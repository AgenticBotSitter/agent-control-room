import { acquirePrivateProcessLockV1 } from "../../../installer/shared/private-process-lock.mjs";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { captureReleaseTrustV1 } from "../../../../scripts/release-signing.mjs";
import { promisify } from "node:util";
import { composeProtectedConfigV1 } from "../services/protected-config.mjs";
import { SERVICE_POLICY_LABELS_V1, validateServicePolicyV1 } from "../services/bundle.mjs";
import { checkHealthV1 as checkInstallerHealthV1 } from "./health.mjs";
import { readCodeV1 } from "../terminal/read-code.mjs";
import { vendorRuntimeV1, undoVendoredRuntimeV1 } from "./runtime.mjs";
import { registerInitialPasskeyProductionV1 } from "../pg/initial-passkey-production.mjs";

const executeFile = promisify(execFile);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/u;
const MAX_JSON = 512 * 1024;
const DB_PORT_SCHEMA = "control-room.database-port-not-yet-supplied/v1";
const refuse = (code, details = {}) => { throw Object.assign(new Error(code), { code, ...details }); };
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const ownerCodeDigest = value => sha256(JSON.stringify({ ownerCode: value }));
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const safeRoot = value => typeof value === "string" && value.length > 1 && value.length <= 4095
  && isAbsolute(value) && resolve(value) === value && value !== "/" && !value.includes("\0");
const inside = (root, path) => {
  const value = relative(root, path);
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};

export const DATABASE_PORT_CONTRACTS_V1 = Object.freeze({
  initializeDatabase: Object.freeze({ inputKeys: Object.freeze(["phase", "root", "pgDataId", "runtime", "socketDir",
    "accounts", "logins", "passwords"]), phases: Object.freeze(["init", "release"]),
  results: Object.freeze({ init: "control-room.database-init-result/v1: outcome initialized, pgDataId, updaterSchemaDigest, clusterShutDownClean true",
    release: "control-room.release-schema-result/v1: outcome applied, schemaDigest, ledgerHead" }) }),
  retireDatabase: Object.freeze({ inputKeys: Object.freeze(["root", "pgDataId", "accountUid"]),
    result: "database-retirement-result/v1: retired" }),
  firstOwner: Object.freeze({ inputKeys: Object.freeze(["root", "accounts", "release", "schemaDigest", "pgDataId", "owner"]),
    result: "exact tenantId, workspaceId, provider, subject" }),
  writeDatabaseLogins: Object.freeze({ inputKeys: Object.freeze(["root", "accounts", "passwords"]),
    result: "path plus references with exact name, passwordDigest, fileRef; never plaintext passwords" }),
  removeDatabaseLogins: Object.freeze({ inputKeys: Object.freeze(["root", "receipt?"]), result: "removed" }),
  "registerInitialPasskey.pg": Object.freeze({ inputKeys: Object.freeze(["root", "config", "ownerCode", "terminal", "qr", "maxAttempts", "authenticator?"]),
    result: "registered credentialIdDigest and attempts, or stopped reason" }),
  recordPasskeyStatus: Object.freeze({ inputKeys: Object.freeze(["root", "status", "credentialIdDigest?/reason?"]),
    result: "recorded" }),
  "checkHealth.database": Object.freeze({ inputKeys: Object.freeze(["root", "expectedRelease", "pgDataId", "schemaDigest",
    "updaterSchemaDigest", "samples"]), result: "healthy true, samples 3, schemaDigest" }),
});

