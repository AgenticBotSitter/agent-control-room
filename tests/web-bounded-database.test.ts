import assert from "node:assert/strict";
import test from "node:test";
import { boundPrivateDatabase, PrivateDatabaseError, privateDatabaseLimits, type PrivateDatabaseLease } from "../src/web/v1/bounded-database";
import { createPrivatePostgresDatabase, privatePostgresOptions } from "../src/web/v1/private-postgres";
import { startupConfig } from "./helpers/web-startup";
import { databaseOperationSignal } from "../src/persistence/operation-signal";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>(r => setTimeout(r, 0));

test("database operation signals are isolated, flow into precommit and expire on completion", async () => {
  const first = fake(), second = fake(), a = boundPrivateDatabase(first.driver), b = boundPrivateDatabase(second.driver);
  const entered = deferred<void>(), release = deferred<void>(); let captured!: AbortSignal, other!: AbortSignal;
  assert.equal(databaseOperationSignal(), undefined);
  const running = a.client.transactionWithPreCommitCheck(async () => {
    captured = databaseOperationSignal()!; assert.equal(captured.aborted, false); entered.resolve(); await release.promise;
    assert.equal(databaseOperationSignal(), captured);
  }, () => { assert.equal(databaseOperationSignal(), captured); assert.equal(captured.aborted, false); });
  await entered.promise;
  await b.client.transaction(async () => { other = databaseOperationSignal()!; assert.notEqual(other, captured); });
  assert.equal(other.aborted, true); assert.equal(captured.aborted, false); assert.equal(databaseOperationSignal(), undefined);
  release.resolve(); await running; assert.equal(captured.aborted, true);
  await a.close(); await b.close();
});

test("nested operations inherit parent cancellation without issuing a late statement", async () => {
  const first = fake(), second = fake(), a = boundPrivateDatabase(first.driver), b = boundPrivateDatabase(second.driver);
  const entered = deferred<void>(), release = deferred<void>(); let child!: AbortSignal;
  const running = a.client.transaction(async () => b.client.transaction(async tx => {
    child = databaseOperationSignal()!; entered.resolve(); await release.promise; await tx.query("LATE WRITE");
  }));
  const observed = assert.rejects(running, /database_outcome_uncertain/);
  await entered.promise; await a.close(); assert.equal(child.aborted, true);
  release.resolve(); await observed; await tick();
  assert.deepEqual(second.statements, ["BEGIN"]); await b.close();
});

test("async precommit waits before COMMIT and rejected checks roll back", async () => {
  for (const refuses of [false, true]) {
    const entered = deferred<void>(), release = deferred<void>(), f = fake();
    const pool = boundPrivateDatabase(f.driver);
    const running = pool.client.transactionWithPreCommitCheck(async tx => { await tx.query("TEST WORK"); return 42; }, async () => {
      entered.resolve(); await release.promise; if (refuses) throw new Error("synthetic_check_refused");
    });
    const observed = refuses ? assert.rejects(running, /synthetic_check_refused/) : running;
    await entered.promise; assert.deepEqual(f.statements, ["BEGIN", "TEST WORK"]);
    release.resolve(); const result = await observed;
    if (!refuses) assert.equal(result, 42);
    assert.deepEqual(f.statements, ["BEGIN", "TEST WORK", refuses ? "ROLLBACK" : "COMMIT"]);
    assert.equal(f.releases(), 1); await pool.close();
  }
});

test("async precommit timeout quarantines the pool and late completion cannot commit", async () => {
  const entered = deferred<void>(), release = deferred<void>(), f = fake();
  const pool = boundPrivateDatabase(f.driver, { ...privateDatabaseLimits, transactionMs: 20 });
  const running = pool.client.transactionWithPreCommitCheck(async () => 42, async () => {
    entered.resolve(); await release.promise;
  });
  const observed = assert.rejects(running, /database_outcome_uncertain/);
  await entered.promise; await observed;
  assert.equal(pool.isAvailable(), false); assert.equal(f.closes(), 1);
  release.resolve(); await tick();
  assert.deepEqual(f.statements, ["BEGIN"]); assert.equal(f.releases(), 1);
  await pool.close(); assert.equal(f.closes(), 1);
});

