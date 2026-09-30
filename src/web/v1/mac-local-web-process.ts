import type { DatabaseClient } from "../../persistence/database";
import { WebAccessError } from "./access-verifier";
import { privateResponseHeaders, webFailure } from "./http-common";
import { captureLocalOwnerSessionProfileV1, LocalOwnerSessionServiceV1, readLocalOwnerCodeV1,
  renderLocalOwnerSignInPageV1, renderLocalOwnerSignOutPageV1, type LocalOwnerSessionProfileV1 } from "./local-owner-session";
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
import type { ActionInboxItemV1 } from "../../operator-surfaces/v1";
import { WorkBatchOwnerServiceV1, type WorkBatchQueueAcceptedResultPortV1,
  type WorkBatchQueueCatalogV1 } from "../../work-intake/v1";
import { createWorkBatchOwnerHttpHandlerV1 } from "./work-batch-owner-http";
import { LinearPipelineServiceV1 } from "../../pipelines/v1";
import { createLinearPipelineHttpHandlerV1 } from "./linear-pipeline-http";
import { createOperationsModeHttpHandlerV1 } from "./operations-mode-http";
import { WebOperationsModeServiceV1, type OperationsModeStopAuthorityV1 } from "./operations-mode-service";
import { encodeProjectEventCursorV1, projectEventSseResponseV1, type ProjectEventReadSourceV1 } from "../../project-events/v1";
import { ProjectActivityServiceV1 } from "./project-activity-service";
import { SessionWatchServiceV1 } from "./session-watch-service";
import { catalogProjectIdSchema } from "./project-wire";
import { sessionWatchIdSchema } from "./session-watch-wire";
import { taskProjectAgentOptionsSchema } from "./task-project-agents-wire";
import { ImproveControlRoomDeskServiceV1 } from "../../improve-control-room/v1";
import { createImproveControlRoomHttpHandlerV1 } from "./improve-control-room-http";
import { parseProductConfigurationV1 } from "../../config/v1/product-configuration";
import { createWebPushChannelV1, deliverOwnerPushV1, parseWebPushSubscriptionV1, PostgresOwnerPushStoreV1,
  startOwnerPushLoopV1, type OwnerWebPushConfigV1 } from "../../web-push/v1";
import { FleetOwnerServiceV1 } from "../../fleet/v1";
import { createFleetOwnerHttpHandlerV1 } from "./fleet-owner-http";
import { RecurringRuleServiceV1 } from "../../recurring/v1";
import { ReusableSkillServiceV1 } from "../../skills/v1";
import { createRecurringRuleHttpHandlerV1 } from "./recurring-rule-http";
import { createReusableSkillHttpHandlerV1 } from "./reusable-skill-http";

