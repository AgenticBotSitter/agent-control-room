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
  CanonicalScheduledReusableContextVerifierV1, computeScheduledContextReviewDigestV1,
  computeScheduledContextVerificationDigestV1, computeScheduledReusableContextPolicyDigestV1,
  type ScheduledReusableContextVerifierV1 } from "../src/services/v1/scheduled-task-assignment";
import type { CompletionAcceptanceProfileV1, CompletionReviewTargetV1, CompletionReviewV1,
  CompletionVerificationV1 } from "../src/completion-gate/v1";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { bindScheduledContextReferencesV1 } from "../src/web/v1/task-execution-planner";
import { prepareNativeTaskApproval } from "../src/harness/v1/native-task-approval-binding";
import { enrollment } from "./hermes-native-fixture";

const scheduleId = "schedule:automatic-assignment";
const occurrenceKey = `${scheduleId}:2026-09-04T12:00`;

type AssignmentFixture = Awaited<ReturnType<typeof taskAssignmentFixture>>;
type ContextSetup = (fixture: AssignmentFixture) => Promise<{
  reusableContexts: ScheduledReusableContextV1[]; verifier: ScheduledReusableContextVerifierV1;
}>;
async function scheduledFixture(setupContext?: ContextSetup) {
  const f = await taskAssignmentFixture();
  const configured = setupContext ? await setupContext(f) : { reusableContexts: [], verifier: undefined };
  const { reusableContexts, verifier } = configured;
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
  const createService = (db: DatabaseClient = f.db, clock: () => number = () => now) =>
    new ScheduledTaskAssignmentServiceV1(db, f.scope, f.planner, f.coordinator, clock, verifier);
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

async function acceptedContext(f: AssignmentFixture, expiresAt?: string) {
  const recorded = await f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, "scheduled-context-review-001");
  const review = await f.reviewStore.getRecord(f.scope.tenantId, recorded.receipt.reviewId, "review") as CompletionReviewV1;
  const verification: CompletionVerificationV1 = { schemaVersion: "control-room-completion-gate/v1",
    id: "verification:scheduled-context", tenantId: f.scope.tenantId, projectId: binding.projectId,
    targetId: f.target.id, targetDigest: sha256Digest(f.target), acceptanceProfileId: f.profile.id,
    acceptanceProfileDigest: sha256Digest(f.profile), scenarioId: "scenario:content", outcome: "passed",
    verifier: { actorId: "service:scheduled-context-verifier", actorType: "service" },
    evidenceDigests: [f.artifact.contentHash], verifiedAt: at(6500), grantsApproval: false,
    grantsExecutionAuthority: false };
  await f.reviewStore.recordVerification(verification);
  const context: ScheduledReusableContextV1 = { kind: "artifact", id: f.artifact.artifactId, targetId: f.target.id,
    contentHash: f.artifact.contentHash, sourceJobId: binding.jobId, sourceRunId: f.artifact.runId,
    sourceRevision: f.target.revisionNumber, reviewIds: [review.id],
    reviewDigest: computeScheduledContextReviewDigestV1([review]), verificationIds: [verification.id],
    verificationDigest: computeScheduledContextVerificationDigestV1([verification]), verifiedAt: verification.verifiedAt,
    ...(expiresAt ? { expiresAt } : {}) };
  return { reusableContexts: [context],
    verifier: new CanonicalScheduledReusableContextVerifierV1(f.results, f.reviewStore, f.reviewKey) };
}

