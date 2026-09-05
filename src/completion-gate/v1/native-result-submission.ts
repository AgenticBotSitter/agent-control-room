import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { jobRecordSchema } from "../../domain/v1";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import { NativeResultStore, nativeResultId, type NativeResultReadConfiguration } from "../../artifacts/v1/native-results";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { assertNoSecretMaterial, computeAuthorityDigest, hmacSha256Tag, sha256Digest,
  type RollbackCheckpointStoreV1 } from "../../security";
import { CompletionGateStoreV1 } from "./store";
import { completionAcceptanceProfileSchemaV1 } from "./schemas";
import { stageCompletionCheckpoint } from "./staged-checkpoint";
import type { CompletionReviewTargetV1 } from "./types";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const requestSchema = z.object({ tenantId: id, runId: id, acceptanceProfileId: id,
  acceptanceProfileDigest: digest, plannedAt: instant }).strict();
const planSchema = requestSchema.extend({ schema: z.literal("control-room.native-review-plan/v1"),
  projectId: id, jobId: id, attemptId: id, nodeId: id, inputDigest: digest, authorityDigest: digest,
  bindingDigest: digest, targetId: id }).strict();
type Plan = z.infer<typeof planSchema>;
type Row = { tenant_id: string; project_id: string; job_id: string; run_id: string; plan: unknown; auth_tag: string };
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); check(); return result; } });
const reject = (): never => { throw new Error("native_review_submission_unavailable"); };

/** Trusted, explicitly injected control-plane composition. No public endpoint, dispatch, profile
 * provisioning or native effects. Register before progress; submission never accepts quality. */
