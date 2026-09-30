import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LinearPipelineServiceV1 } from "../src/pipelines/v1";
import { hmacSha256Tag, sha256Digest } from "../src/security";
import { createLinearPipelineHttpHandlerV1 } from "../src/web/v1/linear-pipeline-http";
import { TaskAssignmentCoordinator, type TaskAssignmentRoute,
  type WorkBatchAssignmentAdmissionAuthority } from "../src/web/v1/task-assignment-coordinator";
import type { JobRecord } from "../src/domain/v1";
import { taskDraft, taskFixture } from "./helpers/web-task";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { taskStartupFixture } from "./helpers/task-startup";
import { TaskExecutionPlanner } from "../src/web/v1/task-execution-planner";
import { now, origin, request, trust } from "./helpers/web-foundation";
import { binding, instant } from "./hermes-native-fixture";
import { nativeQualityCompletionFixture, qualityText } from "./helpers/native-quality-completion";

const key = new Uint8Array(32).fill(12);
const template = { name: "Build, check, validate", description: "Complete one bounded change and review it.",
  stages: [
    { ordinal: 0, stageKind: "build", role: "builder", description: "Build the bounded change.",
      allowedPaths: ["src/**"], maximumChangedFiles: 20, maximumChangedBytes: 262144,
      requiredCapability: "code.change", workerId: "worker:codex:one", workerKind: "codex", nodeId: "node:codex:one",
      selectionKey: "codex.standard", model: "gpt-test", effort: "medium", maxLoops: 3 },
    { ordinal: 1, stageKind: "check", role: "checker", description: "Check the bounded change.",
      requiredCapability: "code.review", workerId: "worker:claude:one", workerKind: "claude-code", nodeId: "node:claude:one",
      selectionKey: "claude.standard", model: "claude-test", effort: "high", maxLoops: 3 },
    { ordinal: 2, stageKind: "signoff", role: "validator", description: "Validate the accepted result.",
      requiredCapability: "code.validate", workerId: "worker:hermes:one", workerKind: "hermes", nodeId: "node:hermes:one",
      selectionKey: "hermes.standard", model: "hermes-test", effort: "medium", provider: "provider:test",
      profile: "profile:test", maxLoops: 0 },
  ], maxTotalLoops: 6, maxDurationSeconds: 3600 } as const;

async function fixture() {
  const f = await taskFixture();
  const service = new LinearPipelineServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => now);
  return { ...f, projects: f.service, service };
}

async function completedPredecessorFixture(options: { productionCoordinatorLogin?: boolean } = {}) {
  let runJobIds: readonly string[] = [];
  const pipelineKey = new Uint8Array(32).fill(55);
  const quality = await nativeQualityCompletionFixture(qualityText, async base => {
    const service = new LinearPipelineServiceV1(base.db, base.scope, pipelineKey,
      { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => instant + 5000);
    const stages = template.stages.map(stage => ({ ...stage, workerId: "executor:hermes-native", workerKind: "hermes" as const,
      nodeId: binding.nodeId, provider: "provider:test", profile: "profile:test" }));
    const saved = await service.createTemplate(base.identity, binding.projectId, { ...template, stages });
    const run = await service.instantiate(base.identity, binding.projectId,
      { templateId: saved.templateId, title: "Authenticated predecessor" }, "linear-completed-predecessor-0001");
    runJobIds = run.jobIds;
    // Stage zero keeps its lineage and runs the whole native lifecycle through
    // the real pipeline gate; its retained completion proof is what the
    // stage-one admission below consumes.
    return { draft: { title: "Authenticated predecessor", instructions: template.description },
      source: { receipt: { jobId: run.jobIds[0]! } },
      admission: { integrityKey: pipelineKey, assertCurrent: async () => {}, assertAcceptedResultCurrent: async () => {} } };
  });
  await quality.ready(); await quality.complete();
  const base = quality.f.assignmentFixture;
  // Production composes the planner and the assignment coordinator on the
  // coordinator login (task-coordinator-lifecycle.ts). With the option set,
  // both run as a LOGIN role that inherits exactly the real
  // db/roles/task_coordinator_roles.sql grants instead of the superuser.
  const db = options.productionCoordinatorLogin ? (await taskStartupFixture(base)).coordinator.client : base.db;
  const planner = options.productionCoordinatorLogin
    ? new TaskExecutionPlanner(db, base.scope, base.plannerConfig, () => instant + 7000) : base.planner;
  const expected = sha256Digest({ title: "Authenticated predecessor", instructions: template.description });
  const prepared = await planner.plan(base.identity, binding.projectId, runJobIds[1]!, expected);
  let acceptedChecks = 0;
  const authority: WorkBatchAssignmentAdmissionAuthority = { integrityKey: pipelineKey,
    assertCurrent: async () => {}, assertAcceptedResultCurrent: async () => { acceptedChecks += 1; } };
  const coordinator = new TaskAssignmentCoordinator(db, base.scope, planner, [base.route], () => instant + 8000,
    [], undefined, undefined, undefined, undefined, authority);
  const assign = () => coordinator.assign(base.identity, binding.projectId, prepared.receipt.jobId,
    binding.nodeId, prepared.receipt.inputDigest);
  return { quality, base, runJobIds, prepared, assign, acceptedChecks: () => acceptedChecks };
}

test("a linear pipeline materializes one canonical request/workflow and three inert dependent jobs", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const saved = await f.service.createTemplate(f.identity, f.project.projectId, template);
  const first = await f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Ship the bounded slice" }, "linear-pipeline-run-0001");
  assert.equal(first.replayed, false); assert.equal(first.startsWork, false); assert.equal(first.jobIds.length, 3);
  assert.equal((await f.db.query("SELECT 1 FROM control_requests WHERE id=$1", [first.requestId])).rows.length, 1);
  assert.equal((await f.db.query("SELECT 1 FROM control_workflows WHERE id=$1", [first.workflowId])).rows.length, 1);
  assert.equal((await f.db.query("SELECT 1 FROM pipeline_runs WHERE id=$1", [first.runId])).rows.length, 1);
  assert.deepEqual((await f.db.query<{ stage_kind: string; stage_ordinal: number }>(`SELECT stage_kind,stage_ordinal
    FROM pipeline_stage_runs WHERE pipeline_run_id=$1 ORDER BY stage_ordinal`, [first.runId])).rows,
  [{ stage_kind: "build", stage_ordinal: 0 }, { stage_kind: "check", stage_ordinal: 1 },
    { stage_kind: "signoff", stage_ordinal: 2 }]);
  assert.equal((await f.db.query("SELECT 1 FROM control_job_dependencies WHERE job_id=$1 AND depends_on_job_id=$2",
    [first.jobIds[1], first.jobIds[0]])).rows.length, 1);
  assert.equal((await f.db.query("SELECT 1 FROM control_job_dependencies WHERE job_id=$1 AND depends_on_job_id=$2",
    [first.jobIds[2], first.jobIds[1]])).rows.length, 1);
  const canonical = (await f.db.query<{ input_digest: string; title: string; objective: string }>(`SELECT j.payload->>'inputDigest' input_digest,
    r.payload->>'title' title,r.payload->>'objective' objective FROM control_jobs j JOIN control_workflows w
      ON w.tenant_id=j.tenant_id AND w.id=j.workflow_id JOIN control_requests r ON r.tenant_id=w.tenant_id AND r.id=w.request_id
    WHERE j.tenant_id='tenant:web' AND j.pipeline_run_id=$1 ORDER BY j.stage_ordinal`, [first.runId])).rows;
  assert.ok(canonical.every(row => row.input_digest === sha256Digest({ title: row.title, instructions: row.objective })));
  assert.equal(new Set(canonical.map(row => `${row.title}\0${row.objective}`)).size, 1);
  for (const table of ["control_attempts", "control_leases", "control_native_task_queue", "control_outbox"])
    assert.equal((await f.db.query(`SELECT 1 FROM ${table} WHERE tenant_id='tenant:web'`)).rows.length, 0);
  const view = await f.service.view(f.identity, f.project.projectId, first.runId);
  assert.deepEqual(view.stages.map(stage => stage.state), ["eligible", "waiting_dependency", "waiting_dependency"]);
  assert.deepEqual(view.stages.map(stage => stage.usage), ["unknown", "unknown", "unknown"]);
  await assert.rejects(f.service.view(f.identity, "project:other", first.runId), /not_found/u);
});

