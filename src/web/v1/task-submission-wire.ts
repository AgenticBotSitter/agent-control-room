import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
import { approvalDigestSchema as digest } from "./task-approval-wire";

export const taskSubmissionDraftSchema = z.object({ expectedInputDigest: digest, expectedPacketDigest: digest }).strict();
export const taskSubmissionReceiptSchema = z.object({ projectId: id, jobId: id, attemptId: id, queueId: id,
  packetDigest: digest, operationDigest: digest, queuedAt: z.string().datetime(), replayed: z.boolean(),
  evidence: z.literal("recorded_delivery_intent"), startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
