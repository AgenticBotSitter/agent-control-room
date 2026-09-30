#!/usr/bin/env node
// Control Room worker connector. One file, no dependencies, Node 20 or newer.
//
// It runs on a worker machine and only ever connects OUT to the Control Room
// fleet gateway. It never holds a database login or an owner session. Its one
// credential is generated here; only the credential's SHA-256 digest is sent
// to Control Room, and it is stored locally in a file only this user can read.
//
//   node connector.mjs join --server https://control.example --code crj_... --bot codex
//   node connector.mjs status | rotate | run | work | claims | mcp
//
// "mcp" starts a Model Context Protocol server on stdin/stdout so any
// MCP-capable agent can list, claim and report work through the same queue,
// permissions and records as the website. It cannot approve, accept, merge or
// widen permissions: the gateway has no such routes.

import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile, chmod, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join as joinPath, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkForConnectorUpdateV1, connectorInstallRootForLaunchV1, connectorInstallRootFromConfigPathV1,
  connectorUpdatesPausedV1, installConnectorLauncherV1, launchCurrentConnectorV1,
  setConnectorUpdatesPausedV1 } from "./connector-update.mjs";
import { captureReleaseTrustV1, compareReleaseVersionsV1, verifyConnectorReleaseAdvertisementV1 } from "../release-signing.mjs";

export { verifyConnectorReleaseAdvertisementV1 };

export const CONNECTOR_VERSION = "0.4.0";
const EMBEDDED_RELEASE_TRUST_V1 = typeof __CONTROL_ROOM_RELEASE_TRUST_V1__ === "undefined"
  ? null : __CONTROL_ROOM_RELEASE_TRUST_V1__;
const CONFIG_SCHEMA = "control-room.fleet-connector/v1";
const SECRET_PATTERN = /^crf_[A-Za-z0-9_-]{43}$/u;
const CODE_PATTERN = /^crj_[A-Za-z0-9_-]{43}$/u;
const WORKER_PATTERN = /^fleet-worker:[a-f0-9]{32}$/u;
const ROTATE_BEFORE_MS = 7 * 86_400_000;
const MEDIA_TYPES = Object.freeze({ ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown",
  ".csv": "text/csv", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".pdf": "application/pdf" });
const MAX_FILE_BYTES = 262_144;
const MAX_RESULT_BYTES = 65_536;
const MAX_PROPOSAL_BYTES = 256 * 1024;
const MAX_MCP_MESSAGE_BYTES = 512 * 1024;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u;
const OFFER_PATTERN = /^fleet-offer:[a-f0-9]{32}$/u;
const CLAIM_PATTERN = /^fleet-claim:[a-f0-9]{32}$/u;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
let bundledHarnessAdapterFactory = null;

/** The build entry registers the reviewed harness factory before invoking the
 * CLI. Source-mode tests retain the explicit adapter-module seam. */
export function registerBundledHarnessAdapterFactory(factory) {
  if (bundledHarnessAdapterFactory || typeof factory !== "function")
    throw new Error("The bundled harness adapter factory is not valid.");
  bundledHarnessAdapterFactory = factory;
}
const BOT_KINDS = Object.freeze(["claude-code", "codex", "hermes", "claude-desktop", "cursor"]);
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ROTATION_LOCK_STALE_MS = 5 * 60_000;
const INSTALL_LOCK_DEADLINE_MS = 10 * 60_000;
let ownProcessIdentity;

export const sha256 = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const newSecret = () => `crf_${randomBytes(32).toString("base64url")}`;
export const newEnrollmentNonce = () => `crn_${randomBytes(32).toString("base64url")}`;

export function connectorUpdateSettingsFromReleaseTrustV1(value) {
  const trust = captureReleaseTrustV1(value);
  return Object.freeze({ releasePublicKey: trust.publicKey, floorVersion: trust.versionFloor,
    keyId: trust.keyId, epoch: trust.epoch, revokedKeyIds: trust.revokedKeyIds, paused: false });
}

export function embeddedConnectorReleaseTrustV1() {
  return EMBEDDED_RELEASE_TRUST_V1 === null ? null : captureReleaseTrustV1(EMBEDDED_RELEASE_TRUST_V1);
}

function commandOutput(command, args) {
  return new Promise(resolveOutput => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let output = "", settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutput(value);
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(""); }, 2_000);
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", () => finish(""));
    child.once("close", code => finish(code === 0 ? output.trim() : ""));
  });
}

async function processIdentity(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
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
  } catch {
    return null;
  }
}

function currentProcessIdentity() {
  ownProcessIdentity ??= processIdentity(process.pid);
  return ownProcessIdentity;
}

async function sameProcess(pid, expectedIdentity, isPidAlive, getProcessIdentity) {
  if (!isPidAlive(pid)) return false;
  if (typeof expectedIdentity !== "string" || expectedIdentity.length === 0) return true;
  const currentIdentity = await getProcessIdentity(pid);
  return currentIdentity === null || currentIdentity === expectedIdentity;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function getProcessIdentity(pid) {
  return pid === process.pid ? currentProcessIdentity() : processIdentity(pid);
}

export function platformName(value = process.platform) {
  return value === "darwin" ? "macos" : value === "win32" ? "windows" : value === "linux" ? "linux" : "other";
}

export function defaultConfigPath(env = process.env) {
  if (env.CONTROL_ROOM_CONNECTOR_CONFIG) return resolve(env.CONTROL_ROOM_CONNECTOR_CONFIG);
  if (process.platform === "win32" && env.APPDATA) return joinPath(env.APPDATA, "control-room", "connector.json");
  return joinPath(env.XDG_CONFIG_HOME || joinPath(homedir(), ".config"), "control-room", "connector.json");
}

export function connectorInstallPaths({ homeDir, env = process.env, platform = process.platform, name, workspace }) {
  if (!PROFILE_PATTERN.test(name ?? ""))
    throw new Error("The bot name must be 1 to 64 letters, numbers, dots, dashes or underscores.");
  const configRoot = platform === "win32"
    ? joinPath(env.APPDATA || joinPath(homeDir, "AppData", "Roaming"), "control-room")
    : joinPath(env.XDG_CONFIG_HOME || joinPath(homeDir, ".config"), "control-room");
  const installRoot = platform === "win32"
    ? joinPath(env.LOCALAPPDATA || joinPath(homeDir, "AppData", "Local"), "ControlRoom", "mcp")
    : joinPath(env.XDG_DATA_HOME || joinPath(homeDir, ".local", "share"), "control-room", "mcp");
  const workspaceRoot = resolve(workspace || joinPath(homeDir, "ControlRoomWork", name));
  return Object.freeze({
    configRoot,
    configPath: joinPath(configRoot, "bots", `${name}.json`),
    botsDir: joinPath(configRoot, "bots"),
    installRoot,
    versionDir: joinPath(installRoot, "versions", CONNECTOR_VERSION),
    connectorPath: joinPath(installRoot, "launcher.mjs"),
    currentPointerPath: joinPath(installRoot, "current.json"),
    shimPath: joinPath(installRoot, "bin", platform === "win32" ? "control-room-mcp.cmd" : "control-room-mcp"),
    workspace: workspaceRoot,
  });
}

/** HTTPS is required, except loopback and the Tailscale address range, whose
 * traffic is already end-to-end encrypted by WireGuard. */
export function checkServer(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("The server address is not a valid URL."); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new Error("Use only the server address, for example https://control.example");
  const host = url.hostname;
  const tailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/u.test(host);
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || tailnet)))
    throw new Error("The server must use https:// (plain http is allowed only on this machine or a Tailscale address).");
  return url.origin;
}

async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

export async function loadConfig(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); } catch { throw new Error("This machine has not joined yet. Run: join --server <address> --code <code>"); }
  if (process.platform !== "win32") {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) throw new Error(`The credential file ${path} is readable by other users. Run: chmod 600 ${path}`);
  }
  const config = JSON.parse(raw);
  if (config.schema !== CONFIG_SCHEMA || !SECRET_PATTERN.test(config.secret ?? "")
    || (config.workerId !== null && !WORKER_PATTERN.test(config.workerId ?? ""))) throw new Error("The credential file is not valid.");
  checkServer(config.server);
  return config;
}

