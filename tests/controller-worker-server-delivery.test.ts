import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, controllerWorkerNodeDispatchBodySchemaV1 } from "../src/harness/v1/controller-worker-node-delivery";
import { createAuthenticatedRemoteNodeSessionDeliveryBridgeV1 } from "../src/harness/v1/remote-session-delivery-bridge";
import { ControllerWorkerDeliveryIntakeHandlerV1 } from "../src/node-bridge/controller-worker-delivery-handler";
import { PortableNodeBridge } from "../src/node-bridge/bridge";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { ServerNodeSession } from "../src/node-control/server-node-session";
import { FixedWindowProtocolRateLimiter, NODE_PROTOCOL_V1, NodeProtocolAuthenticator, signNodeFrame, type SignedNodeFrame } from "../src/node-protocol/v1";
import { sha256Digest } from "../src/security/canonical-digest";

const initial = Date.parse("2026-09-23T18:00:00.000Z");

function body(now: number) {
  const delivery = createControllerWorkerDeliveryV1({
    identity: { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test", runId: "run:test", nodeId: "node:test" },
    worker: { workerId: "worker:hermes", adapterId: "hermes/0.21", adapterRevision: "revision:7654321" },
    input: { prompt: "Inspect one exact task", instructions: "Return bounded evidence only." },
    authorityDigest: sha256Digest("authority"), connectorProfileDigest: sha256Digest("connector"),
    acceptanceProfileId: "acceptance:test", acceptanceProfileDigest: sha256Digest("acceptance"),
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
  });
  return controllerWorkerNodeDispatchBodySchemaV1.parse({ schema: "control-room.controller-worker-node-dispatch/v1",
    queueId: `native-queue:${sha256Digest({ tenantId: delivery.identity.tenantId, jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId }).slice(7)}`,
    enrollmentDigest: sha256Digest("enrollment"), delivery });
}

async function connected() {
  let now = initial;
  const server = generateKeyPairSync("ed25519"), node = generateKeyPairSync("ed25519");
  const serverSpki = server.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const nodeSpki = node.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const dispatch = body(now), journal = new SqliteBridgeJournal(":memory:"), toNode: string[] = [], toServer: string[] = [];
  const handler = new ControllerWorkerDeliveryIntakeHandlerV1({ workerId: dispatch.delivery.worker.workerId,
    adapterId: dispatch.delivery.worker.adapterId, adapterRevision: dispatch.delivery.worker.adapterRevision,
    enrollmentDigest: dispatch.enrollmentDigest }, journal, () => now);
  const bridge = new PortableNodeBridge({ tenantId: "tenant:test", nodeId: "node:test", keyId: "node-key:test",
    features: [CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1] }, journal,
  { async sign(frame) { return signNodeFrame(frame, node.privateKey); } },
  new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", publicKeySpki: serverSpki,
    state: "active", principalState: "active", validFrom: new Date(now - 1_000).toISOString() }; } }, journal,
  new FixedWindowProtocolRateLimiter(100, 60)), undefined, undefined, undefined, undefined, undefined, handler);
  const session = new ServerNodeSession({ tenantId: "tenant:test", nodeId: "node:test", nodeKeyId: "node-key:test",
    serverId: "server:test", serverKeyId: "server-key:test", serverPublicKeySpki: serverSpki, transportIdentity: "transport:test",
    features: [CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1], maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30 }, {
    clock: () => now,
    authentication: new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", publicKeySpki: nodeSpki,
      state: "active", principalState: "active", validFrom: new Date(now - 1_000).toISOString() }; } },
    { async consume() { return "accepted" as const; } }, new FixedWindowProtocolRateLimiter(100, 60)),
    async sign(frame) { return signNodeFrame(frame, server.privateKey); }, async send(raw) { toNode.push(raw); },
  });
  const stamp = () => new Date(now).toISOString();
  await bridge.open({ async send(raw) { toServer.push(raw); }, async close() {} }, { now: stamp(), transportIdentity: "transport:test" });
  const hello = toServer.shift()!;
  await session.acceptHello(hello);
  while (toNode.length || toServer.length) {
    while (toNode.length) await bridge.receive(toNode.shift()!, stamp());
    while (toServer.length) await session.receive(toServer.shift()!);
  }
  return { dispatch, journal, handler, bridge, session, toNode, toServer,
    advance() { now += 1; }, stamp, async close() { session.disconnect(); await bridge.close(); handler.close(); journal.close(); } };
}

test("server sends exactly one generic controller packet and accepts only its authenticated matching receipt", async () => {
  const f = await connected();
  const remote = createAuthenticatedRemoteNodeSessionDeliveryBridgeV1({ session: {
    workerId: f.dispatch.delivery.worker.workerId, enrollmentDigest: f.dispatch.enrollmentDigest, session: f.session,
  } });
  const transmitted = await remote.transmit(f.dispatch.delivery, { kind: "remote", workerId: f.dispatch.delivery.worker.workerId });
  assert.equal(transmitted.deliveryDigest, f.dispatch.delivery.deliveryDigest);
  assert.equal(f.toNode.length, 1); f.advance(); await f.bridge.receive(f.toNode.shift()!, f.stamp());
  assert.equal(f.toServer.length, 1);
  let committed = 0;
  const saved = await remote.acceptReceipt(f.toServer.shift()!, async value => {
    committed++; value.assertCurrent(); assert.equal(value.receipt.startsWork, false);
    assert.equal(value.delivery.deliveryDigest, f.dispatch.delivery.deliveryDigest); return value.receipt;
  });
  assert.equal(saved.disposition, "accepted");
  assert.equal(committed, 1);
  assert.equal(f.journal.acceptedControllerWorkerDelivery(f.dispatch.queueId)?.receipt.deliveryId, f.dispatch.delivery.deliveryId);
  await assert.rejects(remote.acceptReceipt("{}", async () => undefined));
  await f.close();
});

test("generic controller delivery is unavailable without negotiated support", async () => {
  const f = await connected();
  f.session.disconnect();
  assert.equal(f.session.controllerWorkerDeliveryChannel(), undefined);
  await assert.rejects(f.session.stageControllerWorkerDelivery(async () => undefined));
  await f.close();
});
