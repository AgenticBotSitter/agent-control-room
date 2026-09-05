import assert from "node:assert/strict";
import test from "node:test";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { binding, enrollment, input as nativeInput, instant, nativeRunId } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { taskDraft } from "./helpers/web-task";
import { sha256Digest } from "../src/security";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { NativeResultSubmissionService } from "../src/completion-gate/v1/native-result-submission";
import { NativeTaskResultService } from "../src/node-control/native-task-result-service";
import { bindNativeStart } from "../src/harness/hermes-native-v1/contracts";
import { nativeTaskRegistration, nativeTaskObservation } from "../src/harness/hermes-native-v1/task-observation";
import { readFile } from "node:fs/promises";

test("prepared work becomes one real canonical assignment without an effect, native run or dispatch", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const source = await f.canonical.get(binding.tenantId, "job", f.source.receipt.jobId);
  const runsBefore = (await f.db.query("SELECT * FROM control_harness_runs")).rows;
  const result = await f.assign(), job = await f.canonical.get(binding.tenantId, "job", result.receipt.jobId);
  assert.equal(job?.state, "leased"); assert.equal(result.replayed, false); assert.equal(result.receipt.startsWork, false);
  assert.equal(result.receipt.grantsExecutionAuthority, false); assert.equal(result.receipt.leaseCurrent, true);
  assert.equal(result.receipt.expiresAt, at(68_000));
  const plan = await f.planner.read(result.receipt.jobId); assert.ok(plan);
  assert.equal((await f.canonical.get(binding.tenantId, "request", plan.request.id))?.state, "accepted");
  assert.equal((await f.canonical.get(binding.tenantId, "workflow", plan.workflow.id))?.state, "active");
  assert.deepEqual(await f.canonical.get(binding.tenantId, "job", f.source.receipt.jobId), source);
  assert.deepEqual((await f.db.query("SELECT * FROM control_harness_runs")).rows, runsBefore);
  for (const table of ["control_approvals", "control_effect_intents"])
    assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length, 0);
  assert.equal((await f.db.query("SELECT * FROM control_outbox WHERE topic<>'domain.transition'")).rows.length, 0);
  const detail = await f.tasks.detail(f.identity, binding.projectId, result.receipt.jobId);
  assert.equal(detail.task.state, "leased"); assert.equal(detail.attempts.length, 1); assert.deepEqual(detail.attempts[0].runs, []);
});

test("concurrent requests reconcile one assignment without extending a lease", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const values = await Promise.all([f.assign(), f.assign(), f.assign()]);
  assert.equal(values.filter(value => !value.replayed).length, 1);
  assert.equal(new Set(values.map(value => value.receipt.leaseId)).size, 1);
  const after = await f.create(f.db, () => instant + 400_000, []).assign(f.identity, binding.projectId,
    f.prepared.receipt.jobId, binding.nodeId, f.prepared.receipt.inputDigest);
  assert.equal(after.replayed, true); assert.equal(after.receipt.leaseCurrent, false);
  assert.equal(after.receipt.expiresAt, values[0].receipt.expiresAt);
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='tasks.assign'")).rows.length, 1);
  await assert.rejects(f.coordinator.assign(f.identity, binding.projectId, f.prepared.receipt.jobId, "node:other", f.prepared.receipt.inputDigest));
});

test("a lost database acknowledgement reconciles the same assignment after service reconstruction", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const db: DatabaseClient = { ...f.db, async transactionWithPreCommitCheck(work, check) {
    await f.db.transactionWithPreCommitCheck(work, check); throw new Error("synthetic_lost_ack");
  } };
  await assert.rejects(f.create(db).assign(f.identity, binding.projectId, f.prepared.receipt.jobId, binding.nodeId, f.prepared.receipt.inputDigest));
  const saved = await f.assign(); assert.equal(saved.replayed, true);
  assert.equal((await f.db.query("SELECT * FROM control_attempts WHERE job_id=$1", [saved.receipt.jobId])).rows.length, 1);
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='tasks.assign'")).rows.length, 1);
});

