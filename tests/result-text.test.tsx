import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultText } from "../private-app/app/result-text";
import { TaskResultsPanel } from "../private-app/app/task-results";
import type { TaskResultsPage, TaskResultContent } from "../src/web/v1/task-result-wire";
import { createTaskReviewWorkspace } from "../src/web/v1/task-review-workspace";
import { createTaskVerificationWorkspace } from "../src/web/v1/task-verification-workspace";
import { TaskWhatChanged } from "../private-app/app/task-what-changed";
import { projectTaskChangeViewV1, TASK_CHANGE_DIFF_LINE_LIMIT_V1 } from "../src/web/v1/task-change-diff";

const changeEvidence = (patch: Partial<NonNullable<TaskResultContent["worktreeChangeEvidence"]>> = {}): NonNullable<TaskResultContent["worktreeChangeEvidence"]> => ({
  schema: "control-room.worktree-change-audit-detail/v1", baseRevision: "1".repeat(40), headRevision: "2".repeat(40),
  changes: [{ path: "src/worker.ts", kind: "modified", bytes: 42, contentDigest: `sha256:${"3".repeat(64)}` }],
  commits: [], commitsTruncated: false,
  unifiedDiff: { text: "diff --git a/src/worker.ts b/src/worker.ts\n--- a/src/worker.ts\n+++ b/src/worker.ts\n@@ -1 +1,2 @@\n-old\n+new\n+next", originalBytes: 121,
    retainedBytes: 121, truncated: false, contentDigest: `sha256:${"4".repeat(64)}`, retainedDigest: `sha256:${"5".repeat(64)}` },
  confinement: { kind: "workspace_write", outsideWorktree: "refused", evidenceDigest: `sha256:${"6".repeat(64)}` },
  evidenceDigest: `sha256:${"7".repeat(64)}`, ...patch,
});

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

test("the exact open result renders its protected bounded diff evidence", () => {
  const artifact = { artifactId: "artifact:test", attemptId: "attempt:test", runId: "run:test",
    contentHash: `sha256:${"a".repeat(64)}`, sizeBytes: 12, receivedAt: "2026-09-08T12:00:00.000Z",
    byteCheck: "matched_recorded_claim" as const, qualityAccepted: false as const };
  const page: TaskResultsPage = { projectId: "project:test", jobId: "job:test", observedAt: artifact.receivedAt,
    resultSource: "configured", reviewSource: "configured", items: [artifact], reviews: [],
    additionalResultsOmitted: false, additionalTargetsOmitted: false, canReadContent: true, reviewCommands: "not_connected" };
  const marker = "[CONTROL ROOM: unified diff truncated; original 70000 bytes; sha256:full]";
  const content: TaskResultContent = { projectId: page.projectId, jobId: page.jobId, artifact, text: "Done",
    contentVerifiedAt: artifact.receivedAt, untrustedContent: true, worktreeChangeEvidence: {
      schema: "control-room.worktree-change-audit-detail/v1", baseRevision: "1".repeat(40), headRevision: "2".repeat(40),
      changes: [{ path: "src/worker.ts", kind: "modified", bytes: 42, contentDigest: `sha256:${"3".repeat(64)}` }],
      commits: [{ revision: "2".repeat(40), subject: "Build isolated worker" }], commitsTruncated: false,
      unifiedDiff: { text: `diff --git a/src/worker.ts b/src/worker.ts\n${marker}`, originalBytes: 70_000,
        retainedBytes: 100, truncated: true, contentDigest: `sha256:${"4".repeat(64)}`, retainedDigest: `sha256:${"5".repeat(64)}` },
      confinement: { kind: "workspace_write", outsideWorktree: "refused", evidenceDigest: `sha256:${"6".repeat(64)}` },
      evidenceDigest: `sha256:${"7".repeat(64)}`,
    } };
  const html = renderToStaticMarkup(<TaskResultsPanel page={page} content={content} pending={false}
    onOpen={() => {}} onClose={() => {}} />);
  assert.match(html, /Verified code changes/); assert.match(html, /What changed/); assert.match(html, /src\/worker.ts/);
  assert.match(html, /Build isolated worker/); assert.match(html, /saved diff is truncated/);
  assert.match(html, /refused writes outside/); assert.match(html, /does not run, approve, merge, retry or resume/);
});

test("what changed renders evidence-derived per-file summaries and both readable diff layouts", () => {
  const evidence = changeEvidence();
  const unified = renderToStaticMarkup(<TaskWhatChanged evidence={evidence} />);
  assert.match(unified, /What changed/); assert.match(unified, /Modified with 2 lines added and 1 removed/);
  assert.match(unified, /Unified diff for src\/worker.ts/); assert.match(unified, /is-added/);
  assert.match(unified, /aria-pressed="true">Unified/); assert.match(unified, /Side by side/);
  const split = renderToStaticMarkup(<TaskWhatChanged evidence={evidence} initialMode="split" />);
  assert.match(split, /Side-by-side diff for src\/worker.ts/); assert.match(split, /Before/); assert.match(split, /After/);
  assert.match(split, /aria-pressed="true">Side by side/);
});

