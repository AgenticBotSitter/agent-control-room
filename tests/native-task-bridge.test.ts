import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PortableNodeBridge, SqliteBridgeJournal } from "../src/node-bridge";
import { FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator, NODE_PROTOCOL_V1, signNodeFrame,
  type NodeMessageBodyMap, type SignedNodeFrame, type UnsignedNodeFrame } from "../src/node-protocol/v1";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { NativeTaskSnapshotService } from "../src/node-control/native-task-snapshot-service";
import { HermesNativeRunAdapter } from "../src/harness/hermes-native-v1/adapter";
import { SqliteNativeRunJournal } from "../src/harness/hermes-native-v1/run-journal";
import { nativeTaskObservation } from "../src/harness/hermes-native-v1/task-observation";
import { binding, capabilityBody, enrollment, input, instant, nativeRunId, response, statusBody } from "./hermes-native-fixture";
import { at, nativeTaskFixture, observation, registration } from "./native-task-fixture";

async function bridgeFixture(enabled = true) {
  const f = await nativeTaskFixture(), journal = new SqliteBridgeJournal(":memory:"), server = generateKeyPairSync("ed25519");
  await f.runs.create(registration);
  const serverAuth = new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", state: "active",
    principalState: "active", validFrom: at(-60_000), publicKeySpki: server.publicKey.export({ format: "der", type: "spki" }).toString("base64url") }; } },
  journal, new FixedWindowProtocolRateLimiter(100, 60));
  let ordinal = 0, failAfterStore = false;
  const sent: SignedNodeFrame[] = [], receipts: Awaited<ReturnType<NativeTaskSnapshotService["ingest"]>>[] = [];
  const bridge = new PortableNodeBridge({ tenantId: binding.tenantId, nodeId: binding.nodeId, keyId: "key:test",
    features: ["harness.native.snapshot.v1"] }, journal, { async sign(frame) { return signNodeFrame(frame, f.keys.privateKey); } },
  serverAuth, () => `bridge-${++ordinal}`);
  const transport = { async close() {}, async send(raw: string) {
    const frame = JSON.parse(raw) as SignedNodeFrame; sent.push(frame);
    if (frame.type === "harness.native.snapshot") {
      receipts.push(await f.service.ingest(raw, { ...f.options(frame.sentAt), expectedConnectionId: bridge.status().connectionId! }));
      if (failAfterStore) { failAfterStore = false; throw new Error("fixture acknowledgement lost"); }
    } else await f.auth.verify(raw, { expectedDirection: "node_to_server", receivedAt: frame.sentAt, transportIdentity: "transport:fixture" });
  } };
  let incoming = 0;
  async function receive<T extends "connection.accepted" | "node.reconciliation.request" | "protocol.ack">(type: T, body: NodeMessageBodyMap[T]) {
    incoming++;
    const connectionId = bridge.status().connectionId!;
    const frame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room", tenantId: binding.tenantId,
      actorId: "server:test", keyId: "server-key:test", connectionId, sequence: incoming, messageId: `server:${connectionId}:${incoming}`,
      correlationId: "correlation:test", nonce: `server_${connectionId.replaceAll(":", "_")}_${incoming}_nonce_123456789`, sentAt: at(1000), expiresAt: at(60_000), type, body } as UnsignedNodeFrame<T>, server.privateKey);
    await bridge.receive(JSON.stringify(frame), at(1000));
  }
  async function open() {
    incoming = 0; await bridge.open(transport, { now: at(1000), transportIdentity: "transport:server" });
    await receive("connection.accepted", { selectedProtocol: NODE_PROTOCOL_V1, enabledFeatures: enabled ? ["harness.native.snapshot.v1"] : [],
      maxFrameBytes: 16_384, heartbeatIntervalSeconds: 30, serverTime: at(1000) });
    await receive("node.reconciliation.request", { lastAcknowledgedNodeSequence: 0, requestedAttemptIds: [] });
  }
  return { ...f, bridge, journal, sent, receipts, open, receive, loseNextAcknowledgement() { failAfterStore = true; },
    async close() { await bridge.close(); journal.close(); await f.close(); } };
}

