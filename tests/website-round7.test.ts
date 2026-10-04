import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { runInNewContext } from "node:vm";
import type { DatabaseClient, QueryResult } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { LocalOwnerSessionServiceV1, renderLocalOwnerSignOutPageV1, LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1, type MacLocalWebProcessOptionsV1 } from "../src/web/v1/mac-local-web-process";

const origin = "http://127.0.0.1:3210", now = Date.parse("2026-10-02T12:00:00.000Z");
const ownerCode = "synthetic-round7-owner-code-long-enough";
const profile = { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:r7",
  provider: "local", subject: "synthetic-owner", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 };
const render = () => { throw new Error("API must not reach page renderer"); };
const paths = ["/api/v1/passkeys/registration/options", "/api/v1/passkeys/registration", "/api/v1/local-owner-session"];
const noDatabase: DatabaseClient = {
  async query() { throw new Error("database must not be used"); },
  async transaction() { throw new Error("database must not be used"); },
  async transactionWithPreCommitCheck() { throw new Error("database must not be used"); },
};
async function fixture(overrides: Partial<MacLocalWebProcessOptionsV1> = {}) {
  let time = now, calls = 0;
  const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:r7", localOwnerSession: profile,
    database: { client: noDatabase, close: async () => {}, isAvailable: () => true }, clock: () => time,
    passkeyRegistration: { options: async () => { calls++; return { challenge: "synthetic" }; },
      insert: async () => { calls++; return { accepted: true }; } }, ...overrides });
  async function signIn() {
    const result = await app.handle(new Request(origin + paths[2], { method: "POST", headers: {
      origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), render);
    assert.equal(result.status, 201);
    return result.headers.get("set-cookie")!.split(";")[0]!;
  }
  const cookie = await signIn();
  const request = (path: string, init: RequestInit = {}, selectedCookie = cookie) => app.handle(new Request(origin + path, {
    ...init, headers: { cookie: selectedCookie, origin, "content-type": "application/json", ...init.headers },
  }), render);
  const attempt = (path = paths[0]!, body?: string, selectedCookie = cookie) => request(path, {
    method: path === paths[2] ? "DELETE" : "POST",
    ...(path === paths[2] ? {} : { body: body ?? JSON.stringify(path === paths[0] ? { registrationSecret: "A".repeat(43) }
      : { registrationSecret: "A".repeat(43), comparisonCode: "ABC234", response: {}, authorizationAssertion: null }) }),
  }, selectedCookie);
  return { app, request, attempt, signIn, cookie, calls: () => calls, advance: (ms: number) => { time += ms; } };
}
async function limited(response: Response, seconds = 60) {
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), String(seconds));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "owner_attempt_limit",
    message: `Too many attempts. Wait ${seconds} seconds before trying again.`, retryAfterSeconds: seconds });
}

for (const count of [10, 11, 50]) for (const path of paths) {
  test(`R7W-01: ${count} concurrent attempts on ${path}`, { timeout: 10000 }, async () => {
    const f = await fixture();
    try {
      // All callers start with a live session; concurrent sign-outs verify it
      // before any of them completes revocation.
      const responses = await Promise.all(Array.from({ length: count }, () => f.attempt(path)));
      const status = path === paths[0] ? 200 : path === paths[1] ? 201 : 204;
      assert.equal(responses.filter(r => r.status === status).length, 10);
      assert.equal(f.calls(), path === paths[2] ? 0 : 10);
      for (const response of responses.slice(10)) await limited(response);
      const retryCookie = path === paths[2] ? await f.signIn() : f.cookie;
      f.advance(59_001);
      await limited(await f.attempt(path, undefined, retryCookie), 1);
      f.advance(999);
      assert.equal((await f.attempt(path, undefined, retryCookie)).status, status,
        "exact window boundary releases budget despite the refused retries");
    } finally { await f.app.close(); }
  });
}

