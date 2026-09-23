import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { publishDurableResultV1, type DurableResultBindingV1 } from "../src/artifacts/v1/durable-result-publication";
import { createInMemoryNeutralReservationPort } from "../src/artifacts/v1/neutral-reservation-port";
import { PlanSelectedTaskResultReaderV1 } from "../src/web/v1/task-result-reader";
import { CompletionGateStoreV1, type CompletionAcceptanceProfileV1 } from "../src/completion-gate/v1";
import { sha256Digest } from "../src/security";
import { at } from "./native-task-fixture";
import { binding } from "./hermes-native-fixture";
import { webNativeResultFixture } from "./helpers/web-native-result";

const connectorDigest = `sha256:${createHash("sha256").update("durable-test:c").digest("hex")}`;

async function durableFixture() {
  const f = await webNativeResultFixture();
  const runId = "run:plan-selected-durable", jobId = "job:plan-selected-durable", attemptId = "attempt:plan-selected-durable";
  await f.provisionRun(runId, jobId, attemptId);
  const profile: CompletionAcceptanceProfileV1 = { schemaVersion: "control-room-completion-gate/v1",
    id: "profile:plan-selected-durable", tenantId: binding.tenantId, projectId: binding.projectId,
    name: "Plan-selected durable result", targetKind: "document", requiredVerificationScenarioIds: ["scenario:durable"],
    minimumIndependentReviews: 1, reviewerSeparation: { actor: true, worker: false, agentProfile: false,
      harness: false, modelFamily: false }, verificationRequiresProducerSeparation: true, minimumRisk: "low",
    maximumRevisionRounds: 0, automaticLowRiskDisposition: false,
    createdBy: { actorId: "identity:test", actorType: "human" }, createdAt: at() };
  await new CompletionGateStoreV1(f.db, f.reviewKey, f.checkpoints).registerProfile(profile);
  const publication: DurableResultBindingV1 = { tenantId: binding.tenantId, projectId: binding.projectId, jobId, attemptId, runId,
    nodeId: binding.nodeId, workflowId: "workflow:test", harness: "third-party", connectorProfileDigest: connectorDigest,
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile) };
  const published = await publishDurableResultV1({ db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey,
    storage: f.storage, storageClass: "local", reservations: createInMemoryNeutralReservationPort() }, {
    binding: publication, bytes: new TextEncoder().encode("A plan-selected durable result."),
    receivedAt: at(2_000), assertAuthority: () => {} });
  const reader = new PlanSelectedTaskResultReaderV1(f.db, { harnessIntegrityKey: f.harnessKey, results: f.config,
    reviewIntegrityKey: f.reviewKey });
  return { f, reader, jobId, published };
}

test("plan-selected reader preserves native reads when no durable review plan exists", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const input = f.complete("A legacy native result.");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2_000)));
  const reader = new PlanSelectedTaskResultReaderV1(f.db, { harnessIntegrityKey: f.harnessKey, results: f.config,
    reviewIntegrityKey: f.reviewKey });
  const listed = await f.db.transaction(tx => reader.list(tx, binding.tenantId, binding.projectId, binding.jobId));
  assert.deepEqual(listed.receipts.map(value => value.artifactId), [receipt.artifactId]);
  const result = await f.db.transaction(tx => reader.read(tx, binding.tenantId, binding.projectId, binding.jobId, receipt.artifactId));
  assert.equal(result?.receipt.schema, "control-room.native-result-receipt/v1");
  assert.equal(result?.text, "A legacy native result.");
});

test("plan-selected reader uses authenticated durable metadata and bytes for a durable plan", async t => {
  const { f, reader, jobId, published } = await durableFixture(); t.after(f.close);
  const listed = await f.db.transaction(tx => reader.list(tx, binding.tenantId, binding.projectId, jobId));
  assert.deepEqual(listed.receipts.map(value => value.artifactId), [published.receipt.artifactId]);
  assert.equal(listed.receipts[0]?.schema, "control-room.durable-result-receipt/v1");
  const metadata = await f.db.transaction(tx => reader.readReceipt(tx, binding.tenantId, binding.projectId, jobId, published.receipt.artifactId));
  assert.equal(metadata?.contentHash, published.receipt.contentHash);
  const result = await f.db.transaction(tx => reader.read(tx, binding.tenantId, binding.projectId, jobId, published.receipt.artifactId));
  assert.equal(result?.text, "A plan-selected durable result.");
});

test("a durable plan cannot fall back to the legacy reader when durable bytes are unavailable", async t => {
  const { f, jobId, published } = await durableFixture(); t.after(f.close);
  const reader = new PlanSelectedTaskResultReaderV1(f.db, { harnessIntegrityKey: f.harnessKey,
    results: { ...f.config, storage: { read: async () => undefined } }, reviewIntegrityKey: f.reviewKey });
  await assert.rejects(() => f.db.transaction(tx => reader.read(tx, binding.tenantId, binding.projectId, jobId,
    published.receipt.artifactId)), /durable_result_content_unavailable/);
});
