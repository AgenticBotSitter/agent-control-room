// Live-cluster regression proofs for the two project-activity database defects.
//
//   DEFECT 1 (HIGH): the activity service held one pooled connection for its
//   authority/authorization transaction and then needed a SECOND connection to
//   read events. The web pg pool has max 8. With 8 concurrent timeline reads
//   every request self-deadlocked, timed out near 5s, and the bounded database
//   then quarantined itself so all later queries returned database_unavailable.
//   THE FIX: the read runs on the authority transaction's own connection through
//   the optional `session` parameter threaded from ProjectActivityServiceV1.read()
//   down to ProjectEventStoreV1.read().
//
//   DEFECT 2 (MEDIUM-HIGH): the store read the head row and the event rows in
//   two separate autocommit statements, so an append committing in between made
//   the final-head equality check throw integrity_failed. Under concurrent
//   appends about half of all reads failed. THE FIX: read() now runs in one
//   `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction.
//
// Both proofs run against a disposable PostgreSQL 17 cluster this file creates
// for itself: initdb into a temp directory, the real migrations, the real
// private-web grant SQL, and removal in `after()`. It never connects to an
// existing database and never drops one. The 8-connection web pool is the REAL
// createPrivatePgDatabase() construction, not a hand-rolled Pool.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { Client, Pool } from "pg";
import { privilegeClassMarkerTables, revokeMarkerClassesSql } from "./support/privilege-class-markers";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import {
  encodeProjectEventCursorV1,
  encodeProjectEventOriginCursorV1,
  PROJECT_EVENT_INPUT_V1,
  ProjectEventStoreV1,
  type ProjectEventInputV1,
  type ProjectEventPageV1,
  type ProjectEventReadRequestV1,
  type ProjectEventV1,
} from "../src/project-events/v1";
import { createPrivatePgDatabase } from "../src/web/v1/private-pg-database";
import { ProjectActivityServiceV1 } from "../src/web/v1/project-activity-service";
import { WebAccessError, type VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { mergeProjectActivityEventsV1 } from "../src/web/v1/project-activity-browser-client";
import { sha256Digest } from "../src/security";
import { concurrently } from "./support/attack-kit";

// This file provisions its OWN disposable PostgreSQL 17 cluster in a temp
// directory, applies the real migrations and the real private-web grants, and
// removes it in `after()`. It never connects to an existing database. The
// binary directory follows the same candidates as the other real-cluster lane
// files (tests/postgres-production-coordination.test.mjs), so it skips
// gracefully on a machine without PostgreSQL 17 instead of failing CI.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_BINS = ([process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"] as const)
  .filter((dir): dir is string => !!dir);
const BIN = CANDIDATE_BINS.find(dir => existsSync(join(dir, "initdb")) && existsSync(join(dir, "postgres")))
  ?? "/usr/lib/postgresql/17/bin";
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined : { skip: "needs PostgreSQL 17 binaries (PG_BIN, /opt/homebrew/opt/postgresql@17/bin, or /usr/lib/postgresql/17/bin)" };
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 56160);
const exec = promisify(execFile);
const native = (name: string, args: string[]) => exec(join(BIN, name), args,
  { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TMPDIR: run, NODE_ENV: "test" }, timeout: 120000, maxBuffer: 1 << 26 });

// The web reader runs as a member of control_room_private_web with
// column-scoped SELECT on the event tables. The pool proof is meaningless with an
// unrestricted login, so every read goes through this one.
const PG = { host: "127.0.0.1", port: PORT, database: "cr_pa403" } as const;
const ADMIN = { ...PG, user: "pa_admin" } as const;
const WRITER = { ...PG, user: "pa_writer", password: "pawrite" } as const;
const WEB = { ...PG, user: "pa_web", password: "paweb" } as const;

// Run-scoped ids. Every identifier is suffixed with a fresh random token so a
// database left behind by an earlier run can never collide with this one, and
// the before() purge removes any earlier run's rows by tenant prefix.
const TOKEN = randomBytes(5).toString("hex");
const TENANT_ID = `tenant:pa-${TOKEN}`;
const WORKSPACE_ID = `ws:pa-${TOKEN}`;
const ADAPTER_ID = `adapter:pa-${TOKEN}`;
const SIBLING_WORKSPACE_ID = `ws:pa-sibling-${TOKEN}`;
const FOREIGN_TENANT_ID = `tenant:pa-foreign-${TOKEN}`;
const FOREIGN_WORKSPACE_ID = `ws:pa-foreign-${TOKEN}`;
const FOREIGN_ADAPTER_ID = `adapter:pa-foreign-${TOKEN}`;
const projectId = (label: string) => `project:pa-${label}-${TOKEN}`;
const identityId = (label: string) => `identity:pa-${label}-${TOKEN}`;
const grantId = (label: string) => `grant:pa-${label}-${TOKEN}`;
const sessionDigest = (label: string) => sha256Digest({ session: `pa-${label}-${TOKEN}` });

// One shared 32-byte integrity key: the HMAC that authenticates heads and event
// rows must be identical for the appending store and every reading store, or
// the store's own verification would (correctly) refuse the rows.
const KEY = new Uint8Array(32).fill(0x5a);
// Deterministic event clock. The store rejects an occurredAt more than 30s
// after recordedAt, so both sides use the same fixed instant.
const EVENT_NOW = "2026-09-28T12:00:00.000Z";
// The web authority checks the assertion against real wall-clock time, so the
// session/identity window is derived from Date.now() while its exact ISO
// rendering is what gets seeded (the authority compares them for equality).
const SESSION_ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const SESSION_EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const VERIFICATION_EXPIRES_AT = new Date(Date.now() + 7 * 86_400_000).toISOString();
const PROVIDER = "test";

