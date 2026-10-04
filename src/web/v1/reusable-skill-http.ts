import { privateRequestBudgets } from "./private-request-budgets";
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
      const route = /^\/api\/v1\/projects\/([^/]+)\/skills(?:\/([^/]+))?$/.exec(url.pathname);
      if (!route) throw new WebAccessError("not_found");
      // The skills list is paginated, so a cursor is the one query parameter
      // this route accepts. Every other query string stays refused, so an
      // unexpected parameter can never be silently ignored.
      let after: string | undefined;
      if (url.search) {
        const params = new URLSearchParams(url.search);
        if ([...params.keys()].some(key => key !== "after") || params.getAll("after").length > 1)
          throw new WebAccessError("invalid_request");
        // `URLSearchParams` has ALREADY percent-decoded the value, so it must
        // not be decoded again: `after=skill%253Aa` yields `skill%3Aa` here,
        // and a second decode turns it into `skill:a`. That would let a crafted
        // cursor name a real skill id the caller never received, which is
        // exactly the reason a cursor carries an id the server looks up for
        // itself. The value is used as decoded, once.
        const cursor = params.get("after");
        if (cursor !== null) after = cursor;
      }
      let projectId: string, skillId: string | undefined;
      try { projectId = decodeURIComponent(route[1]!); skillId = route[2] ? decodeURIComponent(route[2]) : undefined; }
      catch { throw new WebAccessError("invalid_request"); }
      if (request.method === "GET" && !skillId) return Response.json(await options.service.list(identity, projectId, after),
        { headers: privateResponseHeaders });
      if (after !== undefined) throw new WebAccessError("invalid_request");
      if (!request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        throw new WebAccessError("invalid_request");
      const body = await readBoundedJson(request.body, privateRequestBudgets.skill);
      if (request.method === "POST" && !skillId) {
        // The create action key is a HEADER, not a body field. It identifies
        // the owner's single action and must be generated per submission, so it
        // cannot be replayed by resubmitting a body captured from elsewhere; and
        // it must not be part of the content the schema validates, or a retry
        // carrying a changed key would be a different skill on purpose.
        const actionKey = request.headers.get("idempotency-key") ?? "";
        return Response.json(await options.service.create(identity, projectId, body, actionKey),
          { status: 201, headers: privateResponseHeaders });
      }
      const result = request.method === "PUT" && skillId ? await options.service.update(identity, projectId, skillId, body)
        : (() => { throw new WebAccessError("invalid_request"); })();
      return Response.json(result, { status: 200, headers: privateResponseHeaders });
    } catch (error) { return webFailure(error); }
  };
}

