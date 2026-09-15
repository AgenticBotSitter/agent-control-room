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
import { sha256Digest } from "../src/security/digest.ts";
import {
  ProjectCoordinationHttpService,
  createProjectCoordinationCanonicalStoreAdapterV1,
} from "../src/web/v1/project-coordination-http.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_BINS = [process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"]
  .filter(Boolean);
const BIN = CANDIDATE_BINS.find((dir) => existsSync(join(dir, "initdb")) && existsSync(join(dir, "postgres")))
  ?? "/usr/lib/postgresql/17/bin";
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined : { skip: "needs PostgreSQL 17 binaries (PG_BIN, /opt/homebrew/opt/postgresql@17/bin, or /usr/lib/postgresql/17/bin)" };
const PORT = 65437;
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
    `CREATE ROLE coord_web_200 WITH LOGIN PASSWORD 'w200-${"x".repeat(16)}' IN ROLE control_room_private_web`);
  await query(target("cr_prod_coord200"),
    `INSERT INTO tenants(id, display_name) VALUES('tenant:test','Role proof tenant')`);
  // Seeds the barrier/page tests need: attention rows reference the
  // workspace, project, and adapter; the page path needs a live project
  // head plus an authorized owner identity with a live session.
  await query(target("cr_prod_coord200"),
    `INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Test workspace')`);
  await query(target("cr_prod_coord200"),
    `INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
     VALUES('adapter:test','tenant:test','control-room-manual','1.0.0','control_room_native','disabled','v1',30)`);
  await query(target("cr_prod_coord200"),
    `INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
     normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
     VALUES('project:alpha','tenant:test','workspace:test','adapter:test','project:alpha','1','Alpha','Seed',
     'running','seed','healthy','control_room_native',now(),'{}',now())`);
  await query(target("cr_prod_coord200"),
    `INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
     VALUES('tenant:test','project:alpha','active',1,now(),now())`);
  const subjectDigest = sha256Digest({ provider: "test", subject: "pg-owner" });
  const issued = new Date(Date.now() - 60_000).toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  await query(target("cr_prod_coord200"),
    `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
     VALUES('identity:pg-owner','tenant:test','human','PG owner','test',$1,'active',now(),now())`, [subjectDigest]);
  await query(target("cr_prod_coord200"),
    `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,
     allow_external_effects,require_strong_factor,created_at,updated_at)
     VALUES('grant:pg-1','tenant:test','identity:pg-owner','owner','[\"*\"]','[\"*\"]','critical',true,false,now(),now())`);
  await query(target("cr_prod_coord200"),
    `INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
     VALUES('tenant:test',$1,'identity:pg-owner',$2,$3)`, [PAGE_TOKEN_DIGEST, issued, expires]);
  pageIdentity.issuedAt = issued;
  pageIdentity.expiresAt = expires;
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
// Page-path identity: issued/expiry are filled from the seeded session row
// in before() so the service's exact-match check always pairs them.
const PAGE_TOKEN_DIGEST = DIGEST("f");
const pageIdentity = {
  provider: "test",
  subject: "pg-owner",
  tokenDigest: PAGE_TOKEN_DIGEST,
  issuedAt: "",
  expiresAt: "",
  verificationExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
};
// Minimal DatabaseClient over one pg connection, so the service under test
// runs its real transaction path (BEGIN/COMMIT) on that connection.
const clientFor = (conn) => ({
  query: (statement, params = []) => conn.query(statement, params),
  transaction: async (callback) => {
    await conn.query("BEGIN");
    try {
      const result = await callback({ query: (s, p = []) => conn.query(s, p) });
      await conn.query("COMMIT");
      return result;
    } catch (cause) {
      await conn.query("ROLLBACK").catch(() => {});
      throw cause;
    }
  },
  transactionWithPreCommitCheck: async (callback, preCommitCheck) => {
    await conn.query("BEGIN");
    try {
      const result = await callback({ query: (s, p = []) => conn.query(s, p) });
      await preCommitCheck();
      await conn.query("COMMIT");
      return result;
    } catch (cause) {
      await conn.query("ROLLBACK").catch(() => {});
      throw cause;
    }
  },
});
const insertAttention = (id, sourceRecordId) => query(target("cr_prod_coord200"),
  `INSERT INTO attention_items(id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,
   source_version,attention_type,title,summary,due_at,created_at_source,observed_at,payload,updated_at)
   VALUES($1,'tenant:test','workspace:test','project:alpha',NULL,'adapter:test',$2,'1','approval','T','S',NULL,now(),now(),'{}',now())`,
  [id, sourceRecordId]);

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

