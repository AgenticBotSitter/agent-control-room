import { z } from "zod";
import { jobStates, attemptStates } from "../../domain/v1/types";
import { harnessRunStates } from "../../harness/v1/types";
import { projectViewSchema, catalogProjectIdSchema } from "./project-wire";

const id = catalogProjectIdSchema;
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => ![...value].some(char =>
  (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !["\n", "\r", "\t"].includes(char)));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/);
const effort = z.enum(["default", "low", "medium", "high", "xhigh", "max"]);
const usageUnknownReason = z.enum(["usage_not_reported", "model_not_recorded", "price_table_not_recorded",
  "price_entry_not_recorded", "partial_token_usage"]);
export const usageCostSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("known"), nanoUsd: z.string().regex(/^(?:0|[1-9][0-9]*)$/), priceEntryId: id, tableId: id }).strict(),
  z.object({ kind: z.literal("included_in_subscription"), priceEntryId: id, tableId: id }).strict(),
  z.object({ kind: z.literal("unknown"), reason: usageUnknownReason }).strict(),
]);
export const usageRollupSchema = z.object({ runs: count, inputTokens: count.nullable(), outputTokens: count.nullable(),
  totalTokens: count.nullable(), wallTimeMs: count.nullable(), knownCostNanoUsd: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  knownCostRuns: count, subscriptionRuns: count, unknownCostRuns: count,
  unknownCostReasons: z.array(usageUnknownReason) }).strict();
const declaredScope = z.object({ kind: z.enum(["file", "tree"]), path: z.string().max(512)
  .refine(value => value === "" || /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127})*$/.test(value)) }).strict()
  .transform(value => ({ ...value, path: value.path.toLowerCase() }));
export const taskDraftSchema = z.object({ title: text(120), instructions: text(4000),
  model: model.optional(), effort: effort.optional(), scopes: z.array(declaredScope).max(64).optional() }).strict()
  .superRefine((value, context) => {
    if (value.scopes && new Set(value.scopes.map(scope => `${scope.kind}\0${scope.path}`)).size !== value.scopes.length)
      context.addIssue({ code: "custom", message: "duplicate task scope", path: ["scopes"] });
  });
export type TaskDraft = z.infer<typeof taskDraftSchema>;
export const taskSummarySchema = z.object({ jobId: id, projectId: id, requestId: id, title: text(180),
  state: z.enum(jobStates), version: count, createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  /** Present only when authenticated completion-gate evidence proves the result is ready. */
  qualityStatus: z.literal("accepted").optional() }).strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export const taskReceiptSchema = z.object({ jobId: id, projectId: id, requestId: id,
  createdAt: z.string().datetime(), submission: z.literal("proposed"), startsWork: z.literal(false) }).strict();
export type TaskReceipt = z.infer<typeof taskReceiptSchema>;
export const taskCommandSchema = z.object({ receipt: taskReceiptSchema, replayed: z.boolean() }).strict();
export const taskPageSchema = z.object({ project: projectViewSchema, tasks: z.array(taskSummarySchema).max(50),
  nextCursor: id.nullable(), canPropose: z.boolean(), dispatch: z.enum(["not_connected", "configured"]), observedAt: z.string().datetime(),
  modelOptions: z.array(z.object({ workerKind: z.enum(["codex", "claude-code", "hermes"]),
    choices: z.array(z.object({ key: model, label: z.string().min(1).max(240), model, efforts: z.array(effort).min(1).max(5),
      limited: z.boolean() }).strict()).min(1).max(32), defaultModel: model, defaultEffort: effort }).strict()).max(3).optional() }).strict();
export type TaskPage = z.infer<typeof taskPageSchema>;
const nativeState = z.enum(["prepared", "dispatching", "queued", "running", "waiting_approval", "stopping", "completed",
  "failed", "cancelled", "interrupted", "ambiguous"]);
const hermesDeliveryRecoveryStatus = z.object({
  state: z.enum(["no_authenticated_delivery", "delivery_receipt_unresolved", "terminal_result_staged"]),
  terminal: z.object({ terminalResultDigest: digest, contentDigest: digest, sizeBytes: count,
    inputTokens: count, outputTokens: count, totalTokens: count, durationMs: count }).strict().optional(),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false), permitsRetry: z.literal(false), permitsResume: z.literal(false),
}).strict();
export const hermesDeliveryRecoverySchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("not_configured") }).strict(),
  z.object({ source: z.literal("not_applicable") }).strict(),
  z.object({ source: z.literal("ambiguous_attempt") }).strict(),
  z.object({ source: z.literal("unavailable") }).strict(),
  z.object({ source: z.literal("configured"), status: hermesDeliveryRecoveryStatus }).strict(),
]);
export type HermesDeliveryRecovery = z.infer<typeof hermesDeliveryRecoverySchema>;
const progressPoint = z.object({ version: count, state: nativeState, observedAt: z.string().datetime(),
  availability: z.enum(["unknown", "current", "offline", "expired"]) }).strict();
