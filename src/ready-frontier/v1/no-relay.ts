import { hmacSha256Tag, sha256Digest } from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import type { ActionInboxItemV1 } from "../../operator-surfaces/v1/types";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import {
  readyFrontierActivationPacketSchemaV1,
  readyFrontierFakeDeliveryAcknowledgementSchemaV1,
  readyFrontierFakeDeliveryRequestSchemaV1,
  readyFrontierNoRelayProjectionSchemaV1,
  readyFrontierNoRelayRequestSchemaV1,
  readyFrontierNoRelayRunSchemaV1,
} from "./no-relay-schemas";
import {
  READY_FRONTIER_FAKE_DELIVERY_ACK_V1,
  READY_FRONTIER_NO_RELAY_PROJECTION_V1,
  READY_FRONTIER_NO_RELAY_RUN_V1,
  type ReadyFrontierActivationPacketV1,
  type ReadyFrontierFakeDeliveryAcknowledgementV1,
  type ReadyFrontierFakeDeliveryRequestV1,
  type ReadyFrontierNoRelayProjectionV1,
  type ReadyFrontierNoRelayRequestV1,
  type ReadyFrontierNoRelayRunV1,
} from "./no-relay-types";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
function key(value: unknown): Uint8Array {
  const parsed = exactHostUint8ArrayV1(value, 128);
  if (!parsed || parsed.byteLength < 32) fail("integrity_failed");
  return parsed.copy();
}
function before(left: string, right: string): boolean { return Date.parse(left) < Date.parse(right); }
function equal(left: string, right: string): boolean { return left.length === right.length && left === right; }

export const READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1 = Object.freeze([
  "ambiguity_reconciliation_unproved",
  "consumer_channel_unqualified",
  "credential_broker_unbound",
  "hosted_postgresql_unqualified",
  "multi_process_concurrency_unproved",
  "production_clock_custody_unproved",
  "production_independent_review_missing",
  "production_owner_approval_missing",
  "production_policy_custody_unproved",
] as const);

export function parseReadyFrontierNoRelayRequestV1(value: unknown): ReadyFrontierNoRelayRequestV1 {
  const request = parseExactReadyFrontierV1(readyFrontierNoRelayRequestSchemaV1, value) as ReadyFrontierNoRelayRequestV1;
  if (request.tenantId !== request.materializationRequest.tenantId
    || request.workspaceId !== request.materializationRequest.workspaceId
    || !before(request.promotionRequestedAt, request.reservationExpiresAt)
    || Date.parse(request.promotedAt) < Date.parse(request.promotionRequestedAt)
    || Date.parse(request.observedAt) < Date.parse(request.promotedAt)
    || !before(request.promotedAt, request.deliveryDeadline)
    || Date.parse(request.observedAt) > Date.parse(request.deliveryDeadline)
    || Date.parse(request.deliveryDeadline) > Date.parse(request.reservationExpiresAt)) fail("replay_drift");
  return request;
}

function acknowledgementUnsigned(value: ReadyFrontierFakeDeliveryAcknowledgementV1):
  Omit<ReadyFrontierFakeDeliveryAcknowledgementV1, "acknowledgementDigest"> {
  const { acknowledgementDigest: _digest, ...unsigned } = value; void _digest; return unsigned;
}

export function buildReadyFrontierFakeDeliveryAcknowledgementV1(value: Omit<ReadyFrontierFakeDeliveryAcknowledgementV1,
  "schema" | "acknowledgementDigest">): ReadyFrontierFakeDeliveryAcknowledgementV1 {
  const candidate = parseExactReadyFrontierV1(readyFrontierFakeDeliveryAcknowledgementSchemaV1
    .omit({ acknowledgementDigest: true }), { schema: READY_FRONTIER_FAKE_DELIVERY_ACK_V1, ...value });
  return parseExactReadyFrontierV1(readyFrontierFakeDeliveryAcknowledgementSchemaV1,
    { ...candidate, acknowledgementDigest: sha256Digest(candidate) }) as ReadyFrontierFakeDeliveryAcknowledgementV1;
}

