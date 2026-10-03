import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { EventEmitter } from "node:events";
import { createWebPushChannelV1, ownerPushPayloadV1, ownerPushDedupeKeyV1 } from "../src/web-push/v1";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { sha256Digest } from "../src/security";
import { UpdaterAlertSenderV1, UPDATER_PUSH_TEMPLATES_V1 } from "../src/updater/v1/alerts.mjs";
import { now, vapid, subscription, uid, AlertStore, scratch } from "./support/owner-notify-fixtures";

function interceptHttps(t: any, statusCode = 201) {
  const original = https.request, options: any[] = [];
  https.request = ((value: any, callback: any) => {
    options.push(value);
    const request: any = new EventEmitter();
    request.write = () => true;
    request.destroy = (error: Error) => request.emit("error", error);
    request.end = () => queueMicrotask(() => {
      const response: any = new EventEmitter(); response.statusCode = statusCode; response.headers = {};
      callback(response); response.emit("end");
    });
    return request;
  }) as any;
  t.after(() => { https.request = original; });
  return options;
}

test("N01/N07/U02: real library constructs 50 attention requests with valid topics, day TTL and bounded transport", async t => {
  const requests = interceptHttps(t), channel = createWebPushChannelV1(vapid);
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => channel.send(subscription,
    ownerPushPayloadV1("needs_you", "/needs-me", ownerPushDedupeKeyV1(`attention:item-${i}`)))));
  assert.equal(results.filter(r => r.statusCode === 201).length, 50);
  assert.equal(requests.length, 50);
  for (const request of requests) {
    assert.ok(request.headers.Topic === undefined || /^[A-Za-z0-9_-]{1,32}$/.test(request.headers.Topic));
    assert.ok(request.headers.TTL >= 86400); assert.ok(request.timeout > 0 && request.timeout < 300000);
  }
});

test("N01/N07/U02: actual updater default sender constructs every fixed alert through real web-push", async t => {
  const root = await scratch(t), requests = interceptHttps(t);
  const rows = Object.keys(UPDATER_PUSH_TEMPLATES_V1).map((template, i) => ({ id: uid(i + 1), template, attempts: 0 }));
  const sender = new UpdaterAlertSenderV1({ root, store: new AlertStore(rows), loadVapid: async () => vapid, now: () => now } as any);
  assert.equal((await sender.tick()).sent, rows.length);
  assert.equal(requests.length, rows.length);
  assert.ok(rows.every((r: any) => r.sent));
  for (const request of requests) {
    assert.ok(request.headers.Topic === undefined || /^[A-Za-z0-9_-]{1,32}$/.test(request.headers.Topic));
    assert.ok(request.headers.TTL >= 86400); assert.ok(request.timeout > 0 && request.timeout < 300000);
  }
});

test("N02: authenticated test requires this browser and reports provider acceptance honestly", async t => {
  const requests = interceptHttps(t, 503);
  for (const targets of [[], [subscription]]) {
    const client = { async query(sql: string) { return { rows: sql.startsWith("SELECT id,tenant_id,endpoint") ? targets.map(s => ({ ...s, tenant_id: s.tenantId, expires_at: null })) : [] }; } };
    const origin = "http://127.0.0.1:4321", ownerCode = "fixture-owner-code-long-enough";
    const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:fixture", database: { client: client as any, close: async () => {}, isAvailable: () => true },
      localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: subscription.tenantId, provider: "fixture", subject: "fixture-owner", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
      ownerWebPush: vapid, ownerPushDispatch: false, clock: () => now });
    t.after(() => app.close());
    const login = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), () => new Response());
    const cookie = login.headers.get("set-cookie")!;
    const call = (path: string, body: any) => app.handle(new Request(`${origin}/api/v1/owner-web-push/${path}`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), () => new Response());
    assert.equal((await call("test", { endpoint: subscription.endpoint })).status, 503);
    assert.equal((await call("test", { endpoint: "https://evil.invalid/push" })).status, 400);
    assert.equal((await call("test", {})).status, 400);
    assert.equal((await call("test", { endpoint: subscription.endpoint, extra: true })).status, 400);
    assert.equal((await app.handle(new Request(`${origin}/api/v1/owner-web-push/test`, { headers: { origin, cookie } }), () => new Response())).status, 400);
    assert.equal((await (await call("status", { endpoint: subscription.endpoint })).json()).subscribed, targets.length > 0);
  }
  assert.equal(requests.length, 1, "only a saved browser can be tested");
});

test("N02: 50 concurrent authenticated tests target only this browser with unique events", async t => {
  const requests = interceptHttps(t), keys = new Set<string>();
  const other = { ...subscription, id: "push:other", endpoint: "https://fcm.googleapis.com/fcm/send/other" };
  const client = { async query(sql: string, args?: any[]) {
    if (sql.startsWith("SELECT id,tenant_id,endpoint")) return { rows: [subscription, other].map(s => ({ ...s, tenant_id: s.tenantId, expires_at: null })) };
    if (sql.startsWith("INSERT INTO owner_web_push_deliveries")) keys.add(args![2]);
    return { rows: [] };
  } };
  const origin = "http://127.0.0.1:4321", ownerCode = "fixture-owner-code-long-enough";
  const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:fixture", database: { client: client as any, close: async () => {}, isAvailable: () => true },
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: subscription.tenantId, provider: "fixture", subject: "fixture-owner", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    ownerWebPush: vapid, ownerPushDispatch: false, clock: () => now });
  t.after(() => app.close());
  const login = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), () => new Response());
  const cookie = login.headers.get("set-cookie")!;
  const responses = await Promise.all(Array.from({ length: 50 }, () => app.handle(new Request(`${origin}/api/v1/owner-web-push/test`, {
    method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) }), () => new Response())));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(requests.length, 50); assert.equal(keys.size, 50);
  assert.ok(requests.every(request => request.path.endsWith("/fixture")));
});
