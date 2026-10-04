import { execFile, spawn } from "node:child_process";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lchown, lstat, open, readFile, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertT1Path as assertTrustedPath, buildTrustedEnvironment } from "../trusted-runtime.mjs";
import { readRoleManifestV1 } from "../pg/database-phase-data.mjs";
import {
  DATABASE_INIT_REQUEST_V1, DATABASE_INIT_RESULT_V1, RELEASE_SCHEMA_REQUEST_V1, RELEASE_SCHEMA_RESULT_V1,
  parseDatabasePhaseAccountsV1, parseDatabasePhaseLoginsV1, parseDatabasePhasePasswordsV1,
  parseDatabasePhaseRequestV1, parseDatabasePhaseResultV1,
} from "../pg/database-phase-contract.mjs";
import {
  abortAttendedV1, buildFixedBundleV1, buildReleaseV1, classifyAttendedSourceV1, confirmAttendedV1, fetchVerifiedSourceV1,
  runningBundleDigestV1, stageReleaseV1, stageUpdaterBundleV1, switchPairV1,
} from "../attended/index.mjs";
import {
  adoptBootstrapV1, loadInstallStepsV1, removeAdoptedBootstrapV1, seedUpdaterV1, verifyBootstrapSourceV1,
} from "../install/bootstrap.mjs";
import {
  installServicesV1, recoverServicesV1, restartServicesV1, startPostHealthServicesV1, uninstallServicesV1,
} from "../services/installer.mjs";
// THE FOUR COLLIDING NAMES ARE ALIASED, and this is the merge's decision.
//
// Four stage-one exports have the SAME NAME as the implementations already in this
// file: `initializeDatabaseV1`, `retireDatabaseV1`, `firstOwnerV1`,
// `writeDatabaseV1`/`removeDatabaseLoginsV1`. Before the installer stream landed, this
// file WAS the home of those four, because M1 wrote them first and the installer's
// stage-one port was a typed refusal stub that delegated to them.
//
// After the merge the STUB MOVED DOWNSTREAM: `createStageOnePortsV1` (below) is what
// builds the port object, and it prefers THIS file's real implementations. So the
// installer stream's copies are imported here under `stageOne*` names -- kept
// reachable, kept tested (the installer's own tests call them directly), and NOT
// wired into the default port, because wiring them in would replace four working
// PostgreSQL implementations with four `database_port_not_yet_supplied` refusals.
//
// The aliases exist so `createStageOnePortsV1` can compose the two halves honestly:
// installer's non-DB ports stay the installer's, this file's DB ports stay this
// file's, and neither side's name is silently lost in the merge.
import {
  checkHealthV1, cleanupBootstrapV1, composeProtectedConfigPortV1,
  initializeDatabaseV1 as stageOneInitializeDatabaseV1,
  firstOwnerV1 as stageOneFirstOwnerV1,
  installGuardV1, killAccountProcessesV1, recordPasskeyStatusV1, recordTailscaleServeV1,
  registerInitialPasskeyV1, removeDatabaseLoginsV1 as stageOneRemoveDatabaseLoginsV1,
  removeGuardV1, removeKnownGoodV1, remintOwnerCodeV1,
  retireDatabaseV1 as stageOneRetireDatabaseV1, rollbackOwnerCodeV1, seedKnownGoodV1,
  writeDatabaseLoginsV1 as stageOneWriteDatabaseLoginsV1,
} from "../install/stage-one-ports.mjs";
// M4's implementations of the four ports the installer's typed refusals stood in
// for. These are the PRODUCTION defaults: the refusals above stay reachable under
// their `stageOne*` names, so the installer's contract tests still exercise them
// and the contract is still documented, but nothing on the install path calls a
// `database_port_not_yet_supplied` any more.
import { removeDatabaseLoginsV1, retireDatabaseV1,
  writeDatabaseLoginsV1 } from "../pg/first-owner-ports.mjs";
// rv-9b B1: the database half of `checkHealth`, M4's check over the real session
// transport. Loaded on first use, because it reaches the TypeScript cluster-layout
// planner, which the bundle transpiles and an unbundled import of this file must
// not need.
const checkDatabaseHealthV1 = async input =>
  (await import("../pg/database-health-production.mjs")).checkDatabaseHealthProductionV1(input);
// N1: the production first-owner port runs the release's `firstOwner.js` as a child.
// Lazy for the same reason: it reaches the health module's session context.
const firstOwnerViaScriptV1 = async input =>
  (await import("../pg/first-owner-script.mjs")).firstOwnerViaScriptV1(input);
// Round 7 (C6): the rehearsal evidence ports -- the runtime-tree root metadata
// assertion, the owner-denial matrix and the Seatbelt check. Rehearsal only; they
// are never called on the real install path.
import { assertRuntimeTreeRootMetadataV1 } from "../install/runtime.mjs";
import { servicePolicyForRolesV1 } from "../services/bundle.mjs";
// M3: the PostgreSQL half of the install-night passkey ceremony. The port takes
// its session as `runtime.session` and its authority as `runtime.authority`; the
// installer calls it with ONE argument, so the PRODUCTION default is
// `registerInitialPasskeyProductionV1` below, which builds both. See
// `pg/initial-passkey-ports.mjs` for why it is a session and not an import.
import { recordPasskeyStatusV1 as passkeyStatusV1 } from "../pg/initial-passkey-ports.mjs";
import { registerInitialPasskeyProductionV1 } from "../pg/initial-passkey-production.mjs";

