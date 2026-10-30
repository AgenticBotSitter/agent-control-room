import assert from "node:assert/strict";
import { ImproveControlRoomLoopServiceV1 } from "../src/web/v1/improve-control-room-loop-service";
import { createHash } from "node:crypto";
import { sha256Digest } from "../src/security";
import { readPrivateWebSchemaDigest, privateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import { createInjectedPrivateFixturePreparation, fixtureMigratorScopeDigest } from "../src/web/v1/private-fixture-preparation";
import { rehearsalScopeDigest } from "../src/web/v1/private-database-rehearsal";
import type { createPrivatePostgresDatabase } from "../src/web/v1/private-postgres";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1,
  type LoopImprovementContractV1 } from "../src/improve-control-room/v1/schemas";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CONTROL_ROOM_UPDATE_PATH_RULES_V1, CONTROL_ROOM_UPDATE_TEST_PROFILES_V1,
  ImproveControlRoomDeskServiceV1, UpdateCandidatePublisherV1,
  createLocalIntegrationRepositoryObserverV1,
  type IntegrationRepositorySnapshotV1, type UpdateCandidateRunnerResultV1 } from "../src/improve-control-room/v1";
import { LinearPipelineServiceV1 } from "../src/pipelines/v1";
import { createImproveControlRoomHttpHandlerV1 } from "../src/web/v1/improve-control-room-http";
import { bindCandidatePublisherToPipelineAdvanceV1 } from "../src/web/v1/task-coordinator-lifecycle";
import { taskFixture } from "./helpers/web-task";
import { now, origin, request as webRequest, token as webToken, trust } from "./helpers/web-foundation";
import { ImprovementRequestForm } from "../private-app/app/improve-control-room-workspace";
import { UpdateCandidatesHome, UpdateCandidatesPanel } from "../private-app/app/update-candidates-home";

const key = new Uint8Array(32).fill(64);
const candidateRevision = "b".repeat(40);
const testResult = (profile: "fast" | "db" | "full" | "targeted", status: "passed" | "not_run" = "passed") => ({
  profile, profileVersion: 1, profileDigest: `sha256:${"1".repeat(64)}`, commandIds: ["test.example"],
  candidateRevision, status, summary: status === "passed" ? "Focused tests passed." : "Requires a DB-capable helper.",
  evidenceDigest: status === "passed" ? `sha256:${"c".repeat(64)}` : null, testCount: status === "passed" ? 4 : null,
  durationMs: 25, workerId: "service:test-runner", runner: { kind: profile === "db" || profile === "full"
    ? "local_test_runner" as const : "candidate_worktree" as const, serviceId: "runner:test" },
  observedAt: new Date(now).toISOString(),
});
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
  const deskHandler = createImproveControlRoomHttpHandlerV1({ origin, trust, service: desk, clock: () => now });
  return { ...f, pipelines, saved, desk, deskHandler };
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
  await assert.rejects(f.desk.create(f.identity, f.project.projectId, { ...draft,
    leadWorkerId: "worker:builder" }, "improvement-request-0003"), /conflict/u, "the lead is the template's sign-off worker");
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
    baseRevision: "a".repeat(40), candidateRevision, summary: "Adds an update-ready owner card.",
    changedAreas: ["Home", "improvement desk"], testResults: [testResult("fast")],
    databaseChanges: { kind: "migrations", migrationIds: ["0160_improve_control_room_desk"],
      summary: "Adds inert request, candidate and decision records.", compatibilityNotes: "Run the ledger.",
      rollbackNotes: "Use the reviewed restore plan." }, riskFlags: [{ kind: "database", summary: "database changed",
        needsIndependentReview: true }], independentReviews: [{ reviewId: "review:test", reviewDigest: `sha256:${"2".repeat(64)}`,
        reviewerWorkerId: "worker:checker" }], leadWorkerId: "worker:lead" });
  assert.equal(recorded.candidate.startsDeploy, false);
  await assert.rejects(f.desk.recordCandidate({ projectId: f.project.projectId,
    improvementRequestId: request.requestId, pipelineRunId: request.pipelineRunId,
    baseRevision: "a".repeat(40), candidateRevision, summary: "Different evidence for the same revision.",
    changedAreas: ["Home", "improvement desk"], testResults: [testResult("fast")], databaseChanges: { kind: "none" },
    riskFlags: [], independentReviews: [], leadWorkerId: "worker:lead" }), /update_candidate_conflict/u,
  "a replay must match the entire immutable candidate, not only its revision");
  await assert.rejects(f.desk.recordCandidate({ projectId: f.project.projectId,
    improvementRequestId: request.requestId, pipelineRunId: request.pipelineRunId,
    baseRevision: "a".repeat(40), candidateRevision, summary: "Mismatched runner evidence.", changedAreas: ["desk"],
    testResults: [{ ...testResult("fast"), candidateRevision: "c".repeat(40) }], databaseChanges: { kind: "none" },
    riskFlags: [], independentReviews: [], leadWorkerId: "worker:lead" }), /test result revision mismatch/u);
  const ready = await f.desk.ready(f.identity);
  assert.equal(ready.candidates.length, 1); assert.equal(ready.signedDeployApprovalCreated, false);
  const exact = { candidateId: recorded.candidate.candidateId, expectedVersion: 1,
    candidateRecordDigest: recorded.candidate.recordDigest, decision: "accept" as const };
  await assert.rejects(f.desk.decide(f.identity, { ...exact, expectedVersion: 2 }, "update-owner-stale-0001"), /conflict/u);
  await assert.rejects(f.desk.decide(f.identity, { ...exact, candidateRecordDigest: `sha256:${"9".repeat(64)}` },
    "update-owner-stale-0002"), /conflict/u);
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

