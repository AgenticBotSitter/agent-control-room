// The fleet gateway: HTTP request bodies and headers from connectors, including bot result
// uploads, chunk bodies and chunk headers, driven over a raw loopback socket so malformed HTTP
// (bad lengths, chunked bodies, duplicate headers, control characters) reaches the real parser.
import { createServer } from "node:http";
import { connect } from "node:net";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createFleetGatewayHandlerV1, FLEET_BODY_LIMITS_V1 } from "../../../src/fleet/v1/gateway-http.ts";
import { FleetErrorV1, fleetFail } from "../../../src/fleet/v1/errors.ts";
import { releaseKeyIdV1, RELEASE_TRUST_SCHEMA_V1 } from "../../../scripts/release-signing.mjs";
import { isPostgresJsonTextV1 } from "../../../src/persistence/postgres-text.ts";

const WID = `fleet-worker:${"a".repeat(32)}`, GOOD = "crf_" + "B".repeat(43);
const CLAIM = `fleet-claim:${"1".repeat(32)}`, UPLOAD = `result-upload:${"2".repeat(32)}`;
const releaseKeys = generateKeyPairSync("ed25519");
const publicKey = releaseKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const releaseTrust = { schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: releaseKeyIdV1(publicKey), publicKey, versionFloor: "0.1.0", revokedKeyIds: [] };
const principal = Object.freeze({ workerId: WID, tenantId: "tenant:1", identityId: "identity:1", projectIds: ["project:a"], credentialExpiresAt: "2027-01-01T00:00:00.000Z", workerKind: "codex" });
const KNOWN_ERRORS = new Set(["unauthenticated", "forbidden", "not_found", "conflict", "invalid", "too_large", "rate_limited", "expired", "unavailable", "paused", "worker_kind_mismatch", "refused_secret_material", "refused"]);

let calls = [], unexpected = [];
const record = (method, args) => { calls.push({ method, args }); };
const store = {
  async authenticate({ bearer, declaredWorkerId }) { if (bearer === GOOD && declaredWorkerId === WID) return principal; fleetFail("unauthenticated"); },
  async enroll(body) { record("enroll", body); if (typeof body.code !== "string" || !/^crj_[A-Za-z0-9_-]{43}$/u.test(body.code) || typeof body.credentialDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(body.credentialDigest)) fleetFail("invalid"); return { workerId: `fleet-worker:${"b".repeat(32)}`, replayed: false }; },
  me(p) { record("me", p); return { workerId: p.workerId }; },
  async listWork(p) { record("listWork", p); return { offers: [] }; },
  async waitWork(p) { record("waitWork", p); return { offers: [] }; },
  async recordWaitPresence(p) { record("recordWaitPresence", p); },
  async myClaims(p) { record("myClaims", p); return []; },
  async recordMcpCall(p, body) { record("recordMcpCall", body); return { recorded: true }; },
  async recordRefusedMcpAuthentication(input) { record("recordRefusedMcpAuthentication", input); },
  async heartbeat(p, body) { record("heartbeat", body); return { ok: true }; },
  async rotate(p, body) { record("rotate", body); return { rotated: true }; },
  async claim(p, body) { record("claim", body); return { claimId: CLAIM, replayed: false }; },
  async progress(p, body) { record("progress", body); return { recorded: true }; },
  async blocker(p, body) { record("blocker", body); return { recorded: true }; },
  async submitResult(p, body) { record("submitResult", body); return { resultId: `fleet-result:${"3".repeat(32)}`, replayed: false }; },
};
const uploads = {
  async declaredOutputs(p, claimId) { record("declaredOutputs", { claimId }); return []; },
  async reserve(p, input) { record("reserve", input); return { uploadId: UPLOAD }; },
  async chunk(p, input) { record("chunk", { ...input, bytes: input.bytes?.byteLength }); return { received: true }; },
  async finalise(p, input) { record("finalise", input); return { published: true }; },
  async voidUpload(p, input) { record("voidUpload", input); return { voided: true }; },
  async inputs(p, claimId) { record("inputs", { claimId }); return []; },
  async inputBytes(p, input) { record("inputBytes", input); return { ordinal: 1, displayName: "a.txt", contentDigest: `sha256:${"0".repeat(64)}`, sizeBytes: 2, bytes: new Uint8Array([104, 105]) }; },
};
const proposals = { async submit(input) { record("proposal", input); return { accepted: true, batchId: "batch:1" }; } };
const healthProbeKey = Buffer.alloc(32, 9);
let server, port;

