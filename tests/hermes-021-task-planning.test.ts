import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
  HERMES_021_MACOS_LOCAL_JOB_TYPE_V1, HERMES_021_MACOS_LOCAL_START_OPERATION_V1,
  HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1, Hermes021MacosDispatchPreparationV1,
  executeAssignedHermes021MacosTaskV1 } from "../src/harness/hermes-021-v1";
import { createInMemoryNeutralReservationPort } from "../src/artifacts/v1/neutral-reservation-port";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { NativeApprovalPacketStore } from "../src/web/v1/native-approval-packet-store";
import type { NativeTaskSubmission } from "../src/persistence/native-task-submission";
import { deliverVerifiedHermes021LocalQueueTaskV1 } from "../src/web/v1/hermes-021-local-queue-delivery";
import { createHermes021LocalSubprocessQueueExecutorV1 } from "../src/web/v1/hermes-021-local-subprocess-executor";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, enrollment, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { taskDraft } from "./helpers/web-task";

test("a Marvin Hermes 0.21 template creates a pinned v5 plan, not an older generic Hermes plan", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  // The durable publisher verifies the admitted run's adapter against the
  // installation registry. A real installer creates this neutral adapter
  // record before enabling a worker; this disposable fixture does the same.
  await f.db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'hermes-021-macos-local','1.0.0','control_room_native','disabled','v1',30)`,
  [HERMES_021_MACOS_LOCAL_ADAPTER_V1, binding.tenantId]);
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
  // Hermes 0.21 uses its own canonical packet at pickup.  It must still use
  // the existing HMAC-protected pg-boss submission channel, rather than a
  // second local scheduler or a browser-owned task handoff.
  const queuedReferences: Parameters<NativeTaskSubmission["enqueueInSession"]>[1][] = [];
  const submissions: NativeTaskSubmission = { async enqueueInSession(_tx, reference) { queuedReferences.push(reference); } };
  const hermesQueue = new TaskAssignmentCoordinator(f.db, f.scope, planner, [route], () => instant + 8000,
    [], new NativeApprovalPacketStore(new Uint8Array(32).fill(92), []), submissions);
  const queued = await hermesQueue.enqueueHermes021LocalTask(f.identity, binding.projectId, planned.receipt.jobId,
    planned.receipt.inputDigest, new AbortController().signal);
  assert.equal(queued.replayed, false);
  assert.equal(queuedReferences.length, 1);
  assert.equal(queuedReferences[0]?.packetDigest, queued.packetDigest);
  assert.equal(queuedReferences[0]?.jobId, planned.receipt.jobId);
  const located = await hermesQueue.locateApprovedHermes021LocalQueueDelivery(queuedReferences[0]!, new AbortController().signal);
  assert.equal(located.kind, "hermes-021-local");
  assert.equal(located.leaseId, assigned.receipt.leaseId);
  assert.deepEqual(located.task, { projectId: binding.projectId, jobId: planned.receipt.jobId,
    attemptId: assigned.receipt.attemptId, inputDigest: planned.receipt.inputDigest });
  const standardPickup = await hermesQueue.locateQueuedHarnessDelivery(queuedReferences[0]!, new AbortController().signal);
  assert.equal(standardPickup.kind, "hermes-021-local", "the shared queue dispatcher selects Marvin's local route");
  let queueExecutorCalls = 0;
  await deliverVerifiedHermes021LocalQueueTaskV1({ reference: queuedReferences[0]!, signal: new AbortController().signal,
    target: standardPickup, async deliver(target) {
      queueExecutorCalls++;
      assert.equal(target.kind, "hermes-021-local");
      assert.equal(target.task.jobId, planned.receipt.jobId);
    } });
  assert.equal(queueExecutorCalls, 1, "only the explicit local executor receives the verified queue pickup");
  const replayedQueue = await hermesQueue.enqueueHermes021LocalTask(f.identity, binding.projectId, planned.receipt.jobId,
    planned.receipt.inputDigest, new AbortController().signal);
  assert.equal(replayedQueue.replayed, true);
  assert.equal(queuedReferences.length, 1);
  const dispatcher = new Hermes021MacosDispatchPreparationV1(f.db, planner, {
    localServiceId: "service:marvin-hermes", workerId: "worker:marvin", expectedVersion: "0.21.3", sourceRevision: "00570550" },
  () => instant + 9000);
  const dispatch = await dispatcher.prepare({ tenantId: binding.tenantId, projectId: binding.projectId,
    jobId: planned.receipt.jobId, attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId,
    inputDigest: planned.receipt.inputDigest });
  assert.equal(dispatch.delivery.worker.adapterId, HERMES_021_MACOS_LOCAL_ADAPTER_V1);
  assert.equal(dispatch.delivery.identity.attemptId, assigned.receipt.attemptId);
  assert.equal(dispatch.route.kind, "local");
  assert.equal(dispatch.workflowId, saved.job.workflowId);

  let launches = 0;
  const execution = { preparation: dispatcher, runs: new HarnessRunStoreV1(f.db, new Uint8Array(32).fill(25)),
    delivery: { db: f.db, integrityKey: new Uint8Array(32).fill(24),
    binding: { localServiceId: "service:marvin-hermes", workerId: "worker:marvin", expectedVersion: "0.21.3" as const,
      sourceRevision: "00570550" }, policy: { assertAdmitted() {} } }, clock: () => instant + 9000 };
  const localExecutor = createHermes021LocalSubprocessQueueExecutorV1({ tenantId: binding.tenantId,
    execution,
    results: { db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage: f.storage,
      storageClass: "local", reservations: createInMemoryNeutralReservationPort() },
    assertAuthority: delivery => {
      assert.equal(delivery.identity.jobId, planned.receipt.jobId);
      assert.equal(delivery.authorityDigest, saved.job.authority.digest);
    },
    host: { async execute(input) {
      launches++;
      await input.onLine(JSON.stringify({ type: "result", session_id: "session:marvin", exit_code: 0, text: "completed", tokens: {
        input: 1, output: 1, total: 2, cache_read: 0, cache_write: 0 }, duration_ms: 3, timestamp: instant + 9000 }));
    } },
  });
  const composed = await localExecutor.deliver(standardPickup, new AbortController().signal);
  const executed = composed.execution;
  assert.equal(executed.delivered.state, "completed_delivery");
  assert.equal(executed.delivered.outcome?.kind, "completed");
  assert.ok(composed.publication);
  assert.equal(composed.publication?.replayed, false);
  assert.equal(composed.publication?.target.acceptanceProfileId, f.profile.id);
  assert.equal(executed.registered.replayed, false);
  assert.equal(executed.registered.run.connectorProfileDigest, HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1);
  assert.equal(executed.registered.run.authorityDigest, saved.job.authority.digest);
  assert.equal(launches, 1);
  assert.deepEqual(executed.lifecycle.map(event => event.payload.category === "lifecycle" ? event.payload.state : event.payload.category),
    ["starting", "running", "usage", "succeeded"]);
  assert.equal((await execution.runs.get(binding.tenantId, executed.registered.run.id))?.state, "succeeded");

  const replay = await executeAssignedHermes021MacosTaskV1(localExecutor.execution, { tenantId: binding.tenantId,
    projectId: binding.projectId, jobId: planned.receipt.jobId, attemptId: assigned.receipt.attemptId,
    leaseId: assigned.receipt.leaseId, inputDigest: planned.receipt.inputDigest });
  assert.equal(replay.delivered.state, "already_delivered");
  assert.equal(replay.registered.replayed, true);
  assert.equal(replay.lifecycle.length, 0);
  assert.equal(launches, 1);

});
