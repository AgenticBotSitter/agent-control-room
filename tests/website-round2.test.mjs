import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import webpush from "web-push";
import { sha256Digest } from "../src/security/index.ts";
import { LOCAL_OWNER_SESSION_PROFILE_V1, renderLocalOwnerSignOutPageV1 } from "../src/web/v1/local-owner-session.ts";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process.ts";
import { createMacLocalNodeHandler, privateHttpLimits } from "../src/web/v1/private-node-handler.ts";
import { WebProjectService } from "../src/web/v1/project-service.ts";
import { createProjectSettingsBrowserClient } from "../src/web/v1/project-settings-browser-client.ts";
import { nodeExchange } from "./helpers/web-node.ts";

const origin = "http://127.0.0.1:3210", now = Date.parse("2026-10-01T00:00:00.000Z");
const code = "round2-synthetic-owner-code-for-tests";
const profile = { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:round2",
  provider: "local", subject: "test-owner", ownerCodeDigest: sha256Digest({ ownerCode: code }), sessionSeconds: 300 };
const request = (path, method = "GET", body, headers = {}) => new Request(origin + path, {
  method, headers: { origin, "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function fixture(t, extra = {}) {
  let queries = 0;
  const client = { query: async () => { queries++; return { rows: [] }; },
    transaction: async () => { throw new Error("test_database_boundary"); },
    transactionWithPreCommitCheck: async () => { throw new Error("test_database_boundary"); } };
  const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:round2", localOwnerSession: profile,
    database: { client, close: async () => {}, isAvailable: () => true }, clock: () => now,
    workerReadiness: { read: () => [] }, workBatchIntegrityKey: new Uint8Array(32).fill(1),
    fleet: { ownerAuthority: client }, ...extra });
  t.after(() => app.close());
  const send = r => app.handle(r, () => new Response("rendered"));
  return { app, send, queries: () => queries, signIn: async () => {
    const response = await send(request("/api/v1/local-owner-session", "POST", { ownerCode: code }));
    assert.equal(response.status, 201);
    return response.headers.get("set-cookie").split(";")[0];
  } };
}

async function transport(f, path, method, body, cookie, extra = {}) {
  const bytes = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  let handled = 0;
  const handler = createMacLocalNodeHandler({ origin, application: f.app,
    assets: { count: 0, digest: "test-empty", respond: () => undefined },
    handler: r => { handled++; return f.send(r); } });
  const headers = { Origin: origin, "Content-Type": "application/json", Cookie: cookie,
    ...(bytes === undefined ? {} : { "Content-Length": String(Buffer.byteLength(bytes)) }), ...extra };
  const exchange = nodeExchange({ path, method, body: bytes,
    headers: Object.entries(headers).filter(([, value]) => value !== undefined).flat() });
  let reads = 0;
  const read = exchange.input._read;
  exchange.input._read = function(size) { reads++; return read.call(this, size); };
  exchange.input.rawHeaders[1] = new URL(origin).host;
  try {
    await handler.handle(exchange.input, exchange.output);
    return { status: exchange.output.statusCode, body: exchange.body(), handled, reads };
  } finally { exchange.input.destroy(); exchange.output.destroy(); }
}

function pushFixture(t) {
  return fixture(t, { ownerWebPush: { subject: "mailto:test@example.invalid", ...webpush.generateVAPIDKeys() },
    ownerPushDispatch: false });
}

