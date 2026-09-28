import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrivatePgDriver } from "../src/web/v1/private-pg-driver";
import { boundPrivateDatabase } from "../src/web/v1/bounded-database";
import { qualifyPrivatePgSession } from "../src/web/v1/private-pg-qualification";
import { sanitizedDatabaseFailureV1 } from "../src/web/v1/sanitized-database-failure";
import { withDatabaseOperationSignal } from "../src/persistence/operation-signal";

test("qualification refusal destroys the lease before returning application access", async () => {
  for (const rows of [[], [{ qualified: false }], [{ qualified: "true" }], [{ qualified: true }, { qualified: true }]]) {
    const releases: boolean[] = [];
    const driver = createPrivatePgDriver({ async connect() { return {
      async query() { return { rows }; }, release(destroy) { releases.push(!!destroy); },
    }; }, async end() {} }, qualifyPrivatePgSession);
    await assert.rejects(driver.acquire(), { message: "database_unavailable" });
    await driver.terminate(); assert.deepEqual(releases, [true]);
  }
});

test("shutdown destroys a lease while qualification is pending", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const releases: boolean[] = [];
  const driver = createPrivatePgDriver({ async connect() { return {
    async query() { return { rows: [] }; }, release(destroy) { releases.push(!!destroy); },
  }; }, async end() {} }, () => { entered(); return new Promise<void>(done => { finish = done; }); });
  const denied = assert.rejects(driver.acquire());
  await started;
  const closing = driver.terminate();
  assert.deepEqual(releases, [true]); finish(); await denied; await closing;
  assert.deepEqual(releases, [true]);
});

test("pg adapter preserves parameters and releases acquired clients exactly once", async () => {
  const released: boolean[] = [];
  let ends = 0;
  const params = [null, ["a", "b"], { value: 1 }];
  const driver = createPrivatePgDriver({
    async connect() { return {
      async query(statement, values) { assert.equal(statement, "SELECT $1"); assert.equal(values, params); return { rows: [{ ok: true }] }; },
      release(destroy) { released.push(!!destroy); },
    }; },
    async end() { ends++; },
  });
  const lease = await driver.acquire();
  assert.deepEqual(await lease.query("SELECT $1", params), { rows: [{ ok: true }] });
  lease.release(); lease.release();
  await assert.rejects(lease.query("SELECT 1"));
  await Promise.all([driver.terminate(), driver.terminate()]);
  assert.deepEqual(released, [false]); assert.equal(ends, 1);
  await assert.rejects(driver.acquire());
});

test("failed acquisition is sanitized and shutdown still finishes", async () => {
  let ends = 0;
  const driver = createPrivatePgDriver({ async connect() { throw new Error("private connection detail"); }, async end() { ends++; } });
  await assert.rejects(driver.acquire(), { message: "database_unavailable" });
  await driver.terminate(); assert.equal(ends, 1);
});

test("one bounded pool-width waits for a connection instead of failing an ordinary burst", async () => {
  let releaseFirst!: () => void, firstEntered!: () => void, secondEntered = false, acquisitions = 0;
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  const db = boundPrivateDatabase({ async acquire() { acquisitions++; return {
    async query(statement) {
      if (statement === "SELECT first") { firstEntered(); await held; }
      if (statement === "SELECT second") secondEntered = true;
      return { rows: [] };
    }, release() {},
  }; }, async terminate() {} }, { connections: 1, checkoutMs: 1_000, statementMs: 1_000, transactionMs: 1_000, closeMs: 1_000 });
  const first = db.client.query("SELECT first"); await entered;
  const second = db.client.query("SELECT second");
  await assert.rejects(db.client.query("SELECT overload"), { message: "database_unavailable" });
  assert.equal(secondEntered, false); assert.equal(acquisitions, 1);
  releaseFirst(); await Promise.all([first, second]);
  assert.equal(secondEntered, true); assert.equal(acquisitions, 2);
  await db.close();
});

