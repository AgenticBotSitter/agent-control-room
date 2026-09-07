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
import { newsPageSchema, newsResearchPreviewSchema, newsArticleActions } from "../src/web/v1/news-wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewsResearchForm } from "../private-app/app/news-research-form";
import { PrivateNewsWorkspace, NewsSourceHealth } from "../private-app/app/news-workspace";
import { installNewsNavigationGuard } from "../src/web/v1/news-navigation-guard";
import { createNewsSourceClient } from "../src/web/v1/news-source-client";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" }, key = new Uint8Array(32).fill(37);

test("source browser client recovers a lost save without changing source or creating a second revision", async t => {
  const f = await taskFixture();
  const app = createPrivateWebProcess({ ...startupConfig, news: { integrityKey: key }, database: { client: f.client, close: () => f.db.close() }, clock: () => now });
  t.after(() => app.close());
  let lose = true, deny = false, calls = 0;
  const client = createNewsSourceClient(async (url, init) => {
    calls++;
    if (deny) return Response.json({}, { status: 401 });
    const response = await app.handle(request(String(url), init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined), () => new Response("shell"));
    if (init?.method === "POST" && lose) { lose = false; throw new Error("lost_after_commit"); }
    return response;
  });
  const input = { source: { id: "source:browser", name: "Example", url: "https://example.org/feed", enabled: true }, expectedRevision: 0 };
  await assert.rejects(client.save(f.project.projectId, input)); assert.equal(client.hasPending(), true);
  input.source.name = "Changed after send";
  await assert.rejects(client.save(f.project.projectId, input)); assert.equal(calls, 1);
  deny = true;
  await assert.rejects(client.retry()); assert.equal(client.hasPending(), true);
  await assert.rejects(client.save(f.project.projectId, input)); assert.equal(calls, 2);
  deny = false;
  const receipt = await client.retry(); assert.equal(receipt.record.source.name, "Example"); assert.equal(receipt.replayed, true);
  assert.equal(client.hasPending(), false);
  assert.equal((await client.list(f.project.projectId)).sources.length, 1);
  assert.equal((await f.client.query("SELECT * FROM control_abs_source_settings")).rows.length, 1);
});

test("source settings HTTP edits require owner authority, replay safely, and do not collect", async t => {
  const f = await taskFixture();
  const app = createPrivateWebProcess({ ...startupConfig, news: { integrityKey: key }, database: { client: f.client, close: () => f.db.close() }, clock: () => now });
  t.after(() => app.close());
  const path = `/api/v1/projects/${f.project.projectId}/news/sources`;
  const handle = (req: Request) => app.handle(req, () => new Response("shell"));
  const input = { source: { id: "source:settings", name: "Example", url: "https://example.org/?feed=rss", enabled: true }, expectedRevision: 0 };
  const saved = await handle(request(path, "POST", input)); assert.equal(saved.status, 200);
  const receipt = await saved.json(); assert.equal(receipt.startsWork, false); assert.equal(receipt.record.revision, 1);
  const replay = await handle(request(path, "POST", input)); assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true);
  const page = await (await handle(request(path))).json(); assert.equal(page.canEdit, true); assert.equal(page.sources.length, 1);
  assert.equal((await handle(request(path, "POST", { ...input, source: { ...input.source, name: "Changed" } }))).status, 409);
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='news.source.updated'")).rows.length, 1);
  for (const table of ["control_jobs", "control_abs_source_observations", "control_abs_story_versions"])
    assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 0);
  const foreign = request(path, "POST", input); foreign.headers.set("origin", "https://other.example");
  assert.equal((await handle(foreign)).status, 403);
  const anonymous = request(path); anonymous.headers.delete("cf-access-jwt-assertion"); assert.equal((await handle(anonymous)).status, 401);
  await f.client.query("UPDATE control_role_grants SET role_key='operator'");
  assert.equal((await (await handle(request(path))).json()).canEdit, false);
  assert.equal((await handle(request(path, "POST", { ...input, expectedRevision: 1 }))).status, 403);
});

