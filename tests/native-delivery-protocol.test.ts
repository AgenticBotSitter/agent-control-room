import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalApprovalStorageFixture as fixture } from "./helpers/canonical-approval-storage";
import { sha256Digest, canonicalJson } from "../src/security";
import { NodeProtocolAuthenticator, signNodeFrame, NODE_PROTOCOL_V1, signedNodeFrameSchema,
  type SignedNodeFrame } from "../src/node-protocol/v1";
import { nativeTaskDispatchBodySchema, nativeTaskDispatchReceiptBodySchema, matchNativeTaskDispatchReceipt, prepareNativeTaskDispatchIntake } from "../src/harness/v1/native-delivery";
import { createNativeApprovalIntake } from "../src/harness/v1/native-approval-intake";

async function setup() {
  const f = await fixture(); await f.save();
  const queued = await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  const p = await f.coordinator.prepareStoredNativeDispatch(...f.args, queued.packetDigest, f.abort.signal);
  const body = nativeTaskDispatchBodySchema.parse({ schema: "control-room.native-task-dispatch/v1", queueId: queued.queueId,
    inputDigest: p.inputDigest, enrollmentDigest: sha256Digest(p.enrollment), bindingDigest: sha256Digest(p.binding),
    packetDigest: p.packetDigest, request: f.prepared.request, start: p.start, packet: f.packet });
  const server = generateKeyPairSync("ed25519"), node = generateKeyPairSync("ed25519");
  const base = { protocol: NODE_PROTOCOL_V1, messageId: "message:dispatch:1", correlationId: queued.queueId,
    tenantId: p.request.tenantId, actorId: "server:dispatch", senderKind: "control_room" as const,
    keyId: "server-key:dispatch", connectionId: "connection:node-channel", sequence: 1,
    sentAt: new Date(f.clock()).toISOString(), expiresAt: new Date(p.start.deadline).toISOString(),
    nonce: "native_dispatch_nonce_1234567890123456" };
  const frame = signNodeFrame({ ...base, direction: "server_to_node", type: "harness.native.dispatch", body }, server.privateKey);
  const seen = new Set<string>(); let revoked = false;
  const auth = new NodeProtocolAuthenticator({ resolve: async q => {
    const isServer = q.senderKind === "control_room";
    if (q.tenantId !== base.tenantId || q.actorId !== (isServer ? base.actorId : p.request.nodeId)
      || q.keyId !== (isServer ? base.keyId : "node-key:dispatch")) return undefined;
    return { ...q, algorithm: "ed25519", publicKeySpki: (isServer ? server : node).publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      state: revoked ? "revoked" : "active", principalState: "active", validFrom: base.sentAt };
  } }, { consume: async frame => { if (seen.has(frame.messageId)) return "duplicate"; seen.add(frame.messageId); return "accepted"; } }, { consume: async () => {} });
  const verify = (value: SignedNodeFrame = frame, receivedAt = base.sentAt) => auth.verify(JSON.stringify(value), {
    expectedDirection: value.direction, receivedAt, expectedConnectionId: base.connectionId, transportIdentity: "synthetic-node-channel" });
  const receiptBody = nativeTaskDispatchReceiptBodySchema.parse({ schema: "control-room.native-task-dispatch-receipt/v1",
    queueId: body.queueId, dispatchMessageId: frame.messageId, dispatchBodyDigest: frame.bodyDigest,
    tenantId: base.tenantId, nodeId: p.request.nodeId, projectId: p.request.projectId, jobId: p.request.jobId, attemptId: p.request.attemptId,
    packetDigest: body.packetDigest, bindingDigest: body.bindingDigest, recordedAt: base.sentAt,
    disposition: "recorded", safeReason: "none", startsWork: false, grantsExecutionAuthority: false });
  const receipt = signNodeFrame({ ...base, messageId: "message:receipt:1", causationId: frame.messageId,
    actorId: p.request.nodeId, keyId: "node-key:dispatch", senderKind: "node", direction: "node_to_server",
    type: "harness.native.dispatch.receipt", body: receiptBody }, node.privateKey);
  return { ...f, body, frame, receipt, verify, server, revoke: () => { revoked = true; } };
}

test("native delivery and exact receipt authenticate through existing protocol with separate signers", async t => {
  const f = await setup(); t.after(f.close);
  assert.equal((await f.verify()).delivery, "accepted"); assert.equal((await f.verify()).delivery, "duplicate");
  const verified = await f.verify(f.receipt); assert.equal(verified.delivery, "accepted");
  assert.deepEqual(matchNativeTaskDispatchReceipt(verified.frame.body, f.frame), f.receipt.body);
  assert.equal(f.receipt.body.startsWork, false); assert.equal(f.receipt.body.grantsExecutionAuthority, false);
});

test("frame direction, tenant, receipt signer identity and dispatch deadline must match", async t => {
  const f = await setup(); t.after(f.close);
  for (const value of [{ ...f.frame, direction: "node_to_server", senderKind: "node" },
    { ...f.frame, tenantId: "tenant:other" },
    { ...f.frame, expiresAt: new Date(f.body.start.deadline + 1).toISOString() },
    { ...f.receipt, actorId: "node:other" }, { ...f.receipt, causationId: "message:other" },
    { ...f.receipt, body: { ...f.receipt.body, recordedAt: new Date(f.clock() + 1).toISOString() } }])
    assert.equal(signedNodeFrameSchema.safeParse(value).success, false);
});

