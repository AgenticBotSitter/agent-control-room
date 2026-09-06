import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import type { NativeResultReceipt } from "../src/artifacts/v1/native-results";
import type { CompletionReviewTargetV1 } from "../src/completion-gate/v1";
import { nativeReviewPlanSchema, nativeReviewTarget, verifyNativeReviewTarget } from "../src/completion-gate/v1/native-review-plan";
import { sha256Digest } from "../src/security";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { taskResultsPageSchema, taskResultContentSchema } from "../src/web/v1/task-result-wire";
import { taskReviewCommandSchema, taskReviewOptionsSchema } from "../src/web/v1/task-review-wire";
import { taskVerificationCommandSchema, taskVerificationOptionsSchema } from "../src/web/v1/task-verification-wire";
import { nativeRevisedResultFixture } from "./helpers/native-revised-result";
import { origin, request } from "./helpers/web-foundation";

const digest = (value: string) => sha256Digest(value);
const at = (offset = 0) => new Date(1_800_000_000_000 + offset).toISOString();

test("an old native plan or missing lineage cannot associate a later same-hash same-producer revision", () => {
  const receipt: NativeResultReceipt = {
    schema: "control-room.native-result-receipt/v1", artifactId: "artifact:old", tenantId: "tenant:test",
    projectId: "project:test", jobId: "job:old", attemptId: "attempt:old", runId: "run:old",
    nodeId: "node:test", snapshotDigest: digest("old snapshot"), snapshotVersion: 1,
    contentHash: digest("coincidentally identical bytes"), sizeBytes: 30, manifestDigest: digest("old manifest"),
    receivedAt: at(), byteCheck: "matched_recorded_claim", qualityAccepted: false,
  };
  const plan = nativeReviewPlanSchema.parse({
    schema: "control-room.native-review-plan/v1", tenantId: receipt.tenantId, projectId: receipt.projectId,
    jobId: receipt.jobId, runId: receipt.runId, attemptId: receipt.attemptId, nodeId: receipt.nodeId,
    inputDigest: digest("old input"), authorityDigest: digest("old authority"), bindingDigest: digest("old binding"),
    targetId: "target:old", acceptanceProfileId: "profile:test", acceptanceProfileDigest: digest("profile"), plannedAt: at(),
  });
  const initial = nativeReviewTarget(plan, receipt);
  const later: CompletionReviewTargetV1 = { ...initial, id: "target:later", rootTargetId: initial.id,
    revisionNumber: 2, supersedesTargetId: "target:middle", submittedAt: at(2000) };

  // This isolates association refusal; it does not represent a real third native execution.
  assert.throws(() => verifyNativeReviewTarget(plan, later, receipt), /native_review_target_unavailable/);
  assert.throws(() => verifyNativeReviewTarget(undefined, later, receipt), /native_review_target_unavailable/);
  assert.doesNotThrow(() => verifyNativeReviewTarget(plan, initial, receipt));
});