export function createClient(config, fetcher = globalThis.fetch) {
  async function call(method, path, body, secret = config.secret, extraHeaders = {}) {
    const response = await fetcher(`${config.server}${path}`, { method, redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(config.workerId ? { "x-control-room-worker": config.workerId } : {}),
        ...extraHeaders,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let value;
    try { value = await response.json(); } catch { value = {}; }
    if (!response.ok || value.ok !== true) {
      const error = new Error(`Control Room refused the request (${value.error ?? response.status}).`);
      error.code = value.error ?? `http_${response.status}`;
      throw error;
    }
    return value.result;
  }
  return Object.freeze({
    enroll: body => call("POST", "/fleet/v1/enroll", body, null),
    me: () => call("GET", "/fleet/v1/me"),
    heartbeat: () => call("POST", "/fleet/v1/heartbeat", { connectorVersion: CONNECTOR_VERSION, platform: platformName() }),
    rotate: (digest, secret) => call("POST", "/fleet/v1/rotate", { newCredentialDigest: digest }, secret),
    work: () => call("GET", "/fleet/v1/work"),
    claims: () => call("GET", "/fleet/v1/claims"),
    claim: (offerId, idempotencyKey) => call("POST", "/fleet/v1/claims", { offerId, idempotencyKey }),
    progress: (claimId, message, idempotencyKey) => call("POST", `/fleet/v1/claims/${claimId}/progress`, { message, idempotencyKey }),
    blocker: (claimId, message, idempotencyKey, release) => call("POST", `/fleet/v1/claims/${claimId}/blocker`,
      { message, idempotencyKey, ...(release ? { release: true } : {}) }),
    result: (claimId, summary, files, idempotencyKey) => call("POST", `/fleet/v1/claims/${claimId}/result`,
      { summary, idempotencyKey, ...(files.length ? { files } : {}) }),
    propose: (projectId, proposal, idempotencyKey) => call("POST",
      `/fleet/v1/projects/${encodeURIComponent(projectId)}/proposals`, { proposal, idempotencyKey }),
    mcpCall: (callId, toolName) => call("POST", "/fleet/v1/mcp/calls", { callId, toolName }, config.secret,
      { "x-control-room-mcp-call": callId, "x-control-room-mcp-tool": toolName }),
  });
}

/** @param {{ server: string, code: string, workerKind: string, configPath: string, fetcher?: typeof fetch,
 * writeConfig?: (path: string, value: object) => Promise<void>, expectedReleaseTrust?: object | null }} options */
export async function join({ server, code, workerKind, configPath, fetcher, writeConfig = writePrivate,
  expectedReleaseTrust = embeddedConnectorReleaseTrustV1() }) {
  const origin = checkServer(server);
  if (!CODE_PATTERN.test(code ?? "")) throw new Error("The join code is not valid. Copy it again from the Workers page.");
  if (typeof workerKind !== "string" || !/^[a-z][a-z0-9-]{1,39}$/u.test(workerKind))
    throw new Error("The worker kind is required to redeem a join code.");
  const codeDigest = sha256(code);
  let pending;
  try {
    await stat(configPath);
    pending = await loadConfig(configPath);
  } catch (error) {
    if ((error?.code ?? "") !== "ENOENT" && !String(error?.message ?? "").startsWith("This machine has not joined yet.")) throw error;
  }
  if (pending?.workerId) throw new Error("This machine has already joined. Use status or rotate instead.");
  if (pending && (pending.server !== origin || pending.codeDigest !== codeDigest || pending.workerKind !== workerKind
    || !/^crn_[A-Za-z0-9_-]{43}$/u.test(pending.clientNonce ?? "")))
    throw new Error("A different join is already pending in this credential file. Finish it with the original server and code.");
  const secret = pending?.secret ?? newSecret();
  const clientNonce = pending?.clientNonce ?? newEnrollmentNonce();
  // The secret, code binding and nonce are saved before use. A lost response
  // retries this exact enrollment instead of consuming a second credential.
  await writeConfig(configPath, { schema: CONFIG_SCHEMA, server: origin, workerId: null, secret,
    credentialExpiresAt: null, codeDigest, clientNonce, workerKind });
  const client = createClient({ server: origin, workerId: null, secret }, fetcher);
  let result;
  try {
    result = await client.enroll({ code, workerKind, credentialDigest: sha256(secret), platform: platformName(),
      architecture: process.arch, connectorVersion: CONNECTOR_VERSION, clientNonce });
  } catch (error) {
    // A refusal is final for this code. Network failures and server failures
    // retain the nonce and secret because the redemption may have committed.
    const transient = typeof error?.code === "string" && (error.code === "rate_limited"
      || ["http_408", "http_429"].includes(error.code) || /^http_5\d\d$/u.test(error.code));
    if (typeof error?.code === "string" && !transient) await removeConfigArtifacts(configPath);
    throw error;
  }
  if (result.workerKind !== workerKind) {
    await removeConfigArtifacts(configPath);
    throw new Error(`This code was made for ${result.workerKind ?? "another bot"}, not ${workerKind}. Nothing was installed. Remove the worker in Control Room and create a code for ${workerKind}.`);
  }
  let updates;
  try {
    const gatewayTrust = captureReleaseTrustV1(result.releaseTrust);
    const trusted = expectedReleaseTrust === null ? gatewayTrust : captureReleaseTrustV1(expectedReleaseTrust);
    if (expectedReleaseTrust !== null && JSON.stringify(gatewayTrust) !== JSON.stringify(trusted))
      throw new Error("release trust mismatch");
    const release = verifyConnectorReleaseAdvertisementV1(result.connector, trusted);
    updates = connectorUpdateSettingsFromReleaseTrustV1({ ...trusted,
      versionFloor: compareReleaseVersionsV1(release.minVersion, trusted.versionFloor) > 0
        ? release.minVersion : trusted.versionFloor });
  }
  catch {
    await removeConfigArtifacts(configPath);
    throw new Error("The Control Room did not provide a valid installation release key. Nothing was installed.");
  }
  await writeConfig(configPath, { schema: CONFIG_SCHEMA, server: origin, workerId: result.workerId, secret,
    credentialExpiresAt: result.credentialExpiresAt, workerKind, updates });
  return result;
}

async function removeConfigArtifacts(configPath) {
  await rm(configPath, { force: true });
  await removeConfigTemporaryFiles(configPath);
}

async function removeConfigTemporaryFiles(configPath) {
  let entries;
  try { entries = await readdir(dirname(configPath)); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  const prefix = `${basename(configPath)}.`;
  await Promise.all(entries.filter(entry => entry.startsWith(prefix) && entry.endsWith(".tmp"))
    .filter(entry => !entry.startsWith(`${basename(configPath)}.rotate.lock.`))
    .map(entry => rm(joinPath(dirname(configPath), entry), { force: true })));
}

function lockGeneration(info, token = "") {
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
    const path = joinPath(dirname(lockPath), entry);
    try { if (clock() - (await stat(path)).mtimeMs >= staleMs) await rm(path, { force: true }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }));
}

async function electGenerationCleaner(lockPath, generation, clock) {
  const markerPath = `${lockPath}.reap-${generation}`;
  let handle;
  try { handle = await open(markerPath, "wx", 0o600); }
  catch (error) { if (error?.code === "EEXIST") return false; throw error; }
  try { await handle.writeFile(`${JSON.stringify({ pid: process.pid, electedAt: new Date(clock()).toISOString() })}\n`); await handle.sync(); }
  finally { await handle.close(); }
  return true;
}

export async function acquireRotationLock(lockPath, { staleMs = ROTATION_LOCK_STALE_MS, waitMs = 25,
  deadlineMs = 10_000, clock = Date.now, sleep = ms => new Promise(done => setTimeout(done, ms)),
  beforeDeadOwnerCleanup = async () => {}, afterDirectoryElection = async () => {},
  afterOwnerPublication = async () => {}, afterCleanerElection = async () => {},
  getProcessIdentity: inspectProcessIdentity = getProcessIdentity,
  isPidAlive = pidAlive } = {}) {
  const started = clock(), token = randomBytes(16).toString("hex");
  const contenderPath = `${lockPath}.${process.pid}.${token}.tmp`;
  const ownerPath = joinPath(lockPath, `owner-${token}.json`);
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
              observedOwnerPath = joinPath(lockPath, owners[0]);
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
          if (!elected) continue;
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

export async function unlockConnector({ name, homeDir, env = process.env, platform = process.platform,
  staleMs = ROTATION_LOCK_STALE_MS, clock = Date.now, isPidAlive = pidAlive,
  getProcessIdentity: inspectProcessIdentity = getProcessIdentity, beforeRemovalCheck = async () => {} } = {}) {
  const paths = connectorInstallPaths({ homeDir, env, platform, name });
  const lockPath = `${paths.configPath}.rotate.lock`;
  let observed;
  try { observed = await stat(lockPath); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error(`No credential lock exists for ${name}.`);
    throw error;
  }
  if (!observed.isDirectory()) throw new Error(`The credential lock for ${name} is not an empty lock directory.`);
  if (clock() - observed.mtimeMs < staleMs)
    throw new Error(`The credential lock for ${name} is not stale yet. Wait before trying unlock again.`);
  const unlockMarker = `${lockPath}.unlock-${lockGeneration(observed)}`;
  let marker;
  try { marker = await open(unlockMarker, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Another unlock check is already running for ${name}.`);
    throw error;
  }
  try {
    await marker.writeFile(`${JSON.stringify({ pid: process.pid, processIdentity: await inspectProcessIdentity(process.pid) })}\n`);
    await marker.sync();
    if ((await readdir(lockPath)).length !== 0)
      throw new Error(`The credential lock for ${name} has an owner record. Use unlock only for an empty stale lock directory.`);

    const directory = dirname(lockPath), prefix = `${basename(lockPath)}.`, suffix = ".tmp";
    const deadContenders = [];
    for (const entry of await readdir(directory)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;
      const match = /^(\d+)\.([a-f0-9]{32})$/u.exec(entry.slice(prefix.length, -suffix.length));
      if (!match) continue;
      const contenderPath = joinPath(directory, entry), contenderPid = Number(match[1]);
      let contenderIdentity = null;
      try {
        const contender = JSON.parse(await readFile(contenderPath, "utf8"));
        if (contender?.pid === contenderPid && contender?.token === match[2]
          && typeof contender.processIdentity === "string") contenderIdentity = contender.processIdentity;
      } catch (error) { if (error?.code === "ENOENT") continue; }
      if (await sameProcess(contenderPid, contenderIdentity, isPidAlive, inspectProcessIdentity))
        throw new Error(`A connector for ${name} is still running. Stop it before using unlock.`);
      deadContenders.push(contenderPath);
    }

    await beforeRemovalCheck({ lockPath });
    const current = await stat(lockPath);
    if (String(current.dev) !== String(observed.dev) || String(current.ino) !== String(observed.ino)
      || !current.isDirectory() || (await readdir(lockPath)).length !== 0)
      throw new Error(`The credential lock for ${name} changed while unlock was checking it. Try again.`);
    await rmdir(lockPath);
    await Promise.all(deadContenders.map(path => rm(path, { force: true })));
    return Object.freeze({ unlocked: name });
  } finally {
    try { await marker.close(); }
    finally { await rm(unlockMarker, { force: true }); }
  }
}

async function recoverPendingUnlocked({ configPath, fetcher }) {
  const config = await loadConfig(configPath);
  if (!config.pendingSecret || !SECRET_PATTERN.test(config.pendingSecret)) return config;
  try { await createClient(config, fetcher).me(); const { pendingSecret: _p, ...rest } = config;
    await writePrivate(configPath, rest); return rest; }
  catch {
    const promoted = { ...config, secret: config.pendingSecret };
    const me = await createClient(promoted, fetcher).me();
    const { pendingSecret: _p, ...rest } = promoted;
    await writePrivate(configPath, { ...rest, credentialExpiresAt: me.credentialExpiresAt });
    return { ...rest, credentialExpiresAt: me.credentialExpiresAt };
  }
}

/** Rotation keeps the next secret on disk first; if the reply is lost the
 * connector tries it on the next start. Concurrent callers that observed the
 * same secret coalesce behind one per-profile lock. */
/** @param {{ configPath: string, fetcher?: typeof fetch, lock?: object }} options */
export async function rotate({ configPath, fetcher, lock }) {
  const observed = await loadConfig(configPath);
  const release = await acquireRotationLock(`${configPath}.rotate.lock`, lock);
  let failure;
  try {
    const config = await recoverPendingUnlocked({ configPath, fetcher });
    if (config.secret !== observed.secret) return Object.freeze({ credentialExpiresAt: config.credentialExpiresAt, coalesced: true });
    const next = newSecret();
    await writePrivate(configPath, { ...config, pendingSecret: next });
    const result = await createClient(config, fetcher).rotate(sha256(next), config.secret);
    const { pendingSecret: _pending, ...rest } = config;
    await writePrivate(configPath, { ...rest, secret: next, credentialExpiresAt: result.credentialExpiresAt });
    return result;
  } catch (error) { failure = error; throw error; }
  finally { await releaseRotationLock(release, failure); }
}

/** @param {{ configPath: string, fetcher?: typeof fetch, lock?: object }} options */
export async function recoverPending({ configPath, fetcher, lock }) {
  const config = await loadConfig(configPath);
  if (!config.pendingSecret || !SECRET_PATTERN.test(config.pendingSecret)) return config;
  const release = await acquireRotationLock(`${configPath}.rotate.lock`, lock);
  let failure;
  try { return await recoverPendingUnlocked({ configPath, fetcher }); }
  catch (error) { failure = error; throw error; }
  finally { await releaseRotationLock(release, failure); }
}

async function releaseRotationLock(release, workError) {
  try { await release(); }
  catch (releaseError) {
    if (!workError) throw releaseError;
    if (workError instanceof Error && workError.cause === undefined) {
      try { workError.cause = releaseError; } catch { /* keep the protected operation's error */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-bot MCP installation
// ---------------------------------------------------------------------------
export function runCommand(command, args, { env = process.env, input, spawnProcess = spawn } = {}) {
  if (env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI === "1" && ["claude", "codex", "hermes"].includes(command))
    return Promise.reject(new Error(`Test guard refused to spawn the real ${command} CLI.`));
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(command, args, { env, shell: false, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    if (input !== undefined) child.stdin.end(input);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} stopped with exit ${code}: ${stderr.trim() || "no error text"}`));
    });
  });
}

