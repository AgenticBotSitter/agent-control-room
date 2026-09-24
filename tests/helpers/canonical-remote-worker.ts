import { generateKeyPairSync } from "node:crypto";
import { ServerNodeSession } from "../../src/node-control/server-node-session";
import { FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator, signNodeFrame } from "../../src/node-protocol/v1";
import { CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1 } from
  "../../src/harness/v1/controller-worker-node-delivery";
import { ControllerWorkerDeliveryIntakeHandlerV1 } from "../../src/node-bridge/controller-worker-delivery-handler";
import { PortableNodeBridge } from "../../src/node-bridge/bridge";
import { SqliteBridgeJournal } from "../../src/node-bridge/journal";
import { computeAuthorityDigest, sha256Digest } from "../../src/security";
import { CONTROLLER_WORKER_REMOTE_ADAPTER_V1, CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
  CONTROLLER_WORKER_REMOTE_START_OPERATION_V1, createRemoteWorkerEnrollmentV1 } from
  "../../src/harness/v1/remote-worker-delivery";
import { createRemoteWorkerEnrollmentInStoreV1 } from "../../src/harness/v1/remote-worker-enrollment-store";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator } from "../../src/web/v1/task-assignment-coordinator";
import { FleetSignalStore } from "../../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../../src/node-fleet/v1/schemas";
import { binding, instant } from "../hermes-native-fixture";
import { at } from "../native-task-fixture";
import { ownerReviewFixture } from "./web-owner-review";
import { taskDraft } from "./web-task";

export const canonicalCapabilityDigest = sha256Digest("protected-remote-capabilities");
export const canonicalReleaseBindingDigest = sha256Digest("protected-remote-release");

export async function realInstalledConnection(enrollment: ReturnType<typeof createRemoteWorkerEnrollmentV1>, clock: () => number) {
  const serverKeys = generateKeyPairSync("ed25519"), nodeKeys = generateKeyPairSync("ed25519");
  const serverSpki = serverKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const nodeSpki = nodeKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const journal = new SqliteBridgeJournal(":memory:"), toNode: string[] = [], toServer: string[] = [];
  const handler = new ControllerWorkerDeliveryIntakeHandlerV1({ workerId: enrollment.workerId,
    adapterId: enrollment.adapterId, adapterRevision: enrollment.adapterRevision,
    enrollmentDigest: enrollment.enrollmentDigest }, journal, clock);
  const bridge = new PortableNodeBridge({ tenantId: binding.tenantId, nodeId: binding.nodeId,
    keyId: "key:test", features: [CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1] }, journal,
  { async sign(frame) { return signNodeFrame(frame, nodeKeys.privateKey); } },
  new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", publicKeySpki: serverSpki,
    state: "active", principalState: "active", validFrom: at(1_000) }; } }, journal,
  new FixedWindowProtocolRateLimiter(100, 60)), undefined, undefined, undefined, undefined, undefined, handler);
  const createSession = () => new ServerNodeSession({ tenantId: binding.tenantId, nodeId: binding.nodeId,
    nodeKeyId: "key:test", serverId: "server:control-room", serverKeyId: "server-key:control-room",
    serverPublicKeySpki: serverSpki, transportIdentity: "transport:protected-remote",
    features: [CONTROLLER_WORKER_NODE_DELIVERY_FEATURE_V1, CONTROLLER_WORKER_NODE_RECOVERY_FEATURE_V1],
    maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30 }, {
    clock, authentication: new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519",
      publicKeySpki: nodeSpki, state: "active", principalState: "active", validFrom: at(1_000) }; } },
    { async consume() { return "accepted" as const; } }, new FixedWindowProtocolRateLimiter(100, 60)),
    async sign(frame) { return signNodeFrame(frame, serverKeys.privateKey); }, async send(raw) { toNode.push(raw); },
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
    get session() { return session; }, sends: () => deliverySends,
    takeDispatch() { const raw = toNode.shift(); if (!raw) throw new Error("missing dispatch"); deliverySends++; return raw; },
    async receiveDispatch(raw: string) {
      await bridge.receive(raw, new Date(clock()).toISOString());
      const receiptRaw = toServer.shift(); if (!receiptRaw) throw new Error("missing receipt"); return receiptRaw;
    },
    async deliverToNode() { return this.receiveDispatch(this.takeDispatch()); },
    async reconnect() { session.disconnect(); await bridge.disconnected(); toNode.length = 0; toServer.length = 0;
      session = createSession(); await pumpHandshake(); },
    async recovery(queueId: string) { await bridge.recoverControllerWorkerReceipt(queueId, new Date(clock()).toISOString());
      const raw = toServer.shift(); if (!raw) throw new Error("missing recovery receipt"); return raw; },
    async close() { session.disconnect(); await bridge.close(); handler.close(); journal.close(); },
  };
}

