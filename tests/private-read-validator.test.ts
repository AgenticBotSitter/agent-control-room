import assert from "node:assert/strict";
import test from "node:test";
import { privateResponseHeaders } from "../src/web/v1/http-common";
import { applyReadValidator, ifNoneMatchMatches, notModifiedResponse,
  readValidatorFor, readValidatorScope } from "../src/web/v1/private-read-validator";

const origin = "https://control.example";
const tokenA = `sha256:${"a".repeat(64)}`;
const tokenB = `sha256:${"b".repeat(64)}`;

const read = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`${origin}${path}`, { method, headers });

const json = (value: unknown, headers: Record<string, string> = {}) =>
  Response.json(value, { headers: { ...privateResponseHeaders, ...headers } });

const scopeFor = (token: string, path: string, search = "") =>
  readValidatorScope(token, "GET", path, search);

test("a scope digest is stable for one identity and request, and never equal across identities", () => {
  const first = scopeFor(tokenA, "/api/v1/projects");
  assert.equal(first, scopeFor(tokenA, "/api/v1/projects"), "stable for the same identity and request");
  assert.notEqual(first, scopeFor(tokenB, "/api/v1/projects"),
    "two sessions must never share a scope, or a validator could cross sessions");
  assert.notEqual(first, scopeFor(tokenA, "/api/v1/connections"),
    "different endpoints must never share a scope");
  assert.notEqual(scopeFor(tokenA, "/api/v1/projects", "?a=1"), scopeFor(tokenA, "/api/v1/projects", "?a=2"),
    "different queries must never share a scope");
  assert.notEqual(scopeFor(tokenA, "/api/v1/projects"), readValidatorScope(tokenA, "POST", "/api/v1/projects", ""),
    "the method is part of the scope");
  assert.match(first, /^[0-9a-f]{64}$/, "a scope is a digest, never a token");
});

test("a scope is refused when the identity digest is not a verified digest", () => {
  for (const bad of ["", "sha256:short", "a".repeat(64), `sha256:${"A".repeat(64)}`, "sha256:" + "z".repeat(64)])
    assert.throws(() => readValidatorScope(bad, "GET", "/api/v1/projects", ""), /read_validator_scope_invalid/, bad);
});

test("a validator presented by one session can never satisfy another session's read", async () => {
  const path = "/api/v1/projects";
  // Session A reads, and receives a validator.
  const first = await applyReadValidator(read(path), json({ projects: [] }), scopeFor(tokenA, path), privateResponseHeaders);
  assert.equal(first.validated, true);
  const validatorA = first.response.headers.get("etag");
  assert.ok(validatorA, "an authorized JSON read carries a validator");
  // Session B presents session A's validator for the same URL.
  const second = await applyReadValidator(read(path, { "if-none-match": validatorA! }),
    json({ projects: [] }), scopeFor(tokenB, path), privateResponseHeaders);
  assert.equal(second.notModified, false, "a validator must not cross sessions");
  assert.equal(second.response.status, 200, "so the full representation is returned instead");
});

test("a validator from a previous session cannot be replayed after a sign-out", async () => {
  const path = "/api/v1/projects";
  // The session that signed out.
  const before = await applyReadValidator(read(path), json({ projects: [] }),
    scopeFor(tokenA, path), privateResponseHeaders);
  const stale = before.response.headers.get("etag")!;
  // The next session replays it. A new session has a new tokenDigest, so its
  // scope differs and the stale validator cannot match.
  const after = await applyReadValidator(read(path, { "if-none-match": stale }),
    json({ projects: [] }), scopeFor(tokenB, path), privateResponseHeaders);
  assert.equal(after.notModified, false, "a validator must not survive a sign-out");
  assert.equal(after.response.status, 200);
  assert.notEqual(after.response.headers.get("etag"), stale, "and it gets a validator of its own");
});

test("an unchanged read with a matching validator returns 304 and no body", async () => {
  const path = "/api/v1/connections";
  const body = { connections: [{ id: "node:one" }] };
  const scope = scopeFor(tokenA, path);
  const first = await applyReadValidator(read(path), json(body), scope, privateResponseHeaders);
  const validator = first.response.headers.get("etag")!;
  assert.equal(await first.response.text(), JSON.stringify(body), "the first read carries the body");

  const second = await applyReadValidator(read(path, { "if-none-match": validator }), json(body), scope, privateResponseHeaders);
  assert.equal(second.notModified, true);
  assert.equal(second.response.status, 304);
  assert.equal(second.response.headers.get("etag"), validator);
  assert.equal(await second.response.text(), "", "a 304 must have no body");
  assert.equal(second.response.body, null, "not an empty body: no body at all");
});

test("a 304 preserves the private response policy, including no-store", async () => {
  const path = "/api/v1/connections";
  const scope = scopeFor(tokenA, path);
  const first = await applyReadValidator(read(path), json({ connections: [] }), scope, privateResponseHeaders);
  const validator = first.response.headers.get("etag")!;
  const second = await applyReadValidator(read(path, { "if-none-match": validator }),
    json({ connections: [] }), scope, privateResponseHeaders);
  assert.equal(second.response.headers.get("cache-control"), "no-store",
    "a 304 must be exactly as uncacheable as the 200 it replaces");
  assert.equal(second.response.headers.get("x-robots-tag"), privateResponseHeaders["x-robots-tag"]);
  assert.equal(second.response.headers.get("referrer-policy"), privateResponseHeaders["referrer-policy"]);
  assert.equal(second.response.headers.get("x-content-type-options"), "nosniff");
});

