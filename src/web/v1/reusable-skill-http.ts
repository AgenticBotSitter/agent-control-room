import { WebAccessError, createAccessVerifier, requireSameOrigin, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { ReusableSkillServiceV1 } from "../../skills/v1";

export function createReusableSkillHttpHandlerV1(options: { origin: string; service: ReusableSkillServiceV1;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("reusable_skill_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method !== "GET"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)()) : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const route = /^\/api\/v1\/projects\/([^/]+)\/skills(?:\/([^/]+))?$/.exec(url.pathname);
      if (!route) throw new WebAccessError("not_found");
      let projectId: string, skillId: string | undefined;
      try { projectId = decodeURIComponent(route[1]!); skillId = route[2] ? decodeURIComponent(route[2]) : undefined; }
      catch { throw new WebAccessError("invalid_request"); }
      if (request.method === "GET" && !skillId) return Response.json(await options.service.list(identity, projectId),
        { headers: privateResponseHeaders });
      if (!request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        throw new WebAccessError("invalid_request");
      const body = await readBoundedJson(request.body, 32_768);
      const result = request.method === "POST" && !skillId ? await options.service.create(identity, projectId, body)
        : request.method === "PUT" && skillId ? await options.service.update(identity, projectId, skillId, body)
          : (() => { throw new WebAccessError("invalid_request"); })();
      return Response.json(result, { status: request.method === "POST" ? 201 : 200, headers: privateResponseHeaders });
    } catch (error) { return webFailure(error); }
  };
}