const runFile = promisify(execFile);
const TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const SECURE_PATH_LINE = "Value to override user's $PATH with: /usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const MAX_TAILSCALE_JSON_BYTES = 1024 * 1024;
const SAFE_ENVIRONMENT = buildTrustedEnvironment();
const command = (file, args, options = {}) => runFile(file, args, {
  env: SAFE_ENVIRONMENT, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options,
});
const runtimeVendorModule = `../install/${"runtime.mjs"}`;
const vendorToolRuntime = async input => (await import(runtimeVendorModule)).vendorRuntimeV1(input);
const rollbackToolRuntime = async input => {
  const receipt = input?.receipt?.undo ?? input?.receipt;
  const runtime = await import(runtimeVendorModule);
  if (receipt !== undefined) return runtime.undoVendoredRuntimeV1({ root: input?.root, receipt });
  return runtime.recoverPlannedRuntimeV1({ root: input?.root, tools: input?.tools, transactionId: input?.transactionId });
};

/**
 * Run a program with one bounded line on its stdin.
 *
 * This is a separate helper rather than an option on `command` because
 * `execFile` has no stdin option: it closes the child's stdin immediately. The
 * database phase needs the opposite — the script reads its request's passwords
 * from stdin and nothing else — and the only other ways to hand a child input are
 * a file or a pipe this process owns. A file would put a password on disk, which
 * is the exposure the whole design is removing, so the pipe is built here.
 *
 * The payload is ONE line and it is bounded, because the child reads exactly one
 * line: a multi-line payload would leave the child's own reader waiting on a
 * stream that has already ended.
 */
function runWithStdin(file, args, payload, options = {}) {
  return new Promise((resolve, reject) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      reject(new Error("database_phase_stdin_refused")); return;
    }
    let line;
    try { line = `${JSON.stringify(payload)}\n`; } catch (error) { reject(error); return; }
    if (Buffer.byteLength(line) > 64 * 1024) { reject(new Error("database_phase_stdin_refused")); return; }
    const child = spawn(file, args, { env: SAFE_ENVIRONMENT, shell: false, stdio: ["pipe", "pipe", "pipe"],
      ...options });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve({ stdout, stderr })
      // A nonzero exit is a hard failure, and the child's own message is not
      // trusted as the reason: the caller learns the refusal code from the
      // exception, and the stderr is available for an operator reading a log.
      : reject(new Error(`database_phase_script_failed:${code}:${stderr.trim().split("\n").pop()?.slice(0, 200) ?? ""}`)));
    child.stdin.on("error", error => reject(Object.assign(error, { code: "database_phase_stdin_refused" })));
    child.stdin.end(line);
  });
}

// Every real Mac lists `nobody -2` and `nogroup -1`: negative IDs are valid rows, not a malformed inventory.
export function parseDirectoryRowsV1(output, valueName) {
  return output.split(/\r?\n/u).filter(Boolean).map(line => {
    const match = /^(\S+)\s+(-?\d{1,10})$/u.exec(line.trim());
    if (!match) throw new Error("account_inventory_refused");
    return { name: match[1], [valueName]: Number(match[2]) };
  });
}

async function dsclRead(path, key) {
  try { return (await command("/usr/bin/dscl", [".", "-read", path, key])).stdout.trim().split(/\s+/u).slice(1).join(" "); }
  catch { return null; }
}

async function readAccountInventory() {
  const [usersOutput, groupsOutput] = await Promise.all([
    command("/usr/bin/dscl", [".", "-list", "/Users", "UniqueID"]),
    command("/usr/bin/dscl", [".", "-list", "/Groups", "PrimaryGroupID"]),
  ]);
  const rawUsers = parseDirectoryRowsV1(usersOutput.stdout, "uid"), groups = parseDirectoryRowsV1(groupsOutput.stdout, "gid");
  const users = [];
  for (const row of rawUsers) {
    const path = `/Users/${row.name}`;
    const [gid, home, shell, hidden, password, memberships] = await Promise.all([
      dsclRead(path, "PrimaryGroupID"), dsclRead(path, "NFSHomeDirectory"), dsclRead(path, "UserShell"), dsclRead(path, "IsHidden"),
      dsclRead(path, "Password"), command("/usr/bin/id", ["-Gn", row.name]).then(result => result.stdout.trim().split(/\s+/u), () => []),
    ]);
    users.push({ ...row, gid: Number(gid), home, shell, hidden: hidden === "1", password, memberships });
  }
  return { users, groups };
}

