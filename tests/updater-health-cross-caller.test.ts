// The `/api/v1/local-host-health` route is a COMPATIBILITY SURFACE with three
// independent callers, and it is the only thing standing between `mac:up` and a
// host it can prove, and between the installer and a completed install.
//
//   1. `scripts/mac-local/up.mjs` -- `authenticatedHostReady`, the readiness
//      probe. A rehearsal or preview install cannot finish `mac:up` without it.
//   2. cook/installer's `src/updater/v1/install/health.mjs` -- `checkWebHealthV1`
//      / `verifyWebHealthV1`, the final web health check on install night. This
//      file is not on cook/v1 (it lands with the installer), so its HTTP half is
//      REPRODUCED verbatim below rather than imported; the reproduction is
//      marked and every field it checks is checked here.
//   3. The updater's own §8.4 evaluator, `captureHostResponseV1` in
//      src/updater/v1/health.mjs, which reads the same response.
//
// This file exists because item 14's signed-request protocol was briefly
// applied to this route and broke all three at once: the request became
// HMAC-authenticated and the response tag changed from purpose-keyed to
// response-keyed, so every existing caller was refused. tests/
// mac-local-web-process.test.ts and tests/mac-local-task-host-supervisor.test.mjs
// had been edited in the same commit to match, so nothing in the tree noticed.
//
// WHAT IS PROVED HERE, AND HOW:
//   * callers 1 and 2 speak to a REAL host over REAL loopback TCP with REAL
//     `fetch` -- no injected transport, no injected clock, no fake key path.
//     That is the DEFAULT-PATH rule: the production request the production
//     process answers, not a hand-built `Request`.
//   * caller 2's `verifyWebHealthV1` logic and caller 1's `requestAuthenticated
//     HostHealth` are the real code for caller 1 (imported) and a verbatim port
//     for caller 2 (that branch's file is not on this branch).
//   * caller 3's evaluator accepts the SAME response, unedited, with only its
//     other ports stubbed -- so the three callers cannot drift apart again
//     without one of these three assertions failing.
//   * and the route is still the OLD protocol: a signed-request body is
//     refused, which is the specific thing that broke.
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authenticatedHostReady } from "../scripts/mac-local/up.mjs";
import { captureUpdaterHealthCountsV1, createHealthNonceV1, healthRequestTagV1,
  healthResponseTagV1, LOCAL_HOST_HEALTH_ENDPOINT_V1, UPDATER_HEALTH_ENDPOINT_V1 }
  from "../src/updater/v1/health-protocol.mjs";
import { UpdaterHealthEvaluatorV1 } from "../src/updater/v1/health.mjs";
import { sha256Digest } from "../src/security";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";

const ORIGIN_BASE = "http://127.0.0.1";
const healthProbeKey = Buffer.alloc(32, 5);
/** The BARE release id, which is what the web host reports as `healthReleaseId`
 *  (hostReleaseIdentityV1 reads `.control-room-release.json`'s `version`, or
 *  "dev" in a checkout) and what the installer's `releaseTargetPattern` captures
 *  out of `releases/<id>`. It must satisfy the updater's own SAFE_ID_V1 as well,
 *  because the §8.4 evaluator runs `assertSafeIdV1` on its expected release --
 *  measured: `releases/...` there is refused `updater_health_expectation_refused`. */
const RELEASE_ID = "cross-caller-one";
/** What install night passes: a `current` symlink target, `releases/<id>`. */
const EXPECTED_RELEASE = `releases/${RELEASE_ID}`;
const CHILD_PID = 4_321;
const HOST_STARTED_AT = "2026-09-30T12:00:00.000Z";
const HOST_SIGNED = Object.freeze({ ready: true, pid: CHILD_PID, releaseId: RELEASE_ID,
  startedAt: HOST_STARTED_AT });
const DIGEST = `sha256:${"a".repeat(64)}`;