test("owner journey automatically publishes the signed-off pipeline and records Accept", async t => {
  const f = await deskFixture(); t.after(() => void f.db.close());
  const requestResponse = await f.deskHandler(webRequest(`/api/v1/projects/${encodeURIComponent(f.project.projectId)}/improvements`,
    "POST", {
    description: "Publish the completed owner journey.", pipelineTemplateId: f.saved.templateId,
    selectedWorkerIds: ["worker:builder", "worker:checker"], leadWorkerId: "worker:lead",
  }, "improvement-publisher-journey-0001"));
  assert.equal(requestResponse.status, 201);
  const request = (await requestResponse.json() as { request: Awaited<ReturnType<typeof f.desk.create>>["request"] }).request;
  const snapshot: IntegrationRepositorySnapshotV1 = { baseRevision: "a".repeat(40), candidateRevision,
    changedPaths: ["db/migrations/0161_update_candidate_evidence.sql", "private-app/app/update-candidates-home.tsx",
      "src/security/digest.ts", "src/improve-control-room/v1/publisher.ts", "tests/improve-control-room-desk.test.ts"],
    addedPaths: ["db/migrations/0161_update_candidate_evidence.sql"],
    commitSubjects: ["Publish completed desk updates"] };
  const calls: string[] = [];
  const runnerResult = (): UpdateCandidateRunnerResultV1 => ({ status: "passed", summary: "Profile passed.",
    evidenceDigest: `sha256:${"3".repeat(64)}`, testCount: 7, durationMs: 40, observedAt: new Date(now).toISOString() });
  assert.throws(() => new UpdateCandidatePublisherV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, f.desk, {
    repository: { observe: async () => snapshot }, pathRules: CONTROL_ROOM_UPDATE_PATH_RULES_V1,
    profiles: CONTROL_ROOM_UPDATE_TEST_PROFILES_V1.map(profile => profile.id === "db"
      ? { ...profile, runner: { kind: "candidate_worktree" as const, serviceId: profile.runner.serviceId } } : profile),
    runner: { run: async () => runnerResult() },
  }), /config_invalid/u, "a DB profile cannot escape the local test-runner service");
  const publisher = new UpdateCandidatePublisherV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, f.desk, {
    repository: { observe: async () => snapshot }, profiles: CONTROL_ROOM_UPDATE_TEST_PROFILES_V1,
    pathRules: CONTROL_ROOM_UPDATE_PATH_RULES_V1, runner: { run: async input => { calls.push(input.profile.id); return runnerResult(); } },
    reviews: { acceptedForRun: async () => [{ reviewId: "review:independent", reviewDigest: `sha256:${"5".repeat(64)}`,
      reviewerWorkerId: "worker:checker" }] },
  });
  assert.deepEqual(await publisher.publishRun(request.pipelineRunId), { state: "not_eligible" },
    "the publisher does nothing before pipeline completion and lead sign-off");
  await f.db.query("UPDATE pipeline_runs SET state='succeeded',completed_at=updated_at WHERE id=$1", [request.pipelineRunId]);
  await f.db.query("UPDATE pipeline_stage_runs SET state='succeeded' WHERE pipeline_run_id=$1 AND stage_kind='signoff'",
    [request.pipelineRunId]);
  const [first, concurrent] = await Promise.all([publisher.publishRun(request.pipelineRunId), publisher.publishRun(request.pipelineRunId)]);
  assert.equal(first.state, "published"); assert.equal(concurrent.state, "published");
  assert.deepEqual(calls, ["fast", "targeted", "db", "full"], "the in-process concurrent caller shares the one profile run");
  const readyResponse = await f.deskHandler(webRequest("/api/v1/update-candidates"));
  assert.equal(readyResponse.status, 200);
  const ready = await readyResponse.json() as Awaited<ReturnType<typeof f.desk.ready>>, candidate = ready.candidates[0]!;
  assert.equal(ready.candidates.length, 1); assert.equal(candidate.state, "ready");
  assert.deepEqual(candidate.testResults.map(result => result.profile), ["fast", "targeted", "db", "full"]);
  assert.equal(candidate.testResults.every(result => result.candidateRevision === candidateRevision), true);
  assert.deepEqual(candidate.databaseChanges, { kind: "migrations", migrationIds: ["0161_update_candidate_evidence"],
    summary: "1 migration added.",
    compatibilityNotes: "Installed only through the database update path: a checked backup first, then automatic restore on failure.",
    rollbackNotes: "Installed only through the database update path: a checked backup first, then automatic restore on failure." });
  assert.deepEqual(candidate.riskFlags.map(flag => flag.kind),
    ["authority", "database", "security"]);
  const home = renderToStaticMarkup(createElement(UpdateCandidatesPanel,
    { state: { state: "ready", candidates: ready.candidates }, onDecide: () => {}, onRetry: () => {} }));
  assert.match(home, /Update ready/u); assert.match(home, /Publish completed desk updates/u); assert.match(home, />Accept</u);
  assert.match(home, /aaaaaaaaaaaa.*bbbbbbbbbbbb/u);
  assert.match(home, /local test runner/u); assert.match(home, /7 tests/u); assert.match(home, /independent review verified/u);
  const decision = { candidateId: candidate.candidateId, expectedVersion: candidate.version,
    candidateRecordDigest: candidate.recordDigest, decision: "accept" } as const;
  const mismatched = await f.deskHandler(webRequest("/api/v1/update-candidates/update-candidate:wrong/decision", "POST",
    decision, "publisher-owner-bad-path-0001"));
  assert.equal(mismatched.status, 400, "a stale or mismatched browser path cannot decide another candidate");
  const acceptedResponse = await f.deskHandler(webRequest(
    `/api/v1/update-candidates/${encodeURIComponent(candidate.candidateId)}/decision`, "POST", decision,
    "publisher-owner-accept-0001"));
  assert.equal(acceptedResponse.status, 201);
  const accepted = await acceptedResponse.json() as Awaited<ReturnType<typeof f.desk.decide>>;
  assert.equal(accepted.decision, "accept"); assert.equal(accepted.startsDeploy, false);
  const after = await f.deskHandler(webRequest("/api/v1/update-candidates"));
  assert.equal(after.status, 200); assert.equal(((await after.json()) as { candidates: unknown[] }).candidates.length, 0);
});

test("V10/V11: role-only database changes reach the owner and eight concurrent sweeps publish once", async () => {
  const runId = "pipeline-run:role-only", recorded: Array<Record<string, unknown>> = [];
  let observations = 0, publications = 0, sweepQueries = 0; const profiles: string[] = [];
  const snapshot: IntegrationRepositorySnapshotV1 = { baseRevision: "a".repeat(40), candidateRevision,
    changedPaths: ["scripts/mac-local/database-role-manifest.mjs", "tools/checked-backup.sql"], addedPaths: [],
    commitSubjects: ["Adjust the production database role manifest"] };
  const client = { query: async (sql: string, values: readonly unknown[]) => {
    if (typeof values[1] === "number") { sweepQueries += 1; return { rows: [{ pipeline_run_id: runId }] }; }
    assert.match(sql, /SELECT request\.id AS request_id/u); assert.equal(values[1], runId);
    return { rows: [{ request_id: "improvement-request:role", project_id: "project:role", pipeline_run_id: runId,
      lead_worker_id: "worker:lead", run_state: "succeeded", signoff_state: "succeeded",
      signoff_worker: "worker:lead", build_worker: "worker:builder" }] };
  } };
  const publisher = new UpdateCandidatePublisherV1(client as never,
    { tenantId: "tenant:web", workspaceId: "workspace:web" }, { recordCandidate: async input => {
      publications += 1; recorded.push(input); return { replayed: false,
        candidate: { candidateId: "update-candidate:role-only" } } as never;
    } }, { repository: { observe: async () => { observations += 1; return snapshot; } },
      profiles: CONTROL_ROOM_UPDATE_TEST_PROFILES_V1, pathRules: CONTROL_ROOM_UPDATE_PATH_RULES_V1,
      runner: { run: async input => { profiles.push(input.profile.id); return { status: "passed", summary: "Passed.",
        evidenceDigest: `sha256:${"3".repeat(64)}`, testCount: 1, durationMs: 1, observedAt: new Date(now).toISOString() }; } },
      reviews: { acceptedForRun: async () => [{ reviewId: "review:role-only", reviewDigest: `sha256:${"4".repeat(64)}`,
        reviewerWorkerId: "worker:checker" }] } });
  assert.throws(() => publisher.sweep(0), /config_invalid/u, "a bad sweep limit is refused before repository work");
  const sweeps = await Promise.all(Array.from({ length: 8 }, () => publisher.sweep(8)));
  assert.equal(sweepQueries, 1, "concurrent sweep callers share one serialized branch-HEAD scan");
  assert.equal(publications, 1); assert.equal(observations, 2, "one publish observes the branch HEAD before and after tests");
  assert.deepEqual(profiles, ["fast", "targeted", "db", "full"]);
  assert.equal(sweeps.every(value => value[0]?.state === "published"), true);
  const database = recorded[0]!.databaseChanges as { kind: string; changedPaths: string[]; migrationIds: string[] };
  assert.deepEqual(database, { kind: "changes", changedPaths: ["scripts/mac-local/database-role-manifest.mjs", "tools/checked-backup.sql"], migrationIds: [],
    summary: "2 database-sensitive paths changed.",
    compatibilityNotes: "Installed only through the database update path: a checked backup first, then automatic restore on failure.",
    rollbackNotes: "Installed only through the database update path: a checked backup first, then automatic restore on failure." });
  const candidate = { ...recorded[0], candidateId: "update-candidate:role-only", state: "ready", version: 1,
    recordDigest: `sha256:${"5".repeat(64)}`, createdAt: new Date(now).toISOString(), decidedAt: null,
    startsDeploy: false, signedDeployApprovalCreated: false } as never;
  const home = renderToStaticMarkup(createElement(UpdateCandidatesPanel,
    { state: { state: "ready", candidates: [candidate] }, onDecide: () => {}, onRetry: () => {} }));
  assert.match(home, /Database:.*database-sensitive paths changed.*database-role-manifest\.mjs.*tools\/checked-backup\.sql/u);
});

