// Local rehearsal database: a throwaway PostgreSQL 17 cluster on 127.0.0.1 with the full
// migration ledger, the four Mac-local roles, and a protected root pointing at it.
// Never points at the VPS. Usage: pnpm mac:rehearsal up|down ABSOLUTE_DIR [--port 15499]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { applyMigrations } from "../../../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../../../deploy/postgres/evidence.mjs";
import { sha256Digest } from "../../../src/security/canonical-digest";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1, captureMacLocalProtectedConfigurationV1 } from "../../../src/web/v1/mac-local-protected-configuration";
import { captureMacLocalDatabaseRolesV1, MAC_LOCAL_DATABASE_ROLES_V1 } from "../../../src/web/v1/mac-local-database-roles";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../../../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../../../src/harness/v1/owner-trusted-local-enablements";
import { readPinnedMacExecutableVersion } from "../start-web-host.mjs";

const [action, dir] = process.argv.slice(2);
const portIndex = process.argv.indexOf("--port");
const port = portIndex === -1 ? 15499 : Number(process.argv[portIndex + 1]);
if (!["up", "down"].includes(action) || !dir || !isAbsolute(dir) || !Number.isInteger(port)) {
  console.error("usage: pnpm mac:rehearsal up|down ABSOLUTE_DIR [--port 15499]");
  process.exit(2);
}
const env = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
const pg = join(dir, "pg");
const bounded = { env, stdio: "ignore" as const, timeout: 120_000, killSignal: "SIGKILL" as const };
const pgctl = (...args: string[]) => execFileSync("pg_ctl", ["-D", pg, ...args], bounded);

if (action === "down") {
  if (existsSync(pg)) pgctl("stop", "-m", "fast");
  console.log("rehearsal database stopped (data kept; delete the directory to discard)");
  process.exit(0);
}

const fresh = !existsSync(pg);
if (fresh) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync("initdb", ["-D", pg, "-U", "postgres", "--auth=trust", "-E", "UTF8"], bounded);
  writeFileSync(join(pg, "pg_hba.conf"), "host all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n");
}
pgctl("-l", join(dir, "pg.log"), "-w", "-o", `-p ${port} -k '' -c listen_addresses=127.0.0.1`, "start");
if (!fresh) { console.log(`rehearsal database running on 127.0.0.1:${port}; protected root ${join(dir, "protected")}`); process.exit(0); }

execFileSync("psql", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "dbname=control_room",
  "-f", new URL("../../../deploy/postgres/provision-database.sql", import.meta.url).pathname], bounded);
const pw = () => randomBytes(24).toString("base64url");
const secrets = { migrator: pw(), application: pw(), scheduler: pw() };
const local: Record<string, string> = { control_room_web: pw(), control_room_coordinator: pw(), control_room_results: pw(), control_room_queue_worker: pw() };
const bootstrapTarget = `host=127.0.0.1 port=${port} dbname=control_room user=postgres`;
await applyMigrations({ bootstrapTarget,
  migrateTarget: `host=127.0.0.1 port=${port} dbname=control_room user=control_room_migrator password=${secrets.migrator}`,
  env: { CONTROL_ROOM_MIGRATOR_PASSWORD: secrets.migrator, CONTROL_ROOM_APP_PASSWORD: secrets.application, CONTROL_ROOM_SCHEDULER_PASSWORD: secrets.scheduler } });
const client = connectTarget(bootstrapTarget); await client.connect();
try {
  // Rehearsal-only queue installation. Production queue setup remains a
  // separate, reviewed database operation; application startup never migrates.
  await client.query(getConstructionPlans("control_room_queue"));
  const boss = new PgBoss({ db: { executeSql: (sql, values) => client.query(sql, values) },
    schema: "control_room_queue", backend: "postgres", migrate: false, createSchema: false,
    supervise: false, schedule: false, useListenNotify: false });
  await boss.start();
  try { await boss.createQueue("native-task-delivery", { retryLimit: 0 }); }
  finally { await boss.stop({ graceful: false }); }
  for (const [name, password] of Object.entries(local)) {
    if ((await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name])).rows.length === 0)
      await client.query(`CREATE ROLE ${name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await client.query(`ALTER ROLE ${name} PASSWORD ${client.escapeLiteral(password)}`);
    await client.query(`GRANT control_room_application TO ${name}`);
  }
  await client.query(`GRANT USAGE ON SCHEMA control_room_queue TO control_room_coordinator,control_room_queue_worker`);
  await client.query(`GRANT SELECT ON control_room_queue.version,control_room_queue.queue TO control_room_coordinator,control_room_queue_worker`);
  await client.query(`GRANT UPDATE(name) ON control_room_queue.queue TO control_room_coordinator`);
  await client.query(`GRANT SELECT,INSERT ON control_room_queue.job,control_room_queue.job_common TO control_room_coordinator`);
  await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON control_room_queue.job,control_room_queue.job_common TO control_room_queue_worker`);
} finally { await client.end(); }

const home = homedir(), claudeRoot = join(home, "Library/Application Support/Claude/claude-code");
const claudeVersion = readdirSync(claudeRoot).filter(v => /^\d+\.\d+\.\d+$/u.test(v))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const paths = { codex: "/Applications/ChatGPT.app/Contents/Resources/codex",
  "claude-code": join(claudeRoot, claudeVersion ?? "missing", "claude.app/Contents/MacOS/claude"),
  hermes: join(home, ".hermes/hermes-agent/venv/bin/hermes") } as const;
const workers = [];
for (const kind of ["codex", "claude-code", "hermes"] as const)
  workers.push({ workerId: `worker:${kind === "claude-code" ? "claude" : kind}:mac-1`, kind, executablePath: paths[kind],
    recordedVersion: await readPinnedMacExecutableVersion(paths[kind]) });

const root = join(dir, "protected"), config = join(root, "config");
mkdirSync(config, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700); chmodSync(config, 0o700);
const database = { host: "127.0.0.1", port, database: "control_room", username: "control_room_web", password: local.control_room_web, majorVersion: 17 };
const role = (username: string) => ({ ...database, username, password: local[username] });
const roles = { schema: MAC_LOCAL_DATABASE_ROLES_V1, web: role("control_room_web"), coordinator: role("control_room_coordinator"),
  results: role("control_room_results"), queueWorker: role("control_room_queue_worker") };
captureMacLocalDatabaseRolesV1(roles);
const ownerCode = pw() + pw();
const macLocal = { schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local",
  localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local",
    provider: "local-owner", subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 28_800 },
  database, enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers } };
captureMacLocalProtectedConfigurationV1(JSON.parse(JSON.stringify(macLocal)));
for (const [file, body] of [["mac-local.json", JSON.stringify(macLocal)], ["database-roles.json", JSON.stringify(roles)], ["owner-sign-in.txt", ownerCode]])
  writeFileSync(join(config, file), `${body}\n`, { mode: 0o600 });
console.log(`rehearsal database ready on 127.0.0.1:${port}; protected root ${root}`);
console.log(`next: pnpm mac:check-database ${root} && pnpm mac:bootstrap-owner ${root}`);
