import { timingSafeEqual } from "node:crypto";
import { codexCanonicalResultRecordSchemaV1 } from "../../harness/codex-v1/canonical-result-record";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import { jobRecordSchema } from "../../domain/v1";
import { NativeResultStore, nativeResultId, type NativeResultReadConfiguration } from "../../artifacts/v1/native-results";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest, type AwaitableRollbackCheckpointStoreV1 } from "../../security";
import { readCodexTaskExecutionPlanV3InSession } from "../../web/v1/task-execution-planner";
import { readCodexActivationTransmissionIntentInSession } from "../../web/v1/codex-activation-transmission-intent";
import { CompletionGateStoreV1 } from "./store";
import { completionAcceptanceProfileSchemaV1 } from "./schemas";
import { readCodexReviewPlanV1, codexReviewTargetV1 } from "./codex-review-plan";
import type { SubmittedTaskResultInspectionV1, TaskResultInspectionSourceV1 } from "./task-result-inspection";

type PublicationRow = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; run_id: string;
  publication_id: string; record_digest: string; record: unknown; auth_tag: string; recorded_at: string | Date };
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
const unavailable = (): never => { throw new Error("codex_result_inspection_unavailable"); };

export type CodexResultInspectionConfigurationV1 = {
  integrityKey: Uint8Array; harnessIntegrityKey: Uint8Array; taskPlanIntegrityKey: Uint8Array;
  activationIntegrityKey: Uint8Array; reviewIntegrityKey: Uint8Array;
  checkpoints: AwaitableRollbackCheckpointStoreV1; results: NativeResultReadConfiguration;
};

/** Reconstructs the exact persisted Codex result and its shared Completion Gate target.
 * It trusts only authenticated records created by the canonical publisher and performs no effects. */
