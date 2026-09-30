import assert from "node:assert/strict";
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
import { now, origin, request as webRequest, trust } from "./helpers/web-foundation";
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
  assert.deepEqual(candidate.databaseChanges.kind === "migrations" ? candidate.databaseChanges.migrationIds : [],
    ["0161_update_candidate_evidence"]); assert.deepEqual(candidate.riskFlags.map(flag => flag.kind),
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
            : scenario === "moving" ? [{ reviewId: "review:independent", reviewDigest: `sha256:${"7".repeat(64)}`,
              reviewerWorkerId: "worker:checker" }] : [] }, runner: { run: async input => {
            seenProfiles.push(input.profile.id);
            attempts += 1;
            if (scenario === "interrupted" && attempts === 1) throw new Error("stopped halfway");
            return { status: scenario === "failed" && attempts === 1 ? "failed" : "passed", summary: "Bounded result.",
              evidenceDigest: `sha256:${"4".repeat(64)}`, testCount: 1, durationMs: 5, observedAt: new Date(now).toISOString() };
          } },
        });
        const refused = await publisher.publishRun(request.pipelineRunId);
        assert.equal(refused.state, "blocked");
        if (refused.state === "blocked") assert.equal(refused.reason, { failed: "tests_not_passed",
          interrupted: "test_runner_unavailable", moving: "repository_changed",
          review: "independent_review_required", migration: "repository_unavailable" }[scenario]);
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
    advanceReady: async (limit = 8) => ({ checked: limit, advanced: [], completed: [] }),
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
