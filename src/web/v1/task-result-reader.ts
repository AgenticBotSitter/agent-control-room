import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { NativeResultStore, verifyStoredTaskResultRowV1, type NativeResultReadConfiguration,
  type StoredTaskResultRowV1 } from "../../artifacts/v1/native-results";
import { listDurableResultReceiptsV1, readDurableResultReceiptV1, readDurableResultV1,
  verifyDurableStoredResultRowV1 } from "../../artifacts/v1/durable-result-publication";
import { readTaskReviewPlanV1, taskReviewPlanKeyV1, verifiedTaskReviewPlanV1,
  type TaskReviewPlanV1, type TaskResultReceiptV1 } from "../../completion-gate/v1/task-review-plan";

export type PlanSelectedTaskResultReceiptV1 = TaskResultReceiptV1;
export type PlanSelectedTaskResultV1 = Readonly<{ receipt: PlanSelectedTaskResultReceiptV1; text: string }>;
export type PlanSelectedTaskResultPageV1 = Readonly<{
  receipts: readonly PlanSelectedTaskResultReceiptV1[];
  additionalResultsOmitted: boolean;
}>;

export interface PlanSelectedTaskResultReaderConfigurationV1 {
  /** Authenticates legacy native and Codex receipts. */
  harnessIntegrityKey: Uint8Array;
  /** Read-only durable artifact storage and its receipt integrity key. */
  results: NativeResultReadConfiguration;
  /** Authenticates the immutable review plan that selects the receipt reader. */
  reviewIntegrityKey?: Uint8Array;
}

/**
 * Read-only task result selector. The authenticated review plan chooses the
 * receipt family before a receipt is read; a durable plan can never fall back
 * to the legacy native/Codex reader if durable evidence is absent or invalid.
 */
export class PlanSelectedTaskResultReaderV1 {
  private readonly legacy: NativeResultStore;
  private readonly durableKey: Uint8Array;
  private readonly durableStorageClass: NativeResultReadConfiguration["storageClass"];
  private readonly durableReadBytes: NativeResultReadConfiguration["storage"]["read"];
  private readonly reviewKey?: Uint8Array;

  constructor(db: DatabaseClient, config: PlanSelectedTaskResultReaderConfigurationV1) {
    if (!(config.harnessIntegrityKey instanceof Uint8Array) || config.harnessIntegrityKey.length !== 32
      || config.reviewIntegrityKey !== undefined && (!(config.reviewIntegrityKey instanceof Uint8Array) || config.reviewIntegrityKey.length !== 32))
      throw new Error("task_result_reader_configuration_invalid");
    this.legacy = new NativeResultStore(db, config.harnessIntegrityKey, { ...config.results,
      storage: Object.freeze({ read: config.results.storage.read.bind(config.results.storage) }) });
    this.durableKey = Uint8Array.from(config.results.integrityKey);
    this.durableStorageClass = config.results.storageClass;
    this.durableReadBytes = config.results.storage.read.bind(config.results.storage);
    this.reviewKey = config.reviewIntegrityKey === undefined ? undefined : Uint8Array.from(config.reviewIntegrityKey);
  }

  private async plan(tx: DatabaseSession, tenantId: string, projectId: string, jobId: string): Promise<TaskReviewPlanV1 | undefined> {
    return this.reviewKey === undefined ? undefined : readTaskReviewPlanV1(tx, this.reviewKey, tenantId, projectId, jobId);
  }
  private durable(plan: TaskReviewPlanV1 | undefined): boolean {
    return plan?.schema === "control-room.durable-result-review-plan/v1";
  }

  async list(tx: DatabaseSession, tenantId: string, projectId: string, jobId: string): Promise<PlanSelectedTaskResultPageV1> {
    const plan = await this.plan(tx, tenantId, projectId, jobId);
    if (this.durable(plan)) return listDurableResultReceiptsV1(tx, this.durableKey, this.durableStorageClass, tenantId, projectId, jobId);
    return this.legacy.list(tx, tenantId, projectId, jobId);
  }

