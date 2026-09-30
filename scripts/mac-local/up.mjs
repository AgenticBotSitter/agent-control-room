// Starts the Mac-local stack in the fixed order: database check, owner verification, repin,
// task provider, task host. The database connection is direct over the protected Tailscale route.
// Repeat-safe: a running stack is left alone.
// Once the launchd user agent is installed (first time: --install-service), the task host runs as that
// agent, so it starts at login and restarts after a crash. Without it, the host is a detached child.
// Usage: pnpm mac:up -- --protected-root ABS_PATH [--install-service]   (or CONTROL_ROOM_PROTECTED_ROOT)
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { alive, FLEET_GATEWAY_PORT, fleetGatewayCommand, hostCommand, protectedRootFromArguments, readPid, repoRoot,
  runtimePaths, stopRecorded, stopRecordedHost, taskHostCommand } from "./stack.mjs";
import { installOrRefreshService, plistPath, serviceInstalled, servicePid, serviceUpToDate } from "./service.mjs";
import { captureMacLocalBuildSourceV1, macLocalBuildSourceV1 } from "./build-source.mjs";
import { readHostState, readRecoverableHostState } from "./task-host-supervisor.mjs";

const PROVIDER_MODULE = "dist-vps/server/macLocalDefaultTaskProvider.js";
const BUILD_SOURCE = "dist-vps/server/mac-local-build-source.json";

export function providerFileBody(modulePath) {
  return `export { schema, workerKinds, createTaskApplication } from ${JSON.stringify(pathToFileURL(modulePath).href)};\n`;
}

export function missingTaskRuntimeInstruction(root) {
  return `task settings missing: run pnpm mac:prepare-task-runtime -- --protected-root ${JSON.stringify(root)} --hermes-profile cr --hermes-provider opencode-go --hermes-model space-bunny-free --hermes-destination https://opencode.ai:443`;
}

export async function verifyMacLocalBuildCurrentV1(root = repoRoot) {
  try {
    const recorded = captureMacLocalBuildSourceV1(JSON.parse(await readFile(join(root, BUILD_SOURCE), "utf8")));
    const current = await macLocalBuildSourceV1(root);
    return recorded.commit === current.commit && recorded.sourceDigest === current.sourceDigest;
  } catch { return false; }
}

const log = line => console.log(`mac:up ${line}`);
const fail = (line, code = 1) => { console.error(`mac:up FAILED ${line}`); process.exit(code); };

/** The recorded stop reason only ever produces a log line, so a state file this stack cannot read
 * must not stop the start. A restored backup, a manual edit or any non-private file in runtime/ is
 * a recovery situation, and the checks below it are the ones that can act on it, so the reason is
 * dropped, the owner is told what to clear and why, and the preflight continues. */
export async function readPreviousHostState(path) {
  const { state, unreadable } = await readRecoverableHostState(path);
  if (unreadable) {
    const name = path.split("/").slice(-2).join("/");
    // The cause is named in plain words, not by its internal identifier: the owner needs to know
    // the file is not private enough to read, and an identifier is not a thing they can act on.
    const why = /mac_local_host_state_invalid/u.test(unreadable)
      ? "it is not a private regular file this account owns"
      : "it is not readable as recorded host state";
    log(`host state file ${name} is unreadable (${why}); starting without a recorded stop reason`);
    log(`to clear it: rm ${path} — it records the last stop and is not state this stack needs`);
    return undefined;
  }
  return state;
}

function run(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.once("close", code => { clearTimeout(timer); resolve(code ?? 1); });
    child.once("error", () => { clearTimeout(timer); resolve(1); });
  });
}

async function boundedHealthResponse(response) {
  if (response.status !== 200 || !response.body
    || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return undefined;
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512) { await reader.cancel(); return undefined; }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks.map(value => Buffer.from(value)), size).toString("utf8");
    return JSON.parse(body);
  } catch { try { await reader.cancel(); } catch {} return undefined; }
}

