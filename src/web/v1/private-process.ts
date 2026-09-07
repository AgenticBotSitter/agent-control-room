import type { DatabaseClient } from "../../persistence/database";
import { createAccessKeyCache, type AccessKeyLoader } from "./access-key-cache";
import { createAccessVerifier, requireSameOrigin, WebAccessError } from "./access-verifier";
import { privateResponseHeaders, webFailure } from "./http-common";
import { createProjectHttpHandler } from "./project-http";
import { WebProjectService } from "./project-service";
import { catalogProjectIdSchema } from "./project-wire";
import { WebConnectionService, type WebConnectionKeys } from "./connection-service";
import { WebTaskService, type WebTaskKeys } from "./task-service";
import { createTaskHttpHandler } from "./task-http";
import { WebTaskReviewService } from "./task-review-service";
import { WebTaskVerificationService } from "./task-verification-service";
import type { TaskPlanningOperation } from "./task-execution-planner";
import type { TaskAssignmentOperation } from "./task-assignment-coordinator";
import type { TaskApprovalOperation, TaskSubmissionOperation } from "./task-coordinator-lifecycle";
import type { TaskRevisionOperation } from "./task-revision-operation";
import type { QueueAttentionSource } from "./queue-attention-wire";
import { taskPlanningReceiptSchema } from "./task-planning-wire";
import { taskAttentionPageSchema } from "./task-attention-wire";
import { taskDeliveryStatusSchema } from "./task-delivery-wire";

export interface PrivateWebProcessOptions {
  origin: string; issuer: string; audience: string; tenantId: string; workspaceId: string;
  maxSessionSeconds: number; loadKeys: AccessKeyLoader;
  /** A single process-owned pool, supplied by the separately reviewed deployment bootstrap. */
  database: { client: DatabaseClient; close: () => Promise<void> };
  /** Optional existing registry integrity key, supplied privately; never loaded or created by this process. */
  ideaProjects?: { integrityKey: Uint8Array };
  /** Existing enrollment/signal keys, supplied privately. Absence is unavailable, not an empty roster. */
  connections?: WebConnectionKeys;
  /** Existing harness evidence verification key. No key means progress is unavailable, not no runs. */
  tasks?: Omit<WebTaskKeys, "ideaIntegrityKey"> & { harnessIntegrityKey: Uint8Array };
  /** Trusted control-plane operation only. No planner key, privileged pool or native adapter is
   * given to the web SQL service. Its resource lifecycle is owned by the supplying composition. */
  planning?: TaskPlanningOperation;
  /** Narrow optional coordinator operations; resource ownership remains in trusted composition. */
  assignment?: TaskAssignmentOperation;
  approvals?: TaskApprovalOperation;
  submission?: TaskSubmissionOperation;
  revisions?: TaskRevisionOperation;
  queueAttention?: QueueAttentionSource;
  clock?: () => number;
  /** Tests may shorten the production drain ceiling; never extend it. */
  drainMs?: number;
}

export function privateNotConfigured() {
  return Response.json({ error: "private_app_not_configured" }, { status: 503, headers: privateResponseHeaders });
}

