import { z } from "zod";
import { jobRecordSchema } from "../../domain/v1";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import { NativeResultStore, nativeResultId, type NativeResultReadConfiguration } from "../../artifacts/v1/native-results";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { assertNoSecretMaterial, computeAuthorityDigest, sha256Digest,
  type AwaitableRollbackCheckpointStoreV1 } from "../../security";
import { CompletionGateStoreV1 } from "./store";
import { completionAcceptanceProfileSchemaV1, completionReviewSchemaV1, completionFindingSchemaV1 } from "./schemas";
import { stageAsyncCompletionCheckpoint } from "./async-staged-checkpoint";
import { nativeRevisionContextSchema } from "./native-revision-context";
import { nativeReviewRequestSchema as requestSchema, nativeReviewPlanTag, verifyNativeReviewPlan,
  nativeReviewTarget, nativeReviewRevision, type NativeReviewPlan as Plan, type NativeReviewPlanRow as Row } from "./native-review-plan";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const revisionRequestSchema = requestSchema.extend({ revision: nativeRevisionContextSchema });
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
const reject = (): never => { throw new Error("native_review_submission_unavailable"); };

/** Trusted, explicitly injected control-plane composition. No public endpoint, dispatch, profile
 * provisioning or native effects. Register before progress; submission never accepts quality. */
