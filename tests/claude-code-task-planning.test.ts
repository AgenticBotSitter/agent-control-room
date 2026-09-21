import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1,
  CLAUDE_CODE_LOCAL_CAPABILITY_V1, CLAUDE_CODE_LOCAL_JOB_TYPE_V1,
  CLAUDE_CODE_LOCAL_START_OPERATION_V1 } from "../src/harness/claude-code-v1";
import { TaskExecutionPlanner, nativeTaskTemplateSchema, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator, validateTaskAssignmentRoutes } from "../src/web/v1/task-assignment-coordinator";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import { ClaudeCodeLocalDispatchPreparationV1 } from "../src/harness/claude-code-v1/dispatch-preparation";
import { executeAssignedClaudeCodeLocalTaskV1 } from "../src/harness/claude-code-v1/assigned-task-execution";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { NativeApprovalPacketStore } from "../src/web/v1/native-approval-packet-store";
import type { NativeTaskSubmission } from "../src/persistence/native-task-submission";
import { deliverVerifiedClaudeCodeLocalQueueTaskV1 } from "../src/web/v1/claude-code-local-queue-delivery";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";
import { createPersistentNeutralReservationPort, createPersistentNeutralReservationStore } from "../src/artifacts/v1/neutral-reservation-port";
import type { ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";

class FinishedClaudeProcess {
  constructor(private readonly lines: string[]) {}
  acquire() {
    return { ready: Promise.resolve({
      readStdout: async () => {
        const line = this.lines.shift();
        return line === undefined ? undefined : new TextEncoder().encode(line);
      },
      readStderr: async () => undefined,
      closeStdin: async () => {}, terminate: async () => {},
      exited: Promise.resolve({ code: 0, signal: null }),
    }), close: async () => {} };
  }
}

function acceptedClaudeDelivery(packet: ControllerWorkerDeliveryV1, receivedAt: string) {
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: packet.deliveryId, deliveryDigest: packet.deliveryDigest, workerId: packet.worker.workerId,
    route: { kind: "local" as const, workerId: packet.worker.workerId }, receivedAt,
    disposition: "accepted" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  return Object.freeze({ ...material, receiptDigest: sha256Digest(material) });
}

test("a local Claude task can be saved and prepared as a signed local delivery without starting Claude", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:claude",
    allowedOperations: [CLAUDE_CODE_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:claude"], filesystemRoots: [],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:claude-local", adapter: CLAUDE_CODE_LOCAL_ADAPTER_V1, authority,
    instructions: "Return a bounded plain-text review only.", connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(74),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7_000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "claude-local-plan-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const replay = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  assert.equal(replay.replayed, true, "the same proposal produces one durable plan");
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.schema === "control-room.task-execution-plan/v9");
  if (!saved || saved.schema !== "control-room.task-execution-plan/v9") throw new Error("missing Claude plan");
  assert.equal(saved.adapter, CLAUDE_CODE_LOCAL_ADAPTER_V1);
  assert.equal(saved.connectorProfileDigest, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1);
  assert.equal(saved.executionClass, "text_review");
  assert.equal(saved.job.jobType, CLAUDE_CODE_LOCAL_JOB_TYPE_V1);
  assert.equal(saved.job.requiredCapability, CLAUDE_CODE_LOCAL_CAPABILITY_V1);
  assert.equal(planned.receipt.startsWork, false);
  assert.equal(planned.receipt.grantsExecutionAuthority, false);

  const route = [{ nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: CLAUDE_CODE_LOCAL_CAPABILITY_V1, maxConcurrentTasks: 3, requiredScratchBytes: 0, leaseSeconds: 60 }] as const;
  assert.doesNotThrow(() => validateTaskAssignmentRoutes(route),
    "the shared coordinator recognizes Claude's capability; private startup still keeps it unadmitted until separate proof and host composition exist");

  const signals = new FleetSignalStore(f.db);
  const telemetry: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("claude-telemetry"),
    kind: "telemetry", source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 10 }, availableMemoryBytes: { quality: "observed", value: 1000 },
      availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } };
  const capability: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("claude-capability"),
    kind: "capability", source: "probe_runner", payload: { probeId: CLAUDE_CODE_LOCAL_CAPABILITY_V1,
      probeVersion: "1.0.0", outcome: "pass", reasonCode: "reported_only" } };
  await signals.ingestAuthenticated(telemetry, at(6_000), binding);
  await signals.ingestAuthenticated(capability, at(6_000), binding);
  const assignments = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => instant + 8_000);
  const assigned = await assignments.assign(f.identity, binding.projectId, planned.receipt.jobId, binding.nodeId, planned.receipt.inputDigest);
  const queuedReferences: Parameters<NativeTaskSubmission["enqueueInSession"]>[1][] = [];
  const submissions: NativeTaskSubmission = { async enqueueInSession(_tx, reference) { queuedReferences.push(reference); } };
  const queuedCoordinator = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => instant + 8_000,
    [], new NativeApprovalPacketStore(new Uint8Array(32).fill(76), []), submissions);
  const queued = await queuedCoordinator.enqueueClaudeCodeLocalTask(f.identity, binding.projectId, planned.receipt.jobId,
    planned.receipt.inputDigest, new AbortController().signal);
  assert.equal(queued.replayed, false);
  assert.equal(queuedReferences.length, 1);
  const located = await queuedCoordinator.locateApprovedClaudeCodeLocalQueueDelivery(queuedReferences[0]!, new AbortController().signal);
  assert.equal(located.kind, "claude-code-local");
  assert.equal(located.leaseId, assigned.receipt.leaseId);
  assert.deepEqual(located.task, { projectId: binding.projectId, jobId: planned.receipt.jobId,
    attemptId: assigned.receipt.attemptId, inputDigest: planned.receipt.inputDigest });
  const standardPickup = await queuedCoordinator.locateQueuedHarnessDelivery(queuedReferences[0]!, new AbortController().signal);
  assert.equal(standardPickup.kind, "claude-code-local", "the shared queue recognizes the Claude route without using a second scheduler");
  let callbackCalls = 0;
  await deliverVerifiedClaudeCodeLocalQueueTaskV1({ reference: queuedReferences[0]!, target: located,
    signal: new AbortController().signal, deliver: async target => {
      callbackCalls++; assert.equal(target.startsWork, false); assert.equal(target.grantsExecutionAuthority, false);
    } });
  assert.equal(callbackCalls, 1, "the queue switch forwards only a verified locator; it does not acquire Claude itself");
  const replayedQueue = await queuedCoordinator.enqueueClaudeCodeLocalTask(f.identity, binding.projectId, planned.receipt.jobId,
    planned.receipt.inputDigest, new AbortController().signal);
  assert.equal(replayedQueue.replayed, true);
  assert.equal(queuedReferences.length, 1);
  const preparation = new ClaudeCodeLocalDispatchPreparationV1(f.db, planner,
    { workerId: "worker:claude-local", adapterRevision: "source-123" }, () => instant + 9_000);
  const dispatch = await preparation.prepare({ tenantId: binding.tenantId, projectId: binding.projectId,
    jobId: planned.receipt.jobId, attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId,
    inputDigest: planned.receipt.inputDigest });
  assert.equal(dispatch.delivery.worker.adapterId, CLAUDE_CODE_LOCAL_ADAPTER_V1);
  assert.equal(dispatch.delivery.identity.attemptId, assigned.receipt.attemptId);
  assert.equal(dispatch.route.kind, "local");
  assert.equal(dispatch.startsWork, false);
  assert.equal(dispatch.grantsExecutionAuthority, false);
  await preparation.assertCurrent({ tenantId: binding.tenantId, projectId: binding.projectId, jobId: planned.receipt.jobId,
    attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId, inputDigest: planned.receipt.inputDigest }, dispatch);

  const foreignProfile = { ...template, connectorProfileDigest: sha256Digest("foreign-claude-profile") };
  assert.throws(() => nativeTaskTemplateSchema.parse(foreignProfile), /unsupported native task template/);
});

