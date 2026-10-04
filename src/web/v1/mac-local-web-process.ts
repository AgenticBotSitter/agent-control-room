import { ownerPushLinkV1 } from "../../web-push/v1/policy";
import { localOwnerSignInTargetV1 } from "./local-owner-session";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../persistence/database";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import { captureLocalOwnerSessionProfileV1, LocalOwnerSessionServiceV1, LocalOwnerAttemptLimitErrorV1, readLocalOwnerCodeV1,
  renderLocalOwnerSignInPageV1, renderLocalOwnerSignOutPageV1, type LocalOwnerSessionProfileV1 } from "./local-owner-session";
import { WebProjectService } from "./project-service";
import { ownerProjectSectionPageV1 } from "./owner-project-pages";
import { createProjectHttpHandler } from "./project-http";
import { createCoordinationHttpHandler } from "./coordination-http";
import { ProjectCoordinationHttpService, createProjectCoordinationCanonicalStoreAdapterV1 } from "./project-coordination-http";
import { WebTaskService, type WebTaskKeys } from "./task-service";
import { createTaskHttpHandler } from "./task-http";
import type { WebTaskReviewService } from "./task-review-service";
import type { WebTaskVerificationService } from "./task-verification-service";
import type { TaskPlanningOperation } from "./task-execution-planner";
import type { TaskAssignmentOperation } from "./task-assignment-coordinator";
import type { TaskApprovalOperation, TaskSubmissionOperation } from "./task-coordinator-lifecycle";
import type { TaskRevisionOperation } from "./task-revision-operation";
import type { MacLocalWorkerReadinessV1 } from "./mac-local-worker-readiness";
import { MacLocalWorkerScorecardServiceV1 } from "./mac-local-worker-scorecard-service";
import type { LocalOwnerSessionStoreV1 } from "./local-owner-session-store";
import type { PersistedLocalOwnerSessionV1 } from "./local-owner-session";
import type { ActionInboxItemV1 } from "../../operator-surfaces/v1";
import { WorkBatchOwnerServiceV1, type WorkBatchQueueAcceptedResultPortV1,
  type WorkBatchQueueCatalogV1 } from "../../work-intake/v1";
import { createWorkBatchOwnerHttpHandlerV1 } from "./work-batch-owner-http";
import { LinearPipelineServiceV1, PipelineAdvanceServiceV1 } from "../../pipelines/v1";
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
import { createWebPushChannelV1, deliverOwnerPushV1, parseWebPushSubscriptionV1, ownerPushEndpointAllowedV1, PostgresOwnerPushStoreV1,
  startOwnerPushLoopV1, type OwnerWebPushConfigV1 } from "../../web-push/v1";
