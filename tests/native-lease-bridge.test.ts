import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { PortableNodeBridge, SqliteBridgeJournal } from "../src/node-bridge";
import { FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator, signNodeFrame } from "../src/node-protocol/v1";
import { NATIVE_DELIVERY_FEATURE } from "../src/harness/v1/native-delivery";
import { createNativeLeaseCommandHandler } from "../src/harness/hermes-native-v1/lease-intake";
import { createNativeLeaseEvidence } from "../src/harness/hermes-native-v1/lease-evidence";
import { nativeLeaseEvidenceFixture } from "./helpers/native-lease-evidence";

async function fixture(t: TestContext) {
  const f = await nativeLeaseEvidenceFixture();
  const cleanup: (() => void | Promise<void>)[] = [f.close];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const journal = new SqliteBridgeJournal(":memory:"), nodeKey = generateKeyPairSync("ed25519");
  cleanup.push(() => journal.close());
  const key = await f.trust.resolveServerKey(f.grant.keyId); assert.ok(key);
  const spki = Buffer.from(key).toString("base64url"), sent: string[] = [];
  let taskCurrent = true, loseDuringTrust = false;
  const handler = createNativeLeaseCommandHandler({ request: f.config.request, serverActorId: f.config.serverActorId,
    serverKeyId: f.grant.keyId, serverPublicKeySpki: spki }, {
    journal, clock: f.dependencies.clock!, channel: () => bridge.nativeDeliveryChannel(),
    assertTaskCurrent: () => { if (!taskCurrent) throw new Error("synthetic dispatch invalidated"); return true; },
    trust: { currentServerTrustRevision: f.trust.currentServerTrustRevision.bind(f.trust),
      async resolveServerKey(id) { const result = await f.trust.resolveServerKey(id); if (loseDuringTrust) taskCurrent = false; return result; } },
  });
  cleanup.push(handler.close);
  let nodeId = 0;
  const bridge = new PortableNodeBridge({ tenantId: f.config.request.tenantId, nodeId: f.config.request.nodeId,
    keyId: "key:synthetic-node", features: [NATIVE_DELIVERY_FEATURE] }, journal,
  { async sign(frame) { return signNodeFrame(frame, nodeKey.privateKey); } },
  new NodeProtocolAuthenticator({ async resolve(input) {
    if (input.actorId !== f.config.serverActorId || input.keyId !== f.grant.keyId) return undefined;
    return { ...input, algorithm: "ed25519", publicKeySpki: spki, state: "active", principalState: "active", validFrom: f.at };
  } }, journal, new FixedWindowProtocolRateLimiter(100, 60)), () => ++nodeId === 1 ? "lease" : `synthetic-node-${nodeId}`, handler);
  cleanup.push(() => bridge.close());
  await bridge.open({ async send(raw) { sent.push(raw); }, async close() {} }, { now: f.at, transportIdentity: "transport:synthetic" });
  if (f.hello.type !== "connection.accepted" || f.grant.type !== "job.lease.grant") throw new Error("synthetic frame mismatch");
  await bridge.receive(JSON.stringify(f.serverFrame(1, "connection.accepted", { ...f.hello.body, enabledFeatures: [NATIVE_DELIVERY_FEATURE] })), f.at);
  await bridge.receive(JSON.stringify(f.serverFrame(2, "node.reconciliation.request", { lastAcknowledgedNodeSequence: 0, requestedAttemptIds: [] })), f.at);
  const grant = f.serverFrame(3, "job.lease.grant", f.grant.body);
  return { ...f, journal, bridge, grant, handler, sent,
    loseDuringTrust: () => { loseDuringTrust = true; },
    read: createNativeLeaseEvidence({ ...f.config, messageId: grant.messageId }, { journal, trust: f.trust, clock: f.dependencies.clock }),
  };
}

test("authenticated bridge command intake produces the retained lease consumed by the existing reader", async t => {
  const f = await fixture(t);
  assert.equal(f.journal.queuedCommandCount(), 0);
  await f.bridge.receive(JSON.stringify(f.grant), f.at);
  assert.equal(f.journal.inboundStatus(f.grant.messageId), "processed");
  assert.deepEqual(await f.read(new AbortController().signal), f.policy.lease);
  assert.equal(f.journal.queuedCommandCount(), 1);
  await f.bridge.receive(JSON.stringify(f.grant), f.at);
  assert.equal(f.journal.queuedCommandCount(), 1);
  assert.deepEqual(f.calls, []);
});

test("dispatch invalidation during bridge intake leaves authenticated inbox without usable lease state", async t => {
  const f = await fixture(t); f.loseDuringTrust();
  await assert.rejects(f.bridge.receive(JSON.stringify(f.grant), f.at));
  assert.equal(f.journal.inboundStatus(f.grant.messageId), "received");
  assert.equal(f.journal.queuedCommandCount(), 0);
  assert.equal(f.journal.attemptSummary(f.summary.attemptId), undefined);
  await assert.rejects(f.read(new AbortController().signal));
  assert.deepEqual(f.calls, []);
});
