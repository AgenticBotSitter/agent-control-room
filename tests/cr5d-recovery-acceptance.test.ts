import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PortableNodeBridge, SqliteBridgeJournal, type BridgeTransport } from "../src/node-bridge";
import { computeExecutionId, SqliteExecutionStateStore } from "../src/node-policy/v1";
import { sha256Digest } from "../src/security";
import {
  FixedWindowProtocolRateLimiter,
  NODE_PROTOCOL_V1,
  NodeProtocolAuthenticator,
  signNodeFrame,
  type SignedNodeFrame,
  type TrustedKeyResolver,
  type UnsignedNodeFrame,
} from "../src/node-protocol/v1";

const now = "2026-08-26T12:06:00.000Z";
const expiresAt = "2026-08-26T12:10:00.000Z";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    spki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}

class MemoryTransport implements BridgeTransport {
  readonly sent: SignedNodeFrame[] = [];
  async send(frameJson: string): Promise<void> { this.sent.push(JSON.parse(frameJson) as SignedNodeFrame); }
  async close(): Promise<void> {}
}

function resolver(spki: string): TrustedKeyResolver {
  return {
    async resolve(input) {
      if (input.tenantId !== "tenant:owner" || input.actorId !== "control-room:server" || input.keyId !== "server-key:1" || input.senderKind !== "control_room") return undefined;
      return {
        tenantId: input.tenantId,
        actorId: input.actorId,
        keyId: input.keyId,
        senderKind: input.senderKind,
        algorithm: "ed25519",
        publicKeySpki: spki,
        state: "active",
        principalState: "active",
        validFrom: "2026-08-26T11:00:00.000Z",
      };
    },
  };
}

function serverFrame(
  privateKey: KeyObject,
  connectionId: string,
  sequence: number,
  messageSuffix: string,
  type: "connection.accepted" | "node.reconciliation.request" | "protocol.ack",
  body: SignedNodeFrame["body"],
  causationId?: string,
): SignedNodeFrame {
  return signNodeFrame({
    protocol: NODE_PROTOCOL_V1,
    direction: "server_to_node",
    messageId: `server:recovery:${messageSuffix}:${sequence}`,
    correlationId: `correlation:recovery:${messageSuffix}`,
    ...(causationId ? { causationId } : {}),
    tenantId: "tenant:owner",
    actorId: "control-room:server",
    senderKind: "control_room",
    keyId: "server-key:1",
    connectionId,
    sequence,
    sentAt: now,
    expiresAt,
    nonce: `server_recovery_${messageSuffix}_${sequence}_12345678901234567890`,
    type,
    body,
  } as UnsignedNodeFrame, privateKey);
}

function bridgeFor(journal: SqliteBridgeJournal, serverSpki: string, nodePrivateKey: KeyObject, idPrefix: string) {
  let id = 0;
  return new PortableNodeBridge(
    { tenantId: "tenant:owner", nodeId: "node:mac-mini", keyId: "node-key:1", features: ["reconciliation"] },
    journal,
    { async sign(frame) { return signNodeFrame(frame, nodePrivateKey); } },
    new NodeProtocolAuthenticator(resolver(serverSpki), journal, new FixedWindowProtocolRateLimiter(100, 60)),
    () => `${idPrefix}-${++id}`,
  );
}

async function connectAndReconcile(
  bridge: PortableNodeBridge,
  transport: MemoryTransport,
  serverPrivateKey: KeyObject,
  messageSuffix: string,
): Promise<string> {
  await bridge.open(transport, { now, transportIdentity: "tls:server" });
  const connectionId = bridge.status().connectionId as string;
  const hello = transport.sent[0];
  await bridge.receive(JSON.stringify(serverFrame(serverPrivateKey, connectionId, 1, messageSuffix, "connection.accepted", {
    selectedProtocol: NODE_PROTOCOL_V1,
    enabledFeatures: ["reconciliation"],
    maxFrameBytes: 65_536,
    heartbeatIntervalSeconds: 30,
    serverTime: now,
  }, hello.messageId)), now);
  await bridge.receive(JSON.stringify(serverFrame(serverPrivateKey, connectionId, 2, messageSuffix, "node.reconciliation.request", {
    lastAcknowledgedNodeSequence: 0,
    requestedAttemptIds: ["attempt:recovery:1"],
  })), now);
  return connectionId;
}

