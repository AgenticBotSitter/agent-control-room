// Signed, crash-safe connector self-update support. This module deliberately
// owns the updater state machine; connector.mjs only wires it into commands.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyReleaseKeyRevocationsV1, applyReleaseKeyRotationV1, captureReleaseTrustV1, compareReleaseVersionsV1,
  connectorReleaseSignatureMaterialV1, MAX_CONNECTOR_RELEASE_BYTES_V1,
  RELEASE_TRUST_SCHEMA_V1, verifyConnectorReleaseAdvertisementV1 } from "../release-signing.mjs";

export const CONNECTOR_UPDATE_STATE_SCHEMA_V1 = "control-room.fleet-connector-update-state/v1";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const UPDATE_LOCK_WAIT_MS = 30_000;
const DOWNLOAD_DEADLINE_MS = 30_000;
const FAILED_RELEASE_BACKOFF_MS = 6 * 60 * 60_000;
let ownProcessIdentity;
const SELF_PROCESS_IDENTITY = `process-start-ms:${Math.round(Date.now() - process.uptime() * 1_000)}`;

export { connectorReleaseSignatureMaterialV1, verifyConnectorReleaseAdvertisementV1 };

const refused = reason => {
  const error = new Error(`connector_update_refused:${reason}`);
  error.code = "connector_update_refused";
  throw error;
};

export function compareConnectorVersionsV1(left, right) {
  if (!VERSION_PATTERN.test(left ?? "") || !VERSION_PATTERN.test(right ?? "")) refused("version");
  return compareReleaseVersionsV1(left, right);
}

export function connectorUpdatePathsV1(installRoot) {
  if (typeof installRoot !== "string" || !isAbsolute(installRoot) || resolve(installRoot) !== installRoot) refused("install_root");
  return Object.freeze({ installRoot, launcher: join(installRoot, "launcher.mjs"), versions: join(installRoot, "versions"),
    current: join(installRoot, "current.json"), previous: join(installRoot, "previous.json"),
    pending: join(installRoot, "update.pending.json"), state: join(installRoot, "update-state.json"),
    policy: join(installRoot, "update-policy.json"), trust: join(installRoot, "release-trust.json"),
    launcherRelease: join(installRoot, "launcher-release.json"), lock: join(installRoot, "update.lock") });
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

async function readJson(path, optional = false) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (optional && error?.code === "ENOENT") return null; refused("state"); }
}

function trustFromUpdates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refused("trust");
  return captureReleaseTrustV1({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: value.epoch, keyId: value.keyId,
    publicKey: value.releasePublicKey ?? value.publicKey, versionFloor: value.floorVersion ?? value.versionFloor,
    revokedKeyIds: value.revokedKeyIds ?? [] });
}

function sameTrust(left, right) {
  return JSON.stringify(captureReleaseTrustV1(left)) === JSON.stringify(captureReleaseTrustV1(right));
}

async function readMachineTrust(paths) {
  return captureReleaseTrustV1(await readJson(paths.trust));
}

export async function pinConnectorReleaseTrustV1({ installRoot, trust: trustValue, rotation, revocations }) {
  const paths = connectorUpdatePathsV1(installRoot), proposed = captureReleaseTrustV1(trustValue);
  await mkdir(paths.installRoot, { recursive: true, mode: 0o700 });
  return withUpdateLock(paths.lock, async () => {
    const existingValue = await readJson(paths.trust, true);
    if (!existingValue) { await atomicJson(paths.trust, proposed); return proposed; }
    const existing = captureReleaseTrustV1(existingValue);
    if (sameTrust(existing, proposed)) return existing;
    let transitioned = existing;
    if (rotation) transitioned = applyReleaseKeyRotationV1(rotation, transitioned);
    if (revocations) transitioned = applyReleaseKeyRevocationsV1(revocations, transitioned);
    if (!sameTrust(transitioned, proposed)) refused("machine_trust_mismatch");
    await atomicJson(paths.trust, proposed);
    return proposed;
  });
}

async function raiseMachineFloor(paths, version) {
  const trust = await readMachineTrust(paths);
  if (compareConnectorVersionsV1(version, trust.versionFloor) <= 0) return trust;
  const raised = captureReleaseTrustV1({ ...trust, versionFloor: version });
  await atomicJson(paths.trust, raised);
  return raised;
}

function releaseRecordPath(paths, version) { return join(paths.versions, version, "connector-release.json"); }

