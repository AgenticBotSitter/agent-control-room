import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { PrivateDatabaseError } from "../src/web/v1/bounded-database";
import { recoveringPrivateDatabase, type RecoveringPrivateDatabaseGeneration } from "../src/web/v1/recovering-private-database";

function generation(runQuery: (statement: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
  close: () => Promise<void> = async () => {}) {
  let available = true, closes = 0;
  const query: DatabaseClient["query"] = async <T>(statement: string, params?: unknown[]) => {
    const result = await runQuery(statement, params); return { rows: result.rows as T[] };
  };
  const client = Object.freeze<DatabaseClient>({
    query,
    transaction: <T>(work: (session: DatabaseSession) => Promise<T>) => work({ query }),
    transactionWithPreCommitCheck: async <T>(work: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) => {
      const result = await work({ query }); await check(); return result;
    },
  });
  return {
    value: Object.freeze<RecoveringPrivateDatabaseGeneration>({ client, isAvailable: () => available,
      close: async () => { available = false; closes++; await close(); } }),
    unavailable: () => { available = false; },
    closes: () => closes,
  };
}

async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail("condition_not_reached");
}

test("a failed operation is never replayed and a qualified generation serves later calls", async () => {
  const statements: string[] = [];
  const first = generation(async statement => {
    statements.push(`first:${statement}`); first.unavailable();
    throw new PrivateDatabaseError("database_outcome_uncertain");
  });
  const second = generation(async statement => { statements.push(`second:${statement}`); return { rows: [{ ok: true }] }; });
  let opens = 0;
  const database = recoveringPrivateDatabase(() => [first.value, second.value][opens++]!,
    { delaysMs: [1], sleep: async () => {} });
  await assert.rejects(database.client.query("INSERT once"), { message: "database_outcome_uncertain" });
  await eventually(() => database.isAvailable());
  assert.deepEqual(await database.client.query("SELECT later"), { rows: [{ ok: true }] });
  assert.deepEqual(statements, ["first:INSERT once", "second:SELECT 1", "second:SELECT later"]);
  assert.equal(opens, 2); assert.equal(first.closes(), 1);
  await database.close(); assert.equal(second.closes(), 1);
});

