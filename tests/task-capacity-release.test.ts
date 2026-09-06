import assert from "node:assert/strict";
import test from "node:test";
import { taskQualityCoordinatorFixture } from "./helpers/task-quality-coordinator";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion";
import { TaskExecutionPlanner } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { TaskQualityCoordinator } from "../src/web/v1/task-quality-coordinator";
import { sha256Digest } from "../src/security";

const signal = () => new AbortController().signal;

test("restricted quality reconciliation releases occupancy before review and later completes without rewriting the lease", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close); await x.verifyRole();
  const before = await x.states(), beforeOptions = await x.f.coordinator.options(
    x.f.identity, x.request.projectId, x.request.jobId);
  assert.equal(beforeOptions.receipt?.leaseState, "active"); assert.equal(beforeOptions.receipt?.leaseCurrent, true);

  const waiting = await x.reconcile();
  assert.equal(waiting.disposition, "waiting_review"); assert.equal(waiting.verification, "recorded");
  assert.ok(waiting.capacity); const capacity = waiting.capacity;
  assert.equal(capacity.replayed, false); assert.equal(capacity.receipt.jobId, x.request.jobId);
  assert.equal(capacity.receipt.runId, x.request.runId); assert.equal(capacity.receipt.leaseId, before.lease.id);
  assert.equal(capacity.receipt.leaseEpoch, before.lease.epoch);
  assert.equal(capacity.receipt.jobVersion, before.job.version);
  assert.equal(capacity.receipt.attemptVersion, before.attempt.version);
  assert.equal(capacity.receipt.leaseVersion, before.lease.version + 1);
  assert.equal(capacity.receipt.qualityAccepted, false);
  assert.equal(capacity.receipt.grantsApproval, false);
  assert.equal(capacity.receipt.grantsExecutionAuthority, false);
  assert.ok(Date.parse(capacity.receipt.releasedAt) >= Date.parse(capacity.receipt.completedAt));
  const released = await x.states();
  assert.deepEqual(released.job, before.job); assert.deepEqual(released.attempt, before.attempt);
  assert.equal(released.lease.state, "released"); assert.equal(released.lease.version, before.lease.version + 1);
  assert.equal(released.lease.updatedAt, capacity.receipt.releasedAt);

  const options = await x.f.coordinator.options(x.f.identity, x.request.projectId, x.request.jobId);
  assert.equal(options.receipt?.leaseState, "released"); assert.equal(options.receipt?.leaseCurrent, false);
  const assignmentReplay = await x.f.coordinator.assign(x.f.identity, x.request.projectId, x.request.jobId,
    x.f.route.nodeId, x.registration.nativeTask!.inputDigest);
  assert.equal(assignmentReplay.replayed, true); assert.equal(assignmentReplay.receipt.leaseState, "released");
  assert.equal(assignmentReplay.receipt.leaseCurrent, false); assert.deepEqual(assignmentReplay.receipt, options.receipt);
  await assert.rejects(x.f.coordinator.prepareNativeApproval(...x.f.args));

  const capacityReplay = await x.reconcile();
  assert.equal(capacityReplay.disposition, "waiting_review"); assert.equal(capacityReplay.verification, "replayed");
  assert.ok(capacityReplay.capacity); assert.equal(capacityReplay.capacity.replayed, true);
  assert.deepEqual(capacityReplay.capacity.receipt, capacity.receipt);
  assert.deepEqual(await x.states(), released);

  const reviewed = await x.ownerReview("accepted"); assert.equal(reviewed.replayed, false);
  const beforeCompletion = await x.states();
  const completed = await x.reconcile();
  assert.equal(completed.disposition, "completed"); assert.equal(completed.verification, "replayed");
  assert.equal(completed.completion.replayed, false);
  assert.equal(completed.completion.receipt.capacityReleaseDigest, sha256Digest(capacity.receipt));
  assert.equal(completed.completion.receipt.leaseVersion, released.lease.version);
  const final = await x.states();
  assert.equal(final.job.state, "succeeded"); assert.equal(final.attempt.state, "succeeded");
  assert.deepEqual(final.lease, beforeCompletion.lease);
  const completionReplay = await x.reconcile();
  assert.equal(completionReplay.disposition, "completed"); assert.equal(completionReplay.completion.replayed, true);
  assert.deepEqual(completionReplay.completion.receipt, completed.completion.receipt);
  assert.deepEqual((await x.states()).lease, final.lease);
  assert.equal((await x.f.db.query("SELECT id FROM audit_events WHERE action='task.native.capacity_released'")).rows.length, 1);
});