test("expired assignment reconciliation releases capacity but does not start a retry or claim native stop", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close); const first = await f.assign();
  await assert.rejects(f.coordinator.expire(f.identity, binding.projectId, first.receipt.jobId, first.receipt.inputDigest));
  const coordinator = f.create(f.db, () => instant + 70_000);
  const expired = await coordinator.expire(f.identity, binding.projectId, first.receipt.jobId, first.receipt.inputDigest);
  assert.equal(expired.receipt.leaseState, "expired"); assert.equal(expired.receipt.leaseCurrent, false); assert.equal(expired.replayed, false);
  assert.equal((await coordinator.expire(f.identity, binding.projectId, first.receipt.jobId, first.receipt.inputDigest)).replayed, true);
  const replay = await coordinator.assign(f.identity, binding.projectId, first.receipt.jobId, binding.nodeId, first.receipt.inputDigest);
  assert.equal(replay.replayed, true); assert.equal(replay.receipt.leaseId, first.receipt.leaseId); assert.equal(replay.receipt.leaseCurrent, false);
  assert.equal((await f.db.query("SELECT * FROM control_attempts WHERE job_id=$1", [first.receipt.jobId])).rows.length, 1);
  const audit = (await f.db.query<{ safe_metadata: { confirmsNativeStop: boolean } }>("SELECT safe_metadata FROM audit_events WHERE action='tasks.assignment.expire'")).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].safe_metadata.confirmsNativeStop, false);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "assignment-after-expiry-001");
  const second = await f.planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const next = await coordinator.assign(f.identity, binding.projectId, second.receipt.jobId, binding.nodeId, second.receipt.inputDigest);
  assert.equal(next.replayed, false); assert.notEqual(next.receipt.jobId, first.receipt.jobId);
});

test("reported machine facts are required scheduling evidence, never native qualification", async t => {
  for (const mode of ["telemetry_missing", "capability_missing", "stale", "offline", "capability_failed", "capacity",
    "draining", "key_revoked", "closed", "cancelled_parent", "executor_mismatch"] as const) await t.test(mode, async t => {
    const f = await taskAssignmentFixture(); t.after(f.close);
    if (mode === "telemetry_missing") await f.db.query("DELETE FROM control_node_fleet_current WHERE signal_kind='telemetry'");
    if (mode === "capability_missing") await f.db.query("DELETE FROM control_node_fleet_current WHERE signal_kind='capability'");
    if (mode === "offline") await f.signals.ingestAuthenticated({ ...f.telemetry, sequence: 2, payload: { ...f.telemetry.payload, networkClass: "offline" } }, at(7000), binding);
    if (mode === "capability_failed") await f.signals.ingestAuthenticated({ ...f.capability, sequence: 2, payload: { ...f.capability.payload, outcome: "fail" } }, at(7000), binding);
    if (mode === "draining") await f.canonical.transition({ tenantId: binding.tenantId, kind: "node", entityId: binding.nodeId,
      expectedVersion: 1, toState: "draining", transitionId: "transition:drain-test", idempotencyKey: "assignment-drain-test",
      actor: { actorId: "identity:test", actorType: "human" }, occurredAt: at(7000) });
    if (mode === "key_revoked") await f.db.query("UPDATE control_node_keys SET state='revoked',revoked_at=$1", [at(7000)]);
    if (mode === "closed") await f.db.query("UPDATE control_manual_project_heads SET lifecycle='completed'");
    if (mode === "cancelled_parent") {
      const plan = await f.planner.read(f.prepared.receipt.jobId); assert.ok(plan);
      await f.canonical.transition({ tenantId: binding.tenantId, kind: "request", entityId: plan.request.id, expectedVersion: 0,
        toState: "cancelled", transitionId: "transition:cancel-parent", idempotencyKey: "assignment-cancel-parent",
        actor: { actorId: "identity:test", actorType: "human" }, occurredAt: at(7000) });
    }
    const coordinator = f.create(f.db, () => instant + (mode === "stale" ? 121_000 : 8000), [{ ...f.route,
      ...(mode === "capacity" ? { maxConcurrentTasks: 1 } : {}), ...(mode === "executor_mismatch" ? { executorId: "executor:other" } : {}) }]);
    await assert.rejects(coordinator.assign(f.identity, binding.projectId, f.prepared.receipt.jobId, binding.nodeId, f.prepared.receipt.inputDigest));
    assert.equal((await f.canonical.get(binding.tenantId, "job", f.prepared.receipt.jobId))?.state, "proposed");
    assert.equal((await f.db.query("SELECT * FROM control_attempts WHERE job_id=$1", [f.prepared.receipt.jobId])).rows.length, 0);
  });
});

