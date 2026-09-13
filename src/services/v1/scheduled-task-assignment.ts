import { z } from "zod";
import { scheduleRecordSchema, type JobRecord } from "../../domain/v1";
import { appendAuditWith } from "../../audit/audit-store";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { WebAccessError, type VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import { type TaskExecutionPlanner } from "../../web/v1/task-execution-planner";
import { type TaskAssignmentCoordinator } from "../../web/v1/task-assignment-coordinator";
import type { NativeResultStore } from "../../artifacts/v1/native-results";
import type { CompletionGateStoreV1 } from "../../completion-gate/v1/store";
import type { CompletionReviewV1, CompletionVerificationV1 } from "../../completion-gate/v1/types";
import { readTaskReviewPlanV1, verifyTaskReviewTargetV1 } from "../../completion-gate/v1/task-review-plan";
import { evaluatePolicy, type RoleGrant } from "../../security/policy";
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
  resolveInSession(tx: DatabaseSession, scope: Readonly<{ tenantId: string; workspaceId: string; projectId: string }>,
    context: ScheduledReusableContextV1, now: string): Promise<ScheduledReusableContextV1>;
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
export const computeScheduledContextReviewDigestV1 = (reviews: readonly CompletionReviewV1[]) => sha256Digest({
  contractVersion: "control-room-scheduled-context-reviews/v1", reviews,
});
export const computeScheduledContextVerificationDigestV1 = (verifications: readonly CompletionVerificationV1[]) => sha256Digest({
  contractVersion: "control-room-scheduled-context-verifications/v1", verifications,
});
export const computeScheduleAssignmentPolicyDigestV1 = (value: Omit<ScheduleAssignmentPolicyV1, "policyDigest">) => sha256Digest(value);
const serviceActor = "service:schedule-assignment:v1";

/** Repository-backed accepted-context resolver. It authenticates canonical result metadata,
 * completion-gate integrity/checkpoint state, exact review and verification records, and
 * revision lineage inside the caller's plan/assignment transaction. */
export class CanonicalScheduledReusableContextVerifierV1 implements ScheduledReusableContextVerifierV1 {
  private readonly reviewKey: Uint8Array;
  constructor(private readonly results: Pick<NativeResultStore, "readReceipt">,
    private readonly completion: CompletionGateStoreV1, reviewIntegrityKey: Uint8Array) {
    if (!(reviewIntegrityKey instanceof Uint8Array) || reviewIntegrityKey.length !== 32) fail("context_unavailable");
    this.reviewKey = Uint8Array.from(reviewIntegrityKey);
  }
  async resolveInSession(tx: DatabaseSession,
    scope: Readonly<{ tenantId: string; workspaceId: string; projectId: string }>,
    context: ScheduledReusableContextV1, now: string): Promise<ScheduledReusableContextV1> {
    if (Date.parse(context.verifiedAt) > Date.parse(now)
      || context.expiresAt && Date.parse(now) >= Date.parse(context.expiresAt)) fail("context_unavailable");
    const receipt = await this.results.readReceipt(tx, scope.tenantId, scope.projectId, context.sourceJobId, context.id);
    if (!receipt || receipt.artifactId !== context.id || receipt.projectId !== scope.projectId
      || receipt.jobId !== context.sourceJobId || receipt.runId !== context.sourceRunId
      || receipt.contentHash !== context.contentHash) fail("context_unavailable");
    const evidence = await this.completion.acceptedContextInSession(tx, scope.tenantId, scope.projectId, context.targetId);
    const plan = await readTaskReviewPlanV1(tx, this.reviewKey, scope.tenantId, scope.projectId, context.sourceJobId);
    try { verifyTaskReviewTargetV1(plan, evidence.target, receipt); } catch { return fail("context_unavailable"); }
    const reviews = evidence.reviews, verifications = evidence.verifications;
    const latestVerification = verifications.reduce((latest, value) => value.verifiedAt > latest ? value.verifiedAt : latest, "");
    if (evidence.target.subjectDigest !== context.contentHash || evidence.target.revisionNumber !== context.sourceRevision
      || evidence.target.id !== context.targetId || evidence.snapshot.status !== "ready"
      || reviews.map(value => value.id).join("|") !== context.reviewIds.join("|")
      || verifications.map(value => value.id).join("|") !== context.verificationIds.join("|")
      || computeScheduledContextReviewDigestV1(reviews) !== context.reviewDigest
      || computeScheduledContextVerificationDigestV1(verifications) !== context.verificationDigest
      || latestVerification !== context.verifiedAt) fail("context_unavailable");
    const resolved = { ...context, reviewIds: [...context.reviewIds], verificationIds: [...context.verificationIds] };
    Object.freeze(resolved.reviewIds); Object.freeze(resolved.verificationIds); return Object.freeze(resolved);
  }
}

type PolicyRow = { tenant_id: string; workspace_id: string; project_id: string; id: string; schedule_id: string;
  state: ScheduleAssignmentPolicyV1["state"]; version: number; policy_digest: string; payload: unknown };
type ReceiptRow = { payload: unknown; receipt_digest: string };
type CurrentGrantRow = { id: string; role_key: string; allowed_actions: string[]; project_ids: string[];
  risk_ceiling: RoleGrant["riskCeiling"]; allow_external_effects: boolean; require_strong_factor: boolean;
  expires_at: string | Date | null; revoked_at: string | Date | null };
const iso = (value: string | Date) => new Date(value).toISOString();
type LockedAuthority = Readonly<{ policy: ScheduleAssignmentPolicyV1; ownerActive: boolean; ownerId: string;
  grants: readonly RoleGrant[] }>;

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
  /** Match WebSessionAuthority's owner/grant -> operation-row order. The unlocked locator is
   * rechecked against the locked policy, so it cannot redirect authority while locks are acquired. */
  private async lockAuthority(tx: DatabaseSession, policyId: string): Promise<LockedAuthority> {
    const locator = (await tx.query<{ owner_identity_id: string }>(`SELECT owner_identity_id
      FROM control_schedule_assignment_policies WHERE tenant_id=$1 AND id=$2`,
    [this.scope.tenantId, policyId])).rows[0];
    if (!locator) fail("policy_conflict");
    const owner = (await tx.query<{ id: string; state: string }>(`SELECT id,state FROM control_identities
      WHERE tenant_id=$1 AND id=$2 AND actor_type='human' FOR UPDATE`,
    [this.scope.tenantId, locator.owner_identity_id])).rows[0];
    if (!owner) fail("policy_not_active");
    const grantRows = (await tx.query<CurrentGrantRow>(`SELECT id,role_key,allowed_actions,project_ids,risk_ceiling,
      allow_external_effects,require_strong_factor,expires_at,revoked_at FROM control_role_grants
      WHERE tenant_id=$1 AND identity_id=$2 FOR SHARE`, [this.scope.tenantId, owner.id])).rows;
    const row = (await tx.query<PolicyRow>(`SELECT * FROM control_schedule_assignment_policies
      WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [this.scope.tenantId, policyId])).rows[0];
    if (!row) fail("policy_conflict");
    const policy = policyFromRow(row);
    if (policy.ownerIdentityId !== locator.owner_identity_id || owner.id !== policy.ownerIdentityId
      || sha256Digest({ tenantId: this.scope.tenantId, identityId: owner.id, actorType: "human" })
        !== policy.ownerIdentityDigest) fail("policy_conflict");
    const grants = grantRows.filter(value => value.role_key === "owner").map(value => ({ id: value.id,
      roleKey: value.role_key, allowedActions: value.allowed_actions, projectIds: value.project_ids,
      riskCeiling: value.risk_ceiling, allowExternalEffects: value.allow_external_effects,
      requireStrongFactor: value.require_strong_factor, ...(value.expires_at ? { expiresAt: iso(value.expires_at) } : {}),
      ...(value.revoked_at ? { revokedAt: iso(value.revoked_at) } : {}) }));
    return Object.freeze({ policy, ownerActive: owner.state === "active", ownerId: owner.id,
      grants: Object.freeze(grants) });
  }
  private authorized(authority: LockedAuthority, now: string) {
    const policy = authority.policy;
    if (!authority.ownerActive) fail("policy_not_active");
    const result = evaluatePolicy({ tenantId: this.scope.tenantId, identityId: authority.ownerId, actorType: "human",
      authenticatedAt: policy.createdAt, expiresAt: policy.validUntil }, [...authority.grants], { tenantId: this.scope.tenantId,
      action: "tasks.assign", resourceType: "task", resourceId: policy.projectId, projectId: policy.projectId,
      risk: "low", externalEffect: false, occurredAt: now });
    if (!result.allowed) fail("policy_not_active");
  }
  private terminalFence(authority: LockedAuthority, resolvedContexts: readonly ScheduledReusableContextV1[], deadline?: number) {
    const nowMs = this.clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("policy_expired");
    const now = new Date(nowMs).toISOString(), policy = authority.policy;
    if (nowMs < Date.parse(policy.validFrom) || nowMs >= Date.parse(policy.validUntil)) fail("policy_expired");
    for (const context of resolvedContexts) {
      if (context.expiresAt && nowMs >= Date.parse(context.expiresAt)) fail("context_unavailable");
    }
    this.authorized(authority, now);
    if (deadline !== undefined && nowMs >= deadline) fail("assignment_conflict");
  }
  private async current(tx: DatabaseSession, authority: LockedAuthority,
    input: { policyId: string; policyDigest: string; admission: ScheduledTaskAdmissionReceiptV1 }) {
    const policy = authority.policy, now = this.now();
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
    this.authorized(authority, now);
    const resolvedContexts: ScheduledReusableContextV1[] = [];
    const verifier = this.contextVerifier;
    for (const context of policy.reusableContexts) {
      if (!verifier) fail("context_unavailable");
      try {
        const resolved = await verifier.resolveInSession(tx,
          { ...this.scope, projectId: policy.projectId }, context, now);
        if (sha256Digest(resolved) !== sha256Digest(context)) fail("context_unavailable");
        resolvedContexts.push(resolved);
      } catch { fail("context_unavailable"); }
    }
    return { policy, now, resolvedContexts: Object.freeze(resolvedContexts) };
  }

  async plan(value: unknown): Promise<{ receipt: ScheduledTaskPlanReceiptV1; replayed: boolean }> {
    const parsed = operationSchema.safeParse(value); if (!parsed.success) fail("admission_conflict");
    let admission: ScheduledTaskAdmissionReceiptV1;
    try { admission = parseScheduledTaskAdmissionReceiptV1(parsed.data.admission); } catch { return fail("admission_conflict"); }
    let assertFinalCurrent: (() => Promise<unknown>) | undefined, terminal: (() => void) | undefined;
    return this.db.transactionWithPreCommitCheck(async tx => {
      const authority = await this.lockAuthority(tx, parsed.data.policyId);
      const prior = (await tx.query<ReceiptRow>(`SELECT payload,receipt_digest FROM control_scheduled_task_plans
        WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 FOR UPDATE`,
      [this.scope.tenantId, admission.scheduleId, admission.occurrenceKey])).rows[0];
      if (prior) {
        const receipt = parsePlanReceipt(prior.payload);
        if (prior.receipt_digest !== receipt.receiptDigest || receipt.admissionReceiptDigest !== admission.receiptDigest
          || receipt.policyId !== parsed.data.policyId || receipt.policyDigest !== parsed.data.policyDigest) fail("planning_conflict");
        return { receipt, replayed: true };
      }
      const assertCurrent = async () => { await this.current(tx, authority, { ...parsed.data, admission }); };
      assertFinalCurrent = assertCurrent;
      const { policy, now, resolvedContexts } = await this.current(tx, authority, { ...parsed.data, admission });
      terminal = () => this.terminalFence(authority, resolvedContexts);
      const sourceJob = (await tx.query<{ payload: JobRecord }>("SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.tenantId, admission.destination.jobId])).rows[0]?.payload;
      if (!sourceJob || sha256Digest(sourceJob) !== admission.destination.jobDigest) fail("admission_conflict");
      const planned = await this.planner.planScheduledInSession(tx, { projectId: policy.projectId,
        sourceJobId: admission.destination.jobId, expectedInputDigest: sourceJob.inputDigest, policyId: policy.id,
        policyVersion: policy.version, policyDigest: policy.policyDigest,
        ownerIdentityDigest: policy.ownerIdentityDigest, reusableContexts: resolvedContexts }, assertCurrent);
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
    }, async () => { if (assertFinalCurrent) await assertFinalCurrent(); terminal?.(); });
  }

  async assign(value: unknown): Promise<{ receipt: ScheduledTaskAssignmentReceiptV1; replayed: boolean }> {
    const parsed = operationSchema.safeParse(value); if (!parsed.success) fail("admission_conflict");
    let admission: ScheduledTaskAdmissionReceiptV1;
    try { admission = parseScheduledTaskAdmissionReceiptV1(parsed.data.admission); } catch { return fail("admission_conflict"); }
    let commitDeadline: number | undefined, assertFinalCurrent: (() => Promise<unknown>) | undefined;
    let terminal: (() => void) | undefined;
    return this.db.transactionWithPreCommitCheck(async tx => {
      const authority = await this.lockAuthority(tx, parsed.data.policyId);
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
      const assertCurrent = async () => { await this.current(tx, authority, { ...parsed.data, admission }); };
      assertFinalCurrent = assertCurrent;
      const { policy, now, resolvedContexts } = await this.current(tx, authority, { ...parsed.data, admission });
      terminal = () => this.terminalFence(authority, resolvedContexts, commitDeadline);
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
    }, async () => { if (assertFinalCurrent) await assertFinalCurrent(); terminal?.(); });
  }

  async process(value: unknown) { const plan = await this.plan(value); const assignment = await this.assign(value); return { plan, assignment }; }
}
