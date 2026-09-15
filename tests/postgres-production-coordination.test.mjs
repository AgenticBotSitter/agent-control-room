// Live-cluster proofs for the #200 correction package on a disposable
// PostgreSQL 17 cluster. Never touches an existing database: initdb into a
// temp dir, socket-only, --auth-host=reject. Needs the PG 17 bin directory
// (PG_BIN or the Debian default); skips gracefully without it, like the
// other production-lane files.
//
// Two proofs live here because PGlite cannot provide them:
//  1. The real private-web role (not SET ROLE in-process) performs an
//     allowed idempotency-ledger lifecycle step and cannot exceed its
//     column-scoped authority.
//  2. A REPEATABLE READ snapshot hides a concurrent commit (barrier test
//     with two connections), while READ COMMITTED shows it — pinning why
//     the page-composition snapshot must be repeatable-read.
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { privateWebInsertColumns } from "../src/web/v1/private-database-preflight.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.PG_BIN ?? "/usr/lib/postgresql/17/bin";
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined : { skip: "needs PostgreSQL 17 binaries (PG_BIN or /usr/lib/postgresql/17/bin)" };
const PORT = 65435;
const exec = promisify(execFile);

let run = "", socket = "", data = "";
const target = (database, user = "fixture_admin") =>
  ({ host: socket, port: PORT, database, user, password: "fixture_only" });
const adminDb = () => target("postgres");
const passwords = { CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24), CONTROL_ROOM_APP_PASSWORD: "a".repeat(24), CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24) };
const bootstrapTarget = (database) => target(database, "fixture_admin");
const migrateTarget = (database) => ({ host: socket, port: PORT, database,
  user: "control_room_migrator", password: passwords.CONTROL_ROOM_MIGRATOR_PASSWORD });

const ROOT_UID = 0;
const POSTGRES_UID = 102;
const POSTGRES_GID = 105;
const native = (name, args) => {
  const runAsPostgres = process.getuid?.() === ROOT_UID;
  const binaryPath = join(BIN, name);
  const command = runAsPostgres && ["initdb", "pg_ctl", "postgres"].includes(name)
    ? ["setpriv", `--reuid=${POSTGRES_UID}`, `--regid=${POSTGRES_GID}`, "--clear-groups", binaryPath, ...args]
    : [binaryPath, ...args];
  return exec(command[0], command.slice(1),
    { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run, NODE_ENV: "test" }, timeout: 60000, maxBuffer: 1 << 26 });
};

