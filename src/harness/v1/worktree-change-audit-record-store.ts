import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { verifyDurableResultReceiptV1 } from "../../artifacts/v1/durable-result-receipt";
import { createWorktreeChangeAuditRecordV1, verifyWorktreeChangeAuditRecordV1,
  summarizeWorktreeChangeAuditRecordV1, type WorktreeChangeAuditRecordV1,
  type WorktreeChangeAuditSummaryV1 } from "./worktree-change-audit-record";
import { readManagedWorktreeChangeAuditPlanV1 } from "./worktree-change-audit-plan-store";

/** Protected persistence for result-bound worktree audit evidence only. */
export const WORKTREE_CHANGE_AUDIT_RECORD_STORE_V1 =
  "control-room.worktree-change-audit-record-store/v1" as const;

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const localId = z.string().regex(/^[a-z][a-z0-9._:-]{2,179}$/i);
const artifactId = z.string().regex(/^artifact:result:[a-f0-9]{64}$/);
const scopeSchema = z.object({
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId, artifactId,
}).strict();
type Scope = z.infer<typeof scopeSchema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; run_id: string;
  artifact_id: string; record: unknown; auth_tag: string };
type ReceiptRow = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; run_id: string;
  artifact_id: string; receipt: unknown; auth_tag: string };
const fail = (): never => { throw new Error("worktree_change_audit_record_unavailable"); };
const tag = (key: Uint8Array, record: WorktreeChangeAuditRecordV1) => hmacSha256Tag(key,
  { purpose: "worktree-change-audit-record-store/v1", record });

function sameScope(scope: Scope, row: Row | ReceiptRow): boolean {
  return scope.tenantId === row.tenant_id && scope.projectId === row.project_id && scope.jobId === row.job_id
    && scope.attemptId === row.attempt_id && scope.runId === row.run_id && scope.artifactId === row.artifact_id;
}

function sameIdentity(scope: Scope, identity: WorktreeChangeAuditRecordV1["identity"]): boolean {
  return scope.tenantId === identity.tenantId && scope.projectId === identity.projectId && scope.jobId === identity.jobId
    && scope.attemptId === identity.attemptId && scope.runId === identity.runId && scope.artifactId === identity.artifactId;
}

function verifyStored(key: Uint8Array, row: Row): WorktreeChangeAuditRecordV1 {
  const record = verifyWorktreeChangeAuditRecordV1(row.record);
  const expected = Buffer.from(tag(key, record)), actual = Buffer.from(row.auth_tag);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || !sameScope(record.identity, row)) fail();
  return record;
}

async function readCanonicalDurableResult(tx: DatabaseSession, key: Uint8Array, scope: Scope) {
  const row = (await tx.query<ReceiptRow>(`SELECT tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,receipt,auth_tag
    FROM control_native_artifact_receipts
    WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3 AND attempt_id=$4 AND run_id=$5 AND artifact_id=$6`,
  [scope.tenantId, scope.projectId, scope.jobId, scope.attemptId, scope.runId, scope.artifactId])).rows[0];
  if (!row || !sameScope(scope, row)) fail();
  // Native/legacy receipt shapes do not parse here. A row is usable only if
  // it is itself a valid HMAC-authenticated durable-result receipt.
  const receipt = verifyDurableResultReceiptV1(row.receipt, key, row.auth_tag);
  if (receipt.tenantId !== scope.tenantId || receipt.projectId !== scope.projectId || receipt.jobId !== scope.jobId
    || receipt.attemptId !== scope.attemptId || receipt.runId !== scope.runId || receipt.artifactId !== scope.artifactId) fail();
  return receipt;
}

/**
 * Appends immutable audit evidence after the store itself reads and authenticates
 * both authorities: the complete historical plan and durable result receipt.
 * Callers supply only complete lineage, inventory evidence, and recorded time.
 */