export function parseReadyFrontierFakeDeliveryAcknowledgementV1(value: unknown): ReadyFrontierFakeDeliveryAcknowledgementV1 {
  const acknowledgement = parseExactReadyFrontierV1(readyFrontierFakeDeliveryAcknowledgementSchemaV1,
    value) as ReadyFrontierFakeDeliveryAcknowledgementV1;
  if (!equal(acknowledgement.acknowledgementDigest, sha256Digest(acknowledgementUnsigned(acknowledgement)))) {
    fail("digest_mismatch");
  }
  return acknowledgement;
}

type UnsignedRunV1 = Omit<ReadyFrontierNoRelayRunV1, "schema" | "runDigest" | "runAuthTag">;
function runUnsigned(value: ReadyFrontierNoRelayRunV1): Omit<ReadyFrontierNoRelayRunV1, "runDigest" | "runAuthTag"> {
  const { runDigest: _digest, runAuthTag: _tag, ...unsigned } = value; void _digest; void _tag; return unsigned;
}
function validateRunState(run: ReadyFrontierNoRelayRunV1): void {
  if (Date.parse(run.updatedAt) < Date.parse(run.startedAt)) fail("replay_drift");
  const startedBeforeDeadline = Date.parse(run.startedAt) < Date.parse(run.deliveryDeadline);
  if ((run.state === "expired_before_delivery" && startedBeforeDeadline)
    || (run.state !== "expired_before_delivery" && !startedBeforeDeadline)) fail("replay_drift");
  if (run.state === "acknowledged_repository_simulation") {
    if (run.safeReason !== "fake_handoff_acknowledged" || !run.acknowledgedAt || !run.acknowledgementDigest
      || run.updatedAt !== run.acknowledgedAt || Date.parse(run.acknowledgedAt) < Date.parse(run.startedAt)
      || Date.parse(run.acknowledgedAt) > Date.parse(run.deliveryDeadline)) fail("replay_drift");
  } else if (run.acknowledgedAt !== null || run.acknowledgementDigest !== null
    || (run.state === "terminal_ambiguous" && run.safeReason !== "delivery_outcome_ambiguous")
    || (run.state === "expired_before_delivery" && run.safeReason !== "delivery_window_expired")
    || (run.state === "delivery_started" && run.safeReason !== "delivery_outcome_ambiguous")) fail("replay_drift");
}

export function buildReadyFrontierNoRelayRunV1(value: UnsignedRunV1, integrityKeyValue: unknown): ReadyFrontierNoRelayRunV1 {
  const integrityKey = key(integrityKeyValue);
  try {
    const unsigned = parseExactReadyFrontierV1(readyFrontierNoRelayRunSchemaV1.omit({ runDigest: true, runAuthTag: true }),
      { schema: READY_FRONTIER_NO_RELAY_RUN_V1, ...value });
    const withDigest = { ...unsigned, runDigest: sha256Digest(unsigned) };
    const run = parseExactReadyFrontierV1(readyFrontierNoRelayRunSchemaV1, { ...withDigest,
      runAuthTag: hmacSha256Tag(integrityKey, { runId: withDigest.runId, state: withDigest.state,
        updatedAt: withDigest.updatedAt, runDigest: withDigest.runDigest }) }) as ReadyFrontierNoRelayRunV1;
    validateRunState(run); return run;
  } finally { integrityKey.fill(0); }
}

export function parseReadyFrontierNoRelayRunV1(value: unknown, integrityKeyValue: unknown): ReadyFrontierNoRelayRunV1 {
  const integrityKey = key(integrityKeyValue);
  try {
    const run = parseExactReadyFrontierV1(readyFrontierNoRelayRunSchemaV1, value) as ReadyFrontierNoRelayRunV1;
    if (!equal(run.runDigest, sha256Digest(runUnsigned(run))) || !equal(run.runAuthTag,
      hmacSha256Tag(integrityKey, { runId: run.runId, state: run.state, updatedAt: run.updatedAt,
        runDigest: run.runDigest }))) fail("digest_mismatch");
    validateRunState(run); return run;
  } finally { integrityKey.fill(0); }
}