export async function readHealthProbeKey(root) {
  try {
    const path = join(root, "service", "health-probe.key");
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o600) return undefined;
    const encoded = (await readFile(path, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) return undefined;
    const key = Buffer.from(encoded, "base64url");
    return key.length === 32 ? key : undefined;
  } catch { return undefined; }
}

async function requestAuthenticatedHostHealth(port, healthProbeKey, timeoutMs = 1_000, transport = fetch) {
  const origin = `http://127.0.0.1:${port}`;
  try {
    const nonce = randomBytes(32).toString("base64url");
    const response = await transport(`${origin}/api/v1/local-host-health`, { method: "POST",
      headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(timeoutMs) });
    const value = await boundedHealthResponse(response);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "nonce,pid,ready,releaseId,schema,startedAt,tag"
      || value.schema !== "control-room.local-host-health/v1" || value.ready !== true
      || value.nonce !== nonce || !Number.isSafeInteger(value.pid) || value.pid <= 1
      || typeof value.releaseId !== "string" || typeof value.startedAt !== "string"
      || !Number.isFinite(Date.parse(value.startedAt)) || typeof value.tag !== "string") return undefined;
    const material = JSON.stringify({ nonce, pid: value.pid, purpose: "local-host-health/v1",
      releaseId: value.releaseId, startedAt: value.startedAt });
    const expected = `hmac-sha256:${createHmac("sha256", healthProbeKey).update(material, "utf8").digest("hex")}`;
    const actualBytes = Buffer.from(value.tag, "utf8"), expectedBytes = Buffer.from(expected, "utf8");
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return undefined;
    return value.pid;
  } catch { return undefined; }
}

/** A ready host proves one coherent generation: its supervisor wrote the private pid/state files,
 * both recorded processes still have the exact commands for this root, and the child itself answers
 * the owner-code-authenticated health route on the configured port. The records are re-read after
 * the request so a restart halfway through the probe is a retry, never a mixed-generation success. */
export async function authenticatedHostReady(root, port, runtime = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
  const healthProbeKey = runtime.healthProbeKey ?? await (runtime.readHealthProbeKey ?? readHealthProbeKey)(root);
  if (!(healthProbeKey instanceof Uint8Array) || healthProbeKey.length !== 32) return undefined;
  const paths = runtimePaths(root), exactAlive = runtime.alive ?? alive;
  const pidReader = runtime.readPid ?? readPid, stateReader = runtime.readHostState ?? readHostState;
  const snapshot = async () => {
    try {
      const pid = await pidReader(paths.hostPid), state = await stateReader(paths.hostState);
      if (!pid || state?.schema !== "control-room.mac-local-host-state/v1" || state.state !== "running"
        || state.pid !== pid || !Number.isSafeInteger(state.childPid)
        || !exactAlive(pid, hostCommand(root)) || !exactAlive(state.childPid, taskHostCommand(root))) return undefined;
      return Object.freeze({ pid, childPid: state.childPid });
    } catch { return undefined; }
  };
  const before = await snapshot();
  if (!before) return undefined;
  const childPid = await requestAuthenticatedHostHealth(port, healthProbeKey, runtime.timeoutMs ?? 1_000,
    runtime.transport ?? fetch);
  if (childPid !== before.childPid) return undefined;
  const after = await snapshot();
  return after && after.pid === before.pid && after.childPid === before.childPid ? after.pid : undefined;
}
async function waitFor(check, seconds) {
  const deadline = Date.now() + seconds * 1_000;
  for (;;) {
    const result = await check();
    if (result) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await new Promise(r => setTimeout(r, Math.min(500, remaining)));
  }
}

const portOpen = (port, timeoutMs = 1_000) => new Promise(resolve => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setTimeout(timeoutMs);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(false));
});

/** The dev/preview gateway is accepted only when both its exact recorded
 * process and its fixed loopback listener are present. */
export async function fleetGatewayReady(root, runtime = {}) {
  const paths = runtimePaths(root), pid = await (runtime.readPid ?? readPid)(paths.fleetGatewayPid);
  if (!pid || !(runtime.alive ?? alive)(pid, fleetGatewayCommand(root))) return undefined;
  return await (runtime.portOpen ?? portOpen)(FLEET_GATEWAY_PORT) ? pid : undefined;
}

