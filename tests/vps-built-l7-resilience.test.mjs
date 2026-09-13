import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateTaskBootstrap } from "../dist-vps/server/taskBootstrap.js";
import { createTaskPlanningBrowserClient } from "../src/web/v1/task-planning-browser-client.ts";
import { createTaskRevisionBrowserClient, revisionRequestFromReview } from "../src/web/v1/task-revision-browser-client.ts";
import { WebProjectService } from "../src/web/v1/project-service.ts";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { computeAuthorityDigest, sha256Digest } from "../src/security/index.ts";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion.ts";
import { nativeRevisedExecutionAfterCapacityReleaseFixture, revisedText } from "./helpers/native-revised-result.ts";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { taskDraft } from "./helpers/web-task.ts";
import { origin, request } from "./helpers/web-foundation.ts";

test("compiled mounted lifecycle survives lost replies and restart at the real two-slot limit", async t => {
  const source = await nativeQualityCompletionFixture();
  let revised;
  t.after(async () => { await revised?.close(); await source.close(); });

  const projects = new WebProjectService(source.f.db, source.f.scope, source.f.clock);
  const projectB = (await projects.create(source.f.identity,
    { title: "L7 unrelated project", summary: "Cross-project resilience control" }, "l7-project-b-create-001")).project;
  const profileB = { ...source.profile, id: "profile:l7-project-b", projectId: projectB.projectId,
    name: "L7 unrelated project checks" };
  await source.f.reviewStore.registerProfile(profileB);
  const authorityB = { ...source.f.plannerConfig.template.authority, projectId: projectB.projectId };
  authorityB.digest = computeAuthorityDigest(authorityB);
  const templateB = { ...source.f.plannerConfig.template, id: "template:l7-project-b", authority: authorityB,
    acceptanceProfileId: profileB.id, acceptanceProfileDigest: sha256Digest(profileB) };
  const projectBDraft = { ...taskDraft, title: "Unrelated L7 planning source" };
  const projectBTask = await source.f.tasks.propose(source.f.identity, projectB.projectId, projectBDraft, "l7-project-b-task-001");

  const startup = await taskStartupFixture(source.f.assignmentFixture);
  const canonical = new CanonicalStore(startup.coordinator.client);
  const config = { ...startup.config, coordinator: { ...startup.config.coordinator,
    planning: { ...source.f.plannerConfig, additionalTemplates: [templateB] },
    quality: { ...source.f.ownerConfig, scenarios: [source.scenario] }, revisionPlanning: true } };
  const mounts = [];
  async function mount() {
    let application;
    const opened = [];
    const runtime = await createPrivateTaskBootstrap({ clock: source.f.clock,
      openDatabase(database) {
        const pool = startup.pool(database.username);
        opened.push({ username: database.username, pool });
        return pool;
      },
      install(value) { application = value; },
    }).start(config);
    assert.ok(application); assert.equal(runtime.isReady(), true);
    assert.deepEqual(opened.map(value => value.username), ["web_test", "coordinator_test"]);
    assert.equal(new Set(opened.map(value => value.pool)).size, 2);
    const mounted = { application, opened, runtime };
    mounts.push(mounted); return mounted;
  }
  const send = (mounted, webRequest) => mounted.application.handle(webRequest, () => new Response("shell"));
  const browserTransport = mounted => async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cf-access-jwt-assertion", source.f.jwt); headers.set("origin", origin);
    return send(mounted, new Request(`${origin}${url}`, { ...init, headers }));
  };
  const sourceStates = () => source.states();
  const projectBState = async () => ({
    project: await projects.get(source.f.identity, projectB.projectId),
    task: await canonical.get(source.f.scope.tenantId, "job", projectBTask.receipt.jobId),
  });

  const runtime1 = await mount();
  const sourceRequest = { ...source.request, projectId: source.registration.projectId, jobId: source.registration.jobId };
  const reconcileSource = () => runtime1.runtime.quality.reconcile(sourceRequest, new AbortController().signal);
  const sourceBeforeRelease = await sourceStates();
  const releasedSource = await reconcileSource();
  assert.equal(releasedSource.disposition, "waiting_review"); assert.equal(releasedSource.verification, "recorded");
  assert.equal(releasedSource.capacity.replayed, false);
  const sourceAfterRelease = await sourceStates();
  assert.deepEqual(sourceAfterRelease.job, sourceBeforeRelease.job); assert.deepEqual(sourceAfterRelease.attempt, sourceBeforeRelease.attempt);
  assert.equal(sourceAfterRelease.lease.state, "released");
  assert.equal(sourceAfterRelease.lease.version, sourceBeforeRelease.lease.version + 1);
  assert.equal((await source.f.db.query("SELECT id FROM control_leases WHERE state='active' AND node_id=$1",
    [source.f.route.nodeId])).rows.length, 1);

  const sourceReviewPath = `/api/v1/projects/${source.registration.projectId}/tasks/${source.registration.jobId}`
    + `/results/${source.artifact.artifactId}/reviews/${source.target.id}`;
  const feedback = "Prepare a clearer explanation of the recorded evidence.";
  const sourceReviewDraft = { artifactId: source.artifact.artifactId, targetId: source.target.id,
    targetDigest: source.request.targetDigest, contentHash: source.request.contentHash,
    decision: "changes_requested", feedback };
  const sourceReviewedResponse = await send(runtime1,
    request(sourceReviewPath, "POST", sourceReviewDraft, "l7-source-review-001", source.f.jwt));
  assert.equal(sourceReviewedResponse.status, 201, await sourceReviewedResponse.clone().text());
  const sourceReview = (await sourceReviewedResponse.json()).receipt;
  const changed = await reconcileSource();
  assert.equal(changed.disposition, "changes_requested"); assert.equal(changed.verification, "not_run");
  assert.equal(changed.capacity.replayed, true); assert.deepEqual(await sourceStates(), sourceAfterRelease);

  const sourceOptionsResponse = await send(runtime1, request(sourceReviewPath, "GET", undefined, undefined, source.f.jwt));
  assert.equal(sourceOptionsResponse.status, 200, await sourceOptionsResponse.clone().text());
  const sourceOptions = await sourceOptionsResponse.json();
  const revisionDraft = revisionRequestFromReview(source.registration.id, sourceOptions);
  assert.ok(revisionDraft); assert.equal(revisionDraft.reviewId, sourceReview.reviewId);
  const revisionStatuses = [];
  const revisionClient = createTaskRevisionBrowserClient(async (url, init) => {
    const response = await browserTransport(runtime1)(url, init); revisionStatuses.push(response.status); return response;
  });
  const revisionPlan = await revisionClient.prepare(source.registration.projectId, source.registration.jobId, revisionDraft);
  assert.deepEqual(revisionStatuses, [201]); assert.equal(revisionPlan.revisionNumber, 1);
  assert.equal(revisionPlan.startsWork, false); assert.equal(revisionPlan.grantsExecutionAuthority, false);

  revised = await nativeRevisedExecutionAfterCapacityReleaseFixture(source, revisionPlan);
  assert.equal(source.f.route.maxConcurrentTasks, 2);
  assert.equal((await source.f.db.query("SELECT id FROM control_leases WHERE state='active' AND node_id=$1",
    [source.f.route.nodeId])).rows.length, 2);
  const childReviewPlan = await revised.register();
  const delivered = await revised.deliver(revisedText);
  const childContext = await source.f.db.transaction(tx => revised.submission.inspectSubmitted(tx,
    revised.plan.tenantId, revised.registration.id));
  assert.equal(childContext.plan.schema, "control-room.native-review-plan/v2");
  assert.equal(childContext.snapshot.target.supersedesTargetId, source.target.id);
  assert.equal(childContext.snapshot.target.rootTargetId, source.target.rootTargetId);
  const child = { jobId: revised.plan.job.id, runId: revised.registration.id,
    artifactId: delivered.artifact.artifactId, artifact: delivered.artifact,
    target: childContext.snapshot.target, targetDigest: childContext.snapshot.targetDigest };
  const childRequest = { tenantId: revised.plan.tenantId, projectId: revised.plan.projectId,
    jobId: child.jobId, runId: child.runId, targetDigest: child.targetDigest, contentHash: child.artifact.contentHash };
  assert.equal(childReviewPlan.plan.targetId, child.target.id);
  const counters = revised.counters();

  const projectBBeforePlanning = await projectBState();
  let projectBPlanningWrites = 0;
  const planningClient = createTaskPlanningBrowserClient(async (url, init) => {
    const response = await browserTransport(runtime1)(url, init);
    if (init?.method === "POST") {
      projectBPlanningWrites++;
      assert.equal(projectBPlanningWrites, 1); assert.equal(response.status, 201, await response.clone().text());
      await response.body?.cancel();
      throw new Error("synthetic_project_b_planning_reply_lost");
    }
    return response;
  });
  const projectBDigest = sha256Digest(projectBDraft);
  await assert.rejects(planningClient.prepare(projectB.projectId, projectBTask.receipt.jobId, projectBDigest),
    error => error?.code === "uncertain");
  assert.equal(planningClient.hasPending(), true); assert.equal(projectBPlanningWrites, 1);
  const recoveredProjectBPlan = await planningClient.options(projectB.projectId, projectBTask.receipt.jobId, projectBDigest);
  assert.equal(recoveredProjectBPlan.availability, "already_planned"); assert.ok(recoveredProjectBPlan.savedPlan);
  assert.equal(planningClient.hasPending(), false); assert.equal(projectBPlanningWrites, 1);
  assert.deepEqual(await projectBState(), projectBBeforePlanning);

  const crossProjectResult = await send(runtime1, request(
    `/api/v1/projects/${projectB.projectId}/tasks/${source.registration.jobId}/results`, "GET", undefined, undefined, source.f.jwt));
  const crossProjectTask = await send(runtime1, request(
    `/api/v1/projects/${source.registration.projectId}/tasks/${projectBTask.receipt.jobId}`, "GET", undefined, undefined, source.f.jwt));
  assert.equal(crossProjectResult.status, 404); assert.equal(crossProjectTask.status, 404);

  const childResultsPath = `/api/v1/projects/${revised.plan.projectId}/tasks/${child.jobId}/results`;
  const childReviewPath = `${childResultsPath}/${child.artifactId}/reviews/${child.target.id}`;
  const mutationState = async () => ({
    snapshot: await source.f.reviewStore.snapshot(revised.plan.tenantId, child.target.id),
    commands: Number((await source.f.db.query("SELECT count(*) AS count FROM control_web_task_review_commands WHERE tenant_id=$1 AND target_id=$2",
      [revised.plan.tenantId, child.target.id])).rows[0].count),
    audits: Number((await source.f.db.query("SELECT count(*) AS count FROM audit_events WHERE tenant_id=$1 AND action='tasks.reviews.record' AND target_id IN (SELECT id FROM control_completion_gate_records WHERE tenant_id=$1 AND parent_id=$2)",
      [revised.plan.tenantId, child.target.id])).rows[0].count),
    checkpoint: source.f.checkpoints.read(`completion-gate:${revised.plan.tenantId}`),
  });
  const beforeInvalidReview = await mutationState();
  const invalidReview = await send(runtime1, request(childReviewPath, "POST", {
    artifactId: child.artifactId, targetId: child.target.id, targetDigest: child.targetDigest,
    contentHash: source.artifact.contentHash, decision: "accepted", feedback: "",
  }, "l7-invalid-child-review-001", source.f.jwt));
  assert.equal(invalidReview.status, 409); assert.deepEqual(await mutationState(), beforeInvalidReview);

  const reconcileChild1 = () => runtime1.runtime.quality.reconcile(childRequest, new AbortController().signal);
  const childBeforeVerification = await revised.childStates();
  const waitingChild = await reconcileChild1();
  assert.equal(waitingChild.disposition, "waiting_review"); assert.equal(waitingChild.verification, "recorded");
  assert.equal(waitingChild.capacity.replayed, false);
  const releasedChild = await revised.childStates();
  assert.deepEqual(releasedChild.job, childBeforeVerification.job); assert.deepEqual(releasedChild.attempt, childBeforeVerification.attempt);
  assert.equal(releasedChild.lease.state, "released");
  assert.equal(releasedChild.lease.version, childBeforeVerification.lease.version + 1);

  const acceptedChildDraft = { artifactId: child.artifactId, targetId: child.target.id, targetDigest: child.targetDigest,
    contentHash: child.artifact.contentHash, decision: "accepted", feedback: "" };
  let childReviewWrites = 0;
  await assert.rejects(async () => {
    childReviewWrites++;
    const response = await send(runtime1,
      request(childReviewPath, "POST", acceptedChildDraft, "l7-child-review-001", source.f.jwt));
    assert.equal(response.status, 201, await response.clone().text());
    await response.body?.cancel();
    throw new Error("synthetic_child_review_reply_lost");
  }, { message: "synthetic_child_review_reply_lost" });
  assert.equal(childReviewWrites, 1);
  const sourceStable = await sourceStates(), projectBStable = await projectBState();
  assert.deepEqual(sourceStable.lease, sourceAfterRelease.lease);
  assert.deepEqual(revised.counters(), counters);

  await runtime1.runtime.close();
  assert.equal(runtime1.runtime.isReady(), false);
  assert.ok(runtime1.opened.every(value => value.pool.closes() === 1 && !value.pool.isAvailable()));

  const runtime2 = await mount();
  assert.ok(runtime2.opened.every(value => !runtime1.opened.some(prior => prior.pool === value.pool)));
  const sourceOptionsAfterRestart = await send(runtime2, request(sourceReviewPath, "GET", undefined, undefined, source.f.jwt));
  assert.equal(sourceOptionsAfterRestart.status, 200, await sourceOptionsAfterRestart.clone().text());
  assert.equal((await sourceOptionsAfterRestart.json()).ownReview.reviewId, sourceReview.reviewId);
  const revisionReplayStatuses = [];
  const revisionReplayClient = createTaskRevisionBrowserClient(async (url, init) => {
    const response = await browserTransport(runtime2)(url, init); revisionReplayStatuses.push(response.status); return response;
  });
  const savedRevision = await revisionReplayClient.prepare(source.registration.projectId, source.registration.jobId, revisionDraft);
  assert.deepEqual(revisionReplayStatuses, [200]); assert.deepEqual(savedRevision, revisionPlan);
  const recoveredAfterRestart = await createTaskPlanningBrowserClient(browserTransport(runtime2))
    .options(projectB.projectId, projectBTask.receipt.jobId, projectBDigest);
  assert.deepEqual(recoveredAfterRestart.savedPlan, recoveredProjectBPlan.savedPlan);
  const childPageResponse = await send(runtime2, request(childResultsPath, "GET", undefined, undefined, source.f.jwt));
  assert.equal(childPageResponse.status, 200, await childPageResponse.clone().text());
  const childPage = await childPageResponse.json();
  const childLineage = childPage.reviews.find(value => value.targetId === child.target.id);
  assert.ok(childLineage); assert.equal(childLineage.revision, 1);
  assert.equal(childLineage.supersedesTargetId, source.target.id);
  assert.deepEqual(childLineage.matchingArtifactIds, [child.artifactId]);
  assert.equal(childLineage.verifications.length, 1); assert.equal(childLineage.reviews.length, 1);
  assert.equal(childLineage.reviews[0].decision, "accepted");
  const reviewRows = await source.f.db.query(
    "SELECT review_id FROM control_web_task_review_commands WHERE tenant_id=$1 AND target_id=$2", [revised.plan.tenantId, child.target.id]);
  assert.equal(reviewRows.rows.length, 1); assert.equal(childReviewWrites, 1);

  const reconcileChild2 = () => runtime2.runtime.quality.reconcile(childRequest, new AbortController().signal);
  const completed = await reconcileChild2();
  assert.equal(completed.disposition, "completed"); assert.equal(completed.completion.replayed, false);
  assert.equal(completed.completion.receipt.jobId, child.jobId);
  assert.equal(completed.completion.receipt.leaseVersion, releasedChild.lease.version);
  const childCompleted = await revised.childStates();
  assert.equal(childCompleted.job.state, "succeeded"); assert.equal(childCompleted.attempt.state, "succeeded");
  assert.deepEqual(childCompleted.lease, releasedChild.lease);
  const completionAudits = await source.f.db.query(
    "SELECT id FROM audit_events WHERE tenant_id=$1 AND action='task.native.completed' AND target_id=$2",
    [revised.plan.tenantId, child.jobId]);
  assert.equal(completionAudits.rows.length, 1);

  const replay = await reconcileChild2();
  assert.equal(replay.disposition, "completed"); assert.equal(replay.completion.replayed, true);
  assert.deepEqual(replay.completion.receipt, completed.completion.receipt);
  assert.deepEqual(await revised.childStates(), childCompleted);
  assert.deepEqual((await sourceStates()).lease, sourceStable.lease);
  assert.deepEqual(await sourceStates(), sourceStable);
  assert.deepEqual(await projectBState(), projectBStable);
  assert.deepEqual(revised.counters(), counters);
  assert.equal((await source.f.db.query(
    "SELECT id FROM audit_events WHERE tenant_id=$1 AND action='task.native.completed' AND target_id=$2",
    [revised.plan.tenantId, child.jobId])).rows.length, 1);

  await runtime2.runtime.close();
  assert.equal(runtime2.runtime.isReady(), false);
  assert.ok(runtime2.opened.every(value => value.pool.closes() === 1 && !value.pool.isAvailable()));
  assert.equal(mounts.length, 2);
});
