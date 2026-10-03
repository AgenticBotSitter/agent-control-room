#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants, rmSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { REHEARSAL_ACCOUNTS_V1, REHEARSAL_LABELS_V1, REHEARSAL_ROOT_V1 } from "./config.mjs";
import { isMainModuleV1 } from "../../../src/installer/shared/is-main-module.mjs";

const runFile = promisify(execFile);
const SNAPSHOTS = Object.freeze(["users", "groups", "launchd-labels", "launch-agents", "launch-daemons", "sudoers-d",
  "newsyslog-d", "cron-deny", "at-deny", "usr-local-bin", "control-room-roots", "tailscale-serve", "tailscale-self-dns"]);
const MAX_OUTPUT = 8 * 1024 * 1024;
const refuse = code => { throw Object.assign(new Error(code), { code }); };
let activeTemporaryDirectory, activeLockDirectory;

function inside(parent, child) { const path = relative(resolve(parent), resolve(child)); return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
function exactArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!/^--[a-z][a-z-]*$/u.test(flag ?? "") || value === undefined || values[flag] !== undefined) refuse("arguments_refused");
    values[flag] = value;
  }
  return values;
}
function normalizedLines(value) { return `${value}`.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, "en")).join("\n") + "\n"; }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function isVolatileTailscaleExtensionLabel(value) {
  return /^io\.tailscale\.[a-z0-9._-]*network-extension(?:\.|$)/iu.test(value);
}

