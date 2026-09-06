import assert from "node:assert/strict";
import test from "node:test";
import { nativeRevisedResultFixture, nativeRevisedExecutionFixture, revisedText } from "./helpers/native-revised-result";
import { qualityText, interceptNativeQualityDatabase } from "./helpers/native-quality-completion";
import { NativeResultVerificationService } from "../src/completion-gate/v1/native-result-verification";
import { NativeTaskCompletionService } from "../src/persistence/native-task-completion";
import { NativeResultSubmissionService } from "../src/completion-gate/v1/native-result-submission";
import { NativeTaskResultService } from "../src/node-control/native-task-result-service";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { CompletionReviewV1, CompletionFindingV1 } from "../src/completion-gate/v1";
import { sha256Digest } from "../src/security";

type Prepared = Awaited<ReturnType<typeof nativeRevisedExecutionFixture>>;
const checkpoint = (x: Prepared) => x.f.checkpoints.read(`completion-gate:${x.plan.tenantId}`);
const gateRows = async (x: Prepared) => (await x.f.db.query("SELECT * FROM control_completion_gate_records ORDER BY id")).rows;
const childPlans = async (x: Prepared) => (await x.f.db.query("SELECT * FROM control_native_review_plans WHERE job_id=$1", [x.plan.job.id])).rows;
const registrationRequest = (x: Prepared) => ({ tenantId: x.plan.tenantId, runId: x.registration.id,
  acceptanceProfileId: x.plan.acceptanceProfileId, acceptanceProfileDigest: x.plan.acceptanceProfileDigest,
  plannedAt: x.registration.createdAt, revision: x.plan.revision });

test("actual synthetic revised child preserves the logical subject and completes only with fresh child checks and review", async t => {
  const x = await nativeRevisedResultFixture(); t.after(x.close);
  assert.notEqual(x.child.jobId, x.source.jobId); assert.notEqual(x.child.runId, x.source.runId);
  assert.notEqual(x.child.artifactId, x.source.artifact.artifactId);
  assert.equal(x.child.target.subjectId, x.source.target.subjectId); assert.equal(x.child.target.rootTargetId, x.source.target.rootTargetId);
  assert.equal(x.child.target.revisionNumber, 1); assert.equal(x.child.target.supersedesTargetId, x.source.target.id);
  assert.equal(x.child.target.producer.actorId, x.registration.nodeId);
  assert.equal(x.child.artifact.jobId, x.child.jobId); assert.equal(x.child.artifact.runId, x.child.runId);
  assert.equal(x.child.artifact.attemptId, x.child.attemptId); assert.equal(x.child.target.subjectDigest, x.child.artifact.contentHash);
  assert.equal(x.child.revision.fromTargetDigest, x.source.targetDigest); assert.equal(x.child.revision.toTargetDigest, x.child.targetDigest);
  assert.deepEqual(x.child.revision.resolvedFindingIds, [x.changeReview.findingId]);
  assert.equal(x.planned.receipt.executionAvailability, "requires_separate_assignment_and_approval");
  assert.equal(x.reviewPlan.plan.schema, "control-room.native-review-plan/v2");
  assert.equal(x.child.targetDigest, sha256Digest(x.child.target));
  const oldState = await x.sourceStates(), seeded = await x.seededStates(), calls = x.counters();
  assert.deepEqual([oldState.job.state, oldState.attempt.state, oldState.lease.state], ["leased", "leased", "active"]);
  assert.equal(calls.sourceEffects, 1); assert.equal(calls.childEffects, 1);
  assert.equal((await x.f.reviewStore.snapshot(x.plan.tenantId, x.source.target.id)).status, "superseded");
  const fresh = await x.f.reviewStore.snapshot(x.plan.tenantId, x.child.target.id);
  assert.equal(fresh.status, "pending");
  assert.deepEqual((await x.f.db.query("SELECT id FROM control_completion_gate_records WHERE parent_id=$1 AND kind IN ('review','verification')", [x.child.target.id])).rows, []);
  const completion = new NativeTaskCompletionService(x.f.db, x.config, x.f.clock);
  await assert.rejects(completion.complete(x.request, () => {}));
  await new NativeResultVerificationService(x.f.db, x.config, [x.scenario], x.f.clock).verify(x.request, () => {});
  await assert.rejects(completion.complete(x.request, () => {}));
  await x.review(); const saved = await completion.complete(x.request, () => {}); assert.equal(saved.replayed, false);
  assert.equal((await completion.complete(x.request, () => {})).replayed, true);
  const childState = await x.childStates(); assert.deepEqual([childState.job.state, childState.attempt.state, childState.lease.state], ["succeeded", "succeeded", "released"]);
  assert.deepEqual(await x.sourceStates(), oldState); assert.deepEqual(await x.seededStates(), seeded); assert.deepEqual(x.counters(), calls);
});

