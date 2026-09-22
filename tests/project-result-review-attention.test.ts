import assert from "node:assert/strict";
import test from "node:test";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { WebTaskService } from "../src/web/v1/task-service";
import { sha256Digest } from "../src/security";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { instant } from "./hermes-native-fixture";
import { request, token, trust } from "./helpers/web-foundation";

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