import { FleetOwnerServiceV1 } from "../../fleet/v1";
import { createFleetOwnerHttpHandlerV1 } from "./fleet-owner-http";
import { createResultFileHttpHandlerV1 } from "./result-file-http";
import type { ResultFileStoreV1 } from "../../artifacts/v1/result-file-store";
import { composeResultFileService } from "./result-file-composition";
import type { FleetConnectorReleaseManifestV1 } from "../../fleet/v1/connector-release";
import { RecurringRuleServiceV1 } from "../../recurring/v1";
import { ReusableSkillServiceV1 } from "../../skills/v1";
import { createRecurringRuleHttpHandlerV1 } from "./recurring-rule-http";
import { createReusableSkillHttpHandlerV1 } from "./reusable-skill-http";
import type { ProjectOrchestrationOwnerPortV1 } from "./project-orchestration-owner";
import { createProjectOrchestrationHttpHandlerV1 } from "./project-orchestration-http";
import { hmacSha256Tag } from "../../security";
import type { UpdaterHomeStatusReaderV1 } from "./updater-home-status";
import { updaterOwnerAttentionRequestSchemaV1, updaterOwnerRequestSchemaV1,
  type UpdaterOwnerAttentionPortV1, type UpdaterOwnerUiPortV1 } from "./updater-owner-ui-wire";

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
  /** The one database client, and its lifecycle. `isAvailable` is REQUIRED, not
   * optional: a permanently closed client must make this process report NOT
   * ready, because every page it serves will fail and nothing else notices.
   * Making it optional was tried on this branch so a test double could omit it,
   * and the honest result is that a double which omits it is a double that
   * cannot say "the database went away" -- so the type stays strict and a
   * double says so. */
  database: { client: DatabaseClient; close: () => Promise<void>; isAvailable: () => boolean };
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
  /** The protected result-file byte store. Omitted means the download route
   * does not exist, which is honest: there is nothing to download from. */
  resultFileStore?: ResultFileStoreV1;
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
  /** Optional owner chief-of-staff bridge supplied by the host composition. */
  orchestration?: ProjectOrchestrationOwnerPortV1;
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
  fleet?: Readonly<{ ownerAuthority: DatabaseClient; gatewayOrigin?: string;
    connectorRelease?: FleetConnectorReleaseManifestV1; afterDecision?: () => Promise<unknown> }>;
  clock?: () => number;
  /** Present only in the real task-host process. The authenticated readiness
   * route returns this pid so mac:up can bind the listener to the supervisor's
   * private child record instead of trusting an arbitrary open port. */
  hostProcessId?: number;
  /** Independent, installation-private readiness key. It never shares owner
   * sign-in material, so deleting or rotating the owner code cannot forge a
   * host-health response. */
  healthProbeKey?: Uint8Array;
  healthReleaseId?: string;
  healthStartedAt?: string;
  /** A read-only projection of updater status. It exists for Home copy only;
   * the web process receives no updater control or approval authority. */
  updaterHomeStatus?: UpdaterHomeStatusReaderV1;
  /** R7U-01 (lead decision 3): the owner's answer to a published run outcome.
   *
   * This is the ONLY way the owner clears a card, and it is deliberately a port
   * rather than a database write: the web login has no UPDATE on the row, is not
   * granted the `run_id`, and this host cannot decide which run is outstanding —
   * the updater owns that. What the host contributes is the owner session, which
   * is what the acknowledgement is recorded against.
   *
   * The updater records the request as an `owner_requests` row rather than
   * answering inline, so a press that arrives while the updater is restarting is
   * still answered on its next tick. The host therefore does not promise the
   * card has cleared by the time it returns; it promises the press was accepted
   * and is durable. */
  updaterOwnerAttention?: UpdaterOwnerAttentionPortV1;
  /** The root updater's bounded owner surface. Omission leaves update controls
   * absent rather than letting the ordinary web process invent status. */
  updaterOwnerUi?: UpdaterOwnerUiPortV1;
  /** Item 10a web seam. The release process may insert the bounded raw row but
   * never verifies or activates a credential; root's updater owns that step. */
  passkeyRegistration?: Readonly<{
    options(input: { ownerSessionDigest: string; registrationSecret: string }): Promise<unknown>;
    insert(input: { ownerSessionDigest: string; registrationSecret: string; comparisonCode: string;
      response: unknown; authorizationAssertion: unknown | null }): Promise<unknown>;
  }>;
}

/** Existing controller operations supplied by the host.  This is deliberately
 * only a typed pass-through: the Mac-local web wrapper cannot construct a
 * planner, queue, result store, review system, or worker of its own. */
export type MacLocalCanonicalTaskOperationsV1 = Pick<MacLocalWebProcessOptionsV1,
  "ownerReviews" | "ownerVerifications" | "planning" | "assignment" | "approvals" | "submission" | "revisions">;

async function passkeyRegistrationResponse(operation: () => Promise<unknown>, status: number): Promise<Response> {
  try { return Response.json(await operation(), { status, headers: privateResponseHeaders }); }
  catch (error) {
    if (error instanceof Error && (error as Error & { code?: unknown }).code === "updater_registration_expired") {
      return Response.json({ error: "registration_expired",
        message: "This Face ID registration link has expired or was already used. Return to the installer and start again." },
      { status: 410, headers: privateResponseHeaders });
    }
    throw error;
  }
}

/**
 * The first real Mac-local web composition. It has a fixed loopback-only owner
 * authentication seam and reuses the normal project service and its database
 * session/grant checks. It does not alter the hosted Cloudflare process.
 */
