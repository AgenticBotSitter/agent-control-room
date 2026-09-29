import { z } from "zod";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const safeText = z.string().min(1).max(2000);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const effort = z.enum(["default", "low", "medium", "high", "xhigh", "max"]);
const workerKind = z.enum(["codex", "claude-code", "hermes"]);
const baseStage = z.object({ ordinal: z.number().int().min(0).max(2), description: safeText,
  requiredCapability: id, workerId: id, workerKind, nodeId: id, selectionKey: id,
  model: z.string().min(1).max(180), effort, provider: id.nullable().default(null),
  profile: id.nullable().default(null), maxLoops: z.number().int().min(0).max(20) }).strict();
export const pipelineStageTemplateSchemaV1 = z.discriminatedUnion("stageKind", [
  baseStage.extend({ stageKind: z.literal("build"), role: z.literal("builder") }).strict(),
  baseStage.extend({ stageKind: z.literal("check"), role: z.literal("checker") }).strict(),
  baseStage.extend({ stageKind: z.literal("signoff"), role: z.literal("validator") }).strict(),
]);
export const linearPipelineTemplateInputSchemaV1 = z.object({
  name: z.string().min(1).max(180), description: safeText,
  stages: z.array(pipelineStageTemplateSchemaV1).length(3),
  maxTotalLoops: z.number().int().min(0).max(60).default(6),
  maxDurationSeconds: z.number().int().min(60).max(604800).default(86400),
}).strict().superRefine((value, context) => {
  const expected = [[0, "build", "builder"], [1, "check", "checker"], [2, "signoff", "validator"]] as const;
  value.stages.forEach((stage, index) => {
    const item = expected[index]!;
    if (stage.ordinal !== item[0] || stage.stageKind !== item[1] || stage.role !== item[2])
      context.addIssue({ code: "custom", message: "linear stage order invalid", path: ["stages", index] });
    if ((stage.workerKind === "hermes") !== (stage.provider !== null && stage.profile !== null))
      context.addIssue({ code: "custom", message: "provider profile invalid", path: ["stages", index] });
  });
});
export const instantiateLinearPipelineSchemaV1 = z.object({ templateId: id, title: z.string().min(1).max(180) }).strict();
export const pipelineTemplateReceiptSchemaV1 = z.object({ templateId: id, projectId: id, version: z.number().int().positive(),
  templateDigest: digest, createdAt: z.string().datetime({ offset: true }), startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false) }).strict();
export const pipelineRunReceiptSchemaV1 = z.object({ runId: id, projectId: id, requestId: id, workflowId: id,
  jobIds: z.array(id).length(3), replayed: z.boolean(), createdAt: z.string().datetime({ offset: true }),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();
export const pipelineStageViewSchemaV1 = z.object({ ordinal: z.number().int().min(0).max(2),
  stageKind: z.enum(["build", "check", "signoff"]), role: z.enum(["builder", "checker", "validator"]),
  jobId: id, workerId: id, nodeId: id, model: z.string().min(1).max(180), effort,
  state: z.enum(["waiting_dependency", "eligible", "assigned", "running", "completed", "failed", "paused", "uncertain"]),
  round: z.number().int().nonnegative().nullable(), usage: z.literal("unknown"),
  predecessorResultDigest: digest.nullable(), startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();
export const pipelineRunViewSchemaV1 = z.object({ runId: id, projectId: id, title: z.string().min(1).max(180),
  state: z.enum(["proposed", "active", "paused", "succeeded", "failed", "cancelled"]),
  stages: z.array(pipelineStageViewSchemaV1).length(3), updatedAt: z.string().datetime({ offset: true }),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();
export const pipelineRunPageSchemaV1 = z.object({ projectId: id, runs: z.array(z.object({ runId: id,
  title: z.string().min(1).max(180), state: z.string(), updatedAt: z.string().datetime({ offset: true }) }).strict()).max(100),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();

export type LinearPipelineTemplateInputV1 = z.infer<typeof linearPipelineTemplateInputSchemaV1>;
export type PipelineStageTemplateV1 = z.infer<typeof pipelineStageTemplateSchemaV1>;
export type PipelineRunViewV1 = z.infer<typeof pipelineRunViewSchemaV1>;
