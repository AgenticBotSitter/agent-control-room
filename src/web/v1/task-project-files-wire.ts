import { z } from "zod";
import { catalogProjectIdSchema } from "./project-wire";
import { taskResultMetadataSchema } from "./task-result-wire";
import { taskSummarySchema } from "./task-wire";

export const taskProjectFilesSchema = z.object({
  projectId: catalogProjectIdSchema,
  items: z.array(z.object({ task: taskSummarySchema, artifact: taskResultMetadataSchema }).strict()).max(20),
  additionalItemsOmitted: z.boolean(),
  resultSource: z.enum(["configured", "not_configured", "not_authorized"]),
  observedAt: z.string().datetime(),
  startsWork: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.items.some(item => item.task.projectId !== value.projectId))
    context.addIssue({ code: "custom", message: "project files must match the project" });
  if (new Set(value.items.map(item => item.artifact.artifactId)).size !== value.items.length)
    context.addIssue({ code: "custom", message: "project file ids must be unique" });
  if (value.resultSource !== "configured" && (value.items.length || value.additionalItemsOmitted))
    context.addIssue({ code: "custom", message: "unavailable project files cannot report records" });
});

export type TaskProjectFiles = z.infer<typeof taskProjectFilesSchema>;
