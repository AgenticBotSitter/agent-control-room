import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { nativeTaskSubmissionReferenceSchema, type NativeTaskSubmission } from "../../persistence/native-task-submission";
import { localId } from "../../harness/v1/native-run-identifiers";
import { TaskExecutionPlanner, type TaskPlanningOperation } from "./task-execution-planner";
import { TaskAssignmentCoordinator, type TaskAssignmentOperation, type TaskAssignmentRoute, type NativeApprovalEnrollment } from "./task-assignment-coordinator";
import type { NativeApprovalPacketStore } from "./native-approval-packet-store";
import { nativeTaskApprovalPacketSchema } from "../../harness/v1/native-approval-packet";
import { TaskQualityCoordinator, taskQualityRequestSchema, taskQualitySweepRequestSchema, type TaskQualityConfiguration, type TaskQualityOperation } from "./task-quality-coordinator";
import { timingSafeEqual } from "node:crypto";
import { TaskCoordinatorInterruption } from "./task-coordinator-interruption";
import { taskRevisionRequestSchema } from "./task-revision-wire";
import { TaskResultCoordinator, taskResultRequestSchema, type TaskResultOperation } from "./task-result-coordinator";
import { NativeEvidenceReceiver, captureNativeEvidenceInput, captureNativeEvidenceSettings, nativeEvidenceRegistrationSchema, type NativeEvidenceSettings } from "./native-evidence-receiver";
import { ManagedNativeSessions, captureManagedNativeSessionSettings, type ManagedNativeSessionSettings } from "./managed-native-sessions";
import { createNativeHttpHost, captureNativeHttpSettings, type NativeHttpSettings } from "./native-http-host";

export type TaskApprovalOperation = Readonly<{ tenantId: string; workspaceId: string;
  prepare: TaskAssignmentCoordinator["prepareNativeApproval"]; store: TaskAssignmentCoordinator["storeNativeApproval"];
  read: TaskAssignmentCoordinator["readNativeApproval"] }>;
export type TaskSubmissionOperation = Readonly<{ tenantId: string; workspaceId: string;
  enqueue: TaskAssignmentCoordinator["enqueueNativeTask"]; read: TaskAssignmentCoordinator["readNativeTaskQueue"];
  readDelivery?: TaskAssignmentCoordinator["readNativeDeliveryStatus"] }>;

export type TaskCoordinatorDatabase = Readonly<{ client: DatabaseClient; close: () => Promise<void>; isAvailable: () => boolean }>;
export type TaskCoordinatorConfiguration = {
  scope: { tenantId: string; workspaceId: string };
  planning: ConstructorParameters<typeof TaskExecutionPlanner>[2]; routes: readonly TaskAssignmentRoute[];
  approvals?: { enrollments: readonly NativeApprovalEnrollment[]; store: NativeApprovalPacketStore };
  /** Trusted, already prepared submission port. Optional close transfers ownership
   * after construction; drained and stopped before the underlying pool closes.
   * Never derived from an HTTP request or enabled implicitly by approval storage. */
  nativeSubmission?: NativeTaskSubmission & { close?: () => Promise<void> };
  quality?: TaskQualityConfiguration;
  revisionPlanning?: true;
  /** An already verified, separately owned bounded control-plane pool. Never the private-web login. */
  database: TaskCoordinatorDatabase;
  /** Optional fixed native-result writer, independently verified against the same primary. */
  resultDatabase?: TaskCoordinatorDatabase;
  evidence?: NativeEvidenceSettings & { database: TaskCoordinatorDatabase };
  sessions?: ManagedNativeSessionSettings & { database: TaskCoordinatorDatabase };
  nativeHttp?: NativeHttpSettings;
  clock?: () => number; maxActive?: number; drainMs?: number; closeMs?: number;
};

/** Takes ownership only after synchronous construction succeeds. No pool opening, role verification,
 * listener, credential loading, approval or dispatch. The supplying bootstrap must verify the pool.
 */