test("exact revised registration and concurrent delivery replay preserve one target, revision, audit and checkpoint", async t => {
  const x = await nativeRevisedResultFixture(); t.after(x.close);
  const before = await gateRows(x), cp = checkpoint(x), calls = x.counters();
  assert.equal((await x.register()).replayed, true);
  const results = await Promise.all([x.submission.submit(x.plan.tenantId, x.child.runId), x.submission.submit(x.plan.tenantId, x.child.runId)]);
  assert.ok(results.every(result => result.replayed && !result.qualityAccepted));
  assert.deepEqual(results[0].target, x.child.target);
  const service = new NativeTaskResultService(x.f.auth, x.f.runs, x.f.results, x.submission);
  const replay = await service.ingest(x.delivered.raw, x.delivered.bytes, x.receiveOptions());
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, x.child.artifact);
  assert.equal((await x.f.db.query("SELECT id FROM audit_events WHERE action='task.result.submitted_for_review' AND target_id=$1", [x.child.artifactId])).rows.length, 1);
  assert.deepEqual(await gateRows(x), before); assert.deepEqual(checkpoint(x), cp); assert.deepEqual(x.counters(), calls);
});

test("revision registration independently rejects incomplete or conflicting predecessor lineage and profile", async t => {
  const x = await nativeRevisedExecutionFixture(); t.after(x.close); const before = await gateRows(x), cp = checkpoint(x);
  const request = registrationRequest(x);
  for (const revision of [{ ...request.revision, findingIds: [] }, { ...request.revision, findingIds: ["finding:missing"] },
    { ...request.revision, findingIds: [...request.revision.findingIds, "finding:unexpected"].sort() },
    { ...request.revision, reviewId: "review:missing" }, { ...request.revision, reviewDigest: sha256Digest("wrong review") },
    { ...request.revision, fromContentHash: sha256Digest("wrong predecessor bytes") },
    { ...request.revision, rootSubjectId: x.plan.job.id }, { ...request.revision, rootTargetId: "target:other" },
    { ...request.revision, revisionNumber: 2 }])
    await assert.rejects(x.submission.registerRevision({ ...request, revision }));
  for (const patch of [{ acceptanceProfileId: "profile:missing" }, { acceptanceProfileDigest: sha256Digest("wrong profile") },
    { plannedAt: new Date(Date.parse(request.plannedAt) - 1).toISOString() }, { plannedAt: x.registration.nativeTask!.deadline }])
    await assert.rejects(x.submission.registerRevision({ ...request, ...patch }));
  assert.deepEqual(await childPlans(x), []); assert.deepEqual(await gateRows(x), before); assert.deepEqual(checkpoint(x), cp);
  assert.equal(x.counters().childEffects, 0); assert.deepEqual(x.counters().childCalls, []);
  assert.equal((await x.register()).replayed, false);
  await assert.rejects(x.submission.registerRevision({ ...request, plannedAt: new Date(Date.parse(request.plannedAt) + 1).toISOString() }));
  assert.equal((await x.register()).replayed, true); assert.equal((await childPlans(x)).length, 1);
  assert.deepEqual(await gateRows(x), before); assert.deepEqual(checkpoint(x), cp);
});

