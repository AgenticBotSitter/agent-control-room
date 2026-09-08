import assert from "node:assert/strict";
import test from "node:test";
import { now } from "./helpers/web-foundation";
import { WebIdeaStartOperation } from "../src/web/v1/idea-start-operation";
import type { DatabaseClient } from "../src/persistence/database";
import { WebIdeaSynthesisOperation } from "../src/web/v1/idea-synthesis-operation";
import { fixture, scope, key } from "./helpers/web-idea-start";

test("failed synthesis audit rolls back the recap without retrying providers", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const run = await new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now)
    .start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  const db: DatabaseClient = { ...f.client, query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work({ async query<T>(sql: string, params?: unknown[]) {
      if (sql.includes("INSERT INTO audit_events")) throw new Error("synthetic failed audit"); return tx.query<T>(sql, params);
    } }), check) };
  await assert.rejects(new WebIdeaSynthesisOperation(db, scope, key, () => now).synthesize(f.identity, f.saved.sessionId,
    { sessionDigest: f.saved.sessionDigest, runId: run.runId }), /failed audit/);
  assert.equal((await f.client.query("SELECT * FROM control_idea_syntheses")).rows.length, 0); assert.equal(f.counts().calls, 4);
});
