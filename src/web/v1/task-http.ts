import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust } from "./access-verifier";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { WebTaskService } from "./task-service";
import type { WebTaskReviewService } from "./task-review-service";
import type { WebTaskVerificationService } from "./task-verification-service";
import { taskVerificationDraftSchema } from "./task-verification-wire";
import { taskReviewDraftSchema } from "./task-review-wire";
import type { TaskPlanningOperation } from "./task-execution-planner";
import { taskPlanningDraftSchema, taskPlanningCommandSchema, taskPlanningOptionsSchema } from "./task-planning-wire";
import { catalogProjectIdSchema } from "./project-wire";
import type { TaskAssignmentOperation } from "./task-assignment-coordinator";
import { taskAssignmentDraftSchema, taskAssignmentCommandSchema, taskAssignmentOptionsSchema } from "./task-assignment-wire";
import type { TaskApprovalOperation, TaskSubmissionOperation } from "./task-coordinator-lifecycle";
import { taskSubmissionDraftSchema, taskSubmissionReceiptSchema, taskSubmissionReadSchema } from "./task-submission-wire";
import { approvalDigestSchema } from "./task-approval-wire";
import { taskApprovalHttp } from "./task-approval-http";
import type { TaskRevisionOperation } from "./task-revision-operation";
import { taskRevisionCommandSchema, taskRevisionRequestSchema } from "./task-revision-wire";
import { sha256Digest } from "../../security";

