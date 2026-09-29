import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, now, trust, request, origin } from "./helpers/web-foundation";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { PostgresNewsSourceSettings } from "../src/project-adapters/news/v1/source-settings";
import { createControlCenterCollection } from "../src/project-adapters/news/v1/control-center-collection";
import { PostgresArticleDetails } from "../src/project-adapters/news/v1/article-store";
import { decodeNewsFeed, NewsFeedDecodeError } from "../src/project-adapters/news/v1/feed-decoder";
import { NewsFeedIngestionService } from "../src/project-adapters/news/v1/feed-ingestion";
import { PostgresNewsStoreV1 } from "../src/project-adapters/news/v1/postgres-store";
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
  assert.equal((await f.client.query<{ count: string }>("SELECT count(*)::text AS count FROM control_news_article_details")).rows[0].count, "1");
});

const feedSource = (projectId: string) => ({
  tenantId: "tenant:web", workspaceId: "workspace:web", projectId,
  source: { sourceId: "source:feed-fixture", sourceLabel: "Fixture feed", sourceKind: "rss" as const,
    endpointUrl: "https://example.invalid/feed" },
  maxBytes: 1_048_576, maxItems: 100,
});
const feedXml = `<rss version="2.0"><channel><title>Fixture feed</title><link>https://example.invalid/</link>` +
  `<description>Fixture</description>` +
  `<item><title>First synthetic story</title><link>https://example.invalid/article-one</link>` +
  `<description>First story summary</description><pubDate>${new Date(now - 3600000).toUTCString()}</pubDate></item>` +
  `<item><title>Second synthetic story</title><link>https://example.invalid/article-two</link>` +
  `<description>Second story summary</description><pubDate>${new Date(now - 7200000).toUTCString()}</pubDate></item>` +
  `</channel></rss>`;

test("feed decoder returns populated story records for a well-formed RSS feed", async () => {
  const decoded = await decodeNewsFeed({ ...feedSource("project:feed-decode"),
    observedAt: new Date(now).toISOString(), xml: feedXml });
  assert.equal(decoded.stories.length, 2);
  assert.equal(decoded.state, "available");
  assert.equal(decoded.rejectedCount, 0);
  assert.equal(decoded.duplicateCount, 0);
  const byUrl = new Map(decoded.stories.map(story => [story.canonicalUrl, story]));
  const first = byUrl.get("https://example.invalid/article-one");
  const second = byUrl.get("https://example.invalid/article-two");
  assert.ok(first); assert.ok(second);
  assert.equal(first.title, "First synthetic story");
  assert.equal(first.summary, "First story summary");
  assert.equal(second.title, "Second synthetic story");
  assert.equal(second.summary, "Second story summary");
});

test("feed ingestion persists decoded stories readable from the news store", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(request(), now);
  const { project } = await f.service.create(identity, { title: "Feed ingest fixture", summary: "Synthetic" }, "feed-ingest-fixture-key");
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: project.projectId };
  const key = new Uint8Array(32).fill(6);
  const observedAt = new Date(now).toISOString();
  const expected = await decodeNewsFeed({ ...feedSource(project.projectId), observedAt, xml: feedXml });
  assert.equal(expected.stories.length, 2);
  const service = new NewsFeedIngestionService(f.client, feedSource(project.projectId), key);
  const result = await service.ingest(feedXml, observedAt);
  assert.equal(result.inserted, 2);
  const store = new PostgresNewsStoreV1(f.client, scope, key);
  for (const story of expected.stories) {
    const stored = await store.getStory(story.storyId);
    assert.ok(stored, `expected story ${story.storyId} to be persisted`);
    assert.equal(stored.title, story.title);
    assert.equal(stored.summary, story.summary);
    assert.equal(stored.canonicalUrl, story.canonicalUrl);
  }
});

test("feed decoder rejects XML larger than maxBytes before parsing", async () => {
  await assert.rejects(
    decodeNewsFeed({ ...feedSource("project:feed-limit"), observedAt: new Date(now).toISOString(),
      xml: feedXml, maxBytes: 16 }),
    (error: unknown) => {
      assert.ok(error instanceof NewsFeedDecodeError);
      assert.equal(error.code, "feed_limit_exceeded");
      return true;
    });
});

test("feed ingestion records a source-health failure instead of throwing on invalid XML", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(request(), now);
  const { project } = await f.service.create(identity, { title: "Feed failure fixture", summary: "Synthetic" }, "feed-failure-fixture-key");
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: project.projectId };
  const key = new Uint8Array(32).fill(6);
  const observedAt = new Date(now).toISOString();
  const config = feedSource(project.projectId);
  await assert.rejects(
    decodeNewsFeed({ ...config, observedAt, xml: "<rss><channel><unclosed>" }),
    (error: unknown) => {
      assert.ok(error instanceof NewsFeedDecodeError);
      assert.equal(error.code, "invalid_feed");
      return true;
    });
  const service = new NewsFeedIngestionService(f.client, config, key);
  await service.ingest("<rss><channel><unclosed>", observedAt); // records the failure; must not throw
  const status = await new PostgresNewsStoreV1(f.client, scope, key).getSourceStatus("source:feed-fixture");
  assert.ok(status);
  assert.equal(status.state, "unavailable");
  assert.equal(status.safeStatusCode, "invalid_feed");
});

test("recordReadFailure rejects a check older than the last recorded observation", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(request(), now);
  const { project } = await f.service.create(identity, { title: "Feed staleness fixture", summary: "Synthetic" }, "feed-staleness-fixture-key");
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: project.projectId };
  const key = new Uint8Array(32).fill(6);
  const service = new NewsFeedIngestionService(f.client, feedSource(project.projectId), key);
  const newer = new Date(now).toISOString();
  const older = new Date(now - 3600000).toISOString();
  await service.recordReadFailure({ checkedAt: newer, reason: "read_failed" });
  await assert.rejects(service.recordReadFailure({ checkedAt: older, reason: "read_timed_out" }), /news_observation_stale/);
  const status = await new PostgresNewsStoreV1(f.client, scope, key).getSourceStatus("source:feed-fixture");
  assert.equal(status?.checkedAt, newer);
});