test("page composition holds its authorization locks: a concurrent revocation blocks, then the snapshot hides a concurrent insert", needsPg, async () => {
  await insertAttention("attn-pg-1", "pg-src-1");
  const connA = await open(target("cr_prod_coord200"));
  try {
    const service = new ProjectCoordinationHttpService({
      database: clientFor(connA),
      scope: { tenantId: "tenant:test", workspaceId: "workspace:test" },
      clock: Date.now,
      store: createProjectCoordinationCanonicalStoreAdapterV1({
        database: clientFor(connA), tenantId: "tenant:test", now: Date.now,
      }),
      readProbe: { beforeSnapshot: async () => {
        entered = true;
        await gate;
      } },
    });
    // Hold the read inside its authorization transaction: auth locks taken,
    // page not yet composed.
    let entered = false;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const inFlight = service.read(pageIdentity, "project:alpha");
    const deadline = Date.now() + 15_000;
    while (!entered) {
      if (Date.now() > deadline) throw new Error("page read never reached its snapshot gate");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // A revocation committed now cannot slip between the check and the
    // data: the session row is locked by the in-flight read, so the
    // revocation blocks instead. lock_timeout turns the block into proof.
    // (A dedicated connection: lock_timeout is session-scoped, and the
    // one-shot query helper cannot send SET + UPDATE together.)
    const connB = await open(target("cr_prod_coord200"));
    let revokeBlocked;
    try {
      await connB.query("SET lock_timeout = '2s'");
      revokeBlocked = await connB.query(
        `UPDATE control_web_sessions SET revoked_at = now()
         WHERE tenant_id = 'tenant:test' AND token_digest = $1`, [PAGE_TOKEN_DIGEST]).then(
        () => null, (cause) => cause);
    } finally {
      await connB.end();
    }
    assert.match(String(revokeBlocked?.message ?? revokeBlocked ?? ""), /lock timeout|could not obtain lock/i);
    // An unrelated content commit lands while the read is held.
    await insertAttention("attn-pg-2", "pg-src-2");
    release();
    const page = await inFlight;
    // The repeatable-read snapshot predates the concurrent insert: old
    // content pairs with its own version, never with the new row's.
    assert.equal(page.attention.length, 1);
    assert.ok(page.versions.attentionVersion > 0);
  } finally {
    await connA.end();
  }
  // A fresh read takes a new snapshot and sees both rows.
  const connC = await open(target("cr_prod_coord200"));
  try {
    const fresh = new ProjectCoordinationHttpService({
      database: clientFor(connC),
      scope: { tenantId: "tenant:test", workspaceId: "workspace:test" },
      clock: Date.now,
      store: createProjectCoordinationCanonicalStoreAdapterV1({
        database: clientFor(connC), tenantId: "tenant:test", now: Date.now,
      }),
    });
    assert.equal((await fresh.read(pageIdentity, "project:alpha")).attention.length, 2);
  } finally {
    await connC.end();
  }
  // A committed revocation is observed: the next read is refused outright.
  await query(target("cr_prod_coord200"),
    `UPDATE control_web_sessions SET revoked_at = now()
     WHERE tenant_id = 'tenant:test' AND token_digest = $1`, [PAGE_TOKEN_DIGEST]);
  const connD = await open(target("cr_prod_coord200"));
  try {
    const revoked = new ProjectCoordinationHttpService({
      database: clientFor(connD),
      scope: { tenantId: "tenant:test", workspaceId: "workspace:test" },
      clock: Date.now,
      store: createProjectCoordinationCanonicalStoreAdapterV1({
        database: clientFor(connD), tenantId: "tenant:test", now: Date.now,
      }),
    });
    await assert.rejects(revoked.read(pageIdentity, "project:alpha"), /authentication_required/);
  } finally {
    await connD.end();
  }
});
