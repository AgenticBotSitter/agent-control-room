import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import { FleetErrorV1, FLEET_WORKER_KINDS_V1, type FleetOwnerServiceV1 } from "../../fleet/v1";

/**
 * Owner-only fleet routes: add a worker, give it a new key, revoke it, open a
 * task to fleet workers, and review results. Worker machines never call these;
 * they use the separate connector gateway with their own credential.
 */
export type FleetOwnerHttpOptionsV1 = Readonly<{ origin: string; service: FleetOwnerServiceV1;
  /** Public address of the connector gateway, shown in the one-line join command. */
  gatewayOrigin?: string; trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1;
  clock?: () => number; localOwnerSession?: LocalOwnerSessionServiceV1 }>;

function translate(error: unknown): never {
  if (error instanceof FleetErrorV1) throw new WebAccessError(error.code === "not_found" ? "not_found"
    : error.code === "conflict" || error.code === "expired" ? "conflict" : "invalid_request");
  throw error;
}

const shellSafe = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/u;

/** The exact commands shown to the owner. The code is the only secret in it
 * and it is short-lived and single use. */
export function fleetJoinCommandsV1(gatewayOrigin: string, code: string, workerKind: string) {
  if (!shellSafe.test(gatewayOrigin) || !/^crj_[A-Za-z0-9_-]{43}$/u.test(code)
    || !(FLEET_WORKER_KINDS_V1 as readonly string[]).includes(workerKind)) throw new WebAccessError("invalid_request");
  const url = `${gatewayOrigin}/fleet/v1/connector.mjs`;
  return Object.freeze({
    unix: `curl -fsSL ${url} -o control-room-connector.mjs && node control-room-connector.mjs join --server ${gatewayOrigin} --code ${code} --bot ${workerKind}`,
    windows: `Invoke-WebRequest ${url} -OutFile control-room-connector.mjs; node control-room-connector.mjs join --server ${gatewayOrigin} --code ${code} --bot ${workerKind}`,
  });
}

export function createFleetOwnerHttpHandlerV1(options: FleetOwnerHttpOptionsV1) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("fleet_owner_http_authentication_invalid");
  if (options.gatewayOrigin !== undefined && !shellSafe.test(options.gatewayOrigin)) throw new Error("fleet_owner_http_gateway_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  const clock = options.clock ?? Date.now;
  const withCommands = <T extends { code: string; workerKind: string }>(issued: T) => ({ ...issued,
    ...(options.gatewayOrigin ? { commands: fleetJoinCommandsV1(options.gatewayOrigin, issued.code, issued.workerKind) } : {}) });

  return async (request: Request): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method !== "GET"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, clock()) : verify!(request, clock());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const path = url.pathname;
      const file = /^\/api\/v1\/fleet\/results\/(fleet-result:[a-f0-9]{32})\/files\/([1-8])$/u.exec(path);
      if (request.method === "GET") {
        if (path === "/api/v1/fleet") {
          const [board, results] = await Promise.all([options.service.listWorkers(identity),
            options.service.listResults(identity, { awaitingOnly: false })]).catch(translate);
          return Response.json({ ...board, results, gatewayConfigured: !!options.gatewayOrigin }, { headers: privateResponseHeaders });
        }
        const files = /^\/api\/v1\/fleet\/results\/(fleet-result:[a-f0-9]{32})\/files$/u.exec(path);
        if (files) return Response.json(await options.service.listResultFiles(identity, files[1]).catch(translate),
          { headers: privateResponseHeaders });
        if (file) {
          const value = await options.service.readResultFile(identity, file[1], Number(file[2])).catch(translate);
          // Worker files are always downloads, never rendered in the app origin.
          return new Response(Buffer.from(value.content), { headers: { ...privateResponseHeaders,
            "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${value.fileName}"`,
            "content-security-policy": "default-src 'none'; sandbox" } });
        }
        throw new WebAccessError("not_found");
      }
      if (request.method !== "POST" || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
        || !request.body) throw new WebAccessError("invalid_request");
      const body = await readBoundedJson(request.body, 16_384) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new WebAccessError("invalid_request");
      if (path === "/api/v1/fleet/enrollment-codes") return Response.json(withCommands(await options.service
        .createEnrollmentCode(identity, body as never).catch(translate)), { status: 201, headers: privateResponseHeaders });
      const worker = /^\/api\/v1\/fleet\/workers\/(fleet-worker:[a-f0-9]{32})\/(revoke|new-key)$/u.exec(path);
      if (worker) {
        if (worker[2] === "revoke") return Response.json(await options.service.revokeWorker(identity, worker[1]).catch(translate),
          { headers: privateResponseHeaders });
        return Response.json(withCommands(await options.service.issueRekeyCode(identity, worker[1]).catch(translate)),
          { status: 201, headers: privateResponseHeaders });
      }
      const code = /^\/api\/v1\/fleet\/enrollment-codes\/(fleet-code:[a-f0-9]{32})\/cancel$/u.exec(path);
      if (code) return Response.json(await options.service.cancelCode(identity, code[1]).catch(translate), { headers: privateResponseHeaders });
      const review = /^\/api\/v1\/fleet\/results\/(fleet-result:[a-f0-9]{32})\/review$/u.exec(path);
      if (review) return Response.json(await options.service.review(identity, { resultId: review[1], decision: body.decision,
        note: body.note }).catch(translate), { headers: privateResponseHeaders });
      if (path === "/api/v1/fleet/offers") return Response.json(await options.service.offerTask(identity, body as never).catch(translate),
        { status: 201, headers: privateResponseHeaders });
      const withdraw = /^\/api\/v1\/fleet\/offers\/(fleet-offer:[a-f0-9]{32})\/withdraw$/u.exec(path);
      if (withdraw) return Response.json(await options.service.withdrawOffer(identity, withdraw[1]).catch(translate),
        { headers: privateResponseHeaders });
      throw new WebAccessError("not_found");
    } catch (error) { return webFailure(error); }
  };
}
