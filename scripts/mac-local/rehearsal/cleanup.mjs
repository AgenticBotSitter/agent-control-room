import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  REHEARSAL_POSTGRES_MARKER,
  REHEARSAL_SCHEMA,
  defaultRegistryDirectory,
  validateRehearsalOwnership,
} from "./lifecycle.mjs";
import { hostCommand, runtimePaths } from "../stack.mjs";

const exec = promisify(execFile);
const configuredPgBin = process.env.PG_BIN;
if (configuredPgBin !== undefined
  && (!isAbsolute(configuredPgBin) || resolve(configuredPgBin) !== configuredPgBin))
  throw new Error("rehearsal_pg_bin_must_be_absolute");
const production = Object.freeze({
  readdir,
  readFile,
  lstat,
  realpath,
  rm,
  currentPid: () => process.pid,
  processCommand: async pid => {
    try { return (await exec("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)],
      { encoding: "utf8", timeout: 10_000 })).stdout.trim(); } catch { return undefined; }
  },
  processIdsByCommand: async command => {
    const output = (await exec("/bin/ps", ["-ww", "-axo", "pid=,command="],
      { encoding: "utf8", timeout: 10_000 })).stdout;
    const expected = exactCommand(command), pids = [];
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
      if (match?.[2] === expected) pids.push(Number(match[1]));
    }
    return pids;
  },
  signal: (pid, signal) => { try { process.kill(pid, signal); return true; } catch { return false; } },
  wait: milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)),
  pgCtl: (dataDirectory, args) => exec(configuredPgBin ? join(configuredPgBin, "pg_ctl")
    : "pg_ctl", ["-D", dataDirectory, ...args],
    { encoding: "utf8", timeout: 30_000 }),
});

const exactCommand = command => command.join(" ");

/** Classifies one owned pid as genuinely gone, exactly identified, or present-but-unidentified.
 *
 * A pid that does not exist at all is proof of absence. A pid that is alive under some *other*
 * command line is not this record's process: either the OS recycled the pid, or the registration
 * captured a command line that has since settled (a `pnpm` wrapper `exec`s into `node` within
 * milliseconds, so a sample taken at spawn can record the transient pre-`exec` string forever).
 * Both cases are identity uncertainty, never absence — treating the second as "already gone" is
 * what let cleanup delete the root, the PostgreSQL data directory, the ownership marker and the
 * registry record while a process the run owned was still executing. */
async function classifyExactProcess(processRecord, runtime) {
  const current = await runtime.processCommand(processRecord.pid);
  if (current === undefined) return "absent";
  return current === exactCommand(processRecord.command) ? "exact" : "identity_uncertain";
}

async function stopExactProcess(processRecord, runtime, graceMs) {
  const initial = await classifyExactProcess(processRecord, runtime);
  if (initial === "absent") return "not_running";
  if (initial === "identity_uncertain") return "identity_uncertain";
  runtime.signal(processRecord.group ? -processRecord.pid : processRecord.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline
    && await runtime.processCommand(processRecord.pid) === exactCommand(processRecord.command)) await runtime.wait(100);
  if (await runtime.processCommand(processRecord.pid) === exactCommand(processRecord.command)) {
    runtime.signal(processRecord.group ? -processRecord.pid : processRecord.pid, "SIGKILL");
    await runtime.wait(100);
  }
  if (await runtime.processCommand(processRecord.pid) !== undefined) return "still_running";
  return "stopped";
}

async function validatePostgresMarker(ownership, runtime) {
  let directory;
  try { directory = await runtime.lstat(ownership.databaseDirectory); }
  catch (error) { if (error?.code === "ENOENT") return "absent"; throw error; }
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || await runtime.realpath(ownership.databaseDirectory) !== ownership.databaseDirectory)
    throw new Error("rehearsal_postgres_directory_unsafe");
  let markerEntry;
  try { markerEntry = await runtime.lstat(join(ownership.databaseDirectory, REHEARSAL_POSTGRES_MARKER)); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // initdb may be interrupted before setup can write its second-factor
    // marker. It is safe to remove that private, owned partial directory only
    // when PostgreSQL left no process identity behind.
    try { await runtime.lstat(join(ownership.databaseDirectory, "postmaster.pid")); }
    catch (pidError) { if (pidError?.code === "ENOENT") return "partial"; throw pidError; }
    throw new Error("rehearsal_postgres_marker_missing_with_process_identity");
  }
  if (!markerEntry.isFile() || markerEntry.isSymbolicLink() || (markerEntry.mode & 0o077) !== 0
    || markerEntry.uid !== ownership.uid) throw new Error("rehearsal_postgres_marker_unsafe");
  const marker = JSON.parse(await runtime.readFile(join(ownership.databaseDirectory, REHEARSAL_POSTGRES_MARKER), "utf8"));
  if (marker?.schema !== "control-room.disposable-postgres/v1"
    || marker?.createdBy !== "mac-local-rehearsal" || marker?.runId !== ownership.runId)
    throw new Error("rehearsal_postgres_marker_mismatch");
}

