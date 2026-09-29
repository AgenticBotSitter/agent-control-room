import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1, controllerWorkerNodeDispatchBodySchemaV1 } from "../src/harness/v1/controller-worker-node-delivery";
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
    features: [CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1] }, journal,
  { async sign(frame) { return signNodeFrame(frame, node.privateKey); } },
  new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", publicKeySpki: serverSpki,
    state: "active", principalState: "active", validFrom: new Date(now - 1_000).toISOString() }; } }, journal,
  new FixedWindowProtocolRateLimiter(100, 60)), undefined, undefined, undefined, undefined, undefined, handler);
  const createSession = () => new ServerNodeSession({ tenantId: "tenant:test", nodeId: "node:test", nodeKeyId: "node-key:test",
    serverId: "server:test", serverKeyId: "server-key:test", serverPublicKeySpki: serverSpki, transportIdentity: "transport:test",
    features: [CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1], maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30 }, {
    clock: () => now,
    authentication: new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", publicKeySpki: nodeSpki,
      state: "active", principalState: "active", validFrom: new Date(now - 1_000).toISOString() }; } },
    { async consume() { return "accepted" as const; } }, new FixedWindowProtocolRateLimiter(100, 60)),
    async sign(frame) { return signNodeFrame(frame, server.privateKey); }, async send(raw) { toNode.push(raw); },
  });
  let session = createSession();
  const stamp = () => new Date(now).toISOString();
  const connect = async () => {
  await bridge.open({ async send(raw) { toServer.push(raw); }, async close() {} }, { now: stamp(), transportIdentity: "transport:test" });
  const hello = toServer.shift()!;
  await session.acceptHello(hello);
  while (toNode.length || toServer.length) {
    while (toNode.length) await bridge.receive(toNode.shift()!, stamp());
    while (toServer.length) await session.receive(toServer.shift()!);
  }
  };
  await connect();
  return { dispatch, journal, handler, bridge, get session() { return session; }, toNode, toServer,
    signNode(frame: Parameters<typeof signNodeFrame>[0]) { return signNodeFrame(frame, node.privateKey); },
    async reconnect() { session.disconnect(); await bridge.disconnected(); toNode.length = 0; toServer.length = 0;
      now += 1; session = createSession(); await connect(); },
    advance(ms = 1) { now += ms; }, stamp, async close() { session.disconnect(); await bridge.close(); handler.close(); journal.close(); } };
}

test("replacement session recovers only the exact journaled receipt without dispatching again", async t => {
  const f = await connected(); t.after(f.close);
  const remote = createAuthenticatedRemoteNodeSessionDeliveryBridgeV1({ session: {
    workerId: f.dispatch.delivery.worker.workerId, enrollmentDigest: f.dispatch.enrollmentDigest, session: f.session } });
  let intent!: SignedNodeFrame<'controller.worker.delivery'>;
  await remote.transmit(f.dispatch.delivery, { kind: 'remote', workerId: f.dispatch.delivery.worker.workerId },
    undefined, async frame => { intent = structuredClone(frame); });
  await f.bridge.receive(f.toNode.shift()!, f.stamp());
  assert.ok(f.toServer.shift(), 'original receipt is lost before controller receipt intake');
  await f.reconnect();
  let stored: string | undefined;
  for (let round = 0; round < 2; round++) {
    await f.bridge.recoverControllerWorkerReceipt(f.dispatch.queueId, f.stamp());
    const result = await f.session.recoverControllerWorkerDeliveryReceipt(f.toServer.shift()!, async scope => {
      assert.equal(scope.attemptId, intent.body.delivery.identity.attemptId); return intent;
    }, async (frame, dispatch, current) => {
      current(); assert.equal(sha256Digest(dispatch), sha256Digest(intent));
      const digest = frame.body.receipt.receipt.receiptDigest;
      const replayed = stored !== undefined;
      if (stored) assert.equal(stored, digest); stored = digest;
      return { replayed };
    });
    assert.equal(result.replayed, round > 0);
    assert.equal(f.toNode.length, 0, 'recovery creates no controller dispatch');
  }
});

test("recovery refuses missing intent, modified receipt and expired original dispatch", async t => {
  for (const mode of ['missing', 'frame', 'worker', 'enrollment', 'node', 'expired'] as const) await t.test(mode, async t => {
    const f = await connected(); t.after(f.close);
    let intent!: SignedNodeFrame<'controller.worker.delivery'>;
    const remote = createAuthenticatedRemoteNodeSessionDeliveryBridgeV1({ session: {
      workerId: f.dispatch.delivery.worker.workerId, enrollmentDigest: f.dispatch.enrollmentDigest, session: f.session } });
    await remote.transmit(f.dispatch.delivery, { kind: 'remote', workerId: f.dispatch.delivery.worker.workerId },
      undefined, async frame => { intent = frame; });
    await f.bridge.receive(f.toNode.shift()!, f.stamp());
    await f.reconnect();
    await f.bridge.recoverControllerWorkerReceipt(f.dispatch.queueId, f.stamp());
    let raw = f.toServer.shift()!;
    if (mode !== 'missing' && mode !== 'expired') {
      const parsed = JSON.parse(raw);
      if (mode === 'frame') parsed.body.dispatchFrameDigest = sha256Digest('wrong-frame');
      if (mode === 'enrollment') parsed.body.receipt.enrollmentDigest = sha256Digest('other-enrollment');
      if (mode === 'node') parsed.actorId = 'node:other';
      if (mode === 'worker') {
        parsed.body.receipt.receipt.workerId = 'worker:other';
        parsed.body.receipt.receipt.route.workerId = 'worker:other';
        const { receiptDigest: _digest, ...material } = parsed.body.receipt.receipt;
        parsed.body.receipt.receipt.receiptDigest = sha256Digest(material);
      }
      const { signature: _signature, bodyDigest: _bodyDigest, ...unsigned } = parsed;
      raw = JSON.stringify(f.signNode(unsigned));
    }
    if (mode === 'expired') f.advance(60_001);
    let writes = 0;
    await assert.rejects(f.session.recoverControllerWorkerDeliveryReceipt(raw,
      async () => { if (mode === 'missing') throw new Error('missing intent'); return intent; },
      async () => { writes++; }));
    assert.equal(writes, 0); assert.equal(f.toNode.length, 0);
  });
});

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
