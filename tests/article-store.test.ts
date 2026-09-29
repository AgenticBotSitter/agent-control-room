import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, now, token, trust, origin, request } from "./helpers/web-foundation";
import { articleStory } from "./helpers/article-fixture";
import { createAccessVerifier, WebAccessError } from "../src/web/v1/access-verifier";
import { PostgresNewsStoryArchives, type NewsArchiveRow } from "../src/project-adapters/news/v1/story-archives";
import { PostgresNewsStoreV1 } from "../src/project-adapters/news/v1/postgres-store";
import { PostgresArticleDetails } from "../src/project-adapters/news/v1/article-store";
import { readNewsArticleDetail } from "../src/project-adapters/news/v1/article-detail";
import { WebNewsService } from "../src/web/v1/news-service";
import { createPrivateWebProcess } from "../src/web/v1/private-process";

test("saved article versions replay, retain lineage, enforce scope and expire with the session", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(new Request("https://fixture.invalid", { headers: { "cf-access-jwt-assertion": token() } }), now);
  const first = await f.service.create(identity, { title: "Article project", summary: "Fixture" }, "article-project-one");
  const second = await f.service.create(identity, { title: "Other project", summary: "Fixture" }, "article-project-two");
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: first.project.projectId }, key = new Uint8Array(32).fill(7);
  const story = articleStory(scope), stories = new PostgresNewsStoreV1(f.client, scope, key);
  await stories.saveStory(story);
  const text = `<article><p>${"Synthetic useful article for reading and research. ".repeat(80)}</p></article>`;
  const record = await readNewsArticleDetail({ ...scope, storyId: story.storyId, storyDigest: story.storyDigest }, {
    getStory: id => stories.getStory(id), authority: { assertCurrent: () => undefined },
    reader: { read: async () => ({ text, byteCount: Buffer.byteLength(text), endpointUrl: story.canonicalUrl, contentType: "text/html" }) },
  }, new AbortController().signal);
  assert.equal(record.status, "extracted"); if (record.status !== "extracted") throw new Error("fixture extraction failed");
  const store = new PostgresArticleDetails(f.client, scope, key);
  assert.equal((await store.save(record)).replayed, false); assert.equal((await store.save(record)).replayed, true);
  assert.deepEqual(await store.get(story.storyId, story.storyDigest, record.detailDigest), record);
  await assert.rejects(store.save({ ...record, text: "tampered" }));
  const webScope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId };
  const news = new WebNewsService(f.client, webScope, { integrityKey: key }, () => now);
  const input = { storyId: story.storyId, storyDigest: story.storyDigest, detailDigest: record.detailDigest };
  assert.deepEqual(await news.article(identity, scope.projectId, input), record);
  const app = createPrivateWebProcess({ origin, ...trust, ...webScope, news: { integrityKey: key },
    database: { client: f.client, close: async () => {} }, clock: () => now, loadKeys: async () => trust.keys });
  t.after(() => app.close());
  const path = `/api/v1/projects/${encodeURIComponent(scope.projectId)}/news/article?${new URLSearchParams(input)}`;
  const call = (req: Request) => app.handle(req, () => new Response("unexpected fallback", { status: 500 }));
  const response = await call(request(path)); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store"); assert.deepEqual(await response.json(), record);
  assert.equal((await call(request(`${path}&storyId=duplicate`))).status, 400);
  assert.equal((await call(request(path, "POST", {}))).status, 400);
  assert.equal((await call(request(path, "GET", undefined, undefined, token({ exp: now / 1000 - 1 })))).status, 401);
  await assert.rejects(news.article(identity, second.project.projectId, input));
  await assert.rejects(new WebNewsService(f.client, webScope, { integrityKey: key }, () => now + 600000).article(identity, scope.projectId, input));
  await assert.rejects(f.client.query("UPDATE control_news_article_details SET auth_tag=auth_tag"));
  await assert.rejects(f.client.query("DELETE FROM control_news_article_details"));
  await assert.rejects(f.client.query("TRUNCATE control_news_article_details"));
  assert.deepEqual(await stories.getStory(story.storyId, story.storyDigest), story);
  // Reusing a valid signed payload under a different indexed digest must not
  // allow an INSERT-only writer to replace the newest visible article.
  await f.client.query(`INSERT INTO control_news_article_details
    (tenant_id,workspace_id,project_id,story_id,story_digest,detail_digest,payload,auth_tag,recorded_at)
    SELECT tenant_id,workspace_id,project_id,story_id,story_digest,$1,payload,auth_tag,recorded_at + interval '1 day'
    FROM control_news_article_details`, [`sha256:${"e".repeat(64)}`]);
  await assert.rejects(store.get(story.storyId, story.storyDigest), { message: "news_article_integrity_failed" });
  assert.deepEqual(await store.get(story.storyId, story.storyDigest, record.detailDigest), record);
});

async function archiveFixture(t: import("node:test").TestContext) {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(new Request(origin, {
    headers: { "cf-access-jwt-assertion": token() },
  }), now);
  const project = await f.service.create(identity, { title: "Archive fixture", summary: "Synthetic news" }, "archive-project-fixture-01");
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: project.project.projectId };
  const key = new Uint8Array(32).fill(7), story = articleStory(scope);
  const stories = new PostgresNewsStoreV1(f.client, scope, key);
  await stories.saveStory(story);
  const archives = new PostgresNewsStoryArchives(f.client, scope, key);
  const news = new WebNewsService(f.client, { tenantId: scope.tenantId, workspaceId: scope.workspaceId }, { integrityKey: key }, () => now);
  const rows = async () => (await f.client.query<NewsArchiveRow>(
    `SELECT story_id,revision,archived,payload,auth_tag FROM control_news_story_archives
     WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND story_id=$4 ORDER BY revision`,
    [scope.tenantId, scope.workspaceId, scope.projectId, story.storyId])).rows;
  return { ...f, identity, scope, story, stories, archives, news, rows };
}

