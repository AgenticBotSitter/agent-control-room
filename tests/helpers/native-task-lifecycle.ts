import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { canonicalApprovalStorageFixture } from "./canonical-approval-storage";
import { nativeStartAuthorityFixture } from "./native-start-authority";
import { PortableNodeBridge, SqliteBridgeJournal } from "../../src/node-bridge";
import { NativeDispatchIntakeHandler } from "../../src/node-bridge/native-dispatch-handler";
import { ServerNodeSession } from "../../src/node-control/server-node-session";
import { FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator, signNodeFrame,
  type SignedNodeFrame } from "../../src/node-protocol/v1";
import { NATIVE_DELIVERY_FEATURE } from "../../src/harness/v1/native-delivery";
import { prepareNativeExecutionHandoff } from "../../src/harness/hermes-native-v1/execution-handoff";
import { nativeTaskObservation, nativeTaskRegistration } from "../../src/harness/hermes-native-v1/task-observation";
import { resolvePinnedApprovalKey } from "../../src/node-policy/v1/pinned-approval-trust";
import { NativeResultSubmissionService } from "../../src/completion-gate/v1/native-result-submission";
import { NativeTaskResultService } from "../../src/node-control/native-task-result-service";
import { sha256Digest } from "../../src/security";
import { response, statusBody } from "../hermes-native-fixture";
import type { TaskSourcePreparation } from "./task-assignment";

/** Explicit in-process wiring, not a mounted runtime: real controllers/stores with synthetic
 * owner keys, qualification and native transport. All assertions use the newly planned job;
 * the reused fixture also contains unrelated pre-existing result/review records. */