test("dependency manifests require an independent review and the full profile", async () => {
  const runId = "pipeline-run:dependency-manifests", recorded: Array<Record<string, unknown>> = [];
  const snapshot: IntegrationRepositorySnapshotV1 = { baseRevision: "a".repeat(40), candidateRevision,
    changedPaths: [".npmrc", ".pnpmfile.cjs", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"], addedPaths: [],
    commitSubjects: ["Update dependency configuration"] };
  const client = { query: async (sql: string, values: readonly unknown[]) => {
    assert.match(sql, /SELECT request\.id AS request_id/u); assert.equal(values[1], runId);
    return { rows: [{ request_id: "improvement-request:dependency", project_id: "project:dependency", pipeline_run_id: runId,
      lead_worker_id: "worker:lead", run_state: "succeeded", signoff_state: "succeeded",
      signoff_worker: "worker:lead", build_worker: "worker:builder" }] };
  } };
  const createPublisher = (reviews: boolean, profiles: string[]) => new UpdateCandidatePublisherV1(client as never,
    { tenantId: "tenant:web", workspaceId: "workspace:web" }, { recordCandidate: async input => {
      recorded.push(input); return { replayed: false, candidate: { candidateId: "update-candidate:dependency" } } as never;
    } }, { repository: { observe: async () => snapshot }, profiles: CONTROL_ROOM_UPDATE_TEST_PROFILES_V1,
      pathRules: CONTROL_ROOM_UPDATE_PATH_RULES_V1, reviews: { acceptedForRun: async () => reviews
        ? [{ reviewId: "review:dependency", reviewDigest: `sha256:${"6".repeat(64)}`, reviewerWorkerId: "worker:checker" }] : [] },
      runner: { run: async input => { profiles.push(input.profile.id); return { status: "passed", summary: "Passed.",
        evidenceDigest: `sha256:${"7".repeat(64)}`, testCount: 1, durationMs: 1, observedAt: new Date(now).toISOString() }; } } });
  assert.deepEqual(await createPublisher(false, []).publishRun(runId), { state: "blocked", reason: "independent_review_required" });
  const profiles: string[] = [];
  assert.deepEqual(await createPublisher(true, profiles).publishRun(runId), { state: "published", candidateId: "update-candidate:dependency" });
  assert.deepEqual(profiles, ["fast", "targeted", "full"]);
  assert.deepEqual(recorded[0]!.riskFlags, [{ kind: "dependency", summary: "dependency configuration changed",
    needsIndependentReview: true }]);
});

test("publisher refuses failed, interrupted, moving and unreviewed evidence, then safely retries", async t => {
  const cases = ["failed", "interrupted", "moving", "review", "migration"] as const;
  for (const scenario of cases) {
    await t.test(scenario, async () => {
      const f = await deskFixture(); try {
        const request = (await f.desk.create(f.identity, f.project.projectId, {
          description: `Exercise ${scenario} publication.`, pipelineTemplateId: f.saved.templateId,
          selectedWorkerIds: ["worker:builder", "worker:checker"], leadWorkerId: "worker:lead",
        }, `publisher-unhappy-${scenario}-0001`)).request;
        await f.db.query("UPDATE pipeline_runs SET state='succeeded',completed_at=updated_at WHERE id=$1", [request.pipelineRunId]);
        await f.db.query("UPDATE pipeline_stage_runs SET state='succeeded' WHERE pipeline_run_id=$1 AND stage_kind='signoff'",
          [request.pipelineRunId]);
        const ordinary: IntegrationRepositorySnapshotV1 = { baseRevision: "a".repeat(40), candidateRevision,
          changedPaths: scenario === "review" ? ["src/security/digest.ts"]
            : scenario === "migration" ? ["db/migrations/0001_existing.sql"]
            : scenario === "moving" ? ["unregistered/file.txt"] : ["private-app/app/home.tsx"],
          addedPaths: [],
          commitSubjects: ["Exercise refusal"] };
        let attempts = 0, observations = 0; const seenProfiles: string[] = [];
        const publisher = new UpdateCandidatePublisherV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, f.desk, {
          repository: { observe: async () => scenario === "moving" && ++observations > 1
            ? { ...ordinary, commitSubjects: ["Repository moved"] } : ordinary },
          profiles: CONTROL_ROOM_UPDATE_TEST_PROFILES_V1, pathRules: CONTROL_ROOM_UPDATE_PATH_RULES_V1,
          reviews: { acceptedForRun: async () => scenario === "review"
            ? [{ reviewId: "review:lead", reviewDigest: `sha256:${"6".repeat(64)}`, reviewerWorkerId: "worker:lead" }]
            : scenario === "moving" || scenario === "migration" ? [{ reviewId: "review:independent", reviewDigest: `sha256:${"7".repeat(64)}`,
              reviewerWorkerId: "worker:checker" }] : [] }, runner: { run: async input => {
            seenProfiles.push(input.profile.id);
            attempts += 1;
            if (scenario === "interrupted" && attempts === 1) throw new Error("stopped halfway");
            return { status: scenario === "failed" && attempts === 1 ? "failed" : "passed", summary: "Bounded result.",
              evidenceDigest: `sha256:${"4".repeat(64)}`, testCount: 1, durationMs: 5, observedAt: new Date(now).toISOString() };
          } },
        });
        const refused = await publisher.publishRun(request.pipelineRunId);
        if (scenario === "migration") {
          assert.equal(refused.state, "published", "a modified or deleted migration reaches the database-change card");
          const candidate = (await f.desk.ready(f.identity)).candidates[0]!;
          assert.deepEqual(candidate.databaseChanges, { kind: "changes", changedPaths: ["db/migrations/0001_existing.sql"],
            migrationIds: ["0001_existing"], summary: "1 database-sensitive path changed.",
            compatibilityNotes: "Installed only through the database update path: a checked backup first, then automatic restore on failure.",
            rollbackNotes: "Installed only through the database update path: a checked backup first, then automatic restore on failure." });
          return;
        }
        assert.equal(refused.state, "blocked");
        if (refused.state === "blocked") assert.equal(refused.reason, { failed: "tests_not_passed",
          interrupted: "test_runner_unavailable", moving: "repository_changed",
          review: "independent_review_required" }[scenario]);
        assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int count FROM control_update_candidates")).rows[0]!.count, 0);
        if (scenario === "moving") assert.deepEqual(seenProfiles, ["fast", "targeted", "full"],
          "an unknown path fails closed to the full profile");
        if (scenario === "failed" || scenario === "interrupted") {
          const retried = await publisher.publishRun(request.pipelineRunId);
          assert.equal(retried.state, "published", "a retry after a non-publishing failure may succeed");
        }
      } finally { await f.db.close(); }
    });
  }
});