test("offline snapshot is durable, sent after negotiated reconciliation and retired only after ACK", async t => {
  const f = await bridgeFixture(); t.after(f.close);
  assert.equal(await f.bridge.publishNativeSnapshot(observation(), at(1000)), "recorded");
  assert.equal(f.sent.length, 0); assert.equal(f.journal.pendingNativeSnapshots().length, 1);
  await f.open();
  const published = f.sent.filter(frame => frame.type === "harness.native.snapshot");
  assert.equal(published.length, 1); assert.equal(f.receipts[0].event.replayed, false);
  assert.ok(f.journal.pendingOutbound().some(item => item.frame.messageId === published[0].messageId));
  await f.receive("protocol.ack", f.receipts[0].acknowledgement);
  assert.equal(f.journal.pendingOutbound().some(item => item.frame.messageId === published[0].messageId), false);
  assert.equal(await f.bridge.publishNativeSnapshot(observation(), at(1000)), "duplicate");
  assert.equal(f.sent.filter(frame => frame.type === "harness.native.snapshot").length, 1);
});

test("lost ACK reconnect republishes only evidence with a fresh connection signature and no duplicate stored result", async t => {
  const f = await bridgeFixture(); t.after(f.close); await f.open(); f.loseNextAcknowledgement();
  await assert.rejects(f.bridge.publishNativeSnapshot(observation(), at(1000)), /acknowledgement lost/);
  assert.equal(f.bridge.status().state, "backing_off");
  await f.open();
  const messages = f.sent.filter(frame => frame.type === "harness.native.snapshot");
  assert.equal(messages.length, 2); assert.notEqual(messages[0].connectionId, messages[1].connectionId);
  assert.notEqual(messages[0].messageId, messages[1].messageId); assert.deepEqual(messages[0].body, messages[1].body);
  assert.deepEqual(f.receipts.map(value => value.event.replayed), [false, true]);
  assert.equal((await f.runs.events(binding.tenantId, binding.runId)).length, 1);
});

test("older peers do not receive an unnegotiated snapshot message", async t => {
  const f = await bridgeFixture(false); t.after(f.close);
  await f.bridge.publishNativeSnapshot(observation(), at(1000)); await f.open();
  assert.equal(f.sent.some(frame => frame.type === "harness.native.snapshot"), false);
  assert.equal(f.journal.pendingNativeSnapshots().length, 1);
  const exposed = f.bridge.status(); exposed.enabledFeatures?.push("harness.native.snapshot.v1");
  assert.equal(await f.bridge.flushNativeSnapshots(at(1000)), 0);
});

test("snapshot outbox survives SQLite reopen and requeues expired signatures without forgetting the body", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cr-native-outbox-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "bridge.sqlite"), key = generateKeyPairSync("ed25519").privateKey;
  let journal = new SqliteBridgeJournal(path);
  try {
    journal.appendNativeSnapshot(observation(), at(1000));
    const frame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node", tenantId: binding.tenantId,
      actorId: binding.nodeId, keyId: "key:test", connectionId: "connection:outbox", sequence: 1, messageId: "message:outbox", correlationId: "correlation:test",
      nonce: "fixture_outbox_nonce_1234567890123456", sentAt: at(1000), expiresAt: at(2000), type: "harness.native.snapshot", body: observation() }, key);
    journal.stageNativeSnapshotOutbound(frame, at(1000)); journal.close(); journal = new SqliteBridgeJournal(path);
    assert.equal(journal.pendingNativeSnapshots().length, 0); journal.expireBefore(at(2000));
    assert.deepEqual(journal.pendingNativeSnapshots(), [observation()]);
    assert.throws(() => journal.appendNativeSnapshot({ ...observation(), safeReason: "transport_unavailable" }, at(2000)), /conflict/);
    assert.throws(() => journal.appendNativeSnapshot({ ...observation(), snapshotVersion: 2 }, at(2000)), /regression/);
  } finally { journal.close(); }
});