async function atomicFile(path, bytes, mode = 0o600) {
  const previousMetadata = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  const temporary = join(dirname(path), `.stage-one-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    const handle = await open(temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, mode);
    try {
      await handle.writeFile(bytes); await handle.chmod(mode);
      if (previousMetadata && process.geteuid?.() === 0) await handle.chown(previousMetadata.uid, previousMetadata.gid);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

async function boundedJsonFile(path, code) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch(() => refuse(code));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > MAX_JSON) refuse(code);
    const text = (await handle.readFile()).toString("utf8");
    if (text.includes("\0")) refuse(code);
    try { return JSON.parse(text); } catch { refuse(code); }
  } finally { await handle.close(); }
}

async function boundedTextFile(path, maximum, code) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch(() => refuse(code));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) refuse(code);
    const value = (await handle.readFile()).toString("utf8");
    if (value.includes("\0")) refuse(code); return value;
  } finally { await handle.close(); }
}

async function boundedBytesFile(path, maximum, code) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch(() => refuse(code));
  try {
    const before = await handle.stat(), bytes = await handle.readFile(), after = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) refuse(code);
    return bytes;
  } finally { await handle.close(); }
}

export function databasePortNotYetSuppliedV1(port, input) {
  if (!Object.hasOwn(DATABASE_PORT_CONTRACTS_V1, port) || !safeRoot(input?.root)) refuse("database_port_contract_refused");
  refuse("database_port_not_yet_supplied", { port, schema: DB_PORT_SCHEMA,
    contract: DATABASE_PORT_CONTRACTS_V1[port] });
}

export const initializeDatabaseV1 = input => databasePortNotYetSuppliedV1("initializeDatabase", input);
export const retireDatabaseV1 = input => databasePortNotYetSuppliedV1("retireDatabase", input);
export const firstOwnerV1 = input => databasePortNotYetSuppliedV1("firstOwner", input);
export const writeDatabaseLoginsV1 = input => databasePortNotYetSuppliedV1("writeDatabaseLogins", input);
export const removeDatabaseLoginsV1 = input => databasePortNotYetSuppliedV1("removeDatabaseLogins", input);
export function registerInitialPasskeyV1(input, runtime = {}) {
  const authority = runtime.authority;
  if (!authority) return databasePortNotYetSuppliedV1("registerInitialPasskey.pg", input);
  const keys = input?.authenticator === undefined
    ? ["root", "config", "ownerCode", "terminal", "qr", "maxAttempts"]
    : ["root", "config", "ownerCode", "terminal", "qr", "maxAttempts", "authenticator"];
  if (!exactKeys(input, keys)
    || !safeRoot(input.root) || !input.config || typeof input.config !== "object" || Array.isArray(input.config)
    || !/^[A-Za-z0-9_-]{16,512}$/u.test(input.ownerCode ?? "") || input.maxAttempts !== 5
    || input.terminal?.isTTY !== true || typeof input.terminal.write !== "function"
    || typeof input.terminal.readLine !== "function" || typeof input.terminal.setRawMode !== "function"
    || input.authenticator !== undefined && input.authenticator !== "software"
    || typeof authority.beginRegistration !== "function" || typeof authority.completeRegistration !== "function") {
    refuse("passkey_registration_input_refused");
  }
  return registerInitialPasskeyWithAuthorityV1(input, authority);
}

async function registerInitialPasskeyWithAuthorityV1(input, authority) {
  const { renderInitialPasskeyV1 } = await import("../terminal/qr.mjs");
  for (let attempts = 1; attempts <= input.maxAttempts; attempts += 1) {
    const registration = await authority.beginRegistration({ mode: "initial",
      ...(input.authenticator ? { authenticator: input.authenticator } : {}) });
    const rpId = registration?.config?.rpId ?? input.config.rpId;
    renderInitialPasskeyV1({ rpId, ownerCode: input.ownerCode,
      registrationSecret: registration?.registrationSecret }, input.terminal);
    try {
      const typedCode = await readCodeV1(input.terminal);
      const completed = await authority.completeRegistration({ registrationSecret: registration.registrationSecret, typedCode });
      if (typeof completed?.credentialId !== "string" || completed.credentialId.length < 1) {
        refuse("passkey_registration_result_refused");
      }
      return Object.freeze({ status: "registered", credentialIdDigest: sha256(completed.credentialId), attempts });
    } catch (error) {
      if (attempts === input.maxAttempts || !["updater_passkey_code_refused", "updater_registration_expired"]
        .includes(error?.code)) throw error;
    }
  }
  refuse("passkey_registration_result_refused");
}
export const recordPasskeyStatusV1 = input => databasePortNotYetSuppliedV1("recordPasskeyStatus", input);
export const checkHealthDatabaseV1 = input => databasePortNotYetSuppliedV1("checkHealth.database", input);

export async function killAccountProcessesV1(input, runtime = {}) {
  if (!exactKeys(input, input?.checkLaunchDomain === undefined ? ["uid"] : ["uid", "checkLaunchDomain"])
    || !Number.isSafeInteger(input.uid) || input.uid < 1 || input.uid > 0x7fffffff
    || input.checkLaunchDomain !== undefined && typeof input.checkLaunchDomain !== "boolean") {
    refuse("account_process_sweep_refused");
  }
  const run = runtime.execute ?? (async (file, args) => executeFile(file, args,
    { env: { LANG: "C", LC_ALL: "C" }, timeout: 10_000, maxBuffer: 1024 * 1024 }));
  await run("/usr/bin/pkill", ["-KILL", "-u", String(input.uid)]).catch(error => {
    if (error?.code !== 1) refuse("account_process_sweep_refused");
  });
  const ps = await run("/bin/ps", ["-axo", "uid="]).catch(() => refuse("account_process_sweep_refused"));
  if (String(ps?.stdout ?? "").split(/\r?\n/u).some(line => Number(line.trim()) === input.uid)) {
    refuse("account_process_sweep_refused");
  }
  if (input.checkLaunchDomain === true) {
    const active = await run("/bin/launchctl", ["print", `user/${input.uid}`]).then(() => true, error => {
      if (typeof error?.code === "number" && error.code !== 0) return false;
      refuse("builder_launch_domain_refused");
    });
    if (active) refuse("builder_launch_domain_refused");
  }
  return Object.freeze({ swept: true, uid: input.uid });
}

export async function installGuardV1(input) {
  const keys = ["root", "source", "target"];
  if (!exactKeys(input, input?.servicePolicy === undefined ? keys : [...keys, "servicePolicy"]) || !safeRoot(input.root)
    || !inside(input.root, input.source) || !inside(input.root, input.target)
    || input.target !== join(input.root, "guard", "guard.sh")) refuse("guard_install_refused");
  const sourceBytes = await boundedBytesFile(input.source, 1024 * 1024, "guard_install_refused");
  let bytes = sourceBytes;
  if (input.servicePolicy !== undefined) {
    const policy = validateServicePolicyV1(input.servicePolicy);
    const byRole = role => policy.find(service => service.role === role);
    const source = sourceBytes.toString("utf8");
    const shellLiteral = value => `'${value.replaceAll("'", `'"'"'`)}'`;
    // Each label is replaced INDIVIDUALLY, and that is a change this round forced.
    //
    // The original rendered the rehearsal labels by replacing one joined string -
    // `SERVICE_POLICY_LABELS_V1.map(s => s.label).join(" ")` - which only works if the
    // guard happens to contain all six labels ADJACENT and IN THAT ORDER.
    //
    // MEASURED: `guard.sh`'s `bootout_all` used to loop over four names and `bootstrap_all`
    // over four more, so the six labels were never adjacent, the joined-string replace
    // silently matched nothing, and `rehearsal guard embeds only its configured root,
    // labels and plist paths` failed on `xyz.agentcontrolroom.rehearsal.updater-guard`
    // being absent from the rendered guard.
    //
    // Per-label replacement has no such precondition: it works for any wording the guard
    // uses, which is the point - a guard whose labels must appear in one specific
    // sequence for a rehearsal to rewrite them is a guard whose rewrite silently no-ops
    // the moment its wording changes. The `rendered === source` refusal below still
    // catches a substitution that changed nothing at all.
    let rendered = source.replace("ROOT='/Library/Application Support/Control Room'", `ROOT=${shellLiteral(input.root)}`);
    for (const service of SERVICE_POLICY_LABELS_V1) {
      rendered = rendered.replaceAll(service.label, byRole(service.role).label);
    }
    for (const service of SERVICE_POLICY_LABELS_V1) {
      rendered = rendered.replaceAll(service.plistPath, byRole(service.role).plistPath);
      rendered = rendered.replaceAll(`system/${service.label}`, `system/${byRole(service.role).label}`);
    }
    if (rendered === source || SERVICE_POLICY_LABELS_V1.some(service => rendered.includes(service.plistPath))) {
      refuse("guard_install_refused");
    }
    bytes = Buffer.from(rendered);
  }
  const digest = sha256(bytes), existing = await lstat(input.target).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1
      || (existing.mode & 0o777) !== 0o555
      || sha256(await boundedBytesFile(input.target, 1024 * 1024, "guard_install_refused")) !== digest) refuse("guard_install_refused");
  } else {
    await mkdir(dirname(input.target), { recursive: true, mode: 0o755 }); await atomicFile(input.target, bytes, 0o555);
  }
  return Object.freeze({ digest, target: input.target });
}

