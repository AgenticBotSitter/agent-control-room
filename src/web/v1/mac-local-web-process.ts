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
import { WorkBatchOwnerServiceV1 } from "../../work-intake/v1";
import { createWorkBatchOwnerHttpHandlerV1 } from "./work-batch-owner-http";
import { SessionWatchServiceV1 } from "./session-watch-service";
import { catalogProjectIdSchema } from "./project-wire";
import { sessionWatchIdSchema } from "./session-watch-wire";
import { taskProjectAgentOptionsSchema } from "./task-project-agents-wire";

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
  planning?: Pick<TaskPlanningOperation, "plan" | "ensureProject" | "readSaved" | "readSavedMany" | "readSavedContinuation" | "readPreparedWorker" | "readConfiguredLocalRoute" | "supportsProject" | "templatesForProject">;
  assignment?: TaskAssignmentOperation;
  approvals?: TaskApprovalOperation;
  submission?: TaskSubmissionOperation;
  revisions?: TaskRevisionOperation;
  /** Read capabilities from the same host-owned task application as the
   * submission operations. Without them, a published result looks absent. */
  taskReadKeys?: Pick<WebTaskKeys, "harnessIntegrityKey" | "results" | "reviews" | "ownerReviews" | "modelCatalog" | "taskPlanIntegrityKey">;
  /** Same protected installation key used by proposal intake. Omission keeps
   * the Pipelines owner module absent. */
  workBatchIntegrityKey?: Uint8Array;
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
  const sessionWatch = new SessionWatchServiceV1(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, options.taskReadKeys?.harnessIntegrityKey, clock);
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
  const workBatches = options.workBatchIntegrityKey ? new WorkBatchOwnerServiceV1(options.database.client, tasks,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, options.workBatchIntegrityKey, clock) : undefined;
  const workBatchHttp = workBatches ? createWorkBatchOwnerHttpHandlerV1({ origin: options.origin,
    localOwnerSession: sessions, service: workBatches, clock }) : undefined;
  let closed: Promise<void> | undefined;

  function pageRedirect(path: "/session" | "/projects", requestOrigin = options.origin): Response {
    return new Response(null, { status: 303, headers: { ...privateResponseHeaders,
      location: new URL(path, requestOrigin).href } });
  }

  function pageFailure(error: unknown): Response {
    const failure = webFailure(error);
    const message = failure.status === 400 ? "This page address is invalid. Check the link and try again."
      : failure.status === 403 ? "Your current access does not allow this page."
        : failure.status === 404 ? "This page or saved item is not available."
          : failure.status === 409 ? "This saved item changed. Return to Projects and open its current page."
            : "Control Room could not load this page. No change was made. Try again when the saved service is available.";
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control Room page unavailable</title><main><h1>Page unavailable</h1><p role="alert">${message}</p><p><a href="/projects">Return to Projects</a></p></main></html>`, {
      status: failure.status, headers: { ...privateResponseHeaders, "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
    });
  }

  const routeId = (value: string) => {
    if (!/^[A-Za-z0-9%:_-]{1,600}$/.test(value)) throw new WebAccessError("not_found");
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch { throw new WebAccessError("not_found"); }
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(decoded)) throw new WebAccessError("not_found");
    return decoded;
  };

  /** The local route table exposes only pages backed by the local database or
   * host-owned readiness read. Optional hosted modules remain absent. */
  async function renderProductRoute(identity: ReturnType<typeof sessions.verify>, url: URL,
    render: () => Promise<Response> | Response): Promise<Response> {
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
    const pipelines = /^\/projects\/([^/]+)\/pipelines(?:\/([^/]+))?$/.exec(url.pathname);
    if (pipelines) {
      if (url.search || !workBatches) throw new WebAccessError("not_found");
      const projectId = routeId(pipelines[1]);
      if (pipelines[2]) await workBatches.view(identity, projectId, routeId(pipelines[2]));
      else await workBatches.list(identity, projectId);
      return render();
    }
    if (url.pathname === "/session-watch") {
      if ([...url.searchParams.keys()].some(name => name !== "after") || url.searchParams.getAll("after").length > 1)
        throw new WebAccessError("invalid_request");
      if (url.searchParams.has("after") && !sessionWatchIdSchema.safeParse(url.searchParams.get("after")).success)
        throw new WebAccessError("invalid_request");
      await sessionWatch.authorize(identity);
      return render();
    }
    const projectSection = /^\/projects\/([^/]+)\/(inbox|agents|reviews|activity|files|settings)$/.exec(url.pathname);
    if (projectSection) {
      if ([...url.searchParams.keys()].some(name => name !== "after")
        || url.searchParams.getAll("after").length > 1 || !["inbox", "reviews"].includes(projectSection[2]) && url.search)
        throw new WebAccessError("invalid_request");
      const projectId = routeId(projectSection[1]);
      if (projectSection[2] === "inbox" || projectSection[2] === "reviews")
        await tasks.projectAttention(identity, projectId, projectSection[2], url.searchParams.get("after") ?? undefined);
      else if (projectSection[2] === "activity") await tasks.projectOverview(identity, projectId);
      else if (projectSection[2] === "files") await tasks.projectFiles(identity, projectId);
      else await projects.getView(identity, projectId);
      return render();
    }
    const taskDetail = /^\/projects\/([^/]+)\/tasks\/([^/]+)$/.exec(url.pathname);
    if (taskDetail) {
      // The selected result is an untrusted browser hint. The result endpoint
      // validates authorization and binding before any content is returned.
      if ([...url.searchParams.keys()].some(name => name !== "result")) throw new WebAccessError("invalid_request");
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
      if (url.origin !== options.origin && url.origin !== profile.trustedOrigin) throw new WebAccessError("access_denied");
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
          projectSections: ["overview", "inbox", "work", ...(workBatches ? ["pipelines"] : []), "agents", "reviews", "activity",
            ...(options.taskReadKeys?.results ? ["files"] : []), "settings"],
          workers: options.workerReadiness.read().map(worker => options.taskWorkersStarted === true ? worker
            : { ...worker, state: "unavailable", proof: "not_proven" }) }, { headers: privateResponseHeaders });
      }
      const identity = sessions.verify(request, clock());
      if (url.pathname === "/api/v1/home/tasks") {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        return Response.json(await tasks.home(identity), { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/session-watch") {
        if (request.method !== "GET" || [...url.searchParams.keys()].some(key => key !== "after")
          || url.searchParams.getAll("after").length > 1) throw new WebAccessError("invalid_request");
        return Response.json(await sessionWatch.read(identity, url.searchParams.get("after") ?? undefined),
          { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/needs-me/tasks") {
        if (request.method !== "GET" || [...url.searchParams.keys()].some(key => key !== "after")
          || url.searchParams.getAll("after").length > 1) throw new WebAccessError("invalid_request");
        return Response.json(await tasks.attention(identity, url.searchParams.get("after") ?? undefined),
          { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/needs-me/pipelines") {
        if (request.method !== "GET" || url.search || !workBatches) throw new WebAccessError("not_found");
        return Response.json(await workBatches.attention(identity), { headers: privateResponseHeaders });
      }
      const projectOverview = /^\/api\/v1\/projects\/([^/]+)\/overview$/.exec(url.pathname);
      if (projectOverview) {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        return Response.json(await tasks.projectOverview(identity, routeId(projectOverview[1])),
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
      const projectInbox = /^\/api\/v1\/projects\/([^/]+)\/inbox$/.exec(url.pathname);
      if (projectInbox) {
        if (request.method !== "GET" || [...url.searchParams.keys()].some(key => key !== "after")
          || url.searchParams.getAll("after").length > 1) throw new WebAccessError("invalid_request");
        return Response.json(await tasks.projectAttention(identity, routeId(projectInbox[1]), "inbox",
          url.searchParams.get("after") ?? undefined), { headers: privateResponseHeaders });
      }
      const projectAgents = /^\/api\/v1\/projects\/([^/]+)\/agents$/.exec(url.pathname);
      if (projectAgents) {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        const projectId = routeId(projectAgents[1]);
        if (options.assignment) return Response.json(taskProjectAgentOptionsSchema.parse(
          await options.assignment.projectOptions(identity, projectId)), { headers: privateResponseHeaders });
        await tasks.authorize(identity, projectId);
        return Response.json(taskProjectAgentOptionsSchema.parse({
          projectId, eligibilitySource: "not_configured", workers: [], tasksExamined: 0,
          additionalTasksOmitted: false, candidateEvidence: "configured_routes_only",
          observedAt: new Date(clock()).toISOString(), startsWork: false,
          grantsAssignmentAuthority: false, grantsExecutionAuthority: false,
        }), { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/projects"
        || /^\/api\/v1\/projects\/[^/]+(?:\/(?:lifecycle|idea-lifecycle))?$/.test(url.pathname)) return projectHttp(request);
      if (/^\/api\/v1\/projects\/[^/]+\/tasks(?:\/|$)/.test(url.pathname)) return taskHttp(request);
      if (workBatchHttp && /^\/api\/v1\/projects\/[^/]+\/pipelines(?:\/|$)/.test(url.pathname)) return workBatchHttp(request);
      if (request.method !== "GET") throw new WebAccessError("invalid_request");
      const response = await renderProductRoute(identity, url, render);
      for (const [name, value] of Object.entries(privateResponseHeaders)) response.headers.set(name, value);
      return response;
    } catch (error) {
      if (error instanceof WebAccessError && error.code === "authentication_required" && request.method === "GET"
        && !new URL(request.url).pathname.startsWith("/api/")) {
        return pageRedirect("/session", new URL(request.url).origin);
      }
      if (request.method === "GET" && !new URL(request.url).pathname.startsWith("/api/")) return pageFailure(error);
      return webFailure(error);
    }
  }

  return Object.freeze({ handle, isReady: () => closed === undefined, close: () => closed ??= options.database.close() });
}
