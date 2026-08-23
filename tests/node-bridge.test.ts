import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PortableNodeBridge, SqliteBridgeJournal, BridgeBackpressureError, type BridgeIncomingTransport, type BridgeTransport } from "../src/node-bridge/index.ts";
import {
  FixedWindowProtocolRateLimiter,
  NODE_PROTOCOL_V1,
  NodeProtocolAuthenticator,
  signNodeFrame,
  type SignedNodeFrame,
  type TrustedKeyResolver,
  type UnsignedNodeFrame,
} from "../src/node-protocol/v1/index.ts";

const t0 = "2026-08-22T18:00:00.000Z";
const t1 = "2026-08-22T18:01:00.000Z";
const t1Heartbeat = "2026-08-22T18:01:30.000Z";
const t2 = "2026-08-22T18:02:00.000Z";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, spki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url") };
}

class MemoryTransport implements BridgeTransport {
  readonly sent: SignedNodeFrame[] = [];
  closed = false;
  fail = false;

  async send(frameJson: string): Promise<void> {
    if (this.fail) throw new Error("synthetic transport failure");
    this.sent.push(JSON.parse(frameJson) as SignedNodeFrame);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class EmptyIncomingTransport extends MemoryTransport implements BridgeIncomingTransport {
  async *incoming(): AsyncIterable<string> {
    for (const frame of [] as string[]) yield frame;
  }
}

function serverResolver(spki: string): TrustedKeyResolver {
  return {
    async resolve(input) {
      if (input.tenantId !== "tenant:owner" || input.actorId !== "control-room:server" || input.keyId !== "server-key:1" || input.senderKind !== "control_room") return undefined;
      return {
        tenantId: input.tenantId, actorId: input.actorId, keyId: input.keyId, senderKind: input.senderKind,
        algorithm: "ed25519", publicKeySpki: spki, state: "active", principalState: "active", validFrom: t0,
      };
    },
  };
}

function serverFrame(
  privateKey: KeyObject,
  connectionId: string,
  sequence: number,
  type: "connection.accepted" | "node.reconciliation.request" | "job.cancel" | "protocol.ack",
  body: SignedNodeFrame["body"],
  causationId?: string,
): SignedNodeFrame {
  return signNodeFrame({
    protocol: NODE_PROTOCOL_V1,
    direction: "server_to_node",
    messageId: `server-message:${sequence}`,
    correlationId: "correlation:bridge-test",
    ...(causationId ? { causationId } : {}),
    tenantId: "tenant:owner",
    actorId: "control-room:server",
    senderKind: "control_room",
    keyId: "server-key:1",
    connectionId,
    sequence,
    sentAt: t1,
    expiresAt: t2,
    nonce: `server_nonce_${sequence}_12345678901234567890`,
    type,
    body,
  } as UnsignedNodeFrame, privateKey);
}

function nodeHello(privateKey: KeyObject, messageId: string, connectionId: string, sequence: number): SignedNodeFrame<"connection.hello"> {
  return signNodeFrame({
    protocol: NODE_PROTOCOL_V1,
    direction: "node_to_server",
    messageId,
    correlationId: "correlation:journal",
    tenantId: "tenant:owner",
    actorId: "node:mac-mini",
    senderKind: "node",
    keyId: "node-key:1",
    connectionId,
    sequence,
    sentAt: t1,
    expiresAt: t2,
    nonce: `node_nonce_${sequence}_123456789012345678901234`,
    type: "connection.hello",
    body: { supportedProtocols: [NODE_PROTOCOL_V1], features: [], requestedMaxFrameBytes: 65_536, lastAcknowledgedServerSequence: 0, unresolvedAttemptIds: [] },
  }, privateKey);
}

function nodeJobEvent(privateKey: KeyObject, messageId: string, connectionId: string, sequence: number): SignedNodeFrame<"job.event"> {
  return signNodeFrame({
    protocol: NODE_PROTOCOL_V1,
    direction: "node_to_server",
    messageId,
    correlationId: "correlation:journal-event",
    tenantId: "tenant:owner",
    actorId: "node:mac-mini",
    senderKind: "node",
    keyId: "node-key:1",
    connectionId,
    sequence,
    sentAt: t1,
    expiresAt: t2,
    nonce: `node_event_nonce_${sequence}_1234567890123456`,
    type: "job.event",
    body: {
      jobId: "job:1", attemptId: "attempt:1", leaseId: "lease:1", leaseEpoch: 1,
      event: "progress", sequence: 1, occurredAt: t1, progressPercent: 25, artifactManifestIds: [],
    },
  }, privateKey);
}

test("portable bridge performs signed hello, reconciliation, command queueing, acknowledgements, and heartbeat", async () => {
  const nodeKeys = keys();
  const serverKeys = keys();
  const journal = new SqliteBridgeJournal(":memory:");
  const authenticator = new NodeProtocolAuthenticator(serverResolver(serverKeys.spki), journal, new FixedWindowProtocolRateLimiter(100, 60));
  let id = 0;
  const bridge = new PortableNodeBridge(
    { tenantId: "tenant:owner", nodeId: "node:mac-mini", keyId: "node-key:1", features: ["reconciliation"] },
    journal,
    { async sign(frame) { return signNodeFrame(frame, nodeKeys.privateKey); } },
    authenticator,
    () => `id-${++id}`,
  );
  const transport = new MemoryTransport();
  await bridge.open(transport, { now: t1, transportIdentity: "tls:server" });
  assert.equal(bridge.status().state, "authenticating");
  const connectionId = bridge.status().connectionId as string;
  const hello = transport.sent[0];
  assert.equal(hello.type, "connection.hello");

  const accepted = serverFrame(serverKeys.privateKey, connectionId, 1, "connection.accepted", {
    selectedProtocol: NODE_PROTOCOL_V1, enabledFeatures: ["reconciliation"], maxFrameBytes: 65_536,
    heartbeatIntervalSeconds: 30, serverTime: t1,
  }, hello.messageId);
  await bridge.receive(JSON.stringify(accepted), t1);
  assert.equal(bridge.status().state, "reconciling");

  journal.upsertAttempt({ attemptId: "attempt:1", jobId: "job:1", leaseId: "lease:1", leaseEpoch: 1, state: "running", lastEventSequence: 2, checkpointIds: ["checkpoint:1"] }, t1);
  const reconcile = serverFrame(serverKeys.privateKey, connectionId, 2, "node.reconciliation.request", {
    lastAcknowledgedNodeSequence: 1, requestedAttemptIds: ["attempt:1"],
  });
  await bridge.receive(JSON.stringify(reconcile), t1);
  assert.equal(bridge.status().state, "online");
  assert.ok(transport.sent.some((frame) => frame.type === "node.reconciliation.report"));

  const cancel = serverFrame(serverKeys.privateKey, connectionId, 3, "job.cancel", {
    jobId: "job:1", attemptId: "attempt:1", leaseId: "lease:1", leaseEpoch: 1, reasonCode: "owner_requested",
  });
  await bridge.receive(JSON.stringify(cancel), t1);
  assert.equal(journal.queuedCommandCount(), 1);
  const beforeDuplicate = transport.sent.length;
  await bridge.receive(JSON.stringify(cancel), t1);
  assert.equal(journal.queuedCommandCount(), 1, "an exact retry must never queue a second command");
  assert.equal(transport.sent.length, beforeDuplicate + 1);
  const duplicateAck = transport.sent.at(-1);
  assert.equal(duplicateAck?.type, "protocol.ack");
  if (duplicateAck?.type === "protocol.ack") assert.equal(duplicateAck.body.disposition, "duplicate");

  const heartbeatSnapshot = async () => ({
    observedAt: t1Heartbeat, health: "healthy" as const, policyVersion: "policy:v1", activeAttemptIds: ["attempt:1"],
    resources: { freeMemoryMb: 10_000, freeScratchMb: 20_000, cpuUtilizationPercent: 12 },
  });
  assert.equal(await bridge.tick(t1, heartbeatSnapshot), false);
  assert.equal(await bridge.tick(t1Heartbeat, heartbeatSnapshot), true);
  const heartbeat = transport.sent.findLast((frame) => frame.type === "node.heartbeat") as SignedNodeFrame<"node.heartbeat">;
  const ack = serverFrame(serverKeys.privateKey, connectionId, 4, "protocol.ack", {
    acknowledgedMessageIds: [heartbeat.messageId], highestContiguousSequence: heartbeat.sequence, disposition: "accepted",
  });
  await bridge.receive(JSON.stringify(ack), t1);
  assert.equal(journal.pendingOutbound().some((item) => item.frame.messageId === heartbeat.messageId), false);
  await bridge.close();
  journal.close();
});

test("SQLite journal survives restart with unacknowledged frames and attempt reconciliation state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-room-bridge-"));
  const path = join(directory, "bridge.sqlite");
  const nodeKeys = keys();
  const first = new SqliteBridgeJournal(path);
  const frame = nodeHello(nodeKeys.privateKey, "message:persisted", "connection:persisted", 1);
  first.stageOutbound(frame, true, t1);
  first.markSent(frame.messageId, t1);
  first.upsertAttempt({ attemptId: "attempt:persisted", jobId: "job:persisted", leaseId: "lease:persisted", leaseEpoch: 3, state: "waiting", lastEventSequence: 7, checkpointIds: ["checkpoint:7"] }, t1);
  first.close();

