import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { WorkBatchServiceV1 } from "../../work-intake/v1/service";
import { FleetErrorV1, fleetFail } from "./errors";
import type { FleetGatewayStoreV1, FleetWorkerPrincipalV1 } from "./gateway-store";
import { FLEET_PROJECT_ID_PATTERN_V1 } from "./identifiers";

/**
 * The connector-facing API. Every route except enrollment and the connector
 * download authenticates the machine credential BEFORE a body byte is read.
 * There is deliberately no route that approves, accepts, merges, assigns or
 * changes permissions; those are owner actions on the web path only.
 */
export const FLEET_BODY_LIMITS_V1 = Object.freeze({ enroll: 4 * 1024, small: 32 * 1024,
  proposal: 256 * 1024, result: 1_700_000 });
const headers = Object.freeze({ "cache-control": "no-store", "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer" });
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

type AdmissionKindV1 = "enroll" | "authenticate";
type AdmissionStateV1 = { startedAt: number; count: number; touchedAt: number };
export type FleetGatewayAdmissionV1 = Readonly<{ enter(request: IncomingMessage, kind: AdmissionKindV1): () => void }>;
export type FleetGatewayAdmissionOptionsV1 = Readonly<{ clock?: () => number; windowMs?: number;
  enrollPerIp?: number; enrollGlobal?: number; authenticatePerIp?: number; authenticateGlobal?: number;
  maxConcurrent?: number; maxTrackedIps?: number }>;

function normalizedAddress(value: string | undefined) {
  if (!value) return "unknown";
  const address = value.startsWith("::ffff:") ? value.slice(7) : value;
  return isIP(address) ? address : "unknown";
}

/** Trust forwarded client addresses only from the loopback proxy the gateway
 * binds behind. Cloudflare overwrites CF-Connecting-IP; Tailscale Serve writes
 * X-Forwarded-For. A direct remote peer can never choose either identity. */
export function fleetGatewayClientAddressV1(request: IncomingMessage) {
  const peer = normalizedAddress(request.socket.remoteAddress);
  if (peer !== "127.0.0.1" && peer !== "::1") return peer;
  const forwarded = header(request, "cf-connecting-ip") ?? header(request, "x-forwarded-for")?.split(",", 1)[0]?.trim();
  const candidate = normalizedAddress(forwarded);
  return candidate === "unknown" ? peer : candidate;
}

