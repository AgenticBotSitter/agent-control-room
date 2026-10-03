import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import { privateRequestBudgets } from "./private-request-budgets";
import type { ProjectOrchestrationOwnerPortV1 } from "./project-orchestration-owner";

export function createProjectOrchestrationHttpHandlerV1(options: Readonly<{ origin: string;
  service: ProjectOrchestrationOwnerPortV1; trust?: AccessTrust;
  gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }>) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("project_orchestration_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  const clock = options.clock ?? Date.now;
  const decode = (value: string) => { try { return decodeURIComponent(value); }
    catch { throw new WebAccessError("invalid_request"); } };
  const body = async (request: Request) => {
    if (!request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      throw new WebAccessError("invalid_request");
    return readBoundedJson(request.body, privateRequestBudgets.orchestration);
  };
  // The process retains this handler and its service's replay/coalescing state.
  // Authentication uses the snapshot captured for this request, never a mutable
  // shared verifier that another concurrent refresh could overwrite.
  return async (request: Request, currentTrust?: AccessTrust): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method !== "GET"); else requireSameOrigin(request, options.origin);
      const requestVerifier = currentTrust ? createAccessVerifier(currentTrust, options.gatewayAssertionProfile) : verify;
      const identity = local ? local.verify(request, clock()) : requestVerifier!(request, clock());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const settings = /^\/api\/v1\/projects\/([^/]+)\/orchestration-settings$/.exec(url.pathname);
      if (settings) {
        const projectId = decode(settings[1]!);
        if (request.method === "GET") return Response.json(await options.service.readSettings(identity, projectId),
          { headers: privateResponseHeaders });
        if (request.method === "POST") return Response.json(await options.service.saveSettings(identity, projectId, await body(request)),
          { headers: privateResponseHeaders });
        throw new WebAccessError("invalid_request");
      }
      const describe = /^\/api\/v1\/projects\/([^/]+)\/orchestration$/.exec(url.pathname);
      // The retry is its own path rather than a field of the describe body: it is a
      // different authority (it records a grant) on a different schedule (only
      // after an escalation), and a body field would let a describe carry it by
      // accident. 200 for every outcome, like describe: it creates no resource the
      // owner then owns, it answers a question about the grant.
      const retry = /^\/api\/v1\/projects\/([^/]+)\/orchestration-retry$/.exec(url.pathname);
      if (retry) {
        if (request.method !== "POST") throw new WebAccessError("invalid_request");
        return Response.json(await options.service.retryEscalated(identity, decode(retry[1]!),
          await body(request), request.headers.get("idempotency-key") ?? ""),
        { status: 200, headers: privateResponseHeaders });
      }
      if (describe) {
        if (request.method !== "POST") throw new WebAccessError("invalid_request");
        // 200 for every outcome. The route has no resource of its own to create:
        // 201 on a `failed` or `refused` body claimed a proposal exists when none
        // did, and told a future non-browser client to look for one.
        return Response.json(await options.service.describe(identity, decode(describe[1]!), await body(request),
          request.headers.get("idempotency-key") ?? "", request.signal), { status: 200, headers: privateResponseHeaders });
      }
      const suggestions = /^\/api\/v1\/projects\/([^/]+)\/pipelines\/([^/]+)\/suggestions(?:\/([^/]+)\/(use|dismiss))?$/.exec(url.pathname);
      if (!suggestions) throw new WebAccessError("not_found");
      const projectId = decode(suggestions[1]!), batchId = decode(suggestions[2]!);
      if (!suggestions[3] && request.method === "GET") return Response.json(
        await options.service.listSuggestions(identity, projectId, batchId), { headers: privateResponseHeaders });
      if (!suggestions[3] || request.method !== "POST") throw new WebAccessError("invalid_request");
      const value = await body(request);
      if (!value || typeof value !== "object" || !Number.isSafeInteger((value as { expectedRevision?: unknown }).expectedRevision)
        || Number((value as { expectedRevision?: unknown }).expectedRevision) < 1)
        throw new WebAccessError("invalid_request");
      const suggestionId = decode(suggestions[3]), expectedRevision = (value as { expectedRevision: number }).expectedRevision;
      if (suggestions[4] === "use") return Response.json(await options.service.useSuggestion(identity, projectId, batchId,
        suggestionId, expectedRevision), { headers: privateResponseHeaders });
      await options.service.dismissSuggestion(identity, projectId, batchId, suggestionId, expectedRevision);
      return new Response(null, { status: 204, headers: privateResponseHeaders });
    } catch (error) { return webFailure(error); }
  };
}