test("dispatch schema rejects substituted owner packet, task, queue and contradictory receipt fields", async t => {
  const f = await setup(); t.after(f.close);
  for (const value of [{ ...f.body, queueId: "native-queue:other" },
    { ...f.body, packetDigest: sha256Digest("other") },
    { ...f.body, start: { ...f.body.start, jobId: "job:other" } },
    { ...f.body, request: { ...f.body.request, approval: f.packet.approval } },
    { ...f.body, bindingDigest: sha256Digest("other") }]) assert.equal(nativeTaskDispatchBodySchema.safeParse(value).success, false);
  assert.equal(nativeTaskDispatchReceiptBodySchema.safeParse({ ...f.receipt.body, disposition: "rejected" }).success, false);
  assert.equal(nativeTaskDispatchReceiptBodySchema.safeParse({ ...f.receipt.body, startsWork: true }).success, false);
});

test("cryptographic tampering, retired signer and expired envelope fail protocol authentication", async t => {
  const f = await setup(); t.after(f.close);
  await assert.rejects(f.verify({ ...f.frame, signature: "A".repeat(86) }));
  await assert.rejects(f.verify(f.frame, new Date(f.body.start.deadline + 1).toISOString()));
  f.revoke(); await assert.rejects(f.verify());
});

test("a valid node signature cannot acknowledge a different task or dispatch", async t => {
  const f = await setup(); t.after(f.close); await f.verify(f.receipt);
  for (const patch of [{ dispatchMessageId: "message:other" }, { dispatchBodyDigest: sha256Digest("other") },
    { packetDigest: sha256Digest("other") }, { bindingDigest: sha256Digest("other") },
    { nodeId: "node:other" }, { attemptId: "attempt:other" }, { queueId: "queue:other" }])
    assert.throws(() => matchNativeTaskDispatchReceipt({ ...f.receipt.body, ...patch }, f.frame));
});

test("oversized native payload and untrusted extra fields are refused", async t => {
  const f = await setup(); t.after(f.close);
  assert.equal(nativeTaskDispatchBodySchema.safeParse({ ...f.body, extra: "x" }).success, false);
  assert.equal(nativeTaskDispatchBodySchema.safeParse({ ...f.body, start: { ...f.body.start, prompt: "x".repeat(70_000) } }).success, false);
  const wrongBody = { ...f.body, inputDigest: sha256Digest("tampered") };
  // Replacing body under the old signature fails; only a trusted sender can issue changed material.
  await assert.rejects(f.verify({ ...f.frame, body: wrongBody }));
});

test("authenticated dispatch reaches existing paired signature intake only with trusted local enrollment", async t => {
  const f = await setup(); t.after(f.close); const authenticated = await f.verify();
  const prepared = prepareNativeTaskDispatchIntake(authenticated.frame.body, f.prepared.enrollment);
  const value = await createNativeApprovalIntake(prepared, { approvals: f.approvals, security: f.native.trust, clock: f.clock })(prepared.packet, f.abort.signal);
  assert.equal(value.packetDigest, f.body.packetDigest); assert.equal(value.grantsExecutionAuthority, false);
  assert.throws(() => prepareNativeTaskDispatchIntake(f.body, { ...f.prepared.enrollment, model: "different-model" }));
  assert.throws(() => prepareNativeTaskDispatchIntake({ ...f.body, start: { ...f.body.start, prompt: "different prompt" } }, f.prepared.enrollment));
});

test("even server-signed delivery cannot substitute invalid owner signatures", async t => {
  const f = await setup(); t.after(f.close);
  const packet = structuredClone(f.packet); packet.approval.signature = "A".repeat(86);
  const body = nativeTaskDispatchBodySchema.parse({ ...f.body, packet, packetDigest: sha256Digest(packet) });
  const frame = signNodeFrame({ ...f.frame, body }, f.server.privateKey);
  const authenticated = await f.verify(frame);
  const prepared = prepareNativeTaskDispatchIntake(authenticated.frame.body, f.prepared.enrollment);
  await assert.rejects(createNativeApprovalIntake(prepared, { approvals: f.approvals, security: f.native.trust, clock: f.clock })(prepared.packet, f.abort.signal));
});

test("new server signature cannot legitimize a contradictory canonical input digest", async t => {
  const f = await setup(); t.after(f.close);
  const body = { ...f.body, inputDigest: sha256Digest("different canonical input") };
  assert.throws(() => prepareNativeTaskDispatchIntake(body, f.prepared.enrollment));
  const { signature: _signature, ...original } = f.frame; void _signature;
  const material = { ...original, body, bodyDigest: sha256Digest(body) };
  // Sign deliberately malformed fixture material without the producer's schema helper.
  const frame = { ...material, signature: sign(null, Buffer.from(canonicalJson(material)), f.server.privateKey).toString("base64url") };
  await assert.rejects(f.verify(frame));
});
