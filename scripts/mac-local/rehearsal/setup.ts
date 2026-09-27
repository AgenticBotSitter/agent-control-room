// Local rehearsal database: a throwaway PostgreSQL 17 cluster on 127.0.0.1 with the full
// migration ledger, the five Mac-local roles, and a protected root pointing at it.
// Never points at the VPS. Usage: pnpm mac:rehearsal up|down ABSOLUTE_DIR [--port 15499]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../../../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../../../deploy/postgres/evidence.mjs";
import { sha256Digest } from "../../../src/security/canonical-digest";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1, captureMacLocalProtectedConfigurationV1 } from "../../../src/web/v1/mac-local-protected-configuration";
import { captureMacLocalDatabaseRolesV1, MAC_LOCAL_DATABASE_ROLES_V1 } from "../../../src/web/v1/mac-local-database-roles";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../../../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../../../src/harness/v1/owner-trusted-local-enablements";
import { readPinnedMacExecutableVersion } from "../start-web-host.mjs";
import { captureWorkIntakeClientConfigurationV1, captureWorkIntakeServerConfigurationV1,
  workIntakeClientFileNameV1, workIntakeIdentityIdV1,
  WORK_INTAKE_CLIENT_CONFIGURATION_V1, WORK_INTAKE_SERVER_CONFIGURATION_V1 } from
  "../../../src/work-intake/v1/installed-configuration";

const [action, dir] = process.argv.slice(2);
const portIndex = process.argv.indexOf("--port");
const port = portIndex === -1 ? 15499 : Number(process.argv[portIndex + 1]);
const webPortIndex = process.argv.indexOf("--web-port");
const webPort = webPortIndex === -1 ? 3217 : Number(process.argv[webPortIndex + 1]);
const fakeExecutables = process.argv.includes("--fake-executables");
if (!["up", "down"].includes(action) || !dir || !isAbsolute(dir) || !Number.isInteger(port)
  || !Number.isInteger(webPort) || webPort < 1024 || webPort > 65534 || webPort === port || webPort + 1 === port) {
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
const bounded = { env, stdio: "ignore" as const, timeout: 120_000, killSignal: "SIGKILL" as const };
const pgctl = (...args: string[]) => execFileSync(pgExecutable("pg_ctl"), ["-D", pg, ...args], bounded);
let clusterStarted = false;
let keepCluster = false;
let stopping = false;

function stopStartedCluster() {
  if (!clusterStarted || stopping) return;
  stopping = true;
  try { pgctl("stop", "-m", "fast"); } catch { /* Preserve the original setup or signal failure. */ }
  clusterStarted = false;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  keepCluster = false;
  stopStartedCluster();
  process.exit(signal === "SIGINT" ? 130 : 143);
});
process.once("exit", () => { if (!keepCluster) stopStartedCluster(); });

if (action === "down") {
  if (existsSync(pg)) {
    let running = false;
    try { pgctl("status"); running = true; }
    catch { /* An already-stopped disposable cluster is the requested state. */ }
    if (running) pgctl("stop", "-m", "fast");
  }
  console.log("rehearsal database stopped (data kept; delete the directory to discard)");
  process.exit(0);
}

