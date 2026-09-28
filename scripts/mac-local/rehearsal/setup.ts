// Local rehearsal database: a throwaway PostgreSQL 17 cluster on 127.0.0.1 with the full
// migration ledger, the five Mac-local roles, and a protected root pointing at it.
// Never points at the VPS. Usage: pnpm mac:rehearsal up|down ABSOLUTE_DIR [--port 15499]
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../../../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../../../deploy/postgres/evidence.mjs";
import { sha256Digest } from "../../../src/security/canonical-digest";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1, captureMacLocalProtectedConfigurationV1 } from "../../../src/web/v1/mac-local-protected-configuration";
import { captureMacLocalDatabaseRolesV1, MAC_LOCAL_DATABASE_ROLES_V1 } from "../../../src/web/v1/mac-local-database-roles";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../../../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../../../src/harness/v1/owner-trusted-local-enablements";
import { readPinnedMacExecutableVersion } from "../start-web-host.mjs";
import { repoRoot } from "../stack.mjs";
import { cleanupRehearsalRoot } from "./cleanup.mjs";
import { createRehearsalOwnership, installRehearsalSignalCleanup, REHEARSAL_MARKER,
  runBoundedChild, updateRehearsalProcesses, validateRehearsalOwnership } from "./lifecycle.mjs";

const [action, dir] = process.argv.slice(2);
const portIndex = process.argv.indexOf("--port");
const port = portIndex === -1 ? 15499 : Number(process.argv[portIndex + 1]);
const webPortIndex = process.argv.indexOf("--web-port");
const webPort = webPortIndex === -1 ? 3217 : Number(process.argv[webPortIndex + 1]);
const fakeExecutables = process.argv.includes("--fake-executables");
if (!["up", "down"].includes(action) || !dir || !isAbsolute(dir) || !Number.isInteger(port)
  || !Number.isInteger(webPort) || webPort < 1024 || webPort > 65535 || webPort === port) {
  console.error("usage: pnpm mac:rehearsal up|down ABSOLUTE_DIR [--port 15499] [--web-port 3217] [--fake-executables]");
  process.exit(2);
}
const locale = process.platform === "linux" ? "C.UTF-8" : "en_US.UTF-8";
const env = { ...process.env, LC_ALL: process.env.LC_ALL || locale, LANG: process.env.LANG || locale };
const pgBin = process.env.PG_BIN;
if (pgBin !== undefined && (!isAbsolute(pgBin) || resolve(pgBin) !== pgBin)) {
  throw new Error("rehearsal_pg_bin_must_be_absolute");
}
const pgExecutable = (name: string) => pgBin ? join(pgBin, name) : name;
const pg = join(dir, "pg");
const shutdown = new AbortController();
type RehearsalProcess = { kind: "setup" | "child"; pid: number; command: readonly string[]; group: boolean };
let ownedProcesses: RehearsalProcess[] = [], ownershipReady = false;
let processUpdate = Promise.resolve();
let keepCluster = false;
const exec = promisify(execFile);
async function saveProcesses(processes: RehearsalProcess[]) {
  processUpdate = processUpdate.then(async () => {
    await updateRehearsalProcesses({ root: dir, processes }); ownedProcesses = processes;
  });
  return processUpdate;
}
async function native(command: string, args: string[], timeoutMs = 120_000) {
  let child: RehearsalProcess | undefined;
  const result = await runBoundedChild(command, args, { cwd: process.cwd(), env, timeoutMs, signal: shutdown.signal,
    async onSpawn(record) {
      const registered: RehearsalProcess = { kind: "child", ...record };
      child = registered;
      await saveProcesses([...ownedProcesses.filter(value => value.kind !== "child"), registered]);
    } });
  if (child) await saveProcesses(ownedProcesses.filter(value => value.pid !== child!.pid));
  if (result.status !== 0) throw new Error("rehearsal_native_command_failed");
  return result;
}
const pgctl = (...args: string[]) => native(pgExecutable("pg_ctl"), ["-D", pg, ...args]);

if (action === "down") {
  const result = await cleanupRehearsalRoot({ root: dir });
  if (!result.cleaned) throw new Error(`rehearsal_cleanup_failed:${result.reason}`);
  console.log("rehearsal-owned host, processes and database stopped; disposable root removed");
  process.exit(0);
}