test("a queued caller receives a fresh operation budget without terminating the pool", async () => {
  let releaseFirst!: () => void, firstEntered!: () => void, secondEntered!: () => void;
  let finishSecond!: () => void, bystanderRan = false, terminations = 0;
  const firstStarted = new Promise<void>(resolve => { firstEntered = resolve; });
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondStarted = new Promise<void>(resolve => { secondEntered = resolve; });
  const secondHeld = new Promise<void>(resolve => { finishSecond = resolve; });
  const db = boundPrivateDatabase({ async acquire() { return {
    async query(statement) {
      if (statement === "SELECT first") { firstEntered(); await firstHeld; }
      if (statement === "SELECT slow_after_queue") { secondEntered(); await secondHeld; }
      if (statement === "SELECT bystander") bystanderRan = true;
      return { rows: [] };
    }, release() {},
  }; }, async terminate() { terminations++; } },
  { connections: 1, checkoutMs: 500, statementMs: 500, transactionMs: 500, closeMs: 500 });

  const first = db.client.query("SELECT first"); await firstStarted;
  const slowAfterQueue = db.client.query("SELECT slow_after_queue");
  await new Promise(resolve => setTimeout(resolve, 300));
  releaseFirst(); await first; await secondStarted;
  const bystander = db.client.query("SELECT bystander");
  await new Promise(resolve => setTimeout(resolve, 300));
  finishSecond(); await Promise.all([slowAfterQueue, bystander]);

  assert.equal(bystanderRan, true); assert.equal(db.isAvailable(), true); assert.equal(terminations, 0);
  await db.close(); assert.equal(terminations, 1);
});

test("admission wait is bounded by checkoutMs without terminating the pool", async () => {
  let releaseHolder!: () => void, holderEntered!: () => void;
  const entered = new Promise<void>(resolve => { holderEntered = resolve; });
  const held = new Promise<void>(resolve => { releaseHolder = resolve; });
  let terminations = 0;
  const db = boundPrivateDatabase({ async acquire() { return {
    async query(statement) {
      if (statement === "SELECT holder") { holderEntered(); await held; }
      return { rows: [] };
    }, release() {},
  }; }, async terminate() { terminations++; } },
  { connections: 1, checkoutMs: 200, statementMs: 1_000, transactionMs: 1_000, closeMs: 1_000 });

  const holder = db.client.query("SELECT holder"); await entered;
  const queued = db.client.query("SELECT queued");
  let holderReleased = false;
  const scheduledRelease = new Promise<void>(resolve => setTimeout(() => {
    holderReleased = true; releaseHolder(); resolve();
  }, 300));
  await assert.rejects(queued, { message: "database_unavailable" });
  assert.equal(holderReleased, false, "admission must expire before the holder is released at 1.5x checkoutMs");
  await scheduledRelease; await holder;
  const available = db.isAvailable(), terminationsBeforeClose = terminations;
  await db.close();
  assert.equal(available, true); assert.equal(terminationsBeforeClose, 0); assert.equal(terminations, 1);
});

test("transaction operation budget quarantines a pool that exceeds transactionMs", async () => {
  let committed = false;
  let terminations = 0;
  const db = boundPrivateDatabase({ async acquire() { return {
    async query() { await new Promise(resolve => setTimeout(resolve, 30)); return { rows: [] }; },
    release() {},
  }; }, async terminate() { terminations++; } },
  { connections: 1, checkoutMs: 100, statementMs: 100, transactionMs: 300, closeMs: 100 });

  await assert.rejects(db.client.transaction(async session => {
    for (let index = 0; index < 15; index += 1) await session.query(`SELECT ${index}`);
    committed = true;
  }), { message: "database_outcome_uncertain" });
  assert.equal(committed, false, "the callback must not finish work beyond the operation budget");
  assert.equal(db.isAvailable(), false); assert.equal(terminations, 1);
});

test("an aborted queued operation leaves admission immediately for the next caller", async () => {
  let releaseFirst!: () => void, firstEntered!: () => void, thirdEntered = false;
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  const db = boundPrivateDatabase({ async acquire() { return {
    async query(statement) {
      if (statement === "SELECT first") { firstEntered(); await held; }
      if (statement === "SELECT third") thirdEntered = true;
      return { rows: [] };
    }, release() {},
  }; }, async terminate() {} }, { connections: 1, checkoutMs: 1_000, statementMs: 1_000, transactionMs: 1_000, closeMs: 1_000 });
  const first = db.client.query("SELECT first"); await entered;
  const controller = new AbortController();
  const aborted = withDatabaseOperationSignal(controller.signal, () => db.client.query("SELECT aborted"));
  controller.abort(); await assert.rejects(aborted, { message: "database_unavailable" });
  const third = db.client.query("SELECT third");
  releaseFirst(); await Promise.all([first, third]);
  assert.equal(thirdEntered, true);
  await db.close();
});