test("R7W-01: one budget across routes and sessions; sign-in remains independent", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 4; i++) assert.equal((await f.attempt()).status, 200);
    const otherCookie = await f.signIn();
    for (let i = 0; i < 4; i++) assert.equal((await f.attempt(paths[1], undefined, otherCookie)).status, 201);
    assert.equal((await f.attempt(paths[2])).status, 204);
    assert.equal((await f.attempt()).status, 401, "ended sessions cannot spend an attempt");
    assert.equal((await f.attempt(paths[0], undefined, otherCookie)).status, 200);
    for (const path of paths) await limited(await f.attempt(path, undefined, otherCookie));
    await f.signIn();
    await limited(await f.attempt(paths[0], undefined, otherCookie));
    f.advance(60_000);
    assert.equal((await f.attempt(paths[1], undefined, otherCookie)).status, 201);
  } finally { await f.app.close(); }
});

test("R7W-01: malformed and missing bodies count; foreign origins do not spend budget", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const path of paths) assert.equal((await f.request(path, { method: path === paths[2] ? "DELETE" : "POST",
      headers: { origin: "https://foreign.invalid" }, body: path === paths[2] ? undefined : "{}" })).status, 403);
    for (let i = 0; i < 5; i++) assert.equal((await f.attempt(paths[0], "{" )).status, 400);
    for (let i = 0; i < 5; i++) assert.equal((await f.request(paths[1]!, { method: "POST" })).status, 400);
    assert.equal(f.calls(), 0);
    await limited(await f.attempt());
    f.advance(60_000);
    assert.equal((await f.attempt()).status, 200);
  } finally { await f.app.close(); }
});

test("R7W-01: sliding expiry frees only old slots and installations have independent budgets", { timeout: 10000 }, async () => {
  const f = await fixture(), g = await fixture({ workspaceId: "workspace:r7-other",
    localOwnerSession: { ...profile, tenantId: "tenant:r7-other" } });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await f.attempt()).status, 200);
    f.advance(30_000);
    for (let i = 0; i < 5; i++) assert.equal((await f.attempt()).status, 200);
    await limited(await f.attempt(), 30);
    assert.equal((await g.attempt()).status, 200, "a separate installation service has an independent budget");
    f.advance(30_000);
    for (let i = 0; i < 5; i++) assert.equal((await f.attempt()).status, 200);
    await limited(await f.attempt(), 30);
    f.advance(30_000);
    assert.equal((await f.attempt()).status, 200);
  } finally { await f.app.close(); await g.app.close(); }
});

test("R7W-01: reused window preserves the existing sign-in failure policy", { timeout: 10000 }, async () => {
  const f = await fixture();
  const wrongCode = () => f.request(paths[2]!, { method: "POST", body: JSON.stringify({ ownerCode: "synthetic-wrong-owner-code-long-enough" }) });
  try {
    for (let i = 0; i < 4; i++) assert.equal((await wrongCode()).status, 401);
    await f.signIn(); // Correct sign-in still clears its own failure history.
    for (let i = 0; i < 5; i++) assert.equal((await wrongCode()).status, 401);
    const correct = () => f.request(paths[2]!, { method: "POST", body: JSON.stringify({ ownerCode }) });
    assert.equal((await correct()).status, 403);
    f.advance(59_001);
    assert.equal((await correct()).status, 403);
    f.advance(999);
    assert.equal((await correct()).status, 201);
    assert.equal((await f.attempt()).status, 200);
  } finally { await f.app.close(); }
});

test("R7W-01: slow bodies reserve slots before yielding; cancellation releases readers, not budget", { timeout: 10000 }, async () => {
  const f = await fixture();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const pending: Promise<Response>[] = [];
  try {
    for (let i = 0; i < 10; i++) pending.push(f.request(paths[0]!, { method: "POST", duplex: "half",
      body: new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } }),
    } as RequestInit));
    await limited(await f.attempt());
    streams.forEach(controller => controller.error(new Error("dropped request")));
    assert.ok((await Promise.all(pending)).every(r => r.status === 400));
    assert.equal(f.calls(), 0);
    await limited(await f.attempt());
    f.advance(60_000);
    assert.equal((await f.attempt()).status, 200);
  } finally {
    streams.forEach(controller => { try { controller.error(new Error("test ended")); } catch {} });
    await Promise.all(pending);
    await f.app.close();
  }
});