test("coordinator completion and periodic sweeps invoke publication without hiding pipeline success", async () => {
  const published: string[] = [], swept: number[] = [];
  const terminal = { runId: "pipeline-run:completed", state: "succeeded" as const,
    completedAt: new Date(now).toISOString(), startsWork: false as const, grantsExecutionAuthority: false as const,
    claimsCancellation: false as const };
  const advanced = { runId: "pipeline-run:active", stageOrdinal: 1, jobId: "job:next", attemptId: "attempt:next",
    queueId: "queue:next", replayed: false, advancedAt: new Date(now).toISOString(), startsWork: true as const,
    grantsExecutionAuthority: false as const, claimsCancellation: false as const };
  let next: typeof terminal | typeof advanced = advanced;
  const bound = bindCandidatePublisherToPipelineAdvanceV1({
    advance: async () => next,
    advanceReady: async (limit = 8) => ({ checked: limit, advanced: [], completed: [], refused: [] }),
  }, {
    publishRun: async runId => { published.push(runId); throw new Error("publisher stopped after completion"); },
    sweep: async (limit = 8) => { swept.push(limit); throw new Error("publisher sweep unavailable"); },
  });
  const activeResult = await bound.advance("pipeline-run:active", "policy:test");
  assert.equal(activeResult.startsWork, true);
  assert.deepEqual(published, [], "an active pipeline stage cannot publish a candidate");
  next = terminal;
  const completedResult = await bound.advance("pipeline-run:completed", "policy:test");
  assert.equal("state" in completedResult ? completedResult.state : undefined, "succeeded",
    "publisher failure cannot rewrite a durable pipeline success");
  assert.deepEqual(published, ["pipeline-run:completed"]);
  assert.equal((await bound.sweep(5)).checked, 5); assert.deepEqual(swept, [5]);
});