test("new assignments reject missing scope, changed input, revoked rights and absent routing", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  await assert.rejects(f.coordinator.assign(f.identity, binding.projectId, f.source.receipt.jobId, binding.nodeId, sha256Digest(taskDraft)));
  await assert.rejects(f.coordinator.assign(f.identity, "project:other", f.prepared.receipt.jobId, binding.nodeId, f.prepared.receipt.inputDigest));
  await assert.rejects(f.coordinator.assign(f.identity, binding.projectId, f.prepared.receipt.jobId, binding.nodeId, sha256Digest("wrong")));
  await assert.rejects(f.create(f.db, undefined, []).assign(f.identity, binding.projectId, f.prepared.receipt.jobId, binding.nodeId, f.prepared.receipt.inputDigest));
  await f.db.query("UPDATE control_role_grants SET role_key='operator'"); await assert.rejects(f.assign(), { code: "access_denied" });
  assert.equal((await f.canonical.get(binding.tenantId, "job", f.prepared.receipt.jobId))?.state, "proposed");
});

test("capacity is reserved atomically and never reclaimed just because a clock passed the deadline", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close); await f.assign();
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "assignment-source-002");
  const second = await f.planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  for (const clock of [() => instant + 9000, () => instant + 70_000])
    await assert.rejects(f.create(f.db, clock).assign(f.identity, binding.projectId, second.receipt.jobId, binding.nodeId, second.receipt.inputDigest), { code: "conflict" });
  assert.equal((await f.canonical.get(binding.tenantId, "job", second.receipt.jobId))?.state, "proposed");
});

test("failed SQL or deadline crossing rolls back ready/claim/audit together", async t => {
  for (const mode of ["sql", "deadline", "session"] as const) await t.test(mode, async t => {
    const f = await taskAssignmentFixture(); t.after(f.close); let now = instant + 8000;
    const wrap = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
      const value = await tx.query<T>(sql, params);
      if (sql.includes("INSERT INTO audit_events")) { if (mode === "sql") throw new Error("synthetic_sql_failure");
        now = instant + (mode === "session" ? 700_000 : 69_000); }
      return value;
    } });
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
    const outboxBefore = (await f.db.query("SELECT * FROM control_outbox")).rows;
    await assert.rejects(f.create(db, () => now).assign(f.identity, binding.projectId, f.prepared.receipt.jobId, binding.nodeId, f.prepared.receipt.inputDigest));
    assert.equal((await f.canonical.get(binding.tenantId, "job", f.prepared.receipt.jobId))?.state, "proposed");
    assert.equal((await f.db.query("SELECT * FROM control_attempts WHERE job_id=$1", [f.prepared.receipt.jobId])).rows.length, 0);
    assert.deepEqual((await f.db.query("SELECT * FROM control_outbox")).rows, outboxBefore);
  });
});

test("an actual assignment carries exact lease lineage through synthetic result submission and private review", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close); const { receipt: assignment } = await f.assign();
  const plan = await f.planner.read(assignment.jobId); assert.ok(plan);
  // Only the canonical assignment is implemented here. Native admission/start and provider output
  // are injected fixture evidence, not an accepted runtime or a claim that execution was authorized.
  const native = bindNativeStart(enrollment, { ...nativeInput, ...plan.input, jobId: plan.job.id,
    attemptId: assignment.attemptId, runId: "run:assigned", deadline: Date.parse(assignment.expiresAt) }).binding;
  const registration = nativeTaskRegistration(native, plan.job.inputDigest, assignment.leaseId, assignment.leaseEpoch, at(8000));
  await f.runs.create(registration);
  const submission = new NativeResultSubmissionService(f.db, { integrityKey: f.reviewKey, harnessIntegrityKey: f.harnessKey,
    checkpoints: f.checkpoints, results: f.config });
  const reviewPlan = await f.planner.bindReview(plan.job.id, registration.id, f.harnessKey, submission);
  const text = "Synthetic recommendation for the assigned task.";
  const body = nativeTaskObservation({ binding: native, version: 5, state: "completed", nativeRunId,
    observedAt: instant + 9000, upstreamUpdatedAt: null, availability: "current", streamAttempted: false, stopAttempted: false,
    resultText: text, usage: null, lastActivity: "none", safeReason: "none" }, registration.nativeTask!);
  const service = new NativeTaskResultService(f.auth, f.runs, f.results, submission);
  const { receipt } = await service.ingest(JSON.stringify(f.frame(body)), new TextEncoder().encode(text), f.options(at(9000)));
  const target = (await f.reviewStore.snapshot(binding.tenantId, reviewPlan.plan.targetId)).target;
  const reviews = f.createReviews(f.db, () => instant + 10_000);
  const decision = await reviews.record(f.identity, binding.projectId, plan.job.id, { artifactId: receipt.artifactId,
    targetId: target.id, targetDigest: sha256Digest(target), contentHash: receipt.contentHash,
    decision: "changes_requested", feedback: "Add supporting detail." }, "assigned-result-review-001");
  assert.equal(decision.receipt.startsRevision, false);
  const view = await f.tasks.results(f.identity, binding.projectId, assignment.jobId);
  assert.ok("items" in view);
  assert.equal(view.items.length, 1); assert.equal(view.reviews[0].status, "changes_requested");
  assert.equal((await f.canonical.get(binding.tenantId, "job", assignment.jobId))?.state, "leased");
});

