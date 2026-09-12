import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, now, trust, request, origin } from "./helpers/web-foundation";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { PostgresNewsSourceSettings } from "../src/project-adapters/abs-news/v1/source-settings";
import { createControlCenterCollection } from "../src/project-adapters/abs-news/v1/control-center-collection";
import { PostgresArticleDetails } from "../src/project-adapters/abs-news/v1/article-store";
import { WebNewsService } from "../src/web/v1/news-service";
import { WebTaskService } from "../src/web/v1/task-service";
import { createTaskHttpHandler } from "../src/web/v1/task-http";

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
  // Continue the real saved-service path, not a preconstructed draft fixture.
  const webScope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId };
  const news = new WebNewsService(f.client, webScope, { integrityKey: key }, () => now);
  const tasks = new WebTaskService(f.client, webScope, () => now);
  const selected = { storyId: reference.storyId, storyDigest: reference.storyDigest,
    action: "research_brief", goal: "Verify the claims and return a source-backed research report." };
  const draft = await news.prepare(identity, project.projectId, selected);
  assert.equal(draft.saved, false); assert.equal(draft.dispatch, "not_requested");
  assert.match(draft.draft.instructions, /VERIFICATION-FIRST RESEARCH/);
  assert.ok(draft.draft.instructions.includes(reference.storyDigest));
  assert.ok(draft.draft.instructions.includes("https://example.invalid/article"));
  assert.equal((await tasks.list(identity, project.projectId)).tasks.length, 0);
  await assert.rejects(news.prepare(identity, project.projectId, { ...selected, action: "setup_guide" }));
  await assert.rejects(news.prepare(identity, project.projectId, { ...selected, storyDigest: `sha256:${"0".repeat(64)}` }));
  const other = await f.service.create(identity, { title: "Other research project", summary: "Synthetic" }, "other-research-project");
  await assert.rejects(news.prepare(identity, other.project.projectId, selected));
  const handle = createTaskHttpHandler({ origin, trust, service: tasks, clock: () => now });
  const path = `/api/v1/projects/${encodeURIComponent(project.projectId)}/tasks`;
  const save = () => handle(request(path, "POST", draft.draft, "collected-research-save"));
  const saved = await save(); assert.equal(saved.status, 201, await saved.clone().text());
  const command = await saved.json(); assert.equal(command.receipt.startsWork, false);
  const replay = await save(); assert.equal(replay.status, 200);
  assert.deepEqual((await replay.json()).receipt, command.receipt);
  assert.equal((await handle(request(path, "POST", { ...draft.draft, title: "Changed draft" }, "collected-research-save"))).status, 409);
  const detail = await tasks.detail(identity, project.projectId, command.receipt.jobId);
  assert.equal(detail.instructions, draft.draft.instructions); assert.deepEqual(detail.attempts, []);
  assert.equal((await tasks.list(identity, project.projectId)).tasks.length, 1);
  assert.equal((await tasks.list(identity, other.project.projectId)).tasks.length, 0);
  assert.deepEqual(urls, [source.url, "https://example.invalid/article"]); // Preparing/saving never refetches.
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
