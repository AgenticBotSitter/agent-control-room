import { parseStrictJsonV1 } from "../../../installer/shared/strict-json.mjs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readlink } from "node:fs/promises";
import { join } from "node:path";
import { updaterRefuseV1 } from "../contracts.mjs";

export const DEFAULT_HEALTH_WEB_PORT_V1 = 3210;
/** `installer.mjs` `DEFAULT_CONTROL_ROOM_GATEWAY_PORT_V1`; the install passes its own. */
export const DEFAULT_HEALTH_GATEWAY_PORT_V1 = 3211;
export const HEALTH_RESPONSE_LIMIT_BYTES_V1 = 4096;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const safeIdPattern = /^[A-Za-z0-9._-]{1,160}$/u;
const releaseTargetPattern = /^releases\/([A-Za-z0-9._-]{1,160})$/u;
const exactKeys = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...names].sort().join(",");
const refuse = code => { throw updaterRefuseV1(code); };

async function readHealthProbeKeyV1(root) {
  let handle;
  try {
    handle = await open(join(root, "updater-state", "health-probe.key"),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o777) !== 0o600
      || entry.uid !== (process.geteuid?.() ?? entry.uid) || entry.size < 43 || entry.size > 44) {
      refuse("health_probe_key_refused");
    }
    const encoded = (await handle.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) refuse("health_probe_key_refused");
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32) refuse("health_probe_key_refused");
    return key;
  } catch (error) {
    if (error?.code?.startsWith?.("health_")) throw error;
    refuse("health_probe_key_refused");
  } finally { await handle?.close().catch(() => {}); }
}

async function readCurrentReleaseV1(root) {
  try {
    const value = await readlink(join(root, "current"));
    if (!releaseTargetPattern.test(value)) refuse("health_release_mismatch");
    return value;
  } catch (error) {
    if (error?.code === "health_release_mismatch") throw error;
    refuse("health_release_mismatch");
  }
}

async function boundedJsonV1(response, limit, refused = "health_web_refused") {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d{1,9}$/u.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel().catch(() => {}); refuse("health_web_response_too_large");
  }
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    || !response.body) refuse(refused);
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); refuse("health_web_response_too_large"); }
      chunks.push(value);
    }
  } catch (error) {
    if (error?.code?.startsWith?.("health_")) throw error;
    refuse(refused);
  }
  try { return parseStrictJsonV1(Buffer.concat(chunks.map(value => Buffer.from(value)), length).toString("utf8")); }
  catch { refuse(refused); }
}

function verifyWebHealthV1(value, { key, nonce, expectedRelease }) {
  if (!exactKeys(value, ["schema", "ready", "pid", "nonce", "releaseId", "startedAt", "tag"])
    || value.schema !== "control-room.local-host-health/v1" || value.ready !== true
    || !Number.isSafeInteger(value.pid) || value.pid <= 1 || value.nonce !== nonce
    || value.releaseId !== expectedRelease || typeof value.startedAt !== "string"
    || !Number.isFinite(Date.parse(value.startedAt)) || typeof value.tag !== "string") refuse("health_web_refused");
  const material = JSON.stringify({ nonce, pid: value.pid, purpose: "local-host-health/v1", ready: true,
    releaseId: value.releaseId, startedAt: value.startedAt });
  const expected = `hmac-sha256:${createHmac("sha256", key).update(material, "utf8").digest("hex")}`;
  const actualBytes = Buffer.from(value.tag, "utf8"), expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) refuse("health_web_refused");
  return Object.freeze({ pid: value.pid, releaseId: value.releaseId, startedAt: value.startedAt });
}

export async function checkWebHealthV1(input, runtime = {}) {
  if (!input || typeof input !== "object") refuse("health_web_refused");
  const port = input.webPort ?? DEFAULT_HEALTH_WEB_PORT_V1;
  const release = releaseTargetPattern.exec(input.expectedRelease ?? "");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535 || !release) {
    refuse("health_web_refused");
  }
  const key = runtime.healthProbeKey ?? await (runtime.readHealthProbeKey ?? readHealthProbeKeyV1)(input.root);
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) refuse("health_probe_key_refused");
  const nonce = (runtime.randomBytes ?? randomBytes)(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce)) refuse("health_web_refused");
  const origin = `http://127.0.0.1:${port}`;
  let response;
  try {
    // `redirect: "error"`: an answer from anywhere but this port is no answer (atk-fa F14).
    response = await (runtime.transport ?? fetch)(`${origin}/api/v1/local-host-health`, { method: "POST",
      headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ nonce }), redirect: "error",
      signal: AbortSignal.timeout(runtime.timeoutMs ?? 1_000) });
  } catch { refuse("health_web_refused"); }
  return verifyWebHealthV1(await boundedJsonV1(response, runtime.responseLimitBytes ?? HEALTH_RESPONSE_LIMIT_BYTES_V1),
    { key, nonce, expectedRelease: release[1] });
}

