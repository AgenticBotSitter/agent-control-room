import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
import { taskReviewDraftSchema } from "./task-review-wire";
import { taskPlanningReceiptSchema } from "./task-planning-wire";
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
export const taskRevisionReceiptSchema = taskPlanningReceiptSchema.extend({ rootSubjectId: id, rootTargetId: id,
  fromRunId: id, fromTargetId: id, fromTargetDigest: digest, fromContentHash: digest, reviewId: id, feedbackDigest: digest,
  revisionNumber: z.number().int().min(1).max(20),
  executionAvailability: z.literal("requires_separate_assignment_and_approval") }).strict();
export const taskRevisionCommandSchema = z.object({ receipt: taskRevisionReceiptSchema, replayed: z.boolean() }).strict();
export type TaskRevisionReceipt = z.infer<typeof taskRevisionReceiptSchema>;
export { nativeRevisionContextSchema as taskRevisionContextSchema } from "../../completion-gate/v1/native-revision-context";
