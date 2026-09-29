import { z } from "zod";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const safeText = z.string().min(1).max(2000);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const effort = z.enum(["default", "low", "medium", "high", "xhigh", "max"]);
const workerKind = z.enum(["codex", "claude-code", "hermes"]);
const repositoryRelativePath = z.string().min(1).max(1024).superRefine((value, context) => {
  const root = value.endsWith("/**") ? value.slice(0, -3) : value;
  if (!root || root.startsWith("/") || root.includes("\\") || root.includes("\0")
    || root.split("/").some(part => !part || part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "build stage path scope invalid" });
  }
});
export const pipelineBuildWritePolicySchemaV1 = z.object({
  allowedPaths: z.array(repositoryRelativePath).min(1).max(100)
    .refine(value => new Set(value).size === value.length, "build stage path scopes duplicated"),
  maximumChangedFiles: z.number().int().min(1).max(500),
  maximumChangedBytes: z.number().int().min(1).max(16 * 1024 * 1024),
}).strict();
/** The product's two fix rounds, everywhere: a stage's first attempt is round
 * 0, so `maxLoops` is the number of corrections it may be sent back for. The
 * stored column allows 20; the ceiling below is what unattended advance
 * enforces, and a template may only lower it. */
export const PIPELINE_MAX_LOOPS_CEILING_V1 = 2;
export const PIPELINE_MAX_TOTAL_LOOPS_CEILING_V1 = 6;
const baseStage = z.object({ ordinal: z.number().int().min(0).max(2), description: safeText,
  requiredCapability: id, workerId: id, workerKind, nodeId: id, selectionKey: id,
  model: z.string().min(1).max(180), effort, provider: id.nullable().default(null),
  profile: id.nullable().default(null), maxLoops: z.number().int().min(0).max(20) }).strict();
