import type { DatabaseClient } from "../../persistence/database";
import { WebAccessError } from "./access-verifier";
import { privateResponseHeaders, webFailure } from "./http-common";
import { captureLocalOwnerSessionProfileV1, LocalOwnerSessionServiceV1, readLocalOwnerCodeV1,
  renderLocalOwnerSignInPageV1, type LocalOwnerSessionProfileV1 } from "./local-owner-session";
import { WebProjectService } from "./project-service";
import { createProjectHttpHandler } from "./project-http";
import { WebTaskService, type WebTaskKeys } from "./task-service";
import { createTaskHttpHandler } from "./task-http";
import type { WebTaskReviewService } from "./task-review-service";
import type { WebTaskVerificationService } from "./task-verification-service";
import type { TaskPlanningOperation } from "./task-execution-planner";
import type { TaskAssignmentOperation } from "./task-assignment-coordinator";
import type { TaskApprovalOperation, TaskSubmissionOperation } from "./task-coordinator-lifecycle";
import type { TaskRevisionOperation } from "./task-revision-operation";
import type { MacLocalWorkerReadinessV1 } from "./mac-local-worker-readiness";
import type { LocalOwnerSessionStoreV1 } from "./local-owner-session-store";
import type { PersistedLocalOwnerSessionV1 } from "./local-owner-session";
import { taskAttentionPageSchema } from "./task-attention-wire";
import { taskPlanningReceiptSchema } from "./task-planning-wire";
import { taskDeliveryStatusSchema } from "./task-delivery-wire";

export interface MacLocalWebProcessOptionsV1 {
  origin: string;
  localOwnerSession: Readonly<LocalOwnerSessionProfileV1>;
  localOwnerSessionStore?: LocalOwnerSessionStoreV1;
  initialLocalOwnerSessions?: readonly PersistedLocalOwnerSessionV1[];
  workspaceId: string;
  database: { client: DatabaseClient; close: () => Promise<void> };
  /** Existing canonical task operations, supplied by the host composition.
   * The local wrapper owns no planner, queue, review store, or worker. */
  ownerReviews?: WebTaskReviewService;
  ownerVerifications?: WebTaskVerificationService;
  planning?: Pick<TaskPlanningOperation, "plan" | "ensureProject" | "readSaved" | "readPreparedWorker" | "readConfiguredLocalRoute" | "supportsProject" | "templatesForProject">;
  assignment?: TaskAssignmentOperation;
  approvals?: TaskApprovalOperation;
  submission?: TaskSubmissionOperation;
  revisions?: TaskRevisionOperation;
  /** Read capabilities from the same host-owned task application as the
   * submission operations. Without them, a published result looks absent. */
  taskReadKeys?: Pick<WebTaskKeys, "harnessIntegrityKey" | "results" | "reviews" | "ownerReviews">;
  /** Host-generation display state built only after pinned executable
   * verification. It is not a delivery, queue, or result authority. */
  workerReadiness?: Pick<MacLocalWorkerReadinessV1, "read">;
  /** A website-only first start verifies CLI versions but has no task workers. */
  taskWorkersStarted?: boolean;
  clock?: () => number;
}

/** Existing controller operations supplied by the host.  This is deliberately
 * only a typed pass-through: the Mac-local web wrapper cannot construct a
 * planner, queue, result store, review system, or worker of its own. */
export type MacLocalCanonicalTaskOperationsV1 = Pick<MacLocalWebProcessOptionsV1,
  "ownerReviews" | "ownerVerifications" | "planning" | "assignment" | "approvals" | "submission" | "revisions">;

/**
 * The first real Mac-local web composition. It has a fixed loopback-only owner
 * authentication seam and reuses the normal project service and its database
 * session/grant checks. It does not alter the hosted Cloudflare process.
 */
