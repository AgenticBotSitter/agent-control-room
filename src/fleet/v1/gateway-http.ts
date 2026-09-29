import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { WorkBatchServiceV1 } from "../../work-intake/v1/service";
import { FleetErrorV1, fleetFail } from "./errors";
import type { FleetGatewayStoreV1, FleetWorkerPrincipalV1 } from "./gateway-store";
import { FLEET_DIGEST_PATTERN_V1, FLEET_PROJECT_ID_PATTERN_V1, FLEET_WORKER_ID_PATTERN_V1,
  plainSha256V1 } from "./identifiers";

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
export type FleetGatewayTrustedClientHeaderV1 = "cf-connecting-ip" | "x-forwarded-for-rightmost" | "none";
export type FleetGatewayAdmissionLeaseV1 = Readonly<{
  /** Releases a request that stopped before authentication completed. */
  release(): void;
  /** Settles an authentication attempt into exactly one isolated budget. */
  completeAuthentication(authenticatedWorkerId: string | null): void;
}>;
export type FleetGatewayAdmissionV1 = Readonly<{
  /** Records only a server-verified digest, never a bearer secret. */
  registerCredential(authenticatedWorkerId: string, credentialDigest: string): void;
  enter(request: IncomingMessage, kind: AdmissionKindV1): FleetGatewayAdmissionLeaseV1;
}>;
export type FleetGatewayAdmissionOptionsV1 = Readonly<{ clock?: () => number; windowMs?: number;
  enrollPerIp?: number; enrollGlobal?: number; authenticatePerIp?: number; authenticateGlobal?: number;
  authenticatedPerWorker?: number; authenticatedGlobal?: number;
  maxConcurrent?: number; maxTrackedIps?: number; maxTrackedWorkers?: number;
  trustedProxyAddresses?: readonly string[]; trustedClientHeader?: FleetGatewayTrustedClientHeaderV1 }>;

function normalizedAddress(value: string | undefined) {
  if (!value) return "unknown";
  const trimmed = value.trim().toLowerCase();
  const address = trimmed.startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed;
  return isIP(address) ? address : "unknown";
}

