import { z } from "zod";
import { scheduleRecordSchema, type JobRecord } from "../../domain/v1";
import { appendAuditWith } from "../../audit/audit-store";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { WebAccessError, type VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import { type TaskExecutionPlanner } from "../../web/v1/task-execution-planner";
import { type TaskAssignmentCoordinator } from "../../web/v1/task-assignment-coordinator";
import { computeScheduledTaskDefinitionDigestV1, parseScheduledTaskAdmissionReceiptV1,
  scheduledReusableContextSchemaV1, type ScheduledReusableContextV1,
  type ScheduledTaskAdmissionReceiptV1 } from "./scheduled-task-admission";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true }).refine(value => new Date(value).toISOString() === value);
const contexts = z.array(scheduledReusableContextSchemaV1).max(16);
const policyCreateSchema = z.object({ id, projectId: id, scheduleId: id, scheduleDefinitionDigest: digest,
  sourceBundleDigest: digest, reusableContexts: contexts, reusableContextPolicyDigest: digest,
  allowedExecutor: id, requiredCapability: id, nodeId: id, validFrom: instant, validUntil: instant }).strict();
const policyStateSchema = z.object({ state: z.enum(["active", "paused", "revoked"]),
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1) }).strict();
const operationSchema = z.object({ policyId: id, policyDigest: digest, admission: z.unknown() }).strict();

export type ScheduleAssignmentPolicyV1 = z.infer<typeof policyCreateSchema> & {
  contractVersion: "control-room-schedule-assignment-policy/v1"; tenantId: string; workspaceId: string;
  state: "active" | "paused" | "revoked"; version: number; ownerIdentityId: string;
  ownerIdentityDigest: string; createdAt: string; updatedAt: string; policyDigest: string;
};
export type ScheduledTaskPlanReceiptV1 = Readonly<{
  contractVersion: "control-room-scheduled-task-plan/v1"; tenantId: string; workspaceId: string; projectId: string;
  scheduleId: string; occurrenceKey: string; admissionReceiptDigest: string; policyId: string; policyVersion: number;
  policyDigest: string; ownerIdentityId: string; ownerIdentityDigest: string; contextBindingDigest: string;
  plannedJobId: string; inputDigest: string; plannedAt: string;
  startsWork: false; grantsExecutionAuthority: false; receiptDigest: string;
}>;
export type ScheduledTaskAssignmentReceiptV1 = Readonly<{
  contractVersion: "control-room-scheduled-task-assignment/v1"; tenantId: string; workspaceId: string; projectId: string;
  scheduleId: string; occurrenceKey: string; planReceiptDigest: string; admissionReceiptDigest: string; policyId: string;
  policyVersion: number; policyDigest: string; ownerIdentityId: string; ownerIdentityDigest: string;
  contextBindingDigest: string; plannedJobId: string; inputDigest: string;
  nodeId: string; attemptId: string; leaseId: string; leaseEpoch: number; assignedAt: string;
  startsWork: false; grantsExecutionAuthority: false; claimsNativeCancellation: false; releasesCapacity: false;
  receiptDigest: string;
}>;

export interface ScheduledReusableContextVerifierV1 {
  verifyInSession(tx: DatabaseSession, scope: Readonly<{ tenantId: string; workspaceId: string; projectId: string }>,
    context: ScheduledReusableContextV1, now: string): Promise<boolean>;
}

export class ScheduledTaskAssignmentErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_policy" | "policy_conflict" | "policy_not_active" | "policy_expired"
    | "admission_conflict" | "context_unavailable" | "schedule_unavailable" | "planning_conflict"
    | "assignment_conflict") { super(safeCode); }
}
const fail = (code: ScheduledTaskAssignmentErrorV1["safeCode"]): never => { throw new ScheduledTaskAssignmentErrorV1(code); };
export const computeScheduledReusableContextPolicyDigestV1 = (value: readonly ScheduledReusableContextV1[]) => sha256Digest({
  contractVersion: "control-room-scheduled-reusable-context-policy/v1", reusableContexts: value,
});
export const computeScheduleAssignmentPolicyDigestV1 = (value: Omit<ScheduleAssignmentPolicyV1, "policyDigest">) => sha256Digest(value);
const serviceActor = "service:schedule-assignment:v1";

