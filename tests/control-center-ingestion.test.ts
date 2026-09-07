import test from "node:test";
import assert from "node:assert/strict";
import { createIndustrySourceReader } from "../src/vendor/control-center/source-reader";
import { safeFetchText } from "../src/vendor/control-center/safe-fetch";
import { createControlCenterCollectionReader } from "../src/project-adapters/abs-news/v1/control-center-reader";
import { absNewsCanonicalUrlSchemaV1, absNewsDiscoveryEndpointSchemaV1 } from "../src/project-adapters/abs-news/v1/schemas";
import { PostgresNewsSourceSettings } from "../src/project-adapters/abs-news/v1/source-settings";
import { collectConfiguredControlCenterSource } from "../src/project-adapters/abs-news/v1/configured-collection";
import { createControlCenterCollection } from "../src/project-adapters/abs-news/v1/control-center-collection";
import { AbsControlCenterIngestion } from "../src/project-adapters/abs-news/v1/control-center-ingestion";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import { WebNewsService } from "../src/web/v1/news-service";
import { newsReadingView } from "../src/web/v1/news-reading-view";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import type { DatabaseClient } from "../src/persistence/database";

const source = { id: "source:borrowed", name: "Example", url: "https://example.org/feed" };
const observed = new Date(now).toISOString();

test("borrowed collection to archive to recollection to restore preserves evidence and review-only status", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const key = new Uint8Array(32).fill(38); let tick = now, title = "AI model announcement", calls = 0;
  await new PostgresNewsSourceSettings(f.client, scope, key).save({ ...source, enabled: true }, 0, observed);
  const create = () => createControlCenterCollection(f.client, { ...scope, sourceId: source.id, expectedRevision: 1,
    limits: { timeoutMs: 10_000, maxAttempts: 4, maxDocumentBytes: 4096, maxReservedBodyBytes: 16384 } }, key,
  { assertCurrent(url) { assert.equal(url, source.url); } }, {
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: async () => {
      calls++;
      return new Response(`<rss><channel><item><title>${title}</title><link>https://example.org/model</link><pubDate>${new Date(now - 1000).toUTCString()}</pubDate></item></channel></rss>`);
    },
  }, () => tick);
  const collect = async () => {
    const collection = create();
    try { return await collection.collect(new AbortController().signal); }
    finally { await collection.close(); }
  };
  const first = await collect(); assert.equal(first.inserted, 1);
  const news = () => new WebNewsService(f.client, { tenantId: scope.tenantId, workspaceId: scope.workspaceId }, { integrityKey: key }, () => tick);
  const history = await news().list(f.identity, scope.projectId, undefined, undefined, "history");
  const story = history.stories[0]; assert.equal(story.verificationState, "review_only");
  const original = await new PostgresAbsNewsStoreV1(f.client, scope, key).getStory(story.storyId, story.storyDigest);
  await news().archive(f.identity, scope.projectId, { storyId: story.storyId, archived: true, expectedRevision: 0 });
  tick += 1000; title = "AI model announcement updated";
  const second = await collect();
  const store = new PostgresAbsNewsStoreV1(f.client, scope, key);
  await store.verifyCollectionReceipt(first.receipt); await store.verifyCollectionReceipt(second.receipt);
  assert.deepEqual(await store.getStory(story.storyId, story.storyDigest), original);
  const archived = await news().list(f.identity, scope.projectId, undefined, undefined, "archive");
  assert.equal(archived.stories.length, 1); assert.equal(archived.stories[0].title, title);
  assert.equal(archived.stories[0].storyId, story.storyId);
  assert.notEqual(archived.stories[0].storyDigest, story.storyDigest);
  assert.equal(newsReadingView(archived.stories, "archive", "important", archived.observedAt).stories.length, 1);
  assert.equal((await news().list(f.identity, scope.projectId, undefined, undefined, "history")).stories.length, 0);
  await news().archive(f.identity, scope.projectId, { storyId: story.storyId, archived: false, expectedRevision: 1 });
  const restored = await news().list(f.identity, scope.projectId, undefined, undefined, "history");
  assert.equal(newsReadingView(restored.stories, "history", "important", restored.observedAt).stories.length, 1);
  assert.equal(restored.stories[0].verificationState, "review_only");
  assert.equal(restored.stories[0].storyDigest, archived.stories[0].storyDigest);
  assert.equal((await news().list(f.identity, scope.projectId, undefined, undefined, "archive")).stories.length, 0);
  assert.equal(calls, 2);
  assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 0);
});

