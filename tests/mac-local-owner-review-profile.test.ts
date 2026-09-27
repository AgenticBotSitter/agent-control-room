import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CompletionGateErrorV1, type CompletionReviewV1 } from "../src/completion-gate/v1";
import { sha256Digest } from "../src/security";
import { createMacLocalHumanVerificationRegistryV1, createMacLocalHumanVerificationScenarioV1,
  createMacLocalOwnerReviewProfileV1, createMacLocalTextScenarioV1, MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1,
  MAC_LOCAL_OWNER_REVIEW_PROFILE_DIGEST_HEX_LENGTH_V1, MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1,
  MAC_LOCAL_TEXT_SCENARIO_V1, macLocalOwnerReviewProfileIdV1 } from "../src/web/v1/mac-local-owner-review-profile";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";

const input = { tenantId: "tenant:mac", projectId: "project:a", ownerIdentityId: "identity:tenant:mac:owner",
  projectCreatedAt: "2026-09-25T12:00:00.000Z" };

test("one stable owner-review profile per project, with a non-authorizing text check", () => {
  const a = createMacLocalOwnerReviewProfileV1(input);
  const b = createMacLocalOwnerReviewProfileV1({ ...input, projectId: "project:b" });
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, macLocalOwnerReviewProfileIdV1(input.projectId));
  assert.deepEqual(a, createMacLocalOwnerReviewProfileV1(input));
  assert.equal(a.automaticLowRiskDisposition, false);
  assert.equal(a.reviewerSeparation.actor, true);
  assert.equal(a.reviewerSeparation.worker, true);
  assert.equal(a.reviewerSeparation.modelFamily, true);
  assert.equal(createMacLocalOwnerReviewProfileV1({ ...input, reviewerIndependence: "different_worker" })
    .reviewerSeparation.modelFamily, false);
  assert.equal(createMacLocalTextScenarioV1(a).acceptanceProfileDigest, sha256Digest(a));
  assert.deepEqual(a.requiredVerificationScenarioIds, [MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, MAC_LOCAL_TEXT_SCENARIO_V1]);
  const human = createMacLocalHumanVerificationScenarioV1(a);
  assert.equal(human.acceptanceProfileDigest, sha256Digest(a));
  assert.notEqual(human.scenarioId, createMacLocalTextScenarioV1(a).scenarioId,
    "an automated structure pass can never stand in for owner observation");
  const registry = createMacLocalHumanVerificationRegistryV1([a]);
  registry.register(b); registry.register(b);
  assert.deepEqual(registry.list().map(value => value.acceptanceProfileId), [a.id, b.id]);
  const long = "project:" + "x".repeat(172);
  assert.match(macLocalOwnerReviewProfileIdV1(long), /^profile:mac-local-owner-review:v2:[a-f0-9]{32}$/);
});

test("migration 0092 derives the same short and long profile ids as TypeScript", async () => {
  const sql = await readFile(new URL("../db/migrations/0092_phase2b_mac_local_quality_profile.sql", import.meta.url), "utf8");
  assert.ok(sql.includes(`WHEN length('${MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1}' || NEW.project_id) <= 180`));
  assert.ok(sql.includes(`THEN '${MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1}' || NEW.project_id`));
  assert.ok(sql.includes(`ELSE '${MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1}'`));
  assert.ok(sql.includes("sha256(convert_to(to_json(NEW.project_id)::text,'UTF8'))"),
    "SQL must hash the JSON text form used by sha256Digest on a bare string");
  assert.ok(sql.includes(`),'hex'),1,${MAC_LOCAL_OWNER_REVIEW_PROFILE_DIGEST_HEX_LENGTH_V1})`));

  const long = "project:" + "x".repeat(172);
  const sqlEquivalent = MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1
    + createHash("sha256").update(JSON.stringify(long)).digest("hex").slice(0, MAC_LOCAL_OWNER_REVIEW_PROFILE_DIGEST_HEX_LENGTH_V1);
  assert.equal(macLocalOwnerReviewProfileIdV1(long), sqlEquivalent);
});

test("profile v2 lets the owner review an agent result and refuses a same-family agent reviewer", async t => {
  const profile = createMacLocalOwnerReviewProfileV1({ tenantId: binding.tenantId, projectId: binding.projectId,
    ownerIdentityId: "identity:test", projectCreatedAt: at() });
  const producer = { actorId: binding.nodeId, actorType: "agent" as const, workerId: "worker:producer",
    agentProfileId: "profile:producer", harness: "hermes", adapterId: "adapter:producer", modelFamily: "family:shared" };
  const f = await ownerReviewFixture({ profile, producer }); t.after(f.close);

  const agentReview: CompletionReviewV1 = { schemaVersion: "control-room-completion-gate/v1", id: "review:same-family",
    tenantId: binding.tenantId, projectId: binding.projectId, targetId: f.target.id, targetDigest: sha256Digest(f.target),
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile),
    reviewer: { actorId: "agent:reviewer", actorType: "agent", workerId: "worker:reviewer",
      agentProfileId: "profile:reviewer", harness: "claude-code", adapterId: "adapter:reviewer", modelFamily: "family:shared" },
    authority: "completion_gate", decision: "accepted", assessedRisk: "low", effectiveRisk: "low",
    evidenceDigests: [f.artifact.contentHash], findingIds: [], reviewedAt: at(6000),
    grantsApproval: false, grantsExecutionAuthority: false };
  await assert.rejects(() => f.reviewStore.recordReview(agentReview),
    (error: unknown) => error instanceof CompletionGateErrorV1 && error.safeCode === "reviewer_not_independent");

  const options = await f.reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
  assert.equal(options.availability, "available");
  assert.equal(options.canReview, true);
  const recorded = await f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, "profile-v2-owner-review-001");
  assert.equal(recorded.receipt.decision, "accepted");
});
