import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAbsNewsStoryV1 } from "../src/project-adapters/abs-news/v1/story";
import { readNewsArticleDetail } from "../src/project-adapters/abs-news/v1/article-detail";

const digest = `sha256:${"a".repeat(64)}`;
function fixture(projectId = "project:article") {
  return buildAbsNewsStoryV1({ tenantId: "tenant:fixture", workspaceId: "workspace:fixture", projectId,
    storyId: "story:fixture", clusterId: "cluster:fixture", queue: "important_now", title: "Synthetic article",
    summary: "Synthetic fixture summary", canonicalUrl: "https://example.invalid/article", sourceLabel: "Fixture",
    discoveredAt: "2026-09-08T00:00:00.000Z", lastVerifiedAt: "2026-09-08T00:00:00.000Z", verificationState: "verified",
    priorityScore: 50, coverageCount: 1, contentDigest: digest, sourceEvidence: [{ evidenceId: "evidence:fixture",
      sourceId: "source:fixture", sourceKind: "manual", sourceLabel: "Fixture", canonicalUrl: "https://example.invalid/article",
      observedAt: "2026-09-08T00:00:00.000Z", evidenceDigest: digest, containsRawNewsletterBody: false, grantsNetworkAuthority: false }] });
}
const binding = (story: ReturnType<typeof fixture>) => ({ tenantId: story.tenantId, workspaceId: story.workspaceId,
  projectId: story.projectId, storyId: story.storyId, storyDigest: story.storyDigest });
const html = `<article><h1>Synthetic article</h1><p>${"Useful synthetic reading detail for a research report. ".repeat(60)}</p></article>`;
const body = (text = html) => ({ text, byteCount: Buffer.byteLength(text), contentType: "text/html", endpointUrl: "https://example.invalid/article" });

test("actual selected extractor binds repeat and changed bytes without changing story", async () => {
  const story = fixture(), original = structuredClone(story);
  let text = html;
  const ports = { getStory: async () => story, reader: { read: async () => body(text) }, authority: { assertCurrent: () => undefined } };
  const first = await readNewsArticleDetail(binding(story), ports, new AbortController().signal);
  assert.equal(first.status, "extracted");
  assert.deepEqual(await readNewsArticleDetail(binding(story), ports, new AbortController().signal), first);
  text = html.replace("research report", "different research report");
  const changed = await readNewsArticleDetail(binding(story), ports, new AbortController().signal);
  assert.equal(changed.status, "extracted");
  if (changed.status !== "extracted" || first.status !== "extracted") throw new Error("fixture extraction failed");
  assert.notEqual(changed.sourceHash, first.sourceHash); assert.notEqual(changed.detailDigest, first.detailDigest);
  assert.equal(changed.storyDigest, first.storyDigest); assert.deepEqual(story, original);
});

test("wrong project, stale story and revoked authority cannot produce an article", async () => {
  const story = fixture(); let reads = 0;
  const reader = { read: async () => { reads++; return body(); } };
  const authority = { assertCurrent: () => undefined };
  await assert.rejects(readNewsArticleDetail(binding(story), { getStory: async () => fixture("project:other"), reader, authority }, new AbortController().signal));
  assert.equal(reads, 0);
  let lookups = 0;
  await assert.rejects(readNewsArticleDetail(binding(story), { getStory: async () => ++lookups === 1 ? story : fixture("project:other"), reader, authority }, new AbortController().signal));
  assert.equal(reads, 1);
  let checks = 0;
  await assert.rejects(readNewsArticleDetail(binding(story), { getStory: async () => story, reader,
    authority: { assertCurrent: () => { if (++checks > 2) throw new Error("expired"); return undefined; } } }, new AbortController().signal));
});

test("mismatched reader provenance and cancelled reads are refused", async () => {
  const story = fixture(), authority = { assertCurrent: () => undefined };
  for (const invalid of [{ ...body(), endpointUrl: "https://example.invalid/other" }, { ...body(), byteCount: 1 }, { ...body(), contentType: "application/json" }])
    await assert.rejects(readNewsArticleDetail(binding(story), { getStory: async () => story, reader: { read: async () => invalid }, authority }, new AbortController().signal));
  const stop = new AbortController(); stop.abort();
  await assert.rejects(readNewsArticleDetail(binding(story), { getStory: async () => { throw new Error("must not read"); }, reader: { read: async () => body() }, authority }, stop.signal));
});
