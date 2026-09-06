import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { localId } from "../../harness/v1/native-run-identifiers";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import { NativeResultSubmissionService } from "../../completion-gate/v1/native-result-submission";
import { TaskExecutionPlanner } from "./task-execution-planner";
import { captureTaskQualityConfiguration, type TaskQualityConfiguration } from "./task-quality-coordinator";
import { sha256Digest } from "../../security";

export const taskResultRequestSchema = z.object({ projectId: localId, jobId: localId, runId: localId }).strict();
export type TaskResultRequest = z.infer<typeof taskResultRequestSchema>;
export type TaskResultOperation = Readonly<{ tenantId: string; workspaceId: string;
  register: TaskResultCoordinator["register"]; submit: TaskResultCoordinator["submit"] }>;
const deny = (): never => { throw new Error("task_result_operation_uncertain"); };

/** Trusted control-plane operations only. Does not capture bytes, register a run, or start work. */
export class TaskResultCoordinator {
  private readonly scope: { tenantId: string; workspaceId: string };
  private readonly quality: TaskQualityConfiguration;
  private readonly planning: ConstructorParameters<typeof TaskExecutionPlanner>[2];
  private highWater = -Infinity;
  constructor(private readonly db: DatabaseClient, scope: { tenantId: string; workspaceId: string },
    planning: ConstructorParameters<typeof TaskExecutionPlanner>[2], quality: TaskQualityConfiguration, private readonly clock = Date.now) {
    this.scope = Object.freeze({ tenantId: localId.parse(scope.tenantId), workspaceId: localId.parse(scope.workspaceId) });
    this.quality = captureTaskQualityConfiguration(quality);
    // The outer lifecycle validates matching review keys; this reader captures independent copies.
    this.planning = { ...planning, template: structuredClone(planning.template), integrityKey: Uint8Array.from(planning.integrityKey),
      reviewIntegrityKey: Uint8Array.from(planning.reviewIntegrityKey),
      checkpoints: { read: planning.checkpoints.read.bind(planning.checkpoints), initialize: deny, advance: deny },
      ...(planning.ideaIntegrityKey ? { ideaIntegrityKey: Uint8Array.from(planning.ideaIntegrityKey) } : {}) };
    new TaskExecutionPlanner(db, this.scope, this.planning, clock);
  }
  private async run<T>(value: TaskResultRequest, signal: AbortSignal,
    work: (db: DatabaseClient, input: TaskResultRequest, check: () => void, now: () => number,
      beforeCommit: (check: () => void) => void) => Promise<T>, assertSourceCurrent: () => void = () => {}) {
    const input = taskResultRequestSchema.parse(value);
    if (!(signal instanceof AbortSignal)) return deny();
    const started = this.clock();
    const current = () => {
      assertSourceCurrent();
      const now = this.clock();
      if (signal.aborted || !Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(now)
        || now < started || now < this.highWater || now - started > 10_000) return deny();
      this.highWater = now; return now;
    };
    current(); const checks: (() => void | Promise<void>)[] = [];
    const result = await this.db.transactionWithPreCommitCheck(async tx => {
      const session: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
        current(); const result = await tx.query<T>(sql, params); current(); return result;
      } };
      // Native run and job locks precede any shared Completion Gate lock.
      const scoped = await session.query(`SELECT r.id FROM control_harness_runs r
        JOIN control_jobs j ON j.tenant_id=r.tenant_id AND j.project_id=r.project_id AND j.id=r.job_id
        JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id
        WHERE r.tenant_id=$1 AND r.id=$2 AND j.id=$3 AND p.id=$4 AND p.workspace_id=$5 FOR UPDATE OF r,j FOR SHARE OF p`,
      [this.scope.tenantId, input.runId, input.jobId, input.projectId, this.scope.workspaceId]);
      if (scoped.rows.length !== 1) return deny();
      const joined: DatabaseClient = { query: session.query.bind(session), transaction: async fn => fn(session),
        transactionWithPreCommitCheck: async (fn, check) => { const result = await fn(session); checks.push(check); return result; } };
      await new TaskExecutionPlanner(joined, this.scope, this.planning, this.clock)
        .lockReviewPredecessorInSession(session, input.projectId, input.jobId);
      return work(joined, input, current, current, check => checks.push(check));
    }, async () => { current(); for (const check of checks) { current(); await check(); } current(); });
    current(); return result;
  }
  async register(value: TaskResultRequest, signal: AbortSignal, assertSourceCurrent?: () => void) {
    return this.run(value, signal, async (db, input, check, now, beforeCommit) => {
      const planner = new TaskExecutionPlanner(db, this.scope, this.planning, this.clock);
      const submission = new NativeResultSubmissionService(db, this.quality);
      const bound = await planner.bindReview(input.jobId, input.runId, this.quality.harnessIntegrityKey, submission); check();
      if (bound.plan.projectId !== input.projectId) return deny();
      const inspected = await new HarnessRunStoreV1(db, this.quality.harnessIntegrityKey).inspect(this.scope.tenantId, input.runId); check();
      if (!inspected?.run.nativeTask || Date.parse(inspected.run.createdAt) > now()) return deny();
      if (!bound.replayed) {
        const deadline = Date.parse(inspected.run.nativeTask.deadline);
        const unexpired = () => { if (now() >= deadline) return deny(); };
        unexpired(); beforeCommit(unexpired);
      }
      return { receipt: { projectId: input.projectId, jobId: input.jobId, runId: input.runId,
        targetId: bound.plan.targetId, planDigest: sha256Digest(bound.plan), inputDigest: bound.plan.inputDigest,
        registeredAt: bound.plan.plannedAt, startsWork: false as const, grantsExecutionAuthority: false as const }, replayed: bound.replayed };
    }, assertSourceCurrent);
  }
  async submit(value: TaskResultRequest, signal: AbortSignal, assertSourceCurrent?: () => void) {
    return this.run(value, signal, async (db, input, check, now) => {
      const planner = new TaskExecutionPlanner(db, this.scope, this.planning, this.clock);
      const submission = new NativeResultSubmissionService(db, this.quality);
      // Reconcile the existing binding through the actual saved v1/v2 execution plan.
      // Reading a valid native plan alone does not establish that its profile/context matches it.
      const bound = await planner.bindReview(input.jobId, input.runId, this.quality.harnessIntegrityKey, submission); check();
      if (!bound.replayed || bound.plan.projectId !== input.projectId) return deny();
      const result = await submission.submit(this.scope.tenantId, input.runId); check();
      if (result.target.projectId !== input.projectId || Date.parse(result.target.submittedAt) > now()) return deny();
      return { receipt: { projectId: input.projectId, jobId: input.jobId, runId: input.runId,
        targetId: result.target.id, targetDigest: sha256Digest(result.target), contentHash: result.target.subjectDigest,
        rootSubjectId: result.target.subjectId, rootTargetId: result.target.rootTargetId, revisionNumber: result.target.revisionNumber,
        submittedAt: result.target.submittedAt, qualityAccepted: false as const, grantsExecutionAuthority: false as const }, replayed: result.replayed };
    }, assertSourceCurrent);
  }
}