test("the producing child route exposes authenticated shared history and records only fresh child evidence", async t => {
  const x = await nativeRevisedResultFixture();
  t.after(x.close);
  const scenario = { scenarioId: x.scenario.scenarioId, label: "Check the revised result",
    instructions: "Read the exact revised result and confirm that it contains the requested evidence.",
    acceptanceProfileId: x.scenario.acceptanceProfileId, acceptanceProfileDigest: x.scenario.acceptanceProfileDigest };
  await x.f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await x.f.raw.exec("SET ROLE control_room_private_web");
  const app = createPrivateWebProcess({ ...x.f.accessTrust, origin, tenantId: x.scope.tenantId,
    workspaceId: x.scope.workspaceId, loadKeys: async () => x.f.accessTrust.keys,
    tasks: { ...x.f.taskKeys, harnessIntegrityKey: x.f.harnessKey,
      ownerReviews: { integrityKey: x.f.reviewKey, checkpoints: x.f.checkpoints },
      manualVerificationScenarios: [scenario] }, database: { client: x.f.db, close: async () => {} }, clock: x.f.clock });
  t.after(() => app.close());
  const projectId = x.plan.projectId;
  const sourcePath = `/api/v1/projects/${projectId}/tasks/${x.source.jobId}/results`;
  const childPath = `/api/v1/projects/${projectId}/tasks/${x.child.jobId}/results`;
  const handle = (path: string, method = "GET", body?: unknown, key?: string) =>
    app.handle(request(path, method, body, key, x.jwt), () => new Response("shell"));

  const childResponse = await handle(childPath);
  assert.equal(childResponse.status, 200, await childResponse.clone().text());
  const childPage = taskResultsPageSchema.parse(await childResponse.json());
  assert.equal(childPage.jobId, x.child.jobId);
  assert.deepEqual(childPage.items.map(item => [item.artifactId, item.runId, item.attemptId]),
    [[x.child.artifactId, x.child.runId, x.child.attemptId]]);
  assert.equal(childPage.reviewCommands, "configured");
  assert.equal(childPage.verificationCommands, "configured");
  const oldFromChild = childPage.reviews.find(item => item.targetId === x.source.target.id);
  const revisedFromChild = childPage.reviews.find(item => item.targetId === x.child.target.id);
  assert.ok(oldFromChild); assert.ok(revisedFromChild);
  assert.equal(oldFromChild.status, "superseded"); assert.equal(oldFromChild.revision, 0);
  assert.deepEqual(oldFromChild.matchingArtifactIds, []);
  assert.ok(oldFromChild.reviews.some(review => review.decision === "changes_requested"));
  assert.ok(oldFromChild.verifications.some(verification => verification.outcome === "passed"));
  assert.equal(revisedFromChild.status, "pending"); assert.equal(revisedFromChild.revision, 1);
  assert.equal(revisedFromChild.supersedesTargetId, x.source.target.id);
  assert.deepEqual(revisedFromChild.matchingArtifactIds, [x.child.artifactId]);
  assert.deepEqual(revisedFromChild.reviews, []); assert.deepEqual(revisedFromChild.verifications, []);
  assert.equal(x.child.logicalSubjectId, x.source.target.subjectId);
  assert.equal(x.child.rootTargetId, x.source.target.rootTargetId);
  for (const hidden of ["control-room.native-review-plan/v2", "rootSubjectId", "auth_tag"])
    assert.equal(JSON.stringify(childPage).includes(hidden), false);

  const sourceResponse = await handle(sourcePath);
  assert.equal(sourceResponse.status, 200, await sourceResponse.clone().text());
  const sourcePage = taskResultsPageSchema.parse(await sourceResponse.json());
  assert.equal(sourcePage.jobId, x.source.jobId);
  assert.deepEqual(sourcePage.items.map(item => item.artifactId), [x.source.artifact.artifactId]);
  assert.deepEqual(sourcePage.reviews.map(item => item.targetId), childPage.reviews.map(item => item.targetId));
  assert.deepEqual(sourcePage.reviews.find(item => item.targetId === x.source.target.id)?.matchingArtifactIds,
    [x.source.artifact.artifactId]);
  assert.deepEqual(sourcePage.reviews.find(item => item.targetId === x.child.target.id)?.matchingArtifactIds, []);

  const contentResponse = await handle(`${childPath}/${x.child.artifactId}`);
  assert.equal(contentResponse.status, 200, await contentResponse.clone().text());
  const content = taskResultContentSchema.parse(await contentResponse.json());
  assert.equal(content.jobId, x.child.jobId); assert.equal(content.artifact.artifactId, x.child.artifactId);
  assert.equal(content.text, x.delivered.text); assert.equal(content.untrustedContent, true);
  assert.ok((await handle(`${sourcePath}/${x.child.artifactId}`)).status >= 400);
  assert.ok((await handle(`${childPath}/${x.source.artifact.artifactId}`)).status >= 400);

  const reviewPath = `${childPath}/${x.child.artifactId}/reviews/${x.child.target.id}`;
  const offeredReviewResponse = await handle(reviewPath);
  assert.equal(offeredReviewResponse.status, 200, await offeredReviewResponse.clone().text());
  const offeredReview = taskReviewOptionsSchema.parse(await offeredReviewResponse.json());
  assert.equal(offeredReview.jobId, x.child.jobId); assert.equal(offeredReview.artifactId, x.child.artifactId);
  assert.equal(offeredReview.targetId, x.child.target.id); assert.equal(offeredReview.canReview, true);
  const reviewDraft = { artifactId: x.child.artifactId, targetId: x.child.target.id, targetDigest: x.child.targetDigest,
    contentHash: x.child.artifact.contentHash, decision: "accepted" as const, feedback: "" };
  const reviewedResponse = await handle(reviewPath, "POST", reviewDraft, "revised-web-review-001");
  assert.equal(reviewedResponse.status, 201, await reviewedResponse.clone().text());
  const reviewed = taskReviewCommandSchema.parse(await reviewedResponse.json());
  assert.equal(reviewed.receipt.jobId, x.child.jobId); assert.equal(reviewed.receipt.artifactId, x.child.artifactId);
  assert.equal(reviewed.receipt.targetId, x.child.target.id); assert.equal(reviewed.receipt.startsRevision, false);
  assert.equal(reviewed.receipt.grantsApproval, false); assert.equal(reviewed.receipt.grantsExecutionAuthority, false);

  const verificationPath = `${childPath}/${x.child.artifactId}/verifications/${x.child.target.id}`;
  const offeredVerificationResponse = await handle(verificationPath);
  assert.equal(offeredVerificationResponse.status, 200, await offeredVerificationResponse.clone().text());
  const offeredVerification = taskVerificationOptionsSchema.parse(await offeredVerificationResponse.json());
  assert.equal(offeredVerification.jobId, x.child.jobId); assert.equal(offeredVerification.artifactId, x.child.artifactId);
  assert.equal(offeredVerification.scenarios.length, 1); assert.equal(offeredVerification.scenarios[0].availability, "available");
  const verificationDraft = { artifactId: x.child.artifactId, targetId: x.child.target.id, targetDigest: x.child.targetDigest,
    contentHash: x.child.artifact.contentHash, scenarioId: scenario.scenarioId, instructionsDigest: sha256Digest(scenario),
    outcome: "passed" as const, note: "I read the revised result and observed the requested supporting evidence." };
  const verifiedResponse = await handle(verificationPath, "POST", verificationDraft);
  assert.equal(verifiedResponse.status, 201, await verifiedResponse.clone().text());
  const verified = taskVerificationCommandSchema.parse(await verifiedResponse.json());
  assert.equal(verified.receipt.jobId, x.child.jobId); assert.equal(verified.receipt.artifactId, x.child.artifactId);
  assert.equal(verified.receipt.targetId, x.child.target.id); assert.equal(verified.receipt.completesJob, false);
  assert.equal(verified.receipt.grantsApproval, false); assert.equal(verified.receipt.grantsExecutionAuthority, false);

  for (const wrong of [
    `${sourcePath}/${x.child.artifactId}/reviews/${x.child.target.id}`,
    `${childPath}/${x.source.artifact.artifactId}/reviews/${x.source.target.id}`,
    `${sourcePath}/${x.child.artifactId}/verifications/${x.child.target.id}`,
    `${childPath}/${x.source.artifact.artifactId}/verifications/${x.source.target.id}`,
  ]) assert.ok((await handle(wrong)).status >= 400);

  assert.equal((await x.f.db.query("SELECT job_id FROM control_native_review_plans WHERE job_id=$1", [x.child.jobId])).rows.length, 1);
  await assert.rejects(x.f.db.query("SELECT job_id FROM control_task_execution_plans LIMIT 1"));
  for (const sql of [
    "INSERT INTO control_native_review_plans DEFAULT VALUES",
    "UPDATE control_native_review_plans SET auth_tag=auth_tag",
    "DELETE FROM control_native_review_plans",
  ]) await assert.rejects(x.f.db.query(sql));

  await x.f.raw.exec("RESET ROLE");
  const revisedSnapshot = await x.f.reviewStore.snapshot(x.scope.tenantId, x.child.target.id);
  const sourceSnapshot = await x.f.reviewStore.snapshot(x.scope.tenantId, x.source.target.id);
  assert.equal(revisedSnapshot.status, "ready"); assert.equal(sourceSnapshot.status, "superseded");
  assert.equal((await x.childStates()).job.state, "leased"); assert.equal((await x.sourceStates()).job.state, "leased");
  assert.equal((await x.f.db.query("SELECT id FROM control_completion_gate_records WHERE kind='revision'")).rows.length, 1);
});