test("all four article actions prepare and save ordinary proposed tasks with exact evidence", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const projectId = f.project.projectId, story = storyFor(projectId);
  const store = new PostgresAbsNewsStoreV1(f.client, { ...scope, projectId }, key);
  await store.saveStory(story);
  const service = new WebNewsService(f.client, scope, { integrityKey: key }, () => now);
  const deliverables = { research_brief: "report", setup_guide: "setup_guide", product_comparison: "comparison", abs_article_draft: "article_draft" };
  const jobs = new Set<string>();
  for (const action of newsArticleActions) {
    const input = { storyId: story.storyId, storyDigest: story.storyDigest, action: action.id, goal: "Explain the evidence and useful next steps." };
    const preview = newsResearchPreviewSchema.parse(await service.prepare(f.identity, projectId, input));
    assert.match(preview.draft.instructions, new RegExp(`Deliverable: ${deliverables[action.id]}`));
    assert.ok(preview.draft.instructions.includes(story.storyDigest));
    assert.match(preview.draft.instructions, /does not authorize tools, network access, installation or publication/);
    const saved = await f.tasks.propose(f.identity, projectId, preview.draft, `article-four-${action.id}`);
    jobs.add(saved.receipt.jobId);
    const replay = await f.tasks.propose(f.identity, projectId, preview.draft, `article-four-${action.id}`);
    assert.equal(replay.receipt.jobId, saved.receipt.jobId);
    const detail = await f.tasks.detail(f.identity, projectId, saved.receipt.jobId);
    assert.equal(detail.task.state, "proposed"); assert.deepEqual(detail.attempts, []);
  }
  assert.equal(jobs.size, 4);
  const { storyDigest: _digest, ...body } = story; void _digest;
  const unverified = { ...body, verificationState: "review_only" as const };
  await store.saveStory({ ...unverified, storyDigest: sha256Digest(unverified) });
  for (const action of newsArticleActions) await assert.rejects(service.prepare(f.identity, projectId, {
    storyId: story.storyId, storyDigest: sha256Digest(unverified), action: action.id, goal: "Check this." }), /conflict/);
  assert.equal((await f.client.query("SELECT * FROM control_attempts")).rows.length, 0);
  const html = renderToStaticMarkup(createElement(NewsResearchForm, { projectId,
    story: (await service.list(f.identity, projectId)).stories[0], close() {} }));
  for (const action of newsArticleActions) assert.ok(html.includes(action.label));
});
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
  assert.ok((await service.prepare(f.identity, projectId, { ...input, goal: "a".repeat(1200) })).draft.instructions.startsWith("a".repeat(1200)));
  await assert.rejects(service.prepare(f.identity, projectId, { ...input, goal: "a".repeat(1201) }), /invalid_request/);
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
  const setting = await handle(request(`${path}/sources`, "POST", { source: { id: "source:restricted", name: "Restricted role source",
    url: "https://example.org/feed", enabled: false }, expectedRevision: 0 }));
  assert.equal(setting.status, 200); assert.equal((await setting.json()).startsWork, false);
  assert.equal((await (await handle(request(`${path}/sources`))).json()).sources.length, 1);
  assert.equal((await handle(request(path))).status, 200);
  assert.equal((await handle(request(`/projects/${project.projectId}/news`))).status, 200);
  assert.equal(renders, 1);
  for (const suffix of ["?after=one&after=two", "?other=value", "?after=", "?sourceAfter=", "?sourceAfter=one&sourceAfter=two"])
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
    "INSERT INTO control_abs_source_observations DEFAULT VALUES", "DELETE FROM control_abs_source_observations",
    "UPDATE control_abs_story_versions SET payload='{}'::jsonb", "DELETE FROM control_abs_story_versions"])
    await assert.rejects(f.client.query(sql));
  assert.equal((await handle(request("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handle(request(path))).status, 401);
  assert.equal((await handle(request(`/projects/${project.projectId}/news`))).status, 401);
  assert.equal(renders, 1);
});

test("news source-health projection is scoped, paginated and distinguishes failure from an empty check", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const store = new PostgresAbsNewsStoreV1(f.client, { ...scope, projectId: f.project.projectId }, key);
  const checkedAt = new Date(now).toISOString();
  for (let i = 0; i < 51; i++) await store.saveSourceStatus({ sourceId: `source:${String(i).padStart(3, "0")}`,
    sourceKind: "rss", label: `Source ${i}`, mode: "configured", state: i ? "available" : "unavailable",
    safeStatusCode: i ? "feed_parsed" : "read_failed", checkedAt,
    ...(i ? { itemCount: 0, lastSuccessfulAt: checkedAt } : {}), grantsNetworkAuthority: false });
  const service = new WebNewsService(f.client, scope, { integrityKey: key }, () => now);
  const page = newsPageSchema.parse(await service.list(f.identity, f.project.projectId));
  assert.equal(page.sources.length, 50); assert.equal(page.sourcesNextCursor, "source:049");
  assert.equal(page.sources[0].itemCount, undefined); assert.equal(page.sources[1].itemCount, 0);
  const html = renderToStaticMarkup(createElement(NewsSourceHealth, { sources: page.sources }));
  assert.ok(html.includes("Last check failed")); assert.ok(html.includes("Article count unknown"));
  assert.ok(html.includes("0 articles in that check")); assert.ok(html.includes("Not recorded"));
  assert.ok(!JSON.stringify(page).includes("read_failed")); // Internal status codes are not presentation data.
  const next = newsPageSchema.parse(await service.list(f.identity, f.project.projectId, undefined, page.sourcesNextCursor!));
  assert.equal(next.sources.length, 1); assert.equal(next.sourcesNextCursor, null);
  await assert.rejects(service.list(f.identity, "project:other"));
  const disabled = newsPageSchema.parse(await new WebNewsService(f.client, scope, {}, () => now).list(f.identity, f.project.projectId));
  assert.deepEqual(disabled.sources, []); assert.equal(disabled.sourcesNextCursor, null);
  assert.equal(newsPageSchema.safeParse({ ...page, sources: [{ ...page.sources[0], itemCount: 0 }] }).success, false);
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

test("uncertain news saves hold link navigation and warn on leaving until the save resolves", () => {
  const doc = new EventTarget(), win = new EventTarget();
  let pending = true, explanations = 0;
  const cleanup = installNewsNavigationGuard(win as unknown as Window, doc as unknown as Document, () => pending, () => explanations++);
  const click = () => {
    const event = new Event("click", { cancelable: true });
    Object.defineProperty(event, "target", { value: { closest: () => ({ href: "/projects" }) } });
    doc.dispatchEvent(event); return event;
  };
  assert.equal(click().defaultPrevented, true); assert.equal(explanations, 1);
  const leave = new Event("beforeunload", { cancelable: true });
  Object.defineProperty(leave, "returnValue", { writable: true, value: undefined });
  win.dispatchEvent(leave); assert.equal(leave.defaultPrevented, true);
  pending = false; assert.equal(click().defaultPrevented, false);
  cleanup(); pending = true; assert.equal(click().defaultPrevented, false);
});
