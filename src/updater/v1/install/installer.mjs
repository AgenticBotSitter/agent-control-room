import { readJsonlPrefixV1 } from "../../../installer/shared/jsonl-prefix.mjs";
import { acquirePrivateProcessLockV1 } from "../../../installer/shared/private-process-lock.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateInstallationReleaseKeyV1 } from "../../../../scripts/release-signing.mjs";
import { spawnTrusted } from "../trusted-runtime.mjs";
import { assertRehearsalInvocationV1, loadRehearsalConfigV1 } from "./rehearsal-config.mjs";
import { DiskReserveV1 } from "../actuator.mjs";

export const CONTROL_ROOM_INSTALL_JOURNAL_SCHEMA_V2 = "control-room.install-journal/v2";
export const CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1 = "installer-journal.jsonl";
export const CONTROL_ROOM_E2E2_EVIDENCE_SCHEMA_V1 = "control-room.e2e2-evidence/v1";
export const CONTROL_ROOM_E2E2_EVIDENCE_FILE_V1 = "e2e2-evidence.jsonl";
export const DEFAULT_CONTROL_ROOM_ROOT_V1 = "/Library/Application Support/Control Room";
export const DEFAULT_CONTROL_ROOM_WEB_PORT_V1 = 3210;
export const DEFAULT_CONTROL_ROOM_GATEWAY_PORT_V1 = 3211;
export const CONTROL_ROOM_SUDOERS_V1 = "Defaults secure_path=\"/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\"\n";

const accountPolicyPath = fileURLToPath(new URL("../policy/accounts.json", import.meta.url));
const controlRoomShimPath = fileURLToPath(new URL("../bin/control-room", import.meta.url));
const digestPattern = /^(?:sha256:)?([a-f0-9]{64})$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const accountPattern = /^_[a-z][a-z0-9_]{1,30}$/u;
const MAX_SOURCE_FILES = 100_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RERUN_FILE_BYTES = 1024 * 1024;
const SAFE_ACL_RIGHTS = new Set(["read", "readattr", "readextattr", "readsecurity", "list", "search", "execute"]);

const refuse = code => { const error = new Error(code); error.code = code; throw error; };
const inside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const absolute = (value, code = "path_refused") => {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) refuse(code);
  return value;
};

export function defaultControlRoomRootV1() { return DEFAULT_CONTROL_ROOM_ROOT_V1; }

function parentPaths(path) {
  const values = [path];
  while (values.at(-1) !== "/") values.push(dirname(values.at(-1)));
  return values.reverse();
}

export async function assertInstallerRootSafetyV1({ root = DEFAULT_CONTROL_ROOM_ROOT_V1, ports }) {
  absolute(root, "install_root_refused");
  if (root === "/") refuse("install_root_refused");
  if (!ports || typeof ports.inspectOwnership !== "function") refuse("command_ports_refused");
  for (const path of parentPaths(root)) {
    const entry = await ports.inspectOwnership(path);
    if (entry === null) continue;
    if (!entry || entry.type !== "directory" || entry.symlink || entry.uid !== 0 || (entry.mode & 0o022) !== 0
      || aclAllowsMutation(entry.acl ?? [])) {
      refuse("install_root_ancestor_refused");
    }
  }
  return Object.freeze({ root });
}

function aclAllowsMutation(lines) {
  if (!Array.isArray(lines) || lines.some(line => typeof line !== "string")) return true;
  return lines.some(line => {
    if (!/\ballow\b/iu.test(line) || /\buser:root\b/iu.test(line)) return false;
    const suffix = line.slice(line.search(/\ballow\b/iu) + "allow".length);
    const rights = suffix.split(/[\s,]+/u).map(value => value.trim().toLowerCase()).filter(Boolean);
    return rights.some(right => !SAFE_ACL_RIGHTS.has(right));
  });
}

async function existingDirectory(path, code) {
  absolute(path, code);
  const stat = await lstat(path).catch(() => refuse(code));
  const canonical = await realpath(path).catch(() => refuse(code));
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== path) refuse(code);
  return path;
}

async function sourceEntries(source) {
  const entries = [];
  let bytes = 0;
  async function visit(directory, prefix = "") {
    for (const child of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (!prefix && child.name === ".git") continue;
      const path = join(directory, child.name), name = prefix ? `${prefix}/${child.name}` : child.name;
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        entries.push({ type: "directory", name, path, mode: stat.mode & 0o777, nlink: stat.nlink,
          uid: stat.uid, gid: stat.gid, dev: stat.dev, ino: stat.ino });
        await visit(path, name);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) refuse("source_hardlink_refused");
        bytes += stat.size;
        entries.push({ type: "file", name, path, mode: stat.mode & 0o777, size: stat.size, nlink: stat.nlink,
          uid: stat.uid, gid: stat.gid, dev: stat.dev, ino: stat.ino });
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || target.includes("\0") || !inside(source, resolve(dirname(path), target))) refuse("source_link_refused");
        const canonical = await realpath(path).catch(() => refuse("source_link_refused"));
        if (!inside(source, canonical)) refuse("source_link_refused");
        entries.push({ type: "link", name, path, target, mode: stat.mode & 0o777,
          uid: stat.uid, gid: stat.gid, dev: stat.dev, ino: stat.ino });
      } else refuse("source_entry_refused");
      if (entries.length > MAX_SOURCE_FILES || bytes > MAX_SOURCE_BYTES) refuse("source_too_large");
    }
  }
  await visit(source);
  return entries;
}

async function checkoutDigest(source, entries = undefined) {
  const hash = createHash("sha256");
  for (const entry of entries ?? await sourceEntries(source)) {
    hash.update(`${entry.type}\0${entry.name}\0${entry.mode.toString(8)}\0`);
    if (entry.type === "file") {
      const content = await readFile(entry.path);
      if (content.byteLength !== entry.size) refuse("source_changed_during_verification");
      hash.update(content);
    } else if (entry.type === "link") hash.update(entry.target);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function digestControlRoomCheckoutV1(sourceInput) {
  return checkoutDigest(await existingDirectory(sourceInput, "source_directory_refused"));
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function safeWrite(path, bytes, mode = 0o600) {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, mode)
    .catch(error => error?.code === "EEXIST" ? refuse("exclusive_file_exists") : Promise.reject(error));
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

export async function readRegularFileNoFollowV1(path, { maximumBytes = MAX_RERUN_FILE_BYTES, uid, gid } = {}) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch(() => refuse("existing_file_refused"));
  try {
    const stat = await handle.stat();
    const enforceOwner = (process.geteuid?.() ?? -1) === 0;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximumBytes || enforceOwner && uid !== undefined && stat.uid !== uid
      || enforceOwner && gid !== undefined && stat.gid !== gid) refuse("existing_file_refused");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) refuse("existing_file_refused");
    return bytes;
  } finally { await handle.close(); }
}

async function replaceRootOwnedFile(path, bytes, mode = 0o600) {
  const current = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (current) {
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) refuse("root_state_file_refused");
    await unlink(path);
  }
  await safeWrite(path, bytes, mode);
}

async function ensureDirectory(path, mode, owner, ports) {
  await mkdir(path, { recursive: true, mode });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("install_layout_refused");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    await ports.lchownPath(path, owner.uid, owner.gid);
    await handle.chmod(mode);
    const after = await handle.stat(), named = await lstat(path);
    if (before.dev !== named.dev || before.ino !== named.ino || !named.isDirectory() || named.isSymbolicLink()
      || (after.mode & 0o7777) !== mode) refuse("install_layout_refused");
  } finally { await handle.close(); }
}

function ids(accounts, name) {
  const account = accounts[name];
  if (!account) refuse("account_state_refused");
  return { uid: account.uid, gid: account.gid };
}

async function loadAccountsPolicy(options) {
  let value;
  try { value = options.accountsPolicy ?? JSON.parse(await readFile(accountPolicyPath, "utf8")); }
  catch { refuse("accounts_policy_refused"); }
  const names = value?.accounts;
  if (value?.schema !== "control-room.accounts/v1" || !names || Object.keys(names).sort().join(",") !== "builder,database,service"
    || Object.values(names).some(name => !accountPattern.test(name)) || new Set(Object.values(names)).size !== 3) {
    refuse("accounts_policy_refused");
  }
  return Object.freeze({ ...names });
}

/** The sole allocator for the installer's service-account UID/GID range. */
export function firstFreeServiceAccountIdV1(usedUids, usedGids) {
  if (!(usedUids instanceof Set) || !(usedGids instanceof Set)) refuse("account_id_range_exhausted");
  for (let id = 300; id <= 399; id += 1) if (!usedUids.has(id) && !usedGids.has(id)) return id;
  refuse("account_id_range_exhausted");
}

async function createAccounts(names, ports) {
  const existing = await ports.readAccountInventory();
  if (!existing || !Array.isArray(existing.users) || !Array.isArray(existing.groups)) refuse("account_inventory_refused");
  const users = new Map(existing.users.map(row => [row.name, row]));
  const groups = new Map(existing.groups.map(row => [row.name, row]));
  const usedUids = new Set(existing.users.map(row => row.uid)), usedGids = new Set(existing.groups.map(row => row.gid));
  const created = [], accounts = {};
  try {
    for (const [role, name] of Object.entries(names)) {
      const user = users.get(name), group = groups.get(name);
      if (user || group) {
        if (!user || !group || user.uid < 300 || user.uid > 399 || user.uid !== group.gid || user.gid !== group.gid || user.home !== "/var/empty"
          || user.shell !== "/usr/bin/false" || user.hidden !== true || user.password !== "*"
          || !Array.isArray(user.memberships) || user.memberships.some(nameValue => ["admin", "wheel", "staff"].includes(nameValue))) {
          refuse("account_state_refused");
        }
        accounts[role] = { name, uid: user.uid, gid: group.gid, created: false };
        continue;
      }
      const id = firstFreeServiceAccountIdV1(usedUids, usedGids);
      await ports.createAccount({ name, uid: id, gid: id, home: "/var/empty", shell: "/usr/bin/false", hidden: true,
        password: "*" });
      created.push(name); usedUids.add(id); usedGids.add(id);
      accounts[role] = { name, uid: id, gid: id, created: true };
    }
    return { accounts, created };
  } catch (error) {
    for (const name of created.reverse()) await ports.deleteAccount(name).catch(() => {});
    throw error;
  }
}

