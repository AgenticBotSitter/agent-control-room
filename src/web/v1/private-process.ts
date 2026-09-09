import type { DatabaseClient } from "../../persistence/database";
import { createAccessKeyCache, type AccessKeyLoader } from "./access-key-cache";
import { captureWebOrigins, createAccessVerifier, requireSameOrigin, WebAccessError } from "./access-verifier";
import { privateResponseHeaders, webFailure, readBoundedJson } from "./http-common";
import { createProjectHttpHandler } from "./project-http";
import { WebProjectService } from "./project-service";
import { WebIdeaProjectLifecycleOperation } from "./idea-project-lifecycle-operation";
import { catalogProjectIdSchema } from "./project-wire";
import { WebConnectionService, type WebConnectionKeys } from "./connection-service";
import { WebTaskService, type WebTaskKeys } from "./task-service";
import { WebNewsService } from "./news-service";
import type { WebNewsCollectionPlanning } from "./news-collection-planning";
import type { WebNewsCollectionAdmission } from "./news-collection-admission";
import { projectWorkspaceSafeIdSchemaV1 } from "../../project-workspace/v1";
import { WebIdeaService } from "./idea-service";
import type { IdeaCreateOperation } from "./idea-create-operation";
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
import { newsCollectionStatusSchema, newsCollectionHistorySchema } from "./news-collection-status-wire";
import { ideaCreationOptionsSchema } from "./idea-wire";

