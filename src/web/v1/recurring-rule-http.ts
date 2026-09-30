import { WebAccessError, createAccessVerifier, requireSameOrigin, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { RecurringRuleServiceV1 } from "../../recurring/v1";

export function createRecurringRuleHttpHandlerV1(options: { origin: string; service: RecurringRuleServiceV1;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("recurring_rule_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method !== "GET"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)()) : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const route = /^\/api\/v1\/projects\/([^/]+)\/recurring-rules(?:\/([^/]+))?(?:\/(pause))?$/.exec(url.pathname);
      if (!route) throw new WebAccessError("not_found");
      let projectId: string, ruleId: string | undefined;
      try { projectId = decodeURIComponent(route[1]!); ruleId = route[2] ? decodeURIComponent(route[2]) : undefined; }
      catch { throw new WebAccessError("invalid_request"); }
      if (request.method === "GET" && !ruleId) return Response.json(await options.service.list(identity, projectId),
        { headers: privateResponseHeaders });
      if (!request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        throw new WebAccessError("invalid_request");
      const body = await readBoundedJson(request.body, 32_768);
      const result = request.method === "POST" && !ruleId ? await options.service.create(identity, projectId, body)
        : request.method === "PUT" && ruleId && !route[3] ? await options.service.update(identity, projectId, ruleId, body)
          : request.method === "POST" && ruleId && route[3] === "pause"
            ? await options.service.setPaused(identity, projectId, ruleId, body as never)
            : (() => { throw new WebAccessError("invalid_request"); })();
      return Response.json(result, { status: request.method === "POST" && !ruleId ? 201 : 200,
        headers: privateResponseHeaders });
    } catch (error) { return webFailure(error); }
  };
}

