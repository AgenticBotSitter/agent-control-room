import { z } from "zod";
import { catalogProjectIdSchema } from "./project-wire";
import { taskSummarySchema, usageRollupSchema } from "./task-wire";

const currentTask = taskSummarySchema.refine(task =>
  ["proposed", "ready", "leased", "running", "waiting_approval", "orphaned"].includes(task.state),
"project overview current work must not be terminal");
const reviewTask = taskSummarySchema.refine(task => task.state === "waiting_approval",
  "project overview review work must await approval");

export const taskProjectOverviewSchema = z.object({
  projectId: catalogProjectIdSchema,
  current: z.array(currentTask).max(10),
  awaitingReview: z.array(reviewTask).max(5),
  recent: z.array(taskSummarySchema).max(10),
  additionalCurrentOmitted: z.boolean(),
  additionalReviewsOmitted: z.boolean(),
  additionalRecentOmitted: z.boolean(),
  usageRollup: usageRollupSchema,
  priceTable: z.object({ state: z.enum(["recorded", "not_recorded"]), tableId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/).nullable(),
    recordedAt: z.string().datetime().nullable() }).strict(),
  observedAt: z.string().datetime(),
  startsWork: z.literal(false),
}).strict().superRefine((value, context) => {
  for (const [name, tasks] of [["current", value.current], ["review", value.awaitingReview], ["recent", value.recent]] as const) {
    if (new Set(tasks.map(task => task.jobId)).size !== tasks.length)
      context.addIssue({ code: "custom", message: `${name} task ids must be unique` });
    if (tasks.some(task => task.projectId !== value.projectId))
      context.addIssue({ code: "custom", message: `${name} tasks must match the project` });
  }
});

export type TaskProjectOverview = z.infer<typeof taskProjectOverviewSchema>;
