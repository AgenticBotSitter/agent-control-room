import assert from "node:assert/strict";
import test from "node:test";
import { nativeTaskLifecycleFixture } from "./helpers/native-task-lifecycle";
import { WebTaskService } from "../src/web/v1/task-service";
import { WebTaskReviewService } from "../src/web/v1/task-review-service";
import { taskResultContentSchema, taskResultsPageSchema } from "../src/web/v1/task-result-wire";
import { sha256Digest } from "../src/security";
import { signNodeFrame, type SignedNodeFrame } from "../src/node-protocol/v1";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import type { DatabaseClient } from "../src/persistence/database";

test("synthetic canonical task lifecycle connects approved delivery, admitted execution, signed progress, exact bytes and owner review", async t => {
  const x = await nativeTaskLifecycleFixture(); t.after(x.close);
  const { f, registration: run } = x;
  assert.equal(x.receipt.nodeReportedDisposition, "recorded"); assert.equal(x.receipt.executionConfirmed, false);
  assert.deepEqual(x.local.calls, []); assert.equal(x.local.effects.countFull(), 0);
  assert.throws(() => x.handoff.snapshot());
  assert.equal((await x.handoff.start()).state, "queued");
  assert.equal(x.local.admissions.count(), 1); assert.equal(x.local.effects.countFull(), 1);
  const reviewPlan = await x.register();
  assert.equal((await f.reviewStore.inspectSubject(run.tenantId, run.projectId, run.jobId)).targets.length, 0);
  await x.publish(); x.advance();
  assert.equal((await x.handoff.poll()).state, "running"); await x.publish();
  x.advance(); const text = "Synthetic lifecycle result: a useful document."; x.setResult(text);
  assert.equal((await x.handoff.poll()).state, "completed");
  const complete = await x.publish();
  assert.deepEqual(x.local.calls, ["capabilities", "start", "status", "status"]);
  assert.equal((await f.runs.get(run.tenantId, run.id))?.state, "succeeded");
  const events = await f.runs.events(run.tenantId, run.id);
  assert.deepEqual(events.map(event => event.payload.category === "native_snapshot" ? event.payload.snapshot.state : "unexpected"),
    ["queued", "running", "completed"]);
  assert.equal(complete.body.usage?.inputTokens, 12); assert.equal(complete.body.usage?.calls, null);
  assert.equal(complete.body.result?.sizeBytes, Buffer.byteLength(text));
  const progressFrames = x.sent.filter(frame => frame.type === "harness.native.snapshot");
  assert.equal(progressFrames.length, 3); assert.equal(JSON.stringify(progressFrames).includes(text), false);
  assert.equal(JSON.stringify(progressFrames).includes(f.prepared.binding.sessionId), false);
  assert.equal(x.journal.pendingOutbound().filter(item => item.frame.type === "harness.native.snapshot").length, 0);
  const tasks = new WebTaskService(f.db, f.scope, f.clock, f.taskKeys);
  assert.deepEqual(taskResultsPageSchema.parse(await tasks.results(f.identity, run.projectId, run.jobId)).items, []);
  const bytes = new TextEncoder().encode(text);
  const { receipt } = await x.results.ingest(complete.raw, bytes, x.options());
  assert.equal(receipt.runId, run.id); assert.equal(receipt.attemptId, run.attemptId); assert.equal(receipt.qualityAccepted, false);
  const target = (await f.reviewStore.snapshot(run.tenantId, reviewPlan.plan.targetId)).target;
  assert.equal(target.subjectId, run.jobId); assert.equal(target.subjectDigest, receipt.contentHash);
  const content = taskResultContentSchema.parse(await tasks.results(f.identity, run.projectId, run.jobId, receipt.artifactId));
  assert.equal(content.text, text); assert.equal(content.untrustedContent, true);
  const reviews = new WebTaskReviewService(f.db, f.scope, f.ownerConfig, f.clock);
  const draft = { artifactId: receipt.artifactId, targetId: target.id, targetDigest: sha256Digest(target),
    contentHash: receipt.contentHash, decision: "accepted" as const, feedback: "" };
  const reviewed = await reviews.record(f.identity, run.projectId, run.jobId, draft, "lifecycle-owner-review-001");
  assert.equal(reviewed.receipt.grantsExecutionAuthority, false);
  const gate = await f.reviewStore.snapshot(run.tenantId, target.id);
  assert.equal(gate.acceptedReviewIds.length, 1); assert.equal(gate.status, "pending");
  assert.deepEqual(gate.missingVerificationScenarioIds, ["scenario:content"]);
  assert.equal((await f.canonical.get(run.tenantId, "job", run.jobId))?.state, "leased");
  // Exact evidence/review replay and reopening execution cannot create another run/effect/review.
  assert.equal((await f.service.ingest(complete.raw, x.options())).event.replayed, true);
  assert.deepEqual((await x.results.ingest(complete.raw, bytes, x.options())).receipt, receipt);
  assert.deepEqual((await reviews.record(f.identity, run.projectId, run.jobId, draft, "lifecycle-owner-review-001")).receipt, reviewed.receipt);
  const reopened = await x.prepare(); t.after(reopened.close); await reopened.start();
  assert.deepEqual(x.local.calls, ["capabilities", "start", "status", "status"]);
  assert.equal(x.local.effects.countFull(), 1); assert.equal((await f.runs.events(run.tenantId, run.id)).length, 3);
});

