import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { durableResultReceiptSchemaV1 } from "../../artifacts/v1/durable-result-receipt";
import { digestSchema, localId } from "./native-run-identifiers";
import { verifyWorktreeChangeAuditEvidenceV1, verifyWorktreeChangeAuditPlanV1,
  type WorktreeChangeAuditEvidenceV1, type WorktreeChangeAuditPlanV1 } from "./worktree-change-audit";

/**
 * A transport- and storage-neutral binding between one durable result receipt
 * and its isolated-worktree audit.  A later owner-owned store may HMAC this
 * deterministic record; this contract neither accepts a key nor performs I/O.
 */
export const WORKTREE_CHANGE_AUDIT_RECORD_V1 = "control-room.worktree-change-audit-record/v1" as const;
export const WORKTREE_CHANGE_AUDIT_SUMMARY_V1 = "control-room.worktree-change-audit-summary/v1" as const;

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const identitySchema = z.object({
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId,
  artifactId: z.string().regex(/^artifact:result:[a-f0-9]{64}$/),
}).strict();

const materialSchema = z.object({
  schema: z.literal(WORKTREE_CHANGE_AUDIT_RECORD_V1), identity: identitySchema,
  resultReceiptDigest: digestSchema,
  plan: z.unknown(), evidence: z.unknown(), recordedAt: instant,
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false), permitsRetry: z.literal(false),
  permitsResume: z.literal(false), permitsApproval: z.literal(false), permitsMerge: z.literal(false),
  performsProviderIo: z.literal(false), performsFilesystemIo: z.literal(false),
}).strict();

export const worktreeChangeAuditRecordSchemaV1 = materialSchema.extend({ recordDigest: digestSchema }).strict();
export type WorktreeChangeAuditRecordV1 = Readonly<Omit<z.infer<typeof worktreeChangeAuditRecordSchemaV1>, "plan" | "evidence"> & {
  plan: WorktreeChangeAuditPlanV1;
  evidence: WorktreeChangeAuditEvidenceV1;
}>;

export type WorktreeChangeAuditSummaryV1 = Readonly<{
  schema: typeof WORKTREE_CHANGE_AUDIT_SUMMARY_V1;
  /** A browser projection is evidence only; it cannot advance any workflow. */
  startsWork: false;
  grantsExecutionAuthority: false;
  permitsRetry: false;
  permitsResume: false;
  permitsApproval: false;
  permitsMerge: false;
  changedFiles: number;
  changedBytes: number;
  addedFiles: number;
  modifiedFiles: number;
  deletedFiles: number;
  evidenceDigest: string;
}>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function material(input: {
  identity: unknown; resultReceipt: unknown; plan: unknown; evidence: unknown; recordedAt: unknown;
}) {
  const identity = identitySchema.parse(input.identity);
  const resultReceipt = durableResultReceiptSchemaV1.parse(input.resultReceipt);
  if (resultReceipt.tenantId !== identity.tenantId || resultReceipt.projectId !== identity.projectId
    || resultReceipt.jobId !== identity.jobId || resultReceipt.attemptId !== identity.attemptId
    || resultReceipt.runId !== identity.runId || resultReceipt.artifactId !== identity.artifactId) {
    throw new Error("worktree_change_audit_result_identity_mismatch");
  }
  const recordedAt = instant.parse(input.recordedAt);
  if (Date.parse(recordedAt) < Date.parse(resultReceipt.receivedAt)) {
    throw new Error("worktree_change_audit_recorded_before_result");
  }
  const plan = verifyWorktreeChangeAuditPlanV1(input.plan);
  const evidence = verifyWorktreeChangeAuditEvidenceV1(plan, input.evidence);
  return materialSchema.parse({ schema: WORKTREE_CHANGE_AUDIT_RECORD_V1, identity,
    resultReceiptDigest: sha256Digest(resultReceipt), plan, evidence, recordedAt,
    startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsResume: false,
    permitsApproval: false, permitsMerge: false, performsProviderIo: false, performsFilesystemIo: false });
}

/** Creates an immutable, deterministic record suitable for a later HMAC-owned persistence boundary. */
export function createWorktreeChangeAuditRecordV1(input: {
  identity: unknown; resultReceipt: unknown; plan: unknown; evidence: unknown; recordedAt: unknown;
}): WorktreeChangeAuditRecordV1 {
  const value = material(input);
  return deepFreeze(worktreeChangeAuditRecordSchemaV1.parse({ ...value, recordDigest: sha256Digest(value) })) as WorktreeChangeAuditRecordV1;
}

/** Re-verifies nested audit material and rejects any altered record field or digest. */
export function verifyWorktreeChangeAuditRecordV1(value: unknown): WorktreeChangeAuditRecordV1 {
  const parsed = worktreeChangeAuditRecordSchemaV1.parse(value);
  // The record intentionally retains only a digest of the protected durable
  // receipt. The persistence boundary must authenticate the stored receipt
  // before it creates this record; this pure verifier can only check that the
  // already-derived record was not altered afterward.
  const materialValue = { schema: WORKTREE_CHANGE_AUDIT_RECORD_V1, identity: parsed.identity,
    resultReceiptDigest: parsed.resultReceiptDigest, plan: verifyWorktreeChangeAuditPlanV1(parsed.plan),
    evidence: verifyWorktreeChangeAuditEvidenceV1(parsed.plan, parsed.evidence), recordedAt: parsed.recordedAt,
    startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsResume: false,
    permitsApproval: false, permitsMerge: false, performsProviderIo: false, performsFilesystemIo: false };
  const expected = worktreeChangeAuditRecordSchemaV1.parse({ ...materialValue, recordDigest: sha256Digest(materialValue) });
  if (canonicalJson(expected) !== canonicalJson(parsed)) throw new Error("worktree_change_audit_record_invalid");
  return deepFreeze(expected) as WorktreeChangeAuditRecordV1;
}

/**
 * Deliberately omits worktree paths, allowed scopes, revisions, lease data,
 * result receipt data, and per-file content digests.  It is safe to pass to a
 * browser only as an aggregate audit projection, never as change evidence.
 */
export function summarizeWorktreeChangeAuditRecordV1(value: unknown): WorktreeChangeAuditSummaryV1 {
  const record = verifyWorktreeChangeAuditRecordV1(value), changes = record.evidence.changes;
  return deepFreeze({ schema: WORKTREE_CHANGE_AUDIT_SUMMARY_V1,
    startsWork: false, grantsExecutionAuthority: false, permitsRetry: false,
    permitsResume: false, permitsApproval: false, permitsMerge: false,
    changedFiles: changes.length,
    changedBytes: changes.reduce((total, change) => total + change.bytes, 0),
    addedFiles: changes.filter(change => change.kind === "added").length,
    modifiedFiles: changes.filter(change => change.kind === "modified").length,
    deletedFiles: changes.filter(change => change.kind === "deleted").length,
    evidenceDigest: record.evidence.evidenceDigest });
}
