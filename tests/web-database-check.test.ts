import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateWebDatabaseCheck } from "../src/web/v1/private-startup.ts";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup.ts";
import { now } from "./helpers/web-foundation.ts";

test("database-only check reuses strict production preflight, closes its pool, and performs only reads", async () => {
  const f = await limitedWebFixture();
  const statements: string[] = [];
  const query: typeof f.pool.client.query = async (sql, params) => {
    statements.push(sql); return f.pool.client.query(sql, params);
  };
  const client = { ...f.pool.client, transaction: <T>(work: Parameters<typeof f.pool.client.transaction<T>>[0]) =>
    f.pool.client.transaction(tx => work({ query: async (sql, params) => { statements.push(sql); return tx.query(sql, params); } })), query };
  const check = createPrivateWebDatabaseCheck({ openDatabase: () => ({ ...f.pool, client }), clock: () => now });
  const result = await check({ ...startupConfig, loadKeys: async () => { assert.fail("database-only check must not fetch login keys"); } });
  assert.deepEqual(result, { schema: "control-room.private-database-check/v1", databasePreflight: "passed", databaseClosed: true,
    applicationInstalled: false, listenerStarted: false, backupVerified: false, productionReady: false });
  assert.equal(f.closes(), 1);
  assert.ok(statements.length > 4);
  assert.ok(statements.every(sql => /^\s*SELECT\b/i.test(sql)), "No database writes are introduced by the checker");
});

test("database-only check validates before opening and never reports success after query or close failure", async () => {
  let opens = 0, closes = 0;
  const check = createPrivateWebDatabaseCheck({ openDatabase: () => {
    opens++;
    throw new Error("synthetic-private-connection-detail");
  }, clock: () => now });
  await assert.rejects(check({ ...startupConfig, database: { ...startupConfig.database, host: "other" as "127.0.0.1" } }), /invalid/);
  assert.equal(opens, 0);
  await assert.rejects(check(startupConfig), /^Error: private_database_check_failed$/);
  assert.equal(opens, 1);
  const broken = createPrivateWebDatabaseCheck({ openDatabase: () => ({
    client: { query: async () => { throw new Error("synthetic query detail"); },
      transaction: async () => { throw new Error("synthetic query detail"); },
      transactionWithPreCommitCheck: async () => { throw new Error("synthetic query detail"); } },
    isAvailable: () => true, close: async () => { closes++; throw new Error("synthetic close detail"); },
  }), clock: () => now });
  await assert.rejects(broken(startupConfig), /^Error: private_database_check_cleanup_uncertain$/);
  assert.equal(closes, 1);
});