test("R2W-2: 50 stalled DELETE bodies time out, disconnect does not unsubscribe, and retry works", async t => {
  const f = pushFixture(t), cookie = await f.signIn();
  let calls = 0;
  const handler = createMacLocalNodeHandler({ origin, application: f.app,
    assets: { count: 0, digest: "test-empty", respond: () => undefined },
    timing: { bodyMs: 20, requestMs: 100, drainMs: 20 },
    handler: r => { calls++; return f.send(r); } });
  const exchange = () => {
    const e = nodeExchange({ path: "/api/v1/owner-web-push", method: "DELETE", holdInput: true,
      headers: ["Origin", origin, "Content-Type", "application/json", "Cookie", cookie, "Content-Length", "512"] });
    e.input.rawHeaders[1] = new URL(origin).host; return e;
  };
  const stalled = Array.from({ length: 50 }, exchange), dropped = exchange();
  try {
    await Promise.all(stalled.map(e => handler.handle(e.input, e.output)));
    assert.ok(stalled.every(e => e.output.statusCode === 408));
    const pending = handler.handle(dropped.input, dropped.output);
    dropped.input.push(Buffer.from('{"endpoint":'));
    dropped.input.destroy(new Error("test_disconnect"));
    await pending;
    assert.equal(calls, 0); assert.equal(f.queries(), 0);
    assert.equal((await transport(f, "/api/v1/owner-web-push", "DELETE",
      { endpoint: "https://fcm.googleapis.com/fcm/send/retry" }, cookie)).status, 204);
    assert.equal(f.queries(), 1);
  } finally {
    for (const e of [...stalled, dropped]) { e.input.destroy(); e.output.destroy(); }
  }
});

test("R2W-2: 50 authenticated unsubscribe requests cross the bounded Node wrapper", async t => {
  const f = pushFixture(t), cookie = await f.signIn();
  const responses = await Promise.all(Array.from({ length: 50 }, () => transport(f,
    "/api/v1/owner-web-push", "DELETE", { endpoint: "https://fcm.googleapis.com/fcm/send/test-fixture" }, cookie)));
  assert.ok(responses.every(r => r.status === 204 && r.handled === 1));
  assert.equal(f.queries(), 50);
});

test("R2W-2: DELETE exception keeps byte limits, other methods, sessions and exact write origins", async t => {
  const f = pushFixture(t), cookie = await f.signIn(), path = "/api/v1/owner-web-push";
  const body = { endpoint: "https://fcm.googleapis.com/fcm/send/test-fixture" };
  for (const extra of [{ Origin: undefined }, { Origin: "https://foreign.example.invalid" }, { "Sec-Fetch-Site": "cross-site" }])
    assert.equal((await transport(f, path, "DELETE", body, cookie, extra)).status, 403);
  assert.equal((await transport(f, path, "POST", {}, cookie, { Origin: undefined })).status, 403);
  assert.equal((await transport(f, path, "DELETE", body, "")).status, 401);
  assert.equal((await transport(f, path, "DELETE", " ".repeat(privateHttpLimits.bodyBytes + 1), cookie)).status, 413);
  assert.equal((await transport(f, path, "DELETE", {}, cookie)).status, 400);
  assert.equal((await transport(f, path, "DELETE", " ".repeat(privateHttpLimits.bodyBytes + 1), cookie,
    { "Content-Length": undefined, "Transfer-Encoding": "chunked" })).status, 413);
  for (const [otherPath, method] of [[path, "GET"], ["/api/v1/local-owner-session", "DELETE"], [path + "?x=1", "DELETE"]]) {
    const response = await transport(f, otherPath, method, body, cookie);
    assert.equal(response.status, 400);
    assert.equal(response.handled, 0, "only the exact unsubscribe path permits a DELETE body");
    assert.equal(response.reads, 0, "a forbidden framed body is refused before consuming bytes");
  }
  const unframed = await transport(f, "/api/v1/local-owner-session", "DELETE", body, cookie,
    { "Content-Length": undefined });
  assert.equal(unframed.status, 400); assert.equal(unframed.handled, 0);
  assert.equal(f.queries(), 0);
  assert.equal((await transport(f, path, "DELETE", body, cookie)).status, 204, "retry after refusals works");
  assert.equal((await transport(f, path, "DELETE", body, cookie,
    { "Content-Length": undefined, "Transfer-Encoding": "chunked" })).status, 204);
  assert.equal(f.queries(), 2);
});

