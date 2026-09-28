import assert from "node:assert/strict";
import test from "node:test";
import { hmacSha256Tag, sha256Digest } from "../src/security";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { binding, instant } from "./hermes-native-fixture";
import { TaskAssignmentCoordinator, type WorkBatchAssignmentAdmissionAuthority } from "../src/web/v1/task-assignment-coordinator";
import { workBatchProposalDigestV1 } from "../src/work-intake/v1";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion";

const recordedAt = "2026-09-04T12:00:08.000Z";
const integrityKey = new Uint8Array(32).fill(93);

function coordinator(f: Awaited<ReturnType<typeof taskAssignmentFixture>>,
  changes: Partial<WorkBatchAssignmentAdmissionAuthority> = {}) {
  const authority: WorkBatchAssignmentAdmissionAuthority = {
    integrityKey, assertCurrent: async () => {}, assertAcceptedResultCurrent: async () => {}, ...changes };
  return new TaskAssignmentCoordinator(f.db, f.scope, f.planner, [f.route], () => instant + 8_000,
    [], undefined, undefined, undefined, undefined, authority);
}
const assign = (f: Awaited<ReturnType<typeof taskAssignmentFixture>>,
  value = coordinator(f)) => value.assign(f.identity, binding.projectId, f.prepared.receipt.jobId,
    binding.nodeId, f.prepared.receipt.inputDigest);

