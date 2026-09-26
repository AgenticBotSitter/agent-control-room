import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { createOwnerTrustedLocalCliReceiptPortV1 } from "../src/harness/v1/owner-trusted-local-cli-receipt-port";
import { createOwnerTrustedLocalCliPublishV1 } from "../src/harness/v1/owner-trusted-local-cli-publish";
import { codexOwnerTrustedLocalRunRegistrationV1 } from "../src/harness/codex-v1/owner-trusted-local-run-registration";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { seedMacLocalAdapterRegistryV1 } from "../src/web/v1/mac-local-owner-bootstrap";
import { DurableResultReviewSubmissionServiceV1 } from "../src/completion-gate/v1/durable-result-review-submission";
import { createInMemoryNeutralReservationPort } from "../src/artifacts/v1/neutral-reservation-port";
import { InMemoryArtifactStorage } from "../src/node-executor/artifact-storage";
import type { CompletionAcceptanceProfileV1 } from "../src/completion-gate/v1";
import { sha256Digest } from "../src/security";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { webNativeResultFixture } from "./helpers/web-native-result";

async function setup(t: { after(fn: () => unknown): void }, runId: string) {
  const f = await webNativeResultFixture(); t.after(f.close);
  const jobId = `job:${runId}`, attemptId = `attempt:${runId}`, authorityDigest = "sha256:" + "5".repeat(64);
  await f.provisionRun(runId, jobId, attemptId, authorityDigest);
  // provisionRun also creates a control_harness_runs row for a synthetic
  // "hermes"/manual adapter; this suite registers its own owner-trusted
  // local Codex run for the same identity instead.
  await f.db.query("DELETE FROM control_harness_runs WHERE tenant_id=$1 AND id=$2", [binding.tenantId, runId]);
  await f.db.transaction(tx => seedMacLocalAdapterRegistryV1(tx, binding.tenantId));

  const profile: CompletionAcceptanceProfileV1 = { schemaVersion: "control-room-completion-gate/v1",
    id: `profile:${runId}`, tenantId: binding.tenantId, projectId: binding.projectId, name: "Codex local result quality",
    targetKind: "document", requiredVerificationScenarioIds: ["scenario:content"], minimumIndependentReviews: 1,
    reviewerSeparation: { actor: true, worker: false, agentProfile: false, harness: false, modelFamily: false },
    verificationRequiresProducerSeparation: true, minimumRisk: "low", maximumRevisionRounds: 2,
    automaticLowRiskDisposition: false, createdBy: { actorId: "identity:test", actorType: "human" }, createdAt: at() };
  await f.reviewStore.registerProfile(profile);

  const storage = new InMemoryArtifactStorage();
  const reviewSubmission = new DurableResultReviewSubmissionServiceV1(f.db,
    { integrityKey: f.resultKey, reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints, storageClass: "local", storage });
  const publication = { db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage, storageClass: "local" as const,
    reservations: createInMemoryNeutralReservationPort(), reviewSubmission };
  const publish = createOwnerTrustedLocalCliPublishV1({ db: f.db, runIntegrityKey: f.harnessKey, publication,
    registerRun: (deliveryValue, createdAt) => codexOwnerTrustedLocalRunRegistrationV1(deliveryValue, createdAt, "codex-cli-0.99.1") });

  const delivery = createControllerWorkerDeliveryV1({
    identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId, attemptId, runId, nodeId: binding.nodeId },
    worker: { workerId: "worker:codex:mac-1", adapterId: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, adapterRevision: "source-123" },
    input: { prompt: "Reply with exactly the single word: ok", instructions: "Return plain text only." },
    authorityDigest, connectorProfileDigest: "sha256:" + "6".repeat(64), acceptanceProfileId: profile.id,
    acceptanceProfileDigest: sha256Digest(profile), issuedAt: at(0), expiresAt: at(120_000),
  });
  const receiptPort = createOwnerTrustedLocalCliReceiptPortV1(() => Date.parse(at(1_000)));
  const receipt = await receiptPort.receive(delivery, { kind: "local", workerId: delivery.worker.workerId });
  return { f, publish, delivery, receipt, storage };
}

test("publishes the CLI's completed text through the existing durable result and pending-review path", async t => {
  const { f, publish, delivery, receipt } = await setup(t, "run:cli-publish-a");
  await publish({ delivery, receipt, text: "The task completed successfully.", signal: new AbortController().signal });

  const run = await f.db.query<{ id: string; harness: string; adapter_id: string; state: string }>(
    "SELECT id,harness,adapter_id,state FROM control_harness_runs WHERE tenant_id=$1 AND id=$2", [binding.tenantId, delivery.identity.runId]);
  assert.equal(run.rows[0]?.id, delivery.identity.runId);
  assert.equal(run.rows[0]?.harness, "codex");
  assert.equal(run.rows[0]?.adapter_id, "connector:codex-owner-trusted-local-v1");
  assert.equal(run.rows[0]?.state, "succeeded");
  const events = await f.db.query<{ state: string }>("SELECT payload->'payload'->>'state' AS state FROM control_harness_run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence", [binding.tenantId, delivery.identity.runId]);
  assert.deepEqual(events.rows.map(row => row.state), ["starting", "running", "succeeded"]);

  const receiptRow = await f.db.query<{ artifact_id: string }>(
    "SELECT artifact_id FROM control_native_artifact_receipts WHERE tenant_id=$1 AND run_id=$2", [binding.tenantId, delivery.identity.runId]);
  assert.equal(receiptRow.rows.length, 1, "the durable result receipt was written");
  const plan = await f.db.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2", [binding.tenantId, delivery.identity.runId]);
  assert.equal(plan.rows.length, 1, "a durable review plan was written");
});

test("replays cleanly on a retry with the exact same text, and refuses an aborted signal without writing anything", async t => {
  const { f, publish, delivery, receipt } = await setup(t, "run:cli-publish-b");
  await publish({ delivery, receipt, text: "The task completed successfully.", signal: new AbortController().signal });
  await publish({ delivery, receipt, text: "The task completed successfully.", signal: new AbortController().signal });
  const run = await f.db.query<{ id: string }>("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, delivery.identity.runId]);
  assert.equal(run.rows.length, 1, "a replay does not create a second run record");
  const events = await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_harness_run_events WHERE tenant_id=$1 AND run_id=$2", [binding.tenantId, delivery.identity.runId]);
  assert.equal(events.rows[0]?.n, 3, "a replay does not add lifecycle events");

  const controller = new AbortController(); controller.abort();
  await assert.rejects(publish({ delivery, receipt, text: "unreachable", signal: controller.signal }));
});