type PolicyRow = { tenant_id: string; workspace_id: string; project_id: string; id: string; schedule_id: string;
  state: ScheduleAssignmentPolicyV1["state"]; version: number; policy_digest: string; payload: unknown };
type ReceiptRow = { payload: unknown; receipt_digest: string };

function policyFromRow(row: PolicyRow): ScheduleAssignmentPolicyV1 {
  const parsed = z.object({ contractVersion: z.literal("control-room-schedule-assignment-policy/v1"), tenantId: id,
    workspaceId: id, projectId: id, id, scheduleId: id, scheduleDefinitionDigest: digest, sourceBundleDigest: digest,
    reusableContexts: contexts, reusableContextPolicyDigest: digest, allowedExecutor: id, requiredCapability: id, nodeId: id,
    validFrom: instant, validUntil: instant, state: z.enum(["active", "paused", "revoked"]), version: z.number().int().positive(),
    ownerIdentityId: id, ownerIdentityDigest: digest, createdAt: instant, updatedAt: instant, policyDigest: digest }).strict().parse(row.payload);
  const { policyDigest, ...unsigned } = parsed;
  if (row.tenant_id !== parsed.tenantId || row.workspace_id !== parsed.workspaceId || row.project_id !== parsed.projectId
    || row.id !== parsed.id || row.schedule_id !== parsed.scheduleId || row.state !== parsed.state
    || Number(row.version) !== parsed.version || row.policy_digest !== policyDigest
    || computeScheduleAssignmentPolicyDigestV1(unsigned) !== policyDigest
    || computeScheduledReusableContextPolicyDigestV1(parsed.reusableContexts) !== parsed.reusableContextPolicyDigest) fail("policy_conflict");
  return Object.freeze(parsed);
}

function parsePlanReceipt(value: unknown): ScheduledTaskPlanReceiptV1 {
  const schema = z.object({ contractVersion: z.literal("control-room-scheduled-task-plan/v1"), tenantId: id,
    workspaceId: id, projectId: id, scheduleId: id, occurrenceKey: id, admissionReceiptDigest: digest,
    policyId: id, policyVersion: z.number().int().positive(), policyDigest: digest, ownerIdentityId: id,
    ownerIdentityDigest: digest, contextBindingDigest: digest,
    plannedJobId: id, inputDigest: digest, plannedAt: instant, startsWork: z.literal(false),
    grantsExecutionAuthority: z.literal(false), receiptDigest: digest }).strict();
  const parsed = schema.parse(value), { receiptDigest, ...unsigned } = parsed;
  if (sha256Digest(unsigned) !== receiptDigest) fail("planning_conflict");
  return Object.freeze(parsed);
}
function parseAssignmentReceipt(value: unknown): ScheduledTaskAssignmentReceiptV1 {
  const schema = z.object({ contractVersion: z.literal("control-room-scheduled-task-assignment/v1"), tenantId: id,
    workspaceId: id, projectId: id, scheduleId: id, occurrenceKey: id, planReceiptDigest: digest,
    admissionReceiptDigest: digest, policyId: id, policyVersion: z.number().int().positive(), policyDigest: digest,
    ownerIdentityId: id, ownerIdentityDigest: digest, contextBindingDigest: digest, plannedJobId: id, inputDigest: digest,
    nodeId: id, attemptId: id, leaseId: id,
    leaseEpoch: z.number().int().positive(), assignedAt: instant, startsWork: z.literal(false),
    grantsExecutionAuthority: z.literal(false), claimsNativeCancellation: z.literal(false), releasesCapacity: z.literal(false),
    receiptDigest: digest }).strict();
  const parsed = schema.parse(value), { receiptDigest, ...unsigned } = parsed;
  if (sha256Digest(unsigned) !== receiptDigest) fail("assignment_conflict");
  return Object.freeze(parsed);
}

