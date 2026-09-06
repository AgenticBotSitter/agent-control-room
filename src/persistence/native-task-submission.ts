import { z } from "zod";
import type { DatabaseSession } from "./database";
import { localId, digestSchema } from "../harness/v1/native-run-identifiers";

/** A locator, never a prompt, signed approval, credential, or execution permission. */
export const nativeTaskSubmissionReferenceSchema = z.object({
  schema: z.literal("control-room.native-task-submission/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId,
  queueId: z.string().regex(/^native-queue:[a-f0-9]{64}$/),
  inputDigest: digestSchema, packetDigest: digestSchema,
}).strict();
export type NativeTaskSubmissionReference = z.infer<typeof nativeTaskSubmissionReferenceSchema>;

/** Trusted server-side composition only. Called on a fresh canonical intent, inside
 * its checked transaction. No handler, worker, sender, or database connection here. */
export interface NativeTaskSubmission {
  enqueueInSession(tx: DatabaseSession, reference: NativeTaskSubmissionReference): Promise<void>;
}
