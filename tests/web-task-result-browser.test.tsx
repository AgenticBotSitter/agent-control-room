import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskResultsPanel, PrivateTaskResults } from "../private-app/app/task-results";
import { createTaskReviewWorkspace } from "../src/web/v1/task-review-workspace";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";
import { createTaskHttpHandler } from "../src/web/v1/task-http";
import { boundedTaskResultsPage, taskResultContentSchema, taskResultsPageSchema } from "../src/web/v1/task-result-wire";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { request, origin } from "./helpers/web-foundation";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { sha256Digest } from "../src/security";
import { resultBytesHash } from "../src/artifacts/v1/native-results";

test("browser reads exact bytes through the real authenticated handler; metadata refresh never fetches content or writes", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("A readable result <b>as text</b>.");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const handler = createTaskHttpHandler({ origin, trust: f.accessTrust, service: f.tasks, clock: () => instant + 6000 });
  const calls: string[] = [];
  const client = createTaskBrowserClient(async (url, init) => {
    assert.equal(init?.method, "GET"); assert.equal(init?.cache, "no-store"); assert.equal(init?.redirect, "error");
    calls.push(String(url)); return handler(request(String(url), "GET", undefined, undefined, f.jwt));
  });
  await client.results(binding.projectId, binding.jobId); await client.results(binding.projectId, binding.jobId);
  assert.equal(calls.every(path => path.endsWith("/results")), true);
  const content = await client.resultContent(binding.projectId, binding.jobId, receipt.artifactId);
  assert.equal(content.text, "A readable result <b>as text</b>."); assert.equal(calls.length, 3);
});

test("browser rejects changed result bytes, wrong scope and invalid matching-review claims", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Exact result");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const content = taskResultContentSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId, receipt.artifactId));
  for (const changed of [{ ...content, text: "Altered result" }, { ...content, jobId: "job:other" },
    { ...content, artifact: { ...content.artifact, artifactId: "artifact:other" } }]) {
    const client = createTaskBrowserClient(async () => Response.json(changed));
    await assert.rejects(client.resultContent(binding.projectId, binding.jobId, receipt.artifactId), { code: "unavailable" });
  }
  await f.reviewTarget(sha256Digest("different bytes"));
  const page = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  page.reviews[0].matchingArtifactIds = [receipt.artifactId];
  await assert.rejects(createTaskBrowserClient(async () => Response.json(page)).results(binding.projectId, binding.jobId), { code: "unavailable" });
});

test("result panel displays escaped selectable content and truthful independent review boundaries", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("A document <b>not rendered HTML</b>.");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  await f.reviewTarget(sha256Digest("different result"));
  const page = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  const content = taskResultContentSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId, receipt.artifactId));
  const html = renderToStaticMarkup(createElement(TaskResultsPanel, { page, content, pending: false, onOpen() {}, onClose() {} }));
  assert.match(html, /Read result/); assert.match(html, /readOnly=""/); assert.match(html, /&lt;b&gt;not rendered HTML&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>not rendered HTML<\/b>|memory:\/\/|node:test|<button[^>]*>Accept/);
  assert.match(html, /does not match any result file/); assert.match(html, /Owner review commands are not connected/);
  assert.match(html, /Assignment and approval remain separate/);
  assert.doesNotMatch(html, /<button[^>]*>Prepare revised task/);
  assert.match(html, /not instructions for Control Room/);
});

test("empty, unconfigured and pending results stay separate and server shell contains no records or action callbacks", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const page = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  const render = (value = page) => renderToStaticMarkup(createElement(TaskResultsPanel, { page: value, pending: true, onOpen() {}, onClose() {} }));
  assert.match(render(), /No result files have been received/);
  assert.match(render({ ...page, resultSource: "not_configured", reviewSource: "not_configured" }), /Result storage is not configured/);
  const input = f.complete(""); const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const next = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  const content = taskResultContentSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId, receipt.artifactId));
  const html = renderToStaticMarkup(createElement(TaskResultsPanel, { page: next, content, pending: true, onOpen() {}, onClose() {} }));
  assert.match(html, /empty result file \(0 bytes\)/); assert.match(html, /button[^>]*disabled/);
  const shell = renderToStaticMarkup(createElement(PrivateTaskResults, { projectId: binding.projectId, jobId: binding.jobId,
    reviewWorkspace: createTaskReviewWorkspace() }));
  assert.match(shell, /Loading protected results and review/); assert.doesNotMatch(shell, /<button|artifact:native|Native task results/);
});

