import { buildReadyFrontierMaterializationRequestFixtureV1 } from "./automation-fixture";
import { projectReadyFrontierNoRelayV1 } from "./no-relay";
import { READY_FRONTIER_NO_RELAY_REQUEST_V1, type ReadyFrontierNoRelayProjectionV1,
  type ReadyFrontierNoRelayRequestV1 } from "./no-relay-types";
import type { ReadyFrontierReadyPolicyV1 } from "./ready-policy-types";
import type { ReadyFrontierStandingPolicyV1 } from "./automation-types";
import type { ReadyFrontierEvaluationV1 } from "./types";

const runKey = () => new Uint8Array(32).fill(0x64);
const packetKey = () => new Uint8Array(32).fill(0x65);
export function readyFrontierRepositoryFixtureNoRelayKeyV1(): Uint8Array { return runKey(); }
export function readyFrontierRepositoryFixtureActivationPacketKeyV1(): Uint8Array { return packetKey(); }

export function buildReadyFrontierNoRelayRequestFixtureV1(evaluation: ReadyFrontierEvaluationV1,
  standingPolicy: ReadyFrontierStandingPolicyV1, readyPolicy: ReadyFrontierReadyPolicyV1,
  proposalIndex = 0, input: Partial<Pick<ReadyFrontierNoRelayRequestV1, "runId" | "observedAt"
    | "deliveryDeadline">> = {}): ReadyFrontierNoRelayRequestV1 {
  return {
    schema: READY_FRONTIER_NO_RELAY_REQUEST_V1, runId: input.runId ?? `frontier.no-relay-run.${proposalIndex + 1}`,
    tenantId: evaluation.tenantId, workspaceId: standingPolicy.workspaceId,
    materializationRequest: buildReadyFrontierMaterializationRequestFixtureV1(evaluation, standingPolicy, proposalIndex),
    readyPolicyId: readyPolicy.policyId, readyPolicyRevision: readyPolicy.revision,
    readyPolicyDigest: readyPolicy.policyDigest, promotionRequestId: `frontier.no-relay-promotion.${proposalIndex + 1}`,
    promotionRequestedAt: "2026-08-30T18:03:30.000Z", promotedAt: "2026-08-30T18:04:00.000Z",
    reservationExpiresAt: "2026-08-30T18:09:00.000Z",
    deliveryDeadline: input.deliveryDeadline ?? "2026-08-30T18:08:00.000Z",
    observedAt: input.observedAt ?? "2026-08-30T18:04:05.000Z",
    trigger: "repository_no_relay_simulation", deliveryTransport: "injected_fake", maximumDeliveryAttempts: 1,
    repositorySimulationOnly: true, permitsProductionPolicyEnrollment: false, permitsApproval: false,
    permitsScheduleCreation: false, permitsClaimOrLease: false, permitsDispatchOrExecution: false,
    permitsProviderContact: false, permitsAgentMessage: false, permitsGitHubMutation: false,
    permitsExternalEffects: false,
  };
}

/** Honest server fixture: AUTO-040 exists as a blocked repository simulation and has not claimed a run. */
export function buildReadyFrontierNoRelayProjectionFixtureV1(): ReadyFrontierNoRelayProjectionV1 {
  const key = runKey();
  try { return projectReadyFrontierNoRelayV1({ tenantId: "tenant.owner", runs: [] }, key); }
  finally { key.fill(0); }
}
