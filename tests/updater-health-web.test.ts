import assert from "node:assert/strict";
import test from "node:test";
import { createHealthNonceV1, healthRequestTagV1, healthResponseTagMatchesV1, healthResponseTagV1,
  LOCAL_HOST_HEALTH_ENDPOINT_V1, LOCAL_HOST_HEALTH_PURPOSE_V1, UPDATER_HEALTH_ENDPOINT_V1 }
  from "../src/updater/v1/health-protocol.mjs";
import { hmacSha256Tag } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { sha256Digest } from "../src/security";

const NOW = Date.parse("2026-09-30T18:00:00.000Z"), ORIGIN = "http://127.0.0.1:7864";
const KEY = new Uint8Array(32).fill(11);

function app() {
  return createMacLocalWebProcessV1({ origin: ORIGIN, workspaceId: "workspace-health",
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: ORIGIN, tenantId: "tenant-health",
      provider: "local", subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode: "owner-code-long-enough" }),
      sessionSeconds: 900 }, database: { client: {} as never, close: async () => {}, isAvailable: () => true }, clock: () => NOW,
    hostProcessId: 4243, healthProbeKey: KEY, healthReleaseId: "release-good",
    healthStartedAt: "2026-09-30T17:59:59.500Z",
    updaterHealthReadPort: { readHealthCounts: async ({ tenantId, workspaceId }) => {
      assert.deepEqual({ tenantId, workspaceId }, { tenantId: "tenant-health", workspaceId: "workspace-health" });
      return { homeSummaryCount: 4, projectCount: 3, updatesPanelCount: 2,
        homeRenderBytes: 8192, planApprovalInsertAllowed: true };
    } } });
}

function nonce(index = 0, at = NOW) {
  return createHealthNonceV1(at, size => { const bytes = Buffer.alloc(size); bytes.writeUInt32BE(index, size - 4); return bytes; });
}

function request(endpoint: string, value: unknown) {
  return new Request(`${ORIGIN}${endpoint}`, { method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(value) });
}

/** The SIGNED protocol, which is `/api/v1/updater-health`'s and only its. */
function authenticated(endpoint: string, index = 0, at = NOW) {
  const value = nonce(index, at);
  return request(endpoint, { nonce: value, reqTag: healthRequestTagV1(KEY, value, endpoint) });
}

/** The compatibility route's protocol: an UNSIGNED `{nonce}` and a purpose-keyed
 *  response tag. The web process must serve this unchanged -- three callers
 *  depend on it -- while `/api/v1/updater-health` demands the signed body. */
function compatibility(endpoint: string, index = 0) {
  return request(endpoint, { nonce: nonce(index) });
}

/**
 * cook/v1's tag for this route, recomputed the way `mac:up` and the installer
 * compute it. `hmacSha256Tag` canonicalises to SORTED-key JSON, and the sorted
 * order of `{nonce, pid, purpose, ready, releaseId, startedAt}` is the order all
 * three callers agree on.
 *
 * The fields are NAMED rather than spread out of the response body, which is the
 * whole point: the body also carries `schema` and `tag`, and NEITHER is in the
 * signed material. An earlier version of this helper spread the body minus
 * `schema`, which silently included `tag` in the thing being verified and so
 * could never match the server -- a helper that recomputes the wrong material is
 * a test that fails for its own reason rather than the one it claims to check.
 */
const purposeKeyedHostTag = (value: Record<string, unknown>) => hmacSha256Tag(KEY, {
  purpose: LOCAL_HOST_HEALTH_PURPOSE_V1, nonce: value.nonce, pid: value.pid, ready: value.ready,
  releaseId: value.releaseId, startedAt: value.startedAt });

test("/api/v1/updater-health requires a fresh non-replayed request HMAC and signs its complete response", async t => {
  const process = app(); t.after(process.close);
  const missing = await process.handle(request(UPDATER_HEALTH_ENDPOINT_V1, { nonce: nonce(1) }),
    () => new Response("unused"));
  assert.equal(missing.status, 403, "an unsigned body must be refused on the signed route");
  const forged = await process.handle(request(UPDATER_HEALTH_ENDPOINT_V1,
    { nonce: nonce(2), reqTag: `hmac-sha256:${"0".repeat(64)}` }), () => new Response("unused"));
  assert.equal(forged.status, 403);
  const stale = await process.handle(authenticated(UPDATER_HEALTH_ENDPOINT_V1, 3, NOW - 10_001),
    () => new Response("unused"));
  assert.equal(stale.status, 403, "a correctly signed but stale nonce must be refused");

  const webRequest = authenticated(UPDATER_HEALTH_ENDPOINT_V1, 4);
  const webReplay = webRequest.clone();
  const webResponse = await process.handle(webRequest, () => new Response("unused"));
  assert.equal(webResponse.status, 200);
  const web = await webResponse.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(web).sort(), ["homeRenderBytes", "homeSummaryCount", "nonce",
    "planApprovalInsertAllowed", "projectCount", "ready", "schema", "tag", "updatesPanelCount"].sort());
  assert.equal(JSON.stringify(web).includes("tenant-health"), false);
  assert.equal(JSON.stringify(web).includes("workspace-health"), false);
  const webTag = web.tag; delete web.tag;
  assert.equal(healthResponseTagMatchesV1(KEY, UPDATER_HEALTH_ENDPOINT_V1, web, webTag), true);
  assert.equal(await process.handle(webReplay, () => new Response("unused")).then(value => value.status), 403,
    "a replayed signed nonce must be refused");
});

