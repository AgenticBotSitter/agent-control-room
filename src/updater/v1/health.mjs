import { readFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { assertSafeIdV1, updaterRefuseV1 } from "./contracts.mjs";
import { openNoFollowV1 } from "./fs-safety.mjs";
import { captureUpdaterComparisonCountsV1, captureUpdaterHealthCountsV1, createHealthNonceV1, healthRequestTagV1,
  healthResponseTagMatchesV1, LOCAL_HOST_HEALTH_ENDPOINT_V1, UPDATER_HEALTH_ENDPOINT_V1 } from "./health-protocol.mjs";

const HEALTH_POLICY_KEYS_V1 = Object.freeze(["schema", "windowMs", "loadedWindowMs", "loadThreshold",
  "probeTimeoutMs", "retryIntervalMs", "replyMaxBytes", "startedAtClockSkewMs", "workerHeartbeatWindowMs",
  "scheduleIntervalMs"]);

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function captureHealthPolicyV1(value) {
  if (!exactKeys(value, HEALTH_POLICY_KEYS_V1) || value.schema !== "control-room.health-policy/v1")
    throw updaterRefuseV1("updater_health_policy_refused");
  const bounds = {
    windowMs: [1_000, 300_000], loadedWindowMs: [1_000, 300_000], loadThreshold: [1, 100],
    probeTimeoutMs: [100, 5_000], retryIntervalMs: [50, 10_000], replyMaxBytes: [256, 16_384],
    startedAtClockSkewMs: [0, 10_000], workerHeartbeatWindowMs: [1_000, 300_000],
    scheduleIntervalMs: [5_000, 300_000],
  };
  for (const [name, [minimum, maximum]] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value[name]) || value[name] < minimum || value[name] > maximum)
      throw updaterRefuseV1("updater_health_policy_refused");
  }
  if (value.loadedWindowMs < value.windowMs) throw updaterRefuseV1("updater_health_policy_refused");
  return Object.freeze({ ...value });
}

/** Reads the policy adjacent to the executing updater bundle. Candidate app
 * releases cannot supply or override this URL. */
export async function loadRunningHealthPolicyV1() {
  let value;
  try { value = JSON.parse(await readFile(new URL("./policy/health.json", import.meta.url), "utf8")); }
  catch { throw updaterRefuseV1("updater_health_policy_refused"); }
  return captureHealthPolicyV1(value);
}

export async function readUpdaterHealthProbeKeyV1(root) {
  let encoded, handle;
  try {
    // Item 1 creates this independent key for the running host. Reuse exactly
    // that installation-private key rather than introducing a second secret.
    handle = await openNoFollowV1(root, "Protected/service/health-probe.key");
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > 64 || (entry.mode & 0o077) !== 0)
      throw updaterRefuseV1("updater_health_probe_key_refused");
    encoded = (await handle.readFile("utf8")).trim();
  } catch { throw updaterRefuseV1("updater_health_probe_key_refused"); }
  finally { await handle?.close().catch(() => {}); }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw updaterRefuseV1("updater_health_probe_key_refused");
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength !== 32) throw updaterRefuseV1("updater_health_probe_key_refused");
  return key;
}

async function boundedJsonResponseV1(response, { timeoutMs, maximumBytes }) {
  if (!response || response.status !== 200 || !response.body
      || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    throw updaterRefuseV1("updater_health_http_refused");
  const reader = response.body.getReader(), chunks = [];
  let size = 0, timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(updaterRefuseV1("updater_health_timeout")); }, timeoutMs);
  });
  try {
    const bytes = await Promise.race([deadline, (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximumBytes) throw updaterRefuseV1("updater_health_reply_too_large");
        chunks.push(value);
      }
      return Buffer.concat(chunks.map(value => Buffer.from(value)), size);
    })()]);
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error?.code) throw error;
    throw updaterRefuseV1("updater_health_reply_refused");
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

async function fetchBoundedJsonV1(transport, url, init, policy) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), policy.probeTimeoutMs);
  try {
    const response = await transport(url, { ...init, signal: controller.signal });
    return await boundedJsonResponseV1(response, { timeoutMs: policy.probeTimeoutMs,
      maximumBytes: policy.replyMaxBytes });
  } catch (error) {
    if (error?.code) throw error;
    throw updaterRefuseV1("updater_health_transport_failed");
  } finally { clearTimeout(timer); }
}

function loopbackOrigin(value, code) {
  let url;
  try { url = new URL(value); } catch { throw updaterRefuseV1(code); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/"
      || url.search || url.hash) throw updaterRefuseV1(code);
  return url.origin;
}

function captureExpectationV1(value) {
  if (!exactKeys(value, ["releaseId", "startedAfter", "schemaDigest", "previousWorkerCount"]))
    throw updaterRefuseV1("updater_health_expectation_refused");
  assertSafeIdV1(value.releaseId, "updater_health_expectation_refused");
  if (typeof value.startedAfter !== "string" || !Number.isFinite(Date.parse(value.startedAfter))
      || typeof value.schemaDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.schemaDigest)
      || !Number.isSafeInteger(value.previousWorkerCount) || value.previousWorkerCount < 0
      || value.previousWorkerCount > 10_000) throw updaterRefuseV1("updater_health_expectation_refused");
  return Object.freeze({ ...value });
}

