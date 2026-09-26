import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, controllerWorkerNodeDispatchBodySchemaV1 } from "../src/harness/v1/controller-worker-node-delivery";
import { ControllerWorkerDeliveryIntakeHandlerV1 } from "../src/node-bridge/controller-worker-delivery-handler";
import { PortableNodeBridge } from "../src/node-bridge/bridge";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { NODE_PROTOCOL_V1, signNodeFrame, signedNodeFrameSchema } from "../src/node-protocol/v1";
import { sha256Digest } from "../src/security/canonical-digest";

const now = Date.parse("2026-09-23T17:00:00.000Z");
const at = (offset: number) => new Date(now + offset).toISOString();
const keys = generateKeyPairSync("ed25519");

function fixture() {
  const delivery = createControllerWorkerDeliveryV1({
    identity: { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test", runId: "run:test", nodeId: "node:mac" },
    worker: { workerId: "worker:marvin", adapterId: "hermes/0.21", adapterRevision: "revision:7654321" },
    input: { prompt: "Inspect one exact task", instructions: "Return only bounded evidence." },
    authorityDigest: sha256Digest("authority"), connectorProfileDigest: sha256Digest("connector"),
    acceptanceProfileId: "acceptance:test", acceptanceProfileDigest: sha256Digest("acceptance"), issuedAt: at(0), expiresAt: at(60_000),
  });
  const enrollmentDigest = sha256Digest("enrollment");
  const body = controllerWorkerNodeDispatchBodySchemaV1.parse({
    schema: "control-room.controller-worker-node-dispatch/v1",
    queueId: `native-queue:${sha256Digest({ tenantId: delivery.identity.tenantId, jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId }).slice(7)}`,
    enrollmentDigest, delivery,
  });
  const frame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room",
    messageId: "message:controller-intake", correlationId: "correlation:controller-intake", tenantId: "tenant:test",
    actorId: "control-room:test", keyId: "server-key:test", connectionId: "connection:test", sequence: 1,
    sentAt: at(1), expiresAt: at(59_000), nonce: "c3ludGhldGljLWNvbnRyb2xsZXI", type: "controller.worker.delivery", body }, keys.privateKey);
  const channel = { tenantId: "tenant:test", nodeId: "node:mac", connectionId: "connection:test", maxFrameBytes: 131_072,
    grantsExecutionAuthority: false as const, assertCurrent() {} };
  return { delivery, enrollmentDigest, body, frame, channel };
}

test("worker intake records one authenticated generic packet before returning its non-executing receipt", async () => {
  const f = fixture(), journal = new SqliteBridgeJournal(":memory:"), handler = new ControllerWorkerDeliveryIntakeHandlerV1({
    workerId: f.delivery.worker.workerId, adapterId: f.delivery.worker.adapterId, adapterRevision: f.delivery.worker.adapterRevision,
    enrollmentDigest: f.enrollmentDigest,
  }, journal, () => now + 2);
  const receipt = await handler.accept(f.frame, f.channel);
  assert.equal(receipt.receipt.disposition, "accepted");
  assert.equal(receipt.receipt.startsWork, false);
  assert.equal(receipt.receipt.grantsExecutionAuthority, false);
  const saved = journal.acceptedControllerWorkerDelivery(f.body.queueId);
  assert.equal(saved?.frame.messageId, f.frame.messageId);
  assert.equal(saved?.receipt.deliveryId, f.delivery.deliveryId);
  await assert.rejects(handler.accept(f.frame, f.channel));
  handler.close(); journal.close();
});

