import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";

const oneLine = z.string().trim().min(1).max(600).refine(value => !/[\r\n]/.test(value), "must be one line");

export const taskBlockerKinds = ["owner_decision", "credential_or_permission", "dependency",
  "environment_broken", "out_of_scope"] as const;
export const taskBlockerStates = ["open", "handoff_pending", "resolved", "handed_off", "cancelled"] as const;

export const taskBlockerEvidenceSchema = z.object({
  label: oneLine.max(160),
  detail: oneLine,
}).strict();

export const taskBlockerReportSchema = z.object({
  blockerId: id,
  projectId: id,
  jobId: id,
  attemptId: id,
  workerId: id,
  kind: z.enum(taskBlockerKinds),
  summary: oneLine,
  unblock: oneLine,
  evidence: z.array(taskBlockerEvidenceSchema).min(1).max(20),
  expectedJobVersion: z.number().int().nonnegative(),
  expectedAttemptVersion: z.number().int().nonnegative(),
  reportedAt: z.string().datetime(),
}).strict();

export const taskBlockerOwnerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("unblock"), answer: oneLine }).strict(),
  z.object({ action: z.literal("handoff"), targetNodeId: id }).strict(),
  z.object({ action: z.literal("cancel"), reason: oneLine }).strict(),
]);

export const taskBlockerRecordSchema = taskBlockerReportSchema.omit({ expectedJobVersion: true,
  expectedAttemptVersion: true }).extend({
  schema: z.literal("control-room.task-blocker/v1"),
  state: z.enum(taskBlockerStates),
  resumeJobState: z.enum(["leased", "running", "waiting_approval"]),
  resumeAttemptState: z.enum(["leased", "running", "waiting"]),
  taskOwnerId: id,
  resolvedByOwnerId: id.optional(),
  ownerAnswer: oneLine.optional(),
  pendingAction: z.enum(["unblock", "handoff"]).optional(),
  targetNodeId: id.optional(),
  priorAttemptId: id.optional(),
  nextAttemptId: id.optional(),
  resolvedAt: z.string().datetime().optional(),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.state === "open" && (value.resolvedByOwnerId || value.resolvedAt || value.targetNodeId || value.nextAttemptId))
    context.addIssue({ code: "custom", message: "open blocker cannot contain an owner disposition" });
  if (value.state === "resolved" && (!value.resolvedByOwnerId || !value.ownerAnswer || !value.resolvedAt))
    context.addIssue({ code: "custom", message: "resolved blocker requires the owner answer" });
  if (["handoff_pending", "handed_off"].includes(value.state) && (!value.resolvedByOwnerId || !value.targetNodeId || !value.resolvedAt))
    context.addIssue({ code: "custom", message: "handoff requires owner and target" });
  if (value.state === "handoff_pending" && !value.pendingAction)
    context.addIssue({ code: "custom", message: "pending recovery requires an action" });
  if (value.state === "handed_off" && (!value.priorAttemptId || !value.nextAttemptId || value.priorAttemptId === value.nextAttemptId))
    context.addIssue({ code: "custom", message: "completed handoff requires distinct linked attempts" });
  if (value.state === "cancelled" && (!value.resolvedByOwnerId || !value.ownerAnswer || !value.resolvedAt))
    context.addIssue({ code: "custom", message: "cancelled blocker requires an owner reason" });
});

export type TaskBlockerReportV1 = z.infer<typeof taskBlockerReportSchema>;
export type TaskBlockerOwnerActionV1 = z.infer<typeof taskBlockerOwnerActionSchema>;
export type TaskBlockerRecordV1 = z.infer<typeof taskBlockerRecordSchema>;
