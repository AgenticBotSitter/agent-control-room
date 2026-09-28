import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { jobRecordSchema } from "../../domain/v1";
import type { NativeResultReadConfiguration } from "../../artifacts/v1/native-results";
import { CompletionGateStoreV1, CompletionGateErrorV1, type CompletionAcceptanceProfileV1, type CompletionReviewV1,
  type CompletionFindingV1, type CompletionRiskV1, type CompletionVerificationV1 } from "../../completion-gate/v1";
import { assertReviewerIndependentV1 } from "../../completion-gate/v1/reviewer-independence";
import { stageAsyncCompletionCheckpoint } from "../../completion-gate/v1/async-staged-checkpoint";
import { readTaskReviewPlanV1, verifyTaskReviewTargetV1 } from "../../completion-gate/v1/task-review-plan";
import { assertNoSecretMaterial, computeAuthorityDigest, hmacSha256Tag, sha256Digest } from "../../security";
import type { AwaitableRollbackCheckpointStoreV1 } from "../../security/rollback-checkpoint";
import { appendAuditWith } from "../../audit/audit-store";
import { WebSessionAuthority, type WebActor } from "./session-authority";
import { WebProjectService } from "./project-service";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { PlanSelectedTaskResultReaderV1 } from "./task-result-reader";
import { catalogProjectIdSchema } from "./project-wire";
import { taskReviewDraftSchema, taskReviewReceiptSchema, taskReviewNoteSchema, taskReviewOptionsSchema,
  type TaskReviewDraft, type TaskReviewReceipt } from "./task-review-wire";
import { manualVerificationScenarioInstructionsDigestV1, manualVerificationScenarioSchema, MAX_MANUAL_VERIFICATION_DESCRIPTORS_V1,
  type ManualVerificationScenario, type ManualVerificationScenarioSource } from "./task-verification-service";

export interface WebTaskReviewConfiguration { integrityKey: Uint8Array; checkpoints: AwaitableRollbackCheckpointStoreV1;
  acceptanceVerificationScenarios?: readonly ManualVerificationScenario[] | ManualVerificationScenarioSource }
type Row = { tenant_id: string; identity_id: string; idempotency_key: string; project_id: string; job_id: string;
  artifact_id: string; target_id: string; review_id: string; request_digest: string; command: unknown;
  auth_tag: string; occurred_at: string | Date };
const commandSchema = z.object({ draft: taskReviewDraftSchema, receipt: taskReviewReceiptSchema }).strict();
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
const risks: CompletionRiskV1[] = ["low", "medium", "high", "critical"];

