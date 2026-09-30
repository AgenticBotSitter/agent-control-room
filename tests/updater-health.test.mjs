import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdaterHealthEvaluatorV1, UpdaterScheduledHealthV1, loadRunningHealthPolicyV1,
  readUpdaterHealthProbeKeyV1 } from "../src/updater/v1/health.mjs";
import { createHealthNonceV1, HealthNonceLedgerV1, healthRequestTagV1, healthResponseTagV1,
  LOCAL_HOST_HEALTH_ENDPOINT_V1, UPDATER_HEALTH_ENDPOINT_V1, verifyHealthRequestV1 } from "../src/updater/v1/health-protocol.mjs";

const NOW = Date.parse("2026-09-30T18:00:00.000Z");
const STARTED = "2026-09-30T17:59:59.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
const KEY = Buffer.alloc(32, 7);
const COMPARISON_COUNTS = Object.freeze({ homeSummaryCount: 4, projectCount: 3, updatesPanelCount: 2 });
const COUNTS = Object.freeze({ ...COMPARISON_COUNTS,
  homeRenderBytes: 8192, planApprovalInsertAllowed: true });
const EXPECTATION = Object.freeze({ releaseId: "release-good", startedAfter: STARTED,
  schemaDigest: DIGEST, previousWorkerCount: 1 });

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function signedHost(nonce, overrides = {}) {
  const response = { schema: "control-room.local-host-health/v1", nonce, ready: true, pid: 4243,
    releaseId: "release-good", startedAt: "2026-09-30T17:59:59.500Z", ...overrides };
  return { ...response, tag: healthResponseTagV1(KEY, LOCAL_HOST_HEALTH_ENDPOINT_V1, response) };
}

function signedWeb(nonce, overrides = {}) {
  const response = { schema: "control-room.updater-health/v1", nonce, ready: true, ...COUNTS, ...overrides };
  return { ...response, tag: healthResponseTagV1(KEY, UPDATER_HEALTH_ENDPOINT_V1, response) };
}

function fixture({ transport, host = {}, web = {}, forgeHost = false, forgeWeb = false, supervisor,
  configuration = { webOrigin: "http://127.0.0.1:7864", gatewayOrigin: "http://127.0.0.1:7865" },
  reads = COMPARISON_COUNTS,
  schemaDigest = DIGEST, gatewayHealth = { schema: "control-room.fleet-health/v1", ready: true, maintenance: false },
  workerHealth = { reconnectedCount: 1 }, manifestsHealthy = true, clock = () => NOW } = {}) {
  const defaultTransport = async (url, init) => {
    if (url.endsWith("/fleet/v1/health"))
      return json(gatewayHealth);
    const request = JSON.parse(init.body);
    assert.equal(request.reqTag, healthRequestTagV1(KEY, request.nonce,
      url.endsWith(LOCAL_HOST_HEALTH_ENDPOINT_V1) ? LOCAL_HOST_HEALTH_ENDPOINT_V1 : UPDATER_HEALTH_ENDPOINT_V1));
    if (url.endsWith(LOCAL_HOST_HEALTH_ENDPOINT_V1)) {
      const response = signedHost(request.nonce, host);
      return json(forgeHost ? { ...response, tag: `hmac-sha256:${"0".repeat(64)}` } : response);
    }
    const response = signedWeb(request.nonce, web);
    return json(forgeWeb ? { ...response, tag: `hmac-sha256:${"0".repeat(64)}` } : response);
  };
  return new UpdaterHealthEvaluatorV1({ root: "/not-used",
    configuration: { read: async () => configuration },
    reads: { readHealthCounts: async () => reads }, database: { schemaDigest: async () => schemaDigest },
    supervisor: supervisor ?? { snapshot: async () => ({ state: "running", childPid: 4243,
      generation: "generation-one", pidAlive: true, logBytes: 100 }) },
    gateway: {}, workers: { reconnected: async () => workerHealth },
    manifests: { verifyKnownGood: async () => manifestsHealthy }, transport: transport ?? defaultTransport,
    key: async () => KEY, clock });
}

