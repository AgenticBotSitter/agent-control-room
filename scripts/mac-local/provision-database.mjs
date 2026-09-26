/**
 * Owner-authorized Mac-local database provisioner.
 *
 * This is deliberately a one-shot installer helper, not part of the running
 * product. It creates no listener or worker. It creates only the fixed
 * PostgreSQL logins, applies the immutable migration ledger, and records the
 * Mac's private configuration beneath the owner-only Protected directory.
 *
 * The initial provision path sends secrets to the VPS over SSH standard input
 * and never prints or places them in command arguments. The repoint-only path
 * reads the local Tailscale route and changes no password or remote state.
 * Re-runs reuse protected password files, so provisioning converges.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Client } from "pg";
import { sha256Digest } from "../../src/security/canonical-digest";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1 } from "../../src/web/v1/mac-local-protected-configuration";
import { captureMacLocalProtectedConfigurationV1 } from "../../src/web/v1/mac-local-protected-configuration";
import { captureMacLocalDatabaseRolesV1, MAC_LOCAL_DATABASE_ROLES_V1 } from "../../src/web/v1/mac-local-database-roles";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../../src/harness/v1/owner-trusted-local-enablements";
import { pinnedVersionLine } from "./executable-version.mjs";
import { capturePrivatePostgresEndpointPolicyV2, isSupportedPrivatePostgresHostV1,
  privatePostgresEndpointFingerprintV1, PRIVATE_POSTGRES_ENDPOINT_V2 } from "../../src/web/v1/private-postgres-endpoint";
import { privatePostgresOptions, validatePrivatePostgresConfiguration } from "../../src/web/v1/private-postgres";
import { macGrantCatalogSqlV1, macRolePlan } from "./database-upgrade-grants.mjs";
import { planMacDatabaseUpgradeSnapshotV1 } from "./database-upgrade-remote.mjs";
import { checkedPostgresScramVerifierV1, postgresScramVerifierV1 } from "./database-upgrade-scram.mjs";

const exec = promisify(execFile);
const roleNames = Object.freeze({ web: "control_room_web", coordinator: "control_room_coordinator",
  results: "control_room_results", publisher: "control_room_publisher", queueWorker: "control_room_queue_worker" });
const bootstrapRoles = Object.freeze({ migrator: "control_room_migrator", application: "control_room_app",
  scheduler: "control_room_scheduler" });
const passwordPattern = /^[A-Za-z0-9_-]{32,}$/u;
const privateMode = 0o700;
const privateFileMode = 0o600;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// A database provision is intentionally bounded. SSH itself has a connection
// deadline below; this covers a connected remote command that stalls while
// fetching, preparing dependencies, or applying the ledger. The VPS command
// has a slightly shorter independent deadline so a dropped SSH client cannot
// leave a second password-changing provision running remotely.
const remoteProvisionTimeoutMs = 5 * 60_000;

function usage() {
  return "Usage: pnpm mac:provision-database --protected-root ABSOLUTE_PATH --ssh-target USER@HOST --database-host HOST [--database-port 5432] [--endpoint-policy-file ABSOLUTE_PATH] [--remote-worktree ABSOLUTE_PATH] [--vps-only] [--dry-run]\n"
    + "   or: pnpm mac:provision-database --repoint-only --protected-root ABSOLUTE_PATH\n"
    + "   or: pnpm mac:provision-database --upgrade --dry-run --snapshot-file ABSOLUTE_PATH\n"
    + "   or: pnpm mac:provision-database --upgrade --prepare --protected-root ABSOLUTE_PATH\n"
    + "   or: pnpm mac:provision-database --upgrade --finish --protected-root ABSOLUTE_PATH";
}

function argument(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("provision_usage_refused");
  return value;
}

function requireAbsolute(value, code) {
  if (!value || !isAbsolute(value) || resolve(value) !== value) throw new Error(code);
  return value;
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: privateMode });
  await chmod(path, privateMode);
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error("provision_protected_directory_refused");
}

async function privateText(path, make) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error("provision_protected_file_refused");
    const existing = (await readFile(path, "utf8")).trim();
    if (!passwordPattern.test(existing)) throw new Error("provision_protected_file_refused");
    return existing;
  } catch (error) {
    if ((error && typeof error === "object" && error.code) !== "ENOENT") throw error;
    const value = make();
    await writePrivate(path, `${value}\n`);
    return value;
  }
}

async function writePrivate(path, content) {
  const temporary = `${path}.new-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: privateFileMode, flag: "wx" });
    await chmod(temporary, privateFileMode);
    await rename(temporary, path);
    await chmod(path, privateFileMode);
  } finally {
    try { await unlink(temporary); } catch {}
  }
}

async function readProtectedJson(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error("provision_protected_file_refused");
  return JSON.parse(await readFile(path, "utf8"));
}

async function readPrivatePassword(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0)
    throw new Error("upgrade_protected_password_refused");
  const value = (await readFile(path, "utf8")).trim();
  if (!passwordPattern.test(value)) throw new Error("upgrade_protected_password_refused");
  return value;
}

async function existingPrivateDirectory(path) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0)
    throw new Error("upgrade_protected_directory_refused");
}

export function macLocalRouteFromTailscaleStatusV1(status, evidenceText) {
  const selfTags = status?.Self?.Tags;
  if (!Array.isArray(selfTags) || !selfTags.includes("tag:general") || !selfTags.includes("tag:control-room-client"))
    throw new Error("provision_mac_client_tag_missing");
  const peers = Object.values(status?.Peer ?? {}).filter(peer => Array.isArray(peer?.Tags)
    && peer.Tags.includes("tag:control-room-vps"));
  if (peers.length !== 1 || peers[0]?.Online !== true) throw new Error("provision_vps_peer_refused");
  const peer = peers[0];
  const host = (peer.TailscaleIPs ?? []).find(value => isSupportedPrivatePostgresHostV1(value) && value !== "127.0.0.1");
  const serverName = typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.$/u, "") : "";
  if (!host || !serverName) throw new Error("provision_vps_peer_refused");
  const start = evidenceText.indexOf("## VPS evidence");
  const end = evidenceText.indexOf("## Live acceptance", start + 1);
  if (start < 0 || end <= start) throw new Error("provision_route_evidence_refused");
  const evidence = evidenceText.slice(start, end).replace(/\r\n/gu, "\n").trim();
  return Object.freeze({ host, port: 5432, serverName,
    privateRouteEvidenceDigest: sha256Digest({ purpose: "control-room.accepted-vps-postgres-route-evidence/v1", evidence }) });
}

export function parseRepointArgumentsV1(args) {
  const values = args[0] === "--" ? args.slice(1) : args;
  let protectedRoot;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--repoint-only") continue;
    if (value === "--protected-root" && protectedRoot === undefined
      && values[index + 1] !== undefined && !values[index + 1].startsWith("--")) {
      protectedRoot = values[index + 1];
      index += 1;
      continue;
    }
    throw new Error("provision_repoint_arguments_refused");
  }
  if (protectedRoot === undefined) throw new Error("provision_repoint_arguments_refused");
  return protectedRoot;
}

async function repointOnly({ protectedRoot: suppliedRoot, route }) {
  const protectedRoot = requireAbsolute(suppliedRoot, "provision_protected_root_required");
  const configRoot = join(protectedRoot, "config");
  await privateDirectory(protectedRoot);
  await privateDirectory(configRoot);
  const routeKeys = ["host", "port", "serverName", "privateRouteEvidenceDigest"];
  if (!route || typeof route !== "object" || Array.isArray(route)
    || Object.keys(route).length !== routeKeys.length || routeKeys.some(key => !Object.hasOwn(route, key))
    || Object.keys(route).some(key => !routeKeys.includes(key))
    || !isSupportedPrivatePostgresHostV1(route.host) || route.host === "127.0.0.1" || route.port !== 5432
    || typeof route.serverName !== "string" || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(route.serverName)
    || typeof route.privateRouteEvidenceDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(route.privateRouteEvidenceDigest))
    throw new Error("provision_route_config_refused");

  const policyInput = { schema: PRIVATE_POSTGRES_ENDPOINT_V2, routeKind: "tailscale",
    endpointFingerprint: privatePostgresEndpointFingerprintV1({ host: route.host, port: 5432,
      database: "control_room", majorVersion: 17 }), privateRouteEvidenceDigest: route.privateRouteEvidenceDigest,
    serverIdentity: { serverName: route.serverName } };
  const endpoint = capturePrivatePostgresEndpointPolicyV2({ host: route.host, port: 5432,
    database: "control_room", majorVersion: 17 }, policyInput);
  if (!endpoint) throw new Error("provision_route_config_refused");

  const macPath = join(configRoot, "mac-local.json"), rolesPath = join(configRoot, "database-roles.json");
  const macOriginal = await readProtectedJson(macPath);
  const rolesOriginal = await readProtectedJson(rolesPath);
  const mac = captureMacLocalProtectedConfigurationV1(macOriginal);
  const roles = captureMacLocalDatabaseRolesV1(rolesOriginal);
  if (mac.database.database !== "control_room" || mac.database.username !== roleNames.web
    || roles.schema !== MAC_LOCAL_DATABASE_ROLES_V1
    || roles.web.username !== roleNames.web || roles.coordinator.username !== roleNames.coordinator
    || roles.results.username !== roleNames.results || roles.publisher.username !== roleNames.publisher
    || roles.queueWorker.username !== roleNames.queueWorker
    || [roles.web, roles.coordinator, roles.results, roles.publisher, roles.queueWorker].some(role => role.database !== "control_room"))
    throw new Error("provision_existing_configuration_refused");

  const update = configuration => validatePrivatePostgresConfiguration({ ...configuration, host: route.host, port: 5432,
    privateEndpoint: endpoint });
  const nextMacDatabase = update(mac.database);
  const nextRoleConfigurations = { web: update(roles.web), coordinator: update(roles.coordinator),
    results: update(roles.results), publisher: update(roles.publisher), queueWorker: update(roles.queueWorker) };
  captureMacLocalProtectedConfigurationV1({ ...macOriginal, database: nextMacDatabase });
  captureMacLocalDatabaseRolesV1({ ...rolesOriginal, ...nextRoleConfigurations });
  const nextMac = { ...macOriginal, database: nextMacDatabase };
  const nextRoles = { ...rolesOriginal, ...nextRoleConfigurations };
  const staged = [];
  try {
    for (const [path, value] of [[macPath, nextMac], [rolesPath, nextRoles]]) {
      const temporary = `${path}.new-${process.pid}-${randomBytes(8).toString("hex")}`;
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: privateFileMode, flag: "wx" });
      await chmod(temporary, privateFileMode);
      staged.push({ path, temporary });
    }
    for (const item of staged) await rename(item.temporary, item.path);
  } finally {
    for (const item of staged) { try { await unlink(item.temporary); } catch {} }
  }
  return Object.freeze({ repointed: true });
}

function newPassword() { return randomBytes(32).toString("base64url"); }

/** CLI version commands sometimes include ordinary installation details after
 * their version. Capture one bounded, printable version-looking line rather
 * than treating a current multi-line CLI as a source-version incompatibility. */