async function createAccount(input) {
  await command("/usr/bin/dscl", [".", "-create", `/Groups/${input.name}`]);
  try {
    await command("/usr/bin/dscl", [".", "-create", `/Groups/${input.name}`, "PrimaryGroupID", String(input.gid)]);
    await command("/usr/bin/dscl", [".", "-create", `/Users/${input.name}`]);
    for (const [key, value] of [["UniqueID", input.uid], ["PrimaryGroupID", input.gid], ["NFSHomeDirectory", input.home],
      ["UserShell", input.shell], ["IsHidden", 1], ["Password", input.password]]) {
      await command("/usr/bin/dscl", [".", "-create", `/Users/${input.name}`, key, String(value)]);
    }
  } catch (error) {
    await command("/usr/bin/dscl", [".", "-delete", `/Users/${input.name}`]).catch(() => {});
    await command("/usr/bin/dscl", [".", "-delete", `/Groups/${input.name}`]).catch(() => {});
    throw error;
  }
}

async function deleteAccount(name) {
  await command("/usr/bin/dscl", [".", "-delete", `/Users/${name}`]).catch(() => {});
  await command("/usr/bin/dscl", [".", "-delete", `/Groups/${name}`]).catch(() => {});
}

async function atomicTextFile(path, text, mode, uid = 0, gid = 0) {
  const temporary = join(dirname(path), `.control-room-${process.pid}-${randomUUID()}`);
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, mode);
  try { await handle.writeFile(text); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
  await lchown(temporary, uid, gid); await rename(temporary, path);
}

async function mutateDeny(path, name, add) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("scheduler_deny_refused");
  const original = await readFile(path, "utf8"), lines = original.split(/\r?\n/u).filter(Boolean);
  const has = lines.includes(name);
  if (add === has) return false;
  const next = add ? [...lines, name] : lines.filter(line => line !== name);
  await atomicTextFile(path, `${next.join("\n")}\n`, stat.mode & 0o777, stat.uid, stat.gid);
  return true;
}

async function installRootFile(path, text, owner) {
  const current = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (current) {
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== owner.uid
      || current.gid !== owner.gid || (current.mode & 0o777) !== owner.mode || await readFile(path, "utf8") !== text) {
      throw new Error("existing_root_file_refused");
    }
    return false;
  }
  await atomicTextFile(path, text, owner.mode, owner.uid, owner.gid);
  return true;
}

function unprivilegedIdentity(identity) {
  if (!identity || !Number.isSafeInteger(identity.uid) || !Number.isSafeInteger(identity.gid)
    || identity.uid < 1 || identity.gid < 1) throw new Error("tailscale_identity_refused");
  return identity;
}

export async function runTailscaleCliV1(identity, args, execute = command) {
  const owner = unprivilegedIdentity(identity);
  if (!Array.isArray(args) || args.some(value => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("tailscale_arguments_refused");
  }
  return execute(TAILSCALE, args, { uid: owner.uid, gid: owner.gid, maxBuffer: MAX_TAILSCALE_JSON_BYTES });
}

const tailscaleCommand = runTailscaleCliV1;

export function parseTailscaleJsonV1(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_TAILSCALE_JSON_BYTES || text.includes("\0")) {
    throw new Error("tailscale_json_refused");
  }
  let value; try { value = JSON.parse(text); } catch { throw new Error("tailscale_json_refused"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tailscale_json_refused");
  return value;
}

export async function sudoSecurePathIsActiveV1(execute = command) {
  try {
    const result = await execute("/usr/bin/sudo", ["-V"]);
    return result.stdout.split(/\r?\n/u).includes(SECURE_PATH_LINE);
  } catch { return false; }
}

const parseBoundedJson = parseTailscaleJsonV1;

export async function readTailscaleRpIdV1(identity, execute = command) {
  const status = parseBoundedJson((await runTailscaleCliV1(identity, ["status", "--json"], execute)).stdout);
  const rpId = typeof status?.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/u, "") : "";
  if (!/^[A-Za-z0-9.-]{1,253}$/u.test(rpId)) throw new Error("tailscale_rp_id_refused");
  return rpId;
}

export async function cleanupTailscaleDirectoryV1(directory, removeFile = unlink, removeDirectory = rmdir) {
  await removeFile(join(directory, "serve.json")).catch(error => { if (error?.code !== "ENOENT") throw error; });
  await removeDirectory(directory).catch(error => {
    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") throw new Error("tailscale_temp_directory_not_empty");
    if (error?.code !== "ENOENT") throw error;
  });
}

export function assertRootOwnedTailscaleParentV1(entry) {
  if (!entry || typeof entry.isDirectory !== "function" || typeof entry.isSymbolicLink !== "function"
    || !entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0) {
    throw new Error("tailscale_temp_directory_refused");
  }
}

export function generateVapidKeysV1() {
  const key = createECDH("prime256v1");
  key.generateKeys();
  const publicKey = key.getPublicKey(undefined, "uncompressed"), scalar = key.getPrivateKey();
  // Node drops leading zero bytes from the scalar (about 1 key in 256), so pad
  // it back to the fixed 32-byte width VAPID requires instead of refusing it.
  const privateKey = scalar.byteLength < 32 ? Buffer.concat([Buffer.alloc(32 - scalar.byteLength), scalar]) : scalar;
  if (publicKey.byteLength !== 65 || publicKey[0] !== 4 || privateKey.byteLength !== 32) {
    throw new Error("vapid_generation_refused");
  }
  return Object.freeze({ publicKey: publicKey.toString("base64url"), privateKey: privateKey.toString("base64url") });
}

async function stdinLine() {
  process.stderr.write("Paste the dedicated read-only repository credential, then press Return: ");
  process.stdin.setEncoding("utf8");
  const raw = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  if (raw) process.stdin.setRawMode(true);
  let text = "";
  try {
    for await (const chunk of process.stdin) {
      if (chunk.includes("\u0003")) throw new Error("github_credential_refused");
      text += chunk; if (/[\r\n]/u.test(text) || text.length > 16_384) break;
    }
  } finally { if (raw) { process.stdin.setRawMode(false); process.stderr.write("\n"); } }
  return text.split(/[\r\n]/u)[0] ?? "";
}

const SERVE_443_SNAPSHOT_SCHEMA_V1 = "control-room.tailscale-serve-443/v1";
const loopbackServeTarget = target => {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/u.exec(target ?? "");
  const port = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null;
};

export function readServe443TargetFromStatusV1(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("live_serve_port_refused");
  const web = status.Web;
  if (web === undefined) return null;
  if (!web || typeof web !== "object" || Array.isArray(web)) throw new Error("live_serve_port_refused");
  const entries = Object.entries(web).filter(([key]) => key.endsWith(":443"));
  if (entries.length === 0) return null;
  if (entries.length !== 1) throw new Error("live_serve_port_refused");
  const [key, value] = entries[0], handlers = value?.Handlers;
  if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)
    || Object.keys(handlers).length !== 1 || typeof handlers["/"]?.Proxy !== "string") {
    throw new Error("live_serve_port_refused");
  }
  const funnel = status.AllowFunnel;
  if (funnel !== undefined && (!funnel || typeof funnel !== "object" || Array.isArray(funnel)
    || funnel[key] === true)) throw new Error("live_serve_port_refused");
  const target = handlers["/"].Proxy;
  if (loopbackServeTarget(target) === null) throw new Error("live_serve_port_refused");
  return Object.freeze({ key, target });
}

