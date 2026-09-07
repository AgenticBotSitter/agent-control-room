import { randomUUID } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { CanonicalStore, type ProposedWorkBundle } from "../../persistence/canonical-store";
import { DOMAIN_CONTRACT_VERSION, requestRecordSchema, workflowRecordSchema, jobRecordSchema,
  attemptRecordSchema, type AuthorityEnvelope } from "../../domain/v1";
import { appendAuditWith } from "../../audit/audit-store";
import { assertNoSecretMaterial, computeAuthorityDigest, sha256Digest } from "../../security";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import { NativeResultStore, type NativeResultReadConfiguration, type NativeResultReceipt } from "../../artifacts/v1/native-results";
import { CompletionGateStoreV1 } from "../../completion-gate/v1/store";
import { readNativeReviewPlan, verifyNativeReviewTarget } from "../../completion-gate/v1/native-review-plan";
import type { AwaitableRollbackCheckpointStoreV1 } from "../../security/rollback-checkpoint";
import type { WebTaskReviewConfiguration } from "./task-review-service";
import type { ManualVerificationScenario } from "./task-verification-service";
import { taskResultMetadataSchema, boundedTaskResultsPage, taskResultContentSchema, taskReviewEvidenceSchema } from "./task-result-wire";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebSessionAuthority, type WebActor } from "./session-authority";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../../idea-lab/v1/schemas";
import { taskAttentionPageSchema, type TaskAttentionPage } from "./task-attention-wire";
import { WebProjectService } from "./project-service";
import { catalogProjectIdSchema } from "./project-wire";
import { taskDraftSchema, taskSummarySchema, taskReceiptSchema, taskDetailSchema, taskPageSchema,
  taskRunSchema, type TaskRun, type TaskReceipt } from "./task-wire";
import { taskPlanningOptionsSchema } from "./task-planning-wire";

/** Joins existing stores to the caller-owned session transaction. No nested BEGIN/COMMIT and no
 * new authority: this closure stays inside authenticated(). The outer freshness check owns commit. */
function joined(tx: DatabaseSession): DatabaseClient {
  return Object.freeze({ query: tx.query.bind(tx), transaction: async <T>(run: (session: DatabaseSession) => Promise<T>) => run(tx),
    transactionWithPreCommitCheck: async <T>(run: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) => {
      const result = await run(tx); await check(); return result;
    } });
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
  harnessIntegrityKey?: Uint8Array;
  ideaIntegrityKey?: Uint8Array;
  results?: NativeResultReadConfiguration;
  reviews?: { integrityKey: Uint8Array; checkpoints: AwaitableRollbackCheckpointStoreV1 };
  ownerReviews?: WebTaskReviewConfiguration;
  manualVerificationScenarios?: readonly ManualVerificationScenario[];
}
const resultMetadata = (receipt: NativeResultReceipt) => taskResultMetadataSchema.parse({ artifactId: receipt.artifactId,
  attemptId: receipt.attemptId, runId: receipt.runId, contentHash: receipt.contentHash, sizeBytes: receipt.sizeBytes,
  receivedAt: receipt.receivedAt, byteCheck: receipt.byteCheck, qualityAccepted: false });

