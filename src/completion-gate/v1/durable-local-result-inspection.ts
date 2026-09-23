import { z } from "zod";
import { attemptRecordSchema, jobRecordSchema, leaseRecordSchema } from "../../domain/v1";
import { readDurableResultV1 } from "../../artifacts/v1/durable-result-publication";
import type { ArtifactReadPortV1 } from "../../node-executor/artifact-storage";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { sha256Digest, type AwaitableRollbackCheckpointStoreV1 } from "../../security";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import { readControllerWorkerDeliveryReceiptV1 } from "../../harness/v1/controller-worker-delivery-receipt-store";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1 } from "../../harness/hermes-021-v1";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 } from "../../harness/claude-code-v1";
import { CompletionGateStoreV1 } from "./store";
import { completionAcceptanceProfileSchemaV1 } from "./schemas";
import { durableReviewTargetV1, verifyDurableResultReviewPlanV1, verifyReviewPlanAgainstReceiptV1,
  type DurableResultReviewPlanRowV1 } from "./durable-result-review-plan";
import type { SubmittedTaskResultInspectionV1, TaskResultInspectionSourceV1 } from "./task-result-inspection";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
const unavailable = (): never => { throw new Error("durable_local_result_inspection_unavailable"); };

type ReceiptLocator = { project_id: string; job_id: string; attempt_id: string; artifact_id: string };
type JobRow = { payload: unknown; state: string; version: number; project_id: string };
type AttemptRow = { payload: unknown; state: string; version: number; job_id: string; node_id: string };
type LeaseRow = { payload: unknown; state: string; version: number; job_id: string; attempt_id: string; node_id: string; epoch: number; expires_at: string | Date };

export type DurableLocalResultInspectionConfigurationV1 = Readonly<{
  integrityKey: Uint8Array;
  reviewIntegrityKey: Uint8Array;
  harnessIntegrityKey: Uint8Array;
  /** Only locally enrolled adapters need a key. An absent adapter is refused,
   * never downgraded to an unsigned or shared receipt check. */
  deliveryIntegrityKeys: Readonly<{ hermes?: Uint8Array; claude?: Uint8Array }>;
  checkpoints: AwaitableRollbackCheckpointStoreV1;
  storageClass: "local" | "r2";
  storage: ArtifactReadPortV1;
}>;

/**
 * Reads an already-completed local Hermes or Claude result back into the
 * ordinary review, correction, and capacity-release workflow. It owns no
 * delivery, process, queue, database table, or storage write authority.
 */
export class DurableLocalResultInspectionServiceV1 implements TaskResultInspectionSourceV1 {
  private readonly resultKey: Uint8Array;
  private readonly reviewKey: Uint8Array;
  private readonly harnessKey: Uint8Array;
  private readonly hermesDeliveryKey?: Uint8Array;
  private readonly claudeDeliveryKey?: Uint8Array;
  private readonly checkpoints: AwaitableRollbackCheckpointStoreV1;
  private readonly readBytes: ArtifactReadPortV1["read"];
  private readonly storageClass: "local" | "r2";

  constructor(private readonly db: DatabaseClient, config: DurableLocalResultInspectionConfigurationV1) {
    const deliveryKeys = [config.deliveryIntegrityKeys?.hermes, config.deliveryIntegrityKeys?.claude]
      .filter((key): key is Uint8Array => key !== undefined);
    for (const key of [config.integrityKey, config.reviewIntegrityKey, config.harnessIntegrityKey, ...deliveryKeys]) {
      if (!(key instanceof Uint8Array) || key.length !== 32) unavailable();
    }
    if (!deliveryKeys.length) unavailable();
    if (!config.checkpoints || typeof config.checkpoints.read !== "function" || typeof config.checkpoints.advance !== "function"
      || typeof config.checkpoints.initialize !== "function" || !["local", "r2"].includes(config.storageClass)
      || typeof config.storage?.read !== "function") unavailable();
    this.resultKey = Uint8Array.from(config.integrityKey);
    this.reviewKey = Uint8Array.from(config.reviewIntegrityKey);
    this.harnessKey = Uint8Array.from(config.harnessIntegrityKey);
    this.hermesDeliveryKey = config.deliveryIntegrityKeys.hermes && Uint8Array.from(config.deliveryIntegrityKeys.hermes);
    this.claudeDeliveryKey = config.deliveryIntegrityKeys.claude && Uint8Array.from(config.deliveryIntegrityKeys.claude);
    this.checkpoints = Object.freeze({ read: config.checkpoints.read.bind(config.checkpoints),
      advance: config.checkpoints.advance.bind(config.checkpoints), initialize: config.checkpoints.initialize.bind(config.checkpoints) });
    this.readBytes = config.storage.read.bind(config.storage);
    this.storageClass = config.storageClass;
  }

