import { sha256Digest } from "../../security";
import { z } from "zod";
import type { KeyAvailabilityState, LocalDenialDetail } from "./types";

export const executionAuthorityStates = [
  "admitted",
  "executing",
  "expiring_soon",
  "cancellation_requested",
  "expired",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ExecutionAuthorityStateV1 = (typeof executionAuthorityStates)[number];
export type DeadlineLimitingFactorV1 = "duration" | "authority" | "lease" | "approval" | "reservation";

export interface ExecutionDeadlineSourcesV1 {
  admittedAt: string;
  ceilingDurationSeconds: number;
  authorityDurationSeconds: number;
  authorityExpiresAt: string;
  leaseExpiresAt: string;
  approvalExpiresAt?: string;
  reservationExpiresAt?: string;
}

export interface EffectiveExecutionDeadlineV1 {
  effectiveDeadline: string;
  limitingFactors: DeadlineLimitingFactorV1[];
  sources: ExecutionDeadlineSourcesV1;
}

export interface ExecutionIdentityV1 {
  tenantId: string;
  nodeId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  operationDigest: string;
}

export interface ExecutionAuthoritySnapshotV1 {
  schema: "control-room.execution-authority/v1";
  executionId: string;
  admissionId: string;
  identity: ExecutionIdentityV1;
  authorityDigest: string;
  state: ExecutionAuthorityStateV1;
  deadline: EffectiveExecutionDeadlineV1;
  leaseEpoch: number;
  cancellationRequestedAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionEventBaseV1 {
  eventId: string;
  occurredAt: string;
}

export type ExecutionAuthorityEventV1 = ExecutionEventBaseV1 & (
  | { kind: "start" }
  | { kind: "expiring_soon" }
  | { kind: "deadline_crossed"; latenessMilliseconds: number }
  | { kind: "cancellation_requested"; reason: "deadline" | "operator" | "server" | "restart" }
  | { kind: "completed" }
  | { kind: "failed"; safeFailureCode: string }
  | { kind: "cancelled" }
  | { kind: "lease_renewed"; authorityDigest: string; leaseEpoch: number; leaseExpiresAt: string }
);

export interface ExecutionTransitionV1 {
  snapshot: ExecutionAuthoritySnapshotV1;
  requestCancellation: boolean;
}

export type DeadlineObservationV1 =
  | { kind: "deadline_crossed"; observedAt: string; latenessMilliseconds: number; requestCancellation: boolean }
  | { kind: "expiring_soon"; observedAt: string; remainingMilliseconds: number }
  | { kind: "none"; observedAt: string; remainingMilliseconds?: number };

export type ExecutionRecoveryActionV1 = "pre_effect_recheck" | "request_cancellation" | "remain_expired" | "none";
export type EffectClaimStateV1 = "claimed" | "missing" | "ambiguous";

const factorOrder: DeadlineLimitingFactorV1[] = ["duration", "authority", "lease", "approval", "reservation"];
const terminalStates = new Set<ExecutionAuthorityStateV1>(["completed", "failed", "cancelled"]);

function requireNonempty(value: string, label: string): string {
  if (value.length === 0 || value.trim() !== value) throw new Error(`${label} must be a nonempty canonical identifier`);
  return value;
}

function normalizeInstant(value: string, label: string): string {
  if (!z.string().datetime({ offset: true }).safeParse(value).success) throw new Error(`${label} must be an RFC 3339 instant`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be an RFC 3339 instant`);
  return new Date(milliseconds).toISOString();
}

function requirePositiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 31_536_000) throw new Error(`${label} must be a positive safe integer no greater than one year`);
  return value;
}

function requireEpoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Lease epoch must be a nonnegative safe integer");
  return value;
}

export function calculateEffectiveExecutionDeadline(input: ExecutionDeadlineSourcesV1): EffectiveExecutionDeadlineV1 {
  const admittedAt = normalizeInstant(input.admittedAt, "Admission time");
  const ceilingDurationSeconds = requirePositiveDuration(input.ceilingDurationSeconds, "Ceiling duration");
  const authorityDurationSeconds = requirePositiveDuration(input.authorityDurationSeconds, "Authority duration");
  const durationSeconds = Math.min(ceilingDurationSeconds, authorityDurationSeconds);
  const durationDeadline = new Date(Date.parse(admittedAt) + durationSeconds * 1_000).toISOString();
  const sources: ExecutionDeadlineSourcesV1 = {
    admittedAt,
    ceilingDurationSeconds,
    authorityDurationSeconds,
    authorityExpiresAt: normalizeInstant(input.authorityExpiresAt, "Authority expiry"),
    leaseExpiresAt: normalizeInstant(input.leaseExpiresAt, "Lease expiry"),
    ...(input.approvalExpiresAt === undefined ? {} : { approvalExpiresAt: normalizeInstant(input.approvalExpiresAt, "Approval expiry") }),
    ...(input.reservationExpiresAt === undefined ? {} : { reservationExpiresAt: normalizeInstant(input.reservationExpiresAt, "Reservation expiry") }),
  };
  const candidates: Array<[DeadlineLimitingFactorV1, string]> = [
    ["duration", durationDeadline],
    ["authority", sources.authorityExpiresAt],
    ["lease", sources.leaseExpiresAt],
    ...(sources.approvalExpiresAt ? [["approval", sources.approvalExpiresAt] as [DeadlineLimitingFactorV1, string]] : []),
    ...(sources.reservationExpiresAt ? [["reservation", sources.reservationExpiresAt] as [DeadlineLimitingFactorV1, string]] : []),
  ];
  const earliest = Math.min(...candidates.map(([, instant]) => Date.parse(instant)));
  if (earliest <= Date.parse(admittedAt)) throw new Error("Effective deadline must be after admission");
  const limitingFactors = factorOrder.filter((factor) => candidates.some(([candidate, instant]) => candidate === factor && Date.parse(instant) === earliest));
  return { effectiveDeadline: new Date(earliest).toISOString(), limitingFactors, sources };
}

export function createExecutionAuthoritySnapshot(input: {
  executionId: string;
  admissionId: string;
  identity: ExecutionIdentityV1;
  authorityDigest: string;
  deadlineSources: ExecutionDeadlineSourcesV1;
  leaseEpoch: number;
  createdAt: string;
}): ExecutionAuthoritySnapshotV1 {
  const createdAt = normalizeInstant(input.createdAt, "Creation time");
  const deadline = calculateEffectiveExecutionDeadline(input.deadlineSources);
  if (createdAt !== deadline.sources.admittedAt) throw new Error("Creation time must equal admission time");
  for (const [label, value] of Object.entries({ executionId: input.executionId, admissionId: input.admissionId, ...input.identity, authorityDigest: input.authorityDigest })) {
    requireNonempty(String(value), label);
  }
  return {
    schema: "control-room.execution-authority/v1",
    executionId: input.executionId,
    admissionId: input.admissionId,
    identity: { ...input.identity },
    authorityDigest: input.authorityDigest,
    state: "admitted",
    deadline,
    leaseEpoch: requireEpoch(input.leaseEpoch),
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

export function computeExecutionId(admissionId: string, operationDigest: string): string {
  return sha256Digest({ schema: "control-room.execution-identity/v1", admissionId, operationDigest });
}

function transitioned(snapshot: ExecutionAuthoritySnapshotV1, event: ExecutionAuthorityEventV1, state: ExecutionAuthorityStateV1, extra: Partial<ExecutionAuthoritySnapshotV1> = {}): ExecutionTransitionV1 {
  return {
    snapshot: { ...snapshot, ...extra, state, version: snapshot.version + 1, updatedAt: normalizeInstant(event.occurredAt, "Event time") },
    requestCancellation: false,
  };
}

function requireState(snapshot: ExecutionAuthoritySnapshotV1, allowed: ExecutionAuthorityStateV1[], event: ExecutionAuthorityEventV1): void {
  if (!allowed.includes(snapshot.state)) throw new Error(`Invalid execution transition: ${snapshot.state} -> ${event.kind}`);
}

export function applyExecutionAuthorityEvent(snapshot: ExecutionAuthoritySnapshotV1, event: ExecutionAuthorityEventV1): ExecutionTransitionV1 {
  requireNonempty(event.eventId, "eventId");
  const occurredAt = normalizeInstant(event.occurredAt, "Event time");
  if (occurredAt !== event.occurredAt) throw new Error("Event time must be canonical UTC");
  if (Date.parse(occurredAt) < Date.parse(snapshot.createdAt)) throw new Error("Execution event predates admission");
  if (Date.parse(occurredAt) < Date.parse(snapshot.updatedAt)) throw new Error("Execution event time cannot move backwards");
  if (terminalStates.has(snapshot.state)) throw new Error(`Invalid execution transition: ${snapshot.state} -> ${event.kind}`);

  switch (event.kind) {
    case "start":
      requireState(snapshot, ["admitted"], event);
      if (Date.parse(occurredAt) >= Date.parse(snapshot.deadline.effectiveDeadline)) throw new Error("Cannot start expired authority");
      return transitioned(snapshot, event, "executing");
    case "expiring_soon":
      requireState(snapshot, ["executing"], event);
      if (Date.parse(occurredAt) >= Date.parse(snapshot.deadline.effectiveDeadline)) throw new Error("Expiry advisory cannot cross the deadline");
      return transitioned(snapshot, event, "expiring_soon");
    case "deadline_crossed": {
      requireState(snapshot, ["admitted", "executing", "expiring_soon", "cancellation_requested"], event);
      if (!Number.isSafeInteger(event.latenessMilliseconds) || event.latenessMilliseconds < 0) throw new Error("Deadline lateness must be a nonnegative safe integer");
      if (Date.parse(occurredAt) < Date.parse(snapshot.deadline.effectiveDeadline)) throw new Error("Deadline has not crossed");
      if (event.latenessMilliseconds !== Date.parse(occurredAt) - Date.parse(snapshot.deadline.effectiveDeadline)) throw new Error("Deadline lateness does not match the event time");
      const mustCancel = snapshot.state === "executing" || snapshot.state === "expiring_soon" || snapshot.state === "cancellation_requested";
      const result = transitioned(snapshot, event, "expired", mustCancel ? { cancellationRequestedAt: snapshot.cancellationRequestedAt ?? occurredAt } : {});
      return { ...result, requestCancellation: mustCancel };
    }
    case "cancellation_requested":
      requireState(snapshot, ["executing", "expiring_soon"], event);
      if (Date.parse(occurredAt) >= Date.parse(snapshot.deadline.effectiveDeadline)) throw new Error("Post-deadline cancellation must use the deadline-crossed event");
      return transitioned(snapshot, event, "cancellation_requested", { cancellationRequestedAt: occurredAt });
    case "completed":
      requireState(snapshot, ["executing", "expiring_soon"], event);
      if (Date.parse(occurredAt) >= Date.parse(snapshot.deadline.effectiveDeadline)) throw new Error("Expired authority cannot complete normally");
      return transitioned(snapshot, event, "completed");
    case "failed":
      if (!/^[a-z0-9_]{1,64}$/.test(event.safeFailureCode)) throw new Error("Failure code must be a safe bounded token");
      requireState(snapshot, ["admitted", "executing", "expiring_soon", "cancellation_requested", "expired"], event);
      return transitioned(snapshot, event, "failed");
    case "cancelled":
      requireState(snapshot, ["cancellation_requested", "expired"], event);
      return transitioned(snapshot, event, "cancelled");
    case "lease_renewed": {
      requireState(snapshot, ["admitted", "executing", "expiring_soon"], event);
      if (Date.parse(occurredAt) >= Date.parse(snapshot.deadline.effectiveDeadline)) throw new Error("Expired authority cannot be renewed");
      if (event.authorityDigest !== snapshot.authorityDigest) throw new Error("Renewal cannot replace authority mid-attempt");
      if (requireEpoch(event.leaseEpoch) <= snapshot.leaseEpoch) throw new Error("Renewal lease epoch must increase");
      const deadline = calculateEffectiveExecutionDeadline({ ...snapshot.deadline.sources, leaseExpiresAt: event.leaseExpiresAt });
      if (Date.parse(deadline.effectiveDeadline) <= Date.parse(occurredAt)) throw new Error("Renewed lease is already expired");
      return transitioned(snapshot, event, snapshot.state === "expiring_soon" ? "executing" : snapshot.state, { deadline, leaseEpoch: event.leaseEpoch });
    }
  }
}

export function observeExecutionDeadline(snapshot: ExecutionAuthoritySnapshotV1, now: string, expiringSoonThresholdSeconds?: number): DeadlineObservationV1 {
  const observedAt = normalizeInstant(now, "Observation time");
  if (terminalStates.has(snapshot.state) || snapshot.state === "expired") return { kind: "none", observedAt };
  const remainingMilliseconds = Date.parse(snapshot.deadline.effectiveDeadline) - Date.parse(observedAt);
  if (remainingMilliseconds <= 0) {
    return {
      kind: "deadline_crossed",
      observedAt,
      latenessMilliseconds: Math.abs(remainingMilliseconds),
      requestCancellation: snapshot.state === "executing" || snapshot.state === "expiring_soon" || snapshot.state === "cancellation_requested",
    };
  }
  if (expiringSoonThresholdSeconds !== undefined) {
    requirePositiveDuration(expiringSoonThresholdSeconds, "Expiry advisory threshold");
    if (snapshot.state === "executing" && remainingMilliseconds <= expiringSoonThresholdSeconds * 1_000) {
      return { kind: "expiring_soon", observedAt, remainingMilliseconds };
    }
  }
  return { kind: "none", observedAt, remainingMilliseconds };
}

export function classifyExecutionRecovery(snapshot: ExecutionAuthoritySnapshotV1): ExecutionRecoveryActionV1 {
  if (snapshot.state === "admitted") return "pre_effect_recheck";
  if (["executing", "expiring_soon", "cancellation_requested"].includes(snapshot.state)) return "request_cancellation";
  if (snapshot.state === "expired") return snapshot.cancellationRequestedAt ? "request_cancellation" : "remain_expired";
  return "none";
}

export function recheckBeforeExternalEffect(input: {
  snapshot: ExecutionAuthoritySnapshotV1;
  now: string;
  currentOperationDigest: string;
  keyAvailability: KeyAvailabilityState;
  paused: boolean;
  effectClaim: EffectClaimStateV1;
}): { allowed: true; checkedAt: string } | { allowed: false; checkedAt: string; detail: LocalDenialDetail } {
  const checkedAt = normalizeInstant(input.now, "Pre-effect check time");
  const deny = (detail: LocalDenialDetail) => ({ allowed: false as const, checkedAt, detail });
  if (input.snapshot.state !== "executing" && input.snapshot.state !== "expiring_soon") return deny(input.snapshot.state === "expired" ? "authority_expired" : "effect_in_progress");
  if (Date.parse(checkedAt) >= Date.parse(input.snapshot.deadline.effectiveDeadline)) return deny("authority_expired");
  if (input.keyAvailability !== "available") return deny("keystore_unavailable");
  if (input.currentOperationDigest !== input.snapshot.identity.operationDigest) return deny("authority_invalid");
  if (input.paused) return deny("paused");
  if (input.effectClaim === "ambiguous") return deny("effect_ambiguous");
  if (input.effectClaim !== "claimed") return deny("effect_in_progress");
  return { allowed: true, checkedAt };
}