async function verifyInstalledConnector(paths, selected, trust, fallback = false) {
  const target = fallback ? paths.launcher : join(paths.installRoot, selected.file);
  const recordPath = fallback ? paths.launcherRelease : releaseRecordPath(paths, selected.version);
  if (!inside(paths.installRoot, target) || !inside(paths.installRoot, recordPath)) refused("target");
  const release = verifyConnectorReleaseAdvertisementV1(await readJson(recordPath), trust, "0.0.0");
  if (release.version !== selected.version) refused("installed_release");
  const bytes = await readFile(target);
  if (bytes.length !== release.size || createHash("sha256").update(bytes).digest("hex") !== release.sha256)
    refused("installed_digest");
  return target;
}

function pointer(version) {
  if (!VERSION_PATTERN.test(version ?? "")) refused("pointer");
  return Object.freeze({ schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1, version, file: `versions/${version}/connector.mjs` });
}

function capturePointer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "file,schema,version"
    || value.schema !== CONNECTOR_UPDATE_STATE_SCHEMA_V1 || !VERSION_PATTERN.test(value.version ?? "")
    || value.file !== `versions/${value.version}/connector.mjs`) refused("pointer");
  return value;
}

function inside(root, path) {
  const part = relative(resolve(root), resolve(path));
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function commandOutput(command, args) {
  return new Promise(resolveOutput => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let output = "", settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolveOutput(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(""); }, 2_000);
    child.stdout.on("data", chunk => { output += chunk; }); child.once("error", () => finish(""));
    child.once("close", code => finish(code === 0 ? output.trim() : ""));
  });
}

async function processIdentity(pid, platform = process.platform) {
  try {
    if (pid === process.pid) return SELF_PROCESS_IDENTITY;
    if (platform === "linux") {
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/u);
      return fields[19] ? `linux-start-ticks:${fields[19]}` : null;
    }
    if (platform === "win32") {
      const value = await commandOutput("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToFileTimeUtc()`]);
      return value ? `windows-start-filetime:${value}` : null;
    }
    const value = await commandOutput("ps", ["-o", "lstart=", "-p", String(pid)]);
    return value ? `posix-start:${value.replace(/\s+/gu, " ").trim()}` : null;
  } catch { return null; }
}

function currentProcessIdentity() {
  ownProcessIdentity ??= Promise.resolve(SELF_PROCESS_IDENTITY);
  return ownProcessIdentity;
}

async function requireRealDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) refused("directory");
}

export async function installConnectorLauncherV1({ installRoot, sourcePath, version, platform = process.platform,
  nodePath = process.execPath, shimPath, trust: trustValue, advertisement }) {
  const paths = connectorUpdatePathsV1(installRoot), target = join(paths.versions, version, "connector.mjs");
  if (!inside(paths.installRoot, target) || !inside(paths.installRoot, shimPath)
    || !VERSION_PATTERN.test(version ?? "")) refused("version");
  await mkdir(paths.installRoot, { recursive: true, mode: 0o700 }); await requireRealDirectory(paths.installRoot);
  await mkdir(paths.versions, { mode: 0o700 }).catch(error => { if (error?.code !== "EEXIST") throw error; });
  await requireRealDirectory(paths.versions);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(dirname(shimPath), { recursive: true, mode: 0o700 });
  await requireRealDirectory(dirname(target));
  const bytes = await readFile(sourcePath);
  const trust = trustValue ? captureReleaseTrustV1(trustValue) : trustFromUpdates(advertisement?.trust);
  const release = verifyConnectorReleaseAdvertisementV1(advertisement, trust);
  if (release.version !== version || release.size !== bytes.length
    || release.sha256 !== createHash("sha256").update(bytes).digest("hex")) refused("installed_release");
  await pinConnectorReleaseTrustV1({ installRoot, trust });
  const initialTemporary = `${target}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  await writeFile(initialTemporary, bytes, { flag: "wx", mode: 0o700 });
  try { await rename(initialTemporary, target); }
  catch (error) {
    await rm(initialTemporary, { force: true });
    if (error?.code !== "EEXIST" || !Buffer.from(await readFile(target)).equals(bytes)) throw error;
  }
  try { await stat(paths.launcher); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try { await writeFile(paths.launcher, bytes, { flag: "wx", mode: 0o700 }); }
    catch (writeError) { if (writeError?.code !== "EEXIST") throw writeError; }
  }
  await atomicJson(releaseRecordPath(paths, version), release);
  try { await stat(paths.launcherRelease); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await atomicJson(paths.launcherRelease, release);
  }
  const existing = await readJson(paths.current, true);
  if (!existing || compareConnectorVersionsV1(capturePointer(existing).version, version) <= 0)
    await atomicJson(paths.current, pointer(version));
  if (platform !== "win32") { await chmod(target, 0o700); await chmod(paths.launcher, 0o700); }
  const quoted = value => `'${String(value).replace(/'/gu, `'\\''`)}'`;
  const body = platform === "win32"
    ? `@echo off\r\n"${nodePath}" "${paths.launcher}" launch mcp %*\r\n`
    : `#!/bin/sh\nexec ${quoted(nodePath)} ${quoted(paths.launcher)} launch mcp "$@"\n`;
  await writeFile(shimPath, body, { mode: 0o700 });
  if (platform !== "win32") await chmod(shimPath, 0o700);
  return paths;
}