export function launchdLabelsV1(value) {
  const labels = new Set(), lines = `${value}`.split(/\r?\n/u);
  let block;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^services\s*=\s*\{$/u.test(line)) { block = "services"; continue; }
    if (/^disabled services\s*=\s*\{$/u.test(line)) { block = "disabled"; continue; }
    if (block && line === "}") { block = undefined; continue; }
    if (!block || line === "") continue;
    let label;
    if (block === "services") {
      const row = /^(?:\d+|-)\s+\S+\s+([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
      if (!row) refuse("launchctl_output_refused");
      label = row[1];
    } else {
      const row = /^"?([A-Za-z0-9][A-Za-z0-9._-]*)"?\s*=>\s*(?:true|false|enabled|disabled)$/u.exec(line);
      if (!row) refuse("launchctl_output_refused");
      label = row[1];
    }
    if (!label.toLowerCase().startsWith("com.apple.") && !isVolatileTailscaleExtensionLabel(label)) labels.add(label);
  }
  if (!lines.some(line => /^\s*services\s*=\s*\{\s*$/u.test(line))) refuse("launchctl_output_refused");
  return [...labels].sort((a, b) => a.localeCompare(b, "en")).join("\n") + "\n";
}

function commandPath(name) {
  if (process.env.CONTROL_ROOM_REHEARSAL_TESTING === "1" && process.env.CONTROL_ROOM_REHEARSAL_COMMAND_DIR) {
    const directory = resolve(process.env.CONTROL_ROOM_REHEARSAL_COMMAND_DIR);
    if (!inside(tmpdir(), directory)) refuse("snapshot_command_refused");
    return join(directory, name);
  }
  return Object.freeze({ dscl: "/usr/bin/dscl", launchctl: "/bin/launchctl", tailscale: "/usr/local/bin/tailscale" })[name];
}
async function command(name, args) {
  let result;
  try { result = await runFile(commandPath(name), args, { encoding: "utf8", maxBuffer: MAX_OUTPUT,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/usr/local/bin", LANG: "C", LC_ALL: "C" } }); } catch { refuse("snapshot_command_refused"); }
  if (result.stderr) refuse("snapshot_command_stderr_refused");
  return result.stdout;
}
function systemPath(systemRoot, absolutePath) { return join(systemRoot, absolutePath.slice(1)); }
async function fileContents(path) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return "MISSING\n"; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_OUTPUT) refuse("snapshot_file_refused");
  const value = await readFile(path, "utf8"); return value.endsWith("\n") ? value : `${value}\n`;
}
async function digestFile(path) {
  const digest = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path); stream.on("data", chunk => digest.update(chunk)); stream.on("error", reject); stream.on("end", resolvePromise);
  });
  return digest.digest("hex");
}
async function directoryState(path) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return "MISSING\n"; throw error; }
  const rows = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const item = join(path, entry.name), stat = await lstat(item), common = `${entry.name}\t${stat.mode & 0o7777}\t${stat.uid}\t${stat.gid}`;
    if (stat.isSymbolicLink()) rows.push(`${common}\tsymlink\t${await readlink(item)}`);
    else if (stat.isFile()) rows.push(`${common}\tfile\t${stat.size}\tsha256:${await digestFile(item)}`);
    else if (stat.isDirectory()) rows.push(`${common}\tdirectory`);
    else rows.push(`${common}\tother`);
  }
  return `${rows.join("\n")}${rows.length ? "\n" : ""}`;
}
async function controlRoomRoots(systemRoot) {
  const path = systemPath(systemRoot, "/Library/Application Support");
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return "MISSING\n"; throw error; }
  const rows = [];
  for (const entry of entries.filter(item => item.name.toLowerCase().startsWith("control room")).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const stat = await lstat(join(path, entry.name));
    rows.push(`${entry.name}\t${stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "not-directory"}`);
  }
  return `${rows.join("\n")}${rows.length ? "\n" : ""}`;
}
async function tailscaleState() {
  const [statusText, serveText] = await Promise.all([command("tailscale", ["status", "--json"]), command("tailscale", ["serve", "status", "--json"])]);
  let status, serve;
  try { status = JSON.parse(statusText); serve = JSON.parse(serveText); } catch { refuse("tailscale_snapshot_refused"); }
  const dnsName = status?.Self?.DNSName;
  if (typeof dnsName !== "string" || dnsName.length === 0 || dnsName.length > 253) refuse("tailscale_snapshot_refused");
  return Object.freeze({ "tailscale-self-dns": `${dnsName.toLowerCase().replace(/\.+$/u, "")}\n`,
    "tailscale-serve": `${JSON.stringify(stable(serve))}\n` });
}
async function capture(systemRoot) {
  const [users, groups, launchd, launchAgents, launchDaemons, sudoers, newsyslog, localBin, roots, tailscale] = await Promise.all([
    command("dscl", [".", "-list", "/Users", "UniqueID"]), command("dscl", [".", "-list", "/Groups", "PrimaryGroupID"]),
    command("launchctl", ["print", "system"]), directoryState(systemPath(systemRoot, "/Library/LaunchAgents")),
    directoryState(systemPath(systemRoot, "/Library/LaunchDaemons")), directoryState(systemPath(systemRoot, "/etc/sudoers.d")),
    directoryState(systemPath(systemRoot, "/etc/newsyslog.d")), directoryState(systemPath(systemRoot, "/usr/local/bin")),
    controlRoomRoots(systemRoot), tailscaleState(),
  ]);
  return Object.freeze({ users: normalizedLines(users), groups: normalizedLines(groups), "launchd-labels": launchdLabelsV1(launchd),
    "launch-agents": launchAgents, "launch-daemons": launchDaemons, "sudoers-d": sudoers, "newsyslog-d": newsyslog,
    "cron-deny": await fileContents(systemPath(systemRoot, "/usr/lib/cron/cron.deny")),
    "at-deny": await fileContents(systemPath(systemRoot, "/usr/lib/cron/at.deny")), "usr-local-bin": localBin,
    "control-room-roots": roots, ...tailscale });
}
async function validateSystemRoot(value) {
  const root = value ?? "/";
  if (!isAbsolute(root) || normalize(root) !== root) refuse("system_root_refused");
  if (root !== "/") {
    if (process.env.CONTROL_ROOM_REHEARSAL_TESTING !== "1") refuse("system_root_refused");
    const canonical = await realpath(root).catch(() => refuse("system_root_refused"));
    if (!inside(await realpath(tmpdir()), canonical)) refuse("system_root_refused");
  }
  return root;
}
async function atomicWrite(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}`, handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}
async function pauseForStopTest(phase) {
  if (process.env.CONTROL_ROOM_REHEARSAL_TESTING !== "1" || process.env.CONTROL_ROOM_REHEARSAL_PAUSE_AFTER !== phase) return;
  await writeFile(join(activeTemporaryDirectory, "paused"), `${process.pid}\n`, { mode: 0o600 });
  await new Promise(() => { setInterval(() => {}, 1000); });
}
function hasLine(value, predicate) { return value.split(/\r?\n/u).filter(Boolean).some(line => predicate(line.split(/\s+/u)[0], line)); }
function assertCleanBefore(values) {
  const accounts = new Set(Object.values(REHEARSAL_ACCOUNTS_V1).map(value => value.toLowerCase()));
  if (hasLine(values.users, name => accounts.has(name.toLowerCase())) || hasLine(values.groups, name => accounts.has(name.toLowerCase()))) refuse("rehearsal_leftover_refused");
  const labels = Object.values(REHEARSAL_LABELS_V1).map(value => value.toLowerCase());
  if (hasLine(values["launchd-labels"], name => labels.some(label => name.toLowerCase() === label || name.toLowerCase().startsWith(`${label}.`)))) refuse("rehearsal_leftover_refused");
  for (const surface of ["launch-agents", "launch-daemons", "sudoers-d", "newsyslog-d", "usr-local-bin"]) {
    if (hasLine(values[surface], name => /rehearsal/iu.test(name))) refuse("rehearsal_leftover_refused");
  }
  if (values["control-room-roots"].split(/\r?\n/u).filter(Boolean)
    .some(line => /^control room rehearsal(?:\t|\.)/iu.test(line))) refuse("rehearsal_leftover_refused");
}
export async function snapshotBeforeV1({ systemRoot } = {}) {
  const root = await validateSystemRoot(systemRoot), parent = await realpath(tmpdir()), directory = await mkdtemp(join(parent, "control-room-e2e2-"));
  activeTemporaryDirectory = directory; await chmod(directory, 0o700);
  try {
    const values = await capture(root); assertCleanBefore(values); await pauseForStopTest("capture");
    for (const name of SNAPSHOTS) await atomicWrite(join(directory, `before-${name}.txt`), values[name]);
    await atomicWrite(join(directory, "manifest.json"), `${JSON.stringify({ schema: "control-room.e2e2-snapshot/v2", systemRoot: root, surfaces: SNAPSHOTS }, null, 2)}\n`);
    activeTemporaryDirectory = undefined; return directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); activeTemporaryDirectory = undefined; throw error; }
}
async function stateDirectory(path) {
  if (!isAbsolute(path) || normalize(path) !== path) refuse("snapshot_state_refused");
  const canonical = await realpath(path).catch(() => refuse("snapshot_state_refused"));
  if (!inside(await realpath(tmpdir()), canonical)) refuse("snapshot_state_refused");
  const stat = await lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) refuse("snapshot_state_refused");
  return canonical;
}
async function retainedRoot(systemRoot, logicalPath) {
  const escaped = REHEARSAL_ROOT_V1.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (typeof logicalPath !== "string" || !new RegExp(`^${escaped}\\.uninstalled-\\d{8}T\\d{9}Z$`, "u").test(logicalPath)) refuse("retained_root_refused");
  const path = systemPath(systemRoot, logicalPath), stat = await lstat(path).catch(() => refuse("retained_root_refused"));
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("retained_root_refused");
  return logicalPath;
}
function lineSet(value) { return new Set(value.split(/\r?\n/u).filter(Boolean)); }
function details(before, after) {
  const left = lineSet(before), right = lineSet(after);
  return Object.freeze({ added: Object.freeze([...right].filter(line => !left.has(line))), removed: Object.freeze([...left].filter(line => !right.has(line))) });
}
function rootsAreExpected(before, after, retained) {
  const left = lineSet(before), right = lineSet(after), retainedLine = `${basename(retained)}\tdirectory`;
  if (left.has(retainedLine) || right.has(`${basename(REHEARSAL_ROOT_V1)}\tdirectory`) || !right.has(retainedLine)) return false;
  right.delete(retainedLine); return left.size === right.size && [...left].every(line => right.has(line));
}
export async function snapshotAfterV1({ state, retained, systemRoot } = {}) {
  const directory = await stateDirectory(state), root = await validateSystemRoot(systemRoot);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8").catch(() => refuse("snapshot_state_refused")));
  if (manifest?.schema !== "control-room.e2e2-snapshot/v2" || manifest.systemRoot !== root || JSON.stringify(manifest.surfaces) !== JSON.stringify(SNAPSHOTS)) refuse("snapshot_state_refused");
  const lock = join(directory, "after.lock");
  await mkdir(lock).catch(error => error?.code === "EEXIST" ? refuse("snapshot_after_busy") : Promise.reject(error)); activeLockDirectory = lock;
  try {
    if (await lstat(join(directory, "diff.json")).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error))) refuse("snapshot_after_exists");
    const retainedPath = await retainedRoot(root, retained), values = await capture(root), changed = [], changes = {};
    for (const name of SNAPSHOTS) {
      const before = await readFile(join(directory, `before-${name}.txt`), "utf8").catch(() => refuse("snapshot_state_refused"));
      await atomicWrite(join(directory, `after-${name}.txt`), values[name]);
      const expected = name === "control-room-roots" ? rootsAreExpected(before, values[name], retainedPath) : before === values[name];
      if (!expected) { changed.push(name); changes[name] = details(before, values[name]); }
    }
    const result = Object.freeze({ schema: "control-room.e2e2-snapshot-diff/v2", passed: changed.length === 0,
      changed: Object.freeze(changed), changes: Object.freeze(changes), retainedRoot: retainedPath });
    await atomicWrite(join(directory, "diff.json"), `${JSON.stringify(result, null, 2)}\n`);
    if (changed.length > 0) refuse("snapshot_diff_not_empty");
    return result;
  } finally { await rm(lock, { recursive: true, force: true }); activeLockDirectory = undefined; }
}
export async function main(argv = process.argv.slice(2)) {
  const [verb, ...rest] = argv, args = exactArguments(rest);
  if (verb === "before" && Object.keys(args).every(flag => flag === "--system-root")) { process.stdout.write(`${await snapshotBeforeV1({ systemRoot: args["--system-root"] })}\n`); return; }
  if (verb === "after" && args["--state"] && args["--retained-root"] && Object.keys(args).every(flag => ["--state", "--retained-root", "--system-root"].includes(flag))) {
    const result = await snapshotAfterV1({ state: args["--state"], retained: args["--retained-root"], systemRoot: args["--system-root"] });
    process.stdout.write(`PASS: system diff empty; retained root ${result.retainedRoot}\n`); return;
  }
  refuse("arguments_refused");
}
function stop(signal) {
  if (activeLockDirectory) rmSync(activeLockDirectory, { recursive: true, force: true });
  if (activeTemporaryDirectory) rmSync(activeTemporaryDirectory, { recursive: true, force: true });
  process.stderr.write(`snapshot_interrupted_${signal.toLowerCase()}\n`); process.exit(1);
}
process.on("SIGINT", () => stop("SIGINT")); process.on("SIGTERM", () => stop("SIGTERM"));
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  main().catch(error => { process.stderr.write(`${typeof error?.code === "string" ? error.code : error?.message ?? "snapshot_failed"}\n`); process.exitCode = 1; });
}