export const pipelineStageTemplateSchemaV1 = z.discriminatedUnion("stageKind", [
  baseStage.extend({ stageKind: z.literal("build"), role: z.literal("builder"),
    ...pipelineBuildWritePolicySchemaV1.shape }).strict(),
  baseStage.extend({ stageKind: z.literal("check"), role: z.literal("checker") }).strict(),
  baseStage.extend({ stageKind: z.literal("signoff"), role: z.literal("validator") }).strict(),
]);
export const legacyPipelineStageTemplateSchemaV1 = z.discriminatedUnion("stageKind", [
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
export const legacyLinearPipelineTemplateInputSchemaV1 = z.object({
  name: z.string().min(1).max(180), description: safeText,
  stages: z.array(legacyPipelineStageTemplateSchemaV1).length(3),
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
  writePolicy: pipelineBuildWritePolicySchemaV1.nullable(),
  pullRequestEvidence: z.object({ url: z.string().url(), commitDigest: z.string().regex(/^[a-f0-9]{40}$/),
    modelSelection: z.object({ workerId: id, model: z.string().min(1).max(180), effort: z.string().min(1).max(80) }).strict(),
    usage: z.literal("unknown"), evidenceDigest: digest }).strict().nullable(),
  predecessorResultDigest: digest.nullable(), startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();
export const pipelineRunViewSchemaV1 = z.object({ runId: id, projectId: id, title: z.string().min(1).max(180),
  state: z.enum(["proposed", "active", "paused", "succeeded", "failed", "cancelled"]),
  templateId:id,runVersion:z.number().int().positive(),templateVersion:z.number().int().positive(),
  unattended:z.boolean(),mayAdvanceUnattended:z.boolean(),
  stages: z.array(pipelineStageViewSchemaV1).length(3), updatedAt: z.string().datetime({ offset: true }),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();
export const pipelineRunPageSchemaV1 = z.object({ projectId: id, runs: z.array(z.object({ runId: id,
  title: z.string().min(1).max(180), state: z.string(), updatedAt: z.string().datetime({ offset: true }) }).strict()).max(100),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();

export const pipelineAdvanceReceiptSchemaV1 = z.object({
  runId: id,
  stageOrdinal: z.number().int().min(0).max(31),
  jobId: id,
  attemptId: id,
  queueId: id,
  replayed: z.boolean(),
  advancedAt: z.string().datetime({ offset: true }),
  startsWork: z.literal(true),
  grantsExecutionAuthority: z.literal(false),
  claimsCancellation: z.literal(false),
}).strict();
export const pipelineTerminalReceiptSchemaV1 = z.object({
  runId: id,
  state: z.literal("succeeded"),
  completedAt: z.string().datetime({ offset: true }),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  claimsCancellation: z.literal(false),
}).strict();

export const pipelineUnattendedTransitionSchemaV1 = z.object({
  runId: id,
  templateId: id,
  policyId: id,
  enabled: z.boolean(),
  expectedRunVersion: z.number().int().positive(),
  expectedTemplateVersion: z.number().int().positive(),
}).strict();
/** The one installation allowance record. Counted runs, never dollars: every
 * ceiling is a whole number of runs, and the optional dollar cap is off unless
 * the owner has set it. Zero is a real ceiling, not "unset". */
export const pipelineInstallationAllowanceInputSchemaV1 = z.object({
  runsPerHour: z.number().int().min(0).max(10000),
  runsPerAgentPerDay: z.number().int().min(0).max(10000),
  machineMaxAgentProcesses: z.number().int().min(0).max(4096),
  machineMaxDbClusters: z.number().int().min(0).max(256),
  dollarCapMicroUsd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  /** The database clusters the owner is seeing right now. Nothing in the system
   * can observe a host-level postmaster, so the owner reports it with the rest
   * of the ceilings and the coordinator enforces what they report. */
  observedDbClusters: z.number().int().min(0).max(256),
}).strict();
export const pipelineInstallationAllowanceReceiptSchemaV1 = z.object({
  allowanceVersion: z.number().int().positive(),
  runsPerHour: z.number().int().nonnegative(),
  runsPerAgentPerDay: z.number().int().nonnegative(),
  machineMaxAgentProcesses: z.number().int().nonnegative(),
  machineMaxDbClusters: z.number().int().nonnegative(),
  dollarCapMicroUsd: z.number().int().nonnegative().nullable(),
  recordedDbClusters: z.number().int().nonnegative().nullable(),
  recordedDbClustersAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
  replayed: z.boolean(),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();
/** The counted fix rounds, and the honest live position. `usedThisHour` and
 * `usedByAgentToday` are read inside the advance transaction, so what the owner
 * sees is the same count the cap is compared against. */
export const pipelineLoopAllowanceViewSchemaV1 = z.object({
  runId: id,
  stageOrdinal: z.number().int().min(0).max(2),
  workerId: id,
  loopIndex: z.number().int().nonnegative(),
  maxLoops: z.number().int().nonnegative(),
  runTotalLoops: z.number().int().nonnegative(),
  maxTotalLoops: z.number().int().nonnegative(),
  usedThisHour: z.number().int().nonnegative(),
  runsPerHour: z.number().int().nonnegative(),
  usedByAgentToday: z.number().int().nonnegative(),
  runsPerAgentPerDay: z.number().int().nonnegative(),
  activeAgentProcesses: z.number().int().nonnegative(),
  machineMaxAgentProcesses: z.number().int().nonnegative(),
  recordedDbClusters: z.number().int().nonnegative().nullable(),
  machineMaxDbClusters: z.number().int().nonnegative(),
  startedWork: z.boolean(),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();
export const pipelineUnattendedTransitionReceiptSchemaV1 = z.object({
  transitionId: id,
  runId: id,
  templateId: id,
  policyId: id,
  enabled: z.boolean(),
  runVersion: z.number().int().positive(),
  templateVersion: z.number().int().positive(),
  occurredAt: z.string().datetime({ offset: true }),
  replayed: z.boolean(),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();

const historyKind = z.enum(["proposed", "revised", "approved", "rejected", "partially_approved",
  "revision_planned", "ran", "assignment_expired", "delivery_prepared", "delivery_staged",
  "transmission_requested", "delivery_received", "queue_recovered", "capacity_released",
  "received", "checked", "resulted", "completed", "advanced"]);
export const pipelineHistoryEventSchemaV1 = z.object({
  id,
  kind: historyKind,
  actorId: id,
  actorType: z.enum(["human", "agent", "worker", "service", "adapter"]),
  action: z.string().min(1).max(180).regex(/^[A-Za-z0-9._:-]+$/),
  targetType: z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/),
  targetId: id,
  safeReason: z.string().min(1).max(120).regex(/^[a-z0-9._:-]+$/).nullable(),
  occurredAt: z.string().datetime({ offset: true }),
  chainPartition: z.string().regex(/^month:\d{4}-\d{2}$/),
  chainSequence: z.number().int().positive(),
  eventHash: digest,
}).strict();
export const pipelineHistorySchemaV1 = z.object({
  runId: id,
  projectId: id,
  events: z.array(pipelineHistoryEventSchemaV1).max(200),
  truncated: z.boolean(),
  chainVerified: z.literal(true),
  observedAt: z.string().datetime({ offset: true }),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();

export type LinearPipelineTemplateInputV1 = z.infer<typeof linearPipelineTemplateInputSchemaV1>;
export type PipelineStageTemplateV1 = z.infer<typeof pipelineStageTemplateSchemaV1>;
export type PipelineRunViewV1 = z.infer<typeof pipelineRunViewSchemaV1>;
export type PipelineAdvanceReceiptV1 = z.infer<typeof pipelineAdvanceReceiptSchemaV1>;
export type PipelineTerminalReceiptV1 = z.infer<typeof pipelineTerminalReceiptSchemaV1>;
export type PipelineHistoryV1 = z.infer<typeof pipelineHistorySchemaV1>;
export type PipelineUnattendedTransitionV1 = z.infer<typeof pipelineUnattendedTransitionSchemaV1>;
export type PipelineInstallationAllowanceInputV1 = z.infer<typeof pipelineInstallationAllowanceInputSchemaV1>;
export type PipelineInstallationAllowanceReceiptV1 = z.infer<typeof pipelineInstallationAllowanceReceiptSchemaV1>;
export type PipelineLoopAllowanceViewV1 = z.infer<typeof pipelineLoopAllowanceViewSchemaV1>;
