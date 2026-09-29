import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { WorkBatchOwnerServiceV1 } from "../../work-intake/v1";

export function createWorkBatchOwnerHttpHandlerV1(options: { origin: string; service: WorkBatchOwnerServiceV1;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("work_batch_owner_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method === "POST"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)()) : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const route = /^\/api\/v1\/projects\/([^/]+)\/pipelines(?:\/([^/]+))?$/.exec(url.pathname);
      if (!route) throw new WebAccessError("not_found");
      let projectId: string, batchId: string | undefined;
      try { projectId = decodeURIComponent(route[1]!); batchId = route[2] ? decodeURIComponent(route[2]) : undefined; }
      catch { throw new WebAccessError("invalid_request"); }
      if (request.method === "GET") return Response.json(batchId
        ? await options.service.view(identity, projectId, batchId)
        : await options.service.list(identity, projectId), { headers: privateResponseHeaders });
      if (request.method !== "POST" || !batchId || !request.body
        || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        throw new WebAccessError("invalid_request");
      const value = await readBoundedJson(request.body, 131_072);
      if (!value || typeof value !== "object" || (value as { batchId?: unknown }).batchId !== batchId)
        throw new WebAccessError("invalid_request");
      const result = await options.service.command(identity, projectId, value, request.headers.get("idempotency-key") ?? "");
      return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
    } catch (error) { return webFailure(error); }
  };
}
