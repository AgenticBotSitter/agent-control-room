import type { ReadyFrontierMaterializationRequestV1 } from "./automation-types";

export const READY_FRONTIER_NO_RELAY_REQUEST_V1 = "control-room-ready-frontier-no-relay-request/v1" as const;
export const READY_FRONTIER_FAKE_DELIVERY_REQUEST_V1 = "control-room-ready-frontier-fake-delivery-request/v1" as const;
export const READY_FRONTIER_FAKE_DELIVERY_ACK_V1 = "control-room-ready-frontier-fake-delivery-ack/v1" as const;
export const READY_FRONTIER_NO_RELAY_RUN_V1 = "control-room-ready-frontier-no-relay-run/v1" as const;
export const READY_FRONTIER_NO_RELAY_PROJECTION_V1 = "control-room-ready-frontier-no-relay-projection/v1" as const;
export const READY_FRONTIER_ACTIVATION_PACKET_V1 = "control-room-ready-frontier-activation-packet/v1" as const;

export type ReadyFrontierNoRelayRunStateV1 = "delivery_started" | "acknowledged_repository_simulation"
  | "terminal_ambiguous" | "expired_before_delivery";

export interface ReadyFrontierNoRelayRequestV1 {
  schema: typeof READY_FRONTIER_NO_RELAY_REQUEST_V1;
  runId: string;
  tenantId: string;
  workspaceId: string;
  materializationRequest: ReadyFrontierMaterializationRequestV1;
  readyPolicyId: string;
  readyPolicyRevision: number;
  readyPolicyDigest: string;
  promotionRequestId: string;
  promotionRequestedAt: string;
  promotedAt: string;
  reservationExpiresAt: string;
  deliveryDeadline: string;
  observedAt: string;
  trigger: "repository_no_relay_simulation";
  deliveryTransport: "injected_fake";
  maximumDeliveryAttempts: 1;
  repositorySimulationOnly: true;
  permitsProductionPolicyEnrollment: false;
  permitsApproval: false;
  permitsScheduleCreation: false;
  permitsClaimOrLease: false;
  permitsDispatchOrExecution: false;
  permitsProviderContact: false;
  permitsAgentMessage: false;
  permitsGitHubMutation: false;
  permitsExternalEffects: false;
}

export interface ReadyFrontierFakeDeliveryRequestV1 {
  schema: typeof READY_FRONTIER_FAKE_DELIVERY_REQUEST_V1;
  runId: string;
  deliveryId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  jobId: string;
  routeId: string;
  handoffId: string;
  handoffPacketDigest: string;
  promotionReceiptDigest: string;
  deliveryStartedAt: string;
  deliveryDeadline: string;
  transport: "injected_fake";
  repositorySimulationOnly: true;
  createsAttempt: false;
  createsLease: false;
  claimsJob: false;
  dispatchesOrExecutes: false;
  contactsProvider: false;
  messagesAgent: false;
  mutatesGitHub: false;
  grantsExternalEffect: false;
}

export interface ReadyFrontierFakeDeliveryAcknowledgementV1 {
  schema: typeof READY_FRONTIER_FAKE_DELIVERY_ACK_V1;
  runId: string;
  deliveryId: string;
  jobId: string;
  routeId: string;
  handoffId: string;
  acknowledgedAt: string;
  state: "acknowledged_repository_simulation";
  repositorySimulationOnly: true;
  createsAttempt: false;
  createsLease: false;
  claimsJob: false;
  dispatchesOrExecutes: false;
  contactsProvider: false;
  messagesAgent: false;
  mutatesGitHub: false;
  grantsExternalEffect: false;
  acknowledgementDigest: string;
}

export interface ReadyFrontierNoRelayRunV1 {
  schema: typeof READY_FRONTIER_NO_RELAY_RUN_V1;
  runId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  requestDigest: string;
  materializationReceiptDigest: string;
  promotionReceiptDigest: string;
  jobId: string;
  routeId: string;
  handoffId: string;
  handoffPacketDigest: string;
  deliveryId: string;
  deliveryDeadline: string;
  deliveryAttemptCount: 1;
  state: ReadyFrontierNoRelayRunStateV1;
  safeReason: "fake_handoff_acknowledged" | "delivery_outcome_ambiguous" | "delivery_window_expired";
  startedAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  acknowledgementDigest: string | null;
  repositorySimulationOnly: true;
  createsAttempt: false;
  createsLease: false;
  claimsJob: false;
  dispatchesOrExecutes: false;
  contactsProvider: false;
  messagesAgent: false;
  mutatesGitHub: false;
  grantsExternalEffect: false;
  runDigest: string;
  runAuthTag: string;
}

export interface ReadyFrontierNoRelayRunViewV1 {
  runId: string;
  projectId: string;
  jobId: string;
  routeId: string;
  state: Exclude<ReadyFrontierNoRelayRunStateV1, "delivery_started">;
  safeReason: ReadyFrontierNoRelayRunV1["safeReason"];
  deliveryAttemptCount: 1;
  updatedAt: string;
}

export interface ReadyFrontierNoRelayAttentionV1 {
  runId: string;
  projectId: string;
  state: "needs_review";
  safeReason: "delivery_outcome_ambiguous" | "delivery_window_expired";
}

export interface ReadyFrontierNoRelayProjectionV1 {
  schema: typeof READY_FRONTIER_NO_RELAY_PROJECTION_V1;
  tenantId: string;
  simulationState: "not_run" | "acknowledged" | "needs_review";
  runs: ReadyFrontierNoRelayRunViewV1[];
  attention: ReadyFrontierNoRelayAttentionV1[];
  activationState: "blocked_no_simulation_evidence" | "blocked_pending_production_proof";
  repositorySimulationOnly: true;
  canActivateProduction: false;
  canDeliver: false;
  canClaimOrLease: false;
  canDispatchOrExecute: false;
  projectionDigest: string;
}

export interface ReadyFrontierActivationPacketV1 {
  schema: typeof READY_FRONTIER_ACTIVATION_PACKET_V1;
  packetId: string;
  tenantId: string;
  workspaceId: string;
  simulationRunId: string;
  simulationRunDigest: string;
  acceptedAuto030Commit: "adf0804a52a13d544192afc90506c3e989254ffd";
  acceptedAuto030ReviewSha256: "sha256:18df9e9611c5f9053962b776b8261304512b98244ba7b627fd99f4821a79fa2";
  requiredProductionGateCodes: string[];
  state: "blocked_pending_production_proof";
  createdAt: string;
  repositorySimulationOnly: true;
  productionOwnerApprovalPresent: false;
  productionPolicyEnrolled: false;
  productionConsumerQualified: false;
  productionDatabaseQualified: false;
  canActivateItself: false;
  permitsProtectedMaterial: false;
  permitsNetwork: false;
  permitsGitHubMutation: false;
  permitsAgentOrProviderContact: false;
  permitsDispatchOrExecution: false;
  permitsExternalEffects: false;
  packetDigest: string;
  packetAuthTag: string;
}

export interface ReadyFrontierFakeDeliveryPortV1 {
  deliver(request: ReadyFrontierFakeDeliveryRequestV1): Promise<unknown>;
}

export interface ReadyFrontierNoRelayResultV1 {
  run: ReadyFrontierNoRelayRunV1;
  materializationReplayed: boolean;
  promotionReplayed: boolean;
  runReplayed: boolean;
}
