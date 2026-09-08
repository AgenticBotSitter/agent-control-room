// Research-only adaptations of existing native-start-authority/native-task-lifecycle helpers.
// Same existing DB/child assignment; current initial clock, distinct synthetic backend ID,
// and caller-owned cleanup replace the parent fixture's fixed setup. No policy rules changed.
import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
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
import type { canonicalApprovalStorageFixture } from "../../tests/helpers/canonical-approval-storage";


import { taskAssignmentFixture } from "../../tests/helpers/task-assignment";
import { taskDraft } from "../../tests/helpers/web-task";
import { sha256Digest } from "../../src/security";
import { CanonicalStore } from "../../src/persistence/canonical-store";
import { prepareNativeTaskApproval } from "../../src/harness/hermes-native-v1/task-approval-binding";
import { createNativeStartAuthority, type NativeStartAuthorityDependencies, type NativeCurrentPolicy } from "../../src/harness/hermes-native-v1/start-authority";
import { HermesNativeRunAdapter } from "../../src/harness/hermes-native-v1/adapter";
import { SqliteNativeRunJournal } from "../../src/harness/hermes-native-v1/run-journal";
import type { NativeRunTransport, NativeEnrollment } from "../../src/harness/hermes-native-v1/contracts";
import { computeArtifactBodyDigest, signArtifact, SqliteLocalAdmissionStore, SqliteExecutionStateStore, SqliteEffectClaimStore,
  type OwnerApprovalAttestationBodyV1 } from "../../src/node-policy/v1";
import { enrollment as defaultEnrollment, capabilityBody, response, statusBody } from "../../tests/hermes-native-fixture";
const childNativeRunId = `run_${"2".repeat(32)}`;

