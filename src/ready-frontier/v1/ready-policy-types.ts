import type { JobRecord } from "../../domain/v1";
import type { ReadyFrontierMaterializationReceiptV1 } from "./automation-types";
import type { ReadyFrontierPlatformV1, ReadyFrontierRiskClassV1 } from "./types";

export const READY_FRONTIER_READY_POLICY_V1 = "control-room-ready-frontier-ready-policy/v1" as const;
export const READY_FRONTIER_PROMOTION_REQUEST_V1 = "control-room-ready-frontier-promotion-request/v1" as const;
export const READY_FRONTIER_HANDOFF_PACKET_V1 = "control-room-ready-frontier-handoff-packet/v1" as const;
export const READY_FRONTIER_PROMOTION_RECEIPT_V1 = "control-room-ready-frontier-promotion-receipt/v1" as const;
export const READY_FRONTIER_PROMOTION_PROJECTION_V1 = "control-room-ready-frontier-promotion-projection/v1" as const;

export type ReadyFrontierReadyPolicyActionV1 = "enroll" | "revise" | "suspend" | "revoke";
export type ReadyFrontierReadyPolicyStateV1 = "active" | "suspended" | "revoked";

export interface ReadyFrontierReadyProjectPolicyV1 {
  projectId: string;
  enabled: boolean;
  allowedRouteIds: string[];
  allowedPlatforms: ReadyFrontierPlatformV1[];
  allowedCapabilities: string[];
  maximumRisk: ReadyFrontierRiskClassV1;
  maximumCostMicrousdPerWork: number;
  maximumActiveReady: number;
  resourceKey: string;
  reservationUnits: number;
  resourceCapacityUnits: number;
  reservationTtlSeconds: number;
}

export interface ReadyFrontierReadyPolicyV1 {
  schema: typeof READY_FRONTIER_READY_POLICY_V1;
  tenantId: string;
  workspaceId: string;
  policyId: string;
  revision: number;
  previousPolicyDigest: string | null;
  action: ReadyFrontierReadyPolicyActionV1;
  state: ReadyFrontierReadyPolicyStateV1;
  parentStandingPolicyId: string;
  parentStandingPolicyRevision: number;
  parentStandingPolicyDigest: string;
  separateReadyReviewDigest: string;
  activationScope: "repository_simulation";
  ownerActorDigest: string;
  ownerAuthenticationEvidenceDigest: string;
  evidenceSource: "repository_fixture";
  repositoryReviewFixtureAccepted: true;
  productionOwnerAuthenticationVerified: false;
  productionIndependentReviewVerified: false;
  recordedAt: string;
  effectiveAt: string;
  expiresAt: string;
  maximumMaterializationAgeSeconds: number;
  maximumActiveReadyGlobal: number;
  projectPolicies: ReadyFrontierReadyProjectPolicyV1[];
  permitsAutomaticReadyTransition: true;
  permitsDatabaseSchedulerReservation: true;
  permitsInternalJobberHandoff: true;
  handoffTransport: "canonical_internal_table";
  permitsAutomaticApproval: false;
  permitsScheduleCreation: false;
  permitsClaimOrLease: false;
  permitsDispatchOrExecution: false;
  permitsProviderContact: false;
  permitsAgentMessage: false;
  permitsGitHubMutation: false;
  permitsExternalEffects: false;
  policyCeilingDigest: string;
  policyDigest: string;
  policyAuthTag: string;
}

export type ReadyFrontierUnsignedReadyPolicyV1 = Omit<ReadyFrontierReadyPolicyV1,
  "policyCeilingDigest" | "policyDigest" | "policyAuthTag">;

export interface ReadyFrontierPromotionRequestV1 {
  schema: typeof READY_FRONTIER_PROMOTION_REQUEST_V1;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  materializationReceiptId: string;
  materializationReceiptDigest: string;
  jobId: string;
  standingPolicyId: string;
  standingPolicyRevision: number;
  standingPolicyDigest: string;
  readyPolicyId: string;
  readyPolicyRevision: number;
  readyPolicyDigest: string;
  requestedAt: string;
  promotedAt: string;
  reservationExpiresAt: string;
  trigger: "standing_ready_policy_repository_simulation";
  repositorySimulationOnly: true;
  createsApproval: false;
  createsSchedule: false;
  permitsReadyTransition: true;
  permitsDatabaseSchedulerReservation: true;
  permitsInternalJobberHandoff: true;
  permitsClaimOrLease: false;
  permitsDispatchOrExecution: false;
  permitsProviderContact: false;
  permitsAgentMessage: false;
  permitsGitHubMutation: false;
  permitsExternalEffects: false;
}

