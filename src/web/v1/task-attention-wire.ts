import { z } from "zod";
import { taskSummarySchema } from "./task-wire";
import { catalogProjectIdSchema } from "./project-wire";
import { approvalDigestSchema } from "./task-approval-wire";

export const taskAttentionReasons = ["proposal", "assignment", "approval", "failed", "orphaned", "review",
  "changes_requested", "verification_blocked", "revision_limit_reached", "result_checks_unavailable",
  "delivery_check", "submission_needed", "delivery_pending", "delivery_uncertain", "delivery_rejected"] as const;
export const taskAttentionCategories = ["uncertainty", "failure", "approval", "review", "preparation"] as const;
export const taskAttentionUrgencies = ["urgent", "soon", "normal"] as const;
export type TaskAttentionReason = typeof taskAttentionReasons[number];

export function taskAttentionPresentation(reasons: readonly TaskAttentionReason[]) {
  const has = (...values: TaskAttentionReason[]) => values.some(value => reasons.includes(value));
  if (has("orphaned", "delivery_uncertain", "verification_blocked", "result_checks_unavailable")) return {
    category: "uncertainty" as const, urgency: has("orphaned", "delivery_uncertain", "verification_blocked") ? "urgent" as const : "soon" as const,
    ownerQuestion: "What was already recorded, and is it safe to continue?",
  };
  if (has("failed", "delivery_rejected")) return { category: "failure" as const, urgency: "urgent" as const,
    ownerQuestion: "What failed, and what evidence should be reviewed before new work?" };
  if (has("approval", "submission_needed")) return { category: "approval" as const, urgency: "soon" as const,
    ownerQuestion: "Is the saved request ready for your approval or submission?" };
  if (has("review", "changes_requested", "revision_limit_reached")) return { category: "review" as const, urgency: "soon" as const,
    ownerQuestion: "Does the saved result meet the requested outcome, or does it need changes?" };
  return { category: "preparation" as const, urgency: "normal" as const,
    ownerQuestion: "Is this saved work ready for its next preparation or assignment step?" };
}

const attentionItemSchema = z.object({ task: taskSummarySchema, inputDigest: approvalDigestSchema,
  reasons: z.array(z.enum(taskAttentionReasons)).min(1).max(15),
  category: z.enum(taskAttentionCategories).optional(), urgency: z.enum(taskAttentionUrgencies).optional(),
  ownerQuestion: z.string().max(160).optional() }).strict()
  .transform(item => ({ ...item, ...taskAttentionPresentation(item.reasons) }));
const urgencyRank = { urgent: 0, soon: 1, normal: 2 } as const;
export const taskAttentionPageSchema = z.object({
  items: z.array(attentionItemSchema).max(25),
  nextCursor: catalogProjectIdSchema.nullable(), examined: z.number().int().min(0).max(25),
  observedAt: z.string().datetime(), startsWork: z.literal(false),
  planningSource: z.enum(["configured", "not_configured"]).default("not_configured"),
  deliverySource: z.enum(["configured", "not_configured"]).default("not_configured"),
  sources: z.object({ ordinary: z.enum(["included", "not_authorized"]),
    ideas: z.enum(["included", "not_authorized", "not_configured"]) }).strict(),
}).strict().refine(page => page.items.length <= page.examined
  && new Set(page.items.map(item => item.task.jobId)).size === page.items.length
  && page.items.every(item => new Set(item.reasons).size === item.reasons.length))
  .transform(page => ({ ...page, items: [...page.items].sort((left, right) =>
    urgencyRank[left.urgency] - urgencyRank[right.urgency]
    || right.task.updatedAt.localeCompare(left.task.updatedAt)
    || left.task.jobId.localeCompare(right.task.jobId)) }));
export type TaskAttentionPage = z.infer<typeof taskAttentionPageSchema>;