test("wrong node, enrollment, worker, or stale channel records nothing", async () => {
  const cases = [
    { channel: { ...fixture().channel, nodeId: "node:other" }, config: {} },
    { channel: fixture().channel, config: { enrollmentDigest: sha256Digest("other") } },
    { channel: fixture().channel, config: { workerId: "worker:other" } },
    { channel: { ...fixture().channel, assertCurrent() { throw new Error("stale"); } }, config: {} },
  ];
  for (const current of cases) {
    const f = fixture(), journal = new SqliteBridgeJournal(":memory:"), handler = new ControllerWorkerDeliveryIntakeHandlerV1({
      workerId: f.delivery.worker.workerId, adapterId: f.delivery.worker.adapterId, adapterRevision: f.delivery.worker.adapterRevision,
      enrollmentDigest: f.enrollmentDigest, ...current.config,
    }, journal, () => now + 2);
    await assert.rejects(handler.accept(f.frame, current.channel));
    assert.equal(journal.acceptedControllerWorkerDelivery(f.body.queueId), undefined);
    handler.close(); journal.close();
  }
  assert.equal(CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, "controller.worker.delivery.v1");
});

test("the portable node bridge negotiates the feature, durably receives one packet, and signs one receipt", async () => {
  const f = fixture(), journal = new SqliteBridgeJournal(":memory:"), handler = new ControllerWorkerDeliveryIntakeHandlerV1({
    workerId: f.delivery.worker.workerId, adapterId: f.delivery.worker.adapterId, adapterRevision: f.delivery.worker.adapterRevision,
    enrollmentDigest: f.enrollmentDigest,
  }, journal, () => now + 4);
  let id = 0;
  const bridge = new PortableNodeBridge({ tenantId: "tenant:test", nodeId: "node:mac", keyId: "node-key:test",
    features: [CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1] }, journal,
  { async sign(unsigned) { return signNodeFrame(unsigned, keys.privateKey); } },
  { async verify(raw) {
    const frame = signedNodeFrameSchema.parse(JSON.parse(String(raw)));
    return { frame, delivery: await journal.consume(frame, at(4)) };
  } },
  () => `id:${++id}`, undefined, undefined, undefined, undefined, handler);
  const sent: string[] = [];
  const transport = { async send(raw: string) { sent.push(raw); }, async close() {} };
  await bridge.open(transport, { now: at(0), transportIdentity: "transport:test" });
  const connectionId = "connection:id:1";
  const accepted = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room",
    messageId: "message:accepted", correlationId: "correlation:accepted", tenantId: "tenant:test", actorId: "control-room:test",
    keyId: "server-key:test", connectionId, sequence: 1, sentAt: at(1), expiresAt: at(59_000), nonce: "c3ludGhldGljLWFjY2VwdGVk",
    type: "connection.accepted", body: { selectedProtocol: NODE_PROTOCOL_V1,
      enabledFeatures: [CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1], maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30, serverTime: at(1) } }, keys.privateKey);
  await bridge.receive(JSON.stringify(accepted), at(1));
  const reconcile = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room",
    messageId: "message:reconcile", correlationId: "correlation:reconcile", tenantId: "tenant:test", actorId: "control-room:test",
    keyId: "server-key:test", connectionId, sequence: 2, sentAt: at(2), expiresAt: at(59_000), nonce: "c3ludGhldGljLXJlY29uY2lsZQ",
    type: "node.reconciliation.request", body: { lastAcknowledgedNodeSequence: 0, requestedAttemptIds: [] } }, keys.privateKey);
  await bridge.receive(JSON.stringify(reconcile), at(2));
  assert.equal(bridge.status().state, "online");
  const dispatch = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room",
    messageId: f.frame.messageId, correlationId: f.frame.correlationId, tenantId: f.frame.tenantId, actorId: f.frame.actorId,
    keyId: f.frame.keyId, connectionId, sequence: 3, sentAt: at(3), expiresAt: at(59_000), nonce: f.frame.nonce,
    type: "controller.worker.delivery", body: f.body }, keys.privateKey);
  await bridge.receive(JSON.stringify(dispatch), at(3));
  const receipt = sent.map(value => JSON.parse(value)).find(value => value.type === "controller.worker.delivery.receipt");
  assert.ok(receipt);
  assert.equal(receipt.body.receipt.deliveryId, f.delivery.deliveryId);
  assert.equal(journal.acceptedControllerWorkerDelivery(f.body.queueId)?.frame.messageId, f.frame.messageId);
  await bridge.close(); handler.close(); journal.close();
});