export function validateReadyFrontierFakeDeliveryForRunV1(requestValue: unknown,
  acknowledgementValue: unknown): ReadyFrontierFakeDeliveryAcknowledgementV1 {
  const request = parseExactReadyFrontierV1(readyFrontierFakeDeliveryRequestSchemaV1,
    requestValue) as ReadyFrontierFakeDeliveryRequestV1;
  const acknowledgement = parseReadyFrontierFakeDeliveryAcknowledgementV1(acknowledgementValue);
  if (acknowledgement.runId !== request.runId || acknowledgement.deliveryId !== request.deliveryId
    || acknowledgement.jobId !== request.jobId || acknowledgement.routeId !== request.routeId
    || acknowledgement.handoffId !== request.handoffId
    || Date.parse(acknowledgement.acknowledgedAt) < Date.parse(request.deliveryStartedAt)
    || Date.parse(acknowledgement.acknowledgedAt) > Date.parse(request.deliveryDeadline)) fail("replay_drift");
  return acknowledgement;
}

export function projectReadyFrontierNoRelayV1(input: { tenantId: string; runs: ReadyFrontierNoRelayRunV1[] },
  integrityKeyValue: unknown): ReadyFrontierNoRelayProjectionV1 {
  const runs = input.runs.map((run) => parseReadyFrontierNoRelayRunV1(run, integrityKeyValue));
  if (runs.some((run) => run.tenantId !== input.tenantId || run.state === "delivery_started")) fail("integrity_failed");
  const views = [...runs].sort((a, b) => a.runId.localeCompare(b.runId)).map((run) => ({
    runId: run.runId, projectId: run.projectId, jobId: run.jobId, routeId: run.routeId,
    state: run.state as Exclude<typeof run.state, "delivery_started">, safeReason: run.safeReason,
    deliveryAttemptCount: 1 as const, updatedAt: run.updatedAt,
  }));
  const attention = views.filter((run) => run.state !== "acknowledged_repository_simulation").map((run) => ({
    runId: run.runId, projectId: run.projectId, state: "needs_review" as const,
    safeReason: run.safeReason as "delivery_outcome_ambiguous" | "delivery_window_expired",
  }));
  const unsigned = {
    schema: READY_FRONTIER_NO_RELAY_PROJECTION_V1, tenantId: input.tenantId,
    simulationState: !views.length ? "not_run" as const : attention.length ? "needs_review" as const : "acknowledged" as const,
    runs: views, attention,
    activationState: !views.some((run) => run.state === "acknowledged_repository_simulation")
      ? "blocked_no_simulation_evidence" as const : "blocked_pending_production_proof" as const,
    repositorySimulationOnly: true as const, canActivateProduction: false as const, canDeliver: false as const,
    canClaimOrLease: false as const, canDispatchOrExecute: false as const,
  };
  return parseExactReadyFrontierV1(readyFrontierNoRelayProjectionSchemaV1,
    { ...unsigned, projectionDigest: sha256Digest(unsigned) }) as ReadyFrontierNoRelayProjectionV1;
}

function packetUnsigned(packet: ReadyFrontierActivationPacketV1): Omit<ReadyFrontierActivationPacketV1,
  "packetDigest" | "packetAuthTag"> {
  const { packetDigest: _digest, packetAuthTag: _tag, ...unsigned } = packet; void _digest; void _tag; return unsigned;
}

function projectionUnsigned(projection: ReadyFrontierNoRelayProjectionV1):
  Omit<ReadyFrontierNoRelayProjectionV1, "projectionDigest"> {
  const { projectionDigest: _digest, ...unsigned } = projection; void _digest; return unsigned;
}