test("pipeline instantiation replays exactly and changed content under one key is refused", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const saved = await f.service.createTemplate(f.identity, f.project.projectId, template);
  const first = await f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Exact replay" }, "linear-pipeline-replay-0001");
  const replay = await f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Exact replay" }, "linear-pipeline-replay-0001");
  assert.equal(replay.runId, first.runId); assert.equal(replay.replayed, true);
  await assert.rejects(f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Changed replay" }, "linear-pipeline-replay-0001"), /conflict/u);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int count FROM pipeline_runs")).rows[0]!.count, 1);
});

test("pre-0098 authenticated pipelines remain readable but cannot publish or instantiate without owner revision", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const saved = await f.service.createTemplate(f.identity, f.project.projectId, template);
  const run = await f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Legacy upgrade fixture" }, "linear-legacy-upgrade-0001");
  const templateRow = (await f.db.query<{ id: string; project_id: string; name: string; description: string;
    stages: Array<Record<string, unknown>>; max_stages: number; max_total_loops: number;
    may_advance_unattended: boolean; max_duration_seconds: number; version: number;
    created_at: string | Date; updated_at: string | Date }>(`SELECT id,project_id,name,description,stages,max_stages,
      max_total_loops,may_advance_unattended,max_duration_seconds,version,created_at,updated_at
      FROM pipeline_templates WHERE id=$1`, [saved.templateId])).rows[0]!;
  const legacyStages = templateRow.stages.map(stage => {
    if (stage.stageKind !== "build") return stage;
    const { allowedPaths: _paths, maximumChangedFiles: _files, maximumChangedBytes: _bytes, ...legacy } = stage;
    return legacy;
  });
  const templateMaterial = { id: templateRow.id, tenantId: "tenant:web", projectId: templateRow.project_id,
    name: templateRow.name, description: templateRow.description, stages: legacyStages,
    maxStages: Number(templateRow.max_stages), maxTotalLoops: Number(templateRow.max_total_loops),
    mayAdvanceUnattended: false, maxDurationSeconds: Number(templateRow.max_duration_seconds),
    version: Number(templateRow.version), createdAt: new Date(templateRow.created_at).toISOString(),
    updatedAt: new Date(templateRow.updated_at).toISOString() };
  const legacyTemplateDigest = sha256Digest(templateMaterial);
  await f.db.query(`UPDATE pipeline_templates SET stages=$1::jsonb,record_digest=$2,auth_tag=$3 WHERE id=$4`,
    [JSON.stringify(legacyStages), legacyTemplateDigest,
      hmacSha256Tag(key, { purpose: "pipeline-template/v1", record: templateMaterial }), saved.templateId]);

  const runRow = (await f.db.query<{ id: string; project_id: string; request_id: string; template_id: string;
    template_version: number; workflow_id: string; title: string; state: string; started_at: string | Date | null;
    updated_at: string | Date; completed_at: string | Date | null; current_stage_ordinal: number | null;
    unattended: boolean; version: number }>(`SELECT id,project_id,request_id,template_id,template_version,workflow_id,title,
      state,started_at,updated_at,completed_at,current_stage_ordinal,unattended,version FROM pipeline_runs WHERE id=$1`,
  [run.runId])).rows[0]!;
  const runMaterial = { id: runRow.id, tenantId: "tenant:web", projectId: runRow.project_id,
    requestId: runRow.request_id, templateId: runRow.template_id, templateVersion: Number(runRow.template_version),
    templateDigest: legacyTemplateDigest, workflowId: runRow.workflow_id, title: runRow.title, state: runRow.state,
    startedAt: runRow.started_at ? new Date(runRow.started_at).toISOString() : null,
    updatedAt: new Date(runRow.updated_at).toISOString(),
    completedAt: runRow.completed_at ? new Date(runRow.completed_at).toISOString() : null,
    currentStageOrdinal: runRow.current_stage_ordinal === null ? null : Number(runRow.current_stage_ordinal),
    unattended: runRow.unattended, version: Number(runRow.version) };
  await f.db.query(`UPDATE pipeline_runs SET template_digest=$1,record_digest=$2,auth_tag=$3 WHERE id=$4`,
    [legacyTemplateDigest, sha256Digest(runMaterial),
      hmacSha256Tag(key, { purpose: "pipeline-run/v1", record: runMaterial }), run.runId]);

  const stage = (await f.db.query<Record<string, unknown>>(`SELECT * FROM pipeline_stage_runs
    WHERE pipeline_run_id=$1 AND stage_ordinal=0`, [run.runId])).rows[0]!;
  const stageMaterial = { id: stage.id, tenantId: "tenant:web", projectId: stage.project_id,
    pipelineRunId: stage.pipeline_run_id, stageOrdinal: Number(stage.stage_ordinal), stageKind: stage.stage_kind,
    role: stage.role, workerId: stage.worker_id, workerKind: stage.worker_kind, nodeId: stage.node_id,
    selectionKey: stage.selection_key, model: stage.model, effort: stage.effort, provider: stage.provider,
    profile: stage.profile, currentJobId: stage.current_job_id, currentAttemptId: stage.current_attempt_id,
    currentLeaseId: stage.current_lease_id, state: stage.state, maxLoops: Number(stage.max_loops),
    handoffFromResultDigest: stage.handoff_from_result_digest, signoffReviewId: stage.signoff_review_id,
    startedAt: stage.started_at ? new Date(stage.started_at as string | Date).toISOString() : null,
    finishedAt: stage.finished_at ? new Date(stage.finished_at as string | Date).toISOString() : null,
    version: Number(stage.version) };
  await f.db.exec("ALTER TABLE pipeline_stage_runs DISABLE TRIGGER pipeline_stage_runs_guard");
  await f.db.query(`UPDATE pipeline_stage_runs SET allowed_paths=NULL,maximum_changed_files=NULL,
    maximum_changed_bytes=NULL,record_digest=$1,auth_tag=$2 WHERE pipeline_run_id=$3 AND stage_ordinal=0`,
  [sha256Digest(stageMaterial), hmacSha256Tag(key, { purpose: "pipeline-stage-run/v1", record: stageMaterial }), run.runId]);
  await f.db.exec("ALTER TABLE pipeline_stage_runs ENABLE TRIGGER pipeline_stage_runs_guard");

  const view = await f.service.view(f.identity, f.project.projectId, run.runId);
  assert.equal(view.stages[0]?.writePolicy, null, "the authenticated legacy row is readable without invented bounds");
  await assert.rejects(f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Legacy must be revised" }, "linear-legacy-upgrade-0002"), /conflict/u);
});

