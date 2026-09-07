import { z } from "zod";
import { jobStates, attemptStates } from "../../domain/v1/types";
import { harnessRunStates } from "../../harness/v1/types";
import { projectViewSchema, catalogProjectIdSchema } from "./project-wire";

const id = catalogProjectIdSchema;
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => ![...value].some(char =>
  (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !["\n", "\r", "\t"].includes(char)));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const taskDraftSchema = z.object({ title: text(120), instructions: text(4000) }).strict();
export type TaskDraft = z.infer<typeof taskDraftSchema>;
export const taskSummarySchema = z.object({ jobId: id, projectId: id, requestId: id, title: text(180),
  state: z.enum(jobStates), version: count, createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export const taskReceiptSchema = z.object({ jobId: id, projectId: id, requestId: id,
  createdAt: z.string().datetime(), submission: z.literal("proposed"), startsWork: z.literal(false) }).strict();
export type TaskReceipt = z.infer<typeof taskReceiptSchema>;
export const taskCommandSchema = z.object({ receipt: taskReceiptSchema, replayed: z.boolean() }).strict();
export const taskPageSchema = z.object({ project: projectViewSchema, tasks: z.array(taskSummarySchema).max(50),
  nextCursor: id.nullable(), canPropose: z.boolean(), dispatch: z.enum(["not_connected", "configured"]), observedAt: z.string().datetime() }).strict();
export type TaskPage = z.infer<typeof taskPageSchema>;
const nativeState = z.enum(["prepared", "dispatching", "queued", "running", "waiting_approval", "stopping", "completed",
  "failed", "cancelled", "interrupted", "ambiguous"]);
const progressPoint = z.object({ version: count, state: nativeState, observedAt: z.string().datetime(),
  availability: z.enum(["unknown", "current", "offline", "expired"]) }).strict();
export const taskRunSchema = z.object({ runId: id, harness: z.enum(["codex", "hermes", "claude", "other"]),
  state: z.enum(harnessRunStates), lastObservedAt: z.string().datetime(), stale: z.boolean(),
  firstObservedExecutionAt: z.string().datetime().nullable(), finishedObservedAt: z.string().datetime().nullable(),
  cancellation: z.enum(["not_requested", "requested", "confirmed", "reported", "unsupported"]),
  source: z.enum(["native_snapshot", "legacy"]), nativeState: nativeState.nullable(),
  availability: z.enum(["unknown", "current", "offline", "expired"]).nullable(),
  usage: z.object({ inputTokens: count.nullable(), outputTokens: count.nullable(), totalTokens: count.nullable(),
    costUsd: z.null(), hardCostLimitEnforced: z.literal(false) }).strict().nullable(),
  resultClaim: z.object({ contentHash: digest, sizeBytes: count, verified: z.literal(false) }).strict().nullable(),
  timeline: z.array(progressPoint).max(50), earlierObservationsOmitted: z.boolean() }).strict();
export type TaskRun = z.infer<typeof taskRunSchema>;
export const taskDetailSchema = z.object({ project: projectViewSchema, task: taskSummarySchema,
  instructions: text(4000), inputDigest: digest, observedAt: z.string().datetime(),
  attempts: z.array(z.object({ attemptId: id, attemptNumber: count, state: z.enum(attemptStates),
    runs: z.array(taskRunSchema).max(10), additionalRunsOmitted: z.boolean() }).strict()).max(10),
  earlierAttemptsOmitted: z.boolean(), progressSource: z.enum(["configured", "not_configured"]),
  dispatch: z.enum(["not_connected", "configured"]), artifacts: z.enum(["not_connected", "configured"]), review: z.enum(["not_connected", "recorded"]) }).strict();
export type TaskDetail = z.infer<typeof taskDetailSchema>;