export interface PrivateWebProcessOptions {
  origin: string; issuer: string; audience: string; tenantId: string; workspaceId: string;
  /** Optional separately approved private address; same services, distinct Access audience. */
  secondaryAccess?: { origin: string; audience: string };
  maxSessionSeconds: number; loadKeys: AccessKeyLoader;
  /** A single process-owned pool, supplied by the separately reviewed deployment bootstrap. */
  database: { client: DatabaseClient; close: () => Promise<void> };
  /** Optional existing registry integrity key, supplied privately; never loaded or created by this process. */
  ideaProjects?: { integrityKey: Uint8Array };
  /** Read-only retained ABS source verification. Does not configure collection. */
  news?: { integrityKey: Uint8Array };
  /** Explicit operations from the trusted collector composition. This process does
   * not create readers, worker pools, schedules or collection authority. */
  newsCollections?: readonly { tenantId: string; workspaceId: string; projectId: string; sourceId: string;
    planning: Pick<WebNewsCollectionPlanning, "describe" | "propose" | "status" | "history">;
    admission: Pick<WebNewsCollectionAdmission, "approve"> }[];
  /** Existing enrollment/signal keys, supplied privately. Absence is unavailable, not an empty roster. */
  connections?: WebConnectionKeys;
  /** Existing harness evidence verification key. No key means progress is unavailable, not no runs. */
  tasks?: Omit<WebTaskKeys, "ideaIntegrityKey"> & { harnessIntegrityKey: Uint8Array };
  /** Trusted control-plane operation only. No planner key, privileged pool or native adapter is
   * given to the web SQL service. Its resource lifecycle is owned by the supplying composition. */
  planning?: TaskPlanningOperation;
  ideaCreation?: IdeaCreateOperation;
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
  const sites = captureWebOrigins({ origin: options.origin, audience: options.audience }, options.secondaryAccess);
  const newsCollections = new Map<string, { describe: WebNewsCollectionPlanning["describe"]; status: WebNewsCollectionPlanning["status"]; history: WebNewsCollectionPlanning["history"];
    propose: WebNewsCollectionPlanning["propose"]; approve: WebNewsCollectionAdmission["approve"] }>();
  for (const entry of options.newsCollections ?? []) {
    if (entry.tenantId !== options.tenantId || entry.workspaceId !== options.workspaceId
      || !catalogProjectIdSchema.safeParse(entry.projectId).success || !projectWorkspaceSafeIdSchemaV1.safeParse(entry.sourceId).success)
      throw new Error("invalid_private_app_config");
    const key = JSON.stringify([entry.projectId, entry.sourceId]);
    if (newsCollections.has(key)) throw new Error("invalid_private_app_config");
    newsCollections.set(key, { describe: entry.planning.describe.bind(entry.planning), status: entry.planning.status.bind(entry.planning), history: entry.planning.history.bind(entry.planning), propose: entry.planning.propose.bind(entry.planning),
      approve: entry.admission.approve.bind(entry.admission) });
  }
  if (options.ideaCreation && (options.ideaCreation.tenantId !== options.tenantId
    || options.ideaCreation.workspaceId !== options.workspaceId || typeof options.ideaCreation.create !== "function" || !options.ideaProjects))
    throw new Error("invalid_private_app_config");
  if (options.ideaCreation?.stop !== undefined && typeof options.ideaCreation.stop !== "function") throw new Error("idea_creation_config_invalid");
  if (options.ideaCreation?.options !== undefined && typeof options.ideaCreation.options !== "function") throw new Error("idea_creation_config_invalid");
  if (options.ideaCreation?.decide !== undefined && typeof options.ideaCreation.decide !== "function") throw new Error("idea_creation_config_invalid");
  if (options.ideaCreation?.synthesize !== undefined && typeof options.ideaCreation.synthesize !== "function") throw new Error("idea_creation_config_invalid");
  if (options.ideaCreation?.start !== undefined && typeof options.ideaCreation.start !== "function") throw new Error("idea_creation_config_invalid");
  const ideaCreation = options.ideaCreation ? Object.freeze({ create: options.ideaCreation.create.bind(options.ideaCreation),
    ...(options.ideaCreation.options ? { options: options.ideaCreation.options.bind(options.ideaCreation) } : {}),
    ...(options.ideaCreation.stop ? { stop: options.ideaCreation.stop.bind(options.ideaCreation) } : {}),
    ...(options.ideaCreation.decide ? { decide: options.ideaCreation.decide.bind(options.ideaCreation) } : {}),
    ...(options.ideaCreation.synthesize ? { synthesize: options.ideaCreation.synthesize.bind(options.ideaCreation) } : {}),
    ...(options.ideaCreation.start ? { start: options.ideaCreation.start.bind(options.ideaCreation) } : {}) }) : undefined;
  if (options.queueAttention && (options.queueAttention.tenantId !== options.tenantId
    || options.queueAttention.workspaceId !== options.workspaceId || typeof options.queueAttention.read !== "function"))
    throw new Error("invalid_private_app_config");
  const queueAttention = options.queueAttention ? Object.freeze({ tenantId: options.tenantId,
    workspaceId: options.workspaceId, read: options.queueAttention.read.bind(options.queueAttention) }) : undefined;
  if (options.planning && (options.planning.tenantId !== options.tenantId || options.planning.workspaceId !== options.workspaceId
    || typeof options.planning.plan !== "function" || options.planning.readSaved !== undefined && typeof options.planning.readSaved !== "function"
    || options.planning.supportsProject !== undefined && typeof options.planning.supportsProject !== "function")) throw new Error("invalid_private_app_config");
  const planning = options.planning ? Object.freeze({ plan: options.planning.plan.bind(options.planning),
    supportsProject: options.planning.supportsProject?.bind(options.planning),
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
    { tenantId: options.tenantId, workspaceId: options.workspaceId }, clock, options.ideaProjects?.integrityKey,
    options.ideaProjects ? new WebIdeaProjectLifecycleOperation(options.database.client,
      { tenantId: options.tenantId, workspaceId: options.workspaceId }, options.ideaProjects.integrityKey, clock) : undefined);
  const connections = new WebConnectionService(options.database.client,
    { tenantId: options.tenantId, workspaceId: options.workspaceId }, clock, options.connections);
  const tasks = new WebTaskService(options.database.client, { tenantId: options.tenantId, workspaceId: options.workspaceId }, clock,
    { ...options.tasks, ideaIntegrityKey: options.ideaProjects?.integrityKey });
  const news = new WebNewsService(options.database.client, { tenantId: options.tenantId, workspaceId: options.workspaceId },
    { integrityKey: options.news?.integrityKey, ideaIntegrityKey: options.ideaProjects?.integrityKey }, clock);
  const ideas = new WebIdeaService(options.database.client, { tenantId: options.tenantId, workspaceId: options.workspaceId },
    options.ideaProjects?.integrityKey, clock, !!ideaCreation, !!ideaCreation?.stop, !!ideaCreation?.decide, !!ideaCreation?.start, !!ideaCreation?.synthesize);
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
        const url = new URL(request.url);
        const site = sites.find(candidate => candidate.origin === url.origin);
        if (!site) throw new WebAccessError("access_denied");
        requireSameOrigin(request, site.origin);
        // Identity credentials only arrive on the verified edge assertion header. Never consume an app cookie/header alias.
        if (!request.headers.get("cf-access-jwt-assertion")) throw new WebAccessError("authentication_required");
        const trust = { ...await keys.get(), audience: site.audience };
        const identity = createAccessVerifier(trust)(request, clock());
        if (url.pathname.startsWith("/api/")) {
          if (url.pathname === "/api/v1/ideas/options") {
            if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
            if (!ideaCreation?.options) throw new Error("idea_creation_not_configured");
            return Response.json(ideaCreationOptionsSchema.parse(await ideaCreation.options(identity)), { headers: privateResponseHeaders });
          }
          const ideaSynthesis = /^\/api\/v1\/ideas\/([^/]+)\/synthesis$/.exec(url.pathname);
          if (ideaSynthesis) {
            if (request.method !== "POST" || url.search || !request.body
              || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new WebAccessError("invalid_request");
            if (!ideaCreation?.synthesize) throw new Error("idea_synthesis_not_configured");
            let sessionId: string; try { sessionId = decodeURIComponent(ideaSynthesis[1]); } catch { throw new WebAccessError("invalid_request"); }
            const result = await ideaCreation.synthesize(identity, sessionId, await readBoundedJson(request.body, 2048));
            return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
          }
          const ideaStart = /^\/api\/v1\/ideas\/([^/]+)\/start$/.exec(url.pathname);
          if (ideaStart) {
            if (request.method !== "POST" || url.search || !request.body
              || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new WebAccessError("invalid_request");
            if (!ideaCreation?.start) throw new Error("idea_start_not_configured");
            let sessionId: string; try { sessionId = decodeURIComponent(ideaStart[1]); } catch { throw new WebAccessError("invalid_request"); }
            const result = await ideaCreation.start(identity, sessionId, await readBoundedJson(request.body, 2048));
            return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
          }
          const ideaDecision = /^\/api\/v1\/ideas\/([^/]+)\/decision$/.exec(url.pathname);
          if (ideaDecision) {
            if (request.method !== "POST" || url.search || !request.body
              || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new WebAccessError("invalid_request");
            if (!ideaCreation?.decide) throw new Error("idea_decision_not_configured");
            let sessionId: string; try { sessionId = decodeURIComponent(ideaDecision[1]); } catch { throw new WebAccessError("invalid_request"); }
            const result = await ideaCreation.decide(identity, sessionId, await readBoundedJson(request.body, 4096));
            return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
          }
          const ideaStop = /^\/api\/v1\/ideas\/([^/]+)\/stop$/.exec(url.pathname);
          if (ideaStop) {
            if (request.method !== "POST" || url.search || !request.body
              || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new WebAccessError("invalid_request");
            if (!ideaCreation?.stop) throw new Error("idea_stop_not_configured");
            let sessionId: string; try { sessionId = decodeURIComponent(ideaStop[1]); } catch { throw new WebAccessError("invalid_request"); }
            return Response.json(await ideaCreation.stop(identity, sessionId, await readBoundedJson(request.body, 2048)), { headers: privateResponseHeaders });
          }
          const ideaRoute = /^\/api\/v1\/ideas(?:\/([^/]+))?$/.exec(url.pathname);
          if (ideaRoute) {
            if (request.method === "POST" && ideaRoute[1] === undefined) {
              if (url.search || !request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
                || !/^[A-Za-z0-9:_-]{8,160}$/.test(request.headers.get("idempotency-key") ?? "")) throw new WebAccessError("invalid_request");
              if (!ideaCreation) throw new Error("idea_creation_not_configured");
              const result = await ideaCreation.create(identity, await readBoundedJson(request.body, 8192), request.headers.get("idempotency-key")!);
              return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
            }
            if (request.method !== "GET" || [...url.searchParams.keys()].some(key => key !== "after")
              || url.searchParams.getAll("after").length > 1 || ideaRoute[1] && url.search)
              throw new WebAccessError("invalid_request");
            let sessionId: string | undefined;
            try { sessionId = ideaRoute[1] === undefined ? undefined : decodeURIComponent(ideaRoute[1]); }
            catch { throw new WebAccessError("invalid_request"); }
            return Response.json(sessionId === undefined ? await ideas.list(identity, url.searchParams.get("after") ?? undefined)
              : await ideas.detail(identity, sessionId), { headers: privateResponseHeaders });
          }
          const collectionRoute = /^\/api\/v1\/projects\/([^/]+)\/news\/sources\/([^/]+)\/collection(?:\/(propose|approve|status|history))?$/.exec(url.pathname);
          if (collectionRoute) {
            let projectId: string, sourceId: string;
            try { projectId = decodeURIComponent(collectionRoute[1]); sourceId = decodeURIComponent(collectionRoute[2]); }
            catch { throw new WebAccessError("invalid_request"); }
            if (!projectWorkspaceSafeIdSchemaV1.safeParse(sourceId).success) throw new WebAccessError("invalid_request");
            const operation = newsCollections.get(JSON.stringify([projectId, sourceId]));
            if (collectionRoute[3] === "history") {
              if (request.method !== "GET" || [...url.searchParams.keys()].some(key => key !== "after")
                || url.searchParams.getAll("after").length > 1
                || url.searchParams.has("after") && !projectWorkspaceSafeIdSchemaV1.safeParse(url.searchParams.get("after")).success)
                throw new WebAccessError("invalid_request");
              const after = url.searchParams.get("after") ?? undefined;
              if (!operation) {
                await news.sourceSettings(identity, projectId);
                return Response.json({ projectId, sourceId, configured: false, observedAt: new Date(clock()).toISOString(),
                  after: after ?? null, scanned: 0, nextCursor: null, entries: [] }, { headers: privateResponseHeaders });
              }
              const history = newsCollectionHistorySchema.parse(await operation.history(identity, after));
              if (history.projectId !== projectId || history.sourceId !== sourceId || history.after !== (after ?? null))
                throw new Error("news_collection_scope_mismatch");
              return Response.json(history, { headers: privateResponseHeaders });
            }
            if (collectionRoute[3] === "status") {
              if (request.method !== "GET" || [...url.searchParams.keys()].some(key => key !== "jobId")
                || url.searchParams.getAll("jobId").length > 1
                || url.searchParams.has("jobId") && !projectWorkspaceSafeIdSchemaV1.safeParse(url.searchParams.get("jobId")).success)
                throw new WebAccessError("invalid_request");
              if (!operation) {
                await news.sourceSettings(identity, projectId);
                return Response.json({ projectId, sourceId, configured: false, observedAt: new Date(clock()).toISOString(), latest: null }, { headers: privateResponseHeaders });
              }
              const status = newsCollectionStatusSchema.parse(await operation.status(identity, url.searchParams.get("jobId") ?? undefined));
              if (status.projectId !== projectId || status.sourceId !== sourceId) throw new Error("news_collection_scope_mismatch");
              return Response.json(status, { headers: privateResponseHeaders });
            }
            if (url.search) throw new WebAccessError("invalid_request");
            if (!collectionRoute[3]) {
              if (request.method !== "GET") throw new WebAccessError("invalid_request");
              if (!operation) {
                await news.sourceSettings(identity, projectId);
                return Response.json({ projectId, sourceId, configured: false, canRefresh: false, startsWork: false }, { headers: privateResponseHeaders });
              }
              const description = await operation.describe(identity);
              if (description.projectId !== projectId || description.sourceId !== sourceId) throw new Error("news_collection_scope_mismatch");
              return Response.json(description, { headers: privateResponseHeaders });
            }
            if (request.method !== "POST" || !request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
              throw new WebAccessError("invalid_request");
            if (!operation) { await news.sourceSettings(identity, projectId); throw new Error("news_collection_not_configured"); }
            const description = await operation.describe(identity);
            if (description.projectId !== projectId || description.sourceId !== sourceId) throw new Error("news_collection_scope_mismatch");
            const input = await readBoundedJson(request.body, 4096);
            const result = collectionRoute[3] === "propose" ? await operation.propose(identity, input) : await operation.approve(identity, input, sourceId);
            return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
          }
          const newsSources = /^\/api\/v1\/projects\/([^/]+)\/news\/sources$/.exec(url.pathname);
          if (newsSources) {
            let projectId: string;
            try { projectId = decodeURIComponent(newsSources[1]); } catch { throw new WebAccessError("invalid_request"); }
            if (request.method === "GET") {
              if ([...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length > 1)
                throw new WebAccessError("invalid_request");
              return Response.json(await news.sourceSettings(identity, projectId, url.searchParams.get("after") ?? undefined), { headers: privateResponseHeaders });
            }
            if (request.method !== "POST" || url.search || !request.body
              || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new WebAccessError("invalid_request");
            return Response.json(await news.saveSourceSetting(identity, projectId, await readBoundedJson(request.body, 8192)), { headers: privateResponseHeaders });
          }
          const newsArticle = /^\/api\/v1\/projects\/([^/]+)\/news\/article$/.exec(url.pathname);
          if (newsArticle) {
            const keys = ["storyId", "storyDigest", "detailDigest"];
            if (request.method !== "GET" || [...url.searchParams.keys()].some(key => !keys.includes(key))
              || keys.some(key => url.searchParams.getAll(key).length > 1)
              || ["storyId", "storyDigest"].some(key => !url.searchParams.has(key))) throw new WebAccessError("invalid_request");
            let projectId: string;
            try { projectId = decodeURIComponent(newsArticle[1]); } catch { throw new WebAccessError("invalid_request"); }
            return Response.json(await news.article(identity, projectId, Object.fromEntries(url.searchParams)), { headers: privateResponseHeaders });
          }
          const newsPrepare = /^\/api\/v1\/projects\/([^/]+)\/news\/prepare$/.exec(url.pathname);
          const newsArchive = /^\/api\/v1\/projects\/([^/]+)\/news\/archive$/.exec(url.pathname);
          if (newsArchive) {
            if (request.method !== "POST" || url.search || !request.body
              || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new WebAccessError("invalid_request");
            let projectId: string;
            try { projectId = decodeURIComponent(newsArchive[1]); } catch { throw new WebAccessError("invalid_request"); }
            return Response.json(await news.archive(identity, projectId, await readBoundedJson(request.body, 2048)), { headers: privateResponseHeaders });
          }
          if (newsPrepare) {
            if (request.method !== "POST" || url.search || !request.body
              || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
              throw new WebAccessError("invalid_request");
            let projectId: string;
            try { projectId = decodeURIComponent(newsPrepare[1]); } catch { throw new WebAccessError("invalid_request"); }
            return Response.json(await news.prepare(identity, projectId, await readBoundedJson(request.body, 8192)),
              { headers: privateResponseHeaders });
          }
          const newsRoute = /^\/api\/v1\/projects\/([^/]+)\/news$/.exec(url.pathname);
          if (newsRoute) {
            if (request.method !== "GET" || [...url.searchParams.keys()].some(key => !["after", "sourceAfter", "view", "order"].includes(key))
              || ["after", "sourceAfter", "view", "order"].some(key => url.searchParams.getAll(key).length > 1)) throw new WebAccessError("invalid_request");
            let projectId: string;
            try { projectId = decodeURIComponent(newsRoute[1]); } catch { throw new WebAccessError("invalid_request"); }
            return Response.json(await news.list(identity, projectId, url.searchParams.get("after") ?? undefined, url.searchParams.get("sourceAfter") ?? undefined, url.searchParams.get("view") ?? "all", url.searchParams.get("order") ?? "id"),
              { headers: privateResponseHeaders });
          }
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
            return await createTaskHttpHandler({ origin: site.origin, trust, service: tasks, ownerReviews, ownerVerifications, planning, assignment, approvals, submission, revisions, clock })(request);
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
          return await createProjectHttpHandler({ origin: site.origin, trust, service, clock })(request);
        }
        if (request.method !== "GET" && request.method !== "HEAD") throw new WebAccessError("invalid_request");
        const taskPage = /^\/projects\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(url.pathname);
        const newsPage = /^\/projects\/([^/]+)\/news$/.exec(url.pathname);
        const ideaPage = /^\/ideas(?:\/([^/]+))?$/.exec(url.pathname);
        const detail = /^\/projects\/([^/]+)(?:\/(overview|settings))?$/.exec(url.pathname);
        if (ideaPage) {
          if ([...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length > 1
            || ideaPage[1] && url.search) throw new WebAccessError("invalid_request");
          let sessionId: string | undefined;
          try { sessionId = ideaPage[1] === undefined ? undefined : decodeURIComponent(ideaPage[1]); }
          catch { throw new WebAccessError("invalid_request"); }
          if (sessionId) await ideas.detail(identity, sessionId); else await ideas.list(identity, url.searchParams.get("after") ?? undefined);
        } else if (taskPage) {
          let id: string, jobId: string | undefined;
          try { id = decodeURIComponent(taskPage[1]); jobId = taskPage[2] ? decodeURIComponent(taskPage[2]) : undefined; }
          catch { throw new WebAccessError("invalid_request"); }
          if ([...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length > 1
            || jobId && url.search || url.searchParams.has("after") && !catalogProjectIdSchema.safeParse(url.searchParams.get("after")).success)
            throw new WebAccessError("invalid_request");
          if (jobId) await tasks.detail(identity, id, jobId); else await tasks.authorize(identity, id);
        } else if (newsPage) {
          if ([...url.searchParams.keys()].some(key => !["after", "sourceAfter", "view", "order"].includes(key))
            || ["after", "sourceAfter", "view", "order"].some(key => url.searchParams.getAll(key).length > 1)
            || url.searchParams.has("view") && !["history", "archive", "fresh"].includes(url.searchParams.get("view")!)
            || url.searchParams.has("order") && !["important", "newest", "oldest"].includes(url.searchParams.get("order")!))
            throw new WebAccessError("invalid_request");
          let id: string;
          try { id = decodeURIComponent(newsPage[1]); } catch { throw new WebAccessError("invalid_request"); }
          await news.list(identity, id, url.searchParams.get("after") ?? undefined, url.searchParams.get("sourceAfter") ?? undefined,
            url.searchParams.get("view") ?? "history", url.searchParams.get("order") ?? "important");
        } else if (detail) {
          let id: string;
          try { id = decodeURIComponent(detail[1]); } catch { throw new WebAccessError("invalid_request"); }
          await service.getView(identity, id);
        } else if (["/", "/projects"].includes(url.pathname)) {
          if ([...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length > 1
            || url.searchParams.has("after") && !catalogProjectIdSchema.safeParse(url.searchParams.get("after")).success)
            throw new WebAccessError("invalid_request");
          await service.authorizeCatalog(identity);
        } else if (url.pathname === "/needs-me") {
          if (url.search) throw new WebAccessError("invalid_request");
          await tasks.authorizeAttentionPage(identity);
        } else if (url.pathname === "/connections") {
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
