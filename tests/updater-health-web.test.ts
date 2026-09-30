import assert from "node:assert/strict";
import test from "node:test";
import { createHealthNonceV1, healthRequestTagV1, healthResponseTagMatchesV1,
  LOCAL_HOST_HEALTH_ENDPOINT_V1, UPDATER_HEALTH_ENDPOINT_V1 } from "../src/updater/v1/health-protocol.mjs";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { sha256Digest } from "../src/security";

const NOW = Date.parse("2026-09-30T18:00:00.000Z"), ORIGIN = "http://127.0.0.1:7864";
const KEY = new Uint8Array(32).fill(11);

function app() {
  return createMacLocalWebProcessV1({ origin: ORIGIN, workspaceId: "workspace-health",
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: ORIGIN, tenantId: "tenant-health",
      provider: "local", subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode: "owner-code-long-enough" }),
      sessionSeconds: 900 }, database: { client: {} as never, close: async () => {} }, clock: () => NOW,
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

function authenticated(endpoint: string, index = 0, at = NOW) {
  const value = nonce(index, at);
  return request(endpoint, { nonce: value, reqTag: healthRequestTagV1(KEY, value, endpoint) });
}

test("both health endpoints require fresh non-replayed request HMACs and sign their complete response", async t => {
  const process = app(); t.after(process.close);
  const missing = await process.handle(request(LOCAL_HOST_HEALTH_ENDPOINT_V1, { nonce: nonce(1) }),
    () => new Response("unused"));
  assert.equal(missing.status, 403);
  const forged = await process.handle(request(LOCAL_HOST_HEALTH_ENDPOINT_V1,
    { nonce: nonce(2), reqTag: `hmac-sha256:${"0".repeat(64)}` }), () => new Response("unused"));
  assert.equal(forged.status, 403);
  const stale = await process.handle(authenticated(LOCAL_HOST_HEALTH_ENDPOINT_V1, 3, NOW - 10_001),
    () => new Response("unused"));
  assert.equal(stale.status, 403);

  const hostRequest = authenticated(LOCAL_HOST_HEALTH_ENDPOINT_V1, 4);
  const hostReplay = hostRequest.clone();
  const hostResponse = await process.handle(hostRequest, () => new Response("unused"));
  assert.equal(hostResponse.status, 200);
  const host = await hostResponse.json() as Record<string, unknown>;
  const hostTag = host.tag; delete host.tag;
  assert.equal(healthResponseTagMatchesV1(KEY, LOCAL_HOST_HEALTH_ENDPOINT_V1, host, hostTag), true);
  assert.equal(await process.handle(hostReplay, () => new Response("unused")).then(value => value.status), 403);

  const webResponse = await process.handle(authenticated(UPDATER_HEALTH_ENDPOINT_V1, 5),
    () => new Response("unused"));
  assert.equal(webResponse.status, 200);
  const web = await webResponse.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(web).sort(), ["homeRenderBytes", "homeSummaryCount", "nonce",
    "planApprovalInsertAllowed", "projectCount", "ready", "schema", "tag", "updatesPanelCount"].sort());
  assert.equal(JSON.stringify(web).includes("tenant-health"), false);
  assert.equal(JSON.stringify(web).includes("workspace-health"), false);
  const webTag = web.tag; delete web.tag;
  assert.equal(healthResponseTagMatchesV1(KEY, UPDATER_HEALTH_ENDPOINT_V1, web, webTag), true);
});

test("the web health boundary cuts off a slow body and handles 50 concurrent authenticated probes", async t => {
  const process = app(); t.after(process.close);
  const slowBody = new ReadableStream<Uint8Array>({ start() {} });
  const began = Date.now();
  const slow = await process.handle(new Request(`${ORIGIN}${LOCAL_HOST_HEALTH_ENDPOINT_V1}`, { method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" }, body: slowBody, duplex: "half" } as RequestInit),
  () => new Response("unused"));
  assert.equal(slow.status, 400);
  assert.ok(Date.now() - began < 2_000);
  const oversized = await process.handle(request(LOCAL_HOST_HEALTH_ENDPOINT_V1,
    { nonce: nonce(99), reqTag: `hmac-sha256:${"0".repeat(64)}`, padding: "x".repeat(512) }),
  () => new Response("unused"));
  assert.equal(oversized.status, 400);
  const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => process.handle(
    authenticated(index % 2 === 0 ? LOCAL_HOST_HEALTH_ENDPOINT_V1 : UPDATER_HEALTH_ENDPOINT_V1, index + 100),
    () => new Response("unused"))));
  assert.equal(responses.filter(response => response.status === 200).length, 50);
});
