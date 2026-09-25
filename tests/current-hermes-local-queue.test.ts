import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { HERMES_LOCAL_ADAPTER_V1, HERMES_LOCAL_CAPABILITY_V1, HERMES_LOCAL_JOB_TYPE_V1,
  HERMES_LOCAL_START_OPERATION_V1 } from "../src/harness/hermes-local-v1";
import { HermesLocalDispatchPreparationV1 } from "../src/harness/hermes-local-v1";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { NativeApprovalPacketStore } from "../src/web/v1/native-approval-packet-store";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import type { NativeTaskSubmission } from "../src/persistence/native-task-submission";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";
import { binding, enrollment, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";

test("the current Hermes plan uses the existing approval queue and refuses a changed queue proof", async t => {
  const f = await ownerReviewFixture();
  t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = {
    projectId: binding.projectId, allowedExecutor: "executor:marvin",
    allowedOperations: [HERMES_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:marvin"], filesystemRoots: [],
    networkPolicy: "allowlist", allowedNetworkDestinations: [enrollment.canonicalDestination], effectPolicy: "approval_required",
    maxRisk: "low", maxDurationSeconds: 120, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "",
  };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = {
    id: "template:marvin-current-queue", adapter: HERMES_LOCAL_ADAPTER_V1, authority,
    instructions: "Return a bounded plain-text result.", connectorProfileDigest: sha256Digest("current-hermes-qualified-build"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile),
  };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(62),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints,
    localAdapterAdmission: { enabledAdapters: [HERMES_LOCAL_ADAPTER_V1] } }, () => instant + 7_000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "current-hermes-queue-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));

  const route = { nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: HERMES_LOCAL_CAPABILITY_V1, maxConcurrentTasks: 3, requiredScratchBytes: 0, leaseSeconds: 60 } as const;
  const signals = new FleetSignalStore(f.db);
  const nextSignalSequence = async (kind: "telemetry" | "capability", subject = "node") => {
    const row = await f.db.query<{ sequence: number | null }>(`SELECT max(signal_sequence)::int AS sequence
      FROM control_node_fleet_signals WHERE tenant_id=$1 AND node_id=$2 AND signal_kind=$3
        AND ($4='node' OR payload->'payload'->>'probeId'=$4)`,
    [binding.tenantId, binding.nodeId, kind, subject]);
    return (row.rows[0]?.sequence ?? 0) + 1;
  };
  const telemetry: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: await nextSignalSequence("telemetry"), observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("current-hermes-telemetry"),
    kind: "telemetry", source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 10 }, availableMemoryBytes: { quality: "observed", value: 1_000 },
      availableStorageBytes: { quality: "observed", value: 1_000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } };
  const capability: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: await nextSignalSequence("capability", HERMES_LOCAL_CAPABILITY_V1), observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("current-hermes-capability"),
    kind: "capability", source: "probe_runner", payload: { probeId: HERMES_LOCAL_CAPABILITY_V1,
      probeVersion: "1.0.0", outcome: "pass", reasonCode: "qualified_current_build" } };
  await signals.ingestAuthenticated(telemetry, at(6_000), binding);
  await signals.ingestAuthenticated(capability, at(6_000), binding);
  const assignments = new TaskAssignmentCoordinator(f.db, f.scope, planner, [route], () => instant + 8_000);
  const assigned = await assignments.assign(f.identity, binding.projectId, planned.receipt.jobId, binding.nodeId, planned.receipt.inputDigest);
  const references: Parameters<NativeTaskSubmission["enqueueInSession"]>[1][] = [];
  const submissions: NativeTaskSubmission = { async enqueueInSession(_tx, reference) { references.push(reference); } };
  const queuedCoordinator = new TaskAssignmentCoordinator(f.db, f.scope, planner, [route], () => instant + 8_000,
    [], new NativeApprovalPacketStore(new Uint8Array(32).fill(63), []), submissions);
  const queued = await queuedCoordinator.enqueueHermesLocalTask(f.identity, binding.projectId, planned.receipt.jobId,
    planned.receipt.inputDigest, new AbortController().signal);
  assert.equal(queued.replayed, false);
  assert.equal(references.length, 1);
  const target = await queuedCoordinator.locateApprovedHermesLocalQueueDelivery(references[0]!, new AbortController().signal);
  assert.equal(target.kind, "hermes-local");
  assert.equal(target.leaseId, assigned.receipt.leaseId);
  const preparation = new HermesLocalDispatchPreparationV1(f.db, planner, {
    workerId: authority.allowedExecutor, adapterRevision: "b50bb77e" }, () => instant + 8_000);
  const prepared = await preparation.prepare({ tenantId: binding.tenantId, projectId: binding.projectId,
    jobId: target.task.jobId, attemptId: target.task.attemptId, leaseId: target.leaseId, inputDigest: target.task.inputDigest });
  assert.equal(prepared.delivery.worker.adapterId, HERMES_LOCAL_ADAPTER_V1);
  assert.equal(prepared.delivery.connectorProfileDigest, template.connectorProfileDigest);
  await preparation.assertCurrent({ tenantId: binding.tenantId, projectId: binding.projectId,
    jobId: target.task.jobId, attemptId: target.task.attemptId, leaseId: target.leaseId, inputDigest: target.task.inputDigest }, prepared);
  const shared = await queuedCoordinator.locateQueuedHarnessDelivery(references[0]!, new AbortController().signal);
  assert.equal(shared.kind, "hermes-local");
  await assert.rejects(() => queuedCoordinator.locateApprovedHermesLocalQueueDelivery({ ...references[0]!, packetDigest: sha256Digest("changed") }, new AbortController().signal));
  assert.equal((await planner.read(planned.receipt.jobId))?.job.jobType, HERMES_LOCAL_JOB_TYPE_V1);
});
