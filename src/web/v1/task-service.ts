import { randomUUID } from "node:crypto";
import { newsResearchTaskDraft } from "./news-research-draft";
import { parseNewsWorkOrderProposalV1 } from "../../project-adapters/news/v1/proposal";
import { PostgresNewsTaskProposalLinksV1 } from "../../project-adapters/news/v1/task-proposal-links";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { CanonicalStore, type ProposedWorkBundle } from "../../persistence/canonical-store";
import { DOMAIN_CONTRACT_VERSION, requestRecordSchema, workflowRecordSchema, jobRecordSchema,
  attemptRecordSchema, type AuthorityEnvelope } from "../../domain/v1";
import { appendAuditWith } from "../../audit/audit-store";
import { assertNoSecretMaterial, computeAuthorityDigest, sha256Digest } from "../../security";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import type { NativeResultReadConfiguration } from "../../artifacts/v1/native-results";
import { CompletionGateStoreV1 } from "../../completion-gate/v1/store";
import { readTaskReviewPlanV1, taskReviewPlanKeyV1, taskReviewRootSubjectIdV1,
  type TaskResultReceiptV1, verifyTaskReviewTargetV1 } from "../../completion-gate/v1/task-review-plan";
import { PlanSelectedTaskResultReaderV1 } from "./task-result-reader";
import type { AwaitableRollbackCheckpointStoreV1 } from "../../security/rollback-checkpoint";
import type { WebTaskReviewConfiguration } from "./task-review-service";
import type { ManualVerificationScenario, ManualVerificationScenarioSource } from "./task-verification-service";
import { taskResultMetadataSchema, boundedTaskResultsPage, taskResultContentSchema, taskReviewEvidenceSchema } from "./task-result-wire";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebSessionAuthority, type WebActor } from "./session-authority";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../../idea-lab/v1/schemas";
import { taskAttentionPageSchema, taskAttentionPresentation, type TaskAttentionPage } from "./task-attention-wire";
import { taskProjectAttentionPageSchema, taskProjectResultAttentionReasons,
  type TaskProjectAttentionPage } from "./task-project-attention-wire";
import { WebProjectService } from "./project-service";
import { catalogProjectIdSchema } from "./project-wire";
import { taskDraftSchema, taskSummarySchema, taskReceiptSchema, taskDetailSchema, taskPageSchema,
  taskRunSchema, type HermesDeliveryRecovery, type TaskRun, type TaskReceipt, type TaskSummary } from "./task-wire";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_LOCAL_JOB_TYPE_V1, type Hermes021MacosDeliveryRecoveryStatusV1 } from "../../harness/hermes-021-v1";
import { HERMES_LOCAL_ADAPTER_V1 } from "../../harness/hermes-local-v1/task-planning-contract";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../../harness/claude-code-v1";
import { CODEX_APP_SERVER_ADAPTER } from "../../harness/codex-v1/delivery-contract";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../../harness/codex-v1/owner-trusted-local-task-planning-contract";
import { taskPlanningOptionsSchema, taskPlanningReceiptSchema } from "./task-planning-wire";
import { taskHomeActivitySchema } from "./task-home-wire";
import { taskProjectOverviewSchema } from "./task-project-overview-wire";
import { taskProjectFilesSchema } from "./task-project-files-wire";
import type { TaskWorktreeChangeSummary } from "./task-result-wire";
import { taskModelOptionsV1, validateRequestedTaskModelV1, type TaskModelCatalogV1 } from "./task-model-selection";
import { readSavedTaskPlansInSessionV1, readTaskRevisionLinksV1, savedTaskPlanProfileIdsV1,
  type SavedTaskPlanRowV1 } from "./task-execution-planner";
import { issueTaskFileAccessV1, verifyTaskFileAccessV1 } from "./task-file-access";
import { projectTaskDisplayStateV1 } from "./task-display-state";
import { deriveProjectEventIntegrityKeyV1, ProjectEventStoreV1, TaskProjectEventWriterV1 } from "../../project-events/v1";
import { costForUsageV1, rollupUsageGroupsV1, usageMeasurementSchemaV1, usagePriceTableSchemaV1,
  type UsagePriceTableV1, type UsageRollupV1 } from "../../usage/v1/usage-cost";
import type { HarnessRunEventV1, HarnessRunV1 } from "../../harness/v1/types";
import type { ProductConfigurationV1 } from "../../config/v1/product-configuration";

const iso = (value: string | Date) => new Date(value).toISOString();

/** Joins existing stores to the caller-owned session transaction. No nested BEGIN/COMMIT and no
 * new authority: this closure stays inside authenticated(). The outer freshness check owns commit. */
function joined(tx: DatabaseSession): DatabaseClient {
  return Object.freeze({ query: tx.query.bind(tx), transaction: async <T>(run: (session: DatabaseSession) => Promise<T>) => run(tx),
    transactionWithPreCommitCheck: async <T>(run: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) => {
      const result = await run(tx); await check(); return result;
    } });
}
function routeEvidence(adapterId: string): "local_hermes" | "local_claude" | "local_codex" | "other_or_unknown" {
  if (adapterId === HERMES_021_MACOS_LOCAL_ADAPTER_V1 || adapterId === HERMES_LOCAL_ADAPTER_V1) return "local_hermes";
  if (adapterId === CLAUDE_CODE_LOCAL_ADAPTER_V1) return "local_claude";
  if (adapterId === CODEX_APP_SERVER_ADAPTER || adapterId === CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1) return "local_codex";
  return "other_or_unknown";
}
type TaskRow = { id: string; state: string; version: number; project_id: string; workflow_id: string;
  job: unknown; workflow: unknown; request: unknown };
const selection = `j.id,j.state,j.version,j.project_id,j.workflow_id,j.payload AS job,w.payload AS workflow,r.payload AS request
  FROM control_jobs j JOIN control_workflows w ON w.tenant_id=j.tenant_id AND w.id=j.workflow_id AND w.project_id=j.project_id
  JOIN control_requests r ON r.tenant_id=w.tenant_id AND r.id=w.request_id AND r.project_id=j.project_id`;
function validated(row: TaskRow, tenantId: string, projectId: string) {
  const job = jobRecordSchema.parse(row.job), workflow = workflowRecordSchema.parse(row.workflow), request = requestRecordSchema.parse(row.request);
  if (job.tenantId !== tenantId || workflow.tenantId !== tenantId || request.tenantId !== tenantId
    || job.projectId !== projectId || request.projectId !== projectId || workflow.projectId !== projectId
    || job.id !== row.id || job.state !== row.state || job.version !== Number(row.version) || row.project_id !== projectId
    || job.workflowId !== row.workflow_id || workflow.id !== job.workflowId || request.id !== workflow.requestId
    || !workflow.jobIds.includes(job.id)) throw new Error("task_lineage_unavailable");
  if (job.jobType === "task.proposal" && job.inputDigest !== sha256Digest({ title: request.title, instructions: request.objective }))
    throw new Error("task_input_unavailable");
  const summary = taskSummarySchema.parse({ jobId: job.id, projectId, requestId: request.id, title: request.title,
    state: job.state, version: job.version, createdAt: job.createdAt, updatedAt: job.updatedAt });
  assertNoSecretMaterial({ summary, instructions: request.objective }, "task view");
  return { job, request, summary };
}

export interface WebTaskKeys {
  modelCatalog?: TaskModelCatalogV1;
  /** Owner-recorded billing facts. Absence is rendered as unknown, never estimated. */
  usagePriceTable?: UsagePriceTableV1;
  /** Read-only authentication key for task execution-plan lineage. */
  taskPlanIntegrityKey?: Uint8Array;
  harnessIntegrityKey?: Uint8Array;
  ideaIntegrityKey?: Uint8Array;
  /** Retained-news provenance key. Without it the news-to-task endpoint is unavailable. */
  newsIntegrityKey?: Uint8Array;
  /** Trusted optional-module configuration, captured at process startup. */
  productConfiguration?: Readonly<ProductConfigurationV1>;
  results?: NativeResultReadConfiguration;
  reviews?: { integrityKey: Uint8Array; checkpoints: AwaitableRollbackCheckpointStoreV1 };
  ownerReviews?: WebTaskReviewConfiguration;
  manualVerificationScenarios?: readonly ManualVerificationScenario[] | ManualVerificationScenarioSource;
  /** Installation-owned aggregate reader. The web layer cannot receive a raw
   * evidence table, receipt key, worktree plan, or filesystem path. */
  worktreeChangeEvidence?: { inspectMany(identities: readonly { tenantId: string; projectId: string; jobId: string;
    attemptId: string; runId: string; artifactId: string }[]):
    Promise<readonly (Readonly<{ changedFiles: number; changedBytes: number; addedFiles: number; modifiedFiles: number;
      deletedFiles: number; evidenceDigest: string }> | undefined)[]>;
    inspectOne?(identity: { tenantId: string; projectId: string; jobId: string; attemptId: string;
      runId: string; artifactId: string }): Promise<unknown | undefined> };
  /** Bound installation-owned read only. The web service never receives its
   * receipt key, storage port, runner, profile, model, or workspace settings. */
  hermesDeliveryRecovery?: { inspect(scope: { tenantId: string; projectId: string; jobId: string; attemptId: string }):
    Promise<Hermes021MacosDeliveryRecoveryStatusV1> };
}
const resultMetadata = (receipt: TaskResultReceiptV1) => taskResultMetadataSchema.parse({ artifactId: receipt.artifactId,
  attemptId: receipt.attemptId, runId: receipt.runId, contentHash: receipt.contentHash, sizeBytes: receipt.sizeBytes,
  receivedAt: receipt.receivedAt, byteCheck: receipt.byteCheck, qualityAccepted: false });