test("borrowed collection lifecycle is inert, single-use and close cancels without publishing", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const key = new Uint8Array(32).fill(30);
  await new PostgresNewsSourceSettings(f.client, scope, key).save({ ...source, enabled: true }, 0, observed);
  const config = { ...scope, sourceId: source.id, expectedRevision: 1,
    limits: { timeoutMs: 10_000, maxAttempts: 4, maxDocumentBytes: 4096, maxReservedBodyBytes: 16384 } };
  let calls = 0;
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const ports = { lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
    fetch: async (_url: URL, _address: { address: string; family: number }, init: RequestInit) => {
      calls++; started();
      return new Promise<Response>((_resolve, reject) => {
        if (init.signal?.aborted) reject(new Error("aborted"));
        else init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    } };
  const create = () => createControlCenterCollection(f.client, config, key, { assertCurrent(url) { assert.equal(url, source.url); } }, ports, () => now);
  const unused = create();
  await unused.close(); await assert.rejects(unused.collect(new AbortController().signal));
  assert.equal(calls, 0);
  const collection = create(), result = collection.collect(new AbortController().signal);
  const rejected = assert.rejects(result);
  await reading;
  await assert.rejects(collection.collect(new AbortController().signal));
  const closing = collection.close(); assert.equal(collection.close(), closing);
  await closing; await rejected;
  assert.equal(calls, 1);
  assert.equal((await new PostgresAbsNewsStoreV1(f.client, scope, key).listStories()).stories.length, 0);
  assert.equal(await new AbsControlCenterIngestion(f.client, { ...scope, source }, key).loadBaseline(), undefined);
});

test("borrowed collection lifecycle returns the persisted receipt before successful close", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const key = new Uint8Array(32).fill(31);
  await new PostgresNewsSourceSettings(f.client, scope, key).save({ ...source, enabled: true }, 0, observed);
  const collection = createControlCenterCollection(f.client, { ...scope, sourceId: source.id, expectedRevision: 1,
    limits: { timeoutMs: 10_000, maxAttempts: 4, maxDocumentBytes: 4096, maxReservedBodyBytes: 16384 } }, key,
  { assertCurrent(url) { assert.equal(url, source.url); } }, {
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: async () => new Response(`<rss><channel><item><title>AI model</title><link>https://example.org/model</link><pubDate>${new Date(now - 1000).toUTCString()}</pubDate></item></channel></rss>`),
  }, () => now);
  const result = await collection.collect(new AbortController().signal);
  assert.equal(result.inserted, 1); await collection.close();
  assert.ok(await new PostgresAbsNewsStoreV1(f.client, scope, key).verifyCollectionReceipt(result.receipt));
  await assert.rejects(collection.collect(new AbortController().signal));
});

test("configured collection uses the saved source and refuses disabled or changed revisions", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const key = new Uint8Array(32).fill(29), settings = new PostgresNewsSourceSettings(f.client, scope, key);
  const value = { ...source, enabled: true };
  await settings.save(value, 0, observed);
  let calls = 0, disableDuringRead = true;
  const reader = createControlCenterCollectionReader({ timeoutMs: 10_000, maxAttempts: 4, maxDocumentBytes: 4096, maxReservedBodyBytes: 16384 }, {
    assertCurrent(url) { assert.equal(url, source.url); },
  }, new AbortController().signal, {
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: async () => {
      calls++;
      if (disableDuringRead) await settings.save({ ...value, enabled: false }, 1, observed);
      return new Response(`<rss><channel><item><title>AI model</title><link>https://example.org/model</link><pubDate>${new Date(now - 1000).toUTCString()}</pubDate></item></channel></rss>`);
    },
  }, () => now);
  const collect = (revision: number) => collectConfiguredControlCenterSource(f.client, scope, source.id, revision, key, reader, () => now);
  await assert.rejects(collect(2), /news_configured_source_changed/);
  assert.equal(calls, 0);
  await assert.rejects(collect(1), /news_configured_source_changed/);
  assert.equal(calls, 1);
  assert.equal((await settings.get(source.id))?.source.enabled, false);
  assert.equal((await new PostgresAbsNewsStoreV1(f.client, scope, key).listStories()).stories.length, 0);
  assert.equal(await new AbsControlCenterIngestion(f.client, { ...scope, source }, key).loadBaseline(), undefined);
  assert.equal((await f.client.query("SELECT * FROM control_abs_source_observations")).rows.length, 0);
  await assert.rejects(collect(2), /news_configured_source_changed/);
  assert.equal(calls, 1);
  disableDuringRead = false;
  await settings.save(value, 2, observed);
  assert.equal((await collect(3)).inserted, 1);
  assert.equal(calls, 2);
});