export function parseReadyFrontierNoRelayProjectionV1(value: unknown): ReadyFrontierNoRelayProjectionV1 {
  const projection = parseExactReadyFrontierV1(readyFrontierNoRelayProjectionSchemaV1,
    value) as ReadyFrontierNoRelayProjectionV1;
  if (!equal(projection.projectionDigest, sha256Digest(projectionUnsigned(projection)))) fail("digest_mismatch");
  const runIds = projection.runs.map((run) => run.runId);
  if (new Set(runIds).size !== runIds.length || runIds.join("\0") !== [...runIds].sort().join("\0")) fail("replay_drift");
  const expectedAttention = projection.runs.filter((run) => run.state !== "acknowledged_repository_simulation")
    .map((run) => ({ runId: run.runId, projectId: run.projectId, state: "needs_review" as const,
      safeReason: run.safeReason as "delivery_outcome_ambiguous" | "delivery_window_expired" }));
  const expectedSimulation = !projection.runs.length ? "not_run"
    : expectedAttention.length ? "needs_review" : "acknowledged";
  const expectedActivation = projection.runs.some((run) => run.state === "acknowledged_repository_simulation")
    ? "blocked_pending_production_proof" : "blocked_no_simulation_evidence";
  if (JSON.stringify(projection.attention) !== JSON.stringify(expectedAttention)
    || projection.simulationState !== expectedSimulation || projection.activationState !== expectedActivation) fail("replay_drift");
  return projection;
}

/** Converts only safe terminal review truth into read-only Action Inbox facts; it creates no response operation. */
export function projectReadyFrontierNoRelayAttentionV1(value: unknown): ActionInboxItemV1[] {
  const projection = parseReadyFrontierNoRelayProjectionV1(value);
  return projection.attention.map((attention) => {
    const run = projection.runs.find((candidate) => candidate.runId === attention.runId);
    if (!run) fail("integrity_failed");
    const identity = sha256Digest({ tenantId: projection.tenantId, runId: run.runId, runDigest: projection.projectionDigest });
    return {
      id: `attention.frontier.no-relay:${identity.slice(7, 31)}`, tenantId: projection.tenantId,
      projectId: run.projectId, workItemId: run.jobId,
      kind: run.state === "terminal_ambiguous" ? "ambiguity" : "authority_expiry", state: "open",
      requestedAction: run.state === "terminal_ambiguous"
        ? "Review ambiguous repository fake delivery" : "Review expired repository fake delivery window",
      reasonCode: attention.safeReason, blockedWorkItemIds: [run.jobId], legalResponses: [{
        id: `response.frontier.no-relay:${identity.slice(7, 31)}`, kind: "request_review",
        label: "Request bounded reconciliation review", requiresConfirmation: true,
        available: false, unavailableReasonCode: "repository_simulation_only",
      }], evidence: [{ id: `evidence.frontier.no-relay:${identity.slice(7, 31)}`, kind: "audit",
        digest: projection.projectionDigest, observedAt: run.updatedAt }], createdAt: run.updatedAt,
      deliveryState: run.state === "terminal_ambiguous" ? "failed" : "not_requested",
    };
  });
}

export function parseReadyFrontierActivationPacketV1(value: unknown,
  packetIntegrityKeyValue: unknown): ReadyFrontierActivationPacketV1 {
  const packetKey = key(packetIntegrityKeyValue);
  try {
    const packet = parseExactReadyFrontierV1(readyFrontierActivationPacketSchemaV1,
      value) as ReadyFrontierActivationPacketV1;
    if (packet.requiredProductionGateCodes.join("|") !== READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1.join("|")
      || !equal(packet.packetDigest, sha256Digest(packetUnsigned(packet)))
      || !equal(packet.packetAuthTag, hmacSha256Tag(packetKey, { packetId: packet.packetId,
        simulationRunDigest: packet.simulationRunDigest, packetDigest: packet.packetDigest }))) fail("digest_mismatch");
    return packet;
  } finally { packetKey.fill(0); }
}
