import assert from "node:assert/strict";
import test from "node:test";
import { DOMAIN_CONTRACT_VERSION, type JobRecord, type RequestRecord, type ScheduleRecord, type WorkflowRecord } from "../src/domain/v1";
import { CanonicalStore, type ProposedWorkBundle } from "../src/persistence/canonical-store";
import { sha256Digest } from "../src/security";
import { ScheduleOccurrenceStore } from "../src/services/v1/occurrence-store";
import { EMPTY_SCHEDULE_REUSABLE_CONTEXT_BINDING_DIGEST_V1, ScheduledTaskAdmissionServiceV1,
  computeScheduledTaskDefinitionDigestV1, computeScheduledTaskSourceBundleDigestV1,
  type ScheduledReusableContextV1 } from "../src/services/v1/scheduled-task-admission";
import { ScheduledTaskAssignmentErrorV1, ScheduledTaskAssignmentServiceV1,
  computeScheduledReusableContextPolicyDigestV1, type ScheduledReusableContextVerifierV1 } from "../src/services/v1/scheduled-task-assignment";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";

const scheduleId = "schedule:automatic-assignment";
const occurrenceKey = `${scheduleId}:2026-09-04T12:00`;

async function scheduledFixture(reusableContexts: ScheduledReusableContextV1[] = [], verifier?: ScheduledReusableContextVerifierV1) {
  const f = await taskAssignmentFixture();
  const sourceRow = (await f.db.query<{ request: RequestRecord; workflow: WorkflowRecord; job: JobRecord }>(`SELECT
    r.payload AS request,w.payload AS workflow,j.payload AS job FROM control_jobs j
    JOIN control_workflows w ON w.tenant_id=j.tenant_id AND w.id=j.workflow_id
    JOIN control_requests r ON r.tenant_id=w.tenant_id AND r.id=w.request_id
    WHERE j.tenant_id=$1 AND j.id=$2`, [f.scope.tenantId, f.source.receipt.jobId])).rows[0];
  const source: ProposedWorkBundle = sourceRow;
  const createdAt = at(6000), scheduledFor = at(7000);
  const schedule: ScheduleRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "schedule", id: scheduleId,
    tenantId: f.scope.tenantId, projectId: binding.projectId, state: "active", scheduleType: "cron",
    expression: "0 12 * * *", timezone: "UTC", targetType: "job", targetId: source.job.id,
    idempotencyWindowSeconds: 300, version: 0, createdAt, updatedAt: createdAt };
  await new CanonicalStore(f.db).create(schedule);
  const scheduleDefinitionDigest = computeScheduledTaskDefinitionDigestV1(schedule);
  await new ScheduleOccurrenceStore(f.db).materialize({ tenantId: f.scope.tenantId, scheduleId, occurrenceKey,
    targetType: "job", targetId: source.job.id, definitionDigest: scheduleDefinitionDigest,
    scheduledFor, localTime: "2026-09-04T12:00", createdAt });
  await f.db.query("UPDATE control_outbox SET status='delivered',delivered_at=$2 WHERE tenant_id=$1 AND aggregate_id=$3",
    [f.scope.tenantId, createdAt, occurrenceKey]);
  const contextBinding = { reusableContexts, bindingDigest: sha256Digest({
    contractVersion: "control-room-scheduled-context-binding/v1", reusableContexts }) };
  const admissionInput = { tenantId: f.scope.tenantId, workspaceId: f.scope.workspaceId, projectId: binding.projectId,
    scheduleId, occurrenceKey, scheduleDefinitionDigest,
    source: { requestId: source.request.id, workflowId: source.workflow.id, jobId: source.job.id,
      bundleDigest: computeScheduledTaskSourceBundleDigestV1(source) }, contextBinding };
  const admission = await new ScheduledTaskAdmissionServiceV1(f.db, () => instant + 8000).admit(admissionInput);
  let now = instant + 8000;
  const createService = () => new ScheduledTaskAssignmentServiceV1(f.db, f.scope, f.planner, f.coordinator, () => now, verifier);
  const service = createService();
  const policyInput = { id: "policy:automatic-assignment", projectId: binding.projectId, scheduleId,
    scheduleDefinitionDigest, sourceBundleDigest: admissionInput.source.bundleDigest, reusableContexts,
    reusableContextPolicyDigest: computeScheduledReusableContextPolicyDigestV1(reusableContexts),
    allowedExecutor: f.route.executorId, requiredCapability: f.route.capabilityProbeId, nodeId: f.route.nodeId,
    validFrom: at(7000), validUntil: at(250000) };
  const policy = await service.createPolicy(f.identity, policyInput);
  const operation = { policyId: policy.policy.id, policyDigest: policy.policy.policyDigest, admission: admission.receipt };
  const baseline = {
    attempts: Number((await f.db.query<{ n: string }>("SELECT count(*)::text AS n FROM control_attempts")).rows[0].n),
    leases: Number((await f.db.query<{ n: string }>("SELECT count(*)::text AS n FROM control_leases")).rows[0].n),
    queue: Number((await f.db.query<{ n: string }>("SELECT count(*)::text AS n FROM control_native_task_queue")).rows[0].n),
    runs: Number((await f.db.query<{ n: string }>("SELECT count(*)::text AS n FROM control_harness_runs")).rows[0].n),
  };
  return { ...f, service, createService, admission, policy, operation, scheduleDefinitionDigest,
    baseline, setNow(value: number) { now = value; } };
}