export function createTaskHttpHandler(options: { origin: string; trust: AccessTrust; service: WebTaskService;
  ownerReviews?: WebTaskReviewService; ownerVerifications?: WebTaskVerificationService; planning?: Pick<TaskPlanningOperation, "plan" | "readSaved">;
  assignment?: TaskAssignmentOperation; approvals?: TaskApprovalOperation; submission?: TaskSubmissionOperation; revisions?: TaskRevisionOperation; clock?: () => number }) {
  const verify = createAccessVerifier(options.trust);
  return async (request: Request): Promise<Response> => {
    try {
      requireSameOrigin(request, options.origin);
      const identity = verify(request, (options.clock ?? Date.now)());
      const url = new URL(request.url);
      const submissionRoute = /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/submission$/.exec(url.pathname);
      if (submissionRoute) {
        if (request.headers.has("idempotency-key")) throw new WebAccessError("invalid_request");
        let ids: string[];
        try { ids = submissionRoute.slice(1).map(decodeURIComponent); } catch { throw new WebAccessError("invalid_request"); }
        if (ids.some(value => !catalogProjectIdSchema.safeParse(value).success)) throw new WebAccessError("invalid_request");
        const [projectId, jobId] = ids;
        await options.service.authorize(identity, projectId);
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has("inputDigest")) throw new WebAccessError("invalid_request");
          const digest = approvalDigestSchema.safeParse(url.searchParams.get("inputDigest"));
          if (!digest.success) throw new WebAccessError("invalid_request");
          if (!options.submission) throw new Error("task_submission_not_configured");
          const receipt = await options.submission.read(identity, projectId, jobId, digest.data);
          const delivery = await options.submission.readDelivery?.(identity, projectId, jobId, digest.data);
          const value = taskSubmissionReadSchema.parse({ projectId, jobId, inputDigest: digest.data, receipt,
            ...(delivery ? { delivery } : {}) });
          if (receipt && (receipt.projectId !== projectId || receipt.jobId !== jobId)) throw new Error("task_submission_scope_mismatch");
          return Response.json(value, { headers: privateResponseHeaders });
        }
        if (url.search) throw new WebAccessError("invalid_request");
        if (request.method !== "POST") throw new WebAccessError("not_found");
        if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body)
          throw new WebAccessError("invalid_request");
        const draft = taskSubmissionDraftSchema.safeParse(await readBoundedJson(request.body, 1024));
        if (!draft.success || request.signal.aborted) throw new WebAccessError("invalid_request");
        if (!options.submission) throw new Error("task_submission_not_configured");
        const receipt = taskSubmissionReceiptSchema.parse(await options.submission.enqueue(identity, projectId, jobId,
          draft.data.expectedInputDigest, draft.data.expectedPacketDigest, request.signal));
        if (receipt.projectId !== projectId || receipt.jobId !== jobId || receipt.packetDigest !== draft.data.expectedPacketDigest)
          throw new Error("task_submission_scope_mismatch");
        return Response.json(receipt, { status: receipt.replayed ? 200 : 201, headers: privateResponseHeaders });
      }
      const revisionRoute = /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/revisions$/.exec(url.pathname);
      if (revisionRoute) {
        if (url.search || request.headers.has("idempotency-key")) throw new WebAccessError("invalid_request");
        let ids: string[];
        try { ids = revisionRoute.slice(1).map(decodeURIComponent); } catch { throw new WebAccessError("invalid_request"); }
        if (ids.some(value => !catalogProjectIdSchema.safeParse(value).success)) throw new WebAccessError("invalid_request");
        const [projectId, sourceJobId] = ids;
        await options.service.authorize(identity, projectId);
        if (request.method !== "POST") throw new WebAccessError("not_found");
        if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body)
          throw new WebAccessError("invalid_request");
        const parsed = taskRevisionRequestSchema.safeParse(await readBoundedJson(request.body, 16_384));
        if (!parsed.success) throw new WebAccessError("invalid_request");
        if (!options.revisions) throw new Error("revision_planning_not_configured");
        const draft = Object.freeze(parsed.data);
        const result = taskRevisionCommandSchema.parse(await options.revisions.plan(identity, projectId, sourceJobId, draft, request.signal));
        const receipt = result.receipt;
        if (receipt.projectId !== projectId || receipt.sourceJobId !== sourceJobId || receipt.jobId === sourceJobId
          || receipt.fromRunId !== draft.runId || receipt.fromTargetId !== draft.targetId || receipt.fromTargetDigest !== draft.targetDigest
          || receipt.fromContentHash !== draft.contentHash || receipt.reviewId !== draft.reviewId
          || receipt.feedbackDigest !== sha256Digest(draft.feedback)) throw new Error("revision_plan_scope_mismatch");
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
      }
      const verificationRoute = /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/results\/([^/]+)\/verifications\/([^/]+)$/.exec(url.pathname);
      if (verificationRoute) {
        if (url.search) throw new WebAccessError("invalid_request");
        let ids: string[];
        try { ids = verificationRoute.slice(1).map(decodeURIComponent); } catch { throw new WebAccessError("invalid_request"); }
        if (ids.some(value => !catalogProjectIdSchema.safeParse(value).success)) throw new WebAccessError("invalid_request");
        const [projectId, jobId, artifactId, targetId] = ids;
        if (!options.ownerVerifications) {
          await options.service.authorize(identity, projectId); throw new Error("owner_verification_not_configured");
        }
        if (request.method === "GET") return Response.json(await options.ownerVerifications.options(identity, projectId, jobId, artifactId, targetId), { headers: privateResponseHeaders });
        if (request.method !== "POST") throw new WebAccessError("not_found");
        if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body) throw new WebAccessError("invalid_request");
        const draft = taskVerificationDraftSchema.safeParse(await readBoundedJson(request.body, 16_384));
        if (!draft.success || draft.data.artifactId !== artifactId || draft.data.targetId !== targetId) throw new WebAccessError("invalid_request");
        const result = await options.ownerVerifications.record(identity, projectId, jobId, draft.data);
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
      }
      const approvalRoute = /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/approval$/.exec(url.pathname);
      if (approvalRoute) {
        let projectId: string, jobId: string;
        try { projectId = decodeURIComponent(approvalRoute[1]); jobId = decodeURIComponent(approvalRoute[2]); }
        catch { throw new WebAccessError("invalid_request"); }
        if (!catalogProjectIdSchema.safeParse(projectId).success || !catalogProjectIdSchema.safeParse(jobId).success)
          throw new WebAccessError("invalid_request");
        return await taskApprovalHttp(request, identity, projectId, jobId, options.service, options.approvals);
      }
      const assignmentRoute = /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/assignment$/.exec(url.pathname);
      if (assignmentRoute) {
        if (url.search) throw new WebAccessError("invalid_request");
        let projectId: string, jobId: string;
        try { projectId = decodeURIComponent(assignmentRoute[1]); jobId = decodeURIComponent(assignmentRoute[2]); }
        catch { throw new WebAccessError("invalid_request"); }
        if (!catalogProjectIdSchema.safeParse(projectId).success || !catalogProjectIdSchema.safeParse(jobId).success)
          throw new WebAccessError("invalid_request");
        // Enforce shared revocation in the web composition too, before crossing an injected operation boundary.
        await options.service.authorize(identity, projectId);
        if (!options.assignment) throw new Error("assignment_not_configured");
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
        if (request.method === "GET") {
          const value = await options.service.planningOptions(identity, projectId, jobId, !!options.planning);
          const savedPlan = await options.planning?.readSaved?.(identity, projectId, jobId);
          return Response.json(taskPlanningOptionsSchema.parse({ ...value,
            ...(savedPlan !== undefined ? { savedPlan, ...(savedPlan ? { availability: "already_planned" } : {}) } : {}) }),
          { headers: privateResponseHeaders });
        }
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
        return Response.json({ ...await options.service.list(identity, projectId, url.searchParams.get("after") ?? undefined),
          dispatch: options.submission ? "configured" : "not_connected" }, { headers: privateResponseHeaders });
      }
      if (url.search) throw new WebAccessError("invalid_request");
      if (jobId && route[4] && route[5]) {
        let artifactId: string, targetId: string;
        try { artifactId = decodeURIComponent(route[4]); targetId = decodeURIComponent(route[5]); } catch { throw new WebAccessError("invalid_request"); }
        if (!options.ownerReviews) throw new Error("owner_review_not_configured");
        if (request.method === "GET") return Response.json({ ...await options.ownerReviews.options(identity, projectId, jobId, artifactId, targetId),
          revisionPlanning: options.revisions ? "configured" : "not_connected" }, { headers: privateResponseHeaders });
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
        return Response.json({ ...await options.service.detail(identity, projectId, jobId),
          dispatch: options.submission ? "configured" : "not_connected" }, { headers: privateResponseHeaders });
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