test("each recorded review identifies whether it matches the particular open file, not merely another listed file", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Result A");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  await f.reviewTarget(receipt.contentHash);
  const page = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  const a = taskResultContentSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId, receipt.artifactId));
  // A second valid presentation fixture: no native call or invented canonical execution.
  const b = { ...a, text: "Result B", artifact: { ...a.artifact, artifactId: "artifact:result:b", runId: "run:result:b",
    contentHash: resultBytesHash(new TextEncoder().encode("Result B")) } };
  page.items.push(b.artifact); page.reviews[0].status = "ready";
  const render = (content?: typeof a) => renderToStaticMarkup(createElement(TaskResultsPanel,
    { page, content, pending: false, onOpen() {}, onClose() {} }));
  const mismatch = render(b);
  assert.match(mismatch, /Quality review complete/); assert.match(mismatch, /matches 1 listed result/);
  assert.match(mismatch, /does not match the open result file/);
  assert.match(mismatch, /Open file ID: <code>artifact:result:b/);
  assert.ok(mismatch.includes(`Open file fingerprint: <code>${b.artifact.contentHash}`));
  assert.match(render(a), /matches the open result file’s ID and fingerprint/);
  assert.doesNotMatch(render(a), /does not match the open result file/);
  assert.match(render(), /No result file is open/);
  assert.doesNotMatch(render(), /matches the open result file’s ID/);
  assert.match(render({ ...a, artifact: { ...a.artifact, contentHash: b.artifact.contentHash } }), /does not match the open result file/);
});

test("maximum-width valid review projections stay within the shared reader capacity without changing retained quality evidence", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); await f.reviewTarget(sha256Digest("Result"));
  const page = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  const wideId = (prefix: string, index: number) => `${prefix}:${index}:`.padEnd(180, "x");
  const template = page.reviews[0];
  page.reviews = Array.from({ length: 20 }, (_, index) => ({ ...template, targetId: wideId("target", index),
    status: "changes_requested", openFindingCount: 100, additionalEvidenceOmitted: true,
    reviews: Array.from({ length: 50 }, (_, n) => ({ id: wideId("review", n), decision: "changes_requested", authority: "completion_gate", reviewedAt: at() })),
    verifications: Array.from({ length: 50 }, (_, n) => ({ id: wideId("verification", n), scenarioId: wideId("scenario", n), outcome: "inconclusive", verifiedAt: at() })),
    findings: Array.from({ length: 100 }, (_, n) => ({ id: wideId("finding", n), code: wideId("code", n), severity: "critical", statementDigest: template.contentHash, raisedAt: at() })),
  }));
  taskResultsPageSchema.parse(page);
  assert.ok(new TextEncoder().encode(JSON.stringify(page)).byteLength > 1_048_576);
  const bounded = boundedTaskResultsPage(page);
  assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= 524_288);
  assert.ok(bounded.reviews.length > 0 && bounded.reviews.length < 20);
  assert.equal(bounded.additionalTargetsOmitted, true);
  assert.deepEqual(bounded.reviews, page.reviews.slice(0, bounded.reviews.length));
  assert.equal(page.reviews.length, 20); // Does not mutate its input or the canonical history.
  const client = createTaskBrowserClient(async () => Response.json(bounded));
  assert.deepEqual(await client.results(binding.projectId, binding.jobId), bounded);
  assert.deepEqual(boundedTaskResultsPage(bounded), bounded);
  const html = renderToStaticMarkup(createElement(TaskResultsPanel, { page: bounded, pending: false, onOpen() {}, onClose() {} }));
  assert.ok(html.includes(`Only the ${bounded.reviews.length} most recent review targets`));
  assert.match(html, /Additional history remains saved/);
});