test("pipeline instantiation screens secret-shaped titles before persistence", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const saved = await f.service.createTemplate(f.identity, f.project.projectId, template);
  await assert.rejects(f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "api_key=synthetic-value-123456" }, "linear-secret-screen-0001"), /invalid_request/u);
  assert.equal((await f.db.query("SELECT 1 FROM pipeline_runs")).rows.length, 0);
});

test("template creation authorizes before consulting protected selection and instantiation revalidates it", async t => {
  const f = await taskFixture(); t.after(() => void f.db.close());
  let selectionChecks = 0, current = true;
  const service = new LinearPipelineServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key,
    { assertCurrent: () => { selectionChecks += 1; return current; }, isAcceptedResultCurrent: () => false }, () => now);
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["tasks.read"]'::jsonb
    WHERE tenant_id='tenant:web' AND identity_id='identity:web'`);
  await assert.rejects(service.createTemplate(f.identity, f.project.projectId, template), /access_denied/u);
  assert.equal(selectionChecks, 0);
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["*"]'::jsonb
    WHERE tenant_id='tenant:web' AND identity_id='identity:web'`);
  const saved = await service.createTemplate(f.identity, f.project.projectId, template);
  assert.equal(selectionChecks, 3);
  current = false;
  await assert.rejects(service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Policy changed" }, "linear-policy-change-0001"), /conflict/u);
  assert.equal(selectionChecks, 4);
});

test("pipeline reads fail closed on template, run, or stage tampering and display only exact accepted proof", async t => {
  const f = await taskFixture(); t.after(() => void f.db.close());
  const exact = sha256Digest("accepted retained bytes");
  const service = new LinearPipelineServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => true,
      acceptedResultProof: (_tx, selection) => selection.sourceJobId.endsWith(":0")
        ? { executionJobId: "job:execution:0", attemptId: "attempt:0", harnessRunId: "run:0",
          artifactId: "artifact:0", contentHash: exact, revision: 7 } : null }, () => now);
  const saved = await service.createTemplate(f.identity, f.project.projectId, template);
  const run = await service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Authenticated read" }, "linear-authenticated-read-0001");
  const view = await service.view(f.identity, f.project.projectId, run.runId);
  assert.equal(view.stages[0]?.round, 7);
  assert.equal(view.stages[1]?.predecessorResultDigest, exact);
  await f.db.query("UPDATE pipeline_stage_runs SET record_digest=$1 WHERE current_job_id=$2",
    [sha256Digest("tampered stage"), run.jobIds[1]]);
  await assert.rejects(service.view(f.identity, f.project.projectId, run.runId), /pipeline_integrity_failed/u);
  await f.db.query("UPDATE pipeline_stage_runs SET record_digest=$1 WHERE current_job_id=$2",
    [sha256Digest("tampered again"), run.jobIds[1]]);
  await f.db.query("UPDATE pipeline_runs SET title='tampered run' WHERE id=$1", [run.runId]);
  await assert.rejects(service.list(f.identity, f.project.projectId), /pipeline_integrity_failed/u);
  await f.db.query("UPDATE pipeline_runs SET title='Authenticated read' WHERE id=$1", [run.runId]);
  await f.db.query("UPDATE pipeline_templates SET description='tampered template' WHERE id=$1", [saved.templateId]);
  await assert.rejects(service.list(f.identity, f.project.projectId), /pipeline_integrity_failed/u);
});

