import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskCancelDraftSchema = z.object({ expectedInputDigest: digest }).strict();
export type TaskCancelDraft = z.infer<typeof taskCancelDraftSchema>;
/**
 * A queued reservation (no run yet started) is cancelled outright: the
 * canonical attempt and job move to "cancelled" and the lease is revoked,
 * same as an explicit owner lease revocation. A running attempt cannot be
 * claimed stopped this way -- none of the mac-local owner-trusted harnesses
 * (Claude, Codex, Hermes-local) report a confirmed mid-run cancellation, so
 * the request is recorded durably (visible, idempotent, audited) with no
 * canonical state change. `confirmsNativeStop` is always false: recording a
 * request is not evidence the underlying process stopped (RES-010).
 */
export const taskCancelReceiptSchema = z.discriminatedUnion("effect", [
  z.object({ effect: z.literal("cancelled"), projectId: id, jobId: id, inputDigest: digest, leaseId: id,
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
  z.object({ effect: z.literal("stop_requested"), projectId: id, jobId: id, inputDigest: digest,
    attemptId: id, leaseId: id, confirmsNativeStop: z.literal(false),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
]);
export type TaskCancelReceipt = z.infer<typeof taskCancelReceiptSchema>;
export const taskCancelCommandSchema = z.object({ receipt: taskCancelReceiptSchema, replayed: z.boolean() }).strict();
