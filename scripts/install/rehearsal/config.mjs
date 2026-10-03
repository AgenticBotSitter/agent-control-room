#!/usr/bin/env node
import { parseStrictJsonV1 } from "../../../src/installer/shared/strict-json.mjs";
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { parseInstallerArgumentsV1 } from "../../../src/updater/v1/cli.mjs";
import { isMainModuleV1 } from "../../../src/installer/shared/is-main-module.mjs";

export const REHEARSAL_ROOT_V1 = "/Library/Application Support/Control Room Rehearsal";
export const LIVE_ROOT_V1 = "/Library/Application Support/Control Room";
export const REHEARSAL_ACCOUNTS_V1 = Object.freeze({ service: "_controlroom_rehearsal", database: "_crdb_rehearsal", builder: "_crbuild_rehearsal" });
export const REHEARSAL_PORTS_V1 = Object.freeze({ web: 13210, gateway: 13211 });
export const REHEARSAL_LABELS_V1 = Object.freeze({
  postgresql17: "xyz.agentcontrolroom.rehearsal.postgres", supervisor: "xyz.agentcontrolroom.rehearsal.supervisor",
  "fleet-gateway": "xyz.agentcontrolroom.rehearsal.gateway", "nightly-backup": "xyz.agentcontrolroom.rehearsal.nightly-backup",
  updater: "xyz.agentcontrolroom.rehearsal.updater", "updater-guard": "xyz.agentcontrolroom.rehearsal.updater-guard",
});
const DEFAULT_LIVE_ACCOUNTS = Object.freeze(["_controlroom", "_crdb", "_crbuild"]);
const DEFAULT_LIVE_LABELS = Object.freeze(["xyz.agentcontrolroom.postgres", "xyz.agentcontrolroom.supervisor",
  "xyz.agentcontrolroom.gateway", "xyz.agentcontrolroom.nightly-backup", "xyz.agentcontrolroom.updater", "xyz.agentcontrolroom.updater-guard"]);
