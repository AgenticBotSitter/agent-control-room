import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { NativeResultStore } from "../../artifacts/v1/native-results";
import type { PrivateWebProcessOptions } from "./private-process";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { NativeResultSubmissionService } from "../../completion-gate/v1/native-result-submission";
import { NativeResultVerificationService, nativeQualityRequestSchema, type AutomaticDocumentScenario,
  type NativeQualityConfiguration } from "../../completion-gate/v1/native-result-verification";
import { NativeTaskCompletionService } from "../../persistence/native-task-completion";
import { documentStructureRulesSchema } from "../../completion-gate/v1/document-structure-contract";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { catalogProjectIdSchema } from "./project-wire";
import { TaskCoordinatorInterruption } from "./task-coordinator-interruption";

export type TaskQualityConfiguration = NativeQualityConfiguration & { scenarios: readonly AutomaticDocumentScenario[] };
export const taskQualityRequestSchema = nativeQualityRequestSchema.extend({ projectId: catalogProjectIdSchema, jobId: catalogProjectIdSchema }).strict();
export type TaskQualityRequest = z.infer<typeof taskQualityRequestSchema>;
export const taskQualitySweepRequestSchema = z.object({ projectId: catalogProjectIdSchema,
  afterRunId: catalogProjectIdSchema.optional() }).strict();
export type TaskQualitySweepRequest = z.infer<typeof taskQualitySweepRequestSchema>;
export type TaskQualitySweepItem = { runId: string; jobId: string; status: "reconciled";
  result: Awaited<ReturnType<TaskQualityCoordinator["reconcile"]>> }
  | { runId: string; jobId: string; status: "unavailable"; requiresReconciliation: true };
export type TaskQualitySweepResult = { tenantId: string; workspaceId: string; projectId: string;
  items: TaskQualitySweepItem[]; nextRunId: string | null; grantsApproval: false; grantsExecutionAuthority: false };
const candidateRowsSchema = z.array(z.object({ run_id: catalogProjectIdSchema, job_id: catalogProjectIdSchema }).strict()).max(6);
const scenariosSchema = z.array(z.object({ scenarioId: catalogProjectIdSchema, acceptanceProfileId: catalogProjectIdSchema,
  acceptanceProfileDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), rules: documentStructureRulesSchema }).strict()).max(50);
const deny = (): never => { throw new Error("task_quality_unavailable"); };

export function validateTaskQualityKeys(quality: TaskQualityConfiguration, reviewKey: Uint8Array, web: PrivateWebProcessOptions["tasks"]) {
  const equal = (a: Uint8Array, b: Uint8Array | undefined) => b instanceof Uint8Array && a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
  if (!equal(quality.integrityKey, reviewKey) || !equal(quality.integrityKey, web?.reviews?.integrityKey)
    || !equal(quality.harnessIntegrityKey, web?.harnessIntegrityKey) || !equal(quality.results.integrityKey, web?.results?.integrityKey)) return deny();
}

/** Capture all supplied capabilities and config before any asynchronous startup/admission. */
export function captureTaskQualityConfiguration(config: TaskQualityConfiguration): TaskQualityConfiguration {
  const key = (value: Uint8Array) => { if (!(value instanceof Uint8Array) || value.length !== 32) return deny(); return Uint8Array.from(value); };
  const scenarios = scenariosSchema.parse(config.scenarios); assertNoSecretMaterial(scenarios);
  if (new Set(scenarios.map(value => JSON.stringify([value.acceptanceProfileId, value.acceptanceProfileDigest, value.scenarioId]))).size !== scenarios.length) return deny();
  const captured = { integrityKey: key(config.integrityKey), harnessIntegrityKey: key(config.harnessIntegrityKey), scenarios,
    results: { ...config.results, integrityKey: key(config.results.integrityKey), storage: Object.freeze({ read: config.results.storage.read.bind(config.results.storage) }) },
    checkpoints: Object.freeze({ read: config.checkpoints.read.bind(config.checkpoints), advance: config.checkpoints.advance.bind(config.checkpoints),
      initialize: () => { throw new Error("task_quality_provisioning_unavailable"); } }) };
  // Constructor validation is effect-free; malformed storage limits fail before pool acquisition.
  const unused: DatabaseClient = { query: deny, transaction: deny, transactionWithPreCommitCheck: deny };
  new NativeResultStore(unused, captured.harnessIntegrityKey, captured.results);
  return captured;
}