export function readLiveServePortFromStatusV1(status) {
  const entry = readServe443TargetFromStatusV1(status);
  if (!entry) return null;
  return loopbackServeTarget(entry.target);
}

export async function captureTailscaleServe443V1(identity, execute = command) {
  const status = parseBoundedJson((await runTailscaleCliV1(identity, ["serve", "status", "--json"], execute)).stdout);
  const entry = readServe443TargetFromStatusV1(status);
  return Object.freeze({ schema: SERVE_443_SNAPSHOT_SCHEMA_V1, target: entry?.target ?? null });
}

export async function setTailscaleServe443V1(snapshot, identity, execute = command) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || Object.keys(snapshot).sort().join(",") !== "schema,target"
    || snapshot.schema !== SERVE_443_SNAPSHOT_SCHEMA_V1
    || snapshot.target !== null && loopbackServeTarget(snapshot.target) === null) {
    throw new Error("tailscale_serve_443_snapshot_refused");
  }
  const args = snapshot.target === null ? ["serve", "--https=443", "off"]
    : ["serve", "--bg", "--https=443", snapshot.target];
  await runTailscaleCliV1(identity, args, execute);
}

export async function assertRuntimeTreeRootMetadataPortV1({ root, tree }) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === "/"
    || !["node", "pnpm", "esbuild", "postgresql"].includes(tree)) throw new Error("runtime_vendor_root_metadata_refused");
  const base = tree === "postgresql" ? "pg" : tree;
  const runtimeRoot = join(root, "runtime");
  const target = await realpath(join(runtimeRoot, `${base}-current`)).catch(() => {
    throw new Error("runtime_vendor_root_metadata_refused");
  });
  if (!target.startsWith(`${runtimeRoot}/`)) throw new Error("runtime_vendor_root_metadata_refused");
  return assertRuntimeTreeRootMetadataV1(target);
}

async function commandMustRefuse(execute, file, args, owner) {
  try { await execute(file, args, { uid: owner.uid, gid: owner.gid }); }
  catch (error) { if (error?.code === 1) return true; throw error; }
  throw new Error("rehearsal_owner_access_not_denied");
}

export async function assertRehearsalOwnerDeniedV1({ root, identity, operation, servicePolicy }, execute = command) {
  const owner = unprivilegedIdentity(identity);
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === "/"
    || !["read", "write", "signal"].includes(operation)) throw new Error("rehearsal_owner_denial_refused");
  if (operation === "read") {
    await commandMustRefuse(execute, "/usr/bin/test", ["-r", join(root, "Protected", "config", "supervisor.json")], owner);
  } else if (operation === "write") {
    await commandMustRefuse(execute, "/usr/bin/test", ["-w", join(root, "Protected", "config")], owner);
  } else {
    const service = servicePolicyForRolesV1(["supervisor"], servicePolicy)[0];
    const printed = await execute("/bin/launchctl", ["print", `system/${service.label}`]);
    const matches = [...(printed.stdout ?? "").matchAll(/^\s*pid = (\d+)\s*$/gmu)];
    if (matches.length !== 1) throw new Error("rehearsal_owner_denial_refused");
    await commandMustRefuse(execute, "/bin/kill", ["-0", matches[0][1]], owner);
  }
  return Object.freeze({ uid: owner.uid, operation, denied: true });
}