export function recordedExecutableVersion(stdout) {
  try { return pinnedVersionLine(stdout); } catch { throw new Error("provision_invalid_executable_version"); }
}

/** The SSH transport or a local account wrapper can add harmless lines before
 * the remote program's success marker. The marker must still be the final
 * non-empty line: output after it would mean we cannot safely identify the
 * provisioner's result. */
export function finalProvisionMarker(stdout) {
  const lines = stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  return lines.at(-1);
}

async function findExecutable(name) {
  const configured = process.env[`CONTROL_ROOM_${name.toUpperCase().replaceAll("-", "_")}_EXECUTABLE`];
  const candidate = configured || (await exec("/usr/bin/which", [name], { encoding: "utf8" })).stdout.trim();
  if (!isAbsolute(candidate)) throw new Error(`provision_missing_${name}_executable`);
  const version = recordedExecutableVersion((await exec(candidate, ["--version"], { encoding: "utf8", timeout: 10_000 })).stdout);
  return Object.freeze({ executablePath: candidate, recordedVersion: version });
}

async function endpointPolicy(host, port, database, path) {
  if (host === "127.0.0.1") {
    if (path !== undefined) throw new Error("provision_unexpected_endpoint_policy");
    return undefined;
  }
  const source = requireAbsolute(path, "provision_endpoint_policy_required");
  const entry = await lstat(source);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error("provision_endpoint_policy_refused");
  const parsed = JSON.parse(await readFile(source, "utf8"));
  const endpointFingerprint = privatePostgresEndpointFingerprintV1({ host, port, database, majorVersion: 17 });
  if (!parsed || typeof parsed !== "object" || parsed.endpointFingerprint !== endpointFingerprint)
    throw new Error("provision_endpoint_policy_refused");
  try {
    const policy = capturePrivatePostgresEndpointPolicyV2({ host, port, database, majorVersion: 17 }, parsed);
    if (!policy) throw new Error("provision_endpoint_policy_refused");
    return policy;
  }
  catch { throw new Error("provision_endpoint_policy_refused"); }
}

