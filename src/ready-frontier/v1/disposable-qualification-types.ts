import type {
  ReadyFrontierProductionCustodyPlanV1,
  ReadyFrontierProductionCustodyReportV1,
  ReadyFrontierProductionCustodyScenarioCodeV1,
} from "./production-custody-types";

export const READY_FRONTIER_DISPOSABLE_QUALIFICATION_REQUEST_V1 =
  "control-room-ready-frontier-disposable-qualification-request/v1" as const;
export const READY_FRONTIER_DISPOSABLE_QUALIFICATION_PROJECTION_V1 =
  "control-room-ready-frontier-disposable-qualification-projection/v1" as const;
export const READY_FRONTIER_ACCEPTED_AUTO070_COMMIT_V1 =
  "20eeb148ce7ecf59a777f060eacd9245d9948cc8" as const;
export const READY_FRONTIER_ACCEPTED_AUTO070_REVIEW_SHA256_V1 =
  "sha256:07033f542a7e3b7167a95d3fa301b90ff3806ec49232cddc878e8fa84353f681" as const;
export const READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_REQUEST_LIFETIME_SECONDS_V1 = 3_600 as const;
export const READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_PROVIDER_CALLS_V1 = 40 as const;
export const READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_DURATION_SECONDS_V1 = 1_800 as const;
export const READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_EVIDENCE_BYTES_V1 = 1_048_576 as const;

export const readyFrontierDisposableQualificationOperationCodesV1 = [
  "provision_disposable_database",
  "start_three_isolated_workers",
  "run_eight_bounded_scenarios",
  "create_isolated_backup",
  "restore_to_second_isolated_database",
  "collect_sanitized_evidence",
  "destroy_disposable_resources",
] as const;
export type ReadyFrontierDisposableQualificationOperationCodeV1 =
  (typeof readyFrontierDisposableQualificationOperationCodesV1)[number];

export const readyFrontierDisposableQualificationRequirementCodesV1 = [
  "exact_owner_signature",
  "owner_selected_private_provider",
  "disposable_resource_identity",
  "protected_credential_reference",
  "three_independent_service_identities",
  "external_checkpoint_custodian",
  "protected_commit_clock",
  "terminal_revocation_feed",
  "cleanup_authority_and_receipt",
  "independent_result_review",
] as const;
export type ReadyFrontierDisposableQualificationRequirementCodeV1 =
  (typeof readyFrontierDisposableQualificationRequirementCodesV1)[number];

export interface ReadyFrontierDisposableQualificationRequestV1 {
  schema: typeof READY_FRONTIER_DISPOSABLE_QUALIFICATION_REQUEST_V1;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  sourceCustodyPlanId: string;
  sourceCustodyPlanDigest: string;
  sourceCustodyReportId: string;
  sourceCustodyReportDigest: string;
  sourceCustodyPlan: ReadyFrontierProductionCustodyPlanV1;
  sourceCustodyReport: ReadyFrontierProductionCustodyReportV1;
  acceptedAuto070Commit: typeof READY_FRONTIER_ACCEPTED_AUTO070_COMMIT_V1;
  acceptedAuto070ReviewSha256: typeof READY_FRONTIER_ACCEPTED_AUTO070_REVIEW_SHA256_V1;
  packetKind: "controlled_effect_request_not_authority";
  qualificationMode: "owner_authorized_disposable_hosted_required";
  requestedProviderClass: "owner_selected_private_hosted_postgresql";
  requestedResourceClass: "new_disposable_nonproduction_only";
  protectedAccessMode: "owner_attended_protected_reference_only";
  transactionIsolationRequired: "serializable";
  evidenceMode: "sanitized_digest_and_safe_codes_only";
  scenarioCodes: ReadyFrontierProductionCustodyScenarioCodeV1[];
  requestedOperations: ReadyFrontierDisposableQualificationOperationCodeV1[];
  blockingRequirementCodes: ReadyFrontierDisposableQualificationRequirementCodeV1[];
  requestedDatabaseCount: 2;
  requestedProcessCount: 3;
  maxProviderCallsRequested: typeof READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_PROVIDER_CALLS_V1;
  maxDurationSecondsRequested: typeof READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_DURATION_SECONDS_V1;
  maxEvidenceBytesRequested: typeof READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_EVIDENCE_BYTES_V1;
  cleanupRequired: true;
  cleanupMustBeSeparatelyAuthorized: true;
  cleanupReceiptRequired: true;
  rawEvidenceRetentionAllowed: false;
  productionDataAllowed: false;
  publicEndpointAllowed: false;
  providerSelected: false;
  disposableResourcesAssigned: false;
  protectedReferencesPresent: false;
  ownerAuthorizationPresent: false;
  ownerSignaturePresent: false;
  networkAuthorized: false;
  processStartAuthorized: false;
  databaseContactAuthorized: false;
  cleanupAuthorized: false;
  liveQualificationAuthorized: false;
  productionConsumerAuthorized: false;
  productionActivationAuthorized: false;
  grantsApproval: false;
  grantsClaimOrLease: false;
  grantsDispatchOrExecution: false;
  grantsExternalEffects: false;
  state: "blocked_pending_owner_authorization_and_resources";
  safeReason: "controlled_effect_packet_not_issued";
  requestedAt: string;
  expiresAt: string;
  requestDigest: string;
  requestAuthTag: string;
}

export interface ReadyFrontierDisposableQualificationRequestInputV1 {
  requestId: string;
  sourceCustodyPlan: ReadyFrontierProductionCustodyPlanV1;
  sourceCustodyReport: ReadyFrontierProductionCustodyReportV1;
  requestedAt: string;
  expiresAt: string;
}

export interface ReadyFrontierDisposableQualificationProjectionV1 {
  schema: typeof READY_FRONTIER_DISPOSABLE_QUALIFICATION_PROJECTION_V1;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  sourceCustodyReportId: string;
  status: "blocked_pending_owner_authorization_and_resources";
  safeReason: "controlled_effect_packet_not_issued";
  requestedProviderClass: "owner_selected_private_hosted_postgresql";
  requestedResourceClass: "new_disposable_nonproduction_only";
  requestedOperations: ReadyFrontierDisposableQualificationOperationCodeV1[];
  blockingRequirementCodes: ReadyFrontierDisposableQualificationRequirementCodeV1[];
  maxProviderCallsRequested: typeof READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_PROVIDER_CALLS_V1;
  maxDurationSecondsRequested: typeof READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_DURATION_SECONDS_V1;
  cleanupRequired: true;
  canSelectProvider: false;
  canResolveProtectedReferences: false;
  canContactNetwork: false;
  canStartProcesses: false;
  canContactDatabase: false;
  canRunLiveQualification: false;
  canCleanupResources: false;
  canActivateProduction: false;
  canDispatchOrExecute: false;
  projectionDigest: string;
}