export async function assertSeatbeltAppliedV1({ root, role, servicePolicy }, execute = command) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === "/"
    || !["postgres", "supervisor"].includes(role)) throw new Error("rehearsal_seatbelt_refused");
  const serviceRole = role === "postgres" ? "postgresql17" : role;
  const service = servicePolicyForRolesV1([serviceRole], servicePolicy)[0];
  const [program, profile] = await Promise.all([
    execute("/usr/bin/plutil", ["-extract", "ProgramArguments.0", "raw", "-o", "-", service.plistPath]),
    execute("/usr/bin/plutil", ["-extract", "ProgramArguments.2", "raw", "-o", "-", service.plistPath]),
    execute("/bin/launchctl", ["print", `system/${service.label}`]),
  ]);
  if (program.stdout.trim() !== "/usr/bin/sandbox-exec"
    || profile.stdout.trim() !== join(root, "updater", "current", "policy", `service-${role}.sb`)) {
    throw new Error("rehearsal_seatbelt_refused");
  }
  return Object.freeze({ role, applied: true, skipped: false });
}

const LIVE_DATABASE_MOVE_CONTRACT_V1 = "control-room.live-database-move/v1";
const LIVE_DATABASE_MOVE_RESULT_V1 = "control-room.live-database-move-result/v1";
const activeDatabaseMoves = new Set();
const accountPattern = /^_[a-z][a-z0-9]{1,30}$/u;

function databaseMoveAccount(input) {
  if (!input || typeof input !== "object" || !accountPattern.test(input.name ?? "")
    || !Number.isSafeInteger(input.uid) || input.uid < 1 || input.uid > 0x7fffffff
    || !Number.isSafeInteger(input.gid) || input.gid < 1 || input.gid > 0x7fffffff
    || typeof input.created !== "boolean") throw new Error("database_move_input_refused");
  return Object.freeze({ name: input.name, uid: input.uid, gid: input.gid });
}

function parseDatabaseMoveResult(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16_384 || text.includes("\0")) {
    throw new Error("database_move_result_refused");
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("database_move_result_refused"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "dumpVerified,outcome,schema,sourceRetained"
    || value.schema !== LIVE_DATABASE_MOVE_RESULT_V1 || value.outcome !== "moved"
    || value.dumpVerified !== true || value.sourceRetained !== true) {
    throw new Error("database_move_result_refused");
  }
  return Object.freeze({ ...value });
}

/**
 * Runs the database worker's future mover as one fixed, root-owned script. The
 * script owns dump/restore and production-login verification; this port owns
 * only the immutable process contract and refuses concurrent moves.
 */
export async function moveLiveDatabaseV1(input, execute = command, assertPath = assertTrustedPath) {
  const root = input?.root;
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === "/"
    || input.verifiedDump !== true || input.retainSource !== true
    || input.scratchParent !== join(root, "pg") || typeof input.spawnTrusted !== "function"
    || !input.accounts || Object.keys(input.accounts).sort().join(",") !== "builder,database,service") {
    throw new Error("database_move_input_refused");
  }
  const accounts = Object.fromEntries(["builder", "database", "service"]
    .map(role => [role, databaseMoveAccount(input.accounts[role])]));
  if (new Set(Object.values(accounts).map(account => account.name)).size !== 3) {
    throw new Error("database_move_input_refused");
  }
  if (activeDatabaseMoves.has(root)) throw new Error("database_move_busy");
  activeDatabaseMoves.add(root);
  try {
    const executable = join(root, "runtime", "node-current", "bin", "node");
    const script = join(root, "updater", "current", "bin", "move-live-database.mjs");
    await assertPath(executable, { allowedRoots: [root], executable: true });
    await assertPath(script, { allowedRoots: [root] });
    const request = JSON.stringify({ schema: LIVE_DATABASE_MOVE_CONTRACT_V1, root,
      scratchParent: input.scratchParent, verifiedDump: true, retainSource: true, accounts });
    const result = await execute(executable, [script, "--request", request], { timeout: 4 * 60 * 60 * 1000 });
    return parseDatabaseMoveResult(result?.stdout);
  } finally { activeDatabaseMoves.delete(root); }
}

// ---------------------------------------------------------------------------
// The database phase: two scripts, one process contract, one parse.
//
// The contract lives in `../pg/database-phase-contract.mjs` and BOTH sides import
// it, rather than this file spelling the schema strings and keys a second time.
// The port and the scripts are compiled by different steps — this one is bundled
// into `cli.mjs`, the scripts are separate bundle entries — so a key typed twice
// is a key that can drift, and the symptom would be a refusal on install night
// with no local reproduction. Sharing the parser is the only version of this that
// has a test.
// ---------------------------------------------------------------------------

