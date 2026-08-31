import type { ReadyFrontierProductionBoundaryAssessmentV1,
  ReadyFrontierProductionGateCodeV1 } from "./production-boundary-types";

export const READY_FRONTIER_PRODUCTION_CUSTODY_PLAN_V1 =
  "control-room-ready-frontier-production-custody-plan/v1" as const;
export const READY_FRONTIER_PRODUCTION_CUSTODY_REPORT_V1 =
  "control-room-ready-frontier-production-custody-report/v1" as const;
export const READY_FRONTIER_PRODUCTION_CUSTODY_PROJECTION_V1 =
  "control-room-ready-frontier-production-custody-projection/v1" as const;
export const READY_FRONTIER_ACCEPTED_AUTO060_COMMIT_V1 =
  "be01058e2edeeddb7bbd2655eaf668ed86b9d0e2" as const;
export const READY_FRONTIER_ACCEPTED_AUTO060_REVIEW_SHA256_V1 =
  "sha256:8651708829f346e26ea60afec18418bd150844b063aa8d07e2afdd1f5bd6d61e" as const;
export const READY_FRONTIER_PRODUCTION_CUSTODY_MAX_LIFETIME_SECONDS_V1 = 3_600 as const;

export const readyFrontierProductionCustodyScenarioCodesV1 = [
  "service_identity_separation",
  "owner_policy_high_water",
  "protected_clock_commit_boundary",
  "revocation_cross_process_convergence",
  "serializable_claim_uniqueness",
  "checkpoint_compare_and_swap",
  "backup_restore_rollback_detection",
  "post_marker_ambiguity",
] as const;
export type ReadyFrontierProductionCustodyScenarioCodeV1 =
  (typeof readyFrontierProductionCustodyScenarioCodesV1)[number];

export const readyFrontierProductionCustodyFaultCodesV1 = [
  "none",
  "service_identity_alias",
  "policy_rollback_accepted",
  "clock_rollback_accepted",
  "revocation_lag",
  "duplicate_claim",
  "checkpoint_rollback_accepted",
  "restored_database_trusted",
  "retry_after_ambiguity",
] as const;
export type ReadyFrontierProductionCustodyFaultCodeV1 =
  (typeof readyFrontierProductionCustodyFaultCodesV1)[number];

export interface ReadyFrontierProductionCustodyServiceRoleV1 {
  role: "proof_ingress_writer" | "proof_read_verifier" | "rollback_checkpoint_custodian";
  serviceIdentityId: string;
  keyIdentityDigest: string;
  independenceDomainDigest: string;
  mayWriteProofLedger: boolean;
  mayVerifyProofLedger: boolean;
  mayAdvanceCheckpoint: boolean;
  mayIssueProof: false;
  mayApproveProduction: false;
  mayActivateProduction: false;
}

export interface ReadyFrontierProductionCustodyPlanV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_CUSTODY_PLAN_V1;
  planId: string;
  tenantId: string;
  workspaceId: string;
  productionBoundaryPlanId: string;
  productionBoundaryPlanDigest: string;
  productionBoundaryAssessmentId: string;
  productionBoundaryAssessmentDigest: string;
  productionBoundaryAssessment: ReadyFrontierProductionBoundaryAssessmentV1;
  acceptedAuto060Commit: typeof READY_FRONTIER_ACCEPTED_AUTO060_COMMIT_V1;
  acceptedAuto060ReviewSha256: typeof READY_FRONTIER_ACCEPTED_AUTO060_REVIEW_SHA256_V1;
  qualificationMode: "repository_fake_only";
  databaseMode: "hosted_postgresql_required_unconfigured";
  transactionIsolationRequired: "serializable";
  ownerPolicyMode: "owner_signed_external_high_water_required";
  clockMode: "protected_monotonic_database_commit_required";
  revocationMode: "terminal_cross_process_high_water_required";
  checkpointMode: "external_compare_and_swap_required";
  restoreMode: "isolated_restore_then_reconcile_required";
  ambiguityMode: "post_marker_unknown_is_terminal_ambiguity";
  processCount: 3;
  processIds: [string, string, string];
  serviceRoles: ReadyFrontierProductionCustodyServiceRoleV1[];
  scenarioCodes: ReadyFrontierProductionCustodyScenarioCodeV1[];
  requiredProductionGateCodes: ReadyFrontierProductionGateCodeV1[];
  defaultDisabled: true;
  repositoryFakeOnly: true;
  liveQualificationAuthorized: false;
  productionConfigurationPresent: false;
  protectedMaterialPresent: false;
  productionKeysEnrolled: false;
  ownerPolicyEnrolled: false;
  hostedDatabaseContactAuthorized: false;
  networkAuthorized: false;
  consumerImplemented: false;
  activationAuthorized: false;
  permitsProtectedReferenceResolution: false;
  permitsClaimOrLease: false;
  permitsDispatchOrExecution: false;
  permitsExternalEffects: false;
  plannedAt: string;
  expiresAt: string;
  planDigest: string;
  planAuthTag: string;
}