test("private integration repository binds a clean exact branch, remote and commit range", async t => {
  const root = await mkdtemp(join(process.cwd(), ".desk-integration-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git(["init", "-b", "integration"]); git(["remote", "add", "origin", "https://example.invalid/control-room.git"]);
  await mkdir(join(root, "db", "migrations"), { recursive: true });
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(root, "db", "migrations", "0001_base.sql"), "SELECT 1;\n");
  git(["add", "README.md", "db/migrations/0001_base.sql"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Base"]);
  const base = git(["rev-parse", "HEAD"]);
  await writeFile(join(root, "README.md"), "base\nchange\n"); git(["add", "README.md"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Bounded change"]);
  let expectedRevision = git(["rev-parse", "HEAD"]);
  const observer = await createLocalIntegrationRepositoryObserverV1({ repositoryPath: root, managedBranch: "integration",
    expectedRemoteName: "origin", expectedRemoteUrl: "https://example.invalid/control-room.git",
    lastAcceptedRevision: base, candidateRevisionForRun: async runId => runId === "pipeline-run:test"
      ? expectedRevision : "c".repeat(40) });
  const snapshot = await observer.observe({ pipelineRunId: "pipeline-run:test" });
  assert.equal(snapshot.baseRevision, base); assert.deepEqual(snapshot.changedPaths, ["README.md"]);
  assert.deepEqual(snapshot.addedPaths, []);
  assert.deepEqual(snapshot.commitSubjects, ["Bounded change"]);
  await assert.rejects(observer.observe({ pipelineRunId: "pipeline-run:other" }), /repository_unavailable/u,
    "the managed branch head must be durably bound to the exact completed run");
  await writeFile(join(root, "README.md"), "dirty\n");
  await assert.rejects(observer.observe({ pipelineRunId: "pipeline-run:test" }), /repository_unavailable/u,
    "a dirty managed branch is never published");
  git(["checkout", "--", "README.md"]); git(["remote", "set-url", "origin", "https://example.invalid/wrong.git"]);
  await assert.rejects(observer.observe({ pipelineRunId: "pipeline-run:test" }), /repository_unavailable/u,
    "an unexpected remote is refused");
  git(["remote", "set-url", "origin", "https://example.invalid/control-room.git"]); git(["checkout", "-b", "unexpected"]);
  await assert.rejects(observer.observe({ pipelineRunId: "pipeline-run:test" }), /repository_unavailable/u,
    "an unexpected branch is refused");
  git(["checkout", "integration"]);
  await writeFile(join(root, "db", "migrations", "0001_base.sql"), "SELECT 2;\n");
  git(["add", "db/migrations/0001_base.sql"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Mutate migration"]);
  expectedRevision = git(["rev-parse", "HEAD"]);
  await assert.rejects(observer.observe({ pipelineRunId: "pipeline-run:test" }), /repository_unavailable/u,
    "an accepted migration is never rewritten");
  const link = `${root}-link`; await symlink(root, link); t.after(() => rm(link, { force: true }));
  await assert.rejects(createLocalIntegrationRepositoryObserverV1({ repositoryPath: link, managedBranch: "integration",
    expectedRemoteName: "origin", expectedRemoteUrl: "https://example.invalid/control-room.git",
    lastAcceptedRevision: base, candidateRevisionForRun: async () => expectedRevision }), /configuration_invalid/u,
  "a symlink binding is refused");
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
    pipelineRunId: request.pipelineRunId, baseRevision: "a".repeat(40), candidateRevision,
    summary: "Integrity-bound candidate.", changedAreas: ["desk"],
    testResults: [testResult("fast")], databaseChanges: { kind: "none" }, riskFlags: [], independentReviews: [],
    leadWorkerId: "worker:lead" });
  // The row guard refuses any edit but an owner decision; tamper beneath it.
  await assert.rejects(f.db.query("UPDATE control_update_candidates SET summary='tampered'"), /transition rejected/u);
  await f.db.query("ALTER TABLE control_update_candidates DISABLE TRIGGER control_update_candidates_update_guard");
  await f.db.query("UPDATE control_update_candidates SET summary='tampered'");
  await assert.rejects(f.desk.ready(f.identity), /improvement_desk_integrity_failed/u);
});

test("the PostgreSQL insert guard treats missing test evidence as a refusal", async () => {
  const sql = await readFile("db/migrations/0161_update_candidate_evidence.sql", "utf8");
  assert.match(sql, /result->>'status' IS DISTINCT FROM 'passed'/u);
  assert.match(sql, /\(result->>'evidenceDigest' ~ '\^sha256:\[a-f0-9\]\{64\}\$'\) IS DISTINCT FROM true/u);
});

test("candidate evidence migrations have a working PGlite rollback path", async t => {
  const f = await taskFixture(); t.after(() => void f.db.close());
  await f.db.exec(await readFile("db/down/0162_validate_update_candidate_evidence.sql", "utf8"));
  await f.db.exec(await readFile("db/down/0161_update_candidate_evidence.sql", "utf8"));
  const columns = (await f.db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
    WHERE table_name='control_update_candidates' AND column_name IN ('risk_flags','independent_reviews')`)).rows;
  assert.deepEqual(columns, []);
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
    summary: "Adds the owner card.", changedAreas: ["Home"], testResults: [testResult("fast", "not_run")],
    databaseChanges: { kind: "none" as const }, riskFlags: [], independentReviews: [],
    leadWorkerId: "worker:lead", state: "ready" as const, version: 1, recordDigest: `sha256:${"e".repeat(64)}`,
    createdAt: new Date(now).toISOString(), decidedAt: null, startsDeploy: false as const, signedDeployApprovalCreated: false as const };
  const home = panel({ state: "ready", candidates: [candidate] });
  assert.match(home, /Update ready/); assert.match(home, /Adds the owner card/); assert.match(home, /fast not run/);
  assert.match(home, />Accept</); assert.match(home, />Decline</);
  assert.match(home, /Deploy and restart are not active/);
  assert.doesNotMatch(home, /deploy now|restart now|install/i, "no control on the card starts a deployment");
});

test("B1a draft saves without dispatch", async t => {
  const f = await deskFixture(); t.after(() => void f.db.close());
  assert.equal(typeof (f.desk as unknown as Record<string, unknown>).saveLoopDraft, "function",
    "B1a persistence method exists");
  const description = "  Keep exact request bytes.\n", settingsText = '{ "fixture": true }\n';
  const saved = await f.desk.saveLoopDraft(f.identity, f.project.projectId, { description, settingsText }, "loop-draft-test-0001");
  assert.equal(saved.request.description, description);
  assert.equal(saved.request.currentVersion, 1);
  assert.equal(saved.request.startsWork, false);
  const rows = (await f.db.query<{ description: string; settings_text: string }>(
    "SELECT description,settings_text FROM control_loop_improvement_inputs")).rows;
  assert.deepEqual(rows, [{ description, settings_text: settingsText }]);
  for (const table of ["pipeline_runs", "work_items", "control_native_task_queue", "control_improvement_requests"]) {
    assert.equal((await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n, 0,
      `B1a draft creates no ${table}`);
  }
});

// SYNTHETIC boundary only: not an implemented or production A2 pin.
const syntheticLoopPin = `sha256:${"7".repeat(64)}`;
const syntheticRawHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const syntheticLoopContract: LoopImprovementContractV1 = {
  toolingRevision: syntheticLoopPin,
  decodeRunIdentity: value => {
    const run = loopImprovementRunIdentitySchemaV1.parse(value);
    assert.match(run.loopRunId, /^synthetic-run-[0-9]+$/u);
    assert.equal(run.adapterId, "synthetic-adapter");
    return run;
  },
  decodeObservation: value => {
    const observed = loopImprovementObservationSchemaV1.parse(value);
    assert.equal(typeof observed.inputVersion, "string");
    assert.match(String(observed.inputVersion), /^SYNTHETIC:[0-9]+$/u);
    assert.equal(typeof observed.confirmation.input_version, "string");
    return observed;
  },
  matchesSavedInput: (run, observation, input) => observation.settingsDigest === `synthetic-sha256:${syntheticRawHash(input.settingsText)}`
    && observation.confirmation.path === `work/docs/${run.loopRunId}.md`
    && observation.confirmation.sha256 === syntheticRawHash(input.description),
};
const syntheticRun = (n = 1) => ({ adapterId: "synthetic-adapter", loopRunId: `synthetic-run-${n}`,
  toolingRevision: syntheticLoopPin, a2SchemaVersion: 1 as const });
const syntheticObservation = (description: string, settingsText: string) => ({ inputVersion: "SYNTHETIC:9",
  settingsDigest: `synthetic-sha256:${syntheticRawHash(settingsText)}`, revision: 12,
  confirmation: { path: "work/docs/synthetic-run-1.md", sha256: syntheticRawHash(description),
    at: "2026-09-04T12:00:00.000Z", who: "owner" as const, input_version: "SYNTHETIC:9" } });
async function loopFixture() {
  const f = await deskFixture(); let attemptedWrites = 0, instantiated = 0;
  const trace = (tx: DatabaseSession): DatabaseSession => ({ query: (sql, params) => {
    if (/INSERT INTO control_loop_improvement_/u.test(sql)) attemptedWrites += 1;
    return tx.query(sql, params);
  } });
  const client: DatabaseClient = { query: (sql, params) => f.client.query(sql, params),
    transaction: work => f.client.transaction(tx => work(trace(tx))),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(trace(tx)), check) };
  const desk = new ImproveControlRoomDeskServiceV1(client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key,
    { instantiate: async () => { instantiated += 1; throw new Error("unexpected_dispatch"); } }, () => now, syntheticLoopContract);
  const draft = { description: "  Exact owner request.\n", settingsText: '{ "fixture": "SYNTHETIC" }\n' };
  const saved = await desk.saveLoopDraft(f.identity, f.project.projectId, draft, "loop-fixture-save-0001");
  const linkInput = { projectId: f.project.projectId, requestId: saved.request.requestId, initialInputVersion: 1, run: syntheticRun() };
  const linked = await desk.recordLoopRunLink(linkInput);
  const start = { requestId: saved.request.requestId, expectedVersion: 1, runLinkId: linked.runLink.runLinkId,
    requestSha256: syntheticRawHash(draft.description), settingsSha256: syntheticRawHash(draft.settingsText) };
  return { ...f, desk, client, draft, saved, linked, linkInput, start,
    observation: syntheticObservation(draft.description, draft.settingsText), writes: () => attemptedWrites, dispatches: () => instantiated };
}

test("B1a byte hashes, immutable history, exact replay and edit-away-and-back authorization invalidation", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close()); const projectId = f.project.projectId;
  assert.equal(f.saved.request.requestSha256, syntheticRawHash(f.draft.description));
  assert.equal(f.saved.request.settingsSha256, syntheticRawHash(f.draft.settingsText));
  assert.equal((await f.desk.viewLoopDesk(f.identity, projectId)).loopRequests[0]!.savedAuthorization, false);
  assert.deepEqual((await f.desk.viewLoopDesk(f.identity, projectId)).legacy, await f.desk.view(f.identity, projectId));
  const replay = await f.desk.saveLoopDraft(f.identity, projectId, f.draft, "loop-fixture-save-0001");
  assert.equal(replay.replayed, true); assert.deepEqual(replay.request, { ...f.saved.request, runLink: f.linked.runLink });
  await assert.rejects(f.desk.saveLoopDraft(f.identity, projectId, { ...f.draft, description: "changed" }, "loop-fixture-save-0001"), /conflict/u);
  assert.equal((await f.desk.recordLoopRunLink(f.linkInput)).replayed, true);
  await assert.rejects(f.desk.recordLoopRunLink({ ...f.linkInput, run: syntheticRun(2) }), /conflict/u);
  const authorized = await f.desk.authorizeLoopStart(f.identity, projectId, f.start, "loop-start-test-0001", f.observation);
  assert.equal(authorized.startsWork, false);
  assert.equal((await f.desk.authorizeLoopStart(f.identity, projectId, f.start, "loop-start-test-0001", f.observation)).replayed, true);
  await assert.rejects(f.desk.authorizeLoopStart(f.identity, projectId, f.start, "loop-start-test-0001",
    { ...f.observation, revision: 13 }), /conflict/u);
  await assert.rejects(f.desk.authorizeLoopStart(f.identity, projectId, f.start, "loop-start-test-0002", f.observation), /conflict/u);
  assert.equal((await f.desk.viewLoopDesk(f.identity, projectId)).loopRequests[0]!.savedAuthorization, true);
  const edit = { requestId: f.start.requestId, expectedVersion: 1, description: "Edited request.", settingsText: f.draft.settingsText };
  const revised = await f.desk.reviseLoopDraft(f.identity, projectId, edit, "loop-edit-test-0001");
  assert.equal(revised.request.currentVersion, 2); assert.equal(revised.request.savedAuthorization, false);
  assert.deepEqual(revised.request.runLink, f.linked.runLink);
  assert.equal((await f.desk.reviseLoopDraft(f.identity, projectId, edit, "loop-edit-test-0001")).replayed, true);
  await assert.rejects(f.desk.reviseLoopDraft(f.identity, projectId, edit, "loop-edit-test-0002"), /conflict/u);
  const back = await f.desk.reviseLoopDraft(f.identity, projectId, { ...edit, ...f.draft, expectedVersion: 2 }, "loop-edit-test-0003");
  assert.equal(back.request.currentVersion, 3); assert.equal(back.request.savedAuthorization, false);
  assert.equal(back.request.requestSha256, f.start.requestSha256);
  await assert.rejects(f.desk.authorizeLoopStart(f.identity, projectId, f.start, "loop-start-test-0001", f.observation), /conflict/u);
  for (const [table, expected] of [["requests", 1], ["inputs", 3], ["run_links", 1], ["authorizations", 1]] as const)
    assert.equal((await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM control_loop_improvement_${table}`)).rows[0]!.n, expected);
  assert.equal(f.dispatches(), 0);
  for (const table of ["pipeline_runs", "work_items", "control_native_task_queue"])
    assert.equal((await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n, 0);
  assert.doesNotMatch(JSON.stringify(await f.desk.viewLoopDesk(f.identity, projectId)), /settingsText|settings_text|auth_tag|start_key|confirmation|SYNTHETIC:9/u);
});

test("B1a historical save and edit replays project the current authorized input", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close()); const projectId = f.project.projectId;
  const edit = { requestId: f.start.requestId, expectedVersion: 1,
    description: "Second saved request.", settingsText: '{ "fixture": "SYNTHETIC", "version": 2 }\n' };
  await f.desk.reviseLoopDraft(f.identity, projectId, edit, "loop-replay-edit-0001");
  const latest = { description: "Third saved request.", settingsText: '{ "fixture": "SYNTHETIC", "version": 3 }\n' };
  await f.desk.reviseLoopDraft(f.identity, projectId, { requestId: f.start.requestId, expectedVersion: 2, ...latest },
    "loop-replay-edit-0002");
  await f.desk.authorizeLoopStart(f.identity, projectId, { ...f.start, expectedVersion: 3,
    requestSha256: syntheticRawHash(latest.description), settingsSha256: syntheticRawHash(latest.settingsText) },
  "loop-replay-start-0001", syntheticObservation(latest.description, latest.settingsText));
  const writes = f.writes();
  const current = (await f.desk.viewLoopDesk(f.identity, projectId)).loopRequests[0]!;
  assert.equal(current.currentVersion, 3); assert.equal(current.savedAuthorization, true);
  for (const [replay, version, original] of [
    [await f.desk.saveLoopDraft(f.identity, projectId, f.draft, "loop-fixture-save-0001"), 1, f.draft],
    [await f.desk.reviseLoopDraft(f.identity, projectId, edit, "loop-replay-edit-0001"), 2, edit],
  ] as const) {
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.request, current, "B1a historical replay returns current version, bytes, hashes and authorization");
    assert.deepEqual(replay.savedInput, { version, description: original.description,
      requestSha256: syntheticRawHash(original.description), settingsSha256: syntheticRawHash(original.settingsText) });
    assert.doesNotMatch(JSON.stringify(replay), /settingsText|settings_text|auth_tag|start_key|confirmation/u);
  }
  assert.equal(f.writes(), writes, "historical replay appends no records");
  const next = await f.desk.reviseLoopDraft(f.identity, projectId, { requestId: current.requestId,
    expectedVersion: current.currentVersion, description: "Fourth saved request.", settingsText: latest.settingsText },
  "loop-replay-edit-0003");
  assert.equal(next.request.currentVersion, 4); assert.equal(next.request.savedAuthorization, false);
  assert.equal(f.dispatches(), 0);
});

test("B1a service owner guard refuses before persistence", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close());
  await f.db.query("UPDATE control_role_grants SET role_key='operator'"); const before = f.writes();
  const error = await f.desk.saveLoopDraft(f.identity, f.project.projectId, f.draft, "loop-owner-refusal-0001").then(() => undefined, error => error);
  assert.equal(f.writes(), before, "B1a owner refusal attempts zero persistence");
  assert.match(String(error), /access_denied/u);
});