async function seedAdmission(f: Awaited<ReturnType<typeof taskAssignmentFixture>>, input: {
  sourceJobId: string; executionJobId?: string; position: number; workerId?: string; model?: string;
}) {
  const workerId = input.workerId ?? f.route.executorId, model = input.model ?? "model:test";
  const suffix = sha256Digest({ sourceJobId: input.sourceJobId, position: input.position }).slice(-16);
  const batchId = `batch:gate:${suffix}`, itemId = `${batchId}:item`;
  const identityId = (await f.db.query<{ id: string }>(
    "SELECT id FROM control_identities WHERE tenant_id=$1 ORDER BY id LIMIT 1", [f.scope.tenantId])).rows[0]!.id;
  await f.db.query("DROP TRIGGER IF EXISTS work_batches_proposal_only ON work_batches");
  await f.db.query("DROP TRIGGER IF EXISTS work_batches_owner_update ON work_batches");
  await f.db.query("DROP TRIGGER IF EXISTS work_batch_items_guard ON work_batch_items");
  await f.db.query("DROP TRIGGER IF EXISTS work_batch_queue_admissions_guard ON work_batch_queue_admissions");
  await f.db.query("DROP TRIGGER IF EXISTS work_batch_agent_queue_heads_guard ON work_batch_agent_queue_heads");
  await f.db.query("DROP TRIGGER IF EXISTS work_batch_agent_queue_heads_consistency ON work_batch_agent_queue_heads");
  const proposal = { schema: "control-room.work-batch-proposal/v1" as const, projectId: binding.projectId,
    tasks: [{ localId: "gate", title: "Gate assignment", instructions: "Exercise the batch assignment gate.",
      requiredCapability: "code.change", role: "builder" as const, requestedWorkerId: workerId,
      requestedWorkerKind: "hermes" as const, requestedModelKey: model,
      acceptanceCriteria: "The admission is exact.", acceptanceTests: "Run focused tests." }], edges: [] };
  const batchDigest = workBatchProposalDigestV1(proposal);
  const batchMaterial = { id: batchId, tenantId: f.scope.tenantId, projectId: binding.projectId,
    proposedByIdentityId: identityId, proposedAt: recordedAt, state: "proposed", proposal,
    queueDepthLimit: 10, batchDigest, version: 1, createdAt: recordedAt, updatedAt: recordedAt };
  const batchTag = hmacSha256Tag(integrityKey, { purpose: "work-batch/v1", record: batchMaterial });
  const itemMaterial = { id: itemId, tenantId: f.scope.tenantId, batchId, batchRevision: 1,
    projectId: binding.projectId, localId: "gate", ordinal: 0, role: "builder", requiredCapability: "code.change",
    dependsOnLocalIds: [], requestedWorkerId: workerId, requestedWorkerKind: "hermes", requestedModelKey: model,
    acceptanceCriteria: "The admission is exact.", acceptanceTests: "Run focused tests.",
    decisionState: "approved", decisionReasonCode: null, jobId: input.sourceJobId, jobAttemptCount: 0, createdAt: recordedAt };
  const itemDigest = sha256Digest(itemMaterial);
  const itemTag = hmacSha256Tag(integrityKey, { purpose: "work-batch-item/v1", record: itemMaterial });
  const decisionMaterial = { id: `${batchId}:decision`, tenantId: f.scope.tenantId, batchId,
    projectId: binding.projectId, batchRevision: 1, state: "approved", approvalIdentityId: identityId,
    approvedAt: recordedAt, decisionReasonCode: null, itemDigests: [itemDigest] };
  const decisionDigest = sha256Digest(decisionMaterial);
  const decisionTag = hmacSha256Tag(integrityKey, { purpose: "work-batch-decision/v1", record: decisionMaterial });
  await f.db.query(`INSERT INTO work_batches(id,tenant_id,project_id,proposed_by_identity_id,proposed_by_actor_type,
    proposed_at,state,approval_identity_id,approved_at,proposal,queue_depth_limit,batch_digest,auth_tag,version,
    decision_digest,decision_auth_tag,created_at,updated_at)
    VALUES($1,$2,$3,$4,'agent',$5,'approved',$4,$5,$6::jsonb,10,$7,$8,1,$9,$10,$5,$5)`,
  [batchId, f.scope.tenantId, binding.projectId, identityId, recordedAt, JSON.stringify(proposal), batchDigest,
    batchTag, decisionDigest, decisionTag]);
  await f.db.query(`INSERT INTO work_batch_items(id,tenant_id,batch_id,batch_revision,project_id,local_id,ordinal,
    role,required_capability,depends_on_local_ids,requested_worker_id,requested_worker_kind,requested_model_key,acceptance_criteria,
    acceptance_tests,decision_state,job_id,item_digest,auth_tag,created_at)
    VALUES($1,$2,$3,1,$4,'gate',0,'builder','code.change','{}',$5,'hermes',$6,'The admission is exact.','Run focused tests.',
      'approved',$7,$8,$9,$10)`, [itemId, f.scope.tenantId, batchId, binding.projectId, workerId, model,
    input.sourceJobId, itemDigest, itemTag, recordedAt]);
  await f.db.query(`INSERT INTO work_batch_agent_queue_heads(tenant_id,worker_id,next_position,updated_at)
    VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,worker_id) DO UPDATE
    SET next_position=greatest(work_batch_agent_queue_heads.next_position,excluded.next_position),updated_at=excluded.updated_at`,
  [f.scope.tenantId, workerId, input.position + 1, recordedAt]);
  const admissionMaterial = { itemId, batchId, projectId: binding.projectId, jobId: input.sourceJobId,
    workerId, workerKind: "hermes", nodeId: f.route.nodeId, position: input.position, queueDepthLimit: 10,
    selectionKey: model, model, effort: "high", provider: "provider:test", profile: "profile:test",
    assignmentRevision: 1, supersedesAdmissionId: null, changeReasonCode: "initial_owner_approval",
    authorizedByIdentityId: identityId, admittedAt: recordedAt };
  const admissionDigest = sha256Digest(admissionMaterial);
  const admissionId = `admission:${admissionDigest.slice(7)}`;
  const admissionTag = hmacSha256Tag(integrityKey, { purpose: "work-batch-queue-admission/v1", record: admissionMaterial });
  await f.db.query(`INSERT INTO work_batch_queue_admissions(tenant_id,admission_id,item_id,batch_id,project_id,job_id,worker_id,
    worker_kind,node_id,queue_position,queue_depth_limit,selection_key,model,effort,provider,profile,
    assignment_revision,supersedes_admission_id,change_reason_code,authorized_by_identity_id,
    admission_digest,auth_tag,admitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,'hermes',$8,$9,10,$10,$10,'high',
      'provider:test','profile:test',1,NULL,'initial_owner_approval',$11,$12,$13,$14)`,
  [f.scope.tenantId, admissionId, itemId, batchId, binding.projectId, input.sourceJobId, workerId,
    f.route.nodeId, input.position, model, identityId, admissionDigest, admissionTag, recordedAt]);
  if (input.executionJobId) await f.db.query(`INSERT INTO control_task_model_selections
    (tenant_id,project_id,job_id,worker_kind,selection_key,model,effort,provider,profile,created_at)
    VALUES($1,$2,$3,'hermes','model:test','model:test','high','provider:test','profile:test',$4)
    ON CONFLICT(tenant_id,job_id) DO UPDATE SET worker_kind=excluded.worker_kind,selection_key=excluded.selection_key,
      model=excluded.model,effort=excluded.effort,provider=excluded.provider,profile=excluded.profile`,
  [f.scope.tenantId, binding.projectId, input.executionJobId, recordedAt]);
}