  async inspectSubmitted(tx: DatabaseSession, tenantIdValue: string, runIdValue: string): Promise<SubmittedTaskResultInspectionV1> {
    const tenantId = id.parse(tenantIdValue), runId = id.parse(runIdValue);
    const locked = await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, runId]);
    if (locked.rows.length !== 1) return unavailable();
    const inspected = await new HarnessRunStoreV1(joined(tx), this.harnessKey).inspect(tenantId, runId);
    if (!inspected) return unavailable();
    const { run, events } = inspected;
    const hermes = run.adapterId === HERMES_021_MACOS_LOCAL_ADAPTER_V1 && run.harness === "hermes"
      && run.connectorProfileDigest === HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1;
    const claude = run.adapterId === CLAUDE_CODE_LOCAL_ADAPTER_V1 && run.harness === "claude"
      && run.connectorProfileDigest === CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1;
    const terminal = events.at(-1);
    if ((!hermes && !claude) || run.nativeTask || run.resumable || run.state !== "succeeded"
      || !run.startedAt || !run.finishedAt || !terminal || terminal.payload.category !== "lifecycle"
      || terminal.payload.state !== "succeeded" || Date.parse(run.finishedAt) < Date.parse(run.startedAt)) return unavailable();

    const locator = (await tx.query<ReceiptLocator>(`SELECT project_id,job_id,attempt_id,artifact_id
      FROM control_native_artifact_receipts WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`, [tenantId, runId])).rows[0];
    if (!locator || locator.project_id !== run.projectId || locator.job_id !== run.jobId || locator.attempt_id !== run.attemptId) return unavailable();
    const reviewRow = (await tx.query<DurableResultReviewPlanRowV1>(`SELECT * FROM control_native_review_plans
      WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`, [tenantId, runId])).rows[0];
    if (!reviewRow) return unavailable();
    const plan = verifyDurableResultReviewPlanV1(this.reviewKey, reviewRow);
    const result = await readDurableResultV1(tx, this.resultKey, this.storageClass, this.readBytes,
      tenantId, run.projectId, run.jobId, locator.artifact_id);
    if (!result || result.receipt.attemptId !== run.attemptId || result.receipt.nodeId !== run.nodeId
      || result.receipt.connectorProfileDigest !== run.connectorProfileDigest
      || result.receipt.receivedAt !== run.finishedAt || !result.receipt.terminalEvidenceDigest) return unavailable();
    verifyReviewPlanAgainstReceiptV1(plan, result.receipt);
    if (plan.terminalEvidenceDigest !== result.receipt.terminalEvidenceDigest || plan.plannedAt > result.receipt.receivedAt) return unavailable();

    const deliveryKey = hermes ? this.hermesDeliveryKey : this.claudeDeliveryKey;
    if (!deliveryKey) return unavailable();
    const delivery = await readControllerWorkerDeliveryReceiptV1(tx, deliveryKey,
      { tenantId, projectId: run.projectId, jobId: run.jobId, attemptId: run.attemptId });
    if (!delivery || delivery.delivery.identity.runId !== run.id || delivery.delivery.identity.nodeId !== run.nodeId
      || delivery.delivery.worker.adapterId !== run.adapterId || delivery.delivery.connectorProfileDigest !== run.connectorProfileDigest
      || delivery.delivery.authorityDigest !== run.authorityDigest || delivery.delivery.acceptanceProfileId !== plan.acceptanceProfileId
      || delivery.delivery.acceptanceProfileDigest !== plan.acceptanceProfileDigest
      || !["accepted", "duplicate"].includes(delivery.receipt.disposition)) return unavailable();

    const jobRow = (await tx.query<JobRow>(`SELECT payload,state,version,project_id FROM control_jobs
      WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, run.jobId])).rows[0];
    const attemptRow = (await tx.query<AttemptRow>(`SELECT payload,state,version,job_id,node_id FROM control_attempts
      WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, run.attemptId])).rows[0];
    if (!jobRow || !attemptRow) return unavailable();
    const job = jobRecordSchema.parse(jobRow.payload), attempt = attemptRecordSchema.parse(attemptRow.payload);
    const leaseRow = (await tx.query<LeaseRow>(`SELECT payload,state,version,job_id,attempt_id,node_id,epoch,expires_at FROM control_leases
      WHERE tenant_id=$1 AND attempt_id=$2 AND job_id=$3 AND node_id=$4 AND epoch=$5 FOR UPDATE`,
    [tenantId, run.attemptId, run.jobId, run.nodeId, attempt.leaseEpoch])).rows[0];
    if (!leaseRow) return unavailable();
    const lease = leaseRecordSchema.parse(leaseRow.payload);
    if (job.tenantId !== tenantId || job.id !== run.jobId || job.projectId !== run.projectId || job.state !== jobRow.state
      || job.version !== Number(jobRow.version) || jobRow.project_id !== job.projectId || job.authority.digest !== run.authorityDigest
      || job.inputDigest !== delivery.delivery.inputDigest || attempt.tenantId !== tenantId || attempt.id !== run.attemptId
      || attempt.state !== attemptRow.state || attempt.version !== Number(attemptRow.version) || attemptRow.job_id !== attempt.jobId
      || attemptRow.node_id !== attempt.nodeId || attempt.jobId !== job.id || attempt.nodeId !== run.nodeId
      || lease.tenantId !== tenantId || lease.state !== leaseRow.state || lease.version !== Number(leaseRow.version)
      || leaseRow.job_id !== lease.jobId || leaseRow.attempt_id !== lease.attemptId || leaseRow.node_id !== lease.nodeId
      || Number(leaseRow.epoch) !== lease.epoch || new Date(leaseRow.expires_at).toISOString() !== lease.expiresAt
      || lease.jobId !== job.id || lease.attemptId !== attempt.id || lease.nodeId !== run.nodeId || lease.epoch !== attempt.leaseEpoch
      || !["active", "released"].includes(lease.state)) return unavailable();

    const gate = new CompletionGateStoreV1(joined(tx), this.reviewKey, this.checkpoints);
    const profile = completionAcceptanceProfileSchemaV1.parse(await gate.getRecord(tenantId, plan.acceptanceProfileId, "profile"));
    const target = durableReviewTargetV1(plan, result.receipt), snapshot = await gate.snapshot(tenantId, target.id);
    if (profile.tenantId !== tenantId || profile.projectId !== run.projectId || profile.targetKind !== "document"
      || sha256Digest(profile) !== plan.acceptanceProfileDigest || sha256Digest(snapshot.target) !== sha256Digest(target)
      || snapshot.targetDigest !== sha256Digest(target) || Date.parse(profile.createdAt) > Date.parse(plan.plannedAt)
      || Date.parse(run.finishedAt) > Date.parse(delivery.delivery.expiresAt)) return unavailable();
    return { run, job, profile, result, snapshot, gate,
      execution: { leaseId: lease.id, leaseEpoch: lease.epoch, startedAt: run.startedAt, completedAt: run.finishedAt,
        // Preparation already bound this packet to the earlier of the current
        // lease and task-authority deadlines. Reuse that signed, verified
        // boundary instead of reconstructing a potentially different value.
        completedBefore: delivery.delivery.expiresAt } };
  }
}
