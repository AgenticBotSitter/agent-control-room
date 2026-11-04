import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { LoopPolicyRefusedV1, type LoopPolicyServiceV1 } from "./loop-policy-service";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import { privateRequestBudgets } from "./private-request-budgets";

export const isLoopPolicyRouteV1 = (path: string) => /^\/api\/v1\/projects\/[^/]+\/loop-policy(?:\/[^/]+)?$/.test(path);
export function createLoopPolicyHttpHandlerV1(options: { origin: string; service: LoopPolicyServiceV1;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust) throw new Error("loop_policy_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    let exceeded = false;
    try {
      const write = ["PUT", "POST", "DELETE"].includes(request.method);
      if (local) local.assertLocalRequest(request, write); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)()) : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const route = /^\/api\/v1\/projects\/([^/]+)\/loop-policy(?:\/(project|selection))?$/.exec(url.pathname);
      if (!route) throw new WebAccessError("not_found");
      let projectId: string;
      try { projectId = decodeURIComponent(route[1]!); } catch { throw new WebAccessError("invalid_request"); }
      if (!route[2]) {
        if (request.method !== "GET" || request.body) throw new WebAccessError("invalid_request");
        return Response.json(await options.service.view(identity, projectId), { headers: privateResponseHeaders });
      }
      if (request.method !== "PUT" || !request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        throw new WebAccessError("invalid_request");
      let bytes = 0;
      const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > privateRequestBudgets.default) { exceeded = true; throw new Error("body_too_large"); }
        controller.enqueue(chunk);
      } }));
      const body = await readBoundedJson(bounded, privateRequestBudgets.default);
      const result = await options.service.put(identity, projectId, route[2], body, request.headers.get("idempotency-key") ?? "");
      return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
    } catch (error) {
      if (exceeded) return Response.json({ error: "request_too_large" }, { status: 413, headers: privateResponseHeaders });
      if (error instanceof LoopPolicyRefusedV1) return Response.json({ error: "policy_refused", reasons: error.reasons }, { status: 422, headers: privateResponseHeaders });
      return webFailure(error);
    }
  };
}
