import assert from "node:assert/strict";
import test from "node:test";
import { taskQualityCoordinatorFixture, deferredQuality } from "./helpers/task-quality-coordinator";
import { qualityText } from "./helpers/native-quality-completion";
import type { DatabaseClient } from "../src/persistence/database";
import type { JobRecord, RequestRecord, WorkflowRecord } from "../src/domain/v1";
import { hmacSha256Tag, sha256Digest } from "../src/security";

type Fixture = Awaited<ReturnType<typeof revisionFixture>>;
type PlanRow = { plan: { schema: string; tenantId: string; projectId: string; sourceJobId: string;
  plannedBy: string; sourceInputDigest: string; sourceDigest: string; input: { prompt: string; instructions: string };
  acceptanceProfileId: string; acceptanceProfileDigest: string; revision: Record<string, unknown>;
  job: JobRecord; request: RequestRecord; workflow: WorkflowRecord }; auth_tag: string };
const signal = () => new AbortController().signal;
const feedback = "Please improve the evidence.";
async function revisionFixture(text = qualityText, decision: "accepted" | "changes_requested" = "changes_requested") {
  const x = await taskQualityCoordinatorFixture(text);
  try {
    const review = await x.ownerReview(decision), owner = x.createOwner({ revisionPlanning: true });
    const request = { runId: x.request.runId, targetId: x.target.id, targetDigest: x.request.targetDigest,
      contentHash: x.request.contentHash, reviewId: review.receipt.reviewId, feedback };
    const plan = () => owner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, request, signal());
    return { ...x, revisionOwner: owner, revisionRequest: request, changeReview: review.receipt, plan,
      close: async () => { await owner.close(); await x.close(); } };
  } catch (error) { await x.close(); throw error; }
}
const rows = async (x: Fixture) => (await x.f.db.query<PlanRow>(
  "SELECT plan,auth_tag FROM control_task_execution_plans WHERE tenant_id=$1 AND source_job_id=$2", [x.request.tenantId, x.request.jobId])).rows;