export async function nativeTaskLifecycleFixture(configuration: { serverFeatures?: string[]; prepareSource?: TaskSourcePreparation } = {}) {
  const f = await canonicalApprovalStorageFixture(configuration.prepareSource);
  const local = await nativeStartAuthorityFixture(undefined, f.prepared.enrollment, f.assignmentFixture);
  assert.equal(sha256Digest(local.prepared.binding), sha256Digest(f.prepared.binding));
  local.policy.approvalKey = await resolvePinnedApprovalKey(f.approvals, f.approvals.binding(), f.packet.approval.body.approvalKeyId);
  const journal = new SqliteBridgeJournal(":memory:"), serverKeys = generateKeyPairSync("ed25519");
  const spki = serverKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const handler = new NativeDispatchIntakeHandler(f.prepared.enrollment, journal,
    { approvals: f.approvals, security: f.native.trust }, f.clock);
  const features = [NATIVE_DELIVERY_FEATURE, "harness.native.snapshot.v1"];
  const bridge = new PortableNodeBridge({ tenantId: "tenant:test", nodeId: "node:test", keyId: "key:test", features }, journal,
    { async sign(frame) { return signNodeFrame(frame, f.keys.privateKey); } },
    new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", publicKeySpki: spki,
      state: "active", principalState: "active", validFrom: new Date(f.clock() - 60_000).toISOString() }; } }, journal,
    new FixedWindowProtocolRateLimiter(100, 60)), undefined, undefined, handler);
  const outgoing: string[] = [], incoming: string[] = [], sent: SignedNodeFrame[] = [];
  let resultText: string | undefined, loseAcknowledgement = false;
  const timestamp = () => new Date(f.clock()).toISOString();
  const session = new ServerNodeSession({ tenantId: "tenant:test", nodeId: "node:test", nodeKeyId: "key:test",
    serverId: "server:test", serverKeyId: "key:server", serverPublicKeySpki: spki, transportIdentity: "transport:lifecycle",
    features: configuration.serverFeatures ?? features, maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30 }, {
    authentication: f.auth, clock: f.clock,
    async sign(frame) { return signNodeFrame(frame, serverKeys.privateKey); },
    async send(raw) {
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error("synthetic_acknowledgement_lost"); }
      outgoing.push(raw);
    },
  });
  await bridge.open({ async send(raw) { incoming.push(raw); sent.push(JSON.parse(raw)); }, async close() {} },
    { now: timestamp(), transportIdentity: "transport:lifecycle-server" });
  await session.acceptHello(incoming.shift()!);
  for (let count = 0; count < 20 && (outgoing.length || incoming.length); count++) {
    while (outgoing.length) await bridge.receive(outgoing.shift()!, timestamp());
    while (incoming.length) await session.receive(incoming.shift()!);
  }
  assert.ok(session.nativeDeliveryChannel()); assert.equal(outgoing.length + incoming.length, 0);
  await f.save();
  await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  await f.coordinator.stageQueuedNativeDelivery(...f.args, sha256Digest(f.packet), session, f.abort.signal);
  await f.coordinator.transmitQueuedNativeDelivery(...f.args, sha256Digest(f.packet), session, f.abort.signal);
  const dispatch = JSON.parse(outgoing[0]) as SignedNodeFrame<"harness.native.dispatch">;
  await bridge.receive(outgoing.shift()!, timestamp());
  const receipt = await f.store.receiveDeliveryReceipt(f.db, session, incoming.shift()!, f.abort.signal);
  const config = { queueId: dispatch.body.queueId, enrollment: f.prepared.enrollment, serverActorId: "server:test" };
  const dependencies = { deliveries: journal, runs: local.journal, approvals: f.approvals,
    security: { currentServerTrustRevision: () => f.native.trust.currentServerTrustRevision(),
      async resolveServerKey() { return new Uint8Array(Buffer.from(spki, "base64url")); } },
    local: local.dependencies, clock: f.clock, transport: { ...local.transport, async json(wire: Parameters<typeof local.transport.json>[0]) {
      if (wire.operation === "status" && resultText !== undefined) {
        await wire.authorize(); local.calls.push(wire.operation);
        return response(statusBody("completed", { session_id: f.prepared.binding.sessionId, output: resultText,
          usage: { input_tokens: 12, output_tokens: 5 } }));
      }
      return local.transport.json(wire);
    } } };
  const prepare = () => prepareNativeExecutionHandoff(config, dependencies, f.abort.signal);
  const handoff = await prepare();
  const registration = nativeTaskRegistration(f.prepared.binding, f.args[3],
    f.prepared.request.leaseId, f.prepared.request.leaseEpoch, timestamp());
  const submission = new NativeResultSubmissionService(f.db, f.ownerConfig);
  const results = new NativeTaskResultService(f.auth, f.runs, f.results, submission);
  const options = () => ({ receivedAt: timestamp(), transportIdentity: "transport:lifecycle",
    expectedConnectionId: bridge.status().connectionId! });
  async function register() {
    await f.runs.create(registration);
    return f.planner.bindReview(registration.jobId, registration.id, f.harnessKey, submission);
  }
  async function queueSnapshot() {
    const body = nativeTaskObservation(handoff.snapshot(), registration.nativeTask!);
    await bridge.publishNativeSnapshot(body, timestamp());
    const raw = incoming.shift()!;
    return { raw, body };
  }
  async function publish() {
    const { raw, body } = await queueSnapshot();
    const stored = await session.acceptNativeSnapshot(raw, (frame, assertCurrent) =>
      f.runs.recordNativeSnapshot(frame.tenantId, frame.actorId, frame.body, assertCurrent));
    await bridge.receive(outgoing.shift()!, timestamp());
    return { raw, body, stored };
  }
  return { f, local, handoff, prepare, registration, submission, results, options, register, publish, queueSnapshot,
    journal, receipt, sent, session, outgoing,
    acknowledgeSnapshot: async () => { await bridge.receive(outgoing.shift()!, timestamp()); },
    loseNextAcknowledgement: () => { loseAcknowledgement = true; },
    setResult: (value: string) => { resultText = value; },
    advance: () => { const now = f.clock() + 1000; f.setNow(now); local.setNow(now); },
    close: async () => { handoff.close(); handler.close(); session.disconnect(); await bridge.close(); journal.close(); await local.close(); await f.close(); } };
}
