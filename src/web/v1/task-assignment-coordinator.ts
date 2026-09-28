import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { attemptRecordSchema, jobRecordSchema, leaseRecordSchema, nodeRecordSchema,
  requestRecordSchema, workflowRecordSchema, type AttemptRecord, type JobRecord, type LeaseRecord } from "../../domain/v1";
import { CanonicalStore } from "../../persistence/canonical-store";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { MAX_NATIVE_UNSENT_RECOVERIES, nativeTaskSubmissionReferenceSchema, type NativeTaskSubmissionReference, type NativeTaskSubmission } from "../../persistence/native-task-submission";
import { FleetSignalStore } from "../../node-fleet/v1/fleet-signal-store";
import { evaluateFleetEligibility } from "../../node-fleet/v1/eligibility";
import { appendAuditWith } from "../../audit/audit-store";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebSessionAuthority, type WebActor } from "./session-authority";
import { NativeQueueAuthority } from "./native-queue-authority";
import { WebProjectService } from "./project-service";
import type { ProjectView } from "./project-wire";
import type { TaskExecutionPlanner } from "./task-execution-planner";
import { enrollmentSchema, type NativeEnrollment } from "../../harness/v1/native-run-contracts";
import { prepareNativeTaskApprovalWithLease } from "../../harness/v1/native-task-lease-grant";
import type { NativeApprovalPacketStore } from "./native-approval-packet-store";
import { nativeTaskApprovalPacketSchema } from "../../harness/v1/native-approval-packet";
import { readNativeTaskQueueIntentInSession, type NativeTaskQueueIntent, type NativeTaskQueueScope } from "./native-task-queue";
import { macLocalQueueIntentPacketDigestV1 } from "./mac-local-queue-intent-digest";
import type { ServerNodeSession } from "../../node-control/server-node-session";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import { CODEX_APP_SERVER_CAPABILITY, CODEX_APP_SERVER_JOB_TYPE } from "../../harness/codex-v1/delivery-contract";
import { HERMES_021_MACOS_LOCAL_CAPABILITY_V1, HERMES_021_MACOS_LOCAL_JOB_TYPE_V1 } from "../../harness/hermes-021-v1/macos-local-worker";
import { HERMES_LOCAL_CAPABILITY_V1, HERMES_LOCAL_JOB_TYPE_V1 } from "../../harness/hermes-local-v1/task-planning-contract";
import { CONTROLLER_WORKER_REMOTE_CAPABILITY_V1, CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1 } from "../../harness/v1/remote-worker-delivery";
import { HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1 } from "../../harness/hermes-021-v1/connector-profile";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1,
  CLAUDE_CODE_LOCAL_CAPABILITY_V1, CLAUDE_CODE_LOCAL_JOB_TYPE_V1 } from "../../harness/claude-code-v1/task-planning-contract";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1,
  CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1 } from "../../harness/codex-v1/owner-trusted-local-task-planning-contract";
import { codexTaskDispatchBodySchemaV1 } from "../../harness/codex-v1/delivery-contract";
import { buildCodexTaskActivationV1, type CodexDispatchFrameForActivationV1,
  type CodexDispatchReceiptFrameForActivationV1 } from "../../harness/codex-v1/activation-contract";
import { describeCodexOwnerPermitReview, prepareCodexOwnerPermitBinding, prepareCodexOwnerPermitMaterial,
  type CodexOwnerPermitBindingV1, type CodexOwnerPermitPreparationInputV1 } from "../../harness/codex-v1/owner-permit";
import { ownerApprovalAttestationSchema } from "../../node-policy/v1/schemas";
import type { PinnedApprovalTrustStore } from "../../node-policy/v1/pinned-approval-trust";
import type { SqliteNodeSecurityStateRepository } from "../../node-policy/v1/persistent-security-state";
import { createCodexApprovalIntakeV1 } from "../../harness/codex-v1/approval-intake";
import { codexApprovalPacketDigestV1, enqueueCodexTaskInSession, readCodexApprovalPacketInSession,
  type VerifiedCodexDeliveryAuthorityV1 } from "./codex-task-queue";
import { persistCodexDeliveryEnvelope } from "./codex-delivery-envelope";
import { persistCodexTransmissionIntent } from "./codex-transmission-intent";
import { persistCodexDeliveryReceipt } from "./codex-delivery-receipt";
import { assertCanonicalCodexAdmissionInSession, codexCurrentAdmissionSchemaV1,
  persistCodexActivationTransmissionIntent, readCodexActivationTransmissionIntentInSession,
  type CodexCurrentAdmissionBasisV1, type CodexCurrentAdmissionV1 } from "./codex-activation-transmission-intent";
import { taskProjectAgentOptionsSchema } from "./task-project-agents-wire";
import { scopesOverlapV1 } from "../../project-coordination/v1/resource-conflict";
import { workBatchProposalDigestV1 } from "../../work-intake/v1/digest";
import { workBatchProposalSchemaV1 } from "../../work-intake/v1/schemas";

type CanonicalNativeApproval = ReturnType<typeof prepareNativeTaskApprovalWithLease> & {
  enrollment: NativeEnrollment; preparedAt: string; sourceInputDigest: string; inputDigest: string;
};

const routeSchema = z.object({ nodeId: localId, executorId: localId,
  capabilityProbeId: z.enum(["harness.hermes.native.runs.v1", HERMES_021_MACOS_LOCAL_CAPABILITY_V1, HERMES_LOCAL_CAPABILITY_V1,
    CODEX_APP_SERVER_CAPABILITY, CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1, CLAUDE_CODE_LOCAL_CAPABILITY_V1, CONTROLLER_WORKER_REMOTE_CAPABILITY_V1]),
  maxConcurrentTasks: z.number().int().min(1).max(8), requiredScratchBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  leaseSeconds: z.number().int().min(1).max(300) }).strict();
export type TaskAssignmentRoute = z.infer<typeof routeSchema>;
export type NativeApprovalEnrollment = { enrollment: NativeEnrollment; nodeClass: string };
export type CodexPermitEnrollment = CodexOwnerPermitBindingV1 & {
  approvalKeyId: string;
  approvals: Pick<PinnedApprovalTrustStore, "binding" | "assertAvailable" | "resolveApprovalKey">;
  security: Pick<SqliteNodeSecurityStateRepository, "currentServerTrustRevision">;
};
export type CodexPermitConfiguration = Readonly<{ integrityKey: Uint8Array; enrollments: readonly CodexPermitEnrollment[] }>;
export type WorkBatchAcceptedResultProof = Readonly<{ tenantId: string; projectId: string;
  sourceJobId: string; executionJobId: string; attemptId: string; runId: string; artifactId: string;
  contentHash: string; targetId: string; targetDigest: string; workerId: string; nodeId: string }>;
export type WorkBatchAssignmentAdmissionAuthority = Readonly<{
  integrityKey: Uint8Array;
  assertCurrent: (tx: DatabaseSession, input: Readonly<{ tenantId: string; projectId: string;
    batchId: string; itemId: string; sourceJobId: string; executionJobId: string; workerId: string;
    workerKind: "codex" | "claude-code" | "hermes"; nodeId: string; selectionKey: string; model: string;
    effort: string; provider: string | null; profile: string | null }>) => Promise<void>;
  assertAcceptedResultCurrent: (tx: DatabaseSession, input: WorkBatchAcceptedResultProof) => Promise<void>;
}>;
/** Installation-owned journal access. This is never a browser operation or a
 * worker-provided decision: the private coordinator uses it only after the
 * canonical route has selected a node. */
export type InstallationTransitionAdmissionFence = Readonly<{
  isPausedInSession: (tx: DatabaseSession, tenantId: string, nodeId: string) => Promise<boolean>;
}>;
export function validateNativeApprovalEnrollments(enrollments: readonly NativeApprovalEnrollment[], tenantId: string, routes: readonly TaskAssignmentRoute[]) {
  const snapshot = z.array(z.object({ enrollment: enrollmentSchema, nodeClass: localId }).strict()).max(64).parse(enrollments);
  if (new Set(snapshot.map(e => e.enrollment.nodeId)).size !== snapshot.length
    || snapshot.some(e => e.enrollment.tenantId !== tenantId || !routes.some(r => r.nodeId === e.enrollment.nodeId))) unavailable();
  return snapshot;
}
export function validateTaskAssignmentRoutes(routes: readonly TaskAssignmentRoute[]) {
  const snapshot = z.array(routeSchema).max(64).parse(routes);
  if (new Set(snapshot.map(route => route.nodeId)).size !== snapshot.length) unavailable();
  return Object.freeze(snapshot.map(route => Object.freeze(route)));
}
export type TaskAssignmentOperation = Readonly<{ tenantId: string; workspaceId: string;
  assign: TaskAssignmentCoordinator["assign"]; expire: TaskAssignmentCoordinator["expire"];
  options: TaskAssignmentCoordinator["options"]; projectOptions: TaskAssignmentCoordinator["projectOptions"] }>;
/** A fully rechecked local queue pickup. It is deliberately not a runner input:
 * the private local composition must use it to reconstruct the controller
 * packet before it can ask the Mac-owned policy to admit a Hermes call. */
export type Hermes021LocalQueueDeliveryTarget = Readonly<{
  kind: "hermes-021-local"; nodeId: string; leaseId: string;
  task: Readonly<{ projectId: string; jobId: string; attemptId: string; inputDigest: string }>;
  startsWork: false; grantsExecutionAuthority: false;
}>;
/** Same queue locator shape as the historical route, but this discriminant
 * binds it to the per-build-qualified current Hermes adapter. */
export type HermesLocalQueueDeliveryTarget = Readonly<{
  kind: "hermes-local"; nodeId: string; leaseId: string;
  task: Readonly<{ projectId: string; jobId: string; attemptId: string; inputDigest: string }>;
  startsWork: false; grantsExecutionAuthority: false;
}>;
/** A queue pickup locator for Claude. It intentionally has no task text,
 * process handle, command, workspace, credential or route setting. */
export type ClaudeCodeLocalQueueDeliveryTarget = Readonly<{
  kind: "claude-code-local"; nodeId: string; leaseId: string;
  task: Readonly<{ projectId: string; jobId: string; attemptId: string; inputDigest: string }>;
  startsWork: false; grantsExecutionAuthority: false;
}>;
/** A queue pickup locator for the Mac's managed Codex CLI. It carries only
 * canonical task identity; the protected host reconstructs its fixed local
 * CLI policy immediately before it can execute. */
export type CodexOwnerTrustedLocalQueueDeliveryTarget = Readonly<{
  kind: "codex-owner-trusted-local"; nodeId: string; leaseId: string;
  task: Readonly<{ projectId: string; jobId: string; attemptId: string; inputDigest: string }>;
  startsWork: false; grantsExecutionAuthority: false;
}>;
/** A queue locator for an already-leased remote controller worker.  It has no
 * worker identity, enrollment, session, address, credential, or packet.  The
 * installation-owned materializer reconstructs those facts immediately before
 * a send, from the protected node binding. */
export type RemoteControllerWorkerQueueDeliveryTarget = Readonly<{
  kind: "controller-worker-remote"; nodeId: string; leaseId: string; leaseEpoch: number;
  task: Readonly<{ projectId: string; jobId: string; attemptId: string; inputDigest: string }>;
  startsWork: false; grantsExecutionAuthority: false;
}>;
type LockedAssignmentAuthority = Readonly<{
  actor: Readonly<{ actorId: string; actorType: "human" | "service" }>;
  project: () => Promise<Pick<ProjectView, "lifecycle" | "origin">>;
  commitDeadline: (value: number) => void;
}>;
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } });
function conflict(): never { throw new WebAccessError("conflict"); }
function unavailable(): never { throw new Error("task_assignment_unavailable"); }

/** Trusted control-plane SQL composition. Assignment allocates one bounded canonical lease; it
 * does not sign a command, approve an effect, register a native run or call an executor. */
