import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { adaptPglite, type DatabaseClient } from "../src/persistence/database";
import { ServerNodeSession } from "../src/node-control/server-node-session";
import { FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator, signNodeFrame } from "../src/node-protocol/v1";
import { CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1 } from
  "../src/harness/v1/controller-worker-node-delivery";
import { ControllerWorkerDeliveryIntakeHandlerV1 } from "../src/node-bridge/controller-worker-delivery-handler";
import { PortableNodeBridge } from "../src/node-bridge/bridge";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { assemblePrivateAgentTaskOperatorConfiguration } from "../src/web/v1/private-agent-task-operator-configuration";
import { validatePrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import { operatorConfigurationScenario } from "./helpers/private-agent-task-operator-configuration";
import { capturePrivateRemoteControllerWorkerQueueCapabilityV1, capturePrivateRemoteControllerWorkerReceiptIngressCapabilityV1,
  createPrivateRemoteControllerWorkerCompositionV1, isPrivateRemoteControllerWorkerCompositionV1,
  isPrivateRemoteControllerWorkerQueueCapabilityV1, isPrivateRemoteControllerWorkerReceiptIngressCapabilityV1,
  PrivateRemoteControllerWorkerEnrollmentStateV1 } from
  "../src/harness/v1/private-remote-controller-worker-composition";
import { CONTROLLER_WORKER_REMOTE_ADAPTER_V1, CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
  CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1, CONTROLLER_WORKER_REMOTE_START_OPERATION_V1,
  createRemoteWorkerEnrollmentV1 } from "../src/harness/v1/remote-worker-delivery";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { boundPrivateDatabase } from "../src/web/v1/bounded-database";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";

async function realInstalledConnection(enrollment: ReturnType<typeof createRemoteWorkerEnrollmentV1>, clock: () => number) {
  const serverKeys = generateKeyPairSync("ed25519"), nodeKeys = generateKeyPairSync("ed25519");
  const serverSpki = serverKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const nodeSpki = nodeKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const journal = new SqliteBridgeJournal(":memory:"), toNode: string[] = [], toServer: string[] = [];
  const handler = new ControllerWorkerDeliveryIntakeHandlerV1({ workerId: enrollment.workerId,
    adapterId: enrollment.adapterId, adapterRevision: enrollment.adapterRevision,
    enrollmentDigest: enrollment.enrollmentDigest }, journal, clock);
  const bridge = new PortableNodeBridge({ tenantId: binding.tenantId, nodeId: binding.nodeId,
    keyId: "node-key:protected-remote",
    features: [CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1] }, journal,
  { async sign(frame) { return signNodeFrame(frame, nodeKeys.privateKey); } },
  new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", publicKeySpki: serverSpki,
    state: "active", principalState: "active", validFrom: at(1_000) }; } }, journal,
  new FixedWindowProtocolRateLimiter(100, 60)), undefined, undefined, undefined, undefined, undefined, handler);
  const createSession = () => new ServerNodeSession({ tenantId: binding.tenantId, nodeId: binding.nodeId,
    nodeKeyId: "node-key:protected-remote", serverId: "server:control-room", serverKeyId: "server-key:control-room",
    serverPublicKeySpki: serverSpki, transportIdentity: "transport:protected-remote",
    features: [CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1],
    maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30 }, {
    clock,
    authentication: new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519",
      publicKeySpki: nodeSpki, state: "active", principalState: "active", validFrom: at(1_000) }; } },
    { async consume() { return "accepted" as const; } }, new FixedWindowProtocolRateLimiter(100, 60)),
    async sign(frame) { return signNodeFrame(frame, serverKeys.privateKey); },
    async send(raw) { toNode.push(raw); },
  });
  let session = createSession(), deliverySends = 0;
  const pumpHandshake = async () => {
    await bridge.open({ async send(raw) { toServer.push(raw); }, async close() {} },
      { now: new Date(clock()).toISOString(), transportIdentity: "transport:protected-remote" });
    await session.acceptHello(toServer.shift()!);
    while (toNode.length || toServer.length) {
      while (toNode.length) await bridge.receive(toNode.shift()!, new Date(clock()).toISOString());
      while (toServer.length) await session.receive(toServer.shift()!);
    }
  };
  await pumpHandshake();
  return {
    get session() { return session; },
    sends: () => deliverySends,
    async deliverToNode() {
      const raw = toNode.shift(); if (!raw) throw new Error("missing dispatch");
      deliverySends++; await bridge.receive(raw, new Date(clock()).toISOString());
      const receiptRaw = toServer.shift(); if (!receiptRaw) throw new Error("missing receipt");
      return receiptRaw;
    },
    async reconnect() {
      session.disconnect(); await bridge.disconnected(); toNode.length = 0; toServer.length = 0;
      session = createSession(); await pumpHandshake();
    },
    async recovery(queueId: string) {
      await bridge.recoverControllerWorkerReceipt(queueId, new Date(clock()).toISOString());
      const raw = toServer.shift(); if (!raw) throw new Error("missing recovery receipt"); return raw;
    },
    async close() { session.disconnect(); await bridge.close(); handler.close(); journal.close(); },
  };
}

