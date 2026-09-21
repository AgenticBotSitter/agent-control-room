import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { persistControllerWorkerDeliveryReceiptV1 } from "../src/harness/v1/controller-worker-delivery-receipt-store";
import { acceptHermes021MacosLocalDeliveryV1, createHermes021MacosTerminalStageV1,
  inspectHermes021MacosDeliveryRecoveryStatusV1 } from "../src/harness/hermes-021-v1";
import { InMemoryArtifactStorage } from "../src/node-executor/artifact-storage";
import { sha256Digest } from "../src/security";
import { nativeTaskFixture } from "./native-task-fixture";
import { binding as nativeBinding, input } from "./hermes-native-fixture";

const key = new Uint8Array(32).fill(71);
const binding = { localServiceId: "service:marvin", workerId: "worker:marvin", expectedVersion: "0.21.3" as const,
  sourceRevision: "00570550" };
const receivedAt = "2026-09-20T00:00:02.000Z";
const terminal = { type: "result" as const, session_id: "session:marvin", exit_code: 0, text: "bounded reviewed text",
  tokens: { input: 4, output: 5, total: 9, cache_read: 0, cache_write: 0 }, duration_ms: 8, timestamp: 9 };

function delivery() {
  return createControllerWorkerDeliveryV1({ identity: { tenantId: nativeBinding.tenantId, projectId: nativeBinding.projectId,
    jobId: nativeBinding.jobId, attemptId: nativeBinding.attemptId, runId: "run:marvin", nodeId: nativeBinding.nodeId }, worker: { workerId: binding.workerId,
    adapterId: "connector:hermes-021-macos-local-v1", adapterRevision: binding.sourceRevision },
  input: { prompt: input.prompt, instructions: input.instructions }, authorityDigest: sha256Digest("authority"),
  connectorProfileDigest: sha256Digest("profile"), acceptanceProfileId: "profile:marvin",
  acceptanceProfileDigest: sha256Digest("acceptance"), issuedAt: "2026-09-20T00:00:01.000Z", expiresAt: "2026-09-20T00:01:00.000Z" });
}

async function saveReceipt(f: Awaited<ReturnType<typeof nativeTaskFixture>>, packet = delivery()) {
  const receipt = acceptHermes021MacosLocalDeliveryV1(packet, { kind: "local", workerId: binding.workerId }, binding,
    { assertAdmitted() {} }, receivedAt);
  await f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, packet, receipt, receivedAt));
  return { packet, receipt };
}

test("recovery inspection reports no receipt, unresolved receipt, then only safe staged-result facts", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const storage = new InMemoryArtifactStorage();
  const scope = { tenantId: nativeBinding.tenantId, projectId: nativeBinding.projectId, jobId: nativeBinding.jobId,
    attemptId: nativeBinding.attemptId };
  const config = { db: f.db, integrityKey: key, storage };
  assert.deepEqual(await inspectHermes021MacosDeliveryRecoveryStatusV1(config, scope), {
    schema: "control-room.hermes-021-macos-delivery-recovery-status/v1", state: "no_authenticated_delivery",
    startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsResume: false,
  });
  const { packet, receipt } = await saveReceipt(f);
  assert.equal((await inspectHermes021MacosDeliveryRecoveryStatusV1(config, scope)).state, "delivery_receipt_unresolved");
  await createHermes021MacosTerminalStageV1({ storage, delivery: packet, receivedAt: receipt.receivedAt }).capture(terminal);
  const staged = await inspectHermes021MacosDeliveryRecoveryStatusV1(config, scope);
  assert.equal(staged.state, "terminal_result_staged");
  assert.deepEqual(staged.terminal, { terminalResultDigest: sha256Digest(terminal), contentDigest: sha256Digest(terminal.text),
    sizeBytes: Buffer.byteLength(terminal.text, "utf8"), inputTokens: 4, outputTokens: 5, totalTokens: 9, durationMs: 8 });
  assert.equal(JSON.stringify(staged).includes(terminal.text), false, "recovery status never exposes terminal text");
  assert.equal(staged.permitsRetry, false);
});

test("recovery inspection refuses a stage from a different authenticated delivery", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const storage = new InMemoryArtifactStorage();
  const { receipt } = await saveReceipt(f);
  const original = delivery();
  const { schema: _schema, inputDigest: _inputDigest, deliveryId: _deliveryId, deliveryDigest: _deliveryDigest, ...otherInput } = original;
  const other = createControllerWorkerDeliveryV1({ ...otherInput, identity: { tenantId: "tenant:test", projectId: "project:test",
    jobId: "job:other", attemptId: "attempt:other", runId: "run:other", nodeId: "node:marvin" }, authorityDigest: sha256Digest("other") });
  await createHermes021MacosTerminalStageV1({ storage, delivery: other, receivedAt: receipt.receivedAt }).capture(terminal);
  const status = await inspectHermes021MacosDeliveryRecoveryStatusV1({ db: f.db, integrityKey: key, storage },
    { tenantId: nativeBinding.tenantId, projectId: nativeBinding.projectId, jobId: nativeBinding.jobId,
      attemptId: nativeBinding.attemptId });
  assert.equal(status.state, "delivery_receipt_unresolved");
});

test("recovery inspection fails closed when receipt authentication cannot be verified", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const storage = new InMemoryArtifactStorage();
  await saveReceipt(f);
  await assert.rejects(inspectHermes021MacosDeliveryRecoveryStatusV1({ db: f.db, integrityKey: new Uint8Array(32).fill(72), storage },
    { tenantId: nativeBinding.tenantId, projectId: nativeBinding.projectId, jobId: nativeBinding.jobId,
      attemptId: nativeBinding.attemptId }), /controller_worker_delivery_receipt_unavailable/);
});
