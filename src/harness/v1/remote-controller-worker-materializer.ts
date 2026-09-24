import { z } from "zod";
import { signedNodeFrameSchema, type SignedNodeFrame } from "../../node-protocol/v1";
import { HarnessRunStoreV1 } from "./store";
import { remoteTaskRegistrationSchemaV1 } from "./remote-task-registration";
import { attemptRecordSchema, jobRecordSchema, leaseRecordSchema } from "../../domain/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { sha256Digest, hmacSha256Tag } from "../../security";
import { type TaskExecutionPlanner, controllerWorkerRemoteTaskExecutionPlanSchemaV11,
  controllerWorkerRemoteTaskExecutionPlanSchemaV12 } from "../../web/v1/task-execution-planner";
import { controllerWorkerAdapterIdSchemaV1, controllerWorkerDeliverySchemaV1,
  createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryReceiptV1, type ControllerWorkerDeliveryV1 } from "./controller-worker-delivery";
import { persistControllerWorkerDeliveryReceiptV1, readControllerWorkerDeliveryReceiptV1 } from "./controller-worker-delivery-receipt-store";
import { CONTROLLER_WORKER_REMOTE_ADAPTER_V1, CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
  CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1, admitRemoteWorkerDeliveryV1, remoteWorkerEnrollmentSchemaV1,
  type RemoteWorkerEnrollmentV1 } from "./remote-worker-delivery";
import { readCurrentRemoteWorkerEnrollmentV1 } from "./remote-worker-enrollment-store";
import { createAuthenticatedRemoteNodeSessionDeliveryBridgeV1, type AuthenticatedRemoteNodeSessionV1,
  type RemoteNodeDeliveryTransmissionV1 } from "./remote-session-delivery-bridge";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const adapterRevision = z.string().min(7).max(180);
const unavailable = (): never => { throw new Error("remote_controller_worker_materializer_unavailable"); };
const joined = (tx: DatabaseSession): DatabaseClient => Object.freeze({
  query: tx.query.bind(tx),
  transaction: async <T,>(work: (session: DatabaseSession) => Promise<T>) => work(tx),
  transactionWithPreCommitCheck: async <T,>(work: (session: DatabaseSession) => Promise<T>,
    check: () => void | Promise<void>) => { const result = await work(tx); await check(); return result; },
});

export const REMOTE_CONTROLLER_WORKER_MATERIALIZER_V1 =
  "control-room.remote-controller-worker-materializer/v1" as const;

/** A leased canonical task reference.  It has no worker, connection, address,
 * credential, or transport input: those facts belong to the protected resolver. */
export type RemoteControllerWorkerMaterializationReferenceV1 = Readonly<{
  tenantId: string; projectId: string; jobId: string; attemptId: string; leaseId: string; inputDigest: string;
}>;

/** The only resolver input is controller-derived placement and plan facts. */
export type RemoteControllerWorkerTargetRequestV1 = Readonly<{
  tenantId: string; nodeId: string; adapterId: typeof CONTROLLER_WORKER_REMOTE_ADAPTER_V1;
  requiredCapability: typeof CONTROLLER_WORKER_REMOTE_CAPABILITY_V1; connectorProfileDigest: string;
}>;

/**
 * Installation-owned target facts. The session is intentionally opaque to the
 * browser and task plan. A resolver may use protected enrollment/session state
 * to select it, but it cannot replace the canonical attempt node supplied by
 * the materializer.
 */
export type RemoteControllerWorkerResolvedTargetV1 = Readonly<{
  nodeId: string; workerId: string; adapterId: string; adapterRevision: string;
  enrollment: RemoteWorkerEnrollmentV1; supportedAdapterRevisions: readonly string[];
  enrollmentAuthority: Readonly<{ nodeKeyId: string; capabilityDigest: string; releaseBindingDigest: string }>;
  session: AuthenticatedRemoteNodeSessionV1;
}>;

export interface RemoteControllerWorkerTargetResolverV1 {
  resolve(input: RemoteControllerWorkerTargetRequestV1): Promise<unknown>;
}