  const restarted = new SqliteBridgeJournal(path);
  assert.equal(restarted.pendingOutbound().length, 1);
  assert.equal(restarted.pendingOutbound()[0].sendAttempts, 1);
  assert.deepEqual(restarted.unresolvedAttempts().map((attempt) => attempt.attemptId), ["attempt:persisted"]);
  restarted.close();
  await rm(directory, { recursive: true });
});

test("journal coalesces unsent heartbeats, preserves essential reserve, and fails closed for other overflow", () => {
  const nodeKeys = keys();
  const journal = new SqliteBridgeJournal(":memory:", 2);
  const heartbeat = (id: string, sequence: number) => {
    const { signature, bodyDigest, ...base } = nodeHello(nodeKeys.privateKey, `base:${id}`, "connection:pressure", sequence);
    void signature;
    void bodyDigest;
    return signNodeFrame({
      ...base,
      messageId: id,
      nonce: `nonce_${sequence}_123456789012345678901234`,
      type: "node.heartbeat",
      body: { observedAt: t1, health: "healthy", policyVersion: "policy:v1", activeAttemptIds: [], resources: { freeMemoryMb: 1, freeScratchMb: 1, cpuUtilizationPercent: 1 } },
    } as UnsignedNodeFrame<"node.heartbeat">, nodeKeys.privateKey);
  };
  journal.stageOutbound(heartbeat("heartbeat:1", 1), false, t1);
  journal.stageOutbound(heartbeat("heartbeat:2", 2), false, t1);
  assert.equal(journal.stageOutbound(heartbeat("heartbeat:3", 3), false, t1), "coalesced");
  assert.equal(journal.pendingOutbound().length, 2);
  const essential = nodeHello(nodeKeys.privateKey, "message:essential", "connection:pressure", 3);
  assert.equal(journal.stageOutbound(essential, true, t1), "staged");
  const nonessential = nodeHello(nodeKeys.privateKey, "message:overflow", "connection:pressure", 4);
  assert.throws(() => journal.stageOutbound(nonessential, false, t1), BridgeBackpressureError);
  const uncommitted = journal.nextOutboundSequence("connection:rollback");
  assert.equal(journal.nextOutboundSequence("connection:rollback"), uncommitted);
  journal.close();
});