export async function removeGuardV1(input) {
  const target = join(input?.root ?? "", "guard", "guard.sh");
  if (!safeRoot(input?.root) || input?.receipt !== undefined
    && (input.receipt?.target !== target || !DIGEST.test(input.receipt?.digest ?? ""))) refuse("guard_remove_refused");
  const exists = await lstat(target).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error));
  if (exists && input.receipt !== undefined
    && sha256(await boundedBytesFile(target, 1024 * 1024, "guard_remove_refused")) !== input.receipt.digest) {
    refuse("guard_remove_refused");
  }
  await rm(target, { force: true }); return Object.freeze({ removed: true });
}

export async function composeProtectedConfigPortV1(input, runtime = {}) {
  if (!input?.keys || typeof input.keys.webHmac !== "string" || typeof input.keys.workIntake !== "string") {
    refuse("protected_configuration_input_refused");
  }
  const webHmac = (await boundedTextFile(input.keys.webHmac, 128, "protected_configuration_input_refused")).trim();
  let workIntake;
  workIntake = await boundedJsonFile(input.keys.workIntake, "protected_configuration_input_refused");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(webHmac)
    || !exactKeys(workIntake, ["schema", "integrityKey"])
    || workIntake.schema !== "control-room.work-intake-keys/v1"
    || !/^[A-Za-z0-9_-]{43}$/u.test(workIntake.integrityKey ?? "")) refuse("protected_configuration_input_refused");
  // Load only the already staged release's data parsers; no startup or DB effects.
  const releaseParsers = await (runtime.loadReleaseParsers ?? (url => import(url)))(
    pathToFileURL(join(input.root, "current", "dist-vps", "server", "macLocalProtectedLoader.js")).href);
  return composeProtectedConfigV1({ ...input, keys: { ...input.keys,
    webHmac: { fileRef: input.keys.webHmac, value: webHmac },
    workIntake: { fileRef: input.keys.workIntake, integrityKey: workIntake.integrityKey } } }, { ...releaseParsers, captureReleaseTrustV1 });
}

