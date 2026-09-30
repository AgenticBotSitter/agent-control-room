import { z } from "zod";
import { catalogProjectIdSchema } from "./project-wire";
import { workBatchProposalSchemaV1 } from "../../work-intake/v1/schemas";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const effort = z.enum(["default", "low", "medium", "high", "xhigh", "max"]);

export const projectOrchestratorChoiceSchemaV1 = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("selected"), workerId: id,
    workerKind: z.enum(["codex", "claude-code", "hermes"]), modelKey: z.string().min(1).max(180),
    effort }).strict(),
]);
export type ProjectOrchestratorChoiceV1 = z.infer<typeof projectOrchestratorChoiceSchemaV1>;

export const projectOrchestratorOptionSchemaV1 = z.object({
  key: id, label: z.string().min(1).max(240), workerId: id,
  workerKind: z.enum(["codex", "claude-code", "hermes"]), modelKey: z.string().min(1).max(180), effort,
}).strict();
export type ProjectOrchestratorOptionV1 = z.infer<typeof projectOrchestratorOptionSchemaV1>;

export const projectOrchestrationSettingsSchemaV1 = z.object({
  projectId: catalogProjectIdSchema, version: z.number().int().nonnegative(),
  choice: projectOrchestratorChoiceSchemaV1,
  options: z.array(projectOrchestratorOptionSchemaV1).max(256),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
export type ProjectOrchestrationSettingsV1 = z.infer<typeof projectOrchestrationSettingsSchemaV1>;

export const projectOrchestrationSettingsDraftSchemaV1 = z.object({
  expectedVersion: z.number().int().nonnegative(), choice: projectOrchestratorChoiceSchemaV1,
}).strict();

export const projectOrchestrationDescribeSchemaV1 = z.object({
  description: z.string().trim().min(1).max(16_000),
}).strict();

export const projectOrchestrationDescribeResultSchemaV1 = z.discriminatedUnion("status", [
  z.object({ status: z.literal("proposal"), batchId: id, href: z.string().min(1).max(640),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
  z.object({ status: z.literal("manual"), message: z.string().min(1).max(400),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
  z.object({ status: z.literal("failed"), needsYou: z.literal(true), message: z.string().min(1).max(400),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
  z.object({ status: z.literal("refused"), message: z.string().min(1).max(400),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
  z.object({ status: z.literal("stopped"), message: z.string().min(1).max(400),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
]);
export type ProjectOrchestrationDescribeResultV1 = z.infer<typeof projectOrchestrationDescribeResultSchemaV1>;

export const projectOrchestrationSuggestionSchemaV1 = z.object({
  suggestionId: id, batchId: id, projectId: catalogProjectIdSchema, baseRevision: z.number().int().positive(),
  proposal: workBatchProposalSchemaV1, createdAt: z.string().datetime(), dismissed: z.boolean(),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false), savesRevision: z.literal(false),
}).strict();
export type ProjectOrchestrationSuggestionV1 = z.infer<typeof projectOrchestrationSuggestionSchemaV1>;

export const projectOrchestrationSuggestionPageSchemaV1 = z.object({
  projectId: catalogProjectIdSchema, batchId: id,
  suggestions: z.array(projectOrchestrationSuggestionSchemaV1).max(64),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
export type ProjectOrchestrationSuggestionPageV1 = z.infer<typeof projectOrchestrationSuggestionPageSchemaV1>;

export const projectOrchestrationSuggestionPrefillSchemaV1 = z.object({
  proposal: workBatchProposalSchemaV1, startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false), savesRevision: z.literal(false),
}).strict();
export type ProjectOrchestrationSuggestionPrefillV1 = z.infer<typeof projectOrchestrationSuggestionPrefillSchemaV1>;
