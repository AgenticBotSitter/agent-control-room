import { z } from "zod";

/** Evidence only: these fields grant no dispatch, retry, approval or cleanup authority. */
export const NATIVE_HERMES_ADAPTER_ID = "adapter.hermes.native_runs.v1" as const;
export const NATIVE_HERMES_VERSION = "2026.8.31" as const;
export const nativeTaskProtocolId = z.string().min(3).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const id = nativeTaskProtocolId;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.string().datetime().refine(value => new Date(value).toISOString() === value);
export const nativeReportedStates = ["prepared", "dispatching", "queued", "running", "waiting_approval", "stopping",
  "completed", "failed", "cancelled", "interrupted", "ambiguous"] as const;
export const nativeTaskRegistrationSchema = z.object({ bindingDigest: digest, inputDigest: digest,
  leaseId: id, leaseEpoch: count.positive(), deadline: time }).strict();
export type NativeTaskRegistration = z.infer<typeof nativeTaskRegistrationSchema>;

export const nativeTaskSnapshotBodySchema = z.object({
  runId: id, projectId: id, jobId: id, attemptId: id, leaseId: id, leaseEpoch: count.positive(),
  bindingDigest: digest, sessionKeyDigest: digest, nativeRunKeyDigest: digest.nullable(),
  snapshotVersion: count.positive(), observedAt: time, upstreamUpdatedAt: time.nullable(),
  state: z.enum(nativeReportedStates), availability: z.enum(["unknown", "current", "offline", "expired"]),
  lastActivity: z.enum(["none", "tool_started", "tool_completed", "message_progress", "approval_requested", "status_resnapshot"]),
  stopAttempted: z.boolean(),
  safeReason: z.enum(["none", "preflight_failed", "dispatch_uncertain", "run_unavailable", "protocol_mismatch",
    "transport_unavailable", "authority_unavailable", "deadline_reached", "gateway_interrupted", "storage_uncertain"]),
  result: z.object({ contentHash: digest, sizeBytes: count.max(65_536) }).strict().nullable(),
  usage: z.object({ inputTokens: count.nullable(), outputTokens: count.nullable(), totalTokens: count.nullable(),
    provenance: z.literal("upstream_reported"), cachedInputTokens: z.null(), reasoningTokens: z.null(),
    calls: z.null(), costUsd: z.null(), hardCostLimitEnforced: z.literal(false) }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (value.result !== null && value.state !== "completed") context.addIssue({ code: "custom", message: "only completed snapshots carry a result claim" });
  if (["queued", "running", "waiting_approval", "stopping", "completed", "cancelled", "interrupted"].includes(value.state)
    && value.nativeRunKeyDigest === null) context.addIssue({ code: "custom", message: "observed upstream state requires an exact run reference" });
  if (value.upstreamUpdatedAt !== null && Date.parse(value.upstreamUpdatedAt) > Date.parse(value.observedAt)) {
    context.addIssue({ code: "custom", message: "upstream update cannot follow the observation" });
  }
});
export type NativeTaskSnapshotBody = z.infer<typeof nativeTaskSnapshotBodySchema>;
export type NativeSnapshotEventPayload = { category: "native_snapshot"; snapshot: NativeTaskSnapshotBody };
export const nativeReportedTerminal = (state: NativeTaskSnapshotBody["state"]) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(state);

export const nativeReportedTransitions: Readonly<Record<NativeTaskSnapshotBody["state"], readonly NativeTaskSnapshotBody["state"][]>> = {
  prepared: ["dispatching", "failed"], dispatching: ["queued", "ambiguous"],
  queued: ["running", "waiting_approval", "stopping", "completed", "failed", "cancelled", "interrupted", "ambiguous"],
  running: ["waiting_approval", "stopping", "completed", "failed", "cancelled", "interrupted", "ambiguous"],
  waiting_approval: ["running", "stopping", "completed", "failed", "cancelled", "interrupted", "ambiguous"],
  stopping: ["completed", "failed", "cancelled", "interrupted", "ambiguous"],
  ambiguous: ["queued", "running", "waiting_approval", "stopping", "completed", "failed", "cancelled", "interrupted"],
  completed: [], failed: [], cancelled: [], interrupted: [],
};

/** Versions can skip, but observations must remain reachable without resetting immutable state. */
export function assertNativeSnapshotProgress(prior: NativeTaskSnapshotBody, next: NativeTaskSnapshotBody): void {
  const reached = new Set([prior.state]); let frontier = [prior.state];
  const steps = Math.min(next.snapshotVersion - prior.snapshotVersion, nativeReportedStates.length);
  for (let step = 0; step < steps; step++) {
    const following = frontier.flatMap(state => [...nativeReportedTransitions[state]]).filter(state => !reached.has(state));
    for (const state of following) reached.add(state);
    frontier = following;
  }
  if (["runId", "projectId", "jobId", "attemptId", "leaseId", "leaseEpoch", "bindingDigest", "sessionKeyDigest"].some(key =>
    prior[key as keyof NativeTaskSnapshotBody] !== next[key as keyof NativeTaskSnapshotBody])
    || next.snapshotVersion <= prior.snapshotVersion || Date.parse(next.observedAt) < Date.parse(prior.observedAt)
    || prior.nativeRunKeyDigest !== null && next.nativeRunKeyDigest !== prior.nativeRunKeyDigest
    || prior.upstreamUpdatedAt !== null && (next.upstreamUpdatedAt === null || Date.parse(next.upstreamUpdatedAt) < Date.parse(prior.upstreamUpdatedAt))
    || prior.stopAttempted && !next.stopAttempted || nativeReportedTerminal(prior.state) || !reached.has(next.state)) {
    throw new Error("native snapshot progress conflict");
  }
}