test("a local Claude delivery publishes once, then a rebuilt executor recovers the protected result without reopening Claude", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:claude",
    allowedOperations: [CLAUDE_CODE_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:claude"], filesystemRoots: [],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:claude-recovery", adapter: CLAUDE_CODE_LOCAL_ADAPTER_V1, authority,
    instructions: "Return a bounded plain-text review only.", connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  let now = instant + 7_000;
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(79),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => now);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "claude-local-executor-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const route = [{ nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: CLAUDE_CODE_LOCAL_CAPABILITY_V1, maxConcurrentTasks: 3, requiredScratchBytes: 0, leaseSeconds: 60 }] as const;
  const signals = new FleetSignalStore(f.db);
  for (const signal of [
    { sequence: 1, kind: "telemetry" as const, source: "telemetry_port" as const,
      payload: { samplingIntervalSeconds: 30, cpuUtilizationPercent: { quality: "observed" as const, value: 10 },
        availableMemoryBytes: { quality: "observed" as const, value: 1000 }, availableStorageBytes: { quality: "observed" as const, value: 1000 },
        networkClass: "unmetered" as const, powerState: "ac" as const, thermalState: "nominal" as const } },
    { sequence: 1, kind: "capability" as const, source: "probe_runner" as const,
      payload: { probeId: CLAUDE_CODE_LOCAL_CAPABILITY_V1, probeVersion: "1.0.0", outcome: "pass" as const, reasonCode: "fixture" } },
  ] as const) {
    const envelope: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
      sequence: signal.sequence, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest(signal),
      kind: signal.kind, source: signal.source, payload: signal.payload };
    await signals.ingestAuthenticated(envelope, at(6_000), binding);
  }
  const assignments = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => now + 1_000);
  const assigned = await assignments.assign(f.identity, binding.projectId, planned.receipt.jobId, binding.nodeId, planned.receipt.inputDigest);
  const reference = { tenantId: binding.tenantId, projectId: binding.projectId, jobId: planned.receipt.jobId,
    attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId, inputDigest: planned.receipt.inputDigest };
  const worker = { workerId: "worker:claude-local", adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1, adapterRevision: "source-123" } as const;
  const preparation = () => new ClaudeCodeLocalDispatchPreparationV1(f.db, planner,
    { workerId: worker.workerId, adapterRevision: worker.adapterRevision }, () => now);
  const firstPrepared = await preparation().prepare(reference);
  await f.db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-local','1.0.0','control_room_native','disabled','v1',30)`,
  [CLAUDE_CODE_LOCAL_ADAPTER_V1, binding.tenantId]);
  const reservations = createPersistentNeutralReservationPort(createPersistentNeutralReservationStore());
  const results = { db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage: f.storage,
    storageClass: "local" as const, reservations };
  let acquisitions = 0;
  const receiptPort = { async receive(packet: ControllerWorkerDeliveryV1) { return acceptedClaudeDelivery(packet, at(7_000)); } };
  const execution = (acquire: () => ReturnType<FinishedClaudeProcess["acquire"]>) => ({ preparation: preparation(),
    runs: new HarnessRunStoreV1(f.db, f.harnessKey), delivery: { db: f.db, integrityKey: new Uint8Array(32).fill(91),
      binding: { ...worker, authorityDigest: firstPrepared.delivery.authorityDigest, acceptanceProfileId: f.profile.id,
        acceptanceProfileDigest: sha256Digest(f.profile) }, authority: { currentAdmissionDigest: () => firstPrepared.delivery.authorityDigest,
        assertCurrent: () => {} }, receiptPort, acquire, cleanupMs: 500, clock: () => now },
    results, protectedStorage: f.storage, assertAuthority: () => {}, clock: () => now });
  const sessionId = "00000000-0000-4000-8000-000000000777";
  const terminal = JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId,
    result: "One local Claude result for owner review.", usage: {} });
  const first = await executeAssignedClaudeCodeLocalTaskV1(execution(() => {
    acquisitions++; return new FinishedClaudeProcess([
      `${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`, `${terminal}\n`,
    ]).acquire();
  }), reference, new AbortController().signal);
  assert.equal(first.state, "published_pending_review");
  assert.equal(first.publication?.replayed, false);
  assert.equal(acquisitions, 1);
  assert.equal(first.registered.replayed, false);
  assert.equal((await f.db.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2", [binding.tenantId, firstPrepared.delivery.identity.runId])).rows.length, 1);
  now += 1_000;
  const restart = await executeAssignedClaudeCodeLocalTaskV1(execution(() => {
    acquisitions++; throw new Error("restart_must_not_acquire_claude");
  }), reference, new AbortController().signal);
  assert.equal(restart.state, "recovered_pending_review");
  assert.equal(restart.publication?.replayed, true);
  assert.equal(restart.registered.replayed, true);
  assert.equal(acquisitions, 1, "recovery reuses protected terminal evidence and never opens another Claude session");
  assert.equal((await f.db.query("SELECT run_id FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2",
    [binding.tenantId, firstPrepared.delivery.identity.runId])).rows.length, 1);
});

