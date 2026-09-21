import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import type { CodexWorkspaceLeaseV1 } from "../codex-v1/workspace";
import { readControllerWorkerDeliveryReceiptV1 } from "./controller-worker-delivery-receipt-store";
import type { ManagedWorktreeChangeAuditAuthorityV1 } from "./worktree-change-audit-authority";
import { verifyWorktreeChangeAuditPlanV1, type WorktreeChangeAuditPlanV1 } from "./worktree-change-audit";

/**
 * An append-only, authority-database record of the manager-derived audit plan.
 * It is deliberately not a worker input, worktree manager, result writer, or
 * browser projection.  In particular, the plan's paths and revisions remain
 * evidence-role material and must never be granted to private-web.
 */
export const WORKTREE_CHANGE_AUDIT_PLAN_RECORD_V1 =
  "control-room.worktree-change-audit-plan-record/v1" as const;

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const localId = z.string().regex(/^[a-z][a-z0-9._:-]{2,179}$/i);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identitySchema = z.object({
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId,
}).strict();
const recordSchema = z.object({
  schema: z.literal(WORKTREE_CHANGE_AUDIT_PLAN_RECORD_V1),
  identity: identitySchema,
  /** Digest of the authenticated, persisted controller delivery packet. */
  deliveryDigest: digest,
  plan: z.unknown(),
  recordedAt: instant,
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false), permitsResume: z.literal(false),
}).strict();

type Record = z.infer<typeof recordSchema>;
type Scope = z.infer<typeof identitySchema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; run_id: string; record: unknown; auth_tag: string };
const fail = (): never => { throw new Error("worktree_change_audit_plan_unavailable"); };
const tag = (key: Uint8Array, record: Record) => hmacSha256Tag(key,
  { purpose: "worktree-change-audit-plan-record/v1", record });

function sameScope(left: Scope, right: Scope): boolean {
  return left.tenantId === right.tenantId && left.projectId === right.projectId
    && left.jobId === right.jobId && left.attemptId === right.attemptId && left.runId === right.runId;
}

function verify(key: Uint8Array, row: Row): Readonly<{ record: Record; plan: WorktreeChangeAuditPlanV1 }> {
  const record = recordSchema.parse(row.record);
  const expected = Buffer.from(tag(key, record)), actual = Buffer.from(row.auth_tag);
  const plan = verifyWorktreeChangeAuditPlanV1(record.plan);
  const scope = { tenantId: row.tenant_id, projectId: row.project_id, jobId: row.job_id,
    attemptId: row.attempt_id, runId: row.run_id };
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
    || !sameScope(record.identity, scope) || plan.deliveryDigest !== record.deliveryDigest
    || Date.parse(record.recordedAt) < 0) fail();
  return Object.freeze({ record, plan });
}

/**
 * Persists only a plan made by a trusted workspace-manager authority from an
 * already-authenticated delivery receipt.  Callers cannot provide paths,
 * limits, revisions, or a self-created lease.  It does not create/clean a
 * worktree, inspect files, start a worker, publish a result, or grant work.
 */
export async function persistManagedWorktreeChangeAuditPlanV1(tx: DatabaseSession, integrityKey: Uint8Array,
  input: Readonly<{
    delivery: { tenantId: string; projectId: string; jobId: string; attemptId: string };
    lease: CodexWorkspaceLeaseV1;
    authority: ManagedWorktreeChangeAuditAuthorityV1;
    recordedAt: unknown;
  }>) {
  if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32
    || !input.authority || typeof input.authority.derive !== "function") fail();
  const deliveryScope = z.object({ tenantId: localId, projectId: localId, jobId: localId, attemptId: localId })
    .strict().parse({ tenantId: input.delivery.tenantId, projectId: input.delivery.projectId,
      jobId: input.delivery.jobId, attemptId: input.delivery.attemptId });
  const recordedAt = instant.parse(input.recordedAt);
  const saved = await readControllerWorkerDeliveryReceiptV1(tx, integrityKey, deliveryScope);
  if (!saved) throw new Error("worktree_change_audit_plan_unavailable");
  const authenticated = saved;
  if (authenticated.receipt.disposition !== "accepted"
    || Date.parse(recordedAt) < Date.parse(authenticated.receipt.receivedAt)) fail();
  const identity = identitySchema.parse({ tenantId: authenticated.delivery.identity.tenantId,
    projectId: authenticated.delivery.identity.projectId, jobId: authenticated.delivery.identity.jobId,
    attemptId: authenticated.delivery.identity.attemptId, runId: authenticated.delivery.identity.runId });
  const plan = input.authority.derive({ delivery: authenticated.delivery, lease: input.lease });
  const verifiedPlan = verifyWorktreeChangeAuditPlanV1(plan);
  const deliveryDigest = authenticated.delivery.deliveryDigest;
  if (verifiedPlan.deliveryDigest !== deliveryDigest || identity.runId !== input.lease.runId) fail();
  const record = recordSchema.parse({ schema: WORKTREE_CHANGE_AUDIT_PLAN_RECORD_V1, identity,
    deliveryDigest, plan: verifiedPlan, recordedAt,
    startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsResume: false });
  assertNoSecretMaterial(record, "managed worktree change audit plan");
  const current = (await tx.query<Row>(`SELECT tenant_id,project_id,job_id,attempt_id,run_id,record,auth_tag
    FROM control_worktree_change_audit_plans WHERE tenant_id=$1 AND run_id=$2`,
  [identity.tenantId, identity.runId])).rows[0];
  if (current) {
    const prior = verify(integrityKey, current);
    if (sha256Digest(prior.record) !== sha256Digest(record)) fail();
    return Object.freeze({ plan: prior.plan, replayed: true as const, startsWork: false as const,
      grantsExecutionAuthority: false as const });
  }
  const inserted = await tx.query<{ run_id: string }>(`INSERT INTO control_worktree_change_audit_plans
    (tenant_id,project_id,job_id,attempt_id,run_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
    ON CONFLICT (tenant_id,run_id) DO NOTHING RETURNING run_id`,
  [identity.tenantId, identity.projectId, identity.jobId, identity.attemptId, identity.runId,
    JSON.stringify(record), tag(integrityKey, record)]);
  if (inserted.rows.length === 1) return Object.freeze({ plan: verifiedPlan, replayed: false as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
  const raced = (await tx.query<Row>(`SELECT tenant_id,project_id,job_id,attempt_id,run_id,record,auth_tag
    FROM control_worktree_change_audit_plans WHERE tenant_id=$1 AND run_id=$2`,
  [identity.tenantId, identity.runId])).rows[0];
  if (!raced) fail();
  const prior = verify(integrityKey, raced);
  if (sha256Digest(prior.record) !== sha256Digest(record)) fail();
  return Object.freeze({ plan: prior.plan, replayed: true as const, startsWork: false as const,
    grantsExecutionAuthority: false as const });
}