export class WebTaskService {
  private readonly authority: WebSessionAuthority;
  private readonly projects: WebProjectService;
  private readonly harnessKey?: Uint8Array;
  private readonly resultStore?: NativeResultStore;
  private readonly reviewConfig?: NonNullable<WebTaskKeys["reviews"]>;
  private readonly reviewCommandsConfigured: boolean;
  private readonly verificationCommandsConfigured: boolean;
  private readonly ideaProjectsConfigured: boolean;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly clock: () => number = Date.now, keys?: WebTaskKeys) {
    this.authority = new WebSessionAuthority(db, scope, clock, "task");
    this.ideaProjectsConfigured = !!keys?.ideaIntegrityKey;
    this.reviewCommandsConfigured = !!keys?.ownerReviews;
    this.verificationCommandsConfigured = !!keys?.manualVerificationScenarios?.length;
    if (keys?.manualVerificationScenarios && (!keys.results || !keys.reviews || !keys.harnessIntegrityKey)) throw new Error("task_key_invalid");
    if (keys?.ownerReviews && (!keys.results || !keys.reviews || !(keys.ownerReviews.integrityKey instanceof Uint8Array)
      || keys.ownerReviews.integrityKey.length !== 32 || keys.reviews.integrityKey.length !== 32
      || keys.ownerReviews.integrityKey.some((byte, index) => byte !== keys.reviews!.integrityKey[index]))) throw new Error("task_key_invalid");
    this.projects = new WebProjectService(db, scope, clock, keys?.ideaIntegrityKey);
    if (keys?.harnessIntegrityKey !== undefined) {
      if (!(keys.harnessIntegrityKey instanceof Uint8Array) || keys.harnessIntegrityKey.length !== 32) throw new Error("task_key_invalid");
      this.harnessKey = new Uint8Array(keys.harnessIntegrityKey);
    }
    if (keys?.results) {
      if (!this.harnessKey) throw new Error("task_key_invalid");
      // The web service retains only the read capability, even when composition supplied a fuller store.
      this.resultStore = new NativeResultStore(db, this.harnessKey, { ...keys.results,
        storage: Object.freeze({ read: keys.results.storage.read.bind(keys.results.storage) }) });
    }
    if (keys?.reviews) {
      if (!(keys.reviews.integrityKey instanceof Uint8Array) || keys.reviews.integrityKey.length !== 32) throw new Error("task_key_invalid");
      this.reviewConfig = { integrityKey: Uint8Array.from(keys.reviews.integrityKey), checkpoints: Object.freeze({
        read: keys.reviews.checkpoints.read.bind(keys.reviews.checkpoints), initialize: () => { throw new Error("review_read_only"); },
        advance: () => { throw new Error("review_read_only"); } }) };
    }
  }
  private id(value: string) { if (!catalogProjectIdSchema.safeParse(value).success) throw new WebAccessError("invalid_request"); }

  async authorize(identity: VerifiedWebIdentity, projectId: string) {
    this.id(projectId);
    await this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); await this.projects.getViewInSession(tx, actor, projectId);
    });
  }

  /** Availability is a current UI hint, not admission. The planner rechecks owner authority
   * and exact source/template inside its own transaction before creating anything. */
  async planningOptions(identity: VerifiedWebIdentity, projectId: string, jobId: string, configured: boolean) {
    this.id(projectId); this.id(jobId);
    return this.authority.authenticated(identity, async (tx, actor) => {
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
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      const rows = (await tx.query<TaskRow>(`SELECT ${selection} WHERE j.tenant_id=$1 AND j.project_id=$2
        AND ($3::text IS NULL OR j.id COLLATE "C">$3 COLLATE "C") ORDER BY j.id COLLATE "C" LIMIT 51`,
      [this.scope.tenantId, projectId, after ?? null])).rows;
      const tasks = rows.slice(0, 50).map(row => validated(row, this.scope.tenantId, projectId).summary);
      return taskPageSchema.parse({ project, tasks, nextCursor: rows.length > 50 ? tasks.at(-1)!.jobId : null,
        canPropose: project.lifecycle === "active" && actor.can("tasks.propose", projectId), dispatch: "not_connected", observedAt: actor.now });
    });
  }

  async propose(identity: VerifiedWebIdentity, projectId: string, value: unknown, key: string) {
    this.id(projectId);
    const parsed = taskDraftSchema.safeParse(value);
    if (!parsed.success || !/^[A-Za-z0-9:_-]{12,180}$/.test(key)) throw new WebAccessError("invalid_request");
    try { assertNoSecretMaterial(parsed.data); } catch { throw new WebAccessError("invalid_request"); }
    const digest = sha256Digest({ ...this.scope, projectId, action: "tasks.propose", draft: parsed.data });
    return this.authority.authenticated(identity, async (tx, actor) => {
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
          definitionDigest: sha256Digest({ type: "private-task-proposal/v1", projectId, draft: parsed.data }),
          authorityMode: "control_room_native", state: "proposed", jobIds: [jobId] },
        job: { ...base, id: jobId, kind: "job", workflowId, projectId, jobType: "task.proposal", specVersion: "1.0.0",
          inputDigest: sha256Digest(parsed.data), state: "proposed", priority: 50, requiredCapability: "task.proposal.review",
          dependsOnJobIds: [], authority, retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [],
            retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } },
      };
      await new CanonicalStore(joined(tx)).createProposedWorkBundle(bundle);
      const receipt: TaskReceipt = { projectId, jobId, requestId, createdAt: actor.now, submission: "proposed", startsWork: false };
      await appendAuditWith(tx, { id: `audit:${randomUUID()}`, ...this.scope, projectId, actorId: actor.id, actorType: "human",
        action: "tasks.propose", targetType: "job", targetId: jobId, idempotencyKey: key, occurredAt: actor.now,
        safeMetadata: { inputDigest: bundle.job.inputDigest, state: "proposed" } });
      await tx.query(`INSERT INTO control_web_task_commands(tenant_id,identity_id,idempotency_key,project_id,job_id,request_digest,result,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [this.scope.tenantId, actor.id, key, projectId, jobId, digest, JSON.stringify(receipt), actor.now]);
      return { receipt, replayed: false };
    });
  }

  async detail(identity: VerifiedWebIdentity, projectId: string, jobId: string) {
    this.id(projectId); this.id(jobId);
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      const row = (await tx.query<TaskRow>(`SELECT ${selection} WHERE j.tenant_id=$1 AND j.project_id=$2 AND j.id=$3`,
        [this.scope.tenantId, projectId, jobId])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      const { job, request, summary } = validated(row, this.scope.tenantId, projectId);
      const attemptRows = (await tx.query<{ id: string; state: string; attempt_number: number; payload: unknown }>(
        `SELECT id,state,attempt_number,payload FROM control_attempts WHERE tenant_id=$1 AND job_id=$2 ORDER BY attempt_number DESC LIMIT 11`,
      [this.scope.tenantId, jobId])).rows;
      const store = this.harnessKey ? new HarnessRunStoreV1(joined(tx), this.harnessKey) : undefined;
      const attempts = [];
      for (const a of attemptRows.slice(0, 10)) {
        const attempt = attemptRecordSchema.parse(a.payload);
        if (attempt.tenantId !== this.scope.tenantId || attempt.jobId !== jobId || attempt.id !== a.id
          || attempt.state !== a.state || attempt.attemptNumber !== Number(a.attempt_number)) throw new Error("task_attempt_unavailable");
        const ids = store ? (await tx.query<{ id: string }>(`SELECT id FROM control_harness_runs WHERE tenant_id=$1
          AND project_id=$2 AND job_id=$3 AND attempt_id=$4 ORDER BY created_at DESC,id DESC LIMIT 11`,
        [this.scope.tenantId, projectId, jobId, attempt.id])).rows : [];
        const runs: TaskRun[] = [];
        for (const { id } of ids.slice(0, 10)) {
          const inspected = await store!.inspect(this.scope.tenantId, id);
          if (!inspected || inspected.run.projectId !== projectId || inspected.run.jobId !== jobId
            || inspected.run.attemptId !== attempt.id || inspected.run.nodeId !== attempt.nodeId) throw new Error("task_run_unavailable");
          const { run, events } = inspected;
          const snapshots = events.flatMap(event => event.payload.category === "native_snapshot" ? [event.payload.snapshot] : []);
          const last = snapshots.at(-1);
          runs.push(taskRunSchema.parse({ runId: run.id, harness: run.harness, state: run.state, lastObservedAt: run.lastObservedAt,
            stale: Date.parse(run.lastObservedAt) > Date.parse(actor.now) || Date.parse(actor.now) - Date.parse(run.lastObservedAt) > 120_000,
            firstObservedExecutionAt: run.startedAt ?? null, finishedObservedAt: run.finishedAt ?? null, cancellation: run.cancelState,
            source: run.nativeTask ? "native_snapshot" : "legacy", nativeState: last?.state ?? null,
            availability: run.nativeTask ? last?.availability ?? "unknown" : null,
            usage: last?.usage ? { inputTokens: last.usage.inputTokens, outputTokens: last.usage.outputTokens,
              totalTokens: last.usage.totalTokens, costUsd: null, hardCostLimitEnforced: false } : null,
            resultClaim: last?.result ? { ...last.result, verified: false } : null,
            timeline: snapshots.slice(-50).map(item => ({ version: item.snapshotVersion, state: item.state,
              observedAt: item.observedAt, availability: item.availability })), earlierObservationsOmitted: snapshots.length > 50 }));
        }
        attempts.push({ attemptId: attempt.id, attemptNumber: attempt.attemptNumber, state: attempt.state,
          runs, additionalRunsOmitted: ids.length > 10 });
      }
      return taskDetailSchema.parse({ project, task: summary, instructions: request.objective, inputDigest: job.inputDigest,
        observedAt: actor.now, attempts, earlierAttemptsOmitted: attemptRows.length > 10,
        progressSource: store ? "configured" : "not_configured", dispatch: "not_connected",
        artifacts: this.resultStore ? "configured" : "not_connected", review: this.reviewConfig ? "recorded" : "not_connected" });
    });
  }

  /** Trusted server composition, never a browser-supplied callback. */
  async readScopedResult<T>(identity: VerifiedWebIdentity, projectId: string, jobId: string,
    read: (scope: { tenantId: string; projectId: string; jobId: string }) => Promise<T>) {
    this.id(projectId); this.id(jobId);
    return this.authority.authenticated(identity, async (tx, actor) => {
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
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); await this.projects.getViewInSession(tx, actor, projectId);
      const row = (await tx.query<TaskRow>(`SELECT ${selection} WHERE j.tenant_id=$1 AND j.project_id=$2 AND j.id=$3`,
        [this.scope.tenantId, projectId, jobId])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      validated(row, this.scope.tenantId, projectId);
      if (artifactId !== undefined) {
        actor.require("tasks.results.read", projectId);
        if (!this.resultStore) throw new Error("task_results_not_configured");
        const content = await this.resultStore.read(tx, this.scope.tenantId, projectId, jobId, artifactId);
        if (!content) throw new WebAccessError("not_found");
        return taskResultContentSchema.parse({ projectId, jobId, artifact: resultMetadata(content.receipt), text: content.text,
          contentVerifiedAt: new Date(this.clock()).toISOString(), untrustedContent: true });
      }
      return this.resultPage(tx, actor, projectId, jobId);
    });
  }

  private async resultPage(tx: DatabaseSession, actor: WebActor, projectId: string, jobId: string) {
      const result = this.resultStore ? await this.resultStore.list(tx, this.scope.tenantId, projectId, jobId)
        : { receipts: [], additionalResultsOmitted: false };
      const items = result.receipts.map(resultMetadata);
      const lineage = this.reviewConfig ? await readNativeReviewPlan(tx, this.reviewConfig.integrityKey,
        this.scope.tenantId, projectId, jobId) : undefined;
      const subjectId = lineage?.schema === "control-room.native-review-plan/v2" ? lineage.revision.rootSubjectId : jobId;
      const review = this.reviewConfig ? await new CompletionGateStoreV1(joined(tx), this.reviewConfig.integrityKey,
        this.reviewConfig.checkpoints).inspectSubject(this.scope.tenantId, projectId, subjectId) : { targets: [], additionalTargetsOmitted: false };
      const reviews = review.targets.map(({ snapshot, reviews, verifications, findings, additionalEvidenceOmitted }) => taskReviewEvidenceSchema.parse({
        targetId: snapshot.target.id, kind: snapshot.target.kind, targetDigest: snapshot.targetDigest,
        contentHash: snapshot.target.subjectDigest, revision: snapshot.revisionNumber, supersedesTargetId: snapshot.target.supersedesTargetId ?? null,
        status: snapshot.status, matchingArtifactIds: snapshot.target.kind === "document" ? result.receipts.filter(receipt => {
          if (receipt.contentHash !== snapshot.target.subjectDigest) return false;
          try { verifyNativeReviewTarget(lineage, snapshot.target, receipt); return true; } catch { return false; }
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

  async attention(identity: VerifiedWebIdentity, after?: string) {
    if (after !== undefined) this.id(after);
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", undefined, true);
      const ordinary = actor.can("projects.read", undefined, true);
      const ideas = actor.can("idea_lab.project_read", undefined, true);
      if (!ordinary && !ideas) throw new WebAccessError("access_denied");
      if (ordinary) actor.require("projects.read", undefined, true);
      if (ideas && this.ideaProjectsConfigured) actor.require("idea_lab.project_read", undefined, true);
      const sources: TaskAttentionPage["sources"] = { ordinary: ordinary ? "included" : "not_authorized",
        ideas: !ideas ? "not_authorized" : this.ideaProjectsConfigured ? "included" : "not_configured" };
      const rows = (await tx.query<TaskRow & { has_artifacts: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM control_native_artifact_receipts a WHERE a.tenant_id=j.tenant_id AND a.project_id=j.project_id AND a.job_id=j.id) AS has_artifacts, ${selection}
        JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id
        WHERE j.tenant_id=$1 AND p.workspace_id=$2 AND ($3::text IS NULL OR j.id COLLATE "C">$3 COLLATE "C")
          AND ((p.adapter_id=$4 AND $6::boolean AND EXISTS(SELECT 1 FROM control_manual_project_heads h
            WHERE h.tenant_id=p.tenant_id AND h.project_id=p.id)) OR (p.adapter_id=$5 AND $7::boolean))
          AND (j.state IN ('proposed','waiting_approval','failed','orphaned')
            OR (j.payload->>'jobType'='harness.hermes.native.task' AND j.state IN ('leased','running')) OR EXISTS(
            SELECT 1 FROM control_native_artifact_receipts a WHERE a.tenant_id=j.tenant_id AND a.project_id=j.project_id AND a.job_id=j.id))
        ORDER BY j.id COLLATE "C" LIMIT 26`, [this.scope.tenantId, this.scope.workspaceId, after ?? null,
        `adapter:manual:${sha256Digest(this.scope).slice(7, 39)}`, CONTROL_ROOM_IDEA_ADAPTER_V1, ordinary, sources.ideas === "included"])).rows;
      const items: TaskAttentionPage["items"] = [];
      for (const row of rows.slice(0, 25)) {
        await this.projects.getViewInSession(tx, actor, row.project_id);
        actor.require("tasks.read", row.project_id, true);
        const { summary, job } = validated(row, this.scope.tenantId, row.project_id);
        const reasons: TaskAttentionPage["items"][number]["reasons"] = [];
        if (summary.state === "proposed") reasons.push(job.jobType === "task.proposal" ? "proposal" : "assignment");
        if (summary.state === "waiting_approval") reasons.push("approval");
        if (summary.state === "failed" || summary.state === "orphaned") reasons.push(summary.state);
        if (job.jobType === "harness.hermes.native.task" && ["leased", "running", "waiting_approval", "orphaned", "failed"].includes(summary.state))
          reasons.push("delivery_check");
        if (row.has_artifacts) {
          const result = await this.resultPage(tx, actor, row.project_id, row.id);
          if (result.resultSource === "not_configured" || result.reviewSource === "not_configured") {
            reasons.push("result_checks_unavailable");
          } else {
            for (const review of result.reviews.filter(value => value.matchingArtifactIds.length > 0)) {
              switch (review.status) {
                case "pending": reasons.push("review"); break;
                case "changes_requested": case "verification_blocked": case "revision_limit_reached":
                  reasons.push(review.status); break;
              }
            }
            if (result.additionalResultsOmitted || result.additionalTargetsOmitted
              || result.reviews.some(value => value.additionalEvidenceOmitted)
              || result.items.some(item => !result.reviews.some(review => review.matchingArtifactIds.includes(item.artifactId))))
              reasons.push("result_checks_unavailable");
          }
        }
        if (reasons.length) items.push({ task: summary, inputDigest: job.inputDigest, reasons: [...new Set(reasons)] });
      }
      return taskAttentionPageSchema.parse({ items, sources, examined: Math.min(rows.length, 25),
        nextCursor: rows.length > 25 ? rows[24].id : null, observedAt: actor.now, startsWork: false });
    });
  }
}