export function createMacLocalWebProcessV1(options: MacLocalWebProcessOptionsV1) {
  const profile = captureLocalOwnerSessionProfileV1(options.localOwnerSession);
  const origin = new URL(options.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.origin !== options.origin
    || profile.origin !== options.origin || !options.workspaceId || !options.database || typeof options.database.close !== "function"
    || typeof options.database.isAvailable !== "function")
    throw new Error("mac_local_web_process_config_invalid");
  // An owner review that can accept exceptions must use the task application's
  // same in-session proposal service. Refuse a partial composition instead of
  // mounting a review that succeeds for ordinary accepts but cannot follow up.
  if (options.ownerReviews && !options.taskService) throw new Error("mac_local_web_process_config_invalid");
  if (options.hostProcessId !== undefined
    && (!Number.isSafeInteger(options.hostProcessId) || options.hostProcessId <= 1))
    throw new Error("mac_local_web_process_config_invalid");
  if (options.hostProcessId !== undefined && (!(options.healthProbeKey instanceof Uint8Array)
    || options.healthProbeKey.length !== 32 || typeof options.healthReleaseId !== "string"
    || !options.healthReleaseId || typeof options.healthStartedAt !== "string"
    || !Number.isFinite(Date.parse(options.healthStartedAt)))) throw new Error("mac_local_web_process_config_invalid");
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
  // Construct on first admitted request, so coordination's canonical-store
  // requirements do not affect unrelated routes. Keep one handler thereafter
  // to preserve its in-flight request coalescing.
  let coordinationHttp: ReturnType<typeof createCoordinationHttpHandler> | undefined;
  const buildCoordinationHttp = () => {
    const coordination = new ProjectCoordinationHttpService({ database: options.database.client,
      scope: { tenantId: profile.tenantId, workspaceId: options.workspaceId }, clock,
      store: createProjectCoordinationCanonicalStoreAdapterV1({ database: options.database.client, tenantId: profile.tenantId,
        workspaceId: options.workspaceId, now: clock }) });
    return createCoordinationHttpHandler({ origin: options.origin, localOwnerSession: sessions,
      service: coordination, clock, isCoordinationEnabled: () => coordination.isEnabled(),
      // int9's coalescing map refuses to build without a per-caller check, as on the VPS.
      authorizeCaller: async (verified, project) => { await coordination.authorizeCaller(verified, project); } });
  };
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
  const orchestrationHttp = options.orchestration ? createProjectOrchestrationHttpHandlerV1({ origin: options.origin,
    localOwnerSession: sessions, service: options.orchestration, clock }) : undefined;
  const pipelineKey = options.workBatchIntegrityKey;
  const pipelines = pipelineKey ? new LinearPipelineServiceV1(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, pipelineKey,
    options.workBatchQueueAdmissionAuthority, clock, undefined, tasks) : undefined;
  // The owner consent/history port, built on THIS web connection with the SAME
  // installation key, exactly as the hosted composition builds it
  // (private-process.ts). It is mounted only together with the pipelines
  // service that owns the same run rows, so the two cannot disagree about which
  // runs exist.
  //
  // This is the fix for the 404 history / 400 consent pair: the handler's
  // optional `advance` was simply never supplied on this composition, while the
  // owner page still offered both controls. Execution stays ABSENT -- the empty
  // configuration means `advance()` finds no capability and refuses
  // `unattended_disabled`, so nothing here can start, assign or dispatch a
  // stage. `setUnattended` and `historyForOwner` are the owner's control and read
  // surface and need no capability, which is precisely why the hosted site can
  // offer them too.
  const pipelineAdvance = pipelineKey ? new PipelineAdvanceServiceV1(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, pipelineKey, {}, clock) : undefined;
  // One condition, not two: `pipelineHttp` exists exactly when the pipelines
  // service does, so the handler can never be mounted without the service that
  // owns the run rows it reads.
  const pipelineHttp = pipelines && pipelineAdvance ? createLinearPipelineHttpHandlerV1({ origin: options.origin,
    localOwnerSession: sessions, service: pipelines, advance: pipelineAdvance, clock }) : undefined;
  const improvementDesk = options.workBatchIntegrityKey && pipelines ? new ImproveControlRoomDeskServiceV1(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, options.workBatchIntegrityKey, pipelines, clock) : undefined;
  const improvementHttp = improvementDesk ? createImproveControlRoomHttpHandlerV1({ origin: options.origin,
    localOwnerSession: sessions, service: improvementDesk, clock }) : undefined;
  const ownerPush = options.ownerWebPush ? { store: new PostgresOwnerPushStoreV1(options.database.client),
    channel: createWebPushChannelV1(options.ownerWebPush) } : undefined;
  // The Workers page's bot/model scorecard. Built here, from this installation's
  // ONE web connection and its OWN tenant/workspace scope, so the route has no
  // scope a caller could choose. Built unconditionally rather than behind an
  // option: the read needs no key, no module and no second login, so a host that
  // omitted it would answer "could not be read" on a page that has real data.
  const workerScorecard = new MacLocalWorkerScorecardServiceV1(options.database.client,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId }, clock);
  // "Save to my Mac" (plan v4.3 2.6). Absent without a download key, and then
  // the route simply does not exist rather than answering an empty catalog.
  const resultFiles = options.resultFileStore && options.taskReadKeys?.harnessIntegrityKey
    ? composeResultFileService({ database: options.database.client, tasks, tenantId: profile.tenantId,
      downloadKey: options.taskReadKeys.harnessIntegrityKey, store: options.resultFileStore, clock })
    : undefined;
  const resultFileHttp = resultFiles ? createResultFileHttpHandlerV1({ origin: options.origin,
    localOwnerSession: sessions, service: resultFiles, clock }) : undefined;
  const fleet = options.fleet;
  const fleetOwner = fleet ? new FleetOwnerServiceV1(fleet.ownerAuthority,
    { tenantId: profile.tenantId, workspaceId: options.workspaceId, clock,
      ...(fleet.afterDecision ? { afterDecision: fleet.afterDecision } : {}) }) : undefined;
  const fleetHttp = fleetOwner ? createFleetOwnerHttpHandlerV1({ origin: options.origin, localOwnerSession: sessions, clock,
    service: fleetOwner,
    ...(fleet?.gatewayOrigin ? { gatewayOrigin: fleet.gatewayOrigin } : {}),
    ...(fleet?.connectorRelease ? { connectorRelease: fleet.connectorRelease } : {}) }) : undefined;
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
  const isReady = () => closed === undefined && options.database.isAvailable() === true;

  function pageRedirect(path: string, requestOrigin = options.origin): Response {
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
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control Room page unavailable</title><style>*{box-sizing:border-box}body{margin:0;padding:1rem;font:16px/1.5 system-ui}a{display:inline-flex;align-items:center;min-width:44px;min-height:44px;overflow-wrap:anywhere}</style><main><h1>Page unavailable</h1><p role="alert">${message}</p><p><a href="/projects">Return to Projects</a></p></main></html>`, {
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
    // The three pages the owner can already link to, which the table omitted and
    // which the QA sweep measured as 404 "Page unavailable" (R4U-05). On a
    // connector-only Mac host `/workers/connect` is the ONLY link to the main
    // job, and the notification on/off screen lives on `/settings`, so both were
    // dead ends rather than minor omissions.
    //
    // Each is the SHARED shell only. Every panel keeps its own endpoint and its
    // own permission check, which is the same contract `/workers` and
    // `/session-watch` already use, so serving the shell here authorizes nothing:
    //   * `/workers/connect` reads /api/v1/fleet and writes through
    //     /api/v1/fleet/connect-codes, which the fleet owner handler authorizes
    //     on every call;
    //   * `/settings` and `/setup` read configuration, topology and the owner's
    //     own notification and voice settings through their own endpoints.
    // The pages are also only meaningful when the feature behind them is
    // configured, and each says so in its own words when it is not.
    if (["/workers/connect", "/settings", "/setup"].includes(url.pathname)) {
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
    const projectSection = ownerProjectSectionPageV1.exec(url.pathname);
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
        if (request.method !== "GET" || [...url.searchParams.keys()].some(key => key !== "next")
          || url.searchParams.getAll("next").length > 1) throw new WebAccessError("invalid_request");
        sessions.assertLocalRequest(request);
        let next = "/projects";
        try { next = ownerPushLinkV1(url.searchParams.get("next") ?? next); }
        catch { throw new WebAccessError("invalid_request"); }
        return renderLocalOwnerSignInPageV1(next);
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
          sessions.assertLocalRequest(request, true);
          let live = true;
          try { await sessions.verifyLive(request, clock()); }
          catch (error) {
            if (!(error instanceof WebAccessError) || error.code !== "authentication_required") throw error;
            live = false;
          }
          // Already-ended sessions can finish idempotently without spending
          // the live owner's budget. Unknown cookies still fail in revoke.
          if (live) sessions.admitAuthenticationAttempt(request, clock());
          await sessions.revoke(request, clock());
          return new Response(null, { status: 204, headers: { ...privateResponseHeaders,
            "set-cookie": `${"control_room_local_owner"}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` } });
        }
        throw new WebAccessError("invalid_request");
      }
      if (url.pathname === "/api/v1/local-host-health") {
        if (request.method !== "POST" || url.search || options.hostProcessId === undefined)
          throw new WebAccessError("not_found");
        if (url.origin !== options.origin) throw new WebAccessError("access_denied");
        sessions.assertLocalRequest(request, true);
        if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
          || !request.body) throw new WebAccessError("invalid_request");
        const body = await readBoundedJson(request.body, 256);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype
          || Object.keys(body).length !== 1 || typeof (body as { nonce?: unknown }).nonce !== "string"
          || !/^[A-Za-z0-9_-]{43}$/u.test((body as { nonce: string }).nonce))
          throw new WebAccessError("invalid_request");
        const nonce = (body as { nonce: string }).nonce, pid = options.hostProcessId,
          releaseId = options.healthReleaseId!, startedAt = options.healthStartedAt!, ready = isReady();
        const tag = hmacSha256Tag(options.healthProbeKey!,
          { purpose: "local-host-health/v1", nonce, pid, ready, releaseId, startedAt });
        return Response.json({ schema: "control-room.local-host-health/v1", ready, pid, nonce, releaseId, startedAt, tag },
          { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/local-workers") {
        if (request.method !== "GET" || url.search || !options.workerReadiness && !fleetOwner) throw new WebAccessError("not_found");
        // `verifyLive`, not `verify`: a session revoked by another process after this
        // host started must stop working without waiting for a restart.
        const identity = await sessions.verifyLive(request, clock());
        const connectorWorkers = !options.workerReadiness && fleetOwner
          ? (await fleetOwner.listWorkers(identity)).workers.map(worker => ({ kind: worker.workerKind,
            state: worker.status === "connected" || worker.status === "working" ? "ready" as const : "unavailable" as const,
            proof: "not_proven" as const })) : undefined;
        const taskWorkersStarted = options.taskWorkersStarted === true || connectorWorkers !== undefined;
        return Response.json({ taskWorkersStarted,
          ...(taskWorkersStarted ? {} : { instruction: "create your first project, then run mac:down && mac:up" }),
          projectSections: ["overview", "inbox", "work", ...(workBatches ? ["pipelines"] : []), "agents", "reviews",
            ...(options.projectEvents ? ["activity"] : []), "automations",
            ...(options.taskReadKeys?.results ? ["files"] : []), "settings"],
          workers: connectorWorkers ?? options.workerReadiness!.read().map(worker => options.taskWorkersStarted === true ? worker
            : { ...worker, state: "unavailable", proof: "not_proven" }) }, { headers: privateResponseHeaders });
      }
      const passkeyAttempt = request.method === "POST" && (url.pathname === "/api/v1/passkeys/registration/options"
        || url.pathname === "/api/v1/passkeys/registration");
      if (passkeyAttempt) sessions.assertLocalRequest(request, true);
      const identity = await sessions.verifyLive(request, clock());
      // Only live sessions can spend the owner's shared authentication budget.
      if (passkeyAttempt) sessions.admitAuthenticationAttempt(request, clock());
      if (url.pathname === "/api/v1/workers-scorecard") {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        // The identity above is already verified live, so a session revoked by
        // another process after this host started has already been refused. The
        // scorecard's own owner check runs inside the service, after this.
        return Response.json(await workerScorecard.read(identity), { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/updater-owner-ui") {
        if (request.method !== "GET" || url.search || !options.updaterOwnerUi) throw new WebAccessError("not_found");
        return Response.json(await options.updaterOwnerUi.read({ tenantId: profile.tenantId, ownerSubject: identity.subject,
          now: new Date(clock()).toISOString() }), { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/updater-owner-requests") {
        sessions.assertLocalRequest(request, true);
        if (request.method !== "POST" || url.search || !options.updaterOwnerUi || !request.body
          || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
          throw new WebAccessError("invalid_request");
        const parsed = updaterOwnerRequestSchemaV1.safeParse(await readBoundedJson(request.body, 512));
        const key = request.headers.get("idempotency-key") ?? "";
        if (!parsed.success || !/^[A-Za-z0-9:_-]{16,160}$/u.test(key)) throw new WebAccessError("invalid_request");
        return Response.json(await options.updaterOwnerUi.request({ tenantId: profile.tenantId, ownerSubject: identity.subject,
          action: parsed.data.action, planId: parsed.data.planId, idempotencyKey: key, now: new Date(clock()).toISOString() }),
        { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/updater-owner-passkey") {
        sessions.assertLocalRequest(request, true);
        if (request.method !== "POST" || url.search || !options.updaterOwnerUi || !request.body
          || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
          throw new WebAccessError("invalid_request");
        const raw = await readBoundedJson(request.body, 256);
        const parsed = raw && typeof raw === "object" && !Array.isArray(raw) && Object.getPrototypeOf(raw) === Object.prototype
          && Object.keys(raw).length === 2 && ((raw as { action?: unknown }).action === "approve" || (raw as { action?: unknown }).action === "rollback")
          && ((raw as { planId?: unknown }).planId === null || typeof (raw as { planId?: unknown }).planId === "string"
            && /^[A-Za-z0-9:_-]{1,120}$/u.test((raw as { planId: string }).planId)) ? raw as { action: "approve" | "rollback"; planId: string | null } : undefined;
        const key = request.headers.get("idempotency-key") ?? "";
        if (!parsed || !/^[A-Za-z0-9:_-]{16,160}$/u.test(key)) throw new WebAccessError("invalid_request");
        return Response.json(await options.updaterOwnerUi.beginPasskeyApproval({ tenantId: profile.tenantId,
          ownerSubject: identity.subject, action: parsed.action, planId: parsed.planId, idempotencyKey: key, now: new Date(clock()).toISOString() }),
        { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/updater-status") {
        if (request.method !== "GET" || url.search || !options.updaterHomeStatus) throw new WebAccessError("not_found");
        return Response.json(await options.updaterHomeStatus.read(), { headers: privateResponseHeaders });
      }
      // R7U-01 (lead decision 3): the owner's answer to a published run outcome.
      //
      // It is BELOW `verifyLive` and takes the SAME owner session the read above
      // does, so it needs no second authentication and no Face ID: acknowledging
      // a card is not an effect on the installation. `assertLocalRequest` is the
      // CSRF boundary every other owner POST here uses, and the body must be
      // EMPTY — the request carries no run id, so there is nothing for a caller
      // to vary, and an unexpected field is a refusal rather than a silently
      // ignored one.
      if (url.pathname === "/api/v1/updater-owner-attention") {
        sessions.assertLocalRequest(request, true);
        if (request.method !== "POST" || url.search || !options.updaterOwnerAttention || !request.body
          || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
          throw new WebAccessError("invalid_request");
        const parsed = updaterOwnerAttentionRequestSchemaV1.safeParse(await readBoundedJson(request.body, 64));
        if (!parsed.success) throw new WebAccessError("invalid_request");
        return Response.json(await options.updaterOwnerAttention.acknowledge({ ownerSubject: identity.subject,
          ownerSessionDigest: identity.tokenDigest }), { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/passkeys/registration/options"
          || url.pathname === "/api/v1/passkeys/registration") {
        if (!options.passkeyRegistration || request.method !== "POST" || url.search || !request.body
          || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
          throw new WebAccessError(options.passkeyRegistration ? "invalid_request" : "not_found");
        sessions.assertLocalRequest(request, true);
        const body = await readBoundedJson(request.body, 20_000);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype)
          throw new WebAccessError("invalid_request");
        const value = body as Record<string, unknown>, registrationSecret = value.registrationSecret;
        if (typeof registrationSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(registrationSecret))
          throw new WebAccessError("invalid_request");
        if (url.pathname.endsWith("/options")) {
          if (Object.keys(value).sort().join(",") !== "registrationSecret") throw new WebAccessError("invalid_request");
          const registrationOptions = options.passkeyRegistration.options.bind(options.passkeyRegistration);
          return await passkeyRegistrationResponse(() => registrationOptions({ ownerSessionDigest: identity.tokenDigest,
            registrationSecret }), 200);
        }
        if (Object.keys(value).sort().join(",") !== "authorizationAssertion,comparisonCode,registrationSecret,response"
            || typeof value.comparisonCode !== "string" || !/^[0-9A-Z]{6}$/u.test(value.comparisonCode))
          throw new WebAccessError("invalid_request");
        const comparisonCode = value.comparisonCode;
        const insertRegistration = options.passkeyRegistration.insert.bind(options.passkeyRegistration);
        return await passkeyRegistrationResponse(() => insertRegistration({ ownerSessionDigest: identity.tokenDigest,
          registrationSecret, comparisonCode, response: value.response,
          authorizationAssertion: value.authorizationAssertion ?? null }), 201);
      }
      if (url.pathname === "/api/v1/product-configuration") {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        await projects.authorizeCatalog(identity);
        return Response.json(productConfiguration, { headers: privateResponseHeaders });
      }
      if (url.pathname === "/api/v1/owner-web-push") {
        if (!ownerPush) {
          // int10: every page's header reads this status (r7iui/r7ipol). An
          // installation without phone push configured is a valid shape, so its
          // status read answers "not set up" rather than a 404 on every page and
          // every 30-second check. Every write is still refused.
          if (request.method === "GET" && !url.search) return Response.json({ enabled: false, subscribed: false,
            message: "Phone notifications are not set up on this installation." }, { headers: privateResponseHeaders });
          throw new WebAccessError("not_found");
        }
        if (request.method !== "GET") {
          sessions.assertLocalRequest(request, true);
          if (!request.body) throw new WebAccessError("invalid_request");
        }
        if (request.method === "GET" && !url.search) {
          return Response.json({ enabled: true, publicKey: options.ownerWebPush!.publicKey, subscribed: false,
            message: "This browser can subscribe to phone notifications." }, { headers: privateResponseHeaders });
        }
        if (request.method === "POST" && !url.search && request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json") {
          // A malformed or off-list subscription is the CALLER's problem, so it
          // is reported as a 400 rather than as the 503 a bare Error maps to. The
          // endpoint allow list is enforced here, at the earliest point, so this
          // is the status an owner sees when their browser hands us an endpoint
          // on a host that is not a push service -- "the service is down" would
          // send them looking in entirely the wrong place.
          let subscription;
          try { subscription = parseWebPushSubscriptionV1(await readBoundedJson(request.body!, 4096)); }
          catch { throw new WebAccessError("invalid_request"); }
          await ownerPush.store.subscribe({ id: "", tenantId: profile.tenantId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth, expiresAt: subscription.expirationTime === null ? null : new Date(subscription.expirationTime).toISOString() });
          return new Response(null, { status: 204, headers: privateResponseHeaders });
        }
        if (request.method === "DELETE" && !url.search && request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json") {
          const body = await readBoundedJson(request.body!, 4096); if (!body || typeof body !== "object" || typeof (body as { endpoint?: unknown }).endpoint !== "string") throw new WebAccessError("invalid_request");
          await ownerPush.store.unsubscribe(profile.tenantId, (body as { endpoint: string }).endpoint);
          return new Response(null, { status: 204, headers: privateResponseHeaders });
        }
        throw new WebAccessError("invalid_request");
      }
      if (url.pathname === "/api/v1/owner-web-push/test" || url.pathname === "/api/v1/owner-web-push/status") {
        if (!ownerPush || request.method !== "POST" || url.search || !request.body
          || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new WebAccessError("invalid_request");
        const body = await readBoundedJson(request.body, 4096);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "endpoint") throw new WebAccessError("invalid_request");
        const endpoint = (body as { endpoint?: unknown }).endpoint;
        if (!ownerPushEndpointAllowedV1(endpoint)) throw new WebAccessError("invalid_request");
        if (url.pathname.endsWith("/status")) return Response.json({ subscribed:
          (await ownerPush.store.list(profile.tenantId)).some(subscription => subscription.endpoint === endpoint) }, { headers: privateResponseHeaders });
        const now = new Date(clock()).toISOString();
        const result = await deliverOwnerPushV1({ tenantId: profile.tenantId, kind: "test", link: "/settings", dedupeKey: `test:${randomUUID()}`,
          now, store: ownerPush.store, channel: ownerPush.channel, subscriptionEndpoint: endpoint });
        if (result.delivered === 0) throw new Error("owner_push_test_not_accepted");
        return Response.json({ accepted: true }, { headers: privateResponseHeaders });
      }
      const activity = /^\/api\/v1\/projects\/([^/]+)\/(activity|events)$/.exec(url.pathname);
      if (activity) {
        // No event source (the connector-only host builds no task application)
        // means no feed: absent like Files and Pipelines, not a permanent 503.
        if (!options.projectEvents) throw new WebAccessError("not_found");
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
        || /^\/api\/v1\/projects\/[^/]+(?:\/(?:lifecycle|idea-lifecycle|settings))?$/.test(url.pathname)) return projectHttp(request);
      if (/^\/api\/v1\/projects\/[^/]+\/tasks(?:\/|$)/.test(url.pathname)) return taskHttp(request);
      if (/^\/api\/v1\/projects\/[^/]+\/recurring-rules(?:\/|$)/.test(url.pathname)) return recurringRuleHttp(request);
      if (/^\/api\/v1\/projects\/[^/]+\/skills(?:\/|$)/.test(url.pathname)) return reusableSkillHttp(request);
      const coordinationRoute = /^\/api\/v1\/projects\/([^/]+)\/coordination(?:\/|$)/.exec(url.pathname);
      if (coordinationRoute) {
        sessions.assertLocalRequest(request, !["GET", "HEAD"].includes(request.method));
        // The canonical coordination adapter is tenant-scoped. Apply the
        // same project/workspace admission as the page before delegating.
        await projects.getView(identity, routeId(coordinationRoute[1]!));
        return (coordinationHttp ??= buildCoordinationHttp())(request);
      }
      if (orchestrationHttp && (/^\/api\/v1\/projects\/[^/]+\/orchestration(?:-settings|-retry)?$/.test(url.pathname)
        || /^\/api\/v1\/projects\/[^/]+\/pipelines\/[^/]+\/suggestions(?:\/|$)/.test(url.pathname)))
        return orchestrationHttp(request);
      if (workBatchHttp && /^\/api\/v1\/projects\/[^/]+\/pipelines(?:\/|$)/.test(url.pathname)) return workBatchHttp(request);
      if (fleetHttp && /^\/api\/v1\/fleet(?:\/|$)/.test(url.pathname)) return fleetHttp(request);
      if (resultFileHttp && /^\/api\/v1\/projects\/[^/]+\/result-files(?:\/|$)/.test(url.pathname))
        return resultFileHttp(request);
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
      if (error instanceof LocalOwnerAttemptLimitErrorV1) return Response.json({ error: "owner_attempt_limit",
        message: `Too many attempts. Wait ${error.retryAfterSeconds} seconds before trying again.`,
        retryAfterSeconds: error.retryAfterSeconds }, { status: 429,
        headers: { ...privateResponseHeaders, "retry-after": String(error.retryAfterSeconds) } });
      if (error instanceof WebAccessError && error.code === "authentication_required" && request.method === "GET"
        && !new URL(request.url).pathname.startsWith("/api/")) {
        return pageRedirect(localOwnerSignInTargetV1(new URL(request.url).pathname), new URL(request.url).origin);
      }
      if (request.method === "GET" && !new URL(request.url).pathname.startsWith("/api/")) return pageFailure(error);
      return webFailure(error);
    }
  }

  // Readiness folds in the database. It used to be `closed === undefined`, which
  // is true for the entire life of a process whose database client has been
  // closed underneath it: `bindPrivatePgPool` quarantines a client PERMANENTLY
  // on an uncertain outcome, and the process keeps answering `/ready` while
  // every page it serves fails. The review's N1 was invisible for exactly this
  // reason -- the host was told the app was ready, so nothing restarted it.
  //
  // `isAvailable` is called unconditionally, because the type above requires it.
  // An optional call here would be a guard that could silently do nothing, which
  // is the failure this whole branch is about.
  return Object.freeze({ handle,
    isReady: () => closed === undefined && options.database.isAvailable(),
    close: () => closed ??= options.database.close() });
}
