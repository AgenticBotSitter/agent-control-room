import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1,
  controllerWorkerNodeDispatchBodySchemaV1,
  controllerWorkerNodeDispatchReceiptBodySchemaV1,
  matchControllerWorkerNodeDispatchReceiptV1,
} from "../src/harness/v1/controller-worker-node-delivery";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { NODE_PROTOCOL_V1, nodeToServerTypes, serverToNodeTypes, signNodeFrame, signedNodeFrameSchema } from "../src/node-protocol/v1";
import { sha256Digest } from "../src/security/canonical-digest";

const now = Date.parse("2026-09-23T16:00:00.000Z");
const at = (offset: number) => new Date(now + offset).toISOString();
const keys = generateKeyPairSync("ed25519");

function fixture() {
  const delivery = createControllerWorkerDeliveryV1({
    identity: { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test", runId: "run:test", nodeId: "node:mac" },
    worker: { workerId: "worker:hermes", adapterId: "hermes/0.21", adapterRevision: "revision:1234567" },
    input: { prompt: "Inspect one saved task", instructions: "Return evidence only." },
    authorityDigest: sha256Digest("authority"), connectorProfileDigest: sha256Digest("connector"),
    acceptanceProfileId: "acceptance:test", acceptanceProfileDigest: sha256Digest("acceptance"),
    issuedAt: at(0), expiresAt: at(60_000),
  });
  const body = controllerWorkerNodeDispatchBodySchemaV1.parse({
    schema: "control-room.controller-worker-node-dispatch/v1",
    queueId: `native-queue:${sha256Digest({ tenantId: delivery.identity.tenantId, jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId }).slice(7)}`,
    enrollmentDigest: sha256Digest("enrollment"), delivery,
  });
  const dispatch = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room",
    messageId: "message:controller-delivery", correlationId: "correlation:controller-delivery", tenantId: delivery.identity.tenantId,
    actorId: "control-room:test", keyId: "server-key:test", connectionId: "connection:test", sequence: 1,
    sentAt: at(1), expiresAt: at(59_000), nonce: "c3ludGhldGljLWNvbnRyb2xsZXI", type: "controller.worker.delivery", body }, keys.privateKey);
  const receiptMaterial = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: delivery.deliveryId, deliveryDigest: delivery.deliveryDigest, workerId: delivery.worker.workerId,
    route: { kind: "remote" as const, workerId: delivery.worker.workerId }, receivedAt: at(2), disposition: "accepted" as const,
    startsWork: false as const, grantsExecutionAuthority: false as const };
  const receipt = { ...receiptMaterial, receiptDigest: sha256Digest(receiptMaterial) };
  const receiptBody = controllerWorkerNodeDispatchReceiptBodySchemaV1.parse({
    schema: "control-room.controller-worker-node-dispatch-receipt/v1", queueId: body.queueId,
    dispatchMessageId: dispatch.messageId, dispatchBodyDigest: sha256Digest(body), enrollmentDigest: body.enrollmentDigest, receipt,
  });
  const receiptFrame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
    messageId: "message:controller-delivery-receipt", correlationId: dispatch.correlationId, causationId: dispatch.messageId,
    tenantId: delivery.identity.tenantId, actorId: delivery.identity.nodeId, keyId: "node-key:test", connectionId: dispatch.connectionId,
    sequence: 2, sentAt: at(3), expiresAt: at(59_000), nonce: "c3ludGhldGljLXJlY2VpcHQ", type: "controller.worker.delivery.receipt", body: receiptBody }, keys.privateKey);
  return { delivery, body, dispatch, receipt, receiptBody, receiptFrame };
}

test("the generic controller packet is carried in an additive signed-node message pair", () => {
  const f = fixture();
  assert.equal(CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, "controller.worker.delivery.v1");
  assert.equal(serverToNodeTypes.has("controller.worker.delivery"), true);
  assert.equal(nodeToServerTypes.has("controller.worker.delivery.receipt"), true);
  assert.equal(signedNodeFrameSchema.parse(f.dispatch).type, "controller.worker.delivery");
  assert.equal(signedNodeFrameSchema.parse(f.receiptFrame).type, "controller.worker.delivery.receipt");
  const matched = matchControllerWorkerNodeDispatchReceiptV1(f.receiptBody, { messageId: f.dispatch.messageId, body: f.body });
  assert.equal(matched.deliveryId, f.delivery.deliveryId);
  assert.equal(matched.startsWork, false);
  assert.equal(matched.grantsExecutionAuthority, false);
});

test("queue, delivery, enrollment, and outer timing substitutions refuse", () => {
  const f = fixture();
  assert.equal(controllerWorkerNodeDispatchBodySchemaV1.safeParse({ ...f.body, queueId: "native-queue:wrong" }).success, false);
  assert.throws(() => matchControllerWorkerNodeDispatchReceiptV1({ ...f.receiptBody, enrollmentDigest: sha256Digest("other") },
    { messageId: f.dispatch.messageId, body: f.body }), /controller_worker_node_delivery_receipt_mismatch/);
  assert.throws(() => matchControllerWorkerNodeDispatchReceiptV1({ ...f.receiptBody, receipt: { ...f.receipt, workerId: "worker:other" } },
    { messageId: f.dispatch.messageId, body: f.body }));
  assert.equal(signedNodeFrameSchema.safeParse({ ...f.dispatch, expiresAt: at(61_000) }).success, false);
  assert.equal(signedNodeFrameSchema.safeParse({ ...f.receiptFrame, sentAt: at(1) }).success, false);
});
