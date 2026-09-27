import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { jobRecordSchema } from "../../domain/v1";
import type { NativeResultReadConfiguration } from "../../artifacts/v1/native-results";
import { CompletionGateStoreV1, type CompletionAcceptanceProfileV1, type CompletionReviewV1,
  type CompletionVerificationV1, type CompletionRiskV1 } from "../../completion-gate/v1";
import { stageAsyncCompletionCheckpoint } from "../../completion-gate/v1/async-staged-checkpoint";
import { readTaskReviewPlanV1, verifyTaskReviewTargetV1 } from "../../completion-gate/v1/task-review-plan";
import { assertNoSecretMaterial, computeAuthorityDigest, sha256Digest, type AwaitableRollbackCheckpointStoreV1 } from "../../security";
import { appendAuditWith } from "../../audit/audit-store";
import { WebSessionAuthority, type WebActor } from "./session-authority";
import { WebProjectService } from "./project-service";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { PlanSelectedTaskResultReaderV1 } from "./task-result-reader";
import { catalogProjectIdSchema as id } from "./project-wire";
import { READ_CORRECT_ATTESTATION_NOTE_V1, taskVerificationDraftSchema,
  taskVerificationOptionsSchema, taskVerificationReceiptSchema } from "./task-verification-wire";

export const manualVerificationScenarioSchema = z.object({ scenarioId: id, label: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(2000), acceptanceProfileId: id,
  acceptanceProfileDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  recordingMode: z.literal("read_correct_attestation").optional() }).strict();
export type ManualVerificationScenario = z.infer<typeof manualVerificationScenarioSchema>;
export type ManualVerificationScenarioSource = Readonly<{ list(): readonly ManualVerificationScenario[] }>;
export const MAX_MANUAL_VERIFICATION_DESCRIPTORS_V1 = 100 as const;
export function manualVerificationScenarioInstructionsDigestV1(value: ManualVerificationScenario): string {
  const scenario = manualVerificationScenarioSchema.parse(value);
  const { recordingMode: _, ...originalDescriptor } = scenario;
  return sha256Digest(originalDescriptor);
}
export interface WebTaskVerificationConfiguration {
  integrityKey: Uint8Array; harnessIntegrityKey: Uint8Array; checkpoints: AwaitableRollbackCheckpointStoreV1;
  results: NativeResultReadConfiguration; ideaIntegrityKey?: Uint8Array;
  manualVerificationScenarios: readonly ManualVerificationScenario[] | ManualVerificationScenarioSource;
}
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
const risks: CompletionRiskV1[] = ["low", "medium", "high", "critical"];

