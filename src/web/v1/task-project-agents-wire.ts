import { z } from "zod";
import { catalogProjectIdSchema } from "./project-wire";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const label = z.string().trim().min(1).max(180).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const eligibleTask = z.object({
  jobId: catalogProjectIdSchema,
  title: label,
  inputDigest: digest,
  workScope: z.enum(["bounded_text_review", "configured_task"]),
}).strict();

export const taskProjectAgentOptionsSchema = z.object({
  projectId: catalogProjectIdSchema,
  eligibilitySource: z.enum(["configured", "not_configured"]),
  workers: z.array(z.object({
    nodeId: catalogProjectIdSchema,
    label,
    platform: z.enum(["macos", "windows", "linux", "cloud"]),
    eligibleTasks: z.array(eligibleTask).min(1).max(20),
  }).strict()).max(64),
  tasksExamined: z.number().int().nonnegative().max(20),
  additionalTasksOmitted: z.boolean(),
  candidateEvidence: z.literal("configured_routes_only"),
  observedAt: z.string().datetime(),
  startsWork: z.literal(false),
  grantsAssignmentAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.eligibilitySource === "not_configured"
    && (value.workers.length || value.tasksExamined || value.additionalTasksOmitted)) {
    context.addIssue({ code: "custom", message: "an unavailable assignment source cannot report eligibility" });
  }
  const nodeIds = value.workers.map(worker => worker.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length || nodeIds.some((id, index) => index > 0 && id <= nodeIds[index - 1]!)) {
    context.addIssue({ code: "custom", message: "project agent workers must be unique and sorted" });
  }
  for (const worker of value.workers) {
    const jobIds = worker.eligibleTasks.map(task => task.jobId);
    if (new Set(jobIds).size !== jobIds.length || jobIds.some((id, index) => index > 0 && id <= jobIds[index - 1]!)) {
      context.addIssue({ code: "custom", message: "eligible tasks must be unique and sorted" });
    }
  }
});

export type TaskProjectAgentOptions = z.infer<typeof taskProjectAgentOptionsSchema>;