/** Owner quality decisions only. No acceptance policy bootstrap, effect approval, revision dispatch or agent port. */
export class WebTaskReviewService {
  private readonly integrityKey: Uint8Array;
  private readonly checkpoints: AwaitableRollbackCheckpointStoreV1;
  private readonly results: PlanSelectedTaskResultReaderV1;
  private readonly projects: WebProjectService;
  private readonly acceptanceVerificationScenarios?: () => readonly z.infer<typeof manualVerificationScenarioSchema>[];
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    config: WebTaskReviewConfiguration & { harnessIntegrityKey: Uint8Array; results: NativeResultReadConfiguration; ideaIntegrityKey?: Uint8Array },
    private readonly clock: () => number = Date.now) {
    if (!(config.integrityKey instanceof Uint8Array) || config.integrityKey.length !== 32) throw new Error("review_configuration_invalid");
    this.integrityKey = Uint8Array.from(config.integrityKey);
    this.checkpoints = Object.freeze({ read: config.checkpoints.read.bind(config.checkpoints),
      advance: config.checkpoints.advance.bind(config.checkpoints), initialize: () => { throw new Error("review_provisioning_unavailable"); } });
    this.results = new PlanSelectedTaskResultReaderV1(db, { harnessIntegrityKey: config.harnessIntegrityKey,
      results: config.results, reviewIntegrityKey: config.integrityKey });
    this.projects = new WebProjectService(db, scope, clock, config.ideaIntegrityKey);
    if (config.acceptanceVerificationScenarios) {
      const source = config.acceptanceVerificationScenarios;
      this.acceptanceVerificationScenarios = () => z.array(manualVerificationScenarioSchema).max(MAX_MANUAL_VERIFICATION_DESCRIPTORS_V1)
        .parse(Array.isArray(source) ? source : (source as ManualVerificationScenarioSource).list());
      this.acceptanceVerificationScenarios();
    }
  }
  private ids(...values: string[]) {
    if (values.some(value => !catalogProjectIdSchema.safeParse(value).success)) throw new WebAccessError("invalid_request");
  }
  private gate(tx: DatabaseSession, checkpoints = this.checkpoints) {
    return new CompletionGateStoreV1(joined(tx), this.integrityKey, checkpoints, () => new Date(this.clock()).toISOString());
  }
  private digest(actorId: string, projectId: string, jobId: string, draft: TaskReviewDraft) {
    return sha256Digest({ ...this.scope, actorId, projectId, jobId, action: "tasks.reviews.record", draft });
  }
  private verificationId(actorId: string, targetId: string, scenarioId: string) {
    return `verification:owner:${sha256Digest({ tenantId: this.scope.tenantId, actorId, targetId, scenarioId }).slice(7)}`;
  }
  private acceptanceAttestation(context: Awaited<ReturnType<WebTaskReviewService["context"]>>) {
    if (!this.acceptanceVerificationScenarios) return undefined;
    const matches = this.acceptanceVerificationScenarios().filter(value => value.acceptanceProfileId === context.profile.id
      && value.acceptanceProfileDigest === sha256Digest(context.profile)
      && context.snapshot.missingVerificationScenarioIds.includes(value.scenarioId));
    if (matches.length > 1) throw new Error("review_configuration_invalid");
    return matches[0];
  }
  private tag(row: Omit<Row, "auth_tag">) {
    return hmacSha256Tag(this.integrityKey, { purpose: "web-task-review-command/v1", ...row,
      occurred_at: new Date(row.occurred_at).toISOString() });
  }
  private async receipt(tx: DatabaseSession, actor: WebActor, row: Row) {
    const command = commandSchema.parse(row.command), receipt = command.receipt;
    assertNoSecretMaterial(command);
    const { auth_tag, ...material } = row;
    const expected = Buffer.from(this.tag(material)), actual = Buffer.from(auth_tag);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
      || row.tenant_id !== this.scope.tenantId || row.identity_id !== actor.id
      || receipt.projectId !== row.project_id || receipt.jobId !== row.job_id || receipt.artifactId !== row.artifact_id
      || receipt.targetId !== row.target_id || receipt.reviewId !== row.review_id
      || receipt.recordedAt !== new Date(row.occurred_at).toISOString()
      || row.request_digest !== this.digest(actor.id, row.project_id, row.job_id, command.draft)
      || receipt.artifactId !== command.draft.artifactId || receipt.targetId !== command.draft.targetId
      || receipt.targetDigest !== command.draft.targetDigest || receipt.contentHash !== command.draft.contentHash
      || receipt.decision !== command.draft.decision || receipt.feedbackDigest !== sha256Digest(command.draft.feedback))
      throw new Error("review_receipt_unavailable");
    const review = await this.gate(tx).getRecord(this.scope.tenantId, receipt.reviewId, "review") as CompletionReviewV1 | undefined;
    if (!review || review.reviewer.actorId !== actor.id || review.reviewer.actorType !== "human"
      || review.targetId !== receipt.targetId || review.targetDigest !== receipt.targetDigest || review.projectId !== receipt.projectId
      || review.decision !== receipt.decision || review.reviewedAt !== receipt.recordedAt || review.authority !== "completion_gate"
      || review.findingIds.join() !== (receipt.findingId ?? "")) throw new Error("review_receipt_unavailable");
    if (receipt.findingId) {
      const finding = await this.gate(tx).getRecord(this.scope.tenantId, receipt.findingId, "finding") as CompletionFindingV1 | undefined;
      if (!finding || finding.reviewId !== review.id || finding.statementDigest !== receipt.feedbackDigest) throw new Error("review_receipt_unavailable");
    }
    if (command.draft.acceptanceAttestation) {
      const verification = await this.gate(tx).getRecord(this.scope.tenantId,
        this.verificationId(actor.id, receipt.targetId, command.draft.acceptanceAttestation.scenarioId), "verification") as CompletionVerificationV1 | undefined;
      if (!verification || verification.targetId !== receipt.targetId || verification.targetDigest !== receipt.targetDigest
        || verification.verifier.actorId !== actor.id || verification.verifier.actorType !== "human"
        || verification.scenarioId !== command.draft.acceptanceAttestation.scenarioId || verification.outcome !== "passed")
        throw new Error("review_receipt_unavailable");
    }
    return command;
  }
  private async context(tx: DatabaseSession, actor: WebActor, projectId: string, jobId: string, artifactId: string,
    targetId: string, gate = this.gate(tx)) {
    actor.require("tasks.read", projectId); actor.require("tasks.results.read", projectId);
    const project = await this.projects.getViewInSession(tx, actor, projectId);
    const row = (await tx.query<{ id: string; project_id: string; workflow_id: string; state: string; version: number; payload: unknown }>(
      "SELECT id,project_id,workflow_id,state,version,payload FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3",
      [this.scope.tenantId, projectId, jobId])).rows[0];
    if (!row) throw new WebAccessError("not_found");
    const job = jobRecordSchema.parse(row.payload);
    if (job.id !== row.id || job.tenantId !== this.scope.tenantId || job.projectId !== row.project_id || job.workflowId !== row.workflow_id
      || job.state !== row.state || job.version !== Number(row.version) || job.authority.projectId !== projectId
      || job.authority.digest !== computeAuthorityDigest(job.authority))
      throw new Error("review_task_unavailable");
    const snapshot = await gate.snapshot(this.scope.tenantId, targetId);
    if (snapshot.target.projectId !== projectId || snapshot.target.kind !== "document")
      throw new WebAccessError("not_found");
    const profile = await gate.getRecord(this.scope.tenantId, snapshot.target.acceptanceProfileId, "profile") as CompletionAcceptanceProfileV1;
    const lineage = await readTaskReviewPlanV1(tx, this.integrityKey, this.scope.tenantId, projectId, jobId);
    const result = await this.results.read(tx, this.scope.tenantId, projectId, jobId, artifactId);
    if (!result || result.receipt.contentHash !== snapshot.target.subjectDigest
      || result.receipt.nodeId !== snapshot.target.producer.actorId || snapshot.target.producer.actorType !== "agent")
      throw new WebAccessError("conflict");
    verifyTaskReviewTargetV1(lineage, snapshot.target, result.receipt);
    const risk = risks[Math.max(risks.indexOf(profile.minimumRisk), risks.indexOf(job.authority.maxRisk))];
    const ownRecordedReview = (await tx.query(`SELECT id FROM control_completion_gate_records WHERE tenant_id=$1 AND project_id=$2
      AND kind='review' AND parent_id=$3 AND payload->'reviewer'->>'actorId'=$4 AND payload->>'authority'='completion_gate'`,
      [this.scope.tenantId, projectId, targetId, actor.id])).rows.length > 0;
    return { project, snapshot, profile, risk, result, ownRecordedReview };
  }
  private availability(actor: WebActor, context: Awaited<ReturnType<WebTaskReviewService["context"]>>, already: boolean) {
    if (!actor.can("tasks.reviews.record", context.project.projectId, true, context.risk)) return "access_denied" as const;
    if (already || context.ownRecordedReview) return "already_reviewed" as const;
    if (context.project.lifecycle !== "active") return "project_inactive" as const;
    if (!["pending", "verification_blocked"].includes(context.snapshot.status)) return "target_closed" as const;
    try {
      assertReviewerIndependentV1(context.snapshot.target.producer, { actorId: actor.id, actorType: "human" },
        context.profile.reviewerSeparation);
    } catch { return "independence_required" as const; }
    return "available" as const;
  }
  async options(identity: VerifiedWebIdentity, projectId: string, jobId: string, artifactId: string, targetId: string) {
    this.ids(projectId, jobId, artifactId, targetId);
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      const context = await this.context(tx, actor, projectId, jobId, artifactId, targetId);
      const row = (await tx.query<Row>(`SELECT * FROM control_web_task_review_commands WHERE tenant_id=$1 AND identity_id=$2
        AND project_id=$3 AND job_id=$4 AND target_id=$5`, [this.scope.tenantId, actor.id, projectId, jobId, targetId])).rows[0];
      const prior = row ? await this.receipt(tx, actor, row) : undefined;
      const availability = this.availability(actor, context, !!prior);
      const attestation = this.acceptanceAttestation(context);
      return taskReviewOptionsSchema.parse({ projectId, jobId, artifactId, targetId, targetDigest: context.snapshot.targetDigest,
        contentHash: context.result.receipt.contentHash, canReview: availability === "available", availability,
        ownReview: prior ? taskReviewNoteSchema.parse({ reviewId: prior.receipt.reviewId, findingId: prior.receipt.findingId,
          artifactId: prior.receipt.artifactId, targetId: prior.receipt.targetId, decision: prior.receipt.decision,
          contentHash: prior.receipt.contentHash, targetDigest: prior.receipt.targetDigest,
          recordedAt: prior.receipt.recordedAt, feedback: prior.draft.feedback }) : null,
        acceptanceAttestation: attestation ? { scenarioId: attestation.scenarioId, label: attestation.label,
          instructions: attestation.instructions, instructionsDigest: manualVerificationScenarioInstructionsDigestV1(attestation) } : null,
        grantsExecutionAuthority: false });
    });
  }
  async record(identity: VerifiedWebIdentity, projectId: string, jobId: string, value: unknown, key: string) {
    this.ids(projectId, jobId); const parsed = taskReviewDraftSchema.safeParse(value);
    if (!parsed.success || !/^[A-Za-z0-9:_-]{12,180}$/.test(key)) throw new WebAccessError("invalid_request");
    const draft = parsed.data; try { assertNoSecretMaterial(draft); } catch { throw new WebAccessError("invalid_request"); }
    const staged = stageAsyncCompletionCheckpoint(this.checkpoints, this.scope.tenantId);
    // Wrap the existing final session/grant check, not the SQL callback. No external anchor changes
    // until all ordinary writes and authorization checks have succeeded.
    const guarded: DatabaseClient = { query: this.db.query.bind(this.db), transaction: this.db.transaction.bind(this.db),
      transactionWithPreCommitCheck: (work, check) => this.db.transactionWithPreCommitCheck(work, async () => { await check(); await staged.flush(check); await check(); }) };
    return new WebSessionAuthority(guarded, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      // Canonical write order: parent tenant before completion-gate and child rows.
      // The later review-command INSERT takes this same FK key-share implicitly;
      // acquiring it now prevents a tenant -> gate / gate -> tenant deadlock.
      const tenant = await tx.query("SELECT id FROM tenants WHERE id=$1 FOR KEY SHARE", [this.scope.tenantId]);
      if (tenant.rows.length !== 1) throw new Error("review_task_unavailable");
      const context = await this.context(tx, actor, projectId, jobId, draft.artifactId, draft.targetId, this.gate(tx, staged.checkpoints));
      actor.require("tasks.reviews.record", projectId, true, context.risk);
      const digest = this.digest(actor.id, projectId, jobId, draft);
      const prior = (await tx.query<Row>(`SELECT * FROM control_web_task_review_commands
        WHERE tenant_id=$1 AND identity_id=$2 AND idempotency_key=$3`, [this.scope.tenantId, actor.id, key])).rows[0];
      if (prior) {
        if (prior.request_digest !== digest || prior.project_id !== projectId || prior.job_id !== jobId) throw new WebAccessError("conflict");
        return { receipt: (await this.receipt(tx, actor, prior)).receipt, replayed: true };
      }
      if (this.availability(actor, context, false) !== "available" || context.snapshot.targetDigest !== draft.targetDigest
        || context.result.receipt.contentHash !== draft.contentHash) throw new WebAccessError("conflict");
      const attestation = this.acceptanceAttestation(context);
      if (draft.decision === "accepted" && (!!attestation !== !!draft.acceptanceAttestation
        || attestation && (draft.acceptanceAttestation?.scenarioId !== attestation.scenarioId
          || draft.acceptanceAttestation.instructionsDigest !== manualVerificationScenarioInstructionsDigestV1(attestation)))) throw new WebAccessError("conflict");
      const existing = (await tx.query("SELECT review_id FROM control_web_task_review_commands WHERE tenant_id=$1 AND identity_id=$2 AND target_id=$3",
        [this.scope.tenantId, actor.id, draft.targetId])).rows;
      if (existing.length) throw new WebAccessError("conflict");
      const reviewId = `review:${randomUUID()}`, findingId = draft.decision === "changes_requested" ? `finding:${randomUUID()}` : null;
      const feedbackDigest = sha256Digest(draft.feedback), schemaVersion = "control-room-completion-gate/v1" as const;
      const review: CompletionReviewV1 = { schemaVersion, id: reviewId, tenantId: this.scope.tenantId, projectId,
        targetId: draft.targetId, targetDigest: draft.targetDigest, acceptanceProfileId: context.profile.id,
        acceptanceProfileDigest: sha256Digest(context.profile), reviewer: { actorId: actor.id, actorType: "human" },
        authority: "completion_gate", decision: draft.decision, assessedRisk: context.risk, effectiveRisk: context.risk,
        evidenceDigests: [...new Set([draft.contentHash, feedbackDigest])].sort(), findingIds: findingId ? [findingId] : [],
        reviewedAt: actor.now, grantsApproval: false, grantsExecutionAuthority: false };
      const findings: CompletionFindingV1[] = findingId ? [{ schemaVersion, id: findingId, tenantId: this.scope.tenantId, projectId,
        targetId: draft.targetId, targetDigest: draft.targetDigest, reviewId, code: "owner:changes_requested", severity: context.risk,
        statementDigest: feedbackDigest, evidenceDigests: [draft.contentHash], raisedAt: actor.now }] : [];
      try { await this.gate(tx, staged.checkpoints).recordReview(review, findings); }
      catch (error) {
        if (error instanceof CompletionGateErrorV1 && ["record_conflict", "reviewer_not_independent", "target_superseded", "profile_mismatch"].includes(error.safeCode))
          throw new WebAccessError("conflict");
        throw error;
      }
      if (attestation && draft.acceptanceAttestation) {
        const verification: CompletionVerificationV1 = { schemaVersion, id: this.verificationId(actor.id, draft.targetId, attestation.scenarioId),
          tenantId: this.scope.tenantId, projectId, targetId: draft.targetId, targetDigest: draft.targetDigest,
          acceptanceProfileId: context.profile.id, acceptanceProfileDigest: sha256Digest(context.profile), scenarioId: attestation.scenarioId,
          outcome: "passed", verifier: { actorId: actor.id, actorType: "human" },
          evidenceDigests: [...new Set([draft.contentHash, manualVerificationScenarioInstructionsDigestV1(attestation), digest])].sort(), verifiedAt: actor.now,
          grantsApproval: false, grantsExecutionAuthority: false };
        await this.gate(tx, staged.checkpoints).recordVerification(verification);
        await appendAuditWith(tx, { id: `audit:${randomUUID()}`, tenantId: this.scope.tenantId, projectId, actorId: actor.id,
          actorType: "human", action: "tasks.verifications.record", targetType: "completion_verification", targetId: verification.id,
          occurredAt: actor.now, idempotencyKey: digest, safeMetadata: { scenarioId: attestation.scenarioId,
            targetDigest: draft.targetDigest, outcome: "passed", source: "owner_acceptance_attestation" } });
      }
      const receipt: TaskReviewReceipt = { projectId, jobId, artifactId: draft.artifactId, targetId: draft.targetId,
        targetDigest: draft.targetDigest, contentHash: draft.contentHash, reviewId, findingId, decision: draft.decision,
        feedbackDigest, recordedAt: actor.now, grantsApproval: false, grantsExecutionAuthority: false, startsRevision: false };
      const row: Omit<Row, "auth_tag"> = { tenant_id: this.scope.tenantId, identity_id: actor.id, idempotency_key: key,
        project_id: projectId, job_id: jobId, artifact_id: draft.artifactId, target_id: draft.targetId, review_id: reviewId,
        request_digest: digest, command: { draft, receipt }, occurred_at: actor.now };
      await tx.query(`INSERT INTO control_web_task_review_commands(tenant_id,identity_id,idempotency_key,project_id,job_id,artifact_id,
        target_id,review_id,request_digest,command,auth_tag,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [this.scope.tenantId, actor.id, key, projectId, jobId, draft.artifactId, draft.targetId, reviewId, digest, JSON.stringify(row.command), this.tag(row), actor.now]);
      await appendAuditWith(tx, { id: `audit:${randomUUID()}`, tenantId: this.scope.tenantId, projectId, actorId: actor.id, actorType: "human",
        action: "tasks.reviews.record", targetType: "completion_review", targetId: reviewId, idempotencyKey: key, occurredAt: actor.now,
        safeMetadata: { targetDigest: draft.targetDigest, decision: draft.decision, feedbackDigest } });
      return { receipt, replayed: false };
    });
  }
}