test("health request authentication rejects missing, forged, replayed and stale nonces under 10k fuzz", () => {
  const ledger = new HealthNonceLedgerV1(), endpoint = LOCAL_HOST_HEALTH_ENDPOINT_V1;
  for (let index = 0; index < 10_000; index += 1) {
    const nonce = createHealthNonceV1(NOW, size => {
      const bytes = Buffer.alloc(size); bytes.writeUInt32BE(index, size - 4); return bytes;
    });
    const variants = [
      { nonce },
      { nonce: "short", reqTag: `hmac-sha256:${"0".repeat(64)}` },
      { nonce, reqTag: `hmac-sha256:${"0".repeat(64)}` },
      { nonce, reqTag: healthRequestTagV1(KEY, nonce, UPDATER_HEALTH_ENDPOINT_V1) },
      { nonce, reqTag: `hmac-sha256:${"0".repeat(64)}`, extra: true },
    ];
    assert.throws(() => verifyHealthRequestV1({ key: KEY, endpoint,
      value: variants[index % variants.length], ledger, now: NOW }),
    /health_request_(?:refused|auth_refused|stale)/u);
  }
  assert.equal(ledger.size, 0, "forged fuzz must not consume replay capacity");
  const nonce = createHealthNonceV1(NOW, size => Buffer.alloc(size, 9));
  const value = { nonce, reqTag: healthRequestTagV1(KEY, nonce, endpoint) };
  assert.deepEqual(verifyHealthRequestV1({ key: KEY, endpoint, value, ledger, now: NOW }), { nonce, issuedAt: NOW });
  assert.throws(() => verifyHealthRequestV1({ key: KEY, endpoint, value, ledger, now: NOW }), /health_request_replayed/u);
  const stale = createHealthNonceV1(NOW - 10_001, size => Buffer.alloc(size, 8));
  assert.throws(() => verifyHealthRequestV1({ key: KEY, endpoint,
    value: { nonce: stale, reqTag: healthRequestTagV1(KEY, stale, endpoint) }, ledger, now: NOW }), /health_request_stale/u);
  const future = createHealthNonceV1(NOW + 2_001, size => Buffer.alloc(size, 6));
  assert.throws(() => verifyHealthRequestV1({ key: KEY, endpoint,
    value: { nonce: future, reqTag: healthRequestTagV1(KEY, future, endpoint) }, ledger, now: NOW }), /health_request_stale/u);
  assert.throws(() => verifyHealthRequestV1({ key: KEY, endpoint, value: { nonce }, ledger, now: NOW }),
    /health_request_refused/u);
});

test("the full evaluator accepts only matching signed counts, release, schema, generation, gateway, workers and manifests", async () => {
  assert.equal((await fixture().sample(EXPECTATION)).healthy, true);
  assert.deepEqual(await fixture({ host: { releaseId: "release-wrong" } }).sample(EXPECTATION),
    { healthy: false, progress: false, code: "updater_health_release_mismatch" });
  assert.deepEqual(await fixture({ host: { startedAt: "2026-09-30T17:59:40.000Z" } }).sample(EXPECTATION),
    { healthy: false, progress: false, code: "updater_health_clock_refused" });
  assert.deepEqual(await fixture({ host: { startedAt: "2026-09-30T18:00:02.001Z" } }).sample(EXPECTATION),
    { healthy: false, progress: false, code: "updater_health_clock_refused" });
  assert.deepEqual(await fixture({ reads: { ...COMPARISON_COUNTS, projectCount: 99 } }).sample(EXPECTATION),
    { healthy: false, progress: false, code: "updater_health_count_mismatch" });
  assert.equal((await fixture({ forgeHost: true }).sample(EXPECTATION)).code, "updater_host_health_auth_refused");
  assert.equal((await fixture({ forgeWeb: true }).sample(EXPECTATION)).code, "updater_web_health_auth_refused");
  assert.equal((await fixture({ web: { planApprovalInsertAllowed: false } }).sample(EXPECTATION)).code,
    "updater_health_counts_refused");
  assert.equal((await fixture({ supervisor: { snapshot: async () => ({ state: "running", childPid: 4243,
    generation: "generation-one", pidAlive: false, logBytes: 100 }) } }).sample(EXPECTATION)).code,
  "updater_health_supervisor_refused");
  assert.equal((await fixture({ configuration: { webOrigin: "http://localhost:7864",
    gatewayOrigin: "http://127.0.0.1:7865" } }).sample(EXPECTATION)).code, "updater_health_config_refused");
  assert.equal((await fixture({ schemaDigest: `sha256:${"b".repeat(64)}` }).sample(EXPECTATION)).code,
    "updater_health_schema_mismatch");
  assert.equal((await fixture({ gatewayHealth: { schema: "control-room.fleet-health/v1", ready: true,
    maintenance: true } }).sample(EXPECTATION)).code, "updater_health_gateway_refused");
  assert.equal((await fixture({ workerHealth: { reconnectedCount: 0 } }).sample(EXPECTATION)).code,
    "updater_health_workers_missing");
  assert.equal((await fixture({ manifestsHealthy: false }).sample(EXPECTATION)).code,
    "updater_health_manifest_refused");
  let calls = 0;
  const changed = fixture({ supervisor: { snapshot: async () => ({ state: "running", childPid: 4243,
    generation: calls++ === 0 ? "generation-one" : "generation-two", pidAlive: true, logBytes: 100 }) } });
  assert.equal((await changed.sample(EXPECTATION)).code, "updater_health_generation_changed");
});

test("bad or missing evidence fails closed and a dropped request can be retried", async () => {
  assert.equal((await fixture({ reads: { projectCount: 1 } }).sample(EXPECTATION)).code,
    "updater_health_counts_refused");
  await assert.rejects(fixture().sample({ ...EXPECTATION, releaseId: "" }), /updater_health_expectation_refused/u);
  let dropped = true;
  const healthy = fixture(), retrying = fixture({ transport: async (url, init) => {
    if (dropped && url.endsWith(LOCAL_HOST_HEALTH_ENDPOINT_V1)) { dropped = false; throw new Error("dropped"); }
    return healthy.transport(url, init);
  } });
  assert.equal((await retrying.sample(EXPECTATION)).healthy, false);
  assert.equal((await retrying.sample(EXPECTATION)).healthy, true);
});

