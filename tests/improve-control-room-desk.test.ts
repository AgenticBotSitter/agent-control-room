import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImproveControlRoomDeskServiceV1 } from "../src/improve-control-room/v1";
import { LinearPipelineServiceV1 } from "../src/pipelines/v1";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import { ImprovementRequestForm } from "../private-app/app/improve-control-room-workspace";
import { UpdateCandidatesHome, UpdateCandidatesPanel } from "../private-app/app/update-candidates-home";

const key = new Uint8Array(32).fill(64);
const template = { name: "Build, check, sign off", description: "Improve the Control Room in one bounded pipeline.",
  stages: [
    { ordinal: 0, stageKind: "build", role: "builder", description: "Build the bounded improvement.",
      allowedPaths: ["src/**", "private-app/**", "tests/**"], maximumChangedFiles: 40, maximumChangedBytes: 524288,
      requiredCapability: "code.change", workerId: "worker:builder", workerKind: "codex", nodeId: "node:builder",
      selectionKey: "builder.standard", model: "build-model", effort: "high", maxLoops: 2 },
    { ordinal: 1, stageKind: "check", role: "checker", description: "Independently check the change.",
      requiredCapability: "code.review", workerId: "worker:checker", workerKind: "claude-code", nodeId: "node:checker",
      selectionKey: "checker.standard", model: "check-model", effort: "high", maxLoops: 2 },
    { ordinal: 2, stageKind: "signoff", role: "validator", description: "Run final tests and sign off.",
      requiredCapability: "code.validate", workerId: "worker:lead", workerKind: "hermes", nodeId: "node:lead",
      selectionKey: "lead.standard", model: "lead-model", effort: "high", provider: "provider:test", profile: "profile:test", maxLoops: 0 },
  ], maxTotalLoops: 4, maxDurationSeconds: 3600 } as const;

