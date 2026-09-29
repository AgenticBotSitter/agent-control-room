import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { LinearPipelineServiceV1, PipelineAdvanceServiceV1 } from "../../pipelines/v1";

export function createLinearPipelineHttpHandlerV1(options: { origin: string; service: LinearPipelineServiceV1;
  advance?: Pick<PipelineAdvanceServiceV1,"setUnattended"|"historyForOwner">;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1 }) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("linear_pipeline_http_authentication_invalid");
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  return async (request: Request): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method === "POST"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, (options.clock ?? Date.now)()) : verify!(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const route = /^\/api\/v1\/projects\/([^/]+)\/(pipeline-templates|pipeline-runs)(?:\/([^/]+))?(?:\/(unattended|history))?$/.exec(url.pathname);
      if (!route) throw new WebAccessError("not_found");
      let projectId: string, recordId: string | undefined;
      try { projectId = decodeURIComponent(route[1]!); recordId = route[3] ? decodeURIComponent(route[3]) : undefined; }
      catch { throw new WebAccessError("invalid_request"); }
      const action = route[4];
      if (action === "history") {
        if (route[2]!=="pipeline-runs"||!options.advance||request.method!=="GET"||!recordId) throw new WebAccessError("not_found");
        return Response.json(await options.advance.historyForOwner(identity,projectId,recordId),
          { headers: privateResponseHeaders });
      }
      if (action === "unattended") {
        if (route[2]!=="pipeline-runs"||!options.advance||request.method!=="POST"||!recordId||!request.body
          || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
          throw new WebAccessError("invalid_request");
        const body = await readBoundedJson(request.body,65_536);
        if (!body || typeof body !== "object" || (body as {runId?:unknown}).runId !== recordId)
          throw new WebAccessError("invalid_request");
        const result = await options.advance.setUnattended(identity,projectId,body,
          request.headers.get("idempotency-key") ?? "");
        return Response.json(result,{status:result.replayed?200:201,headers:privateResponseHeaders});
      }
      if (route[2] === "pipeline-runs" && request.method === "GET") return Response.json(recordId
        ? await options.service.view(identity, projectId, recordId)
        : await options.service.list(identity, projectId), { headers: privateResponseHeaders });
      if (request.method !== "POST" || recordId || action || !request.body
        || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        throw new WebAccessError("invalid_request");
      const body = await readBoundedJson(request.body, 65_536);
      const result = route[2] === "pipeline-templates"
        ? await options.service.createTemplate(identity, projectId, body)
        : await options.service.instantiate(identity, projectId, body, request.headers.get("idempotency-key") ?? "");
      return Response.json(result, { status: "replayed" in result && result.replayed ? 200 : 201, headers: privateResponseHeaders });
    } catch (error) { return webFailure(error); }
  };
}