export function createFleetGatewayAdmissionV1(options: FleetGatewayAdmissionOptionsV1 = {}): FleetGatewayAdmissionV1 {
  const clock = options.clock ?? Date.now, windowMs = options.windowMs ?? 60_000;
  const perIp = { enroll: options.enrollPerIp ?? 8, authenticate: options.authenticatePerIp ?? 120 };
  const globalLimit = { enroll: options.enrollGlobal ?? 80, authenticate: options.authenticateGlobal ?? 1_000 };
  const maxConcurrent = options.maxConcurrent ?? 16, maxTrackedIps = options.maxTrackedIps ?? 4_096;
  if (![windowMs, perIp.enroll, perIp.authenticate, globalLimit.enroll, globalLimit.authenticate,
    maxConcurrent, maxTrackedIps].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("fleet_admission_invalid");
  const ips = new Map<string, AdmissionStateV1>();
  const global: Record<AdmissionKindV1, AdmissionStateV1> = {
    enroll: { startedAt: 0, count: 0, touchedAt: 0 }, authenticate: { startedAt: 0, count: 0, touchedAt: 0 },
  };
  let active = 0;
  const tick = (state: AdmissionStateV1, now: number, limit: number) => {
    if (now < state.startedAt || now - state.startedAt >= windowMs) { state.startedAt = now; state.count = 0; }
    state.touchedAt = now;
    if (state.count >= limit) return false;
    state.count += 1;
    return true;
  };
  return Object.freeze({
    enter(request: IncomingMessage, kind: AdmissionKindV1) {
      const now = clock();
      if (!Number.isSafeInteger(now)) return fleetFail("unavailable");
      const address = fleetGatewayClientAddressV1(request), key = `${kind}:${address}`;
      let state = ips.get(key);
      if (!state) {
        for (const [candidate, value] of ips) if (now - value.touchedAt >= windowMs) ips.delete(candidate);
        if (ips.size >= maxTrackedIps) return fleetFail("rate_limited");
        state = { startedAt: now, count: 0, touchedAt: now }; ips.set(key, state);
      }
      if (!tick(global[kind], now, globalLimit[kind]) || !tick(state, now, perIp[kind]) || active >= maxConcurrent)
        return fleetFail("rate_limited");
      active += 1;
      let released = false;
      return () => { if (!released) { released = true; active -= 1; } };
    },
  });
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { ...headers, connection: "close" });
  response.end(JSON.stringify(body));
}
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = header(request, "content-length");
  if (declared !== undefined && (!/^\d{1,9}$/u.test(declared) || Number(declared) > limit)) fleetFail("too_large");
  if (!(header(request, "content-type") ?? "").startsWith("application/json")) fleetFail("invalid");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += bytes.length;
    if (length > limit) fleetFail("too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}
function object(raw: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fleetFail("invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fleetFail("invalid");
  const actual = Object.keys(parsed);
  if (keys.some(key => !actual.includes(key)) || actual.some(key => !keys.includes(key) && !optional.includes(key)))
    return fleetFail("invalid");
  return parsed as Record<string, unknown>;
}
function decodeFiles(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fleetFail("invalid");
  if (value.length > 8) return fleetFail("too_large");
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fleetFail("invalid");
    const file = item as Record<string, unknown>;
    if (Object.keys(file).sort().join(",") !== "contentBase64,mediaType,name" || typeof file.contentBase64 !== "string"
      || !base64Pattern.test(file.contentBase64)) return fleetFail("invalid");
    if (file.contentBase64.length > Math.ceil(262_144 / 3) * 4) return fleetFail("too_large");
    return { name: file.name, mediaType: file.mediaType, content: new Uint8Array(Buffer.from(file.contentBase64, "base64")) };
  });
}

export type FleetGatewayHttpOptionsV1 = Readonly<{ store: FleetGatewayStoreV1; proposals?: WorkBatchServiceV1;
  connectorScript?: Readonly<{ body: string; digest: string }>; now?: () => string;
  admission?: FleetGatewayAdmissionV1;
  /** Operator log for failures that are not a fixed refusal. Never sent to the caller. */
  onUnexpectedError?: (error: unknown) => void }>;