test("ordinary bounded refusal on a healthy generation does not trigger replacement", async () => {
  const first = generation(async () => { throw new PrivateDatabaseError("database_unavailable"); });
  let opens = 0;
  const database = recoveringPrivateDatabase(() => { opens++; return first.value; }, { delaysMs: [1], sleep: async () => {} });
  await assert.rejects(database.client.query("SELECT overloaded"), { message: "database_unavailable" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(database.isAvailable(), true); assert.equal(opens, 1); assert.equal(first.closes(), 0);
  await database.close();
});

test("an uncertain transaction callback runs once and is not replayed on the replacement", async () => {
  let callbacks = 0;
  const first = generation(async statement => {
    if (statement === "UPDATE once") { first.unavailable(); throw new PrivateDatabaseError("database_outcome_uncertain"); }
    return { rows: [] };
  });
  const second = generation(async () => ({ rows: [] }));
  const values = [first.value, second.value]; let opens = 0;
  const database = recoveringPrivateDatabase(() => values[opens++]!, { delaysMs: [1], sleep: async () => {} });
  await assert.rejects(database.client.transaction(async session => {
    callbacks++; await session.query("UPDATE once");
  }), { message: "database_outcome_uncertain" });
  await eventually(() => database.isAvailable());
  assert.equal(callbacks, 1); assert.equal(opens, 2);
  await database.close();
});

test("uncertain cleanup blocks replacement instead of opening overlapping pools", async () => {
  const first = generation(async () => {
    first.unavailable(); throw new PrivateDatabaseError("database_outcome_uncertain");
  }, async () => { throw new Error("must not escape"); });
  let opens = 0;
  const database = recoveringPrivateDatabase(() => { opens++; return first.value; }, { delaysMs: [1], sleep: async () => {} });
  await assert.rejects(database.client.query("UPDATE uncertain"), { message: "database_outcome_uncertain" });
  await eventually(() => !database.isAvailable());
  await assert.rejects(database.client.query("SELECT refused"), { message: "database_unavailable" });
  assert.equal(opens, 1); assert.equal(first.closes(), 1);
  await assert.rejects(database.close(), { message: "database_close_uncertain" });
});

test("failed candidates back off and close before the next generation opens", async () => {
  const order: string[] = [];
  const first = generation(async () => {
    first.unavailable(); throw new PrivateDatabaseError("database_outcome_uncertain");
  }, async () => { order.push("close:first"); });
  const rejected = generation(async () => { rejected.unavailable(); throw new PrivateDatabaseError("database_unavailable"); },
    async () => { order.push("close:rejected"); });
  const ready = generation(async statement => { order.push(`ready:${statement}`); return { rows: [] }; });
  const values = [first.value, rejected.value, ready.value]; let opens = 0;
  const database = recoveringPrivateDatabase(() => { order.push(`open:${opens + 1}`); return values[opens++]!; },
    { delaysMs: [3, 7], sleep: async ms => { order.push(`sleep:${ms}`); } });
  await assert.rejects(database.client.query("DELETE uncertain"));
  await eventually(() => database.isAvailable());
  assert.deepEqual(order, ["open:1", "close:first", "sleep:3", "open:2", "close:rejected", "sleep:7", "open:3", "ready:SELECT 1"]);
  await database.close();
});

test("a candidate that faults as its probe completes is never published", async () => {
  const first = generation(async () => {
    first.unavailable(); throw new PrivateDatabaseError("database_outcome_uncertain");
  });
  const raced = generation(async () => { raced.unavailable(); return { rows: [] }; });
  const ready = generation(async () => ({ rows: [] }));
  const values = [first.value, raced.value, ready.value]; let opens = 0;
  const database = recoveringPrivateDatabase(() => values[opens++]!, { delaysMs: [1], sleep: async () => {} });
  await assert.rejects(database.client.query("SELECT fault"));
  await eventually(() => database.isAvailable());
  assert.equal(opens, 3); assert.equal(raced.closes(), 1);
  await database.close();
});

test("a generation fault between publication and recovery retirement starts another recovery", async () => {
  const first = generation(async () => {
    first.unavailable(); throw new PrivateDatabaseError("database_outcome_uncertain");
  });
  const raced = generation(async () => ({ rows: [] }));
  const ready = generation(async () => ({ rows: [] }));
  const values = [first.value, raced.value, ready.value]; let opens = 0, reportRacedFault!: () => void;
  const database = recoveringPrivateDatabase(reportFault => {
    const value = values[opens++]!;
    if (value !== raced.value) return value;
    reportRacedFault = reportFault;
    let checks = 0;
    return Object.freeze({ ...value, isAvailable: () => {
      checks++;
      if (checks === 2) queueMicrotask(() => { raced.unavailable(); reportRacedFault(); });
      return value.isAvailable();
    } });
  }, { delaysMs: [1], sleep: async () => {} });
  await assert.rejects(database.client.query("SELECT fault"));
  await eventually(() => database.isAvailable());
  assert.equal(opens, 3); assert.equal(raced.closes(), 1);
  await database.close();
});

test("explicit close cancels pending recovery and never opens a replacement", async () => {
  const first = generation(async () => {
    first.unavailable(); throw new PrivateDatabaseError("database_outcome_uncertain");
  });
  let opens = 0, sleeping!: () => void;
  const entered = new Promise<void>(resolve => { sleeping = resolve; });
  const database = recoveringPrivateDatabase(() => { opens++; return first.value; }, { delaysMs: [30_000],
    sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
      sleeping(); signal.addEventListener("abort", () => reject(new PrivateDatabaseError("database_unavailable")), { once: true });
    }) });
  await assert.rejects(database.client.query("INSERT uncertain"));
  await entered; await database.close();
  assert.equal(opens, 1); assert.equal(first.closes(), 1);
  await assert.rejects(database.client.query("SELECT closed"), { message: "database_unavailable" });
});
