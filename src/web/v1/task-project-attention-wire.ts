import { z } from "zod";
import { catalogProjectIdSchema } from "./project-wire";
import { approvalDigestSchema } from "./task-approval-wire";
import { taskSummarySchema } from "./task-wire";
import { taskAttentionCategories, taskAttentionPresentation, taskAttentionReasons, taskAttentionUrgencies } from "./task-attention-wire";

const resultReasons = ["review", "changes_requested", "verification_blocked", "revision_limit_reached", "result_checks_unavailable"] as const;

const itemSchema = z.object({
  task: taskSummarySchema,
  inputDigest: approvalDigestSchema,
  reasons: z.array(z.enum(taskAttentionReasons)).min(1).max(15),
  /** These are only opaque, signed-result identifiers. The browser must still use
   * the protected exact-result route; no storage address is projected here. */
  resultArtifactIds: z.array(catalogProjectIdSchema).max(50),
  category: z.enum(taskAttentionCategories).optional(),
  urgency: z.enum(taskAttentionUrgencies).optional(),
  ownerQuestion: z.string().max(160).optional(),
}).strict().transform(item => ({ ...item, ...taskAttentionPresentation(item.reasons) }));

export const taskProjectAttentionPageSchema = z.object({
  projectId: catalogProjectIdSchema,
  mode: z.enum(["inbox", "reviews"]),
  items: z.array(itemSchema).max(20),
  nextCursor: catalogProjectIdSchema.nullable(),
  examined: z.number().int().min(0).max(20),
  resultSource: z.enum(["configured", "not_configured"]),
  reviewSource: z.enum(["configured", "not_configured"]),
  resultContent: z.enum(["authorized", "not_authorized"]),
  observedAt: z.string().datetime(),
  startsWork: z.literal(false),
}).strict().superRefine((page, context) => {
  if (page.items.length > page.examined) context.addIssue({ code: "custom", message: "items cannot exceed examined tasks" });
  if (new Set(page.items.map(item => item.task.jobId)).size !== page.items.length)
    context.addIssue({ code: "custom", message: "project attention task ids must be unique" });
  for (const item of page.items) {
    if (item.task.projectId !== page.projectId) context.addIssue({ code: "custom", message: "attention task must match project" });
    if (new Set(item.resultArtifactIds).size !== item.resultArtifactIds.length)
      context.addIssue({ code: "custom", message: "result identifiers must be unique" });
    if (page.resultContent === "not_authorized" && item.resultArtifactIds.length > 0)
      context.addIssue({ code: "custom", message: "unauthorized result content cannot expose result links" });
    if (page.mode === "reviews" && !item.reasons.some(reason => (resultReasons as readonly string[]).includes(reason)))
      context.addIssue({ code: "custom", message: "review page must contain result attention" });
  }
});

export type TaskProjectAttentionPage = z.infer<typeof taskProjectAttentionPageSchema>;
export const taskProjectResultAttentionReasons = resultReasons;