test("R7W-01: a few backend failures permit retries; storage sign-out is bounded under load", { timeout: 10000 }, async () => {
  let calls = 0, fail = true;
  const f = await fixture({ passkeyRegistration: { async options() { calls++; if (fail) throw new Error("outage"); return {}; },
    async insert() { return {}; } } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await f.attempt()).status, 503);
    fail = false;
    assert.equal((await f.attempt()).status, 200);
    assert.equal(calls, 4);
  } finally { await f.app.close(); }

  let releases: (() => void)[] = [], revokes = 0, revokeFails = true;
  const g = await fixture({ localOwnerSessionStore: { async save() {}, async load() { throw new Error("no external DB"); },
    async revoke() { revokes++; if (revokeFails) throw new Error("retryable failure");
      await new Promise<void>(resolve => releases.push(resolve)); } } });
  try {
    assert.equal((await g.attempt(paths[2])).status, 503);
    assert.equal((await g.attempt()).status, 200, "failed sign-out must preserve the session for a retry");
    revokeFails = false;
    const burst = Array.from({ length: 50 }, () => g.attempt(paths[2]));
    // Live verification now yields before reservation. Wait until all ten
    // remaining admissions/refusals finish, while the admitted revokes stay held.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(revokes, 9);
    releases.forEach(resolve => resolve()); releases = [];
    const results = await Promise.all(burst);
    assert.equal(results.filter(r => r.status === 204).length, 8);
    assert.equal(results.filter(r => r.status === 429).length, 42);
  } finally { releases.forEach(resolve => resolve()); await g.app.close(); }
});

/** Scripted database port, not SQL execution: exercise the real composed
 * session authority, project service, adapter and coordination HTTP handler.
 * Bind checks deliberately model scoped queries rather than returning every
 * synthetic project to every query. Real production-role DB proof is outside
 * this brief, which explicitly says no database. */
function coordinationDatabase() {
  let revoked = false, restricted = true, queries = 0, reads = 0;
  const query: DatabaseClient["query"] = async <T>(statement: string, params: unknown[] = []): Promise<QueryResult<T>> => {
    queries++;
    let rows: unknown[] = [];
    if (statement.includes("FROM control_identities")) rows = [{ id: "identity:r7" }];
    else if (statement.includes("SELECT identity_id")) rows = [{ identity_id: "identity:r7", revoked_at: revoked ? new Date(now).toISOString() : null,
      issued_at: new Date(now).toISOString(), expires_at: new Date(now + 900_000).toISOString() }];
    else if (statement.includes("FROM control_role_grants")) rows = [{ id: "grant:r7", role_key: "owner", allowed_actions: ["projects.read", "coordination.read"],
      project_ids: restricted ? ["project:r7", "project:other-workspace"] : ["*"], risk_ceiling: "high", allow_external_effects: false,
      require_strong_factor: false, expires_at: null, revoked_at: null }];
    else if (statement.includes("FROM projects p")) {
      const workspaceScoped = statement.includes("p.workspace_id=$2");
      const projectId = params[workspaceScoped ? 2 : 1];
      if (params[0] === profile.tenantId && (!workspaceScoped || params[1] === "workspace:r7")
        && (projectId === "project:r7" || !workspaceScoped && projectId === "project:other-workspace")) {
        rows = [{ id: projectId, projectId, adapter_id: `adapter:manual:${sha256Digest({ tenantId: profile.tenantId, workspaceId: "workspace:r7" }).slice(7, 39)}`,
          payload: {}, title: "Synthetic coordination project",
          summary: "Synthetic scoped data", lifecycle: "active", version: 1, created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(), createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }];
      }
    } else if (statement.includes("FROM control_project_coordinator_heads")) reads++;
    return { rows: rows as T[] };
  };
  const client: DatabaseClient = { query, transaction: async callback => callback({ query }),
    transactionWithPreCommitCheck: async (callback, check) => { const result = await callback({ query }); await check(); return result; } };
  return { client, revoke: () => { revoked = true; }, wildcard: () => { restricted = false; }, queries: () => queries, reads: () => reads };
}