function captureSupervisorV1(value) {
  if (!exactKeys(value, ["state", "childPid", "generation", "pidAlive", "logBytes"]) || !["running", "starting"].includes(value.state)
      || !Number.isSafeInteger(value.childPid) || value.childPid <= 1 || typeof value.generation !== "string"
      || !/^[A-Za-z0-9._-]{1,80}$/u.test(value.generation) || value.pidAlive !== true
      || !Number.isSafeInteger(value.logBytes) || value.logBytes < 0)
    throw updaterRefuseV1("updater_health_supervisor_refused");
  return Object.freeze({ ...value });
}

async function authenticatedPostV1({ transport, origin, endpoint, key, policy, clock }) {
  const nonce = createHealthNonceV1(clock());
  const value = await fetchBoundedJsonV1(transport, `${origin}${endpoint}`, { method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ nonce, reqTag: healthRequestTagV1(key, nonce, endpoint) }) }, policy);
  return { nonce, value };
}

function captureHostResponseV1(key, nonce, value) {
  const keys = ["schema", "nonce", "ready", "pid", "releaseId", "startedAt", "tag"];
  if (!exactKeys(value, keys) || value.schema !== "control-room.local-host-health/v1" || value.nonce !== nonce
      || value.ready !== true || !Number.isSafeInteger(value.pid) || value.pid <= 1 || typeof value.releaseId !== "string"
      || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt)) || typeof value.tag !== "string")
    throw updaterRefuseV1("updater_host_health_refused");
  const response = { schema: value.schema, nonce: value.nonce, ready: value.ready, pid: value.pid,
    releaseId: value.releaseId, startedAt: value.startedAt };
  if (!healthResponseTagMatchesV1(key, LOCAL_HOST_HEALTH_ENDPOINT_V1, response, value.tag))
    throw updaterRefuseV1("updater_host_health_auth_refused");
  return Object.freeze(response);
}

function captureWebResponseV1(key, nonce, value) {
  const keys = ["schema", "nonce", "ready", "homeSummaryCount", "projectCount", "updatesPanelCount",
    "homeRenderBytes", "planApprovalInsertAllowed", "tag"];
  if (!exactKeys(value, keys) || value.schema !== "control-room.updater-health/v1" || value.nonce !== nonce
      || value.ready !== true || typeof value.tag !== "string") throw updaterRefuseV1("updater_web_health_refused");
  const counts = captureUpdaterHealthCountsV1({ homeSummaryCount: value.homeSummaryCount,
    projectCount: value.projectCount, updatesPanelCount: value.updatesPanelCount,
    homeRenderBytes: value.homeRenderBytes, planApprovalInsertAllowed: value.planApprovalInsertAllowed });
  const response = { schema: value.schema, nonce: value.nonce, ready: value.ready, ...counts };
  if (!healthResponseTagMatchesV1(key, UPDATER_HEALTH_ENDPOINT_V1, response, value.tag))
    throw updaterRefuseV1("updater_web_health_auth_refused");
  return Object.freeze(response);
}

function sameCountsV1(left, right) {
  return left.homeSummaryCount === right.homeSummaryCount && left.projectCount === right.projectCount
    && left.updatesPanelCount === right.updatesPanelCount;
}

