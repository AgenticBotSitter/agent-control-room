import type { IncomingMessage, ServerResponse } from "node:http";
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
export const FLEET_BODY_LIMITS_V1 = Object.freeze({ small: 32 * 1024, proposal: 256 * 1024, result: 1_700_000 });
const headers = Object.freeze({ "cache-control": "no-store", "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer" });
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

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
  connectorScript?: Readonly<{ body: string; digest: string }>; now?: () => string }>;

export function createFleetGatewayHandlerV1(options: FleetGatewayHttpOptionsV1) {
  const now = options.now ?? (() => new Date().toISOString());
  const claimRoute = /^\/fleet\/v1\/claims\/(fleet-claim:[a-f0-9]{32})\/(progress|blocker|result)$/u;
  const proposalRoute = /^\/fleet\/v1\/projects\/([^/]+)\/proposals$/u;

  async function authenticated(request: IncomingMessage): Promise<FleetWorkerPrincipalV1> {
    const authorization = header(request, "authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    return options.store.authenticate({ bearer, declaredWorkerId: header(request, "x-control-room-worker") });
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
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small),
        ["code", "credentialDigest", "platform", "architecture", "connectorVersion"]);
      return send(response, 201, { ok: true, result: await options.store.enroll(body as never) });
    }
    // Every other route: authenticate first, then read the body.
    const known = path === "/fleet/v1/me" || path === "/fleet/v1/heartbeat" || path === "/fleet/v1/rotate"
      || path === "/fleet/v1/work" || path === "/fleet/v1/claims" || claimRoute.test(path) || proposalRoute.test(path);
    if (!known) return fleetFail("not_found");
    const principal = await authenticated(request);
    if (method === "GET" && path === "/fleet/v1/me") return send(response, 200, { ok: true, result: options.store.me(principal) });
    if (method === "GET" && path === "/fleet/v1/work") return send(response, 200, { ok: true, result: await options.store.listWork(principal) });
    if (method === "GET" && path === "/fleet/v1/claims") return send(response, 200, { ok: true, result: await options.store.myClaims(principal) });
    if (method !== "POST") return fleetFail("not_found");
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
        const code = error instanceof FleetErrorV1 ? error.code : "refused";
        const status = error instanceof FleetErrorV1 ? error.status : 400;
        send(response, status, { ok: false, error: code });
      }
    },
  });
}