async function deskFixture() {
  const f = await taskFixture();
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb)
    WHERE tenant_id='tenant:web' AND id=$1`, [f.project.projectId]);
  const pipelines = new LinearPipelineServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => now);
  const saved = await pipelines.createTemplate(f.identity, f.project.projectId, template);
  const desk = new ImproveControlRoomDeskServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" },
    key, pipelines, () => now);
  return { ...f, pipelines, saved, desk };
}

test("the self-project request binds exact template workers and creates one ordinary pipeline", async t => {
  const f = await deskFixture(); t.after(() => void f.db.close());
  const before = await f.desk.view(f.identity, f.project.projectId);
  assert.equal(before.templates.length, 1);
  assert.deepEqual(before.templates[0]!.workers.map(worker => worker.workerId),
    ["worker:builder", "worker:checker", "worker:lead"]);
  const draft = { description: "Show update readiness on Home.", pipelineTemplateId: f.saved.templateId,
    selectedWorkerIds: ["worker:builder", "worker:checker"], leadWorkerId: "worker:lead" };
  const created = await f.desk.create(f.identity, f.project.projectId, draft, "improvement-request-0001");
  assert.equal(created.replayed, false); assert.equal(created.request.startsWork, false);
  assert.equal(created.request.grantsDeployAuthority, false);
  assert.equal((await f.db.query("SELECT 1 FROM pipeline_runs WHERE id=$1", [created.request.pipelineRunId])).rows.length, 1);
  const replay = await f.desk.create(f.identity, f.project.projectId, draft, "improvement-request-0001");
  assert.equal(replay.replayed, true); assert.equal(replay.request.pipelineRunId, created.request.pipelineRunId);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int count FROM control_improvement_requests")).rows[0]!.count, 1);
  assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int count FROM pipeline_runs")).rows[0]!.count, 1);
  await assert.rejects(f.desk.create(f.identity, f.project.projectId, { ...draft,
    selectedWorkerIds: ["worker:builder"] }, "improvement-request-0002"), /conflict/u);
});

test("candidate acceptance records an exact owner decision and cannot deploy", async t => {
  const f = await deskFixture(); t.after(() => void f.db.close());
  const request = (await f.desk.create(f.identity, f.project.projectId, {
    description: "Prepare an inert update card.", pipelineTemplateId: f.saved.templateId,
    selectedWorkerIds: ["worker:builder", "worker:checker"], leadWorkerId: "worker:lead",
  }, "improvement-candidate-0001")).request;
  await f.db.query("UPDATE pipeline_runs SET state='succeeded' WHERE id=$1", [request.pipelineRunId]);
  await f.db.query("UPDATE pipeline_stage_runs SET state='succeeded' WHERE pipeline_run_id=$1 AND stage_kind='signoff'",
    [request.pipelineRunId]);
  const recorded = await f.desk.recordCandidate({ projectId: f.project.projectId,
    improvementRequestId: request.requestId, pipelineRunId: request.pipelineRunId,
    baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), summary: "Adds an update-ready owner card.",
    changedAreas: ["Home", "improvement desk"], testResults: [
      { profile: "fast", status: "passed", summary: "Focused tests passed.", evidenceDigest: `sha256:${"c".repeat(64)}` },
      { profile: "db", status: "not_run", summary: "Requires a DB-capable helper.", evidenceDigest: null },
    ], databaseChanges: { kind: "migrations", migrationIds: ["0160_improve_control_room_desk"],
      summary: "Adds inert request, candidate and decision records." }, leadWorkerId: "worker:lead" });
  assert.equal(recorded.candidate.startsDeploy, false);
  const ready = await f.desk.ready(f.identity);
  assert.equal(ready.candidates.length, 1); assert.equal(ready.signedDeployApprovalCreated, false);
  const receipt = await f.desk.decide(f.identity, { candidateId: recorded.candidate.candidateId,
    expectedVersion: 1, candidateRecordDigest: recorded.candidate.recordDigest, decision: "accept" },
  "update-owner-decision-0001");
  assert.deepEqual({ startsDeploy: receipt.startsDeploy, signed: receipt.signedDeployApprovalCreated,
    grants: receipt.grantsDeployAuthority }, { startsDeploy: false, signed: false, grants: false });
  assert.equal((await f.desk.ready(f.identity)).candidates.length, 0);
  const replay = await f.desk.decide(f.identity, { candidateId: recorded.candidate.candidateId,
    expectedVersion: 1, candidateRecordDigest: recorded.candidate.recordDigest, decision: "accept" },
  "update-owner-decision-0001");
  assert.equal(replay.replayed, true);
  assert.equal((await f.db.query<{ state: string; version: number }>("SELECT state,version FROM control_update_candidates")).rows[0]!.state,
    "accepted");
});

test("candidate integrity drift fails closed", async t => {
  const f = await deskFixture(); t.after(() => void f.db.close());
  const request = (await f.desk.create(f.identity, f.project.projectId, {
    description: "Prepare integrity proof.", pipelineTemplateId: f.saved.templateId,
    selectedWorkerIds: ["worker:builder", "worker:checker"], leadWorkerId: "worker:lead",
  }, "improvement-integrity-0001")).request;
  await f.db.query("UPDATE pipeline_runs SET state='succeeded' WHERE id=$1", [request.pipelineRunId]);
  await f.db.query("UPDATE pipeline_stage_runs SET state='succeeded' WHERE pipeline_run_id=$1 AND stage_kind='signoff'",
    [request.pipelineRunId]);
  await f.desk.recordCandidate({ projectId: f.project.projectId, improvementRequestId: request.requestId,
    pipelineRunId: request.pipelineRunId, baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40),
    summary: "Integrity-bound candidate.", changedAreas: ["desk"],
    testResults: [{ profile: "fast", status: "passed", summary: "Passed.", evidenceDigest: `sha256:${"c".repeat(64)}` }],
    databaseChanges: { kind: "none" }, leadWorkerId: "worker:lead" });
  // The row guard refuses any edit but an owner decision; tamper beneath it.
  await assert.rejects(f.db.query("UPDATE control_update_candidates SET summary='tampered'"), /transition rejected/u);
  await f.db.query("ALTER TABLE control_update_candidates DISABLE TRIGGER control_update_candidates_update_guard");
  await f.db.query("UPDATE control_update_candidates SET summary='tampered'");
  await assert.rejects(f.desk.ready(f.identity), /improvement_desk_integrity_failed/u);
});

test("desk UI labels worker selection and keeps deployment inactive", () => {
  const html = renderToStaticMarkup(createElement(ImprovementRequestForm, { pending: false, onSubmit: () => {}, view: {
    projectId: "project:test", templates: [{ templateId: "pipeline-template:test", name: "Build and review", version: 1,
      templateDigest: `sha256:${"d".repeat(64)}`, workers: [
        { ordinal: 0, stage: "build", workerId: "worker:build", model: "model-build", effort: "high" },
        { ordinal: 1, stage: "check", workerId: "worker:check", model: "model-check", effort: "high" },
        { ordinal: 2, stage: "signoff", workerId: "worker:lead", model: "model-lead", effort: "high" },
      ] }], requests: [], startsWork: false, grantsDeployAuthority: false,
  } }));
  assert.match(html, /What should Control Room improve/);
  assert.match(html, /Choose a build, check and sign-off pipeline/);
  assert.match(html, /does not deploy, restart, upgrade the database or publish a release/);
  // Attention first: nothing on Home until a candidate waits or the read fails.
  assert.equal(renderToStaticMarkup(createElement(UpdateCandidatesHome)), "");
  const panel = (state: Parameters<typeof UpdateCandidatesPanel>[0]["state"], message?: "saved") =>
    renderToStaticMarkup(createElement(UpdateCandidatesPanel, { state, message, onDecide: () => {}, onRetry: () => {} }));
  assert.equal(panel({ state: "loading" }), "");
  assert.equal(panel({ state: "not_configured" }), "", "an installation without the desk raises no alarm");
  assert.equal(panel({ state: "ready", candidates: [] }), "");
  assert.match(panel({ state: "unavailable" }), /role="alert">Update candidates are unavailable/);
  assert.match(panel({ state: "ready", candidates: [] }, "saved"), /Owner decision recorded. No deployment started./);
  const candidate = { candidateId: "update-candidate:test", projectId: "project:test", improvementRequestId: "improvement:test",
    pipelineRunId: "pipeline-run:test", baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40),
    summary: "Adds the owner card.", changedAreas: ["Home"], testResults: [{ profile: "fast" as const,
      status: "not_run" as const, summary: "Pending.", evidenceDigest: null }], databaseChanges: { kind: "none" as const },
    leadWorkerId: "worker:lead", state: "ready" as const, version: 1, recordDigest: `sha256:${"e".repeat(64)}`,
    createdAt: new Date(now).toISOString(), decidedAt: null, startsDeploy: false as const, signedDeployApprovalCreated: false as const };
  const home = panel({ state: "ready", candidates: [candidate] });
  assert.match(home, /Update ready/); assert.match(home, /Adds the owner card/); assert.match(home, /fast not run/);
  assert.match(home, />Accept</); assert.match(home, />Decline</);
  assert.match(home, /Deploy and restart are not active/);
  assert.doesNotMatch(home, /deploy now|restart now|install/i, "no control on the card starts a deployment");
});