const fresh = !existsSync(pg);
const existingOwnership = existsSync(join(dir, REHEARSAL_MARKER));
const ownership = existingOwnership
  ? (await validateRehearsalOwnership({ root: dir })).ownership
  : await createRehearsalOwnership({ root: dir, databasePort: port, webPort, repositoryRoot: repoRoot });
if (ownership.databasePort !== port || ownership.webPort !== webPort)
  throw new Error("rehearsal_ownership_port_mismatch");
ownershipReady = true;
let cleanupPromise: Promise<void> | undefined;
const cleanup = () => cleanupPromise ??= (async () => {
  shutdown.abort(); await processUpdate.catch(() => {});
  if (!ownershipReady) return;
  const result = await cleanupRehearsalRoot({ root: dir });
  if (!result.cleaned) throw new Error(`rehearsal_cleanup_failed:${result.reason}`);
  ownershipReady = false;
})();
const signals = installRehearsalSignalCleanup(cleanup);
try {
  const currentCommand = (await exec("/bin/ps", ["-ww", "-o", "command=", "-p", String(process.pid)],
    { encoding: "utf8", timeout: 10_000 })).stdout.trim();
  if (!currentCommand) throw new Error("rehearsal_setup_identity_unavailable");
  await saveProcesses([{ kind: "setup", pid: process.pid, command: [currentCommand], group: false }]);
  if (fresh) {
    await native(pgExecutable("initdb"), ["-D", pg, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
    writeFileSync(join(pg, ".control-room-disposable-postgres.json"), `${JSON.stringify({
      schema: "control-room.disposable-postgres/v1", createdBy: "mac-local-rehearsal", runId: ownership.runId,
    })}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(join(pg, "pg_hba.conf"), "host all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n");
  }
  await pgctl("-l", join(dir, "pg.log"), "-w", "-o", `-p ${port} -k '' -c listen_addresses=127.0.0.1`, "start");
  if (!fresh) {
    await saveProcesses([]);
    keepCluster = true;
    console.log(`rehearsal database running on 127.0.0.1:${port}; protected root ${join(dir, "protected")}`);
    process.exit(0);
  }

await native(pgExecutable("psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "dbname=control_room",
  "-f", fileURLToPath(new URL("../../../deploy/postgres/provision-database.sql", import.meta.url))]);
const pw = () => randomBytes(24).toString("base64url");
const secrets = { migrator: pw(), application: pw(), scheduler: pw() };
const local: Record<string, string> = { control_room_web: pw(), control_room_coordinator: pw(), control_room_results: pw(), control_room_publisher: pw(), control_room_queue_worker: pw() };
const bootstrapTarget = `host=127.0.0.1 port=${port} dbname=control_room user=postgres`;
await applyMigrations({ target: bootstrapTarget, rootDir: process.cwd(),
  ledgerPath: fileURLToPath(new URL("../../../deploy/postgres/migration-ledger.json", import.meta.url)),
  bootstrapTarget,
  migrateTarget: `host=127.0.0.1 port=${port} dbname=control_room user=control_room_migrator password=${secrets.migrator}`,
  env: { NODE_ENV: "test", CONTROL_ROOM_MIGRATOR_PASSWORD: secrets.migrator,
    CONTROL_ROOM_APP_PASSWORD: secrets.application, CONTROL_ROOM_SCHEDULER_PASSWORD: secrets.scheduler } });
const psql = (database: string, file: string) => native(pgExecutable("psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", database,
  "-v", "ON_ERROR_STOP=1", "-f", fileURLToPath(new URL(file, import.meta.url))]);
// Match the reviewed package-5 sequence against this fresh disposable cluster.
// applyMigrations installs the production roles as part of bootstrap; rerunning
// this idempotent file here makes the rehearsal's ordering explicit.
await psql("control_room", "../../../db/roles/production_roles.sql");
// The fixed pg-boss schema/queue is installed offline before either queue role.
const queueClient = connectTarget(bootstrapTarget); await queueClient.connect();
try {
  await queueClient.query(getConstructionPlans("control_room_queue"));
  const boss = new PgBoss({ db: { executeSql: (sql, values) => queueClient.query(sql, values) },
    schema: "control_room_queue", backend: "postgres", migrate: false, createSchema: false,
    supervise: false, schedule: false, useListenNotify: false });
  await boss.start();
  try { await boss.createQueue("native-task-delivery", { retryLimit: 0 }); }
  finally { await boss.stop({ graceful: false }); }
} finally { await queueClient.end(); }
await psql("control_room", "../../../db/roles/private_web_database.sql");
for (const file of ["private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
  "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql"])
  await psql("control_room", `../../../db/roles/${file}`);
const membership = connectTarget(bootstrapTarget); await membership.connect();
try {
  const roleByLogin: Record<string, string> = { control_room_web: "control_room_private_web",
    control_room_coordinator: "control_room_task_coordinator", control_room_results: "control_room_native_results",
    control_room_publisher: "control_room_local_result_publisher",
    control_room_queue_worker: "control_room_native_queue_worker" };
  for (const [login, password] of Object.entries(local)) {
    await membership.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${membership.escapeLiteral(password)}`);
    await membership.query(`GRANT ${roleByLogin[login]} TO ${login}`);
  }
} finally { await membership.end(); }

let paths: Readonly<Record<"codex" | "claude-code" | "hermes", string>>;
if (fakeExecutables) {
  const fakeRoot = join(dir, "setup-fake-workers");
  mkdirSync(fakeRoot, { recursive: true, mode: 0o700 });
  paths = Object.freeze({ codex: join(fakeRoot, "codex"), "claude-code": join(fakeRoot, "claude"), hermes: join(fakeRoot, "hermes") });
  for (const [kind, path] of Object.entries(paths)) {
    writeFileSync(path, `#!/bin/sh\n[ "$1" = "--version" ] || exit 64\nprintf '%s\\n' '${kind} 1.0.0'\n`, { mode: 0o700, flag: "wx" });
    chmodSync(path, 0o700);
  }
} else {
  if (process.platform !== "darwin") throw new Error("rehearsal_real_executables_require_macos");
  const home = homedir(), claudeRoot = join(home, "Library/Application Support/Claude/claude-code");
  const claudeVersion = readdirSync(claudeRoot).filter(v => /^\d+\.\d+\.\d+$/u.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const codexCandidates = ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex"];
  const codexPath = codexCandidates.find(path => existsSync(path));
  if (!codexPath) throw new Error("rehearsal_codex_executable_missing");
  paths = Object.freeze({ codex: codexPath,
    "claude-code": join(claudeRoot, claudeVersion ?? "missing", "claude.app/Contents/MacOS/claude"),
    hermes: join(home, ".hermes/hermes-agent/venv/bin/hermes") });
}
const workers = [];
for (const kind of ["codex", "claude-code", "hermes"] as const)
  workers.push({ workerId: `worker:${kind === "claude-code" ? "claude" : kind}:mac-1`, kind, executablePath: paths[kind],
    recordedVersion: await readPinnedMacExecutableVersion(paths[kind]) });

const root = join(dir, "protected"), config = join(root, "config");
mkdirSync(config, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700); chmodSync(config, 0o700);
const database = { host: "127.0.0.1", port, database: "control_room", username: "control_room_web", password: local.control_room_web, majorVersion: 17 };
const role = (username: string) => ({ ...database, username, password: local[username] });
const roles = { schema: MAC_LOCAL_DATABASE_ROLES_V1, web: role("control_room_web"), coordinator: role("control_room_coordinator"),
  results: role("control_room_results"), publisher: role("control_room_publisher"), queueWorker: role("control_room_queue_worker") };
captureMacLocalDatabaseRolesV1(roles);
const ownerCode = pw() + pw();
const macLocal = { schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: webPort, workspaceId: "workspace:mac-local",
  localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: `http://127.0.0.1:${webPort}`, tenantId: "tenant:mac-local",
    provider: "local-owner", subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 28_800 },
  database, enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers } };
captureMacLocalProtectedConfigurationV1(JSON.parse(JSON.stringify(macLocal)));
for (const [file, body] of [["mac-local.json", JSON.stringify(macLocal)], ["database-roles.json", JSON.stringify(roles)], ["owner-sign-in.txt", ownerCode]])
  writeFileSync(join(config, file), `${body}\n`, { mode: 0o600 });
console.log(`rehearsal database ready on 127.0.0.1:${port}; protected root ${root}`);
console.log(`next: pnpm mac:bootstrap-owner ${root} && pnpm mac:check-database ${root}`);
  await saveProcesses([]);
  keepCluster = true;
} finally {
  signals.dispose();
  if (!keepCluster) await cleanup();
}
