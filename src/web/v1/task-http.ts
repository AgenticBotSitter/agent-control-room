import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust } from "./access-verifier";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { WebTaskService } from "./task-service";
import type { WebTaskReviewService } from "./task-review-service";
import { taskReviewDraftSchema } from "./task-review-wire";

export function createTaskHttpHandler(options: { origin: string; trust: AccessTrust; service: WebTaskService;
  ownerReviews?: WebTaskReviewService; clock?: () => number }) {
  const verify = createAccessVerifier(options.trust);
  return async (request: Request): Promise<Response> => {
    try {
      requireSameOrigin(request, options.origin);
      const identity = verify(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      const route = /^\/api\/v1\/projects\/([^/]+)\/tasks(?:\/([^/]+)(?:\/(results)(?:\/([^/]+)(?:\/reviews\/([^/]+))?)?)?)?$/.exec(url.pathname);
      if (!route) throw new WebAccessError("not_found");
      let projectId: string, jobId: string | undefined;
      try { projectId = decodeURIComponent(route[1]); jobId = route[2] ? decodeURIComponent(route[2]) : undefined; }
      catch { throw new WebAccessError("invalid_request"); }
      if (!jobId && request.method === "GET") {
        if ([...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length > 1)
          throw new WebAccessError("invalid_request");
        return Response.json(await options.service.list(identity, projectId, url.searchParams.get("after") ?? undefined), { headers: privateResponseHeaders });
      }
      if (url.search) throw new WebAccessError("invalid_request");
      if (jobId && route[4] && route[5]) {
        let artifactId: string, targetId: string;
        try { artifactId = decodeURIComponent(route[4]); targetId = decodeURIComponent(route[5]); } catch { throw new WebAccessError("invalid_request"); }
        if (!options.ownerReviews) throw new Error("owner_review_not_configured");
        if (request.method === "GET") return Response.json(await options.ownerReviews.options(identity, projectId, jobId, artifactId, targetId), { headers: privateResponseHeaders });
        if (request.method !== "POST") throw new WebAccessError("not_found");
        if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body) throw new WebAccessError("invalid_request");
        const draft = taskReviewDraftSchema.safeParse(await readBoundedJson(request.body, 16_384));
        if (!draft.success || draft.data.artifactId !== artifactId || draft.data.targetId !== targetId) throw new WebAccessError("invalid_request");
        const result = await options.ownerReviews.record(identity, projectId, jobId, draft.data, request.headers.get("idempotency-key") ?? "");
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
      }
      if (jobId && route[3] && request.method === "GET") {
        let artifactId: string | undefined;
        try { artifactId = route[4] ? decodeURIComponent(route[4]) : undefined; } catch { throw new WebAccessError("invalid_request"); }
        return Response.json(await options.service.results(identity, projectId, jobId, artifactId), { headers: privateResponseHeaders });
      }
      if (jobId && request.method === "GET")
        return Response.json(await options.service.detail(identity, projectId, jobId), { headers: privateResponseHeaders });
      if (!jobId && request.method === "POST") {
        if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body)
          throw new WebAccessError("invalid_request");
        const result = await options.service.propose(identity, projectId, await readBoundedJson(request.body, 24_576),
          request.headers.get("idempotency-key") ?? "");
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
      }
      throw new WebAccessError("not_found");
    } catch (error) { return webFailure(error); }
  };
}
