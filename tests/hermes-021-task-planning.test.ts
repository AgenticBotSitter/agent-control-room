import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
  HERMES_021_MACOS_LOCAL_JOB_TYPE_V1, HERMES_021_MACOS_LOCAL_START_OPERATION_V1,
  HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1, Hermes021MacosDispatchPreparationV1 } from "../src/harness/hermes-021-v1";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, enrollment, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { taskDraft } from "./helpers/web-task";

test("a Marvin Hermes 0.21 template creates a pinned v5 plan, not an older generic Hermes plan", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:marvin",
    allowedOperations: [HERMES_021_MACOS_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:marvin"], filesystemRoots: [],
    networkPolicy: "allowlist", allowedNetworkDestinations: [enrollment.canonicalDestination], effectPolicy: "approval_required",
    maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:marvin-021", adapter: HERMES_021_MACOS_LOCAL_ADAPTER_V1, authority,
    instructions: "Return a bounded plain-text result.", connectorProfileDigest: HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1,
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(91),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "marvin-021-plan-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.schema === "control-room.task-execution-plan/v5");
  if (!saved || saved.schema !== "control-room.task-execution-plan/v5") throw new Error("missing Hermes 0.21 plan");
  assert.equal(saved.adapter, HERMES_021_MACOS_LOCAL_ADAPTER_V1);
  assert.equal(saved.connectorProfileDigest, template.connectorProfileDigest);
  assert.equal(saved.job.jobType, HERMES_021_MACOS_LOCAL_JOB_TYPE_V1);
  assert.equal(saved.job.requiredCapability, HERMES_021_MACOS_LOCAL_CAPABILITY_V1);
  assert.notEqual(saved.schema, "control-room.task-execution-plan/v1");

  const route = { nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: HERMES_021_MACOS_LOCAL_CAPABILITY_V1, maxConcurrentTasks: 2,
    requiredScratchBytes: 100, leaseSeconds: 60 } as const;
  const signals = new FleetSignalStore(f.db);
  const nextSignalSequence = async (kind: "telemetry" | "capability", subject = "node") => {
    const row = await f.db.query<{ sequence: number | null }>(`SELECT max(signal_sequence)::int AS sequence
      FROM control_node_fleet_signals WHERE tenant_id=$1 AND node_id=$2 AND signal_kind=$3
        AND ($4='node' OR payload->'payload'->>'probeId'=$4)`,
    [binding.tenantId, binding.nodeId, kind, subject]);
    return (row.rows[0]?.sequence ?? 0) + 1;
  };
  const telemetry: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: await nextSignalSequence("telemetry"), observedAt: at(6000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("marvin-telemetry"),
    kind: "telemetry", source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 10 }, availableMemoryBytes: { quality: "observed", value: 1000 },
      availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } };
  const capability: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: await nextSignalSequence("capability", HERMES_021_MACOS_LOCAL_CAPABILITY_V1), observedAt: at(6000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("marvin-capability"),
    kind: "capability", source: "probe_runner", payload: { probeId: HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
      probeVersion: "1.0.0", outcome: "pass", reasonCode: "reported_only" } };
  await signals.ingestAuthenticated(telemetry, at(6000), binding);
  await signals.ingestAuthenticated(capability, at(6000), binding);
  const assignments = new TaskAssignmentCoordinator(f.db, f.scope, planner, [route], () => instant + 8000);
  const assigned = await assignments.assign(f.identity, binding.projectId, planned.receipt.jobId, binding.nodeId, planned.receipt.inputDigest);
  assert.equal(assigned.replayed, false);
  assert.equal(assigned.receipt.jobId, planned.receipt.jobId);
  const dispatcher = new Hermes021MacosDispatchPreparationV1(f.db, planner, {
    localServiceId: "service:marvin-hermes", workerId: "worker:marvin", expectedVersion: "0.21.3", sourceRevision: "00570550" },
  () => instant + 9000);
  const dispatch = await dispatcher.prepare({ tenantId: binding.tenantId, projectId: binding.projectId,
    jobId: planned.receipt.jobId, attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId,
    inputDigest: planned.receipt.inputDigest });
  assert.equal(dispatch.delivery.worker.adapterId, HERMES_021_MACOS_LOCAL_ADAPTER_V1);
  assert.equal(dispatch.delivery.identity.attemptId, assigned.receipt.attemptId);
  assert.equal(dispatch.route.kind, "local");
});
