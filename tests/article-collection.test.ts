import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, now, trust, request } from "./helpers/web-foundation";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { PostgresNewsSourceSettings } from "../src/project-adapters/abs-news/v1/source-settings";
import { createControlCenterCollection } from "../src/project-adapters/abs-news/v1/control-center-collection";
import { PostgresArticleDetails } from "../src/project-adapters/abs-news/v1/article-store";

test("approved collection reuses bounded reader and saves articles only when opted in", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(request(), now);
  const { project } = await f.service.create(identity, { title: "Collection fixture", summary: "Synthetic" }, "collection-fixture-key");
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: project.projectId }, key = new Uint8Array(32).fill(6);
  const settings = new PostgresNewsSourceSettings(f.client, scope, key);
  const source = { id: "source:fixture", name: "Fixture", url: "https://example.invalid/feed", enabled: true };
  await settings.save(source, 0, new Date(now).toISOString());
  const urls: string[] = []; let disableDuringArticle = false;
  const html = `<article><h1>Synthetic article</h1><p>${"Useful synthetic article content for a research report. ".repeat(80)}</p></article>`;
  const ports = { lookup: async () => [{ address: "8.8.8.8", family: 4 as const }], fetch: async (url: URL) => {
    urls.push(url.href);
    if (url.pathname === "/feed") return new Response(`<rss version="2.0"><channel><title>Fixture</title><link>https://example.invalid/</link><description>Fixture</description><item><title>Synthetic article</title><link>https://example.invalid/article</link><description>Synthetic article summary</description><pubDate>${new Date(now - 3600000).toUTCString()}</pubDate></item></channel></rss>`, { headers: { "content-type": "application/rss+xml" } });
    if (disableDuringArticle) await settings.save({ ...source, enabled: false }, 1, new Date(now + 1).toISOString());
    return new Response(disableDuringArticle ? `${html}<p>Changed fixture bytes</p>` : html, { headers: { "content-type": "text/html" } });
  } };
  const make = (maxArticles?: number, maxAttempts = 4) => createControlCenterCollection(f.client, { ...scope, sourceId: source.id, expectedRevision: 1,
    limits: { maxAttempts, timeoutMs: 10000, maxDocumentBytes: 524288, maxReservedBodyBytes: 1048576, ...(maxArticles ? { maxArticles } : {}) } }, key,
  { assertCurrent: url => { assert.equal(new URL(url).hostname, "example.invalid"); return undefined; } }, ports, () => now);
  const legacy = make(); let reference;
  try { const result = await legacy.collect(new AbortController().signal); reference = result.receipt.stories[0]; assert.ok(reference); }
  finally { await legacy.close(); }
  assert.deepEqual(urls, [source.url]);
  const store = new PostgresArticleDetails(f.client, scope, key);
  assert.equal(await store.get(reference.storyId, reference.storyDigest), undefined);
  urls.length = 0;
  const approved = make(1);
  try {
    const result = await approved.collect(new AbortController().signal);
    assert.ok("articleExtraction" in result);
    assert.deepEqual(result.articleExtraction, { attempted: 1, saved: 1, unavailable: 0, skipped: 0 });
  } finally { await approved.close(); }
  assert.deepEqual(urls, [source.url, "https://example.invalid/article"]);
  assert.match((await store.get(reference.storyId, reference.storyDigest))!.text, /Useful synthetic article/);
  urls.length = 0;
  const exhausted = make(1, 1);
  try { await assert.rejects(exhausted.collect(new AbortController().signal)); }
  finally { await exhausted.close(); }
  assert.deepEqual(urls, [source.url]);
  urls.length = 0; disableDuringArticle = true;
  const revoked = make(1);
  try { await assert.rejects(revoked.collect(new AbortController().signal), /news_configured_source_changed/); }
  finally { await revoked.close(); }
  assert.equal((await f.client.query<{ count: string }>("SELECT count(*)::text AS count FROM control_abs_article_details")).rows[0].count, "1");
});
