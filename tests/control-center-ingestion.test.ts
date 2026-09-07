import test from "node:test";
import assert from "node:assert/strict";
import { createIndustrySourceReader } from "../src/vendor/control-center/source-reader";
import { AbsControlCenterIngestion } from "../src/project-adapters/abs-news/v1/control-center-ingestion";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import { WebNewsService } from "../src/web/v1/news-service";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";

const source = { id: "source:borrowed", name: "Example", url: "https://example.org/feed" };
const observed = new Date(now).toISOString();

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
