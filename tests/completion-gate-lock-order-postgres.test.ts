// Real PostgreSQL 17 regression for the owner-accept deadlock seen in the owner
// browser journey (PR #422 report): the owner's review INSERT took a foreign-key
// key-share on the reviewed job while already holding the tenant completion-gate
// integrity row, and a concurrent quality inspection held that job FOR UPDATE
// while waiting for the same integrity row. PostgreSQL killed one side with
// 40P01 and the owner saw a 503.
//
// This file provisions its OWN disposable cluster in a temp directory, applies
// the real migrations and role files, runs the owner review under a real
// control_room_private_web login and the quality verifier under a real
// control_room_task_coordinator login, and stops the cluster in `after()`.
// The interleaving is forced, not timed: the quality transaction is held right
// after its job lock until the owner transaction is observed waiting on a lock.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { after, before } from "node:test";
import { Client, Pool } from "pg";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { WebTaskReviewService } from "../src/web/v1/task-review-service";
import { NativeResultVerificationService } from "../src/completion-gate/v1/native-result-verification";
import { sha256Digest } from "../src/security";
import { nativeQualityBatchFixture } from "./helpers/native-quality-completion";
import type { NativeTaskFixtureDatabase } from "./native-task-fixture";
import { binding, instant } from "./hermes-native-fixture";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_BINS = [process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"]
  .filter((dir): dir is string => !!dir);
const BIN = CANDIDATE_BINS.find(dir => existsSync(join(dir, "initdb")) && existsSync(join(dir, "postgres")))
  ?? "/usr/lib/postgresql/17/bin";
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined
  : { skip: "needs PostgreSQL 17 binaries (PG_BIN, /opt/homebrew/opt/postgresql@17/bin, or /usr/lib/postgresql/17/bin)" };
const PORT = Number(process.env.GATE_LOCK_ORDER_PG_PORT ?? 58233);
const DATABASE = "cr_gate_lock_order";
const OWNER_APP = "gate-lock-order-owner", QUALITY_APP = "gate-lock-order-quality";
const exec = promisify(execFile);
let run = "", started = false;
const pools: Pool[] = [];
const native = (name: string, args: string[]) => exec(join(BIN, name), args,
  { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TMPDIR: run, NODE_ENV: "test" }, timeout: 120_000, maxBuffer: 1 << 26 });
const pool = (user: string, application_name: string, password?: string) => {
  const created = new Pool({ host: "127.0.0.1", port: PORT, database: DATABASE, user, password, max: 4, application_name });
  created.on("error", () => {});
  pools.push(created); return created;
};

/** The PGlite surface the shared fixtures use, over a superuser pool. */
function fixtureDatabase(source: Pool): NativeTaskFixtureDatabase {
  const transaction = async <T>(work: (tx: { query: Pool["query"] }) => Promise<T>) => {
    const client = await source.connect();
    try {
      await client.query("BEGIN");
      const result = await work({ query: client.query.bind(client) as Pool["query"] });
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  };
  return { exec: async (sql: string) => { await source.query(sql); return []; },
    query: (sql: string, params?: unknown[]) => source.query(sql, params),
    transaction, close: async () => {} } as unknown as NativeTaskFixtureDatabase;
}

/** Plain application DatabaseClient over one role's pool; every transaction is one connection. */
function applicationDatabase(source: Pool, onQuery: (sql: string) => Promise<void> = async () => {}): DatabaseClient {
  const within = async <T>(work: (tx: DatabaseSession) => Promise<T>, check: () => void | Promise<void> = () => {}) => {
    const client = await source.connect();
    try {
      await client.query("BEGIN");
      const result = await work({ async query<R>(sql: string, params?: unknown[]) {
        const rows = (await client.query(sql, params)).rows as R[]; await onQuery(sql); return { rows };
      } });
      await check(); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  };
  return { query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await source.query(sql, params)).rows as R[] }),
    transaction: work => within(work), transactionWithPreCommitCheck: (work, check) => within(work, check) };
}

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

before(async () => {
  if (!PG_AVAILABLE) return;
  run = await mkdtemp(join(tmpdir(), "cr-gate-lock-"));
  const data = join(run, "data");
  await mkdir(data, { recursive: true, mode: 0o700 });
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "gate_admin", "--auth-local=trust", "--auth-host=trust", "--no-locale", "--encoding=UTF8"]);
  started = true;
  // deadlock_timeout is left at the PostgreSQL default (1s), as in production.
  await native("pg_ctl", ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "30", "-o",
    `-p ${PORT} -k '${run}' -c listen_addresses=127.0.0.1 -c shared_buffers=32MB -c max_connections=40`, "start"]);
  const bootstrap = new Client({ host: "127.0.0.1", port: PORT, database: "postgres", user: "gate_admin" });
  await bootstrap.connect();
  try { await bootstrap.query(`CREATE DATABASE ${DATABASE}`); } finally { await bootstrap.end(); }
});