async function unchangedEvidence(x: Fixture) {
  return { state: await x.states(), gate: (await x.f.db.query("SELECT * FROM control_completion_gate_records ORDER BY id")).rows,
    checkpoint: x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`), calls: [...x.local.calls], effects: x.local.effects.countFull(),
    runs: (await x.f.db.query("SELECT * FROM control_harness_runs ORDER BY id")).rows,
    outbox: (await x.f.db.query("SELECT * FROM control_outbox ORDER BY id")).rows };
}
const audits = async (x: Fixture, jobId: string) => (await x.f.db.query("SELECT * FROM audit_events WHERE target_id=$1", [jobId])).rows;
async function bundleIndexes(x: Fixture) {
  const result: Record<string, unknown> = {};
  for (const table of ["control_requests", "control_workflows", "control_jobs", "audit_events"])
    result[table] = (await x.f.db.query(`SELECT id FROM ${table} ORDER BY id`)).rows;
  return result;
}

test("optional revision planning requires explicit checked result configuration", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  assert.equal(x.owner.revisions, undefined);
  assert.throws(() => x.createOwner({ revisionPlanning: true, quality: undefined }));
});

test("restricted owner revision planning creates a signed proposed child bundle without changing the completed native result", async t => {
  const x = await revisionFixture(); t.after(x.close); await x.verifyRole();
  const before = await unchangedEvidence(x), sourcePlan = await x.f.planner.read(x.request.jobId); assert.ok(sourcePlan);
  const saved = await x.plan(), stored = await rows(x); assert.equal(stored.length, 1);
  const { plan, auth_tag: tag } = stored[0];
  assert.equal(saved.replayed, false); assert.equal(saved.receipt.startsWork, false); assert.equal(saved.receipt.grantsExecutionAuthority, false);
  assert.equal(saved.receipt.executionAvailability, "requires_separate_assignment_and_approval");
  assert.equal(plan.schema, "control-room.task-execution-plan/v2");
  assert.equal(tag, hmacSha256Tag(x.f.plannerConfig.integrityKey, { purpose: "task-execution-plan/v2", plan }));
  assert.equal(plan.sourceJobId, x.request.jobId); assert.notEqual(plan.job.id, x.request.jobId);
  assert.equal(plan.job.id, saved.receipt.jobId); assert.equal(plan.plannedBy, "identity:test");
  assert.deepEqual([plan.tenantId, plan.projectId], [x.request.tenantId, x.request.projectId]);
  assert.deepEqual([plan.request.state, plan.workflow.state, plan.job.state], ["draft", "proposed", "proposed"]);
  assert.equal(plan.workflow.requestId, plan.request.id); assert.deepEqual(plan.workflow.jobIds, [plan.job.id]);
  assert.equal(plan.job.workflowId, plan.workflow.id); assert.equal(plan.job.inputDigest, sha256Digest(plan.input));
  assert.equal(plan.input.instructions, sourcePlan.input.instructions); assert.ok(plan.input.prompt.length <= 4000);
  assert.deepEqual(JSON.parse(plan.input.prompt), { originalTask: sourcePlan.input.prompt, previousResult: qualityText, requestedChanges: feedback });
  assert.equal(plan.request.objective, plan.input.prompt);
  const review = await x.f.reviewStore.getRecord(x.request.tenantId, x.changeReview.reviewId, "review");
  assert.deepEqual(plan.revision, { rootSubjectId: x.target.subjectId, rootTargetId: x.target.rootTargetId,
    fromJobId: x.request.jobId, fromRunId: x.request.runId, fromTargetId: x.target.id,
    fromTargetDigest: x.request.targetDigest, fromContentHash: x.request.contentHash, reviewId: x.changeReview.reviewId,
    reviewDigest: sha256Digest(review), findingIds: [x.changeReview.findingId], feedbackDigest: sha256Digest(feedback),
    sourcePlanDigest: sha256Digest(sourcePlan), revisionNumber: 1, originalPrompt: sourcePlan.input.prompt });
  assert.equal(plan.sourceDigest, sha256Digest(plan.revision)); assert.equal(plan.sourceInputDigest, sourcePlan.job.inputDigest);
  assert.deepEqual([saved.receipt.rootSubjectId, saved.receipt.rootTargetId, saved.receipt.fromTargetId, saved.receipt.revisionNumber],
    [x.target.subjectId, x.target.rootTargetId, x.target.id, 1]);
  assert.equal(plan.acceptanceProfileId, x.profile.id); assert.equal(plan.acceptanceProfileDigest, sha256Digest(x.profile));
  assert.deepEqual(plan.job.authority, x.f.plannerConfig.template.authority);
  for (const record of [plan.request, plan.workflow, plan.job])
    assert.deepEqual(await x.f.canonical.get(x.request.tenantId, record.kind, record.id), record);
  assert.equal((await audits(x, plan.job.id)).length, 1);
  for (const table of ["control_attempts", "control_leases"])
    assert.deepEqual((await x.f.db.query(`SELECT * FROM ${table} WHERE job_id=$1`, [plan.job.id])).rows, []);
  assert.deepEqual(await x.f.planner.read(plan.job.id), plan);
  await assert.rejects(x.f.planner.bindReview(plan.job.id, x.request.runId, x.f.harnessKey, x.submission));
  assert.deepEqual(await unchangedEvidence(x), before);
});

test("concurrent revision planning and a reconstructed owner preserve exactly one child bundle and audit", async t => {
  const x = await revisionFixture(); t.after(x.close); const before = await unchangedEvidence(x);
  const values = await Promise.all([x.plan(), x.plan(), x.plan()]);
  assert.equal(values.filter(value => !value.replayed).length, 1);
  assert.equal(new Set(values.map(value => value.receipt.jobId)).size, 1);
  const owner = x.createOwner({ revisionPlanning: true }); t.after(() => owner.close());
  const replay = await owner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, x.revisionRequest, signal());
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, values[0].receipt);
  assert.equal((await rows(x)).length, 1); assert.equal((await audits(x, replay.receipt.jobId)).length, 1);
  assert.deepEqual(await unchangedEvidence(x), before);
});

test("lost acknowledgement recovers one already committed revision plan", async t => {
  const x = await revisionFixture(); t.after(x.close); let committed = false;
  const db: DatabaseClient = { ...x.f.db, async transactionWithPreCommitCheck(work, check) {
    let inserted = false;
    const result = await x.f.db.transactionWithPreCommitCheck(tx => work({ async query<T>(sql: string, params?: unknown[]) {
      const value = await tx.query<T>(sql, params); if (sql.includes("INSERT INTO control_task_execution_plans")) inserted = true; return value;
    } }), check);
    if (inserted) { committed = true; throw new Error("synthetic_revision_reply_lost"); } return result;
  } };
  const owner = x.createOwner({ revisionPlanning: true, database: { ...x.config.database, client: db } }); t.after(() => owner.close());
  await assert.rejects(owner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, x.revisionRequest, signal()), /synthetic_revision_reply_lost/);
  assert.equal(committed, true); const replay = await x.plan(); assert.equal(replay.replayed, true);
  assert.equal((await rows(x)).length, 1); assert.equal((await audits(x, replay.receipt.jobId)).length, 1);
});

test("commit acknowledgement after caller cancellation or elapsed budget rejects while retaining one replayable proposed bundle", async t => {
  for (const mode of ["abort", "elapsed"] as const) await t.test(mode, async t => {
    const x = await revisionFixture(); t.after(x.close); const before = await unchangedEvidence(x), indexes = await bundleIndexes(x);
    const abort = new AbortController(); let now = x.f.clock(), committed = false;
    const db: DatabaseClient = { ...x.f.db, async transactionWithPreCommitCheck(work, check) {
      let inserted = false;
      const result = await x.f.db.transactionWithPreCommitCheck(tx => work({ async query<T>(sql: string, params?: unknown[]) {
        const value = await tx.query<T>(sql, params); if (sql.includes("INSERT INTO control_task_execution_plans")) inserted = true; return value;
      } }), check);
      // The real transaction has already committed. Only its acknowledgement is late;
      // this must not be described as rollback or cause another child to be created.
      if (inserted) { committed = true; if (mode === "abort") abort.abort(); else now += 10_001; }
      return result;
    } };
    const owner = x.createOwner({ revisionPlanning: true, clock: () => now, database: { ...x.config.database, client: db } }); t.after(() => owner.close());
    await assert.rejects(owner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, x.revisionRequest, abort.signal));
    assert.equal(committed, true); const stored = await rows(x); assert.equal(stored.length, 1);
    const plan = stored[0].plan;
    for (const record of [plan.request, plan.workflow, plan.job])
      assert.deepEqual(await x.f.canonical.get(x.request.tenantId, record.kind, record.id), record);
    assert.deepEqual([plan.request.state, plan.workflow.state, plan.job.state], ["draft", "proposed", "proposed"]);
    assert.equal((await audits(x, plan.job.id)).length, 1);
    const after = await bundleIndexes(x);
    for (const table of Object.keys(indexes))
      assert.equal((after[table] as unknown[]).length, (indexes[table] as unknown[]).length + 1);
    const replay = await owner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, x.revisionRequest, signal());
    assert.equal(replay.replayed, true); assert.equal(replay.receipt.jobId, plan.job.id);
    assert.equal(replay.receipt.startsWork, false); assert.equal(replay.receipt.executionAvailability, "requires_separate_assignment_and_approval");
    assert.deepEqual(await rows(x), stored); assert.deepEqual(await bundleIndexes(x), after);
    assert.deepEqual(await unchangedEvidence(x), before);
  });
});

test("revision planning rejects malformed or mismatched exact result and feedback requests without children", async t => {
  const x = await revisionFixture(); t.after(x.close); const before = await unchangedEvidence(x);
  for (const patch of [{ feedback: "Different requested change" }, { feedback: "" }, { feedback: "x".repeat(4097) },
    { feedback: "invalid\u0000feedback" }, { reviewId: "review:other" }, { runId: "run:other" }, { targetId: "target:other" },
    { targetDigest: sha256Digest("other target") }, { contentHash: sha256Digest("other bytes") }, { approved: true }])
    await assert.rejects(async () => x.revisionOwner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, { ...x.revisionRequest, ...patch }, signal()));
  await assert.rejects(x.revisionOwner.revisions!.plan(x.f.identity, "project:other", x.request.jobId, x.revisionRequest, signal()));
  await assert.rejects(x.revisionOwner.revisions!.plan({ ...x.f.identity, subject: "identity:other" }, x.request.projectId, x.request.jobId, x.revisionRequest, signal()));
  const scoped = x.createOwner({ revisionPlanning: true, scope: { ...x.f.scope, workspaceId: "workspace:other" } }); t.after(() => scoped.close());
  await assert.rejects(scoped.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, x.revisionRequest, signal()));
  assert.deepEqual(await rows(x), []); assert.deepEqual(await unchangedEvidence(x), before);
});

test("revision planning requires the current owner and every result and review permission", async t => {
  const x = await revisionFixture(); t.after(x.close);
  const actions = ["projects.read", "tasks.plan", "tasks.read", "tasks.results.read", "tasks.reviews.record"];
  for (const missing of actions.slice(1)) {
    await x.asMigrator(() => x.f.db.query("UPDATE control_role_grants SET allowed_actions=$1::jsonb", [JSON.stringify(actions.filter(action => action !== missing))]));
    await assert.rejects(x.plan()); assert.deepEqual(await rows(x), []);
  }
  await x.asMigrator(() => x.f.db.query("UPDATE control_role_grants SET allowed_actions='[\"*\"]'::jsonb,role_key='operator'"));
  await assert.rejects(x.plan()); assert.deepEqual(await rows(x), []);
  await x.asMigrator(() => x.f.db.query("UPDATE control_role_grants SET role_key='owner'"));
  await x.asMigrator(() => x.f.db.query("UPDATE control_web_sessions SET revoked_at=$1", [new Date(x.f.clock()).toISOString()]));
  await assert.rejects(x.plan()); assert.deepEqual(await rows(x), []);
});

test("accepted review, unavailable bytes and oversize complete revision prompts do not produce plans", async t => {
  await t.test("accepted review", async t => {
    const x = await revisionFixture(undefined, "accepted"); t.after(x.close); await assert.rejects(x.plan()); assert.deepEqual(await rows(x), []);
  });
  await t.test("unavailable bytes", async t => {
    const x = await revisionFixture(); t.after(x.close); let read = false;
    const owner = x.createOwner({ revisionPlanning: true, quality: { ...x.config.quality!, results: { ...x.f.ownerConfig.results,
      storage: { read: async () => { read = true; throw new Error("synthetic_bytes_unavailable"); } } } } }); t.after(() => owner.close());
    await assert.rejects(owner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, x.revisionRequest, signal()));
    assert.equal(read, true); assert.deepEqual(await rows(x), []);
  });
  await t.test("complete prompt exceeds bound", async t => {
    const x = await revisionFixture(qualityText + "x".repeat(4000)); t.after(x.close);
    await assert.rejects(x.plan()); assert.deepEqual(await rows(x), []);
  });
});

test("revision planning snapshots request and identity before asynchronous lifecycle admission", async t => {
  const x = await revisionFixture(); t.after(x.close); const entered = deferredQuality(), release = deferredQuality(); let first = true;
  const db: DatabaseClient = { ...x.f.db, async transactionWithPreCommitCheck(work, check) {
    if (first) { first = false; entered.resolve(); await release.promise; } return x.f.db.transactionWithPreCommitCheck(work, check);
  } };
  const owner = x.createOwner({ revisionPlanning: true, database: { ...x.config.database, client: db } }); t.after(() => owner.close());
  const request = { ...x.revisionRequest }, identity = { ...x.f.identity };
  const pending = owner.revisions!.plan(identity, x.request.projectId, x.request.jobId, request, signal());
  request.feedback = "mutated"; request.runId = "run:mutated"; identity.subject = "identity:mutated";
  await entered.promise; release.resolve(); const saved = await pending; assert.equal(saved.replayed, false); assert.equal((await rows(x)).length, 1);
});

test("pre-admission cancellation and expired owner or template refuse revision planning", async t => {
  const x = await revisionFixture(); t.after(x.close);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(x.revisionOwner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, x.revisionRequest, abort.signal));
  for (const now of [Date.parse(x.f.identity.expiresAt) + 1, Date.parse(x.f.plannerConfig.template.authority.expiresAt) - 59_000]) {
    const owner = x.createOwner({ revisionPlanning: true, clock: () => now }); t.after(() => owner.close());
    await assert.rejects(owner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, x.revisionRequest, signal()));
  }
  assert.deepEqual(await rows(x), []);
});

test("SQL failure and cancellation or expiry at precommit roll back the full revision bundle", async t => {
  for (const mode of ["sql", "cancel", "expiry"] as const) await t.test(mode, async t => {
    const x = await revisionFixture(); t.after(x.close); const before = await unchangedEvidence(x), abort = new AbortController();
    const indexes = await bundleIndexes(x); let wrote = false, now = x.f.clock();
    const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(tx => work({
      async query<T>(sql: string, params?: unknown[]) {
        const value = await tx.query<T>(sql, params);
        if (sql.includes("INSERT INTO audit_events")) {
          wrote = true; if (mode === "sql") throw new Error("synthetic_revision_sql_failure");
          if (mode === "cancel") abort.abort(); else now = Date.parse(x.f.identity.expiresAt) + 1;
        }
        return value;
      },
    }), check) };
    const owner = x.createOwner({ revisionPlanning: true, clock: () => now, database: { ...x.config.database, client: db } }); t.after(() => owner.close());
    await assert.rejects(owner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, x.revisionRequest, abort.signal));
    assert.equal(wrote, true); assert.deepEqual(await rows(x), []);
    assert.deepEqual(await bundleIndexes(x), indexes); assert.deepEqual(await unchangedEvidence(x), before);
  });
});

test("forced coordinator drain interrupts revision planning without late child or evidence writes", async t => {
  const x = await revisionFixture(); t.after(x.close); const before = await unchangedEvidence(x), indexes = await bundleIndexes(x);
  const entered = deferredQuality(), release = deferredQuality(), settled = deferredQuality(); let reading = false;
  const db: DatabaseClient = { ...x.f.db, async transactionWithPreCommitCheck(work, check) {
    try { return await x.f.db.transactionWithPreCommitCheck(work, check); } finally { if (reading) settled.resolve(); }
  } };
  const owner = x.createOwner({ revisionPlanning: true, drainMs: 1, database: { ...x.config.database, client: db },
    quality: { ...x.config.quality!, results: { ...x.f.ownerConfig.results, storage: { read: async (...args) => {
      reading = true; entered.resolve(); await release.promise; return x.f.ownerConfig.results.storage.read(...args);
    } } } } });
  const pending = assert.rejects(owner.revisions!.plan(x.f.identity, x.request.projectId, x.request.jobId, x.revisionRequest, signal()));
  await entered.promise; await assert.rejects(owner.close(), /uncertain/); release.resolve(); await pending; await settled.promise;
  assert.deepEqual(await rows(x), []); assert.deepEqual(await bundleIndexes(x), indexes); assert.deepEqual(await unchangedEvidence(x), before);
});