const POOL_PROJECT = projectId("pool");
const COMPOSE_PROJECT = projectId("compose");
const RACE_PROJECT = projectId("race");
const GUARD_PROJECT = "project:pa-guardA-" + TOKEN;
const OTHER_PROJECT = projectId("guardB");
const AUTH_OWNED_PROJECT = projectId("authA");
const AUTH_FOREIGN_PROJECT = projectId("authB");
const STALE_PROJECT = projectId("stale");
const WRONG_WORKSPACE_PROJECT = projectId("wrong-workspace");
const FOREIGN_TENANT_PROJECT = projectId("foreign-tenant");

const POOL_EVENTS = 6;
const COMPOSE_EVENTS = 8;
const RACE_APPENDS = 200;
const GUARD_EVENTS = 5;
// The other project is deliberately LARGER than the first one so a read of the
// first with a generous limit can only stay gap-free if the SQL still filters
// by project_id. Removing that predicate makes the other project's rows
// selectable and the store's per-row verification refuses them.
const OTHER_EVENTS = 8;
const STALE_EVENTS = 6;
const RACE_PAGE_LIMIT = 7;

const APPEND_ONLY_TRIGGER = `CREATE TRIGGER control_project_events_append_only
  BEFORE UPDATE OR DELETE ON control_project_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation()`;

type Web = ReturnType<typeof createPrivatePgDatabase>;
type Reader = { client: DatabaseClient; close(): Promise<void> };
type Seed = { label: string; identityId: string };

let admin!: Client;
let writer!: Reader;
let raceReader!: Reader;
let web!: Web;
let run = "";
let started = false;
let writerStore!: ProjectEventStoreV1;
let raceStore!: ProjectEventStoreV1;
let webStore!: ProjectEventStoreV1;
let poolService!: ProjectActivityServiceV1;
let guardService!: ProjectActivityServiceV1;
let authService!: ProjectActivityServiceV1;
let poolIdentity!: VerifiedWebIdentity;
let ownerAIdentity!: VerifiedWebIdentity;
let revokedOwnerAIdentity!: VerifiedWebIdentity;
let operatorIdentity!: VerifiedWebIdentity;
/** Appended events per project, kept so later tests can build genuine cursors. */
const appended = new Map<string, ProjectEventV1[]>();

async function inTransaction<T>(pool: Pool, callback: (session: DatabaseSession) => Promise<T>,
  check: () => void | Promise<void>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session: DatabaseSession = Object.freeze({
      query: async <T>(statement: string, params: unknown[] = []) =>
        (await client.query(statement, params)) as unknown as { rows: T[] },
    });
    const value = await callback(session);
    await check();
    await client.query("COMMIT");
    return value;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {});
    throw cause;
  } finally {
    client.release();
  }
}

const readerOver = (pool: Pool): Reader => ({
  client: Object.freeze<DatabaseClient>({
    query: async <T>(statement: string, params: unknown[] = []) => {
      const client = await pool.connect();
      try { return await client.query(statement, params) as unknown as { rows: T[] }; }
      finally { client.release(); }
    },
    transaction: <T>(callback: (session: DatabaseSession) => Promise<T>) => inTransaction(pool, callback, () => {}),
    transactionWithPreCommitCheck: <T>(callback: (session: DatabaseSession) => Promise<T>,
      check: () => void | Promise<void>) => inTransaction(pool, callback, check),
  }),
  close: () => pool.end(),
});

const identity = (label: string, tokenLabel: string): VerifiedWebIdentity => ({
  provider: PROVIDER, subject: `${label}-${TOKEN}`, tokenDigest: sessionDigest(tokenLabel),
  issuedAt: SESSION_ISSUED_AT, expiresAt: SESSION_EXPIRES_AT, verificationExpiresAt: VERIFICATION_EXPIRES_AT,
});

function eventInput(label: string, index: number, project: string): ProjectEventInputV1 {
  const sourceId = `source:pa-${label}-${TOKEN}-${index}`;
  return {
    schemaVersion: PROJECT_EVENT_INPUT_V1, tenantId: TENANT_ID, workspaceId: WORKSPACE_ID, projectId: project,
    eventId: `event:pa-${label}-${TOKEN}-${index}`, eventKind: "work",
    source: { kind: "job", sourceId, sourceVersion: `version-${index}`, sourceEventKeyDigest: sha256Digest({ sourceId }) },
    subject: { kind: "work_item", subjectId: `work:pa-${label}-${index}` },
    safeSummary: `Activity ${index} for ${label}`, tone: "neutral", occurredAt: EVENT_NOW,
    presentationOnly: true, grantsApproval: false, grantsCommandAuthority: false, grantsExecutionAuthority: false,
  };
}

async function appendSeries(label: string, project: string, count: number) {
  const events: ProjectEventV1[] = [];
  for (let index = 1; index <= count; index += 1) events.push((await writerStore.append(eventInput(label, index, project))).event);
  appended.set(project, events);
  return events;
}

/** Suspends the append-only trigger for one tightly scoped statement batch. The
 * trigger is restored in `finally`, so a failure can never leave the shared
 * cluster weaker than the test found it. */
async function withAppendOnlySuspended<T>(work: () => Promise<T>): Promise<T> {
  await admin.query("DROP TRIGGER control_project_events_append_only ON control_project_events");
  try { return await work(); }
  finally { await admin.query(APPEND_ONLY_TRIGGER); }
}

async function purgePreviousRuns() {
  const stale = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM tenants WHERE id LIKE 'tenant:pa-%'");
  if (!stale.rows[0]?.n) return;
  await withAppendOnlySuspended(async () => {
    await admin.query("BEGIN");
    try {
      // Children before parents: control_project_events and the stream heads both
      // hold ON DELETE RESTRICT foreign keys onto projects.
      for (const table of ["control_web_sessions", "control_role_grants", "control_project_events",
        "control_project_event_stream_heads", "control_identities", "projects", "workspaces", "adapter_registry"]) {
        await admin.query(`DELETE FROM ${table} WHERE tenant_id LIKE 'tenant:pa-%'`);
      }
      await admin.query("DELETE FROM tenants WHERE id LIKE 'tenant:pa-%'");
      await admin.query("COMMIT");
    } catch (cause) {
      await admin.query("ROLLBACK").catch(() => {});
      throw cause;
    }
  });
}

