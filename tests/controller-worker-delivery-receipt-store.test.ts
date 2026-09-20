import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { persistControllerWorkerDeliveryReceiptV1, readControllerWorkerDeliveryReceiptV1 } from "../src/harness/v1/controller-worker-delivery-receipt-store";
import { sha256Digest } from "../src/security";
import { at, nativeTaskFixture, registration } from "./native-task-fixture";
import { binding, input } from "./hermes-native-fixture";

const key = new Uint8Array(32).fill(72);
const delivery = (): ControllerWorkerDeliveryV1 => createControllerWorkerDeliveryV1({
  identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
    attemptId: binding.attemptId, runId: registration.id, nodeId: binding.nodeId },
  worker: { workerId: "worker:marvin", adapterId: "connector:hermes-021-macos-local-v1", adapterRevision: "00570550" },
  input: { prompt: input.prompt, instructions: input.instructions }, authorityDigest: sha256Digest("marvin-authority"),
  connectorProfileDigest: sha256Digest("marvin-profile"), acceptanceProfileId: "profile:marvin",
  acceptanceProfileDigest: sha256Digest("marvin-acceptance"), issuedAt: at(1000), expiresAt: at(120_000),
});

const receipt = (packet: ControllerWorkerDeliveryV1, kind: "local" | "remote" = "local") => {
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: packet.deliveryId, deliveryDigest: packet.deliveryDigest, workerId: packet.worker.workerId,
    route: { kind, workerId: packet.worker.workerId }, receivedAt: at(2000), disposition: "accepted" as const,
    startsWork: false as const, grantsExecutionAuthority: false as const };
  return { ...material, receiptDigest: sha256Digest(material) };
};

test("the one PostgreSQL authority retains an exact local worker receipt across restart", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(), local = receipt(packet);
  const first = await f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, packet, local, at(3000)));
  assert.equal(first.replayed, false);
  assert.equal(first.startsWork, false);

  const replay = await f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, packet, local, at(3000)));
  assert.equal(replay.replayed, true);
  const saved = await f.db.transaction(tx => readControllerWorkerDeliveryReceiptV1(tx, key, {
    tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId, attemptId: binding.attemptId }));
  assert.equal(saved?.delivery.deliveryDigest, packet.deliveryDigest);
  assert.equal(saved?.receipt.route.kind, "local");
  assert.equal(saved?.startsWork, false);
});

test("the same PostgreSQL receipt store retains a remote acknowledgement without a second authority", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(), remote = receipt(packet, "remote");
  const first = await f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, packet, remote, at(3000)));
  assert.equal(first.replayed, false);
  const saved = await f.db.transaction(tx => readControllerWorkerDeliveryReceiptV1(tx, key, {
    tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId, attemptId: binding.attemptId }));
  assert.equal(saved?.receipt.route.kind, "remote");
  assert.equal(saved?.delivery.deliveryDigest, packet.deliveryDigest);
});

test("a second route or changed receipt cannot turn one task attempt into duplicate work", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery();
  await f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, packet, receipt(packet), at(3000)));
  await assert.rejects(f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, packet,
    receipt(packet, "remote"), at(3000))), /controller_worker_delivery_receipt_unavailable/);
});