export async function createLayoutV1(root, accounts, ports, reserve = ports.diskReserve?.(root) ?? new DiskReserveV1(root)) {
  const rootOwner = { uid: 0, gid: 0 }, service = ids(accounts, "service"), database = ids(accounts, "database");
  const directoryRows = [
    ["", 0o755, rootOwner], ["runtime", 0o555, rootOwner], ["updater", 0o755, rootOwner], ["guard", 0o555, rootOwner],
    ["updater-state", 0o700, rootOwner], ["updater-state/plans", 0o700, rootOwner], ["updater-state/tmp", 0o700, rootOwner],
    ["releases", 0o750, { uid: 0, gid: service.gid }], ["Protected", 0o750, { uid: 0, gid: service.gid }],
    ["Protected/service", 0o700, service], ["Protected/config", 0o750, { uid: 0, gid: service.gid }],
    ["Protected/runtime-state", 0o700, service], ["pg", 0o755, rootOwner],
    ["pg/socket", 0o750, { uid: database.uid, gid: service.gid }], ["backups", 0o710, { uid: 0, gid: service.gid }],
    ["build", 0o755, rootOwner], ["logs", 0o755, rootOwner], ["status", 0o755, rootOwner],
  ];
  for (const [name, mode, owner] of directoryRows) await ensureDirectory(name ? join(root, name) : root, mode, owner, ports);
  await reserve.ensureIntact();
  await ports.lchownPath(join(root, "rescue-reserve.bin"), 0, 0);
  await chmod(join(root, "rescue-reserve.bin"), 0o600);
  const logOwners = [["supervisor", service], ["gateway", service], ["postgres", database],
    ["builder", ids(accounts, "builder")], ["upgrader", database],
    ["updater", rootOwner], ["updater-guard", rootOwner]];
  for (const [role, account] of logOwners) {
    const directory = join(root, "logs", role);
    await ensureDirectory(directory, 0o755, rootOwner, ports);
    for (const file of ["out.log", "err.log"]) {
      const path = join(directory, file);
      const exists = await lstat(path).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error));
      if (!exists) await safeWrite(path, "", 0o600);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1) refuse("log_file_refused");
      await chmod(path, 0o600); await ports.lchownPath(path, account.uid, account.gid);
    }
  }
}

async function pointer(root, name) {
  const path = join(root, name);
  try {
    const stat = await lstat(path);
    if (!stat.isSymbolicLink()) refuse("release_pointer_refused");
    const target = await readlink(path);
    const updater = name.startsWith("updater/");
    if (updater ? !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(target) : !validPointerSnapshot(target)) refuse("release_pointer_refused");
    if (!inside(join(root, updater ? "updater" : "releases"), await realpath(path))) refuse("release_pointer_refused");
    return target;
  } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function savedPasskeyOutcome(root) {
  const path = join(root, "status", "passkey.json");
  if (!await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error))) {
    return { status: "stopped", reason: "passkey_status_missing" };
  }
  let value;
  try { value = JSON.parse((await readRegularFileNoFollowV1(path, { maximumBytes: 4096 })).toString("utf8")); }
  catch { return { status: "stopped", reason: "passkey_status_invalid" }; }
  if (value?.schema === "control-room.install-passkey-status/v1" && value.status === "registered"
    && Object.keys(value).sort().join(",") === "attempts,credentialIdDigest,schema,status"
    && /^sha256:[a-f0-9]{64}$/u.test(value.credentialIdDigest ?? "")
    && Number.isSafeInteger(value.attempts) && value.attempts >= 1 && value.attempts <= 5) return value;
  if (value?.schema === "control-room.install-passkey-status/v1" && value.status === "stopped"
    && Object.keys(value).sort().join(",") === "reason,schema,status"
    && /^[a-z][a-z0-9_-]{0,79}$/u.test(value.reason ?? "")) return value;
  return { status: "stopped", reason: "passkey_status_invalid" };
}

async function replaceGatewayFile(root, bytes, ports) {
  const path = join(root, "Protected", "config", "fleet-gateway.json"), metadata = await lstat(path);
  const temporary = join(dirname(path), `.gateway-config-${randomUUID()}`);
  try {
    await safeWrite(temporary, bytes, metadata.mode & 0o777);
    await ports.lchownPath(temporary, metadata.uid, metadata.gid);
    await rename(temporary, path); await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}

async function restoreGatewayFile(root, snapshot, ports) {
  if (!snapshot || !/^gateway-config-before-[A-Za-z0-9-]{1,80}$/u.test(snapshot.backup ?? "")
    || !digestPattern.test(snapshot.before ?? "") || !digestPattern.test(snapshot.after ?? "")) refuse("install_journal_refused");
  const bytes = await readRegularFileNoFollowV1(join(root, "updater-state", snapshot.backup));
  const current = await readRegularFileNoFollowV1(join(root, "Protected/config/fleet-gateway.json"));
  const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  if (digest(bytes) !== snapshot.before || ![snapshot.before, snapshot.after].includes(digest(current))) {
    refuse("gateway_configuration_changed");
  }
  if (digest(current) !== snapshot.before) await replaceGatewayFile(root, bytes, ports);
}

async function recomposeGatewayFile(root, id, write, ports, undo) {
  const path = join(root, "Protected/config/fleet-gateway.json");
  const before = await readRegularFileNoFollowV1(path);
  let saved; try { saved = JSON.parse(before.toString("utf8")); } catch { refuse("gateway_configuration_refused"); }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) refuse("gateway_configuration_refused");
  const healthProbeKeyFile = join(root, "Protected/service/health-probe.key");
  if (saved.healthProbeKeyFile === healthProbeKeyFile) return;
  const after = Buffer.from(`${JSON.stringify({ ...saved, healthProbeKeyFile }, null, 2)}\n`);
  const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const snapshot = { backup: `gateway-config-before-${id}`, before: digest(before), after: digest(after) };
  await safeWrite(join(root, "updater-state", snapshot.backup), before);
  await write("planned", "recompose-gateway-config", snapshot);
  undo.push(() => restoreGatewayFile(root, snapshot, ports));
  await replaceGatewayFile(root, after, ports);
  await write("done", "recompose-gateway-config", snapshot);
}

function systemPaths(options) {
  const value = options.systemPaths ?? {
    shim: "/usr/local/bin/control-room", sudoers: "/etc/sudoers.d/control-room", sudoersMain: "/etc/sudoers",
    cronDeny: "/usr/lib/cron/cron.deny", atDeny: "/usr/lib/cron/at.deny",
  };
  for (const path of Object.values(value)) absolute(path, "system_path_refused");
  return value;
}

async function installShimAndSudoers(paths, ports, undo) {
  await ports.assertT1Path(dirname(paths.shim));
  await ports.assertT1Path(dirname(paths.sudoers));
  const shim = await readFile(controlRoomShimPath, "utf8");
  const shimCreated = await ports.installRootFile(paths.shim, shim, { mode: 0o555, uid: 0, gid: 0 });
  if (shimCreated) undo.push(async () => ports.removeRootFile(paths.shim));
  const sudoersCreated = await ports.installRootFile(paths.sudoers, CONTROL_ROOM_SUDOERS_V1, { mode: 0o440, uid: 0, gid: 0 });
  if (sudoersCreated) undo.push(async () => ports.removeRootFile(paths.sudoers));
  if (!await ports.validateSudoers(paths.sudoers) || !await ports.sudoSecurePathIsActive()) {
    refuse("sudoers_validation_refused");
  }
  return { shimCreated, sudoersCreated };
}