async function seedIdentity(label: string, roleKey: string, projectIds: string[]): Promise<Seed> {
  const seed = { label, identityId: identityId(label) };
  await writer.client.query(
    `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
     VALUES($1,$2,'human',$3,$4,$5,'active',$6,$6)`,
  [seed.identityId, TENANT_ID, `PA ${label}`, PROVIDER, sha256Digest({ provider: PROVIDER, subject: `${label}-${TOKEN}` }),
    SESSION_ISSUED_AT]);
  await writer.client.query(
    `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,
     allow_external_effects,require_strong_factor,created_at,updated_at)
     VALUES($1,$2,$3,$4,'["*"]',$5,'critical',true,false,$6,$6)`,
  [grantId(label), TENANT_ID, seed.identityId, roleKey, JSON.stringify(projectIds), SESSION_ISSUED_AT]);
  return seed;
}

async function seedSession(seed: Seed, tokenLabel: string) {
  // The authority re-reads this row and requires an exact ISO match against the
  // assertion, so both sides are seeded from the same constants.
  await writer.client.query(
    `INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
     VALUES($1,$2,$3,$4,$5)`,
  [TENANT_ID, sessionDigest(tokenLabel), seed.identityId, SESSION_ISSUED_AT, SESSION_EXPIRES_AT]);
}