test("what changed escapes hostile file names and hostile diff content instead of rendering HTML", () => {
  const path = '<img src=x onerror="alert(1)">.tsx';
  const evidence = changeEvidence({ changes: [{ path, kind: "added", bytes: 60, contentDigest: `sha256:${"8".repeat(64)}` }],
    unifiedDiff: { ...changeEvidence().unifiedDiff,
      text: `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+<script>globalThis.pwned=true</script>` } });
  const html = renderToStaticMarkup(<TaskWhatChanged evidence={evidence} />);
  assert.doesNotMatch(html, /<img|<script>/u);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;\.tsx/u);
  assert.match(html, /&lt;script&gt;globalThis\.pwned=true&lt;\/script&gt;/u);
});

test("what changed collapses big files but leaves small files open", () => {
  const small = renderToStaticMarkup(<TaskWhatChanged evidence={changeEvidence()} />);
  assert.match(small, /<details open="">/u);
  const big = renderToStaticMarkup(<TaskWhatChanged evidence={changeEvidence({
    changes: [{ path: "src/worker.ts", kind: "modified", bytes: 16_385, contentDigest: `sha256:${"3".repeat(64)}` }],
  })} />);
  assert.match(big, /<details>/u); assert.doesNotMatch(big, /<details open/u);
});

test("what changed has a truthful empty state and marks every sensitive path family", () => {
  const empty = renderToStaticMarkup(<TaskWhatChanged evidence={changeEvidence({ changes: [],
    unifiedDiff: { ...changeEvidence().unifiedDiff, text: "", originalBytes: 0, retainedBytes: 0 } })} />);
  assert.match(empty, /0 files/); assert.match(empty, /No changed files were recorded for this result/);
  const paths = ["db/schema.sql", "db/migrations/0141_change.sql", "src/security/guard.ts", ".github/workflows/ci.yml"];
  const marked = renderToStaticMarkup(<TaskWhatChanged evidence={changeEvidence({
    changes: paths.map((path, index) => ({ path, kind: "modified" as const, bytes: 1,
      contentDigest: `sha256:${String(index + 1).repeat(64)}` })),
    unifiedDiff: { ...changeEvidence().unifiedDiff, text: "" },
  })} />);
  for (const marker of ["Database", "Migration", "Security", "GitHub automation"]) assert.match(marked, new RegExp(marker));
});

test("what changed admits files only from the verified inventory and bounds rendered diff lines", () => {
  const unrecorded = "security/forged.ts", recorded = "src/worker.ts";
  const manyLines = Array.from({ length: TASK_CHANGE_DIFF_LINE_LIMIT_V1 + 25 }, (_, index) => `+line ${index}`).join("\n");
  const evidence = changeEvidence({ unifiedDiff: { ...changeEvidence().unifiedDiff,
    text: `diff --git a/${unrecorded} b/${unrecorded}\n--- a/${unrecorded}\n+++ b/${unrecorded}\n@@ -0,0 +1 @@\n+forged\n`+
      `diff --git a/${recorded} b/${recorded}\n--- a/${recorded}\n+++ b/${recorded}\n@@ -0,0 +1,2025 @@\n${manyLines}` } });
  const view = projectTaskChangeViewV1(evidence);
  assert.deepEqual(view.files.map(file => file.path), [recorded]);
  assert.doesNotMatch(view.files[0]!.unifiedLines.map(line => line.text).join("\n"), /forged/u);
  assert.equal(view.files[0]?.unifiedLines.length, TASK_CHANGE_DIFF_LINE_LIMIT_V1);
  assert.equal(view.files[0]?.displayTruncated, true); assert.equal(view.displayTruncated, true);
});

test("what changed stays truthful for missing and half-written retained diff blocks", () => {
  const evidence = changeEvidence({ unifiedDiff: { ...changeEvidence().unifiedDiff,
    text: "diff --git a/src/worker.ts b/src/worker.ts\n--- a/src/worker.ts\n+++ b/src/worker.ts\n@@ -1 +1 @@\n-old\n+" } });
  const before = JSON.stringify(evidence), first = projectTaskChangeViewV1(evidence), retry = projectTaskChangeViewV1(evidence);
  assert.deepEqual(retry, first); assert.equal(JSON.stringify(evidence), before);
  assert.equal(first.files[0]?.diffRetained, true); assert.equal(first.files[0]?.addedLines, 1);
  const missing = projectTaskChangeViewV1(changeEvidence({ unifiedDiff: { ...changeEvidence().unifiedDiff,
    text: "diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts" } }));
  assert.equal(missing.files[0]?.diffRetained, false);
  assert.match(missing.files[0]?.summary ?? "", /detailed lines are not present/u);
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
