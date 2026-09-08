import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { queueAttentionSchema } from "../src/web/v1/queue-attention-wire";
import { readQueueAttention } from "../src/web/v1/queue-attention-browser-client";
import { QueueAttentionPanel } from "../private-app/app/needs-me/workspace";
import { fixture, now, origin, request, trust } from "./helpers/web-foundation";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
const snapshot = queueAttentionSchema.parse({ source: "current_process_recovery", configuredNodes: 3,
  unavailableNodes: 0, notAttemptedNodes: 0, runningNodes: 1, completeNodes: 1,
  uncertainNodes: 1, held: 2, truncatedNodes: 1, startsWork: false });

test("owner-only recovery read is scoped, read-only and revoked with the session", async t => {
  const f = await fixture(); t.after(() => f.db.close()); let reads = 0;
  const app = createPrivateWebProcess({ origin, ...trust, ...scope, clock: () => now,
    database: { client: f.client, close: async () => {} }, loadKeys: async () => trust.keys,
    queueAttention: { ...scope, read: () => { reads++; return snapshot; } } });
  t.after(() => app.close()); const render = () => new Response("shell");
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["connections.read"]'::jsonb WHERE id='grant:web'`);
  assert.equal((await app.handle(request("/needs-me"), render)).status, 200); assert.equal(reads, 0);
  assert.equal((await app.handle(request("/api/v1/needs-me/tasks"), render)).status, 403);
  const response = await app.handle(request("/api/v1/needs-me"), render);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), snapshot); assert.equal(reads, 1);
  for (const path of ["/api/v1/needs-me?retry=true", "/api/v1/needs-me?node=private"])
    assert.equal((await app.handle(request(path), render)).status, 400);
  assert.equal((await app.handle(request("/api/v1/needs-me", "POST"), render)).status, 400);
  await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE id='grant:web'");
  assert.equal((await app.handle(request("/api/v1/needs-me"), render)).status, 403); assert.equal(reads, 1);
  assert.equal((await app.handle(request("/needs-me"), render)).status, 403);
  await f.db.query("UPDATE control_role_grants SET role_key='owner' WHERE id='grant:web'");
  await app.handle(request("/api/v1/session/logout", "POST"), render);
  assert.equal((await app.handle(request("/api/v1/needs-me"), render)).status, 401); assert.equal(reads, 1);
});

test("recovery browser client reads once and rejects misleading or oversized snapshots", async () => {
  let calls = 0;
  const result = await readQueueAttention(async (path, options) => {
    calls++; assert.equal(path, "/api/v1/needs-me"); assert.equal(options?.method, "GET");
    assert.equal(options?.cache, "no-store"); return Response.json(snapshot);
  });
  assert.deepEqual(result, snapshot); assert.equal(calls, 1);
  for (const value of [{ ...snapshot, configuredNodes: 0 }, { ...snapshot, held: 33 },
    { ...snapshot, nodeId: "private" }, { ...snapshot, startsWork: true }])
    await assert.rejects(readQueueAttention(async () => Response.json(value)), /unavailable/);
  await assert.rejects(readQueueAttention(async () => Response.json("x".repeat(5000))), /unavailable/);
  await assert.rejects(readQueueAttention(async () => new Response(null, { status: 401 })), /authentication_required/);
  await assert.rejects(readQueueAttention(async () => new Response(null, { status: 403 })), /access_denied/);
});

test("absent recovery is unavailable, and a foreign source cannot be configured", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const options = { origin, ...trust, ...scope, clock: () => now,
    database: { client: f.client, close: async () => {} }, loadKeys: async () => trust.keys };
  assert.throws(() => createPrivateWebProcess({ ...options,
    queueAttention: { ...scope, tenantId: "tenant:other", read: () => snapshot } }), /invalid_private_app_config/);
  const app = createPrivateWebProcess(options); t.after(() => app.close());
  assert.equal((await app.handle(request("/api/v1/needs-me"), () => new Response("shell"))).status, 503);
});

test("recovery panel describes limitations and offers no retry command", () => {
  const html = renderToStaticMarkup(<QueueAttentionPanel snapshot={snapshot} />);
  for (const text of ["2 work items held", "1 recovery checks", "32-item", "not a durable task inbox", "Zero counts"])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes("<button"));
});
