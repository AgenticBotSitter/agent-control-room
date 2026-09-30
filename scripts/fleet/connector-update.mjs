// Signed, crash-safe connector self-update support. This module deliberately
// owns the updater state machine; connector.mjs only wires it into commands.
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CONNECTOR_UPDATE_SIGNATURE_SCHEMA_V1 = "control-room.fleet-connector-signature/v1";
export const CONNECTOR_UPDATE_STATE_SCHEMA_V1 = "control-room.fleet-connector-update-state/v1";
export const MAX_CONNECTOR_RELEASE_BYTES_V1 = 16 * 1024 * 1024;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{56,128}$/u;
const UPDATE_LOCK_WAIT_MS = 30_000;

const refused = reason => {
  const error = new Error(`connector_update_refused:${reason}`);
  error.code = "connector_update_refused";
  throw error;
};

export function compareConnectorVersionsV1(left, right) {
  if (!VERSION_PATTERN.test(left ?? "") || !VERSION_PATTERN.test(right ?? "")) refused("version");
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

function cleanRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refused("advertisement");
  const allowed = ["builtFrom", "file", "minVersion", "sha256", "signature", "size", "version"];
  if (Object.keys(value).sort().join(",") !== allowed.join(",")) refused("advertisement");
  if (!VERSION_PATTERN.test(value.version ?? "") || value.file !== `connector-${value.version}.mjs`
    || !VERSION_PATTERN.test(value.minVersion ?? "") || compareConnectorVersionsV1(value.version, value.minVersion) < 0
    || !DIGEST_PATTERN.test(value.sha256 ?? "") || !SIGNATURE_PATTERN.test(value.signature ?? "")
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_CONNECTOR_RELEASE_BYTES_V1
    || typeof value.builtFrom !== "string" || !/^[a-f0-9]{40}$/u.test(value.builtFrom)) refused("advertisement");
  return Object.freeze({ version: value.version, file: value.file, sha256: value.sha256, size: value.size,
    builtFrom: value.builtFrom, minVersion: value.minVersion, signature: value.signature });
}

export function connectorReleaseSignatureMaterialV1(value) {
  const release = cleanRelease({ ...value, signature: value.signature ?? "A".repeat(86) });
  return Buffer.from(`${CONNECTOR_UPDATE_SIGNATURE_SCHEMA_V1}\n${release.version}\n${release.file}\n${release.size}\n${release.sha256}\n${release.builtFrom}\n${release.minVersion}\n`, "utf8");
}

export function validateConnectorReleasePublicKeyV1(value) {
  if (typeof value !== "string" || !PUBLIC_KEY_PATTERN.test(value)) refused("public_key");
  let key;
  try { key = createPublicKey({ key: Buffer.from(value, "base64url"), format: "der", type: "spki" }); }
  catch { refused("public_key"); }
  if (key.asymmetricKeyType !== "ed25519") refused("public_key");
  return value;
}

export function verifyConnectorReleaseAdvertisementV1(value, pinnedPublicKey) {
  const release = cleanRelease(value);
  const key = createPublicKey({ key: Buffer.from(validateConnectorReleasePublicKeyV1(pinnedPublicKey), "base64url"),
    format: "der", type: "spki" });
  if (!verify(null, connectorReleaseSignatureMaterialV1(release), key, Buffer.from(release.signature, "base64url")))
    refused("signature");
  return release;
}

export function connectorUpdatePathsV1(installRoot) {
  if (typeof installRoot !== "string" || !isAbsolute(installRoot) || resolve(installRoot) !== installRoot) refused("install_root");
  return Object.freeze({ installRoot, launcher: join(installRoot, "launcher.mjs"), versions: join(installRoot, "versions"),
    current: join(installRoot, "current.json"), previous: join(installRoot, "previous.json"),
    pending: join(installRoot, "update.pending.json"), state: join(installRoot, "update-state.json"),
    policy: join(installRoot, "update-policy.json"), lock: join(installRoot, "update.lock") });
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

async function requireRealDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) refused("directory");
}

export async function installConnectorLauncherV1({ installRoot, sourcePath, version, platform = process.platform,
  nodePath = process.execPath, shimPath }) {
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
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: clock() })); await handle.sync(); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(await readFile(path, "utf8")); } catch {}
      let alive = false;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) try { process.kill(owner.pid, 0); alive = true; } catch (e) { alive = e?.code !== "ESRCH"; }
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

