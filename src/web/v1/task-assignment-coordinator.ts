import { z } from "zod";
import { attemptRecordSchema, jobRecordSchema, leaseRecordSchema, nodeRecordSchema,
  requestRecordSchema, workflowRecordSchema, type AttemptRecord, type JobRecord, type LeaseRecord } from "../../domain/v1";
import { CanonicalStore } from "../../persistence/canonical-store";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { MAX_NATIVE_UNSENT_RECOVERIES, nativeTaskSubmissionReferenceSchema, type NativeTaskSubmissionReference, type NativeTaskSubmission } from "../../persistence/native-task-submission";
import { FleetSignalStore } from "../../node-fleet/v1/fleet-signal-store";
import { evaluateFleetEligibility } from "../../node-fleet/v1/eligibility";
import { appendAuditWith } from "../../audit/audit-store";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebSessionAuthority, type WebActor } from "./session-authority";
import { NativeQueueAuthority } from "./native-queue-authority";
import { WebProjectService } from "./project-service";
import type { TaskExecutionPlanner } from "./task-execution-planner";
import { enrollmentSchema, type NativeEnrollment } from "../../harness/v1/native-run-contracts";
import { prepareNativeTaskApproval } from "../../harness/v1/native-task-approval-binding";
import type { NativeApprovalPacketStore } from "./native-approval-packet-store";
import { nativeTaskApprovalPacketSchema } from "../../harness/v1/native-approval-packet";
import type { NativeTaskQueueScope } from "./native-task-queue";
import type { ServerNodeSession } from "../../node-control/server-node-session";

type CanonicalNativeApproval = ReturnType<typeof prepareNativeTaskApproval> & {
  enrollment: NativeEnrollment; preparedAt: string; sourceInputDigest: string; inputDigest: string;
};

const routeSchema = z.object({ nodeId: localId, executorId: localId,
  capabilityProbeId: z.literal("harness.hermes.native.runs.v1"),
  maxConcurrentTasks: z.number().int().min(1).max(8), requiredScratchBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  leaseSeconds: z.number().int().min(1).max(300) }).strict();