test("a swallowed query failure during async precommit cannot commit", async () => {
  const f = fake(async statement => { if (statement === "FAIL CHECK QUERY") throw new Error("synthetic_query_failure"); return { rows: [] }; });
  const pool = boundPrivateDatabase(f.driver); let retained!: PrivateDatabaseLease;
  await assert.rejects(pool.client.transactionWithPreCommitCheck(async tx => { retained = tx as PrivateDatabaseLease; }, async () => {
    await retained.query("FAIL CHECK QUERY").catch(() => {});
  }), /database_outcome_uncertain/);
  assert.deepEqual(f.statements, ["BEGIN", "FAIL CHECK QUERY"]);
  assert.equal(pool.isAvailable(), false); await pool.close();
});
function fake(query: (statement: string) => Promise<{ rows: never[] }> = async () => ({ rows: [] })) {
  const statements: string[] = []; let releases = 0, closes = 0;
  const lease: PrivateDatabaseLease = { async query<T>(statement: string) { statements.push(statement); return await query(statement) as { rows: T[] }; },
    release: () => { releases++; } };
  return { lease, statements, releases: () => releases, closes: () => closes,
    driver: { acquire: async () => lease, terminate: async () => { closes++; } } };
}
test("private options require explicit credentials and pin bounded PG17 same-host operation", () => {
  const options = privatePostgresOptions(startupConfig.database);
  assert.equal(options.max, 8); assert.equal(options.ssl, false);
  assert.equal(options.prepare, false);
  assert.equal(options.connection.transaction_timeout, 10000); assert.equal(options.connection.lock_timeout, 2000);
  for (const patch of [{ password: "" }, { host: "localhost" }, { port: 0 }, { database: "" }, { username: "" }, { majorVersion: 16 }])
    assert.throws(() => privatePostgresOptions({ ...startupConfig.database, ...patch } as typeof startupConfig.database));
});

test("private postgres adapter uses one reserved session, extended parameters, no prepared retry and one zero-timeout end", async () => {
  const seen: { statement: string; params: unknown[] }[] = []; let reserves = 0, releases = 0, ends = 0;
  const pool = createPrivatePostgresDatabase(startupConfig.database, options => {
    assert.equal(options.username, "web_test"); assert.equal(options.max_pipeline, 1);
    assert.equal(options.prepare, false); assert.equal(options.connection.search_path, "pg_catalog, public");
    return { reserve: async () => { reserves++; return { unsafe: async (statement, params, queryOptions) => {
      assert.deepEqual(queryOptions, { prepare: false, simple: false }); seen.push({ statement, params });
      return statement === "SELECT $1 AS value" ? [{ value: params[0] }] : [];
    }, release: () => { releases++; } }; }, end: async value => { ends++; assert.deepEqual(value, { timeout: 0 }); } };
  });
  assert.equal(reserves, 0);
  assert.deepEqual((await pool.client.transaction(tx => tx.query("SELECT $1 AS value", [42]))).rows, [{ value: 42 }]);
  assert.deepEqual(seen.map(x => x.statement), ["BEGIN", "SELECT $1 AS value", "COMMIT"]);
  assert.equal(reserves, 1); assert.equal(releases, 1); await pool.close(); await pool.close(); assert.equal(ends, 1);
});
test("commit follows the precommit check, rollback follows callback failure, escaped sessions cannot query", async () => {
  const f = fake(); const pool = boundPrivateDatabase(f.driver);
  let escaped!: PrivateDatabaseLease;
  await pool.client.transactionWithPreCommitCheck(async tx => { escaped = tx as PrivateDatabaseLease; await tx.query("SELECT 1"); },
    () => { f.statements.push("CHECK"); });
  assert.deepEqual(f.statements, ["BEGIN", "SELECT 1", "CHECK", "COMMIT"]);
  await assert.rejects(escaped.query("SELECT 2"));
  await assert.rejects(pool.client.transaction(async () => { throw new Error("callback"); }), /callback/);
  assert.deepEqual(f.statements.slice(-2), ["BEGIN", "ROLLBACK"]);
  assert.equal(f.releases(), 2); assert.equal(pool.close(), pool.close()); await pool.close(); assert.equal(f.closes(), 1);
});
test("admission has no pending queue and a timed-out checkout quarantines late leases", async () => {
  const pending = deferred<PrivateDatabaseLease>(); const f = fake(); let acquisitions = 0;
  const pool = boundPrivateDatabase({ ...f.driver, acquire: () => { acquisitions++; return pending.promise; } },
    { ...privateDatabaseLimits, connections: 1, checkoutMs: 10 });
  const running = pool.client.transaction(async tx => { await tx.query("SELECT 1"); });
  await assert.rejects(pool.client.query("SELECT 2"), /database_unavailable/);
  await assert.rejects(running, /database_outcome_uncertain/);
  assert.equal(acquisitions, 1); assert.equal(pool.isAvailable(), false);
  pending.resolve(f.lease); await tick();
  assert.deepEqual(f.statements, []); assert.equal(f.releases(), 1); await pool.close(); assert.equal(f.closes(), 1);
});
test("stalled statements terminate the driver, cannot commit later, and never retry writes", async () => {
  const pending = deferred<{ rows: never[] }>(); const f = fake(async statement => statement === "TEST WORK" ? pending.promise : { rows: [] });
  const pool = boundPrivateDatabase(f.driver, { ...privateDatabaseLimits, statementMs: 10 });
  await assert.rejects(pool.client.transaction(async tx => { await tx.query("TEST WORK"); }), /outcome_uncertain/);
  pending.resolve({ rows: [] }); await tick();
  assert.deepEqual(f.statements, ["BEGIN", "TEST WORK"]); await pool.close(); assert.equal(f.closes(), 1);
});
test("whole-transaction deadline blocks a late callback and precommit without relying on statement progress", async () => {
  const pending = deferred<void>(); const f = fake(); const pool = boundPrivateDatabase(f.driver, { ...privateDatabaseLimits, transactionMs: 10 });
  let checked = false;
  await assert.rejects(pool.client.transactionWithPreCommitCheck(async tx => { await pending.promise; await tx.query("TEST WORK"); },
    () => { checked = true; }), /outcome_uncertain/);
  pending.resolve(); await tick(); assert.equal(checked, false); assert.deepEqual(f.statements, ["BEGIN"]); await pool.close();
});
test("close failure or a stalled close remains uncertain and termination is attempted only once", async () => {
  let closes = 0; const f = fake();
  const pool = boundPrivateDatabase({ ...f.driver, terminate: () => { closes++; return new Promise(() => {}); } },
    { ...privateDatabaseLimits, closeMs: 10 });
  await assert.rejects(pool.close(), /database_close_uncertain/); await assert.rejects(pool.close(), /database_close_uncertain/);
  assert.equal(closes, 1); await assert.rejects(pool.client.query("SELECT 1"), /database_unavailable/);
});

