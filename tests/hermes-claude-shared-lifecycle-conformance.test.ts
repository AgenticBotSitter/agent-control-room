import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { WebTaskService } from "../src/web/v1/task-service";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import { NativeApprovalPacketStore } from "../src/web/v1/native-approval-packet-store";
import type { NativeTaskSubmission } from "../src/persistence/native-task-submission";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { createInMemoryNeutralReservationPort } from "../src/artifacts/v1/neutral-reservation-port";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
  HERMES_021_MACOS_LOCAL_START_OPERATION_V1, HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1,
  Hermes021MacosDispatchPreparationV1, executeAssignedHermes021MacosTaskV1 } from "../src/harness/hermes-021-v1";
import { createHermes021LocalSubprocessQueueExecutorV1 } from "../src/web/v1/hermes-021-local-subprocess-executor";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1, CLAUDE_CODE_LOCAL_CAPABILITY_V1,
  CLAUDE_CODE_LOCAL_START_OPERATION_V1, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
  ClaudeCodeLocalDispatchPreparationV1, executeAssignedClaudeCodeLocalTaskV1 } from "../src/harness/claude-code-v1";
import { createClaudeCodeLocalQueueExecutorV1 } from "../src/web/v1/claude-code-local-executor";
import { createPersistentNeutralReservationPort, createPersistentNeutralReservationStore } from "../src/artifacts/v1/neutral-reservation-port";
import { durableResultReceiptSchemaV1 } from "../src/artifacts/v1/durable-result-receipt";
import { durableResultReviewPlanSchemaV1, durableReviewTargetV1 } from "../src/completion-gate/v1/durable-result-review-plan";
import { DurableResultReviewSubmissionServiceV1 } from "../src/completion-gate/v1/durable-result-review-submission";
import { DurableLocalResultInspectionServiceV1 } from "../src/completion-gate/v1/durable-local-result-inspection";
import { NativeResultVerificationService, type AutomaticDocumentScenario } from "../src/completion-gate/v1/native-result-verification";
import { NativeTaskCompletionService } from "../src/persistence/native-task-completion";
import type { ControllerWorkerDeliveryPortV1, ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding, enrollment, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { taskDraft } from "./helpers/web-task";

class FinishedClaudeProcess {
  constructor(private readonly lines: string[]) {}
  acquire() { return { ready: Promise.resolve({
    writeStdin: async () => {}, readStdout: async () => {
      const line = this.lines.shift(); return line === undefined ? undefined : new TextEncoder().encode(line);
    }, readStderr: async () => undefined, closeStdin: async () => {}, terminate: async () => {},
    exited: Promise.resolve({ code: 0, signal: null }),
  }), close: async () => {} }; }
}

function acceptedClaudeReceipt(packet: ControllerWorkerDeliveryV1, receivedAt: string) {
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: packet.deliveryId, deliveryDigest: packet.deliveryDigest, workerId: packet.worker.workerId,
    route: { kind: "local" as const, workerId: packet.worker.workerId }, receivedAt,
    disposition: "accepted" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  return Object.freeze({ ...material, receiptDigest: sha256Digest(material) });
}

/**
 * Disposable cross-adapter conformance proof.  The only executable ports are
 * inline fakes; there is no installed Hermes/Claude process or queue service.
 * Both adapters nevertheless use the real controller receipt store, ordinary
 * harness-run store, durable result publisher, and owner-review gate in one DB.
 */
test("Hermes and Claude share one durable lifecycle without cross-route recovery effects", async t => {
  const f = await ownerReviewFixture(undefined, "# Result\nA useful shared local review result.\n# Evidence\nFixture evidence is explicit.\n"); t.after(f.close);
  await f.db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'fixture','1.0.0','control_room_native','disabled','v1',30),
          ($3,$2,'fixture','1.0.0','control_room_native','disabled','v1',30)`,
  [HERMES_021_MACOS_LOCAL_ADAPTER_V1, binding.tenantId, CLAUDE_CODE_LOCAL_ADAPTER_V1]);
  let now = instant + 7_000;
  const durableInspection = new DurableLocalResultInspectionServiceV1(f.db, {
    integrityKey: f.resultKey, reviewIntegrityKey: f.reviewKey, harnessIntegrityKey: f.harnessKey,
    deliveryIntegrityKeys: { hermes: new Uint8Array(32).fill(65), claude: new Uint8Array(32).fill(66) },
    checkpoints: f.checkpoints, storageClass: "local", storage: f.storage,
  });
  const makeTemplate = (id: string, adapter: string, executor: string, operation: string, profile: string): NativeTaskTemplate => {
    const hermes = adapter === HERMES_021_MACOS_LOCAL_ADAPTER_V1;
    const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: executor,
      allowedOperations: [operation], credentialRefs: ["credential:fixture"], filesystemRoots: [], networkPolicy: hermes ? "allowlist" : "none",
      allowedNetworkDestinations: hermes ? [enrollment.canonicalDestination] : [], effectPolicy: "approval_required", maxRisk: "low", maxDurationSeconds: 60,
      maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
    authority.digest = computeAuthorityDigest(authority);
    return { id, adapter, authority, instructions: "Return bounded text only.", connectorProfileDigest: profile,
      acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  };
  const hermesPlanner = new TaskExecutionPlanner(f.db, f.scope, { template: makeTemplate("template:shared-hermes",
    HERMES_021_MACOS_LOCAL_ADAPTER_V1, "executor:marvin", HERMES_021_MACOS_LOCAL_START_OPERATION_V1,
    HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1), integrityKey: new Uint8Array(32).fill(61),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints,
    localAdapterAdmission: { enabledAdapters: [HERMES_021_MACOS_LOCAL_ADAPTER_V1] } }, () => now);
  const claudePlanner = new TaskExecutionPlanner(f.db, f.scope, { template: makeTemplate("template:shared-claude",
    CLAUDE_CODE_LOCAL_ADAPTER_V1, "executor:claude", CLAUDE_CODE_LOCAL_START_OPERATION_V1,
    CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1), integrityKey: new Uint8Array(32).fill(62),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => now);
  const hermesSource = await f.tasks.propose(f.identity, binding.projectId, { ...taskDraft, title: "Hermes shared lifecycle" }, "shared-hermes-source");
  const claudeSource = await f.tasks.propose(f.identity, binding.projectId, { ...taskDraft, title: "Claude shared lifecycle" }, "shared-claude-source");
  const hermesPlan = await hermesPlanner.plan(f.identity, binding.projectId, hermesSource.receipt.jobId,
    sha256Digest({ ...taskDraft, title: "Hermes shared lifecycle" }));
  const claudePlan = await claudePlanner.plan(f.identity, binding.projectId, claudeSource.receipt.jobId,
    sha256Digest({ ...taskDraft, title: "Claude shared lifecycle" }));

  const signals = new FleetSignalStore(f.db);
  const nextSignal = async (kind: "telemetry" | "capability") => {
    const row = await f.db.query<{ sequence: number | null }>(`SELECT max(signal_sequence)::int AS sequence
      FROM control_node_fleet_signals WHERE tenant_id=$1 AND node_id=$2 AND signal_kind=$3`,
    [binding.tenantId, binding.nodeId, kind]);
    return Number(row.rows[0]?.sequence ?? 0) + 1;
  };
  await signals.ingestAuthenticated({ schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId, sequence: await nextSignal("telemetry"),
    observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("shared-telemetry"),
    kind: "telemetry", source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 10 }, availableMemoryBytes: { quality: "observed", value: 1000 },
      availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } }, at(6_000), binding);
  for (const probeId of [HERMES_021_MACOS_LOCAL_CAPABILITY_V1, CLAUDE_CODE_LOCAL_CAPABILITY_V1] as const)
    await signals.ingestAuthenticated({ schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId, sequence: await nextSignal("capability"),
      observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest(`shared-${probeId}`),
      kind: "capability", source: "probe_runner", payload: { probeId, probeVersion: "1.0.0", outcome: "pass", reasonCode: "fixture" } }, at(6_000), binding);
  const hermesRoute = [{ nodeId: binding.nodeId, executorId: "executor:marvin", capabilityProbeId: HERMES_021_MACOS_LOCAL_CAPABILITY_V1,
    maxConcurrentTasks: 4, requiredScratchBytes: 0, leaseSeconds: 60 }] as const;
  const claudeRoute = [{ nodeId: binding.nodeId, executorId: "executor:claude", capabilityProbeId: CLAUDE_CODE_LOCAL_CAPABILITY_V1,
    maxConcurrentTasks: 4, requiredScratchBytes: 0, leaseSeconds: 60 }] as const;
  const hermesAssignments = new TaskAssignmentCoordinator(f.db, f.scope, hermesPlanner, hermesRoute, () => now + 1000);
  const claudeAssignments = new TaskAssignmentCoordinator(f.db, f.scope, claudePlanner, claudeRoute, () => now + 1000);
  const hermesAssigned = await hermesAssignments.assign(f.identity, binding.projectId, hermesPlan.receipt.jobId, binding.nodeId, hermesPlan.receipt.inputDigest);
  const claudeAssigned = await claudeAssignments.assign(f.identity, binding.projectId, claudePlan.receipt.jobId, binding.nodeId, claudePlan.receipt.inputDigest);
  // A real runner starts only after the lease is recorded. Keep the disposable
  // lifecycle timestamps coherent so the later shared capacity proof is not
  // accidentally testing an impossible clock ordering.
  now += 2_000;
  const references: Parameters<NativeTaskSubmission["enqueueInSession"]>[1][] = [];
  const submissions: NativeTaskSubmission = { async enqueueInSession(_tx, reference) { references.push(reference); } };
  const hermesQueue = new TaskAssignmentCoordinator(f.db, f.scope, hermesPlanner, hermesRoute, () => now + 1000,
    [], new NativeApprovalPacketStore(new Uint8Array(32).fill(63), []), submissions);
  const claudeQueue = new TaskAssignmentCoordinator(f.db, f.scope, claudePlanner, claudeRoute, () => now + 1000,
    [], new NativeApprovalPacketStore(new Uint8Array(32).fill(64), []), submissions);
  await hermesQueue.enqueueHermes021LocalTask(f.identity, binding.projectId, hermesPlan.receipt.jobId, hermesPlan.receipt.inputDigest, new AbortController().signal);
  await claudeQueue.enqueueClaudeCodeLocalTask(f.identity, binding.projectId, claudePlan.receipt.jobId, claudePlan.receipt.inputDigest, new AbortController().signal);
  const hermesTarget = await hermesQueue.locateQueuedHarnessDelivery(references[0]!, new AbortController().signal);
  const claudeTarget = await claudeQueue.locateQueuedHarnessDelivery(references[1]!, new AbortController().signal);
  assert.equal(hermesTarget.kind, "hermes-021-local"); assert.equal(claudeTarget.kind, "claude-code-local");
  const hermesReference = { tenantId: binding.tenantId, projectId: binding.projectId, jobId: hermesPlan.receipt.jobId,
    attemptId: hermesAssigned.receipt.attemptId, leaseId: hermesAssigned.receipt.leaseId, inputDigest: hermesPlan.receipt.inputDigest };
  const hermesBinding = { localServiceId: "service:fixture-hermes", workerId: "worker:marvin", expectedVersion: "0.21.3" as const, sourceRevision: "00570550" };
  let hermesStarts = 0;
  const reviewSubmission = new DurableResultReviewSubmissionServiceV1(f.db, { integrityKey: f.resultKey,
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints, storageClass: "local", storage: f.storage });
  const hermesResults = { db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage: f.storage, storageClass: "local" as const,
    reservations: createInMemoryNeutralReservationPort(), reviewSubmission };
  const hermesExecution = () => ({ preparation: new Hermes021MacosDispatchPreparationV1(f.db, hermesPlanner, hermesBinding, () => now),
    runs: new HarnessRunStoreV1(f.db, f.harnessKey), delivery: { db: f.db, integrityKey: new Uint8Array(32).fill(65), binding: hermesBinding,
      policy: { assertAdmitted() { throw new Error("stale policy"); } }, terminalResultStorage: f.storage }, clock: () => now });
  const createHermes = (restart = false) => createHermes021LocalSubprocessQueueExecutorV1({ tenantId: binding.tenantId, execution: hermesExecution(), results: hermesResults,
    assertAuthority: () => {}, host: { async execute(input) { hermesStarts++; if (restart) throw new Error("recovery reopened Hermes");
      await input.onLine(JSON.stringify({ type: "result", session_id: "session:shared-hermes", exit_code: 0, text: "# Result\nHermes shared review result.\n# Evidence\nFixture evidence is explicit.\n",
        tokens: { input: 1, output: 1, total: 2, cache_read: 0, cache_write: 0 }, duration_ms: 1, timestamp: now })); } } });
  const hermesFirst = await createHermes().deliver(hermesTarget, new AbortController().signal);
  assert.equal(hermesFirst.publication?.replayed, false);

  const claudeReference = { tenantId: binding.tenantId, projectId: binding.projectId, jobId: claudePlan.receipt.jobId,
    attemptId: claudeAssigned.receipt.attemptId, leaseId: claudeAssigned.receipt.leaseId, inputDigest: claudePlan.receipt.inputDigest };
  const claudeWorker = { workerId: "worker:claude", adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1, adapterRevision: "00570550" } as const;
  const claudePreparation = () => new ClaudeCodeLocalDispatchPreparationV1(f.db, claudePlanner,
    { workerId: claudeWorker.workerId, adapterRevision: claudeWorker.adapterRevision }, () => now);
  const preparedClaude = await claudePreparation().prepare(claudeReference);
  const claudeResults = { db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage: f.storage, storageClass: "local" as const,
    reservations: createPersistentNeutralReservationPort(createPersistentNeutralReservationStore()), reviewSubmission };
  let claudeStarts = 0;
  const claudeReceipt: ControllerWorkerDeliveryPortV1 = { async receive(packet) { return acceptedClaudeReceipt(packet, new Date(now).toISOString()); } };
  const claudeExecution = (restart = false) => ({ preparation: claudePreparation(), runs: new HarnessRunStoreV1(f.db, f.harnessKey),
    delivery: { db: f.db, integrityKey: new Uint8Array(32).fill(66), binding: { ...claudeWorker,
      authorityDigest: preparedClaude.delivery.authorityDigest, acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) },
      authority: { currentAdmissionDigest: () => preparedClaude.delivery.authorityDigest, assertCurrent: () => {} }, receiptPort: claudeReceipt,
      acquire: () => { claudeStarts++; if (restart) throw new Error("recovery reopened Claude"); const sessionId = "00000000-0000-4000-8000-000000004242";
        return new FinishedClaudeProcess([`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`,
          `${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "# Result\\nClaude shared review result.\\n# Evidence\\nFixture evidence is explicit.\\n", usage: {} })}\n`]).acquire(); },
      cleanupMs: 500, clock: () => now }, results: claudeResults, protectedStorage: f.storage, assertAuthority: () => {}, clock: () => now });
  const claudeFirst = await createClaudeCodeLocalQueueExecutorV1({ tenantId: binding.tenantId, execution: claudeExecution() })
    .deliver(claudeTarget, new AbortController().signal);
  assert.equal(claudeFirst, undefined);
  assert.deepEqual((await f.db.query(`SELECT count(*)::int AS count FROM control_worker_delivery_receipts WHERE tenant_id=$1`, [binding.tenantId])).rows[0], { count: 2 });
  assert.deepEqual((await f.db.query(`SELECT count(*)::int AS count FROM control_harness_runs WHERE tenant_id=$1 AND job_id IN ($2,$3)`,
    [binding.tenantId, hermesPlan.receipt.jobId, claudePlan.receipt.jobId])).rows[0], { count: 2 });
  const plans = await f.db.query<{ run_id: string }>(`SELECT run_id FROM control_native_review_plans WHERE tenant_id=$1 AND run_id IN ($2,$3) ORDER BY run_id`,
    [binding.tenantId, hermesFirst.execution.registered.run.id, preparedClaude.delivery.identity.runId]);
  assert.equal(plans.rows.length, 2, "one database holds two distinct pending owner reviews");

  const reviewRows = await f.db.query<{ run_id: string; plan: unknown; artifact_id: string; receipt: unknown }>(`
    SELECT p.run_id,p.plan,r.artifact_id,r.receipt
    FROM control_native_review_plans p
    JOIN control_native_artifact_receipts r ON r.tenant_id=p.tenant_id AND r.run_id=p.run_id
    WHERE p.tenant_id=$1 AND p.run_id IN ($2,$3)`,
  [binding.tenantId, hermesFirst.execution.registered.run.id, preparedClaude.delivery.identity.runId]);
  assert.equal(reviewRows.rows.length, 2);
  const reviews = f.createReviews(f.db, () => now);
  const hermesReview = reviewRows.rows.find(row => row.run_id === hermesFirst.execution.registered.run.id)!;
  const claudeReview = reviewRows.rows.find(row => row.run_id === preparedClaude.delivery.identity.runId)!;
  const ownerTasks = new WebTaskService(f.db, f.scope, () => now, {
    harnessIntegrityKey: f.harnessKey, results: f.config,
    reviews: { integrityKey: f.reviewKey, checkpoints: f.checkpoints }, ownerReviews: f.ownerConfig,
  });
  const [hermesPage, claudePage] = await Promise.all([
    ownerTasks.results(f.identity, binding.projectId, hermesPlan.receipt.jobId),
    ownerTasks.results(f.identity, binding.projectId, claudePlan.receipt.jobId),
  ]);
  assert.deepEqual(hermesPage.items.map(item => item.artifactId), [hermesReview.artifact_id]);
  assert.deepEqual(claudePage.items.map(item => item.artifactId), [claudeReview.artifact_id]);
  assert.equal(hermesPage.reviewCommands, "configured");
  assert.equal(claudePage.reviewCommands, "configured");
  assert.equal(hermesPage.reviews[0]?.status, "pending");
  assert.equal(claudePage.reviews[0]?.status, "pending");
  const draft = (row: typeof hermesReview, decision: "accepted" | "changes_requested", feedback: string) => {
    const plan = durableResultReviewPlanSchemaV1.parse(row.plan);
    const receipt = durableResultReceiptSchemaV1.parse(row.receipt);
    const target = durableReviewTargetV1(plan, receipt);
    return { artifactId: row.artifact_id, targetId: target.id, targetDigest: sha256Digest(target), contentHash: receipt.contentHash,
      decision, feedback };
  };
  const [inspectedHermes, inspectedClaude] = await Promise.all([
    f.db.transaction(tx => durableInspection.inspectSubmitted(tx, binding.tenantId, hermesReview.run_id)),
    f.db.transaction(tx => durableInspection.inspectSubmitted(tx, binding.tenantId, claudeReview.run_id)),
  ]);
  assert.deepEqual([inspectedHermes.result.receipt.artifactId, inspectedClaude.result.receipt.artifactId].sort(),
    [hermesReview.artifact_id, claudeReview.artifact_id].sort());
  assert.deepEqual([inspectedHermes.execution.leaseId, inspectedClaude.execution.leaseId].sort(),
    [hermesAssigned.receipt.leaseId, claudeAssigned.receipt.leaseId].sort());
  const accepted = await reviews.record(f.identity, binding.projectId, hermesPlan.receipt.jobId, draft(hermesReview, "accepted", ""),
    "shared-hermes-accept");
  assert.notEqual(draft(hermesReview, "accepted", "").targetId,
    draft(claudeReview, "changes_requested", "Please correct this result.").targetId);
  const corrected = await reviews.record(f.identity, binding.projectId, claudePlan.receipt.jobId,
    draft(claudeReview, "changes_requested", "Please correct this result."), "shared-claude-correct");
  assert.equal(accepted.replayed, false); assert.equal(corrected.receipt.decision, "changes_requested");

  now += 1000;
  const hermesRecovered = await createHermes(true).deliver(hermesTarget, new AbortController().signal);
  const claudeRecovered = await executeAssignedClaudeCodeLocalTaskV1(claudeExecution(true), claudeReference, new AbortController().signal);
  assert.equal(hermesRecovered.publication?.replayed, true); assert.equal(claudeRecovered.state, "recovered_pending_review");
  assert.deepEqual({ hermesStarts, claudeStarts }, { hermesStarts: 1, claudeStarts: 1 }, "replay reconstructed only durable evidence");
  assert.deepEqual((await f.db.query(`SELECT count(*)::int AS count FROM control_worker_delivery_receipts WHERE tenant_id=$1`, [binding.tenantId])).rows[0], { count: 2 });
  assert.deepEqual((await f.db.query(`SELECT count(*)::int AS count FROM control_harness_runs WHERE tenant_id=$1 AND job_id IN ($2,$3)`,
    [binding.tenantId, hermesPlan.receipt.jobId, claudePlan.receipt.jobId])).rows[0], { count: 2 });
  assert.deepEqual((await f.db.query(`SELECT count(*)::int AS count FROM control_native_review_plans WHERE tenant_id=$1 AND run_id IN ($2,$3)`,
    [binding.tenantId, hermesFirst.execution.registered.run.id, preparedClaude.delivery.identity.runId])).rows[0], { count: 2 });

  // The same authenticated local inspection source drives the ordinary
  // verification and capacity/completion services. Hermes is accepted and
  // completes; Claude has changes requested and releases only its capacity.
  // This proves there is no adapter-specific completion shortcut.
  now += 1_000;
  const scenario: AutomaticDocumentScenario = { scenarioId: "scenario:content", acceptanceProfileId: f.profile.id,
    acceptanceProfileDigest: sha256Digest(f.profile), rules: { version: "document-structure/v1", minUtf8Bytes: 20,
      maxUtf8Bytes: 4096, requiredHeadings: ["Result", "Evidence"], forbiddenTerms: [] } };
  const requests = [
    { tenantId: binding.tenantId, runId: hermesReview.run_id, targetDigest: draft(hermesReview, "accepted", "").targetDigest,
      contentHash: durableResultReceiptSchemaV1.parse(hermesReview.receipt).contentHash },
    { tenantId: binding.tenantId, runId: claudeReview.run_id, targetDigest: draft(claudeReview, "changes_requested", "").targetDigest,
      contentHash: durableResultReceiptSchemaV1.parse(claudeReview.receipt).contentHash },
  ] as const;
  const verification = new NativeResultVerificationService(f.db, f.ownerConfig, [scenario], () => now, durableInspection);
  const [verifiedHermes, verifiedClaude] = await Promise.all(requests.map(request => verification.verify(request, () => {})));
  assert.equal(verifiedHermes.replayed, false); assert.equal(verifiedClaude.replayed, false);
  const completion = new NativeTaskCompletionService(f.db, f.ownerConfig, () => now, durableInspection);
  const completedHermes = await completion.complete(requests[0], () => {});
  const releasedClaude = await completion.releaseCapacity(requests[1], () => {});
  assert.equal(completedHermes.replayed, false); assert.equal(releasedClaude.replayed, false);
  const stateRows = await Promise.all([
    f.canonical.get(binding.tenantId, "job", hermesPlan.receipt.jobId), f.canonical.get(binding.tenantId, "attempt", hermesAssigned.receipt.attemptId), f.canonical.get(binding.tenantId, "lease", hermesAssigned.receipt.leaseId),
    f.canonical.get(binding.tenantId, "lease", claudeAssigned.receipt.leaseId),
  ]);
  assert.deepEqual(stateRows.map(row => row?.state), ["succeeded", "succeeded", "released", "released"]);
});
