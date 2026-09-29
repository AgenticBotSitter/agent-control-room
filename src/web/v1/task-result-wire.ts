import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), time = z.string().datetime();
export const taskReviewEvidenceSchema = z.object({ targetId: id, kind: z.enum(["code", "media", "document", "operation"]),
  targetDigest: digest, contentHash: digest, revision: z.number().int().min(0).max(20), supersedesTargetId: id.nullable(),
  status: z.enum(["pending", "changes_requested", "verification_blocked", "revision_limit_reached", "ready", "superseded"]),
  matchingArtifactIds: z.array(id).max(50), additionalEvidenceOmitted: z.boolean(),
  reviews: z.array(z.object({ id, decision: z.enum(["commented", "accepted", "changes_requested", "rejected"]),
    authority: z.enum(["advisory", "completion_gate"]), reviewedAt: time }).strict()).max(50),
  verifications: z.array(z.object({ id, scenarioId: id, outcome: z.enum(["passed", "failed", "blocked", "inconclusive"]),
    verifiedAt: time }).strict()).max(50),
  findings: z.array(z.object({ id, code: id, severity: z.enum(["low", "medium", "high", "critical"]),
    statementDigest: digest, raisedAt: time }).strict()).max(100),
  missingVerificationScenarioIds: z.array(id).max(50), openFindingCount: z.number().int().nonnegative(),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();
export type TaskReviewEvidence = z.infer<typeof taskReviewEvidenceSchema>;
const worktreeChangeSummarySchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("not_configured") }).strict(),
  z.object({ source: z.literal("not_authorized") }).strict(),
  z.object({ source: z.literal("not_applicable") }).strict(),
  z.object({ source: z.literal("unavailable") }).strict(),
  z.object({ source: z.literal("recorded"), changedFiles: z.number().int().nonnegative(),
    changedBytes: z.number().int().nonnegative(), addedFiles: z.number().int().nonnegative(),
    modifiedFiles: z.number().int().nonnegative(), deletedFiles: z.number().int().nonnegative(), evidenceDigest: digest,
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false), permitsRetry: z.literal(false),
    permitsResume: z.literal(false), permitsApproval: z.literal(false), permitsMerge: z.literal(false) }).strict(),
]);
/** Aggregate-only coding-work evidence. Undefined is treated as not configured
 * for backward compatible browser reads, never as a zero-change audit. */
export const taskWorktreeChangeSummarySchema = worktreeChangeSummarySchema;
export type TaskWorktreeChangeSummary = z.infer<typeof taskWorktreeChangeSummarySchema>;
export const taskWorktreeChangeDetailSchema = z.object({
  schema: z.literal("control-room.worktree-change-audit-detail/v1"),
  baseRevision: z.string().regex(/^[a-f0-9]{40}$/), headRevision: z.string().regex(/^[a-f0-9]{40}$/),
  changes: z.array(z.object({ path: z.string().min(1).max(1024), kind: z.enum(["added", "modified", "deleted"]),
    bytes: z.number().int().nonnegative().max(16 * 1024 * 1024), contentDigest: digest }).strict()).max(500),
  commits: z.array(z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/), subject: z.string().max(500) }).strict()).max(200),
  commitsTruncated: z.boolean(),
  unifiedDiff: z.object({ text: z.string().max(65_536), originalBytes: z.number().int().nonnegative(),
    retainedBytes: z.number().int().nonnegative().max(65_536), truncated: z.boolean(),
    contentDigest: digest, retainedDigest: digest }).strict(),
  confinement: z.object({ kind: z.literal("workspace_write"), outsideWorktree: z.literal("refused"),
    evidenceDigest: digest }).strict(),
  evidenceDigest: digest,
}).strict();
export type TaskWorktreeChangeDetail = z.infer<typeof taskWorktreeChangeDetailSchema>;
export const taskResultMetadataSchema = z.object({ artifactId: id, attemptId: id, runId: id, contentHash: digest,
  sizeBytes: z.number().int().min(0).max(65_536), receivedAt: time, byteCheck: z.literal("matched_recorded_claim"),
  modelSelection: z.object({ model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/),
    effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]),
    provider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/).optional(),
    profile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/).optional() }).strict().optional(),
  qualityAccepted: z.literal(false),
  fileAccess: z.object({ previewHref: z.string().startsWith("/api/v1/").max(4096),
    downloadHref: z.string().startsWith("/api/v1/").max(4096), expiresAt: time }).strict().optional(),
  /** Bound to this result artifact only; missing never means zero changes. */
  worktreeChangeSummary: taskWorktreeChangeSummarySchema.optional() }).strict();
export type TaskResultMetadata = z.infer<typeof taskResultMetadataSchema>;
export const taskResultsPageSchema = z.object({ projectId: id, jobId: id, observedAt: time,
  resultSource: z.enum(["configured", "not_configured"]), reviewSource: z.enum(["configured", "not_configured"]),
  items: z.array(taskResultMetadataSchema).max(50), reviews: z.array(taskReviewEvidenceSchema).max(20),
  additionalResultsOmitted: z.boolean(), additionalTargetsOmitted: z.boolean(), canReadContent: z.boolean(),
  reviewCommands: z.enum(["not_connected", "configured"]),
  verificationCommands: z.enum(["not_connected", "configured"]).optional() }).strict();
export type TaskResultsPage = z.infer<typeof taskResultsPageSchema>;
/** Keep a valid private page below the browser's one-MiB reader limit. Quality state has already
 * been calculated from the complete verified history; omit oldest whole projections, not findings
 * from that calculation. Never alter a retained target's status or omission evidence. */
export function boundedTaskResultsPage(value: unknown): TaskResultsPage {
  const page = taskResultsPageSchema.parse(value);
  const size = () => new TextEncoder().encode(JSON.stringify(page)).byteLength;
  while (size() > 524_288 && page.reviews.length) {
    page.reviews.pop(); page.additionalTargetsOmitted = true;
  }
  if (size() > 524_288) throw new Error("result_projection_unavailable");
  return page;
}
export const taskResultContentSchema = z.object({ projectId: id, jobId: id, artifact: taskResultMetadataSchema,
  text: z.string().refine(value => new TextEncoder().encode(value).byteLength <= 65_536),
  worktreeChangeEvidence: taskWorktreeChangeDetailSchema.optional(),
  contentVerifiedAt: time, untrustedContent: z.literal(true) }).strict();
export type TaskResultContent = z.infer<typeof taskResultContentSchema>;
