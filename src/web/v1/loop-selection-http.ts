import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import type { LoopSelectionServiceV1 } from "./loop-selection-service";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import { privateRequestBudgets } from "./private-request-budgets";

const selectionRoute = /^\/api\/v1\/projects\/([^/]+)\/loop-selection\/preview$/;
export const isLoopSelectionRouteV1 = (path: string) => selectionRoute.test(path);
export function createLoopSelectionHttpHandlerV1(options: { origin: string; service: LoopSelectionServiceV1;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("loop_selection_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    let exceeded = false;
    try {
      if (local) local.assertLocalRequest(request, request.method !== "GET"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)()) : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const route = selectionRoute.exec(url.pathname);
      if (!route) throw new WebAccessError("not_found");
      let projectId: string;
      try { projectId = decodeURIComponent(route[1]!); } catch { throw new WebAccessError("invalid_request"); }
      if (request.method !== "POST" || !request.body
        || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new WebAccessError("invalid_request");
      let bytes = 0;
      const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > privateRequestBudgets.default) { exceeded = true; throw new Error("request_too_large"); }
        controller.enqueue(chunk);
      } }));
      const body = await readBoundedJson(bounded, privateRequestBudgets.default);
      return Response.json(await options.service.preview(identity, projectId, body), { headers: privateResponseHeaders });
    } catch (error) {
      if (exceeded) return Response.json({ error: "request_too_large" }, { status: 413, headers: privateResponseHeaders });
      return webFailure(error);
    }
  };
}