async function generateKeys(root, accounts, ports, { credentialAlreadyAdopted = false } = {}) {
  const service = ids(accounts, "service"), state = join(root, "updater-state"), protectedService = join(root, "Protected", "service");
  const key = size => ports.randomBytes?.(size) ?? randomBytes(size);
  // atk-fa F12: each key reaches its name only complete and owned (temporary, chown,
  // rename), so a stop part-way leaves either no file or a whole one. An adopted file's
  // CONTENT is checked as well as its metadata; a zero-byte file never held a key (a
  // create torn by an older writer) and is replaced, anything else odd is refused.
  const existingKey = async (path, owner, valid) => {
    const current = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!current) return null;
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || (current.mode & 0o777) !== 0o600) {
      refuse("existing_key_refused");
    }
    const opened = await readRegularFileNoFollowV1(path, { uid: owner.uid, gid: owner.gid });
    if (opened.byteLength === 0) { await unlink(path); return null; }
    const text = opened.toString("utf8");
    if (!valid(text)) refuse("existing_key_refused");
    return text;
  };
  const writeOwned = async (path, bytes, owner, valid) => {
    if (await existingKey(path, owner, valid) !== null) return false;
    const temporary = join(dirname(path), `.${basename(path)}.installing`);
    await rm(temporary, { force: true }); await safeWrite(temporary, bytes, 0o600);
    try { await ports.lchownPath(temporary, owner.uid, owner.gid); await rename(temporary, path); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    await syncDirectory(dirname(path)); return true;
  };
  const jsonObject = text => { try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value)
    ? value : null; } catch { return null; } };
  const base64urlKey = text => /^[A-Za-z0-9_-]{43}\n$/u.test(text);
  // The updater's own format (`journal.mjs`): 64 hex characters and a newline (atk-fa F7).
  await writeOwned(join(state, "journal.key"), `${key(32).toString("hex")}\n`, { uid: 0, gid: 0 },
    text => /^[a-f0-9]{64}\n$/u.test(text));
  const vapidPath = join(state, "vapid.json"), publicPath = join(protectedService, "vapid-public.json");
  const validVapid = text => typeof jsonObject(text)?.publicKey === "string" && typeof jsonObject(text)?.privateKey === "string";
  const adoptedVapid = await existingKey(vapidPath, { uid: 0, gid: 0 }, validVapid);
  let vapid = adoptedVapid === null ? null : JSON.parse(adoptedVapid);
  if (!vapid) {
    vapid = await ports.generateVapidKeys();
    if (!vapid || typeof vapid.publicKey !== "string" || typeof vapid.privateKey !== "string") refuse("vapid_generation_refused");
    await writeOwned(vapidPath, `${JSON.stringify(vapid)}\n`, { uid: 0, gid: 0 }, validVapid);
  }
  // Written, or re-derived after a stop between the two files, from the private file's public half.
  await writeOwned(publicPath, `${JSON.stringify({ publicKey: vapid.publicKey })}\n`, service,
    text => jsonObject(text)?.publicKey === vapid.publicKey);
  const releaseKey = await generateInstallationReleaseKeyV1({ protectedRoot: join(root, "Protected"),
    versionFloor: "0.0.0" }, { expectedUid: process.geteuid?.() ?? 0 });
  // The service's probe copy is ALWAYS root's key: after a stop between the two
  // writes the retry copies the adopted key instead of minting a second one.
  const probePath = join(state, "health-probe.key");
  const probe = await existingKey(probePath, { uid: 0, gid: 0 }, base64urlKey) ?? `${key(32).toString("base64url")}\n`;
  await writeOwned(probePath, probe, { uid: 0, gid: 0 }, base64urlKey);
  await writeOwned(join(protectedService, "health-probe.key"), probe, service, text => text === probe);
  await writeOwned(join(protectedService, "web-hmac.key"), `${key(32).toString("base64url")}\n`, service, base64urlKey);
  await writeOwned(join(protectedService, "work-intake.json"), `${JSON.stringify(await ports.generateWorkIntakeKeys())}\n`, service,
    text => jsonObject(text) !== null);
  if (credentialAlreadyAdopted) {
    const token = (await readRegularFileNoFollowV1(join(state, "github-read.token"), { uid: 0, gid: 0 })).toString("utf8");
    if (!/^[A-Za-z0-9._~-]{1,1024}\n$/u.test(token)) refuse("github_credential_refused");
  } else {
    const token = await ports.readGithubCredential();
    if (typeof token !== "string" || token.length < 1 || token.length > 16_384 || token.includes("\0")) refuse("github_credential_refused");
    await writeOwned(join(state, "github-read.token"), token.endsWith("\n") ? token : `${token}\n`, { uid: 0, gid: 0 },
      text => text.length > 1 && text.endsWith("\n") && !text.includes("\0"));
  }
  return releaseKey.trust;
}

async function appendJournal(root, record, ports) {
  const path = join(root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1);
  const handle = await open(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
    .catch(() => refuse("install_journal_refused"));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) refuse("install_journal_refused");
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if ((await handle.write(bytes)).bytesWritten !== bytes.byteLength) refuse("install_journal_refused");
    await handle.sync();
  } finally { await handle.close(); }
  await ports.lchownPath(path, 0, 0); await chmod(path, 0o600); await syncDirectory(dirname(path));
  await ports.afterJournalEntry?.(record);
}

async function validateOwnerEvidenceDestination(path, invokingUser) {
  absolute(path, "rehearsal_evidence_path_refused");
  if (basename(path) !== CONTROL_ROOM_E2E2_EVIDENCE_FILE_V1 || !invokingUser
      || !Number.isSafeInteger(invokingUser.uid) || !Number.isSafeInteger(invokingUser.gid)) {
    refuse("rehearsal_evidence_path_refused");
  }
  const parent = dirname(path), parentStat = await lstat(parent).catch(() => refuse("rehearsal_evidence_path_refused"));
  const expectedUid = (process.geteuid?.() ?? -1) === 0 ? invokingUser.uid : process.geteuid?.();
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0
      || expectedUid === undefined || parentStat.uid !== expectedUid) refuse("rehearsal_evidence_path_refused");
  await realpath(parent).catch(() => refuse("rehearsal_evidence_path_refused"));
  const journalPath = join(parent, CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1);
  for (const target of [path, journalPath]) {
    const stat = await lstat(target).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || stat.uid !== expectedUid)) refuse("rehearsal_evidence_path_refused");
  }
  return Object.freeze({ path, journalPath, parent, owner: Object.freeze({ uid: invokingUser.uid, gid: invokingUser.gid }) });
}

function readEvidenceJournal(text) {
  const prefix = readJsonlPrefixV1(text, { refuse: () => refuse("rehearsal_evidence_refused") });
  // Validate every record before selecting a transaction or repairing its tail.
  if (prefix.values.some(row => row?.schema !== CONTROL_ROOM_E2E2_EVIDENCE_SCHEMA_V1))
    refuse("rehearsal_evidence_refused");
  return prefix;
}

async function appendE2e2Evidence(root, row, ports) {
  const path = join(root, "updater-state", CONTROL_ROOM_E2E2_EVIDENCE_FILE_V1);
  const handle = await open(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600)
    .catch(() => refuse("rehearsal_evidence_refused"));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) refuse("rehearsal_evidence_refused");
    const prefix = readEvidenceJournal(await handle.readFile("utf8"));
    if (prefix.repaired) { await handle.truncate(prefix.bytes); await handle.sync(); }
    await handle.writeFile(`${JSON.stringify(row)}\n`); await handle.sync();
  } finally { await handle.close(); }
  await ports.lchownPath(path, 0, 0); await chmod(path, 0o600); await syncDirectory(dirname(path));
}

async function replaceOwnerEvidenceFile(path, bytes, owner, token, ports) {
  const temporary = join(dirname(path), `.control-room-e2e2-${token}-${basename(path)}`);
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
    .catch(() => refuse("rehearsal_evidence_refused"));
  try { await handle.writeFile(bytes); await handle.chmod(0o600); await handle.sync(); }
  catch (error) { await handle.close().catch(() => {}); await rm(temporary, { force: true }); throw error; }
  await handle.close();
  try {
    await ports.lchownPath(temporary, owner.uid, owner.gid); await chmod(temporary, 0o600); await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

async function publishRehearsalEvidence(root, commit, id, destination, ports) {
  const journal = (await readJournal(root)).filter(row => row.command === "install" && row.transactionId === id);
  if (journal.length === 0 || actionFor(journal, id, "transaction")?.data?.state !== "installed") {
    refuse("rehearsal_evidence_refused");
  }
  const evidencePath = join(root, "updater-state", CONTROL_ROOM_E2E2_EVIDENCE_FILE_V1);
  let evidence;
  try {
    const stat = await lstat(evidencePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || stat.size > 64 * 1024 * 1024) refuse("rehearsal_evidence_refused");
    evidence = readEvidenceJournal(await readFile(evidencePath, "utf8")).values
      .filter(row => row.transactionId === id);
  } catch { refuse("rehearsal_evidence_refused"); }
  const steps = ["capture", "activate", "restore"];
  if (evidence.some(row => row?.schema !== CONTROL_ROOM_E2E2_EVIDENCE_SCHEMA_V1 || row.root !== root || row.commit !== commit)
      || steps.some(step => {
        const matches = evidence.filter(row => row.kind === "tailscale-step" && row.step === step);
        return matches.length !== 1 || matches[0].outcome !== "skipped (rehearsal)";
      })) refuse("rehearsal_evidence_refused");
  const boundJournal = journal.map(row => ({ ...row, root, commit }));
  await replaceOwnerEvidenceFile(destination.journalPath, `${boundJournal.map(JSON.stringify).join("\n")}\n`,
    destination.owner, id, ports);
  await replaceOwnerEvidenceFile(destination.path, `${evidence.map(JSON.stringify).join("\n")}\n`,
    destination.owner, id, ports);
}

function timestamp(ports) {
  const value = ports.now?.() ?? new Date().toISOString();
  if (typeof value !== "string" || new Date(value).toISOString() !== value) refuse("clock_refused");
  return value;
}
function transactionId(ports) {
  const value = ports.randomId?.() ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)) refuse("transaction_id_refused");
  return value;
}
function writer(root, id, command, ports) {
  let sequence = 0;
  return (phase, action, data = {}) => appendJournal(root, { schema: CONTROL_ROOM_INSTALL_JOURNAL_SCHEMA_V2,
    transactionId: id, command, sequence: ++sequence, phase, action, at: timestamp(ports), data }, ports);
}

async function readLockFile(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch(error => error?.code === "ENOENT" ? null : refuse("install_lock_refused"));
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (stat.isFile() && stat.nlink === 0) return null; // removed since it was opened: read the name again
    if (!stat.isFile() || stat.nlink > 2 || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
      refuse("install_lock_refused");
    }
    // Zero bytes: a create the older open-then-write lock left behind after a kill. It
    // never named a holder, and the lock below is only ever linked into place whole.
    if (stat.size === 0 && stat.nlink === 1) return { stat, value: null };
    let value; try { value = JSON.parse(await handle.readFile("utf8")); } catch { refuse("install_lock_refused"); }
    if (!Number.isSafeInteger(value?.pid) || value.pid < 1 || typeof value.token !== "string"
      || !/^[A-Za-z0-9-]{1,64}$/u.test(value.token)
      || typeof value.identity !== "string" || value.identity.length < 1 || value.identity.length > 512) refuse("install_lock_refused");
    // The one second name a lock may have is its holder's own temporary, between the
    // link and the holder removing it.
    if (stat.nlink === 2) {
      const temporary = await lstat(join(dirname(path), `.install.lock.${value.token}`)).catch(() => null);
      if ((temporary?.dev !== stat.dev || temporary?.ino !== stat.ino) && (await handle.stat()).nlink !== 1) {
        refuse("install_lock_refused");
      }
    }
    return { stat, value };
  } finally { await handle.close(); }
}

