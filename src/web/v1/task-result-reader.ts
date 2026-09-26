import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { NativeResultStore, type NativeResultReadConfiguration } from "../../artifacts/v1/native-results";
import { listDurableResultReceiptsV1, readDurableResultReceiptV1, readDurableResultV1 } from "../../artifacts/v1/durable-result-publication";
import { readTaskReviewPlanV1, type TaskReviewPlanV1, type TaskResultReceiptV1 } from "../../completion-gate/v1/task-review-plan";

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