export async function recordTailscaleServeV1(input) {
  if (!exactKeys(input, ["root", "serve", "webPort"]) || !safeRoot(input.root)
    || !Number.isSafeInteger(input.webPort) || input.webPort < 1024 || input.webPort > 65535
    || !input.serve || typeof input.serve !== "object" || Array.isArray(input.serve)) refuse("serve_receipt_refused");
  const bytes = Buffer.from(`${JSON.stringify(input.serve)}\n`);
  if (bytes.byteLength > MAX_JSON || bytes.includes(0)) refuse("serve_receipt_refused");
  const path = join(input.root, "updater-state", "serve.json"); await atomicFile(path, bytes);
  return Object.freeze({ serveDigest: sha256(bytes), webPort: input.webPort });
}

export async function seedKnownGoodV1(input) {
  if (!exactKeys(input, ["root", "releaseId", "pgDataId", "schemaDigest"]) || !safeRoot(input.root)
    || !SAFE_ID.test(input.releaseId ?? "") || !/^data-[A-Za-z0-9._-]{1,32}$/u.test(input.pgDataId ?? "")
    || !DIGEST.test(input.schemaDigest ?? "")) refuse("known_good_seed_refused");
  const value = Object.freeze({ releaseId: input.releaseId, pgDataId: input.pgDataId, schemaDigest: input.schemaDigest });
  const path = join(input.root, "updater-state", "known-good");
  const exists = await lstat(path).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error));
  if (exists && JSON.stringify(await boundedJsonFile(path, "known_good_seed_refused")) !== JSON.stringify(value)) {
    refuse("known_good_seed_refused");
  }
  if (!exists) await atomicFile(path, Buffer.from(`${JSON.stringify(value)}\n`)); return value;
}