before(async () => {
  if (!PG_AVAILABLE) return;
  // A disposable cluster of our own, in a temp directory, removed in `after()`.
  // Nothing here can reach an existing database: initdb creates a brand-new
  // cluster, and the only database in it is the one created below.
  run = await mkdtemp(join(tmpdir(), "cr-pa403-"));
  const data = join(run, "data");
  await mkdir(data, { recursive: true, mode: 0o700 });
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "pa_admin", "--auth-local=trust", "--auth-host=trust", "--no-locale", "--encoding=UTF8"]);
  started = true;
  await native("pg_ctl", ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "30", "-o",
    `-p ${PORT} -k '${run}' -c listen_addresses=127.0.0.1 -c shared_buffers=32MB -c max_connections=60`,
    "start"]);
  const bootstrap = new Client({ host: "127.0.0.1", port: PORT, database: "postgres", user: "pa_admin" });
  await bootstrap.connect();
  try { await bootstrap.query(`CREATE DATABASE ${PG.database}`); } finally { await bootstrap.end(); }
  admin = new Client(ADMIN);
  await admin.connect();
  // The exact production schema and grant SQL under review, not a substitute.
  for (const file of (await readdir(join(ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort())
    await admin.query(await readFile(join(ROOT, "db/migrations", file), "utf8"));
  await admin.query(await readFile(join(ROOT, "db/roles/private_web_roles.sql"), "utf8"));
  await admin.query(await readFile(join(ROOT, "db/roles/private_web_database.sql"), "utf8"));
  await admin.query(`CREATE ROLE pa_web LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    PASSWORD 'paweb' IN ROLE control_room_private_web`);
  await admin.query(`CREATE ROLE pa_writer LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    PASSWORD 'pawrite'`);
  await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO pa_writer`);
  await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO pa_writer`);
  // A privilege-class marker table is granted, not inherited: holding SELECT on
  // one IS membership of that class. GRANT ALL ON ALL TABLES has just made
  // pa_writer a fleet gateway, and the fleet guards would then refuse this
  // fixture's own inserts into control_identities. Production never hits this
  // because a login reaches a marker only by inheriting the one group the role
  // file names.
  await admin.query(revokeMarkerClassesSql("pa_writer", await privilegeClassMarkerTables(ROOT)));
  await purgePreviousRuns();

  const writerPool = new Pool({ ...WRITER, max: 4, application_name: "control-room-activity-test-writer" });
  const racePool = new Pool({ ...WRITER, max: 2, application_name: "control-room-activity-test-race" });
  writer = { client: readerOver(writerPool).client, close: () => writerPool.end() };
  raceReader = readerOver(racePool);
  writerStore = new ProjectEventStoreV1(writer.client, KEY, () => EVENT_NOW);
  raceStore = new ProjectEventStoreV1(raceReader.client, KEY, () => EVENT_NOW);

  await writer.client.query("INSERT INTO tenants(id,display_name) VALUES($1,'Activity regression tenant')", [TENANT_ID]);
  await writer.client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Activity workspace')",
    [WORKSPACE_ID, TENANT_ID]);
  await writer.client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Sibling activity workspace')",
    [SIBLING_WORKSPACE_ID, TENANT_ID]);
  await writer.client.query("INSERT INTO tenants(id,display_name) VALUES($1,'Foreign activity tenant')", [FOREIGN_TENANT_ID]);
  await writer.client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Foreign activity workspace')",
    [FOREIGN_WORKSPACE_ID, FOREIGN_TENANT_ID]);
  await writer.client.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'activity_pg_fixture','fixture-v1','control_room_native','fixture','[]','[]','[]','redaction-v1',30)`,
  [ADAPTER_ID, TENANT_ID]);
  await writer.client.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'activity_pg_foreign_fixture','fixture-v1','control_room_native','fixture','[]','[]','[]','redaction-v1',30)`,
  [FOREIGN_ADAPTER_ID, FOREIGN_TENANT_ID]);
  for (const project of [POOL_PROJECT, COMPOSE_PROJECT, RACE_PROJECT, GUARD_PROJECT, OTHER_PROJECT,
    AUTH_OWNED_PROJECT, AUTH_FOREIGN_PROJECT, STALE_PROJECT]) {
    await writer.client.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
      title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
      VALUES($1,$2,$3,$4,$1,'fixture-v1',$1,'running','active','healthy','control_room_native',$5,'{}')`,
    [project, TENANT_ID, WORKSPACE_ID, ADAPTER_ID, EVENT_NOW]);
  }
  await writer.client.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
    title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,$4,$1,'fixture-v1',$1,'running','active','healthy','control_room_native',$5,'{}')`,
  [WRONG_WORKSPACE_PROJECT, TENANT_ID, SIBLING_WORKSPACE_ID, ADAPTER_ID, EVENT_NOW]);
  await writer.client.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
    title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,$4,$1,'fixture-v1',$1,'running','active','healthy','control_room_native',$5,'{}')`,
  [FOREIGN_TENANT_PROJECT, FOREIGN_TENANT_ID, FOREIGN_WORKSPACE_ID, FOREIGN_ADAPTER_ID, EVENT_NOW]);

  const poolOwner = await seedIdentity("poolowner", "owner", ["*"]);
  await seedSession(poolOwner, "poolowner");
  poolIdentity = identity("poolowner", "poolowner");

  const guardOwner = await seedIdentity("guardowner", "owner", ["*"]);
  await seedSession(guardOwner, "guardowner");
  const guardIdentity = identity("guardowner", "guardowner");

  const scopedOwner = await seedIdentity("ownera", "owner", [AUTH_OWNED_PROJECT]);
  await seedSession(scopedOwner, "ownera");
  await seedSession(scopedOwner, "ownera-revoked");
  ownerAIdentity = identity("ownera", "ownera");
  revokedOwnerAIdentity = identity("ownera", "ownera-revoked");

  const operator = await seedIdentity("operator", "operator", ["*"]);
  await seedSession(operator, "operator");
  operatorIdentity = identity("operator", "operator");

  await appendSeries("pool", POOL_PROJECT, POOL_EVENTS);
  await appendSeries("compose", COMPOSE_PROJECT, COMPOSE_EVENTS);
  await appendSeries("guardA", GUARD_PROJECT, GUARD_EVENTS);
  await appendSeries("guardB", OTHER_PROJECT, OTHER_EVENTS);
  await appendSeries("authA", AUTH_OWNED_PROJECT, 2);
  await appendSeries("authB", AUTH_FOREIGN_PROJECT, 1);
  await appendSeries("stale", STALE_PROJECT, STALE_EVENTS);

  // The real bounded production pool: max 8, statement/transaction timeouts,
  // per-connection qualification, and the private read role.
  web = createPrivatePgDatabase({ host: WEB.host, port: WEB.port, database: WEB.database,
    username: WEB.user, password: WEB.password, majorVersion: 17 });
  webStore = new ProjectEventStoreV1(web.client, KEY, () => EVENT_NOW);
  const scope = { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID };
  poolService = new ProjectActivityServiceV1(web.client, scope, webStore);
  guardService = new ProjectActivityServiceV1(web.client, scope, webStore);
  authService = new ProjectActivityServiceV1(web.client, scope, webStore);
  void guardIdentity;
});

after(async () => {
  await web?.close().catch(() => {});
  await raceReader?.close().catch(() => {});
  await writer?.close().catch(() => {});
  await admin?.end().catch(() => {});
  // Always stop the cluster and remove its data directory, even after a failure:
  // a leaked postmaster holds this Mac's scarce shared memory and its port.
  // The stop happens before the removal, and a failed stop is reported rather
  // than swallowed, so a leak can never pass unnoticed.
  if (started && run) {
    try {
      await native("pg_ctl", ["-D", join(run, "data"), "-m", "immediate", "-w", "-t", "30", "stop"]);
    } catch (error) {
      process.stderr.write(`activity cluster stop failed, removing anyway: ${String(error)}\n`);
    }
  }
  if (run) await rm(run, { recursive: true, force: true });
});

const request = (project: string, limit: number, cursor: { afterCursor?: string; beforeCursor?: string } = {}):
  ProjectEventReadRequestV1 => ({ tenantId: TENANT_ID, workspaceId: WORKSPACE_ID, projectId: project, limit, ...cursor });

const failureMessage = (reason: unknown) => {
  const code = (reason as { code?: unknown } | null)?.code;
  const safe = (reason as { safeCode?: unknown } | null)?.safeCode;
  return [typeof code === "string" ? code : "", typeof safe === "string" ? safe : "", String(reason)].filter(Boolean).join(": ");
};

async function refuses(promise: Promise<unknown>, code: "authentication_required" | "access_denied" | "invalid_request" | "not_found") {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WebAccessError,
      `expected a WebAccessError, received ${failureMessage(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("pool: more concurrent activity reads than the pool has connections all succeed", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  // Pool size + 1 at minimum; twelve keeps a real margin above the 8-connection
  // pool without tripping the bounded database's own admission cap.
  const CONCURRENCY = 12;
  const burst = async () => {
    const started = performance.now();
    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => poolService.read(poolIdentity, POOL_PROJECT, {}, 50)));
    const failures = settled.flatMap(result => result.status === "rejected" ? [failureMessage(result.reason)] : []);
    return { elapsed: performance.now() - started, failures, modes: settled.map(result => result.status === "fulfilled" ? result.value.mode : "rejected") };
  };

  const first = await burst();
  t.diagnostic(`burst #1: ${CONCURRENCY} concurrent reads, zero rejections: ${first.failures.length === 0}, wall ${first.elapsed.toFixed(1)}ms`);
  assert.deepEqual(first.failures, [],
    "every concurrent activity read must resolve; the pre-fix code rejected with database_unavailable");
  assert.ok(first.modes.every(mode => mode === "snapshot"), `every read must return a verified page: ${first.modes.join(",")}`);
  assert.ok(first.elapsed < 4_000,
    `the burst must not hit the 5s pool self-deadlock timeout (was 5005ms before the fix): ${first.elapsed.toFixed(1)}ms`);

  // The old bug did not just fail the burst: the bounded database quarantined
  // itself, so every later query answered database_unavailable. Prove it is
  // still serving, and that the database never latched closed.
  assert.equal(web.isAvailable(), true, "the bounded database must not have shut itself down");
  const alive = await web.client.query<{ ok: number }>("SELECT 1 AS ok");
  assert.equal(alive.rows[0]?.ok, 1, "a plain query after the burst must still succeed");

  // A second burst after a pause rules out "merely slow the first time" (a cold
  // pool) and shows the pool is reusable, not wedged.
  await new Promise(resolve => setTimeout(resolve, 250));
  const second = await burst();
  t.diagnostic(`burst #2: wall ${second.elapsed.toFixed(1)}ms`);
  assert.deepEqual(second.failures, [], "the repeat burst must also resolve with zero rejections");
  assert.ok(second.elapsed < 4_000, `the repeat burst must stay under the deadlock timeout: ${second.elapsed.toFixed(1)}ms`);
  assert.equal(web.isAvailable(), true);
  const stillAlive = await web.client.query<{ ok: number }>("SELECT 1 AS ok");
  assert.equal(stillAlive.rows[0]?.ok, 1);
});