const DATABASE_PHASE_SCRIPTS_V1 = Object.freeze({
  init: { schema: DATABASE_INIT_REQUEST_V1, result: DATABASE_INIT_RESULT_V1,
    name: "init-database.mjs", keys: ["clusterShutDownClean", "outcome", "pgDataId", "schema", "updaterSchemaDigest"],
    proofs: { outcome: "initialized", clusterShutDownClean: true } },
  release: { schema: RELEASE_SCHEMA_REQUEST_V1, result: RELEASE_SCHEMA_RESULT_V1,
    name: "apply-release-schema.mjs", keys: ["ledgerHead", "outcome", "schema", "schemaDigest"],
    proofs: { outcome: "applied" } },
});

const activeDatabasePhases = new Set();

/**
 * `initializeDatabaseV1` — spawn one database-phase script and demand its result.
 *
 * The rules are `moveLiveDatabaseV1`'s, deliberately, because the two ports
 * differ only in WHICH script they run:
 *   - T1 on the pinned Node and on the script, both inside the install root;
 *   - exactly two argv elements, `--request` and one compact JSON value;
 *   - the request is on argv; the PASSWORDS are on the script's stdin, never in
 *     argv and never in the request. `ps` is world-readable on macOS, so a
 *     password in argv is a password in a file an unrelated process can read.
 *   - one bounded JSON object on stdout with an EXACT key set, and both proofs
 *     (`clusterShutDownClean: true`, `updaterSchemaDigest` shaped as a digest)
 *     checked. A result with an extra key is refused rather than journalled, so a
 *     script that learned to add a field cannot add one the installer has not
 *     reviewed;
 *   - one active call per install root.
 *
 * THE SPAWN IS THE FOURTH ARGUMENT, not a hardcoded call. MEASURED: this port
 * originally called `runWithStdin` directly and ignored the injected `execute`,
 * which left it untestable at exactly the place the contract is most worth
 * testing — nothing could observe what reached the child's argv. `moveLiveDatabaseV1`
 * takes its transport as a parameter for the same reason, and a port that cannot
 * be observed is a port whose argv contract is asserted nowhere.
 */