export function createFleetGatewayHandlerV1(options: FleetGatewayHttpOptionsV1) {
  const now = options.now ?? (() => new Date().toISOString());
  const admission = options.admission ?? createFleetGatewayAdmissionV1();
  const claimRoute = /^\/fleet\/v1\/claims\/(fleet-claim:[a-f0-9]{32})\/(progress|blocker|result)$/u;
  const proposalRoute = /^\/fleet\/v1\/projects\/([^/]+)\/proposals$/u;

  async function authenticated(request: IncomingMessage): Promise<FleetWorkerPrincipalV1> {
    const release = admission.enter(request, "authenticate");
    try {
      const authorization = header(request, "authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      return await options.store.authenticate({ bearer, declaredWorkerId: header(request, "x-control-room-worker") });
    } finally { release(); }
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://gateway.invalid"); } catch { return fleetFail("not_found"); }
    if (url.search || url.hash) return fleetFail("not_found");
    const path = url.pathname, method = request.method;
    if (method === "GET" && path === "/fleet/v1/connector.mjs" && options.connectorScript) {
      response.writeHead(200, { "cache-control": "no-store", "content-type": "text/javascript; charset=utf-8",
        "x-content-type-options": "nosniff", "x-control-room-connector-sha256": options.connectorScript.digest,
        connection: "close" });
      response.end(options.connectorScript.body);
      return;
    }
    if (method === "POST" && path === "/fleet/v1/enroll") {
      const release = admission.enter(request, "enroll");
      try {
        const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.enroll),
          ["code", "credentialDigest", "platform", "architecture", "connectorVersion", "clientNonce"]);
        const result = await options.store.enroll(body as never);
        return send(response, result.replayed ? 200 : 201, { ok: true, result });
      } finally { release(); }
    }
    // Every other route: authenticate first, then read the body.
    const known = path === "/fleet/v1/me" || path === "/fleet/v1/heartbeat" || path === "/fleet/v1/rotate"
      || path === "/fleet/v1/work" || path === "/fleet/v1/claims" || path === "/fleet/v1/mcp/calls"
      || claimRoute.test(path) || proposalRoute.test(path);
    if (!known) return fleetFail("not_found");
    const principal = await authenticated(request);
    if (method === "GET" && path === "/fleet/v1/me") return send(response, 200, { ok: true, result: options.store.me(principal) });
    if (method === "GET" && path === "/fleet/v1/work") return send(response, 200, { ok: true, result: await options.store.listWork(principal) });
    if (method === "GET" && path === "/fleet/v1/claims") return send(response, 200, { ok: true, result: await options.store.myClaims(principal) });
    if (method !== "POST") return fleetFail("not_found");
    if (path === "/fleet/v1/mcp/calls") {
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["callId", "toolName"]);
      return send(response, 201, { ok: true, result: await options.store.recordMcpCall(principal, body as never) });
    }
    if (path === "/fleet/v1/heartbeat") {
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["connectorVersion", "platform"]);
      return send(response, 200, { ok: true, result: await options.store.heartbeat(principal, body as never) });
    }
    if (path === "/fleet/v1/rotate") {
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["newCredentialDigest"]);
      return send(response, 200, { ok: true, result: await options.store.rotate(principal, body as never) });
    }
    if (path === "/fleet/v1/claims") {
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["offerId", "idempotencyKey"]);
      const result = await options.store.claim(principal, body as never);
      return send(response, result.replayed ? 200 : 201, { ok: true, result });
    }
    const claim = claimRoute.exec(path);
    if (claim) {
      const [, claimId, action] = claim;
      if (action === "progress") {
        const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["message", "idempotencyKey"]);
        return send(response, 200, { ok: true, result: await options.store.progress(principal, { ...body, claimId } as never) });
      }
      if (action === "blocker") {
        const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["message", "idempotencyKey"], ["release"]);
        return send(response, 200, { ok: true, result: await options.store.blocker(principal, { ...body, claimId } as never) });
      }
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.result), ["summary", "idempotencyKey"], ["files"]);
      const result = await options.store.submitResult(principal, { claimId, summary: body.summary,
        idempotencyKey: body.idempotencyKey, files: decodeFiles(body.files) });
      return send(response, result.replayed ? 200 : 201, { ok: true, result });
    }
    const proposal = proposalRoute.exec(path);
    if (proposal) {
      let projectId: string;
      try { projectId = decodeURIComponent(proposal[1]!); } catch { return fleetFail("not_found"); }
      if (!FLEET_PROJECT_ID_PATTERN_V1.test(projectId) || encodeURIComponent(projectId) !== proposal[1]
        || !principal.projectIds.includes(projectId)) return fleetFail("not_found");
      if (!options.proposals) return fleetFail("unavailable");
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.proposal), ["idempotencyKey", "proposal"]);
      if (typeof body.idempotencyKey !== "string" || !body.proposal || typeof body.proposal !== "object"
        || Array.isArray(body.proposal)) return fleetFail("invalid");
      const at = now();
      // The same S1 proposal service as the website intake: a proposal starts
      // no work and grants no authority until the owner approves it.
      const result = await options.proposals.submit({ principal: { tenantId: principal.tenantId,
        identityId: principal.identityId, actorType: "agent", authenticatedAt: at, expiresAt: principal.credentialExpiresAt },
      projectId, rawProposal: JSON.stringify(body.proposal), idempotencyKey: body.idempotencyKey, now: at });
      return send(response, "accepted" in result && result.accepted === false ? 422 : 202, { ok: true, result });
    }
    return fleetFail("not_found");
  }

  return Object.freeze({
    async handle(request: IncomingMessage, response: ServerResponse) {
      try { await route(request, response); }
      catch (error) {
        if (response.headersSent) { response.destroy(); return; }
        if (!(error instanceof FleetErrorV1)) options.onUnexpectedError?.(error);
        const code = error instanceof FleetErrorV1 ? error.code : "refused";
        const status = error instanceof FleetErrorV1 ? error.status : 400;
        send(response, status, { ok: false, error: code });
      }
    },
  });
}
