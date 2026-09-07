import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup";
import { now, request } from "./helpers/web-foundation";
import { WebNewsService } from "../src/web/v1/news-service";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import { buildAbsNewsSyntheticWorkspaceV1 } from "../src/project-adapters/abs-news/v1/index";
import { sha256Digest } from "../src/security/digest";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { newsPageSchema, newsResearchPreviewSchema } from "../src/web/v1/news-wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewsResearchForm } from "../private-app/app/news-research-form";
import { PrivateNewsWorkspace } from "../private-app/app/news-workspace";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" }, key = new Uint8Array(32).fill(37);
function storyFor(projectId: string) {
  const { storyDigest: _digest, ...source } = buildAbsNewsSyntheticWorkspaceV1().stories[0]; void _digest;
  const body = { ...source, ...scope, projectId }; return { ...body, storyDigest: sha256Digest(body) };
}
test("news preparation reads exact retained evidence, saves no task, and ordinary saving retains the sources", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const projectId = f.project.projectId, story = storyFor(projectId);
  const service = new WebNewsService(f.client, scope, { integrityKey: key }, () => now);
  const missing = await new WebNewsService(f.client, scope, {}, () => now).list(f.identity, projectId);
  assert.equal(missing.availability, "not_configured"); assert.equal(missing.canPrepare, false);
  const store = new PostgresAbsNewsStoreV1(f.client, { ...scope, projectId }, key);
  await store.saveStory(story);
  const page = newsPageSchema.parse(await service.list(f.identity, projectId));
  assert.equal(page.stories[0].storyDigest, story.storyDigest); assert.equal(page.canPrepare, true);
  const input = { storyId: story.storyId, storyDigest: story.storyDigest, action: "research_brief", goal: "Verify these claims." };
  const preview = newsResearchPreviewSchema.parse(await service.prepare(f.identity, projectId, input));
  assert.equal(preview.saved, false); assert.equal(preview.dispatch, "not_requested");
  assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 0);
  assert.equal((await f.client.query("SELECT * FROM control_abs_research_proposals")).rows.length, 0);
  for (const source of story.sourceEvidence) assert.ok(preview.draft.instructions.includes(source.canonicalUrl));
  const saved = await f.tasks.propose(f.identity, projectId, preview.draft, "news-save-000001");
  assert.equal(saved.receipt.projectId, projectId);
  assert.equal((await f.client.query<{ state: string }>("SELECT state FROM control_jobs")).rows[0].state, "proposed");
  assert.equal((await f.tasks.propose(f.identity, projectId, preview.draft, "news-save-000001")).replayed, true);
  await assert.rejects(service.prepare(f.identity, projectId, { ...input, sourceUrls: ["https://example.org/forged"] }));
  await assert.rejects(service.prepare(f.identity, projectId, { ...input, storyDigest: `sha256:${"0".repeat(64)}` }));
  await assert.rejects(service.prepare(f.identity, "project:other", input));
  await assert.rejects(new WebNewsService(f.client, scope, { integrityKey: new Uint8Array(32) }, () => now).list(f.identity, projectId));
  const guide = await service.prepare(f.identity, projectId, { ...input, action: "setup_guide" });
  assert.ok(guide.draft.instructions.includes("Deliverable: setup_guide"));
  await f.client.query("UPDATE control_role_grants SET revoked_at=$1", [new Date(now).toISOString()]);
  await assert.rejects(service.prepare(f.identity, projectId, input));
  await assert.rejects(service.list(f.identity, projectId));
});