export class NativeResultSubmissionService {
  private readonly key: Uint8Array;
  private readonly harnessKey: Uint8Array;
  private readonly results: NativeResultStore;
  constructor(private readonly db: DatabaseClient, config: { integrityKey: Uint8Array; harnessIntegrityKey: Uint8Array;
    checkpoints: RollbackCheckpointStoreV1; results: NativeResultReadConfiguration }) {
    if (config.integrityKey.length !== 32 || config.harnessIntegrityKey.length !== 32) reject();
    this.key = Uint8Array.from(config.integrityKey); this.harnessKey = Uint8Array.from(config.harnessIntegrityKey);
    this.checkpoints = Object.freeze({ read: config.checkpoints.read.bind(config.checkpoints),
      advance: config.checkpoints.advance.bind(config.checkpoints), initialize: config.checkpoints.initialize.bind(config.checkpoints) });
    this.results = new NativeResultStore(db, this.harnessKey, { ...config.results,
      storage: { read: config.results.storage.read.bind(config.results.storage) } });
  }
  private readonly checkpoints: RollbackCheckpointStoreV1;
  private tag(plan: Plan) { return hmacSha256Tag(this.key, { purpose: "native-review-plan/v1", plan }); }
  private verify(row: Row) {
    const plan = planSchema.parse(row.plan), expected = Buffer.from(this.tag(plan)), actual = Buffer.from(row.auth_tag);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || plan.tenantId !== row.tenant_id
      || plan.projectId !== row.project_id || plan.jobId !== row.job_id || plan.runId !== row.run_id) reject();
    return plan;
  }
  private async bound(tx: DatabaseSession, tenantId: string, runId: string) {
    await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, runId]);
    const inspected = await new HarnessRunStoreV1(joined(tx), this.harnessKey).inspect(tenantId, runId);
    if (!inspected?.run.nativeTask) return reject();
    const { run } = inspected;
    const row = (await tx.query<{ payload: unknown }>(`SELECT payload FROM control_jobs
      WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`, [tenantId, run.projectId, run.jobId])).rows[0];
    const job = jobRecordSchema.parse(row?.payload);
    if (job.tenantId !== tenantId || job.projectId !== run.projectId || job.id !== run.jobId
      || job.inputDigest !== run.nativeTask!.inputDigest || computeAuthorityDigest(job.authority) !== job.authority.digest) reject();
    return { ...inspected, job };
  }
  private async profile(gate: CompletionGateStoreV1, plan: z.infer<typeof requestSchema>, projectId: string) {
    const profile = completionAcceptanceProfileSchemaV1.parse(await gate.getRecord(plan.tenantId, plan.acceptanceProfileId, "profile"));
    if (profile.tenantId !== plan.tenantId || profile.projectId !== projectId || profile.targetKind !== "document"
      || sha256Digest(profile) !== plan.acceptanceProfileDigest || Date.parse(profile.createdAt) > Date.parse(plan.plannedAt)) reject();
  }
  /** Only the trusted planner may call this; possessing a signed node frame is not planning authority. */
  async register(input: z.infer<typeof requestSchema>) {
    try {
      const request = requestSchema.parse(input); assertNoSecretMaterial(request);
      return await this.db.transaction(async tx => {
        const { run, events, job } = await this.bound(tx, request.tenantId, request.runId);
        const plan: Plan = { ...request, schema: "control-room.native-review-plan/v1", projectId: run.projectId,
          jobId: run.jobId, attemptId: run.attemptId, nodeId: run.nodeId, inputDigest: job.inputDigest,
          authorityDigest: job.authority.digest, bindingDigest: run.nativeTask!.bindingDigest,
          targetId: `target:native:${sha256Digest({ tenantId: run.tenantId, jobId: run.jobId }).slice(7)}` };
        const gate = new CompletionGateStoreV1(joined(tx), this.key, this.checkpoints);
        await this.profile(gate, request, run.projectId);
        const prior = (await tx.query<Row>(`SELECT * FROM control_native_review_plans WHERE tenant_id=$1 AND job_id=$2`,
          [run.tenantId, run.jobId])).rows[0];
        if (prior) {
          if (sha256Digest(this.verify(prior)) !== sha256Digest(plan)) reject();
          return { plan, replayed: true };
        }
        if (run.state !== "discovered" || events.length || Date.parse(request.plannedAt) < Date.parse(run.createdAt)
          || Date.parse(request.plannedAt) >= Date.parse(run.nativeTask!.deadline)
          || (await gate.inspectSubject(run.tenantId, run.projectId, run.jobId)).targets.length) reject();
        await tx.query(`INSERT INTO control_native_review_plans(tenant_id,project_id,job_id,run_id,plan,auth_tag)
          VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [run.tenantId, run.projectId, run.jobId, run.id, JSON.stringify(plan), this.tag(plan)]);
        return { plan, replayed: false };
      });
    } catch { return reject(); }
  }
  /** Receipt/bytes are independently re-read, not trusted from the upload response. Capture may
   * already have committed if submission fails; callers must report uncertainty, not rerun a task. */
  async submit(tenantId: string, runId: string) {
    try {
      id.parse(tenantId); id.parse(runId);
      const staged = stageCompletionCheckpoint(this.checkpoints, tenantId);
      return await this.db.transactionWithPreCommitCheck(async tx => {
        const { run, job } = await this.bound(tx, tenantId, runId);
        const row = (await tx.query<Row>("SELECT * FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2", [tenantId, runId])).rows[0];
        if (!row) return reject();
        const plan = this.verify(row);
        if (plan.projectId !== run.projectId || plan.jobId !== job.id || plan.attemptId !== run.attemptId || plan.nodeId !== run.nodeId
          || plan.inputDigest !== job.inputDigest || plan.authorityDigest !== job.authority.digest
          || plan.bindingDigest !== run.nativeTask!.bindingDigest || run.state !== "succeeded") reject();
        const gate = new CompletionGateStoreV1(joined(tx), this.key, staged.checkpoints);
        await this.profile(gate, plan, run.projectId);
        const result = await this.results.read(tx, tenantId, run.projectId, job.id, nativeResultId(tenantId, runId));
        if (!result || result.receipt.runId !== runId || result.receipt.attemptId !== run.attemptId
          || result.receipt.nodeId !== run.nodeId || Date.parse(result.receipt.receivedAt) < Date.parse(plan.plannedAt)) return reject();
        const target: CompletionReviewTargetV1 = { schemaVersion: "control-room-completion-gate/v1", id: plan.targetId,
          tenantId, projectId: plan.projectId, kind: "document", subjectId: job.id, subjectDigest: result.receipt.contentHash,
          acceptanceProfileId: plan.acceptanceProfileId, acceptanceProfileDigest: plan.acceptanceProfileDigest,
          producer: { actorId: plan.nodeId, actorType: "agent" }, rootTargetId: plan.targetId, revisionNumber: 0,
          submittedAt: result.receipt.receivedAt };
        const registered = await gate.registerTarget(target);
        if (!registered.replayed) await appendAuditWith(tx, { id: `audit:submission:${sha256Digest({ tenantId, runId }).slice(7)}`,
          tenantId, projectId: plan.projectId, actorId: "service:native-result-submission", actorType: "service",
          action: "task.result.submitted_for_review", targetType: "artifact", targetId: result.receipt.artifactId,
          occurredAt: result.receipt.receivedAt, idempotencyKey: sha256Digest(plan),
          safeMetadata: { targetId: target.id, contentHash: target.subjectDigest, qualityAccepted: false } });
        return { ...registered, qualityAccepted: false as const };
      }, () => staged.flush());
    } catch { return reject(); }
  }
}