const chunkBytes = n => Buffer.alloc(n, 0x41);
const digestOf = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const auth = () => [["authorization", `Bearer ${GOOD}`], ["x-control-room-worker", WID]];
const json = value => Buffer.from(JSON.stringify(value));
const enroll = () => ({ code: "crj_" + "A".repeat(43), workerKind: "codex", credentialDigest: `sha256:${"0".repeat(64)}`, platform: "darwin", architecture: "arm64", connectorVersion: "1.2.3", clientNonce: "n".repeat(16) });
const templates = {
  health: () => ({ method: "GET", path: "/fleet/v1/health", headers: [], body: Buffer.alloc(0) }),
  localHealth: () => ({ method: "POST", path: "/fleet/v1/local-health", headers: [["content-type", "application/json"]], body: json({ nonce: "A".repeat(43) }) }),
  enroll: () => ({ method: "POST", path: "/fleet/v1/enroll", headers: [["content-type", "application/json"]], body: json(enroll()) }),
  me: () => ({ method: "GET", path: "/fleet/v1/me", headers: auth(), body: Buffer.alloc(0) }),
  work: () => ({ method: "GET", path: "/fleet/v1/work", headers: auth(), body: Buffer.alloc(0) }),
  wait: () => ({ method: "GET", path: "/fleet/v1/work/wait", headers: auth(), body: Buffer.alloc(0) }), // long poll: rare, see generate
  heartbeat: () => ({ method: "POST", path: "/fleet/v1/heartbeat", headers: [...auth(), ["content-type", "application/json"]], body: json({ connectorVersion: "1.2.3", platform: "darwin", adapterCapabilities: ["codex"] }) }),
  rotate: () => ({ method: "POST", path: "/fleet/v1/rotate", headers: [...auth(), ["content-type", "application/json"]], body: json({ newCredentialDigest: `sha256:${"1".repeat(64)}` }) }),
  claim: () => ({ method: "POST", path: "/fleet/v1/claims", headers: [...auth(), ["content-type", "application/json"]], body: json({ offerId: `fleet-offer:${"4".repeat(32)}`, idempotencyKey: "key-0123456789abc" }) }),
  mcp: () => ({ method: "POST", path: "/fleet/v1/mcp/calls", headers: [...auth(), ["content-type", "application/json"], ["x-control-room-mcp-call", "call-1"], ["x-control-room-mcp-tool", "control_room_read_project"]], body: json({ callId: "call-1", toolName: "control_room_read_project" }) }),
  progress: () => ({ method: "POST", path: `/fleet/v1/claims/${CLAIM}/progress`, headers: [...auth(), ["content-type", "application/json"]], body: json({ message: "working", idempotencyKey: "key-0123456789abc" }) }),
  blocker: () => ({ method: "POST", path: `/fleet/v1/claims/${CLAIM}/blocker`, headers: [...auth(), ["content-type", "application/json"]], body: json({ message: "stuck", idempotencyKey: "key-0123456789abc", release: true }) }),
  result: () => ({ method: "POST", path: `/fleet/v1/claims/${CLAIM}/result`, headers: [...auth(), ["content-type", "application/json"]], body: json({ summary: "done", idempotencyKey: "key-0123456789abc", files: [{ name: "a.txt", mediaType: "text/plain", contentBase64: "aGk=" }] }) }),
  reserve: () => ({ method: "POST", path: `/fleet/v1/claims/${CLAIM}/reserve`, headers: [...auth(), ["content-type", "application/json"]], body: json({ ordinal: 1, sizeBytes: 2, contentDigest: `sha256:${"5".repeat(64)}`, mediaType: "text/plain" }) }),
  finalise: () => ({ method: "POST", path: `/fleet/v1/claims/${CLAIM}/finalise`, headers: [...auth(), ["content-type", "application/json"]], body: json({ uploadId: UPLOAD, publish: true }) }),
  void: () => ({ method: "POST", path: `/fleet/v1/claims/${CLAIM}/void`, headers: [...auth(), ["content-type", "application/json"]], body: json({ uploadId: UPLOAD, reason: "retry" }) }),
  outputs: () => ({ method: "GET", path: `/fleet/v1/claims/${CLAIM}/outputs`, headers: auth(), body: Buffer.alloc(0) }),
  inputs: () => ({ method: "GET", path: `/fleet/v1/claims/${CLAIM}/inputs`, headers: auth(), body: Buffer.alloc(0) }),
  inputBytes: () => ({ method: "GET", path: `/fleet/v1/claims/${CLAIM}/inputs/1`, headers: auth(), body: Buffer.alloc(0) }),
  chunk: () => { const bytes = chunkBytes(2); return { method: "POST", path: `/fleet/v1/claims/${CLAIM}/uploads/${UPLOAD}/chunks`, headers: [...auth(), ["content-type", "application/octet-stream"], ["x-control-room-chunk-ordinal", "1"], ["x-control-room-chunk-digest", digestOf(bytes)]], body: bytes }; },
  proposal: () => ({ method: "POST", path: "/fleet/v1/projects/project%3Aa/proposals", headers: [...auth(), ["content-type", "application/json"]], body: json({ idempotencyKey: "key-0123456789abc", proposal: { title: "Do a thing", steps: ["one"] } }) }),
};