export async function removeKnownGoodV1(input) {
  if (!safeRoot(input?.root) || input.expected !== undefined
    && (!exactKeys(input.expected, ["releaseId", "pgDataId", "schemaDigest"])
      || !SAFE_ID.test(input.expected.releaseId ?? "") || !DIGEST.test(input.expected.schemaDigest ?? ""))) {
    refuse("known_good_remove_refused");
  }
  const path = join(input.root, "updater-state", "known-good");
  if (input.expected !== undefined) {
    const exists = await lstat(path).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error));
    if (exists) {
      const current = await boundedJsonFile(path, "known_good_remove_refused");
      if (JSON.stringify(current) !== JSON.stringify(input.expected)) refuse("known_good_remove_refused");
    }
  }
  await rm(path, { force: true }); return Object.freeze({ removed: true });
}

export async function remintOwnerCodeV1(input) {
  if (!safeRoot(input?.root)) refuse("owner_code_refused");
  const guard = acquirePrivateProcessLockV1(join(input.root, "updater-state", ".owner-code.lock"), { busyCode: "owner_code_recovery_pending" });
  try { return await remintOwnerCode(input); } finally { guard.release(); }
}

async function remintOwnerCode(input) {
  if (!exactKeys(input, ["root", "accounts", "configuration", "rpId", "maximumRemints"]) || !safeRoot(input.root)
    || input.maximumRemints !== 2 || !Array.isArray(input.configuration)) refuse("owner_code_refused");
  const path = join(input.root, "Protected", "config", "local-owner-session.json");
  const resource = input.configuration.find(value => value?.path === path);
  if (!resource || typeof resource.contents !== "string") refuse("owner_code_refused");
  let previous; try { previous = JSON.parse(resource.contents); } catch { refuse("owner_code_refused"); }
  if (!DIGEST.test(previous.ownerCodeDigest ?? "")) refuse("owner_code_refused");
  const installed = await boundedJsonFile(path, "owner_code_refused");
  if (installed.ownerCodeDigest !== previous.ownerCodeDigest) refuse("owner_code_refused");
  const macPath = join(input.root, "Protected", "config", "mac-local.json");
  const macResource = input.configuration.find(value => value?.path === macPath);
  let mac;
  if (macResource) {
    mac = await boundedJsonFile(macPath, "owner_code_refused");
    if (mac.localOwnerSession?.ownerCodeDigest !== previous.ownerCodeDigest) refuse("owner_code_refused");
  }
  const ownerCode = randomBytes(32).toString("base64url"), digest = ownerCodeDigest(ownerCode);
  const next = { ...previous, ownerCodeDigest: digest };
  const recoveryPath = join(input.root, "updater-state", "owner-code-recovery.json");
  if (await lstat(recoveryPath).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error))) {
    refuse("owner_code_recovery_pending");
  }
  const receipt = { path, previousOwnerCodeDigest: previous.ownerCodeDigest, installedOwnerCodeDigest: digest,
    ...(mac ? { macLocalPath: macPath } : {}) };
  // This receipt reaches durable storage before either protected file changes.
  await atomicFile(recoveryPath, Buffer.from(`${JSON.stringify(receipt)}\n`));
  if (mac) await atomicFile(macPath, Buffer.from(`${JSON.stringify({ ...mac,
    localOwnerSession: { ...mac.localOwnerSession, ownerCodeDigest: digest } }, null, 2)}\n`), 0o640);
  try { await atomicFile(path, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), mac ? 0o640 : 0o600); }
  catch (error) {
    if (mac) await atomicFile(macPath, Buffer.from(`${JSON.stringify(mac, null, 2)}\n`), 0o640);
    throw error;
  }
  return Object.freeze({ ownerCode, ownerCodeDigest: digest,
    receipt: Object.freeze(receipt) });
}

