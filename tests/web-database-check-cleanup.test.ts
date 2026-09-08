import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateWebDatabaseCheck } from "../src/web/v1/private-startup.ts";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup.ts";
import { now } from "./helpers/web-foundation.ts";

test("a passed preflight cannot report success when connection cleanup rejects", async () => {
  const f = await limitedWebFixture();
  const check = createPrivateWebDatabaseCheck({ openDatabase: () => ({ ...f.pool,
    close: async () => { await f.pool.close(); throw new Error("synthetic cleanup uncertainty"); },
  }), clock: () => now });
  await assert.rejects(check(startupConfig), /^Error: private_database_check_cleanup_uncertain$/);
  assert.equal(f.closes(), 1);
});

test("a failed preflight closes its pool once and retains the failure", async () => {
  let closes = 0;
  const check = createPrivateWebDatabaseCheck({ openDatabase: () => ({
    client: { query: async () => { throw new Error("synthetic query detail"); },
      transaction: async () => { throw new Error("synthetic query detail"); },
      transactionWithPreCommitCheck: async () => { throw new Error("synthetic query detail"); } },
    isAvailable: () => true, close: async () => { closes++; },
  }), clock: () => now });
  await assert.rejects(check(startupConfig), /^Error: private_database_check_failed$/);
  assert.equal(closes, 1);
});