async function validateProtectedConfiguration(ownership, runtime) {
  const path = join(ownership.protectedRoot, "config", "mac-local.json");
  let entry;
  try { entry = await runtime.lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.uid !== ownership.uid)
    throw new Error("rehearsal_protected_configuration_unsafe");
  const config = JSON.parse(await runtime.readFile(path, "utf8"));
  if (config?.database?.host !== "127.0.0.1" || config.database.database !== "control_room"
    || config.database.majorVersion !== 17 || config.database.port !== ownership.databasePort || config.port !== ownership.webPort
    || config.database.port === 5432 || config.port === 3210)
    throw new Error("rehearsal_protected_configuration_mismatch");
  return "present";
}

async function discoverExactHosts(ownership, runtime) {
  const command = hostCommand(ownership.protectedRoot);
  const pids = new Set(await runtime.processIdsByCommand(command));
  let raw;
  try { raw = await runtime.readFile(runtimePaths(ownership.protectedRoot).hostPid, "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (raw !== undefined) {
    if (!/^[1-9]\d*\n?$/u.test(raw)) throw new Error("rehearsal_host_identity_uncertain");
    const pid = Number(raw.trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("rehearsal_host_identity_uncertain");
    if (await runtime.processCommand(pid) === exactCommand(command)) pids.add(pid);
  }
  return [...pids].sort((left, right) => left - right)
    .map(pid => Object.freeze({ kind: "host", pid, command, group: true }));
}

export async function cleanupRehearsalRoot({ root, registryDirectory = defaultRegistryDirectory(),
  forbiddenProtectedRoots = [], graceMs = 5_000 }, runtime = production) {
  try { await runtime.lstat(root); }
  catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ root, cleaned: true, alreadyCleaned: true, outcomes: [] });
    throw error;
  }
  try { await runtime.lstat(join(root, ".control-room-rehearsal.json")); }
  catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ root, cleaned: false,
      reason: "rehearsal_ownership_marker_missing", outcomes: [] });
    throw error;
  }
  const validated = await validateRehearsalOwnership({ root, registryDirectory, forbiddenProtectedRoots }, runtime);
  const ownership = validated.ownership;
  const outcomes = [];
  try { await validateProtectedConfiguration(ownership, runtime); }
  catch (error) { return Object.freeze({ root, cleaned: false,
    reason: error instanceof Error ? error.message : "protected_configuration_uncertain", outcomes }); }
  // Stop foreground work first. Once an interrupted mac:up can no longer
  // spawn, reconcile its exact PID file before stopping any detached host.
  for (const processRecord of ownership.processes.filter(record => record.kind !== "host").sort((a, b) =>
    ({ child: 0, setup: 1, journey: 1 })[a.kind] - ({ child: 0, setup: 1, journey: 1 })[b.kind])) {
    if (processRecord.pid === runtime.currentPid?.()) {
      outcomes.push(Object.freeze({ kind: processRecord.kind, pid: processRecord.pid, state: "current" }));
      continue;
    }
    const state = await stopExactProcess(processRecord, runtime, graceMs);
    outcomes.push(Object.freeze({ kind: processRecord.kind, pid: processRecord.pid, state }));
    if (state === "still_running") return Object.freeze({ root, cleaned: false, reason: "process_cleanup_uncertain", outcomes });
    if (state === "identity_uncertain")
      return Object.freeze({ root, cleaned: false, reason: "rehearsal_child_identity_uncertain", outcomes });
  }
  let discoveredHosts;
  try { discoveredHosts = await discoverExactHosts(ownership, runtime); }
  catch (error) { return Object.freeze({ root, cleaned: false,
    reason: error instanceof Error ? error.message : "host_identity_uncertain", outcomes }); }
  const hosts = ownership.processes.filter(record => record.kind === "host");
  for (const discoveredHost of discoveredHosts) if (!hosts.some(record => record.pid === discoveredHost.pid
    && exactCommand(record.command) === exactCommand(discoveredHost.command))) hosts.push(discoveredHost);
  for (const processRecord of hosts) {
    const state = await stopExactProcess(processRecord, runtime, graceMs);
    outcomes.push(Object.freeze({ kind: processRecord.kind, pid: processRecord.pid, state }));
    if (state === "still_running") return Object.freeze({ root, cleaned: false, reason: "process_cleanup_uncertain", outcomes });
    if (state === "identity_uncertain")
      return Object.freeze({ root, cleaned: false, reason: "rehearsal_host_identity_uncertain", outcomes });
  }
  let postgres;
  try { postgres = await validatePostgresMarker(ownership, runtime); }
  catch (error) { return Object.freeze({ root, cleaned: false,
    reason: error instanceof Error ? error.message : "postgres_marker_uncertain", outcomes }); }
  if (postgres !== "absent" && postgres !== "partial") {
    try { await runtime.pgCtl(ownership.databaseDirectory, ["stop", "-m", "fast"]); }
    catch { /* Status below distinguishes already stopped from uncertain. */ }
    let running = true, statusUncertain = false;
    try { await runtime.pgCtl(ownership.databaseDirectory, ["status"]); }
    catch (error) {
      // pg_ctl uses a numeric nonzero exit when this exact -D cluster is not
      // running. Missing binaries, permission errors and timeouts prove nothing.
      if (typeof error?.code === "number") running = false;
      else statusUncertain = true;
    }
    if (statusUncertain) return Object.freeze({ root, cleaned: false, reason: "postgres_status_uncertain", outcomes });
    if (running) return Object.freeze({ root, cleaned: false, reason: "postgres_cleanup_uncertain", outcomes });
  }
  // Re-check every owned pid immediately before deleting, under the same exact-command guard used
  // to stop them. The loops above prove each pid was gone at the moment it was handled; between
  // that proof and this `rm` the OS can hand the pid to something else, and a child that was
  // still in its own pre-`exec` transition can settle into a command line the record never held.
  // Deletion is the irreversible step, so the last word before it is a fresh sample, not a
  // conclusion reached earlier in the run. Anything alive — matched or not — retains the root.
  const preDeleteSurvivors = [];
  for (const processRecord of [...ownership.processes, ...hosts]) {
    if (processRecord.pid === runtime.currentPid?.()) continue;
    const current = await runtime.processCommand(processRecord.pid);
    if (current === undefined) continue;
    preDeleteSurvivors.push(Object.freeze({ kind: processRecord.kind, pid: processRecord.pid,
      state: current === exactCommand(processRecord.command) ? "still_running" : "identity_uncertain" }));
  }
  if (preDeleteSurvivors.length > 0) {
    outcomes.push(...preDeleteSurvivors);
    return Object.freeze({ root, cleaned: false, reason: "process_cleanup_uncertain", outcomes });
  }
  // Delete only after every owned process and the exact -D cluster are proven stopped.
  try {
    await runtime.rm(root, { recursive: true, force: false });
    await runtime.rm(validated.registryPath, { force: true });
  } catch {
    return Object.freeze({ root, cleaned: false, reason: "owned_root_removal_uncertain", outcomes });
  }
  return Object.freeze({ root, cleaned: true, outcomes });
}