test("private news routes require current access and grant only retained-source reads", async t => {
  const f = await limitedWebFixture();
  const app = createPrivateWebProcess({ ...startupConfig, news: { integrityKey: key }, database: f.pool, clock: () => now });
  t.after(() => app.close()); let renders = 0;
  const handle = (req: Request) => app.handle(req, () => { renders++; return new Response("news-shell"); });
  const { project } = await (await handle(request(undefined, "POST", { title: "Saved news", summary: "" }))).json();
  const path = `/api/v1/projects/${project.projectId}/news`;
  assert.equal((await handle(request(path))).status, 200);
  assert.equal((await handle(request(`/projects/${project.projectId}/news`))).status, 200);
  assert.equal(renders, 1);
  for (const suffix of ["?after=one&after=two", "?other=value", "?after="])
    assert.equal((await handle(request(path + suffix))).status, 400);
  assert.equal((await handle(request(path, "POST", {}))).status, 400);
  assert.equal((await handle(request(path + "/prepare"))).status, 400);
  assert.equal((await handle(request(path + "/prepare", "POST", { storyId: "story:missing", storyDigest: `sha256:${"0".repeat(64)}`,
    action: "research_brief", goal: "Verify this." }))).status, 404);
  const foreign = request(path + "/prepare", "POST", {}); foreign.headers.set("origin", "https://different.example");
  assert.equal((await handle(foreign)).status, 403);
  const anonymous = request(path); anonymous.headers.delete("cf-access-jwt-assertion");
  assert.equal((await handle(anonymous)).status, 401);
  for (const sql of ["SELECT * FROM control_abs_research_proposals", "INSERT INTO control_abs_story_versions DEFAULT VALUES",
    "UPDATE control_abs_story_versions SET payload='{}'::jsonb", "DELETE FROM control_abs_story_versions"])
    await assert.rejects(f.client.query(sql));
  assert.equal((await handle(request("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handle(request(path))).status, 401);
  assert.equal((await handle(request(`/projects/${project.projectId}/news`))).status, 401);
  assert.equal(renders, 1);
});

test("authenticated article to preview to saved-task HTTP journey preserves evidence and idempotency", async t => {
  const f = await taskFixture(), projectId = f.project.projectId, story = storyFor(projectId);
  await new PostgresAbsNewsStoreV1(f.client, { ...scope, projectId }, key).saveStory(story);
  const app = createPrivateWebProcess({ ...startupConfig, news: { integrityKey: key },
    database: { client: f.client, close: () => f.db.close() }, clock: () => now });
  t.after(() => app.close());
  const handle = (req: Request) => app.handle(req, () => new Response("shell"));
  const path = `/api/v1/projects/${projectId}`;
  const page = newsPageSchema.parse(await (await handle(request(`${path}/news`))).json());
  const selected = page.stories[0];
  const input = { storyId: selected.storyId, storyDigest: selected.storyDigest, action: "setup_guide", goal: "Explain how to set this up safely." };
  const prepared = await handle(request(`${path}/news/prepare`, "POST", input));
  assert.equal(prepared.status, 200); assert.equal(prepared.headers.get("cache-control"), "no-store");
  const preview = newsResearchPreviewSchema.parse(await prepared.json());
  const first = await handle(request(`${path}/tasks`, "POST", preview.draft, "article-journey-00001"));
  assert.equal(first.status, 201);
  const saved = await first.json();
  const replay = await handle(request(`${path}/tasks`, "POST", preview.draft, "article-journey-00001"));
  assert.equal(replay.status, 200); assert.equal((await replay.json()).receipt.jobId, saved.receipt.jobId);
  const detail = await handle(request(`${path}/tasks/${saved.receipt.jobId}`));
  assert.equal(detail.status, 200);
  assert.ok(JSON.stringify(await detail.json()).includes(story.storyDigest));
  assert.equal((await f.client.query("SELECT * FROM control_attempts")).rows.length, 0);
  assert.equal((await f.client.query("SELECT * FROM control_outbox")).rows.length, 0);
});

test("news UI has truthful loading state, labeled research controls and escaped source titles", () => {
  const story = storyFor("project:ui");
  const loading = renderToStaticMarkup(createElement(PrivateNewsWorkspace, { projectId: story.projectId }));
  assert.ok(loading.includes("Loading saved news")); assert.ok(!loading.includes("Sample story"));
  const form = renderToStaticMarkup(createElement(NewsResearchForm, { projectId: story.projectId,
    story: { ...story, title: "<script>source claim</script>" }, close: () => {} }));
  assert.ok(form.includes("&lt;script&gt;source claim&lt;/script&gt;")); assert.ok(!form.includes("<script>source claim"));
  assert.ok(form.includes("Research this")); assert.ok(form.includes("Write a setup guide"));
  assert.ok(form.includes("Your instructions")); assert.ok(form.includes("Prepare draft"));
  assert.ok(form.includes("does not authorize execution or publication"));
});
