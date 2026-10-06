#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { LIVE_ROOT_V1, readLiveIdentityV1, readPinnedLiveSnapshotV1 } from "./config.mjs";
import { isMainModuleV1 } from "../../../src/installer/shared/is-main-module.mjs";

const runFile = promisify(execFile), MAX_OUTPUT = 8 * 1024 * 1024;
const refuse = code => { throw Object.assign(new Error(code), { code }); };
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
function commandPath() {
  if (process.env.CONTROL_ROOM_REHEARSAL_TESTING === "1" && process.env.CONTROL_ROOM_REHEARSAL_COMMAND_DIR) {
    const directory = resolve(process.env.CONTROL_ROOM_REHEARSAL_COMMAND_DIR);
    if (!inside(tmpdir(), directory)) refuse("live_snapshot_command_refused");
    return resolve(directory, "tailscale");
  }
  return "/usr/local/bin/tailscale";
}
async function command(args) {
  let result;
  try { result = await runFile(commandPath(), args, { encoding: "utf8", maxBuffer: MAX_OUTPUT,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/usr/local/bin", LANG: "C", LC_ALL: "C" } }); } catch { refuse("live_snapshot_command_refused"); }
  if (result.stderr) refuse("live_snapshot_command_refused");
  try { return JSON.parse(result.stdout); } catch { refuse("live_snapshot_command_refused"); }
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
async function currentTailscaleState() {
  const [status, serveStatus] = await Promise.all([command(["status", "--json"]), command(["serve", "status", "--json"])]);
  const hostname = status?.Self?.DNSName;
  if (typeof hostname !== "string" || hostname.length === 0 || hostname.length > 253) refuse("live_snapshot_command_refused");
  return Object.freeze({ hostname: hostname.toLowerCase().replace(/\.+$/u, ""), serveStatus: stable(serveStatus) });
}
function list(value, code) {
  const result = `${value ?? ""}`.split(",").map(item => item.trim()).filter(Boolean);
  if (result.length === 0 || new Set(result.map(item => item.toLowerCase())).size !== result.length) refuse(code);
  return result;
}
async function writeShared(path, bytes) {
  if (!isAbsolute(path) || normalize(path) !== path) refuse("output_path_refused");
  const parent = await realpath(dirname(path)).catch(() => refuse("output_path_refused")), stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("output_path_refused");
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o644)
    .catch(error => error?.code === "EEXIST" ? refuse("output_exists") : Promise.reject(error));
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, 0o644);
}
export async function createOwnerLiveSnapshotV1({ output, liveRoot = LIVE_ROOT_V1, systemRoot, livePorts, liveLabelPrefixes } = {}) {
  const ports = list(livePorts, "live_ports_refused"), labelPrefixes = list(liveLabelPrefixes, "live_label_prefixes_refused");
  if (ports.some(value => !/^\d{1,5}$/u.test(value) || Number(value) < 1 || Number(value) > 65535)) refuse("live_ports_refused");
  if (labelPrefixes.some(value => !/^[a-z0-9][a-z0-9._-]{1,254}$/iu.test(value))) refuse("live_label_prefixes_refused");
  const tailscale = await currentTailscaleState();
  const live = await readLiveIdentityV1({ liveRoot, systemRoot, inputs: { hostname: tailscale.hostname,
    ports: ports.map(value => Number(value)), labelPrefixes }, noLiveInstall: false });
  const snapshot = Object.freeze({ schema: "control-room.e2e2-owner-live-snapshot/v1", hostname: tailscale.hostname,
    ports: Object.freeze([...live.ports].sort((a, b) => a - b)), labels: Object.freeze([...new Set([...live.labels, ...live.labelPrefixes])].sort()),
    accounts: Object.freeze([...live.accounts].sort()), roots: Object.freeze([...live.roots].sort()), hosts: Object.freeze([...live.hosts].sort()),
    serveStatus: tailscale.serveStatus, sourcesRead: live.sourcesRead });
  const bytes = `${JSON.stringify(snapshot, null, 2)}\n`; await writeShared(output, bytes);
  return Object.freeze({ snapshot, digest: sha256(bytes) });
}
export async function checkOwnerServeV1({ input, expectedDigest } = {}) {
  const pinned = await readPinnedLiveSnapshotV1(input, expectedDigest), current = await currentTailscaleState();
  if (current.hostname !== pinned.snapshot.hostname || JSON.stringify(current.serveStatus) !== JSON.stringify(pinned.snapshot.serveStatus)) refuse("tailscale_serve_changed");
  return pinned.digest;
}
export async function main(argv = process.argv.slice(2)) {
  const [verb, ...rest] = argv, args = exactArguments(rest);
  if (verb === "create" && args["--output"] && args["--live-ports"] && args["--live-label-prefixes"]
      && Object.keys(args).every(flag => ["--output", "--live-root", "--system-root", "--live-ports", "--live-label-prefixes"].includes(flag))) {
    const result = await createOwnerLiveSnapshotV1({ output: args["--output"], liveRoot: args["--live-root"] ?? LIVE_ROOT_V1,
      systemRoot: args["--system-root"], livePorts: args["--live-ports"], liveLabelPrefixes: args["--live-label-prefixes"] });
    process.stdout.write(`OWNER LIVE SNAPSHOT SHA256: ${result.digest}\n`); return;
  }
  if (verb === "check-serve" && args["--input"] && args["--checksum"] && Object.keys(args).every(flag => ["--input", "--checksum"].includes(flag))) {
    const digest = await checkOwnerServeV1({ input: args["--input"], expectedDigest: args["--checksum"] });
    process.stdout.write(`PASS: Serve and hostname unchanged; snapshot SHA256: ${digest}\n`); return;
  }
  refuse("arguments_refused");
}
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error?.code ?? error?.message ?? "live_snapshot_failed"}\n`); process.exitCode = 1; });
}
