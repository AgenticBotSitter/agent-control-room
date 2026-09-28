import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultText } from "../private-app/app/result-text";
import { TaskResultsPanel } from "../private-app/app/task-results";
import type { TaskResultsPage, TaskResultContent } from "../src/web/v1/task-result-wire";
import { createTaskReviewWorkspace } from "../src/web/v1/task-review-workspace";
import { createTaskVerificationWorkspace } from "../src/web/v1/task-verification-workspace";

test("formatted results show Markdown but never fetch images or interpret raw HTML", () => {
  const html = renderToStaticMarkup(<ResultText text={'# Heading\n\n**Bold**\n\n![remote](https://example.invalid/a.png)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[good](https://example.invalid)'} />);
  assert.ok(html.includes("<h1>Heading</h1>")); assert.ok(html.includes("<strong>Bold</strong>"));
  assert.ok(!html.includes("<img")); assert.ok(!html.includes("<script"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes("external link"));
  assert.ok(html.includes("(external)"));
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

test("result open mounts command readers only for the newest current matching target", () => {
  const contentHash = `sha256:${"a".repeat(64)}`, targetDigest = `sha256:${"b".repeat(64)}`;
  const artifact = { artifactId: "artifact:test", attemptId: "attempt:test", runId: "run:test", contentHash,
    sizeBytes: 12, receivedAt: "2026-09-08T12:00:00.000Z", byteCheck: "matched_recorded_claim" as const,
    qualityAccepted: false as const };
  const evidence = (targetId: string, revision: number, supersedesTargetId: string | null) => ({ targetId,
    kind: "document" as const, targetDigest, contentHash, revision, supersedesTargetId, status: "pending" as const,
    matchingArtifactIds: [artifact.artifactId], additionalEvidenceOmitted: false, reviews: [], verifications: [], findings: [],
    missingVerificationScenarioIds: [], openFindingCount: 0, grantsApproval: false as const, grantsExecutionAuthority: false as const });
  const page: TaskResultsPage = { projectId: "project:test", jobId: "job:test", observedAt: artifact.receivedAt,
    resultSource: "configured", reviewSource: "configured", items: [artifact],
    reviews: [evidence("target:stale", 0, null), evidence("target:current", 1, "target:stale")],
    additionalResultsOmitted: false, additionalTargetsOmitted: false, canReadContent: true,
    reviewCommands: "configured", verificationCommands: "configured" };
  const content: TaskResultContent = { projectId: page.projectId, jobId: page.jobId, artifact,
    text: "Current result", contentVerifiedAt: artifact.receivedAt, untrustedContent: true };
  const reviewTargets: string[] = [], verificationTargets: string[] = [];
  const reviewWorkspace = createTaskReviewWorkspace(), verificationWorkspace = createTaskVerificationWorkspace();
  const html = renderToStaticMarkup(<TaskResultsPanel page={page} content={content} pending={false}
    onOpen={() => {}} onClose={() => {}}
    reviewWorkspace={{ ...reviewWorkspace, get(binding) { reviewTargets.push(binding.targetId); return reviewWorkspace.get(binding); } }}
    verificationWorkspace={{ ...verificationWorkspace,
      get(binding) { verificationTargets.push(binding.targetId); return verificationWorkspace.get(binding); } }} />);
  assert.equal(html.match(/Loading owner review/g)?.length, 1);
  assert.equal(html.match(/Loading human verification/g)?.length, 1);
  assert.deepEqual(reviewTargets, ["target:current"]); assert.deepEqual(verificationTargets, ["target:current"]);
  assert.match(html, /Revision 0/); assert.match(html, /Revision 1/);
});

test("result open does not mount command readers for a superseded target whose successor is omitted", () => {
  const contentHash = `sha256:${"1".repeat(64)}`, targetDigest = `sha256:${"2".repeat(64)}`;
  const artifact = { artifactId: "artifact:superseded", attemptId: "attempt:test", runId: "run:test", contentHash,
    sizeBytes: 12, receivedAt: "2026-09-08T12:00:00.000Z", byteCheck: "matched_recorded_claim" as const,
    qualityAccepted: false as const };
  const review = { targetId: "target:superseded", kind: "document" as const, targetDigest, contentHash, revision: 0,
    supersedesTargetId: null, status: "superseded" as const, matchingArtifactIds: [artifact.artifactId],
    additionalEvidenceOmitted: false, reviews: [], verifications: [], findings: [], missingVerificationScenarioIds: [],
    openFindingCount: 0, grantsApproval: false as const, grantsExecutionAuthority: false as const };
  const page: TaskResultsPage = { projectId: "project:test", jobId: "job:test", observedAt: artifact.receivedAt,
    resultSource: "configured", reviewSource: "configured", items: [artifact], reviews: [review],
    additionalResultsOmitted: false, additionalTargetsOmitted: true, canReadContent: true,
    reviewCommands: "configured", verificationCommands: "configured" };
  const content: TaskResultContent = { projectId: page.projectId, jobId: page.jobId, artifact,
    text: "Historical result", contentVerifiedAt: artifact.receivedAt, untrustedContent: true };
  const reviewTargets: string[] = [], verificationTargets: string[] = [];
  const reviewWorkspace = createTaskReviewWorkspace(), verificationWorkspace = createTaskVerificationWorkspace();
  const html = renderToStaticMarkup(<TaskResultsPanel page={page} content={content} pending={false}
    onOpen={() => {}} onClose={() => {}}
    reviewWorkspace={{ ...reviewWorkspace, get(binding) { reviewTargets.push(binding.targetId); return reviewWorkspace.get(binding); } }}
    verificationWorkspace={{ ...verificationWorkspace,
      get(binding) { verificationTargets.push(binding.targetId); return verificationWorkspace.get(binding); } }} />);
  assert.deepEqual(reviewTargets, []); assert.deepEqual(verificationTargets, []);
  assert.doesNotMatch(html, /Loading owner review|Loading human verification/);
  assert.match(html, /Replaced by a newer revision/);
});

test("result open follows lineage even when the successor has different content", () => {
  const oldHash = `sha256:${"3".repeat(64)}`, newHash = `sha256:${"4".repeat(64)}`;
  const targetDigest = `sha256:${"5".repeat(64)}`;
  const artifact = { artifactId: "artifact:old-bytes", attemptId: "attempt:test", runId: "run:test", contentHash: oldHash,
    sizeBytes: 12, receivedAt: "2026-09-08T12:00:00.000Z", byteCheck: "matched_recorded_claim" as const,
    qualityAccepted: false as const };
  const evidence = (targetId: string, contentHash: string, revision: number, supersedesTargetId: string | null,
    matchingArtifactIds: string[]) => ({ targetId, kind: "document" as const, targetDigest, contentHash, revision,
    supersedesTargetId, status: "pending" as const, matchingArtifactIds, additionalEvidenceOmitted: false,
    reviews: [], verifications: [], findings: [], missingVerificationScenarioIds: [], openFindingCount: 0,
    grantsApproval: false as const, grantsExecutionAuthority: false as const });
  const page: TaskResultsPage = { projectId: "project:test", jobId: "job:test", observedAt: artifact.receivedAt,
    resultSource: "configured", reviewSource: "configured", items: [artifact], reviews: [
      evidence("target:old-bytes", oldHash, 0, null, [artifact.artifactId]),
      evidence("target:new-bytes", newHash, 1, "target:old-bytes", []),
    ], additionalResultsOmitted: false, additionalTargetsOmitted: false, canReadContent: true,
    reviewCommands: "configured", verificationCommands: "configured" };
  const content: TaskResultContent = { projectId: page.projectId, jobId: page.jobId, artifact,
    text: "Old result", contentVerifiedAt: artifact.receivedAt, untrustedContent: true };
  const reviewTargets: string[] = [], verificationTargets: string[] = [];
  const reviewWorkspace = createTaskReviewWorkspace(), verificationWorkspace = createTaskVerificationWorkspace();
  renderToStaticMarkup(<TaskResultsPanel page={page} content={content} pending={false}
    onOpen={() => {}} onClose={() => {}}
    reviewWorkspace={{ ...reviewWorkspace, get(binding) { reviewTargets.push(binding.targetId); return reviewWorkspace.get(binding); } }}
    verificationWorkspace={{ ...verificationWorkspace,
      get(binding) { verificationTargets.push(binding.targetId); return verificationWorkspace.get(binding); } }} />);
  assert.deepEqual(reviewTargets, []); assert.deepEqual(verificationTargets, []);
});

test("result open selects the highest revision when stale-first matching leaves are unlinked", () => {
  const contentHash = `sha256:${"d".repeat(64)}`, targetDigest = `sha256:${"e".repeat(64)}`;
  const artifact = { artifactId: "artifact:unlinked", attemptId: "attempt:test", runId: "run:test", contentHash,
    sizeBytes: 12, receivedAt: "2026-09-08T12:00:00.000Z", byteCheck: "matched_recorded_claim" as const,
    qualityAccepted: false as const };
  const evidence = (targetId: string, revision: number) => ({ targetId, kind: "document" as const, targetDigest,
    contentHash, revision, supersedesTargetId: null, status: "pending" as const, matchingArtifactIds: [artifact.artifactId],
    additionalEvidenceOmitted: false, reviews: [], verifications: [], findings: [], missingVerificationScenarioIds: [],
    openFindingCount: 0, grantsApproval: false as const, grantsExecutionAuthority: false as const });
  const page: TaskResultsPage = { projectId: "project:test", jobId: "job:test", observedAt: artifact.receivedAt,
    resultSource: "configured", reviewSource: "configured", items: [artifact],
    reviews: [evidence("target:stale-first", 0), evidence("target:newest-second", 2), evidence("target:equal-later", 2)],
    additionalResultsOmitted: false, additionalTargetsOmitted: false, canReadContent: true,
    reviewCommands: "configured", verificationCommands: "not_connected" };
  const content: TaskResultContent = { projectId: page.projectId, jobId: page.jobId, artifact,
    text: "Current result", contentVerifiedAt: artifact.receivedAt, untrustedContent: true };
  const targets: string[] = [], workspace = createTaskReviewWorkspace();
  renderToStaticMarkup(<TaskResultsPanel page={page} content={content} pending={false} onOpen={() => {}} onClose={() => {}}
    reviewWorkspace={{ ...workspace, get(binding) { targets.push(binding.targetId); return workspace.get(binding); } }} />);
  assert.deepEqual(targets, ["target:newest-second"]);
});

test("result open target selection excludes other kinds and hashes before comparing revisions", () => {
  const contentHash = `sha256:${"6".repeat(64)}`, otherHash = `sha256:${"7".repeat(64)}`;
  const targetDigest = `sha256:${"8".repeat(64)}`;
  const artifact = { artifactId: "artifact:filter-pin", attemptId: "attempt:test", runId: "run:test", contentHash,
    sizeBytes: 12, receivedAt: "2026-09-08T12:00:00.000Z", byteCheck: "matched_recorded_claim" as const,
    qualityAccepted: false as const };
  const evidence = (targetId: string, revision: number, kind: "document" | "code", hash: string) => ({ targetId,
    kind, targetDigest, contentHash: hash, revision, supersedesTargetId: null, status: "pending" as const,
    matchingArtifactIds: [artifact.artifactId], additionalEvidenceOmitted: false, reviews: [], verifications: [], findings: [],
    missingVerificationScenarioIds: [], openFindingCount: 0, grantsApproval: false as const, grantsExecutionAuthority: false as const });
  const page: TaskResultsPage = { projectId: "project:test", jobId: "job:test", observedAt: artifact.receivedAt,
    resultSource: "configured", reviewSource: "configured", items: [artifact], reviews: [
      evidence("target:matching-document", 1, "document", contentHash),
      evidence("target:wrong-hash", 2, "document", otherHash),
      evidence("target:wrong-kind", 3, "code", contentHash),
    ], additionalResultsOmitted: false, additionalTargetsOmitted: false, canReadContent: true,
    reviewCommands: "configured", verificationCommands: "not_connected" };
  const content: TaskResultContent = { projectId: page.projectId, jobId: page.jobId, artifact,
    text: "Filter pin", contentVerifiedAt: artifact.receivedAt, untrustedContent: true };
  const targets: string[] = [], workspace = createTaskReviewWorkspace();
  renderToStaticMarkup(<TaskResultsPanel page={page} content={content} pending={false} onOpen={() => {}} onClose={() => {}}
    reviewWorkspace={{ ...workspace, get(binding) { targets.push(binding.targetId); return workspace.get(binding); } }} />);
  assert.deepEqual(targets, ["target:matching-document"]);
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
