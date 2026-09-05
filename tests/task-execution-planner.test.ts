import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { taskDraft } from "./helpers/web-task";
import { at } from "./native-task-fixture";
import { binding, enrollment, input as nativeInput, instant, nativeRunId } from "./hermes-native-fixture";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { NativeResultSubmissionService } from "../src/completion-gate/v1/native-result-submission";
import { NativeTaskResultService } from "../src/node-control/native-task-result-service";
import { bindNativeStart, HERMES_NATIVE_ADAPTER } from "../src/harness/hermes-native-v1/contracts";
import { nativeTaskObservation, nativeTaskRegistration } from "../src/harness/hermes-native-v1/task-observation";
import { WebTaskReviewService } from "../src/web/v1/task-review-service";
import type { CompletionAcceptanceProfileV1 } from "../src/completion-gate/v1";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

async function fixture() {
  const f = await webNativeResultFixture();
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "execution-proposal-001");
  const profile: CompletionAcceptanceProfileV1 = { schemaVersion: "control-room-completion-gate/v1", id: "profile:execution",
    tenantId: binding.tenantId, projectId: binding.projectId, name: "Planned document", targetKind: "document",
    requiredVerificationScenarioIds: ["scenario:content"], minimumIndependentReviews: 1,
    reviewerSeparation: { actor: true, worker: false, agentProfile: false, harness: false, modelFamily: false },
    verificationRequiresProducerSeparation: true, minimumRisk: "low", maximumRevisionRounds: 2, automaticLowRiskDisposition: false,
    createdBy: { actorId: "identity:test", actorType: "human" }, createdAt: at() };
  await f.reviewStore.registerProfile(profile);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:hermes-native",
    allowedOperations: ["harness.hermes.native.start"], credentialRefs: ["credential:test"], filesystemRoots: [],
    networkPolicy: "allowlist", allowedNetworkDestinations: [enrollment.canonicalDestination], effectPolicy: "approval_required",
    maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:document", adapter: HERMES_NATIVE_ADAPTER,
    instructions: "Return a concise plain-text document using only the supplied information.", authority,
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile) };
  const config = { template, integrityKey: new Uint8Array(32).fill(55), reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints };
  const create = (db: DatabaseClient = f.db, clock = () => instant + 7000, extra: Partial<typeof config> = {}) =>
    new TaskExecutionPlanner(db, f.scope, { ...config, ...extra }, clock);
  const planner = create(), plan = () => planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  return { ...f, resultConfig: f.config, source, profile, template, config, create, planner, plan };
}

test("owner planning preserves the inert source and creates a distinct proposed bundle with exact input/profile lineage", async t => {
  const f = await fixture(); t.after(f.close);
  const before = await f.canonical.get(binding.tenantId, "job", f.source.receipt.jobId);
  const outboxBefore = (await f.db.query("SELECT * FROM control_outbox")).rows;
  const saved = await f.plan(), plan = await f.planner.read(saved.receipt.jobId);
  assert.ok(plan); assert.equal(saved.replayed, false); assert.equal(saved.receipt.startsWork, false);
  assert.notEqual(plan.job.id, f.source.receipt.jobId); assert.equal(plan.input.prompt, taskDraft.instructions);
  assert.equal(plan.job.inputDigest, sha256Digest(plan.input)); assert.equal(plan.acceptanceProfileDigest, sha256Digest(f.profile));
  assert.deepEqual(plan.job.authority, f.template.authority); assert.equal(plan.job.state, "proposed");
  assert.deepEqual(await f.canonical.get(binding.tenantId, "job", f.source.receipt.jobId), before);
  const view = await f.tasks.detail(f.identity, binding.projectId, plan.job.id);
  assert.equal(view.instructions, taskDraft.instructions); assert.equal(view.task.state, "proposed"); assert.deepEqual(view.attempts, []);
  for (const table of ["control_effect_intents", "control_approvals"])
    assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length, 0);
  assert.deepEqual((await f.db.query("SELECT * FROM control_outbox")).rows, outboxBefore);
  assert.equal((await f.db.query("SELECT * FROM control_attempts WHERE job_id=$1", [plan.job.id])).rows.length, 0);
});

test("concurrent planning and service reconstruction reconcile one plan without another bundle or audit", async t => {
  const f = await fixture(); t.after(f.close);
  const values = await Promise.all([f.plan(), f.plan(), f.plan()]);
  assert.equal(values.filter(v => !v.replayed).length, 1); assert.equal(new Set(values.map(v => v.receipt.jobId)).size, 1);
  assert.deepEqual((await f.create().plan(f.identity, binding.projectId, f.source.receipt.jobId, sha256Digest(taskDraft))).receipt, values[0].receipt);
  assert.equal((await f.db.query("SELECT * FROM control_task_execution_plans")).rows.length, 1);
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='tasks.plan'")).rows.length, 1);
  const changed = { ...f.template, instructions: "Different approved template" };
  await assert.rejects(f.create(f.db, undefined, { template: changed }).plan(f.identity, binding.projectId, f.source.receipt.jobId, sha256Digest(taskDraft)), { code: "conflict" });
});

