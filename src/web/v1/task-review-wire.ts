import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskReviewDraftSchema = z.object({ artifactId: id, targetId: id, targetDigest: digest,
  contentHash: digest, decision: z.enum(["accepted", "changes_requested"]),
  feedback: z.string().trim().max(4096).refine(value => [...value].every(char => {
    const code = char.codePointAt(0)!; return code >= 32 && code !== 127 || [9, 10, 13].includes(code);
  }))
    .refine(value => new TextEncoder().encode(value).byteLength <= 4096) }).strict()
  .refine(value => value.decision === "changes_requested" ? value.feedback.length > 0 : value.feedback.length === 0);
export type TaskReviewDraft = z.infer<typeof taskReviewDraftSchema>;
export const taskReviewReceiptSchema = z.object({ projectId: id, jobId: id, artifactId: id, targetId: id,
  targetDigest: digest, contentHash: digest, reviewId: id, findingId: id.nullable(),
  decision: z.enum(["accepted", "changes_requested"]), feedbackDigest: digest, recordedAt: z.string().datetime(),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), startsRevision: z.literal(false) }).strict();
export type TaskReviewReceipt = z.infer<typeof taskReviewReceiptSchema>;
export const taskReviewCommandSchema = z.object({ receipt: taskReviewReceiptSchema, replayed: z.boolean() }).strict();
export const taskReviewNoteSchema = z.object({ reviewId: id, findingId: id.nullable(), artifactId: id, targetId: id,
  contentHash: digest, targetDigest: digest,
  decision: z.enum(["accepted", "changes_requested"]), feedback: z.string().max(4096), recordedAt: z.string().datetime() }).strict();
export const taskReviewOptionsSchema = z.object({ projectId: id, jobId: id, targetId: id, targetDigest: digest,
  contentHash: digest, artifactId: id, canReview: z.boolean(),
  availability: z.enum(["available", "not_configured", "access_denied", "project_inactive", "already_reviewed", "target_closed", "independence_required"]),
  ownReview: taskReviewNoteSchema.nullable(), grantsExecutionAuthority: z.literal(false),
  revisionPlanning: z.enum(["configured", "not_connected"]).optional() }).strict();
export type TaskReviewOptions = z.infer<typeof taskReviewOptionsSchema>;
