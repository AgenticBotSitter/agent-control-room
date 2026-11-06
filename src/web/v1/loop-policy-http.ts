import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { LoopPolicyRefusedV1, type LoopPolicyServiceV1 } from "./loop-policy-service";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import { privateRequestBudgets } from "./private-request-budgets";

// P72 implementation decision: POST .../waivers/:id/revoke (empty body, 204;
// repeated revocation is a no-op). Owner authority and retained audit are unchanged.
// Both private and Mac-local transports use this route without widening methods.
export const isLoopPolicyRouteV1 = (path: string) => /^\/api\/v1\/projects\/[^/]+\/loop-policy(?:\/(?:project|selection|waivers)|\/waivers\/[^/]+\/revoke)?$/.test(path);
export function createLoopPolicyHttpHandlerV1(options: { origin: string; service: LoopPolicyServiceV1;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust) throw new Error("loop_policy_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    let exceeded = false;
    try {
      const write = ["PUT", "POST"].includes(request.method);
      if (local) local.assertLocalRequest(request, write); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)()) : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const route = /^\/api\/v1\/projects\/([^/]+)\/loop-policy(?:\/(project|selection|waivers)(?:\/([^/]+)\/(revoke))?)?$/.exec(url.pathname);
      if (!route) throw new WebAccessError("not_found");
      let projectId: string;
      try { projectId = decodeURIComponent(route[1]!); } catch { throw new WebAccessError("invalid_request"); }
      if (!route[2]) {
        if (request.method !== "GET" || request.body) throw new WebAccessError("invalid_request");
        return Response.json(await options.service.view(identity, projectId), { headers: privateResponseHeaders });
      }
      if (route[3]) {
        if (route[2] !== 'waivers' || route[4] !== 'revoke' || request.method !== 'POST' || request.body) throw new WebAccessError('invalid_request');
        let waiverId: string;
        try { waiverId = decodeURIComponent(route[3]); } catch { throw new WebAccessError('invalid_request'); }
        await options.service.revokeWaiver(identity,projectId,waiverId);
        return new Response(null,{status:204,headers:privateResponseHeaders});
      }
      if (request.method !== (route[2] === 'waivers' ? 'POST' : 'PUT') || !request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        throw new WebAccessError("invalid_request");
      let bytes = 0;
      const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > privateRequestBudgets.default) { exceeded = true; throw new Error("body_too_large"); }
        controller.enqueue(chunk);
      } }));
      const body = await readBoundedJson(bounded, privateRequestBudgets.default);
      if (route[2] === 'waivers') {
        const result = await options.service.createWaiver(identity,projectId,body,request.headers.get('idempotency-key') ?? '');
        return Response.json(result.waiver,{status:result.replayed?200:201,headers:privateResponseHeaders});
      }
      const result = await options.service.put(identity, projectId, route[2], body, request.headers.get("idempotency-key") ?? "");
      return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
    } catch (error) {
      if (exceeded) return Response.json({ error: "request_too_large" }, { status: 413, headers: privateResponseHeaders });
      if (error instanceof LoopPolicyRefusedV1) return Response.json({ error: "policy_refused", reasons: error.reasons }, { status: 422, headers: privateResponseHeaders });
      return webFailure(error);
    }
  };
}