async function lockHolderIsStale(value, ports) {
  if (value === null) return true;
  try { process.kill(value.pid, 0); } catch (processError) {
    if (processError?.code === "ESRCH") return true;
    throw processError;
  }
  try { return await ports.processIdentity(value.pid) !== value.identity; }
  catch (identityError) {
    try { process.kill(value.pid, 0); } catch (processError) {
      if (processError?.code === "ESRCH") return true;
      throw processError;
    }
    throw identityError;
  }
}

const sameLock = (left, right) => left && right && left.stat.dev === right.stat.dev && left.stat.ino === right.stat.ino
  && (left.value === null ? right.value === null && right.stat.size === 0 : left.value.token === right.value?.token);

/**
 * The install lock (atk-fa F9/F10). The holder's identity is probed BEFORE anything
 * exists on disk, and the lock is written whole to a private temporary and LINKED
 * into place, so a stop never leaves an empty lock. A stale lock is taken over under
 * a takeover marker named for that lock's token (mkdir is exclusive): only the
 * marker's holder may unlink a lock carrying that token, so of several installers
 * that all judged the same lock stale exactly one removes it, and none can remove
 * the fresh lock a winner then links into place.
 */
// Hold a kernel lease throughout acquisition, takeover and the transaction.
// A paused taker retains this lease even if its diagnostic marker is old.
async function acquireLock(root, ports) {
  await mkdir(root, { recursive: true, mode: 0o755 });
  const guard = acquirePrivateProcessLockV1(join(root, ".installer-process-lock"), { busyCode: "install_already_running" });
  try {
    const release = await acquireJournalLock(root, ports);
    return async path => { try { await release(path); } finally { guard.release(); } };
  } catch (error) { guard.release(); throw error; }
}

async function acquireJournalLock(root, ports) {
  await mkdir(root, { recursive: true, mode: 0o755 });
  const path = join(root, ".install.lock"), token = transactionId(ports);
  const identity = await ports.processIdentity(process.pid);
  if (typeof identity !== "string" || identity.length < 1 || identity.length > 512 || identity.includes("\0")) {
    refuse("install_lock_refused");
  }
  const temporary = join(root, `.install.lock.${token}`);
  await safeWrite(temporary, `${JSON.stringify({ pid: process.pid, token, identity })}\n`, 0o600);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await link(temporary, path);
        return async (releasePath = path) => {
          const value = JSON.parse(await readFile(releasePath, "utf8"));
          if (value.token === token) await unlink(releasePath);
        };
      } catch (error) { if (error?.code !== "EEXIST") throw error; }
      const held = await readLockFile(path);
      if (!held) continue;
      if (!await lockHolderIsStale(held.value, ports)) refuse("install_already_running");
      const marker = join(root, `.install.lock.takeover-${held.value?.token ?? `empty-${held.stat.ino}`}`);
      try { await mkdir(marker, { mode: 0o700 }); } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        // A marker outlives its taker only if the taker died inside the takeover
        // itself (milliseconds); one a minute old is abandoned and is cleared.
        const markerStat = await lstat(marker).catch(() => null);
        if (!markerStat || Date.now() - markerStat.mtimeMs < 60_000) refuse("install_already_running");
        await rm(marker, { recursive: true, force: true }); continue;
      }
      try {
        if (sameLock(held, await readLockFile(path))) {
          await unlink(path);
          if (held.value) await rm(join(root, `.install.lock.${held.value.token}`), { force: true });
        }
      } finally { await rm(marker, { recursive: true, force: true }); }
    }
    refuse("install_already_running");
  } finally { await rm(temporary, { force: true }); }
}

function requirePorts(ports, names) {
  if (!ports || names.some(name => typeof ports[name] !== "function")) refuse("command_ports_refused");
  return ports;
}

async function journalStep(write, action, effect) {
  await write("planned", action);
  const data = await effect();
  await write("done", action, data ?? {});
  return data;
}

function actionFor(entries, transactionIdValue, action, phase = "done") {
  return [...entries].reverse().find(entry => entry.transactionId === transactionIdValue && entry.action === action && entry.phase === phase);
}

function validPointerSnapshot(value) {
  return value === null || typeof value === "string" && /^releases\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);
}

function recoveryAccountNames(record, names) {
  if (!record) return [];
  const created = record.data?.created;
  if (!Array.isArray(created) || created.some(name => !Object.values(names).includes(name)) || new Set(created).size !== created.length
    || record.data?.accounts?.builder?.name !== names.builder) refuse("install_journal_refused");
  return created;
}

function recoveryAccounts(record, names) {
  recoveryAccountNames(record, names);
  const accounts = record?.data?.accounts;
  if (!accounts || Object.entries(names).some(([role, name]) => accounts[role]?.name !== name
    || !Number.isSafeInteger(accounts[role]?.uid) || !Number.isSafeInteger(accounts[role]?.gid)
    || accounts[role].uid < 300 || accounts[role].uid > 399 || accounts[role].gid !== accounts[role].uid)) {
    refuse("install_journal_refused");
  }
  return accounts;
}

function recoveryStageTarget(root, record) {
  if (!record) return null;
  const targetLink = record.data?.targetLink, target = record.data?.target;
  if (!validPointerSnapshot(targetLink) || targetLink === null || target !== join(root, targetLink)) refuse("install_journal_refused");
  return target;
}

function exactStagedChild(parent, target) {
  if (typeof target !== "string" || !isAbsolute(target) || resolve(target) !== target) return false;
  const name = relative(parent, target);
  return name !== "" && name !== "." && name !== ".." && !name.includes(sep)
    && /^[A-Za-z0-9._-]{1,80}$/u.test(name);
}

/**
 * Retire a staged release or updater folder by renaming it aside, unless a live
 * pointer (`current`, `previous`, `updater/current`, `updater/previous`) resolves to
 * it. A "staged" target can be the LIVE folder (a re-run of an installed commit whose
 * identical build the stage reused, or a recovery matching folders by commit), and
 * renaming that left `current` dangling (atk-fa F5).
 */
async function retireStagedTarget(root, target, retiredName) {
  const canonical = await realpath(target).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (canonical === null) return false;
  for (const name of ["current", "previous", "updater/current", "updater/previous"]) {
    if (await realpath(join(root, name)).catch(() => null) === canonical) return false;
  }
  await rename(target, retiredName); return true;
}

