import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const LOCAL_HOST_HEALTH_ENDPOINT_V1 = "/api/v1/local-host-health";
export const UPDATER_HEALTH_ENDPOINT_V1 = "/api/v1/updater-health";
export const HEALTH_NONCE_BYTES_V1 = 32;
export const HEALTH_NONCE_MAX_AGE_MS_V1 = 10_000;
export const HEALTH_NONCE_FUTURE_SKEW_MS_V1 = 2_000;
export const HEALTH_NONCE_LEDGER_LIMIT_V1 = 4_096;

function refuse(code) { throw Object.assign(new Error(code), { code }); }

function exactObject(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) refuse(code);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  refuse("health_canonical_value_refused");
}

function hmacHex(key, material) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) refuse("health_probe_key_refused");
  return createHmac("sha256", key).update(material, "utf8").digest("hex");
}

function constantTimeTagMatches(actual, expected) {
  const expectedBytes = Buffer.from(expected, "utf8");
  const validShape = typeof actual === "string" && /^hmac-sha256:[a-f0-9]{64}$/u.test(actual);
  const supplied = validShape ? Buffer.from(actual, "utf8") : Buffer.alloc(expectedBytes.length);
  const padded = supplied.length === expectedBytes.length ? supplied : Buffer.alloc(expectedBytes.length);
  return timingSafeEqual(padded, expectedBytes) && validShape && supplied.length === expectedBytes.length;
}

function requestMaterial(nonce, endpoint) { return `request\0${nonce}${endpoint}`; }
function responseMaterial(endpoint, response) { return `response\0${endpoint}\0${canonicalJson(response)}`; }

export function createHealthNonceV1(now = Date.now(), bytes = randomBytes) {
  if (!Number.isSafeInteger(now) || now < 0) refuse("health_nonce_clock_refused");
  const nonce = Buffer.alloc(HEALTH_NONCE_BYTES_V1);
  nonce.writeBigUInt64BE(BigInt(now));
  const entropy = bytes(HEALTH_NONCE_BYTES_V1 - 8);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== HEALTH_NONCE_BYTES_V1 - 8)
    refuse("health_nonce_entropy_refused");
  Buffer.from(entropy).copy(nonce, 8);
  return nonce.toString("base64url");
}

export function healthNonceTimeV1(nonce) {
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(nonce)) refuse("health_nonce_refused");
  const bytes = Buffer.from(nonce, "base64url");
  if (bytes.byteLength !== HEALTH_NONCE_BYTES_V1) refuse("health_nonce_refused");
  const value = bytes.readBigUInt64BE();
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) refuse("health_nonce_refused");
  return Number(value);
}

export function healthRequestTagV1(key, nonce, endpoint) {
  healthNonceTimeV1(nonce);
  if (![LOCAL_HOST_HEALTH_ENDPOINT_V1, UPDATER_HEALTH_ENDPOINT_V1].includes(endpoint))
    refuse("health_endpoint_refused");
  return `hmac-sha256:${hmacHex(key, requestMaterial(nonce, endpoint))}`;
}

export function healthResponseTagV1(key, endpoint, response) {
  return `hmac-sha256:${hmacHex(key, responseMaterial(endpoint, response))}`;
}

export function healthResponseTagMatchesV1(key, endpoint, response, tag) {
  return constantTimeTagMatches(tag, healthResponseTagV1(key, endpoint, response));
}

export class HealthNonceLedgerV1 {
  #seen = new Map();
  constructor({ maximum = HEALTH_NONCE_LEDGER_LIMIT_V1 } = {}) {
    if (!Number.isSafeInteger(maximum) || maximum < 50 || maximum > HEALTH_NONCE_LEDGER_LIMIT_V1)
      refuse("health_nonce_ledger_refused");
    this.maximum = maximum;
  }

  accept(nonce, issuedAt, now, maxAgeMs) {
    for (const [value, expiry] of this.#seen) if (expiry < now) this.#seen.delete(value);
    if (this.#seen.has(nonce)) return false;
    if (this.#seen.size >= this.maximum) refuse("health_nonce_ledger_full");
    this.#seen.set(nonce, issuedAt + maxAgeMs);
    return true;
  }

  get size() { return this.#seen.size; }
}

export function verifyHealthRequestV1({ key, endpoint, value, ledger, now = Date.now(),
  maxAgeMs = HEALTH_NONCE_MAX_AGE_MS_V1, futureSkewMs = HEALTH_NONCE_FUTURE_SKEW_MS_V1 }) {
  const request = exactObject(value, ["nonce", "reqTag"], "health_request_refused");
  const nonce = typeof request.nonce === "string" ? request.nonce : "";
  let issuedAt = 0, nonceValid = false, expected = "hmac-sha256:" + "0".repeat(64);
  try {
    issuedAt = healthNonceTimeV1(nonce); expected = healthRequestTagV1(key, nonce, endpoint); nonceValid = true;
  } catch {}
  if (!constantTimeTagMatches(request.reqTag, expected) || !nonceValid) refuse("health_request_auth_refused");
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1
      || !Number.isSafeInteger(futureSkewMs) || futureSkewMs < 0
      || issuedAt < now - maxAgeMs || issuedAt > now + futureSkewMs) refuse("health_request_stale");
  if (!(ledger instanceof HealthNonceLedgerV1) || !ledger.accept(nonce, issuedAt, now, maxAgeMs))
    refuse("health_request_replayed");
  return Object.freeze({ nonce, issuedAt });
}

export function captureUpdaterHealthCountsV1(value) {
  const counts = exactObject(value, ["homeSummaryCount", "projectCount", "updatesPanelCount", "homeRenderBytes",
    "planApprovalInsertAllowed"], "updater_health_counts_refused");
  for (const field of ["homeSummaryCount", "projectCount", "updatesPanelCount"]) {
    if (!Number.isSafeInteger(counts[field]) || counts[field] < 0 || counts[field] > 1_000_000)
      refuse("updater_health_counts_refused");
  }
  if (!Number.isSafeInteger(counts.homeRenderBytes) || counts.homeRenderBytes < 1
      || counts.homeRenderBytes > 4_194_304 || counts.planApprovalInsertAllowed !== true)
    refuse("updater_health_counts_refused");
  return Object.freeze({ homeSummaryCount: counts.homeSummaryCount, projectCount: counts.projectCount,
    updatesPanelCount: counts.updatesPanelCount, homeRenderBytes: counts.homeRenderBytes,
    planApprovalInsertAllowed: true });
}

export function captureUpdaterComparisonCountsV1(value) {
  const counts = exactObject(value, ["homeSummaryCount", "projectCount", "updatesPanelCount"],
    "updater_health_counts_refused");
  for (const field of ["homeSummaryCount", "projectCount", "updatesPanelCount"]) {
    if (!Number.isSafeInteger(counts[field]) || counts[field] < 0 || counts[field] > 1_000_000)
      refuse("updater_health_counts_refused");
  }
  return Object.freeze({ homeSummaryCount: counts.homeSummaryCount, projectCount: counts.projectCount,
    updatesPanelCount: counts.updatesPanelCount });
}

export { canonicalJson as canonicalHealthJsonV1, constantTimeTagMatches as healthTagMatchesV1 };