test("R7W-02: composed coordination API returns data and refuses signed-out, foreign project/workspace and revoked session", { timeout: 10000 }, async () => {
  const db = coordinationDatabase();
  const f = await fixture({ database: { client: db.client, close: async () => {}, isAvailable: () => true } });
  const path = "/api/v1/projects/project:r7/coordination";
  try {
    assert.equal((await f.request(path, {}, "")).status, 401);
    const response = await f.request(path);
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.equal(data.project.projectId, "project:r7"); assert.equal(data.project.title, "Synthetic coordination project");
    assert.equal(data.coordinationEnabled, true); assert.deepEqual(data.activeWork, []);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const readCount = db.reads();
    assert.equal((await f.request("/api/v1/projects/project:other/coordination")).status, 403);
    assert.equal((await f.request("/api/v1/projects/project:other-workspace/coordination")).status, 404);
    assert.equal(db.reads(), readCount, "refused projects never reach coordination data reads");
    const beforeForeign = db.queries();
    assert.equal((await f.request(path + "/appoint-coordinator", { method: "POST", headers: { origin: "https://foreign.invalid" }, body: "{}" })).status, 403);
    assert.equal(db.queries(), beforeForeign, "foreign-origin writes must be refused before project/storage work");
    assert.equal((await f.app.handle(new Request(origin + path + "/appoint-coordinator", { method: "POST",
      headers: { cookie: f.cookie, "content-type": "application/json" }, body: "{}" }), render)).status, 403);
    assert.equal(db.queries(), beforeForeign, "missing-Origin writes must also be refused before project/storage work");
    assert.equal((await f.request(path + "/appoint-coordinator", { method: "POST", body: "{}" })).status, 400);
    assert.equal((await f.request(path + "?unexpected=1")).status, 400);
    assert.equal((await f.request("/api/v1/projects/%ZZ/coordination")).status, 404);
    db.wildcard();
    assert.equal((await f.request("/api/v1/projects/project:missing/coordination")).status, 404);
    const burst = await Promise.all(Array.from({ length: 50 }, () => f.request(path)));
    assert.ok(burst.every(r => r.status === 200));
    db.revoke();
    assert.equal((await f.request(path)).status, 401);
  } finally { await f.app.close(); }
});

const anonymousVariants: Array<[string, Record<string, string>, string, number]> = [
  ["A exact Origin, no cookie", { origin }, "", 401],
  ["B exact Origin, wrong cookie", { origin }, "control_room_local_owner=" + "B".repeat(43), 401],
  ["C exact Origin, malformed cookie", { origin }, "control_room_local_owner=notatoken", 401],
  ["D foreign Origin", { origin: "https://foreign.invalid" }, "", 403],
  ["E missing Origin", {}, "", 403],
  ["F cross-site", { origin, "sec-fetch-site": "cross-site" }, "", 403],
  ["G forwarded", { origin, "x-forwarded-for": "127.0.0.1" }, "", 403],
];
for (const path of paths) for (const [label, headers, cookie, refusal] of anonymousVariants) {
  test(`R7W-01: ${label} cannot spend owner budget at ${path}`, { timeout: 10000 }, async () => {
    const f = await fixture();
    try {
      const attack = () => f.app.handle(new Request(origin + path, {
        method: path === paths[2] ? "DELETE" : "POST", headers: { ...headers, cookie, "content-type": "application/json" },
        ...(path === paths[2] ? {} : { body: JSON.stringify({ registrationSecret: "A".repeat(43) }) }),
      }), render);
      const responses = await Promise.all(Array.from({ length: 50 }, attack));
      assert.ok(responses.every(response => response.status === refusal), responses.map(r => r.status).join(","));
      assert.equal(f.calls(), 0);
      // Pin the whole untouched budget, not just its next slot.
      const owners = await Promise.all(Array.from({ length: 10 }, () => f.attempt(path)));
      assert.ok(owners.every(r => r.status === (path === paths[0] ? 200 : path === paths[1] ? 201 : 204)));
      const retryCookie = path === paths[2] ? await f.signIn() : f.cookie;
      await limited(await f.attempt(path, undefined, retryCookie));
    } finally { await f.app.close(); }
  });
}

