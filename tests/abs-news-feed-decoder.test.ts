import assert from "node:assert/strict";
import test from "node:test";
import { decodeAbsFeed } from "../src/project-adapters/abs-news/v1/feed-decoder";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import { WebNewsService } from "../src/web/v1/news-service";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import { scoreIndustryDiscovery } from "../src/vendor/control-center/industry-curation";

const input = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: "project:feed",
  source: { sourceId: "source:news", sourceLabel: "Example News", sourceKind: "rss", endpointUrl: "https://example.org/feed" },
  observedAt: "2026-09-07T12:00:00.000Z", maxBytes: 65536, maxItems: 100 };
const item = (url: string, title = "New model") => `<item><title>${title}</title><link>${url}</link><description>A short report</description><pubDate>Mon, 07 Sep 2026 10:00:00 GMT</pubDate></item>`;
const rss = (items: string) => `<rss version="2.0"><channel><title>Example</title><link>https://example.org/</link><description>News</description>${items}</channel></rss>`;

test("complete upstream curation ranks discovery without deleting excluded stories or granting verification", async () => {
  const result = await decodeAbsFeed({ ...input, xml: rss(item("https://example.org/release", "New model release")
    + item("https://example.org/privacy", "Privacy policy")) });
  const release = result.stories.find(story => story.canonicalUrl.endsWith("/release"))!;
  const privacy = result.stories.find(story => story.canonicalUrl.endsWith("/privacy"))!;
  assert.equal(release.priorityScore, scoreIndustryDiscovery({ title: release.title, summary: release.summary,
    url: release.canonicalUrl, source: release.sourceLabel, kind: "rss", publishedAt: release.publishedAt,
    discoveredAt: release.discoveredAt }, { now: Date.parse(input.observedAt) }).score);
  assert.ok(release.priorityScore > privacy.priorityScore);
  assert.deepEqual(result.discoveryCuration.selectedStoryIds, [release.storyId]);
  assert.deepEqual(result.discoveryCuration.excludedStoryIds, [privacy.storyId]);
  assert.equal(result.stories.length, 2); assert.equal(result.discoveryCuration.grantsVerification, false);
  assert.ok(result.stories.every(story => story.verificationState === "review_only" && !story.grantsExecutionAuthority));
});

test("upstream RSS parser retains minimized provenance and stable canonical identity without verification", async () => {
  const result = await decodeAbsFeed({ ...input, xml: rss(item("https://example.org/story?utm_source=rss")) });
  assert.equal(result.state, "available"); assert.equal(result.startsWork, false);
  assert.equal(result.stories.length, 1); const story = result.stories[0];
  assert.equal(story.canonicalUrl, "https://example.org/story");
  assert.equal(story.verificationState, "review_only"); assert.equal(story.sourceLabel, "Example News");
  assert.equal(story.sourceEvidence[0].sourceKind, "rss"); assert.equal(story.summary, "A short report");
  assert.equal(story.publishedAt, "2026-09-07T10:00:00.000Z");
  const changed = await decodeAbsFeed({ ...input, xml: rss(item("https://example.org/story", "Corrected headline")) });
  assert.equal(changed.stories[0].storyId, story.storyId);
  assert.notEqual(changed.stories[0].storyDigest, story.storyDigest);
  assert.ok(!JSON.stringify(result).includes("<rss"));
});
test("Atom parsing, rejected items and duplicates have explicit counts", async () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title><id>https://example.org/feed</id><updated>2026-09-07T10:00:00Z</updated><entry><title>Atom story</title><id>urn:news:1</id><link href="https://example.org/atom"/><updated>2026-09-07T10:00:00Z</updated><summary>Summary</summary></entry></feed>`;
  assert.equal((await decodeAbsFeed({ ...input, source: { ...input.source, sourceKind: "atom" }, xml: atom })).stories[0].sourceEvidence[0].sourceKind, "atom");
  const result = await decodeAbsFeed({ ...input, xml: rss(item("https://example.org/a") + item("https://example.org/a#fragment") + item("http://127.0.0.1/private") + item("https://example.org/b", "")) });
  assert.equal(result.inputItemCount, 4); assert.equal(result.stories.length, 1);
  assert.equal(result.duplicateCount, 1); assert.equal(result.rejectedCount, 2); assert.equal(result.state, "partial");
});
test("bounded text parsing rejects declarations, malformed XML and excessive bytes/items", async () => {
  for (const xml of ["<!DOCTYPE rss SYSTEM 'file:///not-read'>" + rss(""), "<!ENTITY ext SYSTEM 'https://example.org/secret'>" + rss(""), "<rss>", "\u0000" + rss("")])
    await assert.rejects(decodeAbsFeed({ ...input, xml }), /invalid_feed/);
  await assert.rejects(decodeAbsFeed({ ...input, maxBytes: 10, xml: rss(item("https://example.org/a", "你好")) }), /feed_limit_exceeded/);
  await assert.rejects(decodeAbsFeed({ ...input, maxItems: 1, xml: rss(item("https://example.org/a") + item("https://example.org/b")) }), /feed_limit_exceeded/);
  await assert.rejects(decodeAbsFeed({ ...input, xml: rss(""), verified: true }), /invalid_feed/);
});
test("decoded feed batch survives store reopening but cannot bypass canonical-page verification", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: input.tenantId, workspaceId: input.workspaceId, projectId: f.project.projectId };
  const key = new Uint8Array(32).fill(19), result = await decodeAbsFeed({ ...input, ...scope, xml: rss(item("https://example.org/a") + item("https://example.org/b")) });
  const open = () => new PostgresAbsNewsStoreV1(f.client, scope, key);
  let inserts = 0;
  const failing = new PostgresAbsNewsStoreV1({ ...f.client, transaction: work => f.client.transaction(tx => work({
    query: (sql, params) => {
      if (sql.includes("INSERT INTO control_abs_story_versions") && ++inserts === 2) throw new Error("injected_second_insert_failure");
      return tx.query(sql, params);
    },
  })) }, scope, key);
  await assert.rejects(failing.saveStories(result.stories), /injected_second_insert_failure/);
  assert.equal((await open().listStories()).stories.length, 0);
  assert.deepEqual(await open().saveStories(result.stories), { inserted: 2, replayed: 0 });
  assert.deepEqual(await open().saveStories(result.stories), { inserted: 0, replayed: 2 });
  assert.equal((await open().listStories()).stories.length, 2);
  const news = new WebNewsService(f.client, { tenantId: scope.tenantId, workspaceId: scope.workspaceId }, { integrityKey: key }, () => now);
  assert.equal((await news.list(f.identity, scope.projectId)).stories.length, 2);
  // The domain store is reusable; feed receipt is discovery, never proposal authority.
  await assert.rejects(news.prepare(f.identity, scope.projectId, { storyId: result.stories[0].storyId,
    storyDigest: result.stories[0].storyDigest, action: "research_brief", goal: "Research this story" }), /conflict/);
  assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 0);
});