test("a planned revision fits the unchanged node capacity only after the source release", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const feedback = "Please improve the evidence.";
  const change = await x.review("changes_requested");
  const planner = new TaskExecutionPlanner(x.f.db, x.f.scope, x.f.plannerConfig, x.f.clock, x.f.ownerConfig);
  const planned = await planner.revise(x.f.identity, x.registration.projectId, x.registration.jobId,
    { runId: x.registration.id, targetId: x.target.id, targetDigest: x.request.targetDigest,
      contentHash: x.artifact.contentHash, reviewId: change.receipt.reviewId, feedback }, signal());
  const plan = await planner.read(planned.receipt.jobId); assert.ok(plan?.schema === "control-room.task-execution-plan/v2");
  const assignment = new TaskAssignmentCoordinator(x.f.db, x.f.scope, planner, [x.f.route], x.f.clock);
  assert.equal(x.f.route.maxConcurrentTasks, 2);
  const seed = await x.f.canonical.get(x.request.tenantId, "lease", "lease:test"); assert.ok(seed);
  const sourceBefore = await x.states(), calls = [...x.local.calls], effects = x.local.effects.countFull();
  const gateBefore = (await x.f.db.query("SELECT id,record_digest FROM control_completion_gate_records ORDER BY id")).rows;
  const active = () => x.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_leases WHERE tenant_id=$1 AND node_id=$2 AND state='active'",
    [x.request.tenantId, x.f.route.nodeId]);
  assert.equal(Number((await active()).rows[0].count), 2);
  const assign = () => assignment.assign(x.f.identity, plan.projectId, plan.job.id, x.f.route.nodeId, plan.job.inputDigest);
  await assert.rejects(assign());
  assert.equal((await x.f.db.query("SELECT id FROM control_attempts WHERE job_id=$1", [plan.job.id])).rows.length, 0);

  const quality = new TaskQualityCoordinator(x.f.db, x.f.scope, { ...x.f.ownerConfig, scenarios: [x.scenario] }, x.f.clock);
  const released = await quality.reconcile({ ...x.request, projectId: x.registration.projectId,
    jobId: x.registration.jobId }, signal(), () => {});
  assert.equal(released.disposition, "changes_requested"); assert.ok(released.capacity);
  assert.equal(released.capacity.replayed, false);
  assert.equal((await x.states()).lease.state, "released");
  assert.deepEqual((await x.states()).job, sourceBefore.job); assert.deepEqual((await x.states()).attempt, sourceBefore.attempt);
  assert.deepEqual(await x.f.canonical.get(x.request.tenantId, "lease", "lease:test"), seed);
  assert.deepEqual((await x.f.db.query("SELECT id,record_digest FROM control_completion_gate_records ORDER BY id")).rows, gateBefore);
  assert.equal(Number((await active()).rows[0].count), 1);

  const child = await assign();
  assert.equal(child.replayed, false); assert.equal(child.receipt.leaseState, "active"); assert.equal(child.receipt.leaseCurrent, true);
  assert.equal(child.receipt.jobId, plan.job.id); assert.equal(Number((await active()).rows[0].count), 2);
  assert.deepEqual(await x.f.canonical.get(x.request.tenantId, "lease", "lease:test"), seed);
  assert.deepEqual(x.local.calls, calls); assert.equal(x.local.effects.countFull(), effects);
  assert.equal((await x.f.db.query("SELECT id FROM control_transition_events WHERE id LIKE '%:expire'")).rows.length, 0);
});

test("automatic pending release precedes change-request revision planning and assignment at unchanged capacity", async t => {
  const x = await nativeQualityCompletionFixture(); t.after(x.close);
  const sourceBefore = await x.states(), calls = [...x.local.calls], effects = x.local.effects.countFull();
  const seed = await x.f.canonical.get(x.request.tenantId, "lease", "lease:test"); assert.ok(seed);
  const active = () => x.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_leases WHERE tenant_id=$1 AND node_id=$2 AND state='active'",
    [x.request.tenantId, x.f.route.nodeId]);
  assert.equal(x.f.route.maxConcurrentTasks, 2); assert.equal(Number((await active()).rows[0].count), 2);

  const quality = new TaskQualityCoordinator(x.f.db, x.f.scope, { ...x.f.ownerConfig, scenarios: [x.scenario] }, x.f.clock);
  const waiting = await quality.reconcile({ ...x.request, projectId: x.registration.projectId,
    jobId: x.registration.jobId }, signal(), () => {});
  assert.equal(waiting.disposition, "waiting_review"); assert.ok(waiting.capacity);
  assert.equal(waiting.capacity.replayed, false); assert.equal((await x.states()).lease.state, "released");
  assert.deepEqual((await x.states()).job, sourceBefore.job); assert.deepEqual((await x.states()).attempt, sourceBefore.attempt);
  assert.deepEqual(await x.f.canonical.get(x.request.tenantId, "lease", "lease:test"), seed);
  assert.equal(Number((await active()).rows[0].count), 1);

  const feedback = "Please improve the evidence.";
  const change = await x.review("changes_requested");
  const planner = new TaskExecutionPlanner(x.f.db, x.f.scope, x.f.plannerConfig, x.f.clock, x.f.ownerConfig);
  const planned = await planner.revise(x.f.identity, x.registration.projectId, x.registration.jobId,
    { runId: x.registration.id, targetId: x.target.id, targetDigest: x.request.targetDigest,
      contentHash: x.artifact.contentHash, reviewId: change.receipt.reviewId, feedback }, signal());
  const plan = await planner.read(planned.receipt.jobId); assert.ok(plan?.schema === "control-room.task-execution-plan/v2");
  const assignment = new TaskAssignmentCoordinator(x.f.db, x.f.scope, planner, [x.f.route], x.f.clock);
  const child = await assignment.assign(x.f.identity, plan.projectId, plan.job.id, x.f.route.nodeId, plan.job.inputDigest);
  assert.equal(child.replayed, false); assert.equal(child.receipt.leaseState, "active");
  assert.equal(child.receipt.leaseCurrent, true); assert.equal(child.receipt.jobId, plan.job.id);
  assert.equal(Number((await active()).rows[0].count), 2);
  const sourceAfter = await x.states();
  assert.deepEqual(sourceAfter.job, sourceBefore.job); assert.deepEqual(sourceAfter.attempt, sourceBefore.attempt);
  assert.equal(sourceAfter.lease.state, "released"); assert.deepEqual(await x.f.canonical.get(x.request.tenantId, "lease", "lease:test"), seed);
  assert.deepEqual(x.local.calls, calls); assert.equal(x.local.effects.countFull(), effects);
  assert.equal((await x.f.db.query("SELECT id FROM control_transition_events WHERE id LIKE '%:expire'")).rows.length, 0);
});