test("/api/v1/local-host-health keeps cook/v1's protocol: unsigned request, purpose-keyed tag", async t => {
  // THE COMPATIBILITY SURFACE. This route has three callers written against
  // cook/v1 -- `mac:up`'s readiness probe, the installer's `checkWebHealthV1` on
  // install night, and the updater's §8.4 evaluator -- so a change to either the
  // request shape or the tag material breaks all three at once. tests/
  // updater-health-cross-caller.test.ts drives the real callers; this is the unit
  // half, and the tag assertion is the same purpose-keyed material.
  const process = app(); t.after(process.close);
  // An unsigned `{nonce}` is SERVED, which is the old protocol.
  const served = await process.handle(compatibility(LOCAL_HOST_HEALTH_ENDPOINT_V1, 10),
    () => new Response("route_absent_fell_through"));
  assert.equal(served.status, 200, "an unsigned {nonce} must be served on the compatibility route");
  const host = await served.json() as Record<string, unknown>;
  assert.equal(host.schema, "control-room.local-host-health/v1");
  assert.equal(host.pid, 4243);
  assert.equal(host.ready, true);
  assert.equal(host.releaseId, "release-good");
  const tag = host.tag as string;
  assert.equal(tag, purposeKeyedHostTag(host), "the tag must be keyed on the purpose literal, not the response");
  // And it is NOT the response-keyed form item 14 introduced for the new route.
  assert.notEqual(tag, healthResponseTagV1(KEY, LOCAL_HOST_HEALTH_ENDPOINT_V1, host),
    "the two tag formats must be distinguishable, or this test cannot tell them apart");

  // A signed body is REFUSED: the old route takes exactly one key, and a
  // `reqTag` is the specific thing that broke the three callers.
  const signedBody = await process.handle(request(LOCAL_HOST_HEALTH_ENDPOINT_V1,
    { nonce: nonce(11), reqTag: `hmac-sha256:${"0".repeat(64)}` }), () => new Response("unused"));
  assert.equal(signedBody.status, 400, "a signed-request body must not be accepted on the compatibility route");
  // A malformed body is still refused the old way (400, not 403).
  const malformed = await process.handle(request(LOCAL_HOST_HEALTH_ENDPOINT_V1, { nonce: "short" }),
    () => new Response("unused"));
  assert.equal(malformed.status, 400, "the old route's own body validation is unchanged");
});

test("the web health boundary cuts off a slow body and handles 50 concurrent probes on both routes", async t => {
  const process = app(); t.after(process.close);
  // The slow-body bound is on the SIGNED route's verifier, which is where
  // `readBoundedJson` with the 1s timeout lives. The compatibility route reads
  // its body with cook/v1's own `readBoundedJson(body, 256)` (5s default), so
  // the 1s assertion belongs here and not there -- asserting the old route cuts
  // off at 1s would be asserting a change that was explicitly not made.
  const slowBody = new ReadableStream<Uint8Array>({ start() {} });
  const began = Date.now();
  const slow = await process.handle(new Request(`${ORIGIN}${UPDATER_HEALTH_ENDPOINT_V1}`, { method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" }, body: slowBody, duplex: "half" } as RequestInit),
  () => new Response("unused"));
  assert.equal(slow.status, 400);
  assert.ok(Date.now() - began < 2_000, "a slow request body must hit the fixed one-second health timeout");
  const oversized = await process.handle(request(UPDATER_HEALTH_ENDPOINT_V1,
    { nonce: nonce(99), reqTag: `hmac-sha256:${"0".repeat(64)}`, padding: "x".repeat(512) }),
  () => new Response("unused"));
  assert.equal(oversized.status, 400, "an oversized body must be refused before authentication");

  // 50 concurrent probes, HALF on each route, each with a distinct nonce. The
  // signed route's nonces come from the app's fixed clock, so they are
  // clock-valid but must still be distinct or the replay ledger refuses them --
  // which is what this asserts, at 50 callers.
  const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => process.handle(
    index % 2 === 0 ? authenticated(UPDATER_HEALTH_ENDPOINT_V1, index + 100)
      : compatibility(LOCAL_HOST_HEALTH_ENDPOINT_V1, index + 100),
    () => new Response("unused"))));
  assert.equal(responses.filter(response => response.status === 200).length, 50,
    "a 50-probe burst across both routes must be fully served");
});