export async function cleanupRegisteredRehearsals({ registryDirectory = defaultRegistryDirectory(),
  forbiddenProtectedRoots = [], graceMs = 5_000 } = {}, runtime = production) {
  let names;
  try { names = await runtime.readdir(registryDirectory); }
  catch (error) { if (error?.code === "ENOENT") return Object.freeze([]); throw error; }
  const results = [];
  for (const name of names.filter(value => /^[a-f0-9]{32}\.json$/u.test(value)).sort()) {
    try {
      const record = JSON.parse(await runtime.readFile(join(registryDirectory, name), "utf8"));
      if (record?.schema !== REHEARSAL_SCHEMA || `${record.runId}.json` !== name)
        throw new Error("rehearsal_registry_entry_invalid");
      const result = await cleanupRehearsalRoot({ root: record.root, registryDirectory,
        forbiddenProtectedRoots, graceMs }, runtime);
      if (result.alreadyCleaned) await runtime.rm(join(registryDirectory, name), { force: true });
      results.push(result);
    } catch (error) {
      results.push(Object.freeze({ root: undefined, cleaned: false,
        reason: error instanceof Error ? error.message : "rehearsal_cleanup_failed", outcomes: [] }));
    }
  }
  return Object.freeze(results);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  if (process.argv.length !== 2) {
    console.error("usage: pnpm rehearsal:cleanup");
    process.exitCode = 2;
  } else {
    const results = await cleanupRegisteredRehearsals({
      forbiddenProtectedRoots: process.env.CONTROL_ROOM_OWNER_PROTECTED_ROOT
        ? [resolve(process.env.CONTROL_ROOM_OWNER_PROTECTED_ROOT)] : [],
    });
    for (const result of results) console.log(result.cleaned
      ? `rehearsal cleanup stopped and removed ${result.root}`
      : `rehearsal cleanup retained uncertain state${result.root ? ` at ${result.root}` : ""}: ${result.reason}`);
    if (results.some(result => !result.cleaned)) process.exitCode = 1;
  }
}