test("planner propagates pipeline lineage and assignment revalidates stage zero selection plus later dependency edge", async t => {
  let runJobIds: readonly string[] = [];
  const pipelineKey = new Uint8Array(32).fill(55);
  const f = await taskAssignmentFixture(async base => {
    const service = new LinearPipelineServiceV1(base.db, base.scope, pipelineKey,
      { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => instant + 5000);
    const stages = template.stages.map(stage => ({ ...stage, workerId: "executor:hermes-native", workerKind: "hermes" as const,
      nodeId: binding.nodeId, provider: "provider:test", profile: "profile:test" }));
    const saved = await service.createTemplate(base.identity, binding.projectId, { ...template, stages });
    const run = await service.instantiate(base.identity, binding.projectId,
      { templateId: saved.templateId, title: "Plan pipeline stage" }, "linear-planner-propagation-0001");
    runJobIds = run.jobIds;
    return { draft: { title: "Plan pipeline stage", instructions: template.description },
      source: { receipt: { jobId: run.jobIds[0]! } } };
  });
  t.after(() => void f.close());
  const propagated = (await f.db.query<{ stage_kind: string; stage_ordinal: number; pipeline_run_id: string }>(
    "SELECT stage_kind,stage_ordinal,pipeline_run_id FROM control_jobs WHERE id=$1", [f.prepared.receipt.jobId])).rows[0];
  assert.deepEqual(propagated, { stage_kind: "build", stage_ordinal: 0,
    pipeline_run_id: (await f.db.query<{ pipeline_run_id: string }>("SELECT pipeline_run_id FROM control_jobs WHERE id=$1",
      [runJobIds[0]])).rows[0]!.pipeline_run_id });
  let selectionChecks = 0;
  const admission: WorkBatchAssignmentAdmissionAuthority = { integrityKey: pipelineKey,
    assertCurrent: async () => { selectionChecks += 1; }, assertAcceptedResultCurrent: async () => {} };
  const coordinator = new TaskAssignmentCoordinator(f.db, f.scope, f.planner, [f.route], () => instant + 8000,
    [], undefined, undefined, undefined, undefined, admission);
  await coordinator.assign(f.identity, binding.projectId, f.prepared.receipt.jobId, binding.nodeId, f.prepared.receipt.inputDigest);
  assert.equal(selectionChecks, 1);
  const expected = sha256Digest({ title: "Plan pipeline stage", instructions: template.description });
  const second = await f.planner.plan(f.identity, binding.projectId, runJobIds[1]!, expected);
  await f.db.query("DELETE FROM control_job_dependencies WHERE tenant_id=$1 AND job_id=$2",
    [binding.tenantId, runJobIds[1]]);
  await assert.rejects(coordinator.assign(f.identity, binding.projectId, second.receipt.jobId,
    binding.nodeId, second.receipt.inputDigest), /conflict/u);
  assert.equal(selectionChecks, 2);
});

test("pipeline assignment admits an exact stage after an authenticated accepted predecessor", async t => {
  const f = await completedPredecessorFixture(); t.after(f.quality.close);
  await f.assign();
  assert.equal(f.acceptedChecks(), 1);
});

test("pipeline planning and exact-stage admission run on the production coordinator login", async t => {
  // Every other assignment test here runs on the superuser connection, where
  // a row lock or write the coordinator role cannot perform still succeeds.
  const f = await completedPredecessorFixture({ productionCoordinatorLogin: true }); t.after(f.quality.close);
  const lineage = (await f.base.db.query<{ stage_kind: string; stage_ordinal: number }>(
    "SELECT stage_kind,stage_ordinal FROM control_jobs WHERE id=$1", [f.prepared.receipt.jobId])).rows[0];
  assert.deepEqual(lineage, { stage_kind: "check", stage_ordinal: 1 });
  const inherited = (await f.base.db.query<{ inherited_from_job_id: string; model: string }>(
    "SELECT inherited_from_job_id,model FROM control_task_model_selections WHERE job_id=$1", [f.prepared.receipt.jobId])).rows[0];
  assert.deepEqual(inherited, { inherited_from_job_id: f.runJobIds[1], model: "claude-test" });
  await f.assign();
  assert.equal(f.acceptedChecks(), 1);
});

test("pipeline assignment independently rechecks the exact predecessor dependency edge", async t => {
  const f = await completedPredecessorFixture(); t.after(f.quality.close);
  await f.base.db.query("DELETE FROM control_job_dependencies WHERE tenant_id=$1 AND job_id=$2",
    [binding.tenantId, f.runJobIds[1]]);
  await assert.rejects(f.assign(), /conflict/u);
  assert.equal(f.acceptedChecks(), 0);
});

test("pipeline assignment independently authenticates the saved stage record", async t => {
  const f = await completedPredecessorFixture(); t.after(f.quality.close);
  await f.base.db.query("UPDATE pipeline_stage_runs SET auth_tag=$1 WHERE tenant_id=$2 AND current_job_id=$3",
    [`hmac-sha256:${"0".repeat(64)}`, binding.tenantId, f.runJobIds[1]]);
  await assert.rejects(f.assign(), /conflict/u);
  assert.equal(f.acceptedChecks(), 0);
});

test("pipeline assignment independently matches the planned model selection", async t => {
  const f = await completedPredecessorFixture(); t.after(f.quality.close);
  await f.base.db.query("UPDATE control_task_model_selections SET model='model:substituted' WHERE tenant_id=$1 AND job_id=$2",
    [binding.tenantId, f.prepared.receipt.jobId]);
  await assert.rejects(f.assign(), /conflict/u);
  assert.equal(f.acceptedChecks(), 0);
});

test("pipeline assignment independently requires retained canonical predecessor proof", async t => {
  const f = await completedPredecessorFixture(); t.after(f.quality.close);
  await f.base.db.query("DROP TRIGGER control_transition_events_append_only ON control_transition_events");
  await f.base.db.query(`DELETE FROM control_transition_events WHERE tenant_id=$1 AND entity_kind='job'
    AND entity_id=$2 AND to_state='succeeded' AND idempotency_key LIKE 'native-completion:%:job'`,
  [binding.tenantId, f.base.prepared.receipt.jobId]);
  await assert.rejects(f.assign(), /conflict/u);
  assert.equal(f.acceptedChecks(), 0);
});

test("pipeline HTTP route requires gateway authentication", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const handler = createLinearPipelineHttpHandlerV1({ origin, trust, service: f.service, clock: () => now });
  const unauthenticated = new Request(`${origin}/api/v1/projects/${encodeURIComponent(f.project.projectId)}/pipeline-runs`,
    { headers: { origin } });
  assert.equal((await handler(unauthenticated)).status, 401);
  assert.equal((await handler(request(`/api/v1/projects/${encodeURIComponent(f.project.projectId)}/pipeline-runs`))).status, 200);
});