function ipv6Network64(address: string) {
  const embedded = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(address)?.[1];
  if (embedded) {
    const octets = embedded.split(".").map(Number);
    address = `${address.slice(0, -embedded.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${
      ((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = address.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${words.slice(0, 4).map(word => Number.parseInt(word, 16).toString(16)).join(":")}::/64`;
}

/** Coarsens unauthenticated source identities so address rotation within one
 * ordinary client network cannot manufacture fresh budgets. */
export function fleetGatewayClientNetworkV1(address: string) {
  const normalized = normalizedAddress(address);
  if (isIP(normalized) === 4) return `${normalized.split(".").slice(0, 3).join(".")}.0/24`;
  if (isIP(normalized) === 6) return ipv6Network64(normalized);
  return "unknown";
}

/** Forwarded identity is an operator-selected contract with an exact immediate
 * proxy address. With the default `none`, even loopback-supplied headers are
 * ignored. Only one header syntax is ever accepted. */
export function fleetGatewayClientAddressV1(request: IncomingMessage,
  options: Pick<FleetGatewayAdmissionOptionsV1, "trustedProxyAddresses" | "trustedClientHeader"> = {}) {
  const peer = normalizedAddress(request.socket.remoteAddress);
  const selected = options.trustedClientHeader ?? "none";
  const trusted = new Set((options.trustedProxyAddresses ?? []).map(normalizedAddress));
  if (selected === "none" || !trusted.has(peer)) return peer;
  const forwarded = selected === "cf-connecting-ip" ? header(request, "cf-connecting-ip")
    : header(request, "x-forwarded-for")?.split(",").at(-1)?.trim();
  const candidate = normalizedAddress(forwarded);
  return candidate === "unknown" ? peer : candidate;
}

export function createFleetGatewayAdmissionV1(options: FleetGatewayAdmissionOptionsV1 = {}): FleetGatewayAdmissionV1 {
  const clock = options.clock ?? Date.now, windowMs = options.windowMs ?? 60_000;
  const perIp = { enroll: options.enrollPerIp ?? 8, authenticate: options.authenticatePerIp ?? 120 };
  const globalLimit = { enroll: options.enrollGlobal ?? 80, authenticate: options.authenticateGlobal ?? 1_000 };
  const authenticatedPerWorker = options.authenticatedPerWorker ?? 120;
  const authenticatedGlobal = options.authenticatedGlobal ?? 1_000;
  const maxConcurrent = options.maxConcurrent ?? 16, maxTrackedIps = options.maxTrackedIps ?? 4_096;
  const maxTrackedWorkers = options.maxTrackedWorkers ?? 4_096;
  if (![windowMs, perIp.enroll, perIp.authenticate, globalLimit.enroll, globalLimit.authenticate,
    authenticatedPerWorker, authenticatedGlobal, maxConcurrent, maxTrackedIps, maxTrackedWorkers]
    .every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("fleet_admission_invalid");
  const selectedHeader = options.trustedClientHeader ?? "none";
  const trustedProxies = options.trustedProxyAddresses ?? [];
  if (!(["cf-connecting-ip", "x-forwarded-for-rightmost", "none"] as const).includes(selectedHeader)
    || trustedProxies.some(address => normalizedAddress(address) === "unknown")
    || selectedHeader !== "none" && trustedProxies.length === 0) throw new Error("fleet_admission_invalid");
  const sources = new Map<string, AdmissionStateV1>(), workers = new Map<string, AdmissionStateV1>();
  const credentials = new Map<string, string>();
  const global = {
    enroll: { startedAt: 0, count: 0, touchedAt: 0 },
    authenticate: { startedAt: 0, count: 0, touchedAt: 0 },
    authenticated: { startedAt: 0, count: 0, touchedAt: 0 },
  };
  let active = 0;
  const tick = (state: AdmissionStateV1, now: number, limit: number) => {
    if (now < state.startedAt || now - state.startedAt >= windowMs) { state.startedAt = now; state.count = 0; }
    state.touchedAt = now;
    if (state.count >= limit) return false;
    state.count += 1;
    return true;
  };
  const stateFor = (map: Map<string, AdmissionStateV1>, key: string, now: number, maximum: number) => {
    let state = map.get(key);
    if (state) return state;
    for (const [candidate, value] of map) if (now - value.touchedAt >= windowMs) map.delete(candidate);
    if (map.size >= maximum) return fleetFail("rate_limited");
    state = { startedAt: now, count: 0, touchedAt: now };
    map.set(key, state);
    return state;
  };
  return Object.freeze({
    registerCredential(authenticatedWorkerId: string, credentialDigest: string) {
      if (!FLEET_WORKER_ID_PATTERN_V1.test(authenticatedWorkerId) || !FLEET_DIGEST_PATTERN_V1.test(credentialDigest))
        throw new Error("fleet_admission_invalid");
      credentials.set(authenticatedWorkerId, credentialDigest);
    },
    enter(request: IncomingMessage, kind: AdmissionKindV1) {
      const now = clock();
      if (!Number.isSafeInteger(now)) return fleetFail("unavailable");
      const address = fleetGatewayClientAddressV1(request, options);
      const network = fleetGatewayClientNetworkV1(address);
      if (active >= maxConcurrent) return fleetFail("rate_limited");
      const authorization = header(request, "authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      const declaredWorkerId = header(request, "x-control-room-worker");
      const presentedDigest = bearer === undefined ? undefined : plainSha256V1(bearer);
      const knownCredential = kind === "authenticate" && declaredWorkerId !== undefined && presentedDigest !== undefined
        && credentials.get(declaredWorkerId) === presentedDigest;
      let provisionalSource: AdmissionStateV1 | undefined;
      let provisionalSourceWindow: number | undefined, provisionalGlobalWindow: number | undefined;
      if (kind === "enroll") {
        const state = stateFor(sources, `enroll:${network}`, now, maxTrackedIps);
        // Refusals from one source must not spend the shared budget.
        if (!tick(state, now, perIp.enroll) || !tick(global.enroll, now, globalLimit.enroll))
          return fleetFail("rate_limited");
      } else if (!knownCredential) {
        provisionalSource = stateFor(sources, `authenticate:${network}`, now, maxTrackedIps);
        if (!tick(provisionalSource, now, perIp.authenticate)) return fleetFail("rate_limited");
        if (!tick(global.authenticate, now, globalLimit.authenticate)) {
          provisionalSource.count -= 1;
          return fleetFail("rate_limited");
        }
        provisionalSourceWindow = provisionalSource.startedAt;
        provisionalGlobalWindow = global.authenticate.startedAt;
      }
      active += 1;
      let settled = false;
      const refundProvisionalFailure = () => {
        if (!provisionalSource) return;
        if (provisionalSource.startedAt === provisionalSourceWindow && provisionalSource.count > 0)
          provisionalSource.count -= 1;
        if (global.authenticate.startedAt === provisionalGlobalWindow && global.authenticate.count > 0)
          global.authenticate.count -= 1;
        provisionalSource = undefined;
      };
      const settle = () => {
        if (settled) return false;
        settled = true;
        active -= 1;
        return true;
      };
      return Object.freeze({
        release() { if (settle()) refundProvisionalFailure(); },
        completeAuthentication(authenticatedWorkerId: string | null) {
          if (!settle()) return;
          if (kind !== "authenticate") return fleetFail("unavailable");
          if (authenticatedWorkerId !== null) {
            refundProvisionalFailure();
            if (presentedDigest !== undefined) credentials.set(authenticatedWorkerId, presentedDigest);
            const state = stateFor(workers, authenticatedWorkerId, now, maxTrackedWorkers);
            if (!tick(state, now, authenticatedPerWorker) || !tick(global.authenticated, now, authenticatedGlobal))
              return fleetFail("rate_limited");
            return;
          }
          if (knownCredential && declaredWorkerId !== undefined) credentials.delete(declaredWorkerId);
          if (provisionalSource) return;
          const state = stateFor(sources, `authenticate:${network}`, now, maxTrackedIps);
          // Failed credentials alone spend this lane. They can neither charge
          // nor occupy the independently tracked authenticated-worker reserve.
          if (!tick(state, now, perIp.authenticate)
            || !tick(global.authenticate, now, globalLimit.authenticate)) return fleetFail("rate_limited");
        },
      });
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
    const lease = admission.enter(request, "authenticate");
    try {
      const authorization = header(request, "authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      const principal = await options.store.authenticate({ bearer, declaredWorkerId: header(request, "x-control-room-worker") });
      lease.completeAuthentication(principal.workerId);
      return principal;
    } catch (error) {
      if (error instanceof FleetErrorV1 && error.code === "unauthenticated") lease.completeAuthentication(null);
      else lease.release();
      throw error;
    }
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
      const lease = admission.enter(request, "enroll");
      try {
        const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.enroll),
          ["code", "credentialDigest", "platform", "architecture", "connectorVersion", "clientNonce"]);
        const result = await options.store.enroll(body as never);
        admission.registerCredential(result.workerId, body.credentialDigest as string);
        return send(response, result.replayed ? 200 : 201, { ok: true, result });
      } finally { lease.release(); }
    }
    // Every other route: authenticate first, then read the body.
    const known = path === "/fleet/v1/me" || path === "/fleet/v1/heartbeat" || path === "/fleet/v1/rotate"
      || path === "/fleet/v1/work" || path === "/fleet/v1/claims" || path === "/fleet/v1/mcp/calls"
      || claimRoute.test(path) || proposalRoute.test(path);
    if (!known) return fleetFail("not_found");
    let principal: FleetWorkerPrincipalV1;
    try { principal = await authenticated(request); }
    catch (error) {
      if (path === "/fleet/v1/mcp/calls" && error instanceof FleetErrorV1 && error.code === "unauthenticated") {
        const authorization = header(request, "authorization");
        await options.store.recordRefusedMcpAuthentication({
          bearer: authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined,
          declaredWorkerId: header(request, "x-control-room-worker"),
          callId: header(request, "x-control-room-mcp-call"), toolName: header(request, "x-control-room-mcp-tool"),
        });
      }
      throw error;
    }
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
      const result = await options.store.rotate(principal, body as never);
      admission.registerCredential(principal.workerId, body.newCredentialDigest as string);
      return send(response, 200, { ok: true, result });
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
