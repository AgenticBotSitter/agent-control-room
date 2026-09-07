import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
import { approvalDigestSchema as digest } from "./task-approval-wire";
import { taskDeliveryStatusSchema } from "./task-delivery-wire";

export const taskSubmissionDraftSchema = z.object({ expectedInputDigest: digest, expectedPacketDigest: digest }).strict();
export const taskSubmissionReceiptSchema = z.object({ projectId: id, jobId: id, attemptId: id, queueId: id,
  packetDigest: digest, operationDigest: digest, queuedAt: z.string().datetime(), replayed: z.boolean(),
  evidence: z.literal("recorded_delivery_intent"), startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
export const taskSubmissionReadSchema = z.object({ projectId: id, jobId: id, inputDigest: digest,
  receipt: taskSubmissionReceiptSchema.omit({ replayed: true }).nullable(), delivery: taskDeliveryStatusSchema.optional() }).strict()
  .refine(value => !value.delivery || value.delivery.projectId === value.projectId && value.delivery.jobId === value.jobId
    && (!value.receipt || value.delivery.attemptId === value.receipt.attemptId));