export function createMacLocalWebProcessV1(options: MacLocalWebProcessOptionsV1) {
  const profile = captureLocalOwnerSessionProfileV1(options.localOwnerSession);
  const origin = new URL(options.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.origin !== options.origin
    || profile.origin !== options.origin || !options.workspaceId || !options.database || typeof options.database.close !== "function")
    throw new Error("mac_local_web_process_config_invalid");
  const clock = options.clock ?? Date.now;
  const sessions = new LocalOwnerSessionServiceV1(profile, options.localOwnerSessionStore, options.initialLocalOwnerSessions);
  const projects = new WebProjectService(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, clock);
  const tasks = new WebTaskService(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, clock, options.taskReadKeys);
  const projectHttp = createProjectHttpHandler({ origin: options.origin, localOwnerSession: sessions, service: projects, clock });
  const taskHttp = createTaskHttpHandler({ origin: options.origin, localOwnerSession: sessions, service: tasks, clock,
    ...(options.ownerReviews ? { ownerReviews: options.ownerReviews } : {}),
    ...(options.ownerVerifications ? { ownerVerifications: options.ownerVerifications } : {}),
    ...(options.planning ? { planning: options.planning } : {}),
    ...(options.assignment ? { assignment: options.assignment } : {}),
    ...(options.approvals ? { approvals: options.approvals } : {}),
    ...(options.submission ? { submission: options.submission } : {}),
    ...(options.revisions ? { revisions: options.revisions } : {}),
  });
  let closed: Promise<void> | undefined;

  function pageRedirect(path: "/session" | "/projects"): Response {
    return new Response(null, { status: 303, headers: { ...privateResponseHeaders,
      location: new URL(path, options.origin).href } });
  }

  /** The local route table exposes only pages backed by the local database or
   * host-owned readiness read. Optional hosted modules remain absent. */
  async function renderProductRoute(identity: ReturnType<typeof sessions.verify>, url: URL,
    render: () => Promise<Response> | Response): Promise<Response> {
    const routeId = (value: string) => {
      if (!/^[A-Za-z0-9%:_-]{1,600}$/.test(value)) throw new WebAccessError("not_found");
      let decoded: string;
      try { decoded = decodeURIComponent(value); } catch { throw new WebAccessError("not_found"); }
      if (!/^[A-Za-z0-9:_-]{1,200}$/.test(decoded)) throw new WebAccessError("not_found");
      return decoded;
    };
    if (url.pathname === "/") {
      if (url.search) throw new WebAccessError("invalid_request");
      return render();
    }
    if (url.pathname === "/needs-me") {
      if (url.search) throw new WebAccessError("invalid_request");
      await tasks.authorizeAttentionPage(identity);
      return render();
    }
    if (url.pathname === "/projects") {
      if ([...url.searchParams.keys()].some(name => !["after", "lifecycle"].includes(name))
        || ["after", "lifecycle"].some(name => url.searchParams.getAll(name).length > 1))
        throw new WebAccessError("invalid_request");
      await projects.authorizeCatalog(identity);
      return render();
    }
    if (url.pathname === "/workers") {
      if (url.search) throw new WebAccessError("invalid_request");
      return render();
    }
    const projectSection = /^\/projects\/([^/]+)\/(reviews|activity|files)$/.exec(url.pathname);
    if (projectSection) {
      if ([...url.searchParams.keys()].some(name => name !== "after")
        || url.searchParams.getAll("after").length > 1 || projectSection[2] !== "reviews" && url.search)
        throw new WebAccessError("invalid_request");
      const projectId = routeId(projectSection[1]);
      if (projectSection[2] === "reviews")
        await tasks.projectAttention(identity, projectId, "reviews", url.searchParams.get("after") ?? undefined);
      else if (projectSection[2] === "activity") await tasks.projectOverview(identity, projectId);
      else await tasks.projectFiles(identity, projectId);
      return render();
    }
    const taskDetail = /^\/projects\/([^/]+)\/tasks\/([^/]+)$/.exec(url.pathname);
    if (taskDetail) {
      if (url.search) throw new WebAccessError("invalid_request");
      await tasks.detail(identity, routeId(taskDetail[1]), routeId(taskDetail[2]));
      return render();
    }
    const taskList = /^\/projects\/([^/]+)\/tasks$/.exec(url.pathname);
    if (taskList) {
      const values = [...url.searchParams.entries()];
      if (values.some(([name]) => name !== "after") || values.length > 1) throw new WebAccessError("invalid_request");
      await tasks.list(identity, routeId(taskList[1]), url.searchParams.get("after") ?? undefined);
      return render();
    }
    const project = /^\/projects\/([^/]+)$/.exec(url.pathname);
    if (project) {
      if (url.search) throw new WebAccessError("invalid_request");
      await projects.getView(identity, routeId(project[1]));
      return render();
    }
    throw new WebAccessError("not_found");
  }

  async function handle(request: Request, render: () => Promise<Response> | Response): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin !== options.origin) throw new WebAccessError("access_denied");
      if (url.pathname === "/session") {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        sessions.assertLocalRequest(request);
        return renderLocalOwnerSignInPageV1();
      }
      if (url.pathname === "/api/v1/local-owner-session") {
        if (url.search) throw new WebAccessError("invalid_request");
        if (request.method === "POST") {
          const issued = await sessions.issue(request, await readLocalOwnerCodeV1(request), clock());
          return Response.json({ authenticated: true, expiresAt: issued.expiresAt }, { status: 201,
            headers: { ...privateResponseHeaders, "set-cookie": issued.cookie } });
        }
        if (request.method === "DELETE") {
          await sessions.revoke(request, clock());
          return new Response(null, { status: 204, headers: { ...privateResponseHeaders,
            "set-cookie": `${"control_room_local_owner"}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` } });
        }
        throw new WebAccessError("invalid_request");
      }
      if (url.pathname === "/api/v1/local-workers") {
        if (request.method !== "GET" || url.search || !options.workerReadiness) throw new WebAccessError("not_found");
        sessions.verify(request, clock());
        return Response.json({ taskWorkersStarted: options.taskWorkersStarted === true,
          ...(options.taskWorkersStarted === true ? {} : { instruction: "create your first project, then run mac:down && mac:up" }),
          projectSections: ["overview", "work", "reviews", "activity", ...(options.taskReadKeys?.results ? ["files"] : [])],
          workers: options.workerReadiness.read().map(worker => options.taskWorkersStarted === true ? worker
            : { ...worker, state: "unavailable", proof: "not_proven" }) }, { headers: privateResponseHeaders });
      }
      const identity = sessions.verify(request, clock());
      if (url.pathname === "/api/v1/home/tasks") {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        return Response.json(await tasks.home(identity), { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/needs-me/tasks") {
        if (request.method !== "GET" || [...url.searchParams.keys()].some(key => key !== "after")
          || url.searchParams.getAll("after").length > 1) throw new WebAccessError("invalid_request");
        const page = await tasks.attention(identity, url.searchParams.get("after") ?? undefined);
        if (options.planning?.readSaved) for (const item of page.items) {
          if (!item.reasons.includes("proposal")) continue;
          const saved = await options.planning.readSaved(identity, item.task.projectId, item.task.jobId);
          if (saved) {
            const receipt = taskPlanningReceiptSchema.parse(saved);
            if (receipt.projectId !== item.task.projectId || receipt.sourceJobId !== item.task.jobId
              || receipt.jobId === item.task.jobId) throw new Error("planning_receipt_scope_mismatch");
            item.reasons = item.reasons.filter(reason => reason !== "proposal");
          }
        }
        if (options.submission?.readDelivery) for (const item of page.items) {
          if (!item.reasons.includes("delivery_check")) continue;
          const status = taskDeliveryStatusSchema.parse(await options.submission.readDelivery(identity,
            item.task.projectId, item.task.jobId, item.inputDigest));
          if (status.projectId !== item.task.projectId || status.jobId !== item.task.jobId)
            throw new Error("delivery_status_scope_mismatch");
          item.reasons = item.reasons.filter(reason => reason !== "delivery_check");
          if (status.state === "not_queued") item.reasons.push("submission_needed");
          else if (status.state === "transmission_unconfirmed") item.reasons.push("delivery_uncertain");
          else if (status.state === "receipt_rejected") item.reasons.push("delivery_rejected");
          else if (status.state !== "receipt_recorded") item.reasons.push("delivery_pending");
        }
        return Response.json(taskAttentionPageSchema.parse({ ...page,
          planningSource: options.planning?.readSaved ? "configured" : "not_configured",
          deliverySource: options.submission?.readDelivery ? "configured" : "not_configured",
          items: page.items.filter(item => item.reasons.length) }), { headers: privateResponseHeaders });
      }
      const projectOverview = /^\/api\/v1\/projects\/([^/]+)\/overview$/.exec(url.pathname);
      if (projectOverview) {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        return Response.json(await tasks.projectOverview(identity, decodeURIComponent(projectOverview[1])),
          { headers: privateResponseHeaders });
      }
      const projectFiles = /^\/api\/v1\/projects\/([^/]+)\/files$/.exec(url.pathname);
      if (projectFiles) {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        return Response.json(await tasks.projectFiles(identity, decodeURIComponent(projectFiles[1])),
          { headers: privateResponseHeaders });
      }
      const projectReviews = /^\/api\/v1\/projects\/([^/]+)\/reviews$/.exec(url.pathname);
      if (projectReviews) {
        if (request.method !== "GET" || [...url.searchParams.keys()].some(key => key !== "after")
          || url.searchParams.getAll("after").length > 1) throw new WebAccessError("invalid_request");
        return Response.json(await tasks.projectAttention(identity, decodeURIComponent(projectReviews[1]), "reviews",
          url.searchParams.get("after") ?? undefined), { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/projects"
        || /^\/api\/v1\/projects\/[^/]+(?:\/(?:lifecycle|idea-lifecycle))?$/.test(url.pathname)) return projectHttp(request);
      if (/^\/api\/v1\/projects\/[^/]+\/tasks(?:\/|$)/.test(url.pathname)) return taskHttp(request);
      if (request.method !== "GET") throw new WebAccessError("invalid_request");
      const response = await renderProductRoute(identity, url, render);
      for (const [name, value] of Object.entries(privateResponseHeaders)) response.headers.set(name, value);
      return response;
    } catch (error) {
      if (error instanceof WebAccessError && error.code === "authentication_required" && request.method === "GET"
        && !new URL(request.url).pathname.startsWith("/api/")) {
        return pageRedirect("/session");
      }
      return webFailure(error);
    }
  }

  return Object.freeze({ handle, isReady: () => closed === undefined, close: () => closed ??= options.database.close() });
}
