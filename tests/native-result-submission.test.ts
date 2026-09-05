import assert from "node:assert/strict";
import test from "node:test";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { at, registration } from "./native-task-fixture";
import { binding, instant } from "./hermes-native-fixture";
import { sha256Digest } from "../src/security";
import { NativeResultSubmissionService } from "../src/completion-gate/v1/native-result-submission";
import { NativeTaskResultService } from "../src/node-control/native-task-result-service";
import { WebTaskReviewService } from "../src/web/v1/task-review-service";
import type { CompletionAcceptanceProfileV1 } from "../src/completion-gate/v1";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

async function fixture() {
  const f = await webNativeResultFixture();
  const profile: CompletionAcceptanceProfileV1 = { schemaVersion: "control-room-completion-gate/v1", id: "profile:planned-result",
    tenantId: binding.tenantId, projectId: binding.projectId, name: "Planned document review", targetKind: "document",
    requiredVerificationScenarioIds: ["scenario:content"], minimumIndependentReviews: 1,
    reviewerSeparation: { actor: true, worker: false, agentProfile: false, harness: false, modelFamily: false },
    verificationRequiresProducerSeparation: true, minimumRisk: "low", maximumRevisionRounds: 2, automaticLowRiskDisposition: false,
    createdBy: { actorId: "identity:test", actorType: "human" }, createdAt: at() };
  await f.reviewStore.registerProfile(profile);
  const config = { integrityKey: f.reviewKey, harnessIntegrityKey: f.harnessKey, checkpoints: f.checkpoints, results: f.config };
  const create = (db = f.db) => new NativeResultSubmissionService(db, config);
  const submission = create(), service = new NativeTaskResultService(f.auth, f.runs, f.results, submission);
  const request = { tenantId: binding.tenantId, runId: registration.id, acceptanceProfileId: profile.id,
    acceptanceProfileDigest: sha256Digest(profile), plannedAt: at() };
  return { ...f, profile, config, create, submission, service, request };
}

test("preplanned authenticated delivery creates the exact review target, then owner review works without manual target setup", async t => {
  const f = await fixture(); t.after(f.close);
  const { plan } = await f.submission.register(f.request);
  assert.equal((await f.reviewStore.inspectSubject(binding.tenantId, binding.projectId, binding.jobId)).targets.length, 0);
  const input = f.complete("A planned useful document.");
  const { receipt } = await f.service.ingest(input.raw, input.bytes, f.options(at(2000)));
  const snapshot = await f.reviewStore.snapshot(binding.tenantId, plan.targetId), target = snapshot.target;
  assert.equal(target.subjectDigest, receipt.contentHash); assert.equal(target.subjectId, binding.jobId);
  assert.equal(target.producer.actorId, binding.nodeId); assert.equal(target.submittedAt, receipt.receivedAt);
  assert.equal(snapshot.status, "pending"); assert.equal(snapshot.grantsExecutionAuthority, false);
  assert.deepEqual(snapshot.acceptedReviewIds, []); assert.deepEqual(snapshot.missingVerificationScenarioIds, ["scenario:content"]);
  const review = new WebTaskReviewService(f.db, f.scope, f.config, () => instant + 6000);
  const saved = await review.record(f.identity, binding.projectId, binding.jobId, { artifactId: receipt.artifactId,
    targetId: target.id, targetDigest: sha256Digest(target), contentHash: receipt.contentHash, decision: "accepted", feedback: "" }, "planned-owner-review-001");
  assert.equal(saved.receipt.grantsExecutionAuthority, false);
  assert.equal((await f.reviewStore.snapshot(binding.tenantId, target.id)).status, "pending");
  assert.equal((await f.tasks.detail(f.identity, binding.projectId, binding.jobId)).task.state, "leased");
});

test("durable plan and delivery replay retain one target and checkpoint across service reconstruction", async t => {
  const f = await fixture(); t.after(f.close); await f.submission.register(f.request);
  const input = f.complete("Replay document"); await f.service.ingest(input.raw, input.bytes, f.options(at(2000)));
  const scope = `completion-gate:${binding.tenantId}`, checkpoint = f.checkpoints.read(scope);
  assert.equal((await f.create().register(f.request)).replayed, true);
  const values = await Promise.all([f.create().submit(binding.tenantId, registration.id), f.create().submit(binding.tenantId, registration.id)]);
  assert.ok(values.every(v => v.replayed && !v.qualityAccepted)); assert.deepEqual(values[0].target, values[1].target);
  assert.deepEqual(f.checkpoints.read(scope), checkpoint);
  assert.equal((await f.db.query("SELECT id FROM audit_events WHERE action='task.result.submitted_for_review'")).rows.length, 1);
});