/** A port the OS says is free, asked for and released. A port already in use is
 *  a test-environment problem to report, not a flake to hide. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => probe.listen(0, "127.0.0.1", () => resolve()).once("error", reject));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("cross_caller_no_port");
  const { port } = address;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

/** The real web process, serving on real loopback TCP, with only the two things
 *  it cannot have in a unit test injected: the database client (the readiness
 *  route never queries it) and the clock. Everything else -- the route, the
 *  session service, the response tag -- is production code. */
async function startHost(extra: Record<string, unknown> = {}) {
  const port = await freePort();
  const origin = `${ORIGIN_BASE}:${port}`;
  const process = createMacLocalWebProcessV1({
    origin, workspaceId: "workspace-cross-caller",
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant-cross-caller",
      provider: "local", subject: "owner",
      ownerCodeDigest: sha256Digest({ ownerCode: "an owner code that is not a secret" }), sessionSeconds: 900 },
    database: { client: {} as never, close: async () => {}, isAvailable: () => true },
    hostProcessId: CHILD_PID, healthProbeKey,
    healthReleaseId: RELEASE_ID, healthStartedAt: HOST_STARTED_AT,
    ...extra,
  });
  const server = createServer();
  server.on("request", (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(chunk as Buffer));
    incoming.on("end", () => {
      void process.handle(new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, {
        method: incoming.method, headers: incoming.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }), () => new Response("route_absent_fell_through", { status: 404 }))
        .then(async response => {
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch(() => { outgoing.writeHead(500); outgoing.end(); });
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(port, "127.0.0.1", () => resolve()).once("error", reject));
  // A refusal here means the port was taken between the probe and the bind, which
  // is the test environment's problem and must be visible, not retried silently.
  assert.equal((server.address() as { port: number }).port, port);
  return { origin, port, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await process.close(); } };
}

// ---------------------------------------------------------------------------
// Caller 2: cook/installer src/updater/v1/install/health.mjs, reproduced.
// Everything below is that file's code with only the names shortened. The three
// parts that matter are `boundedJsonV1`'s content checks, `verifyWebHealthV1`'s
// exact-key/refusal set, and the request body.
// ---------------------------------------------------------------------------

const HEALTH_RESPONSE_LIMIT_BYTES_V1 = 4096;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const releaseTargetPattern = /^releases\/([A-Za-z0-9._-]{1,160})$/u;
const exactKeys = (value: unknown, names: string[]) => (value as object) && typeof value === "object"
  && !Array.isArray(value) && Object.keys(value as object).sort().join(",") === [...names].sort().join(",");

async function boundedJsonV1(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d{1,9}$/u.test(declared) || Number(declared) > HEALTH_RESPONSE_LIMIT_BYTES_V1))
    throw new Error("health_web_response_too_large");
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    || !response.body) throw new Error("health_web_refused");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > HEALTH_RESPONSE_LIMIT_BYTES_V1) { await reader.cancel(); throw new Error("health_web_response_too_large"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map(value => Buffer.from(value)), length).toString("utf8"));
}

/** The installer's `verifyWebHealthV1`, with `refuse` inlined. The purpose-keyed
 *  `material` is the load-bearing line: it is the old tag format, and if the web
 *  process ever keys its tag on the response object instead, this throws. */