export class CodexResultInspectionServiceV1 implements TaskResultInspectionSourceV1 {
  private readonly resultKey: Uint8Array; private readonly harnessKey: Uint8Array;
  private readonly taskPlanKey: Uint8Array; private readonly activationKey: Uint8Array;
  private readonly reviewKey: Uint8Array; private readonly checkpoints: AwaitableRollbackCheckpointStoreV1;
  private readonly results: NativeResultStore;
  constructor(private readonly db: DatabaseClient, config: CodexResultInspectionConfigurationV1) {
    for (const key of [config.integrityKey, config.harnessIntegrityKey, config.taskPlanIntegrityKey,
      config.activationIntegrityKey, config.reviewIntegrityKey]) if (!(key instanceof Uint8Array) || key.length !== 32) unavailable();
    this.resultKey = Uint8Array.from(config.integrityKey); this.harnessKey = Uint8Array.from(config.harnessIntegrityKey);
    this.taskPlanKey = Uint8Array.from(config.taskPlanIntegrityKey); this.activationKey = Uint8Array.from(config.activationIntegrityKey);
    this.reviewKey = Uint8Array.from(config.reviewIntegrityKey);
    this.checkpoints = Object.freeze({ read: config.checkpoints.read.bind(config.checkpoints),
      initialize: config.checkpoints.initialize.bind(config.checkpoints), advance: config.checkpoints.advance.bind(config.checkpoints) });
    this.results = new NativeResultStore(db, this.harnessKey, { ...config.results,
      storage: Object.freeze({ read: config.results.storage.read.bind(config.results.storage) }) });
  }
  async inspectSubmitted(tx: DatabaseSession, tenantId: string, runId: string): Promise<SubmittedTaskResultInspectionV1> {
    const locked = await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, runId]);
    if (locked.rows.length !== 1) return unavailable();
    const inspected = await new HarnessRunStoreV1(joined(tx), this.harnessKey).inspect(tenantId, runId);
    if (!inspected || inspected.events.length || inspected.run.harness !== "codex" || inspected.run.state !== "discovered"
      || inspected.run.nativeTask || inspected.run.startedAt || inspected.run.finishedAt || inspected.run.resumable) return unavailable();
    const row = (await tx.query<PublicationRow>("SELECT * FROM control_codex_result_publications WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, runId])).rows[0];
    if (!row) return unavailable();
    const record = codexCanonicalResultRecordSchemaV1.parse(row.record), expected = Buffer.from(hmacSha256Tag(this.resultKey,
      { purpose: "codex-canonical-result-record/v1", record })), actual = Buffer.from(row.auth_tag), identity = record.publication.identity;
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || row.tenant_id !== identity.tenantId
      || row.project_id !== identity.projectId || row.job_id !== identity.jobId || row.attempt_id !== identity.attemptId
      || row.run_id !== identity.runId || row.publication_id !== record.publication.publicationId
      || row.record_digest !== record.recordDigest || new Date(row.recorded_at).toISOString() !== record.recordedAt) return unavailable();
    const taskPlan = await readCodexTaskExecutionPlanV3InSession(tx, this.taskPlanKey, tenantId, identity.jobId);
    if (!taskPlan || sha256Digest(taskPlan) !== record.taskPlanDigest) return unavailable();
    const activation = await readCodexActivationTransmissionIntentInSession(tx, this.activationKey, {
      tenantId, projectId: identity.projectId, jobId: identity.jobId, attemptId: identity.attemptId,
      inputDigest: taskPlan.job.inputDigest });
    if (!activation || sha256Digest(activation) !== record.activationIntentRecordDigest
      || activation.frame.body.runId !== runId || activation.currentAdmission.leaseId !== identity.leaseId
      || activation.currentAdmission.leaseEpoch !== identity.leaseEpoch || activation.currentAdmission.nodeId !== identity.nodeId) return unavailable();
    const jobRow = (await tx.query<{ payload: unknown }>("SELECT payload FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
      [tenantId, identity.projectId, identity.jobId])).rows[0];
    const job = jobRecordSchema.parse(jobRow?.payload);
    if (job.tenantId !== tenantId || job.projectId !== identity.projectId || job.id !== identity.jobId
      || job.inputDigest !== taskPlan.job.inputDigest) return unavailable();
    const plan = await readCodexReviewPlanV1(tx, this.reviewKey, tenantId, identity.projectId, identity.jobId);
    if (!plan || plan.runId !== runId || plan.taskPlanDigest !== record.taskPlanDigest
      || plan.activationIntentRecordDigest !== record.activationIntentRecordDigest) return unavailable();
    const gate = new CompletionGateStoreV1(joined(tx), this.reviewKey, this.checkpoints);
    const profile = completionAcceptanceProfileSchemaV1.parse(await gate.getRecord(tenantId, plan.acceptanceProfileId, "profile"));
    if (sha256Digest(profile) !== plan.acceptanceProfileDigest || profile.projectId !== identity.projectId) return unavailable();
    const result = await this.results.read(tx, tenantId, identity.projectId, identity.jobId, nativeResultId(tenantId, runId));
    if (!result || result.receipt.schema !== "control-room.codex-result-receipt/v1") return unavailable();
    const snapshot = await gate.snapshot(tenantId, plan.targetId);
    if (sha256Digest(snapshot.target) !== sha256Digest(codexReviewTargetV1(plan, result.receipt))) return unavailable();
    const startedAt = activation.frame.body.activatedAt, completedAt = record.terminalEvidence.observedAt;
    // The inert Codex harness anchor is intentionally created when the result is received, after
    // the real start/finish evidence. Bind that anchor exactly instead of treating it as run start.
    if (inspected.run.createdAt !== result.receipt.receivedAt || Date.parse(completedAt) < Date.parse(startedAt)
      || Date.parse(result.receipt.receivedAt) < Date.parse(completedAt)) return unavailable();
    return { ...inspected, job, profile, result, snapshot, gate,
      execution: { leaseId: identity.leaseId, leaseEpoch: identity.leaseEpoch, startedAt, completedAt,
        completedBefore: activation.frame.expiresAt } };
  }
}