export interface ReadyFrontierSchedulerDecisionV1 {
  selectedProjectId: string;
  selectedJobId: string;
  selectedRouteId: string;
  resourceKey: string;
  reservationUnits: number;
  resourceCapacityUnits: number;
  score: number;
  reasonCodes: ["hard_gates_passed", "deterministic_allocation_selected", "database_capacity_reserved"];
  decisionDigest: string;
}

export interface ReadyFrontierReservationV1 {
  reservationId: string;
  tenantId: string;
  projectId: string;
  jobId: string;
  routeId: string;
  resourceKey: string;
  units: number;
  capacityUnits: number;
  decisionDigest: string;
  state: "active";
  acquiredAt: string;
  expiresAt: string;
}

export interface ReadyFrontierHandoffPacketV1 {
  schema: typeof READY_FRONTIER_HANDOFF_PACKET_V1;
  handoffId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  jobId: string;
  routeId: string;
  requiredCapability: string;
  materializationReceiptDigest: string;
  evaluationDigest: string;
  sourceDigest: string;
  proposalDigest: string;
  standingPolicyDigest: string;
  readyPolicyDigest: string;
  schedulerDecisionDigest: string;
  reservationId: string;
  createdAt: string;
  expiresAt: string;
  destination: "internal_scheduler_jobber_table";
  state: "pending_internal_handoff";
  repositorySimulationOnly: true;
  permitsClaimOrLease: false;
  permitsDispatchOrExecution: false;
  permitsProviderContact: false;
  permitsAgentMessage: false;
  permitsGitHubMutation: false;
  permitsExternalEffects: false;
  packetDigest: string;
  packetAuthTag: string;
}

export interface ReadyFrontierPromotionReceiptV1 {
  schema: typeof READY_FRONTIER_PROMOTION_RECEIPT_V1;
  receiptId: string;
  requestId: string;
  promotionRequestDigest: string;
  tenantId: string;
  workspaceId: string;
  materializationReceiptId: string;
  materializationReceiptDigest: string;
  cycleId: string;
  proposalId: string;
  proposalDigest: string;
  evaluationDigest: string;
  sourceDigest: string;
  standingPolicyId: string;
  standingPolicyRevision: number;
  standingPolicyDigest: string;
  readyPolicyId: string;
  readyPolicyRevision: number;
  readyPolicyDigest: string;
  proposedJobDigest: string;
  readyJob: JobRecord;
  schedulerDecision: ReadyFrontierSchedulerDecisionV1;
  reservation: ReadyFrontierReservationV1;
  handoff: ReadyFrontierHandoffPacketV1;
  promotedAt: string;
  state: "ready_handoff_pending";
  repositorySimulationOnly: true;
  createsAttempt: false;
  createsLease: false;
  createsApproval: false;
  createsSchedule: false;
  dispatchState: "not_requested";
  contactsProvider: false;
  messagesAgent: false;
  mutatesGitHub: false;
  grantsExternalEffect: false;
  receiptDigest: string;
  receiptAuthTag: string;
}

export interface ReadyFrontierPromotionBuildInputV1 {
  request: ReadyFrontierPromotionRequestV1;
  materializationReceipt: ReadyFrontierMaterializationReceiptV1;
}

export interface ReadyFrontierPromotionProjectionV1 {
  schema: typeof READY_FRONTIER_PROMOTION_PROJECTION_V1;
  tenantId: string;
  readyPolicyState: "repository_fixture_active" | "missing" | "suspended" | "revoked" | "expired";
  productionReadyPolicyState: "not_enrolled";
  readyPromotionState: "not_requested" | "historical_ready_handoff_recorded";
  readyJobCount: number;
  pendingInternalHandoffCount: number;
  historicalPromotionCount: number;
  repositorySimulationOnly: true;
  viewCanPromote: false;
  viewCanSchedule: false;
  viewCanClaimOrLease: false;
  viewCanDispatchOrExecute: false;
  projectionDigest: string;
}
