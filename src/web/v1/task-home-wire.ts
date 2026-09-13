import { z } from "zod";
import { taskResultMetadataSchema } from "./task-result-wire";
import { taskSummarySchema } from "./task-wire";

const activeTaskSummarySchema = taskSummarySchema.refine(
  task => ["leased", "running", "waiting_approval"].includes(task.state),
  "home active work must still be active",
);

export const taskHomeActivitySchema = z.object({
  active: z.array(activeTaskSummarySchema).max(10),
  recentResults: z.array(z.object({ task: taskSummarySchema, artifact: taskResultMetadataSchema }).strict()).max(10),
  additionalActiveOmitted: z.boolean(),
  additionalResultsOmitted: z.boolean(),
  resultSource: z.enum(["configured", "not_configured", "not_authorized"]),
  observedAt: z.string().datetime(),
  startsWork: z.literal(false),
}).strict().superRefine((value, context) => {
  if (new Set(value.active.map(task => task.jobId)).size !== value.active.length) {
    context.addIssue({ code: "custom", message: "active task ids must be unique" });
  }
  if (new Set(value.recentResults.map(item => item.artifact.artifactId)).size !== value.recentResults.length) {
    context.addIssue({ code: "custom", message: "recent result ids must be unique" });
  }
  if (value.resultSource !== "configured" && (value.recentResults.length || value.additionalResultsOmitted)) {
    context.addIssue({ code: "custom", message: "unavailable results cannot report records" });
  }
});

export type TaskHomeActivity = z.infer<typeof taskHomeActivitySchema>;
