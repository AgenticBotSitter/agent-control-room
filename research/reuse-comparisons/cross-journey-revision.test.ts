import { createTaskCoordinatorLifecycle } from "../../src/web/v1/task-coordinator-lifecycle";
import assert from "node:assert/strict";
import test from "node:test";
import { nativeQualityCompletionFixture, qualityText } from "../../tests/helpers/native-quality-completion";
import { origin, request, token } from "../../tests/helpers/web-foundation";
import { binding, instant } from "../../tests/hermes-native-fixture";
import { createPrivateWebProcess } from "../../src/web/v1/private-process";
import { createControlCenterCollection } from "../../src/project-adapters/abs-news/v1/control-center-collection";
import { PostgresNewsSourceSettings } from "../../src/project-adapters/abs-news/v1/source-settings";
import { newsPageSchema, newsResearchPreviewSchema } from "../../src/web/v1/news-wire";
import { taskReceiptSchema } from "../../src/web/v1/task-wire";
import { sha256Digest } from "../../src/security";
import { createTaskHttpHandler } from "../../src/web/v1/task-http";
import { childLifecycleFixture } from "./cross-journey-child-helper";
import { WebTaskReviewService } from "../../src/web/v1/task-review-service";

test("research: borrowed discovery result carries exact source lineage into owner-requested revision", async t => {
  // In-process application integration only: no sockets, providers or pg-boss
  // workers. The existing acceptance profile verifies document structure, not
  // the truth or quality of the synthetic research conclusions.
  const article = "https://example.org/news/model", text = `${qualityText}Source: ${article}\n`;
  let storyDigest = "", sourceJobId = "";
  const reads: string[] = [];
  const jwt = token({ iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const req = (path: string, method = "GET", body?: unknown) => request(path, method, body, "research-journey-save-001", jwt);
  const x = await nativeQualityCompletionFixture(text, async f => {
    const scope = { ...f.scope, projectId: binding.projectId }, key = new Uint8Array(32).fill(47);
    const source = { id: "source:research-journey", name: "Synthetic AI news", url: "https://example.org/news", enabled: true };
    await new PostgresNewsSourceSettings(f.db, scope, key).save(source, 0, new Date(instant + 6000).toISOString());
    const collection = createControlCenterCollection(f.db, { ...scope, sourceId: source.id, expectedRevision: 1,
      limits: { timeoutMs: 10000, maxAttempts: 8, maxDocumentBytes: 4096, maxReservedBodyBytes: 32768 } }, key,
    { assertCurrent(url) { assert.equal(new URL(url).origin, "https://example.org"); } }, {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch: async url => {
        reads.push(url.toString());
        return new Response(url.toString() === source.url
          ? '<html><head><link rel="alternate" type="application/rss+xml" href="https://example.org/feed.xml"></head></html>'
          : `<rss><channel><item><title>AI model release</title><link>${article}</link><pubDate>${new Date(instant).toUTCString()}</pubDate></item></channel></rss>`);
      },
    }, () => instant + 6000);
    try { await collection.collect(new AbortController().signal); }
    finally { await collection.close(); }
    assert.deepEqual(reads.slice(0, 2), [source.url, "https://example.org/feed.xml"]);
    const app = createPrivateWebProcess({ origin, issuer: f.accessTrust.issuer, audience: f.accessTrust.audience,
      maxSessionSeconds: f.accessTrust.maxSessionSeconds, loadKeys: async () => f.accessTrust.keys,
      ...f.scope, database: { client: f.db, close: async () => {} }, news: { integrityKey: key }, clock: () => instant + 6000 });
    try {
      const base = `/api/v1/projects/${encodeURIComponent(binding.projectId)}`;
      const pageResponse = await app.handle(req(`${base}/news`), () => new Response("shell"));
      assert.equal(pageResponse.status, 200);
      const page = newsPageSchema.parse(await pageResponse.json());
      assert.equal(page.stories.length, 1); const story = page.stories[0];
      assert.equal(story.canonicalUrl, article); assert.equal(story.verificationState, "review_only"); storyDigest = story.storyDigest;
      const previewResponse = await app.handle(req(`${base}/news/prepare`, "POST", {
        storyId: story.storyId, storyDigest, action: "research_brief", goal: "Verify the source claims and produce a report." }), () => new Response("shell"));
      assert.equal(previewResponse.status, 200); const preview = newsResearchPreviewSchema.parse(await previewResponse.json());
      assert.equal(preview.saved, false); assert.equal(preview.dispatch, "not_requested");
      assert.match(preview.draft.instructions, /VERIFICATION-FIRST RESEARCH/);
      assert.ok(preview.draft.instructions.includes(article)); assert.ok(preview.draft.instructions.includes(storyDigest));
      const savedResponse = await app.handle(req(`${base}/tasks`, "POST", preview.draft), () => new Response("shell"));
      assert.equal(savedResponse.status, 201); const saved = await savedResponse.json();
      const receipt = taskReceiptSchema.parse(saved.receipt); sourceJobId = receipt.jobId;
      assert.equal(receipt.startsWork, false);
      const replay = await app.handle(req(`${base}/tasks`, "POST", preview.draft), () => new Response("shell"));
      assert.equal(replay.status, 200); assert.deepEqual((await replay.json()).receipt, receipt);
      assert.equal((await f.tasks.detail(f.identity, binding.projectId, sourceJobId)).attempts.length, 0);
      return { draft: preview.draft, source: { receipt, replayed: false } };
    } finally { await app.close(); }
  });
  t.after(x.close);
  assert.equal(x.f.assignmentFixture.source.receipt.jobId, sourceJobId);
  const planned = (await x.f.db.query<{ plan: { sourceJobId: string; sourceInputDigest: string; input: { prompt: string; instructions: string } } }>(
    "SELECT plan FROM control_task_execution_plans WHERE tenant_id=$1 AND job_id=$2", [x.registration.tenantId, x.registration.jobId])).rows[0].plan;
  assert.equal(planned.sourceJobId, sourceJobId);
  assert.equal(planned.sourceInputDigest, sha256Digest(x.f.assignmentFixture.sourceDraft));
  assert.equal(planned.input.prompt, x.f.assignmentFixture.sourceDraft.instructions);
  assert.equal(x.f.assignmentFixture.prepared.receipt.inputDigest, sha256Digest(planned.input));
  assert.ok(x.f.assignmentFixture.sourceDraft.instructions.includes(storyDigest));
  assert.equal(x.registration.jobId, x.f.assignmentFixture.prepared.receipt.jobId);
  assert.notEqual(x.registration.jobId, sourceJobId);
  const taskHttp = createTaskHttpHandler({ origin, trust: x.f.accessTrust, service: x.f.tasks, clock: x.f.clock });
  const resultPath = `/api/v1/projects/${encodeURIComponent(x.registration.projectId)}/tasks/${encodeURIComponent(x.registration.jobId)}/results/${encodeURIComponent(x.artifact.artifactId)}`;
  const denied = req(resultPath); denied.headers.delete("cf-access-jwt-assertion");
  assert.equal((await taskHttp(denied)).status, 401);
  const resultResponse = await taskHttp(req(resultPath)); assert.equal(resultResponse.status, 200);
  const content = await resultResponse.json(); assert.equal(content.text, text); assert.equal(content.untrustedContent, true);
  assert.equal(x.artifact.qualityAccepted, false);
  await assert.rejects(x.complete());

  await x.verify(); const review = await x.review("changes_requested");
  await assert.rejects(x.complete());
  const config = { scope: x.f.scope, planning: x.f.plannerConfig,
    routes: [x.f.assignmentFixture.route], quality: { ...x.f.ownerConfig, scenarios: [x.scenario] },
    clock: x.f.clock, revisionPlanning: true as const,
    database: { client: x.f.db, isAvailable: () => true, close: async () => {} } };
  const owner = createTaskCoordinatorLifecycle(config); t.after(() => owner.close());
  const value = { runId: x.registration.id, targetId: x.target.id, targetDigest: x.request.targetDigest,
    contentHash: x.request.contentHash, reviewId: review.receipt.reviewId, feedback: "Please improve the evidence." };
  const revise = () => owner.revisions!.plan(x.f.identity, binding.projectId, x.registration.jobId,
    value, new AbortController().signal);
  const child = await revise();
  assert.equal(child.receipt.startsWork, false); assert.equal(child.receipt.grantsExecutionAuthority, false);
  assert.equal(child.receipt.sourceJobId, x.registration.jobId);
  assert.notEqual(child.receipt.jobId, sourceJobId); assert.notEqual(child.receipt.jobId, x.registration.jobId);
  const plan = await x.f.planner.read(child.receipt.jobId); assert.ok(plan);
  assert.equal(plan.schema, "control-room.task-execution-plan/v2");
  const prompt = JSON.parse(plan.input.prompt);
  assert.equal(prompt.previousResult, text); assert.equal(prompt.requestedChanges, value.feedback);
  assert.equal(prompt.originalTask, x.f.assignmentFixture.sourceDraft.instructions);
  assert.ok(prompt.originalTask.includes(storyDigest)); assert.ok(prompt.previousResult.includes(article));
  assert.equal(child.receipt.fromContentHash, x.artifact.contentHash);
  assert.equal(child.receipt.reviewId, review.receipt.reviewId);
  assert.deepEqual([child.receipt.fromRunId, child.receipt.fromTargetId, child.receipt.fromTargetDigest],
    [value.runId, value.targetId, value.targetDigest]);
  for (const table of ["control_attempts", "control_leases"])
    assert.equal((await x.f.db.query(`SELECT id FROM ${table} WHERE job_id=$1`, [child.receipt.jobId])).rows.length, 0);
  const reopened = createTaskCoordinatorLifecycle(config); t.after(() => reopened.close());
  const replay = await reopened.revisions!.plan(x.f.identity, binding.projectId, x.registration.jobId,
    value, new AbortController().signal);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, child.receipt);
  assert.equal((await x.f.db.query("SELECT id FROM audit_events WHERE target_id=$1", [child.receipt.jobId])).rows.length, 1);
  assert.equal(x.local.effects.countFull(), 1);
  assert.deepEqual((await x.results.ingest(x.completed.raw, new TextEncoder().encode(text), x.options())).receipt, x.artifact);
  assert.equal(x.local.effects.countFull(), 1);
  const runsBeforeAssignment = (await x.f.db.query("SELECT * FROM control_harness_runs ORDER BY id")).rows;
  const parentBeforeAssignment = await x.states();
  const coordinator = x.f.assignmentFixture.create(x.f.db, x.f.clock);
  const activeLeases = (await x.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_leases WHERE tenant_id=$1 AND node_id=$2 AND state='active'",
    [x.f.scope.tenantId, binding.nodeId])).rows[0];
  assert.ok(Number(activeLeases?.count) >= x.f.assignmentFixture.route.maxConcurrentTasks);
  // Preserve the observed full-capacity refusal, not a fabricated assignment pass.
  await assert.rejects(coordinator.assign(x.f.identity, binding.projectId, child.receipt.jobId,
    binding.nodeId, plan.job.inputDigest), { code: "conflict" });
  const detail = await x.f.tasks.detail(x.f.identity, binding.projectId, child.receipt.jobId);
  assert.equal(detail.task.state, "proposed"); assert.equal(detail.attempts.length, 0);
  assert.deepEqual((await x.f.db.query("SELECT * FROM control_harness_runs ORDER BY id")).rows, runsBeforeAssignment);
  assert.deepEqual(await x.states(), parentBeforeAssignment);
  assert.equal(x.local.effects.countFull(), 1);
  const seedBeforeRelease = await x.f.canonical.get(x.f.scope.tenantId, "lease", "lease:test");
  const reconciled = await owner.quality!.reconcile({ ...x.request, projectId: binding.projectId,
    jobId: x.registration.jobId }, new AbortController().signal);
  assert.equal(reconciled.disposition, "changes_requested"); assert.ok(reconciled.capacity);
  const released = await x.states();
  assert.equal(released.lease.state, "released");
  assert.deepEqual(released.job, parentBeforeAssignment.job);
  assert.deepEqual(released.attempt, parentBeforeAssignment.attempt);
  assert.deepEqual(await x.f.canonical.get(x.f.scope.tenantId, "lease", "lease:test"), seedBeforeRelease);
  const assigned = await coordinator.assign(x.f.identity, binding.projectId, child.receipt.jobId,
    binding.nodeId, plan.job.inputDigest);
  assert.equal(assigned.receipt.startsWork, false); assert.equal(assigned.receipt.grantsExecutionAuthority, false);
  assert.equal(assigned.receipt.leaseCurrent, true);
  assert.notEqual(assigned.receipt.leaseId, x.registration.nativeTask!.leaseId);
  const assignedDetail = await x.f.tasks.detail(x.f.identity, binding.projectId, child.receipt.jobId);
  assert.equal(assignedDetail.task.state, "leased"); assert.equal(assignedDetail.attempts.length, 1);
  assert.deepEqual(assignedDetail.attempts[0].runs, []);
  const assignedAgain = await x.f.assignmentFixture.create(x.f.db, x.f.clock).assign(x.f.identity,
    binding.projectId, child.receipt.jobId, binding.nodeId, plan.job.inputDigest);
  assert.equal(assignedAgain.replayed, true); assert.deepEqual(assignedAgain.receipt, assigned.receipt);
  assert.deepEqual((await x.f.db.query("SELECT * FROM control_harness_runs ORDER BY id")).rows, runsBeforeAssignment);
  assert.deepEqual(await x.states(), released);
  assert.equal(x.local.effects.countFull(), 1);
  const childArgs = [x.f.identity, binding.projectId, child.receipt.jobId, plan.job.inputDigest] as const;
  const parentPacket = await x.f.coordinator.readNativeApproval(...x.f.args);
  await assert.rejects(x.f.coordinator.storeNativeApproval(...childArgs, x.f.packet, x.f.abort.signal));
  assert.deepEqual(await x.f.coordinator.readNativeApproval(...x.f.args), parentPacket);
  const childPrepared = await x.f.coordinator.prepareNativeApproval(...childArgs);
  const packet = { schema: "control-room.native-task-approval-packet/v1" as const,
    approval: x.f.sign({ ...x.f.packet.approval.body, jobId: childPrepared.request.jobId,
      attemptId: childPrepared.request.attemptId, operationDigest: childPrepared.request.operationDigest,
      issuedAt: new Date(x.f.clock()).toISOString(), expiresAt: new Date(childPrepared.start.deadline).toISOString(),
      nonce: "c3ludGhldGljLWNoaWxkLW5vbmNl" }),
    recovery: x.f.sign({ ...x.f.packet.recovery.body, bindingDigest: sha256Digest(childPrepared.binding),
      issuedAt: x.f.clock(), expiresAt: childPrepared.start.deadline + 120_000, nonce: "synthetic-child-recovery-nonce" }) };
  assert.notEqual(sha256Digest(packet), sha256Digest(x.f.packet));
  assert.notEqual(packet.approval.body.attemptId, x.f.packet.approval.body.attemptId);
  const childFixture = { ...x.f, args: childArgs, prepared: childPrepared, packet,
    assignmentFixture: { ...x.f.assignmentFixture, assign: async () => assigned },
    save: () => x.f.coordinator.storeNativeApproval(...childArgs, packet, x.f.abort.signal) };
  const y = await childLifecycleFixture(childFixture, close => { t.after(close); });
  assert.notEqual(y.registration.id, x.registration.id);
  assert.notEqual(y.registration.attemptId, x.registration.attemptId);
  assert.equal(y.registration.jobId, child.receipt.jobId);
  assert.equal(y.registration.nativeTask!.leaseId, assigned.receipt.leaseId);
  await y.handoff.start(); const childReviewPlan = await y.register();
  assert.equal(childReviewPlan.plan.schema, "control-room.native-review-plan/v2");
  assert.deepEqual(childReviewPlan.plan.revision, plan.revision);
  assert.deepEqual([childReviewPlan.plan.revision.fromJobId, childReviewPlan.plan.revision.fromRunId,
    childReviewPlan.plan.revision.fromTargetId, childReviewPlan.plan.revision.fromTargetDigest,
    childReviewPlan.plan.revision.fromContentHash, childReviewPlan.plan.revision.reviewId,
    childReviewPlan.plan.revision.feedbackDigest], [x.registration.jobId, x.registration.id, x.target.id,
    x.request.targetDigest, x.artifact.contentHash, review.receipt.reviewId, sha256Digest(value.feedback)]);
  await y.publish();
  y.advance(); await y.handoff.poll(); await y.publish();
  const revisedText = `${qualityText}Source: ${article}\nStory: ${storyDigest}\nFeedback addressed: ${value.feedback}\n`;
  y.advance(); y.setResult(revisedText); await y.handoff.poll(); const childCompleted = await y.publish();
  const childArtifact = (await y.results.ingest(childCompleted.raw, new TextEncoder().encode(revisedText), y.options())).receipt;
  assert.notEqual(childArtifact.artifactId, x.artifact.artifactId); assert.notEqual(childArtifact.contentHash, x.artifact.contentHash);
  const childTarget = (await x.f.reviewStore.snapshot(binding.tenantId, childReviewPlan.plan.targetId)).target;
  assert.notEqual(childTarget.id, x.target.id);
  const childRequest = { tenantId: binding.tenantId, runId: y.registration.id,
    targetDigest: sha256Digest(childTarget), contentHash: childArtifact.contentHash };
  await assert.rejects(x.createCompletion().complete(childRequest, () => {}));
  await x.createVerification().verify(childRequest, () => {});
  await assert.rejects(x.createCompletion().complete(childRequest, () => {}));
  const childReview = await new WebTaskReviewService(x.f.db, x.f.scope, x.f.ownerConfig, x.f.clock).record(
    x.f.identity, binding.projectId, child.receipt.jobId, { artifactId: childArtifact.artifactId, targetId: childTarget.id,
      targetDigest: childRequest.targetDigest, contentHash: childRequest.contentHash, decision: "accepted", feedback: "" },
    "cross-journey-child-review-001");
  assert.notEqual(childReview.receipt.reviewId, review.receipt.reviewId);
  const childCompletion = await x.createCompletion().complete(childRequest, () => {});
  assert.equal(childCompletion.replayed, false);
  const childStates = async () => ({
    job: await x.f.canonical.get(binding.tenantId, "job", y.registration.jobId),
    attempt: await x.f.canonical.get(binding.tenantId, "attempt", y.registration.attemptId),
    lease: await x.f.canonical.get(binding.tenantId, "lease", y.registration.nativeTask!.leaseId) });
  const settledChild = await childStates();
  assert.deepEqual([settledChild.job.state, settledChild.attempt.state, settledChild.lease.state], ["succeeded", "succeeded", "released"]);
  const completionReplay = await x.createCompletion().complete(childRequest, () => {});
  assert.equal(completionReplay.replayed, true); assert.deepEqual(completionReplay.receipt, childCompletion.receipt);
  assert.deepEqual(await childStates(), settledChild);
  assert.deepEqual(await x.f.coordinator.readNativeApproval(...x.f.args), parentPacket);
  assert.equal(x.local.effects.countFull(), 1); assert.equal(y.local.effects.countFull(), 1);
  assert.deepEqual((await y.results.ingest(childCompleted.raw, new TextEncoder().encode(revisedText), y.options())).receipt, childArtifact);
  const finalPlan = await x.f.planner.read(child.receipt.jobId); assert.deepEqual(finalPlan, plan);
  assert.deepEqual(await x.states(), released);
  t.diagnostic(JSON.stringify({scope:"same child signed-memory bridge and synthetic results, not live execution",
    childRevisionPlan:"v2", parentPacketRejected:true, freshChildPacket:true, parentUnchanged:true,
    childState:"succeeded", childLease:"released", completionReplayed:true,
    parentEffectCount:x.local.effects.countFull(), childEffectCount:y.local.effects.countFull(), sharedFleetDedup:false}));
});