test("first use: 40 rounds of 6 concurrent reads on one fresh token all succeed", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  const rounds = 40;
  const width = 6;
  let completed = 0;
  for (let round = 0; round < rounds; round += 1) {
    const freshIdentity = { ...poolIdentity, tokenDigest: sessionDigest(`first-use-${round}`) };
    const pages = await concurrently(width,
      () => poolService.read(freshIdentity, POOL_PROJECT, {}, 100), { boundMs: 10_000 });
    assert.equal(pages.length, width);
    assert.ok(pages.every(page => page.mode === "snapshot" && page.events.length === POOL_EVENTS));
    completed += pages.length;
  }
  assert.equal(completed, rounds * width, "every concurrent first-use request must complete successfully");
  const persisted = await writer.client.query<{ count: number }>(`SELECT count(*)::int AS count FROM control_web_sessions
    WHERE tenant_id=$1 AND token_digest = ANY($2::text[])`,
  [TENANT_ID, Array.from({ length: rounds }, (_, round) => sessionDigest(`first-use-${round}`))]);
  assert.equal(persisted.rows[0]?.count, rounds, "one immutable session row must exist per fresh token");
  assert.equal(web.isAvailable(), true, "first-use contention must not quarantine the bounded database");
  t.diagnostic(`${rounds} rounds x ${width} concurrent first-use reads: ${completed} succeeded`);
});

test("store scope: projects in another tenant or workspace are project_not_found", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  for (const [label, project] of [["another tenant", FOREIGN_TENANT_PROJECT],
    ["another workspace", WRONG_WORKSPACE_PROJECT]] as const) {
    await assert.rejects(webStore.read(request(project, 100)), (error: unknown) => {
      assert.equal((error as { safeCode?: unknown })?.safeCode, "project_not_found",
        `${label} must be refused by the store existence check`);
      return true;
    });
  }
  t.diagnostic("store refused both foreign-tenant and foreign-workspace projects as project_not_found");
});

test("reads compose on the caller's transaction and take one connection", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  // (1) The optional-session path is real: same page, same digest, same cursor.
  const bounded = request(COMPOSE_PROJECT, 3);
  const standalone = await webStore.read(bounded);
  assert.equal(standalone.mode, "snapshot");
  const composed = await web.client.transaction(async session => {
    await session.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const opening = await session.query<{ setting: string }>("SELECT pg_backend_pid()::text AS setting");
    const page = await webStore.read(bounded, session);
    const closing = await session.query<{ setting: string }>("SELECT pg_backend_pid()::text AS setting");
    const isolation = await session.query<{ setting: string }>("SELECT current_setting('transaction_isolation') AS setting");
    const readOnly = await session.query<{ setting: string }>("SELECT current_setting('transaction_read_only') AS setting");
    return { page, opening: opening.rows[0]?.setting, closing: closing.rows[0]?.setting,
      isolation: isolation.rows[0]?.setting, readOnly: readOnly.rows[0]?.setting };
  });
  assert.deepEqual(composed.page, standalone,
    "a read supplied a caller session must be byte-identical to the self-transaction read");
  // pg_backend_pid is per-connection. An unchanged pid proves the store issued
  // its statements on the caller's own backend rather than checking out a second
  // pooled connection.
  assert.equal(composed.opening, composed.closing, "the composed read must run on the caller's connection");
  assert.ok(composed.opening, "the caller's backend pid must be observable inside the transaction");
  assert.equal(composed.isolation, "repeatable read", "the composed read must share the caller's REPEATABLE READ snapshot");
  assert.equal(composed.readOnly, "on", "the composed read must share the caller's READ ONLY transaction");
  t.diagnostic(`composed read ran on backend pid ${composed.opening} at ${composed.isolation} read-only=${composed.readOnly}`);

  // (2) The equivalence holds for both cursor directions, not just the head page.
  const events = appended.get(COMPOSE_PROJECT)!;
  const afterRequest = request(COMPOSE_PROJECT, 3, { afterCursor: encodeProjectEventOriginCursorV1(COMPOSE_PROJECT) });
  const beforeRequest = request(COMPOSE_PROJECT, 3, { beforeCursor: encodeProjectEventCursorV1(events[5]!) });
  for (const [label, requestValue] of [["afterCursor", afterRequest], ["beforeCursor", beforeRequest]] as const) {
    const independent = await webStore.read(requestValue);
    const supplied = await web.client.transaction(session => webStore.read(requestValue, session));
    assert.deepEqual(supplied, independent, `the ${label} page must be identical with and without a supplied session`);
    assert.ok(supplied.events.length > 0, `the ${label} case must really page events`);
  }

  // (3) The defect-1 kill in its strongest form: more concurrent caller-held
  // transactions than the pool has connections, each performing a read on its
  // OWN session. If read() still tried to take a second connection, every one
  // of the eight admitted transactions would hold a slot while waiting for a
  // ninth, and the ninth would exhaust the pool's checkout budget.
  const wide = request(COMPOSE_PROJECT, 100);
  const CONCURRENT_CALLER_TRANSACTIONS = 9;
  const started = performance.now();
  const settled = await Promise.allSettled(Array.from({ length: CONCURRENT_CALLER_TRANSACTIONS }, () =>
    web.client.transaction(async session => {
      const page = await webStore.read(wide, session);
      return page.events.length;
    })));
  const elapsed = performance.now() - started;
  const failures = settled.flatMap(result => result.status === "rejected" ? [failureMessage(result.reason)] : []);
  t.diagnostic(`${CONCURRENT_CALLER_TRANSACTIONS} concurrent caller transactions each read on their own session: ${elapsed.toFixed(1)}ms`);
  assert.deepEqual(failures, [], "a caller-supplied session must never need a second pooled connection");
  assert.ok(settled.every(result => result.status === "fulfilled" && result.value === COMPOSE_EVENTS),
    "each composed read must return the project's full event set");
  assert.ok(elapsed < 4_000, `composed reads must not self-deadlock: ${elapsed.toFixed(1)}ms`);
  assert.equal(web.isAvailable(), true);
});