test("batch assignment follows source-to-execution lineage and locks the exact worker and model", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  await seedAdmission(f, { sourceJobId: f.source.receipt.jobId, executionJobId: f.prepared.receipt.jobId, position: 1 });
  const assigned = await assign(f);
  assert.equal(assigned.receipt.nodeId, f.route.nodeId);
  const attempt = (await f.db.query<{ worker_id: string }>(
    "SELECT worker_id FROM control_attempts WHERE tenant_id=$1 AND job_id=$2",
  [f.scope.tenantId, f.prepared.receipt.jobId])).rows[0];
  assert.equal(attempt?.worker_id, f.route.executorId);

  const wrong = await taskAssignmentFixture(); t.after(wrong.close);
  await seedAdmission(wrong, { sourceJobId: wrong.source.receipt.jobId,
    executionJobId: wrong.prepared.receipt.jobId, position: 1, model: "model:other" });
  await assert.rejects(assign(wrong), (error: unknown) => (error as { code?: string }).code === "conflict");

  const wrongWorker = await taskAssignmentFixture(); t.after(wrongWorker.close);
  await seedAdmission(wrongWorker, { sourceJobId: wrongWorker.source.receipt.jobId,
    executionJobId: wrongWorker.prepared.receipt.jobId, position: 1, workerId: "executor:other" });
  await assert.rejects(assign(wrongWorker), (error: unknown) => (error as { code?: string }).code === "conflict");
});

test("batch assignment waits for source dependencies even though the prepared job has no dependency edge", async t => {
  const f = await taskAssignmentFixture(async base => {
    const first = { title: "Batch predecessor", instructions: "Produce retained evidence first." };
    const predecessor = await base.tasks.propose(base.identity, binding.projectId, first, "batch-gate-predecessor-0001");
    const dependent = { title: "Batch dependent", instructions: "Continue only after retained evidence." };
    const source = await base.tasks.proposeWithDependencies(base.identity, binding.projectId, dependent,
      "batch-gate-dependent-0001", [predecessor.receipt.jobId]);
    return { draft: dependent, source };
  });
  t.after(f.close);
  await seedAdmission(f, { sourceJobId: f.source.receipt.jobId, executionJobId: f.prepared.receipt.jobId, position: 1 });
  await assert.rejects(assign(f), (error: unknown) => (error as { code?: string }).code === "conflict");
});

test("batch assignment waits behind every earlier admission for the same exact worker", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const earlier = await f.tasks.propose(f.identity, binding.projectId,
    { title: "Earlier admitted work", instructions: "This item has not completed." }, "batch-gate-earlier-0001");
  await seedAdmission(f, { sourceJobId: earlier.receipt.jobId, position: 1 });
  await seedAdmission(f, { sourceJobId: f.source.receipt.jobId, executionJobId: f.prepared.receipt.jobId, position: 2 });
  await assert.rejects(assign(f), (error: unknown) => (error as { code?: string }).code === "conflict");
});

test("batch-linked work fails closed without authority, admission, or intact authentication", async t => {
  const absentAuthority = await taskAssignmentFixture(); t.after(absentAuthority.close);
  await seedAdmission(absentAuthority, { sourceJobId: absentAuthority.source.receipt.jobId,
    executionJobId: absentAuthority.prepared.receipt.jobId, position: 1 });
  await assert.rejects(absentAuthority.assign(), (error: unknown) => (error as { code?: string }).code === "conflict");

  const absentAdmission = await taskAssignmentFixture(); t.after(absentAdmission.close);
  await seedAdmission(absentAdmission, { sourceJobId: absentAdmission.source.receipt.jobId,
    executionJobId: absentAdmission.prepared.receipt.jobId, position: 1 });
  await absentAdmission.db.query("DROP TRIGGER work_batch_queue_admissions_append_only ON work_batch_queue_admissions");
  await absentAdmission.db.query("DELETE FROM work_batch_queue_admissions");
  await assert.rejects(assign(absentAdmission), (error: unknown) => (error as { code?: string }).code === "conflict");

  const tampered = await taskAssignmentFixture(); t.after(tampered.close);
  await seedAdmission(tampered, { sourceJobId: tampered.source.receipt.jobId,
    executionJobId: tampered.prepared.receipt.jobId, position: 1 });
  await tampered.db.query("DROP TRIGGER work_batch_queue_admissions_append_only ON work_batch_queue_admissions");
  await tampered.db.query("UPDATE work_batch_queue_admissions SET auth_tag=$1", [`hmac-sha256:${"0".repeat(64)}`]);
  await assert.rejects(assign(tampered), (error: unknown) => (error as { code?: string }).code === "conflict");
});