test("missing plan does not report successful configured submission; captured artifact is retained without quality acceptance", async t => {
  const f = await fixture(); t.after(f.close); const input = f.complete("No review plan");
  await assert.rejects(f.service.ingest(input.raw, input.bytes, f.options(at(2000))), /native_result_rejected/);
  assert.equal((await f.db.query("SELECT * FROM control_native_artifact_receipts")).rows.length, 1);
  assert.equal((await f.reviewStore.inspectSubject(binding.tenantId, binding.projectId, binding.jobId)).targets.length, 0);
  await assert.rejects(f.submission.register(f.request), /native_review_submission_unavailable/);
});

test("registration rejects a missing or mismatched profile, invalid time, or changed immutable plan", async t => {
  const f = await fixture(); t.after(f.close);
  for (const patch of [{ acceptanceProfileId: "profile:missing" }, { acceptanceProfileDigest: `sha256:${"a".repeat(64)}` },
    { plannedAt: at(-1) }, { plannedAt: registration.nativeTask!.deadline }, { tenantId: "tenant:other" }])
    await assert.rejects(f.submission.register({ ...f.request, ...patch }));
  assert.equal((await f.db.query("SELECT * FROM control_native_review_plans")).rows.length, 0);
  await f.submission.register(f.request);
  await assert.rejects(f.submission.register({ ...f.request, plannedAt: at(1) }));
  for (const sql of ["UPDATE control_native_review_plans SET plan=plan", "DELETE FROM control_native_review_plans", "TRUNCATE control_native_review_plans"])
    await assert.rejects(f.db.query(sql));
});

test("absent bytes and wrong scope cannot create a target", async t => {
  const f = await fixture(); t.after(f.close); await f.submission.register(f.request);
  await assert.rejects(f.submission.submit(binding.tenantId, registration.id));
  const input = f.complete("A stored file"); await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const unavailable = new NativeResultSubmissionService(f.db, { ...f.config, results: { ...f.config.results, storage: { read: async () => undefined } } });
  await assert.rejects(unavailable.submit(binding.tenantId, registration.id));
  await assert.rejects(f.submission.submit("tenant:other", registration.id));
  assert.equal((await f.reviewStore.inspectSubject(binding.tenantId, binding.projectId, binding.jobId)).targets.length, 0);
});

test("ordinary audit failure rolls back target and leaves checkpoint unchanged; exact retry submits the retained file", async t => {
  const f = await fixture(); t.after(f.close); await f.submission.register(f.request);
  const input = f.complete("Retained after SQL failure"); await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const checkpoint = f.checkpoints.read(`completion-gate:${binding.tenantId}`);
  const wrap = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
    if (sql.includes("INSERT INTO audit_events")) throw new Error("synthetic_audit_failure");
    return tx.query<T>(sql, params);
  } });
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
  await assert.rejects(f.create(db).submit(binding.tenantId, registration.id));
  assert.deepEqual(f.checkpoints.read(`completion-gate:${binding.tenantId}`), checkpoint);
  assert.equal((await f.reviewStore.inspectSubject(binding.tenantId, binding.projectId, binding.jobId)).targets.length, 0);
  assert.equal((await f.submission.submit(binding.tenantId, registration.id)).replayed, false);
});

test("lost commit acknowledgement reconciles the original target without another checkpoint advance", async t => {
  const f = await fixture(); t.after(f.close); await f.submission.register(f.request);
  const input = f.complete("Lost submission acknowledgement"); await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const db: DatabaseClient = { ...f.db, async transactionWithPreCommitCheck(work, check) {
    await f.db.transactionWithPreCommitCheck(work, check); throw new Error("synthetic_lost_ack");
  } };
  await assert.rejects(f.create(db).submit(binding.tenantId, registration.id));
  const checkpoint = f.checkpoints.read(`completion-gate:${binding.tenantId}`);
  assert.equal((await f.submission.submit(binding.tenantId, registration.id)).replayed, true);
  assert.deepEqual(f.checkpoints.read(`completion-gate:${binding.tenantId}`), checkpoint);
});