export class TaskQualityCoordinator {
  private readonly config: TaskQualityConfiguration;
  private readonly scope: { tenantId: string; workspaceId: string };
  private highWater = Number.NEGATIVE_INFINITY;
  constructor(private readonly db: DatabaseClient, scope: { tenantId: string; workspaceId: string },
    config: TaskQualityConfiguration, private readonly clock: () => number = Date.now) {
    this.scope = Object.freeze({ tenantId: catalogProjectIdSchema.parse(scope.tenantId), workspaceId: catalogProjectIdSchema.parse(scope.workspaceId) });
    this.config = captureTaskQualityConfiguration(config);
  }
  private async scopeIn(tx: DatabaseSession, request: Pick<TaskQualityRequest, "projectId" | "jobId" | "runId">) {
    const rows = await tx.query(`SELECT p.id FROM control_harness_runs r
      JOIN control_jobs j ON j.tenant_id=r.tenant_id AND j.id=r.job_id AND j.project_id=r.project_id
      JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id
      WHERE r.tenant_id=$1 AND r.id=$2 AND j.id=$3 AND p.id=$4 AND p.workspace_id=$5 FOR SHARE OF p`,
    [this.scope.tenantId, request.runId, request.jobId, request.projectId, this.scope.workspaceId]);
    if (rows.rows.length !== 1) return deny();
  }
  private operation(signal: AbortSignal, assertCurrent: () => void) {
    if (!(signal instanceof AbortSignal)) return deny();
    let interrupted = false;
    const stop = (): never => { interrupted = true; throw new TaskCoordinatorInterruption("task_quality_unavailable"); };
    const time = () => {
      if (interrupted) return stop();
      let now: number; try { now = this.clock(); } catch { return stop(); }
      if (!Number.isSafeInteger(now) || now < 0 || now < this.highWater) return stop();
      this.highWater = now; return now;
    };
    const started = time(), current = () => {
      if (signal.aborted || time() - started > 10_000) return stop();
      try { assertCurrent(); } catch { return stop(); }
    };
    current();
    return { time, current };
  }
  /** One supplied-runtime tick over canonical saved results. No daemon, new queue or native effect.
   * Candidate indexes are hints only; exact bindings/bytes are verified again before reconciliation.
   * Earlier candidates may commit even if a later failure invalidates this whole call. */
  async sweep(input: TaskQualitySweepRequest, signal: AbortSignal, assertCurrent: () => void): Promise<TaskQualitySweepResult> {
    const request = taskQualitySweepRequestSchema.parse(input); assertNoSecretMaterial(request);
    const { current } = this.operation(signal, assertCurrent);
    const rows = await this.db.transactionWithPreCommitCheck(async tx => {
      current();
      const project = await tx.query("SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR SHARE",
        [this.scope.tenantId, this.scope.workspaceId, request.projectId]);
      current(); if (project.rows.length !== 1) return deny();
      const selected = await tx.query(`SELECT r.id AS run_id,j.id AS job_id FROM control_harness_runs r
        JOIN control_jobs j ON j.tenant_id=r.tenant_id AND j.project_id=r.project_id AND j.id=r.job_id
        JOIN control_native_review_plans p ON p.tenant_id=r.tenant_id AND p.project_id=r.project_id AND p.job_id=j.id AND p.run_id=r.id
        JOIN control_native_artifact_receipts a ON a.tenant_id=r.tenant_id AND a.project_id=r.project_id AND a.job_id=j.id AND a.run_id=r.id
        WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.state='succeeded' AND j.state IN ('leased','running')
          AND r.id COLLATE "C" > $3::text COLLATE "C"
        ORDER BY r.id COLLATE "C" LIMIT 6`, [this.scope.tenantId, request.projectId, request.afterRunId ?? ""]);
      current();
      const candidates = candidateRowsSchema.parse(selected.rows);
      if (candidates.some((row, index) => row.run_id <= (index ? candidates[index - 1].run_id : request.afterRunId ?? ""))) return deny();
      return candidates;
    }, current);
    current();
    const submission = new NativeResultSubmissionService(this.db, this.config), items: TaskQualitySweepItem[] = [];
    for (const row of rows.slice(0, 5)) {
      current();
      try {
        const exact = await this.db.transactionWithPreCommitCheck(async tx => {
          current();
          await this.scopeIn(tx, { projectId: request.projectId, jobId: row.job_id, runId: row.run_id });
          current();
          const context = await submission.inspectSubmitted(tx, this.scope.tenantId, row.run_id);
          current();
          if (context.run.projectId !== request.projectId || context.job.id !== row.job_id) return deny();
          return taskQualityRequestSchema.parse({ tenantId: this.scope.tenantId, projectId: request.projectId,
            runId: row.run_id, jobId: row.job_id, targetDigest: context.snapshot.targetDigest, contentHash: context.result.receipt.contentHash });
        }, current);
        current();
        const result = await this.reconcile(exact, signal, current);
        current(); items.push({ runId: row.run_id, jobId: row.job_id, status: "reconciled", result });
      } catch (error) {
        // Do not convert cancellation, a stale lifecycle or an expired budget into a normal item.
        if (error instanceof TaskCoordinatorInterruption) throw error;
        current(); items.push({ runId: row.run_id, jobId: row.job_id, status: "unavailable", requiresReconciliation: true });
      }
    }
    current();
    return { ...this.scope, projectId: request.projectId, items, nextRunId: rows.length > 5 ? rows[4].run_id : null,
      grantsApproval: false, grantsExecutionAuthority: false };
  }
  async reconcile(input: TaskQualityRequest, signal: AbortSignal, assertCurrent: () => void) {
    const request = taskQualityRequestSchema.parse(input); assertNoSecretMaterial(request);
    if (request.tenantId !== this.scope.tenantId) return deny();
    const { time, current } = this.operation(signal, assertCurrent);
    const db: DatabaseClient = { query: () => { throw new Error("task_quality_transaction_required"); },
      transaction: work => db.transactionWithPreCommitCheck(work, () => {}),
      transactionWithPreCommitCheck: (work, precommit) => { current(); return this.db.transactionWithPreCommitCheck(async tx => {
        current(); await this.scopeIn(tx, request); current(); return work(tx);
      }, async () => { current(); await precommit(); current(); }); } };
    const native = nativeQualityRequestSchema.parse({ tenantId: request.tenantId, runId: request.runId,
      targetDigest: request.targetDigest, contentHash: request.contentHash });
    const submission = new NativeResultSubmissionService(db, this.config);
    const inspect = () => db.transaction(async tx => {
      const context = await submission.inspectSubmitted(tx, request.tenantId, request.runId);
      if (context.run.projectId !== request.projectId || context.run.jobId !== request.jobId
        || context.snapshot.targetDigest !== request.targetDigest || context.result.receipt.contentHash !== request.contentHash) return deny();
      return context;
    });
    let context = await inspect();
    let verification: "not_configured" | "not_run" | "recorded" | "replayed" = "not_run";
    if (["pending", "ready"].includes(context.snapshot.status)) {
      const scenarios = this.config.scenarios.filter(value => value.acceptanceProfileId === context.profile.id
        && value.acceptanceProfileDigest === sha256Digest(context.profile) && context.profile.requiredVerificationScenarioIds.includes(value.scenarioId));
      if (scenarios.length) {
        const verified = await new NativeResultVerificationService(db, this.config, scenarios, time).verify(native, current);
        verification = verified.replayed ? "replayed" : "recorded"; context = await inspect();
      } else verification = "not_configured";
    }
    const base = { ...request, verification, grantsApproval: false as const, grantsExecutionAuthority: false as const };
    // Verified native completion frees occupancy independently of the quality disposition.
    // Ready results retain the existing atomic quality-completion path and its exact replay.
    const capacity = context.snapshot.status === "ready" ? undefined
      : await new NativeTaskCompletionService(db, this.config, time).releaseCapacity(native, current);
    current();
    switch (context.snapshot.status) {
      case "ready": {
        const completion = await new NativeTaskCompletionService(db, this.config, time).complete(native, current);
        current(); return { ...base, disposition: "completed" as const, completion };
      }
      case "pending": current(); return { ...base, capacity, disposition: "waiting_review" as const };
      case "changes_requested": case "revision_limit_reached":
        current(); return { ...base, capacity, disposition: "changes_requested" as const };
      case "verification_blocked": current(); return { ...base, capacity, disposition: "verification_blocked" as const };
      case "superseded": current(); return { ...base, capacity, disposition: "superseded" as const };
      default: return deny();
    }
  }
}
export type TaskQualityOperation = Readonly<{ tenantId: string; workspaceId: string;
  reconcile: (input: TaskQualityRequest, signal: AbortSignal) => ReturnType<TaskQualityCoordinator["reconcile"]>;
  sweep: (input: TaskQualitySweepRequest, signal: AbortSignal) => Promise<TaskQualitySweepResult> }>;
