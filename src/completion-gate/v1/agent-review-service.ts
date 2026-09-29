import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import type { AwaitableRollbackCheckpointStoreV1 } from "../../security/rollback-checkpoint";
import type { TaskAssignmentRoute } from "../../web/v1/task-assignment-coordinator";
import { deriveProtectedAgentPrincipalV1 } from "./protected-agent-principal";
import { assertReviewerIndependentV1, ReviewerIndependenceErrorV1 } from "./reviewer-independence";
import { completionAcceptanceProfileSchemaV1 } from "./schemas";
import { CompletionGateErrorV1, CompletionGateStoreV1 } from "./store";
import type { CompletionAcceptanceProfileV1, CompletionPrincipalV1, CompletionReviewTargetV1,
  CompletionReviewV1, CompletionFindingV1, CompletionRiskV1 } from "./types";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const createSchema = z.object({ projectId: id, pipelineRunId: id, producerJobId: id, reviewerJobId: id,
  reviewerRunId: id, targetId: id }).strict();
const recordSchema = z.object({ planId: id, decision: z.enum(["accepted", "changes_requested"]),
  assessedRisk: z.enum(["low", "medium", "high", "critical"]),
  evidenceDigests: z.array(digest).min(1).max(32), findingStatementDigest: digest.optional() }).strict()
  .superRefine((value, context) => {
    if ((value.decision === "changes_requested") !== !!value.findingStatementDigest)
      context.addIssue({ code: "custom", message: "finding binding invalid", path: ["findingStatementDigest"] });
  });

type StageRow = { project_id: string; pipeline_run_id: string; current_job_id: string; stage_ordinal: number;
  stage_kind: "check"; role: "checker"; worker_id: string; worker_kind: "codex" | "claude-code" | "hermes";
  node_id: string; selection_key: string; model: string; effort: "default" | "low" | "medium" | "high" | "xhigh" | "max";
  provider: string | null; profile: string | null; current_attempt_id: string | null; current_lease_id: string | null;
  state: string; max_loops: number; handoff_from_result_digest: string | null; signoff_review_id: string | null;
  started_at: string | Date | null; finished_at: string | Date | null; record_digest: string; auth_tag: string; version: number };
type PlanRow = { id: string; tenant_id: string; project_id: string; pipeline_run_id: string; producer_job_id: string;
  reviewer_job_id: string; reviewer_run_id: string; target_id: string; target_digest: string;
  acceptance_profile_id: string; acceptance_profile_digest: string; review_id: string; finding_id: string;
  reviewer: CompletionPrincipalV1; plan_digest: string; auth_tag: string; created_at: string | Date };
const riskOrder: CompletionRiskV1[] = ["low", "medium", "high", "critical"];