const fresh = !existsSync(pg);
try {
  if (fresh) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync(pgExecutable("initdb"), ["-D", pg, "-U", "postgres", "--auth=trust", "-E", "UTF8"], bounded);
    writeFileSync(join(pg, ".control-room-disposable-postgres.json"), `${JSON.stringify({
      schema: "control-room.disposable-postgres/v1", createdBy: "mac-local-rehearsal",
    })}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(join(pg, "pg_hba.conf"), "host all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n");
  }
  pgctl("-l", join(dir, "pg.log"), "-w", "-o", `-p ${port} -k '' -c listen_addresses=127.0.0.1`, "start");
  clusterStarted = true;
  if (!fresh) {
    keepCluster = true;
    console.log(`rehearsal database running on 127.0.0.1:${port}; protected root ${join(dir, "protected")}`);
    process.exit(0);
  }

execFileSync(pgExecutable("psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "dbname=control_room",
  "-f", fileURLToPath(new URL("../../../deploy/postgres/provision-database.sql", import.meta.url))], bounded);
const pw = () => randomBytes(24).toString("base64url");
const secrets = { migrator: pw(), application: pw(), scheduler: pw(), workIntake: pw() };
const local: Record<string, string> = { control_room_web: pw(), control_room_coordinator: pw(), control_room_results: pw(), control_room_publisher: pw(), control_room_queue_worker: pw() };
const bootstrapTarget = `host=127.0.0.1 port=${port} dbname=control_room user=postgres`;
await applyMigrations({ target: bootstrapTarget, rootDir: process.cwd(),
  ledgerPath: fileURLToPath(new URL("../../../deploy/postgres/migration-ledger.json", import.meta.url)),
  bootstrapTarget,
  migrateTarget: `host=127.0.0.1 port=${port} dbname=control_room user=control_room_migrator password=${secrets.migrator}`,
  env: { NODE_ENV: "test", CONTROL_ROOM_MIGRATOR_PASSWORD: secrets.migrator,
    CONTROL_ROOM_APP_PASSWORD: secrets.application, CONTROL_ROOM_SCHEDULER_PASSWORD: secrets.scheduler,
    CONTROL_ROOM_WORK_INTAKE_PASSWORD: secrets.workIntake } });
const psql = (database: string, file: string) => execFileSync(pgExecutable("psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", database,
  "-v", "ON_ERROR_STOP=1", "-f", fileURLToPath(new URL(file, import.meta.url))], bounded);
// Match the reviewed package-5 sequence against this fresh disposable cluster.
// applyMigrations installs the production roles as part of bootstrap; rerunning
// this idempotent file here makes the rehearsal's ordering explicit.
psql("control_room", "../../../db/roles/production_roles.sql");
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
psql("control_room", "../../../db/roles/private_web_database.sql");
for (const file of ["private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
  "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql"])
  psql("control_room", `../../../db/roles/${file}`);
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
const clients = workers.map(worker => ({ worker, client: captureWorkIntakeClientConfigurationV1({
  schema: WORK_INTAKE_CLIENT_CONFIGURATION_V1, origin: `http://127.0.0.1:${webPort + 1}`,
  bearerSecret: randomBytes(32).toString("base64url") }) }));
const credentialStart=new Date(),credentialEnd=new Date(credentialStart.getTime()+8*60*60*1000);
const workIntake = captureWorkIntakeServerConfigurationV1({ schema: WORK_INTAKE_SERVER_CONFIGURATION_V1,
  port: webPort + 1, database: { ...database, username: "control_room_work_intake_agent", password: secrets.workIntake },
  integrityKey: randomBytes(32).toString("base64url"), queueDepthLimit: 10,
  credentials: clients.map(({ worker, client }) => ({ workerId:worker.workerId,workerKind:worker.kind,
    credentialDigest: sha256Digest(client.bearerSecret),
    principal: { tenantId: "tenant:mac-local",
      identityId: workIntakeIdentityIdV1("tenant:mac-local",worker.workerId), actorType: "agent",
      authenticatedAt: credentialStart.toISOString(), expiresAt: credentialEnd.toISOString() } })) });
for (const [file, body] of [["mac-local.json", JSON.stringify(macLocal)], ["database-roles.json", JSON.stringify(roles)],
  ["work-intake-server.json", JSON.stringify(workIntake)], ["owner-sign-in.txt", ownerCode]])
  writeFileSync(join(config, file), `${body}\n`, { mode: 0o600 });
const clientRoot=join(config,"work-intake-clients"); mkdirSync(clientRoot,{recursive:true,mode:0o700});
for(const {worker,client} of clients) writeFileSync(join(clientRoot,workIntakeClientFileNameV1(worker.workerId)),`${JSON.stringify(client)}\n`,{mode:0o600});
console.log(`rehearsal database ready on 127.0.0.1:${port}; protected root ${root}`);
console.log(`next: pnpm mac:bootstrap-owner ${root} && pnpm mac:check-database ${root}`);
  keepCluster = true;
} finally {
  if (!keepCluster) stopStartedCluster();
}