test("source settings persist upstream fields, disable without fetching, and reject lost updates", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId }, key = new Uint8Array(32).fill(28);
  const settings = new PostgresNewsSourceSettings(f.client, scope, key), value = { ...source, enabled: true };
  const first = await settings.save(value, 0, observed);
  assert.equal(first.startsWork, false); assert.equal(first.record.revision, 1);
  assert.equal((await settings.save(value, 0, observed)).replayed, true);
  await assert.rejects(settings.save({ ...value, name: "Other" }, 0, observed), /conflict/);
  const later = new Date(now + 1000).toISOString();
  const disabled = await settings.save({ ...value, enabled: false }, 1, later);
  assert.equal(disabled.record.revision, 2);
  const restarted = new PostgresNewsSourceSettings(f.client, scope, key);
  assert.deepEqual(await restarted.get(source.id), disabled.record);
  assert.deepEqual((await restarted.list()).sources, [disabled.record]);
  await assert.rejects(settings.save(value, 2, observed), /stale/);
  assert.equal(await new PostgresNewsSourceSettings(f.client, { ...scope, projectId: "project:other" }, key).get(source.id), undefined);
  await assert.rejects(new PostgresNewsSourceSettings(f.client, scope, new Uint8Array(32)).get(source.id), /integrity_failed/);
  for (const sql of ["UPDATE control_abs_source_settings SET payload=payload", "DELETE FROM control_abs_source_settings", "TRUNCATE control_abs_source_settings"])
    await assert.rejects(f.client.query(sql));
  assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 0);
  assert.equal((await f.client.query("SELECT * FROM control_abs_source_observations")).rows.length, 0);
  for (let i = 0; i < 50; i++) await settings.save({ ...value, id: `source:extra:${String(i).padStart(2, "0")}` }, 0, later);
  const firstPage = await restarted.list(); assert.equal(firstPage.sources.length, 50); assert.ok(firstPage.nextCursor);
  const lastPage = await restarted.list(firstPage.nextCursor!); assert.equal(lastPage.sources.length, 1); assert.equal(lastPage.nextCursor, null);
  assert.equal(new Set([...firstPage.sources, ...lastPage.sources].map(row => row.source.id)).size, 51);
});