test("an uncertain database response returns no ACK; exact delivery recovers committed evidence only", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); await f.runs.create(registration);
  let loseCommitReply = true;
  const runs = new HarnessRunStoreV1({ ...f.db, async transaction(work) {
    const value = await f.db.transaction(work);
    if (loseCommitReply) { loseCommitReply = false; throw new Error("fixture commit response unavailable"); }
    return value;
  } }, new Uint8Array(32).fill(17));
  const service = new NativeTaskSnapshotService(f.auth, runs), frame = f.frame(observation({ state: "completed", observedAt: instant + 1000 }));
  await assert.rejects(service.ingest(JSON.stringify(frame), f.options()), { message: "native_snapshot_rejected" });
  assert.equal((await service.ingest(JSON.stringify(frame), f.options())).event.replayed, true);
  assert.equal((await f.runs.events(binding.tenantId, binding.runId)).length, 1);
});

test("native adapter to SQLite outbox to signed protocol to canonical progress works with zero network/provider calls", async t => {
  const f = await bridgeFixture(); t.after(f.close); await f.open();
  const journal = new SqliteNativeRunJournal(":memory:", { testOnlyAllowEphemeral: true }); t.after(() => journal.close());
  let now = instant + 1000; const calls: string[] = [];
  // Explicit synthetic authority/transport: this tests evidence plumbing, not admission or a live profile.
  const adapter = new HermesNativeRunAdapter(enrollment, journal, { async check() {}, async markStart() {} }, {
    async json(request) {
      await request.authorize(); calls.push(request.operation);
      if (request.operation === "capabilities") return response(capabilityBody);
      if (request.operation === "start") return response({ run_id: nativeRunId, status: "started", replayed: false }, 202);
      return response(statusBody("completed", { output: "Synthetic full-chain result", usage: { input_tokens: 12, output_tokens: 5 } }));
    }, async events() { throw new Error("no stream in this fixture"); },
  }, () => now);
  const queued = await adapter.start(input);
  await f.bridge.publishNativeSnapshot(nativeTaskObservation(queued, registration.nativeTask!), at(1000));
  now += 1000;
  const complete = await adapter.poll(binding.runId);
  await f.bridge.publishNativeSnapshot(nativeTaskObservation(complete, registration.nativeTask!), at(2000));
  assert.deepEqual(calls, ["capabilities", "start", "status"]);
  assert.equal((await f.runs.get(binding.tenantId, binding.runId))?.state, "succeeded");
  const event = (await f.runs.events(binding.tenantId, binding.runId)).at(-1)!;
  assert.equal(event.payload.category, "native_snapshot");
  if (event.payload.category === "native_snapshot") {
    assert.equal(event.payload.snapshot.usage?.inputTokens, 12); assert.equal(event.payload.snapshot.usage?.calls, null);
    assert.equal(event.payload.snapshot.result?.sizeBytes, Buffer.byteLength("Synthetic full-chain result"));
  }
  assert.equal((await f.canonical.get(binding.tenantId, "job", binding.jobId))?.state, "leased");
});

test("offline evidence queue has a finite capacity and conflicting records are never overwritten", () => {
  const journal = new SqliteBridgeJournal(":memory:");
  try {
    for (let index = 0; index < 2048; index++) journal.appendNativeSnapshot({ ...observation(), snapshotVersion: index + 1 }, at(1000));
    assert.throws(() => journal.appendNativeSnapshot({ ...observation(), snapshotVersion: 2049 }, at(1000)), /ceiling/);
    assert.equal(journal.appendNativeSnapshot({ ...observation(), snapshotVersion: 1 }, at(1000)), "duplicate");
    assert.equal(journal.pendingNativeSnapshots().length, 32);
  } finally { journal.close(); }
});