async function canonical() {
  const f = await ownerReviewFixture(undefined, "A useful private result.", { exactRepositorySimulation: true });
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId,
    allowedExecutor: "executor:protected-remote", allowedOperations: [CONTROLLER_WORKER_REMOTE_START_OPERATION_V1],
    credentialRefs: ["credential:protected-remote"], filesystemRoots: [], networkPolicy: "none",
    allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low", maxDurationSeconds: 60,
    maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const connectorProfileDigest = sha256Digest("protected-remote-profile");
  const template: NativeTaskTemplate = { id: "template:protected-remote",
    adapter: CONTROLLER_WORKER_REMOTE_ADAPTER_V1, authority, instructions: "Return bounded evidence only.",
    connectorProfileDigest, acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  let now = instant + 7_000;
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(41),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => now);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "protected-remote-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const route = [{ nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: CONTROLLER_WORKER_REMOTE_CAPABILITY_V1, maxConcurrentTasks: 8,
    requiredScratchBytes: 0, leaseSeconds: 60 }] as const;
  const signals = new FleetSignalStore(f.db);
  for (const signal of [{ kind: "telemetry", source: "telemetry_port", fingerprint: sha256Digest("remote-telemetry"),
    payload: { samplingIntervalSeconds: 30, cpuUtilizationPercent: { quality: "observed", value: 10 },
      availableMemoryBytes: { quality: "observed", value: 1000 }, availableStorageBytes: { quality: "observed", value: 1000 },
      networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } },
  { kind: "capability", source: "probe_runner", fingerprint: sha256Digest("remote-capability"),
    payload: { probeId: CONTROLLER_WORKER_REMOTE_CAPABILITY_V1, probeVersion: "1.0.0", outcome: "pass", reasonCode: "reported_only" } }] as const) {
    await signals.ingestAuthenticated({ schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
      sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", ...signal } as FleetSignalEnvelope,
    at(6_000), binding);
  }
  const assignments = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => now + 1_000);
  const assigned = await assignments.assign(f.identity, binding.projectId, planned.receipt.jobId,
    binding.nodeId, planned.receipt.inputDigest);
  return { f, planner, connectorProfileDigest, now: () => now, advance(ms: number) { now += ms; },
    ref: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: planned.receipt.jobId,
      attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId, inputDigest: planned.receipt.inputDigest } };
}