export interface ReadyFrontierProductionCustodyScenarioResultV1 {
  scenarioCode: ReadyFrontierProductionCustodyScenarioCodeV1;
  status: "simulated_pass" | "simulated_failure";
  safeFindingCode: string;
  processCount: 3;
  evidenceDigest: string;
}

export interface ReadyFrontierProductionCustodyReportV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_CUSTODY_REPORT_V1;
  reportId: string;
  runId: string;
  planId: string;
  planDigest: string;
  tenantId: string;
  workspaceId: string;
  productionBoundaryAssessmentId: string;
  productionBoundaryAssessmentDigest: string;
  qualificationMode: "repository_fake_only";
  injectedFault: ReadyFrontierProductionCustodyFaultCodeV1;
  status: "simulated_pass" | "simulated_failure";
  scenarioResults: ReadyFrontierProductionCustodyScenarioResultV1[];
  simulatedPassCount: number;
  simulatedFailureCount: number;
  blockingGateCodes: ReadyFrontierProductionGateCodeV1[];
  qualifiedProofCount: 0;
  remainingQualifiedProofCount: 9;
  state: "blocked_fake_qualification_only";
  safeReason: "protected_production_qualification_not_run";
  liveQualificationPerformed: false;
  productionDatabaseContacted: false;
  productionClockContacted: false;
  productionKeyStoreContacted: false;
  productionCheckpointContacted: false;
  ownerPolicyRead: false;
  ownerApprovalIssued: false;
  protectedReferenceResolutionAttempted: false;
  consumerConstructed: false;
  claimOrLeaseAttempted: false;
  dispatchOrExecutionAttempted: false;
  networkContacted: false;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsActivationAuthority: false;
  grantsClaimOrLease: false;
  grantsDispatchOrExecution: false;
  grantsExternalEffects: false;
  startedAt: string;
  completedAt: string;
  reportDigest: string;
  reportAuthTag: string;
}

export interface ReadyFrontierProductionCustodyProjectionV1 {
  schema: typeof READY_FRONTIER_PRODUCTION_CUSTODY_PROJECTION_V1;
  tenantId: string;
  workspaceId: string;
  planId: string;
  reportId: string;
  status: "blocked_fake_qualification_only";
  safeReason: "protected_production_qualification_not_run";
  scenarioStatuses: Array<{
    scenarioCode: ReadyFrontierProductionCustodyScenarioCodeV1;
    status: "simulated_pass" | "simulated_failure";
  }>;
  blockingGateCodes: ReadyFrontierProductionGateCodeV1[];
  qualifiedProofCount: 0;
  remainingQualifiedProofCount: 9;
  canRunLiveQualification: false;
  canEnrollProductionKeys: false;
  canEnrollOwnerPolicy: false;
  canContactHostedDatabase: false;
  canActivateProduction: false;
  canConstructConsumer: false;
  canResolveProtectedReferences: false;
  canContactNetwork: false;
  canClaimOrLease: false;
  canDispatchOrExecute: false;
  projectionDigest: string;
}

export interface ReadyFrontierProductionCustodyPlanInputV1 {
  planId: string;
  assessment: ReadyFrontierProductionBoundaryAssessmentV1;
  plannedAt: string;
  expiresAt: string;
}

export interface ReadyFrontierProductionCustodyRunInputV1 {
  runId: string;
  plan: ReadyFrontierProductionCustodyPlanV1;
  startedAt: string;
  completedAt: string;
  injectedFault?: ReadyFrontierProductionCustodyFaultCodeV1;
}