test("one project can offer reviewed local workers without silently choosing one", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const make = (id: string, executor: string): NativeTaskTemplate => {
    const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: executor,
      allowedOperations: [CLAUDE_CODE_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:claude"], filesystemRoots: [],
      networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
      maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
    authority.digest = computeAuthorityDigest(authority);
    return { id, adapter: CLAUDE_CODE_LOCAL_ADAPTER_V1, authority, instructions: "Return bounded review text.",
      connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, acceptanceProfileId: f.profile.id,
      acceptanceProfileDigest: sha256Digest(f.profile) };
  };
  const first = make("template:claude-one", "executor:claude-one");
  const second = make("template:claude-two", "executor:claude-two");
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template: first, additionalTemplates: [second],
    integrityKey: new Uint8Array(32).fill(75), reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7_000);
  assert.deepEqual(planner.templatesForProject(binding.projectId).map(value => value.id), [first.id, second.id]);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "claude-template-choice-source");
  await assert.rejects(() => planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft)), /conflict/);
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft), second.id);
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.templateDigest === sha256Digest(second));
  assert.equal(await planner.readPreparedWorker(f.identity, binding.projectId, source.receipt.jobId), null,
    "the source proposal is not presented as prepared for a worker");
  assert.equal(await planner.readPreparedWorker(f.identity, binding.projectId, planned.receipt.jobId), "claude",
    "the prepared task exposes only a safe display category");
  await assert.rejects(() => planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft), first.id), /conflict/,
    "a later choice cannot replace the already saved task plan");
});
