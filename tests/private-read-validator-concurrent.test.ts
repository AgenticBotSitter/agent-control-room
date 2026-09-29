import assert from "node:assert/strict";
import test from "node:test";
import { now, origin, trust, token } from "./helpers/web-foundation";
import { limitedWebFixture } from "./helpers/web-startup";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import type { AccessTrust } from "../src/web/v1/access-verifier";
import { createPolledReadFetch } from "../src/web/v1/polled-conditional-fetch";

/**
 * The validator scope is bound per request. A single shared variable would let
 * one concurrent request's scope be consumed by another request's response,
 * which shows up only under concurrency — and this is the exact shape of the
 * load test. These tests therefore assert on concurrent reads, not sequential
 * ones, because a sequential test cannot see the bug.
 */

const clock = () => now;

/**
 * The fixture's single in-process database connection is shared behind the real
 * bounded pool, so several requests can be in flight at once. PGlite has one
 * connection, so this is the only honest way to exercise concurrent reads here;
 * the real multi-connection pool is exercised by the load test.
 */
async function fixture(): Promise<Awaited<ReturnType<typeof limitedWebFixture>> & {
  application: ReturnType<typeof createPrivateWebProcess>;
  handler: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
}> {
  // `limitedWebFixture` is the repository's own fully-composed web fixture: the
  // real migration ledger, the real least-privilege role, and the real bounded
  // pool. Composing anything less here would make a 503 look like a regression.
  const f = await limitedWebFixture();
  const application = createPrivateWebProcess({ origin, issuer: trust.issuer, audience: trust.audience,
    tenantId: "tenant:web", workspaceId: "workspace:web", maxSessionSeconds: trust.maxSessionSeconds, clock,
    loadKeys: async () => trust.keys as AccessTrust["keys"],
    database: f.pool });
  const handler = (request: Request) => application.handle(request, () => new Response("shell"));
  return { ...f, application, handler, close: async () => { await application.close(); await f.pool.close(); } };
}

/** Issues one request through the real dispatch and returns status plus headers. */
async function call(handler: (request: Request) => Promise<Response>, path: string, jwt: string, conditional?: string) {
  const request = new Request(`${origin}${path}`, { method: "GET", headers: {
    origin, "cf-access-jwt-assertion": jwt, accept: "application/json",
    ...(conditional ? { "if-none-match": conditional } : {}) } });
  const response = await handler(request);
  const body = await response.text();
  return { status: response.status, etag: response.headers.get("etag"),
    cacheControl: response.headers.get("cache-control"), body };
}

test("concurrent reads each get their own validator rather than stealing one", async t => {
  const f = await fixture();
  t.after(f.close);
  // Several distinct endpoints in flight at once, from several sessions, which
  // is what several open clients actually do to this process. These are the
  // endpoints the measured owner pages poll and that this fixture can serve.
  const results = await Promise.all([
    call(f.handler, "/api/v1/projects", token()),
    call(f.handler, "/api/v1/home/tasks", token()),
    call(f.handler, "/api/v1/needs-me/tasks", token()),
    call(f.handler, "/api/v1/projects", token()),
    call(f.handler, "/api/v1/home/tasks", token()),
  ]);
  for (const result of results) assert.equal(result.status, 200, result.body);
  // A dropped scope shows up as a missing etag on exactly the requests that raced.
  for (const result of results) assert.ok(result.etag, "every concurrent read must receive its own validator");
  for (const result of results) assert.equal(result.cacheControl, "no-store", "no-store is never relaxed");
  // Each distinct endpoint must carry its own validator: a shared scope would
  // make two different endpoints produce the same value.
  assert.notEqual(results[0]!.etag, results[1]!.etag, "different endpoints never share a validator");
});

