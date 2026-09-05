import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskPlanningDraftSchema = z.object({ expectedInputDigest: digest }).strict();
export const taskPlanningOptionsSchema = z.object({ projectId: id, sourceJobId: id, inputDigest: digest,
  availability: z.enum(["available", "not_configured", "not_eligible"]), startsWork: z.literal(false) }).strict();
export type TaskPlanningOptions = z.infer<typeof taskPlanningOptionsSchema>;
export const taskPlanningReceiptSchema = z.object({ projectId: id, sourceJobId: id, jobId: id,
  sourceInputDigest: digest, inputDigest: digest, plannedAt: z.string().datetime(), startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false) }).strict();
export type TaskPlanningReceipt = z.infer<typeof taskPlanningReceiptSchema>;
export const taskPlanningCommandSchema = z.object({ receipt: taskPlanningReceiptSchema, replayed: z.boolean() }).strict();