test("news archive persists and restores a saved story through the web service", async t => {
  const f = await archiveFixture(t), { storyId } = f.story;
  assert.equal(await f.archives.get(storyId), undefined);
  const saved = await f.news.archive(f.identity, f.scope.projectId, { storyId, archived: true, expectedRevision: 0 });
  assert.deepEqual(saved, { record: { storyId, archived: true, revision: 1, updatedAt: new Date(now).toISOString() },
    replayed: false, startsWork: false, projectId: f.scope.projectId });
  assert.deepEqual(await f.archives.get(storyId), saved.record);
  // Archive classification is exposed by list(), not the retained article-text read.
  const archived = await f.news.list(f.identity, f.scope.projectId, undefined, undefined, "archive");
  assert.equal(archived.stories.length, 1);
  assert.equal(archived.stories[0].storyId, storyId);
  assert.equal(archived.stories[0].queue, "archive");
  assert.equal(archived.stories[0].archiveRevision, 1);
  const restored = await f.news.archive(f.identity, f.scope.projectId, { storyId, archived: false, expectedRevision: 1 });
  assert.equal(restored.replayed, false);
  assert.deepEqual(restored.record, { ...saved.record, archived: false, revision: 2 });
  assert.deepEqual(await f.archives.get(storyId), restored.record);
  assert.deepEqual((await f.rows()).map(row => [row.revision, row.archived]), [[1, true], [2, false]]);
  const page = await f.news.list(f.identity, f.scope.projectId);
  assert.equal(page.stories.length, 1);
  assert.equal(page.stories[0].storyId, storyId);
  assert.notEqual(page.stories[0].queue, "archive");
  assert.equal(page.stories[0].archiveRevision, 2);
  assert.equal((await f.news.list(f.identity, f.scope.projectId, undefined, undefined, "archive")).stories.length, 0);
  assert.deepEqual(await f.stories.getStory(storyId, f.story.storyDigest), f.story);
});

test("news archive exact retries replay without inserting archive or audit rows", async t => {
  const f = await archiveFixture(t), { storyId } = f.story;
  const input = { storyId, archived: true, expectedRevision: 0 };
  const first = await f.news.archive(f.identity, f.scope.projectId, input);
  const before = await f.rows();
  const auditCount = async () => (await f.client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_events WHERE action='news.archive.updated' AND project_id=$1", [f.scope.projectId])).rows[0].count;
  const audits = await auditCount();
  assert.equal(audits, "1");
  // expectedRevision is the pre-write revision: replay repeats 0 for saved revision 1.
  const replay = await f.news.archive(f.identity, f.scope.projectId, input);
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.deepEqual(await f.rows(), before);
  assert.equal(await auditCount(), audits);
  const direct = await f.archives.save(storyId, true, 0, new Date(now).toISOString());
  assert.deepEqual(direct, { record: first.record, replayed: true, startsWork: false });
  assert.deepEqual(await f.rows(), before);
});

test("news archive stale revisions and unknown stories fail without changing persistence", async t => {
  const f = await archiveFixture(t), { storyId } = f.story;
  await f.news.archive(f.identity, f.scope.projectId, { storyId, archived: true, expectedRevision: 0 });
  const before = await f.rows();
  await assert.rejects(f.archives.save(storyId, false, 0, new Date(now).toISOString()), { message: "news_archive_conflict" });
  await assert.rejects(f.news.archive(f.identity, f.scope.projectId, { storyId, archived: false, expectedRevision: 0 }),
    error => error instanceof WebAccessError && error.code === "conflict");
  await assert.rejects(f.news.archive(f.identity, f.scope.projectId, { storyId: "story:unknown", archived: true, expectedRevision: 0 }),
    error => error instanceof WebAccessError && error.code === "not_found");
  assert.deepEqual(await f.rows(), before);
  assert.equal(await f.archives.get("story:unknown"), undefined);
});

test("news archive rejects an invalid stored authentication tag on verify and get", async t => {
  const f = await archiveFixture(t), { storyId } = f.story;
  await f.news.archive(f.identity, f.scope.projectId, { storyId, archived: true, expectedRevision: 0 });
  const [valid] = await f.rows();
  assert.deepEqual(f.archives.verify(valid), await f.archives.get(storyId));
  const badTag = valid.auth_tag.slice(0, -1) + (valid.auth_tag.endsWith("0") ? "1" : "0");
  assert.notEqual(badTag, valid.auth_tag); // Preserve SQL shape, invalidate authentication.
  assert.throws(() => f.archives.verify({ ...valid, auth_tag: badTag }), { message: "news_archive_integrity_failed" });
  // The store is append-only. Insert a deliberately invalid next revision in the
  // disposable fixture rather than disabling production mutation protections.
  await f.client.query(`INSERT INTO control_news_story_archives
    (tenant_id,workspace_id,project_id,story_id,revision,archived,payload,auth_tag)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [f.scope.tenantId, f.scope.workspaceId, f.scope.projectId,
    storyId, 2, true, { ...valid.payload as object, revision: 2 }, badTag]);
  assert.equal((await f.rows()).length, 2);
  await assert.rejects(f.archives.get(storyId), { message: "news_archive_integrity_failed" });
});