const hasCode = (code: ScheduledTaskAssignmentErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ScheduledTaskAssignmentErrorV1 && error.safeCode === code;
const count = async (f: Awaited<ReturnType<typeof scheduledFixture>>, table: string) =>
  Number((await f.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0].n);

test("one admitted occurrence is planned and assigned once across concurrency and restart replay", async t => {
  const f = await scheduledFixture(); t.after(f.close);
  assert.deepEqual(f.admission.receipt.contextBinding, { reusableContexts: [],
    bindingDigest: EMPTY_SCHEDULE_REUSABLE_CONTEXT_BINDING_DIGEST_V1 });
  const results = await Promise.all(Array.from({ length: 4 }, () => f.service.process(f.operation)));
  assert.equal(results.filter(value => !value.plan.replayed).length, 1);
  assert.equal(results.filter(value => !value.assignment.replayed).length, 1);
  for (const value of results) assert.deepEqual(value.assignment.receipt, results[0].assignment.receipt);
  const replay = await f.createService().process(f.operation);
  assert.equal(replay.plan.replayed, true); assert.equal(replay.assignment.replayed, true);
  assert.equal(await count(f, "control_scheduled_task_admissions"), 1);
  assert.equal(await count(f, "control_scheduled_task_plans"), 1);
  assert.equal(await count(f, "control_scheduled_task_assignments"), 1);
  assert.equal(await count(f, "control_attempts"), f.baseline.attempts + 1);
  assert.equal(await count(f, "control_leases"), f.baseline.leases + 1);
  assert.equal(replay.assignment.receipt.startsWork, false);
  assert.equal(replay.assignment.receipt.grantsExecutionAuthority, false);
  assert.equal(replay.assignment.receipt.claimsNativeCancellation, false);
  assert.equal(replay.assignment.receipt.releasesCapacity, false);
  assert.equal(replay.plan.receipt.ownerIdentityId, f.policy.policy.ownerIdentityId);
  assert.equal(replay.plan.receipt.ownerIdentityDigest, f.policy.policy.ownerIdentityDigest);
  assert.equal(replay.assignment.receipt.ownerIdentityId, f.policy.policy.ownerIdentityId);
  assert.equal(replay.assignment.receipt.ownerIdentityDigest, f.policy.policy.ownerIdentityDigest);
  assert.equal(await count(f, "control_native_task_queue"), f.baseline.queue);
  assert.equal(await count(f, "control_harness_runs"), f.baseline.runs);
  assert.deepEqual(Object.keys(f.coordinator.webOperation()).sort(), ["assign", "expire", "options", "tenantId", "workspaceId"]);
  const extraDraft = { ...f.sourceDraft, title: "A third capacity claimant" };
  const extraSource = await f.tasks.propose(f.identity, binding.projectId, extraDraft, "scheduled-capacity-owner-003");
  const extraPlan = await f.planner.plan(f.identity, binding.projectId, extraSource.receipt.jobId, sha256Digest(extraDraft));
  await assert.rejects(f.coordinator.assign(f.identity, binding.projectId, extraPlan.receipt.jobId,
    binding.nodeId, extraPlan.receipt.inputDigest), { message: "conflict" });
  assert.equal(await count(f, "control_leases"), f.baseline.leases + 1);
});

test("policy mismatch, pause, revocation and expiry block new plans or leases", async t => {
  const mismatch = await scheduledFixture(); t.after(mismatch.close);
  await assert.rejects(mismatch.service.plan({ ...mismatch.operation, policyDigest: sha256Digest("wrong") }), hasCode("policy_conflict"));
  assert.equal(await count(mismatch, "control_scheduled_task_plans"), 0); assert.equal(await count(mismatch, "control_leases"), mismatch.baseline.leases);

  const paused = await scheduledFixture(); t.after(paused.close);
  const pausedPolicy = await paused.service.setPolicyState(paused.identity, paused.policy.policy.id,
    { state: "paused", expectedVersion: 1 });
  await assert.rejects(paused.service.plan({ ...paused.operation, policyDigest: pausedPolicy.policy.policyDigest }), hasCode("policy_not_active"));
  assert.equal(await count(paused, "control_leases"), paused.baseline.leases);

  const revoked = await scheduledFixture(); t.after(revoked.close);
  const revokedPolicy = await revoked.service.setPolicyState(revoked.identity, revoked.policy.policy.id,
    { state: "revoked", expectedVersion: 1 });
  await assert.rejects(revoked.service.plan({ ...revoked.operation, policyDigest: revokedPolicy.policy.policyDigest }), hasCode("policy_not_active"));
  assert.equal(await count(revoked, "control_leases"), revoked.baseline.leases);

  const expired = await scheduledFixture(); t.after(expired.close); expired.setNow(instant + 250000);
  await assert.rejects(expired.service.plan(expired.operation), hasCode("policy_expired"));
  assert.equal(await count(expired, "control_leases"), expired.baseline.leases);
});

test("pause after planning preserves the proposal and blocks assignment; assignment replay never releases capacity", async t => {
  const f = await scheduledFixture(); t.after(f.close);
  const plan = await f.service.plan(f.operation); assert.equal(plan.replayed, false);
  const paused = await f.service.setPolicyState(f.identity, f.policy.policy.id, { state: "paused", expectedVersion: 1 });
  await assert.rejects(f.service.assign({ ...f.operation, policyDigest: paused.policy.policyDigest }), hasCode("planning_conflict"));
  assert.equal(await count(f, "control_scheduled_task_plans"), 1); assert.equal(await count(f, "control_leases"), f.baseline.leases);

  const cancelled = await scheduledFixture(); t.after(cancelled.close);
  await cancelled.service.plan(cancelled.operation);
  await new CanonicalStore(cancelled.db).transition({ tenantId: cancelled.scope.tenantId, kind: "job",
    entityId: cancelled.admission.receipt.destination.jobId, expectedVersion: 0, toState: "cancelled",
    transitionId: "transition:scheduled-proposal-cancel", idempotencyKey: "scheduled-proposal-cancel",
    actor: { actorId: "identity:web", actorType: "human" }, occurredAt: at(8500) });
  await assert.rejects(cancelled.service.assign(cancelled.operation), hasCode("schedule_unavailable"));
  assert.equal(await count(cancelled, "control_scheduled_task_plans"), 1);
  assert.equal(await count(cancelled, "control_leases"), cancelled.baseline.leases);

  const assigned = await scheduledFixture(); t.after(assigned.close);
  const first = await assigned.service.process(assigned.operation);
  await assigned.db.query("UPDATE control_schedules SET state='paused',payload=jsonb_set(payload,'{state}','\"paused\"'::jsonb) WHERE id=$1",
    [scheduleId]);
  const replay = await assigned.service.assign(assigned.operation);
  assert.deepEqual(replay.receipt, first.assignment.receipt); assert.equal(replay.replayed, true);
  const cancellation = new ScheduledTaskAdmissionServiceV1(assigned.db, () => instant + 9000);
  await assert.rejects(cancellation.cancelPending({ tenantId: assigned.scope.tenantId, workspaceId: assigned.scope.workspaceId,
    projectId: binding.projectId, scheduleId, occurrenceKey, scheduleDefinitionDigest: assigned.scheduleDefinitionDigest,
    sourceJobId: assigned.source.receipt.jobId }), { safeCode: "admission_already_committed" });
  assert.equal(await count(assigned, "control_leases"), assigned.baseline.leases + 1);
  const lease = (await assigned.db.query<{ state: string }>("SELECT state FROM control_leases WHERE id=$1",
    [replay.receipt.leaseId])).rows[0];
  assert.equal(lease.state, "active");
});

test("non-empty context is exact, revalidated at plan and assignment, and never falls back to empty", async t => {
  const context: ScheduledReusableContextV1 = { kind: "artifact", id: "artifact:accepted-context",
    contentHash: sha256Digest("context"), sourceJobId: "job:accepted-context", sourceRunId: "run:accepted-context",
    sourceRevision: 0, reviewId: "review:accepted-context", reviewDigest: sha256Digest("review"),
    verificationDigest: sha256Digest("verification"), verifiedAt: at(5000) };
  let available = true;
  const verifier: ScheduledReusableContextVerifierV1 = { async verifyInSession(_tx, scope, value, now) {
    return available && scope.projectId === binding.projectId && value.id === context.id
      && value.contentHash === context.contentHash && Date.parse(value.verifiedAt) <= Date.parse(now)
      && (!value.expiresAt || Date.parse(value.expiresAt) > Date.parse(now));
  } };
  const f = await scheduledFixture([context], verifier); t.after(f.close);
  await f.service.plan(f.operation); available = false;
  await assert.rejects(f.service.assign(f.operation), hasCode("context_unavailable"));
  assert.equal(await count(f, "control_scheduled_task_plans"), 1); assert.equal(await count(f, "control_leases"), f.baseline.leases);

  const unavailable = await scheduledFixture([{ ...context, id: "artifact:cross-project" }], verifier); t.after(unavailable.close);
  await assert.rejects(unavailable.service.plan(unavailable.operation), hasCode("context_unavailable"));
  assert.equal(await count(unavailable, "control_scheduled_task_plans"), 0);

  const empty = await scheduledFixture(); t.after(empty.close);
  await assert.rejects(empty.service.plan({ ...empty.operation, admission: {
    ...empty.admission.receipt, contextBinding: undefined } }), hasCode("admission_conflict"));
  assert.equal(await count(empty, "control_scheduled_task_plans"), 0);
});

test("schedule pause after admission and before planning refuses without erasing admission", async t => {
  const f = await scheduledFixture(); t.after(f.close);
  await f.db.query("UPDATE control_schedules SET state='paused',payload=jsonb_set(payload,'{state}','\"paused\"'::jsonb) WHERE id=$1",
    [scheduleId]);
  await assert.rejects(f.service.plan(f.operation), hasCode("schedule_unavailable"));
  assert.equal(await count(f, "control_scheduled_task_admissions"), 1);
  assert.equal(await count(f, "control_scheduled_task_plans"), 0); assert.equal(await count(f, "control_leases"), f.baseline.leases);
});
