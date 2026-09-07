import test from "node:test";
import assert from "node:assert/strict";
import { createIndustrySourceReader } from "../src/vendor/control-center/source-reader";
import { safeFetchText } from "../src/vendor/control-center/safe-fetch";
import { AbsControlCenterIngestion } from "../src/project-adapters/abs-news/v1/control-center-ingestion";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import { WebNewsService } from "../src/web/v1/news-service";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import type { DatabaseClient } from "../src/persistence/database";

const source = { id: "source:borrowed", name: "Example", url: "https://example.org/feed" };
const observed = new Date(now).toISOString();

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
  await assert.rejects(service.prepare(f.identity, scope.projectId, { storyId: stories[0].storyId,
    storyDigest: stories[0].storyDigest, action: "research_brief", goal: "Research this" }), /conflict/);
  await assert.rejects(ingest.ingest({ ...result, snapshot: undefined }, new Date(now - 100).toISOString()), /news_observation_stale/);
  assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 0);
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