test("planning permission is separate from proposal/read permission and logout denies new planning", async t => {
  for (const mode of ["grant", "operator", "logout"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close);
    if (mode === "grant") await f.db.query("UPDATE control_role_grants SET allowed_actions='[\"projects.read\",\"tasks.read\",\"tasks.propose\"]'::jsonb");
    if (mode === "operator") await f.db.query("UPDATE control_role_grants SET role_key='operator'");
    if (mode === "logout") await new (await import("../src/web/v1/project-service")).WebProjectService(f.db, f.scope, () => instant + 7000).logout(f.identity);
    await assert.rejects(f.plan()); assert.equal((await f.db.query("SELECT * FROM control_task_execution_plans")).rows.length, 0);
  });
});

test("new planning rejects wrong input, scope, closed project and expired template", async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(f.planner.plan(f.identity, binding.projectId, f.source.receipt.jobId, `sha256:${"a".repeat(64)}`));
  await assert.rejects(f.planner.plan(f.identity, "project:other", f.source.receipt.jobId, sha256Digest(taskDraft)));
  const authority = { ...f.template.authority, expiresAt: at(7100), digest: "" }; authority.digest = computeAuthorityDigest(authority);
  await assert.rejects(f.create(f.db, undefined, { template: { ...f.template, authority } }).plan(f.identity, binding.projectId, f.source.receipt.jobId, sha256Digest(taskDraft)));
  await f.db.query("UPDATE control_manual_project_heads SET lifecycle='completed' WHERE project_id=$1", [binding.projectId]);
  await assert.rejects(f.plan()); assert.equal((await f.db.query("SELECT * FROM control_task_execution_plans")).rows.length, 0);
});

test("unsupported template permissions and missing review profile fail without materialization", async t => {
  const f = await fixture(); t.after(f.close);
  for (const patch of [{ effectPolicy: "preauthorized" as const }, { maxCostUsd: 1 }, { filesystemRoots: ["/synthetic"] },
    { allowedOperations: ["arbitrary.operation"] }, { maxDurationSeconds: 301 }]) {
    const authority = { ...f.template.authority, ...patch, digest: "" }; authority.digest = computeAuthorityDigest(authority);
    assert.throws(() => f.create(f.db, undefined, { template: { ...f.template, authority } }));
  }
  await assert.rejects(f.create(f.db, undefined, { template: { ...f.template, acceptanceProfileId: "profile:missing" } })
    .plan(f.identity, binding.projectId, f.source.receipt.jobId, sha256Digest(taskDraft)));
  assert.equal((await f.db.query("SELECT * FROM control_task_execution_plans")).rows.length, 0);
});

test("ordinary SQL failure, owner expiry and elapsed template window roll back the whole new plan", async t => {
  for (const mode of ["sql", "expiry", "template_expiry", "template_lock_wait"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close); let now = instant + 7000;
    const wrap = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (mode === "template_lock_wait" && sql.includes("FROM control_jobs") && sql.includes("FOR UPDATE")) now = instant + 241_000;
      if (sql.includes("INSERT INTO audit_events")) { if (mode === "sql") throw new Error("synthetic_sql_failure");
        now = instant + (mode === "expiry" ? 700_000 : 241_000); }
      return result;
    } });
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
    await assert.rejects(f.create(db, () => now).plan(f.identity, binding.projectId, f.source.receipt.jobId, sha256Digest(taskDraft)),
      mode === "sql" ? /synthetic_sql_failure/ : mode === "expiry" ? /authentication_required/ : /conflict/);
    assert.equal((await f.db.query("SELECT * FROM control_task_execution_plans")).rows.length, 0);
    assert.equal((await f.db.query("SELECT * FROM control_jobs WHERE payload->>'jobType'='harness.hermes.native.task'")).rows.length, 0);
  });
});

test("lost acknowledgement recovers the same plan, and plan records reject mutation", async t => {
  const f = await fixture(); t.after(f.close);
  const db: DatabaseClient = { ...f.db, async transactionWithPreCommitCheck(work, check) {
    await f.db.transactionWithPreCommitCheck(work, check); throw new Error("synthetic_lost_ack");
  } };
  await assert.rejects(f.create(db).plan(f.identity, binding.projectId, f.source.receipt.jobId, sha256Digest(taskDraft)));
  assert.equal((await f.plan()).replayed, true);
  for (const sql of ["UPDATE control_task_execution_plans SET plan=plan", "DELETE FROM control_task_execution_plans", "TRUNCATE control_task_execution_plans"])
    await assert.rejects(f.db.query(sql));
});

