import { z } from "zod";
import { appendAuditWith } from "../../audit/audit-store";
import { readDurableResultV1 } from "../../artifacts/v1/durable-result-publication";
import type { ArtifactReadPortV1 } from "../../node-executor/artifact-storage";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { sha256Digest, type AwaitableRollbackCheckpointStoreV1 } from "../../security";
import { stageAsyncCompletionCheckpoint } from "./async-staged-checkpoint";
import { durableReviewTargetV1, verifyDurableResultReviewPlanV1, verifyReviewPlanAgainstReceiptV1,
  type DurableResultReviewPlanRowV1, type DurableResultReviewPlanV1 } from "./durable-result-review-plan";
import { completionAcceptanceProfileSchemaV1 } from "./schemas";
import { CompletionGateStoreV1 } from "./store";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
const unavailable = (): never => { throw new Error("durable_result_review_submission_unavailable"); };

type ReceiptLocator = { project_id: string; job_id: string; artifact_id: string };

export type DurableResultReviewSubmissionConfigurationV1 = {
  /** Authenticates the durable receipt and manifest. */
  integrityKey: Uint8Array;
  /** Authenticates the immutable durable review plan and Completion Gate records. */
  reviewIntegrityKey: Uint8Array;
  checkpoints: AwaitableRollbackCheckpointStoreV1;
  storageClass: "local" | "r2";
  storage: ArtifactReadPortV1;
};

/**
 * Registers the one pending Completion Gate target for a previously published
 * harness-neutral durable result. It trusts neither caller-supplied receipt
 * data nor a publisher return value: the receipt bytes, authenticated receipt,
 * immutable review plan, and acceptance profile are read again in one staged
 * transaction. It records no quality decision or completion acceptance.
 */
export class DurableResultReviewSubmissionServiceV1 {
  private readonly resultKey: Uint8Array;
  private readonly reviewKey: Uint8Array;
  private readonly checkpoints: AwaitableRollbackCheckpointStoreV1;
  private readonly readBytes: ArtifactReadPortV1["read"];
  private readonly storageClass: "local" | "r2";

  constructor(private readonly db: DatabaseClient, config: DurableResultReviewSubmissionConfigurationV1) {
    if (!(config.integrityKey instanceof Uint8Array) || config.integrityKey.length !== 32
      || !(config.reviewIntegrityKey instanceof Uint8Array) || config.reviewIntegrityKey.length !== 32
      || !["local", "r2"].includes(config.storageClass) || typeof config.storage?.read !== "function"
      || typeof config.checkpoints?.read !== "function" || typeof config.checkpoints?.advance !== "function"
      || typeof config.checkpoints?.initialize !== "function") unavailable();
    this.resultKey = Uint8Array.from(config.integrityKey);
    this.reviewKey = Uint8Array.from(config.reviewIntegrityKey);
    this.storageClass = config.storageClass;
    this.readBytes = config.storage.read.bind(config.storage);
    this.checkpoints = Object.freeze({ read: config.checkpoints.read.bind(config.checkpoints),
      advance: config.checkpoints.advance.bind(config.checkpoints), initialize: config.checkpoints.initialize.bind(config.checkpoints) });
  }

  private async profile(gate: CompletionGateStoreV1, plan: DurableResultReviewPlanV1, projectId: string) {
    const profile = completionAcceptanceProfileSchemaV1.parse(await gate.getRecord(plan.tenantId, plan.acceptanceProfileId, "profile"));
    if (profile.tenantId !== plan.tenantId || profile.projectId !== projectId || profile.targetKind !== "document"
      || sha256Digest(profile) !== plan.acceptanceProfileDigest || Date.parse(profile.createdAt) > Date.parse(plan.plannedAt)) unavailable();
    return profile;
  }

  private async readPlan(tx: DatabaseSession, tenantId: string, runId: string) {
    const row = (await tx.query<DurableResultReviewPlanRowV1>(`SELECT * FROM control_native_review_plans
      WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`, [tenantId, runId])).rows[0];
    if (!row) unavailable();
    return verifyDurableResultReviewPlanV1(this.reviewKey, row);
  }

  /** Trusted transaction-only reconstruction. It never registers a target or infers a review decision. */
  async inspectSubmitted(tx: DatabaseSession, tenantId: string, runId: string) {
    id.parse(tenantId); id.parse(runId);
    const locator = (await tx.query<ReceiptLocator>(`SELECT project_id,job_id,artifact_id
      FROM control_native_artifact_receipts WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`, [tenantId, runId])).rows[0];
    if (!locator) unavailable();
    const plan = await this.readPlan(tx, tenantId, runId);
    if (plan.projectId !== locator.project_id || plan.jobId !== locator.job_id) unavailable();
    const result = await readDurableResultV1(tx, this.resultKey, this.storageClass, this.readBytes,
      tenantId, locator.project_id, locator.job_id, locator.artifact_id);
    if (!result) return unavailable();
    const { receipt } = result;
    verifyReviewPlanAgainstReceiptV1(plan, receipt);
    if (receipt.acceptanceProfileId !== plan.acceptanceProfileId
      || receipt.acceptanceProfileDigest !== plan.acceptanceProfileDigest) unavailable();
    const target = durableReviewTargetV1(plan, receipt);
    return { plan, receipt, target };
  }

  /**
   * Creates only the pending owner-review target. The tenant checkpoint is
   * advanced only after the database transaction commits; exact retries return
   * the registered target and do not append another audit event.
   */
  async submit(tenantId: string, runId: string) {
    try {
      id.parse(tenantId); id.parse(runId);
      const staged = stageAsyncCompletionCheckpoint(this.checkpoints, tenantId);
      return await this.db.transactionWithPreCommitCheck(async tx => {
        const submitted = await this.inspectSubmitted(tx, tenantId, runId);
        const gate = new CompletionGateStoreV1(joined(tx), this.reviewKey, staged.checkpoints);
        await this.profile(gate, submitted.plan, submitted.receipt.projectId);
        const registered = await gate.registerTarget(submitted.target);
        if (!registered.replayed) await appendAuditWith(tx, { id: `audit:durable-submission:${sha256Digest({ tenantId, runId }).slice(7)}`,
          tenantId, projectId: submitted.plan.projectId, actorId: "service:durable-result-review-submission", actorType: "service",
          action: "task.result.submitted_for_review", targetType: "artifact", targetId: submitted.receipt.artifactId,
          occurredAt: submitted.receipt.receivedAt, idempotencyKey: sha256Digest(submitted.plan),
          safeMetadata: { targetId: submitted.target.id, contentHash: submitted.target.subjectDigest,
            qualityAccepted: false, completionVerified: false } });
        return { target: registered.target, replayed: registered.replayed, qualityAccepted: false as const,
          completionVerified: false as const, releasesCapacity: false as const };
      }, () => staged.flush());
    } catch { return unavailable(); }
  }
}