test("fast COMMIT uncertainty quarantines without a late rollback and waits for bounded termination", async () => {
  const termination = deferred<void>(); let closes = 0;
  const f = fake(async statement => { if (statement === "COMMIT") throw new Error("lost acknowledgement"); return { rows: [] }; });
  const pool = boundPrivateDatabase({ ...f.driver, terminate: () => { closes++; return termination.promise; } });
  let settled = false;
  const work = pool.client.transaction(tx => tx.query("TEST WORK"));
  void work.then(() => { settled = true; }, () => { settled = true; });
  await tick(); assert.equal(pool.isAvailable(), false); assert.equal(settled, false);
  assert.deepEqual(f.statements, ["BEGIN", "TEST WORK", "COMMIT"]);
  await assert.rejects(pool.client.query("SELECT 1"), /database_unavailable/);
  termination.resolve(); await assert.rejects(work, /database_outcome_uncertain/);
  await pool.close(); assert.equal(closes, 1); assert.equal(f.releases(), 1);
});

test("failed ROLLBACK overrides callback failure with terminal uncertainty", async () => {
  const f = fake(async statement => { if (statement === "ROLLBACK") throw new Error("rollback failed"); return { rows: [] }; });
  const pool = boundPrivateDatabase(f.driver);
  await assert.rejects(pool.client.transaction(async () => { throw new Error("ordinary callback failure"); }),
    { message: "database_outcome_uncertain" });
  assert.equal(pool.isAvailable(), false); assert.deepEqual(f.statements, ["BEGIN", "ROLLBACK"]);
  await pool.close(); assert.equal(f.closes(), 1);
});

test("fast driver statement uncertainty quarantines instead of attempting more transaction commands", async () => {
  const f = fake(async statement => { if (statement === "TEST WORK") throw new PrivateDatabaseError("database_outcome_uncertain"); return { rows: [] }; });
  const pool = boundPrivateDatabase(f.driver);
  await assert.rejects(pool.client.transaction(tx => tx.query("TEST WORK")), /database_outcome_uncertain/);
  assert.deepEqual(f.statements, ["BEGIN", "TEST WORK"]); assert.equal(pool.isAvailable(), false);
  await pool.close(); assert.equal(f.closes(), 1);
});