async function writePrivate(path, content) {
  const temporary = `${path}.new-${process.pid}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "w" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** Appends to a private log without following a symlink or reusing a loose file. */
function openPrivateLog(path) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const entry = fstatSync(fd);
  if (!entry.isFile() || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid()) {
    closeSync(fd);
    throw new Error(`${path} must be a private regular file`);
  }
  return fd;
}

async function startDetached([command, ...args], logPath, pidPath) {
  const out = openPrivateLog(logPath);
  const child = spawn(command, args, { cwd: repoRoot, detached: true, stdio: ["ignore", out, out], env: process.env });
  closeSync(out);
  // A failed exec (for example a missing binary) is reported by the start check, not thrown.
  child.once("error", () => {});
  child.unref();
  if (!child.pid) throw new Error(`${command} could not be started`);
  // A started child whose pid cannot be recorded could never be stopped by mac:down.
  try { await writePrivate(pidPath, `${child.pid}\n`); }
  catch (error) { try { process.kill(-child.pid, "SIGKILL"); } catch {} throw error; }
  return child.pid;
}

/** Starts a detached child and waits until `ready()`. On any failure the child is stopped and its
 * pid file removed, so a failed start never leaves an orphan behind. The failure is thrown rather
 * than reported here, so the one reporter (`main`'s catch, which calls `fail`) owns the message and
 * the exit code, and so this path can be exercised without ending the test runner. */
export async function startAndWait(command, logPath, pidPath, ready, seconds, what, runtime = {}) {
  const pid = await startDetached(command, logPath, pidPath);
  const exactAlive = runtime.alive ?? alive;
  const ok = await waitFor(async () => !exactAlive(pid, command) || await ready(), seconds) && exactAlive(pid, command);
  if (!ok) {
    await (runtime.stopRecorded ?? stopRecorded)(pidPath, command, 10);
    throw new Error(`${what} did not start within ${seconds}s (see ${logPath.split("/").slice(-2).join("/")})`);
  }
  return pid;
}

async function main() {
  const args = process.argv.slice(2);
  const root = protectedRootFromArguments(args);
  if (!root) fail("--protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT) is required", 2);
  const paths = runtimePaths(root);
  const mac = JSON.parse(await readFile(join(root, "config/mac-local.json"), "utf8"));
  const service = args.includes("--install-service") || await serviceInstalled();
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  await chmod(paths.runtime, 0o700);
  const previous = await readPreviousHostState(paths.hostState);
  const recordedSupervisorAlive = previous?.state === "running" && Number.isSafeInteger(previous.pid)
    && alive(previous.pid, hostCommand(root));
  if (previous?.state === "stopped")
    log(`host stopped because ${previous.reason ?? "no stop reason was recorded"}; starting recovery`);
  else if (previous?.state === "running" && !recordedSupervisorAlive)
    log("host stopped because its supervisor disappeared without recording an exit; starting recovery");
  if (!existsSync(join(root, "config/task-runtime.json")))
    fail(missingTaskRuntimeInstruction(root));
  if (!existsSync(join(repoRoot, "dist-vps/server/macLocalHost.js"))) fail("release build missing: run pnpm build first");
  if (!await verifyMacLocalBuildCurrentV1()) fail("release build stale: run pnpm build first");

  log("1/6 database");
  if (await run(["--import", "tsx", "scripts/mac-local/check-database.ts", root]) !== 0) {
    const binding = await run(["--import", "tsx", "scripts/mac-local/bootstrap-owner.ts", root]);
    if (binding === 2) fail("first-owner setup has not been run; see OWNER_GUIDE_MAC.md");
    fail("database check failed");
  }

  log("2/6 first-owner binding");
  const binding = await run(["--import", "tsx", "scripts/mac-local/bootstrap-owner.ts", root]);
  if (binding === 2)
    fail("first-owner setup has not been run; see OWNER_GUIDE_MAC.md");
  if (binding !== 0) fail("first-owner binding verification failed");
  const hostReady = () => authenticatedHostReady(root, mac.port);

  const hostPid = await readPid(paths.hostPid);
  if (hostPid && alive(hostPid, taskHostCommand(root))) {
    log("upgrading the existing direct task host to crash supervision");
    if (await stopRecordedHost(paths.hostPid, root, 45) === "still_running")
      fail("the existing direct task host would not stop: run pnpm mac:down first");
  }
  let existingHostPid;
  if (!service && hostPid && alive(hostPid, hostCommand(root))) {
    // A host that is alive but not serving is a failure, never "already running".
    if (await hostReady()) existingHostPid = hostPid;
    else fail("task host is running but not serving: run pnpm mac:down first");
  }
  if (service) {
    const pid = await hostReady();
    if (pid
      && await serviceUpToDate({ protectedRoot: root, logPath: paths.hostLog, env: process.env })) {
      log(`already running as a launchd user agent (pid ${pid})`);
      log("fleet gateway launchd hand-off pending: cook/daemons item 5 owns its production service definition");
      return;
    }
  }

  log("3/6 repin");
  const repin = await run(["--import", "tsx", "scripts/mac-local/repin-workers.mjs", "--protected-root", root]);
  if (repin === 1) log("repin blocked for a worker: it will show unavailable");
  else if (repin !== 0) fail(`repin exit ${repin}: protected configuration is unsafe`);

  log("4/6 task provider");
  const module = join(repoRoot, PROVIDER_MODULE);
  if (existsSync(module)) {
    const body = providerFileBody(module);
    const current = existsSync(paths.provider) ? await readFile(paths.provider, "utf8") : undefined;
    if (current !== body) { await writePrivate(paths.provider, body); log("task provider written"); }
  } else log("task provider absent; only a zero-project website can start");

  if (service) return startService(root, paths, mac.port, hostReady);

  log("5/6 fleet connector release");
  if (await run(["scripts/build-fleet-connector.mjs", "--root", "scripts/fleet/release"]) !== 0)
    fail("fleet connector release build failed");

  let pid = existingHostPid, startedHost = false;
  if (!pid) {
    log("6/6 task host and fleet gateway");
    await stopRecordedHost(paths.hostPid, root, 45);
    pid = await startAndWait(hostCommand(root), paths.hostLog, paths.hostPid, hostReady, 90, "task host");
    startedHost = true;
  } else log(`task host already running (pid ${pid})`);
  try {
    let gatewayPid = await fleetGatewayReady(root);
    if (!gatewayPid) {
      await stopRecorded(paths.fleetGatewayPid, fleetGatewayCommand(root), 10);
      gatewayPid = await startAndWait(fleetGatewayCommand(root), paths.fleetGatewayLog, paths.fleetGatewayPid,
        () => fleetGatewayReady(root), 30, "fleet gateway");
    }
    log(`running: http://127.0.0.1:${mac.port} (pid ${pid}); fleet gateway http://127.0.0.1:${FLEET_GATEWAY_PORT} (pid ${gatewayPid})`);
  } catch (error) {
    if (startedHost) await stopRecordedHost(paths.hostPid, root, 45);
    throw error;
  }
}

/** Service mode: launchd owns the host process. A host that mac:up once started directly is
 * stopped first; the launchd-started host is never signalled here, only reloaded through launchctl. */
async function startService(root, paths, port, hostReady) {
  log("5/6 task host (launchd user agent)");
  const { loaded } = await servicePid();
  if (!loaded && await stopRecordedHost(paths.hostPid, root, 45) === "still_running")
    fail("a directly started task host would not stop: run pnpm mac:down first");
  const state = await installOrRefreshService({ protectedRoot: root, logPath: paths.hostLog, env: process.env });
  log(`service ${state}: ${plistPath().split("/").slice(-3).join("/")}`);
  const pid = await waitFor(hostReady, 90);
  if (!pid) fail(`task host did not start within 90s (see ${paths.hostLog.split("/").slice(-2).join("/")})`);
  log(`running: http://127.0.0.1:${port} (pid ${pid})`);
  log("fleet gateway launchd hand-off pending: cook/daemons item 5 owns its production service definition");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => fail(error instanceof Error ? error.message : "unknown"));
}
