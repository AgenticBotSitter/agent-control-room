import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { publishDurableResultV1, type DurableResultBindingV1 } from "../src/artifacts/v1/durable-result-publication";
import { DurableResultReviewSubmissionServiceV1 } from "../src/completion-gate/v1/durable-result-review-submission";
import { CompletionGateStoreV1, type CompletionAcceptanceProfileV1 } from "../src/completion-gate/v1";
import { createInMemoryNeutralReservationPort } from "../src/artifacts/v1/neutral-reservation-port";
import { sha256Digest } from "../src/security";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { webNativeResultFixture } from "./helpers/web-native-result";

const connectorDigest = `sha256:${createHash("sha256").update("durable-test:c").digest("hex")}`;

async function prepared(runId: string, acceptanceProfileDigest?: string) {
  const f = await webNativeResultFixture();
  await f.provisionRun(runId, `job:${runId}`, `attempt:${runId}`);
  const profile: CompletionAcceptanceProfileV1 = { schemaVersion: "control-room-completion-gate/v1",
    id: `profile:${runId}`, tenantId: binding.tenantId, projectId: binding.projectId,
    name: "Durable result quality", targetKind: "document", requiredVerificationScenarioIds: ["scenario:durable"],
    minimumIndependentReviews: 1, reviewerSeparation: { actor: true, worker: false, agentProfile: false,
      harness: false, modelFamily: false }, verificationRequiresProducerSeparation: true, minimumRisk: "low",
    maximumRevisionRounds: 0, automaticLowRiskDisposition: false,
    createdBy: { actorId: "identity:test", actorType: "human" }, createdAt: at() };
  await new CompletionGateStoreV1(f.db, f.reviewKey, f.checkpoints).registerProfile(profile);
  const durableBinding: DurableResultBindingV1 = { tenantId: binding.tenantId, projectId: binding.projectId,
    jobId: `job:${runId}`, attemptId: `attempt:${runId}`, runId, nodeId: binding.nodeId,
    workflowId: "workflow:test", harness: "third-party", connectorProfileDigest: connectorDigest,
    acceptanceProfileId: profile.id, acceptanceProfileDigest: acceptanceProfileDigest ?? sha256Digest(profile) };
  const published = await publishDurableResultV1({ db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey,
    storage: f.storage, storageClass: "local", reservations: createInMemoryNeutralReservationPort() },
  { binding: durableBinding, bytes: new TextEncoder().encode("A durable review submission result."),
    receivedAt: at(2_000), assertAuthority: () => {} });
  const service = new DurableResultReviewSubmissionServiceV1(f.db, { integrityKey: f.resultKey,
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints, storageClass: "local", storage: f.storage });
  return { f, profile, published, service };
}

test("durable result review submission re-verifies the publication and audits only its first registration", async t => {
  const { f, published, service } = await prepared("run:durable-review-submit"); t.after(f.close);
  const first = await service.submit(binding.tenantId, "run:durable-review-submit");
  assert.equal(first.replayed, false);
  assert.equal(first.qualityAccepted, false);
  assert.equal(first.completionVerified, false);
  assert.deepEqual(first.target, published.target);

  const replay = await service.submit(binding.tenantId, "run:durable-review-submit");
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.target, first.target);
  assert.deepEqual((await f.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM audit_events
    WHERE tenant_id=$1 AND action='task.result.submitted_for_review'`, [binding.tenantId])).rows[0], { count: 1 });
  assert.deepEqual((await f.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM control_completion_gate_records
    WHERE tenant_id=$1 AND kind='target'`, [binding.tenantId])).rows[0], { count: 1 });
});

test("durable result review submission fails closed when the immutable plan cannot be authenticated", async t => {
  const { f } = await prepared("run:durable-review-plan"); t.after(f.close);
  const service = new DurableResultReviewSubmissionServiceV1(f.db, { integrityKey: f.resultKey,
    reviewIntegrityKey: new Uint8Array(32).fill(45), checkpoints: f.checkpoints, storageClass: "local", storage: f.storage });
  await assert.rejects(() => service.submit(binding.tenantId, "run:durable-review-plan"),
    /durable_result_review_submission_unavailable/);
  assert.deepEqual((await f.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM control_completion_gate_records
    WHERE tenant_id=$1 AND kind='target'`, [binding.tenantId])).rows[0], { count: 0 });
});

test("durable result review submission refuses a receipt and plan that name a stale acceptance profile digest", async t => {
  const { f, service } = await prepared("run:durable-review-profile", sha256Digest("stale-profile")); t.after(f.close);
  await assert.rejects(() => service.submit(binding.tenantId, "run:durable-review-profile"),
    /durable_result_review_submission_unavailable/);
  assert.deepEqual((await f.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM control_completion_gate_records
    WHERE tenant_id=$1 AND kind='target'`, [binding.tenantId])).rows[0], { count: 0 });
});
