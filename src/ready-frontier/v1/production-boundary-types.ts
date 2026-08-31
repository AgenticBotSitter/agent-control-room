import type { ReadyFrontierActivationPacketV1 } from "./no-relay-types";
import { READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1 } from "./no-relay";

export const READY_FRONTIER_PRODUCTION_BOUNDARY_PLAN_V1 =
  "control-room-ready-frontier-production-boundary-plan/v1" as const;
export const READY_FRONTIER_PRODUCTION_GATE_REQUIREMENT_V1 =
  "control-room-ready-frontier-production-gate-requirement/v1" as const;
export const READY_FRONTIER_PRODUCTION_BOUNDARY_ASSESSMENT_V1 =
  "control-room-ready-frontier-production-boundary-assessment/v1" as const;
export const READY_FRONTIER_PRODUCTION_DISABLED_DISPOSITION_V1 =
  "control-room-ready-frontier-production-disabled-disposition/v1" as const;
export const READY_FRONTIER_PRODUCTION_RECONCILIATION_DECISION_V1 =
  "control-room-ready-frontier-production-reconciliation-decision/v1" as const;
export const READY_FRONTIER_PRODUCTION_BOUNDARY_PROJECTION_V1 =
  "control-room-ready-frontier-production-boundary-projection/v1" as const;

export const READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1 =
  "fb549ebbcf5a2cbd9ca3d3cbef6842578e280074" as const;
export const READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1 =
  "sha256:bc1b02f52b68ad9ce836253eb890c4df561513eed158b8a7875de4c7200cde07" as const;
export const READY_FRONTIER_PRODUCTION_PLAN_MAX_LIFETIME_SECONDS_V1 = 3_600 as const;

export type ReadyFrontierProductionGateCodeV1 =
  (typeof READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)[number];

export const readyFrontierProductionEvidenceClassesV1 = [
  "destination_reconciliation_attestation",
  "consumer_channel_qualification",
  "credential_broker_custody_attestation",
  "hosted_postgresql_qualification",
  "multi_process_concurrency_qualification",
  "production_clock_custody_attestation",
  "production_independent_review",
  "production_owner_approval_attestation",
  "production_policy_custody_attestation",
] as const;
export type ReadyFrontierProductionEvidenceClassV1 =
  (typeof readyFrontierProductionEvidenceClassesV1)[number];

export const readyFrontierProductionProofAuthoritiesV1 = [
  "destination_reconciler",
  "consumer_qualifier",
  "credential_broker_custodian",
  "database_qualifier",
  "concurrency_qualifier",
  "clock_custodian",
  "independent_reviewer",
  "owner_approval_authority",
  "owner_policy_custodian",
] as const;
export type ReadyFrontierProductionProofAuthorityV1 =
  (typeof readyFrontierProductionProofAuthoritiesV1)[number];

export interface ReadyFrontierProductionGateRequirementV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_GATE_REQUIREMENT_V1;
  gateCode: ReadyFrontierProductionGateCodeV1;
  evidenceClass: ReadyFrontierProductionEvidenceClassV1;
  proofAuthority: ReadyFrontierProductionProofAuthorityV1;
  requiredBindings: string[];
  freshnessRequired: boolean;
  independentVerifierRequired: boolean;
  status: "unobserved";
  evidenceDigest: null;
  validUntil: null;
  repositoryCanSatisfy: false;
  grantsApproval: false;
  grantsActivationAuthority: false;
  grantsDispatchOrExecution: false;
  grantsExternalEffects: false;
  requirementDigest: string;
}

export interface ReadyFrontierProductionBoundaryPlanV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_BOUNDARY_PLAN_V1;
  planId: string;
  tenantId: string;
  workspaceId: string;
  activationPacketId: string;
  activationPacketDigest: string;
  simulationRunId: string;
  simulationRunDigest: string;
  acceptedAuto040Commit: typeof READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1;
  acceptedAuto040ReviewSha256: typeof READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1;
  requiredProductionGateCodes: ReadyFrontierProductionGateCodeV1[];
  consumerProcessModel: "separate_service_principal";
  consumerChannelProtocol: "mutual_ed25519_authenticated_handoff_v1";
  handoffClaimMode: "transactional_single_owner_claim";
  databaseMode: "hosted_postgresql_required_unconfigured";
  brokerMode: "node_local_reference_only";
  clockMode: "protected_monotonic_and_database_boundary_required";
  policyCustodyMode: "owner_signed_external_high_water_required";
  ambiguityMode: "destination_evidence_or_new_owner_action";
  postMarkerUnknownState: "terminal_ambiguity";
  automaticRetryAfterMarker: false;
  defaultDisabled: true;
  repositoryDesignOnly: true;
  productionConfigurationPresent: false;
  protectedMaterialPresent: false;
  consumerImplemented: false;
  policyEnrolled: false;
  activationAuthorized: false;
  permitsProtectedReferenceResolution: false;
  permitsNetwork: false;
  permitsGitHubMutation: false;
  permitsAgentOrProviderContact: false;
  permitsClaimOrLease: false;
  permitsDispatchOrExecution: false;
  permitsExternalEffects: false;
  plannedAt: string;
  expiresAt: string;
  planDigest: string;
}