export const taskRunSchema = z.object({ runId: id, harness: z.enum(["codex", "hermes", "claude", "other"]),
  model: model.optional(), effort: effort.optional(), provider: model.optional(), profile: model.optional(),
  state: z.enum(harnessRunStates), lastObservedAt: z.string().datetime(), stale: z.boolean(),
  /** A redacted category derived from the signed run adapter, not a claim that
   * the corresponding local installation is still configured or available. */
  routeEvidence: z.enum(["local_hermes", "local_claude", "local_codex", "other_or_unknown"]).optional(),
  firstObservedExecutionAt: z.string().datetime().nullable(), finishedObservedAt: z.string().datetime().nullable(),
  cancellation: z.enum(["not_requested", "requested", "confirmed", "reported", "unsupported"]),
  source: z.enum(["native_snapshot", "legacy"]), nativeState: nativeState.nullable(),
  availability: z.enum(["unknown", "current", "offline", "expired"]).nullable(),
  usage: z.object({ inputTokens: count.nullable(), outputTokens: count.nullable(), totalTokens: count.nullable(),
    wallTimeMs: count.nullable() }).strict().nullable(), cost: usageCostSchema,
  resultClaim: z.object({ contentHash: digest, sizeBytes: count, verified: z.literal(false) }).strict().nullable(),
  timeline: z.array(progressPoint).max(50), earlierObservationsOmitted: z.boolean() }).strict();
export type TaskRun = z.infer<typeof taskRunSchema>;
export const taskLocalRouteObservationSchema = z.object({
  state: z.enum(["not_prepared", "not_local_route", "not_observed", "configured_local_route", "needs_attention", "recorded_not_current"]),
  adapter: z.enum(["hermes", "claude", "codex"]).nullable(),
}).strict();
export type TaskLocalRouteObservation = z.infer<typeof taskLocalRouteObservationSchema>;
export const taskDetailSchema = z.object({ project: projectViewSchema, task: taskSummarySchema,
  instructions: text(4000), inputDigest: digest, observedAt: z.string().datetime(),
  modelSelection: z.object({ workerKind: z.enum(["codex", "claude-code", "hermes"]).nullable(), selectionKey: model.nullable(),
    model: model.nullable(), effort: effort.nullable(), provider: model.nullable(), profile: model.nullable(), inheritedFromJobId: id.nullable() }).strict().nullable(),
  ownershipLeases: z.array(z.object({ nodeId: id, scopes: z.array(z.object({ kind: z.enum(["file", "tree"]), path: z.string().max(512) }).strict()).max(64),
    expiresAt: z.string().datetime(), state: z.enum(["active", "released", "expired", "revoked"]), current: z.boolean() }).strict()).max(10),
  attempts: z.array(z.object({ attemptId: id, attemptNumber: count, state: z.enum(attemptStates),
    runs: z.array(taskRunSchema).max(10), additionalRunsOmitted: z.boolean(), usageRollup: usageRollupSchema }).strict()).max(10),
  usageRollup: usageRollupSchema,
  priceTable: z.object({ state: z.enum(["recorded", "not_recorded"]), tableId: id.nullable(), recordedAt: z.string().datetime().nullable() }).strict(),
  earlierAttemptsOmitted: z.boolean(), preparedFor: z.enum(["hermes", "codex", "claude", "configured_worker"]).nullable(),
  localRouteObservation: taskLocalRouteObservationSchema,
  hermesDeliveryRecovery: hermesDeliveryRecoverySchema,
  revisionLinks: z.object({ previousJobId: id.nullable(), nextJobId: id.nullable(), revisionNumber: z.number().int().min(0).max(20) }).strict().optional(),
  progressSource: z.enum(["configured", "not_configured"]),
  dispatch: z.enum(["not_connected", "configured"]), artifacts: z.enum(["not_connected", "configured"]), review: z.enum(["not_connected", "recorded"]) }).strict();
export type TaskDetail = z.infer<typeof taskDetailSchema>;
