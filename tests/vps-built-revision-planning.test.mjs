import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import handler from "../dist-vps/server/index.js";
import { createPrivateTaskBootstrap } from "../dist-vps/server/taskBootstrap.js";
import { installPrivateApplication } from "../dist-vps/server/runtime.js";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion.ts";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { request } from "./helpers/web-foundation.ts";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";

test("compiled two-role startup plans one owner-requested revision without starting native work", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const startup = await taskStartupFixture(x.f.assignmentFixture);
  const canonical = new CanonicalStore(startup.coordinator.client);
  const opened = [], preflights = [];
  let losePlanResponse = false;
  const observe = work => async tx => work({ async query(sql, params) {
    const result = await tx.query(sql, params);
    if (sql.includes("AS database_temp")) {
      preflights.push((await tx.query("SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0]);
    }
    return result;
  } });
  const bootstrap = createPrivateTaskBootstrap({ clock: x.f.clock, install: installPrivateApplication,
    openDatabase(config) {
      opened.push(config.username);
      const pool = startup.openDatabase(config), db = pool.client;
      return { ...pool, client: { ...db,
        transaction: work => db.transaction(observe(work)),
        async transactionWithPreCommitCheck(work, check) {
          const value = await db.transactionWithPreCommitCheck(observe(work), check);
          if (losePlanResponse) { losePlanResponse = false; throw new Error("synthetic_lost_revision_plan_response"); }
          return value;
        },
      } };
    },
  });
  const runtime = await bootstrap.start({ ...startup.config, coordinator: { ...startup.config.coordinator,
    quality: { ...x.f.ownerConfig, scenarios: [x.scenario] }, revisionPlanning: true,
  } });
  t.after(() => runtime.close());
  assert.equal(runtime.isReady(), true); assert.ok(runtime.quality); assert.ok(runtime.revisions);
  assert.deepEqual(opened, ["web_test", "coordinator_test"]);
  assert.deepEqual(preflights, [
    { current_user: "web_test", session_user: "web_test", rolsuper: false },
    { current_user: "coordinator_test", session_user: "coordinator_test", rolsuper: false },
  ]);

  const feedback = "Add a clearer explanation of the evidence source.";
  const reviewPath = `/api/v1/projects/${x.registration.projectId}/tasks/${x.registration.jobId}/results/${x.artifact.artifactId}/reviews/${x.target.id}`;
  const reviewDraft = { artifactId: x.artifact.artifactId, targetId: x.target.id, targetDigest: x.request.targetDigest,
    contentHash: x.request.contentHash, decision: "changes_requested", feedback };
  const reviewed = await handler(request(reviewPath, "POST", reviewDraft, "compiled-revision-review-001", x.f.jwt));
  assert.equal(reviewed.status, 201, await reviewed.clone().text());
  const reviewReceipt = (await reviewed.json()).receipt;
  assert.equal(reviewReceipt.startsRevision, false); assert.equal(reviewReceipt.decision, "changes_requested");

  const source = {
    job: await canonical.get(x.request.tenantId, "job", x.registration.jobId),
    attempt: await canonical.get(x.request.tenantId, "attempt", x.registration.attemptId),
    lease: await canonical.get(x.request.tenantId, "lease", x.registration.nativeTask.leaseId),
    target: await x.f.reviewStore.snapshot(x.request.tenantId, x.target.id),
    checkpoint: x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`),
  };
  const nativeCalls = [...x.local.calls], nativeEffects = x.local.effects.countFull();
  const plansBefore = (await startup.coordinator.client.query("SELECT job_id FROM control_task_execution_plans ORDER BY job_id")).rows;
  const revisionRequest = { runId: x.registration.id, targetId: x.target.id, targetDigest: x.request.targetDigest,
    contentHash: x.request.contentHash, reviewId: reviewReceipt.reviewId, feedback };
  const plan = () => runtime.revisions.plan(x.f.identity, x.registration.projectId, x.registration.jobId,
    revisionRequest, new AbortController().signal);

  losePlanResponse = true;
  await assert.rejects(plan(), /synthetic_lost_revision_plan_response/);
  const saved = await plan(); assert.equal(saved.replayed, true);
  assert.equal(saved.receipt.projectId, x.registration.projectId);
  assert.equal(saved.receipt.sourceJobId, x.registration.jobId); assert.notEqual(saved.receipt.jobId, x.registration.jobId);
  assert.equal(saved.receipt.rootSubjectId, x.target.subjectId); assert.equal(saved.receipt.rootTargetId, x.target.rootTargetId);
  assert.equal(saved.receipt.fromTargetId, x.target.id); assert.equal(saved.receipt.revisionNumber, 1);
  assert.equal(saved.receipt.startsWork, false); assert.equal(saved.receipt.grantsExecutionAuthority, false);
  assert.equal(saved.receipt.executionAvailability, "requires_separate_assignment_and_approval");

  const child = await canonical.get(x.request.tenantId, "job", saved.receipt.jobId);
  assert.equal(child.state, "proposed"); assert.equal(child.version, 0); assert.equal(child.projectId, x.registration.projectId);
  const workflow = await canonical.get(x.request.tenantId, "workflow", child.workflowId);
  const childRequest = await canonical.get(x.request.tenantId, "request", workflow.requestId);
  assert.equal(workflow.state, "proposed"); assert.deepEqual(workflow.jobIds, [child.id]);
  assert.equal(childRequest.state, "draft"); assert.equal(childRequest.projectId, x.registration.projectId);
  assert.equal((await startup.coordinator.client.query("SELECT id FROM control_attempts WHERE job_id=$1", [child.id])).rows.length, 0);
  assert.equal((await startup.coordinator.client.query("SELECT job_id FROM control_task_execution_plans")).rows.length, plansBefore.length + 1);
  assert.equal((await startup.coordinator.client.query("SELECT id FROM audit_events WHERE action='tasks.revisions.plan' AND target_id=$1", [child.id])).rows.length, 1);

  assert.deepEqual(await canonical.get(x.request.tenantId, "job", x.registration.jobId), source.job);
  assert.deepEqual(await canonical.get(x.request.tenantId, "attempt", x.registration.attemptId), source.attempt);
  assert.deepEqual(await canonical.get(x.request.tenantId, "lease", x.registration.nativeTask.leaseId), source.lease);
  assert.deepEqual(await x.f.reviewStore.snapshot(x.request.tenantId, x.target.id), source.target);
  assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`), source.checkpoint);
  assert.deepEqual(x.local.calls, nativeCalls); assert.equal(x.local.effects.countFull(), nativeEffects);

  const replay = await plan(); assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, saved.receipt);
  assert.equal((await startup.coordinator.client.query("SELECT id FROM audit_events WHERE action='tasks.revisions.plan' AND target_id=$1", [child.id])).rows.length, 1);
  assert.deepEqual(x.local.calls, nativeCalls); assert.equal(x.local.effects.countFull(), nativeEffects);
  await runtime.close(); assert.equal(runtime.isReady(), false);
  assert.equal(startup.web.closes(), 1); assert.equal(startup.coordinator.closes(), 1);
  await assert.rejects(plan()); assert.equal((await handler(request(reviewPath, "GET", undefined, undefined, x.f.jwt))).status, 503);
});

test("compiled browser assets exclude internal revision planning", () => {
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  const javascript = files("dist-vps/client").filter(file => file.endsWith(".js"));
  assert.ok(javascript.length > 0);
  for (const file of javascript) assert.doesNotMatch(readFileSync(file, "utf8"),
    /TaskExecutionPlanner|control-room\.task-execution-plan\/v2|tasks\.revisions\.plan|revision_submission_not_connected/);
  // The protected revision UI now consumes this public receipt flag. Planner implementation
  // and private execution-plan records must still stay out of browser assets.
  assert.ok(javascript.some(file => readFileSync(file, "utf8").includes("requires_separate_assignment_and_approval")));
});
