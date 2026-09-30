import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { hmacSha256Tag, sha256Digest } from "../src/security";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { handlePrivateWebRequest } from "../src/web/v1/private-process";
import { createMacLocalProtectedHostV1 } from "../src/web/v1/mac-local-host";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1, captureMacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";

// Regression cover for a break found by standing up a real throwaway install on
// 2026-09-30, which every service-level test passed:
//
//   `hostProcessId` was accepted by the protected host but never forwarded into
//   the web service composition, so `/api/v1/local-host-health` was absent and
//   answered 404. `mac:up` proves a started host with exactly that route, so
//   `mac:up` could never complete on any rehearsal or preview install: it timed
//   out after 90 seconds against a host that was in fact listening and serving.
//
// The probe is sent through the installed private application, which is exactly
// what the host's loopback transport forwards to, because a missing pid makes
// the route absent -- a 404 rather than a 400 -- so only a signed 200 carrying
// this host's own pid proves the value arrived. The listener the host binds is
// only what `start()` requires.

const configuration = captureMacLocalProtectedConfigurationV1({ schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1,
  port: 3210, workspaceId: "workspace:mac-local",
  localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local",
    provider: "local", subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode: "a test owner code that is not a secret" }),
    sessionSeconds: 900 },
  database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web",
    password: "a-test-password", majorVersion: 17 },
  enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1",
    workers: [{ workerId: "worker:codex", kind: "codex", executablePath: "/bin/codex", recordedVersion: "codex test" }] } });

const databaseRoles = Object.freeze({
  schema: MAC_LOCAL_DATABASE_ROLES_V1,
  web: configuration.database,
  coordinator: { ...configuration.database, username: "control_room_coordinator", password: "coordinator-test" },
  results: { ...configuration.database, username: "control_room_results", password: "results-test" },
  publisher: { ...configuration.database, username: "control_room_publisher", password: "publisher-test" },
  agentReviewer: { ...configuration.database, username: "control_room_agent_reviewer_login", password: "reviewer-test" },
  queueWorker: { ...configuration.database, username: "control_room_queue_worker", password: "queue-worker-test" },
});

const healthProbeKey = new Uint8Array(32).fill(7);
const healthStartedAt = "2026-09-30T00:00:00.000Z";
const releaseId = "test-release";
const pid = 4_321;

/** Starts the host on its own loopback port and returns the origin it bound.
 *  The configuration's port is fixed, so a port already in use is a test
 *  environment problem to report rather than a flake to hide: this asks the OS
 *  for a free port by rewriting only the in-memory configuration. */
async function startHost(extra: Record<string, unknown>) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => probe.listen(0, "127.0.0.1", () => resolve()).once("error", reject));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("test_host_no_port");
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const captured = createServer();
  const host = createMacLocalProtectedHostV1({
    loadConfiguration: async () => ({ ...configuration, port,
      localOwnerSession: { ...configuration.localOwnerSession, origin: `http://127.0.0.1:${port}` } }),
    readVersion: async () => "codex test",
    loadDatabaseRoles: async () => databaseRoles,
    // A client with no `query` keeps the composition on the session-store-less
    // path, so no database is contacted by a readiness probe.
    openDatabase: () => ({ client: {} as never, isAvailable: () => true, async close() { /* test */ } }),
    assets: { count: 0, digest: "test", respond() { return undefined; } },
    render: () => new Response("page"),
    ...extra,
    createServer: () => captured, listenerTiming: { bindMs: 2_000, closeMs: 2_000 },
  });
  const running = await host.start();
  const bound = captured.address();
  if (!bound || typeof bound === "string" || bound.port !== port) throw new Error("test_host_bound_other_port");
  return { origin: `http://127.0.0.1:${port}`, running, close: () => running.close() };
}

/** The exact probe `scripts/mac-local/up.mjs` sends, delivered the way the host's
 *  transport delivers it. The renderer returns a marker that must never appear:
 *  reaching it means the route was absent and the request fell through. */
async function probeHealth(origin: string) {
  const nonce = Buffer.alloc(32, 3).toString("base64url");
  const response = await handlePrivateWebRequest(new Request(`${origin}/api/v1/local-host-health`, {
    method: "POST", headers: { origin, host: origin.replace("http://", ""), "content-type": "application/json" },
    body: JSON.stringify({ nonce }) }), () => new Response("route_absent_fell_through_to_the_renderer"));
  return { status: response.status, body: await response.text() };
}

test("the protected host forwards its pid so mac:up's readiness probe is answered", async t => {
  const host = await startHost({ hostProcessId: pid, healthProbeKey, healthReleaseId: releaseId, healthStartedAt });
  t.after(() => host.close());
  assert.equal(host.running.isReady(), true);
  const { status, body } = await probeHealth(host.origin);
  // A missing pid makes the route absent: the failure `mac:up` actually hit.
  assert.equal(status, 200, `the readiness route must be mounted, not absent: ${body}`);
  const value = JSON.parse(body) as { pid: number; ready: boolean; releaseId: string; nonce: string; tag: string };
  assert.equal(value.pid, pid, "the route must report the pid the host supplied");
  assert.equal(value.ready, true);
  assert.equal(value.releaseId, releaseId);
  // The signature is what `mac:up` verifies, so it is asserted rather than trusted.
  assert.equal(value.tag, hmacSha256Tag(healthProbeKey,
    { purpose: "local-host-health/v1", nonce: value.nonce, pid, ready: true, releaseId, startedAt: healthStartedAt }));
});

test("the readiness route stays absent when the host supplies no pid", async t => {
  const host = await startHost({ healthProbeKey, healthReleaseId: releaseId, healthStartedAt });
  t.after(() => host.close());
  const { status } = await probeHealth(host.origin);
  assert.equal(status, 404, "a composition with no pid must not serve a readiness route");
});

test("a web process with a pid but no probe key is refused at construction", () => {
  // Forwarding the pid is not permission to serve a readiness route with no key
  // behind it: the construction refusal must still hold.
  assert.throws(() => createMacLocalWebProcessV1({
    origin: "http://127.0.0.1:3210", localOwnerSession: configuration.localOwnerSession,
    workspaceId: configuration.workspaceId,
    database: { client: {} as never, close: async () => {}, isAvailable: () => true },
    hostProcessId: pid,
  } as never), /mac_local_web_process_config_invalid/);
});