export interface ReadyFrontierProductionBoundaryAssessmentV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_BOUNDARY_ASSESSMENT_V1;
  assessmentId: string;
  planId: string;
  planDigest: string;
  tenantId: string;
  workspaceId: string;
  activationPacketDigest: string;
  requirements: ReadyFrontierProductionGateRequirementV1[];
  blockingGateCodes: ReadyFrontierProductionGateCodeV1[];
  remainingProofCount: 9;
  state: "blocked_design_only";
  safeReason: "production_evidence_unobserved";
  eligibleForOwnerApproval: false;
  eligibleForActivation: false;
  requiresNewProductionEvidenceAssessment: true;
  requiresFreshStrongOwnerApproval: true;
  requiresIndependentSecurityReview: true;
  assessedAt: string;
  activationAuthorized: false;
  grantsApproval: false;
  grantsActivationAuthority: false;
  grantsClaimOrLease: false;
  grantsDispatchOrExecution: false;
  grantsExternalEffects: false;
  assessmentDigest: string;
}

export interface ReadyFrontierProductionDisabledDispositionV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_DISABLED_DISPOSITION_V1;
  dispositionId: string;
  planId: string;
  planDigest: string;
  assessmentId: string;
  assessmentDigest: string;
  tenantId: string;
  workspaceId: string;
  status: "disabled_before_consumer_construction";
  blockingGateCodes: ReadyFrontierProductionGateCodeV1[];
  safeReason: "production_evidence_unobserved";
  recordedAt: string;
  requiresNewAssessmentAndOwnerAuthorization: true;
  automaticRetryAllowed: false;
  productionConfigurationRead: false;
  databaseContacted: false;
  protectedReferenceResolutionAttempted: false;
  consumerConstructed: false;
  claimOrLeaseAttempted: false;
  handoffConsumed: false;
  agentOrProviderContacted: false;
  networkContacted: false;
  deploymentAttempted: false;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsActivationAuthority: false;
  grantsDispatchOrExecution: false;
  dispositionDigest: string;
}

export type ReadyFrontierProductionReconciliationStateV1 =
  | "pending"
  | "claimed"
  | "failed_before_contact"
  | "delivery_started"
  | "ambiguous"
  | "confirmed"
  | "reconciled_not_delivered";
export type ReadyFrontierProductionReconciliationEventV1 =
  | "claim_acquired"
  | "definite_precontact_failure"
  | "delivery_marker_written"
  | "post_marker_unknown"
  | "qualified_destination_confirmed"
  | "qualified_destination_absence_observed"
  | "independent_destination_absence_confirmed";

export interface ReadyFrontierProductionReconciliationDecisionV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_RECONCILIATION_DECISION_V1;
  fromState: ReadyFrontierProductionReconciliationStateV1;
  event: ReadyFrontierProductionReconciliationEventV1;
  toState: ReadyFrontierProductionReconciliationStateV1 | null;
  permittedByStateMachine: boolean;
  requiresProtectedDatabaseTransaction: boolean;
  requiresQualifiedDestinationEvidence: boolean;
  requiresNewOwnerAuthorizedActionBeforeRetry: boolean;
  automaticRetryAllowed: false;
  performsConsumerAction: false;
  contactsDestination: false;
  grantsClaimOrLease: false;
  grantsDispatchOrExecution: false;
  grantsExternalEffects: false;
  decisionDigest: string;
}

export interface ReadyFrontierProductionBoundaryProjectionV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_BOUNDARY_PROJECTION_V1;
  tenantId: string;
  workspaceId: string;
  planId: string;
  assessmentId: string;
  status: "blocked_design_only";
  safeReason: "production_evidence_unobserved";
  blockingGateCodes: ReadyFrontierProductionGateCodeV1[];
  remainingProofCount: 9;
  canActivateProduction: false;
  canConstructConsumer: false;
  canResolveProtectedReferences: false;
  canContactNetwork: false;
  canClaimOrLease: false;
  canDispatchOrExecute: false;
  projectionDigest: string;
}

export interface ReadyFrontierProductionBoundaryPlanInputV1 {
  planId: string;
  activationPacket: ReadyFrontierActivationPacketV1;
  plannedAt: string;
  expiresAt: string;
}
