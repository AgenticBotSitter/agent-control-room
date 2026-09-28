import { randomUUID, timingSafeEqual } from "node:crypto";
import { AuditStore, appendAuditWith } from "../../audit/audit-store";
import { jobRecordSchema } from "../../domain/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebAccessError } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import { linearPipelineTemplateInputSchemaV1, pipelineAdvanceReceiptSchemaV1, pipelineBuildWritePolicySchemaV1, pipelineHistorySchemaV1,
  pipelineTerminalReceiptSchemaV1,
  pipelineUnattendedTransitionReceiptSchemaV1, pipelineUnattendedTransitionSchemaV1,
  type PipelineAdvanceReceiptV1, type PipelineHistoryV1, type PipelineTerminalReceiptV1 } from "./schemas";

const ADVANCE_ACTION = "tasks.assign" as const;
const SERVICE_ACTOR = "service:pipeline-advance:v1" as const;
const RISK = { low: 0, medium: 1, high: 2, critical: 3 } as const;
const HISTORY_VOCABULARY = {
  "work_batches.propose":"proposed", "work_batches.revise":"revised",
  "work_batches.approved":"approved", "work_batches.rejected":"rejected",
  "work_batches.partially_approved":"partially_approved", "pipelines.run.instantiate":"proposed",
  "tasks.propose":"proposed", "tasks.plan":"approved", "tasks.revisions.plan":"revision_planned",
  "tasks.assign":"ran", "tasks.assignment.expire":"assignment_expired",
  "native.task.queued":"ran", "hermes.021.local.task.queued":"ran",
  "hermes.local.task.queued":"ran", "claude.code.local.task.queued":"ran",
  "codex.owner_trusted.local.task.queued":"ran", "codex.task.queued":"ran",
  "native.delivery.prepared":"delivery_prepared", "native.delivery.staged":"delivery_staged",
  "native.delivery.transmission_requested":"transmission_requested",
  "native.delivery.receipt_recorded":"delivery_received", "native.queue.unsent_recovered":"queue_recovered",
  "codex.delivery.staged":"delivery_staged", "codex.delivery.transmission_requested":"transmission_requested",
  "codex.delivery.receipt_recorded":"delivery_received", "task.native.capacity_released":"capacity_released",
  "task.result.received":"received", "task.result.submitted_for_review":"resulted",
  "task.result.structure_verified":"checked", "tasks.reviews.record":"checked",
  "tasks.verifications.record":"checked", "task.native.completed":"completed",
  "pipelines.stage.advanced":"advanced", "pipelines.run.succeeded":"completed", "pipelines.unattended.enabled":"approved",
  "pipelines.unattended.disabled":"approved",
} as const;
const iso = (value: string | Date) => new Date(value).toISOString();
const millis = (value: string | Date) => new Date(value).getTime();
const same = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b); };

export type PipelineAdvanceSafeReasonV1 = "unattended_disabled" | "unattended_not_authorized"
  | "run_not_active" | "stage_not_eligible" | "stage_uncertain" | "waiting_approval"
  | "dependency_not_accepted" | "selection_not_current" | "execution_authority_missing"
  | "policy_inactive" | "policy_action_not_permitted" | "policy_route_mismatch"
  | "policy_risk_exceeded" | "policy_task_allowance_exhausted" | "policy_cost_allowance_exhausted"
  | "policy_cost_unknown" | "policy_concurrency_exhausted" | "deadline_reached" | "advance_conflict"
  | "pipeline_integrity_failed";
export class PipelineAdvanceErrorV1 extends Error {
  constructor(readonly safeReason: PipelineAdvanceSafeReasonV1) { super(safeReason); this.name = "PipelineAdvanceErrorV1"; }
}
const refuse = (reason: PipelineAdvanceSafeReasonV1): never => { throw new PipelineAdvanceErrorV1(reason); };
function safeInteger(value: number | string): number { const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) refuse("advance_conflict"); return parsed; }
function strings(value: unknown): string[] { const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.length > 128 || parsed.some(item => typeof item !== "string")) refuse("advance_conflict");
  return parsed; }

type TemplateRow = { id: string; project_id: string; name: string; description: string; stages: unknown;
  max_stages: number; max_total_loops: number; may_advance_unattended: boolean; max_duration_seconds: number;
  record_digest: string; auth_tag: string; version: number; created_at: string | Date; updated_at: string | Date };
type RunRow = { id: string; project_id: string; request_id: string; template_id: string; template_version: number;
  template_digest: string; workflow_id: string; title: string; state: "proposed"|"active"|"paused"|"succeeded"|"failed"|"cancelled";
  started_at: string | Date | null; updated_at: string | Date; completed_at: string | Date | null;
  current_stage_ordinal: number | null; unattended: boolean; record_digest: string; auth_tag: string; version: number };
type StageRow = { stage_ordinal: number; stage_kind: "build"|"check"|"signoff"; role: "builder"|"checker"|"validator";
  project_id: string; pipeline_run_id: string; current_job_id: string; worker_id: string;
  worker_kind: "codex"|"claude-code"|"hermes"; node_id: string; selection_key: string; model: string;
  effort: string; provider: string|null; profile: string|null; current_attempt_id: string|null; current_lease_id: string|null;
  state: string; max_loops: number; handoff_from_result_digest: string|null; signoff_review_id: string|null;
  allowed_paths: unknown|null; maximum_changed_files: number|null; maximum_changed_bytes: number|null;
  started_at: string|Date|null; finished_at: string|Date|null; record_digest: string; auth_tag: string; version: number };
type PolicyRow = { id: string; project_id: string; coordinator_identity_id: string; coordinator_version: number|string;
  owner_identity_id: string; state: string; version: number|string; policy_digest: string; allowed_actions: unknown; eligible_routes: unknown;
  risk_ceiling: keyof typeof RISK; max_total_tasks: number|string; max_total_cost_microusd: number|string;
  max_concurrent_tasks: number|string; valid_from: string|Date; valid_until: string|Date };
type AdvanceReceiptRow = { id: string; project_id: string; pipeline_run_id: string; stage_ordinal: number;
  source_job_id: string; execution_job_id: string; attempt_id: string; queue_id: string; selection_digest: string;
  template_version: number; template_digest: string; run_version: number; run_digest: string; policy_id: string;
  policy_version: number|string; policy_digest: string; delegation_receipt_id: string; delegation_receipt_digest: string;
  delegation_task_units:number|string; delegation_cost_microusd:number|string; delegation_cost_evidence_digest:string;
  request_digest: string; receipt_digest: string; auth_tag: string; advanced_at: string|Date };
type UnattendedTransitionRow = { id:string; project_id:string; pipeline_run_id:string; pipeline_template_id:string;
  template_version:number|string; template_digest:string; run_version:number|string; run_digest:string; policy_id:string;
  policy_version:number|string; policy_digest:string; owner_identity_id:string; enabled:boolean; idempotency_key:string;
  request_digest:string; transition_digest:string; auth_tag:string; occurred_at:string|Date };