test("query-bearing source and discovered feed pass the complete borrowed collection path without changing story identity", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const querySource = { ...source, url: "https://example.org/?section=ai" }, endpoint = "https://example.org/?feed=rss";
  const key = new Uint8Array(32).fill(27), checked: string[] = [];
  const reader = createControlCenterCollectionReader({ timeoutMs: 10_000, maxAttempts: 4, maxDocumentBytes: 4096, maxReservedBodyBytes: 16384 }, {
    assertCurrent(url) { checked.push(url); if (![querySource.url, endpoint].includes(url)) throw new Error("not_allowed"); },
  }, new AbortController().signal, {
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: async url => new Response(url.toString() === querySource.url
      ? '<html><head><link rel="alternate" type="application/rss+xml" href="/?feed=rss"></head></html>'
      : `<rss><channel><item><title>AI model</title><link>https://example.org/model</link><pubDate>${new Date(now - 1000).toUTCString()}</pubDate></item></channel></rss>`),
  }, () => now);
  const ingestion = new AbsControlCenterIngestion(f.client, { ...scope, source: querySource }, key);
  const result = await ingestion.collect(reader, reader.signal, () => now);
  assert.equal(result.inserted, 1); assert.ok(checked.includes(endpoint));
  const restarted = new AbsControlCenterIngestion(f.client, { ...scope, source: querySource }, key);
  assert.equal((await restarted.loadBaseline())?.endpoint, endpoint);
  assert.equal((await restarted.loadBaseline())?.sourceUrl, querySource.url);
  const story = (await new PostgresAbsNewsStoreV1(f.client, scope, key).listStories()).stories[0];
  assert.equal(story.canonicalUrl, "https://example.org/model"); assert.equal(story.verificationState, "review_only");
  assert.equal(absNewsCanonicalUrlSchemaV1.safeParse(endpoint).success, false);
  const changed = new AbsControlCenterIngestion(f.client, { ...scope, source: { ...querySource, url: "https://example.org/?section=other" } }, key);
  assert.equal(await changed.loadBaseline(), undefined);
  for (const url of ["http://example.org/?feed=rss", "https://user:password@example.org/?feed=rss", "https://127.0.0.1/?feed=rss", "https://example.org:8443/?feed=rss", "https://example.org/?feed=rss#fragment"])
    assert.equal(absNewsDiscoveryEndpointSchemaV1.safeParse(url).success, false, url);
});

test("collection composition loads restart memory automatically and abort cannot commit article or baseline changes", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const config = { ...scope, source }, key = new Uint8Array(32).fill(26);
  let tick = now, calls = 0;
  const pages = ["old"];
  const reader = createIndustrySourceReader({ now: () => tick, async readText(url) {
    calls++;
    return { finalUrl: url, text: `<rss><channel>${pages.map(page => `<item><title>${page}</title><link>https://example.org/${page}</link></item>`).join("")}</channel></rss>` };
  } });
  const first = new AbsControlCenterIngestion(f.client, config, key);
  assert.equal((await first.collect(reader, new AbortController().signal, () => tick)).inserted, 0);
  const restarted = new AbsControlCenterIngestion(f.client, config, key);
  const baseline = await restarted.loadBaseline();
  tick += 1000; pages.push("new");
  const abort = new AbortController();
  const interrupted: DatabaseClient = { ...f.client, query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(work, async () => { abort.abort(); await check(); }) };
  await assert.rejects(new AbsControlCenterIngestion(interrupted, config, key).collect(reader, abort.signal, () => tick));
  assert.deepEqual(await restarted.loadBaseline(), baseline);
  assert.equal((await new PostgresAbsNewsStoreV1(f.client, scope, key).listStories()).stories.length, 0);
  assert.equal((await restarted.collect(reader, new AbortController().signal, () => tick)).inserted, 1);
  const before = calls;
  await assert.rejects(restarted.collect(reader, AbortSignal.abort(), () => tick));
  assert.equal(calls, before);
  const saved = await restarted.loadBaseline();
  await assert.rejects(restarted.collect({ async readSource() { throw new Error("test_source_failure"); } }, new AbortController().signal), /test_source_failure/);
  assert.deepEqual(await restarted.loadBaseline(), saved);
});

