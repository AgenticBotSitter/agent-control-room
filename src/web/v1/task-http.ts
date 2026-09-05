import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust } from "./access-verifier";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { WebTaskService } from "./task-service";
import type { WebTaskReviewService } from "./task-review-service";
import { taskReviewDraftSchema } from "./task-review-wire";
import type { TaskExecutionPlanner } from "./task-execution-planner";
import { taskPlanningDraftSchema, taskPlanningCommandSchema } from "./task-planning-wire";
import { catalogProjectIdSchema } from "./project-wire";
import type { TaskAssignmentOperation } from "./task-assignment-coordinator";
import { taskAssignmentDraftSchema, taskAssignmentCommandSchema, taskAssignmentOptionsSchema } from "./task-assignment-wire";

export function createTaskHttpHandler(options: { origin: string; trust: AccessTrust; service: WebTaskService;
  ownerReviews?: WebTaskReviewService; planning?: Pick<TaskExecutionPlanner, "plan">;
  assignment?: TaskAssignmentOperation; clock?: () => number }) {
  const verify = createAccessVerifier(options.trust);
  return async (request: Request): Promise<Response> => {
    try {
      requireSameOrigin(request, options.origin);
      const identity = verify(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      const assignmentRoute = /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/assignment$/.exec(url.pathname);
      if (assignmentRoute) {
        if (url.search) throw new WebAccessError("invalid_request");
        let projectId: string, jobId: string;
        try { projectId = decodeURIComponent(assignmentRoute[1]); jobId = decodeURIComponent(assignmentRoute[2]); }
        catch { throw new WebAccessError("invalid_request"); }
        if (!catalogProjectIdSchema.safeParse(projectId).success || !catalogProjectIdSchema.safeParse(jobId).success)
          throw new WebAccessError("invalid_request");
        if (!options.assignment) { await options.service.authorize(identity, projectId); throw new Error("assignment_not_configured"); }
        if (request.method === "GET") {
          const value = taskAssignmentOptionsSchema.parse(await options.assignment.options(identity, projectId, jobId));
          if (value.projectId !== projectId || value.jobId !== jobId) throw new Error("assignment_scope_mismatch");
          return Response.json(value, { headers: privateResponseHeaders });
        }
        if (request.method !== "POST") throw new WebAccessError("not_found");
        if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body) throw new WebAccessError("invalid_request");
        const draft = taskAssignmentDraftSchema.safeParse(await readBoundedJson(request.body, 1024));
        if (!draft.success) throw new WebAccessError("invalid_request");
        const result = taskAssignmentCommandSchema.parse(draft.data.action === "assign"
          ? await options.assignment.assign(identity, projectId, jobId, draft.data.nodeId, draft.data.expectedInputDigest)
          : await options.assignment.expire(identity, projectId, jobId, draft.data.expectedInputDigest));
        if (result.receipt.projectId !== projectId || result.receipt.jobId !== jobId || result.receipt.inputDigest !== draft.data.expectedInputDigest
          || draft.data.action === "assign" && result.receipt.nodeId !== draft.data.nodeId
          || draft.data.action === "expire" && result.receipt.leaseState !== "expired") throw new Error("assignment_scope_mismatch");
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
      }
      const planningRoute = /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/plan$/.exec(url.pathname);
      if (planningRoute) {
        if (url.search) throw new WebAccessError("invalid_request");
        let projectId: string, jobId: string;
        try { projectId = decodeURIComponent(planningRoute[1]); jobId = decodeURIComponent(planningRoute[2]); }
        catch { throw new WebAccessError("invalid_request"); }
        if (!catalogProjectIdSchema.safeParse(projectId).success || !catalogProjectIdSchema.safeParse(jobId).success)
          throw new WebAccessError("invalid_request");
        if (request.method === "GET") return Response.json(await options.service.planningOptions(identity, projectId, jobId,
          !!options.planning), { headers: privateResponseHeaders });
        if (request.method !== "POST") throw new WebAccessError("not_found");
        if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body)
          throw new WebAccessError("invalid_request");
        const draft = taskPlanningDraftSchema.safeParse(await readBoundedJson(request.body, 1024));
        if (!draft.success) throw new WebAccessError("invalid_request");
        if (!options.planning) {
          await options.service.authorize(identity, projectId);
          throw new Error("task_planning_not_configured");
        }
        // Source uniqueness, not a browser-selected key, reconciles this exact plan after a lost reply.
        const result = taskPlanningCommandSchema.parse(await options.planning.plan(identity, projectId, jobId, draft.data.expectedInputDigest));
        if (result.receipt.projectId !== projectId || result.receipt.sourceJobId !== jobId
          || result.receipt.sourceInputDigest !== draft.data.expectedInputDigest || result.receipt.jobId === jobId) throw new Error("task_plan_scope_mismatch");
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
      }
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