test("a 200 that carries a validator never relaxes cache-control", async () => {
  const path = "/api/v1/connections";
  const outcome = await applyReadValidator(read(path), json({ connections: [] }), scopeFor(tokenA, path), privateResponseHeaders);
  assert.equal(outcome.response.status, 200);
  assert.ok(outcome.response.headers.get("etag"), "the validator is added");
  assert.equal(outcome.response.headers.get("cache-control"), "no-store", "and nothing else changes");
});

test("changed data is never answered with 304, even under a matching-looking validator", async () => {
  const path = "/api/v1/connections";
  const scope = scopeFor(tokenA, path);
  const before = await applyReadValidator(read(path), json({ connections: [{ id: "node:one" }] }), scope, privateResponseHeaders);
  const validator = before.response.headers.get("etag")!;
  // Same validator, different body: the data changed, so the client must get it.
  const after = await applyReadValidator(read(path, { "if-none-match": validator }),
    json({ connections: [{ id: "node:two" }] }), scope, privateResponseHeaders);
  assert.equal(after.notModified, false, "changed data must be sent, not hidden behind a 304");
  assert.equal(after.response.status, 200);
  assert.notEqual(after.response.headers.get("etag"), validator, "a changed body gets a new validator");
});

test("only an exact strong validator matches; *, weak and multi-value forms never do", () => {
  const validator = readValidatorFor("scope", "body");
  assert.equal(ifNoneMatchMatches(validator, validator), true);
  assert.equal(ifNoneMatchMatches(`  ${validator}  `, validator), true, "surrounding whitespace is tolerated");
  assert.equal(ifNoneMatchMatches("*", validator), false, "* must not short-circuit a protected read");
  assert.equal(ifNoneMatchMatches(`W/${validator}`, validator), false, "a weak validator is not our strong one");
  assert.equal(ifNoneMatchMatches(`"other", ${validator}`, validator), false, "a list is not treated as our value");
  assert.equal(ifNoneMatchMatches(validator.slice(0, -1), validator), false);
  assert.equal(ifNoneMatchMatches(`${validator}extra`, validator), false, "no prefix matching");
  assert.equal(ifNoneMatchMatches(null, validator), false);
  assert.equal(ifNoneMatchMatches("", validator), false);
  assert.equal(ifNoneMatchMatches("x".repeat(9000), validator), false, "an oversized header is refused");
  assert.equal(ifNoneMatchMatches('"unterminated', validator), false, "a malformed validator is refused");
});

test("non-GET, error and non-JSON responses are passed through with no validator", async () => {
  const scope = scopeFor(tokenA, "/api/v1/projects");
  const post = await applyReadValidator(read("/api/v1/projects", { "if-none-match": '"anything"' }, "POST"),
    json({ ok: true }), scope, privateResponseHeaders);
  assert.equal(post.validated, false, "a write response is never validated");
  assert.equal(post.response.status, 200);
  assert.equal(post.response.headers.get("etag"), null);

  const head = await applyReadValidator(read("/api/v1/projects", {}, "HEAD"), json({ ok: true }), scope, privateResponseHeaders);
  assert.equal(head.validated, false, "HEAD has no body to hash");

  for (const status of [400, 401, 403, 404, 409, 500, 503]) {
    const failure = await applyReadValidator(read("/api/v1/projects"),
      Response.json({ error: "service_unavailable" }, { status, headers: privateResponseHeaders }),
      scope, privateResponseHeaders);
    assert.equal(failure.validated, false, `a ${status} must never become a 304`);
    assert.equal(failure.response.status, status, "and must not be masked");
    assert.equal(failure.response.headers.get("etag"), null);
  }

  const text = await applyReadValidator(read("/api/v1/projects"),
    new Response("plain text", { headers: { ...privateResponseHeaders, "content-type": "text/plain" } }),
    scope, privateResponseHeaders);
  assert.equal(text.validated, false, "a non-JSON read is not validated");

  const stream = await applyReadValidator(read("/api/v1/projects"),
    new Response(null, { status: 200, headers: { ...privateResponseHeaders, "content-type": "application/json" } }),
    scope, privateResponseHeaders);
  assert.equal(stream.validated, false, "a bodyless response is not validated");
});

test("an oversized body is returned unchanged rather than buffered to be hashed", async () => {
  const path = "/api/v1/projects";
  const big = "x".repeat(1_048_577);
  const outcome = await applyReadValidator(read(path, { "if-none-match": '"stale"' }),
    new Response(JSON.stringify({ big }), { headers: { ...privateResponseHeaders, "content-type": "application/json" } }),
    scopeFor(tokenA, path), privateResponseHeaders);
  assert.equal(outcome.validated, false, "a body over the limit is not hashed");
  assert.equal(outcome.response.status, 200);
  assert.equal(outcome.response.headers.get("etag"), null);
});

test("a 304 response is built from the caller's policy headers and carries no body", async () => {
  const validator = readValidatorFor("scope", "{}");
  const response = notModifiedResponse(validator, privateResponseHeaders);
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), validator);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.body, null);
});
