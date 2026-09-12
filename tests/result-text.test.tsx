import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultText } from "../private-app/app/result-text";
import { TaskResultsPanel, RevisionRequestedNotice, StaleResultNotice } from "../private-app/app/task-results";
import type { TaskResultsPage, TaskResultContent, TaskReviewEvidence } from "../src/web/v1/task-result-wire";

test("formatted results show Markdown but never fetch images or interpret raw HTML", () => {
  const html = renderToStaticMarkup(<ResultText text={'# Heading\n\n**Bold**\n\n![remote](https://example.invalid/a.png)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[good](https://example.invalid)'} />);
  assert.ok(html.includes("<h1>Heading</h1>")); assert.ok(html.includes("<strong>Bold</strong>"));
  assert.ok(!html.includes("<img")); assert.ok(!html.includes("<script"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes("Original plain text"));
});

test("actual results panel renders only currently authorized matching content", () => {
  const artifact = { artifactId: "artifact:test", attemptId: "attempt:test", runId: "run:test",
    contentHash: `sha256:${"a".repeat(64)}`, sizeBytes: 12, receivedAt: "2026-09-08T12:00:00.000Z",
    byteCheck: "matched_recorded_claim" as const, qualityAccepted: false as const };
  const page: TaskResultsPage = { projectId: "project:test", jobId: "job:test", observedAt: artifact.receivedAt,
    resultSource: "configured", reviewSource: "configured", items: [artifact], reviews: [],
    additionalResultsOmitted: false, additionalTargetsOmitted: false, canReadContent: true, reviewCommands: "not_connected" };
  const content: TaskResultContent = { projectId: page.projectId, jobId: page.jobId, artifact,
    text: "# Unique protected result", contentVerifiedAt: artifact.receivedAt, untrustedContent: true };
  const render = (p: TaskResultsPage, c = content) => renderToStaticMarkup(
    <TaskResultsPanel page={p} content={c} pending={false} onOpen={() => {}} onClose={() => {}} />);
  assert.ok(render(page).includes("<h1>Unique protected result</h1>"));
  assert.ok(render(page).includes("Opening it does not run tools or approve work."));
  for (const changed of [{ ...page, canReadContent: false }, { ...page, jobId: "job:other" }, { ...page, items: [] }])
    assert.ok(!render(changed).includes("Unique protected result"));
  assert.ok(!render(page, { ...content, artifact: { ...artifact, contentHash: `sha256:${"b".repeat(64)}` } }).includes("Unique protected result"));
});

test("oversized results retain full plain text without Markdown parsing", () => {
  const text = "x".repeat(32769);
  const html = renderToStaticMarkup(<ResultText text={text} />);
  assert.ok(html.includes(text)); assert.ok(html.includes("Large result shown as plain text."));
  assert.ok(!html.includes("Formatted agent result"));
});

test("GFM tables and code render while local and protocol-relative links remain inert", () => {
  const text = '| Name | State |\n| --- | --- |\n| Task | Saved |\n\n```sh\necho example\n```\n\n[local](file:///tmp/example) [relative](/api/delete) [network](//example.invalid)';
  const html = renderToStaticMarkup(<ResultText text={text} />);
  assert.ok(html.includes("<table>")); assert.ok(html.includes("<th>Name</th>"));
  assert.ok(html.includes('<code class="language-sh">echo example'));
  assert.ok(!html.includes('href="file:')); assert.ok(!html.includes('href="/'));
});

test("revision-requested notice renders only when open content matches a changes_requested review", () => {
  const baseHash = "sha256:" + "a".repeat(64);
  const artifact = { artifactId: "artifact:one", attemptId: "attempt:one", runId: "run:one",
    contentHash: baseHash, sizeBytes: 12, receivedAt: "2026-09-12T15:00:00.000Z",
    byteCheck: "matched_recorded_claim" as const, qualityAccepted: false as const };
  const review: TaskReviewEvidence = { targetId: "target:one", kind: "document", targetDigest: baseHash,
    contentHash: baseHash, revision: 2, supersedesTargetId: null, status: "changes_requested",
    matchingArtifactIds: ["artifact:one"], additionalEvidenceOmitted: false, reviews: [],
    verifications: [], findings: [], missingVerificationScenarioIds: [], openFindingCount: 0,
    grantsApproval: false, grantsExecutionAuthority: false };
  const page: TaskResultsPage = { projectId: "project:one", jobId: "job:one", observedAt: artifact.receivedAt,
    resultSource: "configured", reviewSource: "configured", items: [artifact], reviews: [review],
    additionalResultsOmitted: false, additionalTargetsOmitted: false, canReadContent: true,
    reviewCommands: "configured" };
  const content: TaskResultContent = { projectId: page.projectId, jobId: page.jobId, artifact,
    text: "Revision two body", contentVerifiedAt: artifact.receivedAt, untrustedContent: true };
  const notice = renderToStaticMarkup(<RevisionRequestedNotice review={review} />);
  assert.ok(notice.includes("Revision requested"));
  assert.ok(notice.includes("Revision 2"));
  const html = renderToStaticMarkup(
    <TaskResultsPanel page={page} content={content} pending={false} onOpen={() => {}} onClose={() => {}} />);
  assert.ok(html.includes("private-revision-requested"));
  // Mismatched artifact: same status, but the artifactId is not in matchingArtifactIds. Should NOT show.
  const foreignReview = { ...review, matchingArtifactIds: ["artifact:other"], contentHash: "sha256:" + "b".repeat(64) };
  const noMatchPage = { ...page, reviews: [foreignReview] };
  const noMatchHtml = renderToStaticMarkup(
    <TaskResultsPanel page={noMatchPage} content={content} pending={false} onOpen={() => {}} onClose={() => {}} />);
  assert.ok(!noMatchHtml.includes("private-revision-requested"));
});

test("stale-result notice renders only when content verifiedAt is older than page observedAt", () => {
  const artifact = { artifactId: "artifact:stale", attemptId: "attempt:stale", runId: "run:stale",
    contentHash: "sha256:" + "c".repeat(64), sizeBytes: 4, receivedAt: "2026-09-12T15:00:00.000Z",
    byteCheck: "matched_recorded_claim" as const, qualityAccepted: false as const };
  const page: TaskResultsPage = { projectId: "project:stale", jobId: "job:stale", observedAt: "2026-09-12T16:00:00.000Z",
    resultSource: "configured", reviewSource: "configured", items: [artifact], reviews: [],
    additionalResultsOmitted: false, additionalTargetsOmitted: false, canReadContent: true, reviewCommands: "not_connected" };
  const staleContent: TaskResultContent = { projectId: page.projectId, jobId: page.jobId, artifact,
    text: "stale", contentVerifiedAt: "2026-09-12T15:00:00.000Z", untrustedContent: true };
  const freshContent: TaskResultContent = { ...staleContent, contentVerifiedAt: "2026-09-12T16:30:00.000Z" };
  const notice = renderToStaticMarkup(<StaleResultNotice page={page} content={staleContent} />);
  assert.ok(notice.includes("private-result-stale"));
  assert.ok(notice.includes("stale"));
  const staleHtml = renderToStaticMarkup(
    <TaskResultsPanel page={page} content={staleContent} pending={false} onOpen={() => {}} onClose={() => {}} />);
  assert.ok(staleHtml.includes("private-result-stale"));
  const freshHtml = renderToStaticMarkup(
    <TaskResultsPanel page={page} content={freshContent} pending={false} onOpen={() => {}} onClose={() => {}} />);
  assert.ok(!freshHtml.includes("private-result-stale"));
});
