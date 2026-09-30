import { randomUUID, timingSafeEqual } from "node:crypto";
import { AuditStore, appendAuditWith } from "../../audit/audit-store";
import { jobRecordSchema } from "../../domain/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebAccessError } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import { linearPipelineTemplateInputSchemaV1, pipelineAdvanceReceiptSchemaV1, pipelineBuildWritePolicySchemaV1, pipelineHistorySchemaV1,
  pipelineInstallationAllowanceInputSchemaV1, pipelineInstallationAllowanceReceiptSchemaV1, pipelineTerminalReceiptSchemaV1,
  pipelineUnattendedTransitionReceiptSchemaV1, pipelineUnattendedTransitionSchemaV1,
  type PipelineAdvanceReceiptV1, type PipelineHistoryV1, type PipelineInstallationAllowanceInputV1,
  type PipelineInstallationAllowanceReceiptV1, type PipelineTerminalReceiptV1 } from "./schemas";
import { PIPELINE_ALLOWANCE_DEFAULTS_V1, PIPELINE_MACHINE_CEILING_V1, allowanceReceiptV1,
  latestClusterObservationV1, parseAllowanceInputV1, pipelineAllowanceDigestV1, pipelineAllowanceMaterialV1,
  pipelineAllowanceTagV1, type PipelineAllowanceReasonCodeV1, type PipelineAllowanceRowV1 } from "./installation-allowance";
import { pipelineStageMaterialV1 } from "./stage-material";
import { pipelineEffectiveMaxLoopsV1, pipelineEffectiveMaxTotalLoopsV1, pipelineLoopAttentionItemV1,
  pipelineLoopCountDigestV1, pipelineLoopCountMaterialV1, pipelineLoopCountTagV1 } from "./loop-counts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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
  | "pipeline_integrity_failed" | "stage_loop_limit_reached" | "run_loop_limit_reached"
  | PipelineAllowanceReasonCodeV1;
/** Every installation ceiling, with the plain reason code the owner sees. One
 * vocabulary for the runs-per-hour, per-agent-per-day, machine and loop caps,
 * so a refusal never says "quota" and never reads as a lost error. */
export const PIPELINE_ALLOWANCE_SAFE_REASONS_V1 = Object.freeze([
  "installation_allowance_missing", "installation_runs_per_hour_exhausted",
  "installation_agent_runs_per_day_exhausted", "installation_agent_process_ceiling_reached",
  "installation_db_cluster_ceiling_reached", "installation_cluster_count_unknown",
  "installation_cost_ceiling_exhausted", "stage_loop_limit_reached", "run_loop_limit_reached",
] as const);
export type PipelineAllowanceSafeReasonV1 = (typeof PIPELINE_ALLOWANCE_SAFE_REASONS_V1)[number];
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
  allowed_paths: unknown|null; maximum_changed_files: number|string|null; maximum_changed_bytes: number|string|null;
  started_at: string|Date|null; finished_at: string|Date|null; record_digest: string; auth_tag: string; version: number };
type PolicyRow = { id: string; project_id: string; coordinator_identity_id: string; coordinator_version: number|string;
  owner_identity_id: string; state: string; version: number|string; policy_digest: string; allowed_actions: unknown; eligible_routes: unknown;
  risk_ceiling: keyof typeof RISK; max_total_tasks: number|string; max_total_cost_microusd: number|string;
  max_concurrent_tasks: number|string; valid_from: string|Date; valid_until: string|Date };
type AdvanceReceiptRow = { id: string; project_id: string; pipeline_run_id: string; stage_ordinal: number;
  loop_index: number | string;
  source_job_id: string; execution_job_id: string; attempt_id: string; queue_id: string; selection_digest: string;
  template_version: number; template_digest: string; run_version: number; run_digest: string; policy_id: string;
  policy_version: number|string; policy_digest: string; delegation_receipt_id: string; delegation_receipt_digest: string;
  delegation_task_units:number|string; delegation_cost_microusd:number|string|null; delegation_cost_state:"known"|"unknown";
  delegation_cost_evidence_digest:string|null;
  request_digest: string; receipt_digest: string; auth_tag: string; advanced_at: string|Date };
type LoopCountRow = { id: string; pipeline_run_id: string; stage_ordinal: number|string; worker_id: string;
  loop_index: number|string; max_loops: number|string; max_total_loops: number|string;
  run_total_loops: number|string; reason_code: string; receipt_id: string; receipt_digest: string;
  request_digest: string; auth_tag: string; recorded_at: string|Date };
