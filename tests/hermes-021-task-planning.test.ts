import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { TaskExecutionPlanner, nativeTaskTemplateSchema, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
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
import { startPgBossNativeTaskWorker, type PgBossNativeWorkerClient } from "../src/persistence/pg-boss-native-task-worker";
import { PG_BOSS_NATIVE_SUBMISSION, nativeTaskSubmissionId } from "../src/persistence/pg-boss-native-task-submission";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, enrollment, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { taskDraft } from "./helpers/web-task";

test("a Marvin Hermes 0.21 template creates a pinned text-review plan, not an older generic Hermes plan", async t => {
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
  const tooLongAuthority = { ...authority, maxDurationSeconds: 121, digest: "" };
  tooLongAuthority.digest = computeAuthorityDigest(tooLongAuthority);
  assert.throws(() => nativeTaskTemplateSchema.parse({ ...template, authority: tooLongAuthority }), /unsupported native task template/);
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(91),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "marvin-021-plan-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.schema === "control-room.task-execution-plan/v7");
  if (!saved || saved.schema !== "control-room.task-execution-plan/v7") throw new Error("missing Hermes 0.21 plan");
  assert.equal(saved.adapter, HERMES_021_MACOS_LOCAL_ADAPTER_V1);
  assert.equal(saved.connectorProfileDigest, template.connectorProfileDigest);
  assert.equal(saved.executionClass, "text_review");
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
  const assignmentOptions = await assignments.options(f.identity, binding.projectId, planned.receipt.jobId);
  assert.deepEqual(assignmentOptions.candidates, [{ nodeId: binding.nodeId, label: "Synthetic node", platform: "linux",
    workScope: "bounded_text_review" }], "the owner sees the restricted local Hermes scope before reserving it");
  assert.equal(assignmentOptions.startsWork, false);
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
  const replayedQueue = await hermesQueue.enqueueHermes021LocalTask(f.identity, binding.projectId, planned.receipt.jobId,
    planned.receipt.inputDigest, new AbortController().signal);
  assert.equal(replayedQueue.replayed, true);
  assert.equal(queuedReferences.length, 1);
  const localBinding = {
    localServiceId: "service:marvin-hermes", workerId: "worker:marvin", expectedVersion: "0.21.3" as const,
    sourceRevision: "00570550",
  };
  let deliveryNow = instant + 9000;
  const dispatcher = new Hermes021MacosDispatchPreparationV1(f.db, planner, localBinding,
  () => deliveryNow);
  const dispatch = await dispatcher.prepare({ tenantId: binding.tenantId, projectId: binding.projectId,
    jobId: planned.receipt.jobId, attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId,
    inputDigest: planned.receipt.inputDigest });
  assert.equal(dispatch.delivery.worker.adapterId, HERMES_021_MACOS_LOCAL_ADAPTER_V1);
  assert.equal(dispatch.delivery.identity.attemptId, assigned.receipt.attemptId);
  assert.equal(dispatch.route.kind, "local");
  assert.equal(dispatch.workflowId, saved.job.workflowId);

  // A construction-time policy must not be reused by the long-lived queue
  // executor. The execution composition derives a fresh one from dispatch.
  const localPolicy = { assertAdmitted() { throw new Error("stale_policy_must_not_be_used"); } };

  let launches = 0;
  const execution = { preparation: dispatcher, runs: new HarnessRunStoreV1(f.db, new Uint8Array(32).fill(25)),
    delivery: { db: f.db, integrityKey: new Uint8Array(32).fill(24),
    binding: localBinding, policy: localPolicy, terminalResultStorage: f.storage }, clock: () => deliveryNow };
  const results = { db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage: f.storage,
    storageClass: "local" as const, reservations: createInMemoryNeutralReservationPort() };
  const localExecutor = createHermes021LocalSubprocessQueueExecutorV1({ tenantId: binding.tenantId,
    execution,
    results,
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
  let queuedWorkerHandler!: Parameters<PgBossNativeWorkerClient["work"]>[2];
  let workerStopped = 0;
  const queue = { name: PG_BOSS_NATIVE_SUBMISSION.name, table: PG_BOSS_NATIVE_SUBMISSION.table, policy: "standard" as const,
    partition: false, retryLimit: 0, deadLetter: null, notify: false };
  const workerClient: PgBossNativeWorkerClient = {
    async getQueue() { return queue; },
    async work(name, _options, handler) { assert.equal(name, PG_BOSS_NATIVE_SUBMISSION.name); queuedWorkerHandler = handler; return "worker:marvin"; },
    async cancel() {},
    async offWork(_name, input) { assert.deepEqual(input, { id: "worker:marvin", wait: true }); workerStopped++; },
  };
  let composed: Awaited<ReturnType<typeof localExecutor.deliver>> | undefined;
  const worker = await startPgBossNativeTaskWorker(workerClient, { async deliver(reference, signal) {
    const target = await hermesQueue.locateQueuedHarnessDelivery(reference, signal);
    assert.equal(target.kind, "hermes-021-local");
    return deliverVerifiedHermes021LocalQueueTaskV1({ reference, signal, target, deliver: async (deliveryTarget, deliverySignal) => {
      composed = await localExecutor.deliver(deliveryTarget, deliverySignal);
    } });
  } });
  const reference = queuedReferences[0]!;
  const queueResult = await queuedWorkerHandler([{ id: nativeTaskSubmissionId(reference), name: PG_BOSS_NATIVE_SUBMISSION.name,
    data: reference, retryLimit: 0, retryCount: 0, state: "active", policy: "standard", deadLetter: null,
    signal: new AbortController().signal }]);
  assert.deepEqual(queueResult, { disposition: "delivered" }, "the real shared queue worker selects the local Hermes executor");
  await worker.close(); assert.equal(workerStopped, 1);
  assert.ok(composed);
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

  const completedEvents = await execution.runs.events(binding.tenantId, executed.registered.run.id);
  deliveryNow += 5_000;
  const restartedExecutor = createHermes021LocalSubprocessQueueExecutorV1({ tenantId: binding.tenantId,
    execution: { ...execution,
      preparation: new Hermes021MacosDispatchPreparationV1(f.db, planner, localBinding, () => deliveryNow),
      runs: new HarnessRunStoreV1(f.db, new Uint8Array(32).fill(25)) },
    results, assertAuthority: delivery => assert.equal(delivery.authorityDigest, saved.job.authority.digest),
    host: { async execute() { launches++; throw new Error("restart must never invoke Hermes"); } },
  });
  const recovered = await restartedExecutor.deliver(located, new AbortController().signal);
  assert.equal(recovered.execution.delivered.state, "recovered_terminal_result");
  assert.equal(recovered.execution.delivered.outcome?.kind, "completed");
  assert.equal(recovered.execution.lifecycle.length, 0,
    "restart recovery retrieves evidence without appending a second completion lifecycle");
  assert.equal(recovered.publication?.replayed, true,
    "restart recovery finishes through the existing durable result receipt");
  assert.equal(recovered.execution.prepared.delivery.deliveryDigest, executed.prepared.delivery.deliveryDigest,
    "delayed recovery retains the authenticated original packet instead of signing fresh issuance time");
  assert.equal(recovered.execution.delivered.receipt.receivedAt, executed.delivered.receipt.receivedAt);
  assert.equal(launches, 1, "restart recovery never invokes Marvin again");
  assert.deepEqual(await execution.runs.events(binding.tenantId, executed.registered.run.id), completedEvents,
    "the terminal harness history is immutable across restart recovery");

  const replay = await executeAssignedHermes021MacosTaskV1(localExecutor.execution, { tenantId: binding.tenantId,
    projectId: binding.projectId, jobId: planned.receipt.jobId, attemptId: assigned.receipt.attemptId,
    leaseId: assigned.receipt.leaseId, inputDigest: planned.receipt.inputDigest });
  assert.equal(replay.delivered.state, "recovered_terminal_result");
  assert.equal(replay.delivered.outcome?.kind, "completed");
  assert.equal(replay.registered.replayed, true);
  assert.equal(replay.lifecycle.length, 0);
  assert.equal(launches, 1);

  const reboundExecution = { ...restartedExecutor.execution,
    preparation: new Hermes021MacosDispatchPreparationV1(f.db, planner,
      { ...localBinding, workerId: "worker:different" }, () => deliveryNow) };
  await assert.rejects(() => executeAssignedHermes021MacosTaskV1(reboundExecution, {
    tenantId: binding.tenantId, projectId: binding.projectId, jobId: planned.receipt.jobId,
    attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId,
    inputDigest: planned.receipt.inputDigest }), /hermes_021_macos_dispatch_preparation_unavailable/);
  assert.equal(launches, 1, "a retained receipt cannot move the task to a different worker");

  // The runner performs the same canonical recheck immediately before launch.
  // Simulate a revocation after packaging but before the executor reaches its
  // local runner. The process must stop before it can create another run or
  // call Hermes.
  const originalPrepare = dispatcher.prepare.bind(dispatcher);
  dispatcher.prepare = async reference => {
    const prepared = await originalPrepare(reference);
    await f.db.query(`UPDATE control_leases SET state='released', payload=jsonb_set(payload,'{state}',to_jsonb('released'::text))
      WHERE tenant_id=$1 AND id=$2`, [binding.tenantId, assigned.receipt.leaseId]);
    return prepared;
  };
  await assert.rejects(() => executeAssignedHermes021MacosTaskV1(localExecutor.execution, { tenantId: binding.tenantId,
    projectId: binding.projectId, jobId: planned.receipt.jobId, attemptId: assigned.receipt.attemptId,
    leaseId: assigned.receipt.leaseId, inputDigest: planned.receipt.inputDigest }), /hermes_021_macos_dispatch_preparation_unavailable/);
  assert.equal(launches, 1, "a late revoke never reaches the local Hermes runner");

});