async function runRemoteProvision({ sshTarget, remoteWorktree, passwords }) {
  // Root's SSH account runs the PostgreSQL owner command locally on the VPS.
  // The secrets are JSON on stdin, not process arguments or a remote file.
  const source = String.raw`const reportError = error => {
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : error?.name === 'Error' ? 'ERROR' : 'UNKNOWN';
  process.stderr.write('provision_error:' + code + '\n'); process.exitCode = 1;
};
process.on('uncaughtException', reportError); process.on('unhandledRejection', reportError);
import { applyMigrations } from './deploy/postgres/apply-migrations.mjs';
import { connectTarget } from './deploy/postgres/evidence.mjs';
import { provisionMacLocalNarrowRolesV1 } from './scripts/mac-local/narrow-role-provision.mjs';
const input = await new Promise((resolve, reject) => {
  let body = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', part => { body += part; if (body.length > 16 * 1024) reject(new Error('input_too_large')); });
  process.stdin.once('error', reject); process.stdin.once('end', () => resolve(body));
});
const value = JSON.parse(input);
const bootstrapTarget = 'host=/var/run/postgresql dbname=control_room user=postgres';
const migrateTarget = 'host=127.0.0.1 port=5432 dbname=control_room user=control_room_migrator password=' + value.migrator;
process.stderr.write('provision_stage:bootstrap-passwords\n');
const bootstrap = connectTarget(bootstrapTarget); await bootstrap.connect();
try {
  for (const [name, password] of Object.entries({ control_room_migrator: value.migrator, control_room_app: value.application, control_room_scheduler: value.scheduler }))
    await bootstrap.query('ALTER ROLE ' + name + ' PASSWORD ' + bootstrap.escapeLiteral(password));
} finally { await bootstrap.end(); }
process.stderr.write('provision_stage:migrations\n');
await applyMigrations({ bootstrapTarget, migrateTarget, env: {
  CONTROL_ROOM_MIGRATOR_PASSWORD: value.migrator,
  CONTROL_ROOM_APP_PASSWORD: value.application,
  CONTROL_ROOM_SCHEDULER_PASSWORD: value.scheduler
}});
const client = connectTarget(bootstrapTarget); await client.connect();
try {
  process.stderr.write('provision_stage:local-roles\n');
  await provisionMacLocalNarrowRolesV1(client, value.local);
  process.stdout.write('control_room_provisioned\n');
} finally { await client.end(); }`;
  // /opt/data is deliberately root-only on the VPS. The restricted PostgreSQL
  // account cannot traverse it even after this child directory is chowned, so
  // stage the non-secret source tree beneath the system temporary directory.
  // The outer EXIT/signal trap removes it after every attempt.
  const stage = `/var/tmp/control-room-provision-${randomBytes(12).toString("hex")}`;
  const sourceBase64 = Buffer.from(source, "utf8").toString("base64");
  const remoteBody = String.raw`set -eu
printf 'provision_stage:fetch\\n' >&2
git -C ${JSON.stringify(remoteWorktree)} fetch --quiet origin claude/mac-local-integration
printf 'provision_stage:worktree\\n' >&2
git -C ${JSON.stringify(remoteWorktree)} worktree add --quiet --detach "$stage" origin/claude/mac-local-integration
cd "$stage"
printf 'provision_stage:dependencies\\n' >&2
CI=true pnpm install --frozen-lockfile --offline --ignore-scripts >/dev/null
printf 'provision_stage:ownership\\n' >&2
chown -R postgres:postgres "$stage"
printf 'provision_stage:runner\\n' >&2
printf '%s' ${JSON.stringify(sourceBase64)} | base64 -d > "$stage/.control-room-provision.mjs"
chown postgres:postgres "$stage/.control-room-provision.mjs"
runuser -u postgres -- node "$stage/.control-room-provision.mjs"`;
  const remoteBodyBase64 = Buffer.from(remoteBody, "utf8").toString("base64");
  const remote = String.raw`set -eu
umask 077
stage=${JSON.stringify(stage)}
export stage
body=""
cleanup() {
  rm -f "$body"
  git -C ${JSON.stringify(remoteWorktree)} worktree remove --force "$stage" >/dev/null 2>&1 || true
}

trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
if ! command -v timeout >/dev/null 2>&1; then
  printf 'provision_error:TIMEOUT_UNAVAILABLE\\n' >&2
  exit 1
fi
body=$(mktemp /tmp/control-room-provision.XXXXXX)
printf '%s' ${JSON.stringify(remoteBodyBase64)} | base64 -d > "$body"
set +e
timeout --kill-after=10s 260s /bin/bash "$body"
status=$?
set -e
if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
  printf 'provision_error:TIMEOUT\\n' >&2
fi
exit "$status"`;
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", sshTarget,
      remote],
    { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "", stdout = "";
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = error => {
      // This stops the local transport. The remote command has its own,
      // shorter timeout; both deadlines are required because a noninteractive
      // SSH disconnect alone does not guarantee a remote child is reaped.
      if (!child.killed) child.kill("SIGKILL");
      finish(rejectPromise, error);
    };
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", fail);
    child.once("close", code => {
      if (code === 0 && finalProvisionMarker(stdout) === "control_room_provisioned") finish(resolvePromise);
      else {
        const stageMatch = /provision_stage:([a-z-]+)/g;
        let stage = "unknown", match;
        while ((match = stageMatch.exec(stderr)) !== null) stage = match[1];
        const reportedError = /provision_error:([A-Z0-9_]+)/.exec(stderr)?.[1];
        const reason = reportedError ? `remote_${reportedError.toLowerCase()}`
          : stderr.includes("Permission denied") ? "ssh_unavailable"
          : stderr.includes("migration_") ? "migration_refused"
          : /password authentication failed|no pg_hba\.conf entry/i.test(stderr) ? "postgres_authentication_refused"
          : /Cannot find module|ERR_MODULE_NOT_FOUND/i.test(stderr) ? "remote_runtime_unavailable"
          : "remote_execution_refused";
        finish(rejectPromise, new Error(`provision_${reason}:${stage}`));
      }
    });
    // A broken SSH pipe can otherwise emit an unhandled error after stdin is
    // written, making a failed provision look like a hung installer.
    child.stdin.once("error", error => fail(new Error(`provision_ssh_stdin_refused:${error.code ?? "unknown"}`)));
    timer = setTimeout(() => fail(new Error("provision_ssh_timeout")), remoteProvisionTimeoutMs);
    try { child.stdin.end(JSON.stringify(passwords)); }
    catch (error) { fail(new Error(`provision_ssh_stdin_refused:${error?.code ?? "unknown"}`)); }
  });
}