test("R2W-3: browser project settings and planner retry reach their mounted handlers", async t => {
  const calls = [], projectId = "project:round2";
  const settings = { projectId, version: 0, eligibleWorkerKinds: null, maxConcurrentTasks: null,
    defaultWorkerKind: null, defaultModel: null, defaultEffort: null, updatedAt: new Date(now).toISOString() };
  // Storage is mocked; the real browser client, transport, application and route handlers run.
  t.mock.method(WebProjectService.prototype, "readSettings", async (_identity, id) => {
    calls.push(["read", id]); return settings;
  });
  t.mock.method(WebProjectService.prototype, "updateSettings", async (_identity, id, draft) => {
    calls.push(["save", id, draft]); return { ...settings, version: draft.expectedVersion + 1 };
  });
  let retries = 0;
  const f = fixture(t, { orchestration: {
    readSettings: async () => ({ enabled: true }),
    retryEscalated: async () => { retries++; return { outcome: "retry_granted" }; },
  } }), cookie = await f.signIn();
  const browser = createProjectSettingsBrowserClient(async (path, options) => {
    const response = await transport(f, path, options.method, options.body, cookie);
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  });
  assert.deepEqual(await browser.read(projectId), settings);
  const draft = { expectedVersion: 0, eligibleWorkerKinds: null, maxConcurrentTasks: null,
    defaultWorkerKind: null, defaultModel: null, defaultEffort: null };
  assert.equal((await browser.save(projectId, draft)).version, 1);
  assert.deepEqual(calls, [["read", projectId], ["save", projectId, draft]]);
  const retryPath = `/api/v1/projects/${encodeURIComponent(projectId)}/orchestration-retry`;
  const responses = await Promise.all(Array.from({ length: 50 }, () => transport(f, retryPath, "POST", { description: "Retry planning" }, cookie)));
  assert.ok(responses.every(r => r.status === 200));
  assert.equal(retries, 50, "the router forwards each request exactly once; the owner service governs retry authority");
  assert.equal((await transport(f, "/api/v1/projects/%ZZ/settings", "GET", undefined, cookie)).status, 400);
  assert.equal((await transport(f, retryPath, "POST", "{", cookie)).status, 400);
  for (const [path, method] of [[`/api/v1/projects/${encodeURIComponent(projectId)}/settings`, "GET"], [retryPath, "POST"]]) {
    assert.equal((await transport(f, path, method, method === "POST" ? {} : undefined, "")).status, 401);
    assert.equal((await transport(f, path, method, method === "POST" ? {} : undefined, cookie,
      { Origin: "https://foreign.example.invalid" })).status, 403);
  }
  assert.equal(calls.length, 2); assert.equal(retries, 50);
});

test("R2W-4: failed sign-out stays on the page, reports failure and retries durable revocation", async t => {
  for (const target of ["/session", "/cdn-cgi/access/logout"]) {
    let fail = true;
    const f = fixture(t, { localOwnerSessionStore: { save: async () => {}, revoke: async () => {
      if (fail) throw new Error("test_persistence_failure");
    } } }), cookie = await f.signIn();
    const html = await renderLocalOwnerSignOutPageV1(target).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const message = { textContent: "" }; let submit, location, networkFailure = false;
    runInNewContext(script, {
      document: { getElementById: id => id === "message" ? message : { addEventListener: (_event, fn) => { submit = fn; },
        querySelector: () => ({ disabled: false }) } },
      fetch: async (path, options) => {
        if (networkFailure) throw new Error("test_network_failure");
        return f.send(request(path, options.method, undefined, { cookie }));
      }, location: { assign: path => { location = path; } },
    });
    await Promise.all(Array.from({ length: 20 }, () => submit({ preventDefault() {} })));
    assert.equal(location, undefined); assert.match(message.textContent, /sign.out.*failed|could not sign.*out/i);
    assert.equal((await f.send(request("/api/v1/local-workers", "GET", undefined, { cookie }))).status, 200);
    networkFailure = true; message.textContent = "";
    await submit({ preventDefault() {} });
    assert.equal(location, undefined); assert.match(message.textContent, /sign.out.*failed|could not sign.*out/i);
    networkFailure = false;
    fail = false; await submit({ preventDefault() {} });
    assert.equal(location, target);
    assert.equal((await f.send(request("/api/v1/local-workers", "GET", undefined, { cookie }))).status, 401);
  }
});
