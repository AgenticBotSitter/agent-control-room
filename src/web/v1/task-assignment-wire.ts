import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskAssignmentDraftSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), nodeId: id, expectedInputDigest: digest }).strict(),
  z.object({ action: z.literal("expire"), expectedInputDigest: digest }).strict(),
]);
export type TaskAssignmentDraft = z.infer<typeof taskAssignmentDraftSchema>;
export const taskAssignmentReceiptSchema = z.object({ projectId: id, jobId: id, inputDigest: digest, nodeId: id,
  attemptId: id, leaseId: id, leaseEpoch: z.number().int().nonnegative(), acquiredAt: z.string().datetime(), expiresAt: z.string().datetime(),
  leaseState: z.enum(["active", "released", "expired", "revoked"]), leaseCurrent: z.boolean(),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();
export type TaskAssignmentReceipt = z.infer<typeof taskAssignmentReceiptSchema>;
export const taskAssignmentCommandSchema = z.object({ receipt: taskAssignmentReceiptSchema, replayed: z.boolean() }).strict();
export const taskAssignmentOptionsSchema = z.object({ projectId: id, jobId: id, inputDigest: digest,
  candidates: z.array(z.object({ nodeId: id, label: z.string().min(1).max(180), platform: z.enum(["macos", "windows", "linux", "cloud"]) }).strict()).max(64),
  receipt: taskAssignmentReceiptSchema.nullable(), startsWork: z.literal(false), candidateEvidence: z.literal("configured_routes_only") }).strict();
export type TaskAssignmentOptions = z.infer<typeof taskAssignmentOptionsSchema>;