export async function childLocalFixture(initialNow: number, otherCommandKey?: string, configuredEnrollment?: NativeEnrollment,
  existingFixture?: Awaited<ReturnType<typeof taskAssignmentFixture>>) {
  const enrollment = configuredEnrollment ?? defaultEnrollment;
  const f = existingFixture ?? await taskAssignmentFixture();
  let assigned: Awaited<ReturnType<typeof f.assign>>["receipt"];
  if (otherCommandKey) {
    const source = await f.tasks.propose(f.identity, f.profile.projectId, taskDraft, otherCommandKey);
    const plan = await f.planner.plan(f.identity, f.profile.projectId, source.receipt.jobId, sha256Digest(taskDraft));
    assigned = (await f.coordinator.assign(f.identity, f.profile.projectId, plan.receipt.jobId, f.route.nodeId, plan.receipt.inputDigest)).receipt;
  } else assigned = (await f.assign()).receipt;
  const canonical = new CanonicalStore(f.db), plan = await f.planner.read(assigned.jobId);
  if (!plan) throw new Error("fixture plan missing");
  let now = initialNow, profileAvailable = true, profileChecks = 0, reads = 0, extraActive = 0;
  const prepared = prepareNativeTaskApproval({ enrollment, nodeClass: "personal-compute", now, input: plan.input,
    job: await canonical.get(f.scope.tenantId, "job", assigned.jobId), attempt: await canonical.get(f.scope.tenantId, "attempt", assigned.attemptId),
    lease: await canonical.get(f.scope.tenantId, "lease", assigned.leaseId) });
  const at = new Date(now).toISOString(), expiresAt = new Date(prepared.start.deadline).toISOString(), r = prepared.request;
  const keys = generateKeyPairSync("ed25519");
  const body: OwnerApprovalAttestationBodyV1 = { schema: "control-room.owner-approval-attestation/v1", tenantId: r.tenantId,
    nodeId: r.nodeId, projectId: r.projectId, jobId: r.jobId, attemptId: r.attemptId, operationDigest: r.operationDigest,
    risk: "low", decision: "approved", issuedAt: at, expiresAt, nonce: "c3ludGhldGljLW5vbmNl", approvalKeyId: "approval-key:test", bodyDigest: "" };
  body.bodyDigest = computeArtifactBodyDigest(body);
  const request = { ...r, approval: signArtifact(body, keys.privateKey) };
  const ceiling: NativeCurrentPolicy["ceiling"] = { schema: "control-room.node-authority-ceiling/v1", tenantId: r.tenantId, nodeId: r.nodeId,
    version: 1, issuedAt: at, issuerKeyId: "owner-key:test", projectIds: [r.projectId], executorIds: [r.executorId], operationIds: [r.operationId],
    credentialRefs: r.credentialRefs, filesystemRoots: [], networkDestinations: [enrollment.canonicalDestination], maxRisk: "low",
    externalEffects: "approval_required", maxDurationSeconds: 60, maxConcurrentEffects: 1, bodyDigest: "" };
  ceiling.bodyDigest = computeArtifactBodyDigest(ceiling);
  const policy: NativeCurrentPolicy = { paused: false, ceiling,
    lease: { tenantId: r.tenantId, nodeId: r.nodeId, jobId: r.jobId, attemptId: r.attemptId, leaseId: r.leaseId, leaseEpoch: r.leaseEpoch,
      validFrom: at, expiresAt, authorityDigest: plan.job.authority.digest, authority: plan.job.authority, parentAuthorities: [] },
    executor: { contractVersion: "control-room-node-policy/v1", executorId: r.executorId, operationIds: [r.operationId],
      externalEffectOperationIds: [r.operationId], targetKinds: ["network"], supportsCancellation: true, supportsNetworkIdentityEnforcement: true, costMeter: "none" },
    keyAvailability: { state: "available", keyReferenceId: "key:test", observedAt: at }, activeExternalEffects: 0,
    approvalKey: { keyId: body.approvalKeyId, publicKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url") } };
  const options = { testOnlyAllowEphemeral: true };
  const admissions = new SqliteLocalAdmissionStore(":memory:", options), executions = new SqliteExecutionStateStore(":memory:", options),
    effects = new SqliteEffectClaimStore(":memory:", options), journal = new SqliteNativeRunJournal(":memory:", options);
  const dependencies: NativeStartAuthorityDependencies = { admissions, executions, effects, clock: () => now,
    async readCurrent() { reads++; return { ...policy, activeExternalEffects: effects.countActive(r.tenantId, r.nodeId) + extraActive }; },
    // Explicit synthetic qualification seam: this does not resolve accepted host evidence.
    async assertProfileCurrent() { profileChecks++; if (!profileAvailable) throw new Error("synthetic profile unavailable"); },
  };
  const config = { enrollment, request, start: prepared.start };
  const create = (overrides: Partial<NativeStartAuthorityDependencies> = {}) => createNativeStartAuthority(config, { ...dependencies, ...overrides });
  const calls: string[] = [];
  const transport: NativeRunTransport = { async json(wire) {
    await wire.authorize(); calls.push(wire.operation);
    if (wire.operation === "capabilities") return response(capabilityBody);
    if (wire.operation === "start") return response({ run_id: childNativeRunId, status: "started", replayed: false }, 202);
    return response(statusBody("running", { run_id: childNativeRunId, session_id: prepared.binding.sessionId }));
  }, async events(wire) { await wire.authorize(); calls.push("events"); } };
  const adapter = (controller: ReturnType<typeof create>, wire = transport) => new HermesNativeRunAdapter(enrollment, journal, controller.authority, wire, () => now);
  return { ...f, prepared, config, policy, dependencies, admissions, executions, effects, journal, create, calls, transport, adapter,
    setNow: (value: number) => { now = value; }, setProfile: (value: boolean) => { profileAvailable = value; },
    setExtraActive: (value: number) => { extraActive = value; }, reads: () => reads, profileChecks: () => profileChecks,
    close: async () => { journal.close(); effects.close(); executions.close(); admissions.close(); if (!existingFixture) await f.close(); } };
}
/** Explicit in-process wiring, not a mounted runtime: real controllers/stores with synthetic
 * owner keys, qualification and native transport. All assertions use the newly planned job;
 * the reused fixture also contains unrelated pre-existing result/review records. */
export async function childLifecycleFixture(f: Awaited<ReturnType<typeof canonicalApprovalStorageFixture>>,
  onClose: (close: () => Promise<void>) => void) {
  const configuration: { serverFeatures?: string[] } = {};
  const local = await childLocalFixture(f.clock(), undefined, f.prepared.enrollment, f.assignmentFixture);
  onClose(() => local.close());
  assert.equal(sha256Digest(local.prepared.binding), sha256Digest(f.prepared.binding));
  local.policy.approvalKey = await resolvePinnedApprovalKey(f.approvals, f.approvals.binding(), f.packet.approval.body.approvalKeyId);
  const journal = new SqliteBridgeJournal(":memory:"), serverKeys = generateKeyPairSync("ed25519");
  onClose(async () => { journal.close(); });
  const spki = serverKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const handler = new NativeDispatchIntakeHandler(f.prepared.enrollment, journal,
    { approvals: f.approvals, security: f.native.trust }, f.clock);
  onClose(async () => { handler.close(); });
  const features = [NATIVE_DELIVERY_FEATURE, "harness.native.snapshot.v1"];
  const bridge = new PortableNodeBridge({ tenantId: "tenant:test", nodeId: "node:test", keyId: "key:test", features }, journal,
    { async sign(frame) { return signNodeFrame(frame, f.keys.privateKey); } },
    new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", publicKeySpki: spki,
      state: "active", principalState: "active", validFrom: new Date(f.clock() - 60_000).toISOString() }; } }, journal,
    new FixedWindowProtocolRateLimiter(100, 60)), undefined, undefined, handler);
  onClose(async () => { await bridge.close(); });
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
  onClose(async () => { session.disconnect(); });
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
        return response(statusBody("completed", { run_id: childNativeRunId, session_id: f.prepared.binding.sessionId, output: resultText,
          usage: { input_tokens: 12, output_tokens: 5 } }));
      }
      return local.transport.json(wire);
    } } };
  const prepare = () => prepareNativeExecutionHandoff(config, dependencies, f.abort.signal);
  const handoff = await prepare();
  onClose(async () => { handoff.close(); });
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
  const close = async () => { handoff.close(); handler.close(); session.disconnect(); await bridge.close(); journal.close(); await local.close(); };
  return { f, local, handoff, prepare, registration, submission, results, options, register, publish, queueSnapshot,
    journal, receipt, sent, session, outgoing,
    acknowledgeSnapshot: async () => { await bridge.receive(outgoing.shift()!, timestamp()); },
    loseNextAcknowledgement: () => { loseAcknowledgement = true; },
    setResult: (value: string) => { resultText = value; },
    advance: () => { const now = f.clock() + 1000; f.setNow(now); local.setNow(now); },
    close };
}