/** The real role files, applied after the fixture's migrations and seed data. */
async function applyRoles() {
  const admin = new Client({ host: "127.0.0.1", port: PORT, database: DATABASE, user: "gate_admin" });
  await admin.connect();
  try {
    for (const file of ["private_web_roles.sql", "private_web_database.sql", "task_coordinator_roles.sql"])
      await admin.query(await readFile(join(ROOT, "db/roles", file), "utf8"));
    await admin.query(`CREATE ROLE gate_owner_web LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD 'gateowner' IN ROLE control_room_private_web`);
    await admin.query(`CREATE ROLE gate_quality LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD 'gatequality' IN ROLE control_room_task_coordinator`);
  } finally { await admin.end(); }
}

after(async () => {
  await Promise.allSettled(pools.map(value => value.end()));
  if (started) await native("pg_ctl", ["-D", join(run, "data"), "-m", "fast", "-w", "-t", "30", "stop"]).catch(() => {});
  if (run) await rm(run, { recursive: true, force: true });
});

test("owner accept and a concurrent quality inspection of the same job cannot deadlock on the completion gate", needsPg, async t => {
  const f = await nativeQualityBatchFixture({ database: fixtureDatabase(pool("gate_admin", "gate-lock-order-fixture")) });
  t.after(() => f.close());
  await applyRoles();
  const clock = () => instant + 6000;
  const observer = pool("gate_admin", "gate-lock-order-observer");

  // Quality side: the real verifier as the coordinator login. Pause the
  // transaction immediately after its job row lock, before it asks for the gate.
  const qualityHoldsJob = deferred(), releaseQuality = deferred();
  let paused = false;
  const qualityDb = applicationDatabase(pool("gate_quality", QUALITY_APP, "gatequality"), async sql => {
    if (paused || !/FROM control_jobs[\s\S]*FOR UPDATE/u.test(sql)) return;
    paused = true; qualityHoldsJob.resolve(); await releaseQuality.promise;
  });
  const verifier = new NativeResultVerificationService(qualityDb, f.qualityConfig, f.scenarios, clock);
  const quality = verifier.verify(f.request, () => {});
  await qualityHoldsJob.promise;

  // Owner side: the real owner-accept service as the private-web login.
  const owner = new WebTaskReviewService(applicationDatabase(pool("gate_owner_web", OWNER_APP, "gateowner")), f.scope,
    { integrityKey: f.reviewKey, checkpoints: f.checkpoints, harnessIntegrityKey: f.harnessKey, results: f.config }, clock);
  const accept = owner.record(f.identity, binding.projectId, binding.jobId, { artifactId: f.artifact.artifactId,
    targetId: f.target.id, targetDigest: sha256Digest(f.target), contentHash: f.artifact.contentHash,
    decision: "accepted", feedback: "" }, "gate-lock-order-accept-0001");
  accept.catch(() => {});

  // Wait until the owner transaction is blocked on a lock held by the paused
  // quality transaction, then capture which relations it already holds.
  let waiting: { pid: number; query: string } | undefined;
  for (let attempt = 0; attempt < 400 && !waiting; attempt++) {
    waiting = (await observer.query<{ pid: number; query: string }>(`SELECT pid,query FROM pg_stat_activity
      WHERE application_name=$1 AND wait_event_type='Lock'`, [OWNER_APP])).rows[0];
    if (!waiting) await new Promise(done => setTimeout(done, 25));
  }
  assert.ok(waiting, "owner accept never waited on the quality transaction's job lock");
  const held = (await observer.query<{ relation: string }>(`SELECT DISTINCT relation::regclass::text AS relation FROM pg_locks
    WHERE pid=$1 AND granted AND locktype='relation'`, [waiting.pid])).rows.map(row => row.relation);
  releaseQuality.resolve();

  const [verified, accepted] = await Promise.allSettled([quality, accept]);
  const reason = (value: PromiseSettledResult<unknown>) => value.status === "rejected"
    ? `${(value.reason as { code?: string })?.code ?? ""} ${(value.reason as Error)?.message ?? value.reason}` : "fulfilled";
  const serverDeadlock = async () => (await readFile(join(run, "server.log"), "utf8")).split("\n")
    .filter(line => /deadlock|Process \d+|while locking/u.test(line)).join("\n");
  if (accepted.status === "rejected" || verified.status === "rejected")
    t.diagnostic(`PostgreSQL log:\n${await serverDeadlock()}`);
  assert.equal(accepted.status, "fulfilled", `owner accept failed: ${reason(accepted)}`);
  assert.equal(verified.status, "fulfilled", `quality verification failed: ${reason(verified)}`);
  // Canonical order: the owner waits for the job parent before it touches the
  // tenant completion-gate integrity row, never while holding it.
  assert.equal(held.includes("control_completion_gate_integrity"), false,
    `owner accept held the completion-gate integrity row while waiting at: ${waiting.query}`);
  assert.match(waiting.query, /FROM control_jobs/u);

  const reviews = await observer.query("SELECT id FROM control_completion_gate_records WHERE tenant_id=$1 AND kind='review'",
    [f.scope.tenantId]);
  const verifications = await observer.query("SELECT id FROM control_completion_gate_records WHERE tenant_id=$1 AND kind='verification'",
    [f.scope.tenantId]);
  assert.equal(reviews.rows.length, 1);
  assert.equal(verifications.rows.length, f.scenarios.length);
});
