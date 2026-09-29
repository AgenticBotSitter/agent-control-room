import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
import { approvalDigestSchema as digest } from "./task-approval-wire";
import { taskDeliveryStatusSchema } from "./task-delivery-wire";

export const taskSubmissionDraftSchema = z.object({ expectedInputDigest: digest, expectedPacketDigest: digest }).strict();
export const taskSubmissionReceiptSchema = z.object({ projectId: id, jobId: id, attemptId: id, queueId: id,
  packetDigest: digest, operationDigest: digest, queuedAt: z.string().datetime(), replayed: z.boolean(),
  evidence: z.literal("recorded_delivery_intent"), startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
/** Mac-local-only confirm-what-you-saw preview: the exact `packetDigest` a
 * matching enqueue would produce right now, for the caller to post back as
 * `expectedPacketDigest`. Present only while nothing is queued yet. */
export const taskSubmissionPreviewSchema = z.object({ projectId: id, jobId: id, packetDigest: digest }).strict();
export const taskSubmissionReadSchema = z.object({ projectId: id, jobId: id, inputDigest: digest,
  receipt: taskSubmissionReceiptSchema.omit({ replayed: true }).nullable(), delivery: taskDeliveryStatusSchema.optional(),
  preview: taskSubmissionPreviewSchema.optional() }).strict()
  .refine(value => !value.delivery || value.delivery.projectId === value.projectId && value.delivery.jobId === value.jobId
    && (!value.receipt || value.delivery.attemptId === value.receipt.attemptId))
  .refine(value => !value.preview || !value.receipt && value.preview.projectId === value.projectId && value.preview.jobId === value.jobId);