async function recoverInterruptedInstall(root, paths, names, ports, identity, rehearsal, rehearsalEvidence) {
  const entries = await readJournal(root), planned = [...entries].reverse().find(entry => entry.command === "install"
    && entry.action === "transaction" && entry.phase === "planned");
  if (!planned) return;
  const id = planned.transactionId;
  const recordedRehearsalDigest = planned.data?.rehearsalConfigDigest;
  if (recordedRehearsalDigest !== undefined && recordedRehearsalDigest !== rehearsal?.digest
    || recordedRehearsalDigest === undefined && rehearsal !== undefined) refuse("rehearsal_identity_mismatch");
  if (rehearsal && (planned.data?.authenticator !== "software"
      || planned.data?.e2e2EvidenceLog !== rehearsalEvidence?.path)) refuse("rehearsal_identity_mismatch");
  const servicePolicy = rehearsal?.servicePolicy;
  if (actionFor(entries, id, "transaction")?.data?.state === "installed"
    || entries.some(entry => entry.command === "recovery" && entry.data?.installTransactionId === id && entry.data?.state === "recovered")) return;
  const recoveryId = transactionId(ports), write = writer(root, recoveryId, "recovery", ports);
  await write("planned", "transaction", { installTransactionId: id });
  const recoverBatch = async (action, roles) => {
    const plannedBatch = actionFor(entries, id, action, "planned"), doneBatch = actionFor(entries, id, action);
    if (!plannedBatch) return;
    const receipt = doneBatch?.data?.receipt;
    if (receipt !== undefined && (!receipt || receipt.roles?.join("\0") !== roles.join("\0")
      || !digestPattern.test(receipt.receiptDigest ?? ""))) refuse("install_journal_refused");
    await ports.recoverServices({ root, roles, ...(servicePolicy ? { servicePolicy } : {}),
      ...(receipt === undefined ? {} : { receipt }) });
  };
  await recoverBatch("install-post-health-services", ["nightly-backup", "updater", "updater-guard"]);
  const ownerSession = actionFor(entries, id, "mint-owner-session");
  if (actionFor(entries, id, "mint-owner-session", "planned")) {
    await ports.rollbackOwnerCode({ root, ...(servicePolicy ? { servicePolicy } : {}),
      ...(ownerSession?.data?.receipt ? { receipt: ownerSession.data.receipt } : {}) });
  }
  const knownGood = actionFor(entries, id, "seed-known-good");
  if (actionFor(entries, id, "seed-known-good", "planned")) {
    await ports.removeKnownGood({ root, ...(knownGood ? { expected: knownGood.data } : {}) });
  }
  const capture = actionFor(entries, id, "capture-tailscale"), activate = actionFor(entries, id, "activate-tailscale", "planned");
  if (!rehearsal && capture && activate) await ports.restoreTailscaleServe({ snapshot: capture.data,
    temporaryDirectory: join(root, "updater-state", "tmp"), identity });
  await recoverBatch("install-services", ["supervisor", "fleet-gateway"]);
  if (actionFor(entries, id, "install-guard", "planned")) {
    await ports.removeGuard({ root, receipt: actionFor(entries, id, "install-guard")?.data });
  }
  const init = actionFor(entries, id, "init-database");
  if (actionFor(entries, id, "install-database-service", "planned") || actionFor(entries, id, "init-database", "planned")) {
    await recoverBatch("install-database-service", ["postgresql17"]);
    const accountsRecord = actionFor(entries, id, "create-accounts");
    const recoveredAccounts = recoveryAccounts(accountsRecord, names);
    await ports.killAccountProcesses({ uid: recoveredAccounts.database.uid });
    const pgDataId = init?.data?.pgDataId ?? `data-${id.replace(/-/gu, "").slice(0, 24)}`;
    if (!/^data-[A-Za-z0-9._-]{1,32}$/u.test(pgDataId)) refuse("install_journal_refused");
    // D's uid, as the in-process undo passes it (`install-steps.mjs`): without it the
    // port falls back to the caller's uid, which is root here, and refused every
    // retry after an interruption past `init-database` (rv-9b B4).
    await ports.retireDatabase({ root, pgDataId, accountUid: recoveredAccounts.database.uid });
    const loginReceipt = actionFor(entries, id, "write-database-logins")?.data?.receipt;
    await ports.removeDatabaseLogins({ root, ...(loginReceipt ? { receipt: loginReceipt } : {}) });
  }
  const pgRuntime = actionFor(entries, id, "vendor-pg-runtime");
  if (actionFor(entries, id, "vendor-pg-runtime", "planned")) await ports.rollbackRuntime(pgRuntime
    ? { root, receipt: pgRuntime.data } : { root, tools: ["postgresql"], transactionId: id });
  const gatewaySnapshot = actionFor(entries, id, "recompose-gateway-config", "planned");
  if (gatewaySnapshot) await restoreGatewayFile(root, gatewaySnapshot.data, ports);
  const pointers = actionFor(entries, id, "switch-pointers") ?? actionFor(entries, id, "switch-pointers", "planned");
  if (pointers) {
    if (!["oldCurrent", "oldPrevious", "oldUpdaterCurrent", "oldUpdaterPrevious"]
      .every(name => Object.hasOwn(pointers.data ?? {}, name))) refuse("install_journal_refused");
    if (!validPointerSnapshot(pointers.data?.oldCurrent ?? null) || !validPointerSnapshot(pointers.data?.oldPrevious ?? null)
      || !validPointerSnapshot(pointers.data?.target ?? null)) refuse("install_journal_refused");
    for (const value of [pointers.data?.oldUpdaterCurrent, pointers.data?.oldUpdaterPrevious])
      if (value !== undefined && value !== null && !/^[A-Za-z0-9._-]{1,80}$/u.test(value)) refuse("install_journal_refused");
    await ports.switchPairV1({ root, restore: { oldCurrent: pointers.data.oldCurrent ?? null,
      oldPrevious: pointers.data.oldPrevious ?? null, oldUpdaterCurrent: pointers.data.oldUpdaterCurrent ?? null,
      oldUpdaterPrevious: pointers.data.oldUpdaterPrevious ?? null } });
    if (!actionFor(entries, id, "create-accounts", "planned")) {
      await ports.restartServices({ root, roles: ["supervisor", "fleet-gateway", "updater"], rollback: true,
        ...(servicePolicy ? { servicePolicy } : {}) });
    }
  }
  const pairStagePlanned = actionFor(entries, id, "stage", "planned"), pairStage = actionFor(entries, id, "stage");
  if (pairStage) {
    const releaseTarget = pairStage.data?.release?.target, updaterTarget = pairStage.data?.updater?.target ?? null;
    if (!exactStagedChild(join(root, "releases"), releaseTarget)
      || updaterTarget !== null && !exactStagedChild(join(root, "updater"), updaterTarget))
      refuse("install_journal_refused");
    const targets = [updaterTarget, releaseTarget].filter(Boolean);
    for (const target of targets) await retireStagedTarget(root, target, `${target}.rolled-back-interrupted-${id}`);
  } else if (pairStagePlanned) {
    if (!commitPattern.test(planned.data?.commit ?? "")) refuse("install_journal_refused");
    const suffix = `-${planned.data.commit.slice(0, 12)}`;
    for (const parent of [join(root, "releases"), join(root, "updater")]) {
      for (const name of await readdir(parent).catch(error => error?.code === "ENOENT" ? [] : Promise.reject(error))) {
        if (!(name.endsWith(suffix) || name.startsWith(".staging-") && name.endsWith(suffix))) continue;
        const target = join(parent, name);
        if (!exactStagedChild(parent, target)) refuse("install_journal_refused");
        if (name.startsWith(".staging-")) await rm(target, { recursive: true, force: true });
        else await retireStagedTarget(root, target, `${target}.rolled-back-interrupted-${id}`);
      }
    }
  }
  const staged = actionFor(entries, id, "stage-release");
  const stagedTarget = recoveryStageTarget(root, staged);
  if (stagedTarget) await retireStagedTarget(root, stagedTarget, join(root, "releases", `.rolled-back-interrupted-${id}`));
  const staging = join(root, "releases", `.staging-${id}`);
  if (await lstat(staging).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error))) {
    await rename(staging, join(root, "releases", `.rolled-back-staging-${id}`));
  }
  if (actionFor(entries, id, "seed-updater", "planned")) {
    if (!commitPattern.test(planned.data?.commit ?? "")) refuse("install_journal_refused");
    const seed = join(root, "updater", `seed-${planned.data.commit.slice(0, 12)}`);
    for (const target of [seed, `${seed}.retired-${id}`]) {
      if (!exactStagedChild(join(root, "updater"), target)) refuse("install_journal_refused");
      await rm(target, { recursive: true, force: true });
    }
  }
  const toolRuntime = actionFor(entries, id, "vendor-tool-runtime");
  if (actionFor(entries, id, "vendor-tool-runtime", "planned")) await ports.rollbackRuntime(toolRuntime
    ? { root, receipt: toolRuntime.data } : { root, tools: ["node", "pnpm", "esbuild"], transactionId: id });
  if (actionFor(entries, id, "adopt-bootstrap", "planned")) await ports.removeAdoptedBootstrapV1(root);
  const sudoers = actionFor(entries, id, "sudoers");
  if (sudoers && (typeof sudoers.data?.sudoersCreated !== "boolean" || typeof sudoers.data?.shimCreated !== "boolean")) {
    refuse("install_journal_refused");
  }
  if (sudoers?.data?.sudoersCreated) await ports.removeRootFile(paths.sudoers);
  if (sudoers?.data?.shimCreated) await ports.removeRootFile(paths.shim);
  if (actionFor(entries, id, "install-services", "planned") && typeof ports.recoverServices !== "function") {
    await ports.uninstallServices({ root, bootoutFirst: true, removePlists: true,
      ...(servicePolicy ? { servicePolicy } : {}) });
  }
  const scheduler = actionFor(entries, id, "deny-builder-schedulers");
  const accounts = actionFor(entries, id, "create-accounts");
  const created = recoveryAccountNames(accounts, names), builder = accounts?.data?.accounts?.builder?.name;
  if (["fetch-source", "build-release", "build-updater-bundle"].some(action => actionFor(entries, id, action, "planned"))) {
    const historicalAccounts = accounts ?? [...entries].reverse().find(entry => entry.command === "install"
      && entry.action === "create-accounts" && entry.phase === "done");
    const recoveredAccounts = recoveryAccounts(historicalAccounts, names);
    await ports.killAccountProcesses({ uid: recoveredAccounts.builder.uid, checkLaunchDomain: true });
    if (!commitPattern.test(planned.data?.commit ?? "")) refuse("install_journal_refused");
    const prefix = `job-${planned.data.commit.slice(0, 12)}-`;
    const build = join(root, "build");
    for (const name of await readdir(build).catch(error => error?.code === "ENOENT" ? [] : Promise.reject(error))) {
      if (!name.startsWith(prefix) || !/^[A-Za-z0-9._-]{1,100}$/u.test(name)) continue;
      await rm(join(build, name), { recursive: true, force: true });
    }
  }
  if (scheduler && (typeof scheduler.data?.cronAdded !== "boolean" || typeof scheduler.data?.atAdded !== "boolean")) {
    refuse("install_journal_refused");
  }
  if (builder && scheduler?.data?.cronAdded) await ports.removeDenyEntry(paths.cronDeny, builder);
  if (builder && scheduler?.data?.atAdded) await ports.removeDenyEntry(paths.atDeny, builder);
  for (const name of [...created].reverse()) await ports.deleteAccount(name);
  await write("done", "transaction", { state: "recovered", installTransactionId: id });
}

async function assertSelfUpdateOff(root) {
  const path = join(root, "updater-state", "self-update");
  const stat = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    refuse("self_update_state_refused");
  }
  const value = await readFile(path, "utf8");
  if (value === "On\n") refuse("self_update_enabled");
  if (value !== "Off\n") refuse("self_update_state_refused");
}

function attendedIdentity(accounts) {
  return Object.freeze({ rootUid: 0, rootGid: 0, builderUid: accounts.builder.uid,
    builderGid: accounts.builder.gid, serviceGid: accounts.service.gid, builderAccount: accounts.builder.name });
}