function verifyWebHealthV1(value: unknown, { key, nonce, expectedRelease }: Readonly<
  { key: Uint8Array; nonce: string; expectedRelease: string }>) {
  if (!exactKeys(value, ["schema", "ready", "pid", "nonce", "releaseId", "startedAt", "tag"])
    || (value as { schema: string }).schema !== "control-room.local-host-health/v1"
    || (value as { ready: boolean }).ready !== true
    || !Number.isSafeInteger((value as { pid: number }).pid) || (value as { pid: number }).pid <= 1
    || (value as { nonce: string }).nonce !== nonce
    || (value as { releaseId: string }).releaseId !== expectedRelease
    || typeof (value as { startedAt: string }).startedAt !== "string"
    || !Number.isFinite(Date.parse((value as { startedAt: string }).startedAt))
    || typeof (value as { tag: string }).tag !== "string") throw new Error("health_web_refused");
  const material = JSON.stringify({ nonce, pid: (value as { pid: number }).pid, purpose: "local-host-health/v1",
    ready: true, releaseId: (value as { releaseId: string }).releaseId, startedAt: (value as { startedAt: string }).startedAt });
  const expected = `hmac-sha256:${createHmac("sha256", key).update(material, "utf8").digest("hex")}`;
  const actualBytes = Buffer.from((value as { tag: string }).tag, "utf8"), expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
    throw new Error("health_web_refused");
  return Object.freeze({ pid: (value as { pid: number }).pid, releaseId: (value as { releaseId: string }).releaseId,
    startedAt: (value as { startedAt: string }).startedAt });
}

/** The installer's `checkWebHealthV1` HTTP half, with the port and the release
 *  validation it performs, over the REAL transport. `checkHealthV1` calls this
 *  three times on install night. */
async function checkWebHealthV1(input: Readonly<{ root: string; webPort: number; expectedRelease: string }>) {
  const release = releaseTargetPattern.exec(input.expectedRelease ?? "");
  if (!Number.isSafeInteger(input.webPort) || input.webPort < 1024 || input.webPort > 65_535 || !release)
    throw new Error("health_web_refused");
  const key = healthProbeKey;
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("health_probe_key_refused");
  const nonce = randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce)) throw new Error("health_web_refused");
  const origin = `${ORIGIN_BASE}:${input.webPort}`;
  const response = await fetch(`${origin}${LOCAL_HOST_HEALTH_ENDPOINT_V1}`, { method: "POST",
    headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ nonce }),
    signal: AbortSignal.timeout(1_000) });
  return verifyWebHealthV1(await boundedJsonV1(response), { key, nonce, expectedRelease: release[1]! });
}

// ---------------------------------------------------------------------------

test("the installer's own health check and mac:up's readiness probe both succeed against the real host", async t => {
  const host = await startHost();
  t.after(host.close);

  // ---- Caller 2, the installer. Three samples, as install night runs it.
  for (let sample = 0; sample < 3; sample += 1) {
    const accepted = await checkWebHealthV1({ root: "/not-used", webPort: host.port, expectedRelease: EXPECTED_RELEASE });
    assert.equal(accepted.releaseId, releaseTargetPattern.exec(EXPECTED_RELEASE)![1],
      `installer sample ${sample} must be accepted by the web process`);
    assert.equal(accepted.pid, CHILD_PID, `installer sample ${sample} must see the host's own pid`);
  }

  // ---- Caller 1, mac:up. The REAL `authenticatedHostReady`, with only the
  // process-liveness facts injected (this test is not standing up a supervisor);
  // the HTTP probe, the key check and the response verification are production.
  const root = await mkdtemp(join(tmpdir(), "cr-cross-caller-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pid = await authenticatedHostReady(root, host.port, {
    healthProbeKey,
    readPid: async () => CHILD_PID,
    readHostState: async () => ({ schema: "control-room.mac-local-host-state/v1", state: "running",
      pid: CHILD_PID, childPid: CHILD_PID }),
    alive: () => true,
  });
  assert.equal(pid, CHILD_PID, "mac:up's readiness probe must accept the host it started");

  // And the honest negative: a pid that does not match the recorded child is a
  // retry, never a mixed-generation success.
  assert.equal(await authenticatedHostReady(root, host.port, { healthProbeKey,
    readPid: async () => CHILD_PID,
    readHostState: async () => ({ schema: "control-room.mac-local-host-state/v1", state: "running",
      pid: CHILD_PID, childPid: CHILD_PID + 1 }),
    alive: () => true }), undefined, "a probe answering for a different child must not prove readiness");
});