test("pipeline unattended and history HTTP routes are owner-service operations on runs only", async t=>{
  const f=await fixture();t.after(()=>void f.db.close());let transitions=0,histories=0;
  const advance={setUnattended:async()=>{transitions++;return{replayed:false}},
    historyForOwner:async()=>{histories++;return{runId:"pipeline-run:test"}}};
  const handler=createLinearPipelineHttpHandlerV1({origin,trust,service:f.service,advance:advance as never,clock:()=>now});
  const project=encodeURIComponent(f.project.projectId),run=encodeURIComponent("pipeline-run:test");
  const history=await handler(request(`/api/v1/projects/${project}/pipeline-runs/${run}/history`));
  assert.equal(history.status,200);assert.equal(histories,1);
  const unattended=await handler(request(`/api/v1/projects/${project}/pipeline-runs/${run}/unattended`,"POST",
    {runId:"pipeline-run:test"},"pipeline-consent-0001"));
  assert.equal(unattended.status,201);assert.equal(transitions,1);
  assert.equal((await handler(request(`/api/v1/projects/${project}/pipeline-templates/${run}/history`))).status,404);
  assert.ok((await handler(request(`/api/v1/projects/${project}/pipeline-templates/${run}/unattended`,"POST",
    {runId:"pipeline-run:test"}))).status>=400);
  assert.equal(histories,1);assert.equal(transitions,1);
});

test("schema constraints refuse partial pipeline columns, unknown kinds and cross-job attempt lineage", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const task = await f.tasks.propose(f.identity, f.project.projectId,
    { title: "Independent task", instructions: "Remain outside the pipeline." }, "linear-independent-0001");
  await assert.rejects(f.db.query("UPDATE control_jobs SET stage_ordinal=0 WHERE id=$1", [task.receipt.jobId]),
    /ck_control_jobs_pipeline_columns_all_or_none/u);
  await assert.rejects(f.db.query("UPDATE control_jobs SET stage_kind='unknown' WHERE id=$1", [task.receipt.jobId]),
    /check constraint/u);
  const saved = await f.service.createTemplate(f.identity, f.project.projectId, template);
  const run = await f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "First project run" }, "linear-project-lineage-0001");
  const other = await f.projects.create(f.identity, { title: "Other project", summary: "Separate lineage." },
    "linear-other-project-0001");
  const otherTask = await f.tasks.propose(f.identity, other.project.projectId,
    { title: "Other project task", instructions: "Stay in the other project." }, "linear-other-task-0001");
  await assert.rejects(f.db.query(`UPDATE control_jobs SET stage_kind='build',stage_ordinal=0,pipeline_run_id=$1 WHERE id=$2`,
    [run.runId, otherTask.receipt.jobId]), /foreign key constraint/u);
});

test("pipeline projection pauses every stage outside an active project", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const saved = await f.service.createTemplate(f.identity, f.project.projectId, template);
  const run = await f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Paused projection" }, "linear-paused-projection-0001");
  await f.projects.transition(f.identity, f.project.projectId, { lifecycle: "paused", expectedVersion: 1 },
    "pipeline-project-pause-0001");
  assert.deepEqual((await f.service.view(f.identity, f.project.projectId, run.runId)).stages.map(stage => stage.state),
    ["paused", "paused", "paused"]);
});

test("pipeline projection fails closed when the run no longer has exactly three stages", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const saved = await f.service.createTemplate(f.identity, f.project.projectId, template);
  const run = await f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Stage count guard" }, "linear-stage-count-guard-0001");
  await f.db.query("DROP TRIGGER pipeline_stage_runs_guard ON pipeline_stage_runs");
  await f.db.query("DELETE FROM pipeline_stage_runs WHERE pipeline_run_id=$1 AND stage_ordinal=2", [run.runId]);
  await assert.rejects(f.service.view(f.identity, f.project.projectId, run.runId), /pipeline_integrity_failed/u);
});