export class AgentReviewServiceV1 {
  readonly #key: Uint8Array;
  readonly #pipelineKey: Uint8Array;
  readonly #gate: CompletionGateStoreV1;
  constructor(private readonly db: DatabaseClient, private readonly tenantId: string, integrityKey: Uint8Array,
    checkpoints: AwaitableRollbackCheckpointStoreV1, private readonly routes: readonly TaskAssignmentRoute[],
    private readonly clock: () => string = () => new Date().toISOString(), pipelineIntegrityKey: Uint8Array = integrityKey) {
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32
      || !(pipelineIntegrityKey instanceof Uint8Array) || pipelineIntegrityKey.length !== 32 || !tenantId || !Array.isArray(routes))
      throw new Error("agent_review_configuration_invalid");
    this.#key = Uint8Array.from(integrityKey);
    this.#pipelineKey = Uint8Array.from(pipelineIntegrityKey);
    this.#gate = new CompletionGateStoreV1(db, this.#key, checkpoints, clock);
  }
  #material(row: Omit<PlanRow, "auth_tag" | "reviewer"> & { reviewer: CompletionPrincipalV1 }) {
    return { schema: "control-room.agent-review-plan/v1", id: row.id, tenantId: row.tenant_id,
      projectId: row.project_id, pipelineRunId: row.pipeline_run_id, producerJobId: row.producer_job_id,
      reviewerJobId: row.reviewer_job_id, reviewerRunId: row.reviewer_run_id, targetId: row.target_id,
      targetDigest: row.target_digest, acceptanceProfileId: row.acceptance_profile_id,
      acceptanceProfileDigest: row.acceptance_profile_digest, reviewId: row.review_id, findingId: row.finding_id,
      reviewer: row.reviewer, createdAt: new Date(row.created_at).toISOString(), grantsApproval: false,
      grantsExecutionAuthority: false } as const;
  }
  #verify(row: PlanRow) {
    const material = this.#material(row), digestValue = sha256Digest(material);
    const expected = Buffer.from(hmacSha256Tag(this.#key, { purpose: "agent-review-plan/v1", plan: material }));
    const actual = Buffer.from(row.auth_tag);
    if (row.tenant_id !== this.tenantId || row.plan_digest !== digestValue || expected.length !== actual.length
      || !timingSafeEqual(expected, actual)) throw new Error("agent_review_plan_unavailable");
    return material;
  }
  async createPlan(value: unknown) {
    const input = createSchema.parse(value);
    const target = await this.#gate.getRecord(this.tenantId, input.targetId, "target") as CompletionReviewTargetV1 | undefined;
    if (!target || target.projectId !== input.projectId || target.subjectId !== input.producerJobId)
      throw new Error("agent_review_plan_unavailable");
    const profile = await this.#gate.getRecord(this.tenantId, target.acceptanceProfileId, "profile") as CompletionAcceptanceProfileV1 | undefined;
    if (!profile) throw new Error("agent_review_plan_unavailable");
    const stage = (await this.db.query<StageRow>(`SELECT stage.project_id,stage.pipeline_run_id,stage.current_job_id,
      stage.stage_ordinal,stage.stage_kind,stage.role,stage.worker_id,stage.worker_kind,stage.node_id,stage.selection_key,
      stage.model,stage.effort,stage.provider,stage.profile,stage.current_attempt_id,stage.current_lease_id,stage.state,
      stage.max_loops,stage.handoff_from_result_digest,stage.signoff_review_id,stage.started_at,stage.finished_at,
      stage.record_digest,stage.auth_tag,stage.version FROM pipeline_stage_runs stage
      JOIN control_task_execution_plans execution ON execution.tenant_id=stage.tenant_id
        AND execution.project_id=stage.project_id AND execution.source_job_id=stage.current_job_id
      JOIN pipeline_stage_runs producer ON producer.tenant_id=stage.tenant_id
        AND producer.pipeline_run_id=stage.pipeline_run_id AND producer.stage_ordinal=stage.stage_ordinal-1
      JOIN control_task_execution_plans produced ON produced.tenant_id=producer.tenant_id
        AND produced.project_id=producer.project_id AND produced.source_job_id=producer.current_job_id
      JOIN control_harness_runs run ON run.tenant_id=stage.tenant_id AND run.id=$5 AND run.job_id=execution.job_id
        AND run.project_id=stage.project_id AND run.node_id=stage.node_id
      JOIN control_attempts attempt ON attempt.tenant_id=run.tenant_id AND attempt.id=run.attempt_id
        AND attempt.job_id=run.job_id AND attempt.node_id=run.node_id AND attempt.worker_id=stage.worker_id
      JOIN control_task_model_selections selected ON selected.tenant_id=stage.tenant_id AND selected.job_id=execution.job_id
        AND selected.project_id=stage.project_id
      WHERE stage.tenant_id=$1 AND stage.project_id=$2 AND stage.pipeline_run_id=$3
        AND execution.job_id=$4 AND produced.job_id=$6 AND stage.stage_kind='check' AND stage.role='checker'
        AND selected.worker_kind=stage.worker_kind AND selected.selection_key=stage.selection_key
        AND selected.model=stage.model AND selected.effort=stage.effort
        AND selected.provider IS NOT DISTINCT FROM stage.provider AND selected.profile IS NOT DISTINCT FROM stage.profile`,
    [this.tenantId, input.projectId, input.pipelineRunId, input.reviewerJobId, input.reviewerRunId, input.producerJobId])).rows[0];
    if (!stage) throw new Error("agent_review_plan_unavailable");
    const stageMaterial = { id: `${stage.pipeline_run_id}:stage:${Number(stage.stage_ordinal)}`, tenantId: this.tenantId,
      projectId: stage.project_id, pipelineRunId: stage.pipeline_run_id, stageOrdinal: Number(stage.stage_ordinal),
      stageKind: stage.stage_kind, role: stage.role, workerId: stage.worker_id, workerKind: stage.worker_kind,
      nodeId: stage.node_id, selectionKey: stage.selection_key, model: stage.model, effort: stage.effort,
      provider: stage.provider, profile: stage.profile, currentJobId: stage.current_job_id,
      currentAttemptId: stage.current_attempt_id, currentLeaseId: stage.current_lease_id, state: stage.state,
      maxLoops: Number(stage.max_loops), handoffFromResultDigest: stage.handoff_from_result_digest,
      signoffReviewId: stage.signoff_review_id, startedAt: stage.started_at ? new Date(stage.started_at).toISOString() : null,
      finishedAt: stage.finished_at ? new Date(stage.finished_at).toISOString() : null, version: Number(stage.version) };
    const expected = Buffer.from(hmacSha256Tag(this.#pipelineKey, { purpose: "pipeline-stage-run/v1", record: stageMaterial }));
    const actual = Buffer.from(stage.auth_tag);
    if (sha256Digest(stageMaterial) !== stage.record_digest || expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new Error("agent_review_plan_unavailable");
    const route = this.routes.find(item => item.nodeId === stage.node_id);
    if (!route) throw new Error("agent_review_plan_unavailable");
    const reviewer = deriveProtectedAgentPrincipalV1(route, { workerId: stage.worker_id, workerKind: stage.worker_kind,
      nodeId: stage.node_id, selectionKey: stage.selection_key, model: stage.model, provider: stage.provider, profile: stage.profile });
    try { assertReviewerIndependentV1(target.producer, reviewer, profile.reviewerSeparation); }
    catch (error) {
      throw new CompletionGateErrorV1(error instanceof ReviewerIndependenceErrorV1 ? error.safeCode : "reviewer_not_independent");
    }
    const targetDigest = sha256Digest(target), acceptanceProfileDigest = sha256Digest(profile), now = this.clock();
    const partial: Omit<PlanRow, "auth_tag" | "plan_digest"> = { id: `agent-review-plan:${randomUUID()}`,
      tenant_id: this.tenantId, project_id: input.projectId, pipeline_run_id: input.pipelineRunId,
      producer_job_id: input.producerJobId, reviewer_job_id: input.reviewerJobId, reviewer_run_id: input.reviewerRunId,
      target_id: input.targetId, target_digest: targetDigest, acceptance_profile_id: profile.id,
      acceptance_profile_digest: acceptanceProfileDigest, review_id: `review:${randomUUID()}`,
      finding_id: `finding:${randomUUID()}`, reviewer, created_at: now };
    const material = this.#material({ ...partial, plan_digest: "" }), planDigest = sha256Digest(material),
      authTag = hmacSha256Tag(this.#key, { purpose: "agent-review-plan/v1", plan: material });
    await this.db.query(`INSERT INTO control_agent_review_plans(id,tenant_id,project_id,pipeline_run_id,producer_job_id,
      reviewer_job_id,reviewer_run_id,target_id,target_digest,acceptance_profile_id,acceptance_profile_digest,review_id,finding_id,
      reviewer,plan_digest,auth_tag,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17)`,
    [partial.id, this.tenantId, partial.project_id, partial.pipeline_run_id, partial.producer_job_id, partial.reviewer_job_id,
      partial.reviewer_run_id, partial.target_id, partial.target_digest, partial.acceptance_profile_id,
      partial.acceptance_profile_digest, partial.review_id, partial.finding_id, JSON.stringify(reviewer), planDigest, authTag, now]);
    return Object.freeze({ planId: partial.id, reviewId: partial.review_id, reviewer, targetId: target.id,
      targetDigest, findingId: partial.finding_id, grantsApproval: false as const, grantsExecutionAuthority: false as const });
  }
  async record(value: unknown) {
    const input = recordSchema.parse(value);
    // The reviewer login has no table privilege: the database read boundary
    // serves only its bound installation tenant's plan, run and profile.
    const row = (await this.db.query<PlanRow & { run_state: string | null; run_job_id: string | null;
      run_project_id: string | null; profile_payload: unknown }>("SELECT * FROM read_agent_review_plan($1)",
    [input.planId])).rows[0];
    if (!row) throw new Error("agent_review_plan_unavailable");
    const plan = this.#verify(row);
    if (row.run_state !== "succeeded" || row.run_job_id !== plan.reviewerJobId || row.run_project_id !== plan.projectId)
      throw new Error("agent_review_run_incomplete");
    const profile = completionAcceptanceProfileSchemaV1.parse(row.profile_payload) as CompletionAcceptanceProfileV1;
    const effectiveRisk = riskOrder[Math.max(riskOrder.indexOf(profile.minimumRisk), riskOrder.indexOf(input.assessedRisk))]!;
    const review: CompletionReviewV1 = { schemaVersion: "control-room-completion-gate/v1", id: plan.reviewId,
      tenantId: this.tenantId, projectId: plan.projectId, targetId: plan.targetId, targetDigest: plan.targetDigest,
      acceptanceProfileId: plan.acceptanceProfileId, acceptanceProfileDigest: plan.acceptanceProfileDigest,
      reviewer: plan.reviewer, authority: "completion_gate", decision: input.decision, assessedRisk: input.assessedRisk,
      effectiveRisk, evidenceDigests: [...new Set(input.evidenceDigests)].sort(),
      findingIds: input.decision === "changes_requested" ? [plan.findingId] : [], reviewedAt: this.clock(),
      grantsApproval: false, grantsExecutionAuthority: false };
    const findings: CompletionFindingV1[] = input.decision === "changes_requested" ? [{
      schemaVersion: "control-room-completion-gate/v1", id: plan.findingId, tenantId: this.tenantId,
      projectId: plan.projectId, targetId: plan.targetId, targetDigest: plan.targetDigest, reviewId: plan.reviewId,
      code: "agent:changes_requested", severity: effectiveRisk, statementDigest: input.findingStatementDigest!,
      evidenceDigests: [...new Set(input.evidenceDigests)].sort(), raisedAt: review.reviewedAt,
    }] : [];
    const result = await this.#gate.commitAgentReview(input.planId, review, findings);
    return Object.freeze({ review: result.review, replayed: result.replayed, grantsApproval: false as const,
      grantsExecutionAuthority: false as const });
  }
}