test("a starting host is progress only after the same live generation grows its log", async () => {
  let logBytes = 10;
  const evaluator = fixture({ supervisor: { snapshot: async () => ({ state: "starting", childPid: 4243,
    generation: "generation-one", pidAlive: true, logBytes }) } });
  assert.deepEqual(await evaluator.sample(EXPECTATION),
    { healthy: false, progress: false, code: "updater_host_starting" });
  logBytes = 11;
  assert.deepEqual(await evaluator.sample(EXPECTATION),
    { healthy: false, progress: true, code: "updater_host_starting" });
  assert.deepEqual(await evaluator.sample(EXPECTATION),
    { healthy: false, progress: false, code: "updater_host_starting" });
});

test("hostile slow and oversized web replies hit fixed bounds", async () => {
  const slow = fixture({ transport: async url => url.endsWith("/fleet/v1/health")
    ? json({ schema: "control-room.fleet-health/v1", ready: true, maintenance: false })
    : new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } }) });
  const began = Date.now(), slowResult = await slow.sample(EXPECTATION);
  assert.equal(slowResult.code, "updater_health_timeout");
  assert.ok(Date.now() - began < 2_000, "slowloris is cut off by the fixed one-second probe timeout");
  const oversized = fixture({ transport: async url => url.endsWith("/fleet/v1/health")
    ? json({ schema: "control-room.fleet-health/v1", ready: true, maintenance: false })
    : new Response("x".repeat(4_097), { headers: { "content-type": "application/json" } }) });
  assert.equal((await oversized.sample(EXPECTATION)).code, "updater_health_reply_too_large");
});

test("50 concurrent complete probes remain isolated", async () => {
  const evaluator = fixture();
  const results = await Promise.all(Array.from({ length: 50 }, () => evaluator.sample(EXPECTATION)));
  assert.equal(results.filter(result => result.healthy).length, 50);
});

test("the scheduled check uses the same evaluator object as Phase D can use", async () => {
  const calls = [], evaluator = { async sample(value) { calls.push(value); return { healthy: true }; } };
  const scheduled = new UpdaterScheduledHealthV1({ evaluator, expectation: async () => EXPECTATION,
    policy: async () => ({ scheduleIntervalMs: 30_000 }) });
  assert.deepEqual(await scheduled.tick(), { healthy: true });
  await scheduled.stop();
  assert.deepEqual(calls, [EXPECTATION]);
  assert.equal((await loadRunningHealthPolicyV1()).schema, "control-room.health-policy/v1");
});

test("the running policy supplies the 180-second default and 300-second loaded windows", async () => {
  const policy = await loadRunningHealthPolicyV1();
  assert.deepEqual({ windowMs: policy.windowMs, loadedWindowMs: policy.loadedWindowMs, loadThreshold: policy.loadThreshold },
    { windowMs: 180_000, loadedWindowMs: 300_000, loadThreshold: 14 });
  let now = 0, samples = 0;
  const evaluator = fixture();
  evaluator.policy = async () => policy;
  evaluator.loadAverage = () => 14;
  evaluator.clock = () => now;
  evaluator.sleep = async ms => { now += ms; };
  evaluator.sample = async () => { samples += 1; return { healthy: false, progress: false, code: "still_starting" }; };
  assert.deepEqual(await evaluator.evaluate(EXPECTATION), { healthy: false, progress: false, code: "still_starting" });
  assert.equal(now, 300_000);
  assert.ok(samples > 1);
});

test("the updater reuses the installed item-1 probe key and refuses unsafe file modes", async t => {
  const root = await mkdtemp(join(tmpdir(), "cr-health-key-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const service = join(root, "Protected", "service"), path = join(service, "health-probe.key");
  await mkdir(service, { recursive: true });
  await writeFile(path, `${KEY.toString("base64url")}\n`, { mode: 0o600 });
  assert.deepEqual(await readUpdaterHealthProbeKeyV1(root), KEY);
  await chmod(path, 0o644);
  await assert.rejects(readUpdaterHealthProbeKeyV1(root), /updater_health_probe_key_refused/u);
});

test("stopping halfway waits for the in-flight scheduled probe and starts no second caller", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const scheduled = new UpdaterScheduledHealthV1({ evaluator: { async sample() { calls += 1; await gate; return { healthy: true }; } },
    expectation: async () => EXPECTATION, policy: async () => ({ scheduleIntervalMs: 5_000 }) });
  const first = scheduled.tick();
  assert.equal(await scheduled.tick(), false);
  const stopping = scheduled.stop();
  release();
  assert.deepEqual(await first, { healthy: true });
  await stopping;
  assert.equal(calls, 1);
});
