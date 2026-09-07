import assert from "node:assert/strict";
import test from "node:test";
import { buildAbsFeedProposedWork, verifyAbsFeedJobPlan } from "../src/project-adapters/abs-news/v1/feed-job-plan";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { taskFixture } from "./helpers/web-task";

function input(projectId = "project:feed") {
  return { plan: { schema: "control-room.abs-feed-plan/v1", jobId: "job:feed", plannedAt: "2026-09-07T10:00:00.000Z",
    configuration: { tenantId: "tenant:web", workspaceId: "workspace:web", projectId,
      source: { sourceId: "source:feed", sourceLabel: "Example news", sourceKind: "rss", endpointUrl: "https://example.org/feed" },
      maxBytes: 10000, maxItems: 25, timeoutMs: 10000 } },
    requestId: "request:feed", workflowId: "workflow:feed", ownerId: "owner:feed", executorId: "executor:feed",
    expiresAt: "2026-09-07T10:05:00.000Z" };
}
test("feed plan creates ordinary proposed canonical records without lease, approval or dispatch", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const work = buildAbsFeedProposedWork(input(f.project.projectId));
  assert.equal(work.startsWork, false); assert.equal(work.job.state, "proposed");
  assert.deepEqual(work.job.authority.allowedNetworkDestinations, ["https://example.org:443"]);
  assert.deepEqual(verifyAbsFeedJobPlan(work.job, work.plan), work.plan.configuration);
  // Trusted storage composition only; this test does not simulate owner admission.
  await f.client.transaction(async tx => {
    const joined = { query: tx.query.bind(tx), transaction: async <T>(fn: (value: typeof tx) => Promise<T>) => fn(tx),
      transactionWithPreCommitCheck: async <T>(fn: (value: typeof tx) => Promise<T>, check: () => void | Promise<void>) => { const result = await fn(tx); await check(); return result; } };
    const store = new CanonicalStore(joined);
    await store.create(work.request); await store.create(work.workflow); await store.create(work.job);
  });
  const job = await new CanonicalStore(f.client).get("tenant:web", "job", work.job.id);
  assert.deepEqual(verifyAbsFeedJobPlan(job, work.plan), work.plan.configuration);
  for (const table of ["control_attempts", "control_leases", "control_approvals", "control_effect_intents", "control_outbox"])
    assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 0);
});
test("every source/configuration field and planned identity is bound by the job input digest", () => {
  const work = buildAbsFeedProposedWork(input());
  const changed = [
    (p: typeof work.plan) => { p.configuration.source.endpointUrl = "https://other.example.org/feed"; },
    (p: typeof work.plan) => { p.configuration.source.sourceId = "source:other"; },
    (p: typeof work.plan) => { p.configuration.source.sourceLabel = "Another attribution"; },
    (p: typeof work.plan) => { p.configuration.source.sourceKind = "atom"; },
    (p: typeof work.plan) => { p.configuration.maxBytes++; },
    (p: typeof work.plan) => { p.configuration.maxItems++; },
    (p: typeof work.plan) => { p.configuration.timeoutMs++; },
    (p: typeof work.plan) => { p.configuration.workspaceId = "workspace:other"; },
    (p: typeof work.plan) => { p.configuration.projectId = "project:other"; },
    (p: typeof work.plan) => { p.configuration.tenantId = "tenant:other"; },
    (p: typeof work.plan) => { p.jobId = "job:other"; },
    (p: typeof work.plan) => { p.plannedAt = "2026-09-07T10:00:01.000Z"; },
  ];
  for (const change of changed) { const plan = structuredClone(work.plan); change(plan); assert.throws(() => verifyAbsFeedJobPlan(work.job, plan)); }
  assert.throws(() => verifyAbsFeedJobPlan(work.job, { ...work.plan, networkAuthorized: true }));
});
test("freshly hashed but widened job authority and retry settings remain unsupported", () => {
  const work = buildAbsFeedProposedWork(input());
  for (const patch of [{ allowedOperations: ["abs.feed.collect", "other:operation"] }, { credentialRefs: ["key:other"] },
    { filesystemRoots: ["/tmp"] }, { allowedNetworkDestinations: ["https://other.example.org/feed"] },
    { effectPolicy: "preauthorized" as const }, { maxConcurrentEffects: 2 }, { maxCostUsd: 1 },
    { maxDurationSeconds: 61 }, { parentDigest: sha256Digest("parent") }]) {
    const job = structuredClone(work.job); Object.assign(job.authority, patch); job.authority.digest = computeAuthorityDigest(job.authority);
    assert.throws(() => verifyAbsFeedJobPlan(job, work.plan));
  }
  for (const patch of [{ maxAttempts: 2 }, { retryAfterOrphan: true }, { retryableFailureCodes: ["temporary"] }]) {
    const job = structuredClone(work.job); Object.assign(job.retryPolicy, patch); assert.throws(() => verifyAbsFeedJobPlan(job, work.plan));
  }
});
test("invalid source, insufficient window and unassigned executor cannot create proposals", () => {
  assert.throws(() => buildAbsFeedProposedWork({ ...input(), executorId: "executor:unassigned" }));
  assert.throws(() => buildAbsFeedProposedWork({ ...input(), expiresAt: "2026-09-07T10:00:59.000Z" }));
  const source = input(); source.plan.configuration.source.endpointUrl = "http://127.0.0.1/feed";
  assert.throws(() => buildAbsFeedProposedWork(source));
});
