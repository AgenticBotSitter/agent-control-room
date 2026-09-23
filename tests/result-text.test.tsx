import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultText } from "../private-app/app/result-text";
import { TaskResultsPanel } from "../private-app/app/task-results";
import type { TaskResultsPage, TaskResultContent } from "../src/web/v1/task-result-wire";

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

test("coding-change evidence is aggregate-only and never mistaken for authority", () => {
  const page: TaskResultsPage = { projectId: "project:test", jobId: "job:test", observedAt: "2026-09-08T12:00:00.000Z",
    resultSource: "configured", reviewSource: "configured", reviews: [], additionalResultsOmitted: false,
    additionalTargetsOmitted: false, canReadContent: false, reviewCommands: "not_connected", items: [{
      artifactId: "artifact:test", attemptId: "attempt:test", runId: "run:test", contentHash: `sha256:${"a".repeat(64)}`,
      sizeBytes: 20, receivedAt: "2026-09-08T12:00:00.000Z", byteCheck: "matched_recorded_claim", qualityAccepted: false,
      worktreeChangeSummary: { source: "recorded", changedFiles: 2, changedBytes: 20, addedFiles: 1, modifiedFiles: 1, deletedFiles: 0,
        evidenceDigest: `sha256:${"b".repeat(64)}`, startsWork: false, grantsExecutionAuthority: false,
        permitsRetry: false, permitsResume: false, permitsApproval: false, permitsMerge: false } }] };
  const html = renderToStaticMarkup(<TaskResultsPanel page={page} pending={false} onOpen={() => {}} onClose={() => {}} />);
  assert.match(html, /Verified change summary: 2 files \/ 20 bytes/);
  assert.match(html, /does not start, retry, resume, approve or merge work/);
  for (const forbidden of ["src/secret.ts", "allowedPaths", "baseRevision", "resultReceiptDigest", "contentDigest"])
    assert.doesNotMatch(html, new RegExp(forbidden));
  const unavailable = renderToStaticMarkup(<TaskResultsPanel page={{ ...page, items: page.items.map(item => ({ ...item,
    worktreeChangeSummary: { source: "unavailable" as const } })) }}
    pending={false} onOpen={() => {}} onClose={() => {}} />);
  assert.match(unavailable, /does not mean no files changed/);
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