export class TaskAssignmentCoordinator {
  private readonly routes: readonly TaskAssignmentRoute[];
  private readonly enrollments: readonly NativeApprovalEnrollment[];
  private readonly projects: WebProjectService;
  private readonly codex?: Readonly<{ integrityKey: Uint8Array; enrollments: readonly CodexPermitEnrollment[] }>;
  private readonly workBatchAdmission?: WorkBatchAssignmentAdmissionAuthority;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly planner: TaskExecutionPlanner, routes: readonly TaskAssignmentRoute[],
    private readonly clock: () => number = Date.now, enrollments: readonly NativeApprovalEnrollment[] = [],
    private readonly approvalStore?: NativeApprovalPacketStore,
    private readonly nativeTaskSubmission?: NativeTaskSubmission,
    codex?: CodexPermitConfiguration,
    private readonly transitionAdmission?: InstallationTransitionAdmissionFence,
    workBatchAdmission?: WorkBatchAssignmentAdmissionAuthority) {
    const plannerScope = planner.webOperation();
    if (plannerScope.tenantId !== scope.tenantId || plannerScope.workspaceId !== scope.workspaceId) unavailable();
    this.scope = Object.freeze({ ...scope });
    this.routes = validateTaskAssignmentRoutes(routes);
    this.enrollments = validateNativeApprovalEnrollments(enrollments, scope.tenantId, this.routes);
    if (codex) {
      if (!(codex.integrityKey instanceof Uint8Array) || codex.integrityKey.byteLength !== 32
        || codex.enrollments.length > 64 || new Set(codex.enrollments.map(value => value.nodeId)).size !== codex.enrollments.length) unavailable();
      const values = codex.enrollments.map(value => {
        const { approvalKeyId, approvals, security, ...rawBinding } = value;
        const binding = prepareCodexOwnerPermitBinding(rawBinding);
        if (binding.tenantId !== scope.tenantId || !this.routes.some(route => route.nodeId === binding.nodeId
          && route.capabilityProbeId === CODEX_APP_SERVER_CAPABILITY)) unavailable();
        if (typeof value.approvals?.binding !== "function" || typeof value.approvals?.assertAvailable !== "function"
          || typeof value.approvals?.resolveApprovalKey !== "function" || typeof value.security?.currentServerTrustRevision !== "function") unavailable();
        return Object.freeze({ ...binding, approvalKeyId: localId.parse(approvalKeyId),
          approvals: Object.freeze({ binding: approvals.binding.bind(approvals),
            assertAvailable: approvals.assertAvailable.bind(approvals),
            resolveApprovalKey: approvals.resolveApprovalKey.bind(approvals) }),
          security: Object.freeze({ currentServerTrustRevision: security.currentServerTrustRevision.bind(security) }) });
      });
      this.codex = Object.freeze({ integrityKey: Uint8Array.from(codex.integrityKey), enrollments: Object.freeze(values) });
    }
    this.projects = new WebProjectService(db, scope, clock);
    if (transitionAdmission && typeof transitionAdmission.isPausedInSession !== "function") unavailable();
    if (workBatchAdmission) {
      if (!(workBatchAdmission.integrityKey instanceof Uint8Array) || workBatchAdmission.integrityKey.byteLength !== 32
        || typeof workBatchAdmission.assertCurrent !== "function"
        || typeof workBatchAdmission.assertAcceptedResultCurrent !== "function") unavailable();
      this.workBatchAdmission = Object.freeze({ integrityKey: Uint8Array.from(workBatchAdmission.integrityKey),
        assertCurrent: workBatchAdmission.assertCurrent.bind(workBatchAdmission),
        assertAcceptedResultCurrent: workBatchAdmission.assertAcceptedResultCurrent.bind(workBatchAdmission) });
    }
  }
  /** A bad journal answer is deliberately indistinguishable from ordinary
   * contention. It must not become a fail-open delivery path. */
  private async assertTransitionAdmission(tx: DatabaseSession, nodeId: string): Promise<void> {
    if (!this.transitionAdmission) return;
    try {
      if (await this.transitionAdmission.isPausedInSession(tx, this.scope.tenantId, nodeId)) conflict();
    } catch { conflict(); }
  }
  /** A pipeline row narrows the ordinary assignment path; it is never an
   * assignment authority of its own.  The saved exact selection and every
   * predecessor's canonical accepted result are rechecked under the same
   * transaction that creates the ordinary attempt/lease. */
  private async assertPipelineAdmission(tx: DatabaseSession, job: JobRecord,
    route: TaskAssignmentRoute, attemptWorkerId?: string | null): Promise<boolean> {
    const link = (await tx.query<{ pipeline_run_id: string | null; stage_kind: string | null; stage_ordinal: number | null }>(
      `SELECT pipeline_run_id,stage_kind,stage_ordinal FROM control_jobs WHERE tenant_id=$1 AND id=$2`,
    [this.scope.tenantId, job.id])).rows[0];
    if (!link?.pipeline_run_id) return false;
    if (link.stage_kind === null || link.stage_ordinal === null || !this.workBatchAdmission) conflict();
    const stage = (await tx.query<{ project_id: string; current_job_id: string; stage_kind: string; stage_ordinal: number;
      role: string; worker_id: string; worker_kind: "codex" | "claude-code" | "hermes"; node_id: string; selection_key: string; model: string;
      effort: string; provider: string | null; profile: string | null; state: string; max_loops: number;
      allowed_paths: unknown | null; maximum_changed_files: number | null; maximum_changed_bytes: number | null;
      handoff_from_result_digest: string | null; signoff_review_id: string | null; started_at: string | Date | null;
      finished_at: string | Date | null; record_digest: string; auth_tag: string; version: number }>(`SELECT project_id,
        current_job_id,stage_kind,stage_ordinal,role,worker_id,worker_kind,node_id,selection_key,model,effort,provider,
        profile,state,max_loops,allowed_paths,maximum_changed_files,maximum_changed_bytes,handoff_from_result_digest,
        signoff_review_id,started_at,finished_at,record_digest,auth_tag,version
      FROM pipeline_stage_runs WHERE tenant_id=$1 AND pipeline_run_id=$2 AND stage_ordinal=$3 FOR SHARE`,
    [this.scope.tenantId, link.pipeline_run_id, Number(link.stage_ordinal)])).rows[0];
    if (!stage || stage.project_id !== job.projectId || stage.stage_kind !== link.stage_kind
      || stage.worker_id !== route.executorId || stage.node_id !== route.nodeId
      || attemptWorkerId !== undefined && attemptWorkerId !== stage.worker_id) conflict();
    const plan = (await tx.query<{ source_job_id: string }>(`SELECT source_job_id FROM control_task_execution_plans
      WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3 FOR SHARE`,
    [this.scope.tenantId, job.projectId, job.id])).rows[0];
    if (!plan || plan.source_job_id !== stage.current_job_id) conflict();
    const selection = (await tx.query<{ worker_kind: string | null; selection_key: string | null; model: string | null;
      effort: string | null; provider: string | null; profile: string | null }>(`SELECT worker_kind,selection_key,model,
        effort,provider,profile FROM control_task_model_selections WHERE tenant_id=$1 AND job_id=$2 FOR SHARE`,
    [this.scope.tenantId, job.id])).rows[0];
    if (!selection || selection.worker_kind !== stage.worker_kind || selection.selection_key !== stage.selection_key
      || selection.model !== stage.model || selection.effort !== stage.effort
      || selection.provider !== stage.provider || selection.profile !== stage.profile) conflict();
    const material = { id: `${link.pipeline_run_id}:stage:${Number(stage.stage_ordinal)}`, tenantId: this.scope.tenantId,
      projectId: stage.project_id, pipelineRunId: link.pipeline_run_id, stageOrdinal: Number(stage.stage_ordinal),
      stageKind: stage.stage_kind, role: stage.role, workerId: stage.worker_id, workerKind: stage.worker_kind,
      nodeId: stage.node_id, selectionKey: stage.selection_key, model: stage.model, effort: stage.effort,
      provider: stage.provider, profile: stage.profile, currentJobId: stage.current_job_id,
      currentAttemptId: null, currentLeaseId: null, state: stage.state, maxLoops: Number(stage.max_loops),
      allowedPaths: stage.stage_kind === "build" ? stage.allowed_paths : null,
      maximumChangedFiles: stage.stage_kind === "build" ? Number(stage.maximum_changed_files) : null,
      maximumChangedBytes: stage.stage_kind === "build" ? Number(stage.maximum_changed_bytes) : null,
      handoffFromResultDigest: stage.handoff_from_result_digest, signoffReviewId: stage.signoff_review_id,
      startedAt: stage.started_at ? new Date(stage.started_at).toISOString() : null,
      finishedAt: stage.finished_at ? new Date(stage.finished_at).toISOString() : null, version: Number(stage.version) };
    const expected = Buffer.from(hmacSha256Tag(this.workBatchAdmission.integrityKey,
      { purpose: "pipeline-stage-run/v1", record: material })), actual = Buffer.from(stage.auth_tag);
    if (sha256Digest(material) !== stage.record_digest || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      const { allowedPaths: _paths, maximumChangedFiles: _files, maximumChangedBytes: _bytes, ...legacy } = material;
      const legacyExpected = Buffer.from(hmacSha256Tag(this.workBatchAdmission.integrityKey,
        { purpose: "pipeline-stage-run/v1", record: legacy }));
      if (stage.allowed_paths !== null || stage.maximum_changed_files !== null || stage.maximum_changed_bytes !== null
        || sha256Digest(legacy) !== stage.record_digest || legacyExpected.length !== actual.length
        || !timingSafeEqual(legacyExpected, actual)) conflict();
    }
    try {
      await this.workBatchAdmission.assertCurrent(tx, { tenantId: this.scope.tenantId, projectId: job.projectId,
        batchId: link.pipeline_run_id, itemId: `${link.pipeline_run_id}:stage:${Number(stage.stage_ordinal)}`,
        sourceJobId: stage.current_job_id, executionJobId: job.id, workerId: stage.worker_id, workerKind: stage.worker_kind,
        nodeId: stage.node_id, selectionKey: stage.selection_key, model: stage.model, effort: stage.effort,
        provider: stage.provider, profile: stage.profile });
    } catch { conflict(); }
    const dependencies = (await tx.query<{ depends_on_job_id: string }>(`SELECT depends_on_job_id
      FROM control_job_dependencies WHERE tenant_id=$1 AND job_id=$2 ORDER BY depends_on_job_id FOR SHARE`,
    [this.scope.tenantId, stage.current_job_id])).rows;
    if (Number(stage.stage_ordinal) === 0) {
      if (dependencies.length !== 0) conflict();
      return true;
    }
    const predecessor = (await tx.query<{ current_job_id: string; worker_id: string; node_id: string }>(`SELECT current_job_id,
        worker_id,node_id FROM pipeline_stage_runs WHERE tenant_id=$1 AND pipeline_run_id=$2 AND stage_ordinal=$3 FOR SHARE`,
    [this.scope.tenantId, link.pipeline_run_id, Number(stage.stage_ordinal) - 1])).rows[0];
    if (!predecessor || dependencies.length !== 1 || dependencies[0]?.depends_on_job_id !== predecessor.current_job_id) conflict();
    const proof = (await tx.query<WorkBatchAcceptedResultProof>(`SELECT completed.project_id AS "projectId",
        p.source_job_id AS "sourceJobId",completed.id AS "executionJobId",attempt.id AS "attemptId",
        artifact.run_id AS "runId",artifact.artifact_id AS "artifactId",artifact.receipt->>'contentHash' AS "contentHash",
        review.plan->>'targetId' AS "targetId",transition.safe_metadata->'receipt'->>'targetDigest' AS "targetDigest",
        attempt.worker_id AS "workerId",attempt.node_id AS "nodeId",completed.tenant_id AS "tenantId"
      FROM control_task_execution_plans p JOIN control_jobs completed ON completed.tenant_id=p.tenant_id AND completed.id=p.job_id
      JOIN control_attempts attempt ON attempt.tenant_id=completed.tenant_id AND attempt.job_id=completed.id AND attempt.state='succeeded'
        AND attempt.worker_id=$3 AND attempt.node_id=$4
      JOIN control_native_artifact_receipts artifact ON artifact.tenant_id=attempt.tenant_id AND artifact.job_id=attempt.job_id
        AND artifact.attempt_id=attempt.id
      JOIN control_artifact_manifests manifest ON manifest.tenant_id=artifact.tenant_id AND manifest.id=artifact.artifact_id
        AND manifest.job_id=artifact.job_id AND manifest.attempt_id=artifact.attempt_id
        AND manifest.content_hash=artifact.receipt->>'contentHash' AND manifest.state IN ('uploaded','verified')
      JOIN control_native_review_plans review ON review.tenant_id=artifact.tenant_id AND review.project_id=artifact.project_id
        AND review.job_id=artifact.job_id AND review.run_id=artifact.run_id
      JOIN control_transition_events transition ON transition.tenant_id=completed.tenant_id AND transition.entity_kind='job'
        AND transition.entity_id=completed.id AND transition.to_state='succeeded'
        AND transition.idempotency_key LIKE 'native-completion:%:job'
      WHERE p.tenant_id=$1 AND p.source_job_id=$2 AND completed.state='succeeded'
        AND transition.safe_metadata->'receipt'->>'artifactId'=artifact.artifact_id
        AND transition.safe_metadata->'receipt'->>'contentHash'=artifact.receipt->>'contentHash'
      ORDER BY attempt.attempt_number DESC LIMIT 1`, [this.scope.tenantId, predecessor.current_job_id,
        predecessor.worker_id, predecessor.node_id])).rows[0];
    if (!proof?.contentHash || !proof.targetId || !proof.targetDigest) conflict();
    try { await this.workBatchAdmission.assertAcceptedResultCurrent(tx, proof); } catch { conflict(); }
    return true;
  }
  /** Work-batch admission is an additional fail-closed constraint on the
   * ordinary canonical assignment/queue path, never a second assignment
   * authority.  A batch job may use its dependency edges only when this
   * append-only record still names the exact route and saved model choice and
   * every predecessor has a retained native result accepted by the canonical
   * completion transition. */
  private async assertWorkBatchQueueAdmission(tx: DatabaseSession, job: JobRecord,
    route: TaskAssignmentRoute, attemptWorkerId?: string | null): Promise<boolean> {
    if (await this.assertPipelineAdmission(tx, job, route, attemptWorkerId)) return true;
    type GateRow = { item_id: string; batch_id: string; source_job_id: string; worker_id: string | null;
      node_id: string | null; queue_position: string | number | null; worker_kind: "codex" | "claude-code" | "hermes" | null;
      selection_key: string | null; model: string | null; effort: string | null; provider: string | null; profile: string | null;
      admission_id: string | null; assignment_revision: string | number | null; supersedes_admission_id: string | null;
      change_reason_code: string | null; authorized_by_identity_id: string | null;
      admission_digest: string | null; admission_auth_tag: string | null; admitted_at: string | Date | null;
      batch_state: string; approval_identity_id: string | null; approved_at: string | Date | null;
      decision_reason_code: string | null; decision_digest: string | null; decision_auth_tag: string | null;
      batch_version: string | number; batch_project_id: string; proposed_by_identity_id: string; proposed_at: string | Date;
      proposal: unknown; queue_depth_limit: number; batch_digest: string; batch_auth_tag: string;
      batch_created_at: string | Date; batch_updated_at: string | Date;
      item_batch_revision: string | number; local_id: string; ordinal: number; role: "builder" | "checker" | "validator";
      required_capability: string; depends_on_local_ids: string[]; requested_worker_id: string | null;
      requested_worker_kind: string | null; requested_model_key: string | null; acceptance_criteria: string;
      acceptance_tests: string; decision_state: string; item_decision_reason_code: string | null;
      job_attempt_count: number; item_digest: string; item_auth_tag: string; item_created_at: string | Date };
    const linked = (await tx.query<GateRow>(`SELECT item.id AS item_id,item.batch_id,item.job_id AS source_job_id,
        admission.worker_id,admission.node_id,admission.queue_position,admission.worker_kind,admission.selection_key,
        admission.model,admission.effort,admission.provider,admission.profile,admission.admission_id,
        admission.assignment_revision,admission.supersedes_admission_id,admission.change_reason_code,
        admission.authorized_by_identity_id,admission.admission_digest,
        admission.auth_tag AS admission_auth_tag,admission.admitted_at,
        batch.state AS batch_state,batch.approval_identity_id,batch.approved_at,batch.decision_reason_code,
        batch.decision_digest,batch.decision_auth_tag,batch.version AS batch_version,batch.project_id AS batch_project_id,
        batch.proposed_by_identity_id,batch.proposed_at,batch.proposal,batch.queue_depth_limit,batch.batch_digest,
        batch.auth_tag AS batch_auth_tag,batch.created_at AS batch_created_at,batch.updated_at AS batch_updated_at,
        item.batch_revision AS item_batch_revision,item.local_id,item.ordinal,item.role,item.required_capability,
        item.depends_on_local_ids,item.requested_worker_id,item.requested_worker_kind,item.requested_model_key,
        item.acceptance_criteria,item.acceptance_tests,item.decision_state,
        item.decision_reason_code AS item_decision_reason_code,item.job_attempt_count,item.item_digest,
        item.auth_tag AS item_auth_tag,item.created_at AS item_created_at
      FROM work_batch_items item JOIN work_batches batch
        ON batch.tenant_id=item.tenant_id AND batch.id=item.batch_id AND batch.project_id=item.project_id
      LEFT JOIN work_batch_effective_queue_admissions admission
        ON admission.tenant_id=item.tenant_id AND admission.item_id=item.id AND admission.job_id=item.job_id
      LEFT JOIN control_task_execution_plans plan
        ON plan.tenant_id=item.tenant_id AND plan.source_job_id=item.job_id AND plan.job_id=$2::text
      WHERE item.tenant_id=$1 AND (item.job_id=$2::text OR plan.job_id=$2::text)`,
    [this.scope.tenantId, job.id])).rows[0];
    if (!linked) return false;
    const authority = this.workBatchAdmission;
    if (!authority || !linked.worker_id || !linked.node_id || linked.queue_position === null || !linked.worker_kind
      || !linked.selection_key || !linked.model || !linked.effort || !linked.admission_digest
      || !linked.admission_auth_tag || !linked.admitted_at) conflict();
    const same = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right);
      return a.length === b.length && timingSafeEqual(a, b); };
    const iso = (value: string | Date) => new Date(value).toISOString();
    const proposal = workBatchProposalSchemaV1.safeParse(linked.proposal);
    const batchMaterial = proposal.success ? { id: linked.batch_id, tenantId: this.scope.tenantId,
      projectId: linked.batch_project_id, proposedByIdentityId: linked.proposed_by_identity_id,
      proposedAt: iso(linked.proposed_at), state: "proposed", proposal: proposal.data,
      queueDepthLimit: Number(linked.queue_depth_limit), batchDigest: linked.batch_digest,
      version: 1, createdAt: iso(linked.batch_created_at), updatedAt: iso(linked.batch_created_at) } : undefined;
    const allItems = (await tx.query<{ item_digest: string }>(`SELECT item_digest FROM work_batch_items
      WHERE tenant_id=$1 AND batch_id=$2 ORDER BY ordinal`, [this.scope.tenantId, linked.batch_id])).rows;
    const decisionMaterial = { id: `${linked.batch_id}:decision`, tenantId: this.scope.tenantId,
      batchId: linked.batch_id, projectId: linked.batch_project_id, batchRevision: Number(linked.batch_version),
      state: linked.batch_state, approvalIdentityId: linked.approval_identity_id, approvedAt: linked.approved_at ? iso(linked.approved_at) : null,
      decisionReasonCode: linked.decision_reason_code, itemDigests: allItems.map(item => item.item_digest) };
    const itemMaterial = { id: linked.item_id, tenantId: this.scope.tenantId, batchId: linked.batch_id,
      batchRevision: Number(linked.item_batch_revision), projectId: linked.batch_project_id, localId: linked.local_id,
      ordinal: Number(linked.ordinal), role: linked.role, requiredCapability: linked.required_capability,
      dependsOnLocalIds: linked.depends_on_local_ids,
      ...(linked.requested_worker_id ? { requestedWorkerId: linked.requested_worker_id } : {}),
      requestedWorkerKind: linked.requested_worker_kind, requestedModelKey: linked.requested_model_key,
      acceptanceCriteria: linked.acceptance_criteria, acceptanceTests: linked.acceptance_tests,
      decisionState: linked.decision_state, decisionReasonCode: linked.item_decision_reason_code,
      jobId: linked.source_job_id, jobAttemptCount: Number(linked.job_attempt_count), createdAt: iso(linked.item_created_at) };
    const admissionMaterial = { itemId: linked.item_id, batchId: linked.batch_id, projectId: linked.batch_project_id,
      jobId: linked.source_job_id, workerId: linked.worker_id, workerKind: linked.worker_kind, nodeId: linked.node_id,
      position: Number(linked.queue_position), queueDepthLimit: Number(linked.queue_depth_limit),
      selectionKey: linked.selection_key, model: linked.model, effort: linked.effort,
      provider: linked.provider, profile: linked.profile, assignmentRevision: Number(linked.assignment_revision),
      supersedesAdmissionId: linked.supersedes_admission_id, changeReasonCode: linked.change_reason_code,
      authorizedByIdentityId: linked.authorized_by_identity_id, admittedAt: iso(linked.admitted_at) };
    if (!batchMaterial || linked.batch_state !== "approved" && linked.batch_state !== "partially_approved"
      || linked.decision_state !== "approved" || Number(linked.item_batch_revision) !== Number(linked.batch_version)
      || workBatchProposalDigestV1(proposal.data) !== linked.batch_digest
      || !same(hmacSha256Tag(authority.integrityKey, { purpose: "work-batch/v1", record: batchMaterial }), linked.batch_auth_tag)
      || sha256Digest(itemMaterial) !== linked.item_digest
      || !same(hmacSha256Tag(authority.integrityKey, { purpose: "work-batch-item/v1", record: itemMaterial }), linked.item_auth_tag)
      || !linked.approval_identity_id || !linked.approved_at || !linked.decision_digest || !linked.decision_auth_tag
      || sha256Digest(decisionMaterial) !== linked.decision_digest
      || !same(hmacSha256Tag(authority.integrityKey, { purpose: "work-batch-decision/v1", record: decisionMaterial }), linked.decision_auth_tag)
      || sha256Digest(admissionMaterial) !== linked.admission_digest
      || linked.admission_id !== `admission:${linked.admission_digest.slice(7)}`
      || !same(hmacSha256Tag(authority.integrityKey, { purpose: "work-batch-queue-admission/v1", record: admissionMaterial }), linked.admission_auth_tag)) conflict();
    const admission = linked;
    if (admission.worker_id !== route.executorId || admission.node_id !== route.nodeId
      || attemptWorkerId !== undefined && attemptWorkerId !== route.executorId) conflict();
    const selection = (await tx.query<{ worker_kind: string | null; selection_key: string | null;
      model: string | null; effort: string | null; provider: string | null; profile: string | null }>(
      `SELECT worker_kind,selection_key,model,effort,provider,profile
       FROM control_task_model_selections WHERE tenant_id=$1 AND job_id=$2 FOR SHARE`,
    [this.scope.tenantId, job.id])).rows[0];
    if (!selection || selection.worker_kind !== admission.worker_kind
      || selection.selection_key !== admission.selection_key || selection.model !== admission.model
      || selection.effort !== admission.effort || selection.provider !== admission.provider
      || selection.profile !== admission.profile) conflict();
    try {
      await authority.assertCurrent(tx, { tenantId: this.scope.tenantId, projectId: job.projectId,
        batchId: linked.batch_id, itemId: linked.item_id, sourceJobId: linked.source_job_id, executionJobId: job.id,
        workerId: admission.worker_id!, workerKind: admission.worker_kind!, nodeId: admission.node_id!,
        selectionKey: admission.selection_key!, model: admission.model!, effort: admission.effort!,
        provider: admission.provider, profile: admission.profile });
    } catch { conflict(); }
    const predecessors = (await tx.query<{ job_id: string }>(`SELECT predecessor.job_id FROM (
        SELECT d.depends_on_job_id AS job_id
        FROM control_job_dependencies d
        WHERE d.tenant_id=$1 AND d.job_id=$4
        UNION
        SELECT prior.job_id
        FROM work_batch_effective_queue_admissions prior
        WHERE prior.tenant_id=$1 AND prior.worker_id=$2 AND prior.queue_position<$3
      ) predecessor ORDER BY predecessor.job_id`, [this.scope.tenantId, admission.worker_id,
        Number(admission.queue_position), admission.source_job_id])).rows;
    for (const predecessor of predecessors) {
      const priorAdmission = (await tx.query<{ admission_id: string; item_id: string; batch_id: string;
        project_id: string; job_id: string; worker_id: string; worker_kind: string; node_id: string;
        queue_position: string | number; queue_depth_limit: number; selection_key: string; model: string;
        effort: string; provider: string | null; profile: string | null; assignment_revision: string | number;
        supersedes_admission_id: string | null; change_reason_code: string; authorized_by_identity_id: string;
        admission_digest: string; auth_tag: string; admitted_at: string | Date }>(`SELECT *
        FROM work_batch_effective_queue_admissions WHERE tenant_id=$1 AND job_id=$2`,
      [this.scope.tenantId, predecessor.job_id])).rows[0];
      if (!priorAdmission) conflict();
      const priorMaterial = { itemId: priorAdmission.item_id, batchId: priorAdmission.batch_id,
        projectId: priorAdmission.project_id, jobId: priorAdmission.job_id, workerId: priorAdmission.worker_id,
        workerKind: priorAdmission.worker_kind, nodeId: priorAdmission.node_id,
        position: Number(priorAdmission.queue_position), queueDepthLimit: Number(priorAdmission.queue_depth_limit),
        selectionKey: priorAdmission.selection_key, model: priorAdmission.model, effort: priorAdmission.effort,
        provider: priorAdmission.provider, profile: priorAdmission.profile,
        assignmentRevision: Number(priorAdmission.assignment_revision),
        supersedesAdmissionId: priorAdmission.supersedes_admission_id, changeReasonCode: priorAdmission.change_reason_code,
        authorizedByIdentityId: priorAdmission.authorized_by_identity_id, admittedAt: iso(priorAdmission.admitted_at) };
      if (sha256Digest(priorMaterial) !== priorAdmission.admission_digest
        || priorAdmission.admission_id !== `admission:${priorAdmission.admission_digest.slice(7)}`
        || !same(hmacSha256Tag(authority.integrityKey,
          { purpose: "work-batch-queue-admission/v1", record: priorMaterial }), priorAdmission.auth_tag)) conflict();
      const proof = (await tx.query<WorkBatchAcceptedResultProof>(`SELECT completed.project_id AS "projectId",
          prior.job_id AS "sourceJobId",completed.id AS "executionJobId",attempt.id AS "attemptId",
          artifact.run_id AS "runId",artifact.artifact_id AS "artifactId",artifact.receipt->>'contentHash' AS "contentHash",
          review.plan->>'targetId' AS "targetId",transition.safe_metadata->'receipt'->>'targetDigest' AS "targetDigest",
          prior.worker_id AS "workerId",prior.node_id AS "nodeId",completed.tenant_id AS "tenantId"
        FROM work_batch_effective_queue_admissions prior
        JOIN control_task_execution_plans completed_plan ON completed_plan.tenant_id=prior.tenant_id
          AND completed_plan.source_job_id=prior.job_id
        JOIN control_jobs completed ON completed.tenant_id=completed_plan.tenant_id AND completed.id=completed_plan.job_id
          AND completed.state='succeeded'
        JOIN control_attempts attempt ON attempt.tenant_id=completed.tenant_id AND attempt.job_id=completed.id
          AND attempt.state='succeeded' AND attempt.worker_id=prior.worker_id AND attempt.node_id=prior.node_id
        JOIN control_native_artifact_receipts artifact ON artifact.tenant_id=attempt.tenant_id
          AND artifact.project_id=completed.project_id AND artifact.job_id=completed.id AND artifact.attempt_id=attempt.id
        JOIN control_artifact_manifests manifest ON manifest.tenant_id=artifact.tenant_id
          AND manifest.id=artifact.artifact_id AND manifest.project_id=artifact.project_id
          AND manifest.job_id=artifact.job_id AND manifest.attempt_id=artifact.attempt_id
          AND manifest.content_hash=artifact.receipt->>'contentHash' AND manifest.state IN ('uploaded','verified')
        JOIN control_native_review_plans review ON review.tenant_id=artifact.tenant_id
          AND review.project_id=artifact.project_id AND review.job_id=artifact.job_id AND review.run_id=artifact.run_id
        JOIN control_transition_events transition ON transition.tenant_id=completed.tenant_id
          AND transition.entity_kind='job' AND transition.entity_id=completed.id AND transition.to_state='succeeded'
          AND transition.idempotency_key LIKE 'native-completion:%:job'
        WHERE prior.tenant_id=$1 AND prior.job_id=$2
          AND artifact.receipt->>'artifactId'=artifact.artifact_id AND artifact.receipt->>'runId'=artifact.run_id
          AND artifact.receipt->>'jobId'=artifact.job_id AND artifact.receipt->>'attemptId'=artifact.attempt_id
          AND transition.safe_metadata->'receipt'->>'artifactId'=artifact.artifact_id
          AND transition.safe_metadata->'receipt'->>'runId'=artifact.run_id
          AND transition.safe_metadata->'receipt'->>'jobId'=artifact.job_id
          AND transition.safe_metadata->'receipt'->>'attemptId'=artifact.attempt_id
          AND transition.safe_metadata->'receipt'->>'contentHash'=artifact.receipt->>'contentHash'
        ORDER BY attempt.attempt_number DESC LIMIT 1`, [this.scope.tenantId, predecessor.job_id])).rows[0];
      if (!proof || !proof.contentHash || !proof.targetId || !proof.targetDigest) conflict();
      try { await authority.assertAcceptedResultCurrent(tx, proof); } catch { conflict(); }
    }
    return true;
  }
  webOperation(): TaskAssignmentOperation {
    return Object.freeze({ ...this.scope, assign: this.assign.bind(this), expire: this.expire.bind(this),
      options: this.options.bind(this), projectOptions: this.projectOptions.bind(this) });
  }
  /** Trusted owner-review loader. It reconstructs one unsigned Codex permit from
   * locked canonical state and configured machine bindings. It is not a browser
   * operation and does not sign, queue, create a workspace, or start Codex. */
  async prepareCodexOwnerPermit(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    return this.withCodexPermit(identity, projectId, jobId, expectedInputDigest, undefined,
      async (_tx, prepared, assertCurrent) => ({ value: Object.freeze({ input: prepared,
        review: describeCodexOwnerPermitReview(prepared), assertCurrent, startsWork: false as const,
        grantsExecutionAuthority: false as const }) }));
  }
  /** Trusted signed-permit intake. Rebuilds the same material from canonical
   * state, verifies current owner trust, then writes the existing shared queue
   * intent. It never transmits the intent or starts work. */
  async enqueueCodexTask(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string,
    permitValue: unknown, signal: AbortSignal) {
    if (!(signal instanceof AbortSignal) || signal.aborted) conflict();
    const permit = ownerApprovalAttestationSchema.parse(permitValue), issuedAt = Date.parse(permit.body.issuedAt);
    return this.withCodexPermit(identity, projectId, jobId, expectedInputDigest,
      { issuedAt, approvalNonce: permit.body.nonce, approvalKeyId: permit.body.approvalKeyId }, async (tx, prepared, assertCurrent, actorId, configured) => {
        const material = prepareCodexOwnerPermitMaterial(prepared), body = codexTaskDispatchBodySchemaV1.parse({
          schema: "control-room.codex-task-dispatch/v1",
          queueId: `native-queue:${sha256Digest({ tenantId: material.start.tenantId, jobId: material.start.jobId,
            attemptId: material.start.attemptId }).slice(7)}`,
          start: material.start, request: material.request, permit, permitDigest: sha256Digest(permit),
        });
        const verified = await createCodexApprovalIntakeV1({ body, expectedEnrollmentDigest: configured.enrollmentDigest,
          expectedConnectorProfileDigest: configured.connectorProfileDigest,
          expectedWorkspaceIntentDigest: configured.workspaceIntentDigest }, { approvals: configured.approvals,
          security: configured.security, clock: this.clock })(signal);
        if (signal.aborted) conflict(); assertCurrent(); verified.assertFresh();
        const queued = await enqueueCodexTaskInSession(tx, this.codex!.integrityKey, body, verified, actorId, this.clock());
        if (!queued.receipt.replayed && this.nativeTaskSubmission) await this.nativeTaskSubmission.enqueueInSession(tx, {
          schema: "control-room.native-task-submission/v1", tenantId: this.scope.tenantId, projectId,
          jobId, attemptId: queued.receipt.attemptId, queueId: queued.receipt.queueId,
          inputDigest: expectedInputDigest, packetDigest: queued.receipt.packetDigest,
        });
        if (!queued.receipt.replayed) await appendAuditWith(tx, {
          id: `audit:codex:${queued.receipt.queueId}`, tenantId: this.scope.tenantId, actorId, actorType: "human",
          action: "codex.task.queued", targetType: "job", targetId: jobId, correlationId: queued.receipt.queueId,
          idempotencyKey: `codex:${queued.receipt.queueId}`, safeMetadata: { packetDigest: queued.receipt.packetDigest },
          occurredAt: queued.receipt.queuedAt,
        });
        return { value: Object.freeze({ ...queued.receipt, startsWork: false as const,
          grantsExecutionAuthority: false as const }), assertFresh: () => {
            if (signal.aborted) conflict(); assertCurrent(); verified.assertFresh();
          } };
      });
  }
  /** Trusted shared-queue lookup. Harness kind is proved from the locked job and v3 plan. */
  async locateApprovedCodexQueueDelivery(input: NativeTaskSubmissionReference, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted
      || ref.tenantId !== this.scope.tenantId) conflict();
    return this.withCodexPermit(undefined, ref.projectId, ref.jobId, ref.inputDigest, undefined,
      async (_tx, _prepared, assertCurrent, _actorId, _configured, _nodeKeyId, _deadline, queued) => {
        if (!queued || queued.body.start.attemptId !== ref.attemptId) conflict();
        assertCurrent(); queued.authority.assertFresh();
        return { value: Object.freeze({ kind: "codex" as const, nodeId: queued.body.start.nodeId,
          task: Object.freeze({ projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId,
            inputDigest: ref.inputDigest }), startsWork: false as const }),
          assertFresh: () => { assertCurrent(); queued.authority.assertFresh(); } };
      }, { reference: ref, signal });
  }
  /**
   * Protected, non-executing current-admission read for an already activated
   * Codex queue.  The native reference remains only a locator: this repeats
   * the complete owner/pin/route/profile/lease fence in `withCodexPermit`
   * before returning evidence.  It cannot send, launch, or grant execution.
   */
  async readCurrentCodexQueuedAdmission(input: NativeTaskSubmissionReference, expected: {
    queueId: string; nodeId: string; packetDigest: string; activationFrameDigest: string; currentAdmissionDigest: string;
  }, signal: AbortSignal): Promise<Readonly<{
    currentAdmission: CodexCurrentAdmissionV1; activationFrameDigest: string;
    startsWork: false; grantsExecutionAuthority: false;
  }>> {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    digestSchema.parse(expected.packetDigest); digestSchema.parse(expected.activationFrameDigest);
    digestSchema.parse(expected.currentAdmissionDigest); localId.parse(expected.queueId); localId.parse(expected.nodeId);
    if (!this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted
      || ref.tenantId !== this.scope.tenantId || ref.packetDigest !== expected.packetDigest) conflict();
    return this.withCodexPermit(undefined, ref.projectId, ref.jobId, ref.inputDigest, undefined,
      async (tx, _prepared, assertCurrent, _actorId, _configured, _nodeKeyId, _deadline, queued, basis) => {
        if (!queued || !basis || queued.body.queueId !== expected.queueId || queued.body.start.nodeId !== expected.nodeId
          || queued.body.start.attemptId !== ref.attemptId || codexApprovalPacketDigestV1(queued.body) !== expected.packetDigest) conflict();
        const scope = { tenantId: ref.tenantId, projectId: ref.projectId, jobId: ref.jobId,
          attemptId: ref.attemptId, inputDigest: ref.inputDigest };
        const saved = await readCodexActivationTransmissionIntentInSession(tx, this.codex!.integrityKey, scope);
        if (!saved || saved.currentAdmission.queueId !== expected.queueId
          || saved.currentAdmission.nodeId !== expected.nodeId
          || sha256Digest(saved.frame) !== expected.activationFrameDigest
          || sha256Digest(saved.currentAdmission) !== expected.currentAdmissionDigest
          || saved.frame.body.currentAdmissionDigest !== expected.currentAdmissionDigest) conflict();
        await assertCanonicalCodexAdmissionInSession(tx, saved.currentAdmission);
        // `checkedAt` is intentionally fresh for this read. Every authority-bearing
        // field must otherwise be exactly the current withCodexPermit snapshot.
        const currentBasis = (value: CodexCurrentAdmissionV1 | CodexCurrentAdmissionBasisV1) => ({
          schema: value.schema, tenantId: value.tenantId, projectId: value.projectId, projectVersion: value.projectVersion,
          projectLifecycle: value.projectLifecycle, jobId: value.jobId, jobVersion: value.jobVersion,
          jobState: value.jobState, attemptId: value.attemptId, attemptVersion: value.attemptVersion,
          attemptState: value.attemptState, leaseId: value.leaseId, leaseVersion: value.leaseVersion,
          leaseEpoch: value.leaseEpoch, leaseState: value.leaseState, leaseExpiresAt: value.leaseExpiresAt,
          nodeId: value.nodeId, nodeVersion: value.nodeVersion, nodeState: value.nodeState,
          nodeKeyId: value.nodeKeyId, nodeKeyState: value.nodeKeyState, nodeKeyValidFrom: value.nodeKeyValidFrom,
          nodeKeyValidUntil: value.nodeKeyValidUntil, authorityDigest: value.authorityDigest,
          authorityExpiresAt: value.authorityExpiresAt, approvalKeyId: value.approvalKeyId,
          ownerTrustRevisionDigest: value.ownerTrustRevisionDigest, configurationExpiresAt: value.configurationExpiresAt,
          admissionExpiresAt: value.admissionExpiresAt,
        });
        if (sha256Digest(currentBasis(saved.currentAdmission)) !== sha256Digest(currentBasis(basis))
          || saved.currentAdmission.permitDigest !== queued.body.permitDigest
          || saved.currentAdmission.inputDigest !== queued.body.start.inputDigest
          || saved.currentAdmission.operationDigest !== queued.body.start.operationDigest
          || saved.currentAdmission.effectClaimKey !== queued.body.start.effectClaimKey
          || saved.currentAdmission.enrollmentDigest !== queued.body.start.enrollmentDigest
          || saved.currentAdmission.connectorProfileDigest !== queued.body.start.connectorProfileDigest
          || saved.currentAdmission.workspaceIntentDigest !== queued.body.start.workspaceIntentDigest) conflict();
        assertCurrent(); queued.authority.assertFresh();
        const result = Object.freeze({ currentAdmission: saved.currentAdmission,
          activationFrameDigest: expected.activationFrameDigest, startsWork: false as const,
          grantsExecutionAuthority: false as const });
        return { value: result, assertFresh: () => { assertCurrent(); queued.authority.assertFresh(); } };
      }, { reference: ref, signal });
  }
  /** Trusted shared-queue discriminator. The queue reference is only a locator:
   * the selected harness path performs the complete canonical authority check. */
  async locateQueuedHarnessDelivery(input: NativeTaskSubmissionReference, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted
      || ref.tenantId !== this.scope.tenantId) conflict();
    const kind = await this.db.transaction(async tx => {
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, ref.projectId]);
      const job = await this.job(tx, ref.projectId, ref.jobId);
      const plan = await this.planner.readInSession(tx, ref.jobId);
      if (!plan || plan.tenantId !== ref.tenantId || plan.projectId !== ref.projectId
        || job.inputDigest !== ref.inputDigest || signal.aborted) conflict();
      if (job.jobType === CODEX_APP_SERVER_JOB_TYPE
        && (plan.schema === "control-room.task-execution-plan/v3" || plan.schema === "control-room.task-execution-plan/v4")) return "codex" as const;
      if (job.jobType === CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1
        && (plan.schema === "control-room.task-execution-plan/v13" || plan.schema === "control-room.task-execution-plan/v14")) return "codex-owner-trusted-local" as const;
      if (job.jobType === HERMES_021_MACOS_LOCAL_JOB_TYPE_V1
        && (plan.schema === "control-room.task-execution-plan/v5" || plan.schema === "control-room.task-execution-plan/v6"
          || plan.schema === "control-room.task-execution-plan/v7" || plan.schema === "control-room.task-execution-plan/v8")) return "hermes-021-local" as const;
      if (job.jobType === HERMES_LOCAL_JOB_TYPE_V1
        && (plan.schema === "control-room.task-execution-plan/v15" || plan.schema === "control-room.task-execution-plan/v16")) return "hermes-local" as const;
      if (job.jobType === CLAUDE_CODE_LOCAL_JOB_TYPE_V1
        && (plan.schema === "control-room.task-execution-plan/v9" || plan.schema === "control-room.task-execution-plan/v10")) return "claude-code-local" as const;
      if (job.jobType === "harness.hermes.native.task"
        && (plan.schema === "control-room.task-execution-plan/v1" || plan.schema === "control-room.task-execution-plan/v2")) return "hermes" as const;
      return conflict();
    });
    if (signal.aborted) conflict();
    if (kind === "codex") return this.locateApprovedCodexQueueDelivery(ref, signal);
    if (kind === "codex-owner-trusted-local") return this.locateApprovedCodexOwnerTrustedLocalQueueDelivery(ref, signal);
    if (kind === "hermes-021-local") return this.locateApprovedHermes021LocalQueueDelivery(ref, signal);
    if (kind === "hermes-local") return this.locateApprovedHermesLocalQueueDelivery(ref, signal);
    if (kind === "claude-code-local") return this.locateApprovedClaudeCodeLocalQueueDelivery(ref, signal);
    const target = await this.locateApprovedQueueDelivery(ref, signal);
    return Object.freeze({ kind: "hermes" as const, ...target, startsWork: false as const });
  }
  /**
   * Canonically discriminates the additive remote route without widening
   * the legacy `ManagedNativeSessions` union. Non-remote queue locators return
   * undefined; a v11 source or v12 correction locator is fully revalidated
   * before it becomes a target.
   */
  async locateQueuedRemoteControllerWorkerDelivery(input: NativeTaskSubmissionReference, signal: AbortSignal): Promise<RemoteControllerWorkerQueueDeliveryTarget | undefined> {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted
      || ref.tenantId !== this.scope.tenantId) conflict();
    const remote = await this.db.transaction(async tx => {
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, ref.projectId]);
      const job = await this.job(tx, ref.projectId, ref.jobId);
      const plan = await this.planner.readInSession(tx, ref.jobId);
      if (!plan || plan.tenantId !== ref.tenantId || plan.projectId !== ref.projectId
        || job.inputDigest !== ref.inputDigest || signal.aborted) conflict();
      return job.jobType === CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1
        && (plan.schema === "control-room.task-execution-plan/v11" || plan.schema === "control-room.task-execution-plan/v12");
    });
    if (!remote) return undefined;
    return this.locateApprovedRemoteControllerWorkerQueueDelivery(ref, signal);
  }
  /**
   * Rebuilds only the canonical locator for a remote source or correction task. The locator is
   * deliberately insufficient to send: the protected installation materializer
   * must re-read the plan, lease and enrolled target before it can use the
   * authenticated node session.
   */
  async locateApprovedRemoteControllerWorkerQueueDelivery(input: NativeTaskSubmissionReference, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted
      || ref.tenantId !== this.scope.tenantId) conflict();
    return this.db.transaction(async tx => {
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, ref.projectId]);
      const job = await this.job(tx, ref.projectId, ref.jobId);
      const plan = await this.planner.readInSession(tx, ref.jobId);
      const stored = await this.stored(tx, job);
      if (!plan || !stored || (plan.schema !== "control-room.task-execution-plan/v11" && plan.schema !== "control-room.task-execution-plan/v12")
        || plan.tenantId !== ref.tenantId || plan.projectId !== ref.projectId
        || job.inputDigest !== ref.inputDigest || job.jobType !== CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1
        || job.requiredCapability !== CONTROLLER_WORKER_REMOTE_CAPABILITY_V1
        || stored.attempt.id !== ref.attemptId || signal.aborted) conflict();
      const route = this.routes.find(value => value.nodeId === stored.lease.nodeId);
      const now = this.clock();
      if (!route || route.executorId !== job.authority.allowedExecutor
        || route.capabilityProbeId !== CONTROLLER_WORKER_REMOTE_CAPABILITY_V1
        || stored.lease.state !== "active" || stored.attempt.leaseEpoch !== stored.lease.epoch
        || !Number.isSafeInteger(now) || now < 0
        || now >= Date.parse(stored.lease.expiresAt) || now >= Date.parse(job.authority.expiresAt)) conflict();
      await this.assertTransitionAdmission(tx, route.nodeId);
      return Object.freeze({ kind: "controller-worker-remote" as const, nodeId: route.nodeId, leaseId: stored.lease.id,
        leaseEpoch: stored.lease.epoch,
        task: Object.freeze({ projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId,
          inputDigest: ref.inputDigest }), startsWork: false as const,
        grantsExecutionAuthority: false as const }) satisfies RemoteControllerWorkerQueueDeliveryTarget;
    });
  }
  /** Stages one signed Codex envelope and stores it before any transport send. */
  async stageApprovedCodexQueueDelivery(input: NativeTaskSubmissionReference, session: ServerNodeSession, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted
      || ref.tenantId !== this.scope.tenantId) conflict();
    return session.stageCodexDispatch((sign, channel) => this.withCodexPermit(undefined, ref.projectId, ref.jobId,
      ref.inputDigest, undefined, async (tx, _prepared, assertCurrent, actorId, _configured, nodeKeyId, deadline, queued) => {
        if (!queued || queued.body.start.attemptId !== ref.attemptId || channel.tenantId !== ref.tenantId
          || channel.nodeId !== queued.body.start.nodeId || channel.nodeKeyId !== nodeKeyId
          || queued.body.start.deadline > deadline) conflict();
        assertCurrent(); queued.authority.assertFresh(); channel.assertCurrent();
        const frame = await sign(queued.body, queued.body.start.deadline);
        const receipt = await persistCodexDeliveryEnvelope(tx, this.codex!.integrityKey, frame, channel,
          actorId, this.clock(), queued.authority);
        const assertFresh = () => {
          if (signal.aborted) conflict(); assertCurrent(); queued.authority.assertFresh(); channel.assertCurrent();
        };
        await appendAuditWith(tx, { id: `audit:codex-envelope:${receipt.queueId}`, tenantId: ref.tenantId,
          actorId, actorType: "human", action: "codex.delivery.staged", targetType: "job", targetId: ref.jobId,
          correlationId: receipt.queueId, idempotencyKey: `codex-envelope:${receipt.queueId}`,
          safeMetadata: { frameDigest: receipt.frameDigest }, occurredAt: receipt.stagedAt });
        return { value: receipt, assertFresh };
      }, { reference: ref, signal }));
  }
  /** Commits the unique transmission intent before the session performs its only send. */
  async transmitApprovedCodexQueueDelivery(input: NativeTaskSubmissionReference, session: ServerNodeSession, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted
      || ref.tenantId !== this.scope.tenantId) conflict();
    return session.sendPreparedCodexDispatch((frame, channel) => this.withCodexPermit(undefined, ref.projectId, ref.jobId,
      ref.inputDigest, undefined, async (tx, _prepared, assertCurrent, actorId, _configured, nodeKeyId, deadline, queued) => {
        if (!queued || queued.body.start.attemptId !== ref.attemptId
          || sha256Digest(frame.body) !== sha256Digest(queued.body)
          || channel.tenantId !== ref.tenantId || channel.nodeId !== queued.body.start.nodeId
          || channel.nodeKeyId !== nodeKeyId || Date.parse(frame.expiresAt) > deadline) conflict();
        const receipt = await persistCodexTransmissionIntent(tx, this.codex!.integrityKey, frame, channel,
          actorId, this.clock(), queued.authority);
        const assertFresh = () => {
          if (signal.aborted) conflict(); assertCurrent(); queued.authority.assertFresh(); channel.assertCurrent();
        };
        await appendAuditWith(tx, { id: `audit:codex-transmit:${receipt.queueId}`, tenantId: ref.tenantId,
          actorId, actorType: "human", action: "codex.delivery.transmission_requested", targetType: "job", targetId: ref.jobId,
          correlationId: receipt.queueId, idempotencyKey: `codex-transmit:${receipt.queueId}`,
          safeMetadata: { frameDigest: receipt.frameDigest }, occurredAt: receipt.requestedAt });
        return { value: { value: receipt, assertFresh }, assertFresh };
      }, { reference: ref, signal }));
  }
  /** Records only the machine's authenticated storage receipt; it cannot start or settle work. */
  async receiveCodexDeliveryReceipt(session: ServerNodeSession, raw: string | Uint8Array, signal: AbortSignal) {
    if (!this.codex || !(signal instanceof AbortSignal) || signal.aborted) conflict();
    const saved = await session.acceptCodexReceipt(raw, async (frame, dispatch, assertCurrent) => {
      let fence = () => { if (signal.aborted) conflict(); assertCurrent(); };
      const value = await this.db.transactionWithPreCommitCheck(async tx => {
        const result = await persistCodexDeliveryReceipt(tx, this.codex!.integrityKey, frame, dispatch, this.clock, fence);
        const previous = fence; fence = () => { previous(); result.assertFresh(); };
        await appendAuditWith(tx, { id: `audit:codex-receipt:${frame.body.queueId}`, tenantId: frame.tenantId,
          projectId: frame.body.projectId, actorId: frame.actorId, actorType: "worker",
          action: "codex.delivery.receipt_recorded", targetType: "attempt", targetId: frame.body.attemptId,
          correlationId: frame.body.queueId, idempotencyKey: `codex-receipt:${frame.body.queueId}`,
          safeMetadata: { receiptFrameDigest: sha256Digest(frame), disposition: frame.body.disposition,
            safeReason: frame.body.safeReason }, occurredAt: result.value.receivedAt });
        fence(); return result.value;
      }, () => fence());
      fence(); return value;
    });
    if (saved.nodeReportedDisposition !== "recorded") return saved;
    if (!session.codexActivationAvailable()) return saved;
    const activation = await session.stageCodexActivation(({ dispatch, receipt, channel, sign }) => {
      const start = dispatch.body.start;
      const reference = nativeTaskSubmissionReferenceSchema.parse({ schema: "control-room.native-task-submission/v1",
        tenantId: start.tenantId, projectId: start.projectId, jobId: start.jobId, attemptId: start.attemptId,
        queueId: dispatch.body.queueId, inputDigest: start.inputDigest,
        packetDigest: codexApprovalPacketDigestV1(dispatch.body) });
      return this.withCodexPermit(undefined, start.projectId, start.jobId, start.inputDigest, undefined,
        async (tx, _prepared, assertCurrent, actorId, _configured, nodeKeyId, deadline, queued, basis) => {
          if (!queued || !basis || queued.body.start.attemptId !== start.attemptId
            || channel.tenantId !== start.tenantId || channel.nodeId !== start.nodeId
            || channel.nodeKeyId !== nodeKeyId || channel.connectionId !== dispatch.connectionId) conflict();
          const admission = codexCurrentAdmissionSchemaV1.parse({ ...basis, queueId: dispatch.body.queueId,
            dispatchMessageId: dispatch.messageId, dispatchFrameDigest: sha256Digest(dispatch),
            receiptMessageId: receipt.messageId, receiptFrameDigest: sha256Digest(receipt),
            permitDigest: dispatch.body.permitDigest, approvalExpiresAt: dispatch.body.permit.body.expiresAt,
            inputDigest: start.inputDigest, operationDigest: start.operationDigest, effectClaimKey: start.effectClaimKey,
            enrollmentDigest: start.enrollmentDigest, connectorProfileDigest: start.connectorProfileDigest,
            workspaceIntentDigest: start.workspaceIntentDigest, connectionId: dispatch.connectionId });
          const frame = await sign(activatedAt => buildCodexTaskActivationV1({
            dispatch: dispatch as unknown as CodexDispatchFrameForActivationV1,
            receipt: receipt as unknown as CodexDispatchReceiptFrameForActivationV1,
            currentAdmissionDigest: sha256Digest(admission), receiptReceivedAt: saved.receivedAt,
            activatedAt, activationExpiresAt: admission.admissionExpiresAt }), deadline);
          const result = await persistCodexActivationTransmissionIntent(tx, this.codex!.integrityKey,
            frame, dispatch, receipt, admission, channel, actorId, this.clock(), queued.authority);
          const assertFresh = () => {
            if (signal.aborted) conflict(); assertCurrent(); queued.authority.assertFresh(); channel.assertCurrent();
          };
          await appendAuditWith(tx, { id: `audit:codex-activation:${result.activationId}`, tenantId: start.tenantId,
            projectId: start.projectId, actorId, actorType: "human", action: "codex.activation.transmission_requested",
            targetType: "attempt", targetId: start.attemptId, correlationId: dispatch.body.queueId,
            idempotencyKey: `codex-activation:${dispatch.body.queueId}`,
            safeMetadata: { activationDigest: result.activationDigest,
              currentAdmissionDigest: result.currentAdmissionDigest }, occurredAt: result.reservedAt });
          return { value: { value: result, assertFresh }, assertFresh };
        }, { reference, signal });
    });
    const transport = await session.sendPreparedCodexActivation();
    return Object.freeze({ ...saved, activation: Object.freeze({ ...activation, ...transport }) });
  }
  /** Trusted coordinator/signing integration only. Not included in the browser operation surface.
   * Enrollment is configured at construction, never supplied by the approval request. */
  async prepareNativeApproval(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    return this.withNativeApproval(identity, projectId, jobId, expectedInputDigest, async (_tx, prepared) => ({ value: prepared }));
  }
  /** Trusted authenticated packet intake; never part of webOperation or an execution command. */
  async readNativeApproval(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    return this.readNativeEvidence(identity, projectId, jobId, expectedInputDigest, (store, tx, scope) => store.readInSession(tx, scope));
  }
  async readNativeTaskQueue(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    return this.readNativeEvidence(identity, projectId, jobId, expectedInputDigest, (store, tx, scope) => store.readQueueInSession(tx, scope));
  }
  async readNativeDeliveryPreparation(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    return this.readNativeEvidence(identity, projectId, jobId, expectedInputDigest, (store, tx, scope) => store.readDeliveryPreparationInSession(tx, scope));
  }
  async readNativeDeliveryEnvelope(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    return this.readNativeEvidence(identity, projectId, jobId, expectedInputDigest, (store, tx, scope) => store.readDeliveryEnvelopeInSession(tx, scope));
  }
  async readNativeTransmissionIntent(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    return this.readNativeEvidence(identity, projectId, jobId, expectedInputDigest, (store, tx, scope) => store.readTransmissionInSession(tx, scope));
  }
  async readNativeDeliveryReceipt(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    return this.readNativeEvidence(identity, projectId, jobId, expectedInputDigest, (store, tx, scope) => store.readReceiptInSession(tx, scope));
  }
  async readNativeDeliveryStatus(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    return this.readNativeEvidence(identity, projectId, jobId, expectedInputDigest, async (store, tx, scope) => {
      const queue = await store.readQueueInSession(tx, scope);
      const prepared = await store.readDeliveryPreparationInSession(tx, scope);
      const envelope = await store.readDeliveryEnvelopeInSession(tx, scope);
      const intent = await store.readTransmissionInSession(tx, scope);
      const receipt = await store.readReceiptInSession(tx, scope);
      if (prepared && !queue || envelope && !prepared || intent && !envelope || receipt && !intent) conflict();
      for (const record of [prepared, envelope, intent, receipt]) if (record && queue
        && (record.queueId !== queue.queueId || record.packetDigest !== queue.packetDigest)) conflict();
      if (prepared && envelope && prepared.bodyDigest !== envelope.bodyDigest
        || intent && envelope && (intent.frameDigest !== envelope.frameDigest || intent.messageId !== envelope.messageId)
        || receipt && intent && receipt.dispatchMessageId !== intent.messageId) conflict();
      const state = receipt ? receipt.nodeReportedDisposition === "recorded" ? "receipt_recorded" as const : "receipt_rejected" as const
        : intent ? "transmission_unconfirmed" as const : envelope ? "staged" as const : prepared ? "prepared" as const
          : queue ? "queued" as const : "not_queued" as const;
      return { projectId, jobId, attemptId: scope.attemptId, state, observedAt: new Date(this.clock()).toISOString(),
        startsWork: false as const, executionConfirmed: false as const };
    });
  }
  private async readNativeEvidence<T>(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string,
    read: (store: NativeApprovalPacketStore, tx: DatabaseSession, scope: NativeTaskQueueScope) => Promise<T>) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    if (!this.approvalStore) conflict();
    const store = this.approvalStore;
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.approve", projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE", [this.scope.tenantId, projectId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.origin !== "ordinary") conflict();
      const job = await this.job(tx, projectId, jobId), plan = await this.planner.readInSession(tx, jobId);
      if (!plan || plan.projectId !== projectId || plan.tenantId !== this.scope.tenantId || job.inputDigest !== expectedInputDigest) conflict();
      // The native approval store and its packet format are Hermes-specific. A Codex
      // reservation must use the separate bounded owner-permit path instead.
      if (job.jobType === CODEX_APP_SERVER_JOB_TYPE
        || plan.schema === "control-room.task-execution-plan/v3" || plan.schema === "control-room.task-execution-plan/v4") conflict();
      return read(store, tx, { tenantId: this.scope.tenantId, projectId, jobId,
        attemptId: this.ids(jobId).attemptId, inputDigest: expectedInputDigest });
    });
  }
  /** Trusted authenticated packet intake; never part of webOperation or an execution command. */
  async storeNativeApproval(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string,
    packet: unknown, signal: AbortSignal) {
    if (!this.approvalStore || signal.aborted) conflict();
    const store = this.approvalStore, snapshot = nativeTaskApprovalPacketSchema.parse(packet);
    return this.withNativeApproval(identity, projectId, jobId, expectedInputDigest, async (tx, prepared, actorId) => {
      const stored = await store.acceptInSession(tx, prepared, snapshot, actorId, signal);
      return { value: stored.receipt, assertFresh: stored.assertFresh };
    });
  }
  /** Internal, non-web dispatch preparation. Rebuild and verify now; do not expose private enrollment
   * to the browser or treat the returned snapshot as a durable permission/callback for later execution. */
  async prepareStoredNativeDispatch(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string,
    expectedPacketDigest: string, signal: AbortSignal) {
    digestSchema.parse(expectedPacketDigest);
    if (!this.approvalStore || signal.aborted) conflict();
    const store = this.approvalStore;
    return this.withNativeApproval(identity, projectId, jobId, expectedInputDigest, async (tx, prepared) => {
      const { assertFresh, ...material } = await store.revalidateInSession(tx, prepared, expectedPacketDigest, signal);
      return { value: { ...material, inputDigest: prepared.inputDigest, preparedAt: prepared.preparedAt,
        evidence: "revalidated_signed_snapshot" as const }, assertFresh };
    });
  }
  /** Durable intent insertion shares current revalidation and commit fences. No sender is invoked. */
  async enqueueNativeTask(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string,
    expectedPacketDigest: string, signal: AbortSignal) {
    digestSchema.parse(expectedPacketDigest);
    if (!this.approvalStore || signal.aborted) conflict();
    const store = this.approvalStore;
    return this.withNativeApproval(identity, projectId, jobId, expectedInputDigest, async (tx, prepared, actorId) => {
      const queued = await store.enqueueInSession(tx, prepared, expectedPacketDigest, actorId, signal);
      // Cutover is explicit constructor composition, never a browser-supplied queue.
      // Old/replayed canonical intents are not automatically backfilled or resurrected.
      if (!queued.receipt.replayed && this.nativeTaskSubmission) await this.nativeTaskSubmission.enqueueInSession(tx, {
        schema: "control-room.native-task-submission/v1", tenantId: this.scope.tenantId, projectId,
        jobId, attemptId: queued.receipt.attemptId, queueId: queued.receipt.queueId,
        inputDigest: expectedInputDigest, packetDigest: queued.receipt.packetDigest,
      });
      if (!queued.receipt.replayed) await appendAuditWith(tx, {
        id: `audit:${queued.receipt.queueId}`, tenantId: this.scope.tenantId, actorId, actorType: "human",
        action: "native.task.queued", targetType: "job", targetId: jobId, correlationId: queued.receipt.queueId,
        idempotencyKey: queued.receipt.queueId, safeMetadata: { packetDigest: expectedPacketDigest },
        occurredAt: queued.receipt.queuedAt,
      });
      return { value: queued.receipt, assertFresh: queued.assertFresh };
    });
  }
  /**
   * Queues an already-assigned local Hermes task in the same protected pg-boss
   * channel as other work.  This is deliberately separate from
   * `enqueueNativeTask`: Hermes 0.21 does not use the older signed-native
   * packet format, so accepting it there would incorrectly weaken that
   * format.  This method records no runner command and starts no Hermes work.
   */
  async enqueueHermes021LocalTask(identity: VerifiedWebIdentity, projectId: string, jobId: string,
    expectedInputDigest: string, signal: AbortSignal) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    if (!this.approvalStore || !this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted) conflict();
    const store = this.approvalStore;
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.approve", projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, projectId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
      const job = await this.job(tx, projectId, jobId), plan = await this.planner.readInSession(tx, jobId), stored = await this.stored(tx, job);
      if (!plan || !stored || plan.tenantId !== this.scope.tenantId || plan.projectId !== projectId
        || job.inputDigest !== expectedInputDigest || job.jobType !== HERMES_021_MACOS_LOCAL_JOB_TYPE_V1
        || job.requiredCapability !== HERMES_021_MACOS_LOCAL_CAPABILITY_V1
        || (plan.schema !== "control-room.task-execution-plan/v5" && plan.schema !== "control-room.task-execution-plan/v6"
          && plan.schema !== "control-room.task-execution-plan/v7" && plan.schema !== "control-room.task-execution-plan/v8")
        || plan.connectorProfileDigest !== HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1) conflict();
      const route = this.routes.find(value => value.nodeId === stored.lease.nodeId);
      const now = this.clock(), deadline = Math.min(Date.parse(stored.lease.expiresAt), Date.parse(job.authority.expiresAt));
      if (!route || route.executorId !== job.authority.allowedExecutor
        || route.capabilityProbeId !== HERMES_021_MACOS_LOCAL_CAPABILITY_V1
        || !Number.isSafeInteger(now) || now < 0 || now >= deadline || signal.aborted) conflict();
      await this.assertWorkBatchQueueAdmission(tx, job, route, stored.attempt.workerId ?? null);
      // The intent is bound to every canonical fact that selects the local
      // adapter.  A queue reference remains only a locator; pickup rebuilds
      // and verifies these facts again before it can reach a private runner.
      const packetDigest = sha256Digest({ schema: "control-room.hermes-021-macos-local-queue-intent/v1",
        planDigest: sha256Digest(plan), authorityDigest: job.authority.digest, tenantId: this.scope.tenantId,
        projectId, jobId, attemptId: stored.attempt.id, leaseId: stored.lease.id, leaseEpoch: stored.lease.epoch,
        nodeId: route.nodeId, executorId: route.executorId, capability: route.capabilityProbeId,
        connectorProfileDigest: plan.connectorProfileDigest });
      const intent: NativeTaskQueueIntent = {
        schema: "control-room.native-task-queue/v1", tenantId: this.scope.tenantId, projectId, jobId,
        attemptId: stored.attempt.id, nodeId: route.nodeId, leaseId: stored.lease.id, leaseEpoch: stored.lease.epoch,
        inputDigest: expectedInputDigest, packetDigest, operationDigest: job.authority.digest,
        bindingDigest: sha256Digest({ nodeId: route.nodeId, executorId: route.executorId,
          capability: route.capabilityProbeId, connectorProfileDigest: plan.connectorProfileDigest }),
        enrollmentDigest: sha256Digest({ adapter: HERMES_021_MACOS_LOCAL_JOB_TYPE_V1, nodeId: route.nodeId }),
        deliveryKind: "hermes-021-macos-local", deadline, queuedAt: new Date(now).toISOString(), queuedBy: actor.id,
      };
      const queued = await store.enqueueHermes021LocalInSession(tx, intent, sha256Digest(plan));
      if (!queued.replayed) await this.nativeTaskSubmission!.enqueueInSession(tx, {
        schema: "control-room.native-task-submission/v1", tenantId: this.scope.tenantId, projectId, jobId,
        attemptId: stored.attempt.id, queueId: queued.queueId, inputDigest: expectedInputDigest, packetDigest,
      });
      if (!queued.replayed) await appendAuditWith(tx, {
        id: `audit:hermes-021:${queued.queueId}`, tenantId: this.scope.tenantId, actorId: actor.id, actorType: "human",
        action: "hermes.021.local.task.queued", targetType: "job", targetId: jobId, correlationId: queued.queueId,
        idempotencyKey: `hermes-021:${queued.queueId}`, safeMetadata: { packetDigest }, occurredAt: intent.queuedAt,
      });
      return Object.freeze({ ...queued, startsWork: false as const, grantsExecutionAuthority: false as const });
    });
  }

  /** Server-only pipeline continuation.  It deliberately supports one already
   * existing native route and writes the identical protected queue intent used
   * by the owner-start path.  Unsupported adapters never fall through to a
   * generic/native queue and this method is not included in webOperation(). */
  async enqueuePipelineHermes021InSession(tx: DatabaseSession, input: Readonly<{
    tenantId:string; projectId:string; runId:string; stageOrdinal:number; sourceJobId:string; executionJobId:string;
    workerId:string; workerKind:"codex"|"claude-code"|"hermes"; nodeId:string; selectionKey:string; model:string;
    effort:string; provider:string|null; profile:string|null; attemptId:string; leaseId:string; leaseEpoch:number;
    inputDigest:string; policyId:string; approvingOwnerIdentityId:string; idempotencyKey:string; commitDeadline:number;
  }>, authority: Readonly<{actorId:"service:pipeline-advance:v1";assertCurrent:()=>void|Promise<void>}>) {
    if (!this.approvalStore || !this.nativeTaskSubmission || input.tenantId!==this.scope.tenantId
      || !Number.isSafeInteger(input.commitDeadline) || input.commitDeadline<0) conflict();
    for (const id of [input.projectId,input.executionJobId,input.nodeId,input.attemptId,input.leaseId,input.policyId,
      input.approvingOwnerIdentityId]) localId.parse(id);
    digestSchema.parse(input.inputDigest); await authority.assertCurrent();
    const store=this.approvalStore,job=await this.job(tx,input.projectId,input.executionJobId),
      plan=await this.planner.readInSession(tx,input.executionJobId),stored=await this.stored(tx,job);
    if (!plan||!stored||plan.tenantId!==this.scope.tenantId||plan.projectId!==input.projectId
      ||job.inputDigest!==input.inputDigest||job.jobType!==HERMES_021_MACOS_LOCAL_JOB_TYPE_V1
      ||job.requiredCapability!==HERMES_021_MACOS_LOCAL_CAPABILITY_V1
      ||(plan.schema!=="control-room.task-execution-plan/v5"&&plan.schema!=="control-room.task-execution-plan/v6"
        &&plan.schema!=="control-room.task-execution-plan/v7"&&plan.schema!=="control-room.task-execution-plan/v8")
      ||plan.connectorProfileDigest!==HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1
      ||stored.attempt.id!==input.attemptId||stored.lease.id!==input.leaseId||stored.lease.epoch!==input.leaseEpoch) conflict();
    const route=this.routes.find(value=>value.nodeId===stored.lease.nodeId),now=this.clock(),
      deadline=Math.min(Date.parse(stored.lease.expiresAt),Date.parse(job.authority.expiresAt),input.commitDeadline);
    if(!route||route.nodeId!==input.nodeId||route.executorId!==input.workerId||route.executorId!==job.authority.allowedExecutor
      ||route.capabilityProbeId!==HERMES_021_MACOS_LOCAL_CAPABILITY_V1||!Number.isSafeInteger(now)||now<0||now>=deadline) conflict();
    const approvingOwner=(await tx.query<{owner_identity_id:string}>(`SELECT p.owner_identity_id
      FROM control_project_delegation_policies p JOIN control_identities i
        ON i.tenant_id=p.tenant_id AND i.id=p.owner_identity_id AND i.actor_type='human' AND i.state='active'
      WHERE p.tenant_id=$1 AND p.project_id=$2 AND p.id=$3 AND p.state='active' AND p.owner_identity_id=$4
        AND EXISTS(SELECT 1 FROM control_role_grants g WHERE g.tenant_id=p.tenant_id
          AND g.identity_id=p.owner_identity_id AND g.role_key='owner' AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at>$5) AND g.require_strong_factor=false
          AND (g.project_ids ? $2 OR g.project_ids ? '*')
          AND (g.allowed_actions ? 'tasks.read' OR g.allowed_actions ? '*'))
        AND EXISTS(SELECT 1 FROM control_role_grants g WHERE g.tenant_id=p.tenant_id
          AND g.identity_id=p.owner_identity_id AND g.role_key='owner' AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at>$5) AND g.require_strong_factor=false
          AND (g.project_ids ? $2 OR g.project_ids ? '*')
          AND (g.allowed_actions ? 'tasks.approve' OR g.allowed_actions ? '*'))
      FOR SHARE OF p,i`,[this.scope.tenantId,input.projectId,input.policyId,input.approvingOwnerIdentityId,
      new Date(now).toISOString()])).rows[0];
    if(!approvingOwner)conflict();
    await this.assertWorkBatchQueueAdmission(tx,job,route,stored.attempt.workerId??null);await authority.assertCurrent();
    const packetDigest=sha256Digest({schema:"control-room.hermes-021-macos-local-queue-intent/v1",
      planDigest:sha256Digest(plan),authorityDigest:job.authority.digest,tenantId:this.scope.tenantId,
      projectId:input.projectId,jobId:input.executionJobId,attemptId:stored.attempt.id,leaseId:stored.lease.id,
      leaseEpoch:stored.lease.epoch,nodeId:route.nodeId,executorId:route.executorId,capability:route.capabilityProbeId,
      connectorProfileDigest:plan.connectorProfileDigest});
    const intent:NativeTaskQueueIntent={schema:"control-room.native-task-queue/v1",tenantId:this.scope.tenantId,
      projectId:input.projectId,jobId:input.executionJobId,attemptId:stored.attempt.id,nodeId:route.nodeId,
      leaseId:stored.lease.id,leaseEpoch:stored.lease.epoch,inputDigest:input.inputDigest,packetDigest,
      operationDigest:job.authority.digest,bindingDigest:sha256Digest({nodeId:route.nodeId,executorId:route.executorId,
        capability:route.capabilityProbeId,connectorProfileDigest:plan.connectorProfileDigest}),
      enrollmentDigest:sha256Digest({adapter:HERMES_021_MACOS_LOCAL_JOB_TYPE_V1,nodeId:route.nodeId}),
      deliveryKind:"hermes-021-macos-local",deadline,queuedAt:new Date(now).toISOString(),queuedBy:approvingOwner.owner_identity_id};
    const queued=await store.enqueueHermes021LocalInSession(tx,intent,sha256Digest(plan));
    const retainedIntent=await store.readQueueIntentInSession(tx,intent);
    if(!retainedIntent||retainedIntent.queuedBy!==approvingOwner.owner_identity_id)conflict();
    if(!queued.replayed)await this.nativeTaskSubmission.enqueueInSession(tx,{schema:"control-room.native-task-submission/v1",
      tenantId:this.scope.tenantId,projectId:input.projectId,jobId:input.executionJobId,attemptId:stored.attempt.id,
      queueId:queued.queueId,inputDigest:input.inputDigest,packetDigest});
    if(!queued.replayed)await appendAuditWith(tx,{id:`audit:hermes-021:${queued.queueId}`,tenantId:this.scope.tenantId,
      projectId:input.projectId,actorId:authority.actorId,actorType:"service",action:"hermes.021.local.task.queued",
      targetType:"job",targetId:input.executionJobId,correlationId:queued.queueId,idempotencyKey:`hermes-021:${queued.queueId}`,
      safeMetadata:{packetDigest},occurredAt:intent.queuedAt});
    await authority.assertCurrent();return Object.freeze({queueId:queued.queueId,replayed:queued.replayed});
  }
  /**
   * Server-side pickup lookup for a queued local Hermes task.  The pg-boss message
   * is merely a locator.  This method verifies its HMAC-backed queue intent,
   * its companion approval evidence, present owner permission, the leased
   * current V7/V8 text-review plan and the selected local route before returning a reference that
   * a local delivery composition may prepare.  It does not invoke Hermes.
   */
  async locateApprovedHermes021LocalQueueDelivery(input: NativeTaskSubmissionReference, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.approvalStore || !this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted
      || ref.tenantId !== this.scope.tenantId) conflict();
    const store = this.approvalStore;
    return new NativeQueueAuthority(this.db, this.scope, {
      readQueueIntentInSession: store.readQueueIntentInSession.bind(store),
    }, this.clock).authenticated(ref, async (tx, actor) => {
      actor.require("tasks.read", ref.projectId); actor.require("tasks.approve", ref.projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, ref.projectId]);
      const project = await this.projects.getViewInSession(tx, actor, ref.projectId);
      if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
      const job = await this.job(tx, ref.projectId, ref.jobId), plan = await this.planner.readInSession(tx, ref.jobId), stored = await this.stored(tx, job);
      if (!plan || !stored || plan.tenantId !== this.scope.tenantId || plan.projectId !== ref.projectId
        || job.inputDigest !== ref.inputDigest || job.jobType !== HERMES_021_MACOS_LOCAL_JOB_TYPE_V1
        || job.requiredCapability !== HERMES_021_MACOS_LOCAL_CAPABILITY_V1
        || (plan.schema !== "control-room.task-execution-plan/v5" && plan.schema !== "control-room.task-execution-plan/v6"
          && plan.schema !== "control-room.task-execution-plan/v7" && plan.schema !== "control-room.task-execution-plan/v8")
        || plan.connectorProfileDigest !== HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1
        || stored.attempt.id !== ref.attemptId || signal.aborted) conflict();
      const route = this.routes.find(value => value.nodeId === stored.lease.nodeId);
      const now = this.clock(), deadline = Math.min(Date.parse(stored.lease.expiresAt), Date.parse(job.authority.expiresAt));
      if (!route || route.executorId !== job.authority.allowedExecutor
        || route.capabilityProbeId !== HERMES_021_MACOS_LOCAL_CAPABILITY_V1
        || !Number.isSafeInteger(now) || now < 0 || now >= deadline) conflict();
      await this.assertWorkBatchQueueAdmission(tx, job, route, stored.attempt.workerId ?? null);
      await this.assertTransitionAdmission(tx, route.nodeId);
      const approval = await store.readHermes021LocalQueueApprovalInSession(tx, {
        tenantId: ref.tenantId, projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId, inputDigest: ref.inputDigest,
      });
      const queueIntent = await store.readQueueIntentInSession(tx, {
        tenantId: ref.tenantId, projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId, inputDigest: ref.inputDigest,
      });
      const packetDigest = sha256Digest({ schema: "control-room.hermes-021-macos-local-queue-intent/v1",
        planDigest: sha256Digest(plan), authorityDigest: job.authority.digest, tenantId: this.scope.tenantId,
        projectId: ref.projectId, jobId: ref.jobId, attemptId: stored.attempt.id, leaseId: stored.lease.id,
        leaseEpoch: stored.lease.epoch, nodeId: route.nodeId, executorId: route.executorId,
        capability: route.capabilityProbeId, connectorProfileDigest: plan.connectorProfileDigest });
      if (!approval || !queueIntent || queueIntent.deliveryKind !== "hermes-021-macos-local"
        || queueIntent.packetDigest !== packetDigest || approval.packetDigest !== packetDigest || approval.planDigest !== sha256Digest(plan)
        || approval.operationDigest !== job.authority.digest || approval.nodeId !== route.nodeId
        || approval.leaseId !== stored.lease.id || approval.leaseEpoch !== stored.lease.epoch
        || ref.packetDigest !== packetDigest) conflict();
      // A broker acknowledgement is not proof that the local worker never started. Once
      // any route-neutral worker receipt or harness run exists, recovery must
      // use the retained terminal-result path rather than launch Hermes again.
      await this.requireNeverStaged(tx, ref);
      return Object.freeze({ kind: "hermes-021-local" as const, nodeId: route.nodeId,
        task: Object.freeze({ projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId,
          inputDigest: ref.inputDigest }), leaseId: stored.lease.id,
        startsWork: false as const, grantsExecutionAuthority: false as const }) satisfies Hermes021LocalQueueDeliveryTarget;
    });
  }
  /** Shared read-only derivation for the Hermes-local queue intent. Used by
   * both `previewHermesLocalTask` (no write) and `enqueueHermesLocalTask`
   * (write), so the packet digest the owner is shown is exactly the one that
   * would be queued. Runs inside the caller's transaction and takes the same
   * `FOR UPDATE` locks the write path already relied on. */
  private async hermesLocalPreparedIntent(tx: DatabaseSession, projectId: string, jobId: string, expectedInputDigest: string) {
    const job = await this.job(tx, projectId, jobId), plan = await this.planner.readInSession(tx, jobId), stored = await this.stored(tx, job);
    if (!plan || !stored || plan.tenantId !== this.scope.tenantId || plan.projectId !== projectId
      || job.inputDigest !== expectedInputDigest || job.jobType !== HERMES_LOCAL_JOB_TYPE_V1
      || job.requiredCapability !== HERMES_LOCAL_CAPABILITY_V1
      || (plan.schema !== "control-room.task-execution-plan/v15" && plan.schema !== "control-room.task-execution-plan/v16")) conflict();
    const route = this.routes.find(value => value.nodeId === stored.lease.nodeId);
    const now = this.clock(), deadline = Math.min(Date.parse(stored.lease.expiresAt), Date.parse(job.authority.expiresAt));
    if (!route || route.executorId !== job.authority.allowedExecutor || route.capabilityProbeId !== HERMES_LOCAL_CAPABILITY_V1
      || !Number.isSafeInteger(now) || now < 0 || now >= deadline) conflict();
    await this.assertWorkBatchQueueAdmission(tx, job, route, stored.attempt.workerId ?? null);
    const packetDigest = macLocalQueueIntentPacketDigestV1({ schema: "control-room.hermes-macos-local-queue-intent/v1",
      planDigest: sha256Digest(plan), authorityDigest: job.authority.digest, tenantId: this.scope.tenantId,
      projectId, jobId, attemptId: stored.attempt.id, leaseId: stored.lease.id, leaseEpoch: stored.lease.epoch,
      nodeId: route.nodeId, executorId: route.executorId, capability: route.capabilityProbeId,
      connectorProfileDigest: plan.connectorProfileDigest });
    return { plan, job, stored, route, now, deadline, packetDigest };
  }
  /** Read-only confirm-what-you-saw preview: the exact `packetDigest` a
   * matching `enqueueHermesLocalTask` call would produce right now. Queues
   * nothing and requires the same owner-only authority as the enqueue. */
  async previewHermesLocalTask(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    if (!this.approvalStore || !this.nativeTaskSubmission) conflict();
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.approve", projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, projectId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
      const { packetDigest } = await this.hermesLocalPreparedIntent(tx, projectId, jobId, expectedInputDigest);
      return Object.freeze({ projectId, jobId, packetDigest });
    });
  }
  /** Queues a current, per-build-qualified Hermes task through the same
   * existing pg-boss queue and approval table. It creates no command, runner,
   * credential, or second scheduling mechanism. An optional `expectedPacketDigest`
   * is compared, in this same transaction, against the freshly derived digest
   * before the write; a mismatch refuses instead of queuing a different intent
   * than the one the caller confirmed. */
  async enqueueHermesLocalTask(identity: VerifiedWebIdentity, projectId: string, jobId: string,
    expectedInputDigest: string, signal: AbortSignal, expectedPacketDigest?: string) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    if (expectedPacketDigest !== undefined) digestSchema.parse(expectedPacketDigest);
    if (!this.approvalStore || !this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted) conflict();
    const store = this.approvalStore;
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.approve", projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, projectId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
      const { plan, job, stored, route, now, deadline, packetDigest } = await this.hermesLocalPreparedIntent(tx, projectId, jobId, expectedInputDigest);
      if (signal.aborted) conflict();
      if (expectedPacketDigest !== undefined && packetDigest !== expectedPacketDigest) conflict();
      const intent: NativeTaskQueueIntent = {
        schema: "control-room.native-task-queue/v1", tenantId: this.scope.tenantId, projectId, jobId,
        attemptId: stored.attempt.id, nodeId: route.nodeId, leaseId: stored.lease.id, leaseEpoch: stored.lease.epoch,
        inputDigest: expectedInputDigest, packetDigest, operationDigest: job.authority.digest,
        bindingDigest: sha256Digest({ nodeId: route.nodeId, executorId: route.executorId,
          capability: route.capabilityProbeId, connectorProfileDigest: plan.connectorProfileDigest }),
        enrollmentDigest: sha256Digest({ adapter: HERMES_LOCAL_JOB_TYPE_V1, nodeId: route.nodeId }),
        deliveryKind: "hermes-macos-local", deadline, queuedAt: new Date(now).toISOString(), queuedBy: actor.id,
      };
      const queued = await store.enqueueHermesLocalInSession(tx, intent, sha256Digest(plan));
      if (!queued.replayed) await this.nativeTaskSubmission!.enqueueInSession(tx, {
        schema: "control-room.native-task-submission/v1", tenantId: this.scope.tenantId, projectId, jobId,
        attemptId: stored.attempt.id, queueId: queued.queueId, inputDigest: expectedInputDigest, packetDigest,
      });
      if (!queued.replayed) await appendAuditWith(tx, {
        id: `audit:hermes-local:${queued.queueId}`, tenantId: this.scope.tenantId, actorId: actor.id, actorType: "human",
        action: "hermes.local.task.queued", targetType: "job", targetId: jobId, correlationId: queued.queueId,
        idempotencyKey: `hermes-local:${queued.queueId}`, safeMetadata: { packetDigest }, occurredAt: intent.queuedAt,
      });
      return Object.freeze({ ...queued, startsWork: false as const, grantsExecutionAuthority: false as const });
    });
  }
  /** Rebuilds and verifies the current-Hermes queue locator before it can
   * reach the protected runner. Historical or changed build receipts fail. */
  async locateApprovedHermesLocalQueueDelivery(input: NativeTaskSubmissionReference, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.approvalStore || !this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted
      || ref.tenantId !== this.scope.tenantId) conflict();
    const store = this.approvalStore;
    return new NativeQueueAuthority(this.db, this.scope, {
      readQueueIntentInSession: store.readQueueIntentInSession.bind(store),
    }, this.clock).authenticated(ref, async (tx, actor) => {
      actor.require("tasks.read", ref.projectId); actor.require("tasks.approve", ref.projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, ref.projectId]);
      const project = await this.projects.getViewInSession(tx, actor, ref.projectId);
      if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
      const job = await this.job(tx, ref.projectId, ref.jobId), plan = await this.planner.readInSession(tx, ref.jobId), stored = await this.stored(tx, job);
      if (!plan || !stored || plan.tenantId !== this.scope.tenantId || plan.projectId !== ref.projectId
        || job.inputDigest !== ref.inputDigest || job.jobType !== HERMES_LOCAL_JOB_TYPE_V1
        || job.requiredCapability !== HERMES_LOCAL_CAPABILITY_V1
        || (plan.schema !== "control-room.task-execution-plan/v15" && plan.schema !== "control-room.task-execution-plan/v16")
        || stored.attempt.id !== ref.attemptId || signal.aborted) conflict();
      const route = this.routes.find(value => value.nodeId === stored.lease.nodeId);
      const now = this.clock(), deadline = Math.min(Date.parse(stored.lease.expiresAt), Date.parse(job.authority.expiresAt));
      if (!route || route.executorId !== job.authority.allowedExecutor || route.capabilityProbeId !== HERMES_LOCAL_CAPABILITY_V1
        || !Number.isSafeInteger(now) || now < 0 || now >= deadline) conflict();
      await this.assertWorkBatchQueueAdmission(tx, job, route, stored.attempt.workerId ?? null);
      await this.assertTransitionAdmission(tx, route.nodeId);
      const approval = await store.readHermesLocalQueueApprovalInSession(tx, {
        tenantId: ref.tenantId, projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId, inputDigest: ref.inputDigest,
      });
      const queueIntent = await store.readQueueIntentInSession(tx, {
        tenantId: ref.tenantId, projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId, inputDigest: ref.inputDigest,
      });
      const packetDigest = sha256Digest({ schema: "control-room.hermes-macos-local-queue-intent/v1",
        planDigest: sha256Digest(plan), authorityDigest: job.authority.digest, tenantId: this.scope.tenantId,
        projectId: ref.projectId, jobId: ref.jobId, attemptId: stored.attempt.id, leaseId: stored.lease.id,
        leaseEpoch: stored.lease.epoch, nodeId: route.nodeId, executorId: route.executorId,
        capability: route.capabilityProbeId, connectorProfileDigest: plan.connectorProfileDigest });
      if (!approval || !queueIntent || queueIntent.deliveryKind !== "hermes-macos-local"
        || queueIntent.packetDigest !== packetDigest || approval.packetDigest !== packetDigest || approval.planDigest !== sha256Digest(plan)
        || approval.operationDigest !== job.authority.digest || approval.nodeId !== route.nodeId
        || approval.leaseId !== stored.lease.id || approval.leaseEpoch !== stored.lease.epoch
        || ref.packetDigest !== packetDigest) conflict();
      await this.requireNeverStaged(tx, ref);
      return Object.freeze({ kind: "hermes-local" as const, nodeId: route.nodeId,
        task: Object.freeze({ projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId,
          inputDigest: ref.inputDigest }), leaseId: stored.lease.id,
        startsWork: false as const, grantsExecutionAuthority: false as const }) satisfies HermesLocalQueueDeliveryTarget;
    });
  }
  /** Shared read-only derivation for the Claude Code local queue intent; see
   * `hermesLocalPreparedIntent` for why this must be the one formula both the
   * preview and the write consult. */
  private async claudeCodeLocalPreparedIntent(tx: DatabaseSession, projectId: string, jobId: string, expectedInputDigest: string) {
    const job = await this.job(tx, projectId, jobId), plan = await this.planner.readInSession(tx, jobId), stored = await this.stored(tx, job);
    if (!plan || !stored || plan.tenantId !== this.scope.tenantId || plan.projectId !== projectId
      || job.inputDigest !== expectedInputDigest || job.jobType !== CLAUDE_CODE_LOCAL_JOB_TYPE_V1
      || job.requiredCapability !== CLAUDE_CODE_LOCAL_CAPABILITY_V1
      || (plan.schema !== "control-room.task-execution-plan/v9" && plan.schema !== "control-room.task-execution-plan/v10")
      || plan.adapter !== CLAUDE_CODE_LOCAL_ADAPTER_V1 || plan.connectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1) conflict();
    const route = this.routes.find(value => value.nodeId === stored.lease.nodeId);
    const now = this.clock(), deadline = Math.min(Date.parse(stored.lease.expiresAt), Date.parse(job.authority.expiresAt));
    if (!route || route.executorId !== job.authority.allowedExecutor || route.capabilityProbeId !== CLAUDE_CODE_LOCAL_CAPABILITY_V1
      || !Number.isSafeInteger(now) || now < 0 || now >= deadline) conflict();
    await this.assertWorkBatchQueueAdmission(tx, job, route, stored.attempt.workerId ?? null);
    const packetDigest = macLocalQueueIntentPacketDigestV1({ schema: "control-room.claude-code-local-queue-intent/v1", planDigest: sha256Digest(plan),
      authorityDigest: job.authority.digest, tenantId: this.scope.tenantId, projectId, jobId, attemptId: stored.attempt.id,
      leaseId: stored.lease.id, leaseEpoch: stored.lease.epoch, nodeId: route.nodeId, executorId: route.executorId,
      capability: route.capabilityProbeId, connectorProfileDigest: plan.connectorProfileDigest });
    return { plan, job, stored, route, now, deadline, packetDigest };
  }
  /** Read-only confirm-what-you-saw preview for the Claude Code local path. */
  async previewClaudeCodeLocalTask(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    if (!this.approvalStore || !this.nativeTaskSubmission) conflict();
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.approve", projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, projectId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
      const { packetDigest } = await this.claudeCodeLocalPreparedIntent(tx, projectId, jobId, expectedInputDigest);
      return Object.freeze({ projectId, jobId, packetDigest });
    });
  }
  /** Queues one already-assigned Claude text review through the existing
   * protected pg-boss channel. This records no process setting and starts no
   * Claude process; pickup must reconstruct all current authority again. An
   * optional `expectedPacketDigest` is checked, in this same transaction,
   * before the write. */
  async enqueueClaudeCodeLocalTask(identity: VerifiedWebIdentity, projectId: string, jobId: string,
    expectedInputDigest: string, signal: AbortSignal, expectedPacketDigest?: string) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    if (expectedPacketDigest !== undefined) digestSchema.parse(expectedPacketDigest);
    if (!this.approvalStore || !this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted) conflict();
    const store = this.approvalStore;
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.approve", projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, projectId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
      const { plan, job, stored, route, now, deadline, packetDigest } = await this.claudeCodeLocalPreparedIntent(tx, projectId, jobId, expectedInputDigest);
      if (signal.aborted) conflict();
      if (expectedPacketDigest !== undefined && packetDigest !== expectedPacketDigest) conflict();
      const intent: NativeTaskQueueIntent = { schema: "control-room.native-task-queue/v1", tenantId: this.scope.tenantId,
        projectId, jobId, attemptId: stored.attempt.id, nodeId: route.nodeId, leaseId: stored.lease.id, leaseEpoch: stored.lease.epoch,
        inputDigest: expectedInputDigest, packetDigest, operationDigest: job.authority.digest,
        bindingDigest: sha256Digest({ nodeId: route.nodeId, executorId: route.executorId, capability: route.capabilityProbeId,
          connectorProfileDigest: plan.connectorProfileDigest }),
        enrollmentDigest: sha256Digest({ adapter: CLAUDE_CODE_LOCAL_ADAPTER_V1, nodeId: route.nodeId }),
        deliveryKind: "claude-code-local", deadline, queuedAt: new Date(now).toISOString(), queuedBy: actor.id };
      const queued = await store.enqueueClaudeCodeLocalInSession(tx, intent, sha256Digest(plan));
      if (!queued.replayed) await this.nativeTaskSubmission!.enqueueInSession(tx, {
        schema: "control-room.native-task-submission/v1", tenantId: this.scope.tenantId, projectId, jobId,
        attemptId: stored.attempt.id, queueId: queued.queueId, inputDigest: expectedInputDigest, packetDigest });
      if (!queued.replayed) await appendAuditWith(tx, { id: `audit:claude-code-local:${queued.queueId}`, tenantId: this.scope.tenantId,
        actorId: actor.id, actorType: "human", action: "claude.code.local.task.queued", targetType: "job", targetId: jobId,
        correlationId: queued.queueId, idempotencyKey: `claude-code-local:${queued.queueId}`, safeMetadata: { packetDigest }, occurredAt: intent.queuedAt });
      return Object.freeze({ ...queued, startsWork: false as const, grantsExecutionAuthority: false as const });
    });
  }
  /** Rechecks a Claude queue locator against the exact current plan, lease,
   * HMAC-backed queue record and receipt absence. It cannot acquire Claude. */
  async locateApprovedClaudeCodeLocalQueueDelivery(input: NativeTaskSubmissionReference, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.approvalStore || !this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted
      || ref.tenantId !== this.scope.tenantId) conflict();
    const store = this.approvalStore;
    return new NativeQueueAuthority(this.db, this.scope, { readQueueIntentInSession: store.readQueueIntentInSession.bind(store) }, this.clock)
      .authenticated(ref, async (tx, actor) => {
        actor.require("tasks.read", ref.projectId); actor.require("tasks.approve", ref.projectId, true);
        await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
        await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
          [this.scope.tenantId, ref.projectId]);
        const project = await this.projects.getViewInSession(tx, actor, ref.projectId);
        if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
        const job = await this.job(tx, ref.projectId, ref.jobId), plan = await this.planner.readInSession(tx, ref.jobId), stored = await this.stored(tx, job);
        if (!plan || !stored || plan.tenantId !== this.scope.tenantId || plan.projectId !== ref.projectId
          || job.inputDigest !== ref.inputDigest || job.jobType !== CLAUDE_CODE_LOCAL_JOB_TYPE_V1
          || job.requiredCapability !== CLAUDE_CODE_LOCAL_CAPABILITY_V1
          || (plan.schema !== "control-room.task-execution-plan/v9" && plan.schema !== "control-room.task-execution-plan/v10")
          || plan.adapter !== CLAUDE_CODE_LOCAL_ADAPTER_V1 || plan.connectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1
          || stored.attempt.id !== ref.attemptId || signal.aborted) conflict();
        const route = this.routes.find(value => value.nodeId === stored.lease.nodeId);
        const now = this.clock(), deadline = Math.min(Date.parse(stored.lease.expiresAt), Date.parse(job.authority.expiresAt));
        if (!route || route.executorId !== job.authority.allowedExecutor || route.capabilityProbeId !== CLAUDE_CODE_LOCAL_CAPABILITY_V1
          || !Number.isSafeInteger(now) || now < 0 || now >= deadline) conflict();
        await this.assertWorkBatchQueueAdmission(tx, job, route, stored.attempt.workerId ?? null);
        await this.assertTransitionAdmission(tx, route.nodeId);
        const approval = await store.readClaudeCodeLocalQueueApprovalInSession(tx,
          { tenantId: ref.tenantId, projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId, inputDigest: ref.inputDigest });
        const queueIntent = await store.readQueueIntentInSession(tx,
          { tenantId: ref.tenantId, projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId, inputDigest: ref.inputDigest });
        const packetDigest = sha256Digest({ schema: "control-room.claude-code-local-queue-intent/v1", planDigest: sha256Digest(plan),
          authorityDigest: job.authority.digest, tenantId: this.scope.tenantId, projectId: ref.projectId, jobId: ref.jobId,
          attemptId: stored.attempt.id, leaseId: stored.lease.id, leaseEpoch: stored.lease.epoch, nodeId: route.nodeId,
          executorId: route.executorId, capability: route.capabilityProbeId, connectorProfileDigest: plan.connectorProfileDigest });
        if (!approval || !queueIntent || queueIntent.deliveryKind !== "claude-code-local" || queueIntent.packetDigest !== packetDigest
          || approval.packetDigest !== packetDigest || approval.planDigest !== sha256Digest(plan)
          || approval.operationDigest !== job.authority.digest || approval.nodeId !== route.nodeId
          || approval.leaseId !== stored.lease.id || approval.leaseEpoch !== stored.lease.epoch || ref.packetDigest !== packetDigest) conflict();
        await this.requireNeverStaged(tx, ref);
        return Object.freeze({ kind: "claude-code-local" as const, nodeId: route.nodeId, leaseId: stored.lease.id,
          task: Object.freeze({ projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId, inputDigest: ref.inputDigest }),
          startsWork: false as const, grantsExecutionAuthority: false as const }) satisfies ClaudeCodeLocalQueueDeliveryTarget;
      });
  }
  /** Shared read-only derivation for the Codex owner-trusted local queue
   * intent; see `hermesLocalPreparedIntent` for why this must be the one
   * formula both the preview and the write consult. */
  private async codexOwnerTrustedLocalPreparedIntent(tx: DatabaseSession, projectId: string, jobId: string, expectedInputDigest: string) {
    const job = await this.job(tx, projectId, jobId), plan = await this.planner.readInSession(tx, jobId), stored = await this.stored(tx, job);
    if (!plan || !stored || plan.tenantId !== this.scope.tenantId || plan.projectId !== projectId
      || job.inputDigest !== expectedInputDigest || job.jobType !== CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1
      || job.requiredCapability !== CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1
      || (plan.schema !== "control-room.task-execution-plan/v13" && plan.schema !== "control-room.task-execution-plan/v14")
      || plan.adapter !== CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1) conflict();
    const route = this.routes.find(value => value.nodeId === stored.lease.nodeId);
    const now = this.clock(), deadline = Math.min(Date.parse(stored.lease.expiresAt), Date.parse(job.authority.expiresAt));
    if (!route || route.executorId !== job.authority.allowedExecutor || route.capabilityProbeId !== CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1
      || !Number.isSafeInteger(now) || now < 0 || now >= deadline) conflict();
    await this.assertWorkBatchQueueAdmission(tx, job, route, stored.attempt.workerId ?? null);
    const packetDigest = macLocalQueueIntentPacketDigestV1({ schema: "control-room.codex-owner-trusted-local-queue-intent/v1", planDigest: sha256Digest(plan),
      authorityDigest: job.authority.digest, tenantId: this.scope.tenantId, projectId, jobId, attemptId: stored.attempt.id,
      leaseId: stored.lease.id, leaseEpoch: stored.lease.epoch, nodeId: route.nodeId, executorId: route.executorId,
      capability: route.capabilityProbeId, connectorProfileDigest: plan.connectorProfileDigest });
    return { plan, job, stored, route, now, deadline, packetDigest };
  }
  /** Read-only confirm-what-you-saw preview for the Codex owner-trusted local path. */
  async previewCodexOwnerTrustedLocalTask(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    if (!this.approvalStore || !this.nativeTaskSubmission) conflict();
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.approve", projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, projectId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
      const { packetDigest } = await this.codexOwnerTrustedLocalPreparedIntent(tx, projectId, jobId, expectedInputDigest);
      return Object.freeze({ projectId, jobId, packetDigest });
    });
  }
  /** Queues one assigned owner-trusted local Codex text task through the same
   * protected pg-boss submission. The saved record is adapter-specific and
   * contains no executable path, prompt, account, workspace, or model choice. */
  async enqueueCodexOwnerTrustedLocalTask(identity: VerifiedWebIdentity, projectId: string, jobId: string,
    expectedInputDigest: string, signal: AbortSignal, expectedPacketDigest?: string) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    if (expectedPacketDigest !== undefined) digestSchema.parse(expectedPacketDigest);
    if (!this.approvalStore || !this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted) conflict();
    const store = this.approvalStore;
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.approve", projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, projectId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
      const { plan, job, stored, route, now, deadline, packetDigest } = await this.codexOwnerTrustedLocalPreparedIntent(tx, projectId, jobId, expectedInputDigest);
      if (signal.aborted) conflict();
      if (expectedPacketDigest !== undefined && packetDigest !== expectedPacketDigest) conflict();
      const intent: NativeTaskQueueIntent = { schema: "control-room.native-task-queue/v1", tenantId: this.scope.tenantId,
        projectId, jobId, attemptId: stored.attempt.id, nodeId: route.nodeId, leaseId: stored.lease.id, leaseEpoch: stored.lease.epoch,
        inputDigest: expectedInputDigest, packetDigest, operationDigest: job.authority.digest,
        bindingDigest: sha256Digest({ nodeId: route.nodeId, executorId: route.executorId, capability: route.capabilityProbeId,
          connectorProfileDigest: plan.connectorProfileDigest }),
        enrollmentDigest: sha256Digest({ adapter: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, nodeId: route.nodeId }),
        deliveryKind: "codex-owner-trusted-local", deadline, queuedAt: new Date(now).toISOString(), queuedBy: actor.id };
      const queued = await store.enqueueCodexOwnerTrustedLocalInSession(tx, intent, sha256Digest(plan));
      if (!queued.replayed) await this.nativeTaskSubmission!.enqueueInSession(tx, {
        schema: "control-room.native-task-submission/v1", tenantId: this.scope.tenantId, projectId, jobId,
        attemptId: stored.attempt.id, queueId: queued.queueId, inputDigest: expectedInputDigest, packetDigest });
      if (!queued.replayed) await appendAuditWith(tx, { id: `audit:codex-owner-trusted-local:${queued.queueId}`, tenantId: this.scope.tenantId,
        actorId: actor.id, actorType: "human", action: "codex.owner_trusted.local.task.queued", targetType: "job", targetId: jobId,
        correlationId: queued.queueId, idempotencyKey: `codex-owner-trusted-local:${queued.queueId}`,
        safeMetadata: { packetDigest }, occurredAt: intent.queuedAt });
      return Object.freeze({ ...queued, startsWork: false as const, grantsExecutionAuthority: false as const });
    });
  }
  /** Server-side job-type discriminator for the Mac-local submission
   * operation. It reads the stored job's type from the database itself —
   * never from a request field — the same way `locateQueuedHarnessDelivery`
   * already discriminates for pickup. Only the three owner-trusted local
   * adapters resolve; any remote/native/Codex-app-server job type, or any
   * job whose input digest does not match, refuses. It reads nothing before
   * the same owner-only session check the local methods apply. */
  private async macLocalJobKind(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.approve", projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, projectId]);
      const job = await this.job(tx, projectId, jobId), plan = await this.planner.readInSession(tx, jobId);
      if (!plan || plan.tenantId !== this.scope.tenantId || plan.projectId !== projectId || job.inputDigest !== expectedInputDigest) conflict();
      if (job.jobType === HERMES_LOCAL_JOB_TYPE_V1
        && (plan.schema === "control-room.task-execution-plan/v15" || plan.schema === "control-room.task-execution-plan/v16")) return "hermes-local" as const;
      if (job.jobType === CLAUDE_CODE_LOCAL_JOB_TYPE_V1
        && (plan.schema === "control-room.task-execution-plan/v9" || plan.schema === "control-room.task-execution-plan/v10")) return "claude-code-local" as const;
      if (job.jobType === CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1
        && (plan.schema === "control-room.task-execution-plan/v13" || plan.schema === "control-room.task-execution-plan/v14")) return "codex-owner-trusted-local" as const;
      return conflict();
    });
  }
  /** Read-only Mac-local confirm-what-you-saw preview. Dispatches by the
   * stored job's type, never by a caller-supplied kind. */
  async previewMacLocalTask(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    const kind = await this.macLocalJobKind(identity, projectId, jobId, expectedInputDigest);
    if (kind === "hermes-local") return this.previewHermesLocalTask(identity, projectId, jobId, expectedInputDigest);
    if (kind === "claude-code-local") return this.previewClaudeCodeLocalTask(identity, projectId, jobId, expectedInputDigest);
    return this.previewCodexOwnerTrustedLocalTask(identity, projectId, jobId, expectedInputDigest);
  }
  /** The Mac-local submission operation's only enqueue entry point. It
   * dispatches by the stored job's type to the matching owner-trusted local
   * enqueue method; the remote, signed-packet `enqueueNativeTask` path is
   * never reachable from here. Any other job type is `conflict`. */
  async enqueueMacLocalTask(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string,
    expectedPacketDigest: string, signal: AbortSignal) {
    digestSchema.parse(expectedPacketDigest);
    const kind = await this.macLocalJobKind(identity, projectId, jobId, expectedInputDigest);
    if (kind === "hermes-local") return this.enqueueHermesLocalTask(identity, projectId, jobId, expectedInputDigest, signal, expectedPacketDigest);
    if (kind === "claude-code-local") return this.enqueueClaudeCodeLocalTask(identity, projectId, jobId, expectedInputDigest, signal, expectedPacketDigest);
    return this.enqueueCodexOwnerTrustedLocalTask(identity, projectId, jobId, expectedInputDigest, signal, expectedPacketDigest);
  }
  /** Reconstructs and rechecks a Codex local queue pickup. It deliberately
   * returns only task identity: the protected host, never the browser or this
   * record, supplies the pinned CLI policy and final execution bridge. */
  async locateApprovedCodexOwnerTrustedLocalQueueDelivery(input: NativeTaskSubmissionReference, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.approvalStore || !this.nativeTaskSubmission || !(signal instanceof AbortSignal) || signal.aborted
      || ref.tenantId !== this.scope.tenantId) conflict();
    const store = this.approvalStore;
    return new NativeQueueAuthority(this.db, this.scope, { readQueueIntentInSession: store.readQueueIntentInSession.bind(store) }, this.clock)
      .authenticated(ref, async (tx, actor) => {
        actor.require("tasks.read", ref.projectId); actor.require("tasks.approve", ref.projectId, true);
        await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
        await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
          [this.scope.tenantId, ref.projectId]);
        const project = await this.projects.getViewInSession(tx, actor, ref.projectId);
        if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
        const job = await this.job(tx, ref.projectId, ref.jobId), plan = await this.planner.readInSession(tx, ref.jobId), stored = await this.stored(tx, job);
        if (!plan || !stored || plan.tenantId !== this.scope.tenantId || plan.projectId !== ref.projectId
          || job.inputDigest !== ref.inputDigest || job.jobType !== CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1
          || job.requiredCapability !== CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1
          || (plan.schema !== "control-room.task-execution-plan/v13" && plan.schema !== "control-room.task-execution-plan/v14")
          || plan.adapter !== CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 || stored.attempt.id !== ref.attemptId || signal.aborted) conflict();
        const route = this.routes.find(value => value.nodeId === stored.lease.nodeId);
        const now = this.clock(), deadline = Math.min(Date.parse(stored.lease.expiresAt), Date.parse(job.authority.expiresAt));
        if (!route || route.executorId !== job.authority.allowedExecutor || route.capabilityProbeId !== CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1
          || !Number.isSafeInteger(now) || now < 0 || now >= deadline) conflict();
        await this.assertWorkBatchQueueAdmission(tx, job, route, stored.attempt.workerId ?? null);
        await this.assertTransitionAdmission(tx, route.nodeId);
        const approval = await store.readCodexOwnerTrustedLocalQueueApprovalInSession(tx,
          { tenantId: ref.tenantId, projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId, inputDigest: ref.inputDigest });
        const queueIntent = await store.readQueueIntentInSession(tx,
          { tenantId: ref.tenantId, projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId, inputDigest: ref.inputDigest });
        const packetDigest = sha256Digest({ schema: "control-room.codex-owner-trusted-local-queue-intent/v1", planDigest: sha256Digest(plan),
          authorityDigest: job.authority.digest, tenantId: this.scope.tenantId, projectId: ref.projectId, jobId: ref.jobId,
          attemptId: stored.attempt.id, leaseId: stored.lease.id, leaseEpoch: stored.lease.epoch, nodeId: route.nodeId,
          executorId: route.executorId, capability: route.capabilityProbeId, connectorProfileDigest: plan.connectorProfileDigest });
        if (!approval || !queueIntent || queueIntent.deliveryKind !== "codex-owner-trusted-local" || queueIntent.packetDigest !== packetDigest
          || approval.packetDigest !== packetDigest || approval.planDigest !== sha256Digest(plan)
          || approval.operationDigest !== job.authority.digest || approval.nodeId !== route.nodeId
          || approval.leaseId !== stored.lease.id || approval.leaseEpoch !== stored.lease.epoch || ref.packetDigest !== packetDigest) conflict();
        await this.requireNeverStaged(tx, ref);
        return Object.freeze({ kind: "codex-owner-trusted-local" as const, nodeId: route.nodeId, leaseId: stored.lease.id,
          task: Object.freeze({ projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId, inputDigest: ref.inputDigest }),
          startsWork: false as const, grantsExecutionAuthority: false as const }) satisfies CodexOwnerTrustedLocalQueueDeliveryTarget;
      });
  }
  async prepareQueuedNativeDelivery(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string,
    expectedPacketDigest: string, signal: AbortSignal) {
    digestSchema.parse(expectedPacketDigest);
    if (!this.approvalStore || signal.aborted) conflict();
    const store = this.approvalStore;
    return this.withNativeApproval(identity, projectId, jobId, expectedInputDigest, async (tx, prepared, actorId) => {
      const saved = await store.prepareDeliveryInSession(tx, prepared, expectedPacketDigest, actorId, signal);
      if (!saved.receipt.replayed) await appendAuditWith(tx, {
        id: `audit:delivery:${saved.receipt.queueId}`, tenantId: this.scope.tenantId, actorId, actorType: "human",
        action: "native.delivery.prepared", targetType: "job", targetId: jobId, correlationId: saved.receipt.queueId,
        idempotencyKey: `delivery:${saved.receipt.queueId}`, safeMetadata: { bodyDigest: saved.receipt.bodyDigest }, occurredAt: saved.receipt.preparedAt,
      });
      return { value: saved.receipt, assertFresh: saved.assertFresh };
    });
  }
  async stageQueuedNativeDelivery(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string,
    expectedPacketDigest: string, session: ServerNodeSession, signal: AbortSignal, expectedAttemptId?: string) {
    return this.stageNativeDelivery(identity, projectId, jobId, expectedInputDigest, expectedPacketDigest, session, signal, expectedAttemptId);
  }
  /** Explicit server queue path; never accepts a caller-supplied browser identity. */
  async locateApprovedQueueDelivery(input: NativeTaskSubmissionReference, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.nativeTaskSubmission || !this.approvalStore || signal.aborted || ref.tenantId !== this.scope.tenantId) conflict();
    return this.withNativeApproval(undefined, ref.projectId, ref.jobId, ref.inputDigest, async (tx, prepared) => {
      if (prepared.request.attemptId !== ref.attemptId) conflict();
      const verified = await this.approvalStore!.revalidateInSession(tx, prepared, ref.packetDigest, signal);
      // The queue reference is a locator, not authority. Return only the routing
      // binding derived inside canonical approval/intent revalidation; no prompt,
      // enrollment, signing material or credentials leave this lookup.
      return { value: Object.freeze({ nodeId: prepared.request.nodeId,
        task: Object.freeze({ projectId: prepared.binding.projectId, jobId: prepared.request.jobId,
          attemptId: prepared.request.attemptId, inputDigest: prepared.inputDigest }) }),
      assertFresh: verified.assertFresh };
    }, ref);
  }
  /** Optional trusted recovery composition only, never a browser endpoint. Recovery
   * changes operational eligibility, not the original attempt, lease or approval. */
  async recoverNeverStagedQueueDelivery(input: NativeTaskSubmissionReference, signal: AbortSignal,
    ready?: { nodeId: string; assertCurrent(): void }) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    const recover = this.nativeTaskSubmission?.recoverUnsentInSession?.bind(this.nativeTaskSubmission);
    if (!recover || !this.approvalStore || !(signal instanceof AbortSignal) || signal.aborted || ref.tenantId !== this.scope.tenantId) conflict();
    return this.withNativeApproval(undefined, ref.projectId, ref.jobId, ref.inputDigest, async (tx, prepared, actorId) => {
      if (prepared.request.attemptId !== ref.attemptId || signal.aborted) conflict();
      if (ready && prepared.request.nodeId !== ready.nodeId) conflict();
      if (ready) assertSynchronousFence(() => ready.assertCurrent(), conflict);
      const verified = await this.approvalStore!.revalidateInSession(tx, prepared, ref.packetDigest, signal);
      // Canonical tenant/job/attempt locks are retained through commit. A missing
      // receipt alone is not proof of non-execution: even an envelope is too late.
      await this.requireNeverStaged(tx, ref);
      const prior = await tx.query<{ count: string | number }>(`SELECT count(*) AS count FROM audit_events
        WHERE tenant_id=$1 AND action='native.queue.unsent_recovered' AND correlation_id=$2`, [ref.tenantId, ref.queueId]);
      const count = Number(prior.rows[0]?.count);
      if (prior.rows.length !== 1 || !Number.isSafeInteger(count) || count < 0 || count >= MAX_NATIVE_UNSENT_RECOVERIES) conflict();
      const ordinal = count + 1;
      const recovered = await recover(tx, Object.freeze(ref), ordinal);
      if (typeof recovered !== "boolean" || signal.aborted) conflict();
      if (recovered) await appendAuditWith(tx, { id: `audit:queue-recovery:${ref.queueId}:${ordinal}`,
        tenantId: ref.tenantId, actorId, actorType: "human", action: "native.queue.unsent_recovered",
        targetType: "job", targetId: ref.jobId, correlationId: ref.queueId,
        idempotencyKey: `queue-recovery:${ref.queueId}:${ordinal}`, safeMetadata: { ordinal, packetDigest: ref.packetDigest },
        occurredAt: new Date(this.clock()).toISOString() });
      return { value: { recovered, ordinal: recovered ? ordinal : null }, assertFresh: () => {
        if (signal.aborted) conflict();
        if (ready) assertSynchronousFence(() => ready.assertCurrent(), conflict);
        verified.assertFresh();
      } };
    }, ref);
  }
  /** Called only by the trusted signed-ready session hook. Discovery is bounded
   * and is not authority: every candidate is independently authenticated and checked. */
  async recoverForReadyNode(input: { nodeId: string; attemptId?: string }, signal: AbortSignal, assertCurrent: () => void) {
    const nodeId = localId.parse(input.nodeId), attemptId = input.attemptId === undefined ? undefined : localId.parse(input.attemptId);
    if (!this.nativeTaskSubmission?.recoverUnsentInSession || !(signal instanceof AbortSignal) || signal.aborted) conflict();
    const current = () => { if (signal.aborted) conflict(); assertSynchronousFence(assertCurrent, conflict); };
    current();
    const rows = (await this.db.query<{ project_id: string; job_id: string; attempt_id: string; record: { inputDigest?: string; packetDigest?: string } }>(
      `SELECT q.project_id,q.job_id,q.attempt_id,q.record FROM control_native_task_queue q
       JOIN control_jobs j ON j.tenant_id=q.tenant_id AND j.project_id=q.project_id AND j.id=q.job_id
       JOIN control_task_execution_plans p ON p.tenant_id=q.tenant_id AND p.project_id=q.project_id AND p.job_id=q.job_id
       JOIN control_attempts a ON a.tenant_id=q.tenant_id AND a.job_id=q.job_id AND a.id=q.attempt_id
       JOIN control_leases l ON l.tenant_id=q.tenant_id AND l.job_id=q.job_id AND l.attempt_id=q.attempt_id
       WHERE q.tenant_id=$1 AND a.node_id=$2 AND l.state='active' AND l.expires_at>$3
         AND j.payload->>'jobType'='harness.hermes.native.task'
         AND p.plan->>'schema' IN ('control-room.task-execution-plan/v1','control-room.task-execution-plan/v2')
         AND ($4::text IS NULL OR q.attempt_id=$4)
         AND NOT EXISTS(SELECT 1 FROM control_native_delivery_envelopes e WHERE e.tenant_id=q.tenant_id AND e.job_id=q.job_id AND e.attempt_id=q.attempt_id)
       ORDER BY q.job_id,q.attempt_id LIMIT 33`, [this.scope.tenantId, nodeId, new Date(this.clock()).toISOString(), attemptId ?? null])).rows;
    current();
    let recovered = 0, held = 0;
    for (const row of rows.slice(0, 32)) {
      current();
      try {
        const ref = nativeTaskSubmissionReferenceSchema.parse({ schema: "control-room.native-task-submission/v1", tenantId: this.scope.tenantId,
          projectId: row.project_id, jobId: row.job_id, attemptId: row.attempt_id,
          queueId: `native-queue:${sha256Digest({ tenantId: this.scope.tenantId, jobId: row.job_id, attemptId: row.attempt_id }).slice(7)}`,
          inputDigest: row.record?.inputDigest, packetDigest: row.record?.packetDigest });
        if ((await this.recoverNeverStagedQueueDelivery(ref, signal, { nodeId, assertCurrent: current })).recovered) recovered++;
      } catch { current(); held++; }
    }
    return { examined: Math.min(rows.length, 32), recovered, held, truncated: rows.length > 32 };
  }
  /** Verify recovered pickup against the canonical recovery sequence, not queue
   * retry metadata alone. Does not stage, transmit, recover or create an audit. */
  async verifyRecoveredQueueDelivery(input: NativeTaskSubmissionReference, ordinal: number, signal: AbortSignal): Promise<void> {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.nativeTaskSubmission?.recoverUnsentInSession || !this.approvalStore || ref.tenantId !== this.scope.tenantId
      || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > MAX_NATIVE_UNSENT_RECOVERIES
      || !(signal instanceof AbortSignal) || signal.aborted) conflict();
    return this.withNativeApproval(undefined, ref.projectId, ref.jobId, ref.inputDigest, async (tx, prepared, actorId) => {
      if (prepared.request.attemptId !== ref.attemptId) conflict();
      const verified = await this.approvalStore!.revalidateInSession(tx, prepared, ref.packetDigest, signal);
      await this.requireNeverStaged(tx, ref);
      const records = (await tx.query<{ id: string; actor_id: string; target_id: string; safe_metadata: { ordinal?: number; packetDigest?: string } }>(
        `SELECT id,actor_id,target_id,safe_metadata FROM audit_events
         WHERE tenant_id=$1 AND action='native.queue.unsent_recovered' AND correlation_id=$2`, [ref.tenantId, ref.queueId])).rows;
      if (records.length !== ordinal) conflict();
      for (let i = 1; i <= ordinal; i++) {
        const row = records.find(row => row.id === `audit:queue-recovery:${ref.queueId}:${i}`);
        if (!row || row.actor_id !== actorId || row.target_id !== ref.jobId
          || row.safe_metadata?.ordinal !== i || row.safe_metadata.packetDigest !== ref.packetDigest) conflict();
      }
      return { value: undefined, assertFresh: () => { if (signal.aborted) conflict(); verified.assertFresh(); } };
    }, ref);
  }
  private async requireNeverStaged(tx: DatabaseSession, ref: NativeTaskSubmissionReference) {
    const evidence = await tx.query<{ present: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM control_native_delivery_envelopes WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3)
      OR EXISTS(SELECT 1 FROM control_native_transmission_intents WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3)
      OR EXISTS(SELECT 1 FROM control_native_delivery_receipts WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3)
      -- A route-neutral receipt means a local or remote worker may already
      -- have received this task.  Treat it exactly like an outgoing envelope:
      -- a missing pg-boss acknowledgement is never evidence that work did
      -- not start.
      OR EXISTS(SELECT 1 FROM control_worker_delivery_receipts WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3)
      OR EXISTS(SELECT 1 FROM control_harness_runs WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3)
      AS present`, [ref.tenantId, ref.jobId, ref.attemptId]);
    if (evidence.rows.length !== 1 || evidence.rows[0].present !== false) conflict();
  }
  async stageApprovedQueueDelivery(input: NativeTaskSubmissionReference, session: ServerNodeSession, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.nativeTaskSubmission || ref.tenantId !== this.scope.tenantId) conflict();
    return this.stageNativeDelivery(undefined, ref.projectId, ref.jobId, ref.inputDigest, ref.packetDigest, session, signal, ref.attemptId, ref);
  }
  private async stageNativeDelivery(identity: VerifiedWebIdentity | undefined, projectId: string, jobId: string, expectedInputDigest: string,
    expectedPacketDigest: string, session: ServerNodeSession, signal: AbortSignal, expectedAttemptId?: string, queue?: NativeTaskSubmissionReference) {
    digestSchema.parse(expectedPacketDigest);
    if (!this.approvalStore || signal.aborted) conflict();
    const store = this.approvalStore;
    return session.stageNativeDispatch((sign, channel, signLease) => this.withNativeApproval(identity, projectId, jobId, expectedInputDigest,
      async (tx, prepared, actorId, nodeKeyId, deadline) => {
        if (expectedAttemptId !== undefined && prepared.request.attemptId !== expectedAttemptId) conflict();
        if (channel.tenantId !== this.scope.tenantId || channel.nodeId !== prepared.request.nodeId || channel.nodeKeyId !== nodeKeyId) conflict();
        const saved = await store.stageDeliveryEnvelopeInSession(tx, prepared, expectedPacketDigest, actorId, signal, sign, channel, deadline, signLease);
        await appendAuditWith(tx, { id: `audit:envelope:${saved.receipt.queueId}`, tenantId: this.scope.tenantId, actorId, actorType: "human",
          action: "native.delivery.staged", targetType: "job", targetId: jobId, correlationId: saved.receipt.queueId,
          idempotencyKey: `envelope:${saved.receipt.queueId}`, safeMetadata: { frameDigest: saved.receipt.frameDigest }, occurredAt: saved.receipt.stagedAt });
        return { value: saved.receipt, assertFresh: saved.assertFresh };
      }, queue));
  }
  async transmitQueuedNativeDelivery(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string,
    expectedPacketDigest: string, session: ServerNodeSession, signal: AbortSignal, expectedAttemptId?: string) {
    return this.transmitNativeDelivery(identity, projectId, jobId, expectedInputDigest, expectedPacketDigest, session, signal, expectedAttemptId);
  }
  async transmitApprovedQueueDelivery(input: NativeTaskSubmissionReference, session: ServerNodeSession, signal: AbortSignal) {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (!this.nativeTaskSubmission || ref.tenantId !== this.scope.tenantId) conflict();
    return this.transmitNativeDelivery(undefined, ref.projectId, ref.jobId, ref.inputDigest, ref.packetDigest, session, signal, ref.attemptId, ref);
  }
  private async transmitNativeDelivery(identity: VerifiedWebIdentity | undefined, projectId: string, jobId: string, expectedInputDigest: string,
    expectedPacketDigest: string, session: ServerNodeSession, signal: AbortSignal, expectedAttemptId?: string, queue?: NativeTaskSubmissionReference) {
    digestSchema.parse(expectedPacketDigest);
    if (!this.approvalStore || signal.aborted) conflict();
    const store = this.approvalStore;
    return session.sendPreparedNativeDispatch((frame, channel, leaseFrame) => this.withNativeApproval(identity, projectId, jobId, expectedInputDigest,
      async (tx, prepared, actorId, nodeKeyId, deadline, assertAuthorizationTime) => {
        if (expectedAttemptId !== undefined && prepared.request.attemptId !== expectedAttemptId) conflict();
        if (channel.tenantId !== this.scope.tenantId || channel.nodeId !== prepared.request.nodeId || channel.nodeKeyId !== nodeKeyId
            || Date.parse(frame.expiresAt) > deadline) conflict();
        const saved = await store.recordTransmissionInSession(tx, prepared, expectedPacketDigest, actorId, signal, frame, channel, leaseFrame);
        const checkedAt = this.clock();
        const assertFresh = () => {
          assertAuthorizationTime(); saved.assertFresh(); const now = this.clock();
          if (!Number.isSafeInteger(now) || now < checkedAt || now >= deadline) conflict();
        };
        await appendAuditWith(tx, { id: `audit:transmit:${saved.receipt.queueId}`, tenantId: this.scope.tenantId, actorId, actorType: "human",
          action: "native.delivery.transmission_requested", targetType: "job", targetId: jobId, correlationId: saved.receipt.queueId,
          idempotencyKey: `transmit:${saved.receipt.queueId}`, safeMetadata: { frameDigest: saved.receipt.frameDigest }, occurredAt: saved.receipt.requestedAt });
        return { value: { value: saved.receipt, assertFresh, ...(saved.receipt.leaseFrameDigest ? { leaseFrameDigest: saved.receipt.leaseFrameDigest } : {}) }, assertFresh };
      }, queue));
  }
  private async withCodexPermit<T>(identity: VerifiedWebIdentity | undefined, projectId: string, jobId: string, expectedInputDigest: string,
    issued: { issuedAt: number; approvalNonce: string; approvalKeyId: string } | undefined,
    finish: (tx: DatabaseSession, prepared: CodexOwnerPermitPreparationInputV1, assertCurrent: () => void,
      actorId: string, configured: CodexPermitEnrollment, nodeKeyId: string, deadline: number,
      queued?: { body: ReturnType<typeof codexTaskDispatchBodySchemaV1.parse>;
        authority: VerifiedCodexDeliveryAuthorityV1 }, admission?: CodexCurrentAdmissionBasisV1) => Promise<{ value: T; assertFresh?: () => void }>,
    queue?: { reference: NativeTaskSubmissionReference; signal: AbortSignal }) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    if (!this.codex) conflict();
    let finishFence: (() => void) | undefined;
    const db: DatabaseClient = { query: this.db.query.bind(this.db), transaction: this.db.transaction.bind(this.db),
      transactionWithPreCommitCheck: (work, check) => this.db.transactionWithPreCommitCheck(work, async () => {
        await check(); finishFence?.();
      }) };
    const operation = async (tx: DatabaseSession, actor: WebActor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.approve", projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, projectId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
      const job = await this.job(tx, projectId, jobId), plan = await this.planner.readInSession(tx, jobId), stored = await this.stored(tx, job);
      if (!plan || (plan.schema !== "control-room.task-execution-plan/v3" && plan.schema !== "control-room.task-execution-plan/v4") || plan.projectId !== projectId
        || plan.tenantId !== this.scope.tenantId || job.jobType !== CODEX_APP_SERVER_JOB_TYPE || !stored
        || job.inputDigest !== expectedInputDigest) conflict();
      const configured = this.codex!.enrollments.find(value => value.nodeId === stored.lease.nodeId);
      const route = this.routes.find(value => value.nodeId === stored.lease.nodeId);
      if (!configured || !route || route.capabilityProbeId !== CODEX_APP_SERVER_CAPABILITY
        || route.executorId !== job.authority.allowedExecutor
        || configured.connectorProfileDigest !== plan.connectorProfileDigest
        || configured.workspaceIntentDigest !== plan.workspaceIntentDigest) conflict();
      await this.assertWorkBatchQueueAdmission(tx, job, route, stored.attempt.workerId ?? null);
      await this.assertTransitionAdmission(tx, route.nodeId);
      const nodeRow = (await tx.query<{ payload: unknown; state: string; version: number }>(
        "SELECT payload,state,version FROM control_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.tenantId, configured.nodeId])).rows[0];
      if (!nodeRow) conflict();
      const node = nodeRecordSchema.parse(nodeRow.payload);
      if (node.id !== configured.nodeId || node.tenantId !== this.scope.tenantId || node.state !== "active"
        || node.state !== nodeRow.state || node.version !== Number(nodeRow.version)) conflict();
      const key = (await tx.query<{ state: string; valid_from: string | Date; valid_until: string | Date | null }>(
        "SELECT state,valid_from,valid_until FROM control_node_keys WHERE tenant_id=$1 AND node_id=$2 AND id=$3 AND state='active' FOR SHARE",
        [this.scope.tenantId, node.id, node.identityKeyId])).rows[0];
      const now = this.clock(), keyFrom = key ? new Date(key.valid_from).getTime() : NaN;
      const keyUntil = key?.valid_until ? new Date(key.valid_until).getTime() : Infinity;
      const deadline = Math.min(Date.parse(stored.lease.expiresAt), Date.parse(job.authority.expiresAt),
        configured.validUntil, keyUntil);
      if (!Number.isSafeInteger(now) || now < 0 || !key || !Number.isFinite(keyFrom)
        || Number.isNaN(keyUntil) || keyFrom > now || now >= deadline) conflict();
      const trustedScope = { tenantId: this.scope.tenantId, nodeId: configured.nodeId, nodeClass: configured.nodeClass };
      if (sha256Digest(configured.approvals.binding()) !== sha256Digest(trustedScope)) conflict();
      const trustRevision = configured.security.currentServerTrustRevision();
      let highWater = now;
      const assertCurrent = () => {
        const observed = this.clock();
        if (!Number.isSafeInteger(observed) || observed < highWater || observed >= deadline) conflict();
        highWater = observed;
        assertSynchronousFence(() => configured.approvals.assertAvailable(), conflict);
        if (configured.security.currentServerTrustRevision() !== trustRevision
          || sha256Digest(configured.approvals.binding()) !== sha256Digest(trustedScope)) conflict();
      };
      assertCurrent();
      const storedApproval = queue
        ? await readCodexApprovalPacketInSession(tx, this.codex!.integrityKey, queue.reference) : null;
      if (queue && (!storedApproval || storedApproval.packetDigest !== queue.reference.packetDigest
        || queue.signal.aborted)) conflict();
      const savedPermit = storedApproval?.body.permit.body;
      const effectiveIssued = issued ?? (savedPermit ? { issuedAt: Date.parse(savedPermit.issuedAt),
        approvalNonce: savedPermit.nonce, approvalKeyId: savedPermit.approvalKeyId } : undefined);
      const issuedAt = effectiveIssued?.issuedAt ?? now;
      if (!Number.isSafeInteger(issuedAt) || issuedAt < Date.parse(stored.lease.acquiredAt) || issuedAt > now
        || effectiveIssued && effectiveIssued.approvalKeyId !== configured.approvalKeyId) conflict();
      const { approvalKeyId: _approvalKeyId, approvals: _approvals, security: _security, ...configuredBinding } = configured;
      const prepared: CodexOwnerPermitPreparationInputV1 = { job, attempt: stored.attempt, lease: stored.lease,
        input: plan.input, binding: prepareCodexOwnerPermitBinding(configuredBinding), approvalKeyId: configured.approvalKeyId,
        issuedAt, approvalNonce: effectiveIssued?.approvalNonce ?? sha256Digest({ purpose: "codex-owner-permit-nonce/v1",
          tenantId: this.scope.tenantId, projectId, jobId, attemptId: stored.attempt.id,
          leaseEpoch: stored.lease.epoch, issuedAt }).slice(7) };
      let queued: { body: ReturnType<typeof codexTaskDispatchBodySchemaV1.parse>;
        authority: VerifiedCodexDeliveryAuthorityV1 } | undefined;
      if (storedApproval && queue) {
        const material = prepareCodexOwnerPermitMaterial(prepared);
        const body = codexTaskDispatchBodySchemaV1.parse({ schema: "control-room.codex-task-dispatch/v1",
          queueId: storedApproval.body.queueId, start: material.start, request: material.request,
          permit: storedApproval.body.permit, permitDigest: storedApproval.body.permitDigest });
        if (sha256Digest(body) !== sha256Digest(storedApproval.body)
          || codexApprovalPacketDigestV1(body) !== storedApproval.packetDigest) conflict();
        const authority = await createCodexApprovalIntakeV1({ body,
          expectedEnrollmentDigest: configured.enrollmentDigest,
          expectedConnectorProfileDigest: configured.connectorProfileDigest,
          expectedWorkspaceIntentDigest: configured.workspaceIntentDigest }, { approvals: configured.approvals,
          security: configured.security, clock: this.clock })(queue.signal);
        if (queue.signal.aborted) conflict();
        queued = { body, authority };
      }
      prepareCodexOwnerPermitMaterial(prepared); assertCurrent();
      let admission: CodexCurrentAdmissionBasisV1 | undefined;
      if (queued && storedApproval && savedPermit) {
        const checkedAt = this.clock(); assertCurrent();
        admission = Object.freeze({ schema: "control-room.codex-current-admission/v1", tenantId: this.scope.tenantId,
          projectId, projectVersion: project.version, projectLifecycle: "active", jobId, jobVersion: job.version,
          jobState: "leased", attemptId: stored.attempt.id, attemptVersion: stored.attempt.version,
          attemptState: "leased", leaseId: stored.lease.id, leaseVersion: stored.lease.version,
          leaseEpoch: stored.lease.epoch, leaseState: "active", leaseExpiresAt: stored.lease.expiresAt,
          nodeId: node.id, nodeVersion: node.version, nodeState: "active", nodeKeyId: node.identityKeyId,
          nodeKeyState: "active", nodeKeyValidFrom: new Date(key.valid_from).toISOString(),
          nodeKeyValidUntil: key.valid_until ? new Date(key.valid_until).toISOString() : null,
          authorityDigest: job.authority.digest, authorityExpiresAt: job.authority.expiresAt,
          approvalKeyId: configured.approvalKeyId, ownerTrustRevisionDigest: sha256Digest(trustRevision),
          configurationExpiresAt: new Date(Math.min(configured.validUntil, deadline)).toISOString(),
          checkedAt: new Date(checkedAt).toISOString(), admissionExpiresAt: new Date(deadline).toISOString() });
      }
      const result = await finish(tx, prepared, assertCurrent, actor.id, configured, node.identityKeyId, deadline, queued, admission);
      finishFence = result.assertFresh ?? assertCurrent;
      return result.value;
    };
    if (queue) {
      const store = { readQueueIntentInSession: (tx: DatabaseSession, scope: NativeTaskQueueScope) =>
        readNativeTaskQueueIntentInSession(tx, this.codex!.integrityKey, scope) };
      return new NativeQueueAuthority(db, this.scope, store, this.clock).authenticated(queue.reference, operation);
    }
    if (!identity) conflict();
    return new WebSessionAuthority(db, this.scope, this.clock, "task").authenticated(identity, operation);
  }

  private async withNativeApproval<T>(identity: VerifiedWebIdentity | undefined, projectId: string, jobId: string, expectedInputDigest: string,
    finish: (tx: DatabaseSession, prepared: CanonicalNativeApproval, actorId: string, nodeKeyId: string, deadline: number, assertAuthorizationTime: () => void) => Promise<{ value: T; assertFresh?: () => void }>, queue?: NativeTaskSubmissionReference) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    let deadline: number | undefined, preparedAt: number | undefined, assertFresh: (() => void) | undefined;
    const db: DatabaseClient = { query: this.db.query.bind(this.db), transaction: this.db.transaction.bind(this.db),
      transactionWithPreCommitCheck: (work, check) => this.db.transactionWithPreCommitCheck(work, async () => {
        await check(); const now = this.clock();
        if (!Number.isSafeInteger(now) || preparedAt === undefined || now < preparedAt || deadline === undefined || now >= deadline) conflict();
        assertFresh?.();
      }) };
    const operation = async (tx: DatabaseSession, actor: WebActor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.approve", projectId, true);
      // Match reservation/expiry lock order, keeping the complete canonical snapshot in one transaction.
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE", [this.scope.tenantId, projectId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active" || project.origin !== "ordinary") conflict();
      const job = await this.job(tx, projectId, jobId), plan = await this.planner.readInSession(tx, jobId), stored = await this.stored(tx, job);
      if (!plan || plan.projectId !== projectId || plan.tenantId !== this.scope.tenantId || !stored || job.inputDigest !== expectedInputDigest) conflict();
      // Never reinterpret a Codex plan as a Hermes native approval packet.
      if (job.jobType === CODEX_APP_SERVER_JOB_TYPE
        || plan.schema === "control-room.task-execution-plan/v3" || plan.schema === "control-room.task-execution-plan/v4") conflict();
      const configured = this.enrollments.find(e => e.enrollment.nodeId === stored.lease.nodeId), route = this.routes.find(r => r.nodeId === stored.lease.nodeId);
      if (!configured || !route || route.executorId !== job.authority.allowedExecutor) conflict();
      await this.assertWorkBatchQueueAdmission(tx, job, route, stored.attempt.workerId ?? null);
      await this.assertTransitionAdmission(tx, route.nodeId);
      const enrollment = configured.enrollment;
      const row = (await tx.query<{ payload: unknown; state: string; version: number }>(
        "SELECT payload,state,version FROM control_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [this.scope.tenantId, enrollment.nodeId])).rows[0];
      if (!row) conflict(); const node = nodeRecordSchema.parse(row.payload);
      if (node.id !== enrollment.nodeId || node.tenantId !== this.scope.tenantId || node.state !== "active"
        || node.state !== row.state || node.version !== Number(row.version)) conflict();
      const key = (await tx.query<{ valid_from: string | Date; valid_until: string | Date | null }>(
        "SELECT valid_from,valid_until FROM control_node_keys WHERE tenant_id=$1 AND node_id=$2 AND id=$3 AND state='active' FOR SHARE",
        [this.scope.tenantId, node.id, node.identityKeyId])).rows[0];
      const now = this.clock();
      if (!Number.isSafeInteger(now) || !key || new Date(key.valid_from).getTime() > now) conflict();
      const prepared = prepareNativeTaskApprovalWithLease({ job, attempt: stored.attempt, lease: stored.lease, input: plan.input,
        enrollment, nodeClass: configured.nodeClass, now });
      preparedAt = now; deadline = Math.min(prepared.start.deadline, key.valid_until ? new Date(key.valid_until).getTime() : Infinity);
      if (!Number.isFinite(deadline) || deadline <= now) conflict();
      const result = await finish(tx, { ...prepared, enrollment: structuredClone(enrollment), preparedAt: new Date(now).toISOString(),
        sourceInputDigest: plan.sourceInputDigest, inputDigest: job.inputDigest }, actor.id, node.identityKeyId, deadline, actor.assertTimeCurrent);
      assertFresh = result.assertFresh; return result.value;
    };
    if (queue) return new NativeQueueAuthority(db, this.scope, this.approvalStore!, this.clock).authenticated(queue, operation);
    if (!identity) conflict();
    return new WebSessionAuthority(db, this.scope, this.clock, "task").authenticated(identity, operation);
  }
  /** One canonical eligibility predicate for both task detail and project aggregation. */
  private async configuredCandidatesInSession(tx: DatabaseSession, project: Pick<ProjectView, "lifecycle" | "origin">,
    job: JobRecord, plan: Awaited<ReturnType<TaskExecutionPlanner["readInSession"]>>, hasCurrentAssignment: boolean) {
    const workScope = plan && (plan.schema === "control-room.task-execution-plan/v7" || plan.schema === "control-room.task-execution-plan/v8")
      ? "bounded_text_review" as const : "configured_task" as const;
    const candidates: Array<{ nodeId: string; label: string; platform: "macos" | "windows" | "linux" | "cloud";
      workScope: "bounded_text_review" | "configured_task" }> = [];
    if (!hasCurrentAssignment && plan && this.planner.isPlanAssignable(plan)
      && project.lifecycle === "active" && project.origin === "ordinary" && ["proposed", "ready", "orphaned"].includes(job.state)) {
      for (const route of this.routes.filter(route => route.executorId === job.authority.allowedExecutor)) {
        const row = (await tx.query<{ payload: unknown }>("SELECT payload FROM control_nodes WHERE tenant_id=$1 AND id=$2",
          [this.scope.tenantId, route.nodeId])).rows[0];
        if (!row) continue;
        const node = nodeRecordSchema.parse(row.payload);
        if (node.id !== route.nodeId || node.tenantId !== this.scope.tenantId) unavailable();
        candidates.push({ nodeId: node.id, label: node.displayName, platform: node.platform, workScope });
      }
    }
    assertNoSecretMaterial(candidates);
    return Object.freeze({ workScope, candidates: Object.freeze(candidates) });
  }

  async options(identity: VerifiedWebIdentity, projectId: string, jobId: string) {
    localId.parse(projectId); localId.parse(jobId);
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.assign", projectId, true);
      const project = await this.projects.getViewInSession(tx, actor, projectId), job = await this.job(tx, projectId, jobId);
      const plan = await this.planner.readInSession(tx, jobId);
      if (!plan || plan.projectId !== projectId) throw new WebAccessError("not_found");
      const stored = await this.stored(tx, job);
      const receipt = stored ? this.receipt(job, stored.attempt, stored.lease) : null;
      const { candidates } = await this.configuredCandidatesInSession(tx, project, job, plan,
        !!stored && stored.lease.state === "active");
      const recommendation = candidates.length === 1 ? { state: "one_configured_route" as const,
        nodeId: candidates[0]!.nodeId, label: candidates[0]!.label, workScope: candidates[0]!.workScope,
        availability: "unknown" as const, startsWork: false as const, grantsExecutionAuthority: false as const }
        : candidates.length > 1 ? { state: "choice_required" as const, configuredRouteCount: candidates.length,
          availability: "unknown" as const, startsWork: false as const, grantsExecutionAuthority: false as const }
          : { state: "not_available" as const, availability: "unknown" as const,
            startsWork: false as const, grantsExecutionAuthority: false as const };
      return { projectId, jobId, inputDigest: job.inputDigest, candidates, receipt, startsWork: false as const,
        recommendation, candidateEvidence: "configured_routes_only" as const };
    });
  }

  /**
   * Read-only, bounded project view over the same task-level assignment predicate.
   * It returns eligibility only: no route is reserved and no worker state is inferred.
   */
  async projectOptions(identity: VerifiedWebIdentity, projectId: string) {
    localId.parse(projectId);
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.assign", projectId, true);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      const rows = (await tx.query<{ id: string; state: string; version: number; workflow_id: string;
        job: unknown; workflow: unknown; request: unknown }>(`SELECT j.id,j.state,j.version,j.workflow_id,
          j.payload AS job,w.payload AS workflow,r.payload AS request
        FROM control_jobs j
        JOIN control_workflows w ON w.tenant_id=j.tenant_id AND w.id=j.workflow_id AND w.project_id=j.project_id
        JOIN control_requests r ON r.tenant_id=w.tenant_id AND r.id=w.request_id AND r.project_id=j.project_id
        WHERE j.tenant_id=$1 AND j.project_id=$2 AND j.state='proposed'
        ORDER BY j.id COLLATE "C" LIMIT 21`, [this.scope.tenantId, projectId])).rows;
      const workers = new Map<string, { nodeId: string; label: string; platform: "macos" | "windows" | "linux" | "cloud";
        eligibleTasks: Array<{ jobId: string; title: string; inputDigest: string;
          workScope: "bounded_text_review" | "configured_task" }> }>();
      for (const row of rows.slice(0, 20)) {
        const job = jobRecordSchema.parse(row.job), workflow = workflowRecordSchema.parse(row.workflow), request = requestRecordSchema.parse(row.request);
        if (job.tenantId !== this.scope.tenantId || workflow.tenantId !== this.scope.tenantId || request.tenantId !== this.scope.tenantId
          || job.projectId !== projectId || workflow.projectId !== projectId || request.projectId !== projectId
          || job.id !== row.id || job.state !== row.state || job.version !== Number(row.version)
          || job.workflowId !== row.workflow_id || workflow.id !== job.workflowId || request.id !== workflow.requestId
          || !workflow.jobIds.includes(job.id)) unavailable();
        const plan = await this.planner.readInSession(tx, job.id);
        if (plan && plan.projectId !== projectId) unavailable();
        const stored = await this.stored(tx, job, false);
        const { candidates } = await this.configuredCandidatesInSession(tx, project, job, plan, !!stored);
        for (const candidate of candidates) {
          const existing = workers.get(candidate.nodeId);
          if (existing && (existing.label !== candidate.label || existing.platform !== candidate.platform)) unavailable();
          const worker: { nodeId: string; label: string; platform: "macos" | "windows" | "linux" | "cloud";
            eligibleTasks: Array<{ jobId: string; title: string; inputDigest: string;
              workScope: "bounded_text_review" | "configured_task" }> } = existing ?? {
                nodeId: candidate.nodeId,
                label: candidate.label,
                platform: candidate.platform,
                eligibleTasks: [],
              };
          worker.eligibleTasks.push({ jobId: job.id, title: request.title, inputDigest: job.inputDigest,
            workScope: candidate.workScope });
          workers.set(candidate.nodeId, worker);
        }
      }
      const value = taskProjectAgentOptionsSchema.parse({
        projectId, eligibilitySource: "configured", workers: [...workers.values()].sort((left, right) => left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)
          .map(worker => ({ ...worker, eligibleTasks: worker.eligibleTasks.sort((left, right) => left.jobId < right.jobId ? -1 : left.jobId > right.jobId ? 1 : 0) })),
        tasksExamined: Math.min(rows.length, 20), additionalTasksOmitted: rows.length > 20,
        candidateEvidence: "configured_routes_only", observedAt: actor.now, startsWork: false,
        grantsAssignmentAuthority: false, grantsExecutionAuthority: false,
      });
      assertNoSecretMaterial(value);
      return value;
    });
  }
  private ids(jobId: string, attemptNumber = 1) {
    const suffix = sha256Digest(attemptNumber === 1 ? { ...this.scope, jobId } : { ...this.scope, jobId, attemptNumber }).slice(7);
    return { attemptId: `attempt:assignment:${suffix}`, leaseId: `lease:assignment:${suffix}`,
      transitionId: `transition:assignment:${suffix}`, idempotencyKey: `assignment:${suffix}`, auditId: `audit:assignment:${suffix}` };
  }
  private async job(tx: DatabaseSession, projectId: string, jobId: string) {
    const row = (await tx.query<{ payload: unknown; state: string; version: number }>(
      "SELECT payload,state,version FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
      [this.scope.tenantId, projectId, jobId])).rows[0];
    if (!row) throw new WebAccessError("not_found");
    const job = jobRecordSchema.parse(row.payload);
    if (job.tenantId !== this.scope.tenantId || job.projectId !== projectId || job.id !== jobId
      || job.state !== row.state || job.version !== Number(row.version)) unavailable();
    return job;
  }
  private receipt(job: JobRecord, attempt: AttemptRecord, lease: LeaseRecord) {
    if (attempt.tenantId !== job.tenantId || lease.tenantId !== job.tenantId || attempt.jobId !== job.id || lease.jobId !== job.id
      || lease.attemptId !== attempt.id || lease.nodeId !== attempt.nodeId || lease.epoch !== attempt.leaseEpoch
      || attempt.attemptNumber < 1) return unavailable();
    return { projectId: job.projectId, jobId: job.id, inputDigest: job.inputDigest, nodeId: lease.nodeId,
      attemptId: attempt.id, leaseId: lease.id, leaseEpoch: lease.epoch, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt,
      leaseState: lease.state, leaseCurrent: lease.state === "active" && Date.parse(lease.expiresAt) > this.clock(),
      startsWork: false as const, grantsExecutionAuthority: false as const };
  }
  private async stored(tx: DatabaseSession, job: JobRecord, lock = true) {
    const row = (await tx.query<{ payload: unknown; state: string; version: number; node_id: string; attempt_id: string;
      epoch: number; acquired_at: string | Date; expires_at: string | Date; attempt_number: number }>(
      `SELECT l.payload,l.state,l.version,l.node_id,l.attempt_id,l.epoch,l.acquired_at,l.expires_at,a.attempt_number
       FROM control_attempts a JOIN control_leases l
         ON l.tenant_id=a.tenant_id AND l.job_id=a.job_id AND l.attempt_id=a.id
       WHERE a.tenant_id=$1 AND a.job_id=$2
       ORDER BY a.attempt_number DESC LIMIT 1${lock ? " FOR UPDATE OF a,l" : ""}`,
      [this.scope.tenantId, job.id])).rows[0];
    if (!row) return undefined;
    const ids = this.ids(job.id, Number(row.attempt_number));
    if (row.attempt_id !== ids.attemptId) return unavailable();
    const lease = leaseRecordSchema.parse(row.payload);
    const attemptRow = (await tx.query<{ payload: unknown; state: string; version: number; node_id: string; lease_epoch: number; attempt_number: number }>(
      `SELECT payload,state,version,node_id,lease_epoch,attempt_number FROM control_attempts
       WHERE tenant_id=$1 AND job_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`,
      [this.scope.tenantId, job.id, row.attempt_id])).rows[0];
    if (!attemptRow) return unavailable();
    const attempt = attemptRecordSchema.parse(attemptRow.payload);
    const claim = (await tx.query<{ entity_id: string; safe_metadata: { attemptId?: string; leaseId?: string } }>(
      "SELECT entity_id,safe_metadata FROM control_transition_events WHERE tenant_id=$1 AND id=$2 AND entity_kind='job' AND idempotency_key=$3",
      [this.scope.tenantId, ids.transitionId, ids.idempotencyKey])).rows[0];
    if (!claim || claim.entity_id !== job.id || claim.safe_metadata.attemptId !== ids.attemptId || claim.safe_metadata.leaseId !== ids.leaseId
      || lease.id !== ids.leaseId || lease.state !== row.state || lease.version !== Number(row.version)
      || lease.nodeId !== row.node_id || lease.attemptId !== row.attempt_id || lease.epoch !== Number(row.epoch)
      || lease.acquiredAt !== new Date(row.acquired_at).toISOString() || lease.expiresAt !== new Date(row.expires_at).toISOString()
      || attempt.id !== ids.attemptId || attempt.state !== attemptRow.state || attempt.version !== Number(attemptRow.version)
      || attempt.nodeId !== attemptRow.node_id || attempt.leaseEpoch !== Number(attemptRow.lease_epoch)
      || attempt.attemptNumber !== Number(attemptRow.attempt_number)) return unavailable();
    this.receipt(job, attempt, lease); return { lease, attempt };
  }
  async assign(identity: VerifiedWebIdentity, projectId: string, jobId: string, nodeId: string, expectedInputDigest: string) {
    for (const id of [projectId, jobId, nodeId]) localId.parse(id); digestSchema.parse(expectedInputDigest);
    let commitDeadline: number | undefined;
    const db: DatabaseClient = { query: this.db.query.bind(this.db), transaction: this.db.transaction.bind(this.db),
      transactionWithPreCommitCheck: (work, check) => this.db.transactionWithPreCommitCheck(work, async () => {
        await check(); if (commitDeadline !== undefined && this.clock() >= commitDeadline) conflict();
      }) };
    return new WebSessionAuthority(db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.assign", projectId, true);
      return this.#assignLocked(tx, { projectId, jobId, nodeId, expectedInputDigest }, {
        actor: { actorId: actor.id, actorType: "human" },
        project: () => this.projects.getViewInSession(tx, actor, projectId),
        commitDeadline: value => { commitDeadline = value; },
      });
    });
  }

  /** Server-only standing-policy wrapper. The schedule service owns the surrounding transaction,
   * current-policy checks, and fixed node selection. This is absent from webOperation(). */
  async assignScheduledInSession(tx: DatabaseSession, input: Readonly<{ projectId: string; jobId: string;
    nodeId: string; expectedInputDigest: string }>, authority: Readonly<{
      assertCurrent: () => void | Promise<void>; commitDeadline: (value: number) => void }>) {
    for (const id of [input.projectId, input.jobId, input.nodeId]) localId.parse(id);
    digestSchema.parse(input.expectedInputDigest); await authority.assertCurrent();
    const result = await this.#assignLocked(tx, input, {
      actor: { actorId: "service:schedule-assignment:v1", actorType: "service" },
      project: async () => {
        const row = (await tx.query<{ lifecycle: ProjectView["lifecycle"] }>(`SELECT h.lifecycle FROM projects p
          JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
          WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 FOR SHARE OF p,h`,
        [this.scope.tenantId, this.scope.workspaceId, input.projectId])).rows[0];
        if (!row) conflict();
        return { lifecycle: row.lifecycle, origin: "ordinary" as const };
      },
      commitDeadline: authority.commitDeadline,
    });
    await authority.assertCurrent(); return result;
  }

  /** Authority-bearing wrappers must validate their caller before entering this transaction core.
   * ECMAScript privacy keeps the core unavailable to module consumers and browser composition. */
  async #assignLocked(tx: DatabaseSession,
    input: Readonly<{ projectId: string; jobId: string; nodeId: string; expectedInputDigest: string }>,
    authority: LockedAssignmentAuthority) {
      const { projectId, jobId, nodeId, expectedInputDigest } = input;
      // Match canonical ready-transition lock order and serialize capacity selection across owners.
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, projectId]);
      const project = await authority.project();
      const job = await this.job(tx, projectId, jobId);
      const plan = await this.planner.readInSession(tx, jobId);
      if (!plan || plan.projectId !== projectId || plan.tenantId !== this.scope.tenantId || job.inputDigest !== expectedInputDigest) conflict();
      const prior = await this.stored(tx, job);
      const canReassign = !!prior && (prior.lease.state === "expired" || job.state === "orphaned");
      if (prior && !canReassign) {
        if (prior.lease.nodeId !== nodeId) conflict();
        const priorRoute = this.routes.find(route => route.nodeId === prior.lease.nodeId
          && route.executorId === job.authority.allowedExecutor && route.executorId === prior.attempt.workerId);
        if (!priorRoute) conflict();
        await this.assertWorkBatchQueueAdmission(tx, job, priorRoute, prior.attempt.workerId ?? null);
        return { receipt: this.receipt(job, prior.attempt, prior.lease), replayed: true };
      }
      const attemptNumber = (prior?.attempt.attemptNumber ?? 0) + 1;
      const ids = this.ids(jobId, attemptNumber), canonical = new CanonicalStore(joined(tx));
      // These attempts are reservation lineage. A reservation that expired
      // before submission did not execute the task, so the job's execution
      // failure retry policy does not turn that terminal lease into a dead end.
      // The domain schema still bounds the lineage at 100 canonical attempts.
      // Fleet telemetry can select capacity, but it can never turn an
      // unprepared local process into an admitted worker.  The planner owns
      // the immutable installation policy and this check occurs before a new
      // lease is created; an already-recorded lease remains recoverable.
      this.planner.assertPlanAssignable(plan);
      const route = this.routes.find(route => route.nodeId === nodeId);
      if (!route) conflict();
      const batchAdmission = await this.assertWorkBatchQueueAdmission(tx, job, route);
      if (project.lifecycle !== "active" || project.origin !== "ordinary" || !["proposed", "ready", "orphaned"].includes(job.state)
        || job.authority.allowedExecutor !== route.executorId || job.requiredCapability !== route.capabilityProbeId
        || (!batchAdmission && job.dependsOnJobIds.length > 0) || attemptNumber > 100) conflict();
      await this.assertTransitionAdmission(tx, route.nodeId);
      const request = requestRecordSchema.parse(await canonical.get(this.scope.tenantId, "request", plan.request.id));
      const workflow = workflowRecordSchema.parse(await canonical.get(this.scope.tenantId, "workflow", plan.workflow.id));
      const firstAssignment = !prior;
      if (firstAssignment ? request.state !== "draft" || request.version !== 0 || workflow.state !== "proposed" || workflow.version !== 0
        : request.state !== "accepted" || workflow.state !== "active") conflict();
      const row = (await tx.query<{ payload: unknown; state: string; version: number }>(
        "SELECT payload,state,version FROM control_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [this.scope.tenantId, nodeId])).rows[0];
      if (!row) conflict();
      const node = nodeRecordSchema.parse(row.payload);
      if (node.id !== nodeId || node.tenantId !== this.scope.tenantId || node.state !== "active"
        || node.state !== row.state || node.version !== Number(row.version)) conflict();
      const key = (await tx.query<{ valid_from: string | Date; valid_until: string | Date | null }>(
        "SELECT valid_from,valid_until FROM control_node_keys WHERE tenant_id=$1 AND node_id=$2 AND id=$3 AND state='active' FOR SHARE",
        [this.scope.tenantId, nodeId, node.identityKeyId])).rows[0];
      const now = this.clock();
      if (!Number.isSafeInteger(now) || !key || new Date(key.valid_from).getTime() > now) conflict();
      const signals = await new FleetSignalStore(joined(tx)).current({ tenantId: this.scope.tenantId, nodeId });
      const eligible = evaluateFleetEligibility({ now: new Date(now).toISOString(), signals,
        requiredScratchBytes: route.requiredScratchBytes, requiredCapabilityProbeId: route.capabilityProbeId });
      const telemetry = signals.find(signal => signal.kind === "telemetry");
      const capability = signals.find(signal => signal.kind === "capability" && signal.payload.probeId === route.capabilityProbeId);
      if (!eligible.eligible || !telemetry || telemetry.kind !== "telemetry" || !capability
        || !["limited", "metered", "unmetered"].includes(telemetry.payload.networkClass)
        || ["critical", "blocked", "unavailable"].includes(telemetry.payload.thermalState)) conflict();
      const storedDeclaredScopes = (await tx.query<{ scope_kind: "file" | "tree"; path_fold: string }>(
        `SELECT scope_kind,path_fold FROM control_task_declared_scopes
         WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3 ORDER BY scope_kind,path_fold`,
      [this.scope.tenantId, projectId, jobId])).rows;
      // Legacy or non-browser producers may have no declaration row. Absence
      // never means conflict-free: conservatively serialize the whole repository.
      const declaredScopes = storedDeclaredScopes.length ? storedDeclaredScopes
        : [{ scope_kind: "tree" as const, path_fold: "" }];
      // Retain active ownership only. This bounded prune removes at least four
      // times the maximum rows one assignment can add, so ordinary assignment
      // traffic cannot grow stale scope evidence without bound. Lease-row locks
      // keep renewal from racing the stale decision.
      await tx.query(`WITH stale AS MATERIALIZED (
          SELECT s.tenant_id,s.lease_id,s.scope_kind,s.path_fold
          FROM control_assignment_lease_scopes s
          JOIN control_leases l ON l.tenant_id=s.tenant_id AND l.id=s.lease_id
          WHERE s.tenant_id=$1 AND s.project_id=$2
            AND (l.state<>'active' OR l.expires_at<=$3)
          ORDER BY l.expires_at,s.lease_id,s.scope_kind,s.path_fold
          LIMIT 256 FOR UPDATE OF l SKIP LOCKED
        )
        DELETE FROM control_assignment_lease_scopes s USING stale
        WHERE s.tenant_id=stale.tenant_id AND s.lease_id=stale.lease_id
          AND s.scope_kind=stale.scope_kind AND s.path_fold=stale.path_fold`,
      [this.scope.tenantId, projectId, new Date(now).toISOString()]);
      const held = (await tx.query<{ lease_id: string; job_id: string; node_id: string;
        scope_kind: "file" | "tree"; path_fold: string }>(`SELECT s.lease_id,s.job_id,s.node_id,s.scope_kind,s.path_fold
        FROM control_assignment_lease_scopes s
        JOIN control_leases l ON l.tenant_id=s.tenant_id AND l.id=s.lease_id
        WHERE s.tenant_id=$1 AND s.project_id=$2 AND s.job_id<>$3
          AND l.state='active' AND l.expires_at>$4
        ORDER BY s.lease_id,s.scope_kind,s.path_fold FOR UPDATE OF l`,
      [this.scope.tenantId, projectId, jobId, new Date(now).toISOString()])).rows;
      if (declaredScopes.some(requested => held.some(other => scopesOverlapV1(
        { scopeKind: requested.scope_kind, path: requested.path_fold },
        { scopeKind: other.scope_kind, path: other.path_fold })))) conflict();
      // Reported capabilities guide allocation only. They are never host qualification or local admission.
      const active = (await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_leases
        WHERE tenant_id=$1 AND node_id=$2 AND state='active'`, [this.scope.tenantId, nodeId])).rows[0];
      if (Number(active?.count) >= route.maxConcurrentTasks) conflict();
      const commitDeadline = Math.min(now + Math.min(route.leaseSeconds, job.authority.maxDurationSeconds) * 1000,
        Date.parse(job.authority.expiresAt), Date.parse(telemetry.expiresAt), Date.parse(capability.expiresAt),
        key.valid_until ? new Date(key.valid_until).getTime() : Infinity);
      if (commitDeadline <= now) conflict();
      authority.commitDeadline(commitDeadline);
      const occurredAt = new Date(now).toISOString(), actorRef = authority.actor;
      if (firstAssignment) {
        for (const [kind, entityId, expectedVersion, toState, suffix] of [
          ["request", request.id, 0, "submitted", "submit"], ["request", request.id, 1, "accepted", "accept"],
          ["workflow", workflow.id, 0, "active", "activate"],
        ] as const) await canonical.transition({ tenantId: this.scope.tenantId, kind, entityId, expectedVersion, toState,
          transitionId: `${ids.transitionId}:${suffix}`, idempotencyKey: `${ids.idempotencyKey}:${suffix}`, actor: actorRef, occurredAt });
      }
      const ready = job.state === "ready" ? job : (await canonical.transition({ tenantId: this.scope.tenantId, kind: "job", entityId: jobId,
        expectedVersion: job.version, toState: "ready", transitionId: `${ids.transitionId}:ready`,
        idempotencyKey: `${ids.idempotencyKey}:ready`, actor: actorRef, occurredAt })).entity as JobRecord;
      const claimed = await canonical.claimReadyJob({ ...ids, tenantId: this.scope.tenantId, jobId, expectedJobVersion: ready.version,
        nodeId, workerId: route.executorId, actor: actorRef, acquiredAt: occurredAt, expiresAt: new Date(commitDeadline).toISOString() });
      for (const declared of declaredScopes) await tx.query(`INSERT INTO control_assignment_lease_scopes
        (tenant_id,lease_id,project_id,job_id,attempt_id,node_id,scope_kind,path,path_fold)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [this.scope.tenantId, claimed.lease.id, projectId, jobId,
        claimed.attempt.id, nodeId, declared.scope_kind, declared.path_fold]);
      await appendAuditWith(tx, { id: ids.auditId, tenantId: this.scope.tenantId, projectId,
        actorId: actorRef.actorId, actorType: actorRef.actorType,
        action: "tasks.assign", targetType: "job", targetId: jobId, idempotencyKey: ids.idempotencyKey, occurredAt,
        safeMetadata: { nodeId, attemptId: claimed.attempt.id, leaseId: claimed.lease.id, inputDigest: job.inputDigest,
          routeDigest: sha256Digest(route), startsWork: false, localAdmissionRequired: true } });
      return { receipt: this.receipt(claimed.job, claimed.attempt, claimed.lease), replayed: false };
  }

  /** Reconcile an elapsed reservation only. This does not confirm a process stopped or make the
   * one-attempt task retryable through this coordinator. No timer or native cancellation is installed. */
  async expire(identity: VerifiedWebIdentity, projectId: string, jobId: string, expectedInputDigest: string) {
    localId.parse(projectId); localId.parse(jobId); digestSchema.parse(expectedInputDigest);
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.assign", projectId, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await this.projects.getViewInSession(tx, actor, projectId);
      const job = await this.job(tx, projectId, jobId), plan = await this.planner.readInSession(tx, jobId);
      if (!plan || plan.projectId !== projectId || plan.tenantId !== this.scope.tenantId || job.inputDigest !== expectedInputDigest) conflict();
      const canonical = new CanonicalStore(joined(tx));
      const stored = await this.stored(tx, job); if (!stored) conflict();
      const ids = this.ids(jobId, stored.attempt.attemptNumber);
      const { lease, attempt } = stored;
      const occurredAt = new Date(this.clock()).toISOString();
      if (lease.state === "expired") {
        await tx.query("DELETE FROM control_assignment_lease_scopes WHERE tenant_id=$1 AND lease_id=$2",
          [this.scope.tenantId, lease.id]);
        return { receipt: this.receipt(job, attempt, lease), replayed: true };
      }
      if (lease.state !== "active" || Date.parse(lease.expiresAt) > Date.parse(occurredAt)) conflict();
      // Serialize against allocation/fleet ingestion before releasing capacity.
      await tx.query("SELECT id FROM control_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [this.scope.tenantId, lease.nodeId]);
      const result = await canonical.expireLease({ tenantId: this.scope.tenantId, leaseId: lease.id, jobId, attemptId: attempt.id,
        expectedLeaseVersion: lease.version, expectedJobVersion: job.version, expectedAttemptVersion: attempt.version,
        epoch: lease.epoch, transitionId: `${ids.transitionId}:expire`, idempotencyKey: `${ids.idempotencyKey}:expire`,
        actor: { actorId: actor.id, actorType: "human" }, occurredAt });
      await tx.query("DELETE FROM control_assignment_lease_scopes WHERE tenant_id=$1 AND lease_id=$2",
        [this.scope.tenantId, lease.id]);
      await appendAuditWith(tx, { id: `${ids.auditId}:expire`, tenantId: this.scope.tenantId, projectId, actorId: actor.id, actorType: "human",
        action: "tasks.assignment.expire", targetType: "job", targetId: jobId, idempotencyKey: `${ids.idempotencyKey}:expire`, occurredAt,
        safeMetadata: { attemptId: attempt.id, leaseId: lease.id, leaseEpoch: lease.epoch, startsWork: false, confirmsNativeStop: false } });
      return { receipt: this.receipt(result.job, result.attempt, result.lease), replayed: result.replayed };
    });
  }
}