test("revised submission refuses missing plan, missing bytes, changed storage bytes and unchanged predecessor content", async t => {
  await t.test("missing plan", async t => {
    const x = await nativeRevisedExecutionFixture(); t.after(x.close); await x.deliver(revisedText, false);
    const before = await gateRows(x); await assert.rejects(x.submission.submit(x.plan.tenantId, x.registration.id));
    assert.deepEqual(await gateRows(x), before); assert.deepEqual(await childPlans(x), []);
  });
  await t.test("missing or changed stored bytes", async t => {
    const x = await nativeRevisedExecutionFixture(); t.after(x.close); await x.register();
    await assert.rejects(x.submission.submit(x.plan.tenantId, x.registration.id));
    await x.deliver(revisedText, false); const before = await gateRows(x), cp = checkpoint(x), calls = x.counters();
    for (const bytes of [undefined, new TextEncoder().encode("changed bytes after receipt")]) {
      const submission = new NativeResultSubmissionService(x.f.db, { ...x.config, results: { ...x.config.results, storage: { read: async () => bytes } } });
      await assert.rejects(submission.submit(x.plan.tenantId, x.registration.id));
    }
    assert.deepEqual(await gateRows(x), before); assert.deepEqual(checkpoint(x), cp); assert.deepEqual(x.counters(), calls);
    assert.equal((await x.submission.submit(x.plan.tenantId, x.registration.id)).replayed, false);
  });
  await t.test("unchanged content", async t => {
    const x = await nativeRevisedExecutionFixture(); t.after(x.close); await x.register(); await x.deliver(qualityText, false);
    const before = await gateRows(x), cp = checkpoint(x);
    await assert.rejects(x.submission.submit(x.plan.tenantId, x.registration.id));
    assert.deepEqual(await gateRows(x), before); assert.deepEqual(checkpoint(x), cp);
    assert.equal((await x.f.reviewStore.snapshot(x.plan.tenantId, x.source.target.id)).status, "changes_requested");
  });
});

test("a new predecessor finding after registration cannot be silently omitted at revised submission", async t => {
  const x = await nativeRevisedExecutionFixture(); t.after(x.close); await x.register();
  const review = await x.f.reviewStore.getRecord(x.plan.tenantId, x.changeReview.reviewId, "review") as CompletionReviewV1;
  const finding = await x.f.reviewStore.getRecord(x.plan.tenantId, x.changeReview.findingId!, "finding") as CompletionFindingV1;
  await x.f.reviewStore.recordReview({ ...review, id: "review:additional", reviewer: { actorId: "identity:another-reviewer", actorType: "human" },
    findingIds: ["finding:additional"] }, [{ ...finding, id: "finding:additional", reviewId: "review:additional" }]);
  await x.deliver(revisedText, false); const before = await gateRows(x), cp = checkpoint(x);
  await assert.rejects(x.submission.submit(x.plan.tenantId, x.registration.id));
  assert.deepEqual(await gateRows(x), before); assert.deepEqual(checkpoint(x), cp);
});

test("ordinary submission SQL failure rolls back both target and revision before exact retry", async t => {
  const x = await nativeRevisedExecutionFixture(); t.after(x.close); await x.register(); await x.deliver(revisedText, false);
  const before = await gateRows(x), cp = checkpoint(x), calls = x.counters(); let reached = false;
  const db = interceptNativeQualityDatabase(x.f.db, sql => { if (sql.includes("INSERT INTO audit_events")) { reached = true; throw new Error("synthetic revised audit failure"); } });
  await assert.rejects(new NativeResultSubmissionService(db, x.config).submit(x.plan.tenantId, x.registration.id));
  assert.equal(reached, true); assert.deepEqual(await gateRows(x), before); assert.deepEqual(checkpoint(x), cp);
  assert.equal((await x.submission.submit(x.plan.tenantId, x.registration.id)).replayed, false); assert.deepEqual(x.counters(), calls);
});

