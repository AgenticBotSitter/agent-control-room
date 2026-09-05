import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateWebProcess } from "../src/web/v1/private-process.ts";
import { readBoundedJson } from "../src/web/v1/http-common.ts";
import { fixture, now, trust, origin, request, token } from "./helpers/web-foundation.ts";

const render = () => new Response("private shell");
test("shared private page, API and finite snapshot stream respect stored identity and session state", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  let current = now;
  let loads = 0;
  const app = createPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: f.client, close: async () => {} }, loadKeys: async () => { loads++; return trust.keys; }, clock: () => current });
  t.after(() => app.close());
  assert.equal((await app.handle(new Request(`${origin}/projects`, { headers: { "oai-authenticated-user-id": "owner" } }), render)).status, 401);
  assert.equal(loads, 0);
  const created = await app.handle(request(undefined, "POST", { title: "Private project", summary: "Durable" }), render);
  assert.equal(created.status, 201); const { project } = await created.json();
  const path = `/projects/${encodeURIComponent(project.projectId)}`;
  assert.equal((await app.handle(request(path), render)).status, 200);
  const streamPath = `/api/v1/projects/${encodeURIComponent(project.projectId)}/events`;
  const stream = await app.handle(request(streamPath), render);
  assert.equal(stream.status, 200); assert.match(await stream.text(), /event: project-snapshot/);
  assert.equal((await app.handle(request("/ideas"), render)).status, 404);
  assert.equal((await app.handle(request("/api/v1/fixture-snapshot"), render)).status, 404);
  assert.equal(loads, 1);
  await app.handle(request("/api/v1/session/logout", "POST"), render);
  for (const url of [path, streamPath, "/api/v1/projects"]) assert.equal((await app.handle(request(url), render)).status, 401);
  const fresh = (url: string) => request(url, "GET", undefined, undefined, token({ iat: now / 1000 - 30 }));
  await f.db.query("UPDATE control_role_grants SET revoked_at=$1 WHERE id='grant:web'", [new Date(now).toISOString()]);
  assert.equal((await app.handle(fresh(path), render)).status, 403);
  // Session management remains reachable after permission loss; no private project data is rendered there.
  assert.equal((await app.handle(fresh("/session"), render)).status, 200);
  current += 301_000;
  assert.equal((await app.handle(fresh(streamPath), render)).status, 401);
});

test("cross-origin, malformed input and expired sessions do not reach a page renderer", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const app = createPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: f.client, close: async () => {} }, loadKeys: async () => trust.keys, clock: () => now });
  t.after(() => app.close());
  let renders = 0;
  const page = () => { renders++; return render(); };
  const cross = request(undefined, "POST", { title: "No", summary: "" }); cross.headers.set("origin", "https://other.example.invalid");
  assert.equal((await app.handle(cross, page)).status, 403);
  assert.equal((await app.handle(request("/projects", "GET", undefined, undefined, token({ exp: now / 1000 })), page)).status, 401);
  const missing = new Request(`${origin}/projects`, { headers: { accept: "text/html" } });
  const html = await app.handle(missing, page);
  assert.equal(html.status, 401); assert.match(await html.text(), /Sign in to continue/);
  assert.equal(renders, 0);
});

test("shutdown rejects new requests, drains an admitted transaction, and closes its pool once", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  let release!: () => void; let entered!: () => void; let closes = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const client = { ...f.client, transactionWithPreCommitCheck: async <T>(run: Parameters<typeof f.client.transaction<T>>[0], check: () => void) => {
    entered(); await blocked; return f.client.transactionWithPreCommitCheck(run, check);
  } };
  const app = createPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client, close: async () => { closes++; } }, loadKeys: async () => trust.keys, clock: () => now });
  const inflight = app.handle(request(undefined, "POST", { title: "Before shutdown", summary: "" }), render);
  await started;
  const closing = app.close(); assert.equal(closes, 0);
  assert.equal((await app.handle(request(), render)).status, 503);
  release(); assert.equal((await inflight).status, 201);
  await closing; await app.close(); assert.equal(closes, 1);
});

test("JSON body reader caps byte count and a never-ending body deadline", async () => {
  await assert.rejects(readBoundedJson(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); } }), 10, 20), /invalid_request/);
  let cancelled = false;
  await assert.rejects(readBoundedJson(new ReadableStream({ cancel() { cancelled = true; } }), 100, 10), /invalid_request/);
  assert.equal(cancelled, true);
});