export class UpdaterHealthEvaluatorV1 {
  #starting;
  constructor({ root, configuration, reads, database, supervisor, gateway, workers, manifests,
    transport = fetch, policy = loadRunningHealthPolicyV1, key = () => readUpdaterHealthProbeKeyV1(root),
    clock = Date.now, loadAverage = () => loadavg()[0], sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    this.root = root; this.configuration = configuration; this.reads = reads; this.database = database;
    this.supervisor = supervisor; this.gateway = gateway; this.workers = workers; this.manifests = manifests;
    this.transport = transport; this.policy = policy; this.key = key; this.clock = clock;
    this.loadAverage = loadAverage; this.sleep = sleep;
  }

  async sample(rawExpectation) {
    const expectation = captureExpectationV1(rawExpectation), policy = await this.policy();
    try {
      const config = await this.configuration.read();
      if (!exactKeys(config, ["webOrigin", "gatewayOrigin"])) throw updaterRefuseV1("updater_health_config_refused");
      const webOrigin = loopbackOrigin(config.webOrigin, "updater_health_config_refused");
      const gatewayOrigin = loopbackOrigin(config.gatewayOrigin, "updater_health_config_refused");
      const key = await this.key(), before = captureSupervisorV1(await this.supervisor.snapshot());
      if (before.state === "starting") {
        const prior = this.#starting;
        const progress = prior?.generation === before.generation && prior?.childPid === before.childPid
          && before.logBytes > prior.logBytes;
        this.#starting = before;
        return Object.freeze({ healthy: false, progress, code: "updater_host_starting" });
      }
      this.#starting = undefined;
      const [hostRaw, webRaw, updaterCounts, schemaDigest, gatewayHealth, workerHealth, manifestsHealthy] = await Promise.all([
        authenticatedPostV1({ transport: this.transport, origin: webOrigin,
          endpoint: LOCAL_HOST_HEALTH_ENDPOINT_V1, key, policy, clock: this.clock }),
        authenticatedPostV1({ transport: this.transport, origin: webOrigin,
          endpoint: UPDATER_HEALTH_ENDPOINT_V1, key, policy, clock: this.clock }),
        this.reads.readHealthCounts(), this.database.schemaDigest(),
        fetchBoundedJsonV1(this.gateway.transport ?? this.transport, `${gatewayOrigin}/fleet/v1/health`,
          { method: "GET", headers: { accept: "application/json" } }, policy),
        expectation.previousWorkerCount === 0 ? Promise.resolve({ reconnectedCount: 0 })
          : this.workers.reconnected({ since: expectation.startedAfter, withinMs: policy.workerHeartbeatWindowMs }),
        this.manifests.verifyKnownGood(),
      ]);
      const after = captureSupervisorV1(await this.supervisor.snapshot());
      const host = captureHostResponseV1(key, hostRaw.nonce, hostRaw.value);
      const web = captureWebResponseV1(key, webRaw.nonce, webRaw.value);
      const expectedCounts = captureUpdaterComparisonCountsV1(updaterCounts);
      if (before.generation !== after.generation || before.childPid !== after.childPid || host.pid !== before.childPid)
        throw updaterRefuseV1("updater_health_generation_changed");
      if (host.releaseId !== expectation.releaseId) throw updaterRefuseV1("updater_health_release_mismatch");
      const startedAt = Date.parse(host.startedAt), flippedAt = Date.parse(expectation.startedAfter), now = this.clock();
      if (startedAt + policy.startedAtClockSkewMs < flippedAt || startedAt > now + policy.startedAtClockSkewMs)
        throw updaterRefuseV1("updater_health_clock_refused");
      if (!sameCountsV1(web, expectedCounts)) throw updaterRefuseV1("updater_health_count_mismatch");
      if (schemaDigest !== expectation.schemaDigest) throw updaterRefuseV1("updater_health_schema_mismatch");
      if (!exactKeys(gatewayHealth, ["schema", "ready", "maintenance"])
          || gatewayHealth.schema !== "control-room.fleet-health/v1" || gatewayHealth.ready !== true
          || gatewayHealth.maintenance !== false) throw updaterRefuseV1("updater_health_gateway_refused");
      if (expectation.previousWorkerCount > 0 && (!exactKeys(workerHealth, ["reconnectedCount"])
          || !Number.isSafeInteger(workerHealth.reconnectedCount) || workerHealth.reconnectedCount < 1))
        throw updaterRefuseV1("updater_health_workers_missing");
      if (manifestsHealthy !== true) throw updaterRefuseV1("updater_health_manifest_refused");
      return Object.freeze({ healthy: true, progress: false, code: null });
    } catch (error) {
      return Object.freeze({ healthy: false, progress: false,
        code: typeof error?.code === "string" ? error.code : "updater_health_failed" });
    }
  }

  async evaluate(expectation) {
    const policy = await this.policy(), started = this.clock();
    const loaded = Number(await this.loadAverage()) >= policy.loadThreshold;
    const deadline = started + (loaded ? policy.loadedWindowMs : policy.windowMs);
    let result;
    do {
      result = await this.sample(expectation);
      if (result.healthy) return result;
      const remaining = deadline - this.clock();
      if (remaining <= 0) return result;
      await this.sleep(Math.min(policy.retryIntervalMs, remaining));
    } while (true);
  }

  async fullHealth(expectation) { return (await this.evaluate(expectation)).healthy; }
}

/** The timer and Phase-D callers both receive the same evaluator instance. */
export class UpdaterScheduledHealthV1 {
  #timer; #checking = false; #current;
  constructor({ evaluator, expectation, onResult = () => {}, onError = () => {}, policy = loadRunningHealthPolicyV1 }) {
    this.evaluator = evaluator; this.expectation = expectation; this.onResult = onResult;
    this.onError = onError; this.policy = policy;
  }
  async tick() {
    if (this.#checking) return false;
    this.#checking = true;
    this.#current = (async () => {
      const result = await this.evaluator.sample(await this.expectation());
      await this.onResult(result); return result;
    })();
    try { return await this.#current; }
    finally { this.#checking = false; this.#current = undefined; }
  }
  async start() {
    if (this.#timer) return this;
    const policy = await this.policy();
    this.#timer = setInterval(() => void this.tick().catch(error => this.onError(error)), policy.scheduleIntervalMs);
    return this;
  }
  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    try { await this.#current; } catch (error) { this.onError(error); }
  }
}
