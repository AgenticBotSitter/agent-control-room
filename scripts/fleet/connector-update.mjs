// Signed, crash-safe connector self-update support. This module deliberately
// owns the updater state machine; connector.mjs only wires it into commands.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tryPersistentKernelLockV1 } from "../../src/installer/shared/persistent-kernel-lock.mjs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyReleaseKeyRevocationsV1, captureReleaseTrustV1, compareReleaseVersionsV1,
  connectorReleaseSignatureMaterialV1, MAX_CONNECTOR_RELEASE_BYTES_V1,
  RELEASE_TRUST_SCHEMA_V1, verifyConnectorReleaseAdvertisementV1 } from "../release-signing.mjs";

export const CONNECTOR_UPDATE_STATE_SCHEMA_V1 = "control-room.fleet-connector-update-state/v1";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const UPDATE_LOCK_WAIT_MS = 30_000;
const DOWNLOAD_DEADLINE_MS = 30_000;
const FAILED_RELEASE_BACKOFF_MS = 6 * 60 * 60_000;
/** How many consecutive `run` startups a freshly promoted connector may fail
 * before the launcher gives up on it and recovers the pinned launcher.
 *
 * A candidate is promoted only after it passes its own health check, which
 * runs `health-check` and nothing else. A build that reports the right version
 * there and then cannot start `run` is therefore promoted, exits non-zero on
 * every single launch, and stays selected forever: the launcher's relaunch set
 * lives in ONE invocation and only re-enters on exit 75, so each restart is a
 * fresh set and nothing ever counts. Two attempts is the smallest bound that
 * distinguishes "this one start was unlucky" from "this build does not start",
 * and it is deliberately tiny: the owner gets the working connector back after
 * one bad restart instead of after a human noticing the service is dead. */
const STARTUP_PROBATION_ATTEMPTS = 2;
/** How many distinct connectors one launcher invocation will try before it
 * gives up. Each promotion and each recovery repoints `current`, so the versions
 * are genuinely different and the per-identity `relaunch_loop` guard cannot see
 * the cycle; this bound is what makes the loop terminate even if every one of
 * them fails to start. */
const MAX_LAUNCH_ATTEMPTS = 4;

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

function sameTrustIdentity(leftValue, rightValue) {
  const left = captureReleaseTrustV1(leftValue), right = captureReleaseTrustV1(rightValue);
  return left.keyId === right.keyId && left.publicKey === right.publicKey;
}

function sameTrustExceptFloor(leftValue, rightValue) {
  const left = captureReleaseTrustV1(leftValue), right = captureReleaseTrustV1(rightValue);
  return sameTrustIdentity(left, right) && left.schema === right.schema && left.epoch === right.epoch
    && JSON.stringify(left.revokedKeyIds) === JSON.stringify(right.revokedKeyIds);
}

function higherFloorTrust(leftValue, rightValue) {
  const left = captureReleaseTrustV1(leftValue), right = captureReleaseTrustV1(rightValue);
  return compareConnectorVersionsV1(left.versionFloor, right.versionFloor) >= 0 ? left
    : captureReleaseTrustV1({ ...left, versionFloor: right.versionFloor });
}

async function readMachineTrust(paths) {
  return captureReleaseTrustV1(await readJson(paths.trust));
}

export async function pinConnectorReleaseTrustV1({ installRoot, trust: trustValue, rotation, revocations }) {
  const paths = connectorUpdatePathsV1(installRoot), proposed = captureReleaseTrustV1(trustValue);
  await mkdir(paths.installRoot, { recursive: true, mode: 0o700 });
  return withUpdateLock(paths.lock, async () => {
    if (rotation !== undefined) refused("key_rotation_requires_reinstall");
    const existingValue = await readJson(paths.trust, true);
    if (!existingValue) { await atomicJson(paths.trust, proposed); return proposed; }
    const existing = captureReleaseTrustV1(existingValue);
    let transitioned = existing;
    if (revocations) transitioned = applyReleaseKeyRevocationsV1(revocations, transitioned);
    if (!sameTrustExceptFloor(transitioned, proposed)) refused("machine_trust_mismatch");
    const pinned = higherFloorTrust(transitioned, proposed);
    if (JSON.stringify(pinned) !== JSON.stringify(existing)) await atomicJson(paths.trust, pinned);
    return pinned;
  });
}

export async function assertConnectorReleaseTrustCompatibleV1({ installRoot, trust: trustValue }) {
  const paths = connectorUpdatePathsV1(installRoot), proposed = captureReleaseTrustV1(trustValue);
  const existingValue = await readJson(paths.trust, true);
  if (!existingValue) return proposed;
  const existing = captureReleaseTrustV1(existingValue);
  if (!sameTrustIdentity(existing, proposed)) refused("machine_trust_mismatch");
  return existing;
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

function commandOutput(command, args, options = {}) {
  return new Promise(resolveOutput => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "ignore"], ...options });
    let output = "", settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolveOutput(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(""); }, 2_000);
    child.stdout.on("data", chunk => { output += chunk; }); child.once("error", () => finish(""));
    child.once("close", code => finish(code === 0 ? output.trim() : ""));
  });
}