test("exact plan reconciliation survives project closure without granting another execution", async t => {
  const f = await fixture(); t.after(f.close); const saved = await f.plan();
  await f.db.query("UPDATE control_manual_project_heads SET lifecycle='completed' WHERE project_id=$1", [binding.projectId]);
  const replay = await f.plan(); assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, saved.receipt);
  const expiredReplay = await f.create(f.db, () => instant + 400_000).plan(f.identity, binding.projectId, f.source.receipt.jobId, sha256Digest(taskDraft));
  assert.equal(expiredReplay.replayed, true); assert.deepEqual(expiredReplay.receipt, saved.receipt);
});

test("incorrect plan key fails closed and the private web SQL role cannot materialize execution plans", async t => {
  const f = await fixture(); t.after(f.close); const saved = await f.plan();
  await assert.rejects(f.create(f.db, undefined, { integrityKey: new Uint8Array(32).fill(56) }).read(saved.receipt.jobId));
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec("SET ROLE control_room_private_web");
  try {
    await assert.rejects(f.plan());
    await assert.rejects(f.db.query("SELECT * FROM control_task_execution_plans"));
  } finally { await f.raw.exec("RESET ROLE"); }
  assert.equal((await f.db.query("SELECT * FROM control_task_execution_plans")).rows.length, 1);
});

test("a planned child follows synthetic canonical registration through authenticated delivery and owner review", async t => {
  const f = await fixture(); t.after(f.close); const saved = await f.plan(), plan = (await f.planner.read(saved.receipt.jobId))!;
  // Synthetic fixture transitions stand in for the still-unimplemented admission/dispatch block.
  // No native authority, effect marker, real execution or accepted admission is claimed here.
  const actor = { actorId: "identity:test", actorType: "human" as const };
  const ready = await f.canonical.transition({ tenantId: binding.tenantId, kind: "job", entityId: plan.job.id,
    expectedVersion: 0, toState: "ready", transitionId: "transition:planned-ready", idempotencyKey: "planned-ready",
    actor, occurredAt: at(8000) });
  await f.canonical.claimReadyJob({ tenantId: binding.tenantId, jobId: plan.job.id, expectedJobVersion: ready.entity.version,
    nodeId: binding.nodeId, attemptId: "attempt:planned", leaseId: "lease:planned", transitionId: "transition:planned-claim",
    idempotencyKey: "planned-claim", actor, acquiredAt: at(8000), expiresAt: at(68_000) });
  const native = bindNativeStart(enrollment, { ...nativeInput, ...plan.input, jobId: plan.job.id, attemptId: "attempt:planned",
    runId: "run:planned", deadline: instant + 60_000 }).binding;
  const registration = nativeTaskRegistration(native, plan.job.inputDigest, "lease:planned", 1, at(8000));
  await f.runs.create(registration);
  const submission = new NativeResultSubmissionService(f.db, { integrityKey: f.reviewKey, harnessIntegrityKey: f.harnessKey,
    checkpoints: f.checkpoints, results: f.resultConfig });
  const planned = await f.planner.bindReview(plan.job.id, registration.id, f.harnessKey, submission);
  assert.equal(planned.plan.acceptanceProfileDigest, plan.acceptanceProfileDigest);
  const text = "A synthetic completed recommendation.", body = nativeTaskObservation({ binding: native, version: 5,
    state: "completed", nativeRunId, observedAt: instant + 9000, upstreamUpdatedAt: null, availability: "current",
    streamAttempted: false, stopAttempted: false, resultText: text, usage: null, lastActivity: "none", safeReason: "none" }, registration.nativeTask!);
  const service = new NativeTaskResultService(f.auth, f.runs, f.results, submission);
  const { receipt } = await service.ingest(JSON.stringify(f.frame(body)), new TextEncoder().encode(text), f.options(at(9000)));
  const target = (await f.reviewStore.snapshot(binding.tenantId, planned.plan.targetId)).target;
  const reviews = new WebTaskReviewService(f.db, f.scope, { integrityKey: f.reviewKey, checkpoints: f.checkpoints,
    harnessIntegrityKey: f.harnessKey, results: f.resultConfig }, () => instant + 10_000);
  const decision = await reviews.record(f.identity, binding.projectId, plan.job.id, { artifactId: receipt.artifactId,
    targetId: target.id, targetDigest: sha256Digest(target), contentHash: receipt.contentHash, decision: "accepted", feedback: "" }, "planned-review-001");
  assert.equal(decision.receipt.grantsExecutionAuthority, false);
  assert.equal((await f.reviewStore.snapshot(binding.tenantId, target.id)).status, "pending");
  assert.equal((await f.plan()).replayed, true);
});