test("R7W-01: live verification must finish before admission on all three routes", { timeout: 10000 }, async t => {
  const verify = LocalOwnerSessionServiceV1.prototype.verifyLive;
  const admit = LocalOwnerSessionServiceV1.prototype.admitAuthenticationAttempt;
  const events: string[] = [];
  t.mock.method(LocalOwnerSessionServiceV1.prototype, "verifyLive", async function(this: LocalOwnerSessionServiceV1, request: Request, time: number) {
    events.push("verify-start");
    const identity = await verify.call(this, request, time);
    events.push("verify-end");
    return identity;
  });
  t.mock.method(LocalOwnerSessionServiceV1.prototype, "admitAuthenticationAttempt", function(this: LocalOwnerSessionServiceV1, request: Request, time: number) {
    events.push("admit");
    return admit.call(this, request, time);
  });
  const f = await fixture();
  try {
    for (const path of paths) {
      events.length = 0;
      assert.equal((await f.attempt(path)).status, path === paths[0] ? 200 : path === paths[1] ? 201 : 204);
      assert.deepEqual(events, ["verify-start", "verify-end", "admit"]);
    }
  } finally { await f.app.close(); }
});

test("R7W-01: limiter itself retains exact-Origin defence before reserving", { timeout: 10000 }, () => {
  const service = new LocalOwnerSessionServiceV1(profile);
  for (const originHeader of [undefined, "https://foreign.invalid"]) {
    const request = new Request(origin + paths[0], { method: "POST", headers: originHeader ? { origin: originHeader } : {} });
    for (let i = 0; i < 12; i++) assert.throws(() => service.admitAuthenticationAttempt(request, now), /access_denied/);
  }
  const valid = new Request(origin + paths[0], { method: "POST", headers: { origin } });
  for (let i = 0; i < 10; i++) service.admitAuthenticationAttempt(valid, now);
  assert.throws(() => service.admitAuthenticationAttempt(valid, now), /owner_attempt_limit/);
});

for (const { retryAfter, status } of ["37", null, "invalid", "0", "-1", "9007199254740992", "1e1", "1.0"].map(retryAfter =>
  ({ retryAfter, status: 429 })).concat([{ retryAfter: "37", status: 503 }, { retryAfter: null, status: 204 }, { retryAfter: null, status: 401 }])) {
  test(`R7W-01: sign-out renders Retry-After ${retryAfter} for ${status}`, { timeout: 10000 }, async () => {
    const dom = new JSDOM(await renderLocalOwnerSignOutPageV1("/session").text(), { url: origin + "/sign-out", runScripts: "outside-only" });
    try {
      let calls = 0, navigations = 0;
      dom.window.fetch = async () => {
        calls++;
        return new Response(null, { status, headers: retryAfter === null ? {} : { "retry-after": retryAfter } });
      };
      runInNewContext(dom.window.document.querySelector("script")!.textContent!, {
        document: dom.window.document, fetch: dom.window.fetch,
        location: { assign(target: string) { assert.equal(target, "/session"); navigations++; } },
      });
      const form = dom.window.document.getElementById("sign-out")!;
      form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      await new Promise<void>(resolve => setImmediate(resolve));
      const message = dom.window.document.getElementById("message")!.textContent!;
      if (status === 204 || status === 401) assert.equal(navigations, 1);
      else {
        assert.equal(navigations, 0);
        if (status === 429 && retryAfter === "37") assert.equal(message, "Too many tries — wait 37 seconds");
        else assert.match(message, /Could not sign out/);
        assert.equal(dom.window.document.querySelector("button")!.disabled, false);
      }
      assert.equal(calls, 1);
      assert.equal(dom.window.location.pathname, "/sign-out");
    } finally { dom.window.close(); }
  });
}

