import { z } from "zod";
import { HARNESS_CONTRACT_VERSION_V1, HARNESS_EVENT_SCHEMA_VERSION_V1, harnessRunStates } from "./types";
import { nativeTaskRegistrationSchema, nativeTaskSnapshotBodySchema, NATIVE_HERMES_ADAPTER_ID, NATIVE_HERMES_VERSION } from "./native-observation";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const version = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.string().datetime({ offset: true });
const boundedCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const money = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/);

export const harnessAdapterManifestSchemaV1 = z.object({
  schemaVersion: z.literal(HARNESS_CONTRACT_VERSION_V1), adapterId: id, adapterVersion: version,
  harness: z.enum(["hermes", "codex", "claude", "other"]), harnessVersion: version,
  harnessRevision: z.string().regex(/^[a-f0-9]{40}$/),
  runtime: z.object({ name: z.enum(["python", "node", "native"]), minimumVersion: version, supportedPlatforms: z.array(z.enum(["linux", "macos", "windows"])).min(1).max(3) }).strict(),
  supportedVerbs: z.array(z.enum(["discover", "start", "stream", "steer", "cancel", "resume", "usage"])).min(1).max(7),
  eventSchemaVersion: z.literal(HARNESS_EVENT_SCHEMA_VERSION_V1), approvalMode: z.enum(["unsupported", "observe_only", "request_response"]),
  isolation: z.enum(["adapter_process", "worktree", "container", "harness_owned"]), credentialResolution: z.enum(["harness_native", "node_reference_only", "unsupported"]),
  outputForms: z.array(z.enum(["structured_events", "artifact_references", "final_text_digest", "usage"])).min(1).max(4),
  license: z.string().min(1).max(80), distribution: z.enum(["invocation_only", "redistributable"]),
}).strict().superRefine((manifest, context) => {
  for (const field of ["supportedVerbs", "outputForms", "runtime.supportedPlatforms"] as const) {
    const values = field === "runtime.supportedPlatforms" ? manifest.runtime.supportedPlatforms : manifest[field];
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: `${field} must be unique`, path: field.split(".") });
  }
});

export const harnessRunSchemaV1 = z.object({
  schemaVersion: z.literal(HARNESS_CONTRACT_VERSION_V1), id, tenantId: id, projectId: id, jobId: id, attemptId: id, nodeId: id,
  adapterId: id, adapterVersion: version, harness: z.enum(["hermes", "codex", "claude", "other"]), harnessVersion: version,
  nativeSessionKeyDigest: digest, parentRunId: id.optional(), revisionOfRunId: id.optional(), state: z.enum(harnessRunStates), resumable: z.boolean(),
  cancelState: z.enum(["not_requested", "requested", "confirmed", "reported", "unsupported"]), nativeTask: nativeTaskRegistrationSchema.optional(),
  createdAt: time, updatedAt: time, startedAt: time.optional(), finishedAt: time.optional(), lastObservedAt: time, safeReasonCode: id.optional(),
}).strict().superRefine((run, context) => {
  if (Boolean(run.nativeTask) !== (run.adapterId === NATIVE_HERMES_ADAPTER_ID)
    || run.nativeTask && (run.harness !== "hermes" || run.harnessVersion !== NATIVE_HERMES_VERSION || run.adapterVersion !== "1.0.0" || run.resumable || run.cancelState === "confirmed")
    || run.cancelState === "reported" && (!run.nativeTask || run.state !== "cancelled")) {
    context.addIssue({ code: "custom", message: "native observation registration or cancellation semantics mismatch" });
  }
  if (run.parentRunId && run.revisionOfRunId) context.addIssue({ code: "custom", message: "parent and revision lineage are mutually exclusive", path: ["revisionOfRunId"] });
  if (run.parentRunId === run.id || run.revisionOfRunId === run.id) context.addIssue({ code: "custom", message: "run cannot reference itself", path: ["parentRunId"] });
  if (Date.parse(run.updatedAt) < Date.parse(run.createdAt) || Date.parse(run.lastObservedAt) < Date.parse(run.createdAt)) context.addIssue({ code: "custom", message: "run timestamps must be monotonic", path: ["updatedAt"] });
  const terminal = ["succeeded", "failed", "cancelled"].includes(run.state);
  if (terminal !== Boolean(run.finishedAt)) context.addIssue({ code: "custom", message: "terminal runs require finishedAt and nonterminal runs forbid it", path: ["finishedAt"] });
  if (!run.nativeTask && ["running", "waiting_input", "waiting_approval", "cancelling", "succeeded", "failed", "cancelled"].includes(run.state) && !run.startedAt) context.addIssue({ code: "custom", message: "started lifecycle requires startedAt", path: ["startedAt"] });
});

const eventPayloadSchema = z.discriminatedUnion("category", [
  z.object({ category: z.literal("native_snapshot"), snapshot: nativeTaskSnapshotBodySchema }).strict(),
  z.object({ category: z.literal("lifecycle"), state: z.enum(harnessRunStates), reasonCode: id.optional() }).strict(),
  z.object({ category: z.literal("activity"), activity: z.enum(["tool", "file", "test", "checkpoint"]), phase: z.enum(["started", "progress", "completed", "failed"]), count: boundedCount.optional() }).strict(),
  z.object({ category: z.literal("attention"), attention: z.enum(["input", "approval"]), state: z.enum(["requested", "resolved"]) }).strict(),
  z.object({ category: z.literal("usage"), inputTokens: boundedCount, outputTokens: boundedCount, cachedInputTokens: boundedCount, reasoningTokens: boundedCount, estimatedCostUsd: money.optional() }).strict(),
  z.object({ category: z.literal("transport"), state: z.enum(["connected", "disconnected", "reconnected", "drift"]), reasonCode: id.optional() }).strict(),
]);

export const harnessRunEventSchemaV1 = z.object({
  schemaVersion: z.literal(HARNESS_EVENT_SCHEMA_VERSION_V1), tenantId: id, runId: id, sequence: z.number().int().positive(), occurredAt: time,
  source: z.enum(["adapter", "harness_read", "control_room"]), sourceEventKeyDigest: digest, payload: eventPayloadSchema,
}).strict();