test("0109, 0108 and 0105 down migrations refuse retained policy/history and remove owned objects only when empty", async t => {
  const populated = await fixture(); t.after(() => void populated.db.close());
  const populatedTemplate = await populated.service.createTemplate(populated.identity, populated.project.projectId, template);
  await populated.service.instantiate(populated.identity, populated.project.projectId,
    { templateId: populatedTemplate.templateId, title: "Retained down guard" }, "linear-down-guard-0001");
  const unattendedDown = await readFile("db/down/0109_pipeline_unattended_advance.sql", "utf8");
  const down = await readFile("db/down/0105_linear_pipeline_runs.sql", "utf8");
  const agentReviewDown = await readFile("db/down/0106_agent_review_plans.sql", "utf8");
  const publicationDown = await readFile("db/down/0108_pipeline_build_publications.sql", "utf8");
  // S7b's 0151 and 0153 build append-only triggers on the history guard 0109 owns,
  // so 0109's down refuses while they exist. Reverse the later slice first, which is the
  // real order a down path has to be taken in.
  const s7bDowns = ["0154_pipeline_advance_round_receipts.sql", "0153_pipeline_machine_capacity_observations.sql",
    "0152_pipeline_advance_unknown_cost.sql", "0151_pipeline_stage_loop_counts.sql",
    "0150_pipeline_installation_allowances.sql"];
  // S7b's tables exist in this fixture too, so 0109's down refuses while they
  // do. Reverse S7b first, exactly as an operator would, then 0109 runs.
  for (const file of s7bDowns) await populated.db.exec(await readFile(`db/down/${file}`, "utf8"));
  await populated.db.exec(unattendedDown);
  await assert.rejects(populated.db.exec(publicationDown), /0108 down migration refused/u);
  await populated.db.exec("ROLLBACK");
  await populated.db.exec(`ALTER TABLE pipeline_stage_runs DISABLE TRIGGER pipeline_stage_runs_guard;
    UPDATE pipeline_stage_runs SET allowed_paths=NULL,maximum_changed_files=NULL,maximum_changed_bytes=NULL;
    ALTER TABLE pipeline_stage_runs ENABLE TRIGGER pipeline_stage_runs_guard;`);
  await populated.db.exec(publicationDown);
  await assert.rejects(populated.db.exec(down), /down migration refused/u); await populated.db.exec("ROLLBACK");
  const empty = await taskFixture(); t.after(() => void empty.db.close());
  await assert.rejects(empty.db.exec(unattendedDown), /a later migration depends on its history guard/u);
  await empty.db.exec("ROLLBACK");
  for (const file of s7bDowns) await empty.db.exec(await readFile(`db/down/${file}`, "utf8"));
  await empty.db.exec(unattendedDown);
  await empty.db.exec(publicationDown);
  await empty.db.exec(agentReviewDown);
  await empty.db.exec(down);
  assert.deepEqual((await empty.db.query<{ templates: string | null; runs: string | null; stages: string | null }>(`SELECT
    to_regclass('pipeline_templates')::text templates,to_regclass('pipeline_runs')::text runs,
    to_regclass('pipeline_stage_runs')::text stages`)).rows[0], { templates: null, runs: null, stages: null });
  assert.deepEqual((await empty.db.query<{ guard: string | null }>(
    "SELECT to_regproc('guard_control_job_pipeline_lineage')::text guard")).rows[0], { guard: null });
  // S7b's own tables went with their own down files, and the guard 0109 owned
  // is gone because nothing was left pointing at it.
  assert.deepEqual((await empty.db.query<{ allowance: string | null; loops: string | null; observed: string | null }>(
    `SELECT to_regclass('pipeline_installation_allowances')::text allowance,
      to_regclass('pipeline_stage_loop_counts')::text loops,
      to_regclass('pipeline_machine_capacity_observations')::text observed`)).rows[0],
  { allowance: null, loops: null, observed: null });
  assert.deepEqual((await empty.db.query<{ history: string | null }>(
    "SELECT to_regproc('reject_pipeline_unattended_history_mutation')::text history")).rows[0], { history: null });
});

/** Stage zero planned through the real planner with a coordinator that holds the
 * pipeline admission authority; nothing is assigned yet. */