test("the protected remote composition binds one enrolled session and recovers its exact receipt without resend", async t => {
  const c = await canonical(); t.after(c.f.close);
  const enrollment = createRemoteWorkerEnrollmentV1({ workerId: "worker:protected-remote",
    adapterId: CONTROLLER_WORKER_REMOTE_ADAPTER_V1, adapterRevision: "revision:7654321",
    enrollmentId: "enrollment:protected-remote", state: "enrolled", enrolledAt: at(1_000), revokedAt: null });
  const enrollmentState = new PrivateRemoteControllerWorkerEnrollmentStateV1(enrollment);
  c.advance(1_500);
  const connection = await realInstalledConnection(enrollment, c.now); t.after(connection.close);
  const build = (session: ServerNodeSession) => createPrivateRemoteControllerWorkerCompositionV1({ db: c.f.db,
    planner: c.planner, integrityKey: new Uint8Array(32).fill(61), tenantId: binding.tenantId,
    nodeId: binding.nodeId, workerId: enrollment.workerId, connectorProfileDigest: c.connectorProfileDigest,
    enrollmentState, supportedAdapterRevisions: [enrollment.adapterRevision], session, clock: c.now });
  const original = build(connection.session);
  assert.equal(isPrivateRemoteControllerWorkerCompositionV1(original), true);
  assert.equal(isPrivateRemoteControllerWorkerCompositionV1({ ...original }), false, "a structural copy is not installed authority");
  const capability = capturePrivateRemoteControllerWorkerQueueCapabilityV1(original);
  assert.equal(isPrivateRemoteControllerWorkerQueueCapabilityV1(capability), true);
  assert.deepEqual(Object.keys(capability).sort(), ["grantsExecutionAuthority", "materializer", "startsWork"]);
  assert.equal(capability.startsWork, false); assert.equal(capability.grantsExecutionAuthority, false);
  assert.equal(Object.isFrozen(capability), true); assert.equal(Object.isFrozen(capability.materializer), true);
  const ingress = capturePrivateRemoteControllerWorkerReceiptIngressCapabilityV1(original);
  assert.equal(isPrivateRemoteControllerWorkerReceiptIngressCapabilityV1(ingress), true);
  assert.deepEqual(Object.keys(ingress).sort(), ["accept", "grantsExecutionAuthority", "recover", "startsWork"]);
  assert.equal(ingress.startsWork, false); assert.equal(ingress.grantsExecutionAuthority, false);
  assert.throws(() => capturePrivateRemoteControllerWorkerReceiptIngressCapabilityV1(original), /unavailable/,
    "the installed receipt ingress cannot be replayed from one composition");
  assert.equal(connection.sends(), 0, "capturing custody neither sends nor starts remote work");
  const operatorInput = operatorConfigurationScenario("full");
  (operatorInput.settings.features as unknown as Record<string, boolean>).remoteControllerWorker = true;
  (operatorInput.trusted as unknown as { remoteControllerWorker: unknown }).remoteControllerWorker = capability;
  const operator = assemblePrivateAgentTaskOperatorConfiguration(operatorInput.settings, operatorInput.trusted);
  assert.equal(operator.configuration.coordinator.remoteControllerWorker, capability,
    "generic assembly retains the branded source-only queue capability, not its private composition");
  assert.equal(validatePrivateTaskStartupConfiguration(operator.configuration).remoteControllerWorker, capability);
  assert.equal(connection.sends(), 0, "assembly and validation remain non-executing");
  for (const forged of [
    { ...capability },
    { materializer: capability.materializer, startsWork: false, grantsExecutionAuthority: false },
    new Proxy(capability, {}),
  ]) {
    assert.equal(isPrivateRemoteControllerWorkerQueueCapabilityV1(forged), false);
    assert.throws(() => capturePrivateRemoteControllerWorkerQueueCapabilityV1(forged), /unavailable/);
  }
  for (const forged of [
    { ...ingress },
    { accept: ingress.accept, recover: ingress.recover, startsWork: false, grantsExecutionAuthority: false },
    new Proxy(ingress, {}),
  ]) assert.equal(isPrivateRemoteControllerWorkerReceiptIngressCapabilityV1(forged), false);
  assert.throws(() => Object.defineProperty(capability.materializer, "prepare", { value: async () => undefined }), /TypeError/);
  const prepared = await original.materializer.prepare(c.ref);
  assert.equal(prepared.startsWork, false); assert.equal(prepared.grantsExecutionAuthority, false);
  const sent = await original.materializer.transmit(c.ref, prepared);
  assert.equal(sent.kind, "transmitted");
  if (sent.kind !== "transmitted") throw new Error("expected transmission");
  const lostReceipt = await connection.deliverToNode();
  assert.match(lostReceipt, /controller\.worker\.delivery\.receipt/); assert.equal(connection.sends(), 1);
  c.advance(500);

  await connection.reconnect();
  await assert.rejects(ingress.recover("{}"), /unavailable/,
    "the old session cannot intake a receipt after replacement");
  const recovered = build(connection.session);
  await recovered.materializer.prepare(c.ref);
  const recoveredIngress = capturePrivateRemoteControllerWorkerReceiptIngressCapabilityV1(recovered);
  const raw = await connection.recovery(sent.transmission.queueId);
  const firstRecovery = await recoveredIngress.recover(raw) as { replayed: boolean; startsWork: boolean };
  assert.equal(firstRecovery.replayed, false); assert.equal(firstRecovery.startsWork, false);
  assert.equal(connection.sends(), 1, "receipt recovery never resends or starts the delivery");
  const replayRaw = await connection.recovery(sent.transmission.queueId);
  await assert.rejects(recoveredIngress.recover(replayRaw), /unavailable/,
    "the installed ingress burns after a recovered receipt rather than replaying it");
  assert.equal(connection.sends(), 1);

  const changed = JSON.parse(replayRaw); changed.body.scope.attemptId = "attempt:foreign";
  await assert.rejects(recoveredIngress.recover(JSON.stringify(changed)),
    /(unavailable|unauthenticated)/);
  assert.equal(connection.sends(), 1);

  enrollmentState.revoke(createRemoteWorkerEnrollmentV1({ workerId: enrollment.workerId,
    adapterId: enrollment.adapterId, adapterRevision: enrollment.adapterRevision,
    enrollmentId: enrollment.enrollmentId, state: "revoked", enrolledAt: enrollment.enrolledAt, revokedAt: at(10_500) }));
  await assert.rejects(recoveredIngress.recover(raw), /unavailable/,
    "current protected revocation fences even an exact historical receipt replay");

  const row = (await c.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_worker_delivery_receipts WHERE tenant_id=$1 AND job_id=$2",
  [c.ref.tenantId, c.ref.jobId])).rows[0];
  assert.deepEqual(row, { count: "1" }, "one canonical PostgreSQL receipt is authoritative");
});