export async function rollbackOwnerCodeV1(input) {
  if (!safeRoot(input?.root)) refuse("owner_code_rollback_refused");
  const guard = acquirePrivateProcessLockV1(join(input.root, "updater-state", ".owner-code.lock"), { busyCode: "owner_code_rollback_refused" });
  try { return await rollbackOwnerCode(input); } finally { guard.release(); }
}

async function rollbackOwnerCode(input) {
  if (!safeRoot(input?.root)) refuse("owner_code_rollback_refused");
  const path = join(input.root, "Protected", "config", "local-owner-session.json");
  const recoveryPath = join(input.root, "updater-state", "owner-code-recovery.json");
  const recovery = await lstat(recoveryPath).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  let receipt = input.receipt;
  if (recovery) {
    const saved = await boundedJsonFile(recoveryPath, "owner_code_rollback_refused");
    if (receipt !== undefined && (!exactKeys(saved, Object.keys(receipt ?? {}))
      || Object.entries(saved).some(([key, value]) => receipt[key] !== value))) refuse("owner_code_rollback_refused");
    receipt = saved;
  }
  if (receipt === undefined) {
    const removed = await lstat(path).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error));
    await rm(path, { force: true }); return Object.freeze({ removed });
  }
  const macPath = join(input.root, "Protected", "config", "mac-local.json");
  if (!exactKeys(receipt, ["path", "previousOwnerCodeDigest", "installedOwnerCodeDigest",
    ...(receipt?.macLocalPath === undefined ? [] : ["macLocalPath"])]) || receipt.path !== path
    || receipt.macLocalPath !== undefined && receipt.macLocalPath !== macPath
    || !DIGEST.test(receipt.previousOwnerCodeDigest ?? "") || !DIGEST.test(receipt.installedOwnerCodeDigest ?? "")) {
    refuse("owner_code_rollback_refused");
  }
  // Repeatable (atk-fa F4): recovery replays this after an in-process rollback that
  // already restored the digest and then removed the protected configuration with
  // the core services. A file that is absent, or already at the previous digest, is
  // done; only a file at some THIRD digest is a refusal. `restored` says whether
  // anything was written, so a caller restarts the supervisor only then.
  const present = async file => lstat(file).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error));
  let restored = false;
  if (receipt.macLocalPath && await present(macPath)) {
    const mac = await boundedJsonFile(macPath, "owner_code_rollback_refused");
    const digest = mac.localOwnerSession?.ownerCodeDigest;
    if (digest !== receipt.installedOwnerCodeDigest && digest !== receipt.previousOwnerCodeDigest) {
      refuse("owner_code_rollback_refused");
    }
    if (digest === receipt.installedOwnerCodeDigest) {
      await atomicFile(macPath, Buffer.from(`${JSON.stringify({ ...mac,
        localOwnerSession: { ...mac.localOwnerSession, ownerCodeDigest: receipt.previousOwnerCodeDigest } }, null, 2)}\n`), 0o640);
      restored = true;
    }
  }
  if (await present(path)) {
    const value = await boundedJsonFile(path, "owner_code_rollback_refused");
    if (value.ownerCodeDigest !== receipt.installedOwnerCodeDigest && value.ownerCodeDigest !== receipt.previousOwnerCodeDigest) {
      refuse("owner_code_rollback_refused");
    }
    if (value.ownerCodeDigest === receipt.installedOwnerCodeDigest) {
      await atomicFile(path, Buffer.from(`${JSON.stringify({ ...value, ownerCodeDigest: receipt.previousOwnerCodeDigest }, null, 2)}\n`), receipt.macLocalPath ? 0o640 : 0o600);
      restored = true;
    }
  }
  await rm(recoveryPath, { force: true });
  return Object.freeze({ restored });
}

export async function cleanupBootstrapV1(input) {
  if (!exactKeys(input, ["root", "bootstrapRoot"]) || !safeRoot(input.root) || !safeRoot(input.bootstrapRoot)
    || inside(input.root, input.bootstrapRoot) || inside(input.bootstrapRoot, input.root)) refuse("bootstrap_cleanup_refused");
  const entry = await lstat(input.bootstrapRoot).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!entry) return Object.freeze({ removed: false });
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) refuse("bootstrap_cleanup_refused");
  await rm(input.bootstrapRoot, { recursive: true, force: true }); return Object.freeze({ removed: true });
}