test("completion evidence cannot turn mismatched delivered bytes into an artifact or planned review target", async t => {
  const x = await nativeTaskLifecycleFixture(); t.after(x.close);
  const { f, registration: run } = x;
  await x.handoff.start(); const plan = await x.register(); await x.publish();
  x.advance(); x.setResult("Original synthetic result"); await x.handoff.poll(); const completed = await x.publish();
  await assert.rejects(x.results.ingest(completed.raw, new TextEncoder().encode("Different synthetic data"), x.options()), /native_result_rejected/);
  assert.equal((await f.runs.get(run.tenantId, run.id))?.state, "succeeded");
  assert.equal((await f.reviewStore.inspectSubject(run.tenantId, run.projectId, run.jobId)).targets.length, 0);
  assert.equal((await f.db.query("SELECT artifact_id FROM control_native_artifact_receipts WHERE run_id=$1", [run.id])).rows.length, 0);
  const captured = await x.results.ingest(completed.raw, new TextEncoder().encode("Original synthetic result"), x.options());
  assert.equal((await f.reviewStore.snapshot(run.tenantId, plan.plan.targetId)).target.subjectDigest, captured.receipt.contentHash);
  assert.deepEqual(x.local.calls, ["capabilities", "start", "status"]);
  assert.equal((await f.canonical.get(run.tenantId, "job", run.jobId))?.state, "leased");
});

test("disconnect or expiry at the actual progress-store precommit fence rolls back evidence and emits no ACK", async t => {
  for (const mode of ["disconnect", "expiry"] as const) await t.test(mode, async t => {
    const x = await nativeTaskLifecycleFixture(); t.after(x.close);
    await x.handoff.start(); await x.register();
    const { raw } = await x.queueSnapshot(); let fences = 0;
    const signed = JSON.parse(raw) as SignedNodeFrame<"harness.native.snapshot">;
    // Inject after the store callback has completed its writes and returned. A freshness
    // check only at the end of that callback misses this existing database boundary.
    const database: DatabaseClient = { ...x.f.db,
      transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(work, () => {
        fences++;
        if (mode === "disconnect") x.session.disconnect();
        else x.f.setNow(Date.parse(signed.expiresAt));
        check();
      }) };
    const runs = new HarnessRunStoreV1(database, x.f.harnessKey);
    await assert.rejects(x.session.acceptNativeSnapshot(raw, (frame, assertCurrent) =>
      runs.recordNativeSnapshot(frame.tenantId, frame.actorId, frame.body, assertCurrent)));
    assert.equal(fences, 1);
    assert.equal((await x.f.runs.events(x.registration.tenantId, x.registration.id)).length, 0);
    assert.equal((await x.f.runs.get(x.registration.tenantId, x.registration.id))?.state, "discovered");
    assert.equal(x.outgoing.length, 0);
    assert.equal(x.journal.pendingOutbound().filter(item => item.frame.type === "harness.native.snapshot").length, 1);
    assert.deepEqual(x.local.calls, ["capabilities", "start"]);
  });
});

test("an authenticated snapshot for another binding never enters the current dispatch's persistence callback", async t => {
  const x = await nativeTaskLifecycleFixture(); t.after(x.close);
  await x.handoff.start(); await x.register();
  const { raw } = await x.queueSnapshot();
  const frame = JSON.parse(raw) as SignedNodeFrame<"harness.native.snapshot">;
  frame.body.bindingDigest = sha256Digest("another synthetic binding");
  const changed = signNodeFrame(frame, x.f.keys.privateKey); let commits = 0;
  await assert.rejects(x.session.acceptNativeSnapshot(JSON.stringify(changed), async () => { commits++; }), /task mismatch/);
  assert.equal(commits, 0); assert.equal(x.outgoing.length, 0);
  assert.equal((await x.f.runs.events(x.registration.tenantId, x.registration.id)).length, 0);
});

test("server refuses progress when snapshot support was not negotiated", async t => {
  const x = await nativeTaskLifecycleFixture({ serverFeatures: ["harness.native.dispatch.v1"] }); t.after(x.close);
  let commits = 0;
  // Refuse the channel before parsing or committing even an unsolicited frame.
  await assert.rejects(x.session.acceptNativeSnapshot("{}", async () => { commits++; }), /negotiated support/);
  assert.equal(commits, 0); assert.equal(x.outgoing.length, 0);
  assert.deepEqual(x.local.calls, []);
});

test("lost session ACK retains one committed observation and cannot replay native start", async t => {
  const x = await nativeTaskLifecycleFixture(); t.after(x.close);
  await x.handoff.start(); await x.register(); x.loseNextAcknowledgement();
  await assert.rejects(x.publish(), /synthetic_acknowledgement_lost/);
  const pending = x.journal.pendingOutbound().filter(item => item.frame.type === "harness.native.snapshot");
  assert.equal(pending.length, 1); assert.equal(x.outgoing.length, 0);
  assert.equal((await x.f.runs.events(x.registration.tenantId, x.registration.id)).length, 1);
  let commits = 0;
  await assert.rejects(x.session.acceptNativeSnapshot(JSON.stringify(pending[0].frame), async () => { commits++; }));
  assert.equal(commits, 0);
  // Existing evidence-only ingestion can reconcile the exact signed delivery; the closed
  // dispatch session is not silently revived, and this does not claim reconnect recovery.
  assert.equal((await x.f.service.ingest(JSON.stringify(pending[0].frame), x.options())).event.replayed, true);
  const reopened = await x.prepare(); t.after(reopened.close); await reopened.start();
  assert.deepEqual(x.local.calls, ["capabilities", "start"]);
  assert.equal(x.local.effects.countFull(), 1);
  assert.equal((await x.f.runs.events(x.registration.tenantId, x.registration.id)).length, 1);
});