test("protected readiness and model policy are revalidated with the exact authenticated selection", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  await seedAdmission(f, { sourceJobId: f.source.receipt.jobId, executionJobId: f.prepared.receipt.jobId, position: 1 });
  let observed = 0;
  const ready = coordinator(f, { assertCurrent: async (_tx, input) => {
    observed += 1;
    assert.deepEqual({ workerId: input.workerId, nodeId: input.nodeId, selectionKey: input.selectionKey,
      model: input.model, effort: input.effort, provider: input.provider, profile: input.profile },
    { workerId: f.route.executorId, nodeId: f.route.nodeId, selectionKey: "model:test",
      model: "model:test", effort: "high", provider: "provider:test", profile: "profile:test" });
  } });
  await assign(f, ready);
  assert.equal(observed, 1);

  const drift = await taskAssignmentFixture(); t.after(drift.close);
  await seedAdmission(drift, { sourceJobId: drift.source.receipt.jobId,
    executionJobId: drift.prepared.receipt.jobId, position: 1 });
  const refused = coordinator(drift, { assertCurrent: async () => { throw new Error("policy_drift"); } });
  await assert.rejects(assign(drift, refused), (error: unknown) => (error as { code?: string }).code === "conflict");
});

test("every protected local pickup revalidates batch admission immediately before transition authority", () => {
  for (const name of ["locateApprovedHermes021LocalQueueDelivery", "locateApprovedHermesLocalQueueDelivery",
    "locateApprovedClaudeCodeLocalQueueDelivery", "locateApprovedCodexOwnerTrustedLocalQueueDelivery"] as const) {
    const source = TaskAssignmentCoordinator.prototype[name].toString();
    const admission = source.indexOf("assertWorkBatchQueueAdmission");
    const transition = source.indexOf("assertTransitionAdmission");
    assert.ok(admission >= 0, `${name} must revalidate the effective batch admission at pickup`);
    assert.ok(transition > admission, `${name} must revalidate batch admission before transition authority`);
  }
});

