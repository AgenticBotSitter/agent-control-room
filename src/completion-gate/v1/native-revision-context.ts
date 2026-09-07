import { z } from "zod";
const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const nativeRevisionContextSchema = z.object({ rootSubjectId: id, rootTargetId: id, fromJobId: id, fromRunId: id,
  fromTargetId: id, fromTargetDigest: digest, fromContentHash: digest, reviewId: id, reviewDigest: digest,
  findingIds: z.array(id).min(1).max(100), feedbackDigest: digest, sourcePlanDigest: digest,
  revisionNumber: z.number().int().min(1).max(100), originalPrompt: z.string().min(1).max(4000) }).strict();