async function withUpdateLock(path, work, { clock = Date.now, sleep = ms => new Promise(done => setTimeout(done, ms)),
  deadlineMs = UPDATE_LOCK_WAIT_MS } = {}) {
  const deadline = clock() + deadlineMs, token = randomBytes(16).toString("hex");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: clock(),
        identity: await currentProcessIdentity() })); await handle.sync(); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (deadlineMs === 0) refused("busy");
      let owner;
      try { owner = JSON.parse(await readFile(path, "utf8")); } catch {}
      let alive = false;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) try { process.kill(owner.pid, 0); alive = true; } catch (e) { alive = e?.code !== "ESRCH"; }
      if (alive && typeof owner?.identity === "string") {
        const observed = await processIdentity(owner.pid);
        if (observed !== null && observed !== owner.identity) alive = false;
      }
      let oldEnough = false;
      try { oldEnough = clock() - (await stat(path)).mtimeMs > deadlineMs; } catch {}
      if (!alive && oldEnough) { await rm(path, { force: true }); continue; }
      if (clock() >= deadline) refused("busy");
      await sleep(20);
    }
  }
  try { return await work(); } finally {
    try {
      const current = JSON.parse(await readFile(path, "utf8"));
      if (current.token !== token || current.pid !== process.pid) refused("lock_owner_changed");
      await rm(path, { force: true });
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

async function downloadRelease(release, config, fetcher, destination, { clock = Date.now,
  deadlineMs = DOWNLOAD_DEADLINE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const controller = new AbortController(), deadline = clock() + deadlineMs;
  let rejectDeadline;
  const deadlineFailure = new Promise((_, reject) => { rejectDeadline = reject; });
  const timer = setTimer(() => {
    controller.abort(); rejectDeadline(Object.assign(new Error("download deadline"), { code: "DOWNLOAD_TIMEOUT" }));
  }, deadlineMs);
  try {
    const response = await Promise.race([fetcher(`${config.server}/fleet/v1/connector-releases/${encodeURIComponent(release.version)}`, {
    method: "GET", redirect: "error", signal: controller.signal, headers: {
      accept: "text/javascript", authorization: `Bearer ${config.secret}`, "x-control-room-worker": config.workerId,
    },
  }), deadlineFailure]);
  if (!response.ok || !response.body) refused(`download_${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== release.size) refused("size");
  const handle = await open(destination, "wx", 0o700);
  const digest = createHash("sha256");
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const remaining = deadline - clock();
      if (controller.signal.aborted || remaining <= 0) { controller.abort(); refused("download_timeout"); }
      let deadlineTimer;
      const next = await Promise.race([reader.read(), new Promise((_, reject) => {
        deadlineTimer = setTimer(() => reject(Object.assign(new Error("download deadline"), { code: "DOWNLOAD_TIMEOUT" })), remaining);
      })]).finally(() => clearTimer(deadlineTimer));
      if (next.done) break;
      const chunk = next.value;
      size += chunk.length;
      if (size > release.size || size > MAX_CONNECTOR_RELEASE_BYTES_V1) refused("size");
      digest.update(chunk); await handle.write(chunk);
    }
    await handle.sync();
  } catch (error) {
    if (error?.code === "DOWNLOAD_TIMEOUT") { controller.abort(); refused("download_timeout"); }
    throw error;
  } finally { void reader.cancel().catch(() => {}); await handle.close(); }
  if (size !== release.size || digest.digest("hex") !== release.sha256) refused("digest");
  } catch (error) {
    if (controller.signal.aborted) refused("download_timeout");
    throw error;
  } finally { clearTimer(timer); }
}

async function sweepTemporaryConnectors(paths) {
  let versions;
  try { versions = await readdir(paths.versions, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  for (const version of versions) {
    if (!version.isDirectory() || !VERSION_PATTERN.test(version.name)) continue;
    const directory = join(paths.versions, version.name);
    for (const name of await readdir(directory)) if (/^connector\.\d+\.[a-f0-9]+\.tmp$/u.test(name))
      await rm(join(directory, name), { force: true });
  }
}

function defaultHealthCheck(path, configPath) {
  return new Promise(resolveHealth => {
    const child = spawn(process.execPath, [path, "health-check", "--config", configPath], {
      shell: false, stdio: "ignore", env: process.env,
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolveHealth(false); }, 45_000);
    child.once("error", () => { clearTimeout(timer); resolveHealth(false); });
    child.once("close", code => { clearTimeout(timer); resolveHealth(code === 0); });
  });
}

async function recoverPendingUnlocked(paths, configPath, healthCheck) {
  const pending = await readJson(paths.pending, true);
  if (!pending) return null;
  if (!pending.from || !pending.to) refused("pending");
  const from = capturePointer(pending.from), to = capturePointer(pending.to);
  const current = capturePointer(await readJson(paths.current));
  if (current.version !== to.version) { await rm(paths.pending, { force: true }); return null; }
  const rollback = capturePointer(await readJson(paths.previous));
  if (rollback.version !== from.version) refused("rollback_pointer");
  const candidate = join(paths.installRoot, to.file);
  let healthy = false;
  if (inside(paths.installRoot, candidate)) {
    try {
      const verified = await verifyInstalledConnector(paths, to, await readMachineTrust(paths));
      healthy = verified === candidate && await healthCheck(candidate, configPath);
    } catch { healthy = false; }
  }
  if (healthy) {
    await rm(paths.pending, { force: true });
    return Object.freeze({ state: "updated", version: to.version });
  }
  await rename(paths.previous, paths.current);
  await atomicJson(paths.previous, to); await rm(paths.pending, { force: true });
  return Object.freeze({ state: "reverted", version: from.version, failedVersion: to.version });
}

export async function recoverPendingConnectorUpdateV1({ installRoot, configPath, healthCheck = defaultHealthCheck }) {
  const paths = connectorUpdatePathsV1(installRoot);
  return withUpdateLock(paths.lock, () => recoverPendingUnlocked(paths, configPath, healthCheck));
}

export async function checkForConnectorUpdateV1({ installRoot, configPath, config, advertised, currentVersion,
  fetcher = globalThis.fetch, healthCheck = defaultHealthCheck, fault = async () => {}, clock = Date.now,
  minimumCheckIntervalMs = 0, downloadDeadlineMs = DOWNLOAD_DEADLINE_MS }) {
  const paths = connectorUpdatePathsV1(installRoot);
  return withUpdateLock(paths.lock, async () => {
    const recovered = await recoverPendingUnlocked(paths, configPath, healthCheck);
    if (recovered?.state === "reverted") return recovered;
    const priorState = await readJson(paths.state, true);
    if (minimumCheckIntervalMs > 0 && Number.isSafeInteger(priorState?.checkedAt)
      && clock() - priorState.checkedAt < minimumCheckIntervalMs)
      return Object.freeze({ state: "recently_checked" });
    await sweepTemporaryConnectors(paths);
    const freshConfig = JSON.parse(await readFile(configPath, "utf8"));
    const updates = freshConfig.installation?.updates ?? config.installation?.updates;
    const policy = await readJson(paths.policy, true);
    if (policy && (policy.schema !== CONNECTOR_UPDATE_STATE_SCHEMA_V1 || typeof policy.paused !== "boolean"
      || Object.keys(policy).sort().join(",") !== "paused,schema")) refused("policy");
    if (!updates || policy?.paused === true) return Object.freeze({ state: "paused" });
    const trust = await readMachineTrust(paths);
    const release = verifyConnectorReleaseAdvertisementV1(advertised, trust);
    const active = capturePointer(await readJson(paths.current));
    if (active.version !== currentVersion && compareConnectorVersionsV1(active.version, currentVersion) > 0)
      return Object.freeze({ state: "coalesced", version: active.version });
    if (compareConnectorVersionsV1(release.version, active.version) <= 0) {
      await atomicJson(paths.state, { schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1, checkedAt: clock() });
      return Object.freeze({ state: "current", version: active.version });
    }
    if (priorState?.failedVersion === release.version && Number.isSafeInteger(priorState.failedAt)
      && clock() - priorState.failedAt < FAILED_RELEASE_BACKOFF_MS)
      return Object.freeze({ state: "failed_recently", version: release.version });
    const directory = join(paths.versions, release.version), target = join(directory, "connector.mjs");
    if (!inside(paths.installRoot, target)) refused("target");
    await requireRealDirectory(paths.installRoot); await requireRealDirectory(paths.versions);
    await mkdir(directory, { recursive: true, mode: 0o700 }); await requireRealDirectory(directory);
    const temporary = join(directory, `connector.${process.pid}.${randomBytes(5).toString("hex")}.tmp`);
    try { await downloadRelease(release, freshConfig, fetcher, temporary, { clock, deadlineMs: downloadDeadlineMs }); await fault("downloaded");
      await rm(target, { force: true }); await rename(temporary, target); await fault("version_ready"); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    await atomicJson(releaseRecordPath(paths, release.version), release);
    const from = active, to = pointer(release.version);
    await atomicJson(paths.previous, from); await fault("previous_written");
    await atomicJson(paths.pending, { schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1, from, to }); await fault("pending_written");
    await atomicJson(paths.current, to); await fault("pointer_switched");
    const result = await recoverPendingUnlocked(paths, configPath, healthCheck);
    if (result?.state === "updated") await raiseMachineFloor(paths, result.version);
    await atomicJson(paths.state, { schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1, checkedAt: clock(),
      ...(result?.state === "reverted" ? { failedVersion: result.failedVersion, failedAt: clock() } : {}) });
    return result;
  }, { clock });
}

export async function setConnectorUpdatesPausedV1({ installRoot, configPath, paused }) {
  const paths = connectorUpdatePathsV1(installRoot);
  return withUpdateLock(paths.lock, async () => {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!config.installation?.updates) refused("not_configured");
    await atomicJson(paths.policy, { schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1, paused: paused === true });
    return Object.freeze({ paused: paused === true });
  });
}

export async function connectorUpdatesPausedV1(installRoot) {
  const policy = await readJson(connectorUpdatePathsV1(installRoot).policy, true);
  if (!policy) return false;
  if (policy.schema !== CONNECTOR_UPDATE_STATE_SCHEMA_V1 || typeof policy.paused !== "boolean"
    || Object.keys(policy).sort().join(",") !== "paused,schema") refused("policy");
  return policy.paused;
}

export async function launchCurrentConnectorV1({ installRoot, configPath, args, healthCheck = defaultHealthCheck,
  spawnProcess = spawn }) {
  const paths = connectorUpdatePathsV1(installRoot);
  try { await withUpdateLock(paths.lock, () => recoverPendingUnlocked(paths, configPath, healthCheck), { deadlineMs: 0 }); }
  catch (error) { if (error?.message !== "connector_update_refused:busy") throw error; }
  const launched = new Set();
  for (;;) {
    const trust = await readMachineTrust(paths);
    let selected = capturePointer(await readJson(paths.current)), target;
    try { target = await verifyInstalledConnector(paths, selected, trust); }
    catch {
      const launcherRelease = verifyConnectorReleaseAdvertisementV1(await readJson(paths.launcherRelease), trust, "0.0.0");
      selected = pointer(launcherRelease.version);
      target = await verifyInstalledConnector(paths, selected, trust, true);
    }
    const identity = `${selected.version}:${target}`;
    if (launched.has(identity)) refused("relaunch_loop");
    launched.add(identity);
    const code = await new Promise((resolveLaunch, reject) => {
      const child = spawnProcess(process.execPath, [target, ...args], { shell: false, stdio: "inherit",
        env: { ...process.env, CONTROL_ROOM_CONNECTOR_LAUNCHED: "1" } });
      child.once("error", reject); child.once("close", (childCode, signal) => resolveLaunch(childCode ?? (signal ? 1 : 0)));
    });
    if (code !== 75 || args[0] !== "run") return code;
  }
}

export function connectorInstallRootFromConfigPathV1(configPath, env = process.env, platform = process.platform) {
  if (env.CONTROL_ROOM_CONNECTOR_INSTALL_ROOT) return resolve(env.CONTROL_ROOM_CONNECTOR_INSTALL_ROOT);
  if (platform === "win32" && env.LOCALAPPDATA) return resolve(env.LOCALAPPDATA, "ControlRoom", "mcp");
  if (platform !== "win32" && env.XDG_DATA_HOME) return resolve(env.XDG_DATA_HOME, "control-room", "mcp");
  const configRoot = dirname(dirname(resolve(configPath)));
  if (platform === "win32") return resolve(configRoot, "..", "..", "Local", "ControlRoom", "mcp");
  return resolve(configRoot, "..", "share", "control-room", "mcp");
}

export function connectorInstallRootForLaunchV1(modulePath, configPath, env = process.env, platform = process.platform) {
  if (typeof modulePath === "string" && ["launcher.mjs", "launcher.js"].includes(modulePath.split(/[\\/]/u).at(-1)))
    return dirname(resolve(modulePath));
  return connectorInstallRootFromConfigPathV1(configPath, env, platform);
}