test("close wins the immediate-admission yield before any lease is acquired", async () => {
  let acquisitions = 0, terminations = 0;
  const db = boundPrivateDatabase({ async acquire() { acquisitions++; return {
    async query() { return { rows: [] }; }, release() {},
  }; }, async terminate() { terminations++; } });
  const operation = db.client.query("SELECT never_acquired");
  await db.close();
  await assert.rejects(operation, { message: "database_unavailable" });
  assert.equal(acquisitions, 0); assert.equal(terminations, 1);
});

test("never-settling acquisition still starts pool shutdown and reports bounded uncertainty", async () => {
  let ends = 0;
  const db = boundPrivateDatabase(createPrivatePgDriver({ connect: () => new Promise(() => {}), async end() { ends++; } }),
    { connections: 1, checkoutMs: 10, statementMs: 20, transactionMs: 30, closeMs: 10 });
  await assert.rejects(db.client.query("SELECT 1"), { message: "database_close_uncertain" });
  assert.equal(ends, 1); assert.equal(db.isAvailable(), false);
  await assert.rejects(db.close(), { message: "database_close_uncertain" });
});

test("lost commit acknowledgement stops the pool without rollback or replay", async () => {
  const statements: string[] = [];
  const releases: boolean[] = [];
  let ends = 0;
  const db = boundPrivateDatabase(createPrivatePgDriver({ async connect() { return {
    async query(statement) { statements.push(statement); if (statement === "COMMIT") throw new Error("lost acknowledgement"); return { rows: [] }; },
    release(destroy) { releases.push(!!destroy); },
  }; }, async end() { ends++; } }));
  await assert.rejects(db.client.transaction(session => session.query("INSERT INTO synthetic VALUES (1)")), { message: "database_outcome_uncertain" });
  assert.deepEqual(statements, ["BEGIN", "INSERT INTO synthetic VALUES (1)", "COMMIT"]);
  assert.deepEqual(releases, [true]); assert.equal(ends, 1);
  await assert.rejects(db.client.query("SELECT 1"), { message: "database_unavailable" });
});

for (const sqlState of ["40P01", "40001"] as const) test(`${sqlState} before COMMIT rolls back one request without stopping the pool`, async () => {
  const statements: string[] = [];
  const releases: boolean[] = [];
  let ends = 0, failed = false;
  const db = boundPrivateDatabase(createPrivatePgDriver({ async connect() { return {
    async query(statement) {
      statements.push(statement);
      if (statement === "INSERT INTO synthetic VALUES (1)" && !failed) {
        failed = true; throw Object.assign(new Error("sensitive postgres detail"), { code: sqlState });
      }
      return { rows: statement === "SELECT 1" ? [{ ok: true }] : [] };
    },
    release(destroy) { releases.push(!!destroy); },
  }; }, async end() { ends++; } }));
  await assert.rejects(db.client.transaction(session => session.query("INSERT INTO synthetic VALUES (1)")),
    { message: "database_unavailable" });
  assert.equal(db.isAvailable(), true);
  assert.deepEqual(await db.client.query("SELECT 1"), { rows: [{ ok: true }] });
  assert.deepEqual(statements, ["BEGIN", "INSERT INTO synthetic VALUES (1)", "ROLLBACK", "SELECT 1"]);
  assert.deepEqual(releases, [false, false]); assert.equal(ends, 0);
  await db.close(); assert.equal(ends, 1);
});

for (const sqlState of ["P0001", "55P03"] as const) test(`${sqlState} is a definite refusal that does not stop the pool`, async () => {
  const statements: string[] = [];
  let failed = false, ends = 0;
  const db = boundPrivateDatabase(createPrivatePgDriver({ async connect() { return {
    async query(statement) {
      statements.push(statement);
      if (statement === "INSERT INTO synthetic VALUES (1)" && !failed) {
        failed = true; throw Object.assign(new Error("must not escape"), { code: sqlState, detail: "secret" });
      }
      return { rows: statement === "SELECT 1" ? [{ ok: true }] : [] };
    }, release() {},
  }; }, async end() { ends++; } }));
  const refusal = await db.client.transaction(session => session.query("INSERT INTO synthetic VALUES (1)"))
    .then(() => undefined, error => error);
  assert.equal(refusal?.message, "database_unavailable");
  assert.equal(refusal?.sqlState, sqlState);
  assert.equal(sanitizedDatabaseFailureV1(refusal), `code=database_unavailable sqlstate=${sqlState}`);
  assert.doesNotMatch(sanitizedDatabaseFailureV1(refusal), /secret|must not escape/);
  assert.equal(db.isAvailable(), true);
  assert.deepEqual(await db.client.query("SELECT 1"), { rows: [{ ok: true }] });
  assert.deepEqual(statements, ["BEGIN", "INSERT INTO synthetic VALUES (1)", "ROLLBACK", "SELECT 1"]);
  assert.equal(ends, 0); await db.close(); assert.equal(ends, 1);
});

