import assert from "node:assert/strict";
import test from "node:test";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { WebTaskService } from "../src/web/v1/task-service";
import { sha256Digest } from "../src/security";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { request, token, trust } from "./helpers/web-foundation";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const traceTransactions = (db: DatabaseClient, statements: string[]): DatabaseClient => {
  const traced = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    statements.push(sql.replace(/\s+/gu, " ").trim()); return tx.query<T>(sql, params);
  } });
  return { query: db.query.bind(db), transaction: work => db.transaction(tx => work(traced(tx))),
    transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work(traced(tx)), check) };
};

test("project result-review discovery finds a pending returned result without confusing it with execution approval", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const page = await f.tasks.projectAttention(f.identity, "project:test", "reviews");
  assert.equal(page.mode, "reviews"); assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.task.state, "leased", "the result is discoverable even though execution is not waiting_approval");
  assert.deepEqual(page.items[0]?.reasons, ["review"]);
  assert.deepEqual(page.items[0]?.resultArtifactIds, [f.artifact.artifactId]);
  assert.equal(page.startsWork, false);

  const changed = await f.reviews.record(f.identity, "project:test", "job:test", {
    ...f.draft, decision: "changes_requested", feedback: "Add the missing acceptance detail.",
  }, "project-review-attention-changes");
  assert.equal(changed.replayed, false);
  const afterChange = await f.tasks.projectAttention(f.identity, "project:test", "reviews");
  assert.deepEqual(afterChange.items[0]?.reasons, ["changes_requested"]);

  await assert.rejects(f.tasks.projectAttention(f.identity, "project:other", "reviews"), /not_found|access_denied/);
});

test("owner review locks the tenant and reviewed job before completion-gate or child rows", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const statements: string[] = [];
  const reviews = f.createReviews(traceTransactions(f.db, statements));
  await reviews.record(f.identity, "project:test", "job:test", f.draft, "owner-review-lock-order");
  const tenant = statements.findIndex(sql => sql === "SELECT id FROM tenants WHERE id=$1 FOR KEY SHARE");
  const job = statements.findIndex(sql => /^SELECT id FROM control_jobs .* FOR KEY SHARE$/u.test(sql));
  const gate = statements.findIndex(sql => /control_completion_gate_integrity.*FOR UPDATE/u.test(sql));
  const child = statements.findIndex(sql => sql.startsWith("INSERT INTO control_web_task_review_commands"));
  // The child INSERT key-shares the job through its foreign key; the parent must be
  // held before the gate (see tests/completion-gate-lock-order-postgres.test.ts).
  assert.ok(tenant >= 0 && job > tenant && gate > job && child > gate, JSON.stringify({ tenant, job, gate, child, statements }));
});

test("project result-review discovery reports unavailable evidence rather than treating it as no review work", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const unconfigured = new WebTaskService(f.db, f.scope, () => instant + 6000);
  const page = await unconfigured.projectAttention(f.identity, "project:test", "reviews");
  assert.equal(page.resultSource, "not_configured"); assert.equal(page.reviewSource, "not_configured");
  assert.deepEqual(page.items[0]?.reasons, ["result_checks_unavailable"]);
  assert.deepEqual(page.items[0]?.resultArtifactIds, []);
});

test("a project reader sees review metadata but receives no unusable result-content link", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const now = new Date(instant).toISOString();
  await f.db.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:review-reader','tenant:test','human','Review reader',$1,$2,'active',$3,$3)`,
  [trust.issuer, sha256Digest({ provider: trust.issuer, subject: "project-review-reader" }), now]);
  await f.db.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:review-reader','tenant:test','identity:review-reader','operator',$1::jsonb,$2::jsonb,'low',false,false,$3,$3)`,
  [JSON.stringify(["projects.read", "tasks.read"]), JSON.stringify(["project:test"]), now]);
  const jwt = token({ sub: "project-review-reader", iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const identity = createAccessVerifier(f.accessTrust)(request(undefined, undefined, undefined, undefined, jwt), instant + 6000);
  const page = await new WebTaskService(f.db, f.scope, () => instant + 6000, f.ownerKeys)
    .projectAttention(identity, "project:test", "reviews");
  assert.equal(page.resultContent, "not_authorized");
  assert.deepEqual(page.items[0]?.reasons, ["review"]);
  assert.deepEqual(page.items[0]?.resultArtifactIds, []);
});