async function query(tgt, sql, params = []) {
  const { connectTarget } = await import("../deploy/postgres/evidence.mjs");
  const client = connectTarget(tgt);
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const open = async (tgt) => {
  const client = new Client({ host: tgt.host, port: tgt.port, database: tgt.database, user: tgt.user, password: tgt.password });
  await client.connect();
  return client;
};

before(async () => {
  if (!PG_AVAILABLE) return;
  run = await mkdtemp(join(tmpdir(), "cr-pg200-"));
  socket = join(run, "socket");
  data = join(run, "data");
  await mkdir(socket, { mode: 0o700, recursive: true });
  if (process.getuid?.() === ROOT_UID) {
    await exec("chown", ["-R", `${POSTGRES_UID}:${POSTGRES_GID}`, run]);
  }
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "fixture_admin", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
  await native("pg_ctl", ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "30", "-o",
    `-k ${socket} -p ${PORT} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20`, "start"]);
  await query(adminDb(), `CREATE DATABASE "cr_prod_coord200" OWNER fixture_admin`);
  await applyMigrations({ target: target("cr_prod_coord200"), bootstrapTarget: bootstrapTarget("cr_prod_coord200"),
    migrateTarget: migrateTarget("cr_prod_coord200"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  // The exact production role SQL under review — no test-local substitute.
  const roleSql = await readFile(join(ROOT, "db/roles/private_web_roles.sql"), "utf8");
  await query(target("cr_prod_coord200"), roleSql);
  await query(target("cr_prod_coord200"),
    `CREATE LOGIN coord_web_200 WITH PASSWORD 'w200-${"x".repeat(16)}' IN ROLE control_room_private_web`);
  await query(target("cr_prod_coord200"),
    `INSERT INTO tenants(id, display_name) VALUES('tenant:test','Role proof tenant')`);
});

after(async () => {
  if (!PG_AVAILABLE || !run) return;
  try {
    await native("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});

const webTarget = () => ({ host: socket, port: PORT, database: "cr_prod_coord200",
  user: "coord_web_200", password: `w200-${"x".repeat(16)}` });
const DIGEST = (ch) => `sha256:${ch.repeat(64)}`;

test("restricted login runs the idempotency lifecycle and cannot exceed column authority", needsPg, async () => {
  // Allowed five-column insert as the restricted login.
  await query(webTarget(), `INSERT INTO control_idempotency(tenant_id,operation_scope,idempotency_key,request_digest,status)
    VALUES('tenant:test','project-coordinator-lifecycle','web-key-1',$1,'processing')`, [DIGEST("a")]);
  // Smuggling result/completed_at into a fresh receipt is refused (42501).
  await assert.rejects(
    query(webTarget(), `INSERT INTO control_idempotency(tenant_id,operation_scope,idempotency_key,request_digest,status,result)
      VALUES('tenant:test','project-coordinator-lifecycle','web-key-2',$1,'processing','{}')`, [DIGEST("b")]),
    /permission denied/i);
  // Completion update on the granted columns works.
  await query(webTarget(), `UPDATE control_idempotency SET status='completed',result='{}',completed_at=now()
    WHERE tenant_id='tenant:test' AND operation_scope='project-coordinator-lifecycle' AND idempotency_key='web-key-1'`);
  // Rewriting the request digest or key scope does not.
  await assert.rejects(
    query(webTarget(), `UPDATE control_idempotency SET request_digest=$1
      WHERE tenant_id='tenant:test' AND idempotency_key='web-key-1'`, [DIGEST("c")]),
    /permission denied/i);
  // Tenant lock read works; tenant mutation and deletes do not.
  await query(webTarget(), `SELECT id FROM tenants WHERE id='tenant:test' FOR UPDATE`);
  await assert.rejects(
    query(webTarget(), `UPDATE tenants SET display_name='x' WHERE id='tenant:test'`),
    /permission denied/i);
  await assert.rejects(
    query(webTarget(), `DELETE FROM control_idempotency WHERE idempotency_key='web-key-1'`),
    /permission denied/i);
  // Out-of-scope ledgers stay invisible.
  await assert.rejects(
    query(webTarget(), `SELECT * FROM control_room_schema_migrations`),
    /permission denied/i);
});

test("preflight insert-column map matches the granted idempotency columns", needsPg, async () => {
  assert.deepEqual([...privateWebInsertColumns["control_idempotency"]].sort(),
    ["idempotency_key", "operation_scope", "request_digest", "status", "tenant_id"]);
  // And the database agrees: exactly these five columns carry INSERT.
  const rows = (await query(target("cr_prod_coord200"),
    `SELECT a.attname AS column_name, has_column_privilege('control_room_private_web', c.oid, a.attname, 'INSERT') AS can_insert
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public' AND c.relname = 'control_idempotency' AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY 1`)).rows;
  assert.deepEqual(rows.filter((r) => r.can_insert).map((r) => r.column_name),
    ["idempotency_key", "operation_scope", "request_digest", "status", "tenant_id"]);
});

test("repeatable-read snapshot hides a concurrent commit; read-committed shows it", needsPg, async () => {
  const seedRow = (id) => query(target("cr_prod_coord200"),
    `INSERT INTO attention_items(id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,
     source_version,attention_type,title,summary,due_at,created_at_source,observed_at,payload,updated_at)
     VALUES($1,'tenant:test','workspace:test','project:alpha',NULL,'adapter:test','seed','1','approval','T','S',NULL,now(),now(),'{}',now())`,
    [id]);
  await seedRow("attn-barrier-0");
  const readIds = async (client) => (await client.query(
    `SELECT id FROM attention_items WHERE tenant_id='tenant:test' AND project_id='project:alpha' ORDER BY 1`)).rows.map((r) => r.id);

  // Barrier case: A holds a repeatable-read snapshot across B's commit.
  const connA = await open(target("cr_prod_coord200"));
  const connB = await open(target("cr_prod_coord200"));
  try {
    await connA.query("BEGIN");
    await connA.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    assert.deepEqual(await readIds(connA), ["attn-barrier-0"]);
    await connB.query(`INSERT INTO attention_items(id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,
      source_version,attention_type,title,summary,due_at,created_at_source,observed_at,payload,updated_at)
      VALUES('attn-barrier-1','tenant:test','workspace:test','project:alpha',NULL,'adapter:test','seed','1','approval','T','S',NULL,now(),now(),'{}',now())`);
    // A still sees the old snapshot: old content pairs with the old version
    // the page already computed — never old content with a new version.
    assert.deepEqual(await readIds(connA), ["attn-barrier-0"]);
    await connA.query("COMMIT");
  } finally {
    await connA.end();
    await connB.end();
  }

  // Control case: without repeatable read the same interleave is visible,
  // which is exactly the mixed pairing the page snapshot must prevent.
  const connC = await open(target("cr_prod_coord200"));
  const connD = await open(target("cr_prod_coord200"));
  try {
    await connC.query("BEGIN");
    assert.deepEqual(await readIds(connC), ["attn-barrier-0", "attn-barrier-1"]);
    await connD.query(`INSERT INTO attention_items(id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,
      source_version,attention_type,title,summary,due_at,created_at_source,observed_at,payload,updated_at)
      VALUES('attn-barrier-2','tenant:test','workspace:test','project:alpha',NULL,'adapter:test','seed','1','approval','T','S',NULL,now(),now(),'{}',now())`);
    assert.deepEqual(await readIds(connC), ["attn-barrier-0", "attn-barrier-1", "attn-barrier-2"]);
    await connC.query("COMMIT");
  } finally {
    await connC.end();
    await connD.end();
  }
});
