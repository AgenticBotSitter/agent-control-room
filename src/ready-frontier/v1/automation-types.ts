import type { JobRecord, RequestRecord, WorkflowRecord } from "../../domain/v1";
import type { ActionInboxItemV1 } from "../../operator-surfaces/v1";
import type { ReadyFrontierPlatformV1, ReadyFrontierRiskClassV1 } from "./types";

export const READY_FRONTIER_STANDING_POLICY_V1 = "control-room-ready-frontier-standing-policy/v1" as const;
export const READY_FRONTIER_MATERIALIZATION_REQUEST_V1 = "control-room-ready-frontier-materialization-request/v1" as const;
export const READY_FRONTIER_MATERIALIZATION_RECEIPT_V1 = "control-room-ready-frontier-materialization-receipt/v1" as const;
export const READY_FRONTIER_AUTOMATION_PROJECTION_V1 = "control-room-ready-frontier-automation-projection/v1" as const;

export type ReadyFrontierStandingPolicyActionV1 = "enroll" | "revise" | "suspend" | "revoke";
export type ReadyFrontierStandingPolicyStateV1 = "active" | "suspended" | "revoked";

export interface ReadyFrontierStandingProjectPolicyV1 {
  projectId: string;
  enabled: boolean;
  allowedRouteIds: string[];
  allowedPlatforms: ReadyFrontierPlatformV1[];
  allowedCapabilities: string[];
  maximumRisk: ReadyFrontierRiskClassV1;
  maximumCostMicrousdPerWork: number;
}

export interface ReadyFrontierStandingPolicyV1 {
  schema: typeof READY_FRONTIER_STANDING_POLICY_V1;
  tenantId: string;
  workspaceId: string;
  policyId: string;
  revision: number;
  previousPolicyDigest: string | null;
  action: ReadyFrontierStandingPolicyActionV1;
  state: ReadyFrontierStandingPolicyStateV1;
  activationScope: "repository_simulation";
  ownerActorDigest: string;
  ownerAuthenticationEvidenceDigest: string;
  evidenceSource: "repository_fixture";
  productionOwnerAuthenticationVerified: false;
  recordedAt: string;
  effectiveAt: string;
  expiresAt: string;
  maximumProposalAgeSeconds: number;
  projectPolicies: ReadyFrontierStandingProjectPolicyV1[];
  permitsRepositorySimulationMaterialization: true;
  materializesProposedWorkOnly: true;
  requiresSeparateReadyReview: true;
  permitsAutomaticApproval: false;
  permitsReadyTransition: false;
  permitsScheduling: false;
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

export type ReadyFrontierUnsignedStandingPolicyV1 = Omit<ReadyFrontierStandingPolicyV1,
  "policyCeilingDigest" | "policyDigest" | "policyAuthTag">;

export interface ReadyFrontierMaterializationRequestV1 {
  schema: typeof READY_FRONTIER_MATERIALIZATION_REQUEST_V1;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  cycleId: string;
  proposalId: string;
  proposalDigest: string;
  evaluationDigest: string;
  sourceDigest: string;
  frontierPolicyDigest: string;
  standingPolicyId: string;
  standingPolicyRevision: number;
  standingPolicyDigest: string;
  requestedAt: string;
  materializedAt: string;
  authorityExpiresAt: string;
  trigger: "standing_policy_repository_simulation";
  scheduleId: null;
  repositorySimulationOnly: true;
  permitsApproval: false;
  permitsReadyTransition: false;
  permitsScheduling: false;
  permitsClaimOrLease: false;
  permitsDispatchOrExecution: false;
  permitsProviderContact: false;
  permitsAgentMessage: false;
  permitsGitHubMutation: false;
  permitsExternalEffects: false;
}

export interface ReadyFrontierMaterializationReceiptV1 {
  schema: typeof READY_FRONTIER_MATERIALIZATION_RECEIPT_V1;
  receiptId: string;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  cycleId: string;
  proposalId: string;
  proposalDigest: string;
  intentDigest: string;
  evaluationDigest: string;
  sourceDigest: string;
  frontierPolicyDigest: string;
  standingPolicyId: string;
  standingPolicyRevision: number;
  standingPolicyDigest: string;
  request: RequestRecord;
  workflow: WorkflowRecord;
  job: JobRecord;
  actionInbox: ActionInboxItemV1;
  materializedAt: string;
  state: "materialized_proposed";
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

export interface ReadyFrontierAutomationProposalViewV1 {
  proposalId: string;
  title: string;
  policyDisposition: "eligible_repository_simulation" | "policy_missing" | "policy_inactive" | "policy_denied";
  materializationState: "not_requested" | "materialized_proposed";
  materializedJobId?: string;
}

export interface ReadyFrontierAutomationProjectViewV1 {
  projectId: string;
  proposals: ReadyFrontierAutomationProposalViewV1[];
}

export interface ReadyFrontierAutomationProjectionV1 {
  schema: typeof READY_FRONTIER_AUTOMATION_PROJECTION_V1;
  tenantId: string;
  standingPolicyState: "repository_fixture_active" | "missing" | "suspended" | "revoked" | "expired";
  productionPolicyState: "not_enrolled";
  projects: ReadyFrontierAutomationProjectViewV1[];
  repositorySimulationOnly: true;
  canEnrollProductionPolicy: false;
  canMaterializeFromView: false;
  canApprove: false;
  canReady: false;
  canSchedule: false;
  canClaimOrLease: false;
  canDispatchOrExecute: false;
  projectionDigest: string;
}