test("a complete borrowed 250-story feed saves across batches with one verifiable receipt", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const key = new Uint8Array(32).fill(25), config = { ...scope, source };
  const reader = createIndustrySourceReader({ now: () => now, async readText(url) {
    return safeFetchText(url, {}, { lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch: async () => new Response(`<rss><channel>${Array.from({ length: 250 }, (_, i) =>
        `<item><title>AI model release ${i}</title><link>https://example.org/story-${i}</link><pubDate>${new Date(now - 1000).toUTCString()}</pubDate></item>`).join("")}</channel></rss>`) });
  } });
  const result = await reader.readSource(source); assert.equal(result.items.length, 250);
  let inserts = 0;
  const failing: DatabaseClient = { ...f.client, query: f.client.query.bind(f.client),
    transaction: work => f.client.transaction(tx => work({ async query<T>(sql: string, params?: unknown[]) {
      if (sql.includes("INSERT INTO control_abs_story_versions") && ++inserts === 101) throw new Error("test_second_batch_failure");
      return tx.query<T>(sql, params);
    } })), transactionWithPreCommitCheck: f.client.transactionWithPreCommitCheck.bind(f.client) };
  await assert.rejects(new AbsControlCenterIngestion(failing, config, key).ingest(result, observed), /test_second_batch_failure/);
  for (const table of ["control_abs_story_versions", "control_abs_source_observations", "control_abs_discovery_baselines"])
    assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 0);
  const ingestion = new AbsControlCenterIngestion(f.client, config, key);
  const saved = await ingestion.ingest(result, observed);
  assert.equal(saved.inserted, 250); assert.equal(saved.status.itemCount, 250);
  const store = new PostgresAbsNewsStoreV1(f.client, scope, key);
  assert.equal((await store.verifyCollectionReceipt(saved.receipt)).storyCount, 250);
  assert.equal((await ingestion.ingest(result, observed)).replayed, 250);
  let cursor: string | undefined, count = 0;
  do { const page = await store.listStories(cursor); count += page.stories.length; cursor = page.nextCursor ?? undefined; } while (cursor);
  assert.equal(count, 250);
  assert.deepEqual(await ingestion.loadBaseline(), result.snapshot);
});

test("borrowed undated baseline survives restart, conflicts roll back articles, and rejected items do not advance it", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const key = new Uint8Array(32).fill(23), config = { ...scope, source };
  let tick = now;
  const pages = ["old"];
  const reader = createIndustrySourceReader({ now: () => tick, async readText(url) {
    return { finalUrl: url, text: `<rss><channel>${pages.map(page => `<item><title>AI ${page}</title><link>https://example.org/${page}</link></item>`).join("")}</channel></rss>` };
  } });
  const first = new AbsControlCenterIngestion(f.client, config, key);
  const initial = await reader.readSource(source, await first.loadBaseline());
  assert.equal(initial.items.length, 0);
  await first.ingest(initial, observed);
  const restarted = new AbsControlCenterIngestion(f.client, config, key);
  const baseline = await restarted.loadBaseline(); assert.deepEqual(baseline, initial.snapshot);
  pages.push("new"); tick += 1000;
  const next = await reader.readSource(source, baseline);
  assert.equal(next.items.length, 1);
  assert.equal((await restarted.ingest(next, new Date(tick).toISOString(), baseline)).inserted, 1);
  assert.deepEqual(await restarted.loadBaseline(), next.snapshot);
  const store = new PostgresAbsNewsStoreV1(f.client, scope, key);
  pages.push("conflicting"); tick += 1000;
  const conflicting = await reader.readSource(source, baseline);
  await assert.rejects(restarted.ingest(conflicting, new Date(tick).toISOString(), baseline), /news_baseline_conflict/);
  assert.equal((await store.listStories()).stories.length, 1);
  assert.equal((await store.getSourceStatus(source.id))?.checkedAt, next.snapshot?.checkedAt);
  assert.deepEqual(await restarted.loadBaseline(), next.snapshot);
  const rejected = { ...conflicting, items: [{ ...conflicting.items[0], url: "http://127.0.0.1/private" }] };
  assert.equal((await restarted.ingest(rejected, new Date(tick).toISOString(), next.snapshot)).rejectedCount, 1);
  assert.deepEqual(await restarted.loadBaseline(), next.snapshot);
  const changed = new AbsControlCenterIngestion(f.client, { ...config, source: { ...source, url: "https://example.org/changed" } }, key);
  assert.equal(await changed.loadBaseline(), undefined);
  await assert.rejects(new AbsControlCenterIngestion(f.client, config, new Uint8Array(32).fill(24)).loadBaseline(), /integrity_failed/);
  for (const sql of ["UPDATE control_abs_discovery_baselines SET payload=payload", "DELETE FROM control_abs_discovery_baselines", "TRUNCATE control_abs_discovery_baselines"])
    await assert.rejects(f.client.query(sql));
});

test("borrowed reader results reach project news storage and remain review-only", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const key = new Uint8Array(32).fill(21);
  const reader = createIndustrySourceReader({ now: () => now, async readText(url) {
    return { text: `<rss><channel><title>Example</title><item><title>Model release</title><link>https://example.org/model</link><pubDate>${new Date(now - 1000).toUTCString()}</pubDate></item></channel></rss>`, finalUrl: url };
  } });
  const result = await reader.readSource(source);
  const changedSource = new AbsControlCenterIngestion(f.client, { ...scope, source: { ...source, url: "https://example.org/other" } }, key);
  await assert.rejects(changedSource.ingest(result, observed), /news_source_mismatch/);
  assert.equal((await new PostgresAbsNewsStoreV1(f.client, scope, key).listStories()).stories.length, 0);
  const ingest = new AbsControlCenterIngestion(f.client, { ...scope, source }, key);
  assert.equal((await ingest.ingest(result, observed)).inserted, 1);
  assert.equal((await ingest.ingest(result, observed)).replayed, 1);
  const store = new PostgresAbsNewsStoreV1(f.client, scope, key);
  const stories = (await store.listStories()).stories;
  assert.equal(stories.length, 1); assert.equal(stories[0].verificationState, "review_only");
  assert.ok(stories[0].priorityScore > 35);
  assert.equal((await store.getSourceStatus(source.id))?.safeStatusCode, "discovery_parsed");
  const service = new WebNewsService(f.client, { tenantId: scope.tenantId, workspaceId: scope.workspaceId }, { integrityKey: key }, () => now);
  assert.equal((await service.list(f.identity, scope.projectId)).stories.length, 1);
  const preview = await service.prepare(f.identity, scope.projectId, { storyId: stories[0].storyId,
    storyDigest: stories[0].storyDigest, action: "research_brief", goal: "Research this" });
  assert.ok(preview.draft.instructions.includes("VERIFICATION-FIRST RESEARCH"));
  assert.ok(preview.draft.instructions.includes(stories[0].storyDigest));
  for (const action of ["setup_guide", "product_comparison", "abs_article_draft"])
    await assert.rejects(service.prepare(f.identity, scope.projectId, { storyId: stories[0].storyId,
      storyDigest: stories[0].storyDigest, action, goal: "Research this" }));
  await assert.rejects(ingest.ingest({ ...result, snapshot: undefined }, new Date(now - 100).toISOString()), /news_observation_stale/);
  assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 0);
  const saved = await f.tasks.propose(f.identity, scope.projectId, preview.draft, "borrowed-verification-0001");
  assert.equal((await f.tasks.detail(f.identity, scope.projectId, saved.receipt.jobId)).task.state, "proposed");
  assert.equal((await f.client.query("SELECT * FROM control_attempts")).rows.length, 0);
});

