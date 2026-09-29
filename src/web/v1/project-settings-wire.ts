import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
import { MODEL_IDENTIFIER_PATTERN_V1 } from "../../domain/v1/model-identifier";

const workerKind = z.enum(["codex", "claude-code", "hermes"]);
const model = z.string().regex(MODEL_IDENTIFIER_PATTERN_V1);
const effort = z.enum(["default", "low", "medium", "high", "xhigh", "max"]);

/**
 * Per-project settings the owner can edit from the project's Settings tab: which configured
 * worker kinds may claim this project's work, how many of its tasks may be assigned at once, and
 * the default worker/model/effort offered when proposing a task. Review policy is deliberately
 * absent: a single-owner install has exactly one reviewer, so it stays the fixed,
 * installation-wide profile (shown read-only), never a per-project override.
 * `version: 0` means no settings row exists yet -- every field reads as unset/unrestricted.
 */
export const projectSettingsSchema = z.object({
  projectId: id, version: z.number().int().nonnegative(),
  eligibleWorkerKinds: z.array(workerKind).max(3).nullable(),
  maxConcurrentTasks: z.number().int().min(1).max(20).nullable(),
  defaultWorkerKind: workerKind.nullable(), defaultModel: model.nullable(), defaultEffort: effort.nullable(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.eligibleWorkerKinds && new Set(value.eligibleWorkerKinds).size !== value.eligibleWorkerKinds.length)
    context.addIssue({ code: "custom", message: "eligible worker kinds must be unique", path: ["eligibleWorkerKinds"] });
  if ((value.defaultModel !== null || value.defaultEffort !== null) && value.defaultWorkerKind === null)
    context.addIssue({ code: "custom", message: "a default model or effort needs a default worker kind", path: ["defaultWorkerKind"] });
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export const projectSettingsDraftSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  eligibleWorkerKinds: z.array(workerKind).max(3).nullable(),
  maxConcurrentTasks: z.number().int().min(1).max(20).nullable(),
  defaultWorkerKind: workerKind.nullable(), defaultModel: model.nullable(), defaultEffort: effort.nullable(),
}).strict().superRefine((value, context) => {
  if (value.eligibleWorkerKinds && new Set(value.eligibleWorkerKinds).size !== value.eligibleWorkerKinds.length)
    context.addIssue({ code: "custom", message: "eligible worker kinds must be unique", path: ["eligibleWorkerKinds"] });
  if ((value.defaultModel !== null || value.defaultEffort !== null) && value.defaultWorkerKind === null)
    context.addIssue({ code: "custom", message: "a default model or effort needs a default worker kind", path: ["defaultWorkerKind"] });
});
export type ProjectSettingsDraft = z.infer<typeof projectSettingsDraftSchema>;
