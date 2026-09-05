import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), time = z.string().datetime();
export const taskResultMetadataSchema = z.object({ artifactId: id, attemptId: id, runId: id, contentHash: digest,
  sizeBytes: z.number().int().min(0).max(65_536), receivedAt: time, byteCheck: z.literal("matched_recorded_claim"),
  qualityAccepted: z.literal(false) }).strict();
export type TaskResultMetadata = z.infer<typeof taskResultMetadataSchema>;
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
  contentVerifiedAt: time, untrustedContent: z.literal(true) }).strict();
export type TaskResultContent = z.infer<typeof taskResultContentSchema>;