/** The fleet gateway's tagged `POST /fleet/v1/local-health`. MEASURED (cl-bringup
 * N-H): before the gateway was checked at all, an install whose gateway had exited
 * passed health. And the unauthenticated `GET /fleet/v1/health` it then checked
 * answered `{"ready":true}` for ANY local process on that port, or for a redirect
 * to one (atk-fa F14): the gateway now tags a fresh nonce with the installation's
 * health-probe key, exactly as the web host does, and redirects are refused. */
function verifyGatewayHealthV1(value, { key, nonce }) {
  if (!exactKeys(value, ["schema", "ready", "pid", "nonce", "tag"]) || value.schema !== "control-room.fleet-gateway-health/v1"
    || value.ready !== true || !Number.isSafeInteger(value.pid) || value.pid <= 1 || value.nonce !== nonce
    || typeof value.tag !== "string") refuse("health_gateway_refused");
  const material = JSON.stringify({ nonce, pid: value.pid, purpose: "fleet-gateway-health/v1", ready: true });
  const expected = `hmac-sha256:${createHmac("sha256", key).update(material, "utf8").digest("hex")}`;
  const actualBytes = Buffer.from(value.tag, "utf8"), expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) refuse("health_gateway_refused");
  return Object.freeze({ ready: true, pid: value.pid });
}

export async function checkGatewayHealthV1(input, runtime = {}) {
  if (!input || typeof input !== "object") refuse("health_gateway_refused");
  const port = input.gatewayPort ?? DEFAULT_HEALTH_GATEWAY_PORT_V1;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535
    || port === (input.webPort ?? DEFAULT_HEALTH_WEB_PORT_V1)) refuse("health_gateway_refused");
  const key = runtime.healthProbeKey ?? await (runtime.readHealthProbeKey ?? readHealthProbeKeyV1)(input.root);
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) refuse("health_probe_key_refused");
  const nonce = (runtime.randomBytes ?? randomBytes)(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce)) refuse("health_gateway_refused");
  let response;
  try {
    response = await (runtime.transport ?? fetch)(`http://127.0.0.1:${port}/fleet/v1/local-health`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce }), redirect: "error",
      signal: AbortSignal.timeout(runtime.timeoutMs ?? 1_000) });
  } catch { refuse("health_gateway_refused"); }
  return verifyGatewayHealthV1(await boundedJsonV1(response, runtime.responseLimitBytes ?? HEALTH_RESPONSE_LIMIT_BYTES_V1,
    "health_gateway_refused"), { key, nonce });
}

/** C7 owns the existing HTTP probe. M4 supplies `checkDatabase`; absence is a
 * typed refusal, never an optimistic HTTP-only install acceptance. */
export async function checkHealthV1(input, ports = {}, runtime = {}) {
  if (!input || typeof input !== "object" || typeof input.root !== "string" || !input.root.startsWith("/")
    || !releaseTargetPattern.test(input.expectedRelease ?? "") || !digestPattern.test(input.schemaDigest ?? "")
    || !digestPattern.test(input.updaterSchemaDigest ?? "") || !safeIdPattern.test(input.pgDataId ?? "")) {
    refuse("health_input_refused");
  }
  if (typeof ports.checkDatabase !== "function") refuse("health_database_port_unavailable");
  const samples = input.samples ?? 3;
  if (samples !== 3) refuse("health_input_refused");
  const current = await (ports.readCurrentRelease ?? readCurrentReleaseV1)(input.root);
  if (current !== input.expectedRelease) refuse("health_release_mismatch");
  for (let sample = 0; sample < samples; sample += 1) {
    const database = await ports.checkDatabase({ root: input.root, pgDataId: input.pgDataId,
      schemaDigest: input.schemaDigest, updaterSchemaDigest: input.updaterSchemaDigest });
    if (!exactKeys(database, ["healthy", "schemaDigest", "updaterSchemaDigest"])
      || database.healthy !== true || database.schemaDigest !== input.schemaDigest
      || database.updaterSchemaDigest !== input.updaterSchemaDigest) refuse("health_database_refused");
    await checkWebHealthV1(input, runtime);
    await checkGatewayHealthV1(input, runtime);
    if (sample + 1 < samples) await (runtime.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(
      runtime.sampleIntervalMs ?? 5_000);
  }
  return Object.freeze({ healthy: true, samples, schemaDigest: input.schemaDigest });
}