test("B1a service current version guard refuses before persistence", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close()); const before = f.writes();
  const error = await f.desk.authorizeLoopStart(f.identity, f.project.projectId, { ...f.start, expectedVersion: 2 },
    "loop-version-refusal-0001", f.observation).then(() => undefined, error => error);
  assert.equal(f.writes(), before, "B1a version refusal attempts zero persistence");
  assert.match(String(error), /conflict/u);
});

test("B1a service hash guard refuses before persistence", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close()); const before = f.writes();
  const error = await f.desk.authorizeLoopStart(f.identity, f.project.projectId, { ...f.start, requestSha256: "0".repeat(64) },
    "loop-hash-refusal-0001", f.observation).then(() => undefined, error => error);
  assert.equal(f.writes(), before, "B1a hash refusal attempts zero persistence");
  assert.match(String(error), /conflict/u);
});

test("B1a service confirmation guard refuses before persistence", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close()); const before = f.writes();
  const error = await f.desk.authorizeLoopStart(f.identity, f.project.projectId, f.start, "loop-confirm-refusal-0001",
    { ...f.observation, confirmation: { ...f.observation.confirmation, input_version: "SYNTHETIC:10" } }).then(() => undefined, error => error);
  assert.equal(f.writes(), before, "B1a confirmation refusal attempts zero persistence");
  assert.match(String(error), /conflict/u);
});

test("B1a service pin guard refuses before persistence", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close());
  const second = await f.desk.saveLoopDraft(f.identity, f.project.projectId, f.draft, "loop-pin-second-root-0001");
  const before = f.writes();
  const error = await f.desk.recordLoopRunLink({ ...f.linkInput, requestId: second.request.requestId,
    run: { ...syntheticRun(2), toolingRevision: `sha256:${"8".repeat(64)}` } }).then(() => undefined, error => error);
  assert.equal(f.writes(), before, "B1a pin refusal attempts zero persistence");
  assert.match(String(error), /loop_contract_pin_mismatch/u);
});

test("B1a service signature guard refuses the whole projection", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close());
  await f.db.exec("ALTER TABLE control_loop_improvement_requests DISABLE TRIGGER USER");
  await f.db.query("UPDATE control_loop_improvement_requests SET auth_tag=$1", [`hmac-sha256:${"0".repeat(64)}`]);
  await f.db.exec("ALTER TABLE control_loop_improvement_requests ENABLE TRIGGER USER");
  await assert.rejects(f.desk.viewLoopDesk(f.identity, f.project.projectId), /loop_improvement_integrity_failed/u,
    "B1a signature projection refusal");
});

