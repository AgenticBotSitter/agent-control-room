/**
 * Owner-authorized Mac-local database provisioner.
 *
 * This is deliberately a one-shot installer helper, not part of the running
 * product. It creates no listener or worker. It creates only the fixed
 * PostgreSQL logins, applies the immutable migration ledger, and records the
 * Mac's private configuration beneath the owner-only Protected directory.
 *
 * Secrets travel to the VPS over SSH standard input and are never printed or
 * placed in command arguments. Re-runs reuse the protected password files,
 * so a retry converges rather than silently changing installed credentials.
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { sha256Digest } from "../../src/security/canonical-digest";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1 } from "../../src/web/v1/mac-local-protected-configuration";
import { captureMacLocalProtectedConfigurationV1 } from "../../src/web/v1/mac-local-protected-configuration";
import { captureMacLocalDatabaseRolesV1, MAC_LOCAL_DATABASE_ROLES_V1 } from "../../src/web/v1/mac-local-database-roles";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../../src/harness/v1/owner-trusted-local-enablements";
import { PRIVATE_POSTGRES_ENDPOINT_V1, privatePostgresEndpointFingerprintV1 } from "../../src/web/v1/private-postgres-endpoint";

const exec = promisify(execFile);
const roleNames = Object.freeze({ web: "control_room_web", coordinator: "control_room_coordinator",
  results: "control_room_results", queueWorker: "control_room_queue_worker" });
const bootstrapRoles = Object.freeze({ migrator: "control_room_migrator", application: "control_room_app",
  scheduler: "control_room_scheduler" });
const passwordPattern = /^[A-Za-z0-9_-]{32,}$/u;
const privateMode = 0o700;
const privateFileMode = 0o600;
// A database provision is intentionally bounded. SSH itself has a connection
// deadline below; this covers a connected remote command that stalls while
// fetching, preparing dependencies, or applying the ledger. The VPS command
// has a slightly shorter independent deadline so a dropped SSH client cannot
// leave a second password-changing provision running remotely.
const remoteProvisionTimeoutMs = 5 * 60_000;

function usage() {
  return "Usage: pnpm mac:provision-database --protected-root ABSOLUTE_PATH --ssh-target USER@HOST --database-host HOST [--database-port 5432] [--endpoint-policy-file ABSOLUTE_PATH] [--remote-worktree ABSOLUTE_PATH] [--vps-only] [--dry-run]";
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

function newPassword() { return randomBytes(32).toString("base64url"); }

/** CLI version commands sometimes include ordinary installation details after
 * their version. Capture one bounded, printable version-looking line rather
 * than treating a current multi-line CLI as a source-version incompatibility. */
export function recordedExecutableVersion(stdout) {
  const lines = stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const version = lines.find(line => /(?:^|\s)(?:v?\d+\.\d+|version\b)/iu.test(line));
  if (!version || version.length > 240 || /[\u0000-\u001f\u007f]/u.test(version))
    throw new Error("provision_invalid_executable_version");
  return version;
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
  if (!parsed || typeof parsed !== "object" || parsed.schema !== PRIVATE_POSTGRES_ENDPOINT_V1
    || parsed.endpointFingerprint !== endpointFingerprint) throw new Error("provision_endpoint_policy_refused");
  return parsed;
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
  for (const [name, password] of Object.entries(value.local)) {
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name]);
    if (existing.rows.length === 0)
      await client.query('CREATE ROLE ' + name + ' LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('ALTER ROLE ' + name + ' PASSWORD ' + client.escapeLiteral(password));
    await client.query('GRANT control_room_application TO ' + name);
  }
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

export async function provisionMacLocalDatabaseV1(options) {
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
    results: role(roleNames.results), queueWorker: role(roleNames.queueWorker) });
  const ownerCode = await privateText(join(configRoot, "owner-sign-in.txt"), newPassword);
  const enablementMaterial = Object.freeze({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers });
  // The capture function creates and validates the digest from this material;
  // callers must not supply a digest that could claim to describe itself.
  const macLocal = captureMacLocalProtectedConfigurationV1({ schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local",
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local",
      provider: "local-owner", subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 28_800 },
    database, enablement: enablementMaterial });
  if (!options.dryRun) {
    await writePrivate(join(configRoot, "database-roles.json"), `${JSON.stringify(roles)}\n`);
    await writePrivate(join(configRoot, "mac-local.json"), `${JSON.stringify(macLocal)}\n`);
  }
  return Object.freeze({ provisioned: !options.dryRun, protectedRoot, workers: workers.map(worker => worker.kind) });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const args = process.argv.slice(2), dryRun = args.includes("--dry-run"), vpsOnly = args.includes("--vps-only");
    const result = await provisionMacLocalDatabaseV1({ protectedRoot: argument(args, "--protected-root"), sshTarget: argument(args, "--ssh-target"),
      databaseHost: argument(args, "--database-host"), databasePort: Number(argument(args, "--database-port", "5432")),
      endpointPolicyFile: argument(args, "--endpoint-policy-file", undefined), remoteWorktree: argument(args, "--remote-worktree", "/root/agent-control-room"), dryRun, vpsOnly });
    process.stdout.write(`${JSON.stringify({ provisioned: result.provisioned, workers: result.workers })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error && error.message.startsWith("provision_") ? error.message : usage()}\n`);
    process.exitCode = 1;
  }
}