/** Mounts only the private project's UI/API. No environment reads, connection opening, listener or seed. */
export function createPrivateWebProcess(options: PrivateWebProcessOptions) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.origin !== options.origin || !options.tenantId || !options.workspaceId)
    throw new Error("invalid_private_app_config");
  const clock = options.clock ?? Date.now;
  if (options.queueAttention && (options.queueAttention.tenantId !== options.tenantId
    || options.queueAttention.workspaceId !== options.workspaceId || typeof options.queueAttention.read !== "function"))
    throw new Error("invalid_private_app_config");
  const queueAttention = options.queueAttention ? Object.freeze({ tenantId: options.tenantId,
    workspaceId: options.workspaceId, read: options.queueAttention.read.bind(options.queueAttention) }) : undefined;
  if (options.planning && (options.planning.tenantId !== options.tenantId || options.planning.workspaceId !== options.workspaceId
    || typeof options.planning.plan !== "function" || options.planning.readSaved !== undefined && typeof options.planning.readSaved !== "function")) throw new Error("invalid_private_app_config");
  const planning = options.planning ? Object.freeze({ plan: options.planning.plan.bind(options.planning),
    readSaved: options.planning.readSaved?.bind(options.planning) }) : undefined;
  if (options.revisions && (options.revisions.tenantId !== options.tenantId || options.revisions.workspaceId !== options.workspaceId
    || typeof options.revisions.plan !== "function")) throw new Error("invalid_private_app_config");
  const revisions = options.revisions ? Object.freeze({ tenantId: options.tenantId, workspaceId: options.workspaceId,
    plan: options.revisions.plan.bind(options.revisions) }) : undefined;
  if (options.assignment && (options.assignment.tenantId !== options.tenantId || options.assignment.workspaceId !== options.workspaceId
    || [options.assignment.assign, options.assignment.expire, options.assignment.options].some(method => typeof method !== "function")))
    throw new Error("invalid_private_app_config");
  const assignment = options.assignment ? Object.freeze({ tenantId: options.tenantId, workspaceId: options.workspaceId,
    assign: options.assignment.assign.bind(options.assignment), expire: options.assignment.expire.bind(options.assignment),
    options: options.assignment.options.bind(options.assignment) }) : undefined;
  const drainMs = options.drainMs ?? 30_000;
  if (options.approvals && (options.approvals.tenantId !== options.tenantId || options.approvals.workspaceId !== options.workspaceId
    || [options.approvals.prepare, options.approvals.store, options.approvals.read].some(method => typeof method !== "function")))
    throw new Error("invalid_private_app_config");
  if (options.submission && (options.submission.tenantId !== options.tenantId || options.submission.workspaceId !== options.workspaceId
    || typeof options.submission.enqueue !== "function" || typeof options.submission.read !== "function"
    || options.submission.readDelivery !== undefined && typeof options.submission.readDelivery !== "function")) throw new Error("private_submission_config_invalid");
  const submission = options.submission ? Object.freeze({ tenantId: options.tenantId, workspaceId: options.workspaceId,
    enqueue: options.submission.enqueue.bind(options.submission), read: options.submission.read.bind(options.submission),
    readDelivery: options.submission.readDelivery?.bind(options.submission) }) : undefined;
  const approvals = options.approvals ? Object.freeze({ tenantId: options.tenantId, workspaceId: options.workspaceId,
    prepare: options.approvals.prepare.bind(options.approvals), store: options.approvals.store.bind(options.approvals),
    read: options.approvals.read.bind(options.approvals) }) : undefined;
  if (!Number.isSafeInteger(drainMs) || drainMs < 1 || drainMs > 30_000) throw new Error("invalid_private_app_config");
  const keys = createAccessKeyCache({ ...options, clock });
  const service = new WebProjectService(options.database.client,
    { tenantId: options.tenantId, workspaceId: options.workspaceId }, clock, options.ideaProjects?.integrityKey);
  const connections = new WebConnectionService(options.database.client,
    { tenantId: options.tenantId, workspaceId: options.workspaceId }, clock, options.connections);
  const tasks = new WebTaskService(options.database.client, { tenantId: options.tenantId, workspaceId: options.workspaceId }, clock,
    { ...options.tasks, ideaIntegrityKey: options.ideaProjects?.integrityKey });
  const ownerReviews = options.tasks?.ownerReviews ? new WebTaskReviewService(options.database.client,
    { tenantId: options.tenantId, workspaceId: options.workspaceId }, { ...options.tasks.ownerReviews,
      harnessIntegrityKey: options.tasks.harnessIntegrityKey, results: options.tasks.results!, ideaIntegrityKey: options.ideaProjects?.integrityKey }, clock) : undefined;
  const ownerVerifications = options.tasks?.manualVerificationScenarios ? new WebTaskVerificationService(options.database.client,
    { tenantId: options.tenantId, workspaceId: options.workspaceId }, { ...options.tasks.reviews!,
      harnessIntegrityKey: options.tasks.harnessIntegrityKey, results: options.tasks.results!, ideaIntegrityKey: options.ideaProjects?.integrityKey,
      manualVerificationScenarios: options.tasks.manualVerificationScenarios }, clock) : undefined;
  let closing = false;
  let active = 0;
  let drained: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  let force!: () => void;
  const forced = new Promise<Response>(resolve => { force = () => resolve(webFailure(new Error())); });

    async function dispatch(request: Request, render: () => Promise<Response> | Response): Promise<Response> {
      try {
        requireSameOrigin(request, options.origin);
        const url = new URL(request.url);
        // Identity credentials only arrive on the verified edge assertion header. Never consume an app cookie/header alias.
        if (!request.headers.get("cf-access-jwt-assertion")) throw new WebAccessError("authentication_required");
        const trust = await keys.get();
        const identity = createAccessVerifier(trust)(request, clock());
        if (url.pathname.startsWith("/api/")) {
          if (url.pathname === "/api/v1/needs-me/tasks") {
            if (request.method !== "GET" || [...url.searchParams.keys()].some(key => key !== "after")
              || url.searchParams.getAll("after").length > 1) throw new WebAccessError("invalid_request");
            const page = await tasks.attention(identity, url.searchParams.get("after") ?? undefined);
            // Separate authenticated transactions: never call a second identity-locking pool
            // from inside the web read transaction. Each receipt read rechecks current access.
            if (planning?.readSaved) for (const item of page.items) {
              if (!item.reasons.includes("proposal")) continue;
              const saved = await planning.readSaved(identity, item.task.projectId, item.task.jobId);
              if (saved) {
                const receipt = taskPlanningReceiptSchema.parse(saved);
                if (receipt.projectId !== item.task.projectId || receipt.sourceJobId !== item.task.jobId
                  || receipt.jobId === item.task.jobId) throw new Error("planning_receipt_scope_mismatch");
                item.reasons = item.reasons.filter(reason => reason !== "proposal");
              }
            }
            if (submission?.readDelivery) for (const item of page.items) {
              if (!item.reasons.includes("delivery_check")) continue;
              const status = taskDeliveryStatusSchema.parse(await submission.readDelivery(identity, item.task.projectId, item.task.jobId, item.inputDigest));
              if (status.projectId !== item.task.projectId || status.jobId !== item.task.jobId) throw new Error("delivery_status_scope_mismatch");
              item.reasons = item.reasons.filter(reason => reason !== "delivery_check");
              if (status.state === "not_queued") item.reasons.push("submission_needed");
              else if (status.state === "transmission_unconfirmed") item.reasons.push("delivery_uncertain");
              else if (status.state === "receipt_rejected") item.reasons.push("delivery_rejected");
              else if (status.state !== "receipt_recorded") item.reasons.push("delivery_pending");
            }
            return Response.json(taskAttentionPageSchema.parse({ ...page, planningSource: planning?.readSaved ? "configured" : "not_configured",
              deliverySource: submission?.readDelivery ? "configured" : "not_configured",
              items: page.items.filter(item => item.reasons.length) }), { headers: privateResponseHeaders });
          }
          if (url.pathname === "/api/v1/needs-me") {
            if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
            return Response.json(await connections.readQueueAttention(identity, queueAttention), { headers: privateResponseHeaders });
          }
          if (/^\/api\/v1\/projects\/[^/]+\/tasks(?:\/|$)/.test(url.pathname))
            return await createTaskHttpHandler({ origin: options.origin, trust, service: tasks, ownerReviews, ownerVerifications, planning, assignment, approvals, submission, revisions, clock })(request);
          if (url.pathname === "/api/v1/connections") {
            if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
            return Response.json(await connections.read(identity), { headers: privateResponseHeaders });
          }
          const stream = /^\/api\/v1\/projects\/([^/]+)\/events$/.exec(url.pathname);
          if (stream && request.method === "GET") {
            if (url.search) throw new WebAccessError("invalid_request");
            let id: string;
            try { id = decodeURIComponent(stream[1]); } catch { throw new WebAccessError("invalid_request"); }
            const project = await service.getView(identity, id);
            // A finite, current-state snapshot, not a long-lived authorization or a replayable job-event history.
            return new Response(`event: project-snapshot\ndata: ${JSON.stringify({ project })}\n\n`, {
              headers: { ...privateResponseHeaders, "content-type": "text/event-stream", "x-accel-buffering": "no" },
            });
          }
          return await createProjectHttpHandler({ origin: options.origin, trust, service, clock })(request);
        }
        if (request.method !== "GET" && request.method !== "HEAD") throw new WebAccessError("invalid_request");
        const taskPage = /^\/projects\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(url.pathname);
        const detail = /^\/projects\/([^/]+)(?:\/(overview|settings))?$/.exec(url.pathname);
        if (taskPage) {
          let id: string, jobId: string | undefined;
          try { id = decodeURIComponent(taskPage[1]); jobId = taskPage[2] ? decodeURIComponent(taskPage[2]) : undefined; }
          catch { throw new WebAccessError("invalid_request"); }
          if ([...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length > 1
            || jobId && url.search || url.searchParams.has("after") && !catalogProjectIdSchema.safeParse(url.searchParams.get("after")).success)
            throw new WebAccessError("invalid_request");
          if (jobId) await tasks.detail(identity, id, jobId); else await tasks.authorize(identity, id);
        } else if (detail) {
          let id: string;
          try { id = decodeURIComponent(detail[1]); } catch { throw new WebAccessError("invalid_request"); }
          await service.getView(identity, id);
        } else if (["/", "/projects"].includes(url.pathname)) {
          if ([...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length > 1
            || url.searchParams.has("after") && !catalogProjectIdSchema.safeParse(url.searchParams.get("after")).success)
            throw new WebAccessError("invalid_request");
          await service.authorizeCatalog(identity);
        } else if (["/connections", "/needs-me"].includes(url.pathname)) {
          if (url.search) throw new WebAccessError("invalid_request");
          await connections.authorize(identity);
        } else if (url.pathname !== "/session") throw new WebAccessError("not_found");
        if (url.pathname === "/") return new Response(null, { status: 303,
          headers: { ...privateResponseHeaders, location: "/projects" } });
        const response = await render();
        // The rendered shell carries no project records; every data read rechecks current session/project authority.
        for (const [name, value] of Object.entries(privateResponseHeaders)) response.headers.set(name, value);
        return response;
      } catch (error) {
        const failure = webFailure(error);
        if (!new URL(request.url).pathname.startsWith("/api/") && request.headers.get("accept")?.includes("text/html")) {
          const message = failure.status === 401 ? "Sign in to continue" : failure.status === 403 ? "Access is unavailable for this account"
            : failure.status === 404 ? "This page is not available" : "Control Room is temporarily unavailable";
          return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control Room</title><main><h1>${message}</h1><p>No sample data has been substituted.</p><p><a href="/session">Manage this session</a></p><p>Signing in again through Access logout also ends Access sessions for other protected applications.</p><p><a href="/cdn-cgi/access/logout">Sign in again</a></p></main></html>`,
            { status: failure.status, headers: { ...privateResponseHeaders, "content-type": "text/html; charset=utf-8" } });
        }
        return failure;
      }
    }
  return {
    async handle(request: Request, render: () => Promise<Response> | Response): Promise<Response> {
      if (closing || active >= 64) return webFailure(new Error());
      active++;
      try { return await Promise.race([dispatch(request, render), forced]); }
      finally { active--; if (closing && active === 0) drained?.(); }
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          if (active > 0) await Promise.race([new Promise<void>(resolve => { drained = resolve; }),
            new Promise<void>(resolve => { timer = setTimeout(() => { timedOut = true; force(); resolve(); }, drainMs); })]);
        } finally { clearTimeout(timer); keys.close(); }
        // The bounded production pool terminates all remaining work. Never retry an uncertain write.
        await options.database.close();
        if (timedOut) throw new Error("private_app_drain_uncertain");
      })();
      return closePromise;
    },
  };
}

export type PrivateApplication = Pick<ReturnType<typeof createPrivateWebProcess>, "handle" | "close">;
let installed: PrivateApplication | undefined;
/** Trusted server composition only. A closed installation is not replaceable in-process. */
export function installPrivateApplication(application: PrivateApplication) {
  if (installed) throw new Error("private_app_already_configured");
  installed = Object.freeze({ handle: application.handle.bind(application), close: application.close.bind(application) });
}
/** Exported in the server-only runtime entry, never exposed as an HTTP configuration route. */
export function installPrivateWebProcess(options: PrivateWebProcessOptions) {
  if (installed) throw new Error("private_app_already_configured");
  const application = createPrivateWebProcess(options);
  installPrivateApplication(application);
  return { close: () => application.close() };
}
export function handlePrivateWebRequest(request: Request, render: () => Promise<Response> | Response) {
  return installed ? installed.handle(request, render) : privateNotConfigured();
}