async function downloadRelease(release, config, fetcher, destination) {
  const response = await fetcher(`${config.server}/fleet/v1/connector-releases/${encodeURIComponent(release.version)}`, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000), headers: {
      accept: "text/javascript", authorization: `Bearer ${config.secret}`, "x-control-room-worker": config.workerId,
    },
  });
  if (!response.ok || !response.body) refused(`download_${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== release.size) refused("size");
  const handle = await open(destination, "wx", 0o700);
  const digest = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > release.size || size > MAX_CONNECTOR_RELEASE_BYTES_V1) refused("size");
      digest.update(chunk); await handle.write(chunk);
    }
    await handle.sync();
  } finally { await handle.close(); }
  if (size !== release.size || digest.digest("hex") !== release.sha256) refused("digest");
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
  const healthy = inside(paths.installRoot, candidate) && await healthCheck(candidate, configPath);
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
  minimumCheckIntervalMs = 0 }) {
  const paths = connectorUpdatePathsV1(installRoot);
  return withUpdateLock(paths.lock, async () => {
    const recovered = await recoverPendingUnlocked(paths, configPath, healthCheck);
    if (recovered?.state === "reverted") return recovered;
    const priorState = await readJson(paths.state, true);
    if (minimumCheckIntervalMs > 0 && Number.isSafeInteger(priorState?.checkedAt)
      && clock() - priorState.checkedAt < minimumCheckIntervalMs)
      return Object.freeze({ state: "recently_checked" });
    const freshConfig = JSON.parse(await readFile(configPath, "utf8"));
    const updates = freshConfig.installation?.updates ?? config.installation?.updates;
    const policy = await readJson(paths.policy, true);
    if (policy && (policy.schema !== CONNECTOR_UPDATE_STATE_SCHEMA_V1 || typeof policy.paused !== "boolean"
      || Object.keys(policy).sort().join(",") !== "paused,schema")) refused("policy");
    if (!updates || policy?.paused === true) return Object.freeze({ state: "paused" });
    const release = verifyConnectorReleaseAdvertisementV1(advertised, updates.releasePublicKey);
    if (compareConnectorVersionsV1(release.version, updates.floorVersion) < 0) refused("below_floor");
    const active = capturePointer(await readJson(paths.current));
    if (active.version !== currentVersion && compareConnectorVersionsV1(active.version, currentVersion) > 0)
      return Object.freeze({ state: "coalesced", version: active.version });
    if (compareConnectorVersionsV1(release.version, active.version) <= 0) {
      await atomicJson(paths.state, { schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1, checkedAt: clock() });
      return Object.freeze({ state: "current", version: active.version });
    }
    const directory = join(paths.versions, release.version), target = join(directory, "connector.mjs");
    if (!inside(paths.installRoot, target)) refused("target");
    await requireRealDirectory(paths.installRoot); await requireRealDirectory(paths.versions);
    await mkdir(directory, { recursive: true, mode: 0o700 }); await requireRealDirectory(directory);
    const temporary = join(directory, `connector.${process.pid}.${randomBytes(5).toString("hex")}.tmp`);
    try { await downloadRelease(release, freshConfig, fetcher, temporary); await fault("downloaded");
      await rm(target, { force: true }); await rename(temporary, target); await fault("version_ready"); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    const from = active, to = pointer(release.version);
    await atomicJson(paths.previous, from); await fault("previous_written");
    await atomicJson(paths.pending, { schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1, from, to }); await fault("pending_written");
    await atomicJson(paths.current, to); await fault("pointer_switched");
    const result = await recoverPendingUnlocked(paths, configPath, healthCheck);
    await atomicJson(paths.state, { schema: CONNECTOR_UPDATE_STATE_SCHEMA_V1, checkedAt: clock() });
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
  await recoverPendingConnectorUpdateV1({ installRoot, configPath, healthCheck });
  const selected = capturePointer(await readJson(paths.current));
  const target = join(paths.installRoot, selected.file);
  if (!inside(paths.installRoot, target)) refused("target");
  return new Promise((resolveLaunch, reject) => {
    const child = spawnProcess(process.execPath, [target, ...args], { shell: false, stdio: "inherit", env: process.env });
    child.once("error", reject); child.once("close", (code, signal) => resolveLaunch(code ?? (signal ? 1 : 0)));
  });
}

export function connectorInstallRootFromConfigPathV1(configPath, env = process.env, platform = process.platform) {
  if (env.CONTROL_ROOM_CONNECTOR_INSTALL_ROOT) return resolve(env.CONTROL_ROOM_CONNECTOR_INSTALL_ROOT);
  if (platform === "win32" && env.LOCALAPPDATA) return resolve(env.LOCALAPPDATA, "ControlRoom", "mcp");
  if (platform !== "win32" && env.XDG_DATA_HOME) return resolve(env.XDG_DATA_HOME, "control-room", "mcp");
  const configRoot = dirname(dirname(resolve(configPath)));
  if (platform === "win32") return resolve(configRoot, "..", "..", "Local", "ControlRoom", "mcp");
  return resolve(configRoot, "..", "share", "control-room", "mcp");
}