/** Effect-free occurrence -> proposal -> plan -> capacity reservation integration. */
export class ScheduledTaskAssignmentServiceV1 {
  private readonly authority: WebSessionAuthority;
  constructor(private readonly db: DatabaseClient, private readonly scope: Readonly<{ tenantId: string; workspaceId: string }>,
    private readonly planner: TaskExecutionPlanner, private readonly assignment: TaskAssignmentCoordinator,
    private readonly clock: () => number = Date.now, private readonly contextVerifier?: ScheduledReusableContextVerifierV1) {
    const planningScope = planner.webOperation(), assignmentScope = assignment.webOperation();
    if (planningScope.tenantId !== scope.tenantId || planningScope.workspaceId !== scope.workspaceId
      || assignmentScope.tenantId !== scope.tenantId || assignmentScope.workspaceId !== scope.workspaceId) fail("invalid_policy");
    this.scope = Object.freeze({ ...scope }); this.authority = new WebSessionAuthority(db, scope, clock, "schedule");
  }

  async createPolicy(identity: VerifiedWebIdentity, value: unknown) {
    const parsed = policyCreateSchema.safeParse(value); if (!parsed.success) fail("invalid_policy");
    const input = parsed.data;
    if (input.reusableContextPolicyDigest !== computeScheduledReusableContextPolicyDigestV1(input.reusableContexts)
      || Date.parse(input.validUntil) <= Date.parse(input.validFrom)) fail("invalid_policy");
    assertNoSecretMaterial(input);
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.plan", input.projectId, true); actor.require("tasks.assign", input.projectId, true);
      const existing = (await tx.query<PolicyRow>("SELECT * FROM control_schedule_assignment_policies WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.tenantId, input.id])).rows[0];
      if (existing) {
        const policy = policyFromRow(existing);
        if (policy.ownerIdentityId !== actor.id || sha256Digest(input) !== sha256Digest(Object.fromEntries(
          Object.keys(input).map(key => [key, policy[key as keyof typeof input]])))) fail("policy_conflict");
        return { policy, replayed: true };
      }
      const occupied = (await tx.query<{ id: string }>(`SELECT id FROM control_schedule_assignment_policies
        WHERE tenant_id=$1 AND schedule_id=$2 FOR UPDATE`, [this.scope.tenantId, input.scheduleId])).rows[0];
      if (occupied) fail("policy_conflict");
      const scheduleRow = (await tx.query<{ project_id: string; payload: unknown }>(`SELECT s.project_id,s.payload
        FROM control_schedules s JOIN projects p ON p.tenant_id=s.tenant_id AND p.id=s.project_id
        WHERE s.tenant_id=$1 AND s.id=$2 AND p.workspace_id=$3 FOR UPDATE OF s,p`,
      [this.scope.tenantId, input.scheduleId, this.scope.workspaceId])).rows[0];
      if (!scheduleRow || scheduleRow.project_id !== input.projectId) fail("schedule_unavailable");
      const schedule = scheduleRecordSchema.parse(scheduleRow.payload);
      if (computeScheduledTaskDefinitionDigestV1(schedule) !== input.scheduleDefinitionDigest) fail("schedule_unavailable");
      const now = actor.now;
      const unsigned: Omit<ScheduleAssignmentPolicyV1, "policyDigest"> = {
        contractVersion: "control-room-schedule-assignment-policy/v1", tenantId: this.scope.tenantId,
        workspaceId: this.scope.workspaceId, ...input, state: "active", version: 1, ownerIdentityId: actor.id,
        ownerIdentityDigest: sha256Digest({ tenantId: this.scope.tenantId, identityId: actor.id, actorType: "human" }),
        createdAt: now, updatedAt: now,
      };
      const policy = Object.freeze({ ...unsigned, policyDigest: computeScheduleAssignmentPolicyDigestV1(unsigned) });
      await tx.query(`INSERT INTO control_schedule_assignment_policies(tenant_id,workspace_id,project_id,id,schedule_id,state,
        version,policy_digest,owner_identity_id,owner_identity_digest,schedule_definition_digest,source_bundle_digest,
        reusable_context_policy_digest,allowed_executor,required_capability,node_id,valid_from,valid_until,payload,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'active',1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$18)`,
      [policy.tenantId, policy.workspaceId, policy.projectId, policy.id, policy.scheduleId, policy.policyDigest,
        policy.ownerIdentityId, policy.ownerIdentityDigest, policy.scheduleDefinitionDigest, policy.sourceBundleDigest,
        policy.reusableContextPolicyDigest, policy.allowedExecutor, policy.requiredCapability, policy.nodeId,
        policy.validFrom, policy.validUntil, JSON.stringify(policy), now]);
      await appendAuditWith(tx, { id: `audit:schedule-policy:${sha256Digest(policy.id).slice(7)}`, tenantId: policy.tenantId,
        projectId: policy.projectId, actorId: actor.id, actorType: "human", action: "scheduled.assignment.policy.create",
        targetType: "schedule", targetId: policy.scheduleId, idempotencyKey: `schedule-policy:${policy.id}:1`, occurredAt: now,
        safeMetadata: { policyId: policy.id, policyDigest: policy.policyDigest, version: 1, startsWork: false } });
      return { policy, replayed: false };
    });
  }