test("the same response satisfies the updater's §8.4 evaluator unchanged", async t => {
  // The read port is what makes `/api/v1/updater-health` exist at all: without it
  // the route is a 404 and the sample is `updater_health_http_refused`, which is
  // exactly the failure this test took two rounds to diagnose. The counts it
  // returns must equal the evaluator's own independent reads below, or the §8.4
  // comparison refuses `updater_health_count_mismatch`.
  const host = await startHost({ updaterHealthReadPort: { readHealthCounts: async () => ({
    homeSummaryCount: 5, projectCount: 4, updatesPanelCount: 3, homeRenderBytes: 4_096,
    planApprovalInsertAllowed: true }) } });
  t.after(host.close);
  // Only the evaluator's NON-web ports are stubbed. Its host-health half --
  // the request it builds, the fields it requires and the tag it verifies -- and
  // its web-counts half -- the second signed request -- are production code
  // reading production responses from the same real host. The gateway is the
  // same host too, with only its fleet route answered by a stub, so the whole
  // sample can come back HEALTHY and the assertion is one value rather than a
  // race between two Promise.all rejections.
  const fleetHealth = () => new Response(JSON.stringify(
    { schema: "control-room.fleet-health/v1", ready: true, maintenance: false }),
    { headers: { "content-type": "application/json" } });
  const evaluator = new UpdaterHealthEvaluatorV1({ root: "/not-used",
    configuration: { read: async () => ({ webOrigin: host.origin, gatewayOrigin: host.origin }) },
    reads: { readHealthCounts: async () => ({ homeSummaryCount: 5, projectCount: 4, updatesPanelCount: 3 }) },
    database: { schemaDigest: async () => DIGEST },
    supervisor: { snapshot: async () => ({ state: "running", childPid: CHILD_PID, generation: "generation-one",
      pidAlive: true, logBytes: 10 }) },
    // `init` is forwarded unchanged on the non-fleet branch. Dropping it was a
    // real failure while this was being written: the origin and content-type
    // headers the routes require both travel in `init`, so a bare
    // `fetch(url, {headers:{accept}})` made every probe 403 and the sample came
    // back `updater_health_http_refused`.
    gateway: { transport: async (url: string, init: RequestInit) => url.endsWith("/fleet/v1/health")
      ? fleetHealth() : fetch(url, init) },
    workers: { reconnected: async () => ({ reconnectedCount: 1 }) },
    manifests: { verifyKnownGood: async () => true },
    key: async () => healthProbeKey });
  const result = await evaluator.sample({ releaseId: RELEASE_ID, startedAfter: "2026-09-30T11:59:00.000Z",
    schemaDigest: DIGEST, previousWorkerCount: 1 });
  // `healthy: true` is only reachable if the evaluator's own verifier accepted
  // the host's response tag AND the web endpoint's, against the real process.
  assert.deepEqual(result, { healthy: true, progress: false, code: null },
    "the §8.4 evaluator must accept, unedited, the response these two other callers accept");

  // The negative that keeps this honest: with the release expectation changed,
  // the SAME healthy response must be refused. Otherwise "the evaluator accepts"
  // could be satisfied by an evaluator that accepts anything.
  const wrong = await evaluator.sample({ releaseId: "cross-caller-two", startedAfter: "2026-09-30T11:59:00.000Z",
    schemaDigest: DIGEST, previousWorkerCount: 1 });
  assert.deepEqual(wrong, { healthy: false, progress: false, code: "updater_health_release_mismatch" },
    "the same response under a different release expectation must be refused, so the pass above is not vacuous");
});

