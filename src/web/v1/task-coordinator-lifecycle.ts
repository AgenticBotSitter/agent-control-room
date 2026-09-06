import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
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

export type TaskApprovalOperation = Readonly<{ tenantId: string; workspaceId: string;
  prepare: TaskAssignmentCoordinator["prepareNativeApproval"]; store: TaskAssignmentCoordinator["storeNativeApproval"];
  read: TaskAssignmentCoordinator["readNativeApproval"] }>;

export type TaskCoordinatorDatabase = Readonly<{ client: DatabaseClient; close: () => Promise<void>; isAvailable: () => boolean }>;
export type TaskCoordinatorConfiguration = {
  scope: { tenantId: string; workspaceId: string };
  planning: ConstructorParameters<typeof TaskExecutionPlanner>[2]; routes: readonly TaskAssignmentRoute[];
  approvals?: { enrollments: readonly NativeApprovalEnrollment[]; store: NativeApprovalPacketStore };
  quality?: TaskQualityConfiguration;
  revisionPlanning?: true;
  /** An already verified, separately owned bounded control-plane pool. Never the private-web login. */
  database: TaskCoordinatorDatabase;
  /** Optional fixed native-result writer, independently verified against the same primary. */
  resultDatabase?: TaskCoordinatorDatabase;
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
  if (input.approvals && (!Array.isArray(input.approvals.enrollments)
    || typeof input.approvals.store?.acceptInSession !== "function" || typeof input.approvals.store?.readInSession !== "function"))
    throw new Error("task_coordinator_config_invalid");
  const capture = (resource: TaskCoordinatorDatabase) => {
    if (!resource || typeof resource.close !== "function" || typeof resource.isAvailable !== "function"
      || [resource.client?.query, resource.client?.transaction, resource.client?.transactionWithPreCommitCheck].some(fn => typeof fn !== "function"))
      throw new Error("task_coordinator_config_invalid");
    return Object.freeze({ client: resource.client, close: resource.close.bind(resource), isAvailable: resource.isAvailable.bind(resource) });
  };
  const pool = capture(input.database), resultPool = input.resultDatabase ? capture(input.resultDatabase) : undefined;
  let closing = false, invalid = false, interrupted = false, active = 0, closePromise: Promise<void> | undefined;
  let drained: (() => void) | undefined, force!: () => void;
  const stops = new Set<() => void>();
  const forced = new Promise<void>(resolve => { force = resolve; });
  const check = () => {
    try { if (!invalid && pool.isAvailable() && (!resultPool || resultPool.isAvailable())) return; } catch { /* An unavailable health probe is still a lifecycle interruption. */ }
    throw new TaskCoordinatorInterruption("task_coordinator_unavailable");
  };
  const guardedDatabase = (owned: TaskCoordinatorDatabase) => {
    const raw = Object.freeze({ query: owned.client.query.bind(owned.client),
      transactionWithPreCommitCheck: owned.client.transactionWithPreCommitCheck.bind(owned.client) });
    const db: DatabaseClient = {
    async query<T>(sql: string, params?: unknown[]) { check(); const value = await raw.query<T>(sql, params); check(); return value; },
    transaction: work => db.transactionWithPreCommitCheck(work, () => {}),
    transactionWithPreCommitCheck: (work, precommit) => {
      check();
      return raw.transactionWithPreCommitCheck(async tx => {
        let usable = true;
        const session: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
          check(); if (!usable) throw new TaskCoordinatorInterruption("task_coordinator_session_closed");
          const value = await tx.query<T>(sql, params); check();
          if (!usable) throw new TaskCoordinatorInterruption("task_coordinator_session_closed"); return value;
        } };
        try { return await work(Object.freeze(session)); } finally { usable = false; }
      }, () => { check(); precommit(); check(); });
    },
    }; return db;
  };
  const db = guardedDatabase(pool);
  // Constructors validate and snapshot immutable templates, keys, route records and scope without SQL.
  const planner = new TaskExecutionPlanner(db, scope, input.planning, input.clock, input.revisionPlanning ? input.quality : undefined);
  const assignment = new TaskAssignmentCoordinator(db, scope, planner, input.routes, input.clock,
    input.approvals?.enrollments, input.approvals?.store);
  if (input.quality && (input.quality.integrityKey.length !== input.planning.reviewIntegrityKey.length
    || !timingSafeEqual(input.quality.integrityKey, input.planning.reviewIntegrityKey)))
    throw new Error("task_coordinator_config_invalid");
  const qualityCoordinator = input.quality ? new TaskQualityCoordinator(db, scope, input.quality, input.clock) : undefined;
  const resultCoordinator = resultPool ? new TaskResultCoordinator(guardedDatabase(resultPool), scope, input.planning, input.quality!, input.clock) : undefined;
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
  const planning: TaskPlanningOperation = Object.freeze({ ...scope, plan: (...args) => run(() => planner.plan(...args)) });
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
  return Object.freeze({ planning, assignment: assignments, ...(approvals ? { approvals } : {}), ...(quality ? { quality } : {}),
    ...(revisions ? { revisions } : {}),
    ...(results ? { results } : {}),
    isReady: () => !closing && !invalid && pool.isAvailable() && (!resultPool || resultPool.isAvailable()),
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        let drainTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          if (active) await Promise.race([new Promise<void>(resolve => { drained = resolve; }),
            new Promise<void>(resolve => { drainTimer = setTimeout(() => { timedOut = true; interrupted = true; resolve(); }, drainMs); })]);
          clearTimeout(drainTimer);
          invalid = true;
          await Promise.race([Promise.all([Promise.resolve().then(pool.close), ...(resultPool ? [Promise.resolve().then(resultPool.close)] : [])]), new Promise<never>((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error("task_coordinator_close_uncertain")), closeMs);
          })]);
          if (timedOut) throw new Error("task_coordinator_close_uncertain");
        } catch { throw new Error("task_coordinator_close_uncertain"); }
        finally { invalid = true; clearTimeout(drainTimer); clearTimeout(closeTimer); force(); for (const stop of stops) stop(); }
      })();
      return closePromise;
    },
  });
}
