import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator, validateTaskAssignmentRoutes } from "../src/web/v1/task-assignment-coordinator";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import { CONTROLLER_WORKER_REMOTE_ADAPTER_V1, CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
  CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1, CONTROLLER_WORKER_REMOTE_START_OPERATION_V1,
  createRemoteWorkerEnrollmentV1 } from "../src/harness/v1/remote-worker-delivery";
import { RemoteControllerWorkerMaterializerV1, type RemoteControllerWorkerResolvedTargetV1 } from "../src/harness/v1/remote-controller-worker-materializer";
import type { ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { deliverVerifiedRemoteControllerWorkerQueueTaskV1 } from "../src/web/v1/remote-controller-worker-queue-delivery";
import type { NativeTaskSubmission } from "../src/persistence/native-task-submission";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";

function receipt(delivery: ControllerWorkerDeliveryV1) {
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: delivery.deliveryId, deliveryDigest: delivery.deliveryDigest, workerId: delivery.worker.workerId,
    route: { kind: "remote" as const, workerId: delivery.worker.workerId }, receivedAt: at(9_000),
    disposition: "accepted" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  return Object.freeze({ ...material, receiptDigest: sha256Digest(material) });
}

function remoteTarget(state: "enrolled" | "revoked" = "enrolled") {
  const enrollment = createRemoteWorkerEnrollmentV1({ workerId: "worker:remote-reviewed", adapterId: "connector:remote-reviewed",
    adapterRevision: "revision:7654321", enrollmentId: "enrollment:remote-reviewed", state,
    enrolledAt: at(1_000), revokedAt: state === "revoked" ? at(8_000) : null });
  let dispatch: { body: { delivery: ControllerWorkerDeliveryV1 } } | undefined;
  let sends = 0;
  let nextReceipt: ReturnType<typeof receipt> | undefined;
  const session = {
    controllerWorkerDeliveryChannel() { return { nodeId: binding.nodeId }; },
    async stageControllerWorkerDelivery(work: (sign: (body: unknown, deadline: number) => unknown,
      current: { nodeId: string; assertCurrent(): void }) => Promise<unknown>) {
      await work((body: unknown) => { dispatch = { body: body as { delivery: ControllerWorkerDeliveryV1 } }; return {}; },
        { nodeId: binding.nodeId, assertCurrent() {} });
    },
    async sendPreparedControllerWorkerDelivery(work: (frame: { body: unknown }, current: { assertCurrent(): void }) => Promise<unknown>) {
      sends++; await work({ body: dispatch!.body }, { assertCurrent() {} });
    },
    async acceptControllerWorkerDeliveryReceipt(_raw: string | Uint8Array, work: (frame: { body: { receipt: ReturnType<typeof receipt> } },
      dispatchFrame: { body: { enrollmentDigest: string; delivery: ControllerWorkerDeliveryV1 } }, assertCurrent: () => void) => Promise<unknown>) {
      if (!dispatch || !nextReceipt) throw new Error("missing fixture dispatch");
      return work({ body: { receipt: nextReceipt } }, { body: { enrollmentDigest: enrollment.enrollmentDigest,
        delivery: dispatch.body.delivery } }, () => {});
    },
  };
  const value: RemoteControllerWorkerResolvedTargetV1 = Object.freeze({ nodeId: binding.nodeId,
    workerId: enrollment.workerId, adapterId: enrollment.adapterId, adapterRevision: enrollment.adapterRevision,
    enrollment, supportedAdapterRevisions: Object.freeze([enrollment.adapterRevision]), session: {
      workerId: enrollment.workerId, enrollmentDigest: enrollment.enrollmentDigest, session: session as never,
    } });
  return { value, sends: () => sends, setReceipt(value: ControllerWorkerDeliveryV1) { nextReceipt = receipt(value); } };
}

test("the controller materializes a leased v11 plan through its protected target and records one remote receipt", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:remote",
    allowedOperations: [CONTROLLER_WORKER_REMOTE_START_OPERATION_V1], credentialRefs: ["credential:remote"], filesystemRoots: [],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:remote-materializer", adapter: CONTROLLER_WORKER_REMOTE_ADAPTER_V1,
    authority, instructions: "Return bounded evidence only.", connectorProfileDigest: sha256Digest("remote-profile"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  let now = instant + 7_000;
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(41),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => now);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "remote-materializer-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const route = [{ nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: CONTROLLER_WORKER_REMOTE_CAPABILITY_V1, maxConcurrentTasks: 8, requiredScratchBytes: 0, leaseSeconds: 60 }] as const;
  assert.doesNotThrow(() => validateTaskAssignmentRoutes(route));
  const signals = new FleetSignalStore(f.db);
  const telemetry: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("remote-telemetry"),
    kind: "telemetry", source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 10 }, availableMemoryBytes: { quality: "observed", value: 1000 },
      availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } };
  const capability: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("remote-capability"),
    kind: "capability", source: "probe_runner", payload: { probeId: CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
      probeVersion: "1.0.0", outcome: "pass", reasonCode: "reported_only" } };
  await signals.ingestAuthenticated(telemetry, at(6_000), binding);
  await signals.ingestAuthenticated(capability, at(6_000), binding);
  const assignments = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => now + 1_000);
  const assigned = await assignments.assign(f.identity, binding.projectId, planned.receipt.jobId, binding.nodeId, planned.receipt.inputDigest);
  const current = remoteTarget();
  const resolver = { async resolve(input: { nodeId: string }) { assert.equal(input.nodeId, binding.nodeId); return current.value; } };
  const materializer = new RemoteControllerWorkerMaterializerV1(f.db, planner, resolver, new Uint8Array(32).fill(61), () => now);
  const ref = { tenantId: binding.tenantId, projectId: binding.projectId, jobId: planned.receipt.jobId,
    attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId, inputDigest: planned.receipt.inputDigest };
  const prepared = await materializer.prepare(ref);
  assert.equal(prepared.delivery.worker.workerId, "worker:remote-reviewed");
  assert.equal(prepared.delivery.worker.adapterId, "connector:remote-reviewed");
  assert.equal(prepared.route.kind, "remote");
  assert.equal(prepared.startsWork, false);
  assert.equal((await planner.read(planned.receipt.jobId))?.job.jobType, CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1);
  // The shared queue passes only a native locator. The additive remote
  // discriminator reconstructs a leased target; neither record carries a
  // worker, session, enrollment or credential.
  const submission: NativeTaskSubmission = { async enqueueInSession() {} };
  const queueCoordinator = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => now + 1_000,
    [], undefined, submission);
  const queueReference = { schema: "control-room.native-task-submission/v1" as const, tenantId: ref.tenantId,
    projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId,
    queueId: `native-queue:${sha256Digest({ tenantId: ref.tenantId, jobId: ref.jobId, attemptId: ref.attemptId }).slice(7)}`,
    inputDigest: ref.inputDigest, packetDigest: sha256Digest("remote-queue-packet") };
  const target = await queueCoordinator.locateQueuedRemoteControllerWorkerDelivery(queueReference, new AbortController().signal);
  assert.ok(target);
  const delivered = await deliverVerifiedRemoteControllerWorkerQueueTaskV1({ reference: queueReference,
    signal: new AbortController().signal, target: target!, materializer });
  assert.deepEqual(delivered, { disposition: "delivered" });
  assert.equal(current.sends(), 1);
  current.setReceipt(prepared.delivery);
  const recorded = await materializer.acceptReceipt(ref, prepared, "fixture-receipt", at(10_000));
  assert.equal(recorded.replayed, false);
  const again = await deliverVerifiedRemoteControllerWorkerQueueTaskV1({ reference: queueReference,
    signal: new AbortController().signal, target: target!, materializer });
  assert.deepEqual(again, { disposition: "delivered" });
  assert.equal(current.sends(), 1, "a recorded receipt blocks a second remote transmission");
  await materializer.assertCurrent(ref, prepared);

  const revoked = remoteTarget("revoked");
  const revokedResolver = { async resolve() { return revoked.value; } };
  const fenced = new RemoteControllerWorkerMaterializerV1(f.db, planner, revokedResolver, new Uint8Array(32).fill(61), () => now);
  await assert.rejects(fenced.prepare(ref), /remote_controller_worker_materializer_unavailable/,
    "a revoked protected target cannot materialize a new remote delivery");
  await assert.rejects(deliverVerifiedRemoteControllerWorkerQueueTaskV1({ reference: queueReference,
    signal: new AbortController().signal, target: target!, materializer: fenced }),
  /remote_controller_worker_materializer_unavailable/,
  "a revoked protected target refuses before a second send");
  assert.equal(current.sends(), 1);
});
