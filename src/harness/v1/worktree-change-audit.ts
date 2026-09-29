import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { assertCodexWorkspaceLeaseV1, type CodexWorkspaceLeaseV1 } from "../codex-v1/workspace";
import { controllerWorkerDeliverySchemaV1 } from "./controller-worker-delivery";

/**
 * Shared evidence contract for a future harness that is allowed to propose a
 * change from an isolated Git worktree. It is deliberately not a workspace
 * manager, a Git runner, a scheduler, or a permission grant. Existing owned
 * workspace code creates/removes the worktree; this module only verifies the
 * bounded change inventory returned afterward.
 */
export const WORKTREE_CHANGE_AUDIT_PLAN_V1 = "control-room.worktree-change-audit-plan/v1" as const;
export const WORKTREE_CHANGE_AUDIT_EVIDENCE_V1 = "control-room.worktree-change-audit-evidence/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const relativePath = z.string().min(1).max(1024).superRefine((value, context) => {
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")
    || value.split("/").some(part => !part || part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "worktree path is not a safe relative path" });
  }
});
const scope = z.string().min(1).max(1024).superRefine((value, context) => {
  if (value.endsWith("/**")) {
    const root = value.slice(0, -3);
    if (!relativePath.safeParse(root).success) context.addIssue({ code: "custom", message: "worktree scope is invalid" });
  } else if (!relativePath.safeParse(value).success) context.addIssue({ code: "custom", message: "worktree scope is invalid" });
});

const planSchema = z.object({
  schema: z.literal(WORKTREE_CHANGE_AUDIT_PLAN_V1),
  /** Binds the audit to the controller-prepared delivery, never to a branch name. */
  deliveryDigest: digest,
  /** Binds the audit to one existing isolated-worktree lease. */
  worktreeLeaseDigest: digest,
  baseRevision: revision,
  allowedPaths: z.array(scope).min(1).max(100),
  maximumChangedFiles: z.number().int().min(1).max(500),
  maximumChangedBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  planDigest: digest,
}).strict();

const evidenceSchema = z.object({
  schema: z.literal(WORKTREE_CHANGE_AUDIT_EVIDENCE_V1),
  planDigest: digest,
  baseRevision: revision,
  /** A content digest lets the later result path bind evidence without storing a patch in this record. */
  changes: z.array(z.object({ path: relativePath, kind: z.enum(["added", "modified", "deleted"]),
    bytes: z.number().int().min(0).max(16 * 1024 * 1024), contentDigest: digest }).strict()).max(500),
  evidenceDigest: digest,
}).strict();

export type WorktreeChangeAuditPlanV1 = Readonly<Omit<z.infer<typeof planSchema>, "allowedPaths"> & {
  allowedPaths: readonly string[];
}>;
export type WorktreeChangeAuditEvidenceV1 = Readonly<Omit<z.infer<typeof evidenceSchema>, "changes"> & {
  changes: readonly Readonly<z.infer<typeof evidenceSchema>["changes"][number]>[];
}>;

function allowed(path: string, scopes: readonly string[]): boolean {
  return scopes.some(value => value.endsWith("/**") ? path.startsWith(`${value.slice(0, -3)}/`) : path === value);
}

function freezePlan(value: z.infer<typeof planSchema>): WorktreeChangeAuditPlanV1 {
  return Object.freeze({ ...value, allowedPaths: Object.freeze([...value.allowedPaths]) });
}

function freezeEvidence(value: z.infer<typeof evidenceSchema>): WorktreeChangeAuditEvidenceV1 {
  return Object.freeze({ ...value, changes: Object.freeze(value.changes.map(change => Object.freeze({ ...change }))) });
}

/** Creates a deterministic, side-effect-free audit plan from already-authorized inputs. */
export function createWorktreeChangeAuditPlanV1(input: Omit<WorktreeChangeAuditPlanV1, "schema" | "planDigest">): WorktreeChangeAuditPlanV1 {
  const parsed = z.object({ deliveryDigest: digest, worktreeLeaseDigest: digest, baseRevision: revision,
    allowedPaths: z.array(scope).min(1).max(100), maximumChangedFiles: z.number().int().min(1).max(500),
    maximumChangedBytes: z.number().int().min(1).max(16 * 1024 * 1024) }).strict().parse(input);
  const allowedPaths = [...new Set(parsed.allowedPaths)].sort();
  if (allowedPaths.length !== parsed.allowedPaths.length) throw new Error("worktree_change_audit_scope_duplicated");
  const material = { schema: WORKTREE_CHANGE_AUDIT_PLAN_V1, ...parsed, allowedPaths };
  return freezePlan({ ...material, planDigest: sha256Digest(material) });
}

