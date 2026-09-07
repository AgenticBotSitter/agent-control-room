import { sha256Digest } from "../../security";
import { z } from "zod";
import { computeNormalizedOperationDigest } from "./policy-evaluator";
import type { EffectClaimStateV1 } from "./execution-authority";
import type { NormalizedLocalPolicyRequestV1, NormalizedTargetV1 } from "./types";

export const effectClaimStates = ["claimed", "executing", "confirmed", "failed", "cancelled", "ambiguous"] as const;
export type EffectClaimLifecycleStateV1 = (typeof effectClaimStates)[number];
export type TerminalEffectClaimStateV1 = "confirmed" | "failed" | "cancelled";

export interface EffectIdentityV1 {
  tenantId: string;
  nodeId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  operationDigest: string;
}

export interface PreEffectMarkerV1 {
  schema: "control-room.pre-effect-marker/v1";
  markerId: string;
  claimKey: string;
  requestDigest: string;
  operationDigest: string;
  operation: PreEffectOperationMaterialV1;
  authorityDigest: string;
  effectiveDeadline: string;
  markedAt: string;
}

export interface PreEffectOperationMaterialV1 {
  tenantId: string;
  nodeId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  executorId: string;
  operationId: string;
  credentialRefs: string[];
  target: NormalizedTargetV1;
  risk: NormalizedLocalPolicyRequestV1["risk"];
  externalEffect: true;
  estimatedDurationSeconds: number;
  payloadDigest?: string;
  estimatedCostUsd?: string;
}

