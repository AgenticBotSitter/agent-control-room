import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import { PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1 } from "./project-orchestration-wire";
import type { ProjectOrchestrationOwnerPortV1 } from "./project-orchestration-owner";

/** The transport bound, DERIVED from the one owner-facing character limit.
 *
 * `readBoundedJson` counts BYTES, so a fixed body cap cannot express a character
 * cap for a multi-byte description: a legal 16,000-character Japanese or emoji
 * description is ~48,000 bytes and was refused at the transport with a 400 the
 * browser could only render as "check the description". The cap is instead the
 * worst case the character limit can produce -- every code point encoded as UTF-8
 * -- plus room for the JSON envelope, so a description the wire accepts can never
 * be refused for being longer than the box. One number, derived, no second limit
 * to keep in step. */
const ORCHESTRATION_BODY_LIMIT =
  PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1 * 4 + 64 * 1024;

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
    return readBoundedJson(request.body, ORCHESTRATION_BODY_LIMIT);
  };
  return async (request: Request): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method !== "GET"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, clock()) : verify!(request, clock());
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