function botServerName(name) { return `control-room-${name}`; }

function appConfigPath(bot, { homeDir, env, platform }) {
  if (bot === "cursor") return joinPath(homeDir, ".cursor", "mcp.json");
  if (platform === "win32") return joinPath(env.APPDATA || joinPath(homeDir, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (platform === "darwin") return joinPath(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return joinPath(env.XDG_CONFIG_HOME || joinPath(homeDir, ".config"), "Claude", "claude_desktop_config.json");
}

function timestampedBackup(path, clock = Date.now) {
  return `${path}.backup-${new Date(clock()).toISOString().replace(/[:.]/gu, "-")}-${randomBytes(3).toString("hex")}`;
}

async function readJsonObject(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`The MCP configuration ${path} is not valid JSON.`);
  }
}

async function resolvedJsonConfigPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error(`The MCP configuration ${path} is a dangling symbolic link. Repair its target before installing.`);
    } catch (linkError) {
      if (linkError?.code !== "ENOENT") throw linkError;
    }
    return path;
  }
}

async function writeJsonWithBackup(path, value, { clock = Date.now } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await copyFile(path, timestampedBackup(path, clock)); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
  const prefix = `${basename(path)}.backup-`;
  const backups = [];
  for (const file of (await readdir(dirname(path))).filter(file => file.startsWith(prefix))) {
    const backupPath = joinPath(dirname(path), file);
    backups.push({ path: backupPath, mtimeMs: (await stat(backupPath)).mtimeMs });
  }
  backups.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  await Promise.all(backups.slice(5).map(backup => rm(backup.path, { force: true })));
}

export async function secureWindowsCredential(paths, { runner = runCommand, env = process.env } = {}) {
  const username = env.USERNAME;
  if (!username || /[\r\n]/u.test(username)) throw new Error("Windows could not identify the current user for credential permissions.");
  for (const path of paths) await runner("icacls", [path, "/inheritance:r", "/grant:r", `${username}:F`], { env });
}

function registrationArgs(bot, name, shimPath, workspace, configPath) {
  const server = botServerName(name);
  const launch = [shimPath, "--profile", name, "--config", configPath, "--workspace", workspace];
  if (bot === "claude-code") return ["claude", ["mcp", "add", "--scope", "user", server, "--", ...launch]];
  if (bot === "codex") return ["codex", ["mcp", "add", server, "--", ...launch]];
  if (bot === "hermes") return ["hermes", ["mcp", "add", server, "--command", shimPath,
    "--args", "--profile", name, "--config", configPath, "--workspace", workspace]];
  return null;
}