test("protected assignment HTTP rejects caller authority and rechecks access after options were read", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const { createTaskHttpHandler } = await import("../src/web/v1/task-http");
  const { request, origin } = await import("./helpers/web-foundation");
  const handler = createTaskHttpHandler({ origin, trust: f.accessTrust, service: f.tasks,
    assignment: f.coordinator.webOperation(), clock: () => instant + 8000 });
  const path = `/api/v1/projects/${binding.projectId}/tasks/${f.prepared.receipt.jobId}/assignment`;
  const draft = { action: "assign", nodeId: binding.nodeId, expectedInputDigest: f.prepared.receipt.inputDigest };
  const options = await handler(request(path, "GET", undefined, undefined, f.jwt)); assert.equal(options.status, 200);
  assert.equal((await options.json()).candidateEvidence, "configured_routes_only");
  for (const body of [{ ...draft, approved: true }, { ...draft, authority: {} }, { ...draft, leaseSeconds: 300 },
    { ...draft, nodeId: "x".repeat(1100) }, { ...draft, action: "start" }])
    assert.equal((await handler(request(path, "POST", body, undefined, f.jwt))).status, 400);
  const cross = request(path, "POST", draft, undefined, f.jwt); cross.headers.set("origin", "https://other.example.invalid");
  assert.equal((await handler(cross)).status, 403);
  for (const route of [`${path}?extra=1`, path.replace(binding.projectId, "%GG"), path.replace(binding.projectId, "a%2Fb")])
    assert.equal((await handler(request(route, "POST", draft, undefined, f.jwt))).status, 400);
  assert.equal((await handler(request(path, "DELETE", undefined, undefined, f.jwt))).status, 404);
  await f.db.query("UPDATE control_role_grants SET role_key='operator'");
  assert.equal((await handler(request(path, "POST", draft, undefined, f.jwt))).status, 403);
  assert.equal((await handler(request(path, "GET", undefined, undefined, f.jwt))).status, 403);
  assert.equal((await f.db.query("SELECT * FROM control_attempts WHERE job_id=$1", [f.prepared.receipt.jobId])).rows.length, 0);
});

test("restricted web role cannot allocate, and corrupted assignment mirrors fail closed", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec("SET ROLE control_room_private_web");
  try { await assert.rejects(f.assign()); } finally { await f.raw.exec("RESET ROLE"); }
  const { receipt } = await f.assign();
  await assert.rejects(f.db.query("UPDATE control_attempts SET version=version+1 WHERE id=$1", [receipt.attemptId]), /canonical payload mirror mismatch/);
  // The database already rejects this corruption. Inject only the returned query row to exercise
  // the coordinator's second check without disabling or changing that database guard.
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) { const result = await tx.query<T>(sql, params);
      if (sql.startsWith("SELECT payload,state,version,node_id,lease_epoch"))
        result.rows = result.rows.map(row => ({ ...row, version: 999 })); return result; },
  }), check) };
  await assert.rejects(f.create(db).assign(f.identity, binding.projectId, receipt.jobId, binding.nodeId, receipt.inputDigest), /task_assignment_unavailable/);
  await assert.rejects(f.create(db, () => instant + 70_000).expire(f.identity, binding.projectId, receipt.jobId, receipt.inputDigest), /task_assignment_unavailable/);
});

test("expiry audit failure rolls back capacity release and permits exact later reconciliation", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close); const { receipt } = await f.assign();
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) { const result = await tx.query<T>(sql, params);
      if (sql.includes("INSERT INTO audit_events")) throw new Error("synthetic_expiry_audit_failure"); return result; },
  }), check) };
  await assert.rejects(f.create(db, () => instant + 70_000).expire(f.identity, binding.projectId, receipt.jobId, receipt.inputDigest));
  assert.equal((await f.canonical.get(binding.tenantId, "lease", receipt.leaseId))?.state, "active");
  assert.equal((await f.canonical.get(binding.tenantId, "job", receipt.jobId))?.state, "leased");
  assert.equal((await f.create(f.db, () => instant + 70_000).expire(f.identity, binding.projectId, receipt.jobId, receipt.inputDigest)).replayed, false);
});
