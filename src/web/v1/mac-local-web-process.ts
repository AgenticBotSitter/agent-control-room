import type { DatabaseClient } from "../../persistence/database";
import { WebAccessError } from "./access-verifier";
import { privateResponseHeaders, webFailure } from "./http-common";
import { captureLocalOwnerSessionProfileV1, LocalOwnerSessionServiceV1, readLocalOwnerCodeV1,
  renderLocalOwnerSignInPageV1, type LocalOwnerSessionProfileV1 } from "./local-owner-session";
import { WebProjectService } from "./project-service";
import { createProjectHttpHandler } from "./project-http";
import { WebTaskService } from "./task-service";
import { createTaskHttpHandler } from "./task-http";
import type { WebTaskReviewService } from "./task-review-service";
import type { WebTaskVerificationService } from "./task-verification-service";
import type { TaskPlanningOperation } from "./task-execution-planner";
import type { TaskAssignmentOperation } from "./task-assignment-coordinator";
import type { TaskApprovalOperation, TaskSubmissionOperation } from "./task-coordinator-lifecycle";
import type { TaskRevisionOperation } from "./task-revision-operation";
import type { MacLocalWorkerReadinessV1 } from "./mac-local-worker-readiness";

export interface MacLocalWebProcessOptionsV1 {
  origin: string;
  localOwnerSession: Readonly<LocalOwnerSessionProfileV1>;
  workspaceId: string;
  database: { client: DatabaseClient; close: () => Promise<void> };
  /** Existing canonical task operations, supplied by the host composition.
   * The local wrapper owns no planner, queue, review store, or worker. */
  ownerReviews?: WebTaskReviewService;
  ownerVerifications?: WebTaskVerificationService;
  planning?: Pick<TaskPlanningOperation, "plan" | "readSaved" | "readPreparedWorker" | "readConfiguredLocalRoute" | "supportsProject" | "templatesForProject">;
  assignment?: TaskAssignmentOperation;
  approvals?: TaskApprovalOperation;
  submission?: TaskSubmissionOperation;
  revisions?: TaskRevisionOperation;
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
  const sessions = new LocalOwnerSessionServiceV1(profile);
  const projects = new WebProjectService(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, clock);
  const tasks = new WebTaskService(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, clock);
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

  /** The Mac-local host deliberately exposes only the working project/task
   * journey.  The broader private product has screens that depend on optional
   * hosted services; sending an owner to one of those screens would make an
   * unavailable service look like a live local capability. */
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
      await projects.authorizeCatalog(identity);
      return Response.redirect(new URL("/projects", options.origin), 303);
    }
    if (url.pathname === "/projects") {
      if (url.search) throw new WebAccessError("invalid_request");
      await projects.authorizeCatalog(identity);
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
        if (request.method !== "POST" || url.search) throw new WebAccessError("invalid_request");
        const issued = await sessions.issue(request, await readLocalOwnerCodeV1(request), clock());
        return Response.json({ authenticated: true, expiresAt: issued.expiresAt }, { status: 201,
          headers: { ...privateResponseHeaders, "set-cookie": issued.cookie } });
      }
      if (url.pathname === "/api/v1/local-workers") {
        if (request.method !== "GET" || url.search || !options.workerReadiness) throw new WebAccessError("not_found");
        sessions.verify(request, clock());
        return Response.json({ taskWorkersStarted: options.taskWorkersStarted === true,
          ...(options.taskWorkersStarted === true ? {} : { instruction: "create your first project, then run mac:down && mac:up" }),
          workers: options.workerReadiness.read().map(worker => options.taskWorkersStarted === true ? worker
            : { ...worker, state: "unavailable", proof: "not_proven" }) }, { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/projects") return projectHttp(request);
      if (/^\/api\/v1\/projects\/[^/]+\/tasks(?:\/|$)/.test(url.pathname)) return taskHttp(request);
      const identity = sessions.verify(request, clock());
      if (request.method !== "GET") throw new WebAccessError("invalid_request");
      const response = await renderProductRoute(identity, url, render);
      for (const [name, value] of Object.entries(privateResponseHeaders)) response.headers.set(name, value);
      return response;
    } catch (error) { return webFailure(error); }
  }

  return Object.freeze({ handle, isReady: () => closed === undefined, close: () => closed ??= options.database.close() });
}