test("interleaved sessions revalidate only with their own request scope", async t => {
  const f = await fixture();
  t.after(f.close);
  const sessions = [token(), token({ iat: now / 1000 - 10 })];
  const paths = ["/api/v1/projects", "/api/v1/home/tasks", "/api/v1/needs-me/tasks"];
  const plan = sessions.flatMap(jwt => paths.map(path => ({ jwt, path })));
  const first = await Promise.all(plan.map(({ jwt, path }) => call(f.handler, path, jwt)));
  for (const result of first) {
    assert.equal(result.status, 200, result.body);
    assert.ok(result.etag, "every interleaved request receives a validator");
  }
  for (const [index, { jwt, path }] of plan.entries()) {
    const revalidated = await call(f.handler, path, jwt, first[index]!.etag!);
    assert.equal(revalidated.status, 304,
      `request ${index} must revalidate with its own session scope, not a process-wide last scope`);
  }
});

test("an unchanged read revalidates to 304, and changed data is never hidden", async t => {
  const f = await fixture();
  t.after(f.close);
  const jwt = token();
  const first = await call(f.handler, "/api/v1/projects", jwt);
  assert.equal(first.status, 200);
  assert.ok(first.etag);
  const second = await call(f.handler, "/api/v1/projects", jwt, first.etag!);
  assert.equal(second.status, 304, "unchanged data revalidates to 304");
  assert.equal(second.body, "", "a 304 carries no body");
  assert.equal(second.cacheControl, "no-store", "a 304 is as uncacheable as the 200 it replaces");
  // A brand new token over the same owner is a different session, and its
  // validator scope differs, so the previous session's validator must not match.
  const other = await call(f.handler, "/api/v1/projects", token({ iat: now / 1000 - 30 }), first.etag!);
  assert.equal(other.status, 200, "a validator must not be honoured for another session");
  assert.notEqual(other.etag, first.etag, "a new session gets a validator of its own");
});

test("the product polling transport reuses 304 data, refreshes changed data, and refuses cross-identity reuse", async t => {
  const f = await fixture();
  t.after(f.close);
  let jwt = token();
  const statuses: number[] = [];
  const transport: typeof fetch = async (input, init) => {
    const path = input instanceof Request ? new URL(input.url).pathname + new URL(input.url).search : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("origin", origin);
    headers.set("cf-access-jwt-assertion", jwt);
    const response = await f.handler(new Request(new URL(path, origin), { ...init, headers }));
    statuses.push(response.status);
    return response;
  };
  const polled = createPolledReadFetch(transport);
  const readProjects = async () => {
    const response = await polled("/api/v1/projects", { method: "GET", headers: { accept: "application/json" } });
    return { status: response.status, body: await response.json() as { projects: unknown[] } };
  };

  const first = await readProjects();
  const unchanged = await readProjects();
  assert.deepEqual(statuses.slice(0, 2), [200, 304], "the second unchanged HTTP request is conditional");
  assert.deepEqual(unchanged, first, "the polling reader keeps the validated body across a 304");

  const created = await f.handler(new Request(`${origin}/api/v1/projects`, { method: "POST", headers: {
    origin, "cf-access-jwt-assertion": jwt, "content-type": "application/json", "idempotency-key": "conditional-client-change-1" },
  body: JSON.stringify({ title: "Changed project", summary: "A new representation" }) }));
  assert.equal(created.status, 201, await created.text());
  const changed = await readProjects();
  assert.equal(statuses.at(-1), 200, "a changed resource returns a fresh 200");
  assert.notDeepEqual(changed.body, first.body, "the changed representation replaces the held body");

  jwt = token({ sub: "different-owner" });
  const denied = await polled("/api/v1/projects", { method: "GET", headers: { accept: "application/json" } });
  assert.equal(statuses.at(-1), 403, "another identity cannot match the prior identity's validator");
  assert.equal(denied.status, 403, "a denial is returned, never the cached successful body");
});

test("a write response is never given a validator", async t => {
  const f = await fixture();
  t.after(f.close);
  const request = new Request(`${origin}/api/v1/projects`, { method: "POST",
    headers: { origin, "cf-access-jwt-assertion": token(), "content-type": "application/json",
      "idempotency-key": "concurrent-test-key-1" },
    body: JSON.stringify({ title: "A project", summary: "A summary" }) });
  const created = await f.handler(request);
  const body = await created.text();
  assert.equal(created.status, 201, body);
  assert.equal(created.headers.get("etag"), null, "a write response carries no validator");
  assert.equal(created.headers.get("cache-control"), "no-store");
});