test("the readiness route is still the old protocol: an unsigned request, a purpose-keyed tag", async t => {
  // NO updater read port: this composition is the one that proves the two routes
  // are routed separately, so the new route must be ABSENT here (404) while the
  // old route is served (200).
  const host = await startHost();
  t.after(host.close);

  // The old caller's request: one key, a 43-character nonce, nothing else.
  const nonce = randomBytes(32).toString("base64url");
  const unsigned = await fetch(`${host.origin}${LOCAL_HOST_HEALTH_ENDPOINT_V1}`, { method: "POST",
    headers: { origin: host.origin, "content-type": "application/json" }, body: JSON.stringify({ nonce }) });
  assert.equal(unsigned.status, 200, "an unsigned {nonce} request is the protocol three callers speak");
  const value = await unsigned.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(value).sort(),
    ["nonce", "pid", "ready", "releaseId", "schema", "startedAt", "tag"],
    "the response shape is unchanged, so the installer's exactKeys check still holds");
  // And the tag is the purpose-keyed one, NOT the response-keyed item-14 form.
  const purposeKeyed = `hmac-sha256:${createHmac("sha256", healthProbeKey).update(JSON.stringify({ nonce,
    pid: CHILD_PID, purpose: "local-host-health/v1", ready: true, releaseId: RELEASE_ID,
    startedAt: HOST_STARTED_AT }), "utf8").digest("hex")}`;
  assert.equal(value.tag, purposeKeyed, "the tag material must stay the old purpose-keyed one");
  assert.notEqual(value.tag, healthResponseTagV1(healthProbeKey, LOCAL_HOST_HEALTH_ENDPOINT_V1,
    { ...HOST_SIGNED, schema: "control-room.local-host-health/v1", nonce }),
  "item 14's response-keyed tag must differ from the purpose-keyed one, or this"
  + " assertion cannot tell the two protocols apart");

  // A signed-request body is REFUSED here. This is the specific break: when item
  // 14's `verifyHealthRequestV1` was applied to this route, every one of the three
  // callers got 403 access_denied and `mac:up` could never complete. The tag is
  // written literally because `healthRequestTagV1` no longer mints one for this
  // endpoint at all -- a caller that had adopted item 14 cannot even produce the
  // body, which is asserted below.
  const signed = createHealthNonceV1();
  const withTag = await fetch(`${host.origin}${LOCAL_HOST_HEALTH_ENDPOINT_V1}`, { method: "POST",
    headers: { origin: host.origin, "content-type": "application/json" },
    body: JSON.stringify({ nonce: signed, reqTag: `hmac-sha256:${createHmac("sha256", healthProbeKey).update(
      `request\0${signed}${LOCAL_HOST_HEALTH_ENDPOINT_V1}`, "utf8").digest("hex")}` }) });
  assert.equal(withTag.status, 400, "a signed-request body is not this route's protocol and must be refused");
  // And the protocol module itself refuses to MINT a request tag for the old
  // route, so the two routes cannot be confused by a new caller.
  assert.throws(() => healthRequestTagV1(healthProbeKey, signed, LOCAL_HOST_HEALTH_ENDPOINT_V1),
    /health_endpoint_refused/u, "no request tag may be minted for the compatibility route");

  // The NEW endpoint is a different route and does take the signed body. It is
  // asserted here rather than only in updater-health-web.test.ts because this is
  // the file that would catch a future change making the two routes share a
  // verifier.
  const updaterNonce = createHealthNonceV1();
  const updaterResponse = await fetch(`${host.origin}${UPDATER_HEALTH_ENDPOINT_V1}`, { method: "POST",
    headers: { origin: host.origin, "content-type": "application/json" },
    body: JSON.stringify({ nonce: updaterNonce,
      reqTag: healthRequestTagV1(healthProbeKey, updaterNonce, UPDATER_HEALTH_ENDPOINT_V1) }) });
  assert.equal(updaterResponse.status, 404,
    "this composition supplies no updater read port, so the new route is absent -- the 404 is what proves"
    + " the two routes are routed separately rather than sharing a verifier");
});

