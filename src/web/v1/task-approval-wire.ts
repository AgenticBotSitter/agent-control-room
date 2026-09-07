import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
export const approvalDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const digest = approvalDigestSchema;
const scope = { projectId: id, jobId: id, inputDigest: digest };
const receipt = { projectId: id, jobId: id, attemptId: id, packetDigest: digest, operationDigest: digest,
  acceptedAt: z.string().datetime(), startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) };
export const taskApprovalReceiptSchema = z.object({ ...receipt, evidence: z.literal("stored_signatures_only") }).strict();
export const taskApprovalReadSchema = z.object({ ...scope, receipt: taskApprovalReceiptSchema.nullable() }).strict();
export const taskApprovalSavedSchema = z.object({ ...scope,
  receipt: z.object({ ...receipt, replayed: z.boolean() }).strict() }).strict();
export const taskApprovalReviewSchema = z.object({ ...scope, attemptId: id, nodeId: id,
  prompt: z.string().min(1).max(4000), instructions: z.string().max(8192),
  model: z.string().min(1).max(160), provider: z.string().min(1).max(64),
  durationSeconds: z.number().int().min(1).max(300), deadline: z.string().datetime(), operationDigest: digest,
  signatureStatus: z.literal("unsigned"), startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();
export type TaskApprovalRead = z.infer<typeof taskApprovalReadSchema>;
export type TaskApprovalReview = z.infer<typeof taskApprovalReviewSchema>;
export type TaskApprovalSaved = z.infer<typeof taskApprovalSavedSchema>;
