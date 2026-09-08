import assert from "node:assert/strict";
import test from "node:test";
import { now } from "./helpers/web-foundation";
import { WebIdeaStartOperation } from "../src/web/v1/idea-start-operation";
import type { DatabaseClient } from "../src/persistence/database";
import { fixture, scope, key } from "./helpers/web-idea-start";

test("failed claim audit cannot leave a run or reach a provider", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const commandDb: DatabaseClient = { ...f.client, query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work({ async query<T>(sql: string, params?: unknown[]) {
      if (sql.includes("INSERT INTO audit_events")) throw new Error("synthetic failed audit");
      return tx.query<T>(sql, params);
    } }), check) };
  await assert.rejects(new WebIdeaStartOperation(commandDb, f.runtimeDb, scope, key, f.runtime, () => now)
    .start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest }), /synthetic failed audit/);
  assert.equal(f.counts().calls, 0);
  assert.equal((await f.client.query("SELECT * FROM control_idea_bot_run_events")).rows.length, 0);
});