export class NativeResultSubmissionService {
  private readonly key: Uint8Array;
  private readonly harnessKey: Uint8Array;
  private readonly results: NativeResultStore;
  constructor(private readonly db: DatabaseClient, config: { integrityKey: Uint8Array; harnessIntegrityKey: Uint8Array;
    checkpoints: AwaitableRollbackCheckpointStoreV1; results: NativeResultReadConfiguration }) {
    if (config.integrityKey.length !== 32 || config.harnessIntegrityKey.length !== 32) reject();
    this.key = Uint8Array.from(config.integrityKey); this.harnessKey = Uint8Array.from(config.harnessIntegrityKey);
    this.checkpoints = Object.freeze({ read: config.checkpoints.read.bind(config.checkpoints),
      advance: config.checkpoints.advance.bind(config.checkpoints), initialize: config.checkpoints.initialize.bind(config.checkpoints) });
    this.results = new NativeResultStore(db, this.harnessKey, { ...config.results,
      storage: { read: config.results.storage.read.bind(config.results.storage) } });
  }
  private readonly checkpoints: AwaitableRollbackCheckpointStoreV1;
  private tag(plan: Plan) { return nativeReviewPlanTag(this.key, plan); }
  private verify(row: Row) { return verifyNativeReviewPlan(this.key, row); }
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
    return profile;
  }
  /** Trusted transaction-only readback. Never creates a target or invents verification evidence. */
  async inspectSubmitted(tx: DatabaseSession, tenantId: string, runId: string) {
    id.parse(tenantId); id.parse(runId);
    const bound = await this.bound(tx, tenantId, runId), { run, job } = bound;
    const row = (await tx.query<Row>("SELECT * FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2", [tenantId, runId])).rows[0];
    if (!row) return reject();
    const plan = this.verify(row);
    if (plan.projectId !== run.projectId || plan.jobId !== job.id || plan.attemptId !== run.attemptId || plan.nodeId !== run.nodeId
      || plan.inputDigest !== job.inputDigest || plan.authorityDigest !== job.authority.digest
      || plan.bindingDigest !== run.nativeTask!.bindingDigest || run.state !== "succeeded") return reject();
    const gate = new CompletionGateStoreV1(joined(tx), this.key, this.checkpoints);
    const profile = await this.profile(gate, plan, run.projectId);
    const result = await this.results.read(tx, tenantId, run.projectId, job.id, nativeResultId(tenantId, runId));
    if (!result || result.receipt.runId !== runId || result.receipt.attemptId !== run.attemptId
      || result.receipt.nodeId !== run.nodeId || Date.parse(result.receipt.receivedAt) < Date.parse(plan.plannedAt)) return reject();
    const snapshot = await gate.snapshot(tenantId, plan.targetId), target = snapshot.target;
    const expected = nativeReviewTarget(plan, result.receipt);
    if (sha256Digest(target) !== sha256Digest(expected)) return reject();
    if (plan.schema === "control-room.native-review-plan/v2") {
      const revision = nativeReviewRevision(plan, expected);
      if (sha256Digest(await gate.getRecord(tenantId, revision.id, "revision")) !== sha256Digest(revision)) return reject();
    }
    return { ...bound, plan, profile, result, snapshot, gate };
  }
  /** Trusted planner only, with its already verified immutable execution revision context.
   * Independently bind predecessor evidence before accepting a new producing child run. */
  async registerRevision(input: z.infer<typeof revisionRequestSchema>) {
    try {
      const request = revisionRequestSchema.parse(input); assertNoSecretMaterial(request);
      return await this.db.transaction(async tx => {
        const { run, events, job } = await this.bound(tx, request.tenantId, request.runId);
        const plan: Extract<Plan, { schema: "control-room.native-review-plan/v2" }> = { ...request,
          schema: "control-room.native-review-plan/v2", projectId: run.projectId, jobId: run.jobId,
          attemptId: run.attemptId, nodeId: run.nodeId, inputDigest: job.inputDigest,
          authorityDigest: job.authority.digest, bindingDigest: run.nativeTask!.bindingDigest,
          targetId: `target:native:${sha256Digest({ tenantId: run.tenantId, jobId: run.jobId }).slice(7)}` };
        const gate = new CompletionGateStoreV1(joined(tx), this.key, this.checkpoints);
        const prior = (await tx.query<Row>("SELECT * FROM control_native_review_plans WHERE tenant_id=$1 AND job_id=$2",
          [run.tenantId, run.jobId])).rows[0];
        if (prior) {
          await this.profile(gate, request, run.projectId);
          if (sha256Digest(this.verify(prior)) !== sha256Digest(plan)) return reject();
          return { plan, replayed: true };
        }
        const r = request.revision;
        if (r.fromJobId === job.id || r.fromRunId === run.id || r.rootSubjectId === job.id
          || run.state !== "discovered" || events.length || Date.parse(request.plannedAt) < Date.parse(run.createdAt)
          || Date.parse(request.plannedAt) >= Date.parse(run.nativeTask!.deadline)) return reject();
        const source = await this.inspectSubmitted(tx, request.tenantId, r.fromRunId);
        // Native predecessor locks must precede the shared Completion Gate lock.
        const profile = await this.profile(gate, request, run.projectId);
        if (source.job.id !== r.fromJobId || source.run.projectId !== run.projectId
          || source.snapshot.target.subjectId !== r.rootSubjectId || source.snapshot.target.rootTargetId !== r.rootTargetId
          || source.snapshot.target.id !== r.fromTargetId || source.snapshot.targetDigest !== r.fromTargetDigest
          || source.result.receipt.contentHash !== r.fromContentHash || source.snapshot.status !== "changes_requested"
          || source.snapshot.revisionNumber + 1 !== r.revisionNumber || r.revisionNumber > profile.maximumRevisionRounds
          || source.profile.id !== profile.id || sha256Digest(source.profile) !== request.acceptanceProfileDigest
          || Date.parse(source.result.receipt.receivedAt) > Date.parse(request.plannedAt)
          || sha256Digest(source.snapshot.openFindingIds) !== sha256Digest(r.findingIds)) return reject();
        const review = completionReviewSchemaV1.parse(await gate.getRecord(run.tenantId, r.reviewId, "review"));
        if (sha256Digest(review) !== r.reviewDigest || review.targetId !== r.fromTargetId || review.targetDigest !== r.fromTargetDigest
          || review.projectId !== run.projectId || review.authority !== "completion_gate" || review.reviewer.actorType !== "human"
          || review.decision !== "changes_requested" || Date.parse(review.reviewedAt) > Date.parse(request.plannedAt)
          || sha256Digest([...review.findingIds].sort()) !== sha256Digest(r.findingIds)) return reject();
        for (const findingId of r.findingIds) {
          const finding = completionFindingSchemaV1.parse(await gate.getRecord(run.tenantId, findingId, "finding"));
          if (finding.reviewId !== r.reviewId || finding.targetId !== r.fromTargetId || finding.targetDigest !== r.fromTargetDigest
            || finding.statementDigest !== r.feedbackDigest) return reject();
        }
        await tx.query(`INSERT INTO control_native_review_plans(tenant_id,project_id,job_id,run_id,plan,auth_tag)
          VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [run.tenantId, run.projectId, run.jobId, run.id, JSON.stringify(plan), this.tag(plan)]);
        return { plan, replayed: false };
      });
    } catch { return reject(); }
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
      const staged = stageAsyncCompletionCheckpoint(this.checkpoints, tenantId);
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
        const target = nativeReviewTarget(plan, result.receipt);
        const registered = plan.schema === "control-room.native-review-plan/v2"
          ? await gate.recordRevision(nativeReviewRevision(plan, target), target) : await gate.registerTarget(target);
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
