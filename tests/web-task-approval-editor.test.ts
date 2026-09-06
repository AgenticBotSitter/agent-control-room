import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalEditor, retainApprovalEditor, attachApprovalFile } from "../src/web/v1/task-approval-editor";
import { taskDetailSchema } from "../src/web/v1/task-wire";
import { taskApprovalReviewSchema, taskApprovalReadSchema } from "../src/web/v1/task-approval-wire";

const time = "2026-09-06T00:00:00.000Z", digest = `sha256:${"a".repeat(64)}`;
const detail = taskDetailSchema.parse({ project: { projectId: "project:test", title: "Test", summary: "", lifecycle: "active",
  version: 1, createdAt: time, updatedAt: time, origin: "ordinary", lifecycleEditable: true },
  task: { projectId: "project:test", jobId: "job:test", requestId: "request:test", title: "Task", state: "leased", version: 2, createdAt: time, updatedAt: time },
  instructions: "Test instructions", inputDigest: digest, observedAt: time,
  attempts: [{ attemptId: "attempt:test", attemptNumber: 1, state: "leased", runs: [], additionalRunsOmitted: false }],
  earlierAttemptsOmitted: false, progressSource: "configured", dispatch: "configured", artifacts: "configured", review: "recorded" });
const review = taskApprovalReviewSchema.parse({ projectId: "project:test", jobId: "job:test", inputDigest: digest,
  attemptId: "attempt:test", nodeId: "node:test", prompt: "Test instructions", instructions: "", model: "test", provider: "test",
  durationSeconds: 60, deadline: "2026-09-06T00:05:00.000Z", operationDigest: digest,
  signatureStatus: "unsigned", startsWork: false, grantsExecutionAuthority: false });
const state = taskApprovalReadSchema.parse({ projectId: review.projectId, jobId: review.jobId, inputDigest: digest, receipt: null });

test("matching fresh authorized observations preserve an unsigned review and local file", () => {
  const initial = createApprovalEditor(detail, review)!;
  const selected = attachApprovalFile(initial, initial, { name: "approval.json", text: "{}" })!;
  const refreshed = { ...detail, observedAt: "2026-09-06T00:00:30.000Z" };
  assert.equal(retainApprovalEditor(selected, refreshed, state), selected);
  assert.equal(selected.file?.text, "{}"); assert.equal(initial.file, undefined);
  assert.equal(selected.review.startsWork, false); assert.equal(selected.review.grantsExecutionAuthority, false);
});

test("changed task, attempt, project, expiry or saved receipt discards editing continuity", () => {
  const editor = createApprovalEditor(detail, review)!;
  for (const changed of [
    { ...detail, inputDigest: `sha256:${"b".repeat(64)}` },
    { ...detail, task: { ...detail.task, version: 3 } },
    { ...detail, project: { ...detail.project, version: 2 } },
    { ...detail, project: { ...detail.project, lifecycle: "archived" as const } },
    { ...detail, attempts: [{ ...detail.attempts[0], attemptId: "attempt:other" }] },
    { ...detail, attempts: [{ ...detail.attempts[0], state: "running" as const }] },
    { ...detail, observedAt: review.deadline }, { ...detail, observedAt: "invalid" },
  ]) assert.equal(retainApprovalEditor(editor, changed, state), undefined);
  const saved = { ...state, receipt: { projectId: review.projectId, jobId: review.jobId, attemptId: review.attemptId,
    packetDigest: digest, operationDigest: digest, acceptedAt: time, evidence: "stored_signatures_only" as const,
    startsWork: false as const, grantsExecutionAuthority: false as const } };
  assert.equal(retainApprovalEditor(editor, detail, saved), undefined);
  assert.equal(retainApprovalEditor(editor, detail, { ...state, projectId: "project:other" }), undefined);
});

test("late file reads cannot restore a cleared or replaced editor and remain byte bounded", () => {
  const editor = createApprovalEditor(detail, review)!;
  assert.equal(attachApprovalFile(undefined, editor, { name: "test", text: "{}" }), undefined);
  assert.equal(attachApprovalFile(editor, { ...editor, binding: "old-binding" }, { name: "test", text: "{}" }), editor);
  const replacement = createApprovalEditor(detail, review)!;
  assert.equal(replacement.binding, editor.binding);
  assert.equal(attachApprovalFile(replacement, editor, { name: "stale", text: "{}" }), replacement);
  assert.throws(() => attachApprovalFile(editor, editor, { name: "test", text: "é".repeat(12_289) }), /too_large/);
  assert.equal(attachApprovalFile(editor, editor, { name: "x".repeat(200), text: "{}" })?.file?.name.length, 180);
});