  async setPolicyState(identity: VerifiedWebIdentity, policyId: string, value: unknown) {
    id.parse(policyId); const parsed = policyStateSchema.safeParse(value); if (!parsed.success) fail("invalid_policy");
    return this.authority.authenticated(identity, async (tx, actor) => {
      const row = (await tx.query<PolicyRow>("SELECT * FROM control_schedule_assignment_policies WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.tenantId, policyId])).rows[0];
      if (!row) fail("policy_conflict"); const current = policyFromRow(row);
      actor.require("tasks.plan", current.projectId, true); actor.require("tasks.assign", current.projectId, true);
      if (current.version !== parsed.data.expectedVersion) fail("policy_conflict");
      if (current.state === parsed.data.state) return { policy: current, replayed: true };
      if (current.state === "revoked") fail("policy_conflict");
      const { policyDigest: _old, ...base } = current;
      const unsigned = { ...base, state: parsed.data.state, version: current.version + 1, updatedAt: actor.now };
      const policy = Object.freeze({ ...unsigned, policyDigest: computeScheduleAssignmentPolicyDigestV1(unsigned) });
      await tx.query(`UPDATE control_schedule_assignment_policies SET state=$1,version=$2,policy_digest=$3,payload=$4::jsonb,updated_at=$5
        WHERE tenant_id=$6 AND id=$7`, [policy.state, policy.version, policy.policyDigest, JSON.stringify(policy), actor.now,
        this.scope.tenantId, policyId]);
      await appendAuditWith(tx, { id: `audit:schedule-policy:${sha256Digest({ policyId, version: policy.version }).slice(7)}`,
        tenantId: policy.tenantId, projectId: policy.projectId, actorId: actor.id, actorType: "human",
        action: `scheduled.assignment.policy.${policy.state}`, targetType: "schedule", targetId: policy.scheduleId,
        idempotencyKey: `schedule-policy:${policy.id}:${policy.version}`, occurredAt: actor.now,
        safeMetadata: { policyId, policyDigest: policy.policyDigest, version: policy.version, startsWork: false } });
      return { policy, replayed: false };
    });
  }

  private now(): string { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) fail("policy_expired"); return new Date(value).toISOString(); }
  private async current(tx: DatabaseSession, input: { policyId: string; policyDigest: string; admission: ScheduledTaskAdmissionReceiptV1 }) {
    const row = (await tx.query<PolicyRow>("SELECT * FROM control_schedule_assignment_policies WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [this.scope.tenantId, input.policyId])).rows[0];
    if (!row) fail("policy_conflict"); const policy = policyFromRow(row), now = this.now();
    if (policy.state !== "active") fail("policy_not_active");
    if (policy.policyDigest !== input.policyDigest) fail("policy_conflict");
    if (Date.parse(now) < Date.parse(policy.validFrom) || Date.parse(now) >= Date.parse(policy.validUntil)) fail("policy_expired");
    const admission = input.admission;
    if (admission.tenantId !== this.scope.tenantId || admission.workspaceId !== this.scope.workspaceId
      || admission.projectId !== policy.projectId || admission.scheduleId !== policy.scheduleId
      || admission.scheduleDefinitionDigest !== policy.scheduleDefinitionDigest
      || admission.source.bundleDigest !== policy.sourceBundleDigest
      || admission.contextBinding.bindingDigest !== sha256Digest({ contractVersion: "control-room-scheduled-context-binding/v1",
        reusableContexts: admission.contextBinding.reusableContexts })
      || sha256Digest(admission.contextBinding.reusableContexts) !== sha256Digest(policy.reusableContexts)) fail("admission_conflict");
    const schedule = (await tx.query<{ state: string; payload: unknown }>(`SELECT s.state,s.payload FROM control_schedules s
      JOIN projects p ON p.tenant_id=s.tenant_id AND p.id=s.project_id
      WHERE s.tenant_id=$1 AND s.id=$2 AND p.workspace_id=$3 FOR UPDATE OF s,p`,
    [this.scope.tenantId, policy.scheduleId, this.scope.workspaceId])).rows[0];
    if (!schedule || schedule.state !== "active"
      || computeScheduledTaskDefinitionDigestV1(scheduleRecordSchema.parse(schedule.payload)) !== policy.scheduleDefinitionDigest) {
      fail("schedule_unavailable");
    }
    const occurrence = (await tx.query<{ state: string }>(`SELECT state FROM control_schedule_occurrences
      WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 FOR UPDATE`,
    [this.scope.tenantId, policy.scheduleId, admission.occurrenceKey])).rows[0];
    if (!occurrence || occurrence.state === "cancelled") fail("schedule_unavailable");
    const admitted = (await tx.query<ReceiptRow>(`SELECT payload,receipt_digest FROM control_scheduled_task_admissions
      WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 FOR UPDATE`,
    [this.scope.tenantId, policy.scheduleId, admission.occurrenceKey])).rows[0];
    if (!admitted || admitted.receipt_digest !== admission.receiptDigest
      || sha256Digest(admitted.payload) !== sha256Digest(admission)) fail("admission_conflict");
    const proposal = (await tx.query<{ state: string }>(`SELECT state FROM control_jobs
      WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
    [this.scope.tenantId, policy.projectId, admission.destination.jobId])).rows[0];
    if (!proposal || proposal.state !== "proposed") fail("schedule_unavailable");
    for (const context of policy.reusableContexts) {
      if (!this.contextVerifier || !(await this.contextVerifier.verifyInSession(tx,
        { ...this.scope, projectId: policy.projectId }, context, now))) fail("context_unavailable");
    }
    return { policy, now };
  }

  async plan(value: unknown): Promise<{ receipt: ScheduledTaskPlanReceiptV1; replayed: boolean }> {
    const parsed = operationSchema.safeParse(value); if (!parsed.success) fail("admission_conflict");
    let admission: ScheduledTaskAdmissionReceiptV1;
    try { admission = parseScheduledTaskAdmissionReceiptV1(parsed.data.admission); } catch { return fail("admission_conflict"); }
    return this.db.transactionWithPreCommitCheck(async tx => {
      const prior = (await tx.query<ReceiptRow>(`SELECT payload,receipt_digest FROM control_scheduled_task_plans
        WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 FOR UPDATE`,
      [this.scope.tenantId, admission.scheduleId, admission.occurrenceKey])).rows[0];
      if (prior) {
        const receipt = parsePlanReceipt(prior.payload);
        if (prior.receipt_digest !== receipt.receiptDigest || receipt.admissionReceiptDigest !== admission.receiptDigest
          || receipt.policyId !== parsed.data.policyId || receipt.policyDigest !== parsed.data.policyDigest) fail("planning_conflict");
        return { receipt, replayed: true };
      }
      const assertCurrent = async () => { await this.current(tx, { ...parsed.data, admission }); };
      const { policy, now } = await this.current(tx, { ...parsed.data, admission });
      const sourceJob = (await tx.query<{ payload: JobRecord }>("SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.tenantId, admission.destination.jobId])).rows[0]?.payload;
      if (!sourceJob || sha256Digest(sourceJob) !== admission.destination.jobDigest) fail("admission_conflict");
      const planned = await this.planner.planScheduledInSession(tx, { projectId: policy.projectId,
        sourceJobId: admission.destination.jobId, expectedInputDigest: sourceJob.inputDigest, policyId: policy.id,
        policyVersion: policy.version, policyDigest: policy.policyDigest,
        ownerIdentityDigest: policy.ownerIdentityDigest }, assertCurrent);
      const job = (await tx.query<{ payload: JobRecord }>("SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.tenantId, planned.receipt.jobId])).rows[0]?.payload;
      if (!job || job.authority.allowedExecutor !== policy.allowedExecutor || job.requiredCapability !== policy.requiredCapability
        || job.retryPolicy.maxAttempts !== 1 || job.retryPolicy.retryAfterOrphan) fail("planning_conflict");
      const unsigned = { contractVersion: "control-room-scheduled-task-plan/v1" as const, tenantId: this.scope.tenantId,
        workspaceId: this.scope.workspaceId, projectId: policy.projectId, scheduleId: policy.scheduleId,
        occurrenceKey: admission.occurrenceKey, admissionReceiptDigest: admission.receiptDigest, policyId: policy.id,
        policyVersion: policy.version, policyDigest: policy.policyDigest, ownerIdentityId: policy.ownerIdentityId,
        ownerIdentityDigest: policy.ownerIdentityDigest, contextBindingDigest: admission.contextBinding.bindingDigest,
        plannedJobId: planned.receipt.jobId, inputDigest: planned.receipt.inputDigest, plannedAt: now,
        startsWork: false as const, grantsExecutionAuthority: false as const };
      const receipt = Object.freeze({ ...unsigned, receiptDigest: sha256Digest(unsigned) });
      await tx.query(`INSERT INTO control_scheduled_task_plans(tenant_id,workspace_id,project_id,schedule_id,occurrence_key,
        admission_receipt_digest,policy_id,policy_version,policy_digest,owner_identity_id,owner_identity_digest,
        context_binding_digest,planned_job_id,input_digest,receipt_digest,payload,planned_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)`,
      [receipt.tenantId, receipt.workspaceId, receipt.projectId, receipt.scheduleId, receipt.occurrenceKey,
        receipt.admissionReceiptDigest, receipt.policyId, receipt.policyVersion, receipt.policyDigest,
        receipt.ownerIdentityId, receipt.ownerIdentityDigest, receipt.contextBindingDigest, receipt.plannedJobId,
        receipt.inputDigest, receipt.receiptDigest,
        JSON.stringify(receipt), receipt.plannedAt]);
      return { receipt, replayed: false };
    }, () => { this.now(); });
  }

  async assign(value: unknown): Promise<{ receipt: ScheduledTaskAssignmentReceiptV1; replayed: boolean }> {
    const parsed = operationSchema.safeParse(value); if (!parsed.success) fail("admission_conflict");
    let admission: ScheduledTaskAdmissionReceiptV1;
    try { admission = parseScheduledTaskAdmissionReceiptV1(parsed.data.admission); } catch { return fail("admission_conflict"); }
    let commitDeadline: number | undefined;
    return this.db.transactionWithPreCommitCheck(async tx => {
      const prior = (await tx.query<ReceiptRow>(`SELECT payload,receipt_digest FROM control_scheduled_task_assignments
        WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 FOR UPDATE`,
      [this.scope.tenantId, admission.scheduleId, admission.occurrenceKey])).rows[0];
      if (prior) {
        const receipt = parseAssignmentReceipt(prior.payload);
        if (prior.receipt_digest !== receipt.receiptDigest || receipt.admissionReceiptDigest !== admission.receiptDigest
          || receipt.policyId !== parsed.data.policyId || receipt.policyDigest !== parsed.data.policyDigest) fail("assignment_conflict");
        return { receipt, replayed: true };
      }
      const planRow = (await tx.query<ReceiptRow>(`SELECT payload,receipt_digest FROM control_scheduled_task_plans
        WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 FOR UPDATE`,
      [this.scope.tenantId, admission.scheduleId, admission.occurrenceKey])).rows[0];
      if (!planRow) fail("planning_conflict"); const plan = parsePlanReceipt(planRow.payload);
      if (planRow.receipt_digest !== plan.receiptDigest || plan.admissionReceiptDigest !== admission.receiptDigest
        || plan.policyId !== parsed.data.policyId || plan.policyDigest !== parsed.data.policyDigest) fail("planning_conflict");
      const assertCurrent = async () => { await this.current(tx, { ...parsed.data, admission }); };
      const { policy, now } = await this.current(tx, { ...parsed.data, admission });
      const assigned = await this.assignment.assignScheduledInSession(tx, { projectId: policy.projectId,
        jobId: plan.plannedJobId, nodeId: policy.nodeId, expectedInputDigest: plan.inputDigest }, {
        assertCurrent, commitDeadline: value => { commitDeadline = value; },
      });
      const unsigned = { contractVersion: "control-room-scheduled-task-assignment/v1" as const, tenantId: this.scope.tenantId,
        workspaceId: this.scope.workspaceId, projectId: policy.projectId, scheduleId: policy.scheduleId,
        occurrenceKey: admission.occurrenceKey, planReceiptDigest: plan.receiptDigest,
        admissionReceiptDigest: admission.receiptDigest, policyId: policy.id, policyVersion: policy.version,
        policyDigest: policy.policyDigest, ownerIdentityId: policy.ownerIdentityId,
        ownerIdentityDigest: policy.ownerIdentityDigest, contextBindingDigest: admission.contextBinding.bindingDigest,
        plannedJobId: plan.plannedJobId, inputDigest: plan.inputDigest, nodeId: assigned.receipt.nodeId,
        attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId, leaseEpoch: assigned.receipt.leaseEpoch,
        assignedAt: now, startsWork: false as const, grantsExecutionAuthority: false as const,
        claimsNativeCancellation: false as const, releasesCapacity: false as const };
      const receipt = Object.freeze({ ...unsigned, receiptDigest: sha256Digest(unsigned) });
      await tx.query(`INSERT INTO control_scheduled_task_assignments(tenant_id,workspace_id,project_id,schedule_id,
        occurrence_key,admission_receipt_digest,policy_id,policy_version,policy_digest,owner_identity_id,
        owner_identity_digest,context_binding_digest,planned_job_id,attempt_id,lease_id,receipt_digest,payload,assigned_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)`,
      [receipt.tenantId, receipt.workspaceId, receipt.projectId, receipt.scheduleId, receipt.occurrenceKey,
        receipt.admissionReceiptDigest, receipt.policyId, receipt.policyVersion, receipt.policyDigest,
        receipt.ownerIdentityId, receipt.ownerIdentityDigest, receipt.contextBindingDigest, receipt.plannedJobId,
        receipt.attemptId, receipt.leaseId,
        receipt.receiptDigest, JSON.stringify(receipt), receipt.assignedAt]);
      await appendAuditWith(tx, { id: `audit:scheduled-assignment:${sha256Digest({ scheduleId: receipt.scheduleId,
        occurrenceKey: receipt.occurrenceKey }).slice(7)}`, tenantId: receipt.tenantId, projectId: receipt.projectId,
        actorId: serviceActor, actorType: "service", action: "scheduled.tasks.assign", targetType: "job",
        targetId: receipt.plannedJobId, idempotencyKey: `scheduled-assignment:${receipt.scheduleId}:${receipt.occurrenceKey}`,
        occurredAt: receipt.assignedAt, safeMetadata: { policyId: receipt.policyId, policyVersion: receipt.policyVersion,
          policyDigest: receipt.policyDigest, ownerIdentityDigest: receipt.ownerIdentityDigest,
          attemptId: receipt.attemptId, leaseId: receipt.leaseId, startsWork: false, grantsExecutionAuthority: false,
          claimsNativeCancellation: false, releasesCapacity: false } });
      return { receipt, replayed: false };
    }, async () => {
      if (commitDeadline !== undefined && this.clock() >= commitDeadline) fail("assignment_conflict");
      this.now();
    });
  }

  async process(value: unknown) { const plan = await this.plan(value); const assignment = await this.assign(value); return { plan, assignment }; }
}
