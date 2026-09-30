import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { WebOperationsModeServiceV1 } from "./operations-mode-service";

/** The installation-wide Pause / Drain / Stop switch.
 *
 * One path, two methods, no query string and no route parameters: the mode is
 * not per-project, per-worker or per-resource, and a URL that suggested it was
 * would be a place an owner could look for an override that does not exist. */
export function createOperationsModeHttpHandlerV1(options: { origin: string; service: WebOperationsModeServiceV1;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("operations_mode_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method === "POST"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)())
        : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      if (url.pathname !== "/api/v1/operations-mode" || url.search) throw new WebAccessError("not_found");
      if (request.method === "GET") return Response.json(await options.service.read(identity), { headers: privateResponseHeaders });
      if (request.method !== "POST" || !request.body
        || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        throw new WebAccessError("invalid_request");
      const receipt = await options.service.set(identity, await readBoundedJson(request.body, 2048));
      return Response.json(receipt, { headers: privateResponseHeaders });
    } catch (error) { return webFailure(error); }
  };
}