export function macDatabaseUpgradeReadOnlySqlV1() {
  const principals = [...Object.keys(macRolePlan), ...Object.values(macRolePlan)];
  const names = `ARRAY[${principals.map(name => `'${name}'`).join(",")}]::text[]`;
  const grants = macGrantCatalogSqlV1.replaceAll("$1::text[]", names);
  const sql = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object(
  'applied', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json) FROM
    (SELECT filename,digest,ledger_order FROM control_room_schema_migrations ORDER BY ledger_order) x),
  'roles', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json) FROM
    (SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
      FROM pg_roles WHERE rolname=ANY(${names}) ORDER BY rolname) x),
  'memberships', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json) FROM
    (SELECT member.rolname AS member,parent.rolname AS parent,auth.admin_option,auth.inherit_option,auth.set_option
      FROM pg_auth_members auth JOIN pg_roles member ON member.oid=auth.member
      JOIN pg_roles parent ON parent.oid=auth.roleid
      WHERE member.rolname=ANY(${names}) ORDER BY member.rolname,parent.rolname) x),
  'defaultAcl', (SELECT count(*)::int FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE r.rolname=ANY(${names})),
  'grants', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json) FROM (${grants}) x)
)::text;
COMMIT;`;
  return sql;
}

// Upgrade modes keep every password on the Mac. The VPS receives only a SCRAM
// verifier through a separately operated, owner-approved handoff.
async function currentMainCommit() {
  const git = async args => (await exec("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 10_000 })).stdout.trim();
  const commit = await git(["rev-parse", "HEAD"]);
  if (await git(["branch", "--show-current"]) !== "main" || await git(["status", "--porcelain"])
    || !/^[a-f0-9]{40}$/u.test(commit)) throw new Error("upgrade_main_checkout_refused");
  return commit;
}

async function existingUpgradeConfiguration(protectedRoot) {
  requireAbsolute(protectedRoot, "upgrade_protected_root_required");
  const configRoot = join(protectedRoot, "config"), passwordRoot = join(configRoot, "database-passwords");
  await existingPrivateDirectory(protectedRoot);
  await existingPrivateDirectory(configRoot);
  await existingPrivateDirectory(passwordRoot);
  const mac = await readProtectedJson(join(configRoot, "mac-local.json"));
  captureMacLocalProtectedConfigurationV1(mac);
  const roleFile = join(configRoot, "database-roles.json");
  const oldRoles = await readProtectedJson(roleFile);
  const existingNames = ["schema", "web", "coordinator", "results", "queueWorker"];
  if (oldRoles.schema !== MAC_LOCAL_DATABASE_ROLES_V1
    || Object.keys(oldRoles).some(key => ![...existingNames, "publisher"].includes(key))
    || existingNames.some(key => !Object.hasOwn(oldRoles, key))) throw new Error("upgrade_role_config_refused");
  const sameEndpoint = role => role.host === mac.database.host && role.port === mac.database.port
    && role.database === mac.database.database && role.majorVersion === mac.database.majorVersion
    && JSON.stringify(role.privateEndpoint ?? null) === JSON.stringify(mac.database.privateEndpoint ?? null);
  for (const [key, username] of Object.entries({ web: roleNames.web, coordinator: roleNames.coordinator,
    results: roleNames.results, queueWorker: roleNames.queueWorker })) {
    const role = validatePrivatePostgresConfiguration(oldRoles[key]);
    if (role.username !== username || role.database !== "control_room" || !sameEndpoint(role)
      || role.password !== await readPrivatePassword(join(passwordRoot, `${username}.txt`)))
      throw new Error("upgrade_role_config_refused");
  }
  if (oldRoles.web.password !== mac.database.password || oldRoles.web.username !== mac.database.username
    || JSON.stringify(oldRoles.web.privateEndpoint ?? null) !== JSON.stringify(mac.database.privateEndpoint ?? null))
    throw new Error("upgrade_role_config_refused");
  if (oldRoles.publisher) {
    const publisher = validatePrivatePostgresConfiguration(oldRoles.publisher);
    if (publisher.username !== roleNames.publisher || publisher.database !== "control_room" || !sameEndpoint(publisher)
      || publisher.password !== await readPrivatePassword(join(passwordRoot, `${roleNames.publisher}.txt`)))
      throw new Error("upgrade_role_config_refused");
    captureMacLocalDatabaseRolesV1(oldRoles);
  }
  return { configRoot, passwordRoot, roleFile, oldRoles };
}

export async function planMacDatabaseUpgradeFromFileV1(snapshotFile, expectedMainCommit) {
  requireAbsolute(snapshotFile, "upgrade_snapshot_file_required");
  if (!/^[a-f0-9]{40}$/u.test(expectedMainCommit)) throw new Error("upgrade_main_commit_refused");
  const entry = await lstat(snapshotFile);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 2 * 1024 * 1024)
    throw new Error("upgrade_snapshot_file_refused");
  let record;
  try { record = JSON.parse(await readFile(snapshotFile, "utf8")); }
  catch { throw new Error("upgrade_snapshot_file_refused"); }
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).sort().join(",") !== "mainCommit,schema,snapshot"
    || record.schema !== "control-room.mac-database-upgrade-snapshot/v1"
    || record.mainCommit !== expectedMainCommit) throw new Error("upgrade_snapshot_commit_refused");
  try { return await planMacDatabaseUpgradeSnapshotV1(record.snapshot); }
  catch { throw new Error("upgrade_snapshot_content_refused"); }
}

export async function prepareMacLocalDatabaseUpgradeV1(options) {
  const { configRoot, passwordRoot, oldRoles } = await existingUpgradeConfiguration(options.protectedRoot);
  if (oldRoles.publisher) throw new Error("upgrade_already_finished");
  const mainCommit = options.mainCommit ?? await currentMainCommit();
  if (!/^[a-f0-9]{40}$/u.test(mainCommit)) throw new Error("upgrade_main_commit_refused");
  const password = await privateText(join(passwordRoot, `${roleNames.publisher}.txt`), newPassword);
  const salt = randomBytes(16);
  const verifier = postgresScramVerifierV1(password, salt);
  const verifierDigest = createHash("sha256").update(verifier).digest("hex");
  await writePrivate(join(configRoot, "database-upgrade-prepare.json"),
    `${JSON.stringify({ schema: "control-room.mac-database-upgrade-prepare/v1", mainCommit,
      salt: salt.toString("base64"), verifierDigest })}\n`);
  return { mainCommit, verifier };
}

async function verifyPublisherLogin(configuration) {
  const options = privatePostgresOptions(configuration);
  const client = new Client({ host: options.host, port: options.port, database: options.database,
    user: options.username, password: options.password, ssl: options.ssl === false ? false : options.ssl,
    connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await client.query("SELECT current_user = 'control_room_publisher' AS matches");
    if (result.rows[0]?.matches !== true) throw new Error("upgrade_publisher_login_refused");
  } finally { await client.end().catch(() => {}); }
}

export async function finishMacLocalDatabaseUpgradeV1(options) {
  const { configRoot, passwordRoot, roleFile, oldRoles } = await existingUpgradeConfiguration(options.protectedRoot);
  const mainCommit = options.mainCommit ?? await currentMainCommit();
  const prepared = await readProtectedJson(join(configRoot, "database-upgrade-prepare.json"));
  if (prepared.schema !== "control-room.mac-database-upgrade-prepare/v1"
    || prepared.mainCommit !== mainCommit || !/^[a-f0-9]{64}$/u.test(prepared.verifierDigest)
    || typeof prepared.salt !== "string" || !/^[A-Za-z0-9+/=]{24}$/u.test(prepared.salt)
    || Buffer.from(prepared.salt, "base64").length !== 16)
    throw new Error("upgrade_prepare_record_refused");
  const password = await readPrivatePassword(join(passwordRoot, `${roleNames.publisher}.txt`));
  const verifier = checkedPostgresScramVerifierV1(postgresScramVerifierV1(password, Buffer.from(prepared.salt, "base64")));
  if (createHash("sha256").update(verifier).digest("hex") !== prepared.verifierDigest)
    throw new Error("upgrade_prepare_record_refused");
  const publisher = validatePrivatePostgresConfiguration({ ...oldRoles.web,
    username: roleNames.publisher, password });
  await (options.verifyPublisher ?? verifyPublisherLogin)(publisher);
  const nextRoles = { ...oldRoles, publisher };
  captureMacLocalDatabaseRolesV1(nextRoles);
  if (!oldRoles.publisher) await writePrivate(roleFile, `${JSON.stringify(nextRoles)}\n`);
  return { finished: true, mainCommit };
}

/** The protected `mac-local.json` record the provisioner writes. Pure: it
 * validates the record exactly as the loader will read it back, and stores the
 * plain enablement material. The enablement digest is derived on every load,
 * never stored. */
export function captureProvisionedMacLocalConfigurationV1({ database, ownerCode, workers }) {
  const enablementMaterial = Object.freeze({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers });
  const macLocal = { schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local",
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local",
      provider: "local-owner", subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 28_800 },
    database, enablement: enablementMaterial };
  captureMacLocalProtectedConfigurationV1(JSON.parse(JSON.stringify(macLocal)));
  return macLocal;
}

export async function provisionMacLocalDatabaseV1(options) {
  if (options.repointOnly) return repointOnly(options);
  const protectedRoot = requireAbsolute(options.protectedRoot, "provision_protected_root_required");
  const databaseHost = options.databaseHost;
  const databasePort = options.databasePort ?? 5432;
  if (!options.vpsOnly && (typeof databaseHost !== "string" || !databaseHost || !Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65535))
    throw new Error("provision_database_endpoint_invalid");
  if (typeof options.sshTarget !== "string" || !/^[A-Za-z0-9_.@-]{1,253}$/u.test(options.sshTarget))
    throw new Error("provision_ssh_target_invalid");
  if (typeof options.remoteWorktree !== "string" || !isAbsolute(options.remoteWorktree) || resolve(options.remoteWorktree) !== options.remoteWorktree)
    throw new Error("provision_remote_worktree_invalid");
  const configRoot = join(protectedRoot, "config"), passwordRoot = join(configRoot, "database-passwords");
  if (!options.dryRun) {
    await privateDirectory(protectedRoot); await privateDirectory(configRoot); await privateDirectory(passwordRoot);
  }
  const allPasswords = {};
  for (const [key, name] of Object.entries({ ...bootstrapRoles, ...roleNames }))
    allPasswords[key] = options.dryRun ? newPassword() : await privateText(join(passwordRoot, `${name}.txt`), newPassword);
  const endpoint = options.vpsOnly ? undefined : await endpointPolicy(databaseHost, databasePort, "control_room", options.endpointPolicyFile);
  if (options.vpsOnly && options.endpointPolicyFile !== undefined) throw new Error("provision_vps_only_endpoint_policy_refused");
  if (options.vpsOnly) {
    if (!options.dryRun) await runRemoteProvision({ sshTarget: options.sshTarget, remoteWorktree: options.remoteWorktree,
      passwords: { migrator: allPasswords.migrator, application: allPasswords.application, scheduler: allPasswords.scheduler,
        local: Object.fromEntries(Object.entries(roleNames).map(([key, name]) => [name, allPasswords[key]])) } });
    return Object.freeze({ provisioned: !options.dryRun, protectedRoot, workers: [] });
  }
  const workers = await Promise.all(["codex", "claude", "hermes"].map(async kind => {
    const executable = await findExecutable(kind);
    return Object.freeze({ workerId: `worker:${kind}:mac-1`, kind: kind === "claude" ? "claude-code" : kind,
      ...executable });
  }));
  if (!options.dryRun) await runRemoteProvision({ sshTarget: options.sshTarget, remoteWorktree: options.remoteWorktree,
    passwords: { migrator: allPasswords.migrator, application: allPasswords.application, scheduler: allPasswords.scheduler,
      local: Object.fromEntries(Object.entries(roleNames).map(([key, name]) => [name, allPasswords[key]])) } });
  const database = Object.freeze({ host: databaseHost, port: databasePort, database: "control_room", username: roleNames.web,
    password: allPasswords.web, majorVersion: 17, ...(endpoint ? { privateEndpoint: endpoint } : {}) });
  const role = username => Object.freeze({ ...database, username, password: allPasswords[Object.keys(roleNames).find(key => roleNames[key] === username)] });
  const roles = captureMacLocalDatabaseRolesV1({ schema: MAC_LOCAL_DATABASE_ROLES_V1, web: role(roleNames.web), coordinator: role(roleNames.coordinator),
    results: role(roleNames.results), publisher: role(roleNames.publisher), queueWorker: role(roleNames.queueWorker) });
  const ownerCode = await privateText(join(configRoot, "owner-sign-in.txt"), newPassword);
  const macLocal = captureProvisionedMacLocalConfigurationV1({ database, ownerCode, workers });
  if (!options.dryRun) {
    await writePrivate(join(configRoot, "database-roles.json"), `${JSON.stringify(roles)}\n`);
    await writePrivate(join(configRoot, "mac-local.json"), `${JSON.stringify(macLocal)}\n`);
  }
  return Object.freeze({ provisioned: !options.dryRun, protectedRoot, workers: workers.map(worker => worker.kind) });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const supplied = process.argv.slice(2);
    const args = supplied[0] === "--" ? supplied.slice(1) : supplied;
    const dryRun = args.includes("--dry-run"), vpsOnly = args.includes("--vps-only"),
      repointOnly = args.includes("--repoint-only"), upgrade = args.includes("--upgrade");
    if (upgrade) {
      const mode = ["--dry-run", "--prepare", "--finish"].filter(flag => args.includes(flag));
      const consumed = new Set();
      for (let index = 0; index < args.length; index += 1) {
        const flag = args[index];
        if (!["--upgrade", "--dry-run", "--prepare", "--finish", "--protected-root", "--snapshot-file"].includes(flag)
          || consumed.has(flag)) throw new Error("upgrade_arguments_refused");
        consumed.add(flag);
        if (["--protected-root", "--snapshot-file"].includes(flag)) index += 1;
      }
      if (vpsOnly || repointOnly || mode.length !== 1
        || (dryRun ? !consumed.has("--snapshot-file") || consumed.has("--protected-root")
          : !consumed.has("--protected-root") || consumed.has("--snapshot-file")))
        throw new Error("upgrade_arguments_refused");
      const result = dryRun
        ? await planMacDatabaseUpgradeFromFileV1(argument(args, "--snapshot-file"), await currentMainCommit())
        : mode[0] === "--prepare"
          ? await prepareMacLocalDatabaseUpgradeV1({ protectedRoot: argument(args, "--protected-root") })
          : await finishMacLocalDatabaseUpgradeV1({ protectedRoot: argument(args, "--protected-root") });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (repointOnly) {
      const protectedRoot = parseRepointArgumentsV1(args);
      let status;
      try { status = JSON.parse((await exec("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })).stdout); }
      catch { throw new Error("provision_tailscale_status_refused"); }
      const evidenceText = await readFile(join(repoRoot, "docs/claude/SECURE_DB_ROUTE.md"), "utf8");
      const route = macLocalRouteFromTailscaleStatusV1(status, evidenceText);
      const result = await provisionMacLocalDatabaseV1({ repointOnly: true, protectedRoot, route });
      process.stdout.write(`${JSON.stringify({ repointed: result.repointed })}\n`);
    } else {
      const result = await provisionMacLocalDatabaseV1({ protectedRoot: argument(args, "--protected-root"), sshTarget: argument(args, "--ssh-target"),
        databaseHost: argument(args, "--database-host"), databasePort: Number(argument(args, "--database-port", "5432")),
        endpointPolicyFile: argument(args, "--endpoint-policy-file", undefined), remoteWorktree: argument(args, "--remote-worktree", "/root/agent-control-room"), dryRun, vpsOnly });
      process.stdout.write(`${JSON.stringify({ provisioned: result.provisioned, workers: result.workers })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error && /^(?:provision_|upgrade_)/u.test(error.message) ? error.message : usage()}\n`);
    process.exitCode = 1;
  }
}