async function crossProjectAcceptedContext(f: AssignmentFixture) {
  const projectId = "project:cross-context";
  await f.db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    SELECT $1,tenant_id,workspace_id,adapter_id,$1,'1','Cross context','Synthetic cross-project context',normalized_state,
      domain_state,health,authority_mode,observed_at,'{}'::jsonb,updated_at FROM projects WHERE tenant_id=$2 AND id=$3`,
  [projectId, f.scope.tenantId, binding.projectId]);
  await f.db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3)`, [f.scope.tenantId, projectId, at()]);
  const profile: CompletionAcceptanceProfileV1 = { ...f.profile, id: "profile:cross-context", projectId,
    name: "Cross project context" };
  const target: CompletionReviewTargetV1 = { ...f.target, id: "target:cross-context", projectId,
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile),
    subjectId: "job:cross-context", rootTargetId: "target:cross-context" };
  await f.reviewStore.registerProfile(profile); await f.reviewStore.registerTarget(target);
  const review: CompletionReviewV1 = { schemaVersion: "control-room-completion-gate/v1", id: "review:cross-context",
    tenantId: f.scope.tenantId, projectId, targetId: target.id, targetDigest: sha256Digest(target),
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile),
    reviewer: { actorId: "identity:cross-context-reviewer", actorType: "human" }, authority: "completion_gate",
    decision: "accepted", assessedRisk: "low", effectiveRisk: "low", evidenceDigests: [f.artifact.contentHash],
    findingIds: [], reviewedAt: at(6000), grantsApproval: false, grantsExecutionAuthority: false };
  const verification: CompletionVerificationV1 = { schemaVersion: "control-room-completion-gate/v1",
    id: "verification:cross-context", tenantId: f.scope.tenantId, projectId, targetId: target.id,
    targetDigest: sha256Digest(target), acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile),
    scenarioId: "scenario:content", outcome: "passed", verifier: { actorId: "service:cross-context", actorType: "service" },
    evidenceDigests: [f.artifact.contentHash], verifiedAt: at(6500), grantsApproval: false, grantsExecutionAuthority: false };
  await f.reviewStore.recordReview(review); await f.reviewStore.recordVerification(verification);
  const context: ScheduledReusableContextV1 = { kind: "artifact", id: f.artifact.artifactId, targetId: target.id,
    contentHash: f.artifact.contentHash, sourceJobId: binding.jobId, sourceRunId: f.artifact.runId,
    sourceRevision: target.revisionNumber, reviewIds: [review.id], reviewDigest: computeScheduledContextReviewDigestV1([review]),
    verificationIds: [verification.id], verificationDigest: computeScheduledContextVerificationDigestV1([verification]),
    verifiedAt: verification.verifiedAt };
  return { reusableContexts: [context],
    verifier: new CanonicalScheduledReusableContextVerifierV1(f.results, f.reviewStore, f.reviewKey) };
}