test("B1a strict boundary, missing contract, revoked and expired sessions leave no partial draft", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close()); const projectId = f.project.projectId;
  for (const draft of [{ ...f.draft, selectedWorkerIds: [] }, { ...f.draft, description: "  " },
    { ...f.draft, settingsText: "[]" }, { ...f.draft, settingsText: '{"x":"' + "é".repeat(33000) + '"}' },
    { ...f.draft, description: "-----BEGIN PRIVATE KEY-----" }])
    await assert.rejects(f.desk.saveLoopDraft(f.identity, projectId, draft, "loop-invalid-input-0001"), /invalid_request/u);
  await assert.rejects(f.desk.saveLoopDraft(f.identity, "project:foreign", f.draft, "loop-foreign-test-0001"), /not_found/u);
  const unpinned = new ImproveControlRoomDeskServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key, undefined, () => now);
  await assert.rejects(unpinned.recordLoopRunLink(f.linkInput), /loop_contract_unavailable/u);
  await assert.rejects(unpinned.authorizeLoopStart(f.identity, projectId, f.start, "loop-unpinned-0001", f.observation), /loop_contract_unavailable/u);
  await assert.rejects(f.desk.recordLoopRunLink({ ...f.linkInput, run: { ...syntheticRun(), a2SchemaVersion: 2 } }));
  for (const observed of [{ ...f.observation, inputVersion: 9 }, { ...f.observation, settingsDigest: "wrong" },
    { ...f.observation, confirmation: { ...f.observation.confirmation, path: "work/docs/wrong.md" } },
    { ...f.observation, confirmation: { ...f.observation.confirmation, who: "worker" } },
    { ...f.observation, confirmation: { ...f.observation.confirmation, at: "yesterday" } }])
    await assert.rejects(f.desk.authorizeLoopStart(f.identity, projectId, f.start, "loop-invalid-observation-0001", observed));
  await assert.rejects(f.desk.saveLoopDraft({ ...f.identity, expiresAt: new Date(now).toISOString() }, projectId, f.draft,
    "loop-expired-test-0001"), /authentication_required/u);
  await f.db.query("UPDATE control_web_sessions SET revoked_at=$1", [new Date(now).toISOString()]);
  await assert.rejects(f.desk.saveLoopDraft(f.identity, projectId, f.draft, "loop-revoked-test-0001"), /authentication_required/u);
  assert.equal(f.writes(), 3, "only the initial root, input and link were attempted");
});

test("B1a precommit expiry rolls back root and input together", async t => {
  const f = await deskFixture(); t.after(() => void f.db.close()); let current = now, attempts = 0;
  const traced = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    const result = await tx.query<T>(sql, params);
    if (/INSERT INTO control_loop_improvement_inputs/u.test(sql)) { attempts += 1; current = now + 3600000; }
    return result;
  } });
  const client: DatabaseClient = { query: f.client.query,
    transaction: work => f.client.transaction(tx => work(traced(tx))),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(traced(tx)), check) };
  const desk = new ImproveControlRoomDeskServiceV1(client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key, undefined, () => current);
  await assert.rejects(desk.saveLoopDraft(f.identity, f.project.projectId, { description: "Expired before commit.", settingsText: "{}" },
    "b1a-expired-precommit-0001"), /authentication_required/u);
  assert.equal(attempts, 1);
  for (const table of ["control_loop_improvement_requests", "control_loop_improvement_inputs"])
    assert.equal((await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n, 0);
});

for (const difference of [-1, 1]) test(`B1a injected fixture catalog count ${difference}`, async t => {
  const f = await deskFixture(); t.after(() => void f.db.close()); let closed = false, catalog = false, locked = false;
  assert.equal(await readPrivateWebSchemaDigest(f.client), privateWebSchemaDigest, "injected count proof has the measured schema");
  const hash = "a".repeat(64), manifest = { commit: "b".repeat(40), tree: "c".repeat(40), artifactDigest: hash };
  const config = { host: "127.0.0.1", port: 58460, database: "cr14b_rehearsal_catalog", username: "control_room_migrator",
    password: "synthetic-test-only", majorVersion: 17 as const };
  const web = { ...config, username: "control_room_web" };
  const traced = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT current_user=session_user")) return { rows: [{ valid: true }] as T[] };
    if (sql.includes("SELECT c.relname AS name")) { catalog = true;
      // These cases isolate only catalog cardinality; the real PG case never substitutes query results.
      const actual = await tx.query<{ name: string }>(sql, params), rows = actual.rows;
      assert.equal(rows.length, 253);
      return { rows: (difference < 0 ? rows.slice(1) : [...rows, { name: "synthetic_extra_table" }]) as T[] };
    }
    if (sql.startsWith("LOCK TABLE")) locked = true;
    return tx.query<T>(sql, params);
  } });
  const prep = createInjectedPrivateFixturePreparation({ clock: () => now, monotonic: () => 0,
    openDatabase: () => ({ client: { query: f.client.query,
      transaction: work => f.client.transaction(tx => work(traced(tx))),
      transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(traced(tx)), check) },
      close: async () => { closed = true; } } as ReturnType<typeof createPrivatePostgresDatabase>) });
  const result = await prep.prepare({ manifest, migrator: config, webDatabase: { host: web.host, port: web.port, database: web.database,
    username: web.username, majorVersion: 17 }, packet: { manifest, migratorScopeDigest: fixtureMigratorScopeDigest(config),
    webScopeDigest: rehearsalScopeDigest(web), ownerApprovalDigest: hash, cleanupPlanDigest: hash, pgPackageDigest: hash,
    pgVersionNumber: 170000, expiresAt: now + 120000, durationMs: 60000, dedicatedEmptyDatabase: true,
    migrationsApplied: "0001-0054", setupRolesAccepted: true, maximumConnections: 1, maximumTransactions: 1,
    maximumStatements: 256, installOrProvision: false, automaticRetry: false, cleanup: "close_owned_client_then_operator_database_cleanup" } });
  assert.equal(result.evidence.disposition, "stopped"); assert.equal(catalog, true); assert.equal(locked, false); assert.equal(closed, true);
});

test("B1a foreign owner and tenant cannot mutate saved lineage", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close());
  const subject = "second-test-owner", id = "identity:second-loop-owner", tokenDigest = sha256Digest({ session: subject });
  await f.db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,'tenant:web','human','Second fixture owner',$2,$3,'active',$4,$4)`,
  [id, f.identity.provider, sha256Digest({ provider: f.identity.provider, subject }), new Date(now).toISOString()]);
  await f.db.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:second-loop-owner','tenant:web',$1,'owner','["*"]','["*"]','critical',true,false,$2,$2)`, [id, new Date(now).toISOString()]);
  const second = { ...f.identity, subject, tokenDigest }, before = f.writes();
  await assert.rejects(f.desk.reviseLoopDraft(second, f.project.projectId, { ...f.draft, requestId: f.start.requestId, expectedVersion: 1 },
    "b1a-foreign-owner-edit-0001"), /not_found/u);
  await assert.rejects(f.desk.authorizeLoopStart(second, f.project.projectId, f.start, "b1a-foreign-owner-start-0001", f.observation), /not_found/u);
  assert.equal(f.writes(), before);
  const foreignTenant = new ImproveControlRoomDeskServiceV1(f.client, { tenantId: "tenant:other", workspaceId: "workspace:web" }, key,
    undefined, () => now, syntheticLoopContract);
  await assert.rejects(foreignTenant.viewLoopDesk(f.identity, f.project.projectId), /access_denied/u);
  assert.equal(f.writes(), before);
});