test("transport failure leaves the signed frame durable and enters bounded exponential backoff", async () => {
  const nodeKeys = keys();
  const serverKeys = keys();
  const journal = new SqliteBridgeJournal(":memory:");
  const bridge = new PortableNodeBridge(
    { tenantId: "tenant:owner", nodeId: "node:mac-mini", keyId: "node-key:1", features: [] }, journal,
    { async sign(frame) { return signNodeFrame(frame, nodeKeys.privateKey); } },
    new NodeProtocolAuthenticator(serverResolver(serverKeys.spki), journal, new FixedWindowProtocolRateLimiter(100, 60)),
    () => "failure",
  );
  const transport = new MemoryTransport();
  transport.fail = true;
  await assert.rejects(bridge.open(transport, { now: t1, transportIdentity: "tls:server" }), /synthetic transport failure/);
  assert.equal(bridge.status().state, "backing_off");
  assert.equal(journal.pendingOutbound().length, 1);
  assert.ok(bridge.reconnectDelayMilliseconds() >= 1_000);
  journal.close();
});

test("signing failure cannot consume an unjournaled outbound sequence", async () => {
  const serverKeys = keys();
  const journal = new SqliteBridgeJournal(":memory:");
  const bridge = new PortableNodeBridge(
    { tenantId: "tenant:owner", nodeId: "node:mac-mini", keyId: "node-key:1", features: [] }, journal,
    { async sign() { throw new Error("synthetic signer failure"); } },
    new NodeProtocolAuthenticator(serverResolver(serverKeys.spki), journal, new FixedWindowProtocolRateLimiter(100, 60)),
    () => "signer",
  );
  await assert.rejects(bridge.open(new MemoryTransport(), { now: t1, transportIdentity: "tls:server" }), /synthetic signer failure/);
  assert.equal(journal.nextOutboundSequence("connection:signer"), 1);
  assert.equal(journal.pendingOutbound().length, 0);
  journal.close();
});

