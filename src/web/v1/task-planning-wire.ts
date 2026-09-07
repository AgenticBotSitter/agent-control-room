import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskPlanningDraftSchema = z.object({ expectedInputDigest: digest }).strict();
export const taskPlanningReceiptSchema = z.object({ projectId: id, sourceJobId: id, jobId: id,
  sourceInputDigest: digest, inputDigest: digest, plannedAt: z.string().datetime(), startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false) }).strict();
export type TaskPlanningReceipt = z.infer<typeof taskPlanningReceiptSchema>;
export const taskPlanningOptionsSchema = z.object({ projectId: id, sourceJobId: id, inputDigest: digest,
  availability: z.enum(["available", "not_configured", "not_eligible", "already_planned"]), startsWork: z.literal(false),
  savedPlan: taskPlanningReceiptSchema.nullable().optional() }).strict().refine(value =>
    value.availability !== "already_planned" || !!value.savedPlan).refine(value => !value.savedPlan
    || value.savedPlan.projectId === value.projectId && value.savedPlan.sourceJobId === value.sourceJobId
      && value.savedPlan.sourceInputDigest === value.inputDigest && value.savedPlan.jobId !== value.sourceJobId);
export type TaskPlanningOptions = z.infer<typeof taskPlanningOptionsSchema>;
export const taskPlanningCommandSchema = z.object({ receipt: taskPlanningReceiptSchema, replayed: z.boolean() }).strict();
