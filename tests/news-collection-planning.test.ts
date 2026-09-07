import assert from "node:assert/strict";
import test from "node:test";
import { WebNewsCollectionPlanning } from "../src/web/v1/news-collection-planning";
import { WebProjectService } from "../src/web/v1/project-service";
import { AbsFeedPlanStore } from "../src/project-adapters/abs-news/v1/feed-plan-store";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { sha256Digest } from "../src/security";

const key = new Uint8Array(32).fill(61);
async function fixture() {
  let current = now;
  const f = await taskFixture(() => current), scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const template = { configuration: { ...scope, source: { sourceId: "source:feed", sourceLabel: "Example news", sourceKind: "rss",
    endpointUrl: "https://example.org/feed" }, maxBytes: 10000, maxItems: 25, timeoutMs: 10000 }, executorId: "executor:feed", windowSeconds: 300 };
  const service = new WebNewsCollectionPlanning(f.client, template, key, () => current);
  const store = new AbsFeedPlanStore(f.client, scope, key);
  return { ...f, scope, template, service, store, clock: () => current, expire: () => { current = now + 600_000; },
    input: { sourceDigest: service.sourceDigest, idempotencyKey: "news-plan-request-001" } };
}
test("owner proposal atomically retains its full plan and replays without new job or dispatch", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const [first, second] = await Promise.all([f.service.propose(f.identity, f.input), f.service.propose(f.identity, f.input)]);
  assert.equal(first.jobId, second.jobId); assert.equal(first.inputDigest, second.inputDigest);
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]); assert.equal(first.startsWork, false);
  const saved = await f.store.get(first.jobId); assert.ok(saved); assert.deepEqual(saved.plan.configuration, f.template.configuration);
  assert.equal(saved.job.state, "proposed");
  for (const table of ["control_jobs", "control_workflows", "control_requests", "control_abs_feed_plans"])
    assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 1);
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='tasks.propose'")).rows.length, 1);
  for (const table of ["control_attempts", "control_leases", "control_effect_intents", "control_approvals", "control_outbox"])
    assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 0);
});
test("source drift, injected URLs, wrong scope and revoked owners cannot replace or create plans", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const saved = await f.service.propose(f.identity, f.input);
  await assert.rejects(f.service.propose(f.identity, { ...f.input, endpointUrl: "https://other.example.org/feed" }));
  await assert.rejects(f.service.propose(f.identity, { ...f.input, sourceDigest: sha256Digest("changed") }));
  const changed = new WebNewsCollectionPlanning(f.client, { ...f.template, configuration: { ...f.template.configuration, maxItems: 26 } }, key, f.clock);
  await assert.rejects(changed.propose(f.identity, { ...f.input, sourceDigest: changed.sourceDigest }), /conflict/);
  await assert.rejects(new AbsFeedPlanStore(f.client, { ...f.scope, workspaceId: "workspace:other" }, key).get(saved.jobId));
  await f.client.query("UPDATE control_role_grants SET revoked_at=$1 WHERE id='grant:web'", [new Date(now).toISOString()]);
  await assert.rejects(f.service.propose(f.identity, { ...f.input, idempotencyKey: "news-plan-request-002" }));
  assert.equal((await f.client.query("SELECT * FROM control_abs_feed_plans")).rows.length, 1);
});
test("audit failure or expired precommit rolls back the complete proposed work", async t => {
  for (const mode of ["audit_failure", "expired"] as const) await t.test(mode, async () => {
    const f = await fixture();
    try {
      const session = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (sql.includes("INSERT INTO audit_events")) { if (mode === "audit_failure") throw new Error("synthetic audit failure"); f.expire(); }
        return result;
      } });
      const db: DatabaseClient = { query: f.client.query.bind(f.client), transaction: work => f.client.transaction(tx => work(session(tx))),
        transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
      const service = new WebNewsCollectionPlanning(db, f.template, key, f.clock);
      await assert.rejects(service.propose(f.identity, f.input));
      for (const table of ["control_jobs", "control_requests", "control_workflows", "control_abs_feed_plans"])
        assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 0);
    } finally { await f.db.close(); }
  });
});
test("retained plan is immutable, key checked and cannot adopt a changed configuration", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const receipt = await f.service.propose(f.identity, f.input), work = await f.store.get(receipt.jobId); assert.ok(work);
  assert.equal((await f.store.saveProposed(work)).replayed, true);
  await assert.rejects(new AbsFeedPlanStore(f.client, f.scope, new Uint8Array(32).fill(62)).get(receipt.jobId));
  await assert.rejects(f.store.saveProposed({ ...work, startsWork: true }));
  for (const sql of ["UPDATE control_abs_feed_plans SET input_digest=input_digest", "DELETE FROM control_abs_feed_plans", "TRUNCATE control_abs_feed_plans"])
    await assert.rejects(f.client.query(sql));
});

test("non-owner grants and paused projects cannot propose a collection", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.client.query("UPDATE control_role_grants SET role_key='operator' WHERE id='grant:web'");
  await assert.rejects(f.service.propose(f.identity, f.input));
  await f.client.query("UPDATE control_role_grants SET role_key='owner' WHERE id='grant:web'");
  await new WebProjectService(f.client, f.scope, f.clock).transition(f.identity, f.scope.projectId,
    { lifecycle: "paused", expectedVersion: f.project.version }, "pause-news-project-001");
  await assert.rejects(f.service.propose(f.identity, f.input), /conflict/);
  assert.equal((await f.client.query("SELECT * FROM control_abs_feed_plans")).rows.length, 0);
});
