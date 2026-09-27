import { z } from "zod";
import { HERMES_NATIVE_ADAPTER } from "../../harness/v1/native-run-identifiers";
import { CONTROLLER_WORKER_REMOTE_ADAPTER_V1 } from "../../harness/v1/remote-worker-adapter-id";
import { HERMES_LOCAL_ADAPTER_V1 } from "../../harness/hermes-local-v1/task-planning-contract";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../../harness/codex-v1/owner-trusted-local-task-planning-contract";
import { catalogProjectIdSchema as id } from "./project-wire";
import { jobStates } from "../../domain/v1/types";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskPlanningTemplateChoiceSchema = z.object({ id: id,
  adapter: z.enum([HERMES_NATIVE_ADAPTER, "connector:hermes-021-macos-local-v1", HERMES_LOCAL_ADAPTER_V1,
    "codex-app-server/v1", CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, "connector:claude-code-local-v1", CONTROLLER_WORKER_REMOTE_ADAPTER_V1]),
}).strict();
export type TaskPlanningTemplateChoice = z.infer<typeof taskPlanningTemplateChoiceSchema>;
export const taskPlanningDraftSchema = z.object({ expectedInputDigest: digest, templateId: id.optional() }).strict();
export const taskPlanningReceiptSchema = z.object({ projectId: id, sourceJobId: id, jobId: id,
  sourceInputDigest: digest, inputDigest: digest, plannedAt: z.string().datetime(), startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false) }).strict();
export type TaskPlanningReceipt = z.infer<typeof taskPlanningReceiptSchema>;
export const preparedTaskStatusSchema = z.object({ jobId: id, state: z.enum(jobStates),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), updatedAt: z.string().datetime() }).strict();
export type PreparedTaskStatus = z.infer<typeof preparedTaskStatusSchema>;
export const taskPlanningOptionsSchema = z.object({ projectId: id, sourceJobId: id, inputDigest: digest,
  availability: z.enum(["available", "not_configured", "not_eligible", "already_planned"]), startsWork: z.literal(false),
  templates: z.array(taskPlanningTemplateChoiceSchema).max(16).optional(),
  savedPlan: taskPlanningReceiptSchema.nullable().optional(), preparedTask: preparedTaskStatusSchema.optional() }).strict().refine(value =>
    value.availability !== "already_planned" || !!value.savedPlan).refine(value => !value.savedPlan
    || value.savedPlan.projectId === value.projectId && value.savedPlan.sourceJobId === value.sourceJobId
      && value.savedPlan.sourceInputDigest === value.inputDigest && value.savedPlan.jobId !== value.sourceJobId)
  .refine(value => !value.preparedTask || !!value.savedPlan && value.preparedTask.jobId === value.savedPlan.jobId);
export type TaskPlanningOptions = z.infer<typeof taskPlanningOptionsSchema>;
export const taskPlanningCommandSchema = z.object({ receipt: taskPlanningReceiptSchema, replayed: z.boolean() }).strict();
