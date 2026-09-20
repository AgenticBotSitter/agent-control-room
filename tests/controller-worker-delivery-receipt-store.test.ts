import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { persistControllerWorkerDeliveryReceiptV1, readControllerWorkerDeliveryReceiptV1 } from "../src/harness/v1/controller-worker-delivery-receipt-store";
import { admitRemoteWorkerDeliveryV1, createRemoteWorkerEnrollmentV1,
  deliverAndRecordAdmittedRemoteWorkerPacketV1, observeRemoteWorkerDeliveryV1,
  reconcileAndRecordRemoteWorkerDeliveryAfterReconnectV1 } from "../src/harness/v1/remote-worker-delivery";
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

test("the admitted remote route records its acknowledgement through the same receipt composition", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const { schema: _schema, inputDigest: _inputDigest, deliveryId: _deliveryId, deliveryDigest: _deliveryDigest, ...base } = delivery();
  const packet = createControllerWorkerDeliveryV1({ ...base, worker: {
    workerId: "worker:remote", adapterId: "connector:remote-fixture", adapterRevision: "00570550" },
  });
  const admission = admitRemoteWorkerDeliveryV1({ delivery: packet, route: { kind: "remote", workerId: "worker:remote" },
    enrollment: createRemoteWorkerEnrollmentV1({ workerId: "worker:remote", adapterId: "connector:remote-fixture",
      adapterRevision: "00570550", enrollmentId: "enrollment:remote-fixture", state: "enrolled", enrolledAt: at(0), revokedAt: null }),
    supportedAdapterRevisions: ["00570550"] });
  const recorded = await deliverAndRecordAdmittedRemoteWorkerPacketV1({ db: f.db, integrityKey: key,
    port: { async receive(value, route) { return receipt(value, route.kind); } } }, admission, at(3000));
  assert.equal(recorded.replayed, false);
  assert.equal(recorded.receipt.route.kind, "remote");
  const saved = await f.db.transaction(tx => readControllerWorkerDeliveryReceiptV1(tx, key, {
    tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId, attemptId: binding.attemptId }));
  assert.equal(saved?.delivery.deliveryDigest, packet.deliveryDigest);
  assert.equal(saved?.receipt.route.kind, "remote");
});

test("a remote receipt recovered after a lost reply is recorded without resending the task", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const { schema: _schema, inputDigest: _inputDigest, deliveryId: _deliveryId, deliveryDigest: _deliveryDigest, ...base } = delivery();
  const packet = createControllerWorkerDeliveryV1({ ...base, worker: {
    workerId: "worker:remote", adapterId: "connector:remote-fixture", adapterRevision: "00570550" },
  });
  const enrollment = createRemoteWorkerEnrollmentV1({ workerId: "worker:remote", adapterId: "connector:remote-fixture",
    adapterRevision: "00570550", enrollmentId: "enrollment:remote-fixture", state: "enrolled", enrolledAt: at(0), revokedAt: null });
  const recovered = await reconcileAndRecordRemoteWorkerDeliveryAfterReconnectV1({ db: f.db, integrityKey: key }, {
    prior: observeRemoteWorkerDeliveryV1({ result: undefined, failure: "disconnect" }), delivery: packet,
    route: { kind: "remote", workerId: "worker:remote" }, enrollment, supportedAdapterRevisions: ["00570550"],
    receipt: receipt(packet, "remote"),
  }, at(3000));
  assert.equal(recovered.kind, "receipt");
  if (recovered.kind !== "receipt") throw new Error("expected recovered receipt");
  assert.equal(recovered.replayed, false);
  const saved = await f.db.transaction(tx => readControllerWorkerDeliveryReceiptV1(tx, key, {
    tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId, attemptId: binding.attemptId }));
  assert.equal(saved?.delivery.deliveryDigest, packet.deliveryDigest);
  assert.equal(saved?.receipt.route.kind, "remote");
});

test("a second route or changed receipt cannot turn one task attempt into duplicate work", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery();
  await f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, packet, receipt(packet), at(3000)));
  await assert.rejects(f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, packet,
    receipt(packet, "remote"), at(3000))), /controller_worker_delivery_receipt_unavailable/);
});