export async function initializeDatabaseV1(input, execute = command, assertPath = assertTrustedPath,
  spawnWithStdin = runWithStdin) {
  const script = DATABASE_PHASE_SCRIPTS_V1[input?.phase];
  if (!script) throw new Error("database_phase_refused");
  const root = input.root;
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === "/"
    || typeof input.pgDataId !== "string" || !/^data-[A-Za-z0-9._-]{1,32}$/u.test(input.pgDataId)
    || input.runtime !== "runtime/pg-current" || input.socketDir !== "pg/socket"
    // The port is range-checked here, for the same reason it is in the shared
    // parser: it is part of the socket path, and the two sides must agree on it.
    // It is OPTIONAL in the port's input (M1b review, probe H1: the installer's
    // `databaseInput` sends none, and every installer-shaped call was refused);
    // when absent it is the RELEASE's own value, read below from the role manifest
    // the installer staged, and it is always present on the wire.
    || (input.port !== undefined && (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535))
    || typeof input.passwords !== "object" || input.passwords === null || Array.isArray(input.passwords)) {
    throw new Error("database_phase_input_refused");
  }
  if (input.expectedLedgerHead !== undefined
    && !/^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(input.expectedLedgerHead ?? "")) {
    throw new Error("database_phase_input_refused");
  }
  // CROSS-PHASE KEYS ARE REFUSED RATHER THAN IGNORED. MEASURED: an init request
  // carrying `release: "current"` used to succeed silently, because
  // `requestBody` is built from named keys and `release` is only named for the
  // release phase — so the extra key was dropped and nothing said so. A caller
  // that reached for the wrong phase selector learned nothing until install
  // night. Silently ignoring a key a caller believed was being sent is the one
  // behaviour a request contract must never have: the whole point of an exact
  // key set is that the value sent is the value applied.
  for (const key of ["release", "expectedLedgerHead"]) {
    if (input.phase !== "release" && input[key] !== undefined) {
      throw new Error("database_phase_cross_phase_key_refused");
    }
  }
  const accounts = parseDatabasePhaseAccountsV1(input.accounts, "database_phase_input_refused");
  const logins = parseDatabasePhaseLoginsV1(input.logins, "database_phase_input_refused");
  parseDatabasePhasePasswordsV1(input.passwords, logins, "database_phase_input_refused");
  if (activeDatabasePhases.has(root)) throw new Error("database_phase_busy");
  activeDatabasePhases.add(root);
  try {
    const executable = join(root, "runtime", "node-current", "bin", "node");
    const target = join(root, "updater", "current", "bin", script.name);
    await assertPath(executable, { allowedRoots: [root], executable: true });
    await assertPath(target, { allowedRoots: [root] });
    // The release's port when the caller named none: `<root>/current` is the
    // release the installer staged and the scripts read, so both phases and this
    // port take the number from ONE file. A missing or malformed manifest is a
    // refusal here, before any spawn.
    const port = input.port ?? (await readRoleManifestV1(join(root, "current")).catch(() => {
      throw new Error("database_phase_port_unavailable");
    })).port;
    // The request is BUILT, not spread.
    //
    // MEASURED: `parseDatabasePhaseRequestV1` demands an exact key set —
    // accounts, logins, pgDataId, root, runtime, schema, socketDir (+ release's
    // two) — and this used to build both the pre-spawn check and the wire value
    // from `{ ...input, … }`. `input` is the PORT's argument and carries two keys
    // that are the port's business and NOT the request's: `phase` (which chose
    // the script) and `passwords` (which travel on stdin). So every call through
    // this port was refused `database_phase_input_refused` at its own
    // pre-spawn check — a port that could not run either phase, which no test
    // covered because the executor was hardcoded and nothing reached this line.
    //
    // Naming the seven keys is the fix and also the guard: a key added to the
    // port's input cannot reach the wire without someone editing this list, and
    // the shared parser refuses the moment the two lists disagree.
    const requestBody = { root, pgDataId: input.pgDataId, runtime: input.runtime,
      socketDir: input.socketDir, accounts, logins: logins.map(login => ({ name: login.name, passwordStdin: true })),
      schema: script.schema,
      // The PORT travels with the request, and that is the fix the cross-process
      // test forced: the cluster is socket-only, so the port is part of the SOCKET
      // PATH, and both phases compute it. MEASURED: with the port only in the
      // release's role-manifest data, the INIT phase honoured the caller's port and
      // the spawned RELEASE phase read 5432 from the manifest and answered
      // `connection to server on socket "…/.s.PGSQL.5432" failed: No such file or
      // directory` — naming the wrong port rather than the disagreement.
      port,
      ...(input.phase === "release" ? { release: "current" } : {}),
      // `expectedLedgerHead` is optional, so it is included ONLY when the caller
      // supplied one. The `extraKeys` list below declares the key set the script
      // accepts; the parser compares against the keys actually present, so an
      // absent optional key and a present one are both accepted for a release
      // request and only the latter is a refusal for an init request.
      ...(input.expectedLedgerHead !== undefined ? { expectedLedgerHead: input.expectedLedgerHead } : {}) };
    // …and the script's OWN key set is checked before the spawn, so a request
    // that this port would send is the request the script's parser accepts. The
    // shared parser is the single declaration of both halves.
    parseDatabasePhaseRequestV1(requestBody, {
      schema: script.schema, code: "database_phase_input_refused",
      // `expectedLedgerHead` is OPTIONAL, so it is declared in `optionalKeys`
      // rather than `extraKeys`: `extraKeys` means "always required", and
      // declaring it required would refuse every release request that did not
      // pin a head — which is the legitimate case, because a fresh install has no
      // head to expect.
      extraKeys: input.phase === "release" ? ["release"] : [],
      optionalKeys: input.phase === "release" ? ["expectedLedgerHead"] : [] });
    const request = JSON.stringify(requestBody);
    const result = await spawnWithStdin(executable, [target, "--request", request], input.passwords,
      { timeout: 4 * 60 * 60 * 1000 });
    return parseDatabasePhaseResultV1(result?.stdout, { schema: script.result, keys: script.keys,
      code: "database_phase_result_refused", proofs: script.proofs });
  } finally { activeDatabasePhases.delete(root); }
}

/** The two phases, in the order §4.3 rows 19 and 22 run them. */
export const DATABASE_PHASE_ORDER_V1 = Object.freeze(["init", "release"]);

// The install-night Face ID port lives in `pg/initial-passkey-production.mjs` (atk-fa
// F2): stage one, loaded from the confirmed fixed bundle, hands out the BUNDLED copy,
// because this file runs from the git-archive copy, which has no `node_modules`.
export { registerInitialPasskeyProductionV1 };