function mutateHeaders(rng, headers) {
  const out = headers.map(([k, v]) => [k, v]);
  const op = rng.int(0, 11);
  const i = out.length ? rng.int(0, out.length - 1) : 0;
  if (op === 0 && out.length) out.splice(i, 1);
  else if (op === 1 && out.length) out[i][1] = rng.mutateString(out[i][1]);
  else if (op === 2 && out.length) out.push([out[i][0], rng.bool() ? out[i][1] : rng.nasty(20)]); // duplicate header
  else if (op === 3) out.push([rng.pick(["content-length", "transfer-encoding", "expect", "x-forwarded-for", "cf-connecting-ip", "host", "connection", "x-control-room-chunk-ordinal", "x-control-room-chunk-digest", "authorization", "cookie"]), rng.pick(["0", "-1", "1e3", "chunked", "100-continue", "127.0.0.1, 10.0.0.1", "", rng.nasty(16), "9".repeat(10), "999999999", "identity", "gzip"])]);
  else if (op === 4 && out.length) out[i][0] = rng.pick([out[i][0].toUpperCase(), out[i][0] + " ", " " + out[i][0], out[i][0].replace("-", "_"), rng.nasty(8)]);
  else if (op === 5) out.push(["x-control-room-worker", rng.pick([WID, WID.toUpperCase(), WID + "x", "fleet-worker:" + "z".repeat(32), ""])]);
  else if (op === 6) out.push(["authorization", rng.pick([`Bearer ${GOOD}`, `bearer ${GOOD}`, `Bearer  ${GOOD}`, `Bearer ${GOOD} `, "Bearer", "Basic xyz", `Bearer ${GOOD}\u0000`, `Bearer ${rng.nasty(43)}`])]);
  else if (op === 7 && out.length) out[i][1] = out[i][1] + "\r\nx-injected: 1";
  else if (op === 8) out.push(["content-type", rng.pick(["application/json", "application/json; charset=utf-8", "APPLICATION/JSON", " application/json", "application/json ;", "text/json", "application/octet-stream", "application/octet-stream; x=1", "", "multipart/form-data", "application/json\u0000"])]);
  else if (op === 9 && out.length) out[i][1] = rng.unicode(rng.int(1, 20));
  else if (op === 10) out.push([rng.ascii(rng.int(1, 40)), "x".repeat(rng.int(1, 9000))]);
  return out;
}
function mutatePath(rng, path) {
  const op = rng.int(0, 9);
  if (op === 0) return path + rng.pick(["?x=1", "#f", "/", "//", "%2F", "%00", "?", "/..", "/../enroll", "%2e%2e/"]);
  if (op === 1) return path.replace(/[a-f0-9]{32}/u, rng.pick(["A".repeat(32), "0".repeat(31), "0".repeat(33), "%30".repeat(32), rng.hex(32)]));
  if (op === 2) return path.toUpperCase();
  if (op === 3) return rng.mutateString(path);
  if (op === 4) return path.replace("/fleet/v1/", rng.pick(["/fleet/v2/", "/fleet/v1//", "/Fleet/v1/", "/fleet/v1/./", "//fleet/v1/", "/fleet/v1/../v1/"]));
  if (op === 5) return path.replace("project%3Aa", rng.pick(["project:a", "project%3Ab", "project%253Aa", "project%3Aa%2F..", "%", "a".repeat(200), "project%3Aa/"]));
  if (op === 6) return path.replace(/\/inputs\/1$/u, rng.pick(["/inputs/0", "/inputs/99", "/inputs/100", "/inputs/-1", "/inputs/01", "/inputs/1.0"]));
  if (op === 7) return "/fleet/v1/" + rng.nasty(16);
  if (op === 8) return "http://evil.invalid" + path;
  return "*";
}
function mutateBody(rng, template, body) {
  if (template === "chunk") { const n = rng.pick([0, 1, 2, 3, 4096, 8 * 1024 * 1024, 8 * 1024 * 1024 + 4096, 8 * 1024 * 1024 + 4097, rng.int(0, 70000)]); return chunkBytes(n); }
  const r = rng.float();
  if (r < 0.5) { try { return json(rng.mutate(JSON.parse(body.toString("utf8")), rng.int(1, 3))); } catch { return body; } }
  if (r < 0.8) return Buffer.from(rng.mutateText(body.toString("utf8"), rng.int(1, 3)), "utf8");
  if (r < 0.9) return Buffer.from(rng.bytes(rng.int(0, 300)));
  return Buffer.from(JSON.stringify(rng.jsonValue(0, 5)));
}