async function plannedStageFixture() {
  let runId = "", runJobIds: readonly string[] = [];
  const pipelineKey = new Uint8Array(32).fill(55);
  const admission: WorkBatchAssignmentAdmissionAuthority = { integrityKey: pipelineKey,
    assertCurrent: async () => {}, assertAcceptedResultCurrent: async () => {} };
  const f = await taskAssignmentFixture(async base => {
    const service = new LinearPipelineServiceV1(base.db, base.scope, pipelineKey,
      { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => instant + 5000);
    const stages = template.stages.map(stage => ({ ...stage, workerId: "executor:hermes-native", workerKind: "hermes" as const,
      nodeId: binding.nodeId, provider: "provider:test", profile: "profile:test" }));
    const saved = await service.createTemplate(base.identity, binding.projectId, { ...template, stages });
    const run = await service.instantiate(base.identity, binding.projectId,
      { templateId: saved.templateId, title: "Guarded pipeline stage" }, "linear-guarded-stage-0001");
    runId = run.runId; runJobIds = run.jobIds;
    return { draft: { title: "Guarded pipeline stage", instructions: template.description },
      source: { receipt: { jobId: run.jobIds[0]! } } };
  });
  const coordinator = new TaskAssignmentCoordinator(f.db, f.scope, f.planner, [f.route], () => instant + 8000,
    [], undefined, undefined, undefined, undefined, admission);
  const assign = (receipt: { jobId: string; inputDigest: string }) =>
    coordinator.assign(f.identity, binding.projectId, receipt.jobId, binding.nodeId, receipt.inputDigest);
  const planStage = (ordinal: number) => f.planner.plan(f.identity, binding.projectId, runJobIds[ordinal]!,
    sha256Digest({ title: "Guarded pipeline stage", instructions: template.description }));
  const attempts = async (jobId: string) => (await f.db.query<{ count: number }>(
    "SELECT count(*)::int count FROM control_attempts WHERE tenant_id=$1 AND job_id=$2", [binding.tenantId, jobId])).rows[0]!.count;
  // Models a bypass of the write-once lineage trigger (a privileged or future
  // regressed writer): the assignment gate must still refuse on its own.
  const bypassLineageTrigger = (sql: string, params: unknown[]) => f.db.transaction(async tx => {
    await tx.query("SET LOCAL session_replication_role = replica");
    await tx.query(sql, params);
  });
  // The pipeline gate is a private method; call it with the exact production SQL.
  const gate = (jobId: string, attemptWorkerId?: string | null) => f.db.transaction(async tx =>
    (coordinator as unknown as { assertPipelineAdmission(tx: unknown, job: JobRecord, route: TaskAssignmentRoute,
      attemptWorkerId?: string | null): Promise<boolean> }).assertPipelineAdmission(tx,
      { id: jobId, projectId: binding.projectId } as JobRecord, f.route, attemptWorkerId));
  return { f, runId, runJobIds, coordinator, assign, planStage, attempts, bypassLineageTrigger, gate, pipelineKey };
}

test("pipeline lineage is write-once on control_jobs", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const saved = await f.service.createTemplate(f.identity, f.project.projectId, template);
  const run = await f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Write-once lineage" }, "linear-write-once-0001");
  const other = await f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Other run" }, "linear-write-once-0002");
  for (const [assignment, params] of [
    ["stage_kind=NULL,stage_ordinal=NULL,pipeline_run_id=NULL", []],
    ["stage_kind='signoff'", []], ["stage_ordinal=0", []], ["pipeline_run_id=$2", [other.runId]],
  ] as const) await assert.rejects(f.db.query(`UPDATE control_jobs SET ${assignment} WHERE id=$1`,
    [run.jobIds[1], ...params]), /pipeline lineage is write-once/u, assignment);
  // A no-op rewrite of the same lineage and unrelated column updates still pass.
  await f.db.query("UPDATE control_jobs SET stage_kind=stage_kind,stage_ordinal=stage_ordinal WHERE id=$1", [run.jobIds[1]]);
  assert.deepEqual((await f.db.query("SELECT stage_kind,stage_ordinal::int,pipeline_run_id FROM control_jobs WHERE id=$1",
    [run.jobIds[1]])).rows[0], { stage_kind: "check", stage_ordinal: 1, pipeline_run_id: run.runId });
});

test("clearing a planned stage's lineage cannot take it out of pipeline admission", async t => {
  const s = await plannedStageFixture(); t.after(() => void s.f.close());
  const stage1 = (await s.planStage(1)).receipt;
  await assert.rejects(s.assign(stage1), /conflict/u);
  // Unlinked, the execution job looks like ordinary work with no dependencies.
  // Pipeline membership still follows from its immutable execution plan and stage row.
  await s.bypassLineageTrigger(`UPDATE control_jobs SET stage_kind=NULL,stage_ordinal=NULL,pipeline_run_id=NULL
    WHERE tenant_id=$1 AND id=$2`, [binding.tenantId, stage1.jobId]);
  await assert.rejects(s.assign(stage1), /conflict/u);
  assert.equal(await s.attempts(stage1.jobId), 0);
  assert.equal(await s.attempts(s.f.prepared.receipt.jobId), 0);
  // Stage zero too: an unlinked stage must not escape its saved route and selection.
  await s.bypassLineageTrigger(`UPDATE control_jobs SET stage_kind=NULL,stage_ordinal=NULL,pipeline_run_id=NULL
    WHERE tenant_id=$1 AND id=$2`, [binding.tenantId, s.f.prepared.receipt.jobId]);
  await assert.rejects(s.assign(s.f.prepared.receipt), /conflict/u);
  assert.equal(await s.attempts(s.f.prepared.receipt.jobId), 0);
});

test("pipeline admission refuses a stage-one result produced by a worker other than the stage-zero owner", async t => {
  const f = await completedPredecessorFixture(); t.after(f.quality.close);
  // Stage zero now names another owner's worker; the accepted result belongs to
  // executor:hermes-native, so it must not unlock stage one.
  await f.base.db.query("DROP TRIGGER pipeline_stage_runs_guard ON pipeline_stage_runs");
  await f.base.db.query("UPDATE pipeline_stage_runs SET worker_id='executor:someone-else' WHERE tenant_id=$1 AND current_job_id=$2",
    [binding.tenantId, f.runJobIds[0]]);
  await assert.rejects(f.assign(), /conflict/u);
  assert.equal(f.acceptedChecks(), 0);
});

test("pipeline admission refuses an unrelated job labelled as a pipeline stage", async t => {
  const s = await plannedStageFixture(); t.after(() => void s.f.close());
  // The web and coordinator logins may write lineage once onto any unlabelled
  // job. Labelling ordinary work as stage zero must not borrow that stage's
  // admission (which would skip the ordinary dependency check).
  const task = await s.f.tasks.propose(s.f.identity, binding.projectId, taskDraft, "linear-borrowed-stage-0001");
  const ordinary = (await s.f.planner.plan(s.f.identity, binding.projectId, task.receipt.jobId, sha256Digest(taskDraft))).receipt;
  await s.f.db.query("UPDATE control_jobs SET stage_kind='build',stage_ordinal=0,pipeline_run_id=$1 WHERE tenant_id=$2 AND id=$3",
    [s.runId, binding.tenantId, ordinary.jobId]);
  await s.f.db.query("DELETE FROM control_task_model_selections WHERE tenant_id=$1 AND job_id=$2", [binding.tenantId, ordinary.jobId]);
  await s.f.db.query(`INSERT INTO control_task_model_selections(tenant_id,project_id,job_id,worker_kind,selection_key,model,effort,
      provider,profile,created_at) SELECT tenant_id,project_id,$2,worker_kind,selection_key,model,effort,provider,profile,created_at
    FROM control_task_model_selections WHERE tenant_id=$1 AND job_id=$3`, [binding.tenantId, ordinary.jobId, s.f.prepared.receipt.jobId]);
  await assert.rejects(s.assign(ordinary), /conflict/u);
  assert.equal(await s.attempts(ordinary.jobId), 0);
});