async function runAttendedCoreV1({ root, commit, accounts, fresh, write, ports, options, undo }) {
  let fetched, release, bundle, classification, staged, releaseStage, updaterStage, switchResult, switched = false;
  const toolRoot = options.toolRoot ?? join(root, "updater", fresh ? `seed-${commit.slice(0, 12)}` : "current");
  const common = { root, commit, toolRoot, identities: attendedIdentity(accounts), spawnTrusted,
    ...(options.releaseTrust ? { releaseTrust: options.releaseTrust } : {}),
    ...(options.onSpawn ? { onSpawn: options.onSpawn } : {}),
    terminal: options.terminal, authorize: options.authorize };
  try {
    fetched = await journalStep(write, "fetch-source", () => ports.fetchVerifiedSourceV1(common));
    release = await journalStep(write, "build-release", () => ports.buildReleaseV1({ ...common, ...fetched }));
    bundle = await journalStep(write, "build-updater-bundle", () => ports.buildFixedBundleV1({ ...common, ...fetched }));
    classification = await ports.classifyAttendedSourceV1({ ...common, ...fetched, release, bundle });
    if (!classification || typeof classification.changesDatabase !== "boolean"
      || !Array.isArray(classification.changedPaths)) refuse("attended_classification_refused");
    if (!fresh && classification.changesDatabase) refuse("attended_database_change_requires_upgrader");
    const runningBundleDigest = options.runningBundleDigest === undefined
      ? await ports.runningBundleDigestV1({ root }) : options.runningBundleDigest;
    const updateUpdater = runningBundleDigest !== bundle.bundleDigest;
    const confirmation = await journalStep(write, "confirm", () => ports.confirmAttendedV1({ root, commit, release, bundle,
      runningBundleDigest, inventoryDigest: options.inventoryDigest,
      terminal: options.terminal, authorize: options.authorize }));
    staged = await journalStep(write, "stage", async () => {
      releaseStage = await ports.stageReleaseV1({ root, output: release.output, releaseId: release.releaseId,
        release, serviceGid: accounts.service.gid });
      if (releaseStage?.target !== join(root, "releases", release.releaseId)) refuse("attended_stage_result_refused");
      updaterStage = updateUpdater ? await ports.stageUpdaterBundleV1({ root, bundle, uver: bundle.uver,
        expectedDigest: bundle.bundleDigest, serviceGid: accounts.service.gid }) : null;
      if (updateUpdater && updaterStage?.target !== join(root, "updater", bundle.uver)) refuse("attended_stage_result_refused");
      return { release: releaseStage, updater: updaterStage };
    });
    undo.push(async () => {
      for (const target of [staged.updater?.target, staged.release.target].filter(Boolean))
        await retireStagedTarget(root, target, `${target}.rolled-back-${commit.slice(0, 12)}`).catch(() => {});
    });
    // Persist all four old pointers before the first link changes. The planned
    // record is also the recovery receipt if the switch never returns.
    switchResult = { oldCurrent: await pointer(root, "current"), oldPrevious: await pointer(root, "previous"),
      oldUpdaterCurrent: await pointer(root, "updater/current"), oldUpdaterPrevious: await pointer(root, "updater/previous") };
    await write("planned", "switch-pointers", switchResult);
    switched = true;
    await ports.switchPairV1({ root, release, bundle,
      releaseStage: staged.release, updaterStage: staged.updater, fresh, updateUpdater });
    await write("done", "switch-pointers", switchResult);
    undo.push(async () => {
      await ports.switchPairV1({ root, restore: switchResult });
      if (!fresh) await ports.restartServices({ root, roles: ["supervisor", "fleet-gateway", "updater"], rollback: true,
        ...(options.servicePolicy ? { servicePolicy: options.servicePolicy } : {}) });
    });
    return Object.freeze({ fetched, release, bundle, classification, confirmation, staged, switched: switchResult,
      current: `releases/${release.releaseId}`, previous: switchResult.oldCurrent });
  } catch (error) {
    if (switched && switchResult) {
      await ports.switchPairV1({ root, restore: switchResult }).catch(() => {}); switched = false;
    }
    if (!switched) for (const [target, expected] of [[updaterStage?.target, bundle && join(root, "updater", bundle.uver)],
      [releaseStage?.target, release && join(root, "releases", release.releaseId)]]) {
      if (target === expected) await retireStagedTarget(root, target, `${target}.rolled-back-${commit.slice(0, 12)}`).catch(() => {});
    }
    if (fetched && typeof ports.abortAttendedV1 === "function") await ports.abortAttendedV1(fetched).catch(() => {});
    throw error;
  }
}

/**
 * The install's commit point (atk-fa F15). Once the "installed" record is durable
 * nothing may roll the install back, so the undo list is cleared at once; an error
 * AFTER the record's bytes are durable (its chown, the directory sync, a journal
 * hook) is not a failed install when the journal, read back, says installed.
 */
async function recordInstalled(root, id, write, undo) {
  try { await write("done", "transaction", { state: "installed" }); }
  catch (error) {
    const entries = await readJournal(root).catch(() => []);
    if (actionFor(entries, id, "transaction")?.data?.state !== "installed") throw error;
  }
  undo.length = 0;
}

async function runInitialPasskeyTransactionV1({ root, options, ports, stageOne, stageOnePorts, rehearsal }) {
  const id = transactionId(ports), write = writer(root, id, "passkey", ports);
  await write("planned", "transaction", { mode: "initial" });
  let outcome;
  try {
    // Stage one's port, from the confirmed fixed bundle: the archive copy this
    // installer runs from has no `node_modules` and cannot load `pg` (atk-fa F2).
    if (typeof stageOnePorts?.registerInitialPasskey !== "function") refuse("passkey_port_unavailable");
    const result = await stageOnePorts.registerInitialPasskey({ root, config: stageOne.passkeyConfig,
      ownerCode: stageOne.ownerCode, terminal: options.terminal,
      qr: Object.freeze({ ...(options.qr ?? {}), ownerCodePolicy: "every-unconsumed-attempt" }), maxAttempts: 5,
      // The practice authenticator travels only with a VALIDATED rehearsal config:
      // `installControlRoomV1` already refuses the flag without one, and this is
      // the same rule at the one place the flag is handed on.
      ...(rehearsal && options.authenticator === "software" ? { authenticator: "software" } : {}) });
    if (result?.status === "registered" && digestPattern.test(result.credentialIdDigest ?? "")
      && Number.isSafeInteger(result.attempts) && result.attempts >= 1 && result.attempts <= 5) {
      outcome = Object.freeze({ status: "registered", credentialIdDigest: result.credentialIdDigest,
        attempts: result.attempts });
    } else if (result?.status === "stopped" && typeof result.reason === "string"
      && /^[a-z][a-z0-9_-]{0,79}$/u.test(result.reason)) {
      outcome = Object.freeze({ status: "stopped", reason: result.reason });
    } else refuse("passkey_registration_result_refused");
  } catch (error) {
    const reason = typeof error?.code === "string" && /^[a-z][a-z0-9_-]{0,79}$/u.test(error.code)
      ? error.code : "passkey_registration_failed";
    outcome = Object.freeze({ status: "stopped", reason });
  }
  await ports.recordPasskeyStatus({ root, ...outcome });
  await write("done", "register-passkey", outcome);
  try {
    const cleanup = await ports.cleanupBootstrap({ root, bootstrapRoot: options.bootstrap });
    await write("done", "cleanup-bootstrap", cleanup ?? {});
  } catch (error) {
    const reason = typeof error?.code === "string" ? error.code : "bootstrap_cleanup_failed";
    await ports.recordPasskeyStatus({ root, status: "stopped", reason });
    outcome = Object.freeze({ status: "stopped", reason });
  }
  await write("done", "transaction", { state: outcome.status });
  return outcome;
}