export type RemoteControllerWorkerPreparedDeliveryV1 = Readonly<{
  schema: typeof REMOTE_CONTROLLER_WORKER_MATERIALIZER_V1;
  delivery: ControllerWorkerDeliveryV1;
  workflowId: string;
  route: Readonly<{ kind: "remote"; workerId: string }>;
  enrollmentDigest: string;
  startsWork: false;
  grantsExecutionAuthority: false;
}>;

const referenceSchema = z.object({ tenantId: id, projectId: id, jobId: id, attemptId: id, leaseId: id, inputDigest: digest }).strict();
const preparedSchema = z.object({
  schema: z.literal(REMOTE_CONTROLLER_WORKER_MATERIALIZER_V1), delivery: controllerWorkerDeliverySchemaV1,
  workflowId: id, route: z.object({ kind: z.literal("remote"), workerId: id }).strict(), enrollmentDigest: digest,
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
const targetSchema = z.object({
  nodeId: id, workerId: id, adapterId: controllerWorkerAdapterIdSchemaV1, adapterRevision,
  enrollment: remoteWorkerEnrollmentSchemaV1, supportedAdapterRevisions: z.array(adapterRevision).min(1).max(32),
  enrollmentAuthority: z.object({ nodeKeyId: id, capabilityDigest: digest, releaseBindingDigest: digest }).strict(),
  session: z.unknown(),
}).strict();

function captureTarget(value: unknown): RemoteControllerWorkerResolvedTargetV1 {
  const parsed = targetSchema.parse(value);
  if (new Set(parsed.supportedAdapterRevisions).size !== parsed.supportedAdapterRevisions.length
    || parsed.enrollment.workerId !== parsed.workerId || parsed.enrollment.adapterId !== parsed.adapterId
    || parsed.enrollment.adapterRevision !== parsed.adapterRevision) unavailable();
  const session = parsed.session as Partial<AuthenticatedRemoteNodeSessionV1>;
  if (!session || typeof session !== "object" || session.workerId !== parsed.workerId
    || session.enrollmentDigest !== parsed.enrollment.enrollmentDigest || !session.session
    || typeof session.session.controllerWorkerDeliveryChannel !== "function"
    || typeof session.session.stageControllerWorkerDelivery !== "function"
    || typeof session.session.sendPreparedControllerWorkerDelivery !== "function"
    || typeof session.session.acceptControllerWorkerDeliveryReceipt !== "function") unavailable();
  return Object.freeze({ nodeId: parsed.nodeId, workerId: parsed.workerId, adapterId: parsed.adapterId,
    adapterRevision: parsed.adapterRevision, enrollment: parsed.enrollment,
    supportedAdapterRevisions: Object.freeze([...parsed.supportedAdapterRevisions]),
    enrollmentAuthority: Object.freeze(parsed.enrollmentAuthority),
    session: session as AuthenticatedRemoteNodeSessionV1 });
}

function bindingDigest(value: RemoteControllerWorkerPreparedDeliveryV1) {
  return sha256Digest({ workflowId: value.workflowId, route: value.route, enrollmentDigest: value.enrollmentDigest,
    identity: value.delivery.identity, worker: value.delivery.worker, input: value.delivery.input,
    authorityDigest: value.delivery.authorityDigest, connectorProfileDigest: value.delivery.connectorProfileDigest,
    acceptanceProfileId: value.delivery.acceptanceProfileId,
    acceptanceProfileDigest: value.delivery.acceptanceProfileDigest, expiresAt: value.delivery.expiresAt });
}

/**
 * Reconstructs one remote delivery from a leased task and a protected
 * controller-owned target. It does not enroll a node, open a connection,
 * create a queue, launch a worker, or accept browser-selected routing.
 */
export class RemoteControllerWorkerMaterializerV1 {
  constructor(private readonly db: DatabaseClient, private readonly planner: Pick<TaskExecutionPlanner, "readInSession">,
    private readonly resolver: RemoteControllerWorkerTargetResolverV1, private readonly integrityKey: Uint8Array,
    private readonly clock: () => number = Date.now) {
    if (!db || typeof db.transaction !== "function" || !planner || typeof planner.readInSession !== "function"
      || !resolver || typeof resolver.resolve !== "function" || !(integrityKey instanceof Uint8Array)
      || integrityKey.length !== 32 || typeof clock !== "function") unavailable();
  }

  async prepare(value: RemoteControllerWorkerMaterializationReferenceV1): Promise<RemoteControllerWorkerPreparedDeliveryV1> {
    const ref = referenceSchema.parse(value);
    return this.db.transaction(async tx => {
      const intent = await this.readIntent(tx, ref);
      if (!intent) return this.prepareInSession(tx, ref);
      await this.resolveForPrepared(ref, intent, tx);
      return intent;
    });
  }

  private async readIntent(tx: DatabaseSession, ref: z.infer<typeof referenceSchema>) {
    const row = (await tx.query<{ request_digest: string; result: { prepared: unknown; tag: string; signedFrame?: unknown } }>(
      `SELECT request_digest,result FROM control_idempotency WHERE tenant_id=$1
       AND operation_scope='remote-controller-worker-dispatch-intent/v1' AND idempotency_key=$2`,
      [ref.tenantId, ref.attemptId])).rows[0];
    if (!row) return null;
    const prepared = preparedSchema.parse(row.result.prepared) as RemoteControllerWorkerPreparedDeliveryV1;
    const signedFrame = row.result.signedFrame === undefined ? undefined : signedNodeFrameSchema.parse(row.result.signedFrame);
    if (row.request_digest !== sha256Digest(ref)
      || row.result.tag !== hmacSha256Tag(this.integrityKey, { ref, prepared, ...(signedFrame ? { signedFrame } : {}) })) unavailable();
    return prepared;
  }

  /** A changed lease, plan, enrollment, selected worker, or session binding
   * fails closed before any remote transmission. */
  async assertCurrent(value: RemoteControllerWorkerMaterializationReferenceV1, preparedValue: unknown): Promise<void> {
    const ref = referenceSchema.parse(value);
    const prepared = preparedSchema.parse(preparedValue) as RemoteControllerWorkerPreparedDeliveryV1;
    const current = await this.db.transaction(tx => this.prepareInSession(tx, ref));
    if (bindingDigest(prepared) !== bindingDigest(current)) unavailable();
  }

  /**
   * Stages/sends through the existing authenticated node-session bridge. A
   * durable dispatch intent suppresses a second send even without a receipt.
   * The exact signed envelope is also committed immediately before send so
   * a replacement authenticated session can reconcile its existing receipt.
   */
  async transmit(value: RemoteControllerWorkerMaterializationReferenceV1, preparedValue: unknown,
    signal?: AbortSignal): Promise<Readonly<{ kind: "transmitted"; transmission: RemoteNodeDeliveryTransmissionV1; startsWork: false; grantsExecutionAuthority: false } | {
      kind: "already_recorded"; receipt: ControllerWorkerDeliveryReceiptV1; startsWork: false; grantsExecutionAuthority: false } | {
      kind: "uncertain"; startsWork: false; grantsExecutionAuthority: false }>> {
    if (signal?.aborted) unavailable();
    const ref = referenceSchema.parse(value);
    const prepared = preparedSchema.parse(preparedValue) as RemoteControllerWorkerPreparedDeliveryV1;
    await this.resolveForPrepared(ref, prepared);
    const prior = await this.db.transaction(tx => readControllerWorkerDeliveryReceiptV1(tx, this.integrityKey, {
      tenantId: ref.tenantId, projectId: ref.projectId, jobId: ref.jobId, attemptId: ref.attemptId }));
    if (prior) {
      if (prior.delivery.deliveryDigest !== prepared.delivery.deliveryDigest
        || prior.receipt.route.kind !== "remote" || prior.receipt.route.workerId !== prepared.route.workerId) unavailable();
      return Object.freeze({ kind: "already_recorded" as const, receipt: prior.receipt,
        startsWork: false as const, grantsExecutionAuthority: false as const });
    }
    const existingIntent = await this.db.transaction(tx => this.readIntent(tx, ref));
    if (existingIntent) {
      if (sha256Digest(existingIntent) !== sha256Digest(prepared)) unavailable();
      return Object.freeze({ kind: "uncertain", startsWork: false, grantsExecutionAuthority: false });
    }
    await this.assertCurrent(ref, prepared);
    const target = await this.resolveForPrepared(ref, prepared);
    const admission = admitRemoteWorkerDeliveryV1({ delivery: prepared.delivery, route: prepared.route,
      enrollment: target.enrollment, supportedAdapterRevisions: target.supportedAdapterRevisions });
    if (!admission.accepted) unavailable();
    // Commit the immutable packet before any transport effect. A crash at any
    // later point means uncertainty, never permission to send it again.
    const claimed = await this.db.transaction(async tx => {
      const current = await this.prepareInSession(tx, ref);
      if (sha256Digest(current) !== sha256Digest(prepared)) unavailable();
      const inserted = await tx.query(`INSERT INTO control_idempotency
        (tenant_id,operation_scope,idempotency_key,request_digest,status,result)
        VALUES($1,'remote-controller-worker-dispatch-intent/v1',$2,$3,'completed',$4::jsonb)
        ON CONFLICT(tenant_id,operation_scope,idempotency_key) DO NOTHING RETURNING idempotency_key`,
      [ref.tenantId, ref.attemptId, sha256Digest(ref), JSON.stringify({ prepared,
        tag: hmacSha256Tag(this.integrityKey, { ref, prepared }) })]);
      return inserted.rows.length === 1;
    });
    if (!claimed) return Object.freeze({ kind: "uncertain", startsWork: false, grantsExecutionAuthority: false });
    try {
      const transmission = await createAuthenticatedRemoteNodeSessionDeliveryBridgeV1({ session: target.session })
        .transmit(prepared.delivery, prepared.route, signal, async frame => {
          await this.assertCurrent(ref, prepared);
          const signedFrame = signedNodeFrameSchema.parse(frame);
          if (signedFrame.type !== "controller.worker.delivery" || signedFrame.body.delivery.deliveryDigest !== prepared.delivery.deliveryDigest
            || signedFrame.body.enrollmentDigest !== prepared.enrollmentDigest) unavailable();
          await this.db.transaction(async tx => {
            const tag = hmacSha256Tag(this.integrityKey, { ref, prepared });
            const updated = await tx.query(`UPDATE control_idempotency SET result=$4::jsonb
              WHERE tenant_id=$1 AND operation_scope='remote-controller-worker-dispatch-intent/v1'
              AND idempotency_key=$2 AND request_digest=$3 AND result->>'tag'=$5
              RETURNING idempotency_key`, [ref.tenantId, ref.attemptId, sha256Digest(ref),
              JSON.stringify({ prepared, signedFrame, tag: hmacSha256Tag(this.integrityKey, { ref, prepared, signedFrame }) }), tag]);
            if (updated.rows.length !== 1) unavailable();
          });
          await this.assertCurrent(ref, prepared);
        });
      return Object.freeze({ kind: "transmitted" as const, transmission,
        startsWork: false as const, grantsExecutionAuthority: false as const });
    } catch {
      // The intent has committed. Even a rejected transport promise cannot
      // prove the peer did not receive the packet.
      return Object.freeze({ kind: "uncertain", startsWork: false, grantsExecutionAuthority: false });
    }
  }

  /** Accepts only the signed receipt for the durably recorded packet, then
   * stores it in the existing PostgreSQL receipt table. It does not execute
   * work and a receipt replay is intentionally harmless. An expired lease is
   * not new execution authority: the original receipt's receive time must
   * still be inside the packet window, and the session authenticates the
   * envelope. Lost session recovery is not implemented by this method. */
  async acceptReceipt(value: RemoteControllerWorkerMaterializationReferenceV1, preparedValue: unknown,
    raw: string | Uint8Array, recordedAt: unknown) {
    const ref = referenceSchema.parse(value);
    const prepared = preparedSchema.parse(preparedValue) as RemoteControllerWorkerPreparedDeliveryV1;
    const intent = await this.db.transaction(tx => this.readIntent(tx, ref));
    if (!intent || sha256Digest(intent) !== sha256Digest(prepared)) unavailable();
    const target = await this.resolveForPrepared(ref, prepared);
    const bridge = createAuthenticatedRemoteNodeSessionDeliveryBridgeV1({ session: target.session });
    return bridge.acceptReceipt(raw, async received => {
      if (received.delivery.deliveryDigest !== prepared.delivery.deliveryDigest
        || received.route.workerId !== prepared.route.workerId || received.route.kind !== "remote") unavailable();
      return this.db.transaction(async tx => {
        received.assertCurrent();
        await this.assertCanonicalEnrollment(tx, ref.tenantId, target);
        const prior = await readControllerWorkerDeliveryReceiptV1(tx, this.integrityKey, ref);
        if (prior) {
          if (prior.delivery.deliveryDigest !== prepared.delivery.deliveryDigest
            || prior.receipt.receiptDigest !== received.receipt.receiptDigest) unavailable();
          const registration = await this.registerAcceptedRemoteRunInSession(tx, ref, prepared, prior.receipt);
          await this.assertCanonicalEnrollment(tx, ref.tenantId, target);
          received.assertCurrent();
          return Object.freeze({ receipt: prior.receipt, replayed: true, registrationReplayed: registration.replayed,
            startsWork: false as const, grantsExecutionAuthority: false as const });
        }
        const result = await persistControllerWorkerDeliveryReceiptV1(tx, this.integrityKey,
          received.delivery, received.receipt, recordedAt);
        const registration = await this.registerAcceptedRemoteRunInSession(tx, ref, prepared, result.receipt);
        await this.assertCanonicalEnrollment(tx, ref.tenantId, target);
        received.assertCurrent();
        return Object.freeze({ ...result, registrationReplayed: registration.replayed });
      });
    });
  }

  /** Reconcile a journaled receipt on a replacement authenticated connection.
   * Neither missing signed intent nor expired work can be repaired by resend. */
  async recoverReceipt(value: RemoteControllerWorkerMaterializationReferenceV1, preparedValue: unknown,
    raw: string | Uint8Array, recordedAt: unknown) {
    const ref = referenceSchema.parse(value);
    const prepared = preparedSchema.parse(preparedValue) as RemoteControllerWorkerPreparedDeliveryV1;
    const target = await this.resolveForPrepared(ref, prepared);
    const verifyTarget = async (tx?: DatabaseSession) => {
      const current = await this.resolveForPrepared(ref, prepared, tx);
      if (current.session.session !== target.session.session || this.clock() >= Date.parse(prepared.delivery.expiresAt)
        || !admitRemoteWorkerDeliveryV1({ delivery: prepared.delivery, route: prepared.route,
          enrollment: current.enrollment, supportedAdapterRevisions: current.supportedAdapterRevisions }).accepted) unavailable();
    };
    await verifyTarget();
    const session = target.session.session;
    if (!session.recoverControllerWorkerDeliveryReceipt) unavailable();
    return session.recoverControllerWorkerDeliveryReceipt!(raw, async scope => {
      if (scope.projectId !== ref.projectId || scope.jobId !== ref.jobId || scope.attemptId !== ref.attemptId) unavailable();
      return this.db.transaction(async tx => {
        const row = (await tx.query<{ request_digest: string; result: { prepared: unknown; signedFrame?: unknown; tag: string } }>(
          `SELECT request_digest,result FROM control_idempotency WHERE tenant_id=$1
           AND operation_scope='remote-controller-worker-dispatch-intent/v1' AND idempotency_key=$2`,
          [ref.tenantId, ref.attemptId])).rows[0];
        if (!row || row.request_digest !== sha256Digest(ref) || !row.result.signedFrame) return unavailable();
        const signedFrame = signedNodeFrameSchema.parse(row.result.signedFrame);
        if (signedFrame.type !== "controller.worker.delivery" || sha256Digest(row.result.prepared) !== sha256Digest(prepared)
          || row.result.tag !== hmacSha256Tag(this.integrityKey, { ref, prepared, signedFrame })
          || signedFrame.body.delivery.deliveryDigest !== prepared.delivery.deliveryDigest
          || signedFrame.body.enrollmentDigest !== target.enrollment.enrollmentDigest) return unavailable();
        return signedFrame as SignedNodeFrame<"controller.worker.delivery">;
      });
    }, async (frame, _dispatch, assertCurrent) => this.db.transaction(async tx => {
      await verifyTarget(tx);
      assertCurrent();
      const receipt = frame.body.receipt.receipt;
      const prior = await readControllerWorkerDeliveryReceiptV1(tx, this.integrityKey, ref);
      if (prior) {
        if (prior.delivery.deliveryDigest !== prepared.delivery.deliveryDigest
          || prior.receipt.receiptDigest !== receipt.receiptDigest) unavailable();
        await verifyTarget(tx); assertCurrent();
        const registration = await this.registerAcceptedRemoteRunInSession(tx, ref, prepared, prior.receipt);
        await verifyTarget(tx); assertCurrent();
        return Object.freeze({ receipt: prior.receipt, replayed: true, registrationReplayed: registration.replayed,
          startsWork: false as const, grantsExecutionAuthority: false as const });
      }
      const result = await persistControllerWorkerDeliveryReceiptV1(tx, this.integrityKey, prepared.delivery, receipt, recordedAt);
      const registration = await this.registerAcceptedRemoteRunInSession(tx, ref, prepared, result.receipt);
      await verifyTarget(tx);
      assertCurrent();
      return Object.freeze({ ...result, registrationReplayed: registration.replayed });
    }));
  }

  /** Registers the exact accepted packet; it remains discovered and cannot start work. */
  private async registerAcceptedRemoteRunInSession(tx: DatabaseSession, ref: z.infer<typeof referenceSchema>,
    prepared: RemoteControllerWorkerPreparedDeliveryV1, receipt: ControllerWorkerDeliveryReceiptV1) {
    if (receipt.disposition !== "accepted" || receipt.deliveryId !== prepared.delivery.deliveryId
      || receipt.deliveryDigest !== prepared.delivery.deliveryDigest || receipt.workerId !== prepared.delivery.worker.workerId
      || receipt.route.kind !== "remote" || receipt.route.workerId !== prepared.route.workerId) unavailable();
    const remoteTask = remoteTaskRegistrationSchemaV1.parse({ workerId: prepared.delivery.worker.workerId,
      adapterId: prepared.delivery.worker.adapterId, adapterRevision: prepared.delivery.worker.adapterRevision,
      deliveryDigest: prepared.delivery.deliveryDigest, receiptDigest: receipt.receiptDigest,
      enrollmentDigest: prepared.enrollmentDigest, leaseId: ref.leaseId, inputDigest: ref.inputDigest,
      deadline: prepared.delivery.expiresAt });
    const createdAt = receipt.receivedAt;
    const run = { schemaVersion: "control-room-harness/v1" as const, id: prepared.delivery.identity.runId,
      tenantId: prepared.delivery.identity.tenantId, projectId: prepared.delivery.identity.projectId,
      jobId: prepared.delivery.identity.jobId, attemptId: prepared.delivery.identity.attemptId,
      nodeId: prepared.delivery.identity.nodeId, adapterId: prepared.delivery.worker.adapterId,
      adapterVersion: "1.0.0", harness: "other" as const, harnessVersion: "1.0.0",
      nativeSessionKeyDigest: sha256Digest({ purpose: "remote-task-registration/v1", remoteTask }),
      connectorProfileDigest: prepared.delivery.connectorProfileDigest, authorityDigest: prepared.delivery.authorityDigest,
      state: "discovered" as const, resumable: false, cancelState: "unsupported" as const, remoteTask,
      createdAt, updatedAt: createdAt, lastObservedAt: createdAt };
    return new HarnessRunStoreV1(joined(tx), this.integrityKey).create(run);
  }

  private async resolveForPrepared(ref: z.infer<typeof referenceSchema>, prepared: RemoteControllerWorkerPreparedDeliveryV1,
    tx?: DatabaseSession) {
    const target = captureTarget(await this.resolver.resolve(Object.freeze({ tenantId: ref.tenantId,
      nodeId: prepared.delivery.identity.nodeId, adapterId: CONTROLLER_WORKER_REMOTE_ADAPTER_V1,
      requiredCapability: CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
      connectorProfileDigest: prepared.delivery.connectorProfileDigest })));
    if (target.nodeId !== prepared.delivery.identity.nodeId || target.workerId !== prepared.route.workerId
      || target.workerId !== prepared.delivery.worker.workerId || target.adapterId !== prepared.delivery.worker.adapterId
      || target.adapterRevision !== prepared.delivery.worker.adapterRevision
      || target.enrollment.enrollmentDigest !== prepared.enrollmentDigest) unavailable();
    if (tx) await this.assertCanonicalEnrollment(tx, ref.tenantId, target);
    else await this.db.transaction(session => this.assertCanonicalEnrollment(session, ref.tenantId, target));
    return target;
  }

  private async assertCanonicalEnrollment(tx: DatabaseSession, tenantId: string,
    target: RemoteControllerWorkerResolvedTargetV1) {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) unavailable();
    try {
      await readCurrentRemoteWorkerEnrollmentV1(tx, this.integrityKey, {
        tenantId,
        workerId: target.workerId,
        nodeId: target.nodeId,
        nodeKeyId: target.enrollmentAuthority.nodeKeyId,
        adapterId: target.adapterId,
        adapterRevision: target.adapterRevision,
        capabilityDigest: target.enrollmentAuthority.capabilityDigest,
        enrollmentId: target.enrollment.enrollmentId,
        enrollmentDigest: target.enrollment.enrollmentDigest,
        releaseBindingDigest: target.enrollmentAuthority.releaseBindingDigest,
        now: new Date(now).toISOString(),
      });
    } catch { unavailable(); }
  }

  private async prepareInSession(tx: DatabaseSession, ref: z.infer<typeof referenceSchema>) {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) unavailable();
    const jobRow = (await tx.query<{ payload: unknown; state: string; version: number; project_id: string }>(
      "SELECT payload,state,version,project_id FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
      [ref.tenantId, ref.projectId, ref.jobId])).rows[0];
    const attemptRow = (await tx.query<{ payload: unknown; state: string; version: number; job_id: string; node_id: string }>(
      "SELECT payload,state,version,job_id,node_id FROM control_attempts WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [ref.tenantId, ref.attemptId])).rows[0];
    const leaseRow = (await tx.query<{ payload: unknown; state: string; version: number; attempt_id: string; job_id: string; node_id: string; expires_at: string | Date }>(
      "SELECT payload,state,version,attempt_id,job_id,node_id,expires_at FROM control_leases WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [ref.tenantId, ref.leaseId])).rows[0];
    if (!jobRow || !attemptRow || !leaseRow) unavailable();
    const job = jobRecordSchema.parse(jobRow.payload), attempt = attemptRecordSchema.parse(attemptRow.payload), lease = leaseRecordSchema.parse(leaseRow.payload);
    const rawPlan = await this.planner.readInSession(tx, ref.jobId);
    const plan = rawPlan?.schema === "control-room.task-execution-plan/v11"
      ? controllerWorkerRemoteTaskExecutionPlanSchemaV11.parse(rawPlan)
      : rawPlan?.schema === "control-room.task-execution-plan/v12"
        ? controllerWorkerRemoteTaskExecutionPlanSchemaV12.parse(rawPlan) : unavailable();
    if (plan.adapter !== CONTROLLER_WORKER_REMOTE_ADAPTER_V1 || plan.tenantId !== ref.tenantId || plan.projectId !== ref.projectId
      || plan.job.id !== ref.jobId || jobRow.state !== job.state || jobRow.version !== job.version || jobRow.project_id !== job.projectId
      || attemptRow.state !== attempt.state || attemptRow.version !== attempt.version || attemptRow.job_id !== attempt.jobId
      || attemptRow.node_id !== attempt.nodeId || leaseRow.state !== lease.state || leaseRow.version !== lease.version
      || leaseRow.attempt_id !== lease.attemptId || leaseRow.job_id !== lease.jobId || leaseRow.node_id !== lease.nodeId
      || new Date(leaseRow.expires_at).toISOString() !== lease.expiresAt || job.state !== "leased" || attempt.state !== "leased"
      || lease.state !== "active" || job.inputDigest !== ref.inputDigest || plan.job.inputDigest !== ref.inputDigest
      || plan.executionClass !== "text_review" || job.jobType !== CONTROLLER_WORKER_REMOTE_JOB_TYPE_V1
      || job.requiredCapability !== CONTROLLER_WORKER_REMOTE_CAPABILITY_V1 || attempt.jobId !== job.id || lease.jobId !== job.id
      || lease.attemptId !== attempt.id || lease.nodeId !== attempt.nodeId || Date.parse(lease.expiresAt) <= now
      || Date.parse(job.authority.expiresAt) <= now) unavailable();
    const target = captureTarget(await this.resolver.resolve(Object.freeze({ tenantId: ref.tenantId, nodeId: id.parse(attempt.nodeId),
      adapterId: CONTROLLER_WORKER_REMOTE_ADAPTER_V1, requiredCapability: CONTROLLER_WORKER_REMOTE_CAPABILITY_V1,
      connectorProfileDigest: plan.connectorProfileDigest })));
    if (target.nodeId !== attempt.nodeId || target.enrollment.state !== "enrolled") unavailable();
    await this.assertCanonicalEnrollment(tx, ref.tenantId, target);
    const expiresAt = new Date(Math.min(Date.parse(lease.expiresAt), Date.parse(job.authority.expiresAt))).toISOString();
    const delivery = createControllerWorkerDeliveryV1({ identity: { tenantId: ref.tenantId, projectId: ref.projectId,
      jobId: ref.jobId, attemptId: ref.attemptId, runId: `run:controller-worker-remote:${sha256Digest({ tenantId: ref.tenantId,
        jobId: ref.jobId, attemptId: ref.attemptId, leaseId: ref.leaseId, planDigest: sha256Digest(plan) }).slice(7)}`,
      nodeId: id.parse(attempt.nodeId) }, worker: { workerId: target.workerId, adapterId: target.adapterId,
      adapterRevision: target.adapterRevision }, input: plan.input, authorityDigest: job.authority.digest,
      connectorProfileDigest: plan.connectorProfileDigest, acceptanceProfileId: plan.acceptanceProfileId,
      acceptanceProfileDigest: plan.acceptanceProfileDigest, issuedAt: lease.acquiredAt, expiresAt });
    const admission = admitRemoteWorkerDeliveryV1({ delivery, route: { kind: "remote", workerId: target.workerId },
      enrollment: target.enrollment, supportedAdapterRevisions: target.supportedAdapterRevisions });
    if (!admission.accepted) unavailable();
    return Object.freeze({ schema: REMOTE_CONTROLLER_WORKER_MATERIALIZER_V1, delivery, workflowId: job.workflowId,
      route: Object.freeze({ kind: "remote" as const, workerId: target.workerId }),
      enrollmentDigest: target.enrollment.enrollmentDigest, startsWork: false as const,
      grantsExecutionAuthority: false as const });
  }
}
