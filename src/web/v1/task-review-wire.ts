import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const acceptanceAttestation = z.object({ scenarioId: id, instructionsDigest: digest, confirmed: z.literal(true) }).strict();
const printableLine = (max: number) => z.string().trim().min(1).max(max).refine(value => [...value].every(char => {
  const code = char.codePointAt(0)!; return code >= 32 && code !== 127;
})).refine(value => new TextEncoder().encode(value).byteLength <= max);
const decisions = ["accepted", "accepted_with_exceptions", "changes_requested"] as const;
export const MAX_TASK_REVIEW_EXCEPTIONS_V1 = 10;
export const taskReviewDraftSchema = z.object({ artifactId: id, targetId: id, targetDigest: digest,
  contentHash: digest, decision: z.enum(decisions),
  acceptanceAttestation: acceptanceAttestation.optional(),
  exceptions: z.array(printableLine(300)).min(1).max(MAX_TASK_REVIEW_EXCEPTIONS_V1)
    .refine(values => new Set(values).size === values.length, "exceptions must be distinct").optional(),
  feedback: z.string().trim().max(4096).refine(value => [...value].every(char => {
    const code = char.codePointAt(0)!; return code >= 32 && code !== 127 || [9, 10, 13].includes(code);
  }))
    .refine(value => new TextEncoder().encode(value).byteLength <= 4096) }).strict()
  .superRefine((value, context) => {
    if (value.decision === "changes_requested") {
      if (!(value.feedback.length > 0) || value.acceptanceAttestation !== undefined)
        context.addIssue({ code: "custom", message: "changes requested needs feedback text and no attestation", path: ["feedback"] });
      if (value.exceptions !== undefined) context.addIssue({ code: "custom", message: "changes requested cannot carry exceptions", path: ["exceptions"] });
    } else if (value.decision === "accepted_with_exceptions") {
      if (!value.exceptions?.length) context.addIssue({ code: "custom", message: "accepted with exceptions needs at least one named exception", path: ["exceptions"] });
      if (value.feedback.length !== 0) context.addIssue({ code: "custom", message: "accepted with exceptions does not use the feedback field", path: ["feedback"] });
      if (value.acceptanceAttestation !== undefined) context.addIssue({ code: "custom", message: "accepted with exceptions does not use an acceptance attestation", path: ["acceptanceAttestation"] });
    } else {
      if (value.feedback.length !== 0) context.addIssue({ code: "custom", message: "accepted reviews do not use the feedback field", path: ["feedback"] });
      if (value.exceptions !== undefined) context.addIssue({ code: "custom", message: "accepted reviews cannot carry exceptions", path: ["exceptions"] });
    }
  });
export type TaskReviewDraft = z.infer<typeof taskReviewDraftSchema>;
export const taskReviewAuthenticationExpectationSchema = z.object({ actorId: digest, sessionEpoch: digest }).strict();
export type TaskReviewAuthenticationExpectation = z.infer<typeof taskReviewAuthenticationExpectationSchema>;
export const taskReviewRequestSchema = z.object({ review: taskReviewDraftSchema,
  expectedAuthentication: taskReviewAuthenticationExpectationSchema }).strict();
export const taskReviewAuthenticationMismatchHeader = "authenticated-session-changed";
export const taskReviewExceptionReceiptSchema = z.object({ statement: printableLine(300), followUpJobId: id }).strict();
export const taskReviewReceiptSchema = z.object({ projectId: id, jobId: id, artifactId: id, targetId: id,
  targetDigest: digest, contentHash: digest, reviewId: id, findingId: id.nullable(),
  decision: z.enum(decisions), exceptions: z.array(taskReviewExceptionReceiptSchema).max(MAX_TASK_REVIEW_EXCEPTIONS_V1).optional(),
  feedbackDigest: digest, recordedAt: z.string().datetime(),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), startsRevision: z.literal(false) }).strict();
export type TaskReviewReceipt = z.infer<typeof taskReviewReceiptSchema>;
export const taskReviewCommandSchema = z.object({ receipt: taskReviewReceiptSchema, replayed: z.boolean() }).strict();
export const taskReviewNoteSchema = z.object({ reviewId: id, findingId: id.nullable(), artifactId: id, targetId: id,
  contentHash: digest, targetDigest: digest, exceptions: z.array(taskReviewExceptionReceiptSchema).max(MAX_TASK_REVIEW_EXCEPTIONS_V1).optional(),
  decision: z.enum(decisions), feedback: z.string().max(4096), recordedAt: z.string().datetime() }).strict();
export const taskReviewOptionsSchema = z.object({ projectId: id, jobId: id, targetId: id, targetDigest: digest,
  contentHash: digest, artifactId: id, canReview: z.boolean(),
  availability: z.enum(["available", "not_configured", "access_denied", "project_inactive", "already_reviewed", "target_closed", "independence_required"]),
  ownReview: taskReviewNoteSchema.nullable(), grantsExecutionAuthority: z.literal(false),
  acceptanceAttestation: z.object({ scenarioId: id, label: z.string().min(1).max(120),
    instructions: z.string().min(1).max(2000), instructionsDigest: digest }).strict().nullable().optional(),
  revisionPlanning: z.enum(["configured", "not_connected"]).optional() }).strict();
export type TaskReviewOptions = z.infer<typeof taskReviewOptionsSchema>;