export async function persistResultBoundWorktreeChangeAuditRecordV1(tx: DatabaseSession, integrityKey: Uint8Array,
  input: Readonly<{ scope: unknown; evidence: unknown; recordedAt: unknown }>) {
  if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) fail();
  const scope = scopeSchema.parse(input.scope);
  const recordedAt = instant.parse(input.recordedAt);
  const planEntry = await readManagedWorktreeChangeAuditPlanV1(tx, integrityKey, {
    tenantId: scope.tenantId, projectId: scope.projectId, jobId: scope.jobId,
    attemptId: scope.attemptId, runId: scope.runId,
  });
  const plan = planEntry ?? fail();
  if (Date.parse(recordedAt) < Date.parse(plan.recordedAt)) fail();
  const resultReceipt = await readCanonicalDurableResult(tx, integrityKey, scope);
  if (Date.parse(recordedAt) < Date.parse(resultReceipt.receivedAt)) fail();
  const record = createWorktreeChangeAuditRecordV1({ identity: scope, resultReceipt,
    plan: plan.plan, evidence: input.evidence, recordedAt });
  assertNoSecretMaterial(record, "result-bound worktree change audit");
  const current = (await tx.query<Row>(`SELECT tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,record,auth_tag
    FROM control_worktree_change_audit_records WHERE tenant_id=$1 AND run_id=$2 AND artifact_id=$3`,
  [scope.tenantId, scope.runId, scope.artifactId])).rows[0];
  if (current) {
    const prior = verifyStored(integrityKey, current);
    if (sha256Digest(prior) !== sha256Digest(record)) fail();
    return Object.freeze({ record: prior, replayed: true as const, startsWork: false as const,
      grantsExecutionAuthority: false as const });
  }
  const inserted = await tx.query<{ artifact_id: string }>(`INSERT INTO control_worktree_change_audit_records
    (tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,record,auth_tag)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (tenant_id,run_id,artifact_id) DO NOTHING RETURNING artifact_id`,
  [scope.tenantId, scope.projectId, scope.jobId, scope.attemptId, scope.runId, scope.artifactId,
    JSON.stringify(record), tag(integrityKey, record)]);
  if (inserted.rows.length === 1) return Object.freeze({ record, replayed: false as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
  const raced = (await tx.query<Row>(`SELECT tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,record,auth_tag
    FROM control_worktree_change_audit_records WHERE tenant_id=$1 AND run_id=$2 AND artifact_id=$3`,
  [scope.tenantId, scope.runId, scope.artifactId])).rows[0];
  if (!raced) fail();
  const prior = verifyStored(integrityKey, raced);
  if (sha256Digest(prior) !== sha256Digest(record)) fail();
  return Object.freeze({ record: prior, replayed: true as const, startsWork: false as const,
    grantsExecutionAuthority: false as const });
}

/**
 * Reads one complete, HMAC-authenticated evidence record and returns only its
 * deliberately safe aggregate.  This belongs on the separately-preflighted
 * evidence connection: callers never receive the protected record, plan,
 * receipt, worktree path, revision, or per-file digest.
 *
 * A missing record is an honest absence. A malformed, retagged, or
 * cross-lineage record is an unavailable evidence condition, never a zero
 * change summary.
 */
export async function readResultBoundWorktreeChangeAuditSummaryV1(tx: DatabaseSession, integrityKey: Uint8Array,
  scopeValue: unknown): Promise<WorktreeChangeAuditSummaryV1 | undefined> {
  if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) fail();
  const scope = scopeSchema.parse(scopeValue);
  const row = (await tx.query<Row>(`SELECT tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,record,auth_tag
    FROM control_worktree_change_audit_records
    WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3 AND attempt_id=$4 AND run_id=$5 AND artifact_id=$6`,
  [scope.tenantId, scope.projectId, scope.jobId, scope.attemptId, scope.runId, scope.artifactId])).rows[0];
  if (!row) return undefined;
  const record = verifyStored(integrityKey, row);
  if (!sameIdentity(scope, record.identity)) fail();
  return summarizeWorktreeChangeAuditRecordV1(record);
}