function serialize(rng, req, options = {}) {
  const lines = [`${req.method} ${req.path} HTTP/1.1`];
  const headers = [...req.headers];
  const hasHost = headers.some(([k]) => k.toLowerCase() === "host");
  if (!hasHost) headers.unshift(["host", "127.0.0.1"]);
  const clMode = options.clMode ?? "exact";
  const hasCl = headers.some(([k]) => k.toLowerCase() === "content-length" || k.toLowerCase() === "transfer-encoding");
  let body = req.body;
  if (clMode === "chunked") { headers.push(["transfer-encoding", "chunked"]); body = Buffer.concat([Buffer.from(`${req.body.length.toString(16)}\r\n`), req.body, Buffer.from("\r\n0\r\n\r\n")]); }
  else if (!hasCl && (req.body.length || req.method === "POST")) {
    const declared = clMode === "exact" ? req.body.length : clMode === "less" ? Math.max(0, req.body.length - rng.int(1, 5)) : clMode === "more" ? req.body.length + rng.int(1, 50) : rng.pick(["-1", "1e3", "abc", "9".repeat(10), String(FLEET_BODY_LIMITS_V1.result + 1), "0", " 2", "2 ", "2,2", "+2", "0x10"]);
    headers.push(["content-length", String(declared)]);
  }
  for (const [k, v] of headers) lines.push(`${k}: ${v}`);
  return Buffer.concat([Buffer.from(lines.join("\r\n") + "\r\n\r\n", "latin1"), body]);
}

