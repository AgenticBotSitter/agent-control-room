import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
import { taskReviewDraftSchema } from "./task-review-wire";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskRevisionRequestSchema = z.object({ runId: id, targetId: id, targetDigest: digest,
  contentHash: digest, reviewId: id, feedback: z.string() }).strict().superRefine((value, ctx) => {
  // Reuse the exact feedback normalization/control-character/UTF-8 bounds without
  // accepting review commands or caller-selected execution authority.
  const checked = taskReviewDraftSchema.safeParse({ artifactId: "artifact:revision-input", targetId: value.targetId,
    targetDigest: value.targetDigest, contentHash: value.contentHash, decision: "changes_requested", feedback: value.feedback });
  if (!checked.success || checked.data.feedback !== value.feedback) ctx.addIssue({ code: "custom", message: "invalid revision feedback" });
});
export type TaskRevisionRequest = z.infer<typeof taskRevisionRequestSchema>;
export const taskRevisionContextSchema = z.object({ rootSubjectId: id, rootTargetId: id, fromJobId: id, fromRunId: id,
  fromTargetId: id, fromTargetDigest: digest, fromContentHash: digest, reviewId: id, reviewDigest: digest,
  findingIds: z.array(id).min(1).max(100), feedbackDigest: digest, sourcePlanDigest: digest,
  revisionNumber: z.number().int().min(1).max(100), originalPrompt: z.string().min(1).max(4000) }).strict();