/**
 * Connects the shared isolated-worktree evidence rule to the existing
 * controller delivery and workspace lease.  The workspace manager remains
 * responsible for its physical Git operations; this helper merely ensures a
 * later code-writing adapter cannot mix one task's packet with another task's
 * worktree or base revision.  It returns no private filesystem path.
 */
export function createControllerDeliveryWorktreeChangeAuditPlanV1(input: Readonly<{
  delivery: unknown;
  lease: CodexWorkspaceLeaseV1;
  allowedPaths: readonly string[];
  maximumChangedFiles: number;
  maximumChangedBytes: number;
}>): WorktreeChangeAuditPlanV1 {
  const delivery = controllerWorkerDeliverySchemaV1.parse(input.delivery);
  const lease = { ...input.lease };
  assertCodexWorkspaceLeaseV1(lease);
  if (lease.runId !== delivery.identity.runId) throw new Error("worktree_change_audit_delivery_lease_mismatch");
  return createWorktreeChangeAuditPlanV1({ deliveryDigest: delivery.deliveryDigest,
    worktreeLeaseDigest: lease.leaseId, baseRevision: lease.revision,
    allowedPaths: [...input.allowedPaths], maximumChangedFiles: input.maximumChangedFiles,
    maximumChangedBytes: input.maximumChangedBytes });
}

export function verifyWorktreeChangeAuditPlanV1(value: unknown): WorktreeChangeAuditPlanV1 {
  const parsed = planSchema.parse(value);
  const expected = createWorktreeChangeAuditPlanV1({ deliveryDigest: parsed.deliveryDigest, worktreeLeaseDigest: parsed.worktreeLeaseDigest,
    baseRevision: parsed.baseRevision, allowedPaths: parsed.allowedPaths, maximumChangedFiles: parsed.maximumChangedFiles,
    maximumChangedBytes: parsed.maximumChangedBytes });
  if (canonicalJson(expected) !== canonicalJson(parsed)) throw new Error("worktree_change_audit_plan_invalid");
  return expected;
}

/**
 * Validates a read-only inventory supplied by the existing isolated-worktree
 * boundary. It never reads a filesystem, runs Git, deletes a worktree, starts
 * a harness, or treats valid evidence as execution permission.
 */
export function createWorktreeChangeAuditEvidenceV1(planValue: unknown,
  input: Omit<WorktreeChangeAuditEvidenceV1, "schema" | "planDigest" | "evidenceDigest">): WorktreeChangeAuditEvidenceV1 {
  const plan = verifyWorktreeChangeAuditPlanV1(planValue);
  const changes = z.array(z.object({ path: relativePath, kind: z.enum(["added", "modified", "deleted"]),
    bytes: z.number().int().min(0).max(16 * 1024 * 1024), contentDigest: digest }).strict()).max(500).parse(input.changes);
  if (input.baseRevision !== plan.baseRevision || changes.length > plan.maximumChangedFiles
    || new Set(changes.map(change => change.path)).size !== changes.length
    || changes.some(change => !allowed(change.path, plan.allowedPaths))
    || changes.reduce((total, change) => total + change.bytes, 0) > plan.maximumChangedBytes) {
    throw new Error("worktree_change_audit_evidence_out_of_scope");
  }
  const ordered = [...changes].sort((left, right) => left.path.localeCompare(right.path));
  const material = { schema: WORKTREE_CHANGE_AUDIT_EVIDENCE_V1, planDigest: plan.planDigest,
    baseRevision: plan.baseRevision, changes: ordered };
  return freezeEvidence({ ...material, evidenceDigest: sha256Digest(material) });
}

export function verifyWorktreeChangeAuditEvidenceV1(planValue: unknown, value: unknown): WorktreeChangeAuditEvidenceV1 {
  const plan = verifyWorktreeChangeAuditPlanV1(planValue), parsed = evidenceSchema.parse(value);
  const expected = createWorktreeChangeAuditEvidenceV1(plan, { baseRevision: parsed.baseRevision, changes: parsed.changes });
  if (canonicalJson(expected) !== canonicalJson(parsed)) throw new Error("worktree_change_audit_evidence_invalid");
  return expected;
}
