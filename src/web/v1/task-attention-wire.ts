import { z } from "zod";
import { taskSummarySchema } from "./task-wire";
import { catalogProjectIdSchema } from "./project-wire";
import { approvalDigestSchema } from "./task-approval-wire";

export const taskAttentionReasons = ["proposal", "assignment", "approval", "failed", "orphaned", "review",
  "changes_requested", "verification_blocked", "revision_limit_reached", "result_checks_unavailable",
  "delivery_check", "submission_needed", "delivery_pending", "delivery_uncertain", "delivery_rejected"] as const;
export const taskAttentionPageSchema = z.object({
  items: z.array(z.object({ task: taskSummarySchema, inputDigest: approvalDigestSchema,
    reasons: z.array(z.enum(taskAttentionReasons)).min(1).max(15) }).strict()).max(25),
  nextCursor: catalogProjectIdSchema.nullable(), examined: z.number().int().min(0).max(25),
  observedAt: z.string().datetime(), startsWork: z.literal(false),
  planningSource: z.enum(["configured", "not_configured"]).default("not_configured"),
  deliverySource: z.enum(["configured", "not_configured"]).default("not_configured"),
  sources: z.object({ ordinary: z.enum(["included", "not_authorized"]),
    ideas: z.enum(["included", "not_authorized", "not_configured"]) }).strict(),
}).strict().refine(page => page.items.length <= page.examined
  && new Set(page.items.map(item => item.task.jobId)).size === page.items.length
  && page.items.every(item => new Set(item.reasons).size === item.reasons.length));
export type TaskAttentionPage = z.infer<typeof taskAttentionPageSchema>;