test("pipeline admission refuses an execution job whose stage kind disagrees with its stage row", async t => {
  const s = await plannedStageFixture(); t.after(() => void s.f.close());
  await s.bypassLineageTrigger("UPDATE control_jobs SET stage_kind='check' WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, s.f.prepared.receipt.jobId]);
  await assert.rejects(s.assign(s.f.prepared.receipt), /conflict/u);
  assert.equal(await s.attempts(s.f.prepared.receipt.jobId), 0);
});

test("pipeline admission refuses a recorded attempt worker other than the stage worker", async t => {
  const s = await plannedStageFixture(); t.after(() => void s.f.close());
  assert.equal(await s.gate(s.f.prepared.receipt.jobId), true);
  assert.equal(await s.gate(s.f.prepared.receipt.jobId, "executor:hermes-native"), true);
  await assert.rejects(s.gate(s.f.prepared.receipt.jobId, "executor:someone-else"), /conflict/u);
  await assert.rejects(s.gate(s.f.prepared.receipt.jobId, null), /conflict/u);
});

test("pipeline admission refuses stage zero once its source job carries a dependency edge", async t => {
  const s = await plannedStageFixture(); t.after(() => void s.f.close());
  await s.f.db.query("INSERT INTO control_job_dependencies(tenant_id,job_id,depends_on_job_id) VALUES($1,$2,$3)",
    [binding.tenantId, s.runJobIds[0], s.runJobIds[2]]);
  await assert.rejects(s.assign(s.f.prepared.receipt), /conflict/u);
  assert.equal(await s.attempts(s.f.prepared.receipt.jobId), 0);
});

test("pipeline admission refuses a predecessor proof without a review target digest", async t => {
  const f = await completedPredecessorFixture(); t.after(f.quality.close);
  await f.base.db.query("DROP TRIGGER control_transition_events_append_only ON control_transition_events");
  await f.base.db.query(`UPDATE control_transition_events SET safe_metadata=safe_metadata #- '{receipt,targetDigest}'
    WHERE tenant_id=$1 AND entity_kind='job' AND entity_id=$2 AND to_state='succeeded'
      AND idempotency_key LIKE 'native-completion:%:job'`, [binding.tenantId, f.base.prepared.receipt.jobId]);
  await assert.rejects(f.assign(), /conflict/u);
  assert.equal(f.acceptedChecks(), 0);
});

test("pipeline admission refuses a partial lineage even when the schema check is missing", async t => {
  const s = await plannedStageFixture(); t.after(() => void s.f.close());
  await s.f.db.query("ALTER TABLE control_jobs DROP CONSTRAINT ck_control_jobs_pipeline_columns_all_or_none");
  await s.bypassLineageTrigger("UPDATE control_jobs SET stage_ordinal=NULL WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, s.f.prepared.receipt.jobId]);
  await assert.rejects(s.assign(s.f.prepared.receipt), /conflict/u);
  assert.equal(await s.attempts(s.f.prepared.receipt.jobId), 0);
});

test("pipeline instantiation requires tasks.propose under a non-wildcard grant", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const saved = await f.service.createTemplate(f.identity, f.project.projectId, template);
  const grant = (actions: readonly string[]) => f.db.query(`UPDATE control_role_grants SET allowed_actions=$1::jsonb,
    project_ids=$2::jsonb WHERE tenant_id='tenant:web' AND identity_id='identity:web'`,
  [JSON.stringify(actions), JSON.stringify([f.project.projectId])]);
  await grant(["tasks.read"]);
  await assert.rejects(f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Read-only instantiate" }, "linear-read-only-0001"), /access_denied/u);
  assert.equal((await f.db.query("SELECT 1 FROM pipeline_runs")).rows.length, 0);
  await grant(["tasks.read", "tasks.propose"]);
  await f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Proposer instantiate" }, "linear-proposer-0001");
  assert.equal((await f.db.query("SELECT 1 FROM pipeline_runs")).rows.length, 1);
});

test("pipeline instantiation refuses a paused project", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const saved = await f.service.createTemplate(f.identity, f.project.projectId, template);
  await f.projects.transition(f.identity, f.project.projectId, { lifecycle: "paused", expectedVersion: 1 },
    "pipeline-instantiate-pause-0001");
  await assert.rejects(f.service.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Paused instantiate" }, "linear-paused-instantiate-0001"), /conflict/u);
  assert.equal((await f.db.query("SELECT 1 FROM pipeline_runs")).rows.length, 0);
});

test("pipeline HTTP route refuses cross-origin requests", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const handler = createLinearPipelineHttpHandlerV1({ origin, trust, service: f.service, clock: () => now });
  const path = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/pipeline-templates`;
  const post = request(path, "POST", template);
  const foreign = new Request(post.url, { method: "POST", body: JSON.stringify(template),
    headers: { ...Object.fromEntries(post.headers), origin: "https://attacker.example" } });
  assert.equal((await handler(foreign)).status, 403);
  const crossSite = request(`/api/v1/projects/${encodeURIComponent(f.project.projectId)}/pipeline-runs`);
  crossSite.headers.set("sec-fetch-site", "cross-site");
  assert.equal((await handler(crossSite)).status, 403);
  assert.equal((await f.db.query("SELECT 1 FROM pipeline_templates")).rows.length, 0);
  assert.equal((await handler(request(path, "POST", template))).status, 201);
});
