import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateNodeHandler } from "../src/web/v1/private-node-handler.ts";
import { nodeExchange } from "./helpers/web-node.ts";

const origin = "https://private.example.invalid";
function fixture(overrides: Partial<Parameters<typeof createPrivateNodeHandler>[0]> = {}) {
  const requests: Request[] = []; let closes = 0;
  const application = { isReady: () => true, close: async () => { closes++; } };
  const server = createPrivateNodeHandler({ origin, application,
    handler: request => { requests.push(request); return Response.json({ ok: true }); },
    assets: { count: 1, digest: "synthetic", respond: (path, method) => path === "/_next/static/app.js"
      ? new Response(method === "HEAD" ? null : "compiled fixture", { headers: { "content-type": "text/javascript" } }) : undefined },
    ...overrides });
  return { server, requests, get closes() { return closes; } };
}
async function send(f: ReturnType<typeof fixture>, options: Parameters<typeof nodeExchange>[0] = {}) {
  const x = nodeExchange(options); await f.server.handle(x.input, x.output); return x;
}
test("Node bridge reconstructs the fixed HTTPS origin and preserves reviewed request fields only", async () => {
  const f = fixture();
  const x = await send(f, { method: "POST", path: "/api/v1/projects", body: '{"title":"Example"}', headers: [
    "Origin", origin, "Content-Type", "application/json", "cf-access-jwt-assertion", "synthetic-assertion",
    "Idempotency-Key", "synthetic-key", "X-Forwarded-Host", "ignored.invalid", "X-Forwarded-Proto", "http",
    "Cookie", "ignored=not-an-identity", "Authorization", "ignored",
  ] });
  assert.equal(x.output.statusCode, 200); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, `${origin}/api/v1/projects`);
  assert.equal(f.requests[0].headers.get("origin"), origin);
  assert.equal(f.requests[0].headers.get("idempotency-key"), "synthetic-key");
  for (const name of ["host", "x-forwarded-host", "x-forwarded-proto", "cookie", "authorization"])
    assert.equal(f.requests[0].headers.has(name), false);
  assert.equal(await f.requests[0].text(), '{"title":"Example"}');
  assert.equal(x.headers.get("cache-control"), "no-store"); assert.equal(x.headers.get("connection"), "close");
  await f.server.close(); assert.equal(f.closes, 1);
});
test("Node bridge rejects mismatched peers, origins, duplicate headers and unsupported framing before dispatch", async () => {
  const f = fixture();
  for (const options of [
    { peer: "192.0.2.1" }, { headers: ["HOST", "other.invalid"] },
    { headers: ["Origin", origin, "origin", origin] },
    { method: "POST", headers: ["Content-Length", "1", "Transfer-Encoding", "chunked"], body: "x" },
    { headers: ["Expect", "100-continue"] }, { headers: ["Upgrade", "websocket"] },
    { headers: ["Content-Encoding", "gzip"] }, { headers: ["Trailer", "x-test"] },
    { headers: ["Transfer-Encoding", "chunked"] }, { method: "CONNECT" },
    { path: "https://other.invalid/projects" }, { path: "//other.invalid/projects" },
    { path: "/a/../projects" }, { path: "/projects#fragment" },
    { headers: ["Sec-Fetch-Site", "cross-site"] },
  ]) { const x = await send(f, options); assert.ok(x.output.statusCode >= 400, JSON.stringify(options)); }
  assert.equal(f.requests.length, 0);
});
test("Node bridge rejects excessive input and mismatched lengths without dispatch or error detail", async () => {
  const f = fixture();
  for (const options of [
    { method: "POST", body: "a".repeat(8193) },
    { method: "POST", headers: ["Content-Length", "9000"] },
    { method: "POST", headers: ["Content-Length", "2"], body: "a" },
    { headers: ["Accept", "a".repeat(24576)] },
    { headers: Array.from({ length: 64 }, (_, i) => [`x-${i}`, "x"]).flat() },
    { path: "/" + "a".repeat(4096) },
  ]) { const x = await send(f, options); assert.ok(x.output.statusCode >= 400); assert.match(x.body(), /invalid_request/); }
  assert.equal(f.requests.length, 0);
});
test("Node bridge serves only the startup asset snapshot, with HEAD and no server fallback", async () => {
  const f = fixture();
  const js = await send(f, { path: "/_next/static/app.js" }); assert.equal(js.body(), "compiled fixture");
  const head = await send(f, { path: "/_next/static/app.js", method: "HEAD" }); assert.equal(head.body(), "");
  for (const path of ["/_next/static/private.map", "/_next/static/", "/_next/server/index.js", "/_next/static/app.js?x=1"])
    assert.equal((await send(f, { path })).output.statusCode, 404);
  assert.equal(f.requests.length, 0);
});
test("HEAD cancels rendered bytes and response errors do not disclose details", async () => {
  let cancelled = false;
  const f = fixture({ handler: () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  assert.equal((await send(f, { method: "HEAD" })).body(), ""); assert.equal(cancelled, true);
  const g = fixture({ handler: () => { throw new Error("private database locator"); } });
  const error = await send(g); assert.equal(error.output.statusCode, 503);
  assert.equal(error.body(), '{"error":"service_unavailable"}');
});
test("body deadline stops incomplete request before application invocation", async () => {
  const f = fixture({ timing: { bodyMs: 10 } });
  const x = await send(f, { method: "POST", holdInput: true });
  assert.equal(x.output.statusCode, 408); assert.equal(f.requests.length, 0);
});
test("whole-request deadline aborts a stalled handler, disposes late bytes and never retries", async () => {
  let finish!: (response: Response) => void, calls = 0, request: Request | undefined, cancelled = false;
  const f = fixture({ timing: { requestMs: 15 }, handler: input => {
    calls++; request = input; return new Promise(resolve => { finish = resolve; });
  } });
  const x = await send(f); assert.equal(x.output.destroyed, true); assert.equal(request?.signal.aborted, true);
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true); assert.equal(calls, 1);
});
test("client disconnect cancels response production, including backpressured output", async () => {
  let request: Request | undefined, cancelled = false;
  const f = fixture({ handler: input => { request = input; return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { cancelled = true; },
  })); } });
  const x = nodeExchange({ holdOutput: true }); const pending = f.server.handle(x.input, x.output);
  await new Promise(resolve => setImmediate(resolve)); x.output.destroy(); await pending;
  assert.equal(request?.signal.aborted, true); assert.equal(cancelled, true);
});
test("response byte ceiling destroys output and cancels the source", async () => {
  let cancelled = false;
  const f = fixture({ handler: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; },
  })) });
  const x = await send(f); assert.equal(x.output.destroyed, true); assert.equal(cancelled, true);
});
test("drain drops readiness, denies new admission and closes once after admitted output completes", async () => {
  let finish!: (response: Response) => void;
  const f = fixture({ handler: () => new Promise(resolve => { finish = resolve; }) });
  const x = nodeExchange(); const pending = f.server.handle(x.input, x.output);
  await new Promise(resolve => setImmediate(resolve));
  const close = f.server.close(); assert.equal(f.server.isReady(), false); assert.equal(f.closes, 0);
  assert.equal((await send(f)).output.statusCode, 503);
  finish(Response.json({ done: true })); await pending; await close;
  assert.equal(f.closes, 1); assert.equal(f.server.close(), close);
});
test("drain uncertainty aborts outstanding handlers and cannot be turned into a success", async () => {
  const f = fixture({ timing: { drainMs: 10 }, handler: () => new Promise(() => {}) });
  const x = nodeExchange(); const pending = f.server.handle(x.input, x.output);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.server.close(), /private_serving_drain_uncertain/); await pending;
  assert.equal(f.closes, 1); assert.equal(x.output.destroyed, true); assert.equal(f.server.isReady(), false);
});
test("serving configuration cannot extend production deadlines", () => {
  for (const timing of [{ requestMs: 30001 }, { bodyMs: 5001 }, { drainMs: 0 }, { bodyMs: NaN }])
    assert.throws(() => fixture({ timing }), /private_serving_config_invalid/);
  assert.throws(() => fixture({ origin: "http://private.example.invalid" }), /private_serving_config_invalid/);
});
test("64 active deliveries occupy capacity; excess never reaches the application", async () => {
  let calls = 0;
  const finishes: ((response: Response) => void)[] = [];
  const f = fixture({ handler: () => { calls++; return new Promise(resolve => { finishes.push(resolve); }); } });
  const pending = Array.from({ length: 64 }, () => { const x = nodeExchange(); return f.server.handle(x.input, x.output); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 64); assert.equal((await send(f)).output.statusCode, 503); assert.equal(calls, 64);
  for (const finish of finishes) finish(new Response("completed"));
  await Promise.all(pending); await f.server.close(); assert.equal(f.closes, 1);
});