type UsageRow = { runs_this_hour: string|number; agent_runs_today: string|number;
  active_agent_processes: string|number; spent_microusd: string|number };
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
const stageMaterial = (scope: { tenantId: string }, row: StageRow) =>
  pipelineStageMaterialV1(scope, row as Parameters<typeof pipelineStageMaterialV1>[1]);
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
        FROM pipeline_unattended_transitions WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3`,
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
      const { run, template, stages } = await this.#lockedSnapshot(tx, projectId, parsed.data.runId, true);
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
      // `version` is bigint, so `pg` returns it as a STRING unless a parser is
      // registered. The digest and tag below are taken over `nextTemplate.version`
      // and `nextRun.version` as they stand, and every reader of this record
      // rebuilds it with `Number(...)` -- `advance`'s consent check, the sweep's,
      // and this method's own replay. Signing a string and verifying a number
      // never matches, so the consent was unverifiable and `advance` refused
      // with `pipeline_integrity_failed`: a run the owner disabled could never be
      // resumed, and a run on an ALREADY-enabled template could never be started
      // unattended at all (only the activating branch above produces a number,
      // which is why the unit lane's fake database -- one that returns numbers --
      // never saw it). `templateMaterial` and `runMaterial` already normalise
      // these for the same reason; the consent must agree with them.
      const consentTemplateVersion = Number(nextTemplate.version), consentRunVersion = Number(nextRun.version);
      if (!Number.isSafeInteger(consentTemplateVersion) || consentTemplateVersion < 1
        || !Number.isSafeInteger(consentRunVersion) || consentRunVersion < 1) refuse("pipeline_integrity_failed");
      const material = { id: transitionId, tenantId: this.scope.tenantId, projectId, pipelineRunId: run.id,
        pipelineTemplateId: template.id, templateVersion: consentTemplateVersion, templateDigest: nextTemplateDigest,
        runVersion: consentRunVersion, runDigest: nextRunDigest, policyId: policy.id, policyVersion: Number(policy.version),
        policyDigest: policy.policy_digest, ownerIdentityId: actor.id, enabled: parsed.data.enabled, idempotencyKey,
        requestDigest, occurredAt: now };
      const transitionDigest = sha256Digest(material), authTag = hmacSha256Tag(this.#key,
        { purpose: "pipeline-unattended-transition/v1", record: material });
      await tx.query(`INSERT INTO pipeline_unattended_transitions(id,tenant_id,project_id,pipeline_run_id,pipeline_template_id,
        template_version,template_digest,run_version,run_digest,policy_id,policy_version,policy_digest,owner_identity_id,enabled,
        idempotency_key,request_digest,transition_digest,auth_tag,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,$18,$19)`, [transitionId,this.scope.tenantId,projectId,run.id,template.id,consentTemplateVersion,
        nextTemplateDigest,consentRunVersion,nextRunDigest,policy.id,Number(policy.version),policy.policy_digest,actor.id,
        parsed.data.enabled,idempotencyKey,requestDigest,transitionDigest,authTag,now]);
      await appendAuditWith(tx, { id:`audit:${transitionId}`,...this.scope,projectId,actorId:actor.id,actorType:"human",
        action: parsed.data.enabled ? "pipelines.unattended.enabled" : "pipelines.unattended.disabled",
        targetType:"pipeline_run",targetId:run.id,idempotencyKey,occurredAt:now,
        safeMetadata:{transitionId,policyId:policy.id,enabled:parsed.data.enabled} });
      return pipelineUnattendedTransitionReceiptSchemaV1.parse({ transitionId,runId:run.id,templateId:template.id,
        policyId:policy.id,enabled:parsed.data.enabled,runVersion:Number(nextRun.version),
        templateVersion:Number(nextTemplate.version),
        occurredAt:now,replayed:false,startsWork:false,grantsExecutionAuthority:false });
    });
  }

  async advance(runId: string, policyId: string, expectedConsent?:Readonly<{id:string;digest:string}>): Promise<PipelineAdvanceReceiptV1|PipelineTerminalReceiptV1> {
    const capability = this.#capability;
    if (!this.#enabled() || capability === undefined) throw new PipelineAdvanceErrorV1("unattended_disabled");
    // A loop stop and the owner's Needs Attention item are recorded in their own
    // committed transaction BEFORE the advance transaction opens, so the stop
    // survives the refusal. The count is the immutable job chain; the advance
    // transaction re-reads it under the run lock and refuses again if it moved.
    await this.#precheckLoopStop(runId);
    let precommit: () => void|Promise<void> = () => this.#assertInstall();
    return this.db.transactionWithPreCommitCheck(async tx => {
      this.#assertInstall();
      const locator = (await tx.query<{ project_id:string }>(`SELECT project_id FROM pipeline_runs WHERE tenant_id=$1 AND id=$2`,
        [this.scope.tenantId,runId])).rows[0]; if (!locator) refuse("advance_conflict");
      const { run, template, stages } = await this.#lockedSnapshot(tx, locator.project_id, runId, false);
      this.#verifySnapshot(run,template,stages);
      const consent=(await tx.query<UnattendedTransitionRow>(`SELECT id,project_id,pipeline_run_id,pipeline_template_id,
        template_version,template_digest,run_version,run_digest,policy_id,policy_version,policy_digest,owner_identity_id,enabled,
        idempotency_key,request_digest,transition_digest,auth_tag,occurred_at FROM pipeline_unattended_transitions
        WHERE tenant_id=$1 AND project_id=$2 AND pipeline_run_id=$3 ORDER BY run_version DESC,id DESC LIMIT 1`,
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
        // The round a REPLAY lands on is that SOURCE job's own receipt: a fix round
        // is a new source job and the stage's `current_job_id` moves with it, so
        // the receipt a job already wrote is found by that job, not by counting.
        const round = await this.#stageRound(tx,run.id,Number(candidate.stage_ordinal),
          candidate.current_job_id);
        const prior = await this.#receipt(tx,run.id,candidate.stage_ordinal,round);
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
        WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3`,[this.scope.tenantId,run.project_id,execution.id])).rows[0];
      if (!plan || plan.source_job_id!==source.id) refuse("advance_conflict");
      if (selected.stageOrdinal>0) { const predecessor=stages[selected.stageOrdinal-1]; if (!predecessor) refuse("dependency_not_accepted");
        try { await capability.assertAcceptedPredecessorInSession(tx,{tenantId:this.scope.tenantId,projectId:run.project_id,
          runId:run.id,predecessorJobId:predecessor.current_job_id,successorJobId:source.id}); }
        catch { refuse("dependency_not_accepted"); } }
      await Promise.resolve(capability.assertSelectionCurrentInSession(tx,selected)).catch(()=>refuse("selection_not_current"));
      const policy=await this.#policy(tx,run.project_id,policyId);
      if(Number(consent.policy_version)!==Number(policy.version)||consent.policy_digest!==policy.policy_digest)
        refuse("unattended_not_authorized");
      // The loop ceilings and the installation allowance are both claimed here,
      // in the SAME transaction that inserts the advance receipt below: a check
      // and its claim commit together or not at all, so two concurrent advances
      // can never both see the last unit of a ceiling as free.
      const loop=await this.#claimLoopRound(tx,run,stage,template,source.id);
      const delegation=await capability.authorizeDelegationInSession(tx,selected,policyId);
      const nextCost=delegation.nextCost;
      const allowance=await this.#claimInstallationAllowance(tx,loop.workerId,
        nextCost.kind==="known"?nextCost.microUsd:null);
      this.#assertDelegation(policy,delegation,stage,execution,this.#now(),allowance.cost);
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
        idempotencyKey:`pipeline-advance:${run.id}:${selected.stageOrdinal}:${loop.loopIndex}`,
        commitDeadline:deadline},
      {actorId:SERVICE_ACTOR,assertCurrent:authenticate,commitDeadline:value=>{
        if(!Number.isSafeInteger(value)||value<0)refuse("deadline_reached");deadline=Math.min(deadline,value);
      }}).catch((error:unknown)=>{if(error instanceof PipelineAdvanceErrorV1)throw error;
        return refuse("execution_authority_missing");});
      await authenticate();
      // The receipt is per fix round, so a re-entered stage has its own durable
      // record and a replay of the same job lands on the same row. The round is
      // the one `#claimLoopRound` already claimed and compared, so the receipt's
      // key and the counted round can never disagree.
      const advancedAt=new Date(this.#now()).toISOString(),roundIndex=loop.loopIndex,
        receiptId=`pipeline-advance:${run.id}:${selected.stageOrdinal}:${roundIndex}`;
      // "Count runs, never dollars": an unknown cost is recorded as unknown, with
      // no invented number and no refusal. The pairing check in 0152 refuses any
      // other combination of the three cost columns.
      const costKnown=nextCost.kind==="known";
      const material={id:receiptId,tenantId:this.scope.tenantId,projectId:run.project_id,pipelineRunId:run.id,
        stageOrdinal:selected.stageOrdinal,loopIndex:roundIndex,sourceJobId:source.id,executionJobId:execution.id,attemptId:effect.attemptId,
        queueId:effect.queueId,selectionDigest,templateVersion:Number(template.version),templateDigest:template.record_digest,
        runVersion:Number(effectiveRun.version),runDigest:effectiveRun.record_digest,policyId:policy.id,policyVersion:Number(policy.version),
        policyDigest:policy.policy_digest,delegationReceiptId:delegation.receiptId,
        delegationReceiptDigest:delegation.receiptDigest,delegationTaskUnits:1,
        delegationCostState:costKnown?"known":"unknown",
        delegationCostMicroUsd:costKnown?nextCost.microUsd:null,
        delegationCostEvidenceDigest:costKnown?nextCost.evidenceDigest:null,
        requestDigest,advancedAt};
      const receiptDigest=sha256Digest(material),authTag=hmacSha256Tag(this.#key,{purpose:"pipeline-advance-receipt/v1",record:material});
      await tx.query(`INSERT INTO pipeline_advance_receipts(id,tenant_id,project_id,pipeline_run_id,stage_ordinal,loop_index,
        source_job_id,execution_job_id,attempt_id,queue_id,selection_digest,template_version,template_digest,run_version,run_digest,
        policy_id,policy_version,policy_digest,delegation_receipt_id,delegation_receipt_digest,delegation_task_units,
        delegation_cost_state,delegation_cost_microusd,delegation_cost_evidence_digest,request_digest,receipt_digest,auth_tag,advanced_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
      [receiptId,this.scope.tenantId,run.project_id,run.id,selected.stageOrdinal,roundIndex,source.id,execution.id,effect.attemptId,effect.queueId,
        selectionDigest,template.version,template.record_digest,effectiveRun.version,effectiveRun.record_digest,policy.id,Number(policy.version),
        policy.policy_digest,delegation.receiptId,delegation.receiptDigest,1,material.delegationCostState,
        material.delegationCostMicroUsd,material.delegationCostEvidenceDigest,requestDigest,receiptDigest,authTag,advancedAt]);
      // The counted round is appended against the receipt that opened it, in the
      // same transaction, so the loop count can never disagree with the run.
      await this.#appendLoopCount(tx,run,loop,requestDigest,receiptId,receiptDigest,advancedAt);
      await appendAuditWith(tx,{id:`audit:${receiptId}`,...this.scope,projectId:run.project_id,actorId:SERVICE_ACTOR,actorType:"service",
        action:"pipelines.stage.advanced",targetType:"pipeline_run",targetId:run.id,correlationId:execution.id,
        idempotencyKey:receiptId,occurredAt:advancedAt,safeMetadata:{stageOrdinal:selected.stageOrdinal,sourceJobId:source.id,
          executionJobId:execution.id,attemptId:effect.attemptId,queueId:effect.queueId,policyId:policy.id,receiptDigest}});
      return pipelineAdvanceReceiptSchemaV1.parse({runId:run.id,stageOrdinal:selected.stageOrdinal,jobId:execution.id,
        attemptId:effect.attemptId,queueId:effect.queueId,replayed:false,advancedAt,startsWork:true,
        grantsExecutionAuthority:false,claimsCancellation:false});
    },()=>precommit());
  }

  /** The owner sets this installation's one allowance record. It carries no
   * project scope: these are whole-machine ceilings for unattended work, and
   * they are checked in the same transaction as every advance receipt. */
  async setAllowance(identity: VerifiedWebIdentity, value: unknown): Promise<PipelineInstallationAllowanceReceiptV1> {
    const parsed = pipelineInstallationAllowanceInputSchemaV1.safeParse(value);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    const input: PipelineInstallationAllowanceInputV1 = parseAllowanceInputV1(parsed.data);
    // The product's own review ceiling. A stored column may allow more; an
    // unattended night may not run above these.
    if (input.machineMaxAgentProcesses > PIPELINE_MACHINE_CEILING_V1.agentProcesses
      || input.machineMaxDbClusters > PIPELINE_MACHINE_CEILING_V1.dbClusters)
      throw new WebAccessError("invalid_request");
    return this.#owner.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.assign", undefined, true);
      const owner = (await tx.query<{ id: string }>(`SELECT g.id FROM control_role_grants g JOIN control_identities i
        ON i.tenant_id=g.tenant_id AND i.id=g.identity_id WHERE g.tenant_id=$1 AND g.identity_id=$2 AND g.role_key='owner'
        AND g.revoked_at IS NULL AND i.state='active' FOR SHARE OF g,i`, [this.scope.tenantId, actor.id])).rows[0];
      if (!owner) throw new WebAccessError("access_denied");
      const now = actor.now;
      const existing = await this.#allowanceRow(tx, false);
      const version = existing ? Number(existing.version) + 1 : 1;
      const material = pipelineAllowanceMaterialV1(this.scope, { runs_per_hour: input.runsPerHour,
        runs_per_agent_per_day: input.runsPerAgentPerDay, machine_max_agent_processes: input.machineMaxAgentProcesses,
        machine_max_db_clusters: input.machineMaxDbClusters, dollar_cap_microusd: input.dollarCapMicroUsd,
        owner_identity_id: actor.id, version, updated_at: now });
      const digest = pipelineAllowanceDigestV1(material), tag = pipelineAllowanceTagV1(this.#key, material);
      if (existing) {
        const changed = await tx.query<{ version: number | string; record_digest: string; auth_tag: string }>(
          `UPDATE pipeline_installation_allowances SET runs_per_hour=$1,runs_per_agent_per_day=$2,
            machine_max_agent_processes=$3,machine_max_db_clusters=$4,dollar_cap_microusd=$5,owner_identity_id=$6,
            version=$7,record_digest=$8,auth_tag=$9,updated_at=$10
          WHERE tenant_id=$11 AND workspace_id=$12 AND version=$13 RETURNING version,record_digest,auth_tag`,
          [input.runsPerHour, input.runsPerAgentPerDay, input.machineMaxAgentProcesses, input.machineMaxDbClusters,
            input.dollarCapMicroUsd, actor.id, version, digest, tag, now, this.scope.tenantId, this.scope.workspaceId,
            existing.version]);
        if (changed.rows.length !== 1 || Number(changed.rows[0]?.version) !== version
          || changed.rows[0]?.record_digest !== digest || changed.rows[0]?.auth_tag !== tag)
          refuse("advance_conflict");
      } else {
        await tx.query(`INSERT INTO pipeline_installation_allowances(tenant_id,workspace_id,runs_per_hour,
          runs_per_agent_per_day,machine_max_agent_processes,machine_max_db_clusters,dollar_cap_microusd,owner_identity_id,
          version,record_digest,auth_tag,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [this.scope.tenantId, this.scope.workspaceId, input.runsPerHour, input.runsPerAgentPerDay,
            input.machineMaxAgentProcesses, input.machineMaxDbClusters, input.dollarCapMicroUsd, actor.id,
            version, digest, tag, now]);
      }
      const row = await this.#allowanceRow(tx, true);
      if (!row) refuse("advance_conflict");
      this.#verifyAllowance(row);
      // The owner's cluster count is recorded in the same transaction as the
      // ceilings it is judged against, so the record is never older than the
      // limits that use it.
      await tx.query(`INSERT INTO pipeline_machine_capacity_observations(id,tenant_id,workspace_id,source,db_clusters,
        observed_at) VALUES($1,$2,$3,'owner_reported',$4,$5) ON CONFLICT DO NOTHING`,
      [`machine-capacity:${sha256Digest({ tenantId:this.scope.tenantId, workspaceId:this.scope.workspaceId, now })}`,
        this.scope.tenantId, this.scope.workspaceId, input.observedDbClusters, now]);
      const observed = await this.#clusterObservation(tx);
      // The audit id is globally unique, so it carries the installation: two
      // installations each setting version 1 must not collide.
      await appendAuditWith(tx, { id: `audit:pipeline-allowance:${this.scope.tenantId}:${version}`, ...this.scope,
        projectId: undefined, actorId: actor.id, actorType: "human", action: "pipelines.allowance.set",
        targetType: "workspace", targetId: this.scope.workspaceId, idempotencyKey: `pipeline-allowance:${version}`,
        occurredAt: now, safeMetadata: { allowanceVersion: version, runsPerHour: input.runsPerHour,
          runsPerAgentPerDay: input.runsPerAgentPerDay, machineMaxAgentProcesses: input.machineMaxAgentProcesses,
          machineMaxDbClusters: input.machineMaxDbClusters, dollarCapMicroUsd: input.dollarCapMicroUsd,
          observedDbClusters: input.observedDbClusters } });
      return allowanceReceiptV1({ row, replayed: false, recordedDbClusters: observed.dbClusters,
        recordedDbClustersAt: observed.observedAt });
    });
  }

  /** The owner reads the current ceilings, or the shipped defaults when no
   * record exists yet. It starts no work and grants no authority. */
  async allowance(): Promise<PipelineInstallationAllowanceReceiptV1> {
    const row = await this.#allowanceRow(this.db, false);
    const observed = await this.#clusterObservation(this.db);
    if (!row) return pipelineInstallationAllowanceReceiptSchemaV1.parse({ allowanceVersion: 0,
      ...PIPELINE_ALLOWANCE_DEFAULTS_V1, recordedDbClusters: observed.dbClusters,
      recordedDbClustersAt: observed.observedAt, updatedAt: new Date(this.#now()).toISOString(), replayed: false,
      startsWork: false, grantsExecutionAuthority: false });
    this.#verifyAllowance(row);
    return allowanceReceiptV1({ row, replayed: true, recordedDbClusters: observed.dbClusters,
      recordedDbClustersAt: observed.observedAt });
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

  /** Authenticated owner projection, and the only history entrypoint: the
   * caller must prove both current project read access and the current tenant
   * owner grant before any lineage is read. */
  async historyForOwner(identity: VerifiedWebIdentity, projectId:string, runId:string, limit=100):Promise<PipelineHistoryV1>{
    return this.#owner.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const owner = (await tx.query<{ id:string }>(`SELECT g.id FROM control_role_grants g JOIN control_identities i
        ON i.tenant_id=g.tenant_id AND i.id=g.identity_id WHERE g.tenant_id=$1 AND g.identity_id=$2 AND g.role_key='owner'
        AND g.revoked_at IS NULL AND i.state='active' FOR SHARE OF g,i`, [this.scope.tenantId,actor.id])).rows[0];
      if (!owner) throw new WebAccessError("access_denied");
      return readPipelineHistoryInSessionV1(tx,this.scope.tenantId,projectId,runId,limit,this.#now());
    });
  }

  async #lockedSnapshot(tx:DatabaseSession,projectId:string,runId:string,lockTemplate:boolean){
    const run=(await tx.query<RunRow>(`SELECT id,project_id,request_id,template_id,template_version,template_digest,workflow_id,title,
      state,started_at,updated_at,completed_at,current_stage_ordinal,unattended,record_digest,auth_tag,version FROM pipeline_runs
      WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,[this.scope.tenantId,projectId,runId])).rows[0];
    if(!run)refuse("advance_conflict");
    const template=(await tx.query<TemplateRow>(`SELECT id,project_id,name,description,stages,max_stages,max_total_loops,
      may_advance_unattended,max_duration_seconds,record_digest,auth_tag,version,created_at,updated_at FROM pipeline_templates
      WHERE tenant_id=$1 AND project_id=$2 AND id=$3${lockTemplate ? " FOR UPDATE" : ""}`,
    [this.scope.tenantId,projectId,run.template_id])).rows[0];
    const stages=(await tx.query<StageRow>(`SELECT project_id,pipeline_run_id,stage_ordinal,stage_kind,role,current_job_id,worker_id,
      worker_kind,node_id,selection_key,model,effort,provider,profile,current_attempt_id,current_lease_id,state,max_loops,
      handoff_from_result_digest,allowed_paths,maximum_changed_files,maximum_changed_bytes,
      signoff_review_id,started_at,finished_at,record_digest,auth_tag,version FROM pipeline_stage_runs
      WHERE tenant_id=$1 AND project_id=$2 AND pipeline_run_id=$3 ORDER BY stage_ordinal`,
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
  /** The one signed allowance record, locked for the duration of the advance
   * transaction. A missing record is a refusal, not a default: an installation
   * that never set its ceilings must not start unattended work silently. */
  async #allowanceRow(db: DatabaseClient | DatabaseSession, lock: boolean) {
    return (await db.query<PipelineAllowanceRowV1>(`SELECT runs_per_hour,runs_per_agent_per_day,
      machine_max_agent_processes,machine_max_db_clusters,dollar_cap_microusd,version,owner_identity_id,
      record_digest,auth_tag,updated_at FROM pipeline_installation_allowances
      WHERE tenant_id=$1 AND workspace_id=$2${lock?" FOR UPDATE":""}`,
    [this.scope.tenantId,this.scope.workspaceId])).rows[0];
  }
  #verifyAllowance(row: PipelineAllowanceRowV1) {
    const material = pipelineAllowanceMaterialV1(this.scope,row);
    if (sha256Digest(material)!==row.record_digest
      || !same(hmacSha256Tag(this.#key,{purpose:"pipeline-installation-allowance/v1",record:material}),row.auth_tag))
      refuse("pipeline_integrity_failed");
  }
  async #clusterObservation(db: DatabaseClient | DatabaseSession) {
    const row = (await db.query<{ db_clusters: number | string; observed_at: string | Date }>(
      `SELECT db_clusters,observed_at FROM pipeline_machine_capacity_observations
        WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY observed_at DESC,id DESC LIMIT 1`,
      [this.scope.tenantId,this.scope.workspaceId])).rows[0];
    return latestClusterObservationV1(row,this.#now());
  }

  /** Every ceiling, counted and claimed in this transaction. The counts come
   * from the loop-count rows this transaction is about to append, plus the
   * rows it already committed: the check and the claim are the same statement
   * pair against the same locked record, so a concurrent advance waits here
   * and then sees the first one's count. */
  async #claimInstallationAllowance(tx: DatabaseSession, workerId: string, nextCostMicroUsd: number | null) {
    const row = await this.#allowanceRow(tx, true);
    if (!row) refuse("installation_allowance_missing");
    this.#verifyAllowance(row);
    const now = this.#now();
    const usage = (await tx.query<UsageRow>(`SELECT
      (SELECT COUNT(*) FROM pipeline_advance_receipts WHERE tenant_id=$1
        AND advanced_at > $2::timestamptz - interval '1 hour')::text AS runs_this_hour,
      (SELECT COUNT(*) FROM pipeline_advance_receipts r JOIN pipeline_stage_runs s
        ON s.tenant_id=r.tenant_id AND s.pipeline_run_id=r.pipeline_run_id AND s.stage_ordinal=r.stage_ordinal
        WHERE r.tenant_id=$1 AND s.worker_id=$3
        AND r.advanced_at > $2::timestamptz - interval '1 day')::text AS agent_runs_today,
      -- A process this machine is already running. A lease and a queue row, not a
      -- harness run: a worker mints the harness run when it picks the work up,
      -- so counting only harness runs let successive sweeps each see the same
      -- live count and queue past the ceiling until a worker started them. This
      -- counts the two: a live harness run, OR an execution job that has been
      -- claimed and is still waiting to be started.
      --
      -- The second term must be exactly "claimed and not yet running", and the
      -- job's own state is the only honest evidence of that. It once read
      -- "no LIVE harness run", which is not the same question: a stage whose
      -- harness run has since SUCCEEDED, failed, was cancelled or disconnected
      -- has no live harness run, so every stage the installation ever advanced
      -- held a process slot for the rest of the installation's life. Receipts
      -- are never deleted, so at the default ceiling of 12 unattended pipelines
      -- stopped for good after 12-24 stage advances. Counting the job's state
      -- instead means the slot is freed the moment the work is done -- finished
      -- or cancelled -- which is what "a running agent process" means, and it
      -- also frees a job cancelled before a worker ever picked it up.
      -- The two terms cannot double count: this one requires NO harness run of
      -- ANY state, so a job with a live harness run is counted only by the
      -- first term. The join is an inner one and can never drop a receipt:
      -- pipeline_advance_receipts.execution_job_id has a foreign key to
      -- control_jobs (0109), so every receipt's job exists and every claimed
      -- stage is counted by exactly one of the two terms. A LEFT JOIN here
      -- would be fail-OPEN: an unjoinable receipt would count as nothing.
      ((SELECT COUNT(DISTINCT id) FROM control_harness_runs WHERE tenant_id=$1
        AND state IN('discovered','starting','running','waiting_input','waiting_approval','cancelling'))
        + (SELECT COUNT(DISTINCT r.execution_job_id) FROM pipeline_advance_receipts r
        JOIN control_jobs j ON j.tenant_id=r.tenant_id AND j.id=r.execution_job_id
        WHERE r.tenant_id=$1
        AND j.state IN('proposed','ready','leased','running','waiting_approval')
        AND NOT EXISTS(SELECT 1 FROM control_harness_runs h
          WHERE h.tenant_id=r.tenant_id AND h.job_id=r.execution_job_id)))::text
        AS active_agent_processes,
      (SELECT COALESCE(SUM(delegation_cost_microusd),0) FROM pipeline_advance_receipts WHERE tenant_id=$1
        AND delegation_cost_state='known')::text AS spent_microusd`,
    [this.scope.tenantId,new Date(now).toISOString(),workerId])).rows[0];
    const runsThisHour = safeInteger(usage?.runs_this_hour ?? "0");
    const agentRunsToday = safeInteger(usage?.agent_runs_today ?? "0");
    const activeProcesses = safeInteger(usage?.active_agent_processes ?? "0");
    const spent = safeInteger(usage?.spent_microusd ?? "0");
    const runsPerHour = safeInteger(row.runs_per_hour);
    const runsPerAgentPerDay = safeInteger(row.runs_per_agent_per_day);
    const agentCeiling = Math.min(safeInteger(row.machine_max_agent_processes),PIPELINE_MACHINE_CEILING_V1.agentProcesses);
    const clusterCeiling = Math.min(safeInteger(row.machine_max_db_clusters),PIPELINE_MACHINE_CEILING_V1.dbClusters);
    // The next run is inside the hour only while the run that would be started
    // still fits under the ceiling: refuse AT the boundary, not past it.
    if (runsThisHour+1>runsPerHour) refuse("installation_runs_per_hour_exhausted");
    if (agentRunsToday+1>runsPerAgentPerDay) refuse("installation_agent_runs_per_day_exhausted");
    if (activeProcesses+1>agentCeiling) refuse("installation_agent_process_ceiling_reached");
    const observed = await this.#clusterObservation(tx);
    // A cluster count nobody has recorded, or one too old to be true, refuses.
    // An unknown machine state is never a pass.
    const dbClusters = observed.dbClusters;
    if (dbClusters === null) throw new PipelineAdvanceErrorV1("installation_cluster_count_unknown");
    if (dbClusters + 1 > clusterCeiling) refuse("installation_db_cluster_ceiling_reached");
    const cap = row.dollar_cap_microusd===null?null:safeInteger(row.dollar_cap_microusd);
    if (cap!==null&&nextCostMicroUsd!==null&&(spent>cap||nextCostMicroUsd>cap-spent))
      refuse("installation_cost_ceiling_exhausted");
    return { cost:{spent,cap,next:nextCostMicroUsd}, runsThisHour, agentRunsToday, activeProcesses,
      runsPerHour, runsPerAgentPerDay, agentCeiling, clusterCeiling, dbClusters };
  }

  /** The fix rounds that already exist, counted as DURABLE RECEIPTS rather than
   * jobs. The receipt is the one row the advance transaction itself appends
   * per round, under the run row lock, so a round cannot be counted twice and
   * cannot be invented by planning an extra job.
   *
   * Counting jobs was wrong, and the real planner proves it: a stage holds a
   * SOURCE job and a DISTINCT `job:execution:*` job per round (both carry
   * `stage_ordinal`), so a job count made a stage's first attempt look like
   * round 1 and stopped a signoff stage -- which is signed with `max_loops: 0`
   * -- before it had ever run. The receipt count is exactly "fix rounds this
   * stage has started", which is what `loop_index` and `max_loops` mean. */
  async #loopRounds(runId: string, projectId?: string) {
    return (await this.db.query<{ stage_ordinal: number | string; loop_index: number | string; source_job_id: string }>(
      `SELECT stage_ordinal,loop_index,source_job_id FROM pipeline_advance_receipts
      WHERE tenant_id=$1 AND pipeline_run_id=$2`, [this.scope.tenantId, runId])).rows;
  }

  /** The stage this run is on, its effective ceilings and the current count.
   * Read from the run's own row and the job chain, never from a counter this
   * service keeps. */
  async #loopCeilings(runId: string) {
    const locator = (await this.db.query<{ project_id: string }>(`SELECT project_id FROM pipeline_runs
      WHERE tenant_id=$1 AND id=$2`, [this.scope.tenantId, runId])).rows[0];
    if (!locator) return undefined;
    const rows = (await this.db.query<{ stage_ordinal: number | string; worker_id: string; max_loops: number | string;
      current_job_id: string; stage_kind: string; max_total_loops: number | string; run_version: number | string;
      run_digest: string }>(`SELECT s.stage_ordinal,s.worker_id,s.max_loops,s.current_job_id,s.stage_kind,
      t.max_total_loops,r.version run_version,r.record_digest run_digest
      FROM pipeline_runs r JOIN pipeline_templates t ON t.tenant_id=r.tenant_id AND t.id=r.template_id
      JOIN pipeline_stage_runs s ON s.tenant_id=r.tenant_id AND s.pipeline_run_id=r.id
        AND s.stage_ordinal=coalesce(r.current_stage_ordinal,0)
      WHERE r.tenant_id=$1 AND r.id=$2`, [this.scope.tenantId, runId])).rows;
    const stage = rows[0];
    if (!stage) return undefined;
    const rounds = await this.#loopRounds(runId, locator.project_id);
    const stageOrdinal = Number(stage.stage_ordinal);
    // `stageRounds` is the round THIS advance would be: the stage's own receipt
    // count, unless the stage's current source job already has one, in which
    // case this is a replay of that job and its round is that job's own. That is
    // exactly what `#stageRound` computes inside the transaction, so a replay of
    // an already-started round is never mistaken for a fresh round past the
    // ceiling. `runTotal` is the rounds the whole run has started, so the round
    // it would start is `runTotal + 1`. Both comparisons are `>`, the same two
    // `#claimLoopRound` makes.
    const stageRows = rounds.filter(row => Number(row.stage_ordinal) === stageOrdinal);
    const replay = stageRows.find(row => row.source_job_id === stage.current_job_id);
    const stageRounds = replay ? Number(replay.loop_index) : stageRows.length;
    return { projectId: locator.project_id, stage, stageOrdinal,
      maxLoops: pipelineEffectiveMaxLoopsV1(Number(stage.max_loops)),
      maxTotalLoops: pipelineEffectiveMaxTotalLoopsV1(Number(stage.max_total_loops)),
      stageRounds, runTotal: rounds.length };
  }

  /** A run that is already at a loop ceiling stops advancing, and the owner is
   * told once, in a committed transaction that is independent of the refusal it
   * causes. Repeating it is recognised by the item's id, so no copies pile up. */
  async #precheckLoopStop(runId: string) {
    const active = (await this.db.query<{ eligible: boolean }>(`SELECT EXISTS(SELECT 1 FROM pipeline_runs r
      WHERE r.tenant_id=$1 AND r.id=$2 AND r.state='active' AND r.unattended
        AND EXISTS(SELECT 1 FROM pipeline_unattended_transitions t WHERE t.tenant_id=r.tenant_id
          AND t.pipeline_run_id=r.id AND t.enabled)) AS eligible`,
    [this.scope.tenantId, runId])).rows[0];
    if (active?.eligible !== true) return;
    const current = await this.#loopCeilings(runId);
    if (!current) return;
    // `stageRounds` is the fix rounds this stage has started, so the round this
    // advance would start is `stageRounds`. `runTotal` is the rounds the run has
    // started, so the round it would start is `runTotal + 1`. Both comparisons
    // are `>` and are the same two comparisons `#claimLoopRound` makes, so the
    // pre-check and the in-transaction claim can never disagree by one.
    const nextRunTotal = current.runTotal + 1;
    const reasonCode = current.stageRounds > current.maxLoops
      ? "pipeline_stage_loop_limit_reached" as const
      : nextRunTotal > current.maxTotalLoops ? "pipeline_run_loop_limit_reached" as const : undefined;
    if (!reasonCode) return;
    const stage = { stage_ordinal: current.stageOrdinal, stage_kind: current.stage.stage_kind,
      worker_id: current.stage.worker_id } as unknown as StageRow;
    // The run ceiling is about the run, so it is checked against the run's own
    // round count whichever stage the run is on.
    const run = { id: runId, project_id: current.projectId, version: current.stage.run_version,
      record_digest: current.stage.run_digest } as unknown as RunRow;
    // The record is the LAST round this installation really ran, clamped inside
    // the ceiling it reached. It never claims a round that was refused and never
    // taken, which is exactly what the table's CHECK constraints assert: a stop
    // can sit at max_loops, never above it. The two numbers describe one
    // moment, and which moment depends on which ceiling was reached.
    //
    // A STAGE stop is about this stage's rounds, so it records this stage's
    // last STARTED round, clamped to the ceiling it reached, and a run total at
    // least that round plus one. A RUN stop is about the whole run, so it
    // records the run's own real total -- the number of rounds it started --
    // clamped inside the run ceiling, and the stage round that run was on.
    //
    // `loop_index` is the last round this stage STARTED and `run_total_loops` is
    // the number of rounds this run started; the table's three CHECKs say
    // exactly how they relate: `loop_index <= max_loops`,
    // `run_total_loops <= max_total_loops` and `run_total_loops >=
    // loop_index + 1`. A refused round was never started, so it never appears in
    // either number; each is clamped to the ceiling it stopped at.
    const stageStopped = reasonCode === "pipeline_stage_loop_limit_reached";
    const lastStartedRound = Math.min(current.stageRounds, current.maxLoops);
    // A stage stop still counts every round the run really started, so the
    // truthful run total is the run's own count, floored at this stage's last
    // started round plus one and capped at the run ceiling. A run stop uses the
    // same numbers, and the cap is the one the run reached.
    const lastRunTotal = stageStopped
      ? Math.min(current.maxTotalLoops, Math.max(current.runTotal, lastStartedRound + 1))
      : Math.min(current.maxTotalLoops, Math.max(lastStartedRound + 1, current.runTotal));
    // The attention item and the signed record of the ceiling decision commit
    // together, before the refusal, so "the run stopped and the owner was told"
    // is a fact rather than an attempt.
    await this.#recordLoopStop(run, stage, reasonCode, lastStartedRound, current.maxLoops,
      current.maxTotalLoops, lastRunTotal,
      sha256Digest({ schema: "control-room.pipeline-loop-decision/v1", runId, stageOrdinal: current.stageOrdinal,
        loopIndex: lastStartedRound, reasonCode }));
    refuse(reasonCode === "pipeline_stage_loop_limit_reached" ? "stage_loop_limit_reached" : "run_loop_limit_reached");
  }

  /** The counted fix round this advance is about to start, or the refusal that
   * stops it. `max_loops` and `max_total_loops` are compared here for the first
   * time in the product's life, against the durable receipts of the rounds the
   * run has already started.
   *
   * A stage's first attempt is round 0, so the index of the round this advance
   * starts is exactly the receipts this stage already has, with no "+1" and no
   * subtraction for a job that has not run yet. The run total is every receipt
   * the run holds, so a three-stage run that has never looped starts at 1, not at
   * 2, and a run ceiling of 0 or 1 cannot stop a run that has not run.
   *
   * This comparison is `>` on both ceilings, and it is the SAME comparison
   * `#precheckLoopStop` makes, so the two guards can never disagree by one. */
  async #claimLoopRound(tx: DatabaseSession, run: RunRow, stage: StageRow, template: TemplateRow,
    sourceJobId: string) {
    const stageOrdinal = Number(stage.stage_ordinal);
    const maxLoops = pipelineEffectiveMaxLoopsV1(safeInteger(stage.max_loops));
    const maxTotalLoops = pipelineEffectiveMaxTotalLoopsV1(safeInteger(template.max_total_loops));
    // The rounds this run has already started, read under the run row lock that
    // every advance takes first. The receipts are written in the same
    // transaction as the advance, so this cannot lag a round that committed.
    const rounds = (await tx.query<{ stage_ordinal: number | string }>(`SELECT stage_ordinal
      FROM pipeline_advance_receipts WHERE tenant_id=$1 AND pipeline_run_id=$2`,
    [this.scope.tenantId, run.id])).rows;
    // A stage's first attempt is round 0, so the index of the round this advance
    // starts is the receipts this stage already has -- the same count the replay
    // path uses to find a job's own receipt, so the round this guards, the round
    // the receipt is keyed on, and the round a replay lands on are one number.
    const loopIndex = await this.#stageRound(tx, run.id, stageOrdinal, sourceJobId);
    // `run_total_loops` on the counted row is "every round this run has started,
    // INCLUDING this one", so this advance's own figure is one more than the
    // receipts the run already holds. The table's CHECK caps that figure at
    // `max_total_loops`, which is what makes "a run may start `maxTotalLoops`
    // rounds" true rather than aspirational.
    const nextRunTotal = rounds.length + 1;
    // The pre-check already recorded the stop and told the owner, in a
    // transaction that committed before this one opened. Re-reading the receipts
    // here, under the run row lock, is what makes the decision honest: a run
    // that moved after the pre-check stops here too. This path only refuses,
    // because the refusal aborts this transaction and a write inside it would
    // roll the owner's attention item straight back out. A stop first seen here
    // is recorded by the next attempt's pre-check, which runs before any
    // transaction opens.
    if (loopIndex > maxLoops || nextRunTotal > maxTotalLoops) {
      const reasonCode = loopIndex > maxLoops
        ? "pipeline_stage_loop_limit_reached" as const : "pipeline_run_loop_limit_reached" as const;
      refuse(reasonCode === "pipeline_stage_loop_limit_reached" ? "stage_loop_limit_reached" : "run_loop_limit_reached");
    }
    return { stageOrdinal, workerId: stage.worker_id, loopIndex, maxLoops, maxTotalLoops, runTotalLoops: nextRunTotal };
  }

  /** The ceiling decision, its count row and the owner's Needs Attention item,
   * committed together. The count row is the signed receipt of what the ceiling
   * was compared against; it never becomes a second authority.
   *
   * `reachedLoopIndex` is the round the run wanted and was refused, so it can be
   * one past the ceiling. The row records the LAST ROUND THE RUN ACTUALLY
   * STARTED, which is the ceiling it reached, so the table's CHECK constraints
   * (`loop_index <= max_loops`, `run_total_loops <= max_total_loops`,
   * `run_total_loops >= loop_index + 1`) all hold and the count can never
   * describe a round the run did not run. The refusal is named by its
   * `reason_code`. */
  async #recordLoopStop(run: RunRow, stage: StageRow, reasonCode: "pipeline_stage_loop_limit_reached"
    | "pipeline_run_loop_limit_reached", reachedLoopIndex: number, maxLoops: number, maxTotalLoops: number,
    reachedRunTotal: number, requestDigest: string) {
    // The last round inside each ceiling that the run really started. This is
    // the ONLY clamp: the call site passes the values it actually reached, and
    // the row records the ceiling it stopped at.
    const loopIndex = Math.min(reachedLoopIndex, maxLoops);
    const runTotalLoops = Math.min(reachedRunTotal, maxTotalLoops);
    await this.db.transaction(async tx => {
      await this.#raiseLoopAttention(tx, run, stage, reasonCode, reachedLoopIndex, maxLoops, maxTotalLoops, reachedRunTotal);
      const at = new Date(this.#now()).toISOString();
      const stageOrdinal = Number(stage.stage_ordinal);
      const id = `pipeline-loop-stop:${run.id}:${stageOrdinal}:${reachedLoopIndex}`;
      const material = pipelineLoopCountMaterialV1({ tenantId:this.scope.tenantId, projectId:run.project_id,
        runId:run.id, stageOrdinal, workerId:stage.worker_id, loopIndex, maxLoops, maxTotalLoops,
        runTotalLoops, reasonCode: reasonCode === "pipeline_stage_loop_limit_reached"
          ? "stage_loop_limit_reached" : "run_loop_limit_reached",
        receiptId:id, receiptDigest:sha256Digest({ runId:run.id, stageOrdinal, loopIndex, reasonCode }),
        requestDigest, recordedAt:at });
      await tx.query(`INSERT INTO pipeline_stage_loop_counts(id,tenant_id,project_id,pipeline_run_id,stage_ordinal,
        worker_id,loop_index,max_loops,max_total_loops,run_total_loops,reason_code,receipt_id,receipt_digest,
        request_digest,auth_tag,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT DO NOTHING`,
      [id,this.scope.tenantId,run.project_id,run.id,stageOrdinal,
        stage.worker_id,loopIndex,maxLoops,maxTotalLoops,runTotalLoops,
        reasonCode === "pipeline_stage_loop_limit_reached" ? "stage_loop_limit_reached" : "run_loop_limit_reached",
        material.receiptId,material.receiptDigest,requestDigest,
        pipelineLoopCountTagV1(this.#key,material),at]);
    });
  }

  async #appendLoopCount(tx: DatabaseSession, run: RunRow, loop: { stageOrdinal: number; workerId: string;
    loopIndex: number; maxLoops: number; maxTotalLoops: number; runTotalLoops: number }, requestDigest: string,
    receiptId: string, receiptDigest: string, recordedAt: string) {
    const id = `pipeline-loop:${run.id}:${loop.stageOrdinal}:${loop.loopIndex}`;
    const material = pipelineLoopCountMaterialV1({ tenantId:this.scope.tenantId, projectId:run.project_id,
      runId:run.id, stageOrdinal:loop.stageOrdinal, workerId:loop.workerId, loopIndex:loop.loopIndex,
      maxLoops:loop.maxLoops, maxTotalLoops:loop.maxTotalLoops, runTotalLoops:loop.runTotalLoops,
      reasonCode:"stage_advanced",
      receiptId, receiptDigest, requestDigest, recordedAt });
    const digest = pipelineLoopCountDigestV1(material), tag = pipelineLoopCountTagV1(this.#key,material);
    await tx.query(`INSERT INTO pipeline_stage_loop_counts(id,tenant_id,project_id,pipeline_run_id,stage_ordinal,
      worker_id,loop_index,max_loops,max_total_loops,run_total_loops,reason_code,receipt_id,receipt_digest,request_digest,
      auth_tag,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT DO NOTHING`,
    [id,this.scope.tenantId,run.project_id,run.id,loop.stageOrdinal,loop.workerId,loop.loopIndex,loop.maxLoops,
      loop.maxTotalLoops,loop.runTotalLoops,"stage_advanced",receiptId,receiptDigest,requestDigest,tag,recordedAt]);
    // The run row lock is already held, so no two advances can open the same
    // round; the unique key is the database's own second opinion.
  }
  /** One Needs Attention item per run, written in the transaction that refuses.
   * An exact replay is recognised by its payload, so a repeated refusal at the
   * same ceiling does not pile up copies. */
  async #raiseLoopAttention(tx: DatabaseSession, run: RunRow, stage: StageRow,
    reasonCode: "pipeline_stage_loop_limit_reached"|"pipeline_run_loop_limit_reached", loopIndex: number,
    maxLoops: number, maxTotalLoops: number, runTotalLoops: number) {
    const at = new Date(this.#now()).toISOString();
    const receipts = (await tx.query<{ id: string }>(`SELECT id FROM pipeline_advance_receipts
      WHERE tenant_id=$1 AND pipeline_run_id=$2 ORDER BY stage_ordinal,id`,
    [this.scope.tenantId,run.id])).rows.map(row=>row.id);
    const item = pipelineLoopAttentionItemV1({ tenantId:this.scope.tenantId, projectId:run.project_id, runId:run.id,
      stageOrdinal:Number(stage.stage_ordinal), stageKind:stage.stage_kind, reasonCode, loopIndex, maxLoops,
      maxTotalLoops, runTotalLoops, receiptIds:receipts, createdAt:at });
    const prior = (await tx.query<{ payload: unknown }>(`SELECT payload FROM control_action_inbox
      WHERE tenant_id=$1 AND id=$2`,[this.scope.tenantId,item.id])).rows[0];
    if (prior) {
      const existing = prior.payload as Readonly<Record<string,unknown>>|null;
      if (existing&&existing.reasonCode===reasonCode&&existing.createdAt===at) return;
      if (existing&&typeof existing.createdAt==="string") return;  // already raised for this run
      refuse("advance_conflict");
    }
    // Two overlapping sweeps can both pre-check the same stopped run and both
    // reach this insert. The item's id is per run, so the second one collides
    // with a 23505 that is not a `PipelineAdvanceErrorV1` and would abort the
    // rest of that sweep. `ON CONFLICT DO NOTHING` makes the collision a no-op:
    // the identical item is already recorded, which is exactly what this insert
    // would have written. The audit append below is itself replay-safe by id.
    await tx.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,delivery_state,
      created_at,expires_at,payload) VALUES($1,$2,$3,$4,'question','open','not_requested',$5,NULL,$6::jsonb)
      ON CONFLICT (tenant_id,id) DO NOTHING`,
    [item.id,item.tenantId,item.projectId,item.workItemId,item.createdAt,JSON.stringify(item)]);
    await appendAuditWith(tx,{id:`audit:${item.id}`,...this.scope,projectId:run.project_id,actorId:SERVICE_ACTOR,
      actorType:"service",action:"pipelines.loops.exhausted",targetType:"pipeline_run",targetId:run.id,
      idempotencyKey:item.id,occurredAt:at,
      safeMetadata:{reasonCode,stageOrdinal:Number(stage.stage_ordinal),loopIndex,maxLoops,maxTotalLoops,runTotalLoops}});
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
    execution:ReturnType<typeof jobRecordSchema.parse>,now:number,installationCostCap:{spent:number;
    cap:number|null; next:number|null}){
    this.#assertOwnerPolicyCurrent(policy,new Date(now).toISOString());
    if(receipt.policyId!==policy.id||receipt.policyVersion!==Number(policy.version)||receipt.policyDigest!==policy.policy_digest
      ||receipt.coordinatorVersion!==Number(policy.coordinator_version)||receipt.ownerIdentityId!==policy.owner_identity_id
      ||receipt.action!==ADVANCE_ACTION
      ||receipt.executorId!==stage.worker_id||!strings(policy.eligible_routes).includes(receipt.routeId))refuse("policy_route_mismatch");
    if(RISK[execution.authority.maxRisk]>RISK[policy.risk_ceiling])refuse("policy_risk_exceeded");
    if(safeInteger(receipt.taskUnits)>=safeInteger(policy.max_total_tasks))refuse("policy_task_allowance_exhausted");
    if(safeInteger(receipt.concurrentTasks)>=safeInteger(policy.max_concurrent_tasks))refuse("policy_concurrency_exhausted");
    // "Count runs, never dollars" dropped the refusal on an UNKNOWN cost, which
    // is right: an unknown number cannot be compared to a ceiling, and inventing
    // one would stop every unattended night until a cost port answered. It did
    // not drop the ceiling the owner SIGNED. `max_total_cost_microusd` is a
    // signed column of the delegation policy and the same ceiling is enforced
    // for non-pipeline coordination (canonical-store.ts), so pipelines are
    // compared against it here too: whenever the next cost is KNOWN, the run's
    // committed cost plus it must still fit under what the owner signed.
    // Micro-USD ceilings are bigint columns, so the arithmetic stays exact and
    // the ceiling is subtracted rather than added, and a policy at 0 refuses.
    const nextCost=receipt.nextCost;
    if(nextCost.kind==="known"){
      const spent=safeInteger(receipt.committedCostMicroUsd),next=safeInteger(nextCost.microUsd),
        ceiling=safeInteger(policy.max_total_cost_microusd);
      if(spent>ceiling||next>ceiling-spent)refuse("policy_cost_allowance_exhausted");}
    // The installation's optional dollar cap is a SECOND, machine-wide ceiling
    // on top of the signed one. It is null by default, so it is enforced exactly
    // when the owner has set one and the cost is known.
    if(installationCostCap.cap!==null&&installationCostCap.next!==null
      &&(installationCostCap.spent>installationCostCap.cap
        ||installationCostCap.next>installationCostCap.cap-installationCostCap.spent))
      refuse("installation_cost_ceiling_exhausted");}
  async #job(tx:DatabaseSession,run:RunRow,id:string,stage:StageRow,source:boolean){const row=(await tx.query<{payload:unknown;
    project_id:string;workflow_id:string;pipeline_run_id:string|null;stage_kind:string|null;stage_ordinal:number|null}>(`SELECT payload,
    project_id,workflow_id,pipeline_run_id,stage_kind,stage_ordinal FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR SHARE`,
    [this.scope.tenantId,run.project_id,id])).rows[0];if(!row)refuse("advance_conflict");const job=jobRecordSchema.parse(row.payload);
    if(job.id!==id||job.projectId!==run.project_id||job.workflowId!==run.workflow_id||row.project_id!==run.project_id
      ||row.pipeline_run_id!==run.id||row.stage_kind!==stage.stage_kind||Number(row.stage_ordinal)!==Number(stage.stage_ordinal))refuse("advance_conflict");
    if(source&&id!==stage.current_job_id)refuse("advance_conflict");return job;}
  async #receipt(tx:DatabaseSession,runId:string,ordinal:number,round:number){return(await tx.query<AdvanceReceiptRow>(`SELECT id,project_id,pipeline_run_id,loop_index,
    stage_ordinal,source_job_id,execution_job_id,attempt_id,queue_id,selection_digest,template_version,template_digest,run_version,
    run_digest,policy_id,policy_version,policy_digest,delegation_receipt_id,delegation_receipt_digest,delegation_task_units,
    delegation_cost_state,delegation_cost_microusd,delegation_cost_evidence_digest,request_digest,receipt_digest,
    auth_tag,advanced_at FROM pipeline_advance_receipts WHERE tenant_id=$1 AND pipeline_run_id=$2 AND stage_ordinal=$3
    AND loop_index=$4`,[this.scope.tenantId,runId,ordinal,round])).rows[0];}
  /** The round this stage is on: the number of DURABLE RECEIPTS it has already
   * written, which is exactly "fix rounds this stage has started". A stage's
   * first attempt is round 0, so this is also the index of the round the next
   * advance is about to start. Derived from the receipts the advance itself
   * appends under the run row lock, never from a counter this service keeps.
   *
   * A REPLAY names a job that has already run, so its round is that job's OWN
   * receipt, found by matching the SOURCE job: a fix round is a new source job
   * and the stage's `current_job_id` moves with it. Counting alone made every
   * replay look like the next fix round, so a lost response opened a second
   * round instead of replaying the first. */
  async #stageRound(tx:DatabaseSession,runId:string,ordinal:number,sourceJobId?:string){
    if(sourceJobId!==undefined){
      const prior=(await tx.query<{loop_index:number|string}>(`SELECT loop_index FROM pipeline_advance_receipts
        WHERE tenant_id=$1 AND pipeline_run_id=$2 AND stage_ordinal=$3 AND source_job_id=$4`,
      [this.scope.tenantId,runId,ordinal,sourceJobId])).rows[0];
      if(prior)return safeInteger(prior.loop_index);}
      const row=(await tx.query<{count:string|number}>(
            `SELECT COUNT(*)::text count FROM pipeline_advance_receipts WHERE tenant_id=$1 AND pipeline_run_id=$2 AND stage_ordinal=$3`,
            [this.scope.tenantId,runId,ordinal])).rows[0];
            return Math.max(0,Number(row?.count??0));}
  #replayReceipt(row:AdvanceReceiptRow,selection:PipelineAdvanceSelectionV1,policyId:string){const material={id:row.id,
    tenantId:this.scope.tenantId,projectId:row.project_id,pipelineRunId:row.pipeline_run_id,stageOrdinal:Number(row.stage_ordinal),
    loopIndex:safeInteger(row.loop_index),
    sourceJobId:row.source_job_id,executionJobId:row.execution_job_id,attemptId:row.attempt_id,queueId:row.queue_id,
    selectionDigest:row.selection_digest,templateVersion:Number(row.template_version),templateDigest:row.template_digest,
    runVersion:Number(row.run_version),runDigest:row.run_digest,policyId:row.policy_id,policyVersion:Number(row.policy_version),
    policyDigest:row.policy_digest,delegationReceiptId:row.delegation_receipt_id,delegationReceiptDigest:row.delegation_receipt_digest,
    delegationTaskUnits:safeInteger(row.delegation_task_units),
    delegationCostMicroUsd:row.delegation_cost_state==="known"&&row.delegation_cost_microusd!==null
      ?safeInteger(row.delegation_cost_microusd):null,
    delegationCostState:row.delegation_cost_state,
    delegationCostEvidenceDigest:row.delegation_cost_state==="known"&&row.delegation_cost_evidence_digest!==null
      ?row.delegation_cost_evidence_digest:null,
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

/** The lineage projection for one pipeline run inside the caller's
 * transaction. It checks no identity: the only production caller is
 * `historyForOwner`, which authenticates the owner first. */
export async function readPipelineHistoryInSessionV1(tx:DatabaseSession,tenantId:string,projectId:string,runId:string,
limit:number,observedAt:number):Promise<PipelineHistoryV1>{
  if(!Number.isInteger(limit)||limit<1||limit>200)refuse("advance_conflict");
  const run=(await tx.query<{id:string}>(`SELECT id FROM pipeline_runs WHERE tenant_id=$1 AND project_id=$2 AND id=$3`,
    [tenantId,projectId,runId])).rows[0];if(!run)refuse("advance_conflict");
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
  [tenantId,projectId,runId,limit+1,Object.keys(HISTORY_VOCABULARY)])).rows;
  const audit=new AuditStore({query:tx.query.bind(tx),transaction:async work=>work(tx),
    transactionWithPreCommitCheck:async(work,check)=>{const value=await work(tx);await check();return value;}});
  for(const partition of new Set(rows.map(row=>row.chain_partition))){const verified=await audit.verify(tenantId,partition);
    if(!verified.valid)refuse("advance_conflict");}
  const events=rows.slice(0,limit).flatMap(row=>{const kind=HISTORY_VOCABULARY[row.action as keyof typeof HISTORY_VOCABULARY];
    if(!kind)return[];
    const metadata=row.safe_metadata&&typeof row.safe_metadata==="object"?row.safe_metadata as Record<string,unknown>:{};
    const reason=metadata.reasonCode;return[{id:row.id,kind,actorId:row.actor_id,actorType:row.actor_type,action:row.action,
      targetType:row.target_type,targetId:row.target_id,safeReason:typeof reason==="string"&&/^[a-z0-9._:-]{1,120}$/.test(reason)?reason:null,
      occurredAt:iso(row.occurred_at),chainPartition:row.chain_partition,chainSequence:safeInteger(row.chain_sequence),eventHash:row.event_hash}];});
  return pipelineHistorySchemaV1.parse({runId,projectId,events,truncated:rows.length>limit,chainVerified:true,
    observedAt:new Date(observedAt).toISOString(),startsWork:false,grantsExecutionAuthority:false});
}

// Row locks need UPDATE privilege. The run lock is the one serialization
// point: every consent and every advance takes it first, so the append-only
// consent and receipt rows it guards need no lock of their own. Stage rows
// have no application writer (0108's trigger freezes their selection), and a
// template changes only through the owner consent that holds `lockTemplate`;
// the coordinator reads an activated template, which never changes again.
