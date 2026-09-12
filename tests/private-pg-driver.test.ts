import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrivatePgDriver } from "../src/web/v1/private-pg-driver";
import { boundPrivateDatabase } from "../src/web/v1/bounded-database";
import { qualifyPrivatePgSession } from "../src/web/v1/private-pg-qualification";

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