/** Optional human evidence for explicitly configured scenarios, not an automated verifier or finish command. */
export class WebTaskVerificationService {
  private readonly key: Uint8Array;
  private readonly checkpoints: AwaitableRollbackCheckpointStoreV1;
  private readonly descriptorSource: () => readonly ManualVerificationScenario[];
  private readonly results: PlanSelectedTaskResultReaderV1;
  private readonly projects: WebProjectService;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    config: WebTaskVerificationConfiguration, private readonly clock: () => number = Date.now) {
    if (!(config.integrityKey instanceof Uint8Array) || config.integrityKey.length !== 32) throw new Error("verification_configuration_invalid");
    this.key = Uint8Array.from(config.integrityKey);
    const source = Array.isArray(config.manualVerificationScenarios)
      ? () => config.manualVerificationScenarios as readonly ManualVerificationScenario[]
      : () => (config.manualVerificationScenarios as ManualVerificationScenarioSource).list();
    this.descriptorSource = () => {
      const descriptors = z.array(manualVerificationScenarioSchema).max(MAX_MANUAL_VERIFICATION_DESCRIPTORS_V1).parse(source());
      assertNoSecretMaterial(descriptors);
      if (new Set(descriptors.map(value => JSON.stringify([value.acceptanceProfileId, value.acceptanceProfileDigest, value.scenarioId]))).size !== descriptors.length)
        throw new Error("verification_configuration_invalid");
      return descriptors;
    };
    this.descriptorSource();
    this.checkpoints = Object.freeze({ read: config.checkpoints.read.bind(config.checkpoints), advance: config.checkpoints.advance.bind(config.checkpoints),
      initialize: () => { throw new Error("verification_provisioning_unavailable"); } });
    this.results = new PlanSelectedTaskResultReaderV1(db, { harnessIntegrityKey: config.harnessIntegrityKey,
      results: config.results, reviewIntegrityKey: config.integrityKey });
    this.projects = new WebProjectService(db, scope, clock, config.ideaIntegrityKey);
  }
  private ids(...values: string[]) { if (values.some(value => !id.safeParse(value).success)) throw new WebAccessError("invalid_request"); }
  private gate(tx: DatabaseSession, checkpoints = this.checkpoints) { return new CompletionGateStoreV1(joined(tx), this.key, checkpoints); }
  private recordId(actor: WebActor, targetId: string, scenarioId: string) {
    return `verification:owner:${sha256Digest({ tenantId: this.scope.tenantId, actorId: actor.id, targetId, scenarioId }).slice(7)}`;
  }
  private async context(tx: DatabaseSession, actor: WebActor, projectId: string, jobId: string, artifactId: string, targetId: string,
    gate = this.gate(tx)) {
    actor.require("tasks.read", projectId); actor.require("tasks.results.read", projectId);
    const project = await this.projects.getViewInSession(tx, actor, projectId);
    const row = (await tx.query<{ payload: unknown; state: string; version: number }>(
      "SELECT payload,state,version FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3",
      [this.scope.tenantId, projectId, jobId])).rows[0];
    if (!row) throw new WebAccessError("not_found");
    const job = jobRecordSchema.parse(row.payload);
    if (job.tenantId !== this.scope.tenantId || job.projectId !== projectId || job.id !== jobId || job.state !== row.state
      || job.version !== Number(row.version) || job.authority.projectId !== projectId || computeAuthorityDigest(job.authority) !== job.authority.digest)
      throw new Error("verification_task_unavailable");
    const snapshot = await gate.snapshot(this.scope.tenantId, targetId), target = snapshot.target;
    if (target.projectId !== projectId || target.kind !== "document") throw new WebAccessError("not_found");
    const profile = await gate.getRecord(this.scope.tenantId, target.acceptanceProfileId, "profile") as CompletionAcceptanceProfileV1;
    const result = await this.results.read(tx, this.scope.tenantId, projectId, jobId, artifactId);
    if (!result || result.receipt.contentHash !== target.subjectDigest || result.receipt.nodeId !== target.producer.actorId
      || target.producer.actorType !== "agent") throw new WebAccessError("conflict");
    const lineage = await readTaskReviewPlanV1(tx, this.key, this.scope.tenantId, projectId, jobId);
    verifyTaskReviewTargetV1(lineage, target, result.receipt);
    const descriptors = this.descriptorSource().filter(value => value.acceptanceProfileId === profile.id
      && value.acceptanceProfileDigest === sha256Digest(profile) && profile.requiredVerificationScenarioIds.includes(value.scenarioId));
    const acceptedReviews: CompletionReviewV1[] = [];
    for (const reviewId of snapshot.acceptedReviewIds) {
      const review = await gate.getRecord(this.scope.tenantId, reviewId, "review") as CompletionReviewV1 | undefined;
      if (!review || review.targetId !== target.id || review.targetDigest !== snapshot.targetDigest
        || review.authority !== "completion_gate" || review.decision !== "accepted") throw new Error("verification_history_unavailable");
      acceptedReviews.push(review);
    }
    const ownAcceptedReview = acceptedReviews.some(review => review.reviewer.actorType === "human" && review.reviewer.actorId === actor.id);
    return { project, snapshot, profile, result, descriptors, gate, ownAcceptedReview,
      risk: risks[Math.max(risks.indexOf(profile.minimumRisk), risks.indexOf(job.authority.maxRisk))] };
  }
  private availability(actor: WebActor, context: Awaited<ReturnType<WebTaskVerificationService["context"]>>, prior: boolean,
    descriptor: ManualVerificationScenario) {
    if (!actor.can("tasks.reviews.record", context.project.projectId, true, context.risk)) return "access_denied" as const;
    if (prior) return "already_recorded" as const;
    if (context.project.lifecycle !== "active") return "project_inactive" as const;
    if (descriptor.recordingMode === "read_correct_attestation" && !context.ownAcceptedReview) return "target_closed" as const;
    if (!["pending", "verification_blocked"].includes(context.snapshot.status)) return "target_closed" as const;
    if (context.profile.verificationRequiresProducerSeparation && actor.id === context.snapshot.target.producer.actorId) return "independence_required" as const;
    return "available" as const;
  }
  private async prior(actor: WebActor, context: Awaited<ReturnType<WebTaskVerificationService["context"]>>, descriptor: ManualVerificationScenario) {
    const recordId = this.recordId(actor, context.snapshot.target.id, descriptor.scenarioId);
    const value = await context.gate.getRecord(this.scope.tenantId, recordId, "verification") as CompletionVerificationV1 | undefined;
    if (value && (value.id !== recordId || value.tenantId !== this.scope.tenantId || value.projectId !== context.project.projectId
      || value.targetId !== context.snapshot.target.id || value.targetDigest !== context.snapshot.targetDigest
      || value.acceptanceProfileId !== context.profile.id || value.acceptanceProfileDigest !== sha256Digest(context.profile)
      || value.scenarioId !== descriptor.scenarioId || value.verifier.actorType !== "human" || value.verifier.actorId !== actor.id
      || !value.evidenceDigests.includes(manualVerificationScenarioInstructionsDigestV1(descriptor))
      || !value.evidenceDigests.includes(context.result.receipt.contentHash)))
      throw new Error("verification_history_unavailable");
    return value;
  }
  async options(identity: VerifiedWebIdentity, projectId: string, jobId: string, artifactId: string, targetId: string) {
    this.ids(projectId, jobId, artifactId, targetId);
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      const context = await this.context(tx, actor, projectId, jobId, artifactId, targetId);
      const binding = { projectId, jobId, artifactId, targetId, targetDigest: context.snapshot.targetDigest, contentHash: context.result.receipt.contentHash };
      const scenarios = [];
      for (const descriptor of context.descriptors) {
        const prior = await this.prior(actor, context, descriptor);
        scenarios.push({ scenarioId: descriptor.scenarioId, label: descriptor.label, instructions: descriptor.instructions,
          instructionsDigest: manualVerificationScenarioInstructionsDigestV1(descriptor), availability: this.availability(actor, context, !!prior, descriptor),
          ...(descriptor.recordingMode ? { recordingMode: descriptor.recordingMode } : {}),
          ownVerification: prior ? { ...binding, scenarioId: descriptor.scenarioId,
            instructionsDigest: manualVerificationScenarioInstructionsDigestV1(descriptor),
            outcome: prior.outcome, verificationId: prior.id, recordedAt: prior.verifiedAt, grantsApproval: false,
            grantsExecutionAuthority: false, completesJob: false } : null });
      }
      return taskVerificationOptionsSchema.parse({ ...binding, scenarios, source: scenarios.length ? "configured" : "not_configured", grantsExecutionAuthority: false });
    });
  }
  async record(identity: VerifiedWebIdentity, projectId: string, jobId: string, input: unknown) {
    this.ids(projectId, jobId); const parsed = taskVerificationDraftSchema.safeParse(input);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    const draft = parsed.data; try { assertNoSecretMaterial(draft); } catch { throw new WebAccessError("invalid_request"); }
    const staged = stageAsyncCompletionCheckpoint(this.checkpoints, this.scope.tenantId);
    const guarded: DatabaseClient = { query: this.db.query.bind(this.db), transaction: this.db.transaction.bind(this.db),
      transactionWithPreCommitCheck: (work, check) => this.db.transactionWithPreCommitCheck(work, async () => { await check(); await staged.flush(check); await check(); }) };
    return new WebSessionAuthority(guarded, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      const context = await this.context(tx, actor, projectId, jobId, draft.artifactId, draft.targetId, this.gate(tx, staged.checkpoints));
      actor.require("tasks.reviews.record", projectId, true, context.risk);
      const descriptor = context.descriptors.find(value => value.scenarioId === draft.scenarioId);
      if (!descriptor || manualVerificationScenarioInstructionsDigestV1(descriptor) !== draft.instructionsDigest
        || draft.targetDigest !== context.snapshot.targetDigest
        || draft.contentHash !== context.result.receipt.contentHash) throw new WebAccessError("conflict");
      if (descriptor.recordingMode === "read_correct_attestation"
        && (draft.outcome !== "passed" || draft.note !== READ_CORRECT_ATTESTATION_NOTE_V1)) throw new WebAccessError("invalid_request");
      const requestDigest = sha256Digest({ action: "tasks.verifications.record", ...this.scope, actorId: actor.id, projectId, jobId, draft });
      const noteDigest = sha256Digest(draft.note), evidenceDigests = [...new Set([draft.contentHash, draft.instructionsDigest, noteDigest, requestDigest])].sort();
      const prior = await this.prior(actor, context, descriptor);
      if (prior && (prior.outcome !== draft.outcome || sha256Digest(prior.evidenceDigests) !== sha256Digest(evidenceDigests))) throw new WebAccessError("conflict");
      if (!prior && this.availability(actor, context, false, descriptor) !== "available") throw new WebAccessError("conflict");
      const verification: CompletionVerificationV1 = prior ?? { schemaVersion: "control-room-completion-gate/v1",
        id: this.recordId(actor, draft.targetId, draft.scenarioId), tenantId: this.scope.tenantId, projectId,
        targetId: draft.targetId, targetDigest: draft.targetDigest, acceptanceProfileId: context.profile.id,
        acceptanceProfileDigest: sha256Digest(context.profile), scenarioId: draft.scenarioId, outcome: draft.outcome,
        verifier: { actorId: actor.id, actorType: "human" }, evidenceDigests, verifiedAt: actor.now, grantsApproval: false, grantsExecutionAuthority: false };
      if (!prior) {
        await context.gate.recordVerification(verification);
        await appendAuditWith(tx, { id: `audit:${verification.id}`, tenantId: this.scope.tenantId, projectId,
          actorId: actor.id, actorType: "human", action: "tasks.verifications.record", targetType: "completion_verification",
          targetId: verification.id, occurredAt: actor.now, idempotencyKey: requestDigest,
          safeMetadata: { scenarioId: draft.scenarioId, targetDigest: draft.targetDigest, outcome: draft.outcome, noteDigest } });
      }
      return { receipt: taskVerificationReceiptSchema.parse({ projectId, jobId, artifactId: draft.artifactId,
        targetId: draft.targetId, targetDigest: draft.targetDigest, contentHash: draft.contentHash,
        scenarioId: draft.scenarioId, instructionsDigest: draft.instructionsDigest, outcome: verification.outcome,
        noteDigest, verificationId: verification.id, recordedAt: verification.verifiedAt,
        grantsApproval: false, grantsExecutionAuthority: false, completesJob: false }), replayed: !!prior };
    });
  }
}