test("concurrent appends: a replay loop never sees integrity_failed and stays gap-free", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  const base = { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID, projectId: RACE_PROJECT };
  const integrityFailures: string[] = [];
  const resetPages: number[] = [];
  let pages = 0;
  let headCheckedPages = 0;

  const readPage = async (value: ProjectEventReadRequestV1) => {
    try { return await raceStore.read(value); }
    catch (error) {
      integrityFailures.push(failureMessage(error));
      return undefined;
    }
  };
  const drain = async (startCursor: string | undefined, limit: number) => {
    let merged: ProjectEventV1[] = [];
    let cursor = startCursor;
    for (let guard = 0; guard < 1_000; guard += 1) {
      const value = cursor === undefined
        ? { ...base, limit }
        : { ...base, afterCursor: cursor, limit };
      const page = await readPage(value);
      if (!page) return undefined;
      pages += 1;
      if (page.mode === "reset") resetPages.push(pages);
      // hasMore=false is the only shape on which the store compares its last
      // event against the stream head. Count them so the proof below cannot pass
      // vacuously by never reaching that check.
      if (!page.hasMore) headCheckedPages += 1;
      merged = mergeProjectActivityEventsV1(merged, page.events, RACE_PROJECT);
      if (!page.hasMore) return { merged, nextCursor: page.nextCursor ?? undefined };
      if (page.nextCursor === null) return undefined;
      cursor = page.nextCursor;
    }
    return undefined;
  };

  let appending = true;
  const appender = (async () => {
    try {
      for (let index = 1; index <= RACE_APPENDS; index += 1) {
        await writerStore.append(eventInput("race", index, RACE_PROJECT));
      }
    } finally { appending = false; }
  })();

  let observed: ProjectEventV1[] = [];
  let cursor: string | undefined;
  while (appending) {
    const step = await drain(cursor, RACE_PAGE_LIMIT);
    if (!step) break;
    observed = mergeProjectActivityEventsV1(observed, step.merged, RACE_PROJECT);
    cursor = step.nextCursor;
  }
  await appender;
  t.diagnostic(`race: ${pages} pages read (${headCheckedPages} of them head-checked) while ${RACE_APPENDS} events were appended`);

  // The key assertion. The pre-fix code read the head and the events in two
  // autocommit statements, so a commit landing between them tripped the
  // final-head equality check and roughly half of all reads failed.
  assert.deepEqual(integrityFailures, [],
    "a REPEATABLE READ read must never observe an append between its head and its events");
  assert.deepEqual(resetPages, [], "a valid, freshly issued cursor must never produce a reset page");
  assert.ok(headCheckedPages > 0, "the run must have exercised the final-head equality check at least once");
  assert.ok(pages > 10, `the run must be a real race, not a single read: ${pages} pages`);

  const head = await writer.client.query<{ last_sequence: string }>(
    "SELECT last_sequence::text FROM control_project_event_stream_heads WHERE tenant_id=$1 AND project_id=$2",
  [TENANT_ID, RACE_PROJECT]);
  const lastSequence = Number(head.rows[0]?.last_sequence);
  assert.equal(lastSequence, RACE_APPENDS, "every append must have landed");

  // Drain the whole stream from the origin cursor once the appenders are done
  // and prove the merged timeline is exactly 1..N with no gap and no duplicate.
  const drained = await drain(encodeProjectEventOriginCursorV1(RACE_PROJECT), 100);
  assert.ok(drained, "the post-race drain must complete");
  const complete = mergeProjectActivityEventsV1(drained.merged, observed, RACE_PROJECT);
  assert.equal(complete.length, lastSequence,
    `the merged timeline must hold exactly last_sequence events, no duplicates`);
  assert.deepEqual(complete.map(event => event.sequence),
    Array.from({ length: lastSequence }, (_, index) => index + 1),
    "the merged timeline must be 1..N with no gaps");
  assert.deepEqual(new Set(complete.map(event => event.eventId)).size, lastSequence, "no duplicated events");
  assert.ok(complete.every(event => event.projectId === RACE_PROJECT), "no foreign project events in the merge");
  assert.deepEqual(integrityFailures, []);
});

