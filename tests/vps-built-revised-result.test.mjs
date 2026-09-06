import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import handler from "../dist-vps/server/index.js";
import { createPrivateTaskBootstrap } from "../dist-vps/server/taskBootstrap.js";
import { installPrivateApplication } from "../dist-vps/server/runtime.js";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { nativeRevisedResultFixture } from "./helpers/native-revised-result.ts";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { request } from "./helpers/web-foundation.ts";

test("compiled protected startup verifies, reviews and completes only the actual revised child", async t => {
  const x = await nativeRevisedResultFixture(); t.after(x.close);
  const startup = await taskStartupFixture(x.f.assignmentFixture);
  const canonical = new CanonicalStore(startup.coordinator.client);
  const opened = [], preflights = [];
  const observe = work => async tx => work({ async query(sql, params) {
    const result = await tx.query(sql, params);
    if (sql.includes("AS database_temp"))
      preflights.push((await tx.query("SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0]);
    return result;
  } });
  const bootstrap = createPrivateTaskBootstrap({ clock: x.f.clock, install: installPrivateApplication,
    openDatabase(config) {
      opened.push(config.username);
      const pool = startup.openDatabase(config), db = pool.client;
      return { ...pool, client: { ...db, transaction: work => db.transaction(observe(work)),
        transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(observe(work), check) } };
    },
  });
  const runtime = await bootstrap.start({ ...startup.config, coordinator: { ...startup.config.coordinator,
    quality: { ...x.config, scenarios: [x.scenario] }, revisionPlanning: true } });
  t.after(() => runtime.close());
  assert.equal(runtime.isReady(), true); assert.ok(runtime.quality); assert.ok(runtime.revisions);
  assert.deepEqual(opened, ["web_test", "coordinator_test"]);
  assert.deepEqual(preflights, [
    { current_user: "web_test", session_user: "web_test", rolsuper: false },
    { current_user: "coordinator_test", session_user: "coordinator_test", rolsuper: false },
  ]);

  const sourceBefore = await canonical.get(x.scope.tenantId, "job", x.source.jobId);
  const childBefore = await x.childStates();
  const counters = x.counters();
  const evidence = targetId => startup.coordinator.client.query(
    "SELECT kind,id FROM control_completion_gate_records WHERE tenant_id=$1 AND parent_id=$2 ORDER BY kind,id",
    [x.scope.tenantId, targetId]);
  const sourceEvidence = (await evidence(x.source.target.id)).rows;
  assert.ok(sourceEvidence.some(row => row.kind === "review"));
  assert.ok(sourceEvidence.some(row => row.kind === "verification"));
  assert.deepEqual((await evidence(x.child.target.id)).rows, []);

  const qualityRequest = { ...x.request, projectId: x.plan.projectId, jobId: x.child.jobId };
  const reconcile = () => runtime.quality.reconcile(qualityRequest, new AbortController().signal);
  const waiting = await reconcile();
  assert.equal(waiting.disposition, "waiting_review"); assert.equal(waiting.verification, "recorded");
  assert.equal(waiting.grantsApproval, false); assert.equal(waiting.grantsExecutionAuthority, false);
  assert.equal("completion" in waiting, false);
  const freshEvidence = (await evidence(x.child.target.id)).rows;
  assert.equal(freshEvidence.filter(row => row.kind === "verification").length, 1);
  assert.equal(freshEvidence.some(row => row.kind === "review"), false);
  assert.deepEqual((await evidence(x.source.target.id)).rows, sourceEvidence);
  assert.equal((await x.childStates()).job.state, "leased");
  assert.deepEqual(await canonical.get(x.scope.tenantId, "job", x.source.jobId), sourceBefore);

  const resultsPath = `/api/v1/projects/${x.plan.projectId}/tasks/${x.child.jobId}/results`;
  const pageResponse = await handler(request(resultsPath, "GET", undefined, undefined, x.jwt));
  assert.equal(pageResponse.status, 200, await pageResponse.clone().text());
  const page = await pageResponse.json();
  assert.equal(page.jobId, x.child.jobId); assert.deepEqual(page.items.map(item => item.artifactId), [x.child.artifactId]);
  const projected = page.reviews.find(item => item.targetId === x.child.target.id);
  assert.ok(projected); assert.equal(projected.revision, 1); assert.equal(projected.supersedesTargetId, x.source.target.id);
  assert.deepEqual(projected.matchingArtifactIds, [x.child.artifactId]);
  assert.equal(projected.verifications.length, 1); assert.equal(projected.reviews.length, 0);

  const reviewPath = `${resultsPath}/${x.child.artifactId}/reviews/${x.child.target.id}`;
  const draft = { artifactId: x.child.artifactId, targetId: x.child.target.id, targetDigest: x.child.targetDigest,
    contentHash: x.child.artifact.contentHash, decision: "accepted", feedback: "" };
  const options = await handler(request(reviewPath, "GET", undefined, undefined, x.jwt));
  assert.equal(options.status, 200, await options.clone().text());
  const offered = await options.json(); assert.equal(offered.jobId, x.child.jobId); assert.equal(offered.canReview, true);
  const reviewedResponse = await handler(request(reviewPath, "POST", draft, "compiled-revised-review-001", x.jwt));
  assert.equal(reviewedResponse.status, 201, await reviewedResponse.clone().text());
  const reviewed = await reviewedResponse.json();
  assert.equal(reviewed.receipt.jobId, x.child.jobId); assert.equal(reviewed.receipt.artifactId, x.child.artifactId);
  assert.equal(reviewed.receipt.targetId, x.child.target.id); assert.equal(reviewed.receipt.grantsApproval, false);
  assert.equal(reviewed.receipt.grantsExecutionAuthority, false); assert.equal(reviewed.receipt.startsRevision, false);
  const replayedReview = await handler(request(reviewPath, "POST", draft, "compiled-revised-review-001", x.jwt));
  assert.equal(replayedReview.status, 200, await replayedReview.clone().text());
  assert.deepEqual((await replayedReview.json()).receipt, reviewed.receipt);
  assert.deepEqual(await canonical.get(x.scope.tenantId, "job", x.source.jobId), sourceBefore);

  const completed = await reconcile();
  assert.equal(completed.disposition, "completed"); assert.equal(completed.verification, "replayed");
  assert.equal(completed.completion.replayed, false);
  assert.equal(completed.completion.receipt.jobId, x.child.jobId);
  assert.equal(completed.completion.receipt.runId, x.child.runId);
  assert.equal(completed.completion.receipt.artifactId, x.child.artifactId);
  assert.equal(completed.completion.receipt.grantsExecutionAuthority, false);
  const childAfter = await x.childStates();
  assert.equal(childAfter.job.state, "succeeded"); assert.equal(childAfter.attempt.state, "succeeded");
  assert.equal(childAfter.lease.state, "released"); assert.deepEqual(await canonical.get(x.scope.tenantId, "job", x.source.jobId), sourceBefore);
  const completionReplay = await reconcile();
  assert.equal(completionReplay.disposition, "completed"); assert.equal(completionReplay.completion.replayed, true);
  assert.deepEqual(completionReplay.completion.receipt, completed.completion.receipt);
  assert.deepEqual(x.counters(), counters);
  assert.notDeepEqual(childAfter, childBefore);

  await runtime.close(); assert.equal(runtime.isReady(), false);
  assert.equal(startup.web.closes(), 1); assert.equal(startup.coordinator.closes(), 1);
  await assert.rejects(reconcile());
  assert.equal((await handler(request(resultsPath, "GET", undefined, undefined, x.jwt))).status, 503);
  assert.deepEqual(x.counters(), counters);
});

test("compiled browser assets exclude revised-result lineage and submission internals", () => {
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  const javascript = files("dist-vps/client").filter(file => file.endsWith(".js"));
  assert.ok(javascript.length > 0);
  for (const file of javascript) assert.doesNotMatch(readFileSync(file, "utf8"),
    /NativeResultSubmissionService|nativeReviewPlanSchema|readNativeReviewPlan|verifyNativeReviewTarget|registerRevision|control-room\.native-review-plan\/v2/);
});