export async function installControlRoomV1(options) {
  const ports = requirePorts(options.ports, ["inspectOwnership", "geteuid", "lchownPath", "readAccountInventory",
    "createAccount", "deleteAccount", "ensureDenyEntry", "removeDenyEntry", "installRootFile", "removeRootFile",
    "validateSudoers", "sudoSecurePathIsActive", "assertT1Path", "vendorRuntime", "fetchVerifiedSourceV1", "buildReleaseV1",
    "buildFixedBundleV1", "runningBundleDigestV1", "confirmAttendedV1", "stageReleaseV1", "stageUpdaterBundleV1",
    "classifyAttendedSourceV1",
    "switchPairV1", "verifyBootstrapSourceV1", "adoptBootstrapV1", "removeAdoptedBootstrapV1", "seedUpdaterV1",
    "loadInstallStepsV1", "generateVapidKeys",
    "generateWorkIntakeKeys", "readGithubCredential", "installServices", "uninstallServices", "restartServices", "checkHealth", "captureTailscaleServe",
    "activateTailscaleServe", "inspectTailscaleServe", "readLiveServePort", "restoreTailscaleServe", "moveLiveDatabase",
    "recordPasskeyStatus", "cleanupBootstrap", "invalidateSudoTimestamp", "processIdentity"]);
  if (ports.geteuid() !== 0) refuse("root_required");
  let rehearsal;
  if (options.rehearsalConfig !== undefined) rehearsal = await loadRehearsalConfigV1(options.rehearsalConfig);
  if (rehearsal && ["assertRuntimeTreeRootMetadata", "assertSeatbeltApplied", "assertRehearsalOwnerDenied"]
    .some(name => typeof ports[name] !== "function")) refuse("installer_ports_refused");
  if (!rehearsal && (options.authenticator !== undefined || options.e2e2EvidenceLog !== undefined)) {
    refuse("rehearsal_only_argument_refused");
  }
  const root = options.root ?? rehearsal?.root ?? DEFAULT_CONTROL_ROOM_ROOT_V1;
  const webPort = options.webPort ?? rehearsal?.webPort ?? DEFAULT_CONTROL_ROOM_WEB_PORT_V1;
  if (rehearsal) rehearsal = assertRehearsalInvocationV1(rehearsal, { ...options, root, webPort });
  const rehearsalEvidence = rehearsal
    ? await validateOwnerEvidenceDestination(options.e2e2EvidenceLog, options.invokingUser) : undefined;
  const gatewayPort = rehearsal?.gatewayPort ?? options.gatewayPort ?? DEFAULT_CONTROL_ROOM_GATEWAY_PORT_V1;
  const effectiveOptions = rehearsal ? { ...options, accountsPolicy: rehearsal.accountsPolicy,
    servicePolicy: rehearsal.servicePolicy, tailnetIdentity: rehearsal.tailnetIdentity, tailscale: rehearsal.tailscale,
    rehearsalMode: true, freshDatabase: true } : options;
  let releaseLock;
  const undo = [];
  try {
    await ports.invalidateSudoTimestamp(options.invokingUser);
    await assertInstallerRootSafetyV1({ root, ports });
    if (options.commit === undefined) {
      const exists = await lstat(root).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error));
      const entries = exists ? await readJournal(root) : [];
      if (entries.some(entry => entry.command === "install" && entry.action === "transaction"
        && entry.phase === "done" && entry.data?.state === "installed")) refuse("installed_transaction_exists");
      refuse("commit_refused");
    }
    if (!commitPattern.test(options.commit)) refuse("commit_refused");
    const existing = await lstat(root).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error));
    const existingEntries = existing ? await readJournal(root) : [];
    const hasInstalled = existingEntries.some(entry => entry.command === "install" && entry.action === "transaction"
      && entry.phase === "done" && entry.data?.state === "installed");
    if (hasInstalled && options.bootstrap !== undefined) {
      const error = new Error("this Mac is already installed; run passkey add");
      error.code = "installed_bootstrap_refused";
      error.userMessage = "this Mac is already installed; run passkey add";
      throw error;
    }
    if (!hasInstalled && options.bootstrap === undefined) {
      const error = new Error("run the install-night line again");
      error.code = "install_night_required"; error.userMessage = "run the install-night line again"; throw error;
    }
    if (options.bootstrap !== undefined) absolute(options.bootstrap, "bootstrap_root_refused");
    const paths = systemPaths(effectiveOptions), names = await loadAccountsPolicy(effectiveOptions);
    releaseLock = await acquireLock(root, ports);
    await ensureDirectory(join(root, "updater-state"), 0o700, { uid: 0, gid: 0 }, ports);
    await repairJournalTail(root);
    await assertSelfUpdateOff(root);
    let metadata, bootstrapDigest;
    if (!hasInstalled) {
      try {
        const bytes = await readRegularFileNoFollowV1(join(options.bootstrap, "bootstrap.json"), { uid: 0, gid: 0 });
        metadata = JSON.parse(bytes.toString("utf8")); bootstrapDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      } catch { refuse("bootstrap_metadata_refused"); }
      if (metadata?.schema !== "control-room.bootstrap/v1" || metadata.commit !== options.commit
          || typeof metadata.node !== "object" || Array.isArray(metadata.node)
          || typeof metadata.git !== "string" || !isAbsolute(metadata.git) || resolve(metadata.git) !== metadata.git
          || typeof metadata.remoteUrl !== "string") refuse("bootstrap_metadata_refused");
      await ports.verifyBootstrapSourceV1({ bootstrapRoot: options.bootstrap, commit: options.commit,
        gitPath: metadata.git });
    }
    await recoverInterruptedInstall(root, paths, names, ports, options.invokingUser, rehearsal, rehearsalEvidence);
    const priorEntries = await readJournal(root);
    const completedInstalls = [...priorEntries].reverse().filter(entry => entry.command === "install"
      && entry.action === "transaction" && entry.phase === "done" && entry.data?.state === "installed");
    const installed = completedInstalls[0];
    // A re-run for the commit `current` already runs is refused before any journal
    // record or effect (atk-fa F5): it can only fail at the stage, and a failure
    // there armed recovery to rename the live release and updater folders.
    if (installed && (await pointer(root, "current"))?.endsWith(`-${options.commit.slice(0, 12)}`)) {
      const error = new Error("this commit is already installed");
      error.code = "commit_already_installed"; error.userMessage = "this commit is already installed"; throw error;
    }
    const id = transactionId(ports), write = writer(root, id, "install", ports);
    await write("planned", "transaction", { commit: options.commit, ...(bootstrapDigest ? { bootstrapDigest } : {}),
      ...(rehearsal ? { rehearsalConfigDigest: rehearsal.digest, authenticator: options.authenticator,
        e2e2EvidenceLog: rehearsalEvidence.path } : {}) });
    const writeEvidence = rehearsal ? (kind, data) => appendE2e2Evidence(root, {
      schema: CONTROL_ROOM_E2E2_EVIDENCE_SCHEMA_V1, transactionId: id, root, commit: options.commit, kind, ...data,
    }, ports) : undefined;
    let spawnEvidenceCount = 0;
    const onSpawn = rehearsal ? async ({ file }) => {
      if (typeof file !== "string" || !isAbsolute(file)) refuse("rehearsal_evidence_refused");
      await ports.assertT1Path(file, { executable: true });
      spawnEvidenceCount += 1;
      await writeEvidence("spawn-t1", { spawnId: `spawn-${spawnEvidenceCount}`, passed: true });
    } : undefined;
    const inventoryBytes = options.runtimeInventory === undefined
      ? await readFile(new URL("../policy/runtime-inventory.json", import.meta.url))
      : Buffer.from(JSON.stringify(options.runtimeInventory));
    const runtimeInventory = options.runtimeInventory ?? JSON.parse(inventoryBytes.toString("utf8"));
    const inventoryDigest = `sha256:${createHash("sha256").update(inventoryBytes).digest("hex")}`;

    if (installed) {
      const freshInstall = completedInstalls.find(entry => actionFor(priorEntries, entry.transactionId, "create-accounts"));
      const accountState = recoveryAccounts(actionFor(priorEntries, freshInstall?.transactionId, "create-accounts"), names);
      const initialized = actionFor(priorEntries, freshInstall?.transactionId, "init-database")?.data;
      const schema = actionFor(priorEntries, freshInstall?.transactionId, "apply-release-schema")?.data;
      const attended = await runAttendedCoreV1({ root, commit: options.commit, accounts: accountState,
        fresh: false, write, ports, options: { ...effectiveOptions, inventoryDigest, onSpawn }, undo });
      await recomposeGatewayFile(root, id, write, ports, undo);
      await journalStep(write, "restart-services", () => ports.restartServices({ root,
        roles: ["supervisor", "fleet-gateway", "updater"],
        ...(rehearsal ? { servicePolicy: rehearsal.servicePolicy } : {}) }));
      const health = await journalStep(write, "health-check", () => ports.checkHealth({ root, expectedRelease: attended.current,
        pgDataId: initialized?.pgDataId, schemaDigest: schema?.schemaDigest,
        updaterSchemaDigest: initialized?.updaterSchemaDigest, webPort, gatewayPort, samples: 3 }));
      if (rehearsal) {
        if (health?.healthy !== true || health.samples !== 3 || !digestPattern.test(health.schemaDigest ?? "")) {
          refuse("rehearsal_evidence_refused");
        }
        await writeEvidence("health", { healthy: true, samples: health.samples, schemaDigest: health.schemaDigest });
        await writeEvidence("spawn-count", { expected: spawnEvidenceCount });
      }
      await recordInstalled(root, id, write, undo);
      if (rehearsal) {
        for (const step of ["capture", "activate", "restore"]) await writeEvidence("tailscale-step",
          { step, outcome: "skipped (rehearsal)" });
        await publishRehearsalEvidence(root, options.commit, id, rehearsalEvidence, ports);
      }
      return Object.freeze({ state: "installed", version: attended.release.releaseId,
        current: attended.current, previous: attended.previous, passkey: await savedPasskeyOutcome(root) });
    }

    await journalStep(write, "verify-bootstrap-source", () => ports.verifyBootstrapSourceV1({
      bootstrapRoot: options.bootstrap, commit: options.commit, gitPath: metadata.git,
    }));

    const livePort = rehearsal ? undefined : await ports.readLiveServePort({ identity: options.invokingUser });
    if (!Number.isSafeInteger(webPort) || webPort < 1024 || webPort > 65535
      || !Number.isSafeInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535 || gatewayPort === webPort
      || webPort === livePort && !options.replacingLive) refuse("service_port_refused");

    const accountState = await journalStep(write, "create-accounts", async () => {
      const value = await createAccounts(names, ports);
      undo.push(async () => { for (const name of [...value.created].reverse()) await ports.deleteAccount(name); });
      return value;
    });
    const builderName = accountState.accounts.builder.name;
    const { cronAdded, atAdded } = await journalStep(write, "deny-builder-schedulers", async () => {
      const value = { cronAdded: await ports.ensureDenyEntry(paths.cronDeny, builderName),
        atAdded: await ports.ensureDenyEntry(paths.atDeny, builderName) };
      undo.push(async () => { if (value.atAdded) await ports.removeDenyEntry(paths.atDeny, builderName);
        if (value.cronAdded) await ports.removeDenyEntry(paths.cronDeny, builderName); });
      return value;
    });

    await journalStep(write, "create-layout", () => createLayoutV1(root, accountState.accounts, ports, options.reserve));
    await replaceRootOwnedFile(join(root, "updater-state", "self-update"), "Off\n", 0o600);
    await ports.lchownPath(join(root, "updater-state", "self-update"), 0, 0);
    await write("done", "self-update-off");
    const adopted = await journalStep(write, "adopt-bootstrap", async () => {
      const value = await ports.adoptBootstrapV1({ root, bootstrapRoot: options.bootstrap, transactionId: id,
        remoteUrl: metadata.remoteUrl });
      undo.push(async () => ports.removeAdoptedBootstrapV1(root, value)); return value;
    });
    const toolRuntime = await journalStep(write, "vendor-tool-runtime", async () => {
      const value = await ports.vendorRuntime({ root, inventory: runtimeInventory, tools: ["node", "pnpm", "esbuild"],
        fresh: true, snapshots: { node: join(options.bootstrap, "node.tar.gz") },
        download: { uid: accountState.accounts.builder.uid, gid: accountState.accounts.builder.gid }, transactionId: id });
      undo.push(() => ports.rollbackRuntime({ root, receipt: value })); return value;
    });
    if (rehearsal) {
      for (const tree of ["node", "pnpm", "esbuild"]) {
        if (!toolRuntime?.installed || typeof toolRuntime.installed !== "object") refuse("rehearsal_evidence_refused");
        const metadataResult = await ports.assertRuntimeTreeRootMetadata({ root, tree });
        if (!metadataResult || !Number.isSafeInteger(metadataResult.entries) || metadataResult.entries < 1) {
          refuse("rehearsal_evidence_refused");
        }
        await writeEvidence("runtime-root-metadata", { tree, passed: true, entries: metadataResult.entries });
      }
    }
    let releaseTrust;
    await journalStep(write, "generate-keys", async () => {
      releaseTrust = await generateKeys(root, accountState.accounts, ports, { credentialAlreadyAdopted: true });
      return {};
    });
    await journalStep(write, "sudoers", async () => {
      return installShimAndSudoers(paths, ports, undo);
    });

    const seed = await journalStep(write, "seed-updater", async () => {
      const value = await ports.seedUpdaterV1({ root, bootstrapRoot: options.bootstrap, commit: options.commit,
        transactionId: id });
      undo.push(async () => rm(value.dir, { recursive: true, force: true })); return value;
    });

    const attended = await runAttendedCoreV1({ root, commit: options.commit, accounts: accountState.accounts,
      fresh: true, write, ports, options: { ...effectiveOptions, releaseTrust, inventoryDigest, toolRoot: seed.dir, onSpawn }, undo });
    const loaded = await journalStep(write, "load-install-steps", () => ports.loadInstallStepsV1({
      updaterTarget: attended.staged.updater.target, expectedDigest: attended.bundle.bundleDigest }));
    await rename(seed.dir, `${seed.dir}.retired-${id}`);
    const stageOnePorts = loaded.createStageOnePortsV1(ports);
    const stageOne = await loaded.continueInstallV1(Object.freeze({ root, transactionId: id,
      accounts: accountState.accounts, invokingUser: options.invokingUser, write, undo, ports: stageOnePorts,
      options: Object.freeze({ ...effectiveOptions, releaseTrust, webPort, gatewayPort, spawnTrusted, writeEvidence }), attended,
      runtimeInventory: Object.freeze(runtimeInventory) }));
    if (rehearsal) await writeEvidence("spawn-count", { expected: spawnEvidenceCount });
    await recordInstalled(root, id, write, undo);
    const passkey = await runInitialPasskeyTransactionV1({ root, options, ports, stageOne, stageOnePorts, rehearsal });
    if (rehearsal) {
      await writeEvidence("passkey", passkey);
      await publishRehearsalEvidence(root, options.commit, id, rehearsalEvidence, ports);
    }
    return Object.freeze({ state: "installed", version: attended.release.releaseId,
      current: attended.current, previous: attended.previous, passkey });
  } catch (error) {
    const rollbackErrors = [];
    for (const rollback of undo.reverse()) await rollback().catch(rollbackError => rollbackErrors.push(rollbackError));
    if (rollbackErrors.length > 0) {
      const rollbackError = new Error("install_rollback_incomplete", { cause: error });
      rollbackError.failures = rollbackErrors.length;
      throw rollbackError;
    }
    error.installRollbackComplete = true;
    throw error;
  } finally {
    try { if (releaseLock) await releaseLock(); }
    finally { await ports.invalidateSudoTimestamp(options.invokingUser); }
  }
}