  /** One joined receipt-and-plan query for a bounded set of task keys.
   * The authenticated plan still exclusively selects the receipt verifier;
   * a durable task can never fall back to legacy evidence. */
  async listMany(tx: DatabaseSession, tenantId: string, tasks: readonly { projectId: string; jobId: string }[]): Promise<{
    pages: ReadonlyMap<string, PlanSelectedTaskResultPageV1>;
    plans: ReadonlyMap<string, TaskReviewPlanV1>;
  }> {
    const keys = [...new Map(tasks.map(task => [taskReviewPlanKeyV1(task.projectId, task.jobId), task])).values()];
    if (!keys.length) return { pages: new Map(), plans: new Map() };
    const requested = new Set(keys.map(task => taskReviewPlanKeyV1(task.projectId, task.jobId)));
    const plans = new Map<string, TaskReviewPlanV1>();
    const projects = [...new Set(keys.map(task => task.projectId))], jobs = [...new Set(keys.map(task => task.jobId))];
    const rows = (await tx.query<StoredTaskResultRowV1 & { page_row: number | string; review_plan: unknown | null;
      review_plan_auth_tag: string | null; review_plan_run_id: string | null }>(`SELECT * FROM (
      SELECT r.tenant_id,r.project_id,r.job_id,r.attempt_id,r.run_id,r.artifact_id,r.receipt,r.auth_tag,
        m.payload AS manifest,m.content_hash,m.state,m.version,m.workflow_id,m.created_at,m.updated_at,
        rp.plan AS review_plan,rp.auth_tag AS review_plan_auth_tag,rp.run_id AS review_plan_run_id,
        row_number() OVER (PARTITION BY r.project_id,r.job_id ORDER BY r.artifact_id COLLATE "C") AS page_row
      FROM control_native_artifact_receipts r JOIN control_artifact_manifests m
        ON m.tenant_id=r.tenant_id AND m.id=r.artifact_id AND m.project_id=r.project_id
        AND m.job_id=r.job_id AND m.attempt_id=r.attempt_id
      LEFT JOIN control_native_review_plans rp ON rp.tenant_id=r.tenant_id AND rp.project_id=r.project_id AND rp.job_id=r.job_id
      WHERE r.tenant_id=$1 AND r.project_id=ANY($2::text[]) AND r.job_id=ANY($3::text[])
    ) batched WHERE page_row<=51 ORDER BY project_id COLLATE "C",job_id COLLATE "C",artifact_id COLLATE "C"`,
    [tenantId, projects, jobs])).rows;
    const grouped = new Map<string, TaskResultReceiptV1[]>();
    for (const row of rows) {
      const key = taskReviewPlanKeyV1(row.project_id, row.job_id);
      if (!requested.has(key)) continue;
      let plan = plans.get(key);
      if (this.reviewKey !== undefined && row.review_plan !== null && row.review_plan_auth_tag !== null && row.review_plan_run_id !== null) {
        const verified = verifiedTaskReviewPlanV1(this.reviewKey, { tenant_id: row.tenant_id, project_id: row.project_id,
          job_id: row.job_id, run_id: row.review_plan_run_id, plan: row.review_plan, auth_tag: row.review_plan_auth_tag });
        if (plan && JSON.stringify(plan) !== JSON.stringify(verified)) throw new Error("task_review_plan_unavailable");
        plan = verified; plans.set(key, verified);
      }
      const receipt = this.durable(plan)
        ? verifyDurableStoredResultRowV1(row, this.durableKey, this.durableStorageClass)
        : verifyStoredTaskResultRowV1(row, this.durableKey, this.durableStorageClass).receipt;
      const receipts = grouped.get(key) ?? [];
      receipts.push(receipt); grouped.set(key, receipts);
    }
    const pages = new Map<string, PlanSelectedTaskResultPageV1>();
    for (const task of keys) {
      const key = taskReviewPlanKeyV1(task.projectId, task.jobId), receipts = grouped.get(key) ?? [];
      pages.set(key, { receipts: receipts.slice(0, 50), additionalResultsOmitted: receipts.length > 50 });
    }
    return { pages, plans };
  }

  async readReceipt(tx: DatabaseSession, tenantId: string, projectId: string, jobId: string,
    artifactId: string): Promise<PlanSelectedTaskResultReceiptV1 | undefined> {
    const plan = await this.plan(tx, tenantId, projectId, jobId);
    if (this.durable(plan)) return readDurableResultReceiptV1(tx, this.durableKey, this.durableStorageClass,
      tenantId, projectId, jobId, artifactId);
    return this.legacy.readReceipt(tx, tenantId, projectId, jobId, artifactId);
  }

  async read(tx: DatabaseSession, tenantId: string, projectId: string, jobId: string,
    artifactId: string): Promise<PlanSelectedTaskResultV1 | undefined> {
    const plan = await this.plan(tx, tenantId, projectId, jobId);
    if (this.durable(plan)) return readDurableResultV1(tx, this.durableKey, this.durableStorageClass,
      this.durableReadBytes, tenantId, projectId, jobId, artifactId);
    return this.legacy.read(tx, tenantId, projectId, jobId, artifactId);
  }
}