test("the protected composition accepts an ordinary real-session receipt exactly once", async t => {
  const c = await canonical(); t.after(c.f.close); c.advance(1_500);
  const enrollment = createRemoteWorkerEnrollmentV1({ workerId: "worker:protected-remote",
    adapterId: CONTROLLER_WORKER_REMOTE_ADAPTER_V1, adapterRevision: "revision:7654321",
    enrollmentId: "enrollment:protected-remote", state: "enrolled", enrolledAt: at(1_000), revokedAt: null });
  const connection = await realInstalledConnection(enrollment, c.now); t.after(connection.close);
  const composition = createPrivateRemoteControllerWorkerCompositionV1({ db: c.f.db, planner: c.planner,
    integrityKey: new Uint8Array(32).fill(61), tenantId: binding.tenantId, nodeId: binding.nodeId,
    workerId: enrollment.workerId, connectorProfileDigest: c.connectorProfileDigest,
    enrollmentState: new PrivateRemoteControllerWorkerEnrollmentStateV1(enrollment),
    supportedAdapterRevisions: [enrollment.adapterRevision], session: connection.session, clock: c.now });
  const prepared = await composition.materializer.prepare(c.ref);
  const sent = await composition.materializer.transmit(c.ref, prepared);
  assert.equal(sent.kind, "transmitted");
  const ingress = capturePrivateRemoteControllerWorkerReceiptIngressCapabilityV1(composition);
  const rawReceipt = await connection.deliverToNode();
  const accepted = await ingress.accept(rawReceipt) as {
    replayed: boolean; startsWork: boolean; grantsExecutionAuthority: boolean;
  };
  assert.deepEqual({ replayed: accepted.replayed, startsWork: accepted.startsWork,
    grantsExecutionAuthority: accepted.grantsExecutionAuthority },
  { replayed: false, startsWork: false, grantsExecutionAuthority: false });
  await assert.rejects(ingress.accept(rawReceipt), /unavailable/, "an ingress cannot replay a receipt");
  const historical = await composition.materializer.transmit(c.ref, prepared);
  assert.equal(historical.kind, "already_recorded");
  assert.equal(connection.sends(), 1, "the recorded ordinary receipt suppresses every later send");
});

