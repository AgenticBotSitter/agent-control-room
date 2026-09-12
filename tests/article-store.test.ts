import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, now, token, trust, origin, request } from "./helpers/web-foundation";
import { articleStory } from "./helpers/article-fixture";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import { PostgresArticleDetails } from "../src/project-adapters/abs-news/v1/article-store";
import { readNewsArticleDetail } from "../src/project-adapters/abs-news/v1/article-detail";
import { WebNewsService } from "../src/web/v1/news-service";
import { createPrivateWebProcess } from "../src/web/v1/private-process";

test("saved article versions replay, retain lineage, enforce scope and expire with the session", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(new Request("https://fixture.invalid", { headers: { "cf-access-jwt-assertion": token() } }), now);
  const first = await f.service.create(identity, { title: "Article project", summary: "Fixture" }, "article-project-one");
  const second = await f.service.create(identity, { title: "Other project", summary: "Fixture" }, "article-project-two");
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: first.project.projectId }, key = new Uint8Array(32).fill(7);
  const story = articleStory(scope), stories = new PostgresAbsNewsStoreV1(f.client, scope, key);
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
  await assert.rejects(f.client.query("UPDATE control_abs_article_details SET auth_tag=auth_tag"));
  await assert.rejects(f.client.query("DELETE FROM control_abs_article_details"));
  await assert.rejects(f.client.query("TRUNCATE control_abs_article_details"));
  assert.deepEqual(await stories.getStory(story.storyId, story.storyDigest), story);
  // Reusing a valid signed payload under a different indexed digest must not
  // allow an INSERT-only writer to replace the newest visible article.
  await f.client.query(`INSERT INTO control_abs_article_details
    (tenant_id,workspace_id,project_id,story_id,story_digest,detail_digest,payload,auth_tag,recorded_at)
    SELECT tenant_id,workspace_id,project_id,story_id,story_digest,$1,payload,auth_tag,recorded_at + interval '1 day'
    FROM control_abs_article_details`, [`sha256:${"e".repeat(64)}`]);
  await assert.rejects(store.get(story.storyId, story.storyDigest), { message: "news_article_integrity_failed" });
  assert.deepEqual(await store.get(story.storyId, story.storyDigest, record.detailDigest), record);
});