export default Object.freeze({
  geteuid: () => process.geteuid?.() ?? -1,
  randomBytes,
  randomId: randomUUID,
  now: () => new Date().toISOString(),
  async inspectOwnership(path) {
    try {
      const entry = await lstat(path);
      const acl = (await command("/bin/ls", ["-lde", path])).stdout.split(/\r?\n/u).slice(1)
        .filter(line => /^\s*\d+:/u.test(line));
      return { type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        symlink: entry.isSymbolicLink(), uid: entry.uid, gid: entry.gid, mode: entry.mode & 0o777, acl };
    } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  },
  lchownPath: lchown,
  readAccountInventory,
  createAccount,
  deleteAccount,
  ensureDenyEntry: (path, name) => mutateDeny(path, name, true),
  removeDenyEntry: (path, name) => mutateDeny(path, name, false).catch(error => { if (error?.code !== "ENOENT") throw error; }),
  installRootFile,
  removeRootFile: path => rm(path, { force: true }),
  async validateSudoers(path) { try { await command("/usr/sbin/visudo", ["-cf", path]); return true; } catch { return false; } },
  sudoSecurePathIsActive: sudoSecurePathIsActiveV1,
  assertT1Path: (path, options = {}) => assertTrustedPath(path, {
    allowedRoots: [path], executable: options.executable === true,
  }),
  assertRuntimeTreeRootMetadata: assertRuntimeTreeRootMetadataPortV1,
  assertRehearsalOwnerDenied: assertRehearsalOwnerDeniedV1,
  assertSeatbeltApplied: assertSeatbeltAppliedV1,
  vendorRuntime: vendorToolRuntime,
  verifyBootstrapSourceV1,
  adoptBootstrapV1,
  removeAdoptedBootstrapV1,
  seedUpdaterV1,
  loadInstallStepsV1,
  abortAttendedV1,
  fetchVerifiedSourceV1,
  buildReleaseV1,
  buildFixedBundleV1,
  runningBundleDigestV1,
  confirmAttendedV1,
  classifyAttendedSourceV1,
  stageReleaseV1,
  stageUpdaterBundleV1,
  switchPairV1,
  rollbackRuntime: rollbackToolRuntime,
  initializeDatabase: initializeDatabaseV1,
  recoverServices: recoverServicesV1,
  killAccountProcesses: killAccountProcessesV1,
  retireDatabase: retireDatabaseV1,
  firstOwner: firstOwnerViaScriptV1,
  installGuard: installGuardV1,
  removeGuard: removeGuardV1,
  composeProtectedConfig: composeProtectedConfigPortV1,
  writeDatabaseLogins: writeDatabaseLoginsV1,
  removeDatabaseLogins: removeDatabaseLoginsV1,
  recordTailscaleServe: recordTailscaleServeV1,
  seedKnownGood: seedKnownGoodV1,
  removeKnownGood: removeKnownGoodV1,
  async remintOwnerCode(input) { const { servicePolicy, ...value } = input; const result = await remintOwnerCodeV1(value);
    await restartServicesV1({ root: input.root, roles: ["supervisor"], ...(servicePolicy ? { servicePolicy } : {}) }); return result; },
  async rollbackOwnerCode(input) { const { servicePolicy, ...value } = input; const result = await rollbackOwnerCodeV1(value);
    // Nothing restored (a replay after the in-process rollback): the supervisor may already be gone (atk-fa F4).
    if (result.restored || result.removed) await restartServicesV1({ root: input.root, roles: ["supervisor"], ...(servicePolicy ? { servicePolicy } : {}) });
    return result; },
  startPostHealthServices: (input, proof) => startPostHealthServicesV1(input, proof),
  registerInitialPasskey: registerInitialPasskeyProductionV1,
  recordPasskeyStatus: passkeyStatusV1,
  cleanupBootstrap: cleanupBootstrapV1,
  generateVapidKeys: async () => generateVapidKeysV1(),
  generateWorkIntakeKeys: async () => ({ schema: "control-room.work-intake-keys/v1",
    integrityKey: randomBytes(32).toString("base64url") }),
  readGithubCredential: stdinLine,
  installServices: installServicesV1,
  uninstallServices: uninstallServicesV1,
  restartServices: restartServicesV1,
  checkHealth: input => checkHealthV1(input, { checkDatabase: checkDatabaseHealthV1 }),
  checkDatabaseHealth: checkDatabaseHealthV1,
  captureTailscaleServe: ({ identity }) => captureTailscaleServe443V1(identity),
  readTailscaleRpId: ({ identity }) => readTailscaleRpIdV1(identity),
  async activateTailscaleServe({ webPort, identity }) {
    await setTailscaleServe443V1({ schema: SERVE_443_SNAPSHOT_SCHEMA_V1,
      target: `http://127.0.0.1:${webPort}` }, identity);
  },
  async inspectTailscaleServe({ identity }) {
    return parseBoundedJson((await tailscaleCommand(identity, ["serve", "status", "--json"])).stdout);
  },
  async readLiveServePort({ identity }) {
    const status = parseBoundedJson((await tailscaleCommand(identity, ["serve", "status", "--json"])).stdout);
    return readLiveServePortFromStatusV1(status);
  },
  restoreTailscaleServe: ({ snapshot, identity }) => setTailscaleServe443V1(snapshot, identity),
  moveLiveDatabase: moveLiveDatabaseV1,
  invalidateSudoTimestamp: identity => invalidateSudoTimestampV1(identity),
  async processIdentity(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("install_lock_refused");
    const value = (await command("/bin/ps", ["-o", "lstart=", "-p", String(pid)])).stdout.trim();
    if (!value) throw new Error("install_lock_refused");
    return value;
  },
});

export async function invalidateSudoTimestampV1(identity, execute = command) {
  if (!identity || typeof identity !== "object" || !/^[A-Za-z0-9._-]{1,64}$/u.test(identity.user ?? "")
    || !Number.isSafeInteger(identity.uid) || !Number.isSafeInteger(identity.gid) || identity.uid < 1 || identity.gid < 1
    || identity.uid > 0x7fffffff || identity.gid > 0x7fffffff) throw new Error("invoking_user_refused");
  await execute("/usr/bin/sudo", ["-K"], { uid: identity.uid, gid: identity.gid });
}