function exchange(raw, { halfClose = true, timeoutMs = 6000 } = {}) {
  return new Promise(resolve => {
    const socket = connect(port, "127.0.0.1");
    const chunks = []; let settled = false;
    const done = outcome => { if (settled) return; settled = true; socket.destroy(); resolve({ ...outcome, raw: Buffer.concat(chunks).toString("latin1") }); };
    socket.setTimeout(timeoutMs, () => done({ timedOut: true }));
    socket.on("error", error => done({ socketError: error.code ?? String(error) }));
    socket.on("data", chunk => chunks.push(chunk));
    socket.on("end", () => done({}));
    socket.on("close", () => done({}));
    socket.on("connect", () => { socket.write(raw); if (halfClose) socket.end(); });
  });
}
function parseResponse(raw) {
  // Skip an interim `100 Continue` the Node server emits on its own for Expect headers.
  if (/^HTTP\/1\.1 100 Continue\r\n\r\n/u.test(raw)) raw = raw.replace(/^HTTP\/1\.1 100 Continue\r\n\r\n/u, "");
  const head = raw.indexOf("\r\n\r\n");
  if (head < 0) return { status: undefined, headers: {}, body: raw };
  const [statusLine, ...headerLines] = raw.slice(0, head).split("\r\n");
  const status = Number(/^HTTP\/1\.[01] (\d{3})/u.exec(statusLine)?.[1]);
  const headers = {};
  for (const line of headerLines) { const i = line.indexOf(":"); if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  return { status, headers, body: raw.slice(head + 4) };
}

export const target = {
  name: "fleet-gateway-http",
  timeoutMs: 20000,
  minimize: false,
  corpusMustPass: false,
  corpus: Object.keys(templates),
  async setup() {
    const handler = createFleetGatewayHandlerV1({ store, uploads, proposals, releaseTrust, healthProbeKey, onUnexpectedError: error => unexpected.push(error) });
    server = createServer({ requestTimeout: 500, headersTimeout: 300, connectionsCheckingInterval: 50 }, (request, response) => { void handler.handle(request, response); });
    server.on("clientError", (error, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n"); });
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    port = server.address().port;
  },
  async teardown() { server.closeAllConnections?.(); await new Promise(done => server.close(() => done())); },
  generate(rng, names) {
    let name = rng.pick(names); if (name === "wait" && rng.bool(0.9)) name = "work";
    const req = templates[name]();
    const r = rng.float(); const label = [name];
    if (r < 0.5) {
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) { const op = rng.int(0, 2); if (op === 0) { req.headers = mutateHeaders(rng, req.headers); label.push("hdr"); } else if (op === 1) { req.body = mutateBody(rng, name, req.body); label.push("body"); } else { req.path = mutatePath(rng, req.path); label.push("path"); } }
      const clMode = rng.weighted([[6, "exact"], [1, "less"], [1, "more"], [1, "bad"], [1, "chunked"]]); label.push(clMode);
      return { $label: label.join("+"), $input: { raw: serialize(rng, req, { clMode }), name, req: describe(req), halfClose: rng.bool(0.9) } };
    }
    if (r < 0.7) { const raw = serialize(rng, req); return { $label: `${name}+rawtext`, $input: { raw: Buffer.from(rng.mutateText(raw.toString("latin1"), rng.int(1, 3)), "latin1"), name, halfClose: true } }; }
    if (r < 0.8) { req.method = rng.pick(["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH", "TRACE", "CONNECT", "get", "POST ", "X"]); return { $label: `${name}+method`, $input: { raw: serialize(rng, req), name, req: describe(req), halfClose: true } }; }
    if (r < 0.9) { req.body = mutateBody(rng, name, req.body); req.headers = mutateHeaders(rng, req.headers); return { $label: `${name}+body+hdr`, $input: { raw: serialize(rng, req, { clMode: rng.pick(["exact", "exact", "chunked", "bad"]) }), name, req: describe(req), halfClose: true } }; }
    return { $label: "garbage", $input: { raw: Buffer.from(rng.bytes(rng.int(1, 400))), name: "garbage", halfClose: true } };
  },
  async invoke(input) {
    calls = []; unexpected = [];
    const result = await exchange(input.raw, { halfClose: input.halfClose, timeoutMs: /work\/wait/u.test(input.raw.toString("latin1").split("\r\n")[0] ?? "") ? 600 : 600 });
    const response = parseResponse(result.raw);
    const seen = calls, errors = unexpected;
    let body; try { body = JSON.parse(response.body); } catch { body = undefined; }
    if (result.timedOut) {
      // The work/wait route is a long poll by design: with no offers it holds the connection open.
      if (/\/fleet\/v1\/work\/wait/u.test(input.raw.toString("latin1").split("\r\n")[0] ?? "")) return { outcome: "refused", value: { status: undefined, headers: {}, body: undefined, text: "", calls: seen, longPoll: true } };
      // A declared content-length larger than the bytes sent leaves Node waiting for the rest of the body
      // until its own requestTimeout; that is the HTTP server's behaviour, not a parser hang.
      const rawText = input.raw.toString("latin1"), headEnd = rawText.indexOf("\r\n\r\n");
      const declared = Number(/^content-length:\s*(\d+)\s*$/miu.exec(rawText.slice(0, headEnd))?.[1]);
      const actual = headEnd >= 0 ? input.raw.length - headEnd - 4 : 0;
      const expectHeader = /^expect:\s*(.*)$/miu.exec(rawText.slice(0, headEnd))?.[1]?.trim().toLowerCase();
      if (headEnd < 0 || (expectHeader !== undefined && expectHeader !== "100-continue") || (Number.isFinite(declared) && declared > actual) || /^transfer-encoding:\s*chunked/miu.test(rawText.slice(0, headEnd)) && !/\r\n0\r\n\r\n$/u.test(rawText))
        return { outcome: "refused", value: { status: undefined, headers: {}, body: undefined, text: "", calls: seen, incompleteRequest: true } };
      throw Object.assign(new Error("gateway_socket_timeout"), { timedOut: true });
    }
    if (errors.length) throw Object.assign(new Error(`gateway_unexpected_error:${errors[0]?.name}:${String(errors[0]?.message).slice(0, 100)}`), { unexpected: errors.map(e => ({ name: e?.name, message: e?.message, stack: String(e?.stack).split("\n").slice(0, 3).join(" | ") })) });
    const accepted = response.status !== undefined && response.status < 300;
    return { outcome: accepted ? "accepted" : "refused", value: { status: response.status, headers: response.headers, body, text: response.body.slice(0, 300), calls: seen, socketError: result.socketError } };
  },
  expectedErrors: () => false,
  oracle(input, result) {
    const v = result.value;
    if (!v || v.longPoll || v.incompleteRequest) return undefined;
    if (v.status === undefined) { return v.socketError || v.text.length === 0 ? undefined : `unparseable response: ${v.text.slice(0, 60)}`; }
    if (![200, 201, 202, 204, 400, 401, 403, 404, 405, 408, 409, 410, 413, 414, 415, 417, 422, 423, 429, 431, 503].includes(v.status)) return `unexpected status ${v.status}`;
    if (/\n\s+at\s+\S+\s+\(|\/Users\/|node_modules\//u.test(v.text)) return "response body leaks a stack frame or path";
    // Responses without the gateway's JSON content type come from Node's own HTTP parser (missing Host, bad Expect, malformed request line); their bodies are not the gateway's.
    const gatewayJson = (v.headers["content-type"] ?? "").startsWith("application/json");
    if (v.body !== undefined && v.status !== 417 && gatewayJson) {
      if (typeof v.body !== "object" || v.body === null) return "non-object JSON response";
      if (v.body.ok === false && !KNOWN_ERRORS.has(v.body.error)) return `unknown error code ${String(v.body.error).slice(0, 40)}`;
      if (v.body.ok === false && Object.keys(v.body).length !== 2) return "error response carries extra fields";
      if (v.body.ok === true && v.status >= 400) return "ok:true with error status";
    }
    const rawText = input.raw.toString("latin1");
    const authed = new RegExp(`^authorization:\\s*Bearer ${GOOD}\\s*$`, "miu").test(rawText) && new RegExp(`^x-control-room-worker:\\s*${WID}\\s*$`, "miu").test(rawText);
    const privileged = v.calls.filter(c => !["enroll", "recordRefusedMcpAuthentication"].includes(c.method));
    if (privileged.length && !authed) return `store method ${privileged[0].method} reached without exact credentials`;
    for (const call of v.calls) {
      const a = call.args ?? {};
      if (call.method === "enroll") { const keys = Object.keys(a).sort().join(","); if (!["architecture,clientNonce,code,connectorVersion,credentialDigest,platform,workerKind", "adapterCapabilities,architecture,clientNonce,code,connectorVersion,credentialDigest,platform,workerKind"].includes(keys)) return `enroll body with keys ${keys}`; if (Buffer.byteLength(JSON.stringify(a)) > FLEET_BODY_LIMITS_V1.enroll) return "enroll body over limit reached store"; }
      if (call.method === "chunk") { if (!Number.isSafeInteger(a.ordinal) || a.ordinal < 1 || a.ordinal > 32) return `chunk ordinal ${a.ordinal} reached store`; if (!(a.bytes >= 1 && a.bytes <= FLEET_BODY_LIMITS_V1.chunk)) return `chunk of ${a.bytes} bytes reached store`; const digest = input.req?.headers?.find(([k]) => k.toLowerCase() === "x-control-room-chunk-digest")?.[1]; if (digest !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(digest)) return "chunk with malformed digest header reached store"; }
      if ((call.method === "finalise" || call.method === "voidUpload") && !/^result-upload:[a-f0-9]{32}$/u.test(a.uploadId)) return `${call.method} with uploadId ${String(a.uploadId).slice(0, 40)}`;
      if (call.method === "submitResult") { if (!Array.isArray(a.files) || a.files.length > 8) return "result with >8 files reached store"; for (const f of a.files) if (Object.keys(f).sort().join(",") !== "content,mediaType,name" || f.content.byteLength > 262_144) return "result file shape/size bypass"; }
      if (call.method === "proposal") { if (typeof a.idempotencyKey !== "string" || typeof a.rawProposal !== "string") return "proposal shape bypass"; const p = JSON.parse(a.rawProposal); if (!p || typeof p !== "object" || Array.isArray(p) || !isPostgresJsonTextV1(p)) return "proposal with non-object or NUL text reached service"; }
      if (call.method === "reserve" && (typeof a.claimId !== "string" || !/^fleet-claim:[a-f0-9]{32}$/u.test(a.claimId))) return "reserve with bad claimId";
      if (call.method === "inputBytes" && !(Number.isSafeInteger(a.ordinal) && a.ordinal >= 0 && a.ordinal <= 99)) return `inputBytes ordinal ${a.ordinal}`;
    }
    if (v.status < 300 && v.headers["content-type"]?.startsWith("application/json") && v.headers["x-content-type-options"] !== "nosniff") return "JSON response without nosniff";
    if (v.calls.some(c => c.method === "enroll") && input.req?.body?.byteLength > FLEET_BODY_LIMITS_V1.enroll) return "oversize enroll body accepted";
    return undefined;
  },
};
function describe(req) { return { method: req.method, path: req.path, headers: req.headers, body: req.body }; }