/**
 * `checkHealthV1` — §5.8, HTTP half here and database half supplied by M4.
 *
 * The database half is a PARAMETER rather than the local refusal, and this is
 * what lets the same function serve both callers: `createStageOnePortsV1` passes
 * M4's `checkHealthDatabaseV1` (the real PostgreSQL check), and a test that wants
 * to exercise the HTTP half alone passes its own. The refusal
 * `checkHealthDatabaseV1` names below is what an ARCHIVE that somehow carried
 * this module without M4's beside it would get — and it is the refusal the
 * installer's own tests still assert, so the contract stays covered.
 */
export async function checkHealthV1(input, runtime = {}) {
  return checkInstallerHealthV1(input, { checkDatabase: runtime.checkDatabase ?? checkHealthDatabaseV1 }, runtime);
}

export function createStageOnePortsV1(systemPorts) {
  // rv-9b B1: the database ports are the SYSTEM's (M1/M4's real implementations on
  // the native object), never this module's `database_port_not_yet_supplied` stubs.
  // A fresh install handed stage one only this object, so every database step
  // reached a stub and the install failed at `init-database`. The two passkey
  // ports are the same case (cl-pkwire): the stubs below would have answered Face ID
  // with `database_port_not_yet_supplied`. `registerInitialPasskey` is NOT the
  // system's, though (atk-fa F2): the system object is the git-archive copy, which has
  // no `node_modules` and so can never load `pg`. Stage one hands out its OWN copy of
  // the production port, which in the fixed bundle has `pg` and the passkey modules
  // inlined - the same confirmed, digest-verified code the install already runs.
  const databaseSystem = ["initializeDatabase", "retireDatabase", "firstOwner", "writeDatabaseLogins",
    "removeDatabaseLogins", "recordPasskeyStatus"];
  const requiredSystem = ["installServices", "uninstallServices", "recoverServices", "restartServices",
    "startPostHealthServices", "readTailscaleRpId", "captureTailscaleServe", "activateTailscaleServe",
    "inspectTailscaleServe", "restoreTailscaleServe", "moveLiveDatabase", "randomBytes", ...databaseSystem,
    "checkDatabaseHealth"];
  const evidenceSystem = ["assertRuntimeTreeRootMetadata", "assertSeatbeltApplied", "assertRehearsalOwnerDenied"];
  if (!systemPorts || requiredSystem.some(name => typeof systemPorts[name] !== "function")) refuse("stage_one_system_ports_refused");
  return Object.freeze({
    ...Object.fromEntries(requiredSystem.filter(name => name !== "checkDatabaseHealth")
      .map(name => [name, systemPorts[name]])),
    ...Object.fromEntries(evidenceSystem.filter(name => typeof systemPorts[name] === "function")
      .map(name => [name, systemPorts[name]])),
    vendorRuntime: vendorRuntimeV1, rollbackRuntime: input => undoVendoredRuntimeV1({ root: input.root,
      receipt: input?.receipt?.undo ?? input.receipt }),
    killAccountProcesses: killAccountProcessesV1,
    registerInitialPasskey: registerInitialPasskeyProductionV1,
    installGuard: installGuardV1, removeGuard: removeGuardV1, composeProtectedConfig: composeProtectedConfigPortV1,
    recordTailscaleServe: recordTailscaleServeV1, seedKnownGood: seedKnownGoodV1, removeKnownGood: removeKnownGoodV1,
    remintOwnerCode: async input => {
      const result = await remintOwnerCodeV1(input);
      await systemPorts.restartServices({ root: input.root, roles: ["supervisor"] });
      return result;
    },
    rollbackOwnerCode: async input => {
      const result = await rollbackOwnerCodeV1(input);
      if (result.restored || result.removed) await systemPorts.restartServices({ root: input.root, roles: ["supervisor"] });
      return result;
    },
    cleanupBootstrap: cleanupBootstrapV1,
    checkHealth: input => checkHealthV1(input, { checkDatabase: systemPorts.checkDatabaseHealth }),
  });
}