test("cursor guards: a forged cursor is reset and never leaks another project's events", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  const own = appended.get(GUARD_PROJECT)!;
  const other = appended.get(OTHER_PROJECT)!;
  const forge = (material: unknown) => Buffer.from(JSON.stringify(material)).toString("base64url");

  // Two real projects exist in this tenant/workspace, with different sizes, so
  // every case below can distinguish "resets" from "returns the other project".
  assert.ok(other.length > own.length, "the other project must really be larger for the SQL-filter proof");

  // A read of a small project with a limit larger than its event count must
  // still return only that project. Deleting `project_id=$2` from the snapshot
  // SELECT makes the other project's rows selectable, and the store's per-row
  // verification then refuses them (or they leak into the page).
  const wide = await webStore.read(request(GUARD_PROJECT, 100));
  assert.equal(wide.mode, "snapshot");
  assert.equal(wide.events.length, own.length,
    `a generous limit must not pull in the other project's ${other.length} events`);
  assert.ok(wide.events.every(event => event.projectId === GUARD_PROJECT),
    "the snapshot SQL must filter by project_id, not by tenant alone");
  assert.ok(wide.events.every(event => event.tenantId === TENANT_ID && event.workspaceId === WORKSPACE_ID));

  // The hostile matrix is built per TARGET project: a "genuine cursor from the
  // other project" is only an attack when it is presented to a different
  // project, and an ahead-of-head sequence only exceeds the head of the project
  // it is aimed at. Both directions are exercised for both projects.
  for (const target of [GUARD_PROJECT, OTHER_PROJECT]) {
    const genuine = appended.get(target)!;
    const foreign = target === GUARD_PROJECT ? other : own;
    const hostile: ReadonlyArray<{ label: string; cursor: string }> = [
      // (a) own project and sequence, a digest belonging to the OTHER project.
      { label: "same-project id with foreign digest",
        cursor: forge({ projectId: target, sequence: 3, eventDigest: foreign[2]!.eventDigest }) },
      // (b) FOREIGN project id carrying this project's own digest.
      { label: "foreign project id with own digest",
        cursor: forge({ projectId: foreign === other ? OTHER_PROJECT : GUARD_PROJECT, sequence: 3, eventDigest: genuine[2]!.eventDigest }) },
      // (c) a completely genuine cursor that was honestly minted for the other project.
      { label: "genuine cursor minted for the other project", cursor: encodeProjectEventCursorV1(foreign[2]!) },
      // (d) an otherwise valid cursor whose sequence is beyond the stream head.
      { label: "ahead-of-head cursor",
        cursor: forge({ projectId: target, sequence: genuine.length + 5, eventDigest: genuine.at(-1)!.eventDigest }) },
      // (e) a well-formed cursor that decodes to nothing at all.
      { label: "undecodable cursor",
        cursor: forge({ projectId: target, sequence: genuine.length, eventDigest: null }).slice(0, 20) },
    ];
    for (const direction of ["afterCursor", "beforeCursor"] as const) {
      for (const { label, cursor } of hostile) {
        const page = await webStore.read(request(target, 100, { [direction]: cursor }));
        assert.equal(page.mode, "reset", `${direction} on ${target}: ${label} must reset`);
        assert.equal(page.projectId, target, `${direction} on ${target}: ${label} must stay in scope`);
        assert.ok(page.events.every(event => event.projectId === target),
          `${direction} on ${target}: ${label} must never return another project's events`);
        assert.deepEqual(page.events.map(event => event.sequence), genuine.map(event => event.sequence),
          `${direction} on ${target}: ${label} reset page must carry this project's own verified history`);
      }
    }
    assert.ok(genuine.length > 0 && foreign.length > 0, "both matrix projects must hold real events");
  }

  // A genuine cursor still resumes normally, so the guards are not simply
  // refusing everything they are given.
  const resumed = await webStore.read(request(GUARD_PROJECT, 100, { afterCursor: encodeProjectEventCursorV1(own[1]!) }));
  assert.equal(resumed.mode, "replay");
  assert.deepEqual(resumed.events.map(event => event.sequence), own.slice(2).map(event => event.sequence));
  t.diagnostic("forged cursor matrix: 5 shapes x 2 directions x 2 projects all reset without cross-project leakage");
});

test("service authority: authorize() and read() enforce owner-only and per-project grants", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  // The owner grant is scoped to AUTH_OWNED_PROJECT only; the operator grant
  // carries the "*" wildcard but is not an owner.
  const granted = await authService.read(ownerAIdentity, AUTH_OWNED_PROJECT, {}, 50);
  assert.equal(granted.mode, "snapshot");
  assert.equal(granted.projectId, AUTH_OWNED_PROJECT);
  assert.equal(granted.events.length, 2, "the owner's own project must be readable");

  // A wildcard operator still fails every owner-only projects.read require.
  await refuses(authService.read(operatorIdentity, AUTH_OWNED_PROJECT, {}, 50), "access_denied");
  // This is the mutation kill for the ownerOnly require inside authorize():
  // without it, an operator passes the bare authorize() gate and the page read
  // that follows is never reached.
  await refuses(authService.authorize(operatorIdentity, AUTH_OWNED_PROJECT), "access_denied");
  await refuses(authService.authorize(operatorIdentity, AUTH_FOREIGN_PROJECT), "access_denied");
  await authService.authorize(ownerAIdentity, AUTH_OWNED_PROJECT);

  // A per-project owner grant does not travel to a sibling project, even though
  // that project exists and holds its own verified events.
  await refuses(authService.read(ownerAIdentity, AUTH_FOREIGN_PROJECT, {}, 50), "access_denied");
  await refuses(authService.authorize(ownerAIdentity, AUTH_FOREIGN_PROJECT), "access_denied");

  // A committed revocation is refused outright. The session row is immutable
  // except for its first revocation, which is exactly what is exercised here.
  await writer.client.query("UPDATE control_web_sessions SET revoked_at=$3 WHERE tenant_id=$1 AND token_digest=$2",
    [TENANT_ID, revokedOwnerAIdentity.tokenDigest, SESSION_EXPIRES_AT]);
  const revoked = await writer.client.query<{ revoked_at: Date | null }>(
    "SELECT revoked_at FROM control_web_sessions WHERE tenant_id=$1 AND token_digest=$2",
  [TENANT_ID, revokedOwnerAIdentity.tokenDigest]);
  assert.ok(revoked.rows[0]?.revoked_at, "the revocation must be committed before the refusal is observed");
  await refuses(authService.read(revokedOwnerAIdentity, AUTH_OWNED_PROJECT, {}, 50), "authentication_required");
  // The unrevoked session for the same identity is unaffected.
  const stillValid = await authService.read(ownerAIdentity, AUTH_OWNED_PROJECT, {}, 50);
  assert.equal(stillValid.events.length, 2);
  assert.equal(web.isAvailable(), true);
  t.diagnostic("authority matrix: owner-scoped grant honoured, wildcard operator refused, sibling project refused, revoked session refused");
});

