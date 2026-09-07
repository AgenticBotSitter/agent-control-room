import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const outcome = z.enum(["passed", "failed", "blocked", "inconclusive"]);
const note = z.string().trim().min(1).max(4096).refine(value => new TextEncoder().encode(value).byteLength <= 4096
  && [...value].every(char => { const code = char.codePointAt(0)!; return code >= 32 && code !== 127 || [9, 10, 13].includes(code); }));
export const taskVerificationBindingSchema = z.object({ artifactId: id, targetId: id, targetDigest: digest, contentHash: digest }).strict();
export type TaskVerificationBinding = z.infer<typeof taskVerificationBindingSchema>;
export const taskVerificationDraftSchema = taskVerificationBindingSchema.extend({ scenarioId: id, instructionsDigest: digest, outcome, note }).strict();
export type TaskVerificationDraft = z.infer<typeof taskVerificationDraftSchema>;
export const taskVerificationReceiptSchema = taskVerificationBindingSchema.extend({ projectId: id, jobId: id,
  scenarioId: id, instructionsDigest: digest, outcome, noteDigest: digest, verificationId: id, recordedAt: z.string().datetime(),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), completesJob: z.literal(false) }).strict();
export type TaskVerificationReceipt = z.infer<typeof taskVerificationReceiptSchema>;
export const taskVerificationCommandSchema = z.object({ receipt: taskVerificationReceiptSchema, replayed: z.boolean() }).strict();
export const taskVerificationOptionsSchema = taskVerificationBindingSchema.extend({ projectId: id, jobId: id,
  scenarios: z.array(z.object({ scenarioId: id, label: z.string().min(1).max(120), instructions: z.string().min(1).max(2000),
    instructionsDigest: digest, availability: z.enum(["available", "access_denied", "project_inactive", "target_closed", "independence_required", "already_recorded"]),
    ownVerification: taskVerificationReceiptSchema.omit({ noteDigest: true }).nullable() }).strict()).max(50),
  source: z.enum(["configured", "not_configured"]), grantsExecutionAuthority: z.literal(false) }).strict();
export type TaskVerificationOptions = z.infer<typeof taskVerificationOptionsSchema>;