export type TaskAssignmentRoute = z.infer<typeof routeSchema>;
export type NativeApprovalEnrollment = { enrollment: NativeEnrollment; nodeClass: string };
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
  assign: TaskAssignmentCoordinator["assign"]; expire: TaskAssignmentCoordinator["expire"]; options: TaskAssignmentCoordinator["options"] }>;
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
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly planner: TaskExecutionPlanner, routes: readonly TaskAssignmentRoute[],
    private readonly clock: () => number = Date.now, enrollments: readonly NativeApprovalEnrollment[] = [],
    private readonly approvalStore?: NativeApprovalPacketStore,
    private readonly nativeTaskSubmission?: NativeTaskSubmission) {
    const plannerScope = planner.webOperation();
    if (plannerScope.tenantId !== scope.tenantId || plannerScope.workspaceId !== scope.workspaceId) unavailable();
    this.scope = Object.freeze({ ...scope });
    this.routes = validateTaskAssignmentRoutes(routes);
    this.enrollments = validateNativeApprovalEnrollments(enrollments, scope.tenantId, this.routes);
    this.projects = new WebProjectService(db, scope, clock);
  }
  webOperation(): TaskAssignmentOperation {
    return Object.freeze({ ...this.scope, assign: this.assign.bind(this), expire: this.expire.bind(this), options: this.options.bind(this) });
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
      return { value: { nodeId: prepared.request.nodeId }, assertFresh: verified.assertFresh };
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
      ready?.assertCurrent();
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
        if (signal.aborted) conflict(); ready?.assertCurrent(); verified.assertFresh();
      } };
    }, ref);
  }
  /** Called only by the trusted signed-ready session hook. Discovery is bounded
   * and is not authority: every candidate is independently authenticated and checked. */
  async recoverForReadyNode(input: { nodeId: string; attemptId?: string }, signal: AbortSignal, assertCurrent: () => void) {
    const nodeId = localId.parse(input.nodeId), attemptId = input.attemptId === undefined ? undefined : localId.parse(input.attemptId);
    if (!this.nativeTaskSubmission?.recoverUnsentInSession || !(signal instanceof AbortSignal) || signal.aborted) conflict();
    const current = () => { if (signal.aborted) conflict(); assertCurrent(); };
    current();
    const rows = (await this.db.query<{ project_id: string; job_id: string; attempt_id: string; record: { inputDigest?: string; packetDigest?: string } }>(
      `SELECT q.project_id,q.job_id,q.attempt_id,q.record FROM control_native_task_queue q
       JOIN control_attempts a ON a.tenant_id=q.tenant_id AND a.job_id=q.job_id AND a.id=q.attempt_id
       JOIN control_leases l ON l.tenant_id=q.tenant_id AND l.job_id=q.job_id AND l.attempt_id=q.attempt_id
       WHERE q.tenant_id=$1 AND a.node_id=$2 AND l.state='active' AND l.expires_at>$3
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
    return session.stageNativeDispatch((sign, channel) => this.withNativeApproval(identity, projectId, jobId, expectedInputDigest,
      async (tx, prepared, actorId, nodeKeyId, deadline) => {
        if (expectedAttemptId !== undefined && prepared.request.attemptId !== expectedAttemptId) conflict();
        if (channel.tenantId !== this.scope.tenantId || channel.nodeId !== prepared.request.nodeId || channel.nodeKeyId !== nodeKeyId) conflict();
        const saved = await store.stageDeliveryEnvelopeInSession(tx, prepared, expectedPacketDigest, actorId, signal, sign, channel, deadline);
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
    return session.sendPreparedNativeDispatch((frame, channel) => this.withNativeApproval(identity, projectId, jobId, expectedInputDigest,
      async (tx, prepared, actorId, nodeKeyId, deadline, assertAuthorizationTime) => {
        if (expectedAttemptId !== undefined && prepared.request.attemptId !== expectedAttemptId) conflict();
        if (channel.tenantId !== this.scope.tenantId || channel.nodeId !== prepared.request.nodeId || channel.nodeKeyId !== nodeKeyId
            || Date.parse(frame.expiresAt) > deadline) conflict();
        const saved = await store.recordTransmissionInSession(tx, prepared, expectedPacketDigest, actorId, signal, frame, channel);
        const checkedAt = this.clock();
        const assertFresh = () => {
          assertAuthorizationTime(); saved.assertFresh(); const now = this.clock();
          if (!Number.isSafeInteger(now) || now < checkedAt || now >= deadline) conflict();
        };
        await appendAuditWith(tx, { id: `audit:transmit:${saved.receipt.queueId}`, tenantId: this.scope.tenantId, actorId, actorType: "human",
          action: "native.delivery.transmission_requested", targetType: "job", targetId: jobId, correlationId: saved.receipt.queueId,
          idempotencyKey: `transmit:${saved.receipt.queueId}`, safeMetadata: { frameDigest: saved.receipt.frameDigest }, occurredAt: saved.receipt.requestedAt });
        return { value: { value: saved.receipt, assertFresh }, assertFresh };
      }, queue));
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
      const configured = this.enrollments.find(e => e.enrollment.nodeId === stored.lease.nodeId), route = this.routes.find(r => r.nodeId === stored.lease.nodeId);
      if (!configured || !route || route.executorId !== job.authority.allowedExecutor) conflict();
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
      const prepared = prepareNativeTaskApproval({ job, attempt: stored.attempt, lease: stored.lease, input: plan.input,
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
  async options(identity: VerifiedWebIdentity, projectId: string, jobId: string) {
    localId.parse(projectId); localId.parse(jobId);
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.assign", projectId, true);
      const project = await this.projects.getViewInSession(tx, actor, projectId), job = await this.job(tx, projectId, jobId);
      const plan = await this.planner.readInSession(tx, jobId);
      if (!plan || plan.projectId !== projectId) throw new WebAccessError("not_found");
      const stored = await this.stored(tx, job);
      const receipt = stored ? this.receipt(job, stored.attempt, stored.lease) : null;
      const candidates: Array<{ nodeId: string; label: string; platform: string }> = [];
      if (!stored && project.lifecycle === "active" && project.origin === "ordinary" && job.state === "proposed") {
        for (const route of this.routes.filter(route => route.executorId === job.authority.allowedExecutor)) {
          const row = (await tx.query<{ payload: unknown }>("SELECT payload FROM control_nodes WHERE tenant_id=$1 AND id=$2",
            [this.scope.tenantId, route.nodeId])).rows[0];
          if (!row) continue;
          const node = nodeRecordSchema.parse(row.payload);
          if (node.id !== route.nodeId || node.tenantId !== this.scope.tenantId) unavailable();
          candidates.push({ nodeId: node.id, label: node.displayName, platform: node.platform });
        }
      }
      assertNoSecretMaterial(candidates);
      return { projectId, jobId, inputDigest: job.inputDigest, candidates, receipt, startsWork: false as const,
        candidateEvidence: "configured_routes_only" as const };
    });
  }
  private ids(jobId: string) {
    const suffix = sha256Digest({ ...this.scope, jobId }).slice(7);
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
      || attempt.attemptNumber !== 1) return unavailable();
    return { projectId: job.projectId, jobId: job.id, inputDigest: job.inputDigest, nodeId: lease.nodeId,
      attemptId: attempt.id, leaseId: lease.id, leaseEpoch: lease.epoch, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt,
      leaseState: lease.state, leaseCurrent: lease.state === "active" && Date.parse(lease.expiresAt) > this.clock(),
      startsWork: false as const, grantsExecutionAuthority: false as const };
  }
  private async stored(tx: DatabaseSession, job: JobRecord) {
    const ids = this.ids(job.id);
    const row = (await tx.query<{ payload: unknown; state: string; version: number; node_id: string; attempt_id: string;
      epoch: number; acquired_at: string | Date; expires_at: string | Date }>(
      "SELECT payload,state,version,node_id,attempt_id,epoch,acquired_at,expires_at FROM control_leases WHERE tenant_id=$1 AND job_id=$2 AND id=$3 FOR UPDATE",
      [this.scope.tenantId, job.id, ids.leaseId])).rows[0];
    if (!row) return undefined;
    const lease = leaseRecordSchema.parse(row.payload);
    const attemptRow = (await tx.query<{ payload: unknown; state: string; version: number; node_id: string; lease_epoch: number; attempt_number: number }>(
      "SELECT payload,state,version,node_id,lease_epoch,attempt_number FROM control_attempts WHERE tenant_id=$1 AND job_id=$2 AND id=$3 FOR UPDATE",
      [this.scope.tenantId, job.id, ids.attemptId])).rows[0];
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
      // Match canonical ready-transition lock order and serialize capacity selection across owners.
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      await tx.query("SELECT project_id FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
        [this.scope.tenantId, projectId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      const job = await this.job(tx, projectId, jobId);
      const plan = await this.planner.readInSession(tx, jobId);
      if (!plan || plan.projectId !== projectId || plan.tenantId !== this.scope.tenantId || job.inputDigest !== expectedInputDigest) conflict();
      const ids = this.ids(jobId), canonical = new CanonicalStore(joined(tx));
      const prior = await this.stored(tx, job);
      if (prior) {
        if (prior.lease.nodeId !== nodeId) conflict();
        return { receipt: this.receipt(job, prior.attempt, prior.lease), replayed: true };
      }
      const route = this.routes.find(route => route.nodeId === nodeId);
      if (!route || project.lifecycle !== "active" || project.origin !== "ordinary" || job.state !== "proposed" || job.version !== 0
        || job.authority.allowedExecutor !== route.executorId || job.requiredCapability !== route.capabilityProbeId
        || job.retryPolicy.maxAttempts !== 1 || job.retryPolicy.retryAfterOrphan || job.dependsOnJobIds.length) conflict();
      if ((await tx.query("SELECT id FROM control_attempts WHERE tenant_id=$1 AND job_id=$2 LIMIT 1", [this.scope.tenantId, jobId])).rows.length) conflict();
      const request = requestRecordSchema.parse(await canonical.get(this.scope.tenantId, "request", plan.request.id));
      const workflow = workflowRecordSchema.parse(await canonical.get(this.scope.tenantId, "workflow", plan.workflow.id));
      if (request.state !== "draft" || request.version !== 0 || workflow.state !== "proposed" || workflow.version !== 0) conflict();
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
      // Reported capabilities guide allocation only. They are never host qualification or local admission.
      const active = (await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_leases
        WHERE tenant_id=$1 AND node_id=$2 AND state='active'`, [this.scope.tenantId, nodeId])).rows[0];
      if (Number(active?.count) >= route.maxConcurrentTasks) conflict();
      commitDeadline = Math.min(now + Math.min(route.leaseSeconds, job.authority.maxDurationSeconds) * 1000,
        Date.parse(job.authority.expiresAt), Date.parse(telemetry.expiresAt), Date.parse(capability.expiresAt),
        key.valid_until ? new Date(key.valid_until).getTime() : Infinity);
      if (commitDeadline <= now) conflict();
      const occurredAt = new Date(now).toISOString(), actorRef = { actorId: actor.id, actorType: "human" as const };
      for (const [kind, entityId, expectedVersion, toState, suffix] of [
        ["request", request.id, 0, "submitted", "submit"], ["request", request.id, 1, "accepted", "accept"],
        ["workflow", workflow.id, 0, "active", "activate"],
      ] as const) await canonical.transition({ tenantId: this.scope.tenantId, kind, entityId, expectedVersion, toState,
        transitionId: `${ids.transitionId}:${suffix}`, idempotencyKey: `${ids.idempotencyKey}:${suffix}`, actor: actorRef, occurredAt });
      await canonical.transition({ tenantId: this.scope.tenantId, kind: "job", entityId: jobId, expectedVersion: 0, toState: "ready",
        transitionId: `${ids.transitionId}:ready`, idempotencyKey: `${ids.idempotencyKey}:ready`, actor: actorRef, occurredAt });
      const claimed = await canonical.claimReadyJob({ ...ids, tenantId: this.scope.tenantId, jobId, expectedJobVersion: 1,
        nodeId, actor: actorRef, acquiredAt: occurredAt, expiresAt: new Date(commitDeadline).toISOString() });
      await appendAuditWith(tx, { id: ids.auditId, tenantId: this.scope.tenantId, projectId, actorId: actor.id, actorType: "human",
        action: "tasks.assign", targetType: "job", targetId: jobId, idempotencyKey: ids.idempotencyKey, occurredAt,
        safeMetadata: { nodeId, attemptId: claimed.attempt.id, leaseId: claimed.lease.id, inputDigest: job.inputDigest,
          routeDigest: sha256Digest(route), startsWork: false, localAdmissionRequired: true } });
      return { receipt: this.receipt(claimed.job, claimed.attempt, claimed.lease), replayed: false };
    });
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
      const ids = this.ids(jobId), canonical = new CanonicalStore(joined(tx));
      const stored = await this.stored(tx, job); if (!stored) conflict();
      const { lease, attempt } = stored;
      const occurredAt = new Date(this.clock()).toISOString();
      if (lease.state === "expired") return { receipt: this.receipt(job, attempt, lease), replayed: true };
      if (lease.state !== "active" || Date.parse(lease.expiresAt) > Date.parse(occurredAt)) conflict();
      // Serialize against allocation/fleet ingestion before releasing capacity.
      await tx.query("SELECT id FROM control_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [this.scope.tenantId, lease.nodeId]);
      const result = await canonical.expireLease({ tenantId: this.scope.tenantId, leaseId: lease.id, jobId, attemptId: attempt.id,
        expectedLeaseVersion: lease.version, expectedJobVersion: job.version, expectedAttemptVersion: attempt.version,
        epoch: lease.epoch, transitionId: `${ids.transitionId}:expire`, idempotencyKey: `${ids.idempotencyKey}:expire`,
        actor: { actorId: actor.id, actorType: "human" }, occurredAt });
      await appendAuditWith(tx, { id: `${ids.auditId}:expire`, tenantId: this.scope.tenantId, projectId, actorId: actor.id, actorType: "human",
        action: "tasks.assignment.expire", targetType: "job", targetId: jobId, idempotencyKey: `${ids.idempotencyKey}:expire`, occurredAt,
        safeMetadata: { attemptId: attempt.id, leaseId: lease.id, leaseEpoch: lease.epoch, startsWork: false, confirmsNativeStop: false } });
      return { receipt: this.receipt(result.job, result.attempt, result.lease), replayed: result.replayed };
    });
  }
}