test("revocation between the setup and page transactions is refused", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  // Wraps the real web.client so the SECOND transactionWithPreCommitCheck call
  // (the page transaction; the first is repeatableReadSnapshot's setup
  // transaction) runs `hook` just before it starts. This is the exact gap
  // session-authority.ts:52-54 claims is closed by the page transaction's own
  // re-read and lock of identity/session/grants.
  const between = (hook: () => Promise<void>): DatabaseClient => {
    let calls = 0;
    return Object.freeze({
      query: (statement: string, params?: unknown[]) => web.client.query(statement, params),
      transaction: callback => web.client.transaction(callback),
      transactionWithPreCommitCheck: async (callback, check) => {
        calls += 1;
        if (calls === 2) await hook();
        return web.client.transactionWithPreCommitCheck(callback, check);
      },
    } as DatabaseClient);
  };
  const scope = { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID };
  const poolOwnerIdentityId = identityId("poolowner");
  const poolOwnerGrantId = grantId("poolowner");

  // A session revoked in the gap is refused as authentication_required. The
  // fresh token is inserted by the setup transaction itself (first use), so
  // this never touches any session another case relies on.
  {
    const fresh = { ...poolIdentity, tokenDigest: sessionDigest("between-revoke-session") };
    const service = new ProjectActivityServiceV1(between(() => admin.query(
      "UPDATE control_web_sessions SET revoked_at=now() WHERE tenant_id=$1 AND token_digest=$2",
      [TENANT_ID, fresh.tokenDigest]).then(() => {})), scope, webStore);
    await refuses(service.read(fresh, POOL_PROJECT, {}, 10), "authentication_required");
  }

  // An identity suspended in the gap is refused as access_denied. Restored in
  // finally so no later test sees a suspended poolowner.
  {
    const fresh = { ...poolIdentity, tokenDigest: sessionDigest("between-revoke-identity") };
    try {
      const service = new ProjectActivityServiceV1(between(() => admin.query(
        "UPDATE control_identities SET state='suspended', updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [TENANT_ID, poolOwnerIdentityId]).then(() => {})), scope, webStore);
      await refuses(service.read(fresh, POOL_PROJECT, {}, 10), "access_denied");
    } finally {
      await admin.query("UPDATE control_identities SET state='active', updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [TENANT_ID, poolOwnerIdentityId]);
    }
  }

  // A grant revoked in the gap is refused as access_denied. Restored in
  // finally so no later test sees poolowner without its wildcard grant.
  {
    const fresh = { ...poolIdentity, tokenDigest: sessionDigest("between-revoke-grant") };
    try {
      const service = new ProjectActivityServiceV1(between(() => admin.query(
        "UPDATE control_role_grants SET revoked_at=now() WHERE tenant_id=$1 AND id=$2",
        [TENANT_ID, poolOwnerGrantId]).then(() => {})), scope, webStore);
      await refuses(service.read(fresh, POOL_PROJECT, {}, 10), "access_denied");
    } finally {
      await admin.query("UPDATE control_role_grants SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2",
        [TENANT_ID, poolOwnerGrantId]);
    }
  }

  // Poolowner is fully usable again for any later test.
  const stillValid = await poolService.read(poolIdentity, POOL_PROJECT, {}, 10);
  assert.equal(stillValid.events.length, POOL_EVENTS);
  assert.equal(web.isAvailable(), true);
  t.diagnostic("revocation between setup and page transactions: session -> authentication_required, "
    + "identity suspended -> access_denied, grant revoked -> access_denied");
});

// MUST RUN LAST. It is the only case that drops a schema-wide append-only
// trigger, so it is deliberately declared after every other proof. The trigger
// is restored in withAppendOnlySuspended()'s finally and re-verified below, so
// a failure here cannot leave the shared cluster weaker for anything else.
test("cursor guards: a stale/compacted cursor is reset once its event is gone", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  const events = appended.get(STALE_PROJECT)!;
  assert.equal(events.length, STALE_EVENTS);
  const removed = events[2]!;
  assert.equal(removed.sequence, 3);

  await withAppendOnlySuspended(async () => {
    const deleted = await admin.query<{ gone: string }>(
      "DELETE FROM control_project_events WHERE tenant_id=$1 AND project_id=$2 AND sequence=3 RETURNING sequence::text",
    [TENANT_ID, STALE_PROJECT]);
    assert.equal(deleted.rows.length, 1, "exactly the middle event must be removed");
  });
  const trigger = await admin.query<{ tgname: string }>(
    "SELECT tgname FROM pg_trigger WHERE tgrelid='control_project_events'::regclass AND NOT tgisinternal AND tgname=$1",
  ["control_project_events_append_only"]);
  assert.equal(trigger.rows.length, 1, "the append-only trigger must be restored after the scoped delete");

  // The genuine cursor for the compacted event no longer resolves, so the read
  // must reset rather than replay from a position the stream cannot prove. The
  // bounded limit keeps the probe window clear of the deliberate chain break
  // this delete left behind.
  const compacted = await webStore.read(request(STALE_PROJECT, 1, { afterCursor: encodeProjectEventCursorV1(removed) }));
  assert.equal(compacted.mode, "reset", "a cursor whose event was compacted away must reset");
  assert.equal(compacted.projectId, STALE_PROJECT);
  assert.ok(compacted.events.every(event => event.projectId === STALE_PROJECT),
    "a reset page must never carry another project's events");
  assert.ok(compacted.events.length <= 1);

  // A cursor that still resolves keeps working: the compaction is a cursor
  // problem, not a general outage of the stream.
  const resumed = await webStore.read(request(STALE_PROJECT, 1, { afterCursor: encodeProjectEventCursorV1(events[4]!) }));
  assert.equal(resumed.mode, "replay");
  assert.deepEqual(resumed.events.map(event => event.sequence), [STALE_EVENTS]);

  // The deleted row is really gone, so the reset could not have been a coincidence.
  const remaining = await admin.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM control_project_events WHERE tenant_id=$1 AND project_id=$2",
  [TENANT_ID, STALE_PROJECT]);
  assert.equal(remaining.rows[0]?.count, STALE_EVENTS - 1);
  t.diagnostic(`compacted cursor reset; ${STALE_EVENTS - 1} events remain and a live cursor still replays`);
});