test("reconnect retires obsolete control frames but resends durable lifecycle frames", async () => {
  const nodeKeys = keys();
  const serverKeys = keys();
  const journal = new SqliteBridgeJournal(":memory:");
  const oldHello = nodeHello(nodeKeys.privateKey, "message:old-hello", "connection:old", 1);
  const oldEvent = nodeJobEvent(nodeKeys.privateKey, "message:old-event", "connection:old", 2);
  journal.stageOutbound(oldHello, true, t1);
  journal.markSent(oldHello.messageId, t1);
  journal.stageOutbound(oldEvent, true, t1);
  journal.markSent(oldEvent.messageId, t1);

  let reconnectId = 0;
  const bridge = new PortableNodeBridge(
    { tenantId: "tenant:owner", nodeId: "node:mac-mini", keyId: "node-key:1", features: ["reconciliation"] }, journal,
    { async sign(frame) { return signNodeFrame(frame, nodeKeys.privateKey); } },
    new NodeProtocolAuthenticator(serverResolver(serverKeys.spki), journal, new FixedWindowProtocolRateLimiter(100, 60)),
    () => `new-${++reconnectId}`,
  );
  const transport = new MemoryTransport();
  await bridge.open(transport, { now: t1, transportIdentity: "tls:server" });
  const connectionId = bridge.status().connectionId as string;
  const currentHello = transport.sent[0];
  await bridge.receive(JSON.stringify(serverFrame(serverKeys.privateKey, connectionId, 1, "connection.accepted", {
    selectedProtocol: NODE_PROTOCOL_V1, enabledFeatures: ["reconciliation"], maxFrameBytes: 65_536,
    heartbeatIntervalSeconds: 30, serverTime: t1,
  }, currentHello.messageId)), t1);
  await bridge.receive(JSON.stringify(serverFrame(serverKeys.privateKey, connectionId, 2, "node.reconciliation.request", {
    lastAcknowledgedNodeSequence: 0, requestedAttemptIds: [],
  })), t1);
  assert.equal(transport.sent.some((frame) => frame.messageId === oldEvent.messageId), true);
  assert.equal(transport.sent.some((frame) => frame.messageId === oldHello.messageId), false);
  assert.equal(journal.pendingOutbound().some((row) => row.frame.messageId === oldHello.messageId), false);
  await bridge.close();
  journal.close();
});

test("portable incoming loop enters reconnect backoff when an outbound-only stream ends", async () => {
  const nodeKeys = keys();
  const serverKeys = keys();
  const journal = new SqliteBridgeJournal(":memory:");
  const bridge = new PortableNodeBridge(
    { tenantId: "tenant:owner", nodeId: "node:mac-mini", keyId: "node-key:1", features: [] }, journal,
    { async sign(frame) { return signNodeFrame(frame, nodeKeys.privateKey); } },
    new NodeProtocolAuthenticator(serverResolver(serverKeys.spki), journal, new FixedWindowProtocolRateLimiter(100, 60)),
    () => "loop",
  );
  const delay = await bridge.run(new EmptyIncomingTransport(), { now: t1, transportIdentity: "tls:server" }, () => t1);
  assert.equal(bridge.status().state, "backing_off");
  assert.equal(delay, bridge.reconnectDelayMilliseconds());
  journal.close();
});

test("authenticated-but-unprocessed frame is handled on exact retry before acknowledgement", async () => {
  const nodeKeys = keys();
  const serverKeys = keys();
  const journal = new SqliteBridgeJournal(":memory:");
  const authenticator = new NodeProtocolAuthenticator(serverResolver(serverKeys.spki), journal, new FixedWindowProtocolRateLimiter(100, 60));
  let id = 0;
  const bridge = new PortableNodeBridge(
    { tenantId: "tenant:owner", nodeId: "node:mac-mini", keyId: "node-key:1", features: [] }, journal,
    { async sign(frame) { return signNodeFrame(frame, nodeKeys.privateKey); } }, authenticator, () => `crash-${++id}`,
  );
  const transport = new MemoryTransport();
  await bridge.open(transport, { now: t1, transportIdentity: "tls:server" });
  const connectionId = bridge.status().connectionId as string;
  const accepted = serverFrame(serverKeys.privateKey, connectionId, 1, "connection.accepted", {
    selectedProtocol: NODE_PROTOCOL_V1, enabledFeatures: [], maxFrameBytes: 65_536, heartbeatIntervalSeconds: 30, serverTime: t1,
  }, transport.sent[0].messageId);

  const firstAuthentication = await authenticator.verify(JSON.stringify(accepted), {
    expectedDirection: "server_to_node", expectedConnectionId: connectionId, receivedAt: t1,
    transportIdentity: "tls:server",
  });
  assert.equal(firstAuthentication.delivery, "accepted");
  assert.equal(journal.inboundStatus(accepted.messageId), "received");
  await bridge.receive(JSON.stringify(accepted), t1);
  assert.equal(bridge.status().state, "reconciling");
  assert.equal(journal.inboundStatus(accepted.messageId), "processed");
  const acknowledgement = transport.sent.at(-1);
  assert.equal(acknowledgement?.type, "protocol.ack");
  if (acknowledgement?.type === "protocol.ack") assert.equal(acknowledgement.body.disposition, "duplicate");
  await bridge.close();
  journal.close();
});