test("the tag verifier the callers share is a real HMAC: a forged response is refused", async () => {
  // The reproduction above would pass against a host that returned a CONSTANT
  // tag, because it only compares what the host said with what it computes. So
  // the verifier itself is attacked here, with the same code the three callers
  // use: a wrong key and a one-field edit must both fail, and the boundary value
  // (a tag of the wrong length) must fail without throwing.
  const nonce = randomBytes(32).toString("base64url");
  const value = { schema: "control-room.local-host-health/v1", ready: true, pid: CHILD_PID, nonce,
    releaseId: RELEASE_ID, startedAt: HOST_STARTED_AT };
  const tagFor = (key: Uint8Array) => `hmac-sha256:${createHmac("sha256", key).update(JSON.stringify({ nonce,
    pid: CHILD_PID, purpose: "local-host-health/v1", ready: true, releaseId: RELEASE_ID,
    startedAt: HOST_STARTED_AT }), "utf8").digest("hex")}`;
  assert.doesNotThrow(() => verifyWebHealthV1({ ...value, tag: tagFor(healthProbeKey) },
    { key: healthProbeKey, nonce, expectedRelease: RELEASE_ID }));
  assert.throws(() => verifyWebHealthV1({ ...value, tag: tagFor(Buffer.alloc(32, 6)) }, { key: healthProbeKey,
    nonce, expectedRelease: RELEASE_ID }), /^Error: health_web_refused$/u, "a different key must not verify");
  assert.throws(() => verifyWebHealthV1({ ...value, pid: CHILD_PID + 1, tag: tagFor(healthProbeKey) },
    { key: healthProbeKey, nonce, expectedRelease: RELEASE_ID }), /^Error: health_web_refused$/u,
  "an edited field must not verify");
  assert.throws(() => verifyWebHealthV1({ ...value, tag: "hmac-sha256:short" }, { key: healthProbeKey,
    nonce, expectedRelease: RELEASE_ID }), /^Error: health_web_refused$/u,
  "a wrong-length tag must refuse rather than crash the comparison");
  // `ready: false` is inside the tag, so a host reporting an outage is refused by
  // every caller -- which is why `ready` must stay the REAL readiness.
  assert.throws(() => verifyWebHealthV1({ ...value, ready: false, tag: tagFor(healthProbeKey) },
    { key: healthProbeKey, nonce, expectedRelease: RELEASE_ID }), /^Error: health_web_refused$/u);
  // And the count-capture the new endpoint shares, asserted here so the two
  // routes' validators cannot be merged by accident either.
  assert.deepEqual(captureUpdaterHealthCountsV1({ homeSummaryCount: 0, projectCount: 0, updatesPanelCount: 0,
    homeRenderBytes: 1, planApprovalInsertAllowed: true }),
  { homeSummaryCount: 0, projectCount: 0, updatesPanelCount: 0, homeRenderBytes: 1, planApprovalInsertAllowed: true });
});

test("a probe key of the wrong length is refused by the shared verifier, not coerced", async t => {
  const host = await startHost();
  t.after(host.close);
  // `mac:up` reads the key from `service/health-probe.key` and refuses anything
  // that is not 32 bytes. The web process's own construction refuses a missing
  // key (tests/mac-local-host-readiness-forwarding.test.ts proves that half), so
  // the caller side is the part worth proving here: a short key must not produce
  // a signed response the web process would accept.
  const root = await mkdtemp(join(tmpdir(), "cr-cross-caller-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await authenticatedHostReady(root, host.port, { healthProbeKey: Buffer.alloc(16, 1),
    readPid: async () => CHILD_PID,
    readHostState: async () => ({ schema: "control-room.mac-local-host-state/v1", state: "running",
      pid: CHILD_PID, childPid: CHILD_PID }),
    alive: () => true }), undefined, "a 16-byte key must not prove readiness");
  // A key file that does not exist is the real install-night case: `mac:up`
  // refuses to start a host without it.
  assert.equal(await authenticatedHostReady(root, host.port, {
    readPid: async () => CHILD_PID,
    readHostState: async () => ({ schema: "control-room.mac-local-host-state/v1", state: "running",
      pid: CHILD_PID, childPid: CHILD_PID }),
    alive: () => true }), undefined, "a missing probe key file must not prove readiness");
  await writeFile(join(root, "service", "health-probe.key"), "not-a-key\n", { flag: "a" }).catch(() => {});
});