const LIVE_FILES = Object.freeze(["Protected/config/host.json", "Protected/config/local-owner-session.json",
  "Protected/config/fleet-gateway.json", "Protected/config/supervisor.json", "Protected/config/backup.json", "updater-state/updater.json"]);
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/u;
const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{1,254}$/iu;
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
function folded(value) { return value.normalize("NFC").toLowerCase(); }
function host(value) { return folded(value).replace(/\.+$/u, ""); }
function normalizedRoot(value) { return folded(normalize(value)).replace(/\/+$/u, "") || "/"; }
function labelPrefix(value) { return folded(value).replace(/\.+$/u, ""); }
function labelOverlap(left, right) { const a = labelPrefix(left), b = labelPrefix(right); return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`); }
function rootsOverlap(left, right) { const a = normalizedRoot(left), b = normalizedRoot(right); return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function tailnetSuffix(value) { return host(value).split(".").slice(1).join("."); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function commaValues(value, code) {
  const values = `${value ?? ""}`.split(",").map(item => item.trim()).filter(Boolean);
  if (values.length === 0 || new Set(values.map(folded)).size !== values.length) refuse(code);
  return values;
}
function liveInputs(values, noLiveInstall) {
  if (noLiveInstall) return Object.freeze({ hostname: undefined, ports: [], labelPrefixes: [] });
  const hostname = values["--live-hostname"];
  if (typeof hostname !== "string" || !HOST_PATTERN.test(folded(hostname))) refuse("live_hostname_refused");
  const ports = commaValues(values["--live-ports"], "live_ports_refused").map(value => {
    if (!/^\d{1,5}$/u.test(value)) refuse("live_ports_refused");
    const port = Number(value); if (port < 1 || port > 65535) refuse("live_ports_refused"); return port;
  });
  const labelPrefixes = commaValues(values["--live-label-prefixes"], "live_label_prefixes_refused");
  if (labelPrefixes.some(value => !LABEL_PATTERN.test(value))) refuse("live_label_prefixes_refused");
  return Object.freeze({ hostname: host(hostname), ports, labelPrefixes: labelPrefixes.map(labelPrefix) });
}
async function jsonIfPresent(path) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) refuse("live_config_refused");
  try { return parseStrictJsonV1(await readFile(path, "utf8")); } catch { refuse("live_config_refused"); }
}
function addPortText(value, live) {
  if (/^\d{1,5}$/u.test(value)) { const port = Number(value); if (port >= 1 && port <= 65535) live.ports.add(port); }
  try { const url = new URL(value); if (url.port) live.ports.add(Number(url.port)); live.hosts.add(host(url.hostname)); } catch { /* not a URL */ }
}
function visit(value, key, live) {
  if (Array.isArray(value)) { for (const item of value) visit(item, key, live); return; }
  if (value && typeof value === "object") { for (const [name, item] of Object.entries(value)) visit(item, name, live); return; }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65535) live.ports.add(value);
  if (typeof value !== "string") return;
  addPortText(value, live);
  if (/^(?:account|user|username|serviceAccount|databaseAccount|builderAccount)$/iu.test(key) || /^_[a-z][a-z0-9_]{1,30}$/iu.test(value)) live.accounts.add(folded(value));
  if (/label/iu.test(key) || /^(?:com|xyz)\.[a-z0-9._-]+$/iu.test(value)) live.labels.add(labelPrefix(value));
  if ((/root/iu.test(key) || folded(value).startsWith("/library/application support/control room")) && isAbsolute(value)) live.roots.add(normalizedRoot(value));
  if (/^(?:rpId|hostname|dnsName|tailnet|tailnetName)$/iu.test(key) && HOST_PATTERN.test(folded(value))) live.hosts.add(host(value));
}
function systemPath(systemRoot, absolutePath) { return join(systemRoot, absolutePath.slice(1)); }
async function launchdDirectories(systemRoot) {
  const directories = [systemPath(systemRoot, "/Library/LaunchAgents"), systemPath(systemRoot, "/Library/LaunchDaemons")], users = systemPath(systemRoot, "/Users");
  try {
    for (const entry of await readdir(users, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) directories.push(join(users, entry.name, "Library/LaunchAgents"));
  } catch (error) { if (error?.code !== "ENOENT") refuse("live_discovery_refused"); }
  return directories;
}
async function discoverLaunchd(systemRoot, live, expectedPrefixes) {
  for (const directory of await launchdDirectories(systemRoot)) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) continue; refuse("live_discovery_refused");
    }
    let relevant = false;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.toLowerCase().endsWith(".plist")) continue;
      const path = join(directory, entry.name), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) refuse("live_discovery_refused");
      const text = await readFile(path, "utf8"), labels = [entry.name.slice(0, -6), ...[...text.matchAll(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/giu)].map(match => match[1])];
      for (const value of labels) if (LABEL_PATTERN.test(value)) {
        const normalized = labelPrefix(value); live.labels.add(normalized);
        if (expectedPrefixes.some(prefix => labelOverlap(prefix, normalized))) relevant = true;
      }
    }
    if (relevant) live.sourcesRead += 1;
  }
}
function commandPath(name) {
  if (process.env.CONTROL_ROOM_REHEARSAL_TESTING === "1" && process.env.CONTROL_ROOM_REHEARSAL_COMMAND_DIR) {
    const directory = resolve(process.env.CONTROL_ROOM_REHEARSAL_COMMAND_DIR);
    if (!inside(tmpdir(), directory)) refuse("live_discovery_refused");
    return join(directory, name);
  }
  return Object.freeze({ lsof: "/usr/sbin/lsof" })[name];
}
async function discoverListeners(live, expectedPorts) {
  let result;
  try { result = await runFile(commandPath("lsof"), ["-nP", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", maxBuffer: MAX_OUTPUT,
    env: { PATH: "/usr/bin:/bin:/usr/sbin", LANG: "C", LC_ALL: "C" } }); } catch { refuse("live_discovery_refused"); }
  if (result.stderr) refuse("live_discovery_refused");
  const ports = new Set([...result.stdout.matchAll(/(?:\[[^\]]+\]|\S+):(\d{1,5})\s+\(LISTEN\)/gu)].map(match => Number(match[1])));
  for (const port of ports) live.ports.add(port);
  if (expectedPorts.some(port => ports.has(port))) live.sourcesRead += 1;
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
export async function readLiveIdentityV1({ liveRoot = LIVE_ROOT_V1, systemRoot, inputs, noLiveInstall = false } = {}) {
  if (!isAbsolute(liveRoot) || normalize(liveRoot) !== liveRoot || liveRoot === "/") refuse("live_root_refused");
  const root = await validateSystemRoot(systemRoot);
  const live = { roots: new Set([normalizedRoot(LIVE_ROOT_V1), normalizedRoot(liveRoot)]), accounts: new Set(DEFAULT_LIVE_ACCOUNTS.map(folded)),
    labels: new Set(DEFAULT_LIVE_LABELS.map(labelPrefix)), ports: new Set([3210, 3211]), hosts: new Set(), labelPrefixes: new Set(), sourcesRead: 0 };
  if (!noLiveInstall) {
    live.hosts.add(inputs.hostname); for (const port of inputs.ports) live.ports.add(port); for (const prefix of inputs.labelPrefixes) live.labelPrefixes.add(prefix);
  }
  for (const relativePath of LIVE_FILES) {
    const value = await jsonIfPresent(join(liveRoot, relativePath));
    if (value !== undefined) { visit(value, "", live); live.sourcesRead += 1; }
  }
  if (!noLiveInstall) {
    await discoverLaunchd(root, live, inputs.labelPrefixes); await discoverListeners(live, inputs.ports);
    if (live.sourcesRead === 0) refuse("live_sources_missing");
  }
  return live;
}
export async function readPinnedLiveSnapshotV1(path, expectedDigest) {
  if (!isAbsolute(path) || normalize(path) !== path || !/^[a-f0-9]{64}$/u.test(expectedDigest ?? "")) refuse("live_snapshot_refused");
  const stat = await lstat(path).catch(() => refuse("live_snapshot_refused"));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) refuse("live_snapshot_refused");
  const bytes = await readFile(path);
  const actual = sha256(bytes), expected = expectedDigest.toLowerCase();
  if (!timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) refuse("live_snapshot_checksum_refused");
  let snapshot;
  try { snapshot = parseStrictJsonV1(bytes.toString("utf8")); } catch { refuse("live_snapshot_refused"); }
  if (snapshot?.schema !== "control-room.e2e2-owner-live-snapshot/v1" || snapshot.sha256 !== undefined
      || !Number.isSafeInteger(snapshot.sourcesRead) || snapshot.sourcesRead < 1
      || typeof snapshot.hostname !== "string" || !HOST_PATTERN.test(folded(snapshot.hostname))
      || !Array.isArray(snapshot.ports) || !Array.isArray(snapshot.labels) || !Array.isArray(snapshot.accounts)
      || !Array.isArray(snapshot.roots) || !Array.isArray(snapshot.hosts) || !snapshot.serveStatus
      || typeof snapshot.serveStatus !== "object" || Array.isArray(snapshot.serveStatus)) {
    refuse("live_snapshot_refused");
  }
  const ports = snapshot.ports.map(value => {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) refuse("live_snapshot_refused"); return value;
  });
  const labels = snapshot.labels.map(value => {
    if (typeof value !== "string" || !LABEL_PATTERN.test(value)) refuse("live_snapshot_refused"); return labelPrefix(value);
  });
  const accounts = snapshot.accounts.map(value => {
    if (typeof value !== "string" || !/^_[a-z][a-z0-9_]{1,30}$/iu.test(value)) refuse("live_snapshot_refused"); return folded(value);
  });
  const roots = snapshot.roots.map(value => {
    if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value === "/") refuse("live_snapshot_refused"); return normalizedRoot(value);
  });
  const hosts = snapshot.hosts.map(value => {
    if (typeof value !== "string" || !HOST_PATTERN.test(folded(value))) refuse("live_snapshot_refused"); return host(value);
  });
  if (!hosts.includes(host(snapshot.hostname))) refuse("live_snapshot_refused");
  return Object.freeze({ digest: actual, snapshot: Object.freeze(snapshot), live: {
    roots: new Set(roots), accounts: new Set(accounts), labels: new Set(labels), ports: new Set(ports), hosts: new Set(hosts),
    labelPrefixes: new Set(labels), sourcesRead: snapshot.sourcesRead,
  } });
}
function parserAccepts(flag, value) {
  try { parseInstallerArgumentsV1("install", ["--commit", "a".repeat(40), flag, value], { invokingUser: { user: "owner", uid: 501, gid: 20 } }); return true; } catch { return false; }
}
export function observedInstallerFlagsV1() {
  const desired = Object.freeze({ "--root": REHEARSAL_ROOT_V1, "--web-port": String(REHEARSAL_PORTS_V1.web),
    "--rehearsal-config": "/private/tmp/rehearsal-config.json", "--fresh-database": "yes", "--authenticator": "software",
    "--e2e2-evidence-log": "/private/tmp/e2e2-evidence.jsonl" });
  const supported = Object.keys(desired).filter(flag => parserAccepts(flag, desired[flag]));
  return Object.freeze({ supported: Object.freeze(supported), missing: Object.freeze(Object.keys(desired).filter(flag => !supported.includes(flag))) });
}
function collision(live, kind, value) {
  if (kind === "roots") { if ([...live.roots].some(item => rootsOverlap(item, value))) refuse("live_root_collision_refused"); return; }
  if (kind === "labels") { if ([...live.labels, ...live.labelPrefixes].some(item => labelOverlap(item, value))) refuse("live_label_collision_refused"); return; }
  const compared = typeof value === "string" ? folded(value) : value;
  if (live[kind].has(compared)) refuse(`live_${kind.slice(0, -1)}_collision_refused`);
}
export async function generateRehearsalConfigV1({ tailnetName, liveRoot = LIVE_ROOT_V1, systemRoot,
  liveHostname, livePorts, liveLabelPrefixes, liveSnapshot, liveSnapshotSha256, noLiveInstall = false } = {}) {
  const tailnet = typeof tailnetName === "string" ? host(tailnetName) : "";
  if (!HOST_PATTERN.test(tailnet) || !tailnet.split(".").some(label => label.includes("rehearsal"))) refuse("rehearsal_tailnet_refused");
  let snapshotDigest;
  let live;
  if (liveSnapshot !== undefined || liveSnapshotSha256 !== undefined) {
    if (noLiveInstall || liveSnapshot === undefined || liveSnapshotSha256 === undefined) refuse("live_snapshot_refused");
    const pinned = await readPinnedLiveSnapshotV1(liveSnapshot, liveSnapshotSha256); live = pinned.live; snapshotDigest = pinned.digest;
  } else {
    const inputs = noLiveInstall ? liveInputs({}, true) : liveInputs({ "--live-hostname": liveHostname,
      "--live-ports": Array.isArray(livePorts) ? livePorts.join(",") : livePorts,
      "--live-label-prefixes": Array.isArray(liveLabelPrefixes) ? liveLabelPrefixes.join(",") : liveLabelPrefixes }, false);
    live = await readLiveIdentityV1({ liveRoot, systemRoot, inputs, noLiveInstall });
  }
  collision(live, "roots", REHEARSAL_ROOT_V1);
  for (const account of Object.values(REHEARSAL_ACCOUNTS_V1)) collision(live, "accounts", account);
  for (const label of Object.values(REHEARSAL_LABELS_V1)) collision(live, "labels", label);
  collision(live, "ports", REHEARSAL_PORTS_V1.web); collision(live, "ports", REHEARSAL_PORTS_V1.gateway);
  if ([...live.hosts].some(value => host(value) === tailnet || tailnetSuffix(value) === tailnetSuffix(tailnet))) refuse("live_host_collision_refused");
  const flags = observedInstallerFlagsV1();
  return Object.freeze({ schema: "control-room.e2e2-rehearsal-config/v1", root: REHEARSAL_ROOT_V1, accounts: REHEARSAL_ACCOUNTS_V1,
    launchdLabels: REHEARSAL_LABELS_V1, ports: REHEARSAL_PORTS_V1, tailnetName: tailnet,
    tailscale: Object.freeze({ mode: "skip", expectedStepOutcome: "skipped (rehearsal)", mutationAllowed: false }),
    database: Object.freeze({ mode: "fresh" }), authenticator: Object.freeze({ kind: "software", userVerification: "required" }),
    liveSourcesRead: live.sourcesRead, ...(snapshotDigest ? { liveSnapshotSha256: snapshotDigest } : {}),
    installerArgumentTemplate: Object.freeze(["--root", REHEARSAL_ROOT_V1, "--web-port", String(REHEARSAL_PORTS_V1.web),
      "--rehearsal-config", "<generated-config-path>", "--fresh-database", "yes", "--authenticator", "software",
      "--e2e2-evidence-log", "<private-evidence-path>"]),
    observedInstallerFlags: flags.supported, missingInstallerFlags: flags.missing });
}
async function writeExclusive(path, bytes) {
  if (!isAbsolute(path) || normalize(path) !== path) refuse("output_path_refused");
  const parent = await realpath(dirname(path)).catch(() => refuse("output_path_refused")), stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("output_path_refused");
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
    .catch(error => error?.code === "EEXIST" ? refuse("output_exists") : Promise.reject(error));
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
export async function main(argv = process.argv.slice(2)) {
  const args = exactArguments(argv), allowed = ["--tailnet-name", "--output", "--live-root", "--system-root", "--live-hostname", "--live-ports", "--live-label-prefixes", "--live-snapshot", "--live-snapshot-digest", "--no-live-install"];
  if (!args["--tailnet-name"] || !args["--output"] || Object.keys(args).some(flag => !allowed.includes(flag))) refuse("arguments_refused");
  const noLiveInstall = args["--no-live-install"] === "yes";
  if (args["--no-live-install"] !== undefined && !noLiveInstall) refuse("arguments_refused");
  const snapshotMode = args["--live-snapshot"] !== undefined || args["--live-snapshot-digest"] !== undefined;
  const directFlags = ["--live-hostname", "--live-ports", "--live-label-prefixes"];
  if (!noLiveInstall && !snapshotMode && directFlags.some(flag => !args[flag])) refuse("live_inputs_required");
  if (snapshotMode && (!args["--live-snapshot"] || !args["--live-snapshot-digest"] || directFlags.some(flag => args[flag])
      || args["--live-root"] || args["--system-root"])) refuse("live_snapshot_refused");
  if (noLiveInstall && (snapshotMode || directFlags.some(flag => args[flag]))) refuse("live_inputs_refused");
  const config = await generateRehearsalConfigV1({ tailnetName: args["--tailnet-name"], liveRoot: args["--live-root"] ?? LIVE_ROOT_V1,
    systemRoot: args["--system-root"], liveHostname: args["--live-hostname"], livePorts: args["--live-ports"],
    liveLabelPrefixes: args["--live-label-prefixes"], liveSnapshot: args["--live-snapshot"],
    liveSnapshotSha256: args["--live-snapshot-digest"], noLiveInstall });
  await writeExclusive(args["--output"], `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`live sources read: ${config.liveSourcesRead}\n${args["--output"]}\n`);
}
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error?.code ?? error?.message ?? "rehearsal_config_failed"}\n`); process.exitCode = 1; });
}