export async function canonicalRemoteWorkerFixture() {
  const f = await ownerReviewFixture(undefined, "A useful private result.", { exactRepositorySimulation: true });
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId,
    allowedExecutor: "executor:protected-remote", allowedOperations: [CONTROLLER_WORKER_REMOTE_START_OPERATION_V1],
    credentialRefs: ["credential:protected-remote"], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [],
    effectPolicy: "approval_required", maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const connectorProfileDigest = sha256Digest("protected-remote-profile");
  const template: NativeTaskTemplate = { id: "template:protected-remote", adapter: CONTROLLER_WORKER_REMOTE_ADAPTER_V1, authority,
    instructions: "Return bounded evidence only.", connectorProfileDigest, acceptanceProfileId: f.profile.id,
    acceptanceProfileDigest: sha256Digest(f.profile) };
  let now = instant + 7_000;
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(41),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => now);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "protected-remote-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const route = [{ nodeId: binding.nodeId, executorId: authority.allowedExecutor, capabilityProbeId: CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
    maxConcurrentTasks: 8, requiredScratchBytes: 0, leaseSeconds: 60 }] as const;
  const signals = new FleetSignalStore(f.db);
  for (const signal of [{ kind: "telemetry", source: "telemetry_port", fingerprint: sha256Digest("remote-telemetry"),
    payload: { samplingIntervalSeconds: 30, cpuUtilizationPercent: { quality: "observed", value: 10 }, availableMemoryBytes: { quality: "observed", value: 1000 }, availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } },
  { kind: "capability", source: "probe_runner", fingerprint: sha256Digest("remote-capability"), payload: { probeId: CONTROLLER_WORKER_REMOTE_CAPABILITY_V1, probeVersion: "1.0.0", outcome: "pass", reasonCode: "reported_only" } }] as const)
    await signals.ingestAuthenticated({ schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
      sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", ...signal } as FleetSignalEnvelope, at(6_000), binding);
  const assignments = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => now + 1_000);
  const assigned = await assignments.assign(f.identity, binding.projectId, planned.receipt.jobId, binding.nodeId, planned.receipt.inputDigest);
  return { f, planner, connectorProfileDigest, now: () => now, advance(ms: number) { now += ms; },
    ref: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: planned.receipt.jobId, attemptId: assigned.receipt.attemptId,
      leaseId: assigned.receipt.leaseId, inputDigest: planned.receipt.inputDigest } };
}

export async function enrollCanonicalRemoteWorker(c: Awaited<ReturnType<typeof canonicalRemoteWorkerFixture>>,
  enrollment: ReturnType<typeof createRemoteWorkerEnrollmentV1>) {
  await c.f.db.transaction(tx => createRemoteWorkerEnrollmentInStoreV1(tx, new Uint8Array(32).fill(61), {
    tenantId: binding.tenantId, nodeId: binding.nodeId, nodeKeyId: "key:test", enrollment,
    capabilityDigest: canonicalCapabilityDigest, releaseBindingDigest: canonicalReleaseBindingDigest, now: new Date(c.now()).toISOString() }));
}
