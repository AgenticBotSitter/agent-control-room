import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LinearPipelineServiceV1 } from "../src/pipelines/v1";
import { hmacSha256Tag, sha256Digest } from "../src/security";
import { createLinearPipelineHttpHandlerV1 } from "../src/web/v1/linear-pipeline-http";
import { TaskAssignmentCoordinator, type WorkBatchAssignmentAdmissionAuthority } from "../src/web/v1/task-assignment-coordinator";
import { taskFixture } from "./helpers/web-task";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { now, origin, request, trust } from "./helpers/web-foundation";
import { binding, instant } from "./hermes-native-fixture";

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
        ? { contentHash: exact, revision: 7 } : null }, () => now);
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

test("pipeline HTTP route requires gateway authentication", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const handler = createLinearPipelineHttpHandlerV1({ origin, trust, service: f.service, clock: () => now });
  const unauthenticated = new Request(`${origin}/api/v1/projects/${encodeURIComponent(f.project.projectId)}/pipeline-runs`,
    { headers: { origin } });
  assert.equal((await handler(unauthenticated)).status, 401);
  assert.equal((await handler(request(`/api/v1/projects/${encodeURIComponent(f.project.projectId)}/pipeline-runs`))).status, 200);
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

test("0098 and 0096 down migrations refuse retained policy/history and remove owned objects only when empty", async t => {
  const populated = await fixture(); t.after(() => void populated.db.close());
  const populatedTemplate = await populated.service.createTemplate(populated.identity, populated.project.projectId, template);
  await populated.service.instantiate(populated.identity, populated.project.projectId,
    { templateId: populatedTemplate.templateId, title: "Retained down guard" }, "linear-down-guard-0001");
  const down = await readFile("db/down/0096_linear_pipeline_runs.sql", "utf8");
  const agentReviewDown = await readFile("db/down/0097_agent_review_plans.sql", "utf8");
  const publicationDown = await readFile("db/down/0098_pipeline_build_publications.sql", "utf8");
  await assert.rejects(populated.db.exec(publicationDown), /0098 down migration refused/u);
  await populated.db.exec("ROLLBACK");
  await populated.db.exec(`ALTER TABLE pipeline_stage_runs DISABLE TRIGGER pipeline_stage_runs_guard;
    UPDATE pipeline_stage_runs SET allowed_paths=NULL,maximum_changed_files=NULL,maximum_changed_bytes=NULL;
    ALTER TABLE pipeline_stage_runs ENABLE TRIGGER pipeline_stage_runs_guard;`);
  await populated.db.exec(publicationDown);
  await assert.rejects(populated.db.exec(down), /down migration refused/u); await populated.db.exec("ROLLBACK");
  const empty = await taskFixture(); t.after(() => void empty.db.close());
  await empty.db.exec(publicationDown);
  await empty.db.exec(agentReviewDown);
  await empty.db.exec(down);
  assert.deepEqual((await empty.db.query<{ templates: string | null; runs: string | null; stages: string | null }>(`SELECT
    to_regclass('pipeline_templates')::text templates,to_regclass('pipeline_runs')::text runs,
    to_regclass('pipeline_stage_runs')::text stages`)).rows[0], { templates: null, runs: null, stages: null });
});