test("partial sitemap discovery stores valid items without inventing publication dates", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const key = new Uint8Array(32).fill(22), ingest = new AbsControlCenterIngestion(f.client, { ...scope, source }, key);
  const result = { sourceUrl: source.url, coverageComplete: false, status: { sourceId: source.id, source: source.name,
    mode: "sitemap", endpoint: "https://example.org/sitemap.xml" }, items: [
    { title: "Research", summary: "A new page", url: "https://example.org/research", publishedAt: observed, discoveredAt: observed },
    { title: "Unsafe", summary: "Rejected", url: "http://127.0.0.1/private", publishedAt: "" },
  ] };
  const saved = await ingest.ingest(result, observed);
  assert.equal(saved.inserted, 1); assert.equal(saved.rejectedCount, 1);
  const store = new PostgresAbsNewsStoreV1(f.client, scope, key), story = (await store.listStories()).stories[0];
  assert.equal(story.publishedAt, undefined); assert.equal(story.discoveredAt, observed);
  assert.equal(story.sourceEvidence[0].sourceKind, "sitemap");
  assert.equal((await store.getSourceStatus(source.id))?.state, "partial");
  await assert.rejects(ingest.ingest({ ...result, status: { ...result.status, sourceId: "source:other" } }, observed), /source_mismatch/);
  assert.equal((await store.listStories()).stories.length, 1);
});