const hasCode = (code: ScheduledTaskAssignmentErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ScheduledTaskAssignmentErrorV1 && error.safeCode === code;
const count = async (f: Awaited<ReturnType<typeof scheduledFixture>>, table: string) =>
  Number((await f.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0].n);
const withBeforeCommit = (db: DatabaseClient, before: () => void): DatabaseClient => ({
  query: db.query.bind(db), transaction: db.transaction.bind(db),
  transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(work, async () => {
    before(); await check();
  }),
});

test("one admitted occurrence is planned and assigned once across concurrency and restart replay", async t => {
  const f = await scheduledFixture(); t.after(f.close);
  assert.deepEqual(f.admission.receipt.contextBinding, { reusableContexts: [],
    bindingDigest: EMPTY_SCHEDULE_REUSABLE_CONTEXT_BINDING_DIGEST_V1 });
  const results = await Promise.all(Array.from({ length: 4 }, () => f.service.process(f.operation)));
  assert.equal(results.filter(value => !value.plan.replayed).length, 1);
  assert.equal(results.filter(value => !value.assignment.replayed).length, 1);
  for (const value of results) assert.deepEqual(value.assignment.receipt, results[0].assignment.receipt);
  const legacyPlan = await f.planner.read(results[0].plan.receipt.plannedJobId);
  assert.deepEqual(legacyPlan?.input, { prompt: f.sourceDraft.instructions, instructions: "Use only the supplied information." });
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
  assert.deepEqual(Object.keys(f.coordinator.webOperation()).sort(),
    ["assign", "expire", "options", "projectOptions", "tenantId", "workspaceId"]);
  const extraDraft = { ...f.sourceDraft, title: "A third capacity claimant" };
  const extraSource = await f.tasks.propose(f.identity, binding.projectId, extraDraft, "scheduled-capacity-owner-003");
  const extraPlan = await f.planner.plan(f.identity, binding.projectId, extraSource.receipt.jobId, sha256Digest(extraDraft));
  await assert.rejects(f.coordinator.assign(f.identity, binding.projectId, extraPlan.receipt.jobId,
    binding.nodeId, extraPlan.receipt.inputDigest), { message: "conflict" });
  assert.equal(await count(f, "control_leases"), f.baseline.leases + 1);
});

test("stable policy locking precedes absent receipt reads for PostgreSQL replay serialization", async t => {
  const f = await scheduledFixture(); t.after(f.close); const statements: string[] = [];
  const session = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
    statements.push(sql.replace(/\s+/g, " ").trim()); return tx.query<T>(sql, params);
  } });
  const tracked: DatabaseClient = { query: f.db.query.bind(f.db),
    transaction: work => f.db.transaction(tx => work(session(tx))),
    transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
  const service = f.createService(tracked); await service.plan(f.operation);
  const ownerLock = statements.findIndex(sql => sql.includes("SELECT id,state FROM control_identities"));
  const grantLock = statements.findIndex(sql => sql.includes("FROM control_role_grants") && sql.includes("FOR SHARE"));
  const planLock = statements.findIndex(sql => sql.includes("SELECT * FROM control_schedule_assignment_policies"));
  const planRead = statements.findIndex(sql => sql.includes("SELECT payload,receipt_digest FROM control_scheduled_task_plans"));
  assert.ok(ownerLock >= 0 && ownerLock < grantLock && grantLock < planLock && planLock < planRead,
    "owner and grants lock before stable policy, which locks before missing plan receipt lookup");
  statements.length = 0; await service.assign(f.operation);
  const assignmentOwnerLock = statements.findIndex(sql => sql.includes("SELECT id,state FROM control_identities"));
  const assignmentGrantLock = statements.findIndex(sql => sql.includes("FROM control_role_grants") && sql.includes("FOR SHARE"));
  const assignmentLock = statements.findIndex(sql => sql.includes("SELECT * FROM control_schedule_assignment_policies"));
  const assignmentRead = statements.findIndex(sql => sql.includes("SELECT payload,receipt_digest FROM control_scheduled_task_assignments"));
  assert.ok(assignmentOwnerLock >= 0 && assignmentOwnerLock < assignmentGrantLock
    && assignmentGrantLock < assignmentLock && assignmentLock < assignmentRead,
  "owner and grants lock before stable policy, which locks before missing assignment receipt lookup");
});

test("owner-first plan lock and concurrent policy pause complete without lock inversion", async t => {
  const f = await scheduledFixture(); t.after(f.close);
  let release!: () => void, observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ownerLocked = new Promise<void>(resolve => { observed = resolve; });
  let held = false;
  const session = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
    const result = await tx.query<T>(sql, params);
    if (!held && sql.includes("SELECT id,state FROM control_identities") && sql.includes("FOR UPDATE")) {
      held = true; observed(); await gate;
    }
    return result;
  } });
  const tracked: DatabaseClient = { query: f.db.query.bind(f.db), transaction: work => f.db.transaction(tx => work(session(tx))),
    transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
  const plan = f.createService(tracked).plan(f.operation);
  await ownerLocked;
  const pause = f.service.setPolicyState(f.identity, f.policy.policy.id, { state: "paused", expectedVersion: 1 });
  release();
  const [planned, paused] = await Promise.all([plan, pause]);
  assert.equal(planned.replayed, false); assert.equal(paused.policy.state, "paused");
});

test("final precommit fences reject policy or accepted-context expiry without committing evidence", async t => {
  const policy = await scheduledFixture(); t.after(policy.close);
  const policyService = policy.createService(withBeforeCommit(policy.db, () => policy.setNow(instant + 250000)));
  await assert.rejects(policyService.plan(policy.operation), hasCode("policy_expired"));
  assert.equal(await count(policy, "control_scheduled_task_plans"), 0);

  const context = await scheduledFixture(fixture => acceptedContext(fixture, at(9000))); t.after(context.close);
  await context.service.plan(context.operation);
  const contextService = context.createService(withBeforeCommit(context.db, () => context.setNow(instant + 9000)));
  await assert.rejects(contextService.assign(context.operation), hasCode("context_unavailable"));
  assert.equal(await count(context, "control_scheduled_task_assignments"), 0);
  assert.equal(await count(context, "control_leases"), context.baseline.leases);
});

