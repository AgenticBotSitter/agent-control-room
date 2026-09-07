import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { taskFixture } from "./helpers/web-task";
import { seedWebIdea, webIdeaKey } from "./helpers/web-idea-project";
import { now, request } from "./helpers/web-foundation";
import { startupConfig } from "./helpers/web-startup";
import { WebIdeaService } from "../src/web/v1/idea-service";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { createIdeaBrowserClient } from "../src/web/v1/idea-browser-client";
import { IdeaDiscussion, PrivateIdeaWorkspace } from "../private-app/app/idea-workspace";

test("Idea browser client renders retained round contributions, synthesis and project navigation from the real private API", async t => {
  const f = await taskFixture(); await seedWebIdea(f.client);
  const app = createPrivateWebProcess({ ...startupConfig, database: { client: f.client, close: () => f.db.close() }, clock: () => now });
  t.after(() => app.close());
  const transport: typeof fetch = async (path, options) => {
    assert.equal(options?.credentials, "same-origin"); assert.equal(options?.redirect, "error");
    return app.handle(request(String(path)), () => new Response("shell"));
  };
  const client = createIdeaBrowserClient(transport), page = await client.list(), id = page.sessions[0].sessionId;
  const detail = await client.detail(id), html = renderToStaticMarkup(createElement(IdeaDiscussion, { detail }));
  for (const p of detail.session.participants) assert.ok(html.includes(p.displayName));
  assert.ok(html.includes("Round 1")); assert.ok(html.includes("Synthesis"));
  assert.ok(html.includes("Open project workspace")); assert.ok(html.includes("Test confidence"));
  assert.ok(html.includes("Synthetic test contribution")); assert.ok(!html.includes("Bot-reported confidence"));
  // Rendering-only provider-history variant; this is not provider qualification evidence.
  const providerHtml = renderToStaticMarkup(createElement(IdeaDiscussion, { detail: { ...detail,
    contributions: detail.contributions.map(c => ({ ...c, sourceMode: "provider_filtered" as const, providerContacted: true, liveBotContactAuthorized: true })) } }));
  assert.ok(providerHtml.includes("Retained, filtered provider contribution")); assert.ok(providerHtml.includes("Bot-reported confidence"));
  assert.ok(!providerHtml.includes("Synthetic test contribution"));
  assert.ok(html.includes("Starting live panels is not connected"));
  let renders = 0;
  const handle = (path: string) => app.handle(request(path), () => { renders++; return new Response("shell"); });
  assert.equal((await handle("/ideas")).status, 200);
  assert.equal((await handle(`/ideas/${encodeURIComponent(id)}`)).status, 200);
  assert.equal((await handle(`/ideas/${encodeURIComponent(id)}?after=idea:one`)).status, 400);
  assert.equal((await handle("/ideas?after=x&after=y")).status, 400);
  await app.handle(request("/api/v1/session/logout", "POST"), () => new Response());
  assert.equal((await handle("/ideas")).status, 401); assert.equal(renders, 2);
  await assert.rejects(client.detail(id), /authentication_required/);
});

test("Idea browser rejects mixed identities, incorrect cursor and inconsistent decision dependencies", async t => {
  const f = await taskFixture(); t.after(() => f.db.close()); await seedWebIdea(f.client);
  const service = new WebIdeaService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, webIdeaKey, () => now);
  const id = "idea:project.idea:web", detail = await service.detail(f.identity, id), page = await service.list(f.identity);
  const reply = (body: unknown) => createIdeaBrowserClient(async () => Response.json(body));
  await assert.rejects(reply(detail).detail("idea:other"), /unavailable/);
  await assert.rejects(reply({ ...detail, synthesis: null }).detail(id), /unavailable/);
  await assert.rejects(reply({ ...detail, contributions: detail.contributions.map(c => ({ ...c, participantId: "participant:other" })) }).detail(id), /unavailable/);
  await assert.rejects(reply({ ...page, nextCursor: id }).list(), /unavailable/);
  await assert.rejects(reply({ ...page, execution: "running" }).list(), /unavailable/);
  await assert.rejects(reply({ ...detail, contributions: detail.contributions.map(c => ({ ...c, sourceMode: "provider_filtered", providerContacted: false })) }).detail(id), /unavailable/);
  const html = renderToStaticMarkup(createElement(IdeaDiscussion, { detail: { ...detail,
    session: { ...detail.session, title: "<script>untrusted</script>" } } }));
  assert.ok(html.includes("&lt;script&gt;untrusted&lt;/script&gt;"));
  assert.ok(!html.includes("<script>untrusted</script>"));
  const loading = renderToStaticMarkup(createElement(PrivateIdeaWorkspace));
  assert.ok(loading.includes("Loading saved ideas")); assert.ok(!loading.includes(detail.session.title));
});