/**
 * A journal whose last line has no newline ends in an append that never completed
 * (power cut, disk full): its writer never got past `appendJournal`, so the step it
 * names never ran past its journalled boundary. Reading ignores that tail and this
 * cuts it off under the lock before the next append, instead of every retry
 * refusing (atk-fa F11). A malformed final line is also uncommitted; every
 * earlier line must validate before repair.
 */
async function repairJournalTail(root) {
  await readJournal(root); // Prove the prefix before changing the file.
  const path = join(root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1);
  const handle = await open(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW)
    .catch(error => error?.code === "ENOENT" ? null : refuse("install_journal_refused"));
  if (!handle) return;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024 * 1024) {
      refuse("install_journal_refused");
    }
    const bytes = await handle.readFile();
    const prefix = readJsonlPrefixV1(bytes.toString("utf8"), { refuse: () => refuse("install_journal_refused") });
    if (!prefix.repaired) return;
    await handle.truncate(prefix.bytes); await handle.sync();
  } finally { await handle.close(); }
}

async function readJournal(root) {
  const path = join(root, "updater-state", CONTROL_ROOM_INSTALLER_JOURNAL_FILE_V1);
  let text;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024 * 1024) {
      refuse("install_journal_refused");
    }
    text = await readFile(path, "utf8");
  } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const { values } = readJsonlPrefixV1(text, { refuse: reason => {
    const error = new Error(`install_journal_refused: ${reason}`); error.code = "install_journal_refused"; throw error;
  } });
  const sequences = new Map(), commands = new Map();
  if (values.length > 100_000) refuse("install_journal_refused");
  return values.map(value => {
    if (value?.schema !== CONTROL_ROOM_INSTALL_JOURNAL_SCHEMA_V2
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value.transactionId ?? "")
      || !["install", "passkey", "recovery"].includes(value.command) || !Number.isSafeInteger(value.sequence) || value.sequence < 1
      || !["planned", "done"].includes(value.phase) || typeof value.action !== "string"
      || !/^[a-z][a-z0-9-]{0,79}$/u.test(value.action) || typeof value.at !== "string"
      || (() => { try { return new Date(value.at).toISOString() !== value.at; } catch { return true; } })()
      || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) refuse("install_journal_refused");
    const previous = sequences.get(value.transactionId) ?? 0;
    if (value.sequence !== previous + 1 || commands.has(value.transactionId) && commands.get(value.transactionId) !== value.command) {
      refuse("install_journal_refused");
    }
    sequences.set(value.transactionId, value.sequence); commands.set(value.transactionId, value.command);
    return value;
  });
}

export async function statusControlRoomV1(options) {
  const root = options.root ?? DEFAULT_CONTROL_ROOM_ROOT_V1;
  try { await lstat(root); } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ state: "not-installed", current: null, previous: null });
    throw error;
  }
  await existingDirectory(root, "install_root_refused");
  return Object.freeze({ state: await pointer(root, "current") ? "installed" : "not-installed",
    current: await pointer(root, "current"), previous: await pointer(root, "previous") });
}

export async function uninstallFreshControlRoomV1(options) {
  const ports = requirePorts(options.ports, ["inspectOwnership", "geteuid", "removeRootFile", "deleteAccount", "removeDenyEntry",
    "uninstallServices", "recoverServices", "rollbackOwnerCode", "killAccountProcesses", "restoreTailscaleServe",
    "invalidateSudoTimestamp", "processIdentity"]);
  if (ports.geteuid() !== 0) refuse("root_required");
  let rehearsal;
  if (options.rehearsalConfig !== undefined) rehearsal = await loadRehearsalConfigV1(options.rehearsalConfig);
  const root = options.root ?? rehearsal?.root ?? DEFAULT_CONTROL_ROOM_ROOT_V1;
  let releaseLock;
  let retained;
  try {
    await ports.invalidateSudoTimestamp(options.invokingUser);
    await assertInstallerRootSafetyV1({ root, ports });
    await existingDirectory(root, "install_root_refused");
    releaseLock = await acquireLock(root, ports);
    const entries = await readJournal(root);
    const completedInstalls = [...entries].reverse().filter(entry => entry.command === "install"
      && entry.action === "transaction" && entry.phase === "done" && entry.data?.state === "installed");
    const completed = completedInstalls[0];
    if (!completed) refuse("nothing_to_uninstall");
    const freshInstall = completedInstalls.find(entry => actionFor(entries, entry.transactionId, "create-accounts"));
    if (!freshInstall) refuse("install_journal_refused");
    const recordedRehearsalDigest = actionFor(entries, freshInstall.transactionId, "transaction", "planned")?.data?.rehearsalConfigDigest;
    if (recordedRehearsalDigest !== undefined && recordedRehearsalDigest !== rehearsal?.digest
      || recordedRehearsalDigest === undefined && rehearsal !== undefined || rehearsal && rehearsal.root !== root) {
      refuse("rehearsal_identity_mismatch");
    }
    const effectiveOptions = rehearsal ? { ...options, accountsPolicy: rehearsal.accountsPolicy } : options;
    const names = await loadAccountsPolicy(effectiveOptions), paths = systemPaths(effectiveOptions), id = freshInstall.transactionId;
    const accountRecord = actionFor(entries, id, "create-accounts");
    const accounts = recoveryAccounts(accountRecord, names);
    const schedulerRecord = actionFor(entries, id, "deny-builder-schedulers");
    const created = recoveryAccountNames(accountRecord, names);
    if (schedulerRecord && (typeof schedulerRecord.data?.cronAdded !== "boolean"
      || typeof schedulerRecord.data?.atAdded !== "boolean")) refuse("install_journal_refused");
    for (const [action, roles] of [["install-post-health-services", ["nightly-backup", "updater", "updater-guard"]],
      ["install-services", ["supervisor", "fleet-gateway"]], ["install-database-service", ["postgresql17"]]]) {
      // The core receipt holds the digests of the protected files as installed, and
      // the install then re-minted the owner code, rewriting two of them: put the
      // owner code back first, as recovery does, or the core batch refuses on the
      // digest after it has already booted the services out (atk-fa F6).
      const ownerSession = actionFor(entries, id, "mint-owner-session")?.data?.receipt;
      if (action === "install-services" && ownerSession) {
        await ports.rollbackOwnerCode({ root, receipt: ownerSession,
          ...(rehearsal ? { servicePolicy: rehearsal.servicePolicy } : {}) });
      }
      const record = actionFor(entries, id, action);
      await ports.recoverServices({ root, roles, ...(rehearsal ? { servicePolicy: rehearsal.servicePolicy } : {}),
        ...(record?.data?.receipt ? { receipt: record.data.receipt } : {}) });
    }
    await ports.killAccountProcesses({ uid: accounts.database.uid });
    const capture = actionFor(entries, id, "capture-tailscale");
    if (!rehearsal && capture) await ports.restoreTailscaleServe({ snapshot: capture.data,
      temporaryDirectory: join(root, "updater-state", "tmp"), identity: options.invokingUser });
    await ports.removeRootFile(paths.sudoers); await ports.removeRootFile(paths.shim);
    if (schedulerRecord?.data?.cronAdded) await ports.removeDenyEntry(paths.cronDeny, names.builder);
    if (schedulerRecord?.data?.atAdded) await ports.removeDenyEntry(paths.atDeny, names.builder);
    for (const name of [...created].reverse()) await ports.deleteAccount(name);
    retained = `${root}.uninstalled-${timestamp(ports).replace(/[-:.]/gu, "")}`;
    await rename(root, retained);
    return Object.freeze({ state: "uninstalled", retained });
  } finally {
    try { if (releaseLock) await releaseLock(retained ? join(retained, ".install.lock") : undefined); }
    finally { await ports.invalidateSudoTimestamp(options.invokingUser); }
  }
}