test("terminal synchronous fence catches time crossing after the last awaited validation", async t => {
  const policy = await scheduledFixture(); t.after(policy.close);
  let armed = false, samples = 0;
  const crossingClock = () => !armed ? instant + 8000 : ++samples === 1 ? instant + 8000 : instant + 250000;
  const service = policy.createService(withBeforeCommit(policy.db, () => { armed = true; }), crossingClock);
  await assert.rejects(service.plan(policy.operation), hasCode("policy_expired"));
  assert.equal(samples, 2); assert.equal(await count(policy, "control_scheduled_task_plans"), 0);

  const context = await scheduledFixture(fixture => acceptedContext(fixture, at(9000))); t.after(context.close);
  armed = false; samples = 0;
  const contextClock = () => !armed ? instant + 8000 : ++samples === 1 ? instant + 8000 : instant + 9000;
  await context.service.plan(context.operation);
  const assign = context.createService(withBeforeCommit(context.db, () => { armed = true; }), contextClock);
  await assert.rejects(assign.assign(context.operation), hasCode("context_unavailable"));
  assert.equal(samples, 2); assert.equal(await count(context, "control_scheduled_task_assignments"), 0);

  const grant = await scheduledFixture(); t.after(grant.close);
  await grant.db.query("UPDATE control_role_grants SET expires_at=$1 WHERE tenant_id=$2 AND identity_id=$3",
    [at(9000), grant.scope.tenantId, grant.policy.policy.ownerIdentityId]);
  armed = false; samples = 0;
  const grantClock = () => !armed ? instant + 8000 : ++samples === 1 ? instant + 8000 : instant + 9000;
  const grantService = grant.createService(withBeforeCommit(grant.db, () => { armed = true; }), grantClock);
  await assert.rejects(grantService.plan(grant.operation), hasCode("policy_not_active"));
  assert.equal(samples, 2); assert.equal(await count(grant, "control_scheduled_task_plans"), 0);

  const allocator = await scheduledFixture(); t.after(allocator.close); await allocator.service.plan(allocator.operation);
  armed = false; samples = 0;
  const deadlineClock = () => !armed ? instant + 8000 : ++samples === 1 ? instant + 8000 : instant + 68000;
  const allocatorService = allocator.createService(withBeforeCommit(allocator.db, () => { armed = true; }), deadlineClock);
  await assert.rejects(allocatorService.assign(allocator.operation), hasCode("assignment_conflict"));
  assert.equal(samples, 2); assert.equal(await count(allocator, "control_scheduled_task_assignments"), 0);
  assert.equal(await count(allocator, "control_leases"), allocator.baseline.leases);
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

  const suspended = await scheduledFixture(); t.after(suspended.close);
  await suspended.db.query("UPDATE control_identities SET state='suspended' WHERE tenant_id=$1 AND id=$2",
    [suspended.scope.tenantId, suspended.policy.policy.ownerIdentityId]);
  await assert.rejects(suspended.service.plan(suspended.operation), hasCode("policy_not_active"));
  assert.equal(await count(suspended, "control_scheduled_task_plans"), 0);

  const grantRemoved = await scheduledFixture(); t.after(grantRemoved.close);
  await grantRemoved.db.query("DELETE FROM control_role_grants WHERE tenant_id=$1 AND identity_id=$2",
    [grantRemoved.scope.tenantId, grantRemoved.policy.policy.ownerIdentityId]);
  await assert.rejects(grantRemoved.service.plan(grantRemoved.operation), hasCode("policy_not_active"));
  assert.equal(await count(grantRemoved, "control_scheduled_task_plans"), 0);
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
  await assigned.db.query("UPDATE control_identities SET state='suspended' WHERE tenant_id=$1 AND id=$2",
    [assigned.scope.tenantId, assigned.policy.policy.ownerIdentityId]);
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
  const f = await scheduledFixture(fixture => acceptedContext(fixture)); t.after(f.close);
  const plan = await f.service.plan(f.operation);
  const planned = (await f.db.query<{ payload: JobRecord }>("SELECT payload FROM control_jobs WHERE id=$1",
    [plan.receipt.plannedJobId])).rows[0].payload;
  const expectedInstructions = bindScheduledContextReferencesV1("Use only the supplied information.",
    f.operation.admission.contextBinding.reusableContexts);
  assert.equal(planned.inputDigest, sha256Digest({ prompt: f.sourceDraft.instructions, instructions: expectedInstructions }),
  "accepted context is part of the canonical plan input digest");
  const saved = await f.planner.read(plan.receipt.plannedJobId);
  assert.ok(saved && saved.input.instructions.includes(f.operation.admission.contextBinding.reusableContexts[0].contentHash));
  await f.db.query("ALTER TABLE control_completion_gate_records DISABLE TRIGGER control_completion_gate_records_append_only");
  await f.db.query("UPDATE control_completion_gate_records SET record_digest=$1 WHERE id=$2",
    [sha256Digest("altered"), f.operation.admission.contextBinding.reusableContexts[0].targetId]);
  await f.db.query("ALTER TABLE control_completion_gate_records ENABLE TRIGGER control_completion_gate_records_append_only");
  await assert.rejects(f.service.assign(f.operation), hasCode("context_unavailable"));
  assert.equal(await count(f, "control_scheduled_task_plans"), 1); assert.equal(await count(f, "control_leases"), f.baseline.leases);

  const unavailable = await scheduledFixture(async fixture => {
    const setup = await acceptedContext(fixture);
    setup.reusableContexts[0] = { ...setup.reusableContexts[0], targetId: "target:unprovable-context" };
    return setup;
  }); t.after(unavailable.close);
  await assert.rejects(unavailable.service.plan(unavailable.operation), hasCode("context_unavailable"));
  assert.equal(await count(unavailable, "control_scheduled_task_plans"), 0);

  const crossProject = await scheduledFixture(crossProjectAcceptedContext); t.after(crossProject.close);
  await assert.rejects(crossProject.service.plan(crossProject.operation), hasCode("context_unavailable"));
  assert.equal(await count(crossProject, "control_scheduled_task_plans"), 0);

  const empty = await scheduledFixture(); t.after(empty.close);
  await assert.rejects(empty.service.plan({ ...empty.operation, admission: {
    ...empty.admission.receipt, contextBinding: undefined } }), hasCode("admission_conflict"));
  assert.equal(await count(empty, "control_scheduled_task_plans"), 0);
});