function templateMaterial(scope: { tenantId: string }, row: TemplateRow) {
  const parsed = linearPipelineTemplateInputSchemaV1.parse({ name: row.name, description: row.description,
    stages: row.stages, maxTotalLoops: Number(row.max_total_loops), maxDurationSeconds: Number(row.max_duration_seconds) });
  return { id: row.id, tenantId: scope.tenantId, projectId: row.project_id, name: row.name, description: row.description,
    stages: parsed.stages, maxStages: Number(row.max_stages), maxTotalLoops: Number(row.max_total_loops),
    mayAdvanceUnattended: row.may_advance_unattended, maxDurationSeconds: Number(row.max_duration_seconds),
    version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function runMaterial(scope: { tenantId: string }, row: RunRow) { return { id: row.id, tenantId: scope.tenantId,
  projectId: row.project_id, requestId: row.request_id, templateId: row.template_id, templateVersion: Number(row.template_version),
  templateDigest: row.template_digest, workflowId: row.workflow_id, title: row.title, state: row.state,
  startedAt: row.started_at ? iso(row.started_at) : null, updatedAt: iso(row.updated_at),
  completedAt: row.completed_at ? iso(row.completed_at) : null,
  currentStageOrdinal: row.current_stage_ordinal === null ? null : Number(row.current_stage_ordinal),
  unattended: row.unattended, version: Number(row.version) }; }
function stageMaterial(scope: { tenantId: string }, row: StageRow) {
  const policy = row.stage_kind === "build" && row.allowed_paths !== null
    ? pipelineBuildWritePolicySchemaV1.parse({ allowedPaths: row.allowed_paths,
      maximumChangedFiles: row.maximum_changed_files, maximumChangedBytes: row.maximum_changed_bytes }) : null;
  return { id: `${row.pipeline_run_id}:stage:${Number(row.stage_ordinal)}`,
  tenantId: scope.tenantId, projectId: row.project_id, pipelineRunId: row.pipeline_run_id,
  stageOrdinal: Number(row.stage_ordinal), stageKind: row.stage_kind, role: row.role, workerId: row.worker_id,
  workerKind: row.worker_kind, nodeId: row.node_id, selectionKey: row.selection_key, model: row.model, effort: row.effort,
  provider: row.provider, profile: row.profile, currentJobId: row.current_job_id, currentAttemptId: row.current_attempt_id,
  currentLeaseId: row.current_lease_id, state: row.state, maxLoops: Number(row.max_loops),
  handoffFromResultDigest: row.handoff_from_result_digest, signoffReviewId: row.signoff_review_id,
  allowedPaths: policy ? [...policy.allowedPaths] : null, maximumChangedFiles: policy?.maximumChangedFiles ?? null,
  maximumChangedBytes: policy?.maximumChangedBytes ?? null,
  startedAt: row.started_at ? iso(row.started_at) : null, finishedAt: row.finished_at ? iso(row.finished_at) : null,
  version: Number(row.version) }; }
function verify(key: Uint8Array, purpose: string, material: unknown, digest: string, tag: string) {
  if (sha256Digest(material) !== digest || !same(hmacSha256Tag(key, { purpose, record: material }), tag))
    refuse("pipeline_integrity_failed");
}

export type PipelineAdvanceSelectionV1 = Readonly<{ tenantId: string; projectId: string; runId: string;
  stageOrdinal: number; sourceJobId: string; executionJobId: string; workerId: string;
  workerKind: "codex"|"claude-code"|"hermes"; nodeId: string; selectionKey: string; model: string;
  effort: string; provider: string|null; profile: string|null }>;
export type PipelineStageResolutionV1 = Readonly<{ state: "accepted"|"eligible"|"in_flight"|"waiting_approval"|"uncertain"|"terminal_failure";
  executionJobId: string; expectedInputDigest: string }>;
export type PipelineDelegationReceiptV1 = Readonly<{ receiptId: string; receiptDigest: string; policyId: string;
  policyVersion: number; policyDigest: string; coordinatorVersion: number; ownerIdentityId: string; action: typeof ADVANCE_ACTION;
  routeId: string; executorId: string; taskUnits: number; committedCostMicroUsd: number;
  nextCost: Readonly<{ kind: "known"; microUsd: number; evidenceDigest: string }>|Readonly<{ kind: "unknown" }>;
  concurrentTasks: number; validUntil: string }>;
export type PipelineAdvanceCapabilityV1 = Readonly<{
  resolveStageInSession: (tx: DatabaseSession, input: Omit<PipelineAdvanceSelectionV1,"executionJobId">) => Promise<PipelineStageResolutionV1>;
  assertAcceptedPredecessorInSession: (tx: DatabaseSession, input: Readonly<{ tenantId: string; projectId: string;
    runId: string; predecessorJobId: string; successorJobId: string }>) => void|Promise<void>;
  assertSelectionCurrentInSession: (tx: DatabaseSession, selection: PipelineAdvanceSelectionV1) => void|Promise<void>;
  assertSelectionCurrent: (selection: PipelineAdvanceSelectionV1) => void|Promise<void>;
  authorizeDelegationInSession: (tx: DatabaseSession, selection: PipelineAdvanceSelectionV1,
    policyId: string) => Promise<PipelineDelegationReceiptV1>;
  assignAndQueueInSession: (tx: DatabaseSession, input: PipelineAdvanceSelectionV1 & Readonly<{ expectedInputDigest: string;
    policyId: string; approvingOwnerIdentityId: string; idempotencyKey: string; commitDeadline: number }>, authority: Readonly<{ actorId: typeof SERVICE_ACTOR;
    assertCurrent: () => void|Promise<void>; commitDeadline: (value:number) => void }>) =>
    Promise<Readonly<{ attemptId: string; queueId: string; replayed: boolean }>>;
}>;
type AdvanceConfiguration = Readonly<{ unattendedEnabled?: () => boolean; capability?: PipelineAdvanceCapabilityV1 }>;

export class PipelineAdvanceServiceV1 {
  readonly #key: Uint8Array; readonly #enabled: () => boolean; readonly #capability?: PipelineAdvanceCapabilityV1;
  readonly #owner: WebSessionAuthority;
  constructor(private readonly db: DatabaseClient, private readonly scope: Readonly<{ tenantId: string; workspaceId: string }>,
    integrityKey: Uint8Array, configuration: AdvanceConfiguration = {}, private readonly clock: () => number = Date.now) {
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) throw new Error("pipeline_configuration_invalid");
    this.#key = Uint8Array.from(integrityKey); this.#enabled = configuration.unattendedEnabled ?? (() => false);
    this.#capability = configuration.capability; this.#owner = new WebSessionAuthority(db, scope, clock, "pipeline");
  }

  async setUnattended(identity: VerifiedWebIdentity, projectId: string, value: unknown, idempotencyKey: string) {
    const parsed = pipelineUnattendedTransitionSchemaV1.safeParse(value);
    if (!parsed.success || !/^[A-Za-z0-9:_-]{12,180}$/.test(idempotencyKey)) throw new WebAccessError("invalid_request");
    return this.#owner.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.assign", projectId, true);
      const owner = (await tx.query<{ id: string }>(`SELECT g.id FROM control_role_grants g JOIN control_identities i
        ON i.tenant_id=g.tenant_id AND i.id=g.identity_id WHERE g.tenant_id=$1 AND g.identity_id=$2 AND g.role_key='owner'
        AND g.revoked_at IS NULL AND i.state='active' FOR SHARE OF g,i`, [this.scope.tenantId, actor.id])).rows[0];
      if (!owner) throw new WebAccessError("access_denied");
      const requestDigest = sha256Digest({ schema: "control-room.pipeline-unattended-transition/v1", projectId,
        ...parsed.data, idempotencyKey, ownerIdentityId: actor.id });
      const prior = (await tx.query<UnattendedTransitionRow>(`SELECT id,project_id,pipeline_run_id,pipeline_template_id,
        template_version,template_digest,run_version,run_digest,policy_id,policy_version,policy_digest,owner_identity_id,enabled,
        idempotency_key,request_digest,transition_digest,auth_tag,occurred_at
        FROM pipeline_unattended_transitions WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3 FOR SHARE`,
      [this.scope.tenantId, actor.id, idempotencyKey])).rows[0];
      if (prior) { const material={ id:prior.id,tenantId:this.scope.tenantId,projectId:prior.project_id,
          pipelineRunId:prior.pipeline_run_id,pipelineTemplateId:prior.pipeline_template_id,
          templateVersion:Number(prior.template_version),templateDigest:prior.template_digest,
          runVersion:Number(prior.run_version),runDigest:prior.run_digest,policyId:prior.policy_id,
          policyVersion:Number(prior.policy_version),policyDigest:prior.policy_digest,ownerIdentityId:prior.owner_identity_id,
          enabled:prior.enabled,idempotencyKey:prior.idempotency_key,requestDigest:prior.request_digest,
          occurredAt:iso(prior.occurred_at) };
        verify(this.#key,"pipeline-unattended-transition/v1",material,prior.transition_digest,prior.auth_tag);
        if (prior.request_digest !== requestDigest) throw new WebAccessError("conflict");
        return pipelineUnattendedTransitionReceiptSchemaV1.parse({ transitionId: prior.id, runId: prior.pipeline_run_id,
          templateId: prior.pipeline_template_id, policyId: prior.policy_id, enabled: prior.enabled,
          runVersion: Number(prior.run_version), templateVersion: Number(prior.template_version), occurredAt: iso(prior.occurred_at),
          replayed: true, startsWork: false, grantsExecutionAuthority: false }); }
      const { run, template, stages } = await this.#lockedSnapshot(tx, projectId, parsed.data.runId);
      if (run.template_id !== parsed.data.templateId || Number(run.version) !== parsed.data.expectedRunVersion
        || Number(template.version) !== parsed.data.expectedTemplateVersion) throw new WebAccessError("conflict");
      this.#verifySnapshot(run, template, stages);
      // Pre-S7 rows may be active without a start timestamp.  Never re-sign
      // that legacy-invalid state: updated_at is mutable owner-transition
      // metadata and must not become a substitute deadline anchor.
      if (run.state === "active" && run.started_at === null) refuse("pipeline_integrity_failed");
      if (parsed.data.enabled && !["proposed","active"].includes(run.state)) refuse("run_not_active");
      const policy = await this.#policy(tx, projectId, parsed.data.policyId);
      if (parsed.data.enabled) this.#assertOwnerPolicyCurrent(policy, actor.now);
      // Template consent is a monotonic owner-authorized capability ceiling. A
      // per-run disable must not revoke or version-drift sibling runs that share
      // this reusable template; the live installation switch and each run's
      // independently versioned consent remain the two current execution gates.
      const now = actor.now, activatesTemplate = parsed.data.enabled && !template.may_advance_unattended;
      const nextTemplate = activatesTemplate ? { ...template, may_advance_unattended: true,
        version: Number(template.version)+1, updated_at: now } : template;
      const nextTemplateMaterial = templateMaterial(this.scope, nextTemplate), nextTemplateDigest = sha256Digest(nextTemplateMaterial);
      const nextTemplateTag = hmacSha256Tag(this.#key, { purpose: "pipeline-template/v1", record: nextTemplateMaterial });
      const activatesRun = parsed.data.enabled && run.state === "proposed";
      const nextRun = { ...run, unattended: parsed.data.enabled,
        state: activatesRun ? "active" as const : run.state,
        started_at: activatesRun ? now : run.started_at,
        updated_at: now, version: Number(run.version)+1,
        template_version: nextTemplate.version, template_digest: nextTemplateDigest };
      const nextRunMaterial = runMaterial(this.scope, nextRun), nextRunDigest = sha256Digest(nextRunMaterial);
      const nextRunTag = hmacSha256Tag(this.#key, { purpose: "pipeline-run/v1", record: nextRunMaterial });
      if (activatesTemplate) await tx.query(`UPDATE pipeline_templates SET may_advance_unattended=true,version=$1,updated_at=$2,
        record_digest=$3,auth_tag=$4 WHERE tenant_id=$5 AND project_id=$6 AND id=$7 AND version=$8`,
      [nextTemplate.version,now,nextTemplateDigest,nextTemplateTag,this.scope.tenantId,projectId,template.id,template.version]);
      await tx.query(`UPDATE pipeline_runs SET unattended=$1,state=$2,started_at=$3,updated_at=$4,version=$5,template_version=$6,
        template_digest=$7,record_digest=$8,auth_tag=$9 WHERE tenant_id=$10 AND project_id=$11 AND id=$12 AND version=$13`,
      [parsed.data.enabled,nextRun.state,nextRun.started_at,now,nextRun.version,nextTemplate.version,nextTemplateDigest,nextRunDigest,nextRunTag,
        this.scope.tenantId,projectId,run.id,run.version]);
      const transitionId = `pipeline-unattended:${randomUUID()}`;
      const material = { id: transitionId, tenantId: this.scope.tenantId, projectId, pipelineRunId: run.id,
        pipelineTemplateId: template.id, templateVersion: nextTemplate.version, templateDigest: nextTemplateDigest,
        runVersion: nextRun.version, runDigest: nextRunDigest, policyId: policy.id, policyVersion: Number(policy.version),
        policyDigest: policy.policy_digest, ownerIdentityId: actor.id, enabled: parsed.data.enabled, idempotencyKey,
        requestDigest, occurredAt: now };
      const transitionDigest = sha256Digest(material), authTag = hmacSha256Tag(this.#key,
        { purpose: "pipeline-unattended-transition/v1", record: material });
      await tx.query(`INSERT INTO pipeline_unattended_transitions(id,tenant_id,project_id,pipeline_run_id,pipeline_template_id,
        template_version,template_digest,run_version,run_digest,policy_id,policy_version,policy_digest,owner_identity_id,enabled,
        idempotency_key,request_digest,transition_digest,auth_tag,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,$18,$19)`, [transitionId,this.scope.tenantId,projectId,run.id,template.id,nextTemplate.version,
        nextTemplateDigest,nextRun.version,nextRunDigest,policy.id,Number(policy.version),policy.policy_digest,actor.id,
        parsed.data.enabled,idempotencyKey,requestDigest,transitionDigest,authTag,now]);
      await appendAuditWith(tx, { id:`audit:${transitionId}`,...this.scope,projectId,actorId:actor.id,actorType:"human",
        action: parsed.data.enabled ? "pipelines.unattended.enabled" : "pipelines.unattended.disabled",
        targetType:"pipeline_run",targetId:run.id,idempotencyKey,occurredAt:now,
        safeMetadata:{transitionId,policyId:policy.id,enabled:parsed.data.enabled} });
      return pipelineUnattendedTransitionReceiptSchemaV1.parse({ transitionId,runId:run.id,templateId:template.id,
        policyId:policy.id,enabled:parsed.data.enabled,runVersion:nextRun.version,templateVersion:nextTemplate.version,
        occurredAt:now,replayed:false,startsWork:false,grantsExecutionAuthority:false });
    });
  }

  async advance(runId: string, policyId: string, expectedConsent?:Readonly<{id:string;digest:string}>): Promise<PipelineAdvanceReceiptV1|PipelineTerminalReceiptV1> {
    const capability = this.#capability;
    if (!this.#enabled() || capability === undefined) throw new PipelineAdvanceErrorV1("unattended_disabled");
    let precommit: () => void|Promise<void> = () => this.#assertInstall();
    return this.db.transactionWithPreCommitCheck(async tx => {
      this.#assertInstall();
      const locator = (await tx.query<{ project_id:string }>(`SELECT project_id FROM pipeline_runs WHERE tenant_id=$1 AND id=$2`,
        [this.scope.tenantId,runId])).rows[0]; if (!locator) refuse("advance_conflict");
      const { run, template, stages } = await this.#lockedSnapshot(tx, locator.project_id, runId);
      this.#verifySnapshot(run,template,stages);
      const consent=(await tx.query<UnattendedTransitionRow>(`SELECT id,project_id,pipeline_run_id,pipeline_template_id,
        template_version,template_digest,run_version,run_digest,policy_id,policy_version,policy_digest,owner_identity_id,enabled,
        idempotency_key,request_digest,transition_digest,auth_tag,occurred_at FROM pipeline_unattended_transitions
        WHERE tenant_id=$1 AND project_id=$2 AND pipeline_run_id=$3 ORDER BY run_version DESC,id DESC LIMIT 1 FOR SHARE`,
      [this.scope.tenantId,run.project_id,run.id])).rows[0];
      if(!consent)refuse("unattended_not_authorized");
      const consentMaterial={id:consent.id,tenantId:this.scope.tenantId,projectId:consent.project_id,
        pipelineRunId:consent.pipeline_run_id,pipelineTemplateId:consent.pipeline_template_id,
        templateVersion:Number(consent.template_version),templateDigest:consent.template_digest,runVersion:Number(consent.run_version),
        runDigest:consent.run_digest,policyId:consent.policy_id,policyVersion:Number(consent.policy_version),
        policyDigest:consent.policy_digest,ownerIdentityId:consent.owner_identity_id,enabled:consent.enabled,
        idempotencyKey:consent.idempotency_key,requestDigest:consent.request_digest,occurredAt:iso(consent.occurred_at)};
      verify(this.#key,"pipeline-unattended-transition/v1",consentMaterial,consent.transition_digest,consent.auth_tag);
      if(!consent.enabled||consent.policy_id!==policyId||consent.pipeline_template_id!==template.id
        ||expectedConsent&&(expectedConsent.id!==consent.id||expectedConsent.digest!==consent.transition_digest)
        ||Number(consent.template_version)!==Number(template.version)||consent.template_digest!==template.record_digest
        ||Number(consent.run_version)>Number(run.version)
        ||Number(consent.run_version)===Number(run.version)&&consent.run_digest!==run.record_digest
        )refuse("unattended_not_authorized");
      if (!run.unattended || !template.may_advance_unattended) refuse("unattended_not_authorized");
      if (Number(run.template_version) !== Number(template.version) || run.template_digest !== template.record_digest)
        refuse("pipeline_integrity_failed");
      if (run.state !== "active") refuse("run_not_active");
      const runStartedAtMillis = run.started_at === null
        ? refuse("pipeline_integrity_failed") : millis(run.started_at);
      const project = (await tx.query<{lifecycle:string}>(`SELECT h.lifecycle FROM projects p JOIN control_manual_project_heads h
        ON h.tenant_id=p.tenant_id AND h.project_id=p.id WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 FOR SHARE OF p,h`,
      [this.scope.tenantId,this.scope.workspaceId,run.project_id])).rows[0]; if (!project || project.lifecycle!=="active") refuse("run_not_active");
      let stage: StageRow|undefined, selection: PipelineAdvanceSelectionV1|undefined, expectedInputDigest="";
      for (const candidate of stages) {
        const base = { tenantId:this.scope.tenantId,projectId:run.project_id,runId:run.id,stageOrdinal:Number(candidate.stage_ordinal),
          sourceJobId:candidate.current_job_id,workerId:candidate.worker_id,workerKind:candidate.worker_kind,nodeId:candidate.node_id,
          selectionKey:candidate.selection_key,model:candidate.model,effort:candidate.effort,provider:candidate.provider,profile:candidate.profile };
        const resolved = await capability.resolveStageInSession(tx,base);
        if (resolved.state==="accepted") continue;
        if (resolved.state==="uncertain" || candidate.state==="uncertain") refuse("stage_uncertain");
        if (resolved.state==="waiting_approval") refuse("waiting_approval");
        const selected = {...base,executionJobId:resolved.executionJobId};
        const prior = await this.#receipt(tx,run.id,candidate.stage_ordinal);
        if (prior) return this.#replayReceipt(prior,selected,policyId);
        if (resolved.state!=="eligible") refuse("stage_not_eligible");
        stage=candidate;selection=selected;expectedInputDigest=resolved.expectedInputDigest;break;
      }
      if (!stage || !selection) {
        const finalOrdinal=stages.length-1;
        if(finalOrdinal<0||Number(run.current_stage_ordinal)!==finalOrdinal)refuse("advance_conflict");
        const completedAt=new Date(this.#now()).toISOString(),completedRun={...run,state:"succeeded" as const,
          completed_at:completedAt,current_stage_ordinal:null,updated_at:completedAt,version:Number(run.version)+1};
        const completedMaterial=runMaterial(this.scope,completedRun),completedDigest=sha256Digest(completedMaterial),
          completedTag=hmacSha256Tag(this.#key,{purpose:"pipeline-run/v1",record:completedMaterial});
        const changed=await tx.query<{version:number|string;record_digest:string;auth_tag:string}>(`UPDATE pipeline_runs
          SET state='succeeded',completed_at=$1,current_stage_ordinal=NULL,updated_at=$1,version=$2,record_digest=$3,auth_tag=$4
          WHERE tenant_id=$5 AND project_id=$6 AND id=$7 AND version=$8 RETURNING version,record_digest,auth_tag`,
        [completedAt,completedRun.version,completedDigest,completedTag,this.scope.tenantId,run.project_id,run.id,run.version]);
        const persisted=changed.rows[0];
        if(changed.rows.length!==1||Number(persisted?.version)!==completedRun.version
          ||persisted?.record_digest!==completedDigest||persisted?.auth_tag!==completedTag)refuse("advance_conflict");
        await appendAuditWith(tx,{id:`audit:pipeline-complete:${run.id}:${completedRun.version}`,...this.scope,projectId:run.project_id,
          actorId:SERVICE_ACTOR,actorType:"service",action:"pipelines.run.succeeded",targetType:"pipeline_run",targetId:run.id,
          idempotencyKey:`pipeline-complete:${run.id}:${completedRun.version}`,occurredAt:completedAt,
          safeMetadata:{finalStageOrdinal:finalOrdinal,runDigest:completedDigest}});
        const persistedRun={...completedRun,record_digest:completedDigest,auth_tag:completedTag};
        precommit=()=>{this.#assertInstall();this.#verifySnapshot(persistedRun,template,stages);};
        return pipelineTerminalReceiptSchemaV1.parse({runId:run.id,state:"succeeded",completedAt,startsWork:false,
          grantsExecutionAuthority:false,claimsCancellation:false});
      }
      const selected=selection;
      if(run.current_stage_ordinal===null)refuse("advance_conflict");
      const currentOrdinal=Number(run.current_stage_ordinal);
      if(selected.stageOrdinal!==currentOrdinal&&selected.stageOrdinal!==currentOrdinal+1)refuse("advance_conflict");
      let effectiveRun=run;
      if(selected.stageOrdinal===currentOrdinal+1){
        const advancedRun={...run,current_stage_ordinal:selected.stageOrdinal,updated_at:new Date(this.#now()).toISOString(),
          version:Number(run.version)+1};
        const advancedMaterial=runMaterial(this.scope,advancedRun),advancedDigest=sha256Digest(advancedMaterial),
          advancedTag=hmacSha256Tag(this.#key,{purpose:"pipeline-run/v1",record:advancedMaterial});
        const changed=await tx.query<{version:number|string;record_digest:string;auth_tag:string}>(`UPDATE pipeline_runs
          SET current_stage_ordinal=$1,updated_at=$2,version=$3,record_digest=$4,auth_tag=$5
          WHERE tenant_id=$6 AND project_id=$7 AND id=$8 AND version=$9 RETURNING version,record_digest,auth_tag`,
        [selected.stageOrdinal,advancedRun.updated_at,advancedRun.version,advancedDigest,advancedTag,
          this.scope.tenantId,run.project_id,run.id,run.version]);
        const persisted=changed.rows[0];
        if(changed.rows.length!==1||Number(persisted?.version)!==advancedRun.version
          ||persisted?.record_digest!==advancedDigest||persisted?.auth_tag!==advancedTag)refuse("advance_conflict");
        effectiveRun={...advancedRun,record_digest:advancedDigest,auth_tag:advancedTag};
      }
      const source = await this.#job(tx,effectiveRun,stage.current_job_id,stage,true);
      const execution = await this.#job(tx,effectiveRun,selected.executionJobId,stage,false);
      if (execution.inputDigest!==expectedInputDigest || !["proposed","ready"].includes(execution.state)
        || execution.authority.effectPolicy!=="none" || execution.authority.allowedNetworkDestinations.length!==0)
        refuse("execution_authority_missing");
      const plan = (await tx.query<{source_job_id:string}>(`SELECT source_job_id FROM control_task_execution_plans
        WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3 FOR SHARE`,[this.scope.tenantId,run.project_id,execution.id])).rows[0];
      if (!plan || plan.source_job_id!==source.id) refuse("advance_conflict");
      if (selected.stageOrdinal>0) { const predecessor=stages[selected.stageOrdinal-1]; if (!predecessor) refuse("dependency_not_accepted");
        try { await capability.assertAcceptedPredecessorInSession(tx,{tenantId:this.scope.tenantId,projectId:run.project_id,
          runId:run.id,predecessorJobId:predecessor.current_job_id,successorJobId:source.id}); }
        catch { refuse("dependency_not_accepted"); } }
      await Promise.resolve(capability.assertSelectionCurrentInSession(tx,selected)).catch(()=>refuse("selection_not_current"));
      const policy=await this.#policy(tx,run.project_id,policyId);
      if(Number(consent.policy_version)!==Number(policy.version)||consent.policy_digest!==policy.policy_digest)
        refuse("unattended_not_authorized");
      const delegation=await capability.authorizeDelegationInSession(tx,selected,policyId);
      this.#assertDelegation(policy,delegation,stage,execution,this.#now());
      const runDeadline=runStartedAtMillis+Number(template.max_duration_seconds)*1000;
      let deadline=Math.min(runDeadline,millis(policy.valid_until),Date.parse(execution.authority.expiresAt),Date.parse(delegation.validUntil));
      if (!Number.isFinite(deadline)||this.#now()>=deadline) refuse("deadline_reached");
      const selectionDigest=sha256Digest(selected);
      const requestDigest=sha256Digest({schema:"control-room.pipeline-advance-request/v1",runId:run.id,
        stageOrdinal:selected.stageOrdinal,sourceJobId:source.id,executionJobId:execution.id,selectionDigest,
        templateVersion:template.version,templateDigest:template.record_digest,runVersion:effectiveRun.version,
        runDigest:effectiveRun.record_digest,
        policyId:policy.id,policyVersion:Number(policy.version),policyDigest:policy.policy_digest,
        delegationReceiptId:delegation.receiptId,delegationReceiptDigest:delegation.receiptDigest});
      const authenticate=async()=>{this.#assertInstall();this.#verifySnapshot(effectiveRun,template,stages);
        if(Number(effectiveRun.current_stage_ordinal)!==selected.stageOrdinal)refuse("advance_conflict");
        if(this.#now()>=deadline)refuse("deadline_reached");
        await Promise.resolve(capability.assertSelectionCurrent(selected)).catch(()=>refuse("selection_not_current"));};
      precommit=authenticate;await authenticate();
      const effect=await capability.assignAndQueueInSession(tx,{...selected,expectedInputDigest,policyId,
        approvingOwnerIdentityId:delegation.ownerIdentityId,
        idempotencyKey:`pipeline-advance:${run.id}:${selected.stageOrdinal}`,commitDeadline:deadline},
      {actorId:SERVICE_ACTOR,assertCurrent:authenticate,commitDeadline:value=>{
        if(!Number.isSafeInteger(value)||value<0)refuse("deadline_reached");deadline=Math.min(deadline,value);
      }}).catch((error:unknown)=>{if(error instanceof PipelineAdvanceErrorV1)throw error;
        return refuse("execution_authority_missing");});
      await authenticate();
      const advancedAt=new Date(this.#now()).toISOString(),receiptId=`pipeline-advance:${run.id}:${selected.stageOrdinal}`;
      const material={id:receiptId,tenantId:this.scope.tenantId,projectId:run.project_id,pipelineRunId:run.id,
        stageOrdinal:selected.stageOrdinal,sourceJobId:source.id,executionJobId:execution.id,attemptId:effect.attemptId,
        queueId:effect.queueId,selectionDigest,templateVersion:Number(template.version),templateDigest:template.record_digest,
        runVersion:Number(effectiveRun.version),runDigest:effectiveRun.record_digest,policyId:policy.id,policyVersion:Number(policy.version),
        policyDigest:policy.policy_digest,delegationReceiptId:delegation.receiptId,
        delegationReceiptDigest:delegation.receiptDigest,delegationTaskUnits:1,
        delegationCostMicroUsd:delegation.nextCost.kind==="known"?delegation.nextCost.microUsd:refuse("policy_cost_unknown"),
        delegationCostEvidenceDigest:delegation.nextCost.kind==="known"?delegation.nextCost.evidenceDigest:refuse("policy_cost_unknown"),
        requestDigest,advancedAt};
      const receiptDigest=sha256Digest(material),authTag=hmacSha256Tag(this.#key,{purpose:"pipeline-advance-receipt/v1",record:material});
      await tx.query(`INSERT INTO pipeline_advance_receipts(id,tenant_id,project_id,pipeline_run_id,stage_ordinal,source_job_id,
        execution_job_id,attempt_id,queue_id,selection_digest,template_version,template_digest,run_version,run_digest,policy_id,
        policy_version,policy_digest,delegation_receipt_id,delegation_receipt_digest,delegation_task_units,
        delegation_cost_microusd,delegation_cost_evidence_digest,request_digest,receipt_digest,auth_tag,advanced_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [receiptId,this.scope.tenantId,run.project_id,run.id,selected.stageOrdinal,source.id,execution.id,effect.attemptId,effect.queueId,
        selectionDigest,template.version,template.record_digest,effectiveRun.version,effectiveRun.record_digest,policy.id,Number(policy.version),
        policy.policy_digest,delegation.receiptId,delegation.receiptDigest,1,material.delegationCostMicroUsd,
        material.delegationCostEvidenceDigest,requestDigest,receiptDigest,authTag,advancedAt]);
      await appendAuditWith(tx,{id:`audit:${receiptId}`,...this.scope,projectId:run.project_id,actorId:SERVICE_ACTOR,actorType:"service",
        action:"pipelines.stage.advanced",targetType:"pipeline_run",targetId:run.id,correlationId:execution.id,
        idempotencyKey:receiptId,occurredAt:advancedAt,safeMetadata:{stageOrdinal:selected.stageOrdinal,sourceJobId:source.id,
          executionJobId:execution.id,attemptId:effect.attemptId,queueId:effect.queueId,policyId:policy.id,receiptDigest}});
      return pipelineAdvanceReceiptSchemaV1.parse({runId:run.id,stageOrdinal:selected.stageOrdinal,jobId:execution.id,
        attemptId:effect.attemptId,queueId:effect.queueId,replayed:false,advancedAt,startsWork:true,
        grantsExecutionAuthority:false,claimsCancellation:false});
    },()=>precommit());
  }

  /** Bounded controller-cycle entrypoint. It selects only owner-consented
   * active runs, authenticates the latest owner transition, then delegates
   * each candidate to the same exact/replay-safe advance operation. */
  async advanceReady(limit=8){
    if(!this.#enabled()||!this.#capability)refuse("unattended_disabled");
    if(!Number.isInteger(limit)||limit<1||limit>32)refuse("advance_conflict");
    const candidates=await this.db.query<UnattendedTransitionRow>(`SELECT u.id,u.project_id,u.pipeline_run_id,
      u.pipeline_template_id,u.template_version,u.template_digest,u.run_version,u.run_digest,u.policy_id,u.policy_version,
      u.policy_digest,u.owner_identity_id,u.enabled,u.idempotency_key,u.request_digest,u.transition_digest,u.auth_tag,u.occurred_at
      FROM pipeline_runs r JOIN LATERAL(SELECT t.* FROM pipeline_unattended_transitions t
        WHERE t.tenant_id=r.tenant_id AND t.pipeline_run_id=r.id ORDER BY t.run_version DESC,t.id DESC LIMIT 1)u ON true
      WHERE r.tenant_id=$1 AND r.state='active' AND r.unattended AND u.enabled
      ORDER BY r.unattended_last_swept_at NULLS FIRST,r.id LIMIT $2`,
    [this.scope.tenantId,limit]);
    const receipts:PipelineAdvanceReceiptV1[]=[],completed:PipelineTerminalReceiptV1[]=[];
    for(const row of candidates.rows){
      await this.db.query(`UPDATE pipeline_runs SET unattended_last_swept_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2`,[this.scope.tenantId,row.pipeline_run_id]);
      try{const material={id:row.id,tenantId:this.scope.tenantId,projectId:row.project_id,
        pipelineRunId:row.pipeline_run_id,pipelineTemplateId:row.pipeline_template_id,templateVersion:Number(row.template_version),
        templateDigest:row.template_digest,runVersion:Number(row.run_version),runDigest:row.run_digest,policyId:row.policy_id,
        policyVersion:Number(row.policy_version),policyDigest:row.policy_digest,ownerIdentityId:row.owner_identity_id,enabled:row.enabled,
        idempotencyKey:row.idempotency_key,requestDigest:row.request_digest,occurredAt:iso(row.occurred_at)};
        verify(this.#key,"pipeline-unattended-transition/v1",material,row.transition_digest,row.auth_tag);
        const outcome=await this.advance(row.pipeline_run_id,row.policy_id,{id:row.id,digest:row.transition_digest});
        if(outcome.startsWork)receipts.push(outcome);else completed.push(outcome);}
      catch(error){if(!(error instanceof PipelineAdvanceErrorV1))throw error;}
    }
    return Object.freeze({checked:candidates.rows.length,advanced:Object.freeze(receipts),completed:Object.freeze(completed)});
  }

  async history(projectId:string,runId:string,limit=100):Promise<PipelineHistoryV1>{
    if(!Number.isInteger(limit)||limit<1||limit>200)refuse("advance_conflict");
    return this.db.transaction(async tx=>{
      const run=(await tx.query<{id:string}>(`SELECT id FROM pipeline_runs WHERE tenant_id=$1 AND project_id=$2 AND id=$3`,
        [this.scope.tenantId,projectId,runId])).rows[0];if(!run)refuse("advance_conflict");
      const rows=(await tx.query<{id:string;actor_id:string;actor_type:"human"|"agent"|"worker"|"service"|"adapter";
        action:string;target_type:string;target_id:string;safe_metadata:unknown;occurred_at:string|Date;chain_partition:string;
        chain_sequence:number|string;event_hash:string}>(`WITH RECURSIVE source_jobs AS (
          SELECT current_job_id id FROM pipeline_stage_runs WHERE tenant_id=$1 AND project_id=$2 AND pipeline_run_id=$3),
        execution_jobs AS (SELECT p.job_id id FROM control_task_execution_plans p JOIN source_jobs s ON s.id=p.source_job_id
          WHERE p.tenant_id=$1 AND p.project_id=$2), attempts AS (
          SELECT a.id FROM control_attempts a JOIN execution_jobs j ON j.id=a.job_id WHERE a.tenant_id=$1), artifacts AS (
          SELECT r.artifact_id id FROM control_native_artifact_receipts r JOIN execution_jobs j ON j.id=r.job_id WHERE r.tenant_id=$1),
        review_targets AS (SELECT p.plan->>'targetId' id FROM control_native_review_plans p JOIN execution_jobs j ON j.id=p.job_id
          WHERE p.tenant_id=$1 AND p.project_id=$2 AND jsonb_typeof(p.plan)='object' AND p.plan->>'targetId' IS NOT NULL),
        gate_records AS (SELECT r.id FROM control_completion_gate_records r JOIN review_targets t ON t.id=r.id
          WHERE r.tenant_id=$1 AND r.project_id=$2 UNION ALL SELECT child.id FROM control_completion_gate_records child
          JOIN gate_records parent ON child.parent_id=parent.id WHERE child.tenant_id=$1 AND child.project_id=$2),
        batches AS (SELECT DISTINCT i.batch_id id FROM work_batch_items i JOIN source_jobs s ON s.id=i.job_id
          WHERE i.tenant_id=$1 AND i.project_id=$2), lineage AS (
          SELECT $3::text id UNION SELECT id FROM source_jobs UNION SELECT id FROM execution_jobs UNION SELECT id FROM attempts
          UNION SELECT id FROM artifacts UNION SELECT id FROM review_targets UNION SELECT id FROM gate_records
          UNION SELECT id FROM batches)
        SELECT e.id,e.actor_id,e.actor_type,e.action,e.target_type,e.target_id,e.safe_metadata,e.occurred_at,
          e.chain_partition,e.chain_sequence,e.event_hash FROM audit_events e WHERE e.tenant_id=$1 AND e.project_id=$2
          AND e.chain_version=1 AND e.action=ANY($5::text[])
          AND (e.target_id IN(SELECT id FROM lineage) OR e.correlation_id IN(SELECT id FROM lineage))
          ORDER BY e.chain_partition,e.chain_sequence LIMIT $4`,
      [this.scope.tenantId,projectId,runId,limit+1,Object.keys(HISTORY_VOCABULARY)])).rows;
      const audit=new AuditStore({query:tx.query.bind(tx),transaction:async work=>work(tx),
        transactionWithPreCommitCheck:async(work,check)=>{const value=await work(tx);await check();return value;}});
      for(const partition of new Set(rows.map(row=>row.chain_partition))){const verified=await audit.verify(this.scope.tenantId,partition);
        if(!verified.valid)refuse("advance_conflict");}
      const events=rows.slice(0,limit).flatMap(row=>{const kind=HISTORY_VOCABULARY[row.action as keyof typeof HISTORY_VOCABULARY];
        if(!kind)return[];
        const metadata=row.safe_metadata&&typeof row.safe_metadata==="object"?row.safe_metadata as Record<string,unknown>:{};
        const reason=metadata.reasonCode;return[{id:row.id,kind,actorId:row.actor_id,actorType:row.actor_type,action:row.action,
          targetType:row.target_type,targetId:row.target_id,safeReason:typeof reason==="string"&&/^[a-z0-9._:-]{1,120}$/.test(reason)?reason:null,
          occurredAt:iso(row.occurred_at),chainPartition:row.chain_partition,chainSequence:safeInteger(row.chain_sequence),eventHash:row.event_hash}];});
      return pipelineHistorySchemaV1.parse({runId,projectId,events,truncated:rows.length>limit,chainVerified:true,
        observedAt:new Date(this.#now()).toISOString(),startsWork:false,grantsExecutionAuthority:false});
    });
  }

  /** Authenticated owner projection for the private-web history route.  The
   * server-only history method remains usable by coordinator composition, but
   * an HTTP caller must prove both current project read access and the current
   * tenant owner grant before any lineage is read. */
  async historyForOwner(identity: VerifiedWebIdentity, projectId:string, runId:string, limit=100):Promise<PipelineHistoryV1>{
    return this.#owner.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const owner = (await tx.query<{ id:string }>(`SELECT g.id FROM control_role_grants g JOIN control_identities i
        ON i.tenant_id=g.tenant_id AND i.id=g.identity_id WHERE g.tenant_id=$1 AND g.identity_id=$2 AND g.role_key='owner'
        AND g.revoked_at IS NULL AND i.state='active' FOR SHARE OF g,i`, [this.scope.tenantId,actor.id])).rows[0];
      if (!owner) throw new WebAccessError("access_denied");
      return this.#historyInSession(tx,projectId,runId,limit);
    });
  }

  async #historyInSession(tx:DatabaseSession,projectId:string,runId:string,limit:number):Promise<PipelineHistoryV1>{
    if(!Number.isInteger(limit)||limit<1||limit>200)refuse("advance_conflict");
    const run=(await tx.query<{id:string}>(`SELECT id FROM pipeline_runs WHERE tenant_id=$1 AND project_id=$2 AND id=$3`,
      [this.scope.tenantId,projectId,runId])).rows[0];if(!run)refuse("advance_conflict");
    const rows=(await tx.query<{id:string;actor_id:string;actor_type:"human"|"agent"|"worker"|"service"|"adapter";
      action:string;target_type:string;target_id:string;safe_metadata:unknown;occurred_at:string|Date;chain_partition:string;
      chain_sequence:number|string;event_hash:string}>(`WITH RECURSIVE source_jobs AS (
        SELECT current_job_id id FROM pipeline_stage_runs WHERE tenant_id=$1 AND project_id=$2 AND pipeline_run_id=$3),
      execution_jobs AS (SELECT p.job_id id FROM control_task_execution_plans p JOIN source_jobs s ON s.id=p.source_job_id
        WHERE p.tenant_id=$1 AND p.project_id=$2), attempts AS (
        SELECT a.id FROM control_attempts a JOIN execution_jobs j ON j.id=a.job_id WHERE a.tenant_id=$1), artifacts AS (
        SELECT r.artifact_id id FROM control_native_artifact_receipts r JOIN execution_jobs j ON j.id=r.job_id WHERE r.tenant_id=$1),
      review_targets AS (SELECT p.plan->>'targetId' id FROM control_native_review_plans p JOIN execution_jobs j ON j.id=p.job_id
        WHERE p.tenant_id=$1 AND p.project_id=$2 AND jsonb_typeof(p.plan)='object' AND p.plan->>'targetId' IS NOT NULL),
      gate_records AS (SELECT r.id FROM control_completion_gate_records r JOIN review_targets t ON t.id=r.id
        WHERE r.tenant_id=$1 AND r.project_id=$2 UNION ALL SELECT child.id FROM control_completion_gate_records child
        JOIN gate_records parent ON child.parent_id=parent.id WHERE child.tenant_id=$1 AND child.project_id=$2),
      batches AS (SELECT DISTINCT i.batch_id id FROM work_batch_items i JOIN source_jobs s ON s.id=i.job_id
        WHERE i.tenant_id=$1 AND i.project_id=$2), lineage AS (
        SELECT $3::text id UNION SELECT id FROM source_jobs UNION SELECT id FROM execution_jobs UNION SELECT id FROM attempts
        UNION SELECT id FROM artifacts UNION SELECT id FROM review_targets UNION SELECT id FROM gate_records
        UNION SELECT id FROM batches)
      SELECT e.id,e.actor_id,e.actor_type,e.action,e.target_type,e.target_id,e.safe_metadata,e.occurred_at,
        e.chain_partition,e.chain_sequence,e.event_hash FROM audit_events e WHERE e.tenant_id=$1 AND e.project_id=$2
        AND e.chain_version=1 AND e.action=ANY($5::text[])
        AND (e.target_id IN(SELECT id FROM lineage) OR e.correlation_id IN(SELECT id FROM lineage))
        ORDER BY e.chain_partition,e.chain_sequence LIMIT $4`,
    [this.scope.tenantId,projectId,runId,limit+1,Object.keys(HISTORY_VOCABULARY)])).rows;
    const audit=new AuditStore({query:tx.query.bind(tx),transaction:async work=>work(tx),
      transactionWithPreCommitCheck:async(work,check)=>{const value=await work(tx);await check();return value;}});
    for(const partition of new Set(rows.map(row=>row.chain_partition))){const verified=await audit.verify(this.scope.tenantId,partition);
      if(!verified.valid)refuse("advance_conflict");}
    const events=rows.slice(0,limit).flatMap(row=>{const kind=HISTORY_VOCABULARY[row.action as keyof typeof HISTORY_VOCABULARY];
      if(!kind)return[];
      const metadata=row.safe_metadata&&typeof row.safe_metadata==="object"?row.safe_metadata as Record<string,unknown>:{};
      const reason=metadata.reasonCode;return[{id:row.id,kind,actorId:row.actor_id,actorType:row.actor_type,action:row.action,
        targetType:row.target_type,targetId:row.target_id,safeReason:typeof reason==="string"&&/^[a-z0-9._:-]{1,120}$/.test(reason)?reason:null,
        occurredAt:iso(row.occurred_at),chainPartition:row.chain_partition,chainSequence:safeInteger(row.chain_sequence),eventHash:row.event_hash}];});
    return pipelineHistorySchemaV1.parse({runId,projectId,events,truncated:rows.length>limit,chainVerified:true,
      observedAt:new Date(this.#now()).toISOString(),startsWork:false,grantsExecutionAuthority:false});
  }

  async #lockedSnapshot(tx:DatabaseSession,projectId:string,runId:string){
    const run=(await tx.query<RunRow>(`SELECT id,project_id,request_id,template_id,template_version,template_digest,workflow_id,title,
      state,started_at,updated_at,completed_at,current_stage_ordinal,unattended,record_digest,auth_tag,version FROM pipeline_runs
      WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,[this.scope.tenantId,projectId,runId])).rows[0];
    if(!run)refuse("advance_conflict");
    const template=(await tx.query<TemplateRow>(`SELECT id,project_id,name,description,stages,max_stages,max_total_loops,
      may_advance_unattended,max_duration_seconds,record_digest,auth_tag,version,created_at,updated_at FROM pipeline_templates
      WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,[this.scope.tenantId,projectId,run.template_id])).rows[0];
    const stages=(await tx.query<StageRow>(`SELECT project_id,pipeline_run_id,stage_ordinal,stage_kind,role,current_job_id,worker_id,
      worker_kind,node_id,selection_key,model,effort,provider,profile,current_attempt_id,current_lease_id,state,max_loops,
      handoff_from_result_digest,allowed_paths,maximum_changed_files,maximum_changed_bytes,
      signoff_review_id,started_at,finished_at,record_digest,auth_tag,version FROM pipeline_stage_runs
      WHERE tenant_id=$1 AND project_id=$2 AND pipeline_run_id=$3 ORDER BY stage_ordinal FOR UPDATE`,
    [this.scope.tenantId,projectId,runId])).rows;
    if(!template||stages.length!==3||stages.some((value,index)=>Number(value.stage_ordinal)!==index))refuse("pipeline_integrity_failed");
    return{run,template,stages};
  }
  #verifySnapshot(run:RunRow,template:TemplateRow,stages:StageRow[]){
    verify(this.#key,"pipeline-template/v1",templateMaterial(this.scope,template),template.record_digest,template.auth_tag);
    verify(this.#key,"pipeline-run/v1",runMaterial(this.scope,run),run.record_digest,run.auth_tag);
    for(const stage of stages) {
      const material = stageMaterial(this.scope,stage);
      if (sha256Digest(material) === stage.record_digest
        && same(hmacSha256Tag(this.#key,{purpose:"pipeline-stage-run/v1",record:material}),stage.auth_tag)) continue;
      const { allowedPaths: _paths, maximumChangedFiles: _files, maximumChangedBytes: _bytes, ...legacy } = material;
      if (stage.allowed_paths !== null || stage.maximum_changed_files !== null || stage.maximum_changed_bytes !== null
        || sha256Digest(legacy) !== stage.record_digest
        || !same(hmacSha256Tag(this.#key,{purpose:"pipeline-stage-run/v1",record:legacy}),stage.auth_tag))
        refuse("pipeline_integrity_failed");
    }
  }
  async #policy(tx:DatabaseSession,projectId:string,policyId:string){const row=(await tx.query<PolicyRow>(`SELECT id,project_id,
    coordinator_identity_id,coordinator_version,owner_identity_id,state,version,policy_digest,allowed_actions,eligible_routes,risk_ceiling,
    max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,valid_from,valid_until FROM control_project_delegation_policies
    WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,[this.scope.tenantId,projectId,policyId])).rows[0];
    if(!row)refuse("policy_inactive");return row;}
  #assertOwnerPolicyCurrent(policy:PolicyRow,now:string){if(policy.state!=="active"||millis(now)<millis(policy.valid_from)
    ||millis(now)>=millis(policy.valid_until))refuse("policy_inactive");const actions=strings(policy.allowed_actions);
    if(!actions.includes(ADVANCE_ACTION)||actions.includes("*"))refuse("policy_action_not_permitted");}
  #assertDelegation(policy:PolicyRow,receipt:PipelineDelegationReceiptV1,stage:StageRow,
    execution:ReturnType<typeof jobRecordSchema.parse>,now:number){
    this.#assertOwnerPolicyCurrent(policy,new Date(now).toISOString());
    if(receipt.policyId!==policy.id||receipt.policyVersion!==Number(policy.version)||receipt.policyDigest!==policy.policy_digest
      ||receipt.coordinatorVersion!==Number(policy.coordinator_version)||receipt.ownerIdentityId!==policy.owner_identity_id
      ||receipt.action!==ADVANCE_ACTION
      ||receipt.executorId!==stage.worker_id||!strings(policy.eligible_routes).includes(receipt.routeId))refuse("policy_route_mismatch");
    if(RISK[execution.authority.maxRisk]>RISK[policy.risk_ceiling])refuse("policy_risk_exceeded");
    if(safeInteger(receipt.taskUnits)>=safeInteger(policy.max_total_tasks))refuse("policy_task_allowance_exhausted");
    if(safeInteger(receipt.concurrentTasks)>=safeInteger(policy.max_concurrent_tasks))refuse("policy_concurrency_exhausted");
    const currentCost=receipt.nextCost;if(currentCost.kind!=="known")throw new PipelineAdvanceErrorV1("policy_cost_unknown");
    const spent=safeInteger(receipt.committedCostMicroUsd),next=safeInteger(currentCost.microUsd),
      ceiling=safeInteger(policy.max_total_cost_microusd);
    if(spent>ceiling||next>ceiling-spent)refuse("policy_cost_allowance_exhausted");}
  async #job(tx:DatabaseSession,run:RunRow,id:string,stage:StageRow,source:boolean){const row=(await tx.query<{payload:unknown;
    project_id:string;workflow_id:string;pipeline_run_id:string|null;stage_kind:string|null;stage_ordinal:number|null}>(`SELECT payload,
    project_id,workflow_id,pipeline_run_id,stage_kind,stage_ordinal FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR SHARE`,
    [this.scope.tenantId,run.project_id,id])).rows[0];if(!row)refuse("advance_conflict");const job=jobRecordSchema.parse(row.payload);
    if(job.id!==id||job.projectId!==run.project_id||job.workflowId!==run.workflow_id||row.project_id!==run.project_id
      ||row.pipeline_run_id!==run.id||row.stage_kind!==stage.stage_kind||Number(row.stage_ordinal)!==Number(stage.stage_ordinal))refuse("advance_conflict");
    if(source&&id!==stage.current_job_id)refuse("advance_conflict");return job;}
  async #receipt(tx:DatabaseSession,runId:string,ordinal:number){return(await tx.query<AdvanceReceiptRow>(`SELECT id,project_id,pipeline_run_id,
    stage_ordinal,source_job_id,execution_job_id,attempt_id,queue_id,selection_digest,template_version,template_digest,run_version,
    run_digest,policy_id,policy_version,policy_digest,delegation_receipt_id,delegation_receipt_digest,delegation_task_units,
    delegation_cost_microusd,delegation_cost_evidence_digest,request_digest,receipt_digest,
    auth_tag,advanced_at FROM pipeline_advance_receipts WHERE tenant_id=$1 AND pipeline_run_id=$2 AND stage_ordinal=$3 FOR SHARE`,
    [this.scope.tenantId,runId,ordinal])).rows[0];}
  #replayReceipt(row:AdvanceReceiptRow,selection:PipelineAdvanceSelectionV1,policyId:string){const material={id:row.id,
    tenantId:this.scope.tenantId,projectId:row.project_id,pipelineRunId:row.pipeline_run_id,stageOrdinal:Number(row.stage_ordinal),
    sourceJobId:row.source_job_id,executionJobId:row.execution_job_id,attemptId:row.attempt_id,queueId:row.queue_id,
    selectionDigest:row.selection_digest,templateVersion:Number(row.template_version),templateDigest:row.template_digest,
    runVersion:Number(row.run_version),runDigest:row.run_digest,policyId:row.policy_id,policyVersion:Number(row.policy_version),
    policyDigest:row.policy_digest,delegationReceiptId:row.delegation_receipt_id,delegationReceiptDigest:row.delegation_receipt_digest,
    delegationTaskUnits:safeInteger(row.delegation_task_units),delegationCostMicroUsd:safeInteger(row.delegation_cost_microusd),
    delegationCostEvidenceDigest:row.delegation_cost_evidence_digest,
    requestDigest:row.request_digest,advancedAt:iso(row.advanced_at)};
    verify(this.#key,"pipeline-advance-receipt/v1",material,row.receipt_digest,row.auth_tag);
    if(row.policy_id!==policyId||row.source_job_id!==selection.sourceJobId||row.execution_job_id!==selection.executionJobId
      ||row.selection_digest!==sha256Digest(selection))refuse("advance_conflict");
    return pipelineAdvanceReceiptSchemaV1.parse({runId:row.pipeline_run_id,stageOrdinal:Number(row.stage_ordinal),jobId:row.execution_job_id,
      attemptId:row.attempt_id,queueId:row.queue_id,replayed:true,advancedAt:iso(row.advanced_at),startsWork:true,
      grantsExecutionAuthority:false,claimsCancellation:false});}
  #now(){const now=this.clock();if(!Number.isSafeInteger(now)||now<0)refuse("deadline_reached");return now;}
  #assertInstall(){if(!this.#enabled()||!this.#capability)refuse("unattended_disabled");}
}
