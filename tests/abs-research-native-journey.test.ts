import assert from "node:assert/strict";
import test from "node:test";
import { nativeQualityCompletionFixture, qualityText } from "./helpers/native-quality-completion";
import { origin, request, token } from "./helpers/web-foundation";
import { binding, instant } from "./hermes-native-fixture";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { createControlCenterCollection } from "../src/project-adapters/abs-news/v1/control-center-collection";
import { PostgresNewsSourceSettings } from "../src/project-adapters/abs-news/v1/source-settings";
import { newsPageSchema, newsResearchPreviewSchema } from "../src/web/v1/news-wire";
import { taskReceiptSchema } from "../src/web/v1/task-wire";
import { sha256Digest } from "../src/security";
import { createTaskHttpHandler } from "../src/web/v1/task-http";

test("borrowed discovery becomes the exact ordinary task executed, returned, reviewed and completed", async t => {
  // In-process application integration only: no sockets, providers or pg-boss
  // workers. The existing acceptance profile verifies document structure, not
  // the truth or quality of the synthetic research conclusions.
  const article = "https://example.org/news/model", text = `${qualityText}Source: ${article}\n`;
  let storyDigest = "", sourceJobId = "";
  const reads: string[] = [];
  const jwt = token({ iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const req = (path: string, method = "GET", body?: unknown) => request(path, method, body, "research-journey-save-001", jwt);
  const x = await nativeQualityCompletionFixture(text, async f => {
    const scope = { ...f.scope, projectId: binding.projectId }, key = new Uint8Array(32).fill(47);
    const source = { id: "source:research-journey", name: "Synthetic AI news", url: "https://example.org/news", enabled: true };
    await new PostgresNewsSourceSettings(f.db, scope, key).save(source, 0, new Date(instant + 6000).toISOString());
    const collection = createControlCenterCollection(f.db, { ...scope, sourceId: source.id, expectedRevision: 1,
      limits: { timeoutMs: 10000, maxAttempts: 8, maxDocumentBytes: 4096, maxReservedBodyBytes: 32768 } }, key,
    { assertCurrent(url) { assert.equal(new URL(url).origin, "https://example.org"); } }, {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch: async url => {
        reads.push(url.toString());
        return new Response(url.toString() === source.url
          ? '<html><head><link rel="alternate" type="application/rss+xml" href="https://example.org/feed.xml"></head></html>'
          : `<rss><channel><item><title>AI model release</title><link>${article}</link><pubDate>${new Date(instant).toUTCString()}</pubDate></item></channel></rss>`);
      },
    }, () => instant + 6000);
    try { await collection.collect(new AbortController().signal); }
    finally { await collection.close(); }
    assert.deepEqual(reads.slice(0, 2), [source.url, "https://example.org/feed.xml"]);
    const app = createPrivateWebProcess({ origin, issuer: f.accessTrust.issuer, audience: f.accessTrust.audience,
      maxSessionSeconds: f.accessTrust.maxSessionSeconds, loadKeys: async () => f.accessTrust.keys,
      ...f.scope, database: { client: f.db, close: async () => {} }, news: { integrityKey: key }, clock: () => instant + 6000 });
    try {
      const base = `/api/v1/projects/${encodeURIComponent(binding.projectId)}`;
      const pageResponse = await app.handle(req(`${base}/news`), () => new Response("shell"));
      assert.equal(pageResponse.status, 200);
      const page = newsPageSchema.parse(await pageResponse.json());
      assert.equal(page.stories.length, 1); const story = page.stories[0];
      assert.equal(story.canonicalUrl, article); assert.equal(story.verificationState, "review_only"); storyDigest = story.storyDigest;
      const previewResponse = await app.handle(req(`${base}/news/prepare`, "POST", {
        storyId: story.storyId, storyDigest, action: "research_brief", goal: "Verify the source claims and produce a report." }), () => new Response("shell"));
      assert.equal(previewResponse.status, 200); const preview = newsResearchPreviewSchema.parse(await previewResponse.json());
      assert.equal(preview.saved, false); assert.equal(preview.dispatch, "not_requested");
      assert.match(preview.draft.instructions, /VERIFICATION-FIRST RESEARCH/);
      assert.ok(preview.draft.instructions.includes(article)); assert.ok(preview.draft.instructions.includes(storyDigest));
      const savedResponse = await app.handle(req(`${base}/tasks`, "POST", preview.draft), () => new Response("shell"));
      assert.equal(savedResponse.status, 201); const saved = await savedResponse.json();
      const receipt = taskReceiptSchema.parse(saved.receipt); sourceJobId = receipt.jobId;
      assert.equal(receipt.startsWork, false);
      const replay = await app.handle(req(`${base}/tasks`, "POST", preview.draft), () => new Response("shell"));
      assert.equal(replay.status, 200); assert.deepEqual((await replay.json()).receipt, receipt);
      assert.equal((await f.tasks.detail(f.identity, binding.projectId, sourceJobId)).attempts.length, 0);
      return { draft: preview.draft, source: { receipt, replayed: false } };
    } finally { await app.close(); }
  });
  t.after(x.close);
  assert.equal(x.f.assignmentFixture.source.receipt.jobId, sourceJobId);
  const planned = (await x.f.db.query<{ plan: { sourceJobId: string; sourceInputDigest: string; input: { prompt: string; instructions: string } } }>(
    "SELECT plan FROM control_task_execution_plans WHERE tenant_id=$1 AND job_id=$2", [x.registration.tenantId, x.registration.jobId])).rows[0].plan;
  assert.equal(planned.sourceJobId, sourceJobId);
  assert.equal(planned.sourceInputDigest, sha256Digest(x.f.assignmentFixture.sourceDraft));
  assert.equal(planned.input.prompt, x.f.assignmentFixture.sourceDraft.instructions);
  assert.equal(x.f.assignmentFixture.prepared.receipt.inputDigest, sha256Digest(planned.input));
  assert.ok(x.f.assignmentFixture.sourceDraft.instructions.includes(storyDigest));
  assert.equal(x.registration.jobId, x.f.assignmentFixture.prepared.receipt.jobId);
  assert.notEqual(x.registration.jobId, sourceJobId);
  const taskHttp = createTaskHttpHandler({ origin, trust: x.f.accessTrust, service: x.f.tasks, clock: x.f.clock });
  const resultPath = `/api/v1/projects/${encodeURIComponent(x.registration.projectId)}/tasks/${encodeURIComponent(x.registration.jobId)}/results/${encodeURIComponent(x.artifact.artifactId)}`;
  const denied = req(resultPath); denied.headers.delete("cf-access-jwt-assertion");
  assert.equal((await taskHttp(denied)).status, 401);
  const resultResponse = await taskHttp(req(resultPath)); assert.equal(resultResponse.status, 200);
  const content = await resultResponse.json(); assert.equal(content.text, text); assert.equal(content.untrustedContent, true);
  assert.equal(x.artifact.qualityAccepted, false);
  await assert.rejects(x.complete());
  await x.verify(); const review = await x.review();
  assert.equal(review.receipt.grantsExecutionAuthority, false);
  const complete = await x.complete();
  assert.equal((await x.states()).job.state, "succeeded");
  assert.deepEqual((await x.complete()).receipt, complete.receipt);
  assert.deepEqual((await x.review()).receipt, review.receipt);
  assert.deepEqual((await x.results.ingest(x.completed.raw, new TextEncoder().encode(text), x.options())).receipt, x.artifact);
  assert.equal((await x.f.reviewStore.snapshot(x.registration.tenantId, x.target.id)).acceptedReviewIds.length, 1);
  assert.equal(x.local.effects.countFull(), 1);
});