test("the private composition refuses revoked, foreign and structurally fake installation targets", async t => {
  const c = await canonical(); t.after(c.f.close); c.advance(1_500);
  const valid = createRemoteWorkerEnrollmentV1({ workerId: "worker:protected-remote",
    adapterId: CONTROLLER_WORKER_REMOTE_ADAPTER_V1, adapterRevision: "revision:7654321",
    enrollmentId: "enrollment:protected-remote", state: "enrolled", enrolledAt: at(1_000), revokedAt: null });
  const connection = await realInstalledConnection(valid, c.now); t.after(connection.close);
  const session = connection.session;
  const base = { db: c.f.db as DatabaseClient, planner: c.planner, integrityKey: new Uint8Array(32).fill(61),
    tenantId: binding.tenantId, nodeId: binding.nodeId, workerId: valid.workerId,
    connectorProfileDigest: c.connectorProfileDigest,
    enrollmentState: new PrivateRemoteControllerWorkerEnrollmentStateV1(valid),
    supportedAdapterRevisions: [valid.adapterRevision], session, clock: c.now };
  const revoked = createRemoteWorkerEnrollmentV1({ workerId: valid.workerId,
    adapterId: valid.adapterId, adapterRevision: valid.adapterRevision,
    enrollmentId: valid.enrollmentId, state: "revoked", enrolledAt: valid.enrolledAt, revokedAt: at(2_000) });
  await assert.rejects(Promise.resolve().then(() => new PrivateRemoteControllerWorkerEnrollmentStateV1(revoked)), /unavailable/);
  await assert.rejects(Promise.resolve().then(() => createPrivateRemoteControllerWorkerCompositionV1({ ...base,
    nodeId: "node:foreign" })), /unavailable/);
  await assert.rejects(Promise.resolve().then(() => createPrivateRemoteControllerWorkerCompositionV1({ ...base,
    session: {} as ServerNodeSession })), /unavailable/);
  const fakeDb = Object.freeze({ ...c.f.db }) as DatabaseClient;
  await assert.rejects(Promise.resolve().then(() => createPrivateRemoteControllerWorkerCompositionV1({ ...base,
    db: fakeDb })), /unavailable/, "a structural database copy is not protected storage authority");
  const structuralReceiver = {
    async query<T>() { return { rows: [] as T[] }; },
    async transaction<T>(work: (tx: typeof structuralReceiver) => Promise<T>) { return work(structuralReceiver); },
  };
  const genericAdaptedFake = adaptPglite(structuralReceiver);
  await assert.rejects(Promise.resolve().then(() => createPrivateRemoteControllerWorkerCompositionV1({ ...base,
    db: genericAdaptedFake })), /unavailable/,
  "the generic PGlite adapter cannot mint protected database authority for a structural fake");
  const genericBoundFake = boundPrivateDatabase({ async acquire() { return {
    async query<T>() { return { rows: [] as T[] }; }, release() {},
  }; }, async terminate() {} });
  t.after(genericBoundFake.close);
  await assert.rejects(Promise.resolve().then(() => createPrivateRemoteControllerWorkerCompositionV1({ ...base,
    db: genericBoundFake.client })), /unavailable/,
  "the generic bounded-driver factory cannot mint protected PostgreSQL authority for a structural fake");
  const fakePlanner = Object.freeze({ readInSession: c.planner.readInSession.bind(c.planner) }) as TaskExecutionPlanner;
  await assert.rejects(Promise.resolve().then(() => createPrivateRemoteControllerWorkerCompositionV1({ ...base,
    planner: fakePlanner })), /unavailable/, "a structural planner copy is not canonical planning authority");
  class ForgedEnrollmentState extends PrivateRemoteControllerWorkerEnrollmentStateV1 {
    override current() { return valid; }
  }
  const forged = new ForgedEnrollmentState(valid);
  forged.revoke(revoked);
  await assert.rejects(Promise.resolve().then(() => createPrivateRemoteControllerWorkerCompositionV1({ ...base,
    enrollmentState: forged })), /unavailable/, "a subclass cannot override the current revocation fence");
  const genuineBinding = session.controllerWorkerSessionBinding.bind(session);
  Object.defineProperty(session, "controllerWorkerSessionBinding", { configurable: true, value: genuineBinding });
  await assert.rejects(Promise.resolve().then(() => createPrivateRemoteControllerWorkerCompositionV1(base)), /unavailable/,
    "a real authenticated session with an own method override is not installed session authority");
});