test("the project projection keeps each actionable result status and excludes ready or superseded evidence", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const internal = f.tasks as unknown as {
    resultPage: () => Promise<unknown>;
    resultAttention: (tx: unknown, actor: unknown, row: { project_id: string; id: string; has_artifacts: boolean })
      => Promise<{ reasons: string[]; resultArtifactIds: string[] }>;
  };
  const page = (status: "pending" | "changes_requested" | "verification_blocked" | "revision_limit_reached" | "ready" | "superseded") => ({
    resultSource: "configured", reviewSource: "configured", additionalResultsOmitted: false, additionalTargetsOmitted: false,
    canReadContent: true,
    items: [{ artifactId: "artifact:result" }], reviews: [{ status, matchingArtifactIds: ["artifact:result"], additionalEvidenceOmitted: false }],
  });
  for (const [status, expected] of [
    ["pending", ["review"]], ["changes_requested", ["changes_requested"]], ["verification_blocked", ["verification_blocked"]],
    ["revision_limit_reached", ["revision_limit_reached"]], ["ready", []], ["superseded", []],
  ] as const) {
    internal.resultPage = async () => page(status);
    const value = await internal.resultAttention(undefined, undefined, { project_id: "project:test", id: "job:test", has_artifacts: true });
    assert.deepEqual(value.reasons, expected, status);
    assert.deepEqual(value.resultArtifactIds, expected.length ? ["artifact:result"] : [], status);
  }
  internal.resultPage = async () => ({ ...page("pending"), additionalTargetsOmitted: true });
  assert.deepEqual((await internal.resultAttention(undefined, undefined,
    { project_id: "project:test", id: "job:test", has_artifacts: true })).reasons, ["review", "result_checks_unavailable"]);
});


// projectAttention INBOX mode, which is the half of this reader that shares the
// workspace candidate predicate (R7I-01). The other tests here exercise only
// `reviews` mode, which deliberately keeps EVERY artifact-bearing job and lets
// the reason filter decide -- so nothing else would notice if the inbox arm
// drifted from the workspace reader's own predicate.
//
// Run against the production default path: the real WebTaskService over the
// fixture database, no injected port, tool, runner or fake for this read.
test("project inbox attention applies the same settled exclusion as the workspace reader", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  // The fixture job is `leased` and carries a pending result: the inbox reader
  // must offer it, because an accepted-but-unverified result is live work.
  const live = await f.tasks.projectAttention(f.identity, "project:test", "inbox");
  assert.ok(live.items.some(item => item.task.jobId === "job:test"),
    `a leased job with a pending result must appear in the project inbox, saw ${JSON.stringify(live.items.map(i => i.task.jobId))}`);

  // Accept and fully verify it, which is what `settledResultAttention` calls
  // settled. The project inbox must then DROP it -- the exclusion the two
  // readers now share.
  await f.reviews.record(f.identity, "project:test", "job:test", f.draft, "project-inbox-settled");
  // Every scenario the profile demands, recorded through the gate store exactly
  // as the reader will read them. The fixture profile may demand one or two, so
  // this enumerates it rather than assuming.
  for (const [index, scenarioId] of f.profile.requiredVerificationScenarioIds.entries())
    await f.reviewStore.recordVerification({ schemaVersion: "control-room-completion-gate/v1",
      id: `verification:project-inbox:${index}`, tenantId: binding.tenantId, projectId: binding.projectId,
      targetId: f.target.id, targetDigest: sha256Digest(f.target), acceptanceProfileId: f.profile.id,
      acceptanceProfileDigest: sha256Digest(f.profile), scenarioId, outcome: "passed",
      verifier: { actorId: "service:project-inbox", actorType: "service" },
      evidenceDigests: [f.artifact.contentHash], verifiedAt: at(4000 + index), grantsApproval: false,
      grantsExecutionAuthority: false });
  const settled = await f.tasks.projectAttention(f.identity, "project:test", "inbox");
  assert.equal(settled.items.some(item => item.task.jobId === "job:test"), false,
    `an accepted and fully verified result is settled and must leave the project inbox, saw ${JSON.stringify(settled.items.map(i => i.task.jobId))}`);

  // The `reviews` MODE contrast, asserted at the level where the two modes
  // actually differ: the SQL candidate set. `reviews` mode must NOT carry the
  // settled exclusion, because it exists to list RETURNED results and lets the
  // reason filter decide. (Both modes end up with an empty page here, because
  // the reason logic drops a ready target too -- so asserting on `items` would
  // prove nothing and would have passed even if the modes were identical.)
  const traced: string[] = [];
  const tracedTasks = new WebTaskService(traceTransactions(f.db, traced), f.scope, () => instant + 6000,
    f.ownerKeys);
  await tracedTasks.projectAttention(f.identity, "project:test", "reviews");
  const reviewsSql = traced.filter(sql => sql.includes("control_native_artifact_receipts")).join(" ");
  assert.equal(reviewsSql.includes("minimumIndependentReviews"), false,
    "reviews mode must not carry the settled exclusion: it is a different question");
  traced.length = 0;
  await tracedTasks.projectAttention(f.identity, "project:test", "inbox");
  const inboxSql = traced.filter(sql => sql.includes("control_native_artifact_receipts")).join(" ");
  assert.ok(inboxSql.includes("minimumIndependentReviews"),
    "inbox mode must carry the shared settled predicate");
  t.diagnostic(JSON.stringify({ inboxAfterSettling: settled.items.map(i => i.task.jobId),
    reviewsCarriesSettledPredicate: reviewsSql.includes("minimumIndependentReviews"),
    inboxCarriesSettledPredicate: inboxSql.includes("minimumIndependentReviews") }));
});