test("the pickup admission gate refuses readiness and effective-revision drift after assignment", async t => {
  const readiness = await taskAssignmentFixture(); t.after(readiness.close);
  await seedAdmission(readiness, { sourceJobId: readiness.source.receipt.jobId,
    executionJobId: readiness.prepared.receipt.jobId, position: 1 });
  let current = true;
  const guarded = coordinator(readiness, { assertCurrent: async () => { if (!current) throw new Error("policy_drift"); } });
  await assign(readiness, guarded);
  const internal = guarded as unknown as {
    job(tx: typeof readiness.db, projectId: string, jobId: string): Promise<unknown>;
    assertWorkBatchQueueAdmission(tx: typeof readiness.db, job: unknown, route: typeof readiness.route,
      workerId: string | null): Promise<boolean>;
  };
  const job = await internal.job(readiness.db, binding.projectId, readiness.prepared.receipt.jobId);
  current = false;
  await assert.rejects(internal.assertWorkBatchQueueAdmission(readiness.db, job, readiness.route,
    readiness.route.executorId), (error: unknown) => (error as { code?: string }).code === "conflict");

  const revision = await taskAssignmentFixture(); t.after(revision.close);
  await seedAdmission(revision, { sourceJobId: revision.source.receipt.jobId,
    executionJobId: revision.prepared.receipt.jobId, position: 1 });
  const revisionGate = coordinator(revision);
  await assign(revision, revisionGate);
  const prior = (await revision.db.query<{ admission_id: string; item_id: string; batch_id: string;
    authorized_by_identity_id: string; admitted_at: string | Date }>(`SELECT admission_id,item_id,batch_id,
      authorized_by_identity_id,admitted_at FROM work_batch_effective_queue_admissions WHERE tenant_id=$1`,
  [revision.scope.tenantId])).rows[0]!;
  const changed = { itemId: prior.item_id, batchId: prior.batch_id, projectId: binding.projectId,
    jobId: revision.source.receipt.jobId, workerId: revision.route.executorId, workerKind: "hermes",
    nodeId: revision.route.nodeId, position: 2, queueDepthLimit: 10, selectionKey: "model:changed",
    model: "model:changed", effort: "high", provider: "provider:test", profile: "profile:test",
    assignmentRevision: 2, supersedesAdmissionId: prior.admission_id, changeReasonCode: "owner_reassigned",
    authorizedByIdentityId: prior.authorized_by_identity_id, admittedAt: new Date(prior.admitted_at).toISOString() };
  const digest = sha256Digest(changed);
  await revision.db.query(`UPDATE work_batch_agent_queue_heads SET next_position=3,updated_at=$3
    WHERE tenant_id=$1 AND worker_id=$2`, [revision.scope.tenantId, revision.route.executorId, changed.admittedAt]);
  await revision.db.query(`INSERT INTO work_batch_queue_admissions(tenant_id,admission_id,item_id,batch_id,project_id,
    job_id,worker_id,worker_kind,node_id,queue_position,queue_depth_limit,selection_key,model,effort,provider,profile,
    assignment_revision,supersedes_admission_id,change_reason_code,authorized_by_identity_id,admission_digest,auth_tag,admitted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'hermes',$8,2,10,'model:changed','model:changed','high','provider:test','profile:test',
      2,$9,'owner_reassigned',$10,$11,$12,$13)`, [revision.scope.tenantId, `admission:${digest.slice(7)}`, prior.item_id,
    prior.batch_id, binding.projectId, revision.source.receipt.jobId, revision.route.executorId, revision.route.nodeId,
    prior.admission_id, prior.authorized_by_identity_id, digest,
    hmacSha256Tag(integrityKey, { purpose: "work-batch-queue-admission/v1", record: changed }), changed.admittedAt]);
  const revisionInternal = revisionGate as unknown as typeof internal;
  const revisionJob = await revisionInternal.job(revision.db, binding.projectId, revision.prepared.receipt.jobId);
  await assert.rejects(revisionInternal.assertWorkBatchQueueAdmission(revision.db, revisionJob, revision.route,
    revision.route.executorId), (error: unknown) => (error as { code?: string }).code === "conflict");
});

test("an authenticated accepted predecessor proof permits the next exact admission and rejects callback substitution", async t => {
  const quality = await nativeQualityCompletionFixture(); t.after(quality.close);
  await quality.ready(); await quality.complete();
  const base = quality.f.assignmentFixture;
  const dependentDraft = { title: "Continue after accepted evidence", instructions: "Use the accepted retained result." };
  const dependentSource = await base.tasks.proposeWithDependencies(base.identity, binding.projectId, dependentDraft,
    "batch-gate-accepted-dependent-0001", [base.source.receipt.jobId]);
  const dependentPrepared = await base.planner.plan(base.identity, binding.projectId, dependentSource.receipt.jobId,
    sha256Digest(dependentDraft));
  const dependent = { ...base, source: dependentSource, prepared: dependentPrepared };
  await seedAdmission(base, { sourceJobId: base.source.receipt.jobId, position: 1 });
  await seedAdmission(dependent, { sourceJobId: dependentSource.receipt.jobId,
    executionJobId: dependentPrepared.receipt.jobId, position: 2 });
  let accepted = 0;
  const allowed = coordinator(dependent, { assertAcceptedResultCurrent: async (_tx, proof) => {
    accepted += 1;
    assert.equal(proof.sourceJobId, base.source.receipt.jobId);
    assert.equal(proof.executionJobId, base.prepared.receipt.jobId);
    assert.equal(proof.attemptId, quality.registration.attemptId);
    assert.equal(proof.runId, quality.registration.id);
    assert.equal(proof.artifactId, quality.artifact.artifactId);
    assert.equal(proof.contentHash, quality.request.contentHash);
    assert.equal(proof.targetId, quality.target.id);
    assert.equal(proof.targetDigest, quality.request.targetDigest);
    assert.equal(proof.workerId, base.route.executorId);
    assert.equal(proof.nodeId, base.route.nodeId);
  } });
  await assign(dependent, allowed);
  assert.equal(accepted, 1);

  const substituted = coordinator(dependent, { assertAcceptedResultCurrent: async () => {
    throw new Error("completion_context_substituted");
  } });
  await assert.rejects(assign(dependent, substituted), (error: unknown) => (error as { code?: string }).code === "conflict");
});