test("saved revision lineage reaches the protected result page without treating historical findings as current work", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const input = f.complete("Original document");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const { profile, target } = await f.reviewTarget(receipt.contentHash);
  const base = { schemaVersion: "control-room-completion-gate/v1", tenantId: binding.tenantId,
    projectId: binding.projectId, targetId: target.id, targetDigest: sha256Digest(target) };
  await f.reviewStore.recordReview({ ...base, id: "review:revision-history", authority: "completion_gate",
    decision: "changes_requested", acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile),
    reviewer: { actorId: "identity:test", actorType: "human" }, assessedRisk: "low", effectiveRisk: "low",
    evidenceDigests: [receipt.contentHash], findingIds: ["finding:revision-history"], reviewedAt: at(3000),
    grantsApproval: false, grantsExecutionAuthority: false }, [{ ...base, id: "finding:revision-history",
    reviewId: "review:revision-history", code: "document:missing-section", severity: "low",
    statementDigest: sha256Digest("Add the missing section"), evidenceDigests: [receipt.contentHash], raisedAt: at(3000) }]);
  // Real generic revision storage; no new native run or delivered replacement file is fabricated.
  const next = { ...target, id: "target:result:1", revisionNumber: 1, supersedesTargetId: target.id,
    subjectDigest: resultBytesHash(new TextEncoder().encode("Revised document")), submittedAt: at(4000) };
  await f.reviewStore.recordRevision({ schemaVersion: base.schemaVersion, id: "revision:result:1", tenantId: binding.tenantId,
    projectId: binding.projectId, rootTargetId: target.rootTargetId, fromTargetId: target.id,
    fromTargetDigest: sha256Digest(target), toTargetId: next.id, toTargetDigest: sha256Digest(next), revisionNumber: 1,
    resolvedFindingIds: ["finding:revision-history"], revisedBy: next.producer, revisedAt: next.submittedAt,
    grantsApproval: false, grantsExecutionAuthority: false }, next);
  const checkpoint = f.checkpoints.read(`completion-gate:${binding.tenantId}`);
  const handler = createTaskHttpHandler({ origin, trust: f.accessTrust, service: f.tasks, clock: () => instant + 6000 });
  const client = createTaskBrowserClient(async (url, init) => {
    assert.equal(init?.method, "GET");
    return handler(request(String(url), "GET", undefined, undefined, f.jwt));
  });
  const page = await client.results(binding.projectId, binding.jobId);
  const old = page.reviews.find(value => value.targetId === target.id)!;
  const revised = page.reviews.find(value => value.targetId === next.id)!;
  assert.equal(old.status, "superseded"); assert.equal(old.openFindingCount, 1);
  assert.deepEqual(old.matchingArtifactIds, [receipt.artifactId]);
  assert.equal(revised.status, "pending"); assert.equal(revised.supersedesTargetId, target.id);
  assert.deepEqual(revised.reviews, []); assert.deepEqual(revised.verifications, []);
  assert.deepEqual(revised.matchingArtifactIds, []);
  const before = structuredClone(page);
  const render = (value = page) => renderToStaticMarkup(createElement(TaskResultsPanel,
    { page: value, pending: false, onOpen() {}, onClose() {} }));
  const html = render();
  assert.match(html, /Matches Revision 0 · Replaced by a newer revision/);
  assert.doesNotMatch(html, /Matches Revision 1|Agent result 1|Quality review complete/);
  assert.match(html, /Revision 1 · Review in progress/);
  assert.match(html, /This earlier revision had 1 finding/);
  assert.doesNotMatch(html, /1 finding\(s\) require resolution/);
  assert.match(html, /Checks not recorded on this earlier revision/);
  assert.match(html, /Replaces Revision 0\./); assert.match(html, /Replaced by Revision 1\./);
  assert.match(html, /does not match any result file/);
  assert.match(html, /Assignment and approval remain separate/);
  assert.doesNotMatch(html, /<button[^>]*>Prepare revised task/);
  assert.doesNotMatch(html, /<button[^>]*>(?:Start|Submit|Request) revision/);
  const missingPrior = render({ ...page, reviews: [revised], additionalTargetsOmitted: true });
  assert.match(missingPrior, /earlier revision outside this displayed history/);
  assert.doesNotMatch(missingPrior, /Replaces Revision 0/);
  const missingNext = render({ ...page, reviews: [old], additionalTargetsOmitted: true });
  assert.match(missingNext, /replacement revision is outside this displayed history/);
  assert.doesNotMatch(missingNext, /Replaced by Revision 1\./);
  // Presentation-only permutations: unrelated display order must never create revision lineage.
  const unrelated = { ...revised, targetId: "target:unrelated", revision: 7, supersedesTargetId: null };
  const reordered = render({ ...page, reviews: [old, unrelated, revised] });
  assert.match(reordered, /Replaces Revision 0\./); assert.match(reordered, /Replaced by Revision 1\./);
  assert.doesNotMatch(reordered, /Replaces Revision 7\.|Replaced by Revision 7\./);
  assert.match(reordered, /These findings are historical, not current instructions/);
  // A matching fingerprint alone does not put an unassociated file in this review.
  const sameBytes = { ...page.items[0], artifactId: "artifact:unassociated", runId: "run:unassociated" };
  const twoFiles = render({ ...page, items: [...page.items, sameBytes] });
  const resultList = twoFiles.slice(twoFiles.indexOf('<ul class="private-result-list">')).split("</ul>")[0];
  const cards = resultList.split("<li>");
  assert.equal(cards.length, 3); assert.match(cards[1], /Matches Revision 0/);
  assert.match(cards[2], /artifact:unassociated/); assert.doesNotMatch(cards[2], /Matches Revision/);
  assert.deepEqual(page, before);
  assert.deepEqual(f.checkpoints.read(`completion-gate:${binding.tenantId}`), checkpoint);
  assert.equal((await f.tasks.detail(f.identity, binding.projectId, binding.jobId)).task.state, "leased");
});
