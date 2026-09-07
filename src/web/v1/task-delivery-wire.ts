import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
export const taskDeliveryStatusSchema = z.object({ projectId: id, jobId: id, attemptId: id,
  state: z.enum(["not_queued", "queued", "prepared", "staged", "transmission_unconfirmed", "receipt_recorded", "receipt_rejected"]),
  observedAt: z.string().datetime(), startsWork: z.literal(false), executionConfirmed: z.literal(false),
}).strict();