for (const sqlState of ["08006", "57P01", "53300", "XX000", "40003"] as const) test(`${sqlState} is not treated as a definite refusal`, async () => {
  const db = boundPrivateDatabase(createPrivatePgDriver({ async connect() { return {
    async query(statement) {
      if (statement === "SELECT 1") throw Object.assign(new Error("lost"), { code: sqlState });
      return { rows: [] };
    }, release() {},
  }; }, async end() {} }));
  const failure = await db.client.query("SELECT 1").then(() => undefined, error => error);
  assert.equal(failure?.sqlState, undefined);
  await db.close().catch(() => {});
});

test("unknown sweep failures expose no exception detail", () => {
  assert.equal(sanitizedDatabaseFailureV1(new Error("password host query detail")), "code=unknown");
  assert.equal(sanitizedDatabaseFailureV1(new Error("mac_local_quality_unavailable")),
    "code=mac_local_quality_unavailable");
});

test("a caught deadlock statement still forces rollback without stopping the pool", async () => {
  const statements: string[] = [];
  let failed = false;
  const db = boundPrivateDatabase(createPrivatePgDriver({ async connect() { return {
    async query(statement) {
      statements.push(statement);
      if (statement === "UPDATE synthetic SET value=1" && !failed) {
        failed = true; throw Object.assign(new Error("deadlock detail"), { code: "40P01" });
      }
      return { rows: [] };
    },
    release() {},
  }; }, async end() {} }));
  await assert.rejects(db.client.transaction(async session => {
    try { await session.query("UPDATE synthetic SET value=1"); } catch {}
  }), { message: "database_unavailable" });
  assert.deepEqual(statements, ["BEGIN", "UPDATE synthetic SET value=1", "ROLLBACK"]);
  assert.equal(db.isAvailable(), true); await db.close();
});

test("a COMMIT-time rollback SQLSTATE still stops the pool because acknowledgement is uncertain", async () => {
  const statements: string[] = [];
  let ends = 0;
  const db = boundPrivateDatabase(createPrivatePgDriver({ async connect() { return {
    async query(statement) {
      statements.push(statement);
      if (statement === "COMMIT") throw Object.assign(new Error("commit failed"), { code: "40001" });
      return { rows: [] };
    },
    release() {},
  }; }, async end() { ends++; } }));
  await assert.rejects(db.client.transaction(session => session.query("INSERT INTO synthetic VALUES (1)")),
    { message: "database_outcome_uncertain" });
  assert.deepEqual(statements, ["BEGIN", "INSERT INTO synthetic VALUES (1)", "COMMIT"]);
  assert.equal(db.isAvailable(), false); assert.equal(ends, 1);
  await assert.rejects(db.client.query("SELECT 1"), { message: "database_unavailable" });
});

test("shutdown invalidates active query even when its response arrives later", async () => {
  let complete!: (result: { rows: unknown[] }) => void;
  const releases: boolean[] = [];
  const driver = createPrivatePgDriver({ async connect() { return {
    query: () => new Promise(done => { complete = done; }),
    release(destroy) { releases.push(!!destroy); },
  }; }, async end() {} });
  const lease = await driver.acquire();
  const query = lease.query("SELECT 1");
  const denied = assert.rejects(query, { message: "database_outcome_uncertain" });
  await driver.terminate(); complete({ rows: [{ ok: true }] }); await denied;
  lease.release(); assert.deepEqual(releases, [true]);
});

test("shutdown waits for and destroys a late acquired client", async () => {
  let resolve!: (value: Awaited<ReturnType<import('../src/web/v1/private-pg-driver').PrivatePgPool['connect']>>) => void;
  const releases: boolean[] = [];
  let ended = false;
  const driver = createPrivatePgDriver({ connect: () => new Promise(done => { resolve = done; }), async end() { ended = true; } });
  const acquisition = driver.acquire();
  const denied = assert.rejects(acquisition);
  await Promise.resolve();
  const closing = driver.terminate();
  assert.equal(ended, false);
  resolve({ async query() { throw new Error("must not query"); }, release(destroy) { releases.push(!!destroy); } });
  await denied; await closing;
  assert.deepEqual(releases, [true]); assert.equal(ended, true);
});