export interface EffectClaimSnapshotV1 {
  schema: "control-room.effect-claim/v1";
  claimKey: string;
  destinationIdempotencyKey: string;
  executionId: string;
  admissionId: string;
  identity: EffectIdentityV1;
  identityDigest: string;
  authorityDigest: string;
  effectiveDeadline: string;
  state: EffectClaimLifecycleStateV1;
  markerDigest?: string;
  destinationReceiptDigest?: string;
  nonExecutionEvidenceDigest?: string;
  safeFailureCode?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type EffectClaimEventV1 = { eventId: string; occurredAt: string } & (
  | { kind: "marker_committed"; markerDigest: string }
  | { kind: "ambiguity_raised"; reason: "restart" | "lost_ack" | "unknown_result" }
  | { kind: "confirmed"; destinationReceiptDigest: string }
  | { kind: "failed"; safeFailureCode: string; nonExecutionEvidenceDigest?: string }
  | { kind: "cancelled" }
);

export type EffectRecoveryActionV1 = "re_evaluate_claimed" | "mark_ambiguous" | "await_evidence" | "replay_terminal";

function canonicalInstant(value: string, label: string): string {
  if (!z.string().datetime({ offset: false }).safeParse(value).success || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be canonical RFC 3339 UTC`);
  }
  return value;
}

function digest(value: string, label: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function safeToken(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(value)) throw new Error(`${label} must be a safe identifier`);
  return value;
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key,index) => key !== expected[index])) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function validateEffectClaimEvent(event: EffectClaimEventV1): void {
  const common = ["eventId","kind","occurredAt"];
  switch (event.kind) {
    case "marker_committed":
      exactKeys(event,[...common,"markerDigest"],"Marker event");
      break;
    case "ambiguity_raised":
      exactKeys(event,[...common,"reason"],"Ambiguity event");
      if (!["restart","lost_ack","unknown_result"].includes(event.reason)) throw new Error("Ambiguity reason is invalid");
      break;
    case "confirmed":
      exactKeys(event,[...common,"destinationReceiptDigest"],"Confirmation event");
      break;
    case "failed":
      exactKeys(event,event.nonExecutionEvidenceDigest === undefined ? [...common,"safeFailureCode"] : [...common,"safeFailureCode","nonExecutionEvidenceDigest"],"Failure event");
      break;
    case "cancelled":
      exactKeys(event,common,"Cancellation event");
      break;
    default:
      throw new Error("Effect event kind is invalid");
  }
}

export function computeEffectClaimKey(identity: EffectIdentityV1): string {
  return sha256Digest({
    schema: "control-room.effect-identity/v1",
    tenantId: identity.tenantId,
    nodeId: identity.nodeId,
    projectId: identity.projectId,
    jobId: identity.jobId,
    attemptId: identity.attemptId,
    operationDigest: identity.operationDigest,
  });
}

export function createEffectClaimSnapshot(input: {
  executionId: string;
  admissionId: string;
  identity: EffectIdentityV1;
  authorityDigest: string;
  effectiveDeadline: string;
  createdAt: string;
}): EffectClaimSnapshotV1 {
  const createdAt = canonicalInstant(input.createdAt, "Claim time");
  const effectiveDeadline = canonicalInstant(input.effectiveDeadline, "Effective deadline");
  if (Date.parse(createdAt) >= Date.parse(effectiveDeadline)) throw new Error("Expired authority cannot create an effect claim");
  for (const [label, value] of Object.entries({ executionId: input.executionId, admissionId: input.admissionId, ...input.identity })) {
    safeToken(String(value), label);
  }
  digest(input.identity.operationDigest, "Operation digest");
  digest(input.authorityDigest, "Authority digest");
  const claimKey = computeEffectClaimKey(input.identity);
  return {
    schema: "control-room.effect-claim/v1", claimKey, destinationIdempotencyKey: claimKey,
    executionId: input.executionId, admissionId: input.admissionId, identity: { ...input.identity },
    identityDigest: sha256Digest(input.identity), authorityDigest: input.authorityDigest, effectiveDeadline,
    state: "claimed", version: 1, createdAt, updatedAt: createdAt,
  };
}

export function createPreEffectMarker(input: {
  markerId: string;
  claim: EffectClaimSnapshotV1;
  request: NormalizedLocalPolicyRequestV1;
  authorityDigest: string;
  effectiveDeadline: string;
  markedAt: string;
}): PreEffectMarkerV1 {
  if (input.request.operationId === "harness.hermes.native.start" && input.request.payloadDigest === undefined)
    throw new Error("Native pre-effect marker requires payload commitment");
  const markedAt = canonicalInstant(input.markedAt, "Marker time");
  if (input.claim.state !== "claimed") throw new Error("Only a claimed effect can receive its pre-effect marker");
  if (Date.parse(markedAt) >= Date.parse(input.claim.effectiveDeadline)) throw new Error("Expired authority cannot receive a pre-effect marker");
  safeToken(input.markerId, "Marker ID");
  if (input.authorityDigest !== input.claim.authorityDigest || input.effectiveDeadline !== input.claim.effectiveDeadline) {
    throw new Error("Pre-effect authority binding mismatch");
  }
  const requestIdentity: EffectIdentityV1 = {
    tenantId: input.request.tenantId, nodeId: input.request.nodeId, projectId: input.request.projectId,
    jobId: input.request.jobId, attemptId: input.request.attemptId, operationDigest: input.request.operationDigest,
  };
  if (computeEffectClaimKey(requestIdentity) !== input.claim.claimKey
    || computeNormalizedOperationDigest(input.request) !== input.request.operationDigest
    || !input.request.externalEffect) throw new Error("Pre-effect operation binding mismatch");
  const operation: PreEffectOperationMaterialV1 = {
    tenantId: input.request.tenantId, nodeId: input.request.nodeId, projectId: input.request.projectId,
    jobId: input.request.jobId, attemptId: input.request.attemptId, executorId: input.request.executorId,
    operationId: input.request.operationId, credentialRefs: [...input.request.credentialRefs],
    target: structuredClone(input.request.target), risk: input.request.risk, externalEffect: true,
    estimatedDurationSeconds: input.request.estimatedDurationSeconds,
    ...(input.request.payloadDigest === undefined ? {} : { payloadDigest: digest(input.request.payloadDigest, "Payload digest") }),
    ...(input.request.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: input.request.estimatedCostUsd }),
  };
  return {
    schema: "control-room.pre-effect-marker/v1", markerId: input.markerId, claimKey: input.claim.claimKey,
    requestDigest: sha256Digest(input.request), operationDigest: input.request.operationDigest, operation,
    authorityDigest: input.authorityDigest, effectiveDeadline: input.effectiveDeadline, markedAt,
  };
}

export function computePreEffectOperationDigest(operation: PreEffectOperationMaterialV1): string {
  return sha256Digest(operation);
}

export function validatePreEffectMarkerBinding(marker: PreEffectMarkerV1, claim: EffectClaimSnapshotV1): void {
  if (marker.operation.operationId === "harness.hermes.native.start" && marker.operation.payloadDigest === undefined)
    throw new Error("Native pre-effect marker requires payload commitment");
  exactKeys(marker,["schema","markerId","claimKey","requestDigest","operationDigest","operation","authorityDigest","effectiveDeadline","markedAt"],"Pre-effect marker");
  exactKeys(marker.operation,["tenantId","nodeId","projectId","jobId","attemptId","executorId","operationId","credentialRefs","target","risk","externalEffect","estimatedDurationSeconds",
    ...(marker.operation.estimatedCostUsd === undefined ? [] : ["estimatedCostUsd"]),
    ...(marker.operation.payloadDigest === undefined ? [] : ["payloadDigest"])],"Pre-effect operation");
  if (marker.operation.payloadDigest !== undefined) digest(marker.operation.payloadDigest, "Payload digest");
  if (marker.schema !== "control-room.pre-effect-marker/v1") throw new Error("Pre-effect marker schema is invalid");
  safeToken(marker.markerId, "Marker ID");
  digest(marker.claimKey, "Claim key");
  digest(marker.requestDigest, "Request digest");
  digest(marker.operationDigest, "Operation digest");
  digest(marker.authorityDigest, "Authority digest");
  const markedAt = canonicalInstant(marker.markedAt, "Marker time");
  canonicalInstant(marker.effectiveDeadline, "Effective deadline");
  if (claim.state !== "claimed" || claim.markerDigest !== undefined) throw new Error("Only an unmarked claimed effect may receive a marker");
  if (Date.parse(markedAt) >= Date.parse(claim.effectiveDeadline)) throw new Error("Expired effect claim cannot execute");
  const identity: EffectIdentityV1 = {
    tenantId: marker.operation.tenantId,
    nodeId: marker.operation.nodeId,
    projectId: marker.operation.projectId,
    jobId: marker.operation.jobId,
    attemptId: marker.operation.attemptId,
    operationDigest: marker.operationDigest,
  };
  if (marker.claimKey !== claim.claimKey
    || marker.operation.externalEffect !== true
    || marker.operationDigest !== claim.identity.operationDigest
    || computePreEffectOperationDigest(marker.operation) !== marker.operationDigest
    || computeEffectClaimKey(identity) !== claim.claimKey
    || marker.authorityDigest !== claim.authorityDigest
    || marker.effectiveDeadline !== claim.effectiveDeadline) {
    throw new Error("Pre-effect marker binding mismatch");
  }
}

function transitioned(snapshot: EffectClaimSnapshotV1, event: EffectClaimEventV1, state: EffectClaimLifecycleStateV1, extra: Partial<EffectClaimSnapshotV1> = {}): EffectClaimSnapshotV1 {
  const occurredAt = canonicalInstant(event.occurredAt, "Effect event time");
  if (Date.parse(occurredAt) < Date.parse(snapshot.updatedAt)) throw new Error("Effect event time cannot move backwards");
  return { ...snapshot, ...extra, state, version: snapshot.version + 1, updatedAt: occurredAt };
}

export function applyEffectClaimEvent(snapshot: EffectClaimSnapshotV1, event: EffectClaimEventV1): EffectClaimSnapshotV1 {
  validateEffectClaimEvent(event);
  safeToken(event.eventId, "Event ID");
  if (["confirmed", "failed", "cancelled"].includes(snapshot.state)) throw new Error(`Terminal effect claim cannot transition from ${snapshot.state}`);
  switch (event.kind) {
    case "marker_committed":
      if (snapshot.state !== "claimed") throw new Error("Pre-effect marker requires claimed state");
      if (Date.parse(event.occurredAt) >= Date.parse(snapshot.effectiveDeadline)) throw new Error("Expired effect claim cannot execute");
      return transitioned(snapshot, event, "executing", { markerDigest: digest(event.markerDigest, "Marker digest") });
    case "ambiguity_raised":
      if (snapshot.state !== "executing") throw new Error("Only an executing effect can become ambiguous");
      return transitioned(snapshot, event, "ambiguous");
    case "confirmed":
      if (snapshot.state !== "executing" && snapshot.state !== "ambiguous") throw new Error("Effect confirmation requires executing or ambiguous state");
      return transitioned(snapshot, event, "confirmed", { destinationReceiptDigest: digest(event.destinationReceiptDigest, "Destination receipt digest") });
    case "failed":
      if (!/^[a-z0-9_]{1,64}$/.test(event.safeFailureCode)) throw new Error("Failure code must be a safe bounded token");
      if (snapshot.state === "claimed" && event.nonExecutionEvidenceDigest !== undefined) throw new Error("Pre-effect failure does not accept destination evidence");
      if ((snapshot.state === "executing" || snapshot.state === "ambiguous") && event.nonExecutionEvidenceDigest === undefined) {
        throw new Error("Potentially fired effect requires non-execution evidence");
      }
      if (!["claimed", "executing", "ambiguous"].includes(snapshot.state)) throw new Error("Effect failure is not allowed from this state");
      return transitioned(snapshot, event, "failed", {
        safeFailureCode: event.safeFailureCode,
        ...(event.nonExecutionEvidenceDigest === undefined ? {} : { nonExecutionEvidenceDigest: digest(event.nonExecutionEvidenceDigest, "Non-execution evidence digest") }),
      });
    case "cancelled":
      if (snapshot.state !== "claimed") throw new Error("Only a pre-effect claim can be cancelled safely");
      return transitioned(snapshot, event, "cancelled");
    default:
      throw new Error("Effect event kind is invalid");
  }
}

export function classifyEffectClaimRecovery(snapshot: EffectClaimSnapshotV1): EffectRecoveryActionV1 {
  if (snapshot.state === "claimed" && snapshot.markerDigest === undefined) return "re_evaluate_claimed";
  if (snapshot.state === "executing" || snapshot.markerDigest !== undefined && snapshot.state === "claimed") return "mark_ambiguous";
  if (snapshot.state === "ambiguous") return "await_evidence";
  return "replay_terminal";
}

export function effectClaimStateForPreEffect(snapshot: EffectClaimSnapshotV1 | undefined): EffectClaimStateV1 {
  if (!snapshot) return "missing";
  if (snapshot.state === "ambiguous") return "ambiguous";
  return snapshot.state === "executing" && snapshot.markerDigest !== undefined ? "claimed" : "missing";
}

export function terminalEffectResultDigest(snapshot: EffectClaimSnapshotV1): string {
  if (!["confirmed", "failed", "cancelled"].includes(snapshot.state)) throw new Error("Only settled terminal claims have result digests");
  return sha256Digest({
    state: snapshot.state,
    ...(snapshot.destinationReceiptDigest ? { destinationReceiptDigest: snapshot.destinationReceiptDigest } : {}),
    ...(snapshot.nonExecutionEvidenceDigest ? { nonExecutionEvidenceDigest: snapshot.nonExecutionEvidenceDigest } : {}),
    ...(snapshot.safeFailureCode ? { safeFailureCode: snapshot.safeFailureCode } : {}),
  });
}