function isolatedCliEnv(homeDir, env, respectExplicitProfiles) {
  const profileKeys = ["HERMES_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];
  if (respectExplicitProfiles) for (const key of profileKeys) {
    if (env[key] !== undefined && (typeof env[key] !== "string" || !isAbsolute(env[key]) || /[\u0000-\u001f\u007f]/u.test(env[key])))
      throw new Error(`${key} must be an absolute directory when it is explicitly set.`);
  }
  const isolated = respectExplicitProfiles ? { ...env } : Object.fromEntries(Object.entries(env).filter(([key]) =>
    !profileKeys.includes(key) && !key.startsWith("XDG_")));
  return {
    ...isolated,
    HOME: homeDir,
    USERPROFILE: homeDir,
    HERMES_HOME: respectExplicitProfiles && env.HERMES_HOME !== undefined ? env.HERMES_HOME : joinPath(homeDir, ".hermes"),
    CODEX_HOME: respectExplicitProfiles && env.CODEX_HOME !== undefined ? env.CODEX_HOME : joinPath(homeDir, ".codex"),
    CLAUDE_CONFIG_DIR: respectExplicitProfiles && env.CLAUDE_CONFIG_DIR !== undefined ? env.CLAUDE_CONFIG_DIR : joinPath(homeDir, ".claude"),
    XDG_CONFIG_HOME: respectExplicitProfiles && env.XDG_CONFIG_HOME !== undefined ? env.XDG_CONFIG_HOME : joinPath(homeDir, ".config"),
    XDG_DATA_HOME: respectExplicitProfiles && env.XDG_DATA_HOME !== undefined ? env.XDG_DATA_HOME : joinPath(homeDir, ".local", "share"),
    XDG_CACHE_HOME: respectExplicitProfiles && env.XDG_CACHE_HOME !== undefined ? env.XDG_CACHE_HOME : joinPath(homeDir, ".cache"),
    XDG_STATE_HOME: respectExplicitProfiles && env.XDG_STATE_HOME !== undefined ? env.XDG_STATE_HOME : joinPath(homeDir, ".local", "state"),
    XDG_RUNTIME_DIR: respectExplicitProfiles && env.XDG_RUNTIME_DIR !== undefined ? env.XDG_RUNTIME_DIR : joinPath(homeDir, ".runtime"),
  };
}

function hermesConfigHasServer(raw, server) {
  const lines = raw.split(/\r?\n/u);
  const root = lines.findIndex(line => /^mcp_servers:\s*(?:#.*)?$/u.test(line));
  if (root < 0) return false;
  const escaped = server.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const entry = new RegExp(`^ {2}(?:${escaped}|["']${escaped}["']):(?:\\s|$)`, "u");
  for (let index = root + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/u.test(line) && !/^\s*#/u.test(line)) break;
    if (entry.test(line)) return true;
  }
  return false;
}

async function verifyHermesRegistration(env, server, expected) {
  const path = joinPath(env.HERMES_HOME, "config.yaml");
  let raw = "";
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (hermesConfigHasServer(raw, server) !== expected)
    throw new Error(expected
      ? `Hermes did not save the MCP registration for ${server}. The bot remains uninstalled and can be retried.`
      : `Hermes did not remove the MCP registration for ${server}. The credential was kept for a safe retry.`);
}

async function registerBot({ bot, name, shimPath, workspace, configPath, homeDir, env, platform, runner, clock,
  respectExplicitProfiles }) {
  const command = registrationArgs(bot, name, shimPath, workspace, configPath);
  if (command) {
    const cliEnv = isolatedCliEnv(homeDir, env, respectExplicitProfiles);
    await mkdir(cliEnv.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    await runner(command[0], command[1], { env: cliEnv, ...(bot === "hermes" ? { input: "\n" } : {}) });
    if (bot === "hermes") await verifyHermesRegistration(cliEnv, botServerName(name), true);
    return { kind: "cli" };
  }
  const path = await resolvedJsonConfigPath(appConfigPath(bot, { homeDir, env, platform }));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireRotationLock(`${path}.control-room.lock`, { deadlineMs: INSTALL_LOCK_DEADLINE_MS });
  let failure;
  try {
    const value = await readJsonObject(path);
    const mcpServers = value.mcpServers && typeof value.mcpServers === "object" && !Array.isArray(value.mcpServers)
      ? value.mcpServers : {};
    await writeJsonWithBackup(path, { ...value, mcpServers: { ...mcpServers,
      [botServerName(name)]: { command: shimPath,
        args: ["--profile", name, "--config", configPath, "--workspace", workspace] } } }, { clock });
    return { kind: "json", configPath: path };
  } catch (error) { failure = error; throw error; }
  finally { await releaseRotationLock(release, failure); }
}

function missingRegistration(error) {
  return /(?:not found|no such|does not exist|not configured|unknown (?:mcp )?server)/iu.test(String(error?.message ?? ""));
}

async function unregisterBot({ bot, name, homeDir, env, platform, runner, clock, respectExplicitProfiles }) {
  const server = botServerName(name);
  const cliEnv = isolatedCliEnv(homeDir, env, respectExplicitProfiles);
  if (bot === "claude-code" || bot === "codex") {
    try { await runner(bot === "claude-code" ? "claude" : "codex",
      bot === "claude-code" ? ["mcp", "remove", "--scope", "user", server] : ["mcp", "remove", server], { env: cliEnv }); }
    catch (error) { if (!missingRegistration(error)) throw error; }
    return;
  }
  if (bot === "hermes") {
    try { await runner("hermes", ["mcp", "remove", server], { env: cliEnv }); }
    catch (error) { if (!missingRegistration(error)) throw error; }
    await verifyHermesRegistration(cliEnv, server, false);
    return;
  }
  const path = await resolvedJsonConfigPath(appConfigPath(bot, { homeDir, env, platform }));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireRotationLock(`${path}.control-room.lock`, { deadlineMs: INSTALL_LOCK_DEADLINE_MS });
  let failure;
  try {
    const value = await readJsonObject(path);
    const mcpServers = value.mcpServers && typeof value.mcpServers === "object" && !Array.isArray(value.mcpServers)
      ? { ...value.mcpServers } : {};
    delete mcpServers[server];
    await writeJsonWithBackup(path, { ...value, mcpServers }, { clock });
  } catch (error) { failure = error; throw error; }
  finally { await releaseRotationLock(release, failure); }
}

async function writeLauncher(paths, { platform, sourcePath, nodePath = process.execPath, updates, advertisement }) {
  const trust = captureReleaseTrustV1({ schema: "control-room.release-trust/v1", epoch: updates.epoch,
    keyId: updates.keyId, publicKey: updates.releasePublicKey, versionFloor: updates.floorVersion,
    revokedKeyIds: updates.revokedKeyIds });
  await installConnectorLauncherV1({ installRoot: paths.installRoot, sourcePath, version: CONNECTOR_VERSION,
    platform, nodePath, shimPath: paths.shimPath, trust, advertisement });
}

function validateInstallInput({ bot, workspace }) {
  if (!BOT_KINDS.includes(bot)) throw new Error(`Choose one bot: ${BOT_KINDS.join(", ")}.`);
  if (workspace !== undefined && (typeof workspace !== "string" || !workspace || !isAbsolute(workspace)
    || /[\u0000-\u001f\u007f]/u.test(workspace)))
    throw new Error("The workspace must be an absolute directory path.");
}

function pathContains(parent, child) {
  const fromParent = relative(resolve(parent), resolve(child));
  return fromParent === "" || (!fromParent.startsWith(`..${sep}`) && fromParent !== ".." && !isAbsolute(fromParent));
}

function validateWorkspaceTarget(paths, homeDir) {
  if (dirname(paths.workspace) === paths.workspace || resolve(paths.workspace) === resolve(homeDir)
    || pathContains(paths.workspace, paths.configRoot) || pathContains(paths.configRoot, paths.workspace))
    throw new Error("The workspace cannot be the filesystem root, your home folder, or the Control Room credential folder.");
}

/** Installs one independently revocable bot profile. All filesystem roots and
 * command execution are injectable so tests never touch a person's real home. */
export async function installConnector({ server, code, bot, name, workspace, homeDir, env = process.env,
  platform = process.platform, fetcher, runner = runCommand, sourcePath = fileURLToPath(import.meta.url), clock = Date.now,
  realHomeDir = homedir() }) {
  validateInstallInput({ bot, workspace });
  const paths = connectorInstallPaths({ homeDir, env, platform, name, workspace });
  validateWorkspaceTarget(paths, homeDir);
  const respectExplicitProfiles = resolve(homeDir) === resolve(realHomeDir);
  if (["claude-code", "codex", "hermes"].includes(bot)) isolatedCliEnv(homeDir, env, respectExplicitProfiles);
  await mkdir(paths.botsDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(paths.workspace), { recursive: true, mode: 0o700 });
  let workspaceCreated = false;
  try { await mkdir(paths.workspace, { mode: 0o700 }); workspaceCreated = true; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!(await stat(paths.workspace)).isDirectory()) throw new Error("The workspace must be a directory.");
  }
  if (platform !== "win32") {
    await chmod(paths.botsDir, 0o700);
    if (workspaceCreated) await chmod(paths.workspace, 0o700);
  }
  if (platform === "win32") await secureWindowsCredential([paths.configRoot, paths.botsDir], { runner, env });

  const release = await acquireRotationLock(`${paths.configPath}.rotate.lock`, { deadlineMs: INSTALL_LOCK_DEADLINE_MS });
  let failure, joinedRelease;
  try {
    await removeConfigTemporaryFiles(paths.configPath);
    let config;
    try { config = await loadConfig(paths.configPath); }
    catch (error) {
      if (!String(error?.message ?? "").startsWith("This machine has not joined yet.")) throw error;
    }
    if (config?.workerId) {
      const install = config.installation;
      if (!install || install.bot !== bot || install.name !== name || install.workspace !== paths.workspace
        || config.server !== checkServer(server))
        throw new Error("This bot profile is already connected with different installation settings. Uninstall it first.");
    } else {
      const joined = await join({ server, code, workerKind: bot, configPath: paths.configPath, fetcher,
        writeConfig: async (path, value) => {
          await writePrivate(path, value);
          if (platform === "win32") await secureWindowsCredential([path], { runner, env });
        } });
      joinedRelease = joined.connector;
      config = await loadConfig(paths.configPath);
      const { updates, ...joinedConfig } = config;
      await writePrivate(paths.configPath, { ...joinedConfig, installation: { bot, name, workspace: paths.workspace,
        state: "registering", updates } });
      if (platform === "win32") await secureWindowsCredential([paths.configPath], { runner, env });
    }

    await writeLauncher(paths, { platform, sourcePath, updates: config.installation?.updates ?? config.updates,
      advertisement: joinedRelease ?? (await createClient(config, fetcher).me()).connector });
    const registration = await registerBot({ bot, name, shimPath: paths.shimPath, workspace: paths.workspace,
      configPath: paths.configPath, homeDir, env, platform, runner, clock, respectExplicitProfiles });
    config = await loadConfig(paths.configPath);
    await writePrivate(paths.configPath, { ...config, installation: { ...config.installation, state: "installed" } });
    if (platform === "win32") await secureWindowsCredential([paths.configPath], { runner, env });
    const status = await createClient(await loadConfig(paths.configPath), fetcher).heartbeat();
    return Object.freeze({ paths, registration, status });
  } catch (error) { failure = error; throw error; }
  finally { await releaseRotationLock(release, failure); }
}

export async function uninstallConnector({ bot, name, homeDir, env = process.env, platform = process.platform,
  runner = runCommand, clock = Date.now, realHomeDir = homedir() }) {
  validateInstallInput({ bot });
  const paths = connectorInstallPaths({ homeDir, env, platform, name });
  const release = await acquireRotationLock(`${paths.configPath}.rotate.lock`, { deadlineMs: INSTALL_LOCK_DEADLINE_MS });
  let failure;
  try {
    const config = await loadConfig(paths.configPath);
    const pendingOnly = config.workerId === null && config.installation === undefined;
    if (!pendingOnly && (config.installation?.bot !== bot || config.installation?.name !== name))
      throw new Error("That bot profile does not match the installed credential.");
    if (!pendingOnly) await unregisterBot({ bot, name, homeDir, env, platform, runner, clock,
      respectExplicitProfiles: resolve(homeDir) === resolve(realHomeDir) });
    await removeConfigArtifacts(paths.configPath);
  } catch (error) { failure = error; throw error; }
  finally { await releaseRotationLock(release, failure); }
  // Keep the small, credential-free shim. A bot process that still holds it
  // can finish cleanly, while a later launch receives the connector's normal
  // "profile is not connected" refusal instead of an opaque missing-file error.
  return Object.freeze({ removed: name, shimRemoved: false, workspacePreserved: paths.workspace,
    ownerAction: `Also remove ${name} in Control Room -> Workers.` });
}

export function idempotencyKeyFor(tool, args) {
  return `mcp-${createHash("sha256").update(JSON.stringify([tool, args])).digest("hex").slice(0, 40)}`;
}

/** Reads a result file only from inside the workspace directory, never
 * through a link that escapes it, and never beyond the size limit. */
export async function workspaceFile(root, relative) {
  if (typeof relative !== "string" || !relative) throw new Error("A file path is required.");
  const base = await realpath(root);
  const target = await realpath(resolve(base, relative));
  if (target !== base && !target.startsWith(base + sep)) throw new Error("Only files inside the workspace can be attached.");
  const mediaType = MEDIA_TYPES[extname(target).toLowerCase()];
  if (!mediaType) throw new Error("That file type cannot be attached.");
  const info = await stat(target);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Attached files must be regular files of at most 256 KiB.");
  const name = basename(target).replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^[^A-Za-z0-9]+/u, "").slice(0, 120) || "file";
  return { name, mediaType, contentBase64: (await readFile(target)).toString("base64") };
}

// ---------------------------------------------------------------------------
// MCP server (stdio, newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------
const noAuthority = "It uses this machine's own worker credential and grants nothing: it cannot approve, accept, merge, grant or widen permissions.";
export const MCP_TOOLS = Object.freeze([
  { name: "list_eligible_work", description: `List tasks this worker may claim now (its projects and capabilities only). ${noAuthority}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "claim", description: `Claim one listed task. Creates a time-limited lease through the normal queue; retrying with the same arguments returns the same claim. ${noAuthority}`,
    inputSchema: { type: "object", properties: { offerId: { type: "string" }, idempotencyKey: { type: "string" } },
      required: ["offerId"], additionalProperties: false } },
  { name: "post_progress", description: `Post a short progress note on a claimed task. This also keeps the lease alive. ${noAuthority}`,
    inputSchema: { type: "object", properties: { claimId: { type: "string" }, message: { type: "string", maxLength: 2000 },
      idempotencyKey: { type: "string" } }, required: ["claimId", "message"], additionalProperties: false } },
  { name: "submit_result", description: `Submit the result of a claimed task for owner review: an answer (at most 64 KiB) and up to 8 files (256 KiB each, 1 MiB total) from inside the current workspace. The owner decides; submitting does not accept anything. ${noAuthority}`,
    inputSchema: { type: "object", properties: { claimId: { type: "string" }, answer: { type: "string", maxLength: MAX_RESULT_BYTES },
      files: { type: "array", maxItems: 8, items: { type: "string", description: "Path relative to the workspace." } },
      idempotencyKey: { type: "string" } }, required: ["claimId", "answer"], additionalProperties: false } },
  { name: "report_blocker", description: `Report that a claimed task is blocked. Set release to true to hand it back for another worker. Nothing is marked done. ${noAuthority}`,
    inputSchema: { type: "object", properties: { claimId: { type: "string" }, message: { type: "string", maxLength: 2000 },
      release: { type: "boolean" }, idempotencyKey: { type: "string" } }, required: ["claimId", "message"], additionalProperties: false } },
  { name: "propose_work", description: `Propose S1 work for the owner to approve. It never creates a task, lease or execution and never starts work by itself. ${noAuthority}`,
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, proposal: { type: "object" },
      idempotencyKey: { type: "string" } }, required: ["projectId", "proposal"], additionalProperties: false } },
]);

function validIdempotency(value) {
  return value === undefined || typeof value === "string" && IDEMPOTENCY_PATTERN.test(value);
}

function validateMcpArguments(name, args) {
  const plain = args && typeof args === "object" && !Array.isArray(args)
    && (Object.getPrototypeOf(args) === Object.prototype || Object.getPrototypeOf(args) === null);
  if (!plain) return false;
  const tool = MCP_TOOLS.find(value => value.name === name);
  if (!tool) return false;
  const allowed = Object.keys(tool.inputSchema.properties);
  if (Object.keys(args).some(key => !allowed.includes(key))
    || (tool.inputSchema.required ?? []).some(key => !(key in args)) || !validIdempotency(args.idempotencyKey)) return false;
  if (name === "list_eligible_work") return Object.keys(args).length === 0;
  if (name === "claim") return typeof args.offerId === "string" && OFFER_PATTERN.test(args.offerId);
  if (name === "post_progress" || name === "report_blocker") return typeof args.claimId === "string"
    && CLAIM_PATTERN.test(args.claimId) && typeof args.message === "string" && args.message.trim().length > 0
    && args.message.length <= 2000 && (name !== "report_blocker" || args.release === undefined || typeof args.release === "boolean");
  if (name === "submit_result") return typeof args.claimId === "string" && CLAIM_PATTERN.test(args.claimId)
    && typeof args.answer === "string" && args.answer.trim().length > 0
    && Buffer.byteLength(args.answer, "utf8") <= MAX_RESULT_BYTES
    && (args.files === undefined || Array.isArray(args.files) && args.files.length <= 8
      && args.files.every(path => typeof path === "string" && path.length > 0));
  if (name === "propose_work") return typeof args.projectId === "string" && PROJECT_PATTERN.test(args.projectId)
    && args.proposal && typeof args.proposal === "object" && !Array.isArray(args.proposal)
    && Buffer.byteLength(JSON.stringify(args.proposal), "utf8") <= MAX_PROPOSAL_BYTES;
  return false;
}

export function createMcpDispatcher({ client, workspaceRoot }) {
  const key = (tool, args) => typeof args.idempotencyKey === "string" ? args.idempotencyKey
    : idempotencyKeyFor(tool, Object.fromEntries(Object.entries(args).filter(([k]) => k !== "idempotencyKey")));
  const tools = {
    list_eligible_work: () => client.work(),
    claim: args => client.claim(args.offerId, key("claim", args)),
    post_progress: args => client.progress(args.claimId, args.message, key("progress", args)),
    submit_result: async args => {
      const files = [];
      for (const path of args.files ?? []) files.push(await workspaceFile(workspaceRoot, path));
      return client.result(args.claimId, args.answer, files, key("result", args));
    },
    report_blocker: args => client.blocker(args.claimId, args.message, key("blocker", args), args.release === true),
    propose_work: args => client.propose(args.projectId, args.proposal, key("propose", args)),
  };
  return async function dispatch(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return message && "id" in message ? { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "Invalid request" } } : null;
    }
    const reply = result => ({ jsonrpc: "2.0", id: message.id, result });
    if (!("id" in message)) return null; // notifications need no reply
    switch (message.method) {
      case "initialize": return reply({ protocolVersion: typeof message.params?.protocolVersion === "string"
        ? message.params.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "control-room", version: CONNECTOR_VERSION },
        instructions: "Control Room work queue for this machine. Claim work, post progress, submit results for owner review. You cannot approve or accept work." });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: MCP_TOOLS });
      case "tools/call": {
        const name = message.params?.name, args = message.params?.arguments ?? {};
        const tool = MCP_TOOLS.find(value => value.name === name);
        try {
          const callId = `mcp-call:${randomBytes(16).toString("hex")}`;
          await client.mcpCall(callId, tool ? name : "unsupported");
          if (!tool) return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool" } };
          if (!validateMcpArguments(name, args))
            return reply({ isError: true, content: [{ type: "text", text: "The arguments do not match this tool." }] });
          const value = await tools[name](args);
          return reply({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } });
        } catch (error) {
          return reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Request failed." }] });
        }
      }
      default: return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
    }
  };
}

/** @param {{ configPath: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, fetcher?: typeof fetch, workspaceRoot: string }} options */
export async function serveMcp({ configPath, input = process.stdin, output = process.stdout, fetcher, workspaceRoot }) {
  if (!workspaceRoot) throw new Error("MCP requires an explicit --workspace directory.");
  if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot))
    throw new Error("MCP --workspace must be an absolute directory path.");
  let workspaceInfo;
  try { workspaceInfo = await stat(workspaceRoot); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("MCP --workspace must exist and be a directory.");
    throw error;
  }
  if (!workspaceInfo.isDirectory()) throw new Error("MCP --workspace must exist and be a directory.");
  const config = await recoverPending({ configPath, fetcher });
  const dispatch = createMcpDispatcher({ client: createClient(config, fetcher), workspaceRoot });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_MCP_MESSAGE_BYTES) {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } })}\n`);
      continue;
    }
    let message;
    try { message = JSON.parse(line); }
    catch { output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); continue; }
    const response = await dispatch(message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Harness hand-off: `run` gives a claimed task to one local harness
// ---------------------------------------------------------------------------
// The machine owner enables harnesses in a local settings file next to the
// credential file. Nothing the server sends can pick an executable, a folder,
// a model or an adapter module; the server only offers tasks.
//
// Each harness is reached through the shared local CLI delivery contract that
// Control Room's own Codex, Claude Code and Hermes runners implement
// (OwnerTrustedLocalCliExecutionAdapterV1): the adapter module exports
// createFleetHarnessAdapter({ harness, configuration }) returning an object
// with execute({ delivery: { identity: { jobId }, input: { prompt, instructions } }, signal })
// that resolves to { kind: "completed", text } or { kind: "failed", reason }.
// src/fleet/v1/harness-adapters.ts is that module for a Control Room checkout.
const HARNESS_SETTINGS_SCHEMA = "control-room.fleet-harnesses/v1";
export const HANDOFF_HARNESSES = Object.freeze(["codex", "claude-code", "hermes"]);
const HARNESS_LABELS = Object.freeze({ codex: "Codex", "claude-code": "Claude Code", hermes: "Hermes" });
const MAX_MESSAGE_CHARS = 2000;
const WATCHDOG_GRACE_MS = 15_000;
const operationsMode = value => ["running", "paused", "draining", "stopped"].includes(value) ? value : "unknown";
// Refusals that mean this claim can no longer be reported on.
const LOST_CLAIM_CODES = new Set(["expired", "not_found", "conflict", "unauthenticated"]);
// Answers that are worth repeating with the same idempotency key.
const TRANSIENT_CODES = new Set(["rate_limited", "unavailable", "http_502", "http_503", "http_504"]);

const plainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const absolutePath = value => typeof value === "string" && value.length > 0 && value.length <= 4096
  && resolve(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);

export function defaultHarnessSettingsPath(configPath) {
  return joinPath(dirname(configPath), "harnesses.json");
}

async function refuseSharedWrite(path, what) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${what} ${path} is not a regular file.`);
  if (process.platform !== "win32" && (info.mode & 0o022) !== 0)
    throw new Error(`${what} ${path} can be changed by other users. Run: chmod go-w ${path}`);
}

/** @typedef {Readonly<{ adapterModule: string | null, harnesses: Readonly<Record<string,
 *   Readonly<{ enabled: boolean, configuration: Readonly<Record<string, unknown>> }>>> }>} HarnessSettings */
/** @typedef {Readonly<{ state: string, mode?: string, outcome?: "submitted" | "blocked" | "abandoned", claimId?: string,
 *   jobId?: string, resultId?: string, message?: string, reason?: string, forcedTimeout?: boolean }>} RunPass */

/** Reads the machine owner's harness settings. A missing file means no
 * harness is enabled; anything malformed is refused, never guessed.
 * @param {string} path
 * @returns {Promise<HarnessSettings | null>} */
export async function loadHarnessSettings(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw new Error(`The harness settings file ${path} cannot be read.`); }
  await refuseSharedWrite(path, "The harness settings file");
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The harness settings file is not valid JSON."); }
  const invalid = detail => new Error(`The harness settings file is not valid: ${detail}.`);
  if (!plainObject(value) || value.schema !== HARNESS_SETTINGS_SCHEMA) throw invalid(`schema must be "${HARNESS_SETTINGS_SCHEMA}"`);
  if (Object.keys(value).some(key => !["schema", "adapterModule", "harnesses"].includes(key))) throw invalid("unknown setting");
  if (!plainObject(value.harnesses)) throw invalid("harnesses must be an object");
  const harnesses = {};
  for (const [name, entry] of Object.entries(value.harnesses)) {
    if (!HANDOFF_HARNESSES.includes(name)) throw invalid(`unknown harness "${name}"`);
    if (!plainObject(entry) || typeof entry.enabled !== "boolean") throw invalid(`${name}.enabled must be true or false`);
    const { enabled, ...configuration } = entry;
    if (enabled && (!Number.isSafeInteger(configuration.deadlineMs) || configuration.deadlineMs < 100
      || configuration.deadlineMs > 3_600_000)) throw invalid(`${name}.deadlineMs must be 100 to 3600000`);
    harnesses[name] = Object.freeze({ enabled, configuration: Object.freeze(configuration) });
  }
  const anyEnabled = Object.values(harnesses).some(entry => entry.enabled);
  if (anyEnabled && !bundledHarnessAdapterFactory && !absolutePath(value.adapterModule))
    throw invalid("adapterModule must be an absolute path");
  if (anyEnabled && !bundledHarnessAdapterFactory) await refuseSharedWrite(value.adapterModule, "The harness adapter module");
  return Object.freeze({ adapterModule: anyEnabled && !bundledHarnessAdapterFactory ? value.adapterModule : null,
    harnesses: Object.freeze(harnesses) });
}

/** Loads the adapter for one harness only if the machine owner enabled it.
 * @param {HarnessSettings | null} settings
 * @param {string} harness
 * @param {(specifier: string) => Promise<any>} [importer] */
export async function loadHarnessAdapter(settings, harness, importer = specifier => import(specifier)) {
  const entry = settings?.harnesses?.[harness];
  if (!HANDOFF_HARNESSES.includes(harness) || entry?.enabled !== true) return null;
  if (bundledHarnessAdapterFactory) {
    const adapter = await bundledHarnessAdapterFactory(Object.freeze({ harness, configuration: entry.configuration }));
    if (!adapter || typeof adapter.execute !== "function") throw new Error("The bundled harness adapter returned no adapter.");
    return Object.freeze({ harness, deadlineMs: entry.configuration.deadlineMs, execute: adapter.execute.bind(adapter) });
  }
  if (!settings.adapterModule) return null;
  const module = await importer(pathToFileURL(settings.adapterModule).href);
  if (typeof module?.createFleetHarnessAdapter !== "function")
    throw new Error("The harness adapter module does not export createFleetHarnessAdapter.");
  const adapter = await module.createFleetHarnessAdapter(Object.freeze({ harness, configuration: entry.configuration }));
  if (!adapter || typeof adapter.execute !== "function") throw new Error("The harness adapter module returned no adapter.");
  return Object.freeze({ harness, deadlineMs: entry.configuration.deadlineMs, execute: adapter.execute.bind(adapter) });
}

/** Text the gateway will store: no control characters except tab and newlines. */
export function storableText(value) {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "").trim();
}
const shortReason = value => storableText(value).replace(/\s+/gu, " ").slice(0, 200) || "no reason given";

/** The strings to refuse in outgoing text: each live credential whole, and
 * the bare base64url part after "crf_" (a harness that reads the credential
 * file could echo either form back in its answer). A read-only harness such
 * as Codex can read this machine's own key file even though it was never
 * given the key; this is the only guard standing between that read and the
 * key leaving the machine in a result or blocker message. */
function secretNeedles(secrets) {
  const needles = new Set();
  for (const secret of secrets) {
    if (typeof secret !== "string" || !secret) continue;
    needles.add(secret);
    if (secret.startsWith("crf_")) needles.add(secret.slice(4));
  }
  return [...needles];
}
const containsSecret = (text, needles) => needles.some(needle => needle.length > 0 && String(text).includes(needle));

async function report(send, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await send(); }
    catch (error) {
      const transient = error?.code === undefined || TRANSIENT_CODES.has(error.code);
      if (!transient || attempt >= attempts) throw error;
      await new Promise(done => setTimeout(done, 250 * attempt));
    }
  }
}

/**
 * Runs one claimed task on one local harness and reports what really
 * happened. Only a completed, well-formed, in-bounds answer becomes a result;
 * a failure, crash, timeout, stop, malformed or oversized answer becomes a
 * blocker that hands the task back. Nothing here can accept the result.
 * @param {{ client: ReturnType<typeof createClient>, claim: any, adapter: any, progressIntervalMs?: number,
 *   readMode?: () => Promise<string>, log?: (message: string) => void, watchdogGraceMs?: number,
 *   secrets?: string[] }} options
 * @returns {Promise<RunPass>}
 */
export async function runClaimedTask({ client, claim, adapter, progressIntervalMs = 60_000, readMode = async () => "unknown",
  log = () => {}, watchdogGraceMs = WATCHDOG_GRACE_MS, secrets = [] }) {
  const label = HARNESS_LABELS[adapter.harness] ?? adapter.harness;
  const keyBase = `handoff-${claim.claimId.slice("fleet-claim:".length)}`;
  const outcome = { claimId: claim.claimId, jobId: claim.jobId };
  const needles = secretNeedles(secrets);
  const keyLeakMessage = `${label}'s answer contained this machine's key, so it was not sent. Rotate the key.`;
  const blocked = async (message, extra = {}) => {
    const safeMessage = containsSecret(message, needles) ? keyLeakMessage : message;
    try {
      await report(() => client.blocker(claim.claimId, safeMessage.slice(0, MAX_MESSAGE_CHARS), `${keyBase}-blocker`, true));
      return Object.freeze({ ...outcome, outcome: "blocked", message: safeMessage, ...extra });
    } catch (error) {
      return Object.freeze({ ...outcome, outcome: "abandoned", message: safeMessage, reason: error?.code ?? "unreachable", ...extra });
    }
  };
  try { await report(() => client.progress(claim.claimId, `Started on ${label} on this machine.`, `${keyBase}-start`)); }
  catch (error) { return Object.freeze({ ...outcome, outcome: "abandoned", reason: error?.code ?? "unreachable" }); }

  const controller = new AbortController();
  let stop, ticks = 0, ticking = Promise.resolve(), watchdogTimer;
  const halt = reason => { if (!stop) { stop = reason; controller.abort(); } };
  const startedAt = Date.now();
  const tick = async () => {
    ticks += 1;
    try { if (await readMode() === "stopped") halt("stopped"); }
    catch (error) { if (error?.code === "unauthenticated") halt("lost"); }
    if (stop) return;
    const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
    try { await client.progress(claim.claimId, `Still working on ${label} (${minutes} min).`, `${keyBase}-p${ticks}`); }
    catch (error) { if (LOST_CLAIM_CODES.has(error?.code)) halt("lost"); }
  };
  const ticker = setInterval(() => { ticking = ticking.then(tick); }, progressIntervalMs);
  const watchdog = new Promise(done => {
    watchdogTimer = setTimeout(() => { halt("watchdog"); done({ watchdog: true }); }, adapter.deadlineMs + watchdogGraceMs);
  });
  let settled;
  try {
    // The adapter sees the task text and a cancel signal: never the
    // credential, the server address or anything that grants authority.
    const delivery = Object.freeze({ identity: Object.freeze({ jobId: claim.jobId }), input: Object.freeze({
      prompt: [claim.title, claim.instructions].filter(Boolean).join("\n\n"),
      instructions: "Complete this Control Room task and reply with the result. Your reply is sent to the owner for review; the owner decides whether to accept it." }) });
    settled = await Promise.race([
      Promise.resolve().then(() => adapter.execute({ delivery, signal: controller.signal }))
        .then(value => ({ value }), error => ({ error })),
      watchdog,
    ]);
  } finally {
    clearInterval(ticker); clearTimeout(watchdogTimer);
    await ticking;
  }
  if (stop === "lost") {
    log(`The task ${claim.jobId} can no longer be reported on (its claim ended); nothing was submitted.`);
    return Object.freeze({ ...outcome, outcome: "abandoned", reason: "claim_lost" });
  }
  if (settled.watchdog) return blocked(`The ${label} run did not stop by its time limit, so it was abandoned. Nothing was submitted.`,
    { forcedTimeout: true });
  const value = settled.value;
  // A run that finished anyway is still reported honestly after a Stop.
  if (stop === "stopped" && !(plainObject(value) && value.kind === "completed" && typeof value.text === "string"))
    return blocked(`Stopped from Control Room before ${label} finished. Nothing was submitted.`);
  if ("error" in settled) return blocked(`The ${label} adapter failed before it gave an answer. Nothing was submitted.`);
  if (!plainObject(value) || (value.kind === "completed" ? typeof value.text !== "string"
    : value.kind !== "failed" || typeof value.reason !== "string"))
    return blocked(`${label} gave an answer Control Room does not understand. Nothing was submitted.`);
  if (value.kind === "failed") return blocked(`The ${label} run did not finish (${shortReason(value.reason)}). Nothing was submitted.`);
  const summary = storableText(value.text);
  if (!summary) return blocked(`${label} finished with an empty answer. Nothing was submitted.`);
  if (Buffer.byteLength(summary, "utf8") > MAX_RESULT_BYTES)
    return blocked(`${label}'s answer was larger than 64 KiB, so it was not submitted. Ask for a shorter answer.`);
  if (containsSecret(summary, needles)) return blocked(keyLeakMessage, { keyLeak: true });
  try {
    const result = await report(() => client.result(claim.claimId, summary, [], `${keyBase}-result`));
    return Object.freeze({ ...outcome, outcome: "submitted", resultId: result.resultId });
  } catch (error) {
    if (error?.code === "too_large" || error?.code === "invalid")
      return blocked(`${label}'s answer could not be stored (${error.code}). Nothing was submitted.`);
    return Object.freeze({ ...outcome, outcome: "abandoned", reason: error?.code ?? "unreachable" });
  }
}

/**
 * The `run` loop. Each pass checks in (which also reads the owner's Pause /
 * Drain / Stop), renews the credential when due, and, only when the worker's
 * harness is enabled here and Control Room is running, claims one offered
 * task and hands it to that harness. One task at a time.
 * @param {{ configPath: string, harnessesPath?: string, fetcher?: typeof fetch, once?: boolean,
 *   importer?: (specifier: string) => Promise<any>, progressIntervalMs?: number, pollMs?: number,
 *   log?: (message: string) => void, sleep?: (ms: number) => Promise<void>, watchdogGraceMs?: number }} options
 * @returns {Promise<RunPass>}
 */
export async function runWorker({ configPath, harnessesPath = defaultHarnessSettingsPath(configPath), fetcher, once = false,
  importer, progressIntervalMs = 60_000, pollMs = 60_000, log = message => process.stderr.write(`${message}\n`),
  sleep = ms => new Promise(done => setTimeout(done, ms)), watchdogGraceMs = WATCHDOG_GRACE_MS,
  updateCheck }) {
  const settings = await loadHarnessSettings(harnessesPath);
  const handedBack = new Set(); // tasks this machine could not finish; left for another worker
  let adapter = null, said = "";
  const say = message => { if (message !== said) { said = message; log(`${new Date().toISOString()} ${message}`); } };
  for (;;) {
    let current = await recoverPending({ configPath, fetcher });
    if (current.credentialExpiresAt && Date.parse(current.credentialExpiresAt) - Date.now() < ROTATE_BEFORE_MS) {
      await rotate({ configPath, fetcher }); current = await loadConfig(configPath);
      log("Credential renewed.");
    }
    const client = createClient(current, fetcher);
    let me;
    try { me = await client.heartbeat(); }
    catch (error) {
      if (error?.code === "unauthenticated") throw new Error("Control Room no longer accepts this machine's key. Ask the owner for a new key.");
      say(`Could not reach Control Room (${error?.code ?? "network"}); trying again.`);
      if (once) return Object.freeze({ state: "unreachable" });
      await sleep(pollMs); continue;
    }
    if (me.connector && updateCheck) {
      try {
        const update = await updateCheck(current, me.connector);
        if (update?.state === "updated" || update?.state === "coalesced") {
          log(`Connector ${update.version} is healthy; restarting run on the new version.`);
          return Object.freeze({ state: "updated", version: update.version });
        }
      }
      catch (error) { log(`Connector update was refused (${error?.code ?? "invalid"}); continuing the installed version.`); }
    }
    const mode = operationsMode(me.operationsMode);
    const harness = HANDOFF_HARNESSES.includes(me.workerKind) ? me.workerKind : null;
    let pass = { state: "idle" };
    if (!harness) {
      say(`Connected as ${me.displayName}. This worker is driven through MCP, so run starts no harness.`);
      pass = { state: "no_harness" };
    } else if (settings?.harnesses?.[harness]?.enabled !== true) {
      say(`Connected as ${me.displayName}. ${HARNESS_LABELS[harness]} is not enabled on this machine, so no work is taken. `
        + `Enable it in ${harnessesPath}.`);
      pass = { state: "not_enabled" };
    } else if (mode !== "running") {
      say(`Connected as ${me.displayName}. ${mode === "unknown" ? "Control Room could not read its Pause switch"
        : `Control Room is ${mode}`}, so no new work is taken.`);
      pass = { state: "paused", mode };
    } else {
      // Load before claiming, so a broken local setup never strands a task.
      adapter ??= await loadHarnessAdapter(settings, harness, importer);
      let offers = [], claim;
      try {
        offers = (await client.work()).filter(item => !handedBack.has(item.jobId));
        for (const offer of offers) {
          try { claim = await client.claim(offer.offerId, `handoff-claim-${randomBytes(16).toString("hex")}`); break; }
          catch (error) {
            if (error?.code === "paused") { pass = { state: "paused", mode: "paused" }; break; }
            if (error?.code !== "conflict" && error?.code !== "not_found") throw error;
          }
        }
      } catch (error) {
        if (error?.code === "unauthenticated") throw new Error("Control Room no longer accepts this machine's key. Ask the owner for a new key.");
        say(`Could not take work (${error?.code ?? "network"}); trying again.`);
        pass = { state: "unreachable" };
      }
      if (pass.state === "paused") say("Control Room paused new work, so none was taken.");
      else if (!claim && pass.state !== "unreachable") say(`Connected as ${me.displayName}. Waiting for work (${offers.length} offered).`);
      else if (claim) {
        say(`Claimed "${claim.title}" for ${HARNESS_LABELS[harness]}.`);
        const readMode = async () => operationsMode((await client.heartbeat()).operationsMode);
        // The adapter never receives these; they are only checked against the
        // adapter's own answer afterward, so a leaked key cannot be sent on.
        const secrets = [current.secret, current.pendingSecret].filter(value => typeof value === "string" && value);
        const finished = await runClaimedTask({ client, claim, adapter, progressIntervalMs, readMode, log,
          watchdogGraceMs, secrets });
        if (finished.outcome !== "submitted") handedBack.add(claim.jobId);
        say(finished.outcome === "submitted" ? `Sent the result of "${claim.title}" to the owner for review.`
          : `Could not finish "${claim.title}": ${finished.message ?? finished.reason}`);
        pass = { state: "ran", ...finished };
        // A harness that ignored its own time limit may still be running.
        // Taking more work next to it is not safe; stop and let a person look.
        if (finished.forcedTimeout) throw new Error(`${HARNESS_LABELS[harness]} did not stop by its time limit. `
          + "run has stopped taking work; check this machine before starting it again.");
      }
    }
    if (once) return Object.freeze(pass);
    if (pass.state !== "ran") await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
function options(args) {
  const values = {}, positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (["once", "release", "i-am-the-installer"].includes(name)) values[name] = true;
      else { values[name] = args[i + 1]; i += 1; }
    } else positional.push(arg);
  }
  return { values, positional };
}

const usage = `Control Room worker connector ${CONNECTOR_VERSION}

  install --server <address> --code <code> --bot <kind> --name <label>
          [--workspace <dir>]            Connect one bot with its own credential
  uninstall --bot <kind> --name <label> Remove one bot registration and credential
  unlock --name <label>                 Remove one stale empty credential-lock directory
  join --server <address> --code <code> --bot <kind>
                                          Join this machine (code from the Workers page)
  status                                  Show this worker and its credential
  rotate                                  Replace this machine's credential now
  update check|pause|resume|status        Manage signed connector updates on this machine
  run [--once] [--harnesses <path>]       Stay connected: check in, renew the credential, and
                                          hand offered tasks to the harness enabled in
                                          harnesses.json (next to the credential file)
  work                                    List tasks this worker may claim
  claims                                  List this worker's claims and owner decisions
  claim <offerId>
  progress <claimId> <message>
  blocker <claimId> <message> [--release]
  result <claimId> --summary <text> [--file <path>]...
  mcp --profile <name> --workspace <dir> Start the MCP server for an agent (stdin/stdout)

  --config <path>   Credential file (default ${defaultConfigPath()})
`;

export async function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }, runtime = {}) {
  const [command, ...rest] = argv;
  const { values, positional } = options(rest);
  const env = runtime.env ?? process.env, platform = runtime.platform ?? process.platform;
  const homeDir = runtime.homeDir ?? homedir(), realHomeDir = runtime.realHomeDir ?? homedir();
  let configPath = values.config ? resolve(values.config) : defaultConfigPath(env);
  const print = value => io.out.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
  try {
    if (values.profile && !values.config) configPath = connectorInstallPaths({ homeDir, env, platform, name: values.profile }).configPath;
    if (!command || command === "--help" || command === "help") { print(usage); return 0; }
    const modulePath = fileURLToPath(import.meta.url);
    const installRoot = runtime.installRoot ?? (command === "launch"
      ? connectorInstallRootForLaunchV1(modulePath, configPath, env, platform)
      : connectorInstallRootFromConfigPathV1(configPath, env, platform));
    if (command === "launch") return await launchCurrentConnectorV1({ installRoot, configPath, args: rest,
      healthCheck: runtime.healthCheck, spawnProcess: runtime.spawnProcess });
    if (command === "install" || command === "uninstall" || command === "unlock") {
      if (resolve(homeDir) === resolve(realHomeDir) && values["i-am-the-installer"] !== true)
        throw new Error("Refusing to change a real home. Re-run this owner-approved command with --i-am-the-installer.");
      if (command === "install") {
        const installed = await installConnector({ server: values.server, code: values.code, bot: values.bot,
          name: values.name, workspace: values.workspace, homeDir, env, platform, fetcher: runtime.fetcher,
          runner: runtime.runner, sourcePath: runtime.sourcePath, clock: runtime.clock, realHomeDir });
        print(`Connected as ${values.name}. Open ${values.bot} and ask it to list Control Room work.`);
        print(`For unattended work, start through the updater launcher: ${process.execPath} ${installed.paths.launcher} launch run --config ${installed.paths.configPath}`);
        if (["claude-desktop", "cursor"].includes(values.bot)) print(`Restart ${values.bot}.`);
        print(installed.status);
      } else if (command === "uninstall") {
        const removed = await uninstallConnector({ bot: values.bot, name: values.name, homeDir, env, platform,
          runner: runtime.runner, clock: runtime.clock, realHomeDir });
        print(removed);
        print(removed.ownerAction);
      } else {
        print(await unlockConnector({ name: values.name, homeDir, env, platform, staleMs: runtime.staleMs,
          clock: runtime.clock, isPidAlive: runtime.isPidAlive, getProcessIdentity: runtime.getProcessIdentity }));
      }
      return 0;
    }
    if (command === "join") {
      const result = await join({ server: values.server, code: values.code, workerKind: values.bot,
        configPath, fetcher: runtime.fetcher });
      print(`Joined as "${result.displayName}" (${result.workerId}).`);
      print(`Projects: ${result.projectIds.join(", ")}. Capabilities: ${result.capabilities.join(", ")}.`);
      print(`Credential saved to ${configPath}. Next: node ${basename(process.argv[1] ?? "connector.mjs")} run`);
      return 0;
    }
    if (command === "mcp") {
      let updateConfig;
      try { updateConfig = await loadConfig(configPath); } catch { /* serveMcp reports the original validation error */ }
      if (updateConfig?.installation?.updates) {
        void (async () => {
          const advertised = (await createClient(updateConfig, runtime.fetcher).me()).connector;
          if (advertised) await checkForConnectorUpdateV1({ installRoot, configPath, config: updateConfig, advertised,
            currentVersion: CONNECTOR_VERSION, fetcher: runtime.fetcher, healthCheck: runtime.healthCheck,
            minimumCheckIntervalMs: 86_400_000 });
        })().catch(error => { io.err.write(`Connector update check was skipped (${error?.code ?? "unreachable"}).\n`); });
      }
      await serveMcp({ configPath, workspaceRoot: values.workspace, fetcher: runtime.fetcher }); return 0;
    }
    const config = await recoverPending({ configPath, fetcher: runtime.fetcher });
    const client = createClient(config, runtime.fetcher);
    if (command === "status") { print(await client.heartbeat()); return 0; }
    if (command === "rotate") { print(await rotate({ configPath, fetcher: runtime.fetcher })); return 0; }
    if (command === "health-check") {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { await client.heartbeat(); return 0; }
        catch (error) { lastError = error; }
      }
      throw lastError;
    }
    if (command === "update") {
      const action = positional[0] ?? "status";
      if (action === "pause" || action === "resume") {
        print(await setConnectorUpdatesPausedV1({ installRoot, configPath, paused: action === "pause" })); return 0;
      }
      if (action === "status") { print({ version: CONNECTOR_VERSION,
        paused: await connectorUpdatesPausedV1(installRoot), floorVersion: config.installation?.updates?.floorVersion ?? null }); return 0; }
      if (action === "check") {
        const advertised = (await client.me()).connector;
        if (!advertised) throw new Error("Control Room did not advertise a connector release.");
        print(await checkForConnectorUpdateV1({ installRoot, configPath, config, advertised,
          currentVersion: CONNECTOR_VERSION, fetcher: runtime.fetcher, healthCheck: runtime.healthCheck })); return 0;
      }
      throw new Error("Choose update check, pause, resume or status.");
    }
    if (command === "work") { print(await client.work()); return 0; }
    if (command === "claims") { print(await client.claims()); return 0; }
    if (command === "claim") { print(await client.claim(positional[0], idempotencyKeyFor("claim", { offerId: positional[0] }))); return 0; }
    if (command === "progress") { print(await client.progress(positional[0], positional[1], `cli-${randomBytes(12).toString("hex")}`)); return 0; }
    if (command === "blocker") {
      print(await client.blocker(positional[0], positional[1], `cli-${randomBytes(12).toString("hex")}`, values.release === true));
      return 0;
    }
    if (command === "result") {
      const paths = rest.flatMap((arg, i) => arg === "--file" ? [rest[i + 1]] : []);
      const files = [];
      for (const path of paths) files.push(await workspaceFile(process.cwd(), path));
      print(await client.result(positional[0], values.summary, files, idempotencyKeyFor("result", { claimId: positional[0], summary: values.summary, paths })));
      return 0;
    }
    if (command === "run") {
      if (config.installation?.updates && env.CONTROL_ROOM_CONNECTOR_LAUNCHED !== "1")
        throw new Error("Start unattended work through launcher.mjs launch run so a healthy connector update can relaunch safely.");
      const pass = await runWorker({ configPath, once: values.once === true,
        ...(values.harnesses ? { harnessesPath: resolve(values.harnesses) } : {}),
        log: message => io.err.write(`${message}\n`), updateCheck: (current, advertised) => checkForConnectorUpdateV1({
          installRoot, configPath, config: current, advertised, currentVersion: CONNECTOR_VERSION,
          fetcher: runtime.fetcher, healthCheck: runtime.healthCheck }) });
      return pass.state === "unreachable" ? 1 : pass.state === "updated" ? 75 : 0;
    }
    io.err.write(usage); return 2;
  } catch (error) {
    io.err.write(`${error instanceof Error ? error.message : "The connector stopped."}\n`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); } catch { return false; }
})();
if (invokedDirectly) main().then(code => { process.exitCode = code; });