test("R7W-01: already-ended sign-outs are idempotent without spending a live owner's slots", { timeout: 10000 }, async () => {
  const persisted = new Map<string, { tokenDigest: string; issuedAt: string; expiresAt: string }>();
  const f = await fixture({ localOwnerSessionStore: {
    async save(session) { persisted.set(session.tokenDigest, session); },
    async load() { return [...persisted.values()]; },
    async revoke(digest) { persisted.delete(digest); },
  } });
  try {
    assert.equal((await f.attempt(paths[2])).status, 204);
    const cookie = await f.signIn();
    for (let i = 0; i < 50; i++) assert.equal((await f.attempt(paths[2])).status, 204);
    for (let i = 0; i < 9; i++) assert.equal((await f.attempt(paths[0], undefined, cookie)).status, 200);
    await limited(await f.attempt(paths[0], undefined, cookie));
  } finally { await f.app.close(); }
});

test("R7W-01: durably revoked cookies cannot reserve slots while a fresh session can", { timeout: 10000 }, async () => {
  const persisted = new Map<string, { tokenDigest: string; issuedAt: string; expiresAt: string }>();
  const f = await fixture({ localOwnerSessionStore: {
    async save(session) { persisted.set(session.tokenDigest, session); },
    async load() { return [...persisted.values()]; },
    async revoke(digest) { persisted.delete(digest); },
  } });
  try {
    persisted.clear();
    for (let i = 0; i < 50; i++) assert.equal((await f.attempt()).status, 401);
    const cookie = await f.signIn();
    for (let i = 0; i < 10; i++) assert.equal((await f.attempt(paths[0], undefined, cookie)).status, 200);
    await limited(await f.attempt(paths[0], undefined, cookie));
  } finally { await f.app.close(); }
});

test("R7W-01: routes reject missing Origin before starting live verification", { timeout: 10000 }, async t => {
  let checks = 0;
  t.mock.method(LocalOwnerSessionServiceV1.prototype, "verifyLive", () => { checks++; throw new Error("must not verify"); });
  const f = await fixture();
  try {
    for (const path of paths) {
      const result = await f.app.handle(new Request(origin + path, { method: path === paths[2] ? "DELETE" : "POST",
        headers: { cookie: f.cookie, "content-type": "application/json" },
        ...(path === paths[2] ? {} : { body: "{}" }),
      }), render);
      assert.equal(result.status, 403);
    }
    assert.equal(checks, 0);
  } finally { await f.app.close(); }
});

test("R7W-01: sign-out does not hide an unexpected verification failure", { timeout: 10000 }, async t => {
  const f = await fixture();
  const mock = t.mock.method(LocalOwnerSessionServiceV1.prototype, "verifyLive", () => { throw new Error("unexpected failure"); });
  try {
    assert.equal((await f.attempt(paths[2])).status, 503);
    mock.mock.restore();
    for (let i = 0; i < 10; i++) assert.equal((await f.attempt()).status, 200);
    await limited(await f.attempt());
  } finally { await f.app.close(); }
});

test("int10: a host without phone push configured answers the header's status read, and still refuses writes", async () => {
  // r7iui/r7ipol read this status from every page's header. Without phone push
  // configured the read must not be a 404 on every page and every 30-second check.
  const f = await fixture();
  const status = await f.request("/api/v1/owner-web-push");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { enabled: false, subscribed: false,
    message: "Phone notifications are not set up on this installation." });
  for (const method of ["POST", "DELETE"]) {
    const write = await f.request("/api/v1/owner-web-push", { method, body: JSON.stringify({ endpoint: "https://push.example/x" }) });
    assert.equal(write.status, 404, `${method} without phone push stays refused`);
  }
  assert.equal((await f.request("/api/v1/owner-web-push?x=1")).status, 404, "a status read with a query is still refused");
});