test("abrupt process exit recovers committed execution, lineage, delivery, and acknowledgement exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-room-cr5d-recovery-"));
  const executionPath = join(directory, "execution.sqlite");
  const journalPath = join(directory, "bridge.sqlite");
  try {
    const producer = spawnSync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "tests/fixtures/cr5d-abrupt-exit-producer.ts"),
      executionPath,
      journalPath,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
    assert.equal(producer.status, 91, producer.stderr || producer.stdout);

    const authority = new SqliteExecutionStateStore(executionPath);
    const executionId = computeExecutionId("admission:recovery:1", sha256Digest({
      schema: "control-room.synthetic-execution/v1",
      jobId: "job:recovery:1",
      attemptId: "attempt:recovery:1",
      steps: 3,
      checkpointEverySteps: 2,
      stepDelayMilliseconds: 0,
      artifactText: "restart-safe synthetic result\n",
    }));
    const persistedExecution = authority.load(executionId);
    assert.equal(persistedExecution?.state, "completed");
    assert.equal(authority.events(executionId).filter(({ event }) => event.kind === "completed").length, 1);
    authority.close();

    let journal = new SqliteBridgeJournal(journalPath);
    assert.deepEqual(journal.pendingJobEvents().map((row) => row.event.sequence), [1, 2, 3, 4, 5, 6, 7]);
    const lineage = journal.artifactLineage("artifact:recovery:1");
    assert.equal(lineage?.producerClaim.claim, "content_hash_matches_exact_bytes");
    assert.deepEqual(lineage?.independentVerification, { status: "not_run" });

    const nodeKeys = keys();
    const serverKeys = keys();
    let bridge = bridgeFor(journal, serverKeys.spki, nodeKeys.privateKey, "first");
    let transport = new MemoryTransport();
    await connectAndReconcile(bridge, transport, serverKeys.privateKey, "first");
    const delivered = transport.sent.filter((frame): frame is SignedNodeFrame<"job.event"> => frame.type === "job.event");
    assert.deepEqual(delivered.map((frame) => frame.body.sequence), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(new Set(delivered.map((frame) => frame.messageId)).size, 7);
    assert.ok(journal.pendingJobEvents().every((row) => row.status === "staged"));

    await bridge.close();
    journal.close();

    // Model a second interruption after transport send but before the server receipt.
    // The delivery identities remain stable so the receiver can deduplicate them.
    journal = new SqliteBridgeJournal(journalPath);
    bridge = bridgeFor(journal, serverKeys.spki, nodeKeys.privateKey, "second");
    transport = new MemoryTransport();
    const restartedConnectionId = await connectAndReconcile(bridge, transport, serverKeys.privateKey, "second");
    const redelivered = transport.sent.filter((frame): frame is SignedNodeFrame<"job.event"> => frame.type === "job.event");
    assert.deepEqual(redelivered.map((frame) => frame.messageId), delivered.map((frame) => frame.messageId));

    await bridge.receive(JSON.stringify(serverFrame(serverKeys.privateKey, restartedConnectionId, 3, "second", "protocol.ack", {
      acknowledgedMessageIds: redelivered.map((frame) => frame.messageId),
      highestContiguousSequence: Math.max(...redelivered.map((frame) => frame.sequence)),
      disposition: "accepted",
    })), now);
    assert.ok(Array.from({ length: 7 }, (_, index) => journal.jobEventStatus("attempt:recovery:1", index + 1)).every((state) => state === "acknowledged"));
    await bridge.close();
    journal.close();

    journal = new SqliteBridgeJournal(journalPath);
    assert.equal(journal.pendingJobEvents().length, 0);
    bridge = bridgeFor(journal, serverKeys.spki, nodeKeys.privateKey, "third");
    transport = new MemoryTransport();
    await connectAndReconcile(bridge, transport, serverKeys.privateKey, "third");
    assert.equal(transport.sent.filter((frame) => frame.type === "job.event").length, 0);
    await bridge.close();
    journal.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