export function createTaskCoordinatorLifecycle(input: TaskCoordinatorConfiguration) {
  const scope = Object.freeze({ tenantId: localId.parse(input.scope.tenantId), workspaceId: localId.parse(input.scope.workspaceId) });
  const maxActive = input.maxActive ?? 8, drainMs = input.drainMs ?? 30_000, closeMs = input.closeMs ?? 5000;
  for (const [value, ceiling] of [[maxActive, 8], [drainMs, 30_000], [closeMs, 5000]])
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error("task_coordinator_config_invalid");
  if (input.revisionPlanning !== undefined && (input.revisionPlanning !== true || !input.quality)) throw new Error("task_coordinator_config_invalid");
  if (input.resultDatabase && (!input.quality || input.resultDatabase === input.database || input.resultDatabase.client === input.database.client))
    throw new Error("task_coordinator_config_invalid");
  if (input.evidence && (!input.resultDatabase || !input.quality
    || [input.database, input.resultDatabase].some(pool => pool === input.evidence!.database || pool.client === input.evidence!.database.client)))
    throw new Error("task_coordinator_config_invalid");
  if (input.approvals && (!Array.isArray(input.approvals.enrollments)
    || typeof input.approvals.store?.acceptInSession !== "function" || typeof input.approvals.store?.readInSession !== "function"))
    throw new Error("task_coordinator_config_invalid");
  if (input.nativeSubmission && (!input.approvals || typeof input.nativeSubmission.enqueueInSession !== "function"
    || input.nativeSubmission.recoverUnsentInSession !== undefined && typeof input.nativeSubmission.recoverUnsentInSession !== "function"))
    throw new Error("task_coordinator_config_invalid");
  const nativeSubmission = input.nativeSubmission ? Object.freeze({
    enqueueInSession: input.nativeSubmission.enqueueInSession.bind(input.nativeSubmission),
    ...(input.nativeSubmission.recoverUnsentInSession ? { recoverUnsentInSession: input.nativeSubmission.recoverUnsentInSession.bind(input.nativeSubmission) } : {}),
  }) : undefined;
  const closeSubmission = input.nativeSubmission?.close?.bind(input.nativeSubmission);
  const capture = (resource: TaskCoordinatorDatabase) => {
    if (!resource || typeof resource.close !== "function" || typeof resource.isAvailable !== "function"
      || [resource.client?.query, resource.client?.transaction, resource.client?.transactionWithPreCommitCheck].some(fn => typeof fn !== "function"))
      throw new Error("task_coordinator_config_invalid");
    return Object.freeze({ client: resource.client, close: resource.close.bind(resource), isAvailable: resource.isAvailable.bind(resource) });
  };
  const pool = capture(input.database), resultPool = input.resultDatabase ? capture(input.resultDatabase) : undefined;
  const evidenceSettings = input.evidence ? captureNativeEvidenceSettings(input.evidence) : undefined;
  if (evidenceSettings && (evidenceSettings.storage.storageClass !== input.quality!.results.storageClass
    || !timingSafeEqual(evidenceSettings.storage.integrityKey, input.quality!.results.integrityKey)))
    throw new Error("task_coordinator_config_invalid");
  const evidencePool = input.evidence ? capture(input.evidence.database) : undefined;
  const sessionSettings = input.sessions ? captureManagedNativeSessionSettings(input.sessions) : undefined;
  const httpSettings = input.nativeHttp ? captureNativeHttpSettings(input.nativeHttp) : undefined;
  if (httpSettings && (!sessionSettings || httpSettings.peers.some(peer => !sessionSettings.nodes.some(node => node.nodeId === peer.nodeId))))
    throw new Error("task_coordinator_config_invalid");
  if (input.sessions && (!input.approvals || !evidencePool || !receiverDependenciesValid()
    || [input.database, input.resultDatabase, input.evidence?.database].some(pool => pool === input.sessions!.database || pool?.client === input.sessions!.database.client)))
    throw new Error("task_coordinator_config_invalid");
  function receiverDependenciesValid() {
    return typeof input.approvals?.store.receiveDeliveryReceipt === "function"
      && sessionSettings!.nodes.every(node => node.tenantId === scope.tenantId
        && evidenceSettings!.enrollments.some(enrollment => enrollment.nodeId === node.nodeId));
  }
  const sessionPool = input.sessions ? capture(input.sessions.database) : undefined;
  const sessionState: { manager?: ManagedNativeSessions } = {};
  let closing = false, invalid = false, interrupted = false, active = 0, closePromise: Promise<void> | undefined;
  let drained: (() => void) | undefined, force!: () => void;
  const stops = new Set<() => void>();
  const forced = new Promise<void>(resolve => { force = resolve; });
  const check = () => {
    try { if (!invalid && (!sessionState.manager || sessionState.manager.isAvailable()) && pool.isAvailable() && (!resultPool || resultPool.isAvailable()) && (!evidencePool || evidencePool.isAvailable()) && (!sessionPool || sessionPool.isAvailable())) return; } catch { /* An unavailable health probe is still a lifecycle interruption. */ }
    throw new TaskCoordinatorInterruption("task_coordinator_unavailable");
  };
  const guardedDatabase = (owned: TaskCoordinatorDatabase) => {
    const raw = Object.freeze({ query: owned.client.query.bind(owned.client),
      transactionWithPreCommitCheck: owned.client.transactionWithPreCommitCheck.bind(owned.client) });
    const db: DatabaseClient = {
    async query<T>(sql: string, params?: unknown[]) { check(); const value = await raw.query<T>(sql, params); check(); return value; },
    transaction: work => db.transactionWithPreCommitCheck(work, () => {}),
    transactionWithPreCommitCheck: async (work, precommit) => {
      check();
      const result = await raw.transactionWithPreCommitCheck(async tx => {
        let usable = true;
        const session: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
          check(); if (!usable) throw new TaskCoordinatorInterruption("task_coordinator_session_closed");
          const value = await tx.query<T>(sql, params); check();
          if (!usable) throw new TaskCoordinatorInterruption("task_coordinator_session_closed"); return value;
        } };
        try { return await work(Object.freeze(session)); } finally { usable = false; }
      }, async () => { check(); await precommit(); check(); });
      try { check(); } catch { throw new TaskCoordinatorInterruption("task_coordinator_save_uncertain"); }
      return result;
    },
    }; return db;
  };
  const db = guardedDatabase(pool);
  // Constructors validate and snapshot immutable templates, keys, route records and scope without SQL.
  const planner = new TaskExecutionPlanner(db, scope, input.planning, input.clock, input.revisionPlanning ? input.quality : undefined);
  const assignment = new TaskAssignmentCoordinator(db, scope, planner, input.routes, input.clock,
    input.approvals?.enrollments, input.approvals?.store, nativeSubmission);
  if (input.quality && (input.quality.integrityKey.length !== input.planning.reviewIntegrityKey.length
    || !timingSafeEqual(input.quality.integrityKey, input.planning.reviewIntegrityKey)))
    throw new Error("task_coordinator_config_invalid");
  const qualityCoordinator = input.quality ? new TaskQualityCoordinator(db, scope, input.quality, input.clock) : undefined;
  const resultCoordinator = resultPool ? new TaskResultCoordinator(guardedDatabase(resultPool), scope, input.planning, input.quality!, input.clock) : undefined;
  const receiver = evidencePool ? new NativeEvidenceReceiver(guardedDatabase(evidencePool), {
    ...evidenceSettings!, scope, harnessIntegrityKey: input.quality!.harnessIntegrityKey,
    results: { ...scope, register: resultCoordinator!.register.bind(resultCoordinator), submit: resultCoordinator!.submit.bind(resultCoordinator) },
    clock: input.clock, assertAvailable: check,
  }) : undefined;
  async function run<T>(work: () => Promise<T>): Promise<T> {
    if (closing || active >= maxActive) throw new Error("task_coordinator_unavailable");
    check(); active++;
    let stop!: () => void;
    const stopped = new Promise<never>((_, reject) => { stop = () => reject(new Error("task_coordinator_save_uncertain")); });
    stops.add(stop);
    const operation = Promise.resolve().then(work).finally(() => { stops.delete(stop); active--; if (closing && active === 0) drained?.(); });
    try {
      const result = await Promise.race([operation, stopped]);
      if (interrupted) { await forced; throw new Error("task_coordinator_save_uncertain"); }
      return result;
    } catch (error) {
      // Invalidated SQL failures cannot escape before the bounded pool-close outcome is known.
      if (invalid) { await forced; throw new Error("task_coordinator_save_uncertain"); }
      throw error;
    }
  }
  const receipt = input.sessions ? input.approvals!.store.receiveDeliveryReceipt.bind(input.approvals!.store) : undefined;
  const sessions = sessionPool ? new ManagedNativeSessions(guardedDatabase(sessionPool), sessionSettings!, scope, {
    queue: nativeSubmission ? { locate: assignment.locateApprovedQueueDelivery.bind(assignment),
      ...(nativeSubmission.recoverUnsentInSession ? { ready: assignment.recoverForReadyNode.bind(assignment) } : {}),
      stage: assignment.stageApprovedQueueDelivery.bind(assignment), transmit: assignment.transmitApprovedQueueDelivery.bind(assignment) } : undefined,
    stage: assignment.stageQueuedNativeDelivery.bind(assignment), transmit: assignment.transmitQueuedNativeDelivery.bind(assignment),
    receipt: (session, raw, signal) => receipt!(db, session, raw, signal), progress: receiver!.receive.bind(receiver),
    recover: receiver!.recover.bind(receiver),
    register: receiver!.register.bind(receiver),
  }, run, check, input.clock) : undefined;
  sessionState.manager = sessions;
  const nativeHttp = httpSettings ? createNativeHttpHost({ ...httpSettings, connections: sessions!,
    isReady: () => { try { check(); return !closing && !invalid; } catch { return false; } }, clock: input.clock }) : undefined;
  const planning: TaskPlanningOperation = Object.freeze({ ...scope, plan: (...args) => run(() => planner.plan(...args)),
    readSaved: (identity, projectId, sourceJobId) => {
      const actor = { ...identity };
      return run(() => planner.readSaved(actor, projectId, sourceJobId));
    } });
  const revisions = input.revisionPlanning ? Object.freeze({ ...scope,
    plan: (identity: Parameters<TaskExecutionPlanner["revise"]>[0], projectId: string, sourceJobId: string,
      input: Parameters<TaskExecutionPlanner["revise"]>[3], signal: AbortSignal) => {
      const actor = { ...identity }, request = taskRevisionRequestSchema.parse(input);
      return run(() => planner.revise(actor, projectId, sourceJobId, request, signal));
    },
  }) : undefined;
  const assignments: TaskAssignmentOperation = Object.freeze({ ...scope,
    assign: (...args) => run(() => assignment.assign(...args)), expire: (...args) => run(() => assignment.expire(...args)),
    options: (...args) => run(() => assignment.options(...args)) });
  const approvals: TaskApprovalOperation | undefined = input.approvals ? Object.freeze({ ...scope,
    prepare: (...args: Parameters<TaskApprovalOperation["prepare"]>) => run(() => assignment.prepareNativeApproval(...args)),
    read: (...args: Parameters<TaskApprovalOperation["read"]>) => run(() => assignment.readNativeApproval(...args)),
    store: (identity, projectId, jobId, digest, packet, signal) => {
      const snapshot = nativeTaskApprovalPacketSchema.parse(packet);
      return run(() => assignment.storeNativeApproval(identity, projectId, jobId, digest, snapshot, signal));
    },
  }) : undefined;
  const submission = nativeSubmission ? Object.freeze({ ...scope,
    readDelivery: (identity: Parameters<TaskAssignmentCoordinator["readNativeDeliveryStatus"]>[0], projectId: string, jobId: string, digest: string) => {
      const actor = { ...identity };
      return run(() => assignment.readNativeDeliveryStatus(actor, projectId, jobId, digest));
    },
    read: (...args: Parameters<TaskAssignmentCoordinator["readNativeTaskQueue"]>) => run(() => assignment.readNativeTaskQueue(...args)),
    enqueue: (...args: Parameters<TaskAssignmentCoordinator["enqueueNativeTask"]>) => {
      const [identity, projectId, jobId, inputDigest, packetDigest, signal] = args;
      const actor = { ...identity };
      return run(() => assignment.enqueueNativeTask(actor, projectId, jobId, inputDigest, packetDigest, signal));
    },
  }) : undefined;
  const queueRecovery = nativeSubmission?.recoverUnsentInSession ? Object.freeze({ ...scope,
    verify: (value: Parameters<TaskAssignmentCoordinator["verifyRecoveredQueueDelivery"]>[0], ordinal: number, signal: AbortSignal) => {
      const ref = nativeTaskSubmissionReferenceSchema.parse(value);
      return run(() => assignment.verifyRecoveredQueueDelivery(ref, ordinal, signal));
    },
    recover: (value: Parameters<TaskAssignmentCoordinator["recoverNeverStagedQueueDelivery"]>[0], signal: AbortSignal) => {
      const ref = nativeTaskSubmissionReferenceSchema.parse(value);
      return run(() => assignment.recoverNeverStagedQueueDelivery(ref, signal));
    },
  }) : undefined;
  const quality: TaskQualityOperation | undefined = qualityCoordinator ? Object.freeze({ ...scope,
    sweep: (input, signal) => {
      const snapshot = taskQualitySweepRequestSchema.parse(input);
      return run(() => qualityCoordinator.sweep(snapshot, signal, check));
    },
    reconcile: (input, signal) => {
      const snapshot = taskQualityRequestSchema.parse(input);
      return run(() => qualityCoordinator.reconcile(snapshot, signal, check));
    },
  }) : undefined;
  const results: TaskResultOperation | undefined = resultCoordinator ? Object.freeze({ ...scope,
    register: (value, signal) => { const request = taskResultRequestSchema.parse(value); return run(() => resultCoordinator.register(request, signal)); },
    submit: (value, signal) => { const request = taskResultRequestSchema.parse(value); return run(() => resultCoordinator.submit(request, signal)); },
  }) : undefined;
  // Capture caller-owned values before the shared admission microtask.
  const ownedEvidence = receiver ? Object.freeze({ ...scope,
    register: (value: Parameters<NativeEvidenceReceiver["register"]>[0], signal: AbortSignal) => {
      const request = nativeEvidenceRegistrationSchema.parse(value); return run(() => receiver.register(request, signal));
    },
    receive: (session: Parameters<NativeEvidenceReceiver["receive"]>[0], raw: string | Uint8Array, bytes: Uint8Array | undefined, signal: AbortSignal) => {
      const owned = captureNativeEvidenceInput(raw, bytes), capturedSession = { acceptNativeSnapshot: session.acceptNativeSnapshot.bind(session) };
      return run(() => receiver.receive(capturedSession, owned.raw, owned.bytes, signal));
    },
  }) : undefined;
  return Object.freeze({ planning, assignment: assignments, ...(approvals ? { approvals } : {}), ...(quality ? { quality } : {}),
    ...(nativeSubmission && sessions ? { queueDelivery: async (ref: Parameters<ManagedNativeSessions["deliverApproved"]>[0], signal: AbortSignal) => {
      const result = await sessions.deliverApproved(ref, signal);
      if (!result.deliveryConfirmed) throw new Error("native_task_delivery_unresolved");
      return { disposition: "delivered" as const };
    } } : {}),
    ...(submission ? { submission } : {}),
    ...(sessions && nativeSubmission?.recoverUnsentInSession ? {
      queueAttention: Object.freeze({ ...scope, read: sessions.queueAttention.bind(sessions) }),
    } : {}),
    ...(queueRecovery ? { queueRecovery } : {}),
    ...(revisions ? { revisions } : {}),
    ...(results ? { results } : {}),
    ...(ownedEvidence ? { evidence: ownedEvidence } : {}),
    ...(sessions ? { connections: Object.freeze({ ...scope, attach: sessions.attach.bind(sessions),
      ...(nativeSubmission?.recoverUnsentInSession ? { queueRecoveryStatus: sessions.queueRecoveryStatus.bind(sessions) } : {}),
      attachInput: sessions.attachInput.bind(sessions), attachWire: sessions.attachWire.bind(sessions) }) } : {}),
    ...(nativeHttp ? { nativeHttp } : {}),
    isReady: () => !closing && !invalid && (!nativeHttp || nativeHttp.isReady()) && (!sessions || sessions.isAvailable()) && pool.isAvailable() && (!resultPool || resultPool.isAvailable()) && (!evidencePool || evidencePool.isAvailable()) && (!sessionPool || sessionPool.isAvailable()),
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        let drainTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          const httpClose = nativeHttp ? await Promise.allSettled([nativeHttp.close()]) : [];
          if (httpClose.some(result => result.status === "rejected")) timedOut = true;
          if (active) await Promise.race([new Promise<void>(resolve => { drained = resolve; }),
            new Promise<void>(resolve => { drainTimer = setTimeout(() => { timedOut = true; interrupted = true; resolve(); }, drainMs); })]);
          clearTimeout(drainTimer);
          invalid = true;
          if (closeSubmission) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { await Promise.race([Promise.resolve().then(closeSubmission), new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("task_coordinator_close_uncertain")), closeMs);
            })]); } catch { timedOut = true; } finally { clearTimeout(timer); }
          }
          const sessionClose = sessions ? await Promise.allSettled([sessions.close()]) : [];
          await Promise.race([Promise.all([Promise.resolve().then(pool.close), ...(resultPool ? [Promise.resolve().then(resultPool.close)] : []),
            ...(evidencePool ? [Promise.resolve().then(evidencePool.close)] : []),
            ...(sessionPool ? [Promise.resolve().then(sessionPool.close)] : [])]), new Promise<never>((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error("task_coordinator_close_uncertain")), closeMs);
          })]);
          if (timedOut || sessionClose.some(result => result.status === "rejected")) throw new Error("task_coordinator_close_uncertain");
        } catch { throw new Error("task_coordinator_close_uncertain"); }
        finally { invalid = true; clearTimeout(drainTimer); clearTimeout(closeTimer); force(); for (const stop of stops) stop(); }
      })();
      return closePromise;
    },
  });
}