export interface MacLocalWebProcessOptionsV1 {
  origin: string;
  localOwnerSession: Readonly<LocalOwnerSessionProfileV1>;
  /** The one remote origin behind Cloudflare Access, if configured. Its
   * transport gate already verified the Access token; sign-out there also
   * ends the Access session at Cloudflare's fixed logout path. */
  cloudflareAccessOrigin?: string;
  localOwnerSessionStore?: LocalOwnerSessionStoreV1;
  initialLocalOwnerSessions?: readonly PersistedLocalOwnerSessionV1[];
  workspaceId: string;
  database: { client: DatabaseClient; close: () => Promise<void> };
  /** The existing task service from the Mac task application. This keeps
   * owner-review follow-up creation and browser task routes on one service. */
  taskService?: WebTaskService;
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
  taskReadKeys?: Pick<WebTaskKeys, "harnessIntegrityKey" | "results" | "reviews" | "ownerReviews" | "modelCatalog" | "taskPlanIntegrityKey" | "usagePriceTable">;
  /** Same protected installation key used by proposal intake. Omission keeps
   * the Pipelines owner module absent. */
  workBatchIntegrityKey?: Uint8Array;
  /** Installation-wide Pause / Drain / Stop. The mode is a separate concern
   * from the batch modules, so it has its own key and its own absence.
   *
   * Supply either `operationsModeIntegrityKey`, which builds one here, or
   * `operationsMode`, which is the instance the host already built. Two
   * instances would be two answers to "what mode is this installation in", and
   * the supervisor's health port and the owner endpoint could then disagree. */
  operationsModeIntegrityKey?: Uint8Array;
  operationsMode?: WebOperationsModeServiceV1;
  /** Coordinator-side stop requests, so `stopped` reaches running work. Omission
   * records the mode and still refuses every new claim and start, but the
   * receipt says no stop request was sent rather than implying one. */
  operationsModeStop?: OperationsModeStopAuthorityV1;
  /** Exact protected worker, node and model-policy snapshot used only to
   * admit approved batch items to the existing per-agent queue. */
  workBatchQueueCatalog?: WorkBatchQueueCatalogV1;
  /** The same protected authority captured by the coordinator lifecycle. */
  workBatchQueueAdmissionAuthority?: WorkBatchQueueAcceptedResultPortV1;
  /** Host-owned append-only projection; this wrapper receives no writer. */
  projectEvents?: ProjectEventReadSourceV1;
  /** Host-generation display state built only after pinned executable
   * verification. It is not a delivery, queue, or result authority. */
  workerReadiness?: Pick<MacLocalWorkerReadinessV1, "read">;
  /** A website-only first start verifies CLI versions but has no task workers. */
  taskWorkersStarted?: boolean;
  /** Read-only canonical owner attention, supplied by the separately restricted
   * task-coordinator connection. The local web role cannot read these tables. */
  actionInboxSource?: Readonly<{ read(input: { tenantId: string; actorId: string; grantedAt: string; now: string }): Promise<{
    observedAt: string; items: ActionInboxItemV1[]; truncated: boolean;
  }> }>;
  /** Optional private VAPID credentials. Omission leaves push unavailable. */
  ownerWebPush?: OwnerWebPushConfigV1;
  /** Start the bounded-retry dispatcher alongside the site. Defaults to on when
   * `ownerWebPush` is configured, because a configured push channel that never
   * dispatches is the exact shape of this feature having been "built" and never
   * working. Supplied explicitly false for a read-only or test composition. */
  ownerPushDispatch?: boolean;
  /** Remote workers (T2-F). Owner decisions use a distinct restricted
   * database login; neither the ordinary web login nor the gateway can write
   * those tables. The hook only asks the gateway to reconcile afterward. */
  fleet?: Readonly<{ ownerAuthority: DatabaseClient; gatewayOrigin?: string; afterDecision?: () => Promise<unknown> }>;
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
  // An owner review that can accept exceptions must use the task application's
  // same in-session proposal service. Refuse a partial composition instead of
  // mounting a review that succeeds for ordinary accepts but cannot follow up.
  if (options.ownerReviews && !options.taskService) throw new Error("mac_local_web_process_config_invalid");
  const clock = options.clock ?? Date.now;
  const allowedOrigins = new Set([options.origin, ...(profile.trustedOrigin ? [profile.trustedOrigin] : []),
    ...(profile.remoteOrigins ?? [])]);
  if (options.cloudflareAccessOrigin !== undefined && !profile.remoteOrigins?.includes(options.cloudflareAccessOrigin))
    throw new Error("mac_local_web_process_config_invalid");
  const sessions = new LocalOwnerSessionServiceV1(profile, options.localOwnerSessionStore, options.initialLocalOwnerSessions);
  const productConfiguration = parseProductConfigurationV1({ schema: "control-room.product-configuration/v1",
    displayName: "Control Room", defaultTimezone: "UTC",
    modules: { ideaLab: false, news: false, sessionObservations: false },
    limits: { maxProjects: 24, maxTasksPerProject: 200, maxResultsPerTask: 20, maxArticleSources: 0, maxIdeaParticipants: 0 },
    projectTemplates: [{ id: "control-room", displayName: "Control Room", enabledModules: [] }] });
  const projects = new WebProjectService(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, clock, undefined, undefined, productConfiguration,
    options.taskReadKeys?.harnessIntegrityKey);
  const tasks = options.taskService ?? new WebTaskService(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, clock, options.taskReadKeys);
  const projectActivity = new ProjectActivityServiceV1(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, options.projectEvents, clock);
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
  const recurringRules = new RecurringRuleServiceV1(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, clock);
  const recurringRuleHttp = createRecurringRuleHttpHandlerV1({ origin: options.origin,
    localOwnerSession: sessions, service: recurringRules, clock });
  const reusableSkills = new ReusableSkillServiceV1(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, clock);
  const reusableSkillHttp = createReusableSkillHttpHandlerV1({ origin: options.origin,
    localOwnerSession: sessions, service: reusableSkills, clock });
  const workBatches = options.workBatchIntegrityKey ? new WorkBatchOwnerServiceV1(options.database.client, tasks,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, options.workBatchIntegrityKey, clock,
    options.workBatchQueueCatalog, options.workBatchQueueAdmissionAuthority) : undefined;
  const workBatchHttp = workBatches ? createWorkBatchOwnerHttpHandlerV1({ origin: options.origin,
    localOwnerSession: sessions, service: workBatches, clock }) : undefined;
  const pipelines = options.workBatchIntegrityKey ? new LinearPipelineServiceV1(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, options.workBatchIntegrityKey,
    options.workBatchQueueAdmissionAuthority, clock) : undefined;
  const pipelineHttp = pipelines ? createLinearPipelineHttpHandlerV1({ origin: options.origin,
    localOwnerSession: sessions, service: pipelines, clock }) : undefined;
  const improvementDesk = options.workBatchIntegrityKey && pipelines ? new ImproveControlRoomDeskServiceV1(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, options.workBatchIntegrityKey, pipelines, clock) : undefined;
  const improvementHttp = improvementDesk ? createImproveControlRoomHttpHandlerV1({ origin: options.origin,
    localOwnerSession: sessions, service: improvementDesk, clock }) : undefined;
  const ownerPush = options.ownerWebPush ? { store: new PostgresOwnerPushStoreV1(options.database.client),
    channel: createWebPushChannelV1(options.ownerWebPush) } : undefined;
  const fleetHttp = options.fleet ? createFleetOwnerHttpHandlerV1({ origin: options.origin, localOwnerSession: sessions, clock,
    service: new FleetOwnerServiceV1(options.fleet.ownerAuthority, { tenantId: profile.tenantId, workspaceId: options.workspaceId,
      clock, ...(options.fleet.afterDecision ? { afterDecision: options.fleet.afterDecision } : {}) }),
    ...(options.fleet.gatewayOrigin ? { gatewayOrigin: options.fleet.gatewayOrigin } : {}) }) : undefined;
  // One service, never two: a supplied instance and a key together are refused
  // rather than silently preferring one, because two instances would each hold
  // their own view of the same installation-wide state.
  if (options.operationsMode && options.operationsModeIntegrityKey)
    throw new Error("mac_local_web_process_config_invalid");
  const operationsMode = options.operationsMode ?? (options.operationsModeIntegrityKey
    ? new WebOperationsModeServiceV1(options.database.client,
      { tenantId: profile.tenantId, workspaceId: options.workspaceId }, options.operationsModeIntegrityKey, clock,
      options.operationsModeStop) : undefined);
  const operationsModeHttp = operationsMode ? createOperationsModeHttpHandlerV1({ origin: options.origin,
    localOwnerSession: sessions, service: operationsMode, clock }) : undefined;
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
    if (url.pathname === "/morning") {
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
    const projectSection = /^\/projects\/([^/]+)\/(inbox|agents|reviews|activity|files|settings|automations|improvements)$/.exec(url.pathname);
    if (projectSection) {
      if ([...url.searchParams.keys()].some(name => name !== "after")
        || url.searchParams.getAll("after").length > 1 || !["inbox", "reviews"].includes(projectSection[2]) && url.search)
        throw new WebAccessError("invalid_request");
      const projectId = routeId(projectSection[1]);
      if (projectSection[2] === "inbox" || projectSection[2] === "reviews")
        await tasks.projectAttention(identity, projectId, projectSection[2], url.searchParams.get("after") ?? undefined);
      else if (projectSection[2] === "activity") await projectActivity.authorize(identity, projectId);
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
      if (!allowedOrigins.has(url.origin)) throw new WebAccessError("access_denied");
      if (url.pathname === "/session") {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        sessions.assertLocalRequest(request);
        return renderLocalOwnerSignInPageV1();
      }
      if (url.pathname === "/sign-out") {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        sessions.assertLocalRequest(request);
        return renderLocalOwnerSignOutPageV1(url.origin === options.cloudflareAccessOrigin
          ? "/cdn-cgi/access/logout" : "/session");
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
          projectSections: ["overview", "inbox", "work", ...(workBatches ? ["pipelines"] : []), "agents", "reviews", "activity", "automations",
            ...(options.taskReadKeys?.results ? ["files"] : []), "settings"],
          workers: options.workerReadiness.read().map(worker => options.taskWorkersStarted === true ? worker
            : { ...worker, state: "unavailable", proof: "not_proven" }) }, { headers: privateResponseHeaders });
      }
      const identity = sessions.verify(request, clock());
      if (url.pathname === "/api/v1/product-configuration") {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        await projects.authorizeCatalog(identity);
        return Response.json(productConfiguration, { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/owner-web-push") {
        if (!ownerPush) throw new WebAccessError("not_found");
        if (request.method === "GET" && !url.search) {
          return Response.json({ enabled: true, publicKey: options.ownerWebPush!.publicKey, subscribed: false,
            message: "This browser can subscribe to phone notifications." }, { headers: privateResponseHeaders });
        }
        if (request.method === "POST" && !url.search && request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json") {
          const subscription = parseWebPushSubscriptionV1(await request.json());
          await ownerPush.store.subscribe({ id: "", tenantId: profile.tenantId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth, expiresAt: subscription.expirationTime === null ? null : new Date(subscription.expirationTime).toISOString() });
          return new Response(null, { status: 204, headers: privateResponseHeaders });
        }
        if (request.method === "DELETE" && !url.search && request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json") {
          const body = await request.json(); if (!body || typeof body !== "object" || typeof (body as { endpoint?: unknown }).endpoint !== "string") throw new WebAccessError("invalid_request");
          await ownerPush.store.unsubscribe(profile.tenantId, (body as { endpoint: string }).endpoint);
          return new Response(null, { status: 204, headers: privateResponseHeaders });
        }
        throw new WebAccessError("invalid_request");
      }
      if (url.pathname === "/api/v1/owner-web-push/test") {
        if (!ownerPush || request.method !== "POST" || url.search || request.body) throw new WebAccessError("invalid_request");
        const now = new Date(clock()).toISOString();
        await deliverOwnerPushV1({ tenantId: profile.tenantId, kind: "test", link: "/settings", dedupeKey: `test:${clock().toString(36)}`,
          now, store: ownerPush.store, channel: ownerPush.channel });
        return new Response(null, { status: 204, headers: privateResponseHeaders });
      }
      const activity = /^\/api\/v1\/projects\/([^/]+)\/(activity|events)$/.exec(url.pathname);
      if (activity) {
        if (request.method !== "GET" || [...url.searchParams.keys()].some(key =>
          ![activity[2] === "activity" ? "before" : "after", "limit"].includes(key))
          || ["before", "after", "limit"].some(key => url.searchParams.getAll(key).length > 1))
          throw new WebAccessError("invalid_request");
        const projectId = routeId(activity[1]);
        const rawLimit = url.searchParams.get("limit") ?? "50";
        if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) throw new WebAccessError("invalid_request");
        if (activity[2] === "activity") {
          const before = url.searchParams.has("before") ? url.searchParams.get("before")! : undefined;
          const page = await projectActivity.read(identity, projectId, before !== undefined ? { beforeCursor: before } : {}, Number(rawLimit));
          const olderCursor = page.truncatedBefore
            ? before ? page.nextCursor : page.events[0] ? encodeProjectEventCursorV1(page.events[0]) : null : null;
          return Response.json({ page, olderCursor }, { headers: privateResponseHeaders });
        }
        const headerCursor = request.headers.get("last-event-id")?.trim() || undefined;
        const queryCursor = url.searchParams.has("after") ? url.searchParams.get("after")! : undefined;
        return projectEventSseResponseV1(await projectActivity.read(identity, projectId,
          headerCursor !== undefined || queryCursor !== undefined ? { afterCursor: headerCursor ?? queryCursor! } : {}, Number(rawLimit)));
      }
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
      if (url.pathname === "/api/v1/needs-me/action-items") {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        if (!options.actionInboxSource) throw new WebAccessError("not_found");
        const owner = await tasks.authorizeActionInbox(identity);
        const now = new Date(clock()).toISOString();
        const source = await options.actionInboxSource.read({ tenantId: profile.tenantId,
          actorId: owner.actorId, grantedAt: owner.grantedAt, now });
        return Response.json(source, { headers: privateResponseHeaders });
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
      if (/^\/api\/v1\/projects\/[^/]+\/recurring-rules(?:\/|$)/.test(url.pathname)) return recurringRuleHttp(request);
      if (/^\/api\/v1\/projects\/[^/]+\/skills(?:\/|$)/.test(url.pathname)) return reusableSkillHttp(request);
      if (workBatchHttp && /^\/api\/v1\/projects\/[^/]+\/pipelines(?:\/|$)/.test(url.pathname)) return workBatchHttp(request);
      if (fleetHttp && /^\/api\/v1\/fleet(?:\/|$)/.test(url.pathname)) return fleetHttp(request);
      if (operationsModeHttp && url.pathname === "/api/v1/operations-mode") return operationsModeHttp(request);
      if (pipelineHttp && /^\/api\/v1\/projects\/[^/]+\/pipeline-(?:templates|runs)(?:\/|$)/.test(url.pathname))
        return pipelineHttp(request);
      if (improvementHttp && (url.pathname === "/api/v1/update-candidates"
        || /^\/api\/v1\/update-candidates\/[^/]+\/decision$/.test(url.pathname)
        || /^\/api\/v1\/projects\/[^/]+\/improvements$/.test(url.pathname))) return improvementHttp(request);
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