test("B1a service Start owner guard refuses before persistence", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close());
  await f.db.query("UPDATE control_role_grants SET role_key='operator'"); const before = f.writes();
  const error = await f.desk.authorizeLoopStart(f.identity, f.project.projectId, f.start, "b1a-start-owner-guard-0001", f.observation)
    .then(() => undefined, error => error);
  assert.equal(f.writes(), before, "B1a Start owner refusal attempts zero persistence");
  assert.match(String(error), /access_denied/u);
});

test("B1a service high risk guard refuses before persistence", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close());
  await f.db.query("UPDATE control_role_grants SET risk_ceiling='low'"); const before = f.writes();
  const error = await f.desk.authorizeLoopStart(f.identity, f.project.projectId, f.start, "b1a-start-risk-guard-0001", f.observation)
    .then(() => undefined, error => error);
  assert.equal(f.writes(), before, "B1a high risk refusal attempts zero persistence");
  assert.match(String(error), /access_denied/u);
});

test("B1a service settings observation guard refuses before persistence", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close()); const before = f.writes();
  const error = await f.desk.authorizeLoopStart(f.identity, f.project.projectId, f.start, "b1a-settings-guard-0001",
    { ...f.observation, settingsDigest: "synthetic-wrong-digest" }).then(() => undefined, error => error);
  assert.equal(f.writes(), before, "B1a settings observation refusal attempts zero persistence");
  assert.match(String(error), /conflict/u);
});

test("B1a service record digest guard refuses the whole projection", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close());
  await f.db.exec("ALTER TABLE control_loop_improvement_requests DISABLE TRIGGER USER");
  await f.db.query("UPDATE control_loop_improvement_requests SET record_digest=$1", [`sha256:${"0".repeat(64)}`]);
  await f.db.exec("ALTER TABLE control_loop_improvement_requests ENABLE TRIGGER USER");
  await assert.rejects(f.desk.viewLoopDesk(f.identity, f.project.projectId), /loop_improvement_integrity_failed/u,
    "B1a record digest projection refusal");
});


test("B2a desk HTTP delegates one signed legacy/loop projection without adapter access", async t => {
  const f = await loopFixture(); t.after(() => void f.db.close());
  const legacyDesk = new ImproveControlRoomDeskServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key, f.pipelines, () => now);
  const legacy = (await legacyDesk.create(f.identity, f.project.projectId, { description: "Retained legacy pipeline.", pipelineTemplateId: (await f.desk.view(f.identity, f.project.projectId)).templates[0]!.templateId,
    selectedWorkerIds: ["worker:builder", "worker:checker"], leadWorkerId: "worker:lead" }, "b2a-legacy-fixture-0001")).request;
  let adapterCalls = 0;
  const adapter = { contract: syntheticLoopContract, status: () => { adapterCalls++; throw new Error("unexpected_adapter_read"); } } as never;
  const bridge = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, { integrityKey: key, adapter }, () => now);
  const handler = createImproveControlRoomHttpHandlerV1({ origin, trust, loopBridge: bridge, clock: () => now });
  const path = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/improvements/loop/desk`;
  const before = f.writes();
  const response = await handler(webRequest(path)); assert.equal(response.status, 200);
  const value = await response.json(); assert.deepEqual(value, await f.desk.viewLoopDesk(f.identity, f.project.projectId));
  assert.equal(value.legacy.requests[0].requestId, legacy.requestId);
  assert.ok(value.loopRequests[0].runLink);
  assert.equal(value.loopRequests[0].runLink.initialInputVersion, 1);
  assert.equal(value.loopRequests[0].startsWork, false); assert.equal(value.loopRequests[0].grantsDeployAuthority, false);
  assert.equal(response.headers.get("cache-control"), "no-store");
  for (const suffix of ["?filter=all", "?owner=other"]) assert.equal((await handler(webRequest(path + suffix))).status, 400);
  assert.equal((await handler(webRequest(path, "POST", {}))).status, 400);
  const foreign = webRequest(path); foreign.headers.set("origin", "https://foreign.invalid"); foreign.headers.set("sec-fetch-site", "cross-site");
  assert.equal((await handler(foreign)).status, 403);
  const missing = webRequest(path); missing.headers.delete("cf-access-jwt-assertion"); assert.equal((await handler(missing)).status, 401);
  assert.equal((await handler(webRequest(path, "GET", undefined, "b2a-read-key-00001", webToken({ exp: now / 1000 - 1 })))).status, 401);
  await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE id='grant:web'");
  assert.equal((await handler(webRequest(path))).status, 403);
  await f.db.query("UPDATE control_role_grants SET role_key='owner',revoked_at=$1 WHERE id='grant:web'", [new Date(now).toISOString()]);
  assert.equal((await handler(webRequest(path))).status, 403);
  await f.db.query("UPDATE control_web_sessions SET revoked_at=$1 WHERE token_digest=$2", [new Date(now).toISOString(), f.identity.tokenDigest]);
  assert.equal((await handler(webRequest(path))).status, 401);
  assert.equal(f.writes(), before); assert.equal(adapterCalls, 0);
});

test("B5 fixture completion cannot become a legacy candidate", async t => {
  const { syntheticFirstWebsiteFixtureV1, driveSyntheticFirstWebsiteV1 } = await import("./helpers/improve-control-room-first-website");
  const f = await syntheticFirstWebsiteFixtureV1(); t.after(() => f.close());
  const legacyTables = ["control_improvement_requests", "control_update_candidates", "control_update_candidate_decisions", "pipeline_runs", "work_items"];
  const counts = async () => Object.fromEntries(await Promise.all(legacyTables.map(async table =>
    [table, (await f.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n] as const)));
  const before = await counts();
  const { requestId } = await driveSyntheticFirstWebsiteV1(f, f.bridge, f.identity, f.project.projectId, "b5-legacy");
  assert.equal(f.phase(), "finished");
  // The SYNTHETIC completion reaches only the loop publisher, which refuses it at BASE (see BUILD-B5).
  await assert.rejects(f.publish(), /loop_candidate_integrity_failed/u);
  // The legacy pipeline candidate path has no row to bind a loop request or run link to.
  for (const pipelineRunId of [requestId, (await f.lineage()).id])
    await assert.rejects(f.desk.recordCandidate({ projectId: f.project.projectId, improvementRequestId: requestId, pipelineRunId,
      baseRevision: f.heads.base, candidateRevision: f.heads.final, summary: "B5 fixture completion.", changedAreas: ["index.html"],
      testResults: [testResult("fast")], databaseChanges: { kind: "none" }, riskFlags: [], independentReviews: [],
      leadWorkerId: "worker:lead" }), "B5 a loop completion is never a legacy candidate");
  assert.deepEqual(await counts(), before, "B5 fixture completion writes no legacy request, candidate, decision or pipeline row");
  const view = await f.desk.viewLoopDesk(f.identity, f.project.projectId);
  assert.deepEqual(view.legacy, await f.desk.view(f.identity, f.project.projectId));
  assert.equal(view.legacy.requests.length, 0); assert.deepEqual(view.loopRequests.map(r => r.requestId), [requestId]);
  assert.equal(view.loopRequests[0]!.grantsDeployAuthority, false);
  assert.equal((await f.client.query("SELECT 1 FROM control_loop_update_candidates")).rows.length, 0);
});