test("lost revised-submission acknowledgement replays committed target and revision without repeating native work", async t => {
  const x = await nativeRevisedExecutionFixture(); t.after(x.close); await x.register(); await x.deliver(revisedText, false);
  const calls = x.counters(); let committed = false;
  const db: DatabaseClient = { ...x.f.db, async transactionWithPreCommitCheck(work, check) {
    await x.f.db.transactionWithPreCommitCheck(work, check); committed = true; throw new Error("synthetic revised acknowledgement lost");
  } };
  await assert.rejects(new NativeResultSubmissionService(db, x.config).submit(x.plan.tenantId, x.registration.id));
  assert.equal(committed, true); const cp = checkpoint(x), before = await gateRows(x);
  assert.equal((await x.submission.submit(x.plan.tenantId, x.registration.id)).replayed, true);
  assert.deepEqual(await gateRows(x), before); assert.deepEqual(checkpoint(x), cp); assert.deepEqual(x.counters(), calls);
});

test("checkpoint publication failure never reports a revised target as accepted or repairs an uncertain anchor", async t => {
  for (const failAt of [1, 2]) await t.test(`advance ${failAt}`, async t => {
    const x = await nativeRevisedExecutionFixture(); t.after(x.close); await x.register(); await x.deliver(revisedText, false);
    const before = await gateRows(x), cp = checkpoint(x); let advances = 0;
    const submission = new NativeResultSubmissionService(x.f.db, { ...x.config, checkpoints: {
      read: x.f.checkpoints.read.bind(x.f.checkpoints), initialize: x.f.checkpoints.initialize.bind(x.f.checkpoints),
      advance(expected, next) { advances++; if (advances === failAt) throw new Error("synthetic checkpoint failure"); x.f.checkpoints.advance(expected, next); },
    } });
    await assert.rejects(submission.submit(x.plan.tenantId, x.registration.id));
    assert.equal(advances, failAt); assert.deepEqual(await gateRows(x), before);
    if (failAt === 1) { assert.deepEqual(checkpoint(x), cp); assert.equal((await x.submission.submit(x.plan.tenantId, x.registration.id)).replayed, false); }
    else { assert.notDeepEqual(checkpoint(x), cp); await assert.rejects(x.submission.submit(x.plan.tenantId, x.registration.id)); }
  });
});

test("readback rejects tampered native-plan authentication and a missing exact revision record", async t => {
  const x = await nativeRevisedResultFixture(); t.after(x.close); const before = await gateRows(x), calls = x.counters();
  for (const mode of ["plan_auth", "missing_revision"] as const) {
    let reached = false;
    const wrap = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (mode === "plan_auth" && sql.includes("FROM control_native_review_plans") && params?.includes(x.child.runId)) {
        reached = true; return { ...result, rows: result.rows.map(row => ({ ...row, auth_tag: "hmac-sha256:" + "0".repeat(64) })) };
      }
      if (mode === "missing_revision" && sql.includes("FROM control_completion_gate_records") && params?.[1] === x.child.revision.id && params?.[2] === "revision") {
        reached = true; return { ...result, rows: [] };
      }
      return result;
    } });
    const db: DatabaseClient = { ...x.f.db, transaction: work => x.f.db.transaction(tx => work(wrap(tx))),
      transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
    const submission = new NativeResultSubmissionService(db, x.config);
    await assert.rejects(db.transaction(tx => submission.inspectSubmitted(tx, x.plan.tenantId, x.child.runId))); assert.equal(reached, true);
  }
  assert.deepEqual(await gateRows(x), before); assert.deepEqual(x.counters(), calls);
});
