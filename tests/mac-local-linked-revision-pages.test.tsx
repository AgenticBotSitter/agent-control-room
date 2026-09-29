import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerRevisionPanel } from "../private-app/app/task-owner-revision";
import { TaskRevisionTaskLinks } from "../private-app/app/task-panels";

test("Mac-local request changes journey keeps source and revised task pages linked both ways", () => {
  const projectId = "project:linked", sourceJobId = "job:source", childJobId = "job:revision";
  const prepared = renderToStaticMarkup(createElement(OwnerRevisionPanel, {
    options: { projectId, jobId: sourceJobId, artifactId: "artifact:one", targetId: "target:one",
      targetDigest: `sha256:${"a".repeat(64)}`, contentHash: `sha256:${"b".repeat(64)}`, canReview: false,
      availability: "already_reviewed", ownReview: null, grantsExecutionAuthority: false, revisionPlanning: "configured" },
    request: { runId: "run:source", targetId: "target:source", targetDigest: `sha256:${"c".repeat(64)}`,
      contentHash: `sha256:${"d".repeat(64)}`, reviewId: "review:changes", feedback: "Clarify the result." },
    eligible: false, pending: false, held: false,
    receipt: { projectId, sourceJobId, jobId: childJobId, sourceInputDigest: `sha256:${"f".repeat(64)}`,
      inputDigest: `sha256:${"0".repeat(64)}`, plannedAt: "2026-09-27T00:00:00.000Z",
      startsWork: false, grantsExecutionAuthority: false, rootSubjectId: sourceJobId,
      rootTargetId: "target:root", fromRunId: "run:source", fromTargetId: "target:source",
      fromTargetDigest: `sha256:${"c".repeat(64)}`, fromContentHash: `sha256:${"d".repeat(64)}`,
      reviewId: "review:changes", feedbackDigest: `sha256:${"e".repeat(64)}`, revisionNumber: 1,
      executionAvailability: "requires_separate_assignment_and_approval" },
    onPrepare() {}, onCheck() {},
  }));
  assert.match(prepared, /\/projects\/project%3Alinked\/tasks\/job%3Arevision/);
  assert.match(prepared, /Open revised task/);

  const source = renderToStaticMarkup(createElement(TaskRevisionTaskLinks, { projectId,
    links: { previousJobId: null, nextJobId: childJobId, revisionNumber: 0 } }));
  const child = renderToStaticMarkup(createElement(TaskRevisionTaskLinks, { projectId,
    links: { previousJobId: sourceJobId, nextJobId: null, revisionNumber: 1 } }));
  assert.match(source, /Open revised task/); assert.match(source, /job%3Arevision/);
  assert.match(child, /Open previous task/); assert.match(child, /job%3Asource/);
  assert.match(child, /Each revision remains a separate task/);
});