test("scheduled context-bound input remains compatible with native approval binding", async t => {
  const f = await scheduledFixture(fixture => acceptedContext(fixture)); t.after(f.close);
  const result = await f.service.process(f.operation), saved = await f.planner.read(result.plan.receipt.plannedJobId);
  assert.ok(saved);
  const canonical = new CanonicalStore(f.db);
  const job = await canonical.get(f.scope.tenantId, "job", result.assignment.receipt.plannedJobId);
  const attempt = await canonical.get(f.scope.tenantId, "attempt", result.assignment.receipt.attemptId);
  const lease = await canonical.get(f.scope.tenantId, "lease", result.assignment.receipt.leaseId);
  assert.doesNotThrow(() => prepareNativeTaskApproval({ enrollment, nodeClass: "personal-compute", now: instant + 9000,
    input: saved.input, job, attempt, lease }));
  assert.deepEqual(Object.keys(saved.input).sort(), ["instructions", "prompt"]);
});

test("schedule pause after admission and before planning refuses without erasing admission", async t => {
  const f = await scheduledFixture(); t.after(f.close);
  await f.db.query("UPDATE control_schedules SET state='paused',payload=jsonb_set(payload,'{state}','\"paused\"'::jsonb) WHERE id=$1",
    [scheduleId]);
  await assert.rejects(f.service.plan(f.operation), hasCode("schedule_unavailable"));
  assert.equal(await count(f, "control_scheduled_task_admissions"), 1);
  assert.equal(await count(f, "control_scheduled_task_plans"), 0); assert.equal(await count(f, "control_leases"), f.baseline.leases);
});