export class WebTaskService {
  private readonly authority: WebSessionAuthority;
  private readonly projects: WebProjectService;
  private readonly harnessKey?: Uint8Array;
  private readonly resultStore?: PlanSelectedTaskResultReaderV1;
  private readonly reviewConfig?: NonNullable<WebTaskKeys["reviews"]>;
  private readonly reviewCommandsConfigured: boolean;
  private readonly verificationCommandsConfigured: boolean;
  private readonly ideaProjectsConfigured: boolean;
  private readonly hermesDeliveryRecovery?: WebTaskKeys["hermesDeliveryRecovery"];
  private readonly worktreeChangeEvidence?: NonNullable<WebTaskKeys["worktreeChangeEvidence"]>;
  private readonly modelCatalog?: TaskModelCatalogV1;
  private readonly taskPlanIntegrityKey?: Uint8Array;
  private readonly usagePriceTable?: UsagePriceTableV1;
  private readonly fileAccessKey?: Uint8Array;
  private readonly projectEvents?: TaskProjectEventWriterV1;
  private readonly newsIntegrityKey?: Uint8Array;
  private readonly productConfiguration?: Readonly<ProductConfigurationV1>;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly clock: () => number = Date.now, keys?: WebTaskKeys) {
    this.authority = new WebSessionAuthority(db, scope, clock, "task");
    this.modelCatalog = keys?.modelCatalog;
    this.productConfiguration = keys?.productConfiguration;
    this.usagePriceTable = keys?.usagePriceTable ? usagePriceTableSchemaV1.parse(keys.usagePriceTable) : undefined;
    if (keys?.taskPlanIntegrityKey !== undefined) {
      if (!(keys.taskPlanIntegrityKey instanceof Uint8Array) || keys.taskPlanIntegrityKey.length !== 32)
        throw new Error("task_key_invalid");
      this.taskPlanIntegrityKey = Uint8Array.from(keys.taskPlanIntegrityKey);
    }
    this.ideaProjectsConfigured = !!keys?.ideaIntegrityKey;
    this.reviewCommandsConfigured = !!keys?.ownerReviews;
    this.verificationCommandsConfigured = !!keys?.manualVerificationScenarios;
    if (keys?.hermesDeliveryRecovery && typeof keys.hermesDeliveryRecovery.inspect !== "function") throw new Error("task_key_invalid");
    this.hermesDeliveryRecovery = keys?.hermesDeliveryRecovery ? Object.freeze({
      inspect: keys.hermesDeliveryRecovery.inspect.bind(keys.hermesDeliveryRecovery),
    }) : undefined;
    if (keys?.manualVerificationScenarios && (!keys.results || !keys.reviews || !keys.harnessIntegrityKey)) throw new Error("task_key_invalid");
    if (keys?.ownerReviews && (!keys.results || !keys.reviews || !(keys.ownerReviews.integrityKey instanceof Uint8Array)
      || keys.ownerReviews.integrityKey.length !== 32 || keys.reviews.integrityKey.length !== 32
      || keys.ownerReviews.integrityKey.some((byte, index) => byte !== keys.reviews!.integrityKey[index]))) throw new Error("task_key_invalid");
    this.projects = new WebProjectService(db, scope, clock, keys?.ideaIntegrityKey, undefined, this.productConfiguration);
    if (keys?.newsIntegrityKey !== undefined) {
      if (!(keys.newsIntegrityKey instanceof Uint8Array) || keys.newsIntegrityKey.length !== 32) throw new Error("task_key_invalid");
      this.newsIntegrityKey = Uint8Array.from(keys.newsIntegrityKey);
    }
    if (keys?.harnessIntegrityKey !== undefined) {
      if (!(keys.harnessIntegrityKey instanceof Uint8Array) || keys.harnessIntegrityKey.length !== 32) throw new Error("task_key_invalid");
      this.harnessKey = new Uint8Array(keys.harnessIntegrityKey);
      this.projectEvents = new TaskProjectEventWriterV1(new ProjectEventStoreV1(db,
        deriveProjectEventIntegrityKeyV1(this.harnessKey), () => new Date(this.clock()).toISOString()));
    }
    if (keys?.results) {
      if (!this.harnessKey) throw new Error("task_key_invalid");
      // The web service retains only the read capability, even when composition supplied a fuller store.
      this.resultStore = new PlanSelectedTaskResultReaderV1(db, { harnessIntegrityKey: this.harnessKey,
        results: keys.results, ...(keys.reviews ? { reviewIntegrityKey: keys.reviews.integrityKey } : {}) });
      this.fileAccessKey = Uint8Array.from(keys.results.integrityKey);
    }
    if (keys?.worktreeChangeEvidence) {
      if (typeof keys.worktreeChangeEvidence.inspectMany !== "function") throw new Error("task_key_invalid");
      this.worktreeChangeEvidence = Object.freeze({ inspectMany: keys.worktreeChangeEvidence.inspectMany.bind(keys.worktreeChangeEvidence),
        ...(keys.worktreeChangeEvidence.inspectOne
          ? { inspectOne: keys.worktreeChangeEvidence.inspectOne.bind(keys.worktreeChangeEvidence) } : {}) });
    }
    if (keys?.reviews) {
      if (!(keys.reviews.integrityKey instanceof Uint8Array) || keys.reviews.integrityKey.length !== 32) throw new Error("task_key_invalid");
      this.reviewConfig = { integrityKey: Uint8Array.from(keys.reviews.integrityKey), checkpoints: Object.freeze({
        read: keys.reviews.checkpoints.read.bind(keys.reviews.checkpoints), initialize: () => { throw new Error("review_read_only"); },
        advance: () => { throw new Error("review_read_only"); } }) };
    }
  }
  private async inspectHermesDeliveryRecovery(job: { jobType: string }, projectId: string, jobId: string,
    attempts: readonly { attemptId: string }[]): Promise<HermesDeliveryRecovery> {
    if (job.jobType !== HERMES_021_MACOS_LOCAL_JOB_TYPE_V1) return { source: "not_applicable" };
    if (!this.hermesDeliveryRecovery) return { source: "not_configured" };
    if (attempts.length !== 1) return { source: "ambiguous_attempt" };
    try {
      const status = await this.hermesDeliveryRecovery.inspect({ tenantId: this.scope.tenantId, projectId, jobId,
        attemptId: attempts[0]!.attemptId });
      return { source: "configured", status };
    } catch { return { source: "unavailable" }; }
  }
  private id(value: string) { if (!catalogProjectIdSchema.safeParse(value).success) throw new WebAccessError("invalid_request"); }
  private priceTableEvidence() { return this.usagePriceTable
    ? { state: "recorded" as const, tableId: this.usagePriceTable.tableId, recordedAt: this.usagePriceTable.recordedAt }
    : { state: "not_recorded" as const, tableId: null, recordedAt: null }; }
  private usageEvidence(run: HarnessRunV1, events: readonly HarnessRunEventV1[]) {
    const usageEvent = [...events].reverse().find(event => event.payload.category === "usage");
    const native = [...events].reverse().find(event => event.payload.category === "native_snapshot")?.payload;
    const nativeUsage = native?.category === "native_snapshot" ? native.snapshot.usage : null;
    const wallTimeMs = run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
    const usage = usageEvent?.payload.category === "usage"
      ? usageMeasurementSchemaV1.parse({ inputTokens: usageEvent.payload.inputTokens,
        outputTokens: usageEvent.payload.outputTokens, totalTokens: usageEvent.payload.totalTokens
          ?? (usageEvent.payload.inputTokens !== null && usageEvent.payload.outputTokens !== null
            ? usageEvent.payload.inputTokens + usageEvent.payload.outputTokens : null),
        cachedInputTokens: usageEvent.payload.cachedInputTokens, wallTimeMs: usageEvent.payload.wallTimeMs ?? wallTimeMs })
      : nativeUsage ? usageMeasurementSchemaV1.parse({ inputTokens: nativeUsage.inputTokens,
        outputTokens: nativeUsage.outputTokens, totalTokens: nativeUsage.totalTokens, wallTimeMs })
        : wallTimeMs === null ? null : usageMeasurementSchemaV1.parse({ inputTokens: null, outputTokens: null,
          totalTokens: null, wallTimeMs });
    return { usage, cost: costForUsageV1({ harness: run.harness, model: run.modelSelection?.model,
      usage, ...(this.usagePriceTable ? { priceTable: this.usagePriceTable } : {}) }) };
  }
  private authenticatedRead<T>(identity: VerifiedWebIdentity,
    operation: (tx: DatabaseSession, actor: WebActor) => Promise<T>) {
    return this.authority.authenticated(identity, operation, { readOnly: true });
  }

  async authorize(identity: VerifiedWebIdentity, projectId: string) {
    this.id(projectId);
    await this.authenticatedRead(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); await this.projects.getViewInSession(tx, actor, projectId);
    });
  }

  /** Availability is a current UI hint, not admission. The planner rechecks owner authority
   * and exact source/template inside its own transaction before creating anything. */
  async planningOptions(identity: VerifiedWebIdentity, projectId: string, jobId: string, configured: boolean) {
    this.id(projectId); this.id(jobId);
    return this.authenticatedRead(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      const row = (await tx.query<TaskRow>(`SELECT ${selection} WHERE j.tenant_id=$1 AND j.project_id=$2 AND j.id=$3`,
        [this.scope.tenantId, projectId, jobId])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      const { job } = validated(row, this.scope.tenantId, projectId);
      const eligible = actor.can("tasks.plan", projectId, true) && job.jobType === "task.proposal"
        && job.state === "proposed" && job.version === 0 && project.lifecycle === "active";
      return taskPlanningOptionsSchema.parse({ projectId, sourceJobId: jobId, inputDigest: job.inputDigest,
        availability: !eligible ? "not_eligible" : configured ? "available" : "not_configured", startsWork: false });
    });
  }

  async list(identity: VerifiedWebIdentity, projectId: string, after?: string) {
    this.id(projectId); if (after !== undefined) this.id(after);
    return this.authenticatedRead(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      const rows = (await tx.query<TaskRow>(`SELECT ${selection} WHERE j.tenant_id=$1 AND j.project_id=$2
        AND ($3::text IS NULL OR j.id COLLATE "C">$3 COLLATE "C") ORDER BY j.id COLLATE "C" LIMIT 51`,
      [this.scope.tenantId, projectId, after ?? null])).rows;
      const summaries = rows.slice(0, 50).map(row => validated(row, this.scope.tenantId, projectId).summary);
      const tasks = await this.withDisplayedStates(tx, actor, summaries);
      return taskPageSchema.parse({ project, tasks, nextCursor: rows.length > 50 ? tasks.at(-1)!.jobId : null,
        canPropose: project.lifecycle === "active" && actor.can("tasks.propose", projectId), dispatch: "not_connected", observedAt: actor.now,
        ...(this.modelCatalog ? { modelOptions: taskModelOptionsV1(this.modelCatalog) } : {}) });
    });
  }

  /** Source selection creates an ordinary proposed task, never execution permission.
   * Provenance describes owner-supplied evidence; hashes alone do not verify news. */
  async proposeNewsResearch(identity: VerifiedWebIdentity, projectId: string, value: unknown, key: string) {
    let proposal: ReturnType<typeof parseNewsWorkOrderProposalV1>;
    try { proposal = parseNewsWorkOrderProposalV1(value); }
    catch { throw new WebAccessError("invalid_request"); }
    if (proposal.tenantId !== this.scope.tenantId || proposal.workspaceId !== this.scope.workspaceId
      || proposal.projectId !== projectId) throw new WebAccessError("invalid_request");
    const newsIntegrityKey = this.newsIntegrityKey;
    if (!newsIntegrityKey) throw new WebAccessError("not_found");
    let draft: ReturnType<typeof newsResearchTaskDraft>;
    try { draft = newsResearchTaskDraft(proposal); } catch { throw new WebAccessError("invalid_request"); }
    return this.authority.authenticated(identity, async (tx, actor) => {
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (this.productConfiguration && !project.presentation?.availableModules.includes("news")) throw new WebAccessError("not_found");
      const result = await this.proposeWithDependenciesInSession(tx, actor, projectId, draft, key, []);
      try {
        await new PostgresNewsTaskProposalLinksV1(joined(tx), { ...this.scope, projectId }, newsIntegrityKey)
          .saveInSession(tx, result.receipt.jobId, proposal, actor.now);
      } catch (error) {
        if (error instanceof Error && error.message === "news_task_proposal_link_story_not_found") throw new WebAccessError("not_found");
        throw error;
      }
      return result;
    });
  }

  async propose(identity: VerifiedWebIdentity, projectId: string, value: unknown, key: string) {
    return this.proposeInternal(identity, projectId, value, key, []);
  }

  /** Internal integration seam for a reviewed feature that needs ordinary
   * proposed tasks to wait on already-existing ordinary tasks. This retains
   * the same owner authorization, request/workflow/job bundle, idempotency
   * ledger, and non-runnable materialization ceiling as `propose()`. */
  async proposeWithDependencies(identity: VerifiedWebIdentity, projectId: string, value: unknown, key: string,
    dependsOnJobIds: readonly string[]) {
    return this.proposeInternal(identity, projectId, value, key, dependsOnJobIds);
  }

  private async proposeInternal(identity: VerifiedWebIdentity, projectId: string, value: unknown, key: string,
    dependsOnJobIds: readonly string[]) {
    return this.authority.authenticated(identity, (tx, actor) =>
      this.proposeWithDependenciesInSession(tx, actor, projectId, value, key, dependsOnJobIds));
  }

  /** Server-only composition seam for a larger owner-authorized transaction.
   * It performs the same validation, authorization, idempotency, audit and
   * ordinary proposed-task materialization as proposeWithDependencies(), but
   * never opens or commits a nested transaction. */
  async proposeWithDependenciesInSession(tx: DatabaseSession, actor: WebActor, projectId: string,
    value: unknown, key: string, dependsOnJobIds: readonly string[]) {
    this.id(projectId);
    const parsed = taskDraftSchema.safeParse(value);
    const dependencies = [...dependsOnJobIds].sort();
    if (!parsed.success || !/^[A-Za-z0-9:_-]{12,180}$/.test(key)
      || dependencies.some(id => !catalogProjectIdSchema.safeParse(id).success)
      || new Set(dependencies).size !== dependencies.length) throw new WebAccessError("invalid_request");
    try {
      if (parsed.success && (parsed.data.model !== undefined || parsed.data.effort !== undefined)) {
        if (!this.modelCatalog) throw new Error();
        validateRequestedTaskModelV1(this.modelCatalog, { model: parsed.data.model, effort: parsed.data.effort });
      }
    } catch { throw new WebAccessError("invalid_request"); }
    try { assertNoSecretMaterial(parsed.data); } catch { throw new WebAccessError("invalid_request"); }
    // Preserve the prior idempotency digest byte-for-byte for ordinary browser
    // proposals. Only the narrow dependency integration adds this field.
    const digest = sha256Digest({ ...this.scope, projectId, action: "tasks.propose", draft: parsed.data,
      ...(dependencies.length ? { dependsOnJobIds: dependencies } : {}) });
    actor.require("tasks.read", projectId); actor.require("tasks.propose", projectId);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      const existing = (await tx.query<{ request_digest: string; project_id: string; job_id: string; result: unknown }>(
        `SELECT request_digest,project_id,job_id,result FROM control_web_task_commands
         WHERE tenant_id=$1 AND identity_id=$2 AND idempotency_key=$3`, [this.scope.tenantId, actor.id, key])).rows[0];
      if (existing) {
        if (existing.request_digest !== digest || existing.project_id !== projectId) throw new WebAccessError("conflict");
        const receipt = taskReceiptSchema.parse(existing.result);
        if (receipt.projectId !== projectId || receipt.jobId !== existing.job_id) throw new Error("task_receipt_unavailable");
        return { receipt, replayed: true };
      }
      if (project.lifecycle !== "active") throw new WebAccessError("conflict");
      for (const dependencyId of dependencies) {
        const dependency = (await tx.query<{ project_id: string; payload: unknown }>(
          "SELECT project_id,payload FROM control_jobs WHERE tenant_id=$1 AND id=$2 FOR SHARE",
          [this.scope.tenantId, dependencyId])).rows[0];
        if (!dependency || dependency.project_id !== projectId) throw new WebAccessError("conflict");
        const job = jobRecordSchema.safeParse(dependency.payload);
        if (!job.success || job.data.tenantId !== this.scope.tenantId || job.data.projectId !== projectId || job.data.id !== dependencyId) {
          throw new WebAccessError("conflict");
        }
      }
      const requestId = `request:${randomUUID()}`, workflowId = `workflow:${randomUUID()}`, jobId = `job:${randomUUID()}`;
      const base = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: this.scope.tenantId, version: 0, createdAt: actor.now, updatedAt: actor.now };
      const authority: AuthorityEnvelope = { projectId, allowedExecutor: "executor:unassigned", allowedOperations: ["task.propose"],
        credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "none",
        maxRisk: "low", maxDurationSeconds: 300, maxConcurrentEffects: 0,
        expiresAt: new Date(Date.parse(actor.now) + 300_000).toISOString(), digest: "" };
      authority.digest = computeAuthorityDigest(authority);
      const bundle: ProposedWorkBundle = {
        request: { ...base, id: requestId, kind: "request", projectId, title: parsed.data.title, objective: parsed.data.instructions,
          state: "draft", priority: 50, requestedBy: { actorId: actor.id, actorType: "human" },
          idempotencyKey: sha256Digest({ ...this.scope, actorId: actor.id, key, action: "tasks.propose" }) },
        workflow: { ...base, id: workflowId, kind: "workflow", requestId, projectId, definitionVersion: "private-task-proposal/v1",
          definitionDigest: sha256Digest({ type: "private-task-proposal/v1", projectId, draft: parsed.data, dependsOnJobIds: dependencies }),
          authorityMode: "control_room_native", state: "proposed", jobIds: [jobId] },
        job: { ...base, id: jobId, kind: "job", workflowId, projectId, jobType: "task.proposal", specVersion: "1.0.0",
          inputDigest: sha256Digest({ title: parsed.data.title, instructions: parsed.data.instructions }), state: "proposed", priority: 50, requiredCapability: "task.proposal.review",
          dependsOnJobIds: dependencies, authority, retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [],
            retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } },
      };
      await new CanonicalStore(joined(tx)).createProposedWorkBundle(bundle);
      await tx.query(`INSERT INTO control_task_model_selections
        (tenant_id,project_id,job_id,selection_key,effort,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [this.scope.tenantId, projectId, jobId, parsed.data.model ?? null, parsed.data.effort ?? null, actor.now]);
      // Omission is conservative: until an owner approves enforceable disjoint
      // write scopes, this task owns the whole repository while leased.
      const declaredScopes = parsed.data.scopes?.length ? parsed.data.scopes : [{ kind: "tree" as const, path: "" }];
      for (const scope of declaredScopes) await tx.query(`INSERT INTO control_task_declared_scopes
        (tenant_id,project_id,job_id,scope_kind,path,path_fold) VALUES($1,$2,$3,$4,$5,$5)`,
      [this.scope.tenantId, projectId, jobId, scope.kind, scope.path]);
      const receipt: TaskReceipt = { projectId, jobId, requestId, createdAt: actor.now, submission: "proposed", startsWork: false };
      await appendAuditWith(tx, { id: `audit:${randomUUID()}`, ...this.scope, projectId, actorId: actor.id, actorType: "human",
        action: "tasks.propose", targetType: "job", targetId: jobId, idempotencyKey: key, occurredAt: actor.now,
        safeMetadata: { inputDigest: bundle.job.inputDigest, state: "proposed" } });
      await tx.query(`INSERT INTO control_web_task_commands(tenant_id,identity_id,idempotency_key,project_id,job_id,request_digest,result,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [this.scope.tenantId, actor.id, key, projectId, jobId, digest, JSON.stringify(receipt), actor.now]);
      if (this.projectEvents) await this.projectEvents.appendInSession(tx, { ...this.scope, projectId, subjectId: jobId,
        action: "task_created", sourceId: jobId, sourceVersion: "task-created-v1", occurredAt: actor.now });
      return { receipt, replayed: false };
  }

  async detail(identity: VerifiedWebIdentity, projectId: string, jobId: string) {
    this.id(projectId); this.id(jobId);
    return this.authenticatedRead(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      const row = (await tx.query<TaskRow>(`SELECT ${selection} WHERE j.tenant_id=$1 AND j.project_id=$2 AND j.id=$3`,
        [this.scope.tenantId, projectId, jobId])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      const { job, request, summary } = validated(row, this.scope.tenantId, projectId);
      type DetailBindingRow = { model_job_id: string | null; worker_kind: string | null; selection_key: string | null;
        model: string | null; effort: string | null; provider: string | null; profile: string | null;
        inherited_from_job_id: string | null; node_id: string | null; expires_at: string | Date | null; state: string | null;
        scope_kind: "file" | "tree" | null; path: string | null };
      const bindingRows = (await tx.query<DetailBindingRow>(`SELECT m.job_id AS model_job_id,m.worker_kind,m.selection_key,
        m.model,m.effort,m.provider,m.profile,m.inherited_from_job_id,s.node_id,l.expires_at,l.state,s.scope_kind,s.path
        FROM (SELECT 1) anchor
        LEFT JOIN control_task_model_selections m ON m.tenant_id=$1 AND m.job_id=$2
        LEFT JOIN control_assignment_lease_scopes s ON s.tenant_id=$1 AND s.job_id=$2
        LEFT JOIN control_leases l ON l.tenant_id=s.tenant_id AND l.id=s.lease_id
        ORDER BY l.expires_at DESC,s.scope_kind,s.path`, [this.scope.tenantId, jobId])).rows;
      const modelRow = bindingRows[0]?.model_job_id ? bindingRows[0] : undefined;
      const leaseRows = bindingRows.filter((row): row is DetailBindingRow & { node_id: string; expires_at: string | Date;
        state: string; scope_kind: "file" | "tree"; path: string } => row.node_id !== null && row.expires_at !== null
          && row.state !== null && row.scope_kind !== null && row.path !== null);
      const leaseGroups = new Map<string, { nodeId: string; expiresAt: string; state: "active" | "released" | "expired" | "revoked";
        current: boolean; scopes: { kind: "file" | "tree"; path: string }[] }>();
      for (const lease of leaseRows) {
        const expiresAt = new Date(lease.expires_at).toISOString(), key = `${lease.node_id}\0${expiresAt}\0${lease.state}`;
        const state = lease.state as "active" | "released" | "expired" | "revoked";
        const group = leaseGroups.get(key) ?? { nodeId: lease.node_id, expiresAt, state,
          current: state === "active" && Date.parse(expiresAt) > Date.parse(actor.now), scopes: [] };
        group.scopes.push({ kind: lease.scope_kind, path: lease.path }); leaseGroups.set(key, group);
      }
      const attemptRows = (await tx.query<{ id: string; state: string; attempt_number: number; payload: unknown }>(
        `SELECT id,state,attempt_number,payload FROM control_attempts WHERE tenant_id=$1 AND job_id=$2 ORDER BY attempt_number DESC LIMIT 11`,
      [this.scope.tenantId, jobId])).rows;
      const store = this.harnessKey ? new HarnessRunStoreV1(joined(tx), this.harnessKey) : undefined;
      const boundedAttempts = attemptRows.slice(0, 10);
      // Two bounded reads, not one unbounded one. The rows the page displays come
      // from the per-attempt reader (11 per attempt = 10 shown + 1 to detect
      // `additionalRunsOmitted`), and the TOTALS come from a SQL aggregate over
      // every run in the job — so the cost is bounded by the page's display
      // bound and by the number of priceable shapes, never by run history.
      const inspectedRuns = store ? await store.inspectAttempts(this.scope.tenantId, projectId, jobId,
        boundedAttempts.map(attempt => attempt.id)) : new Map<string, readonly { run: HarnessRunV1;
          events: HarnessRunEventV1[] }[]>();
      // TWO aggregates, because they answer different questions about different
      // sets. The page's headline total covers EVERY run the job has ever
      // recorded, including the attempts it does not display, so it reads the
      // whole job and does not group by attempt. Each displayed attempt's own
      // rollup covers only that attempt, so it reads only the ten attempt ids the
      // page renders. Reading one set and splitting it in the application could
      // not give both: the per-attempt read would have to include every attempt
      // to make the headline total exact, and a group per attempt ever recorded
      // is a read that grows with retries.
      //
      // Both are still aggregates, so both are bounded by shapes rather than by
      // runs; the second is additionally bounded by the page's attempt display
      // bound, which is what makes it independent of the job's retry history.
      const attemptIds = boundedAttempts.map(attempt => attempt.id);
      const rollupGroups = store ? await store.inspectUsageRollup(this.scope.tenantId, projectId, jobId) : [];
      const price = this.usagePriceTable;
      const rollup = rollupUsageGroupsV1(rollupGroups, price);
      const attemptGroups = store
        ? await store.inspectUsageRollup(this.scope.tenantId, projectId, jobId, attemptIds) : [];
      const rollupByAttempt = new Map<string, UsageRollupV1>();
      for (const attempt of boundedAttempts)
        rollupByAttempt.set(attempt.id, rollupUsageGroupsV1(
          attemptGroups.filter(group => group.attemptId === attempt.id), price));
      const attempts = [];
      for (const a of boundedAttempts) {
        const attempt = attemptRecordSchema.parse(a.payload);
        if (attempt.tenantId !== this.scope.tenantId || attempt.jobId !== jobId || attempt.id !== a.id
          || attempt.state !== a.state || attempt.attemptNumber !== Number(a.attempt_number)) throw new Error("task_attempt_unavailable");
        const inspected = inspectedRuns.get(attempt.id) ?? [];
        const runs: TaskRun[] = [];
        for (const value of inspected.slice(0, 10)) {
          if (value.run.projectId !== projectId || value.run.jobId !== jobId
            || value.run.attemptId !== attempt.id || value.run.nodeId !== attempt.nodeId) throw new Error("task_run_unavailable");
          const { run, events } = value;
          const snapshots = events.flatMap(event => event.payload.category === "native_snapshot" ? [event.payload.snapshot] : []);
          const last = snapshots.at(-1);
          const evidence = this.usageEvidence(run, events);
          runs.push(taskRunSchema.parse({ runId: run.id, harness: run.harness, routeEvidence: routeEvidence(run.adapterId), state: run.state, lastObservedAt: run.lastObservedAt,
            ...(run.modelSelection ?? {}),
            stale: Date.parse(run.lastObservedAt) > Date.parse(actor.now) || Date.parse(actor.now) - Date.parse(run.lastObservedAt) > 120_000,
            firstObservedExecutionAt: run.startedAt ?? null, finishedObservedAt: run.finishedAt ?? null, cancellation: run.cancelState,
            source: run.nativeTask ? "native_snapshot" : "legacy", nativeState: last?.state ?? null,
            availability: run.nativeTask ? last?.availability ?? "unknown" : null,
            usage: evidence.usage, cost: evidence.cost,
            resultClaim: last?.result ? { ...last.result, verified: false } : null,
            timeline: snapshots.slice(-50).map(item => ({ version: item.snapshotVersion, state: item.state,
              observedAt: item.observedAt, availability: item.availability })), earlierObservationsOmitted: snapshots.length > 50 }));
        }
        attempts.push({ attemptId: attempt.id, attemptNumber: attempt.attemptNumber, state: attempt.state,
          runs, additionalRunsOmitted: inspected.length > 10,
          usageRollup: rollupByAttempt.get(attempt.id)! });
      }
      const hermesDeliveryRecovery = await this.inspectHermesDeliveryRecovery(job, projectId, jobId, attempts);
      const revisionLinks = this.taskPlanIntegrityKey
        ? await readTaskRevisionLinksV1(tx, this.taskPlanIntegrityKey, this.scope.tenantId, projectId, jobId)
        : { previousJobId: null, nextJobId: null, revisionNumber: 0 };
      const latestAttempt = attempts[0], latestRun = latestAttempt?.runs[0];
      return taskDetailSchema.parse({ project, task: await this.withDisplayedState(tx, actor, summary,
        latestAttempt && latestRun ? { attemptId: latestAttempt.attemptId, attemptState: latestAttempt.state,
          runId: latestRun.runId, runState: latestRun.state } : undefined),
        instructions: request.objective, inputDigest: job.inputDigest,
        modelSelection: modelRow ? { workerKind: modelRow.worker_kind, selectionKey: modelRow.selection_key,
          model: modelRow.model, effort: modelRow.effort, provider: modelRow.provider, profile: modelRow.profile,
          inheritedFromJobId: modelRow.inherited_from_job_id } : null,
        ownershipLeases: [...leaseGroups.values()],
        observedAt: actor.now, attempts, usageRollup: rollup, priceTable: this.priceTableEvidence(),
        earlierAttemptsOmitted: attemptRows.length > 10, preparedFor: null,
        localRouteObservation: { state: "not_prepared", adapter: null },
        hermesDeliveryRecovery,
        revisionLinks,
        progressSource: store ? "configured" : "not_configured", dispatch: "not_connected",
        artifacts: this.resultStore ? "configured" : "not_connected", review: this.reviewConfig ? "recorded" : "not_connected" });
    });
  }

  /** Trusted server composition, never a browser-supplied callback. */
  async readScopedResult<T>(identity: VerifiedWebIdentity, projectId: string, jobId: string,
    read: (scope: { tenantId: string; projectId: string; jobId: string }) => Promise<T>) {
    this.id(projectId); this.id(jobId);
    return this.authenticatedRead(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.results.read", projectId);
      await this.projects.getViewInSession(tx, actor, projectId);
      const row = (await tx.query<TaskRow>(`SELECT ${selection} WHERE j.tenant_id=$1 AND j.project_id=$2 AND j.id=$3`,
        [this.scope.tenantId, projectId, jobId])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      validated(row, this.scope.tenantId, projectId);
      return read({ tenantId: this.scope.tenantId, projectId, jobId });
    });
  }

  async results(identity: VerifiedWebIdentity, projectId: string, jobId: string, artifactId?: string) {
    this.id(projectId); this.id(jobId); if (artifactId !== undefined) this.id(artifactId);
    return this.authenticatedRead(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); await this.projects.getViewInSession(tx, actor, projectId);
      const row = (await tx.query<TaskRow>(`SELECT ${selection} WHERE j.tenant_id=$1 AND j.project_id=$2 AND j.id=$3`,
        [this.scope.tenantId, projectId, jobId])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      const task = validated(row, this.scope.tenantId, projectId);
      if (artifactId !== undefined) {
        actor.require("tasks.results.read", projectId);
        if (!this.resultStore) throw new Error("task_results_not_configured");
        const content = await this.resultStore.read(tx, this.scope.tenantId, projectId, jobId, artifactId);
        if (!content) throw new WebAccessError("not_found");
        // Full patches are restricted to the human who requested the task.
        // Other project owners may retain ordinary result access, but cannot
        // use that broader grant to inspect this coding workspace evidence.
        const worktreeChangeEvidence = actor.id === task.request.requestedBy.actorId && this.worktreeChangeEvidence?.inspectOne
          ? await this.worktreeChangeEvidence.inspectOne({ tenantId: this.scope.tenantId, projectId, jobId,
            attemptId: content.receipt.attemptId, runId: content.receipt.runId, artifactId }) : undefined;
        return taskResultContentSchema.parse({ projectId, jobId, artifact: resultMetadata(content.receipt), text: content.text,
          ...(worktreeChangeEvidence ? { worktreeChangeEvidence } : {}),
          contentVerifiedAt: new Date(this.clock()).toISOString(), untrustedContent: true });
      }
      return this.resultPage(tx, actor, projectId, jobId);
    });
  }

  private fileAccess(projectId: string, jobId: string, receipt: TaskResultReceiptV1) {
    if (!this.fileAccessKey) return undefined;
    const now = this.clock(), scope = { projectId, jobId, runId: receipt.runId, artifactId: receipt.artifactId,
      contentHash: receipt.contentHash, sizeBytes: receipt.sizeBytes };
    const preview = issueTaskFileAccessV1(this.fileAccessKey, { ...scope, disposition: "preview" }, now);
    const download = issueTaskFileAccessV1(this.fileAccessKey, { ...scope, disposition: "download" }, now);
    const base = `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/files/${encodeURIComponent(receipt.artifactId)}`;
    return { previewHref: `${base}?disposition=preview&token=${encodeURIComponent(preview.token)}`,
      downloadHref: `${base}?disposition=download&token=${encodeURIComponent(download.token)}`, expiresAt: preview.expiresAt };
  }

  async file(identity: VerifiedWebIdentity, projectId: string, jobId: string, artifactId: string,
    disposition: "preview" | "download", token: string) {
    this.id(projectId); this.id(jobId); this.id(artifactId);
    return this.authenticatedRead(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.results.read", projectId);
      await this.projects.getViewInSession(tx, actor, projectId);
      if (!this.resultStore || !this.fileAccessKey) throw new WebAccessError("not_found");
      let claims: ReturnType<typeof verifyTaskFileAccessV1>;
      try { claims = verifyTaskFileAccessV1(this.fileAccessKey, token, { projectId, jobId, artifactId, disposition }, this.clock()); }
      catch { throw new WebAccessError("access_denied"); }
      const content = await this.resultStore.read(tx, this.scope.tenantId, projectId, jobId, artifactId);
      if (!content || content.receipt.runId !== claims.runId || content.receipt.contentHash !== claims.contentHash
        || content.receipt.sizeBytes !== claims.sizeBytes || new TextEncoder().encode(content.text).byteLength > 65_536)
        throw new WebAccessError("not_found");
      return Object.freeze({ text: content.text, receipt: content.receipt, disposition });
    });
  }

  private async resultPage(tx: DatabaseSession, actor: WebActor, projectId: string, jobId: string) {
      const result = this.resultStore ? await this.resultStore.list(tx, this.scope.tenantId, projectId, jobId)
        : { receipts: [], additionalResultsOmitted: false };
      const runEvidence = this.harnessKey
        ? await new HarnessRunStoreV1(joined(tx), this.harnessKey).inspectMany(this.scope.tenantId,
          result.receipts.map(receipt => receipt.runId))
        : new Map();
      const evidenceScopes = actor.can("tasks.results.read", projectId) && this.worktreeChangeEvidence
        ? result.receipts.filter(receipt => receipt.artifactId.startsWith("artifact:result:")).map(receipt => ({
          tenantId: this.scope.tenantId, projectId, jobId, attemptId: receipt.attemptId,
          runId: receipt.runId, artifactId: receipt.artifactId,
        })) : [];
      let evidenceByArtifact = new Map<string, Awaited<ReturnType<NonNullable<WebTaskKeys["worktreeChangeEvidence"]>["inspectMany"]>>[number]>();
      if (evidenceScopes.length && this.worktreeChangeEvidence) {
        try {
          const summaries = await this.worktreeChangeEvidence.inspectMany(evidenceScopes);
          if (summaries.length !== evidenceScopes.length) throw new Error("worktree_change_evidence_unavailable");
          evidenceByArtifact = new Map(evidenceScopes.map((scope, index) => [scope.artifactId, summaries[index]]));
        } catch { evidenceByArtifact = new Map(); }
      }
      const items = await Promise.all(result.receipts.map(async receipt => {
        const inspectedRun = runEvidence.get(receipt.runId)?.run;
        if (inspectedRun && (inspectedRun.projectId !== projectId || inspectedRun.jobId !== jobId
          || inspectedRun.attemptId !== receipt.attemptId)) throw new Error("task_result_model_unavailable");
        let worktreeChangeSummary: TaskWorktreeChangeSummary;
        if (!actor.can("tasks.results.read", projectId)) worktreeChangeSummary = { source: "not_authorized" };
        else if (!this.worktreeChangeEvidence) worktreeChangeSummary = { source: "not_configured" };
        else if (!receipt.artifactId.startsWith("artifact:result:")) worktreeChangeSummary = { source: "not_applicable" };
        else {
          const summary = evidenceByArtifact.get(receipt.artifactId);
          worktreeChangeSummary = summary ? { source: "recorded", changedFiles: summary.changedFiles,
            changedBytes: summary.changedBytes, addedFiles: summary.addedFiles, modifiedFiles: summary.modifiedFiles,
            deletedFiles: summary.deletedFiles, evidenceDigest: summary.evidenceDigest, startsWork: false,
            grantsExecutionAuthority: false, permitsRetry: false, permitsResume: false, permitsApproval: false,
            permitsMerge: false } : { source: "unavailable" };
        }
        return taskResultMetadataSchema.parse({ ...resultMetadata(receipt),
          ...(inspectedRun?.modelSelection ? { modelSelection: inspectedRun.modelSelection } : {}),
          fileAccess: this.fileAccess(projectId, jobId, receipt), worktreeChangeSummary });
      }));
      const lineage = this.reviewConfig ? await readTaskReviewPlanV1(tx, this.reviewConfig.integrityKey,
        this.scope.tenantId, projectId, jobId) : undefined;
      const subjectId = taskReviewRootSubjectIdV1(lineage, jobId);
      const review = this.reviewConfig ? await new CompletionGateStoreV1(joined(tx), this.reviewConfig.integrityKey,
        this.reviewConfig.checkpoints).inspectSubject(this.scope.tenantId, projectId, subjectId) : { targets: [], additionalTargetsOmitted: false };
      const reviews = review.targets.map(({ snapshot, reviews, verifications, findings, additionalEvidenceOmitted }) => taskReviewEvidenceSchema.parse({
        targetId: snapshot.target.id, kind: snapshot.target.kind, targetDigest: snapshot.targetDigest,
        contentHash: snapshot.target.subjectDigest, revision: snapshot.revisionNumber, supersedesTargetId: snapshot.target.supersedesTargetId ?? null,
        status: snapshot.status, matchingArtifactIds: snapshot.target.kind === "document" ? result.receipts.filter(receipt => {
          if (receipt.contentHash !== snapshot.target.subjectDigest) return false;
          try { verifyTaskReviewTargetV1(lineage, snapshot.target, receipt); return true; } catch { return false; }
        }).map(receipt => receipt.artifactId) : [], additionalEvidenceOmitted,
        reviews: reviews.map(value => ({ id: value.id, decision: value.decision, authority: value.authority, reviewedAt: value.reviewedAt })),
        verifications: verifications.map(value => ({ id: value.id, scenarioId: value.scenarioId, outcome: value.outcome, verifiedAt: value.verifiedAt })),
        findings: findings.map(value => ({ id: value.id, code: value.code, severity: value.severity, statementDigest: value.statementDigest, raisedAt: value.raisedAt })),
        missingVerificationScenarioIds: snapshot.missingVerificationScenarioIds, openFindingCount: snapshot.openFindingIds.length,
        grantsApproval: false, grantsExecutionAuthority: false }));
      return boundedTaskResultsPage({ projectId, jobId, observedAt: actor.now,
        resultSource: this.resultStore ? "configured" : "not_configured", reviewSource: this.reviewConfig ? "configured" : "not_configured",
        items, reviews, additionalResultsOmitted: result.additionalResultsOmitted, additionalTargetsOmitted: review.additionalTargetsOmitted,
        canReadContent: !!this.resultStore && actor.can("tasks.results.read", projectId),
        reviewCommands: this.reviewCommandsConfigured ? "configured" : "not_connected",
        verificationCommands: this.verificationCommandsConfigured ? "configured" : "not_connected" });
  }

  /** "Accepted" is derived only from authenticated completion-gate evidence.
   * Execution success alone remains "Completed". Omitted result or review rows
   * fail closed so a partial projection can never overstate acceptance. */
  private async withDisplayedState(tx: DatabaseSession, actor: WebActor, summary: TaskSummary,
    knownLatestAttemptOutcome?: { attemptId: string; attemptState: string; runId: string; runState: string }): Promise<TaskSummary> {
    if (!["leased", "running", "waiting_approval", "succeeded"].includes(summary.state) || !this.resultStore
      || !actor.can("tasks.results.read", summary.projectId)) return summary;
    try {
      const evidence = await this.batchResultEvidence(tx, actor, [summary]);
      const page = evidence.get(taskReviewPlanKeyV1(summary.projectId, summary.jobId));
      if (!page) return summary;
      return projectTaskDisplayStateV1(summary, { latestAttemptOutcome: knownLatestAttemptOutcome ?? page.latestAttemptOutcome,
        results: page.items, reviews: page.reviews, additionalResultsOmitted: page.additionalResultsOmitted,
        additionalTargetsOmitted: page.additionalTargetsOmitted });
    } catch {
      // Display completion and acceptance are optional enrichment. Failure to
      // authenticate either retains the canonical task state.
      return summary;
    }
  }

  /** Lightweight result/review projection for bounded task summaries. Unlike
   * resultPage it deliberately does not mint file links, inspect worktrees, or
   * load harness model metadata. */
  private async batchResultEvidence(tx: DatabaseSession, actor: WebActor,
    tasks: readonly { projectId: string; jobId: string }[], savedProfiles?: { ids: readonly string[]; records?: ReadonlyMap<string, unknown> }) {
    type Projection = { resultSource: "configured" | "not_configured"; reviewSource: "configured" | "not_configured";
      items: ReturnType<typeof resultMetadata>[]; reviews: ReturnType<typeof taskReviewEvidenceSchema.parse>[];
      additionalResultsOmitted: boolean; additionalTargetsOmitted: boolean; canReadContent: boolean;
      latestAttemptOutcome?: { attemptId: string; attemptState: string; runId: string; runState: string } };
    const unique = [...new Map(tasks.map(task => [taskReviewPlanKeyV1(task.projectId, task.jobId), task])).values()];
    const output = new Map<string, Projection>();
    if (!unique.length && !savedProfiles?.ids.length) return output;
    if (!this.resultStore) {
      for (const task of unique) output.set(taskReviewPlanKeyV1(task.projectId, task.jobId), { resultSource: "not_configured",
        reviewSource: this.reviewConfig ? "configured" : "not_configured", items: [], reviews: [],
        additionalResultsOmitted: false, additionalTargetsOmitted: false, canReadContent: false });
      if (savedProfiles && this.reviewConfig) savedProfiles.records = await new CompletionGateStoreV1(joined(tx),
        this.reviewConfig.integrityKey, this.reviewConfig.checkpoints).getRecords(this.scope.tenantId, savedProfiles.ids, "profile");
      return output;
    }
    const batch = await this.resultStore.listMany(tx, this.scope.tenantId, unique);
    const subjects = unique.map(task => ({ projectId: task.projectId,
      subjectId: taskReviewRootSubjectIdV1(batch.plans.get(taskReviewPlanKeyV1(task.projectId, task.jobId)), task.jobId) }));
    let inspected = new Map();
    if (this.reviewConfig) {
      const gate = new CompletionGateStoreV1(joined(tx), this.reviewConfig.integrityKey, this.reviewConfig.checkpoints);
      if (savedProfiles) {
        const combined = await gate.inspectSubjectsAndRecords(this.scope.tenantId, subjects, savedProfiles.ids, "profile");
        inspected = combined.subjects; savedProfiles.records = combined.records;
      } else inspected = await gate.inspectSubjects(this.scope.tenantId, subjects);
    }
    for (const task of unique) {
      const key = taskReviewPlanKeyV1(task.projectId, task.jobId), page = batch.pages.get(key);
      if (!page) throw new Error("task_result_model_unavailable");
      const lineage = batch.plans.get(key), subjectId = taskReviewRootSubjectIdV1(lineage, task.jobId);
      const review = (this.reviewConfig
        ? inspected.get(JSON.stringify([task.projectId, subjectId])) ?? { targets: [], additionalTargetsOmitted: false }
        : { targets: [], additionalTargetsOmitted: false }) as Awaited<ReturnType<CompletionGateStoreV1["inspectSubject"]>>;
      const reviews = review.targets.map(({ snapshot, reviews, verifications, findings, additionalEvidenceOmitted }) => taskReviewEvidenceSchema.parse({
        targetId: snapshot.target.id, kind: snapshot.target.kind, targetDigest: snapshot.targetDigest,
        contentHash: snapshot.target.subjectDigest, revision: snapshot.revisionNumber,
        supersedesTargetId: snapshot.target.supersedesTargetId ?? null, status: snapshot.status,
        matchingArtifactIds: snapshot.target.kind === "document" ? page.receipts.filter(receipt => {
          if (receipt.contentHash !== snapshot.target.subjectDigest) return false;
          try { verifyTaskReviewTargetV1(lineage, snapshot.target, receipt); return true; } catch { return false; }
        }).map(receipt => receipt.artifactId) : [], additionalEvidenceOmitted,
        reviews: reviews.map(value => ({ id: value.id, decision: value.decision, authority: value.authority, reviewedAt: value.reviewedAt })),
        verifications: verifications.map(value => ({ id: value.id, scenarioId: value.scenarioId, outcome: value.outcome, verifiedAt: value.verifiedAt })),
        findings: findings.map(value => ({ id: value.id, code: value.code, severity: value.severity,
          statementDigest: value.statementDigest, raisedAt: value.raisedAt })),
        missingVerificationScenarioIds: snapshot.missingVerificationScenarioIds, openFindingCount: snapshot.openFindingIds.length,
        grantsApproval: false, grantsExecutionAuthority: false }));
      output.set(key, { resultSource: "configured", reviewSource: this.reviewConfig ? "configured" : "not_configured",
        items: page.receipts.map(resultMetadata), reviews, additionalResultsOmitted: page.additionalResultsOmitted,
        additionalTargetsOmitted: review.additionalTargetsOmitted, canReadContent: actor.can("tasks.results.read", task.projectId),
        ...(batch.latestAttemptOutcomes.get(key) ? { latestAttemptOutcome: batch.latestAttemptOutcomes.get(key)! } : {}) });
    }
    return output;
  }

  private async withDisplayedStates(tx: DatabaseSession, actor: WebActor, summaries: readonly TaskSummary[]): Promise<TaskSummary[]> {
    const eligible = summaries.filter(summary => ["leased", "running", "waiting_approval", "succeeded"].includes(summary.state)
      && this.resultStore
      && actor.can("tasks.results.read", summary.projectId));
    if (!eligible.length) return [...summaries];
    let evidence: Awaited<ReturnType<WebTaskService["batchResultEvidence"]>>;
    try { evidence = await this.batchResultEvidence(tx, actor, eligible); }
    catch { return [...summaries]; }
    return this.applyDisplayEvidence(summaries, evidence);
  }

  private applyDisplayEvidence(summaries: readonly TaskSummary[],
    evidence: Awaited<ReturnType<WebTaskService["batchResultEvidence"]>>): TaskSummary[] {
    return summaries.map(summary => {
      const page = evidence.get(taskReviewPlanKeyV1(summary.projectId, summary.jobId));
      if (!page) return summary;
      return projectTaskDisplayStateV1(summary, { latestAttemptOutcome: page.latestAttemptOutcome,
        results: page.items, reviews: page.reviews, additionalResultsOmitted: page.additionalResultsOmitted,
        additionalTargetsOmitted: page.additionalTargetsOmitted });
    });
  }

  private resultAttentionFromEvidence(result: Awaited<ReturnType<WebTaskService["batchResultEvidence"]>> extends Map<string, infer P> ? P : never) {
    const reasons: TaskAttentionPage["items"][number]["reasons"] = [], resultArtifactIds: string[] = [];
    if (result.resultSource === "not_configured" || result.reviewSource === "not_configured")
      return { reasons: ["result_checks_unavailable"] as TaskAttentionPage["items"][number]["reasons"], resultArtifactIds };
    for (const review of result.reviews.filter(value => value.matchingArtifactIds.length > 0)) {
      switch (review.status) {
        case "pending": reasons.push("review"); break;
        case "changes_requested": case "verification_blocked": case "revision_limit_reached": reasons.push(review.status); break;
      }
      if (["pending", "changes_requested", "verification_blocked", "revision_limit_reached"].includes(review.status))
        resultArtifactIds.push(...review.matchingArtifactIds);
    }
    if (result.additionalResultsOmitted || result.additionalTargetsOmitted
      || result.reviews.some(value => value.additionalEvidenceOmitted)
      || result.items.some(item => !result.reviews.some(review => review.matchingArtifactIds.includes(item.artifactId))))
      reasons.push("result_checks_unavailable");
    return { reasons: [...new Set(reasons)], resultArtifactIds: result.canReadContent ? [...new Set(resultArtifactIds)].sort() : [] };
  }

  /** One result/review inspection powers both the workspace-wide attention list and
   * project pages. It only returns opaque identifiers already accepted by the signed
   * result reader; it does not grant result reading, approval, revision, or execution. */
  private async resultAttention(tx: DatabaseSession, actor: WebActor, row: TaskRow & { has_artifacts: boolean }) {
    const reasons: TaskAttentionPage["items"][number]["reasons"] = [];
    const resultArtifactIds: string[] = [];
    if (!row.has_artifacts) return { reasons, resultArtifactIds };
    const result = await this.resultPage(tx, actor, row.project_id, row.id);
    if (result.resultSource === "not_configured" || result.reviewSource === "not_configured") {
      reasons.push("result_checks_unavailable");
      return { reasons, resultArtifactIds };
    }
    for (const review of result.reviews.filter(value => value.matchingArtifactIds.length > 0)) {
      switch (review.status) {
        case "pending": reasons.push("review"); break;
        case "changes_requested": case "verification_blocked": case "revision_limit_reached":
          reasons.push(review.status); break;
      }
      if (["pending", "changes_requested", "verification_blocked", "revision_limit_reached"].includes(review.status))
        resultArtifactIds.push(...review.matchingArtifactIds);
    }
    if (result.additionalResultsOmitted || result.additionalTargetsOmitted
      || result.reviews.some(value => value.additionalEvidenceOmitted)
      || result.items.some(item => !result.reviews.some(review => review.matchingArtifactIds.includes(item.artifactId))))
      reasons.push("result_checks_unavailable");
    return { reasons: [...new Set(reasons)],
      resultArtifactIds: result.canReadContent ? [...new Set(resultArtifactIds)].sort() : [] };
  }

  private attentionSources(actor: WebActor): TaskAttentionPage["sources"] {
      actor.require("tasks.read", undefined, true);
      const ordinary = actor.can("projects.read", undefined, true);
      const ideas = actor.can("idea_lab.project_read", undefined, true);
      if (!ordinary && !ideas) throw new WebAccessError("access_denied");
      if (ordinary) actor.require("projects.read", undefined, true);
      if (ideas && this.ideaProjectsConfigured) actor.require("idea_lab.project_read", undefined, true);
      return { ordinary: ordinary ? "included" : "not_authorized",
        ideas: !ideas ? "not_authorized" : this.ideaProjectsConfigured ? "included" : "not_configured" };
  }

  /** The empty shared shell is useful with either recovery or task-inbox access.
   * Each panel's data endpoint retains its own independent permission checks. */
  async authorizeAttentionPage(identity: VerifiedWebIdentity): Promise<void> {
    await this.authenticatedRead(identity, async (_, actor) => {
      if (actor.can("connections.read", undefined, true)) actor.require("connections.read", undefined, true);
      else this.attentionSources(actor);
    });
  }

  /** Canonical cross-project action records remain owner-only even though the
   * shared page shell can also host narrower recovery and idea-task panels. */
  async authorizeActionInbox(identity: VerifiedWebIdentity): Promise<{ actorId: string; grantedAt: string }> {
    return this.authenticatedRead(identity, async (_, actor) => {
      actor.require("projects.read", undefined, true);
      return { actorId: actor.id, grantedAt: actor.now };
    });
  }

  async attention(identity: VerifiedWebIdentity, after?: string) {
    if (after !== undefined) this.id(after);
    return this.authenticatedRead(identity, async (tx, actor) => {
      const sources = this.attentionSources(actor);
      type AttentionRow = TaskRow & { has_artifacts: boolean; source_job_created_at: string | Date;
        source_job_updated_at: string | Date; plan_tenant_id: string | null; plan_project_id: string | null;
        plan_source_job_id: string | null; plan_job_id: string | null; plan_payload: unknown; plan_auth_tag: string | null;
        prepared_job_payload: unknown; prepared_job_state: string | null; prepared_job_version: number | null;
        prepared_job_workflow_id: string | null; prepared_job_created_at: string | Date | null;
        prepared_job_updated_at: string | Date | null; prepared_workflow_payload: unknown; prepared_request_payload: unknown };
      const rows = (await tx.query<AttentionRow>(`SELECT EXISTS(
        SELECT 1 FROM control_native_artifact_receipts a WHERE a.tenant_id=j.tenant_id AND a.project_id=j.project_id AND a.job_id=j.id) AS has_artifacts,
        j.created_at AS source_job_created_at,j.updated_at AS source_job_updated_at,
        ep.tenant_id AS plan_tenant_id,ep.project_id AS plan_project_id,ep.source_job_id AS plan_source_job_id,
        ep.job_id AS plan_job_id,ep.plan AS plan_payload,ep.auth_tag AS plan_auth_tag,
        pj.payload AS prepared_job_payload,pj.state AS prepared_job_state,pj.version AS prepared_job_version,
        pj.workflow_id AS prepared_job_workflow_id,pj.created_at AS prepared_job_created_at,pj.updated_at AS prepared_job_updated_at,
        pw.payload AS prepared_workflow_payload,pr.payload AS prepared_request_payload, ${selection}
        LEFT JOIN control_task_execution_plans ep ON ep.tenant_id=j.tenant_id AND ep.project_id=j.project_id AND ep.source_job_id=j.id
        LEFT JOIN control_jobs pj ON pj.tenant_id=ep.tenant_id AND pj.project_id=ep.project_id AND pj.id=ep.job_id
        LEFT JOIN control_workflows pw ON pw.tenant_id=pj.tenant_id AND pw.id=pj.workflow_id
        LEFT JOIN control_requests pr ON pr.tenant_id=pw.tenant_id AND pr.id=pw.request_id
        JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id
        WHERE j.tenant_id=$1 AND p.workspace_id=$2 AND ($3::text IS NULL OR j.id COLLATE "C">$3 COLLATE "C")
          AND ((p.adapter_id=$4 AND $6::boolean AND EXISTS(SELECT 1 FROM control_manual_project_heads h
            WHERE h.tenant_id=p.tenant_id AND h.project_id=p.id)) OR (p.adapter_id=$5 AND $7::boolean))
          AND (j.state IN ('proposed','waiting_approval','failed','orphaned')
            OR (j.payload->>'jobType'='harness.hermes.native.task' AND j.state IN ('leased','running')) OR EXISTS(
            SELECT 1 FROM control_native_artifact_receipts a WHERE a.tenant_id=j.tenant_id AND a.project_id=j.project_id AND a.job_id=j.id))
        ORDER BY j.id COLLATE "C" LIMIT 26`, [this.scope.tenantId, this.scope.workspaceId, after ?? null,
        `adapter:manual:${sha256Digest(this.scope).slice(7, 39)}`, CONTROL_ROOM_IDEA_ADAPTER_V1, sources.ordinary === "included", sources.ideas === "included"])).rows;
      await this.projects.getViewsInSession(tx, actor, rows.slice(0, 25).map(row => row.project_id));
      for (const row of rows.slice(0, 25)) actor.require("tasks.read", row.project_id, true);
      const pageRows = rows.slice(0, 25).map(row => ({ row, ...validated(row, this.scope.tenantId, row.project_id) }));
      const planningConfigured = !!this.taskPlanIntegrityKey && !!this.reviewConfig;
      const planCandidates = pageRows.filter(({ summary, job }) => summary.state === "proposed" && job.jobType === "task.proposal")
        .map(({ row }) => ({ projectId: row.project_id, sourceJobId: row.id }));
      const planCandidateKeys = new Set(planCandidates.map(candidate => JSON.stringify([candidate.projectId, candidate.sourceJobId])));
      const preloadedPlans: SavedTaskPlanRowV1[] = pageRows.filter(({ row }) => row.plan_tenant_id !== null
        && planCandidateKeys.has(JSON.stringify([row.project_id, row.id]))).map(({ row }) => ({
        tenant_id: row.plan_tenant_id!, project_id: row.plan_project_id!, source_job_id: row.plan_source_job_id!,
        job_id: row.plan_job_id!, plan: row.plan_payload, auth_tag: row.plan_auth_tag!, source_job_payload: row.job,
        source_job_state: row.state, source_job_version: row.version, source_job_workflow_id: row.workflow_id,
        source_job_created_at: row.source_job_created_at, source_job_updated_at: row.source_job_updated_at,
        source_workflow_payload: row.workflow, source_request_payload: row.request,
        prepared_job_payload: row.prepared_job_payload, prepared_job_state: row.prepared_job_state!,
        prepared_job_version: row.prepared_job_version!, prepared_job_workflow_id: row.prepared_job_workflow_id!,
        prepared_job_created_at: row.prepared_job_created_at!, prepared_job_updated_at: row.prepared_job_updated_at!,
        prepared_workflow_payload: row.prepared_workflow_payload, prepared_request_payload: row.prepared_request_payload,
      }));
      const savedProfileIds = planningConfigured ? savedTaskPlanProfileIdsV1({ tenantId: this.scope.tenantId,
        planIntegrityKey: this.taskPlanIntegrityKey! }, preloadedPlans) : [];
      const savedProfiles = planningConfigured && savedProfileIds.length
        ? { ids: savedProfileIds, records: undefined as ReadonlyMap<string, unknown> | undefined }
        : undefined;
      const evidence = await this.batchResultEvidence(tx, actor, pageRows.filter(({ row }) => row.has_artifacts)
        .map(({ row }) => ({ projectId: row.project_id, jobId: row.id })), savedProfiles);
      const savedPlans = planningConfigured ? await readSavedTaskPlansInSessionV1(tx, {
        tenantId: this.scope.tenantId, planIntegrityKey: this.taskPlanIntegrityKey!,
        reviewIntegrityKey: this.reviewConfig!.integrityKey, checkpoints: this.reviewConfig!.checkpoints,
        preloadedRows: preloadedPlans, authenticatedProfiles: savedProfiles?.records,
      }, planCandidates) : new Map<string, null>();
      const plannedSources = new Set<string>();
      for (const candidate of planCandidates) {
        const key = JSON.stringify([candidate.projectId, candidate.sourceJobId]), value = savedPlans.get(key);
        if (!value) continue;
        const receipt = taskPlanningReceiptSchema.parse(value);
        if (receipt.projectId !== candidate.projectId || receipt.sourceJobId !== candidate.sourceJobId
          || receipt.jobId === candidate.sourceJobId) throw new Error("planning_receipt_scope_mismatch");
        plannedSources.add(key);
      }
      const items: TaskAttentionPage["items"] = [];
      for (const { row, summary, job } of pageRows) {
        const reasons: TaskAttentionPage["items"][number]["reasons"] = [];
        if (summary.state === "proposed" && !(job.jobType === "task.proposal"
          && plannedSources.has(JSON.stringify([row.project_id, row.id]))))
          reasons.push(job.jobType === "task.proposal" ? "proposal" : "assignment");
        if (summary.state === "waiting_approval") reasons.push("approval");
        if (summary.state === "failed" || summary.state === "orphaned") reasons.push(summary.state);
        if (job.jobType === "harness.hermes.native.task" && ["leased", "running", "waiting_approval", "orphaned", "failed"].includes(summary.state))
          reasons.push("delivery_check");
        if (row.has_artifacts) {
          const result = evidence.get(taskReviewPlanKeyV1(row.project_id, row.id));
          reasons.push(...(result ? this.resultAttentionFromEvidence(result).reasons : ["result_checks_unavailable"] as const));
        }
        if (reasons.length) {
          const uniqueReasons = [...new Set(reasons)];
          items.push({ task: summary, inputDigest: job.inputDigest, reasons: uniqueReasons,
            ...taskAttentionPresentation(uniqueReasons) });
        }
      }
      return taskAttentionPageSchema.parse({ items, sources, examined: Math.min(rows.length, 25),
        nextCursor: rows.length > 25 ? rows[24].id : null, observedAt: actor.now, startsWork: false,
        planningSource: planningConfigured ? "configured" : "not_configured" });
    });
  }

  /** Bounded project-local slice of the same attention classification used by
   * /needs-me/tasks. Result attention is deliberately independent from a task's
   * execution-approval state: a returned pending result can appear after the task
   * is no longer waiting_approval. */
  async projectAttention(identity: VerifiedWebIdentity, projectId: string, mode: "inbox" | "reviews", after?: string) {
    this.id(projectId); if (after !== undefined) this.id(after);
    return this.authenticatedRead(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      await this.projects.getViewInSession(tx, actor, projectId);
      const hasArtifact = `EXISTS(SELECT 1 FROM control_native_artifact_receipts a
        WHERE a.tenant_id=j.tenant_id AND a.project_id=j.project_id AND a.job_id=j.id)`;
      const candidate = mode === "reviews" ? hasArtifact : `(j.state IN ('proposed','waiting_approval','failed','orphaned')
        OR (j.payload->>'jobType'='harness.hermes.native.task' AND j.state IN ('leased','running')) OR ${hasArtifact})`;
      const rows = (await tx.query<TaskRow & { has_artifacts: boolean }>(`SELECT ${hasArtifact} AS has_artifacts, ${selection}
        WHERE j.tenant_id=$1 AND j.project_id=$2 AND ($3::text IS NULL OR j.id COLLATE "C">$3 COLLATE "C") AND ${candidate}
        ORDER BY j.id COLLATE "C" LIMIT 21`, [this.scope.tenantId, projectId, after ?? null])).rows;
      const evidence = await this.batchResultEvidence(tx, actor,
        rows.slice(0, 20).filter(row => row.has_artifacts).map(row => ({ projectId, jobId: row.id })));
      const items: TaskProjectAttentionPage["items"] = [];
      for (const row of rows.slice(0, 20)) {
        const { summary, job } = validated(row, this.scope.tenantId, projectId);
        const reasons: TaskAttentionPage["items"][number]["reasons"] = [];
        if (mode === "inbox") {
          if (summary.state === "proposed") reasons.push(job.jobType === "task.proposal" ? "proposal" : "assignment");
          if (summary.state === "waiting_approval") reasons.push("approval");
          if (summary.state === "failed" || summary.state === "orphaned") reasons.push(summary.state);
          if (job.jobType === "harness.hermes.native.task" && ["leased", "running", "waiting_approval", "orphaned", "failed"].includes(summary.state))
            reasons.push("delivery_check");
        }
        const projection = row.has_artifacts ? evidence.get(taskReviewPlanKeyV1(projectId, row.id)) : undefined;
        const result = !row.has_artifacts ? { reasons: [] as TaskAttentionPage["items"][number]["reasons"], resultArtifactIds: [] }
          : projection ? this.resultAttentionFromEvidence(projection)
          : { reasons: ["result_checks_unavailable"] as TaskAttentionPage["items"][number]["reasons"], resultArtifactIds: [] };
        reasons.push(...result.reasons);
        const uniqueReasons = [...new Set(reasons)];
        if (!uniqueReasons.length || mode === "reviews" && !uniqueReasons.some(reason =>
          (taskProjectResultAttentionReasons as readonly string[]).includes(reason))) continue;
        items.push({ task: summary, inputDigest: job.inputDigest, reasons: uniqueReasons,
          resultArtifactIds: result.resultArtifactIds, ...taskAttentionPresentation(uniqueReasons) });
      }
      return taskProjectAttentionPageSchema.parse({ projectId, mode, items, examined: Math.min(rows.length, 20),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
        resultSource: this.resultStore ? "configured" : "not_configured",
        reviewSource: this.reviewConfig ? "configured" : "not_configured",
        resultContent: actor.can("tasks.results.read", projectId) ? "authorized" : "not_authorized",
        observedAt: actor.now, startsWork: false });
    });
  }

  /** Bounded, read-only home activity. The caller must have workspace-wide task and
   * project visibility; a partial project grant cannot turn this into an enumeration
   * endpoint. Result candidates are re-read through the signed result store before
   * any metadata is returned. */
  async home(identity: VerifiedWebIdentity, input: Readonly<{ surface?: unknown; recent?: unknown }> = {}) {
    const surface = input.surface === undefined ? "home" : input.surface;
    if (surface !== "home" && surface !== "morning") throw new WebAccessError("invalid_request");
    const recent = input.recent === true;
    return this.authenticatedRead(identity, async (tx, actor) => {
      const sources = this.attentionSources(actor);
      const cursor = (await tx.query<{ seen_through: string | Date }>(`SELECT seen_through FROM owner_surface_cursors
        WHERE tenant_id=$1 AND identity_id=$2 AND surface=$3`, [this.scope.tenantId, actor.id, surface])).rows[0];
      const visibleProject = `((p.adapter_id=$2 AND $4::boolean AND EXISTS(SELECT 1 FROM control_manual_project_heads h
        WHERE h.tenant_id=p.tenant_id AND h.project_id=p.id)) OR (p.adapter_id=$3 AND $5::boolean))`;
      const sourceParameters = [`adapter:manual:${sha256Digest(this.scope).slice(7, 39)}`,
        CONTROL_ROOM_IDEA_ADAPTER_V1, sources.ordinary === "included", sources.ideas === "included"] as const;
      const canReadResults = !!this.resultStore && actor.can("tasks.results.read", undefined, true);
      if (canReadResults) actor.require("tasks.results.read", undefined, true);
      const homeRows = (await tx.query<TaskRow & { home_kind: "active" | "result"; artifact_id: string | null }>(`
        WITH active_rows AS (
          SELECT 'active'::text AS home_kind,NULL::text AS artifact_id,${selection}
          JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id
          WHERE j.tenant_id=$1 AND p.workspace_id=$6 AND ${visibleProject}
            AND j.state IN ('leased','running','waiting_approval')
          ORDER BY j.updated_at DESC,j.id COLLATE "C" LIMIT 251
        ), result_rows AS (
          SELECT 'result'::text AS home_kind,a.artifact_id,${selection}
          JOIN control_native_artifact_receipts a ON a.tenant_id=j.tenant_id AND a.project_id=j.project_id AND a.job_id=j.id
          JOIN control_artifact_manifests m ON m.tenant_id=a.tenant_id AND m.id=a.artifact_id
          JOIN projects p ON p.tenant_id=a.tenant_id AND p.id=a.project_id
          WHERE a.tenant_id=$1 AND p.workspace_id=$6 AND $7::boolean AND ${visibleProject}
            AND ($8::boolean OR m.created_at>$9::timestamptz)
          ORDER BY m.created_at DESC,a.artifact_id COLLATE "C" LIMIT 11
        ) SELECT * FROM active_rows UNION ALL SELECT * FROM result_rows`,
      [this.scope.tenantId, ...sourceParameters, this.scope.workspaceId, canReadResults, recent,
        cursor ? iso(cursor.seen_through) : actor.now])).rows;
      const activeRows = homeRows.filter(row => row.home_kind === "active");
      await this.projects.getViewsInSession(tx, actor, homeRows.map(row => row.project_id));
      const activeSummaries = [];
      for (const row of activeRows.slice(0, 250)) {
        actor.require("tasks.read", row.project_id);
        activeSummaries.push(validated(row, this.scope.tenantId, row.project_id).summary);
      }
      const recentResults: { task: ReturnType<typeof validated>["summary"];
        artifact: ReturnType<typeof resultMetadata> }[] = [];
      let additionalResultsOmitted = false;
      let projectedActive = [...activeSummaries];
      if (this.resultStore && canReadResults) {
        const candidates = homeRows.filter((row): row is typeof row & { artifact_id: string } =>
          row.home_kind === "result" && row.artifact_id !== null);
        const selected = candidates.slice(0, 10), summaries = selected.map(candidate => {
          actor.require("tasks.read", candidate.project_id); actor.require("tasks.results.read", candidate.project_id);
          return validated(candidate, this.scope.tenantId, candidate.project_id).summary;
        });
        const displaySummaries = [...activeSummaries, ...summaries];
        const evidence = await this.batchResultEvidence(tx, actor, displaySummaries);
        projectedActive = this.applyDisplayEvidence(activeSummaries, evidence);
        const enriched = this.applyDisplayEvidence(summaries, evidence);
        for (let index = 0; index < selected.length; index += 1) {
          const candidate = selected[index]!, page = evidence.get(taskReviewPlanKeyV1(candidate.project_id, candidate.id));
          const receipt = page?.items.find(item => item.artifactId === candidate.artifact_id);
          if (!receipt) throw new Error("task_home_result_unavailable");
          recentResults.push({ task: enriched[index]!, artifact: receipt });
        }
        additionalResultsOmitted = candidates.length > 10;
      }
      const remainingActive = projectedActive.filter(task => ["leased", "running", "waiting_approval"].includes(task.state));
      const active = remainingActive.slice(0, 10);
      return taskHomeActivitySchema.parse({ active, recentResults,
        additionalActiveOmitted: remainingActive.length > 10 || activeRows.length > 250, additionalResultsOmitted,
        resultSource: !this.resultStore ? "not_configured" : canReadResults ? "configured" : "not_authorized",
        cursor: { surface, mode: recent ? "recent" : "since_last_look", firstVisit: !cursor,
          acknowledgeThrough: actor.now },
        observedAt: actor.now, startsWork: false });
    });
  }

  async acknowledgeHome(identity: VerifiedWebIdentity, input: Readonly<{ surface?: unknown; acknowledgeThrough?: unknown }>) {
    const surface = input.surface;
    if (surface !== "home" && surface !== "morning") throw new WebAccessError("invalid_request");
    if (typeof input.acknowledgeThrough !== "string" || !Number.isFinite(Date.parse(input.acknowledgeThrough)))
      throw new WebAccessError("invalid_request");
    const through = iso(input.acknowledgeThrough);
    return this.authority.authenticated(identity, async (tx, actor) => {
      this.attentionSources(actor);
      if (Date.parse(through) > Date.parse(actor.now)) throw new WebAccessError("invalid_request");
      const row = (await tx.query<{ seen_through: string | Date }>(`INSERT INTO owner_surface_cursors
        (tenant_id,identity_id,surface,seen_through,updated_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(tenant_id,identity_id,surface) DO UPDATE SET
          seen_through=GREATEST(owner_surface_cursors.seen_through,EXCLUDED.seen_through),
          updated_at=GREATEST(owner_surface_cursors.updated_at,EXCLUDED.updated_at)
        RETURNING seen_through`, [this.scope.tenantId, actor.id, surface, through, actor.now])).rows[0];
      if (!row) throw new Error("owner_surface_cursor_unavailable");
      return Object.freeze({ acknowledged: true as const, seenThrough: iso(row.seen_through) });
    });
  }

  /** Read-only project summary for the Overview page. Separate bounded queries keep
   * current, review-waiting and recent task sets complete within their stated limits. */
  async projectOverview(identity: VerifiedWebIdentity, projectId: string) {
    this.id(projectId);
    return this.authenticatedRead(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      await this.projects.getViewInSession(tx, actor, projectId);
      const read = async (states: readonly string[] | undefined, maximum: number) => {
        const parameters: unknown[] = [this.scope.tenantId, projectId];
        const stateClause = states ? ` AND j.state=ANY($3::text[])` : "";
        if (states) parameters.push(states);
        const limitParameter = parameters.push(maximum + 1);
        return (await tx.query<TaskRow>(`SELECT ${selection} WHERE j.tenant_id=$1 AND j.project_id=$2${stateClause}
          ORDER BY j.updated_at DESC,j.id COLLATE "C" LIMIT $${limitParameter}`, parameters)).rows;
      };
      const currentStates = ["proposed", "ready", "leased", "running", "waiting_approval", "orphaned"];
      const currentRows = await read(currentStates, 250), reviewRows = await read(["waiting_approval"], 250),
        recentRows = await read(undefined, 10);
      const summaries = (rows: readonly TaskRow[]) => rows.map(row => validated(row, this.scope.tenantId, projectId).summary);
      const currentSummaries = summaries(currentRows.slice(0, 250)), reviewSummaries = summaries(reviewRows.slice(0, 250)),
        recentSummaries = summaries(recentRows.slice(0, 10));
      const displayCandidates = [...currentSummaries, ...reviewSummaries, ...recentSummaries]
        .filter(summary => ["leased", "running", "waiting_approval", "succeeded"].includes(summary.state)
          && this.resultStore && actor.can("tasks.results.read", summary.projectId));
      const displayEvidence = displayCandidates.length ? await this.batchResultEvidence(tx, actor, displayCandidates) : new Map();
      const projectedCurrent = this.applyDisplayEvidence(currentSummaries, displayEvidence)
        .filter(task => currentStates.includes(task.state));
      const projectedReviews = this.applyDisplayEvidence(reviewSummaries, displayEvidence)
        .filter(task => task.state === "waiting_approval");
      const projectedRecent = this.applyDisplayEvidence(recentSummaries, displayEvidence);
      const usageRollup = this.harnessKey ? rollupUsageGroupsV1(
        await new HarnessRunStoreV1(joined(tx), this.harnessKey)
          .inspectUsageRollup(this.scope.tenantId, projectId), this.usagePriceTable)
        : rollupUsageGroupsV1([], this.usagePriceTable);
      return taskProjectOverviewSchema.parse({ projectId, current: projectedCurrent.slice(0, 10),
        awaitingReview: projectedReviews.slice(0, 5), recent: projectedRecent,
        additionalCurrentOmitted: projectedCurrent.length > 10 || currentRows.length > 250,
        additionalReviewsOmitted: projectedReviews.length > 5 || reviewRows.length > 250, usageRollup,
        priceTable: this.priceTableEvidence(),
        additionalRecentOmitted: recentRows.length > 10, observedAt: actor.now, startsWork: false });
    });
  }

  /** Project-wide index over the existing signed result receipts. Content remains
   * available only through the exact task result route; no storage locator is exposed. */
  async projectFiles(identity: VerifiedWebIdentity, projectId: string) {
    this.id(projectId);
    return this.authenticatedRead(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      await this.projects.getViewInSession(tx, actor, projectId);
      if (!actor.can("tasks.results.read", projectId)) return taskProjectFilesSchema.parse({ projectId, items: [],
        additionalItemsOmitted: false, resultSource: "not_authorized", observedAt: actor.now, startsWork: false });
      actor.require("tasks.results.read", projectId);
      if (!this.resultStore) return taskProjectFilesSchema.parse({ projectId, items: [], additionalItemsOmitted: false,
        resultSource: "not_configured", observedAt: actor.now, startsWork: false });
      const candidates = (await tx.query<{ job_id: string; artifact_id: string }>(`
        SELECT a.job_id,a.artifact_id FROM control_native_artifact_receipts a
        JOIN control_artifact_manifests m ON m.tenant_id=a.tenant_id AND m.id=a.artifact_id
          AND m.project_id=a.project_id AND m.job_id=a.job_id AND m.attempt_id=a.attempt_id
        WHERE a.tenant_id=$1 AND a.project_id=$2
        ORDER BY m.created_at DESC,a.artifact_id COLLATE "C" LIMIT 21`, [this.scope.tenantId, projectId])).rows;
      const items = [];
      for (const candidate of candidates.slice(0, 20)) {
        const row = (await tx.query<TaskRow>(`SELECT ${selection} WHERE j.tenant_id=$1 AND j.project_id=$2 AND j.id=$3`,
          [this.scope.tenantId, projectId, candidate.job_id])).rows[0];
        if (!row) throw new Error("task_project_file_unavailable");
        const receipt = await this.resultStore.readReceipt(tx, this.scope.tenantId, projectId, candidate.job_id, candidate.artifact_id);
        if (!receipt) throw new Error("task_project_file_unavailable");
        items.push({ task: validated(row, this.scope.tenantId, projectId).summary,
          artifact: taskResultMetadataSchema.parse({ ...resultMetadata(receipt), fileAccess: this.fileAccess(projectId, candidate.job_id, receipt) }) });
      }
      return taskProjectFilesSchema.parse({ projectId, items, additionalItemsOmitted: candidates.length > 20,
        resultSource: "configured", observedAt: actor.now, startsWork: false });
    });
  }
}