export function connectorProcessIdentityEnvironmentV1(env = process.env) {
  return Object.freeze({ PATH: typeof env.PATH === "string" ? env.PATH : "", LC_ALL: "C", LANG: "C" });
}

export async function connectorProcessIdentityForLockV1(pid, { platform = process.platform,
  commandOutput: runCommandOutput = commandOutput } = {}) {
  try {
    if (platform === "linux") {
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/u);
      return fields[19] ? `linux-start-ticks:${fields[19]}` : null;
    }
    if (platform === "win32") {
      const value = await runCommandOutput("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToFileTimeUtc()`]);
      return value ? `windows-start-filetime:${value}` : null;
    }
    const value = await runCommandOutput("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: connectorProcessIdentityEnvironmentV1(),
    });
    return value ? `posix-start:${value.replace(/\s+/gu, " ").trim()}` : null;
  } catch { return null; }
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let release;
  try { release = await acquireRotationLock(path, { clock, sleep, deadlineMs }); }
  catch (error) {
    if (error?.message === "Another session is renewing this bot credential. Try again shortly.") refused("busy");
    throw error;
  }
  try { return await work(); } finally { await release(); }
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

export function connectorCandidateHealthCheckV1(path, configPath, expectedVersion, { spawner = spawn } = {}) {
  return new Promise(resolveHealth => {
    const child = spawner(process.execPath, [path, "health-check", "--config", configPath], {
      shell: false, stdio: ["ignore", "pipe", "ignore"], env: process.env,
    });
    let output = "", overflow = false;
    child.stdout.on("data", chunk => {
      if (output.length + chunk.length > 4096) { overflow = true; child.kill("SIGKILL"); }
      else output += chunk.toString("utf8");
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 45_000);
    child.once("error", () => { clearTimeout(timer); resolveHealth(false); });
    child.once("close", code => {
      clearTimeout(timer);
      let report; try { report = JSON.parse(output); } catch { report = null; }
      resolveHealth(code === 0 && !overflow && report?.connectorVersion === expectedVersion);
    });
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
      healthy = verified === candidate && await healthCheck(candidate, configPath, to.version);
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

export async function recoverPendingConnectorUpdateV1({ installRoot, configPath, healthCheck = connectorCandidateHealthCheckV1 }) {
  const paths = connectorUpdatePathsV1(installRoot);
  return withUpdateLock(paths.lock, () => recoverPendingUnlocked(paths, configPath, healthCheck));
}

export async function checkForConnectorUpdateV1({ installRoot, configPath, config, advertised, currentVersion,
  fetcher = globalThis.fetch, healthCheck = connectorCandidateHealthCheckV1, fault = async () => {}, clock = Date.now,
  minimumCheckIntervalMs = 0, downloadDeadlineMs = DOWNLOAD_DEADLINE_MS }) {
  const paths = connectorUpdatePathsV1(installRoot);
  return withUpdateLock(paths.lock, async () => {
    const recovered = await recoverPendingUnlocked(paths, configPath, healthCheck);
    if (recovered?.state === "reverted") return recovered;
    const priorState = await readJson(paths.state, true);
    // Both cache windows below are "elapsed time since a recorded instant", and
    // elapsed time is only meaningful when it is non-negative. A machine whose
    // clock is set 30 days AHEAD persists a future `checkedAt`; correcting the
    // clock afterwards makes `clock() - checkedAt` NEGATIVE, and the test
    // `elapsed < interval` is trivially true for a negative elapsed. The daily
    // update cache therefore stayed "recently checked" for 31 days after the
    // clock was fixed -- the exact opposite of what the check was for, and a
    // silent month-long update blackout. The same arithmetic guards
    // `failedAt` below, which would otherwise hold a failing release's backoff
    // open for the length of the original clock error.
    const elapsedSince = since => {
      const elapsed = clock() - since;
      return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
    };
    const sinceLastCheck = Number.isSafeInteger(priorState?.checkedAt) ? elapsedSince(priorState.checkedAt) : null;
    if (minimumCheckIntervalMs > 0 && sinceLastCheck !== null && sinceLastCheck < minimumCheckIntervalMs)
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
    let activeUsable = false;
    try { await verifyInstalledConnector(paths, active, trust); activeUsable = true; } catch { /* repair from a signed release */ }
    if (activeUsable && active.version !== currentVersion && compareConnectorVersionsV1(active.version, currentVersion) > 0)
      return Object.freeze({ state: "coalesced", version: active.version });
    if (compareConnectorVersionsV1(release.version, active.version) <= 0 && activeUsable) {
      // Carry the launcher's startup-probation record through: an update check
      // runs inside the same worker process as the startup it is judging, and
      // dropping the counter here would silently reset probation on every pass.
      await atomicJson(paths.state, { ...startupKeysOnly(priorState), schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1, checkedAt: clock() });
      return Object.freeze({ state: "current", version: active.version });
    }
    // A damaged pointer must never induce a relaunch loop or authorize a downgrade.
    if (!activeUsable && compareConnectorVersionsV1(release.version, active.version) < 0)
      return Object.freeze({ state: "current", version: currentVersion });
    const sinceFailure = Number.isSafeInteger(priorState?.failedAt) ? elapsedSince(priorState.failedAt) : null;
    if (priorState?.failedVersion === release.version && sinceFailure !== null && sinceFailure < FAILED_RELEASE_BACKOFF_MS)
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
    let from = active;
    if (!activeUsable) {
      from = pointer(currentVersion);
      try { await verifyInstalledConnector(paths, from, trust); }
      catch { await verifyInstalledConnector(paths, from, trust, true); }
    }
    const to = pointer(release.version);
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

export async function launchCurrentConnectorV1({ installRoot, configPath, args, healthCheck = connectorCandidateHealthCheckV1,
  spawnProcess = spawn }) {
  const paths = connectorUpdatePathsV1(installRoot);
  try { await withUpdateLock(paths.lock, () => recoverPendingUnlocked(paths, configPath, healthCheck), { deadlineMs: 0 }); }
  catch (error) { if (error?.message !== "connector_update_refused:busy") throw error; }
  const launched = new Set();
  for (;;) {
    const trust = await readMachineTrust(paths);
    let selected = capturePointer(await readJson(paths.current)), target;
    let fellBack = false;
    try { target = await verifyInstalledConnector(paths, selected, trust); }
    catch {
      const launcherRelease = verifyConnectorReleaseAdvertisementV1(await readJson(paths.launcherRelease), trust, "0.0.0");
      selected = pointer(launcherRelease.version);
      target = await verifyInstalledConnector(paths, selected, trust, true);
      fellBack = true;
    }
    const identity = `${selected.version}:${target}`;
    if (launched.has(identity)) refused("relaunch_loop");
    launched.add(identity);
    // Bounded startup probation. This is the one place that can tell "the
    // health check passed but the worker will not start", because the count
    // lives in the updater state file and so survives the launcher process.
    // Only a promoted release is counted: a launcher fallback is not a new
    // build, and counting it would roll the machine onto itself.
    if (!fellBack) await applyStartupProbationV1(paths, selected.version);
    const code = await new Promise((resolveLaunch, reject) => {
      const child = spawnProcess(process.execPath, [target, ...args], { shell: false, stdio: "inherit",
        env: { ...process.env, CONTROL_ROOM_CONNECTOR_LAUNCHED: "1", CONTROL_ROOM_CONNECTOR_INSTALL_ROOT: installRoot } });
      child.once("error", reject); child.once("close", (childCode, signal) => resolveLaunch(childCode ?? (signal ? 1 : 0)));
    });
    if (code === 75 && args[0] === "run") continue; // a healthy new version asked to be restarted on it
    if (!fellBack && args[0] === "run" && code !== 0) {
      const recovered = await noteStartupFailureV1(paths, selected.version);
      if (recovered === "recovered") {
        // The probation is spent. Recover the pinned, signed launcher rather
        // than leaving a build that cannot start selected forever. `current`
        // is repointed at the launcher's own verified version first: without
        // that, the next update check would see a healthy, newer `current` and
        // re-promote the very build just abandoned, and the machine would
        // crash-loop between the two. The version floor is untouched -- this
        // moves to the launcher that shipped with the installation, never to an
        // arbitrary older release, and the target is still signature-verified
        // by the next iteration's `verifyInstalledConnector`.
        await withUpdateLock(paths.lock, async () => {
          const launcherRelease = verifyConnectorReleaseAdvertisementV1(await readJson(paths.launcherRelease), trust, "0.0.0");
          if (capturePointer(await readJson(paths.current)).version === selected.version)
            await atomicJson(paths.current, pointer(launcherRelease.version));
        }, { deadlineMs: 0 });
        // Loop rather than recurse: the recovered launcher is a DIFFERENT
        // version, so `launched` does not hold it and the loop cannot spin on
        // it. A recursive call would instead re-run recovery from a fresh state
        // with no memory of this probation, and could repeat the whole
        // roll-forward/roll-back cycle without bound if the launcher itself
        // also failed to start.
        if (launched.size >= MAX_LAUNCH_ATTEMPTS) refused("launch_attempts_exhausted");
        continue;
      }
    } else if (!fellBack) await clearStartupProbationV1(paths);
    return code;
  }
}

/** Just the launcher's startup-probation keys from an updater state record, so
 * an update check rewrites its own keys without erasing the launcher's. */
function startupKeysOnly(state) {
  if (state?.startupVersion === undefined) return {};
  return { startupVersion: state.startupVersion, startupState: state.startupState, startupAttempts: state.startupAttempts };
}

/** Records that a promoted release has just been launched.
 *
 * This must NOT reset a counter for the SAME version: a build that fails to
 * start is launched again on the next restart, and clearing the count on each
 * launch is exactly the no-memory-between-invocations defect again, just
 * relocated. So the count is preserved while the version is unchanged, and
 * only a genuinely different promoted version starts a fresh probation.
 *
 * It is durable -- a file, not a variable -- because the whole defect is that
 * the previous launcher had no memory between invocations. */
async function applyStartupProbationV1(paths, version) {
  const prior = await readJson(paths.state, true);
  const sameVersion = prior?.startupVersion === version;
  await atomicJson(paths.state, { ...prior, schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1,
    startupVersion: version, startupAttempts: sameVersion ? Number(prior.startupAttempts ?? 0) : 0 });
}

/** Counts one `run` startup that ended non-zero. Returns "recovered" once the
 * probation is spent, so the caller falls back to the launcher exactly once. */
async function noteStartupFailureV1(paths, version) {
  const prior = await readJson(paths.state, true);
  const attempts = prior?.startupVersion === version ? Number(prior.startupAttempts ?? 0) + 1 : 1;
  await atomicJson(paths.state, { ...prior, schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1,
    startupVersion: version, startupState: "failing", startupAttempts: attempts });
  return attempts >= STARTUP_PROBATION_ATTEMPTS ? "recovered" : "counted";
}

/** A connector that started and ran has served its purpose: drop the count so
 * the next genuine failure starts a fresh probation rather than inheriting an
 * old one. */
async function clearStartupProbationV1(paths) {
  const prior = await readJson(paths.state, true);
  if (prior?.startupVersion === undefined) return;
  const { startupVersion: _v, startupState: _s, startupAttempts: _a, ...rest } = prior;
  await atomicJson(paths.state, { ...rest, schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1 });
}

export function connectorInstallRootFromConfigPathV1(configPath, env = process.env, platform = process.platform) {
  if (env.CONTROL_ROOM_CONNECTOR_INSTALL_ROOT) return resolve(env.CONTROL_ROOM_CONNECTOR_INSTALL_ROOT);
  if (platform === "win32" && env.LOCALAPPDATA) return resolve(env.LOCALAPPDATA, "ControlRoom", "mcp");
  if (platform !== "win32" && env.XDG_DATA_HOME) return resolve(env.XDG_DATA_HOME, "control-room", "mcp");
  if (platform === "win32" && env.USERPROFILE)
    return resolve(env.USERPROFILE, "AppData", "Local", "ControlRoom", "mcp");
  if (platform !== "win32" && env.HOME) return resolve(env.HOME, ".local", "share", "control-room", "mcp");
  const configRoot = dirname(dirname(resolve(configPath)));
  if (platform === "win32") return resolve(configRoot, "..", "..", "Local", "ControlRoom", "mcp");
  return resolve(configRoot, "..", "share", "control-room", "mcp");
}

export function connectorInstallRootForLaunchV1(modulePath, configPath, env = process.env, platform = process.platform) {
  if (typeof modulePath === "string" && ["launcher.mjs", "launcher.js"].includes(modulePath.split(/[\\/]/u).at(-1)))
    return dirname(resolve(modulePath));
  return connectorInstallRootFromConfigPathV1(configPath, env, platform);
}

const ROTATION_LOCK_STALE_MS = 5 * 60_000;
export async function sameProcess(pid, expectedIdentity, isPidAlive, getProcessIdentity) {
  if (!isPidAlive(pid)) return false;
  if (typeof expectedIdentity !== "string" || expectedIdentity.length === 0) return true;
  const currentIdentity = await getProcessIdentity(pid);
  return currentIdentity === null || currentIdentity === expectedIdentity;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

export function getProcessIdentity(pid) {
  return connectorProcessIdentityForLockV1(pid);
}

export function lockGeneration(info, token = "") {
  if (/^[a-f0-9]{32}$/u.test(token)) return token;
  return createHash("sha256").update(JSON.stringify([String(info.dev), String(info.ino), info.birthtimeMs,
    info.mtimeMs, info.size])).digest("hex").slice(0, 32);
}

async function pruneReaperMarkers(lockPath, staleMs, clock) {
  let entries;
  try { entries = await readdir(dirname(lockPath)); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  const prefix = `${basename(lockPath)}.reap-`;
  await Promise.all(entries.filter(entry => entry.startsWith(prefix)).map(async entry => {
    const path = join(dirname(lockPath), entry);
    try { if (clock() - (await stat(path)).mtimeMs >= staleMs) await rm(path, { force: true }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }));
}

export async function electGenerationCleaner(lockPath, generation, clock, identity = {}) {
  const markerPath = `${lockPath}.reap-${generation}`;
  const scratch = `${markerPath}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  const handle = await open(scratch, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, electedAt: new Date(clock()).toISOString(), ...identity })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    // Election publishes the already-synced record, so a killed cleaner can
    // never strand an empty/partial canonical marker.
    try { await link(scratch, markerPath); }
    catch (error) { if (error?.code === "EEXIST") return false; throw error; }
    return true;
  } finally { await unlink(scratch); }
}

const rotationBusy = () => new Error("Another session is renewing this bot credential. Try again shortly.");
const directoryStamp = info => ({ dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs });
const matchesDirectoryStamp = (stamp, info) => stamp?.dev === String(info.dev)
  && stamp.ino === String(info.ino) && stamp.birthtimeMs === info.birthtimeMs;
const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;

/** POSIX recovery uses one permanent kernel inode for election, retirement and
 * recovery. Protected work holds the published owner directory, not this short
 * transaction lock. Windows keeps its existing portable protocol. */
export async function acquireRotationLock(lockPath, options = {}) {
  if (process.platform === "win32") return acquireLegacyRotationLock(lockPath, options);
  const { staleMs = ROTATION_LOCK_STALE_MS, waitMs = 25, deadlineMs = 10_000, clock = Date.now,
    sleep = ms => new Promise(done => setTimeout(done, ms)),
    beforeDeadOwnerCleanup = async () => {}, afterDirectoryElection = async () => {},
    afterOwnerPublication = async () => {}, afterCleanerElection = async () => {},
    getProcessIdentity: inspect = getProcessIdentity, isPidAlive = pidAlive } = options;
  const started = clock(), token = randomBytes(16).toString("hex");
  const contenderPath = `${lockPath}.${process.pid}.${token}.tmp`;
  const candidatePath = `${contenderPath}.dir`;
  const ownerName = `owner-${token}.json`, ownerPath = join(lockPath, ownerName);
  const owner = { pid: process.pid, processIdentity: await inspect(process.pid), token,
    acquiredAt: new Date(clock()).toISOString() };
  const handle = await open(contenderPath, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(owner)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  const wait = async () => {
    if (clock() - started >= deadlineMs) throw rotationBusy();
    await sleep(Math.min(waitMs, Math.max(0, deadlineMs - (clock() - started))));
  };
  let elected = false;
  try {
    // Publish a COMPLETE directory: no elected-but-ownerless generation exists.
    await mkdir(candidatePath, { mode: 0o700 });
    await rename(contenderPath, join(candidatePath, ownerName));
    for (;;) {
      let observed;
      let guard = await tryPersistentKernelLockV1(`${lockPath}.guard`);
      if (!guard) { await wait(); continue; }
      try {
        try { observed = await rotationOwner(lockPath); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      } catch (error) { await guard.close(); throw error; }
      let dead = false;
      if (observed?.owner) {
        // Process inspection can be slow. Release the short filesystem lock
        // while asking; protected owners must be able to finish and retire.
        await guard.close();
        dead = !await sameProcess(observed.owner.pid, observed.owner.processIdentity, isPidAlive, inspect);
        if (!dead) { await wait(); continue; }
        await beforeDeadOwnerCleanup({ lockPath, observedOwnerPath: observed.path });
        guard = await tryPersistentKernelLockV1(`${lockPath}.guard`);
        if (!guard) { await wait(); continue; }
      }
      let retry = false;
      try {
        let current;
        try { current = await rotationOwner(lockPath); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!current) {
          await rename(candidatePath, lockPath);
          elected = true;
          await afterDirectoryElection({ lockPath, token });
          await afterOwnerPublication({ lockPath, ownerPath, token });
          const generation = await lstat(lockPath);
          return async () => {
            let releaseGuard;
            const releaseStarted = clock();
            for (;;) {
              releaseGuard = await tryPersistentKernelLockV1(`${lockPath}.guard`);
              if (releaseGuard) break;
              if (clock() - releaseStarted >= Math.max(deadlineMs, 1000)) throw rotationBusy();
              await sleep(waitMs);
            }
            try {
              let held;
              try { held = await rotationOwner(lockPath); }
              catch { throw new Error("The credential lock changed owners before it could be released."); }
              if (!held || !sameDirectory(generation, held.info) || held.owner?.token !== token)
                throw new Error("The credential lock changed owners before it could be released.");
              const retirement = `${lockPath}.reap-${token}`;
              if (!await electGenerationCleaner(lockPath, token, clock, {
                processIdentity: owner.processIdentity, directory: directoryStamp(generation),
              })) throw new Error("connector_lock_retirement_busy");
              await unlink(ownerPath); await rmdir(lockPath); await unlink(retirement);
            } finally { await releaseGuard.close(); }
          };
        }
        if (dead && current.owner && sameDirectory(observed.info, current.info)
          && current.owner.token === observed.owner.token && current.owner.pid === observed.owner.pid
          && current.owner.processIdentity === observed.owner.processIdentity
          && !await sameProcess(current.owner.pid, current.owner.processIdentity, isPidAlive, inspect)) {
          const generation = lockGeneration(current.info, current.owner.token);
          const marker = `${lockPath}.reap-${generation}`;
          // A cleaner may itself have died. Under the kernel guard no other
          // cleaner can be removing/replacing this marker or this generation.
          let abandonedMarker = false;
          try {
            const markerOwner = await rotationCleaner(marker, staleMs, clock);
            if (markerOwner === abandonedCleanerMarker) abandonedMarker = true;
            else if (!await sameProcess(markerOwner.pid, markerOwner.processIdentity, isPidAlive, inspect)) await unlink(marker);
          } catch (error) { if (error.code !== "ENOENT") throw error; }
          // An abandoned marker holds the generation's name, so electing a
          // cleaner under it cannot succeed. It is also older than the whole
          // stale window, so it cannot be a live cleaner of this generation:
          // the guard plus the recheck below retire it without touching it.
          if (abandonedMarker || await electGenerationCleaner(lockPath, generation, clock, {
            processIdentity: owner.processIdentity, directory: directoryStamp(current.info),
          })) {
            retry = true;
            if (!abandonedMarker) await afterCleanerElection({ lockPath, generation, observedOwnerPath: current.path });
            let checked;
            // A cleaner outside this protocol can retire the generation between
            // the read above and this recheck. There is then nothing left to
            // retire: a marker THIS attempt elected itself is its own to retire,
            // while an abandoned one is not ours and stays exactly as it is.
            try { checked = await rotationOwner(lockPath); }
            catch (error) {
              if (error.code !== "ENOENT") throw error;
              if (!abandonedMarker) await unlink(marker).catch(removal => { if (removal.code !== "ENOENT") throw removal; });
              continue;
            }
            if (sameDirectory(current.info, checked.info) && checked.owner?.token === current.owner.token
              && checked.owner.pid === current.owner.pid && checked.owner.processIdentity === current.owner.processIdentity
              && !await sameProcess(checked.owner.pid, checked.owner.processIdentity, isPidAlive, inspect)) {
              await unlink(current.path);
              if (current.info.isDirectory()) await rmdir(lockPath);
              // An abandoned marker is never deleted: this retirement proves
              // only the owner record, never the identity of those bytes.
              if (!abandonedMarker) await unlink(marker);
            }
          }
        } else if (!current.owner) {
          // The only new ownerless window is a cleaner/releaser killed after
          // owner unlink. A complete election never creates this shape. The
          // guard proves no new transaction is in that window; generation is
          // checked again before retiring an empty directory.
          if (!current.info.isDirectory() || (await readdir(lockPath)).length !== 0)
            throw new Error("connector_lock_owner_unidentified");
          const markers = (await readdir(dirname(lockPath))).filter(name => name.startsWith(`${basename(lockPath)}.reap-`)
            && /^[a-f0-9]{32}$/u.test(name.slice(`${basename(lockPath)}.reap-`.length)));
          let proven = false;
          for (const name of markers) {
            const markerOwner = await rotationCleaner(join(dirname(lockPath), name), staleMs, clock);
            // An abandoned marker carries no directory stamp, so it can never
            // prove anything about THIS directory; it is simply not evidence,
            // and the refusal below then names the exact path for the owner
            // instead of wedging every later start.
            if (matchesDirectoryStamp(markerOwner.directory, current.info)
              && !await sameProcess(markerOwner.pid, markerOwner.processIdentity, isPidAlive, inspect)) proven = true;
          }
          const legacyContenders = proven ? [] : await abandonedRotationContenders(lockPath, isPidAlive, inspect);
          if (!proven && legacyContenders.length === 0) throw new Error(`The credential lock ${lockPath} is stale but has no owner record. Remove that exact directory only after checking that no connector is running for this profile.`);
          const generation = lockGeneration(current.info);
          const legacyMarker = `${lockPath}.reap-${generation}`;
          let legacyElected = false;
          if (!proven) {
            legacyElected = await electGenerationCleaner(lockPath, generation, clock, {
              processIdentity: owner.processIdentity, directory: directoryStamp(current.info),
            });
            if (!legacyElected) { retry = false; }
            else await afterCleanerElection({ lockPath, generation, observedOwnerPath: null });
          }
          if (proven || legacyElected) {
            if (!sameDirectory(current.info, await lstat(lockPath)) || (await readdir(lockPath)).length !== 0)
              throw new Error("connector_lock_generation_changed");
            for (const contender of legacyContenders) {
              const checked = await lstat(contender.path);
              if (checked.dev !== contender.info.dev || checked.ino !== contender.info.ino
                || await sameProcess(contender.owner.pid, contender.owner.processIdentity, isPidAlive, inspect))
                throw new Error("connector_lock_contender_changed");
            }
            await rmdir(lockPath);
            for (const contender of legacyContenders) await unlink(contender.path);
            if (legacyElected) await unlink(legacyMarker);
            retry = true;
          }
        }
      } finally { await guard.close(); }
      if (!retry) await wait();
      // A failed election always checks its deadline and sleeps.
    }
  } finally {
    await rm(contenderPath, { force: true });
    if (!elected) {
      await rm(join(candidatePath, ownerName), { force: true });
      await rmdir(candidatePath).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
}

// Compatibility recovery for the previous mkdir-before-owner protocol. Its
// synced outside contenders identify every possible publisher. All must be
// proven dead; the kernel guard and generation recheck serialize retirement.
async function abandonedRotationContenders(lockPath, isPidAlive, inspect) {
  const prefix = `${basename(lockPath)}.`, abandoned = [];
  for (const entry of await readdir(dirname(lockPath))) {
    if (!entry.startsWith(prefix)) continue;
    const match = /^(\d+)\.([a-f0-9]{32})\.tmp$/u.exec(entry.slice(prefix.length));
    if (!match) continue;
    const path = join(dirname(lockPath), entry), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096 || (info.mode & 0o077) !== 0)
      throw new Error("connector_lock_contender_unidentified");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let owner;
    try {
      const opened = await handle.stat();
      if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("connector_lock_contender_changed");
      owner = JSON.parse(await handle.readFile("utf8"));
    } finally { await handle.close(); }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1
      || owner.pid !== Number(match[1]) || owner.token !== match[2]) throw new Error("connector_lock_contender_unidentified");
    if (await sameProcess(owner.pid, owner.processIdentity, isPidAlive, inspect)) throw rotationBusy();
    abandoned.push({ path, info, owner });
  }
  return abandoned;
}

/** A marker this protocol published is a complete, synced record, so a marker
 * it cannot identify was never one of its live cleaners. An unidentifiable
 * marker younger than staleMs may still belong to a cleaner between opening
 * and writing its record, so it fails closed. An older one is abandoned by
 * construction: it is never deleted, because nothing proves the bytes are
 * ours, but it must not wedge every later start either.
 *
 * It carries no `directory` stamp, so `matchesDirectoryStamp` can never match
 * it against a real generation: an abandoned marker is never evidence that a
 * particular directory was retired by a cleaner. */
const abandonedCleanerMarker = Object.freeze({ abandoned: true });

async function rotationCleaner(path, staleMs, clock) {
  try { return (await rotationOwner(path, true)).owner; }
  catch (error) {
    if (error.code === "ENOENT") throw error;
    let age;
    try { age = clock() - (await lstat(path)).mtimeMs; } // never follows the marker
    catch { throw new Error("connector_lock_cleaner_unidentified"); }
    if (age < staleMs) throw new Error("connector_lock_cleaner_unidentified");
    return abandonedCleanerMarker;
  }
}

async function rotationOwner(path, publicationLink = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("connector_lock_owner_unidentified");
  let ownerPath = path;
  if (info.isDirectory()) {
    const entries = await readdir(path);
    if (entries.length === 0) return { info, owner: null, path: null };
    if (entries.length !== 1 || !/^owner-[a-f0-9]{32}\.json$/u.test(entries[0]))
      throw new Error(`The credential lock ${path} is stale but has no valid owner PID.`);
    ownerPath = join(path, entries[0]);
  } else if (!info.isFile()) throw new Error("connector_lock_owner_unidentified");
  const ownerInfo = await lstat(ownerPath);
  if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || (ownerInfo.nlink !== 1 && !(publicationLink && ownerInfo.nlink === 2)) || ownerInfo.size > 4096
    || publicationLink && ((ownerInfo.mode & 0o077) !== 0 || ownerInfo.uid !== process.getuid()))
    throw new Error("connector_lock_owner_unidentified");
  const handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let owner;
  try {
    const opened = await handle.stat();
    if (opened.dev !== ownerInfo.dev || opened.ino !== ownerInfo.ino) throw new Error("connector_lock_generation_changed");
    try { owner = JSON.parse(await handle.readFile("utf8")); }
    catch { throw new Error(`The credential lock ${path} is stale but has no valid owner PID.`); }
  } finally { await handle.close(); }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1
    || (info.isDirectory() && basename(ownerPath) !== `owner-${owner.token}.json`))
    throw new Error("connector_lock_owner_unidentified");
  return { info, owner, path: ownerPath };
}

async function acquireLegacyRotationLock(lockPath, { staleMs = ROTATION_LOCK_STALE_MS, waitMs = 25,
  deadlineMs = 10_000, clock = Date.now, sleep = ms => new Promise(done => setTimeout(done, ms)),
  beforeDeadOwnerCleanup = async () => {}, afterDirectoryElection = async () => {},
  afterOwnerPublication = async () => {}, afterCleanerElection = async () => {},
  getProcessIdentity: inspectProcessIdentity = getProcessIdentity,
  isPidAlive = pidAlive } = {}) {
  const started = clock(), token = randomBytes(16).toString("hex");
  const contenderPath = `${lockPath}.${process.pid}.${token}.tmp`;
  const ownerPath = join(lockPath, `owner-${token}.json`);
  const owner = { pid: process.pid, processIdentity: await inspectProcessIdentity(process.pid),
    acquiredAt: new Date(clock()).toISOString(), token };
  const handle = await open(contenderPath, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(owner)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await pruneReaperMarkers(lockPath, staleMs, clock);
  try {
    for (;;) {
      try {
        // mkdir is the atomic election: exactly one contender can own the
        // canonical path. The complete owner record is then atomically renamed
        // into it before that contender begins any protected work.
        await mkdir(lockPath, { mode: 0o700 });
        await afterDirectoryElection({ lockPath, token });
        await rename(contenderPath, ownerPath);
        await afterOwnerPublication({ lockPath, ownerPath, token });
        return async () => {
          try {
            const current = JSON.parse(await readFile(ownerPath, "utf8"));
            if (current?.token !== token) throw new Error("The credential lock changed owners before it could be released.");
            await unlink(ownerPath);
            await rmdir(lockPath);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let age = 0, ownerPid = null, ownerIdentity = null, ownerToken = "", lockIsDirectory = false, ownerMissing = false;
        let observedOwnerPath = null, lockInfo;
        try {
          lockInfo = await stat(lockPath);
          age = clock() - lockInfo.mtimeMs;
          lockIsDirectory = lockInfo.isDirectory();
          let raw;
          if (lockIsDirectory) {
            const entries = await readdir(lockPath);
            const owners = entries.filter(entry => /^owner-[a-f0-9]{32}\.json$/u.test(entry));
            if (entries.length === 0) ownerMissing = true;
            else if (entries.length === 1 && owners.length === 1) {
              observedOwnerPath = join(lockPath, owners[0]);
              ownerToken = owners[0].slice("owner-".length, -".json".length);
              raw = await readFile(observedOwnerPath, "utf8");
            }
          } else {
            raw = await readFile(lockPath, "utf8");
          }
          if (!ownerMissing && raw !== undefined) {
            try {
              const parsed = JSON.parse(raw);
              if (Number.isSafeInteger(parsed?.pid) && parsed.pid > 0
                && (!lockIsDirectory || parsed.token === ownerToken)) {
                ownerPid = parsed.pid;
                ownerIdentity = typeof parsed.processIdentity === "string" ? parsed.processIdentity : null;
              }
            } catch {
              // Older connector versions exposed the lock before writing its JSON.
              // A fresh partial record is retried; a stale one still fails closed.
              ownerPid = null;
            }
          }
        }
        catch (readError) {
          if (["ENOENT", "EISDIR", "ENOTDIR"].includes(readError?.code)) continue;
          throw readError;
        }
        // A dead owner can never release its lock, even if the file is fresh. A
        // live owner is never displaced merely because its work took longer
        // than expected. Malformed locks fail closed instead of guessing.
        if (ownerPid !== null && !await sameProcess(ownerPid, ownerIdentity, isPidAlive, inspectProcessIdentity)) {
          await beforeDeadOwnerCleanup({ lockPath, observedOwnerPath });
          const generation = lockGeneration(lockInfo, ownerToken);
          const elected = await electGenerationCleaner(lockPath, generation, clock);
          if (!elected) {
            if (clock() - started >= deadlineMs) throw new Error("Another session is renewing this bot credential. Try again shortly.");
            await sleep(waitMs);
            continue;
          }
          await afterCleanerElection({ lockPath, generation, observedOwnerPath });
          if (lockIsDirectory) {
            let current;
            try { current = JSON.parse(await readFile(observedOwnerPath, "utf8")); }
            catch (removeError) {
              if (removeError?.code === "ENOENT") continue;
              throw removeError;
            }
            if (current?.token !== ownerToken || current?.pid !== ownerPid
              || (typeof current?.processIdentity === "string" ? current.processIdentity : null) !== ownerIdentity
              || await sameProcess(ownerPid, ownerIdentity, isPidAlive, inspectProcessIdentity)) continue;
            await unlink(observedOwnerPath);
            try { await rmdir(lockPath); } catch (removeError) {
              if (removeError?.code !== "ENOENT" && removeError?.code !== "ENOTEMPTY") throw removeError;
            }
          } else {
            const currentInfo = await stat(lockPath);
            if (String(currentInfo.dev) !== String(lockInfo.dev) || String(currentInfo.ino) !== String(lockInfo.ino)) continue;
            let current;
            try { current = JSON.parse(await readFile(lockPath, "utf8")); } catch { continue; }
            if (current?.pid !== ownerPid
              || (typeof current?.processIdentity === "string" ? current.processIdentity : null) !== ownerIdentity
              || await sameProcess(ownerPid, ownerIdentity, isPidAlive, inspectProcessIdentity)) continue;
            await unlink(lockPath);
          }
          continue;
        }
        if (ownerMissing && age >= staleMs) {
          // Removing an empty directory after observing it is not conditional:
          // another cleaner could replace it with a winner's fresh directory.
          // Fail closed instead of compromising mutual exclusion.
          throw new Error(`The credential lock ${lockPath} is stale but has no owner record. Remove that exact directory only after checking that no connector is running for this profile.`);
        }
        if (age >= staleMs && ownerPid === null)
          throw new Error(`The credential lock ${lockPath} is stale but has no valid owner PID. Remove that exact path only after checking that no connector is running for this profile.`);
        if (clock() - started >= deadlineMs) throw new Error("Another session is renewing this bot credential. Try again shortly.");
        await sleep(waitMs);
      }
    }
  } catch (error) {
    try { await unlink(contenderPath); } catch (removeError) { if (removeError?.code !== "ENOENT") throw removeError; }
    throw error;
  }
}
