import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";

const arraySomeV1 = Array.prototype.some;
const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PIPELINE_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-observation-attestation-pipeline-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PIPELINE_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-observation-attestation-pipeline-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLAIMS_V1 = objectFreezeV1([
  "platform_family",
  "architecture_class",
  "runtime_semantic_version",
  "runtime_executable_content_identity",
  "operating_system_boot_epoch",
  "attestor_process_session_epoch",
  "qualification_harness_identity",
  "accepted_physical_driver_build_identity",
  "qualification_candidate_identity",
  "qualification_attempt_identity",
  "fresh_request_nonce",
  "trusted_observed_and_expiry_time",
  "platform_signer_key_identity_and_signature",
  "monotonic_acceptance_checkpoint_identity",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PROVIDERS_V1 = objectFreezeV1([
  "running_executable_content",
  "operating_system_boot_session",
  "attestor_process_session",
  "running_qualification_harness_artifact",
  "running_physical_driver_artifact",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_STAGES_V1 = objectFreezeV1([
  "verify_exact_products_and_policy",
  "construct_module_owned_production_capsule",
  "preflight_running_executable_content_provider",
  "preflight_operating_system_boot_session_provider",
  "preflight_attestor_process_session_provider",
  "preflight_running_qualification_harness_provider",
  "preflight_running_physical_driver_provider",
  "preflight_and_reserve_after_exit_cleanup_observer",
  "reserve_private_context_nonce_time_acceptance_and_heads",
  "consume_owner_native_execution_authorization_and_product_attempt",
  "spend_one_use_invocation_authorization",
  "recheck_authority_context_time_products_keys_and_heads",
  "finalize_exact_context_synchronously",
  "perform_exact_private_source_lookup",
  "invoke_exact_source_synchronously_once",
  "validate_exact_raw_source_result",
  "apply_one_use_keyed_privacy_transform",
  "bind_transformed_source_to_private_context",
  "release_source_raw_privacy_and_intermediate_references",
  "invoke_validate_transform_release_bind_executable_provider",
  "invoke_validate_transform_release_bind_boot_provider",
  "invoke_validate_transform_release_bind_process_session_provider",
  "invoke_validate_transform_release_bind_harness_provider",
  "invoke_validate_transform_release_bind_driver_provider",
  "seal_private_canonical_payload",
  "recheck_trusted_time_nonce_products_keys_and_heads",
  "sign_complete_canonical_envelope",
  "verify_private_signature_and_envelope",
  "append_attestation_pending_anchor_to_postgresql",
  "compare_and_swap_independent_attestation_high_water",
  "reconcile_attestation_checkpoint_or_terminal_state",
  "terminate_disposable_process_and_release_handles",
  "observe_and_sign_after_exit_cleanup",
  "append_anchor_and_reconcile_cleanup",
  "append_final_acceptance_and_release_private_reference",
  "different_independent_report_only_review",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_DURABLE_STATES_V1 = objectFreezeV1([
  "context_reserved",
  "owner_spent",
  "invocation_spent",
  "attestation_pending_anchor",
  "attestation_checkpointed_pending_cleanup",
  "cleanup_pending_anchor",
  "target_runtime_attestation_accepted",
  "terminal_rejected",
  "terminal_ambiguous_reconciliation_required",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_OUTCOMES_V1 = objectFreezeV1([
  "rejected_before_spend",
  "terminal_owner_authorization_spent_or_uncertain",
  "terminal_invocation_authorization_spent_or_uncertain",
  "terminal_recheck_or_context_finalization_failed",
  "terminal_source_lookup_failed",
  "terminal_source_invocation_failed_or_uncertain",
  "terminal_source_raw_validation_failed",
  "terminal_source_intake_failed",
  "terminal_supplementary_provider_failed_or_uncertain",
  "private_evidence_pipeline_failed_or_uncertain",
  "private_target_runtime_attestation_accepted_for_exact_candidate_proposal_only",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLEANUP_FACTS_V1 = objectFreezeV1([
  "qualification_process_absent",
  "descendants_absent",
  "listeners_and_enumerated_resources_absent",
  "temporary_database_closed",
  "disposable_root_absent",
  "bounded_residue_scan_clean",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RECOVERY_CASES_V1 = objectFreezeV1([
  "no_context_and_old_high_water_requires_fresh_authorizations",
  "uncertain_reservation_with_row_is_terminal_tombstone",
  "pending_with_old_high_water_reissues_same_cas_request_only",
  "pending_with_matching_desired_high_water_finalizes_predetermined_state",
  "finalized_with_matching_high_water_returns_without_write_or_native_action",
  "accepted_with_wrong_high_water_is_rollback_or_tamper",
  "terminal_with_desired_high_water_preserves_terminal_state",
  "high_water_ahead_without_exact_row_is_quarantined",
  "database_ahead_without_exact_pending_row_is_quarantined",
  "unknown_cas_allows_read_only_same_request_reconciliation_only",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_SUCCESSORS_V1 = objectFreezeV1([
  "private_candidate_assembly",
  "fresh_owner_physical_execution_authorization",
  "single_owner_attended_physical_attempt",
  "physical_attempt_cleanup_evidence",
  "different_independent_physical_review",
  "separate_runtime_activation_decision",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RULES_V1 = objectFreezeV1([
  "bind_exact_accepted_live_450_architecture",
  "separate_repository_owner_native_invocation_attestation_candidate_physical_and_activation_authority",
  "allow_one_native_attempt_per_exact_source_owner_and_runner_product_pair",
  "require_superseding_reviewed_product_pair_after_diagnostic",
  "construct_all_production_dependencies_inside_non_exporting_module_capsule",
  "prohibit_caller_source_raw_provider_signer_key_database_checkpoint_callback_or_dependency",
  "preflight_all_five_providers_and_cleanup_before_owner_spend",
  "require_one_use_owner_native_and_invocation_authorizations",
  "allow_one_source_lookup_and_one_synchronous_source_invocation",
  "keep_raw_validation_and_private_intake_distinct",
  "transform_and_release_source_raw_and_privacy_references_before_first_await",
  "invoke_each_supplementary_provider_synchronously_at_most_once",
  "transform_and_release_each_provider_result_before_next_stage",
  "require_pairwise_distinct_purpose_bound_keys",
  "recheck_trusted_database_time_and_every_key_before_signing",
  "sign_complete_canonical_envelope_with_strict_unknown_field_rejection",
  "use_postgresql_as_sole_global_write_authority",
  "limit_independent_high_water_to_authenticated_revision_and_head_digest",
  "use_distinct_context_pending_finalizer_and_recovery_writers",
  "persist_exact_pending_state_before_high_water_compare_and_swap",
  "reconcile_only_the_same_idempotent_compare_and_swap_request",
  "prohibit_source_or_provider_recall_during_recovery",
  "reserve_after_exit_cleanup_before_spend_and_require_it_before_acceptance",
  "keep_acceptance_reference_private_and_provisional_until_cleanup_settles",
  "treat_post_spend_failure_or_uncertainty_as_terminal",
  "permit_only_newly_evaluated_authorization_after_proven_precommit_failure",
  "keep_candidate_proposal_inert_until_separately_authorized_assembly",
  "grant_no_later_successor_authority",
  "test_only_through_direct_module_fixed_scenario_module_minted_fakes",
  "keep_production_capsule_inaccessible_to_repository_tests",
] as const);

export type ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PIPELINE_CONTRACT_V1;
  contractReference: string;
  live450ArchitectureCommit: "8413ad8acca4dbd79ffd56b666ad3c0a25351a36";
  acceptedLive450DesignSha256: "f22f583485c5cebb3bd3fad5d698bbfa9740fb9f54246be27505d842c2740e6e";
  acceptedLive450ReviewSha256: "f84d2b4ded765a76ca74ab80943c2ae49f3d845e138d8e5ea2f15d6704efcea1";
  requiredClaims: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLAIMS_V1;
  supplementaryProviders: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PROVIDERS_V1;
  stages: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_STAGES_V1;
  durableStates: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_DURABLE_STATES_V1;
  outcomes: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_OUTCOMES_V1;
  cleanupFacts: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLEANUP_FACTS_V1;
  recoveryCases: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RECOVERY_CASES_V1;
  laterSuccessors: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_SUCCESSORS_V1;
  rules: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RULES_V1;
  maximumAttestationLifetimeSeconds: 60;
  maximumFutureNativeAttemptsPerExactProductPair: 1;
  maximumCurrentNativeAttempts: 0;
  maximumFutureSourceInvocations: 1;
  maximumCurrentSourceInvocations: 0;
  maximumFutureInvocationsPerSupplementaryProvider: 1;
  maximumCurrentSupplementaryProviderInvocations: 0;
  postgresqlSoleGlobalWriteAuthorityRequired: true;
  independentHighWaterNonAuthoritativeRequired: true;
  separateOwnerNativeAuthorizationRequired: true;
  ownerAuthorizationBeforeSourceRequired: true;
  productionModuleCapsuleRequired: true;
  preResolvedPrivacyOperationRequired: true;
  pairwiseDistinctKeysRequired: true;
  afterExitCleanupRequiredBeforeAcceptance: true;
  exactSplitCommitRecoveryRequired: true;
  directModuleFixedScenarioTestSeamRequired: true;
  callerDependencyInjectionAllowed: false;
  rawObservationExportAllowed: false;
  rawObservationDigestAllowed: false;
  rawObservationPersistenceAllowed: false;
  retryAfterUncertaintyAllowed: false;
  sameAuthorizationReuseAllowed: false;
  recoverySourceOrProviderCallAllowed: false;
  acceptanceBeforeCleanupAllowed: false;
  candidateProposalIsCandidate: false;
  successorAuthorityGranted: false;
  contractImplemented: true;
  productionCapsuleImplemented: false;
  supplementaryProvidersImplemented: false;
  ownerNativeAuthorizationImplemented: false;
  sourceInvocationImplemented: false;
  privateAttestationImplemented: false;
  platformSignerImplemented: false;
  postgresqlPipelineImplemented: false;
  independentHighWaterImplemented: false;
  cleanupObserverImplemented: false;
  candidateAssemblerImplemented: false;
  physicalQualificationImplemented: false;
  runtimeWired: false;
  repositoryContractOnly: true;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  contractDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PIPELINE_STATUS_V1;
  contractReference: string;
  contractDigest: string;
  evidenceClass: "repository_contract_non_execution";
  contractState: "implemented_inert_unwired";
  pipelineState: "not_implemented";
  providerState: "not_implemented";
  persistenceState: "not_implemented";
  cleanupState: "not_implemented";
  nativeAttemptState: "not_attempted";
  runtimeState: "not_wired";
  actualNativeSourceImports: 0;
  actualSourceOwnerModifications: 0;
  actualProductionCapsuleConstructions: 0;
  actualOwnerAuthorizationsCreated: 0;
  actualOwnerAuthorizationSpends: 0;
  actualInvocationAuthorizationsCreated: 0;
  actualInvocationAuthorizationSpends: 0;
  actualContextReservations: 0;
  actualTrustedClockReads: 0;
  actualNoncesIssued: 0;
  actualPrivacyOperationsResolved: 0;
  actualPrivacyKeysResolved: 0;
  actualSourceLookups: 0;
  actualSourceInvocations: 0;
  actualDescriptorInspections: 0;
  actualRawObservationsCreated: 0;
  actualRawObservationExports: 0;
  actualRawObservationDigests: 0;
  actualRawObservationPersistenceWrites: 0;
  actualPrivacyTransforms: 0;
  actualExecutableProviderPreflights: 0;
  actualExecutableProviderCalls: 0;
  actualBootProviderPreflights: 0;
  actualBootProviderCalls: 0;
  actualProcessSessionProviderPreflights: 0;
  actualProcessSessionProviderCalls: 0;
  actualHarnessProviderPreflights: 0;
  actualHarnessProviderCalls: 0;
  actualDriverProviderPreflights: 0;
  actualDriverProviderCalls: 0;
  actualProviderValidations: 0;
  actualProviderTransforms: 0;
  actualCanonicalEnvelopes: 0;
  actualSignerCalls: 0;
  actualSignatureVerifications: 0;
  actualPostgresqlReads: 0;
  actualPostgresqlWrites: 0;
  actualHighWaterReads: 0;
  actualHighWaterWrites: 0;
  actualHighWaterCasRequests: 0;
  actualRecoveryRuns: 0;
  actualCleanupReservations: 0;
  actualProcessTerminations: 0;
  actualCleanupObserverCalls: 0;
  actualCleanupEnvelopes: 0;
  actualAcceptanceReferencesReleased: 0;
  actualCandidateAssemblies: 0;
  actualPhysicalAuthorizations: 0;
  actualPhysicalAttempts: 0;
  actualNativeListenerAttempts: 0;
  actualTimerCreations: 0;
  actualNetworkIoEvents: 0;
  actualExternalProviderCalls: 0;
  actualProtectedValuesRead: 0;
  actualCommandsExecuted: 0;
  actualDeployments: 0;
  actualDnsChanges: 0;
  actualTerminalAmbiguities: 0;
  externalEffectOccurred: false;
  targetRuntimeBlockerCleared: false;
  physicalQualificationAccepted: false;
  candidateEligible: false;
  activationEligible: false;
  runtimeWired: false;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  statusDigest: string;
}>;

export class ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "pipeline_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "pipeline_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "observation attestation pipeline contract record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live450ArchitectureCommit: "8413ad8acca4dbd79ffd56b666ad3c0a25351a36",
  acceptedLive450DesignSha256: "f22f583485c5cebb3bd3fad5d698bbfa9740fb9f54246be27505d842c2740e6e",
  acceptedLive450ReviewSha256: "f84d2b4ded765a76ca74ab80943c2ae49f3d845e138d8e5ea2f15d6704efcea1",
  requiredClaims: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLAIMS_V1,
  supplementaryProviders: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PROVIDERS_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_STAGES_V1,
  durableStates: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_DURABLE_STATES_V1,
  outcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_OUTCOMES_V1,
  cleanupFacts: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLEANUP_FACTS_V1,
  recoveryCases: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RECOVERY_CASES_V1,
  laterSuccessors: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_SUCCESSORS_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RULES_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PIPELINE_CONTRACT_V1,
  contractReference: `observation-attestation-pipeline:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live450ArchitectureCommit: "8413ad8acca4dbd79ffd56b666ad3c0a25351a36" as const,
  acceptedLive450DesignSha256: "f22f583485c5cebb3bd3fad5d698bbfa9740fb9f54246be27505d842c2740e6e" as const,
  acceptedLive450ReviewSha256: "f84d2b4ded765a76ca74ab80943c2ae49f3d845e138d8e5ea2f15d6704efcea1" as const,
  requiredClaims: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLAIMS_V1,
  supplementaryProviders: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PROVIDERS_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_STAGES_V1,
  durableStates: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_DURABLE_STATES_V1,
  outcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_OUTCOMES_V1,
  cleanupFacts: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLEANUP_FACTS_V1,
  recoveryCases: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RECOVERY_CASES_V1,
  laterSuccessors: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_SUCCESSORS_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RULES_V1,
  maximumAttestationLifetimeSeconds: 60 as const,
  maximumFutureNativeAttemptsPerExactProductPair: 1 as const,
  maximumCurrentNativeAttempts: 0 as const,
  maximumFutureSourceInvocations: 1 as const,
  maximumCurrentSourceInvocations: 0 as const,
  maximumFutureInvocationsPerSupplementaryProvider: 1 as const,
  maximumCurrentSupplementaryProviderInvocations: 0 as const,
  postgresqlSoleGlobalWriteAuthorityRequired: true as const,
  independentHighWaterNonAuthoritativeRequired: true as const,
  separateOwnerNativeAuthorizationRequired: true as const,
  ownerAuthorizationBeforeSourceRequired: true as const,
  productionModuleCapsuleRequired: true as const,
  preResolvedPrivacyOperationRequired: true as const,
  pairwiseDistinctKeysRequired: true as const,
  afterExitCleanupRequiredBeforeAcceptance: true as const,
  exactSplitCommitRecoveryRequired: true as const,
  directModuleFixedScenarioTestSeamRequired: true as const,
  callerDependencyInjectionAllowed: false as const,
  rawObservationExportAllowed: false as const,
  rawObservationDigestAllowed: false as const,
  rawObservationPersistenceAllowed: false as const,
  retryAfterUncertaintyAllowed: false as const,
  sameAuthorizationReuseAllowed: false as const,
  recoverySourceOrProviderCallAllowed: false as const,
  acceptanceBeforeCleanupAllowed: false as const,
  candidateProposalIsCandidate: false as const,
  successorAuthorityGranted: false as const,
  contractImplemented: true as const,
  productionCapsuleImplemented: false as const,
  supplementaryProvidersImplemented: false as const,
  ownerNativeAuthorizationImplemented: false as const,
  sourceInvocationImplemented: false as const,
  privateAttestationImplemented: false as const,
  platformSignerImplemented: false as const,
  postgresqlPipelineImplemented: false as const,
  independentHighWaterImplemented: false as const,
  cleanupObserverImplemented: false as const,
  candidateAssemblerImplemented: false as const,
  physicalQualificationImplemented: false as const,
  runtimeWired: false as const,
  repositoryContractOnly: true as const,
  grantsApproval: false as const,
  grantsQualificationAuthority: false as const,
  grantsCandidateAuthority: false as const,
  grantsActivationAuthority: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(contractMaterialV1);
export const connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
reflectApplyV1(weakSetAddV1, contractRecordsV1,
  [connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1,
  [connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1,
    connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1.contractDigest]);

const zeroActualsV1 = {
  actualNativeSourceImports: 0 as const,
  actualSourceOwnerModifications: 0 as const,
  actualProductionCapsuleConstructions: 0 as const,
  actualOwnerAuthorizationsCreated: 0 as const,
  actualOwnerAuthorizationSpends: 0 as const,
  actualInvocationAuthorizationsCreated: 0 as const,
  actualInvocationAuthorizationSpends: 0 as const,
  actualContextReservations: 0 as const,
  actualTrustedClockReads: 0 as const,
  actualNoncesIssued: 0 as const,
  actualPrivacyOperationsResolved: 0 as const,
  actualPrivacyKeysResolved: 0 as const,
  actualSourceLookups: 0 as const,
  actualSourceInvocations: 0 as const,
  actualDescriptorInspections: 0 as const,
  actualRawObservationsCreated: 0 as const,
  actualRawObservationExports: 0 as const,
  actualRawObservationDigests: 0 as const,
  actualRawObservationPersistenceWrites: 0 as const,
  actualPrivacyTransforms: 0 as const,
  actualExecutableProviderPreflights: 0 as const,
  actualExecutableProviderCalls: 0 as const,
  actualBootProviderPreflights: 0 as const,
  actualBootProviderCalls: 0 as const,
  actualProcessSessionProviderPreflights: 0 as const,
  actualProcessSessionProviderCalls: 0 as const,
  actualHarnessProviderPreflights: 0 as const,
  actualHarnessProviderCalls: 0 as const,
  actualDriverProviderPreflights: 0 as const,
  actualDriverProviderCalls: 0 as const,
  actualProviderValidations: 0 as const,
  actualProviderTransforms: 0 as const,
  actualCanonicalEnvelopes: 0 as const,
  actualSignerCalls: 0 as const,
  actualSignatureVerifications: 0 as const,
  actualPostgresqlReads: 0 as const,
  actualPostgresqlWrites: 0 as const,
  actualHighWaterReads: 0 as const,
  actualHighWaterWrites: 0 as const,
  actualHighWaterCasRequests: 0 as const,
  actualRecoveryRuns: 0 as const,
  actualCleanupReservations: 0 as const,
  actualProcessTerminations: 0 as const,
  actualCleanupObserverCalls: 0 as const,
  actualCleanupEnvelopes: 0 as const,
  actualAcceptanceReferencesReleased: 0 as const,
  actualCandidateAssemblies: 0 as const,
  actualPhysicalAuthorizations: 0 as const,
  actualPhysicalAttempts: 0 as const,
  actualNativeListenerAttempts: 0 as const,
  actualTimerCreations: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualExternalProviderCalls: 0 as const,
  actualProtectedValuesRead: 0 as const,
  actualCommandsExecuted: 0 as const,
  actualDeployments: 0 as const,
  actualDnsChanges: 0 as const,
  actualTerminalAmbiguities: 0 as const,
};

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PIPELINE_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1.contractDigest,
  evidenceClass: "repository_contract_non_execution" as const,
  contractState: "implemented_inert_unwired" as const,
  pipelineState: "not_implemented" as const,
  providerState: "not_implemented" as const,
  persistenceState: "not_implemented" as const,
  cleanupState: "not_implemented" as const,
  nativeAttemptState: "not_attempted" as const,
  runtimeState: "not_wired" as const,
  ...zeroActualsV1,
  externalEffectOccurred: false as const,
  targetRuntimeBlockerCleared: false as const,
  physicalQualificationAccepted: false as const,
  candidateEligible: false as const,
  activationEligible: false as const,
  runtimeWired: false as const,
  grantsApproval: false as const,
  grantsQualificationAuthority: false as const,
  grantsCandidateAuthority: false as const,
  grantsActivationAuthority: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(statusMaterialV1);
export const connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1,
    connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "contractReference", "live450ArchitectureCommit", "acceptedLive450DesignSha256",
    "acceptedLive450ReviewSha256", "requiredClaims", "supplementaryProviders", "stages", "durableStates",
    "outcomes", "cleanupFacts", "recoveryCases", "laterSuccessors", "rules", "maximumAttestationLifetimeSeconds",
    "maximumFutureNativeAttemptsPerExactProductPair", "maximumCurrentNativeAttempts",
    "maximumFutureSourceInvocations", "maximumCurrentSourceInvocations",
    "maximumFutureInvocationsPerSupplementaryProvider", "maximumCurrentSupplementaryProviderInvocations",
    "postgresqlSoleGlobalWriteAuthorityRequired", "independentHighWaterNonAuthoritativeRequired",
    "separateOwnerNativeAuthorizationRequired", "ownerAuthorizationBeforeSourceRequired",
    "productionModuleCapsuleRequired", "preResolvedPrivacyOperationRequired", "pairwiseDistinctKeysRequired",
    "afterExitCleanupRequiredBeforeAcceptance", "exactSplitCommitRecoveryRequired",
    "directModuleFixedScenarioTestSeamRequired", "callerDependencyInjectionAllowed", "rawObservationExportAllowed",
    "rawObservationDigestAllowed", "rawObservationPersistenceAllowed", "retryAfterUncertaintyAllowed",
    "sameAuthorizationReuseAllowed", "recoverySourceOrProviderCallAllowed", "acceptanceBeforeCleanupAllowed",
    "candidateProposalIsCandidate", "successorAuthorityGranted", "contractImplemented",
    "productionCapsuleImplemented", "supplementaryProvidersImplemented", "ownerNativeAuthorizationImplemented",
    "sourceInvocationImplemented", "privateAttestationImplemented", "platformSignerImplemented",
    "postgresqlPipelineImplemented", "independentHighWaterImplemented", "cleanupObserverImplemented",
    "candidateAssemblerImplemented", "physicalQualificationImplemented", "runtimeWired", "repositoryContractOnly",
    "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "contractDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  const requiredTrue = [record.postgresqlSoleGlobalWriteAuthorityRequired,
    record.independentHighWaterNonAuthoritativeRequired, record.separateOwnerNativeAuthorizationRequired,
    record.ownerAuthorizationBeforeSourceRequired, record.productionModuleCapsuleRequired,
    record.preResolvedPrivacyOperationRequired, record.pairwiseDistinctKeysRequired,
    record.afterExitCleanupRequiredBeforeAcceptance, record.exactSplitCommitRecoveryRequired,
    record.directModuleFixedScenarioTestSeamRequired, record.contractImplemented, record.repositoryContractOnly];
  const requiredFalse = [record.callerDependencyInjectionAllowed, record.rawObservationExportAllowed,
    record.rawObservationDigestAllowed, record.rawObservationPersistenceAllowed, record.retryAfterUncertaintyAllowed,
    record.sameAuthorizationReuseAllowed, record.recoverySourceOrProviderCallAllowed,
    record.acceptanceBeforeCleanupAllowed, record.candidateProposalIsCandidate, record.successorAuthorityGranted,
    record.productionCapsuleImplemented, record.supplementaryProvidersImplemented,
    record.ownerNativeAuthorizationImplemented, record.sourceInvocationImplemented,
    record.privateAttestationImplemented, record.platformSignerImplemented, record.postgresqlPipelineImplemented,
    record.independentHighWaterImplemented, record.cleanupObserverImplemented, record.candidateAssemblerImplemented,
    record.physicalQualificationImplemented, record.runtimeWired, record.grantsApproval,
    record.grantsQualificationAuthority, record.grantsCandidateAuthority, record.grantsActivationAuthority,
    record.grantsNetworkAuthority, record.grantsCommandAuthority, record.grantsLeaseAuthority,
    record.grantsExecutionAuthority];
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1
    || record.live450ArchitectureCommit !== "8413ad8acca4dbd79ffd56b666ad3c0a25351a36"
    || record.acceptedLive450DesignSha256 !== "f22f583485c5cebb3bd3fad5d698bbfa9740fb9f54246be27505d842c2740e6e"
    || record.acceptedLive450ReviewSha256 !== "f84d2b4ded765a76ca74ab80943c2ae49f3d845e138d8e5ea2f15d6704efcea1"
    || record.requiredClaims !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLAIMS_V1
    || record.supplementaryProviders !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_PROVIDERS_V1
    || record.stages !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_STAGES_V1
    || record.durableStates !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_DURABLE_STATES_V1
    || record.outcomes !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_OUTCOMES_V1
    || record.cleanupFacts !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_CLEANUP_FACTS_V1
    || record.recoveryCases !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RECOVERY_CASES_V1
    || record.laterSuccessors !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_SUCCESSORS_V1
    || record.rules !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OBSERVATION_ATTESTATION_RULES_V1
    || record.maximumAttestationLifetimeSeconds !== 60
    || record.maximumFutureNativeAttemptsPerExactProductPair !== 1 || record.maximumCurrentNativeAttempts !== 0
    || record.maximumFutureSourceInvocations !== 1 || record.maximumCurrentSourceInvocations !== 0
    || record.maximumFutureInvocationsPerSupplementaryProvider !== 1
    || record.maximumCurrentSupplementaryProviderInvocations !== 0
    || reflectApplyV1(arraySomeV1, requiredTrue, [(entry: boolean) => entry !== true])
    || reflectApplyV1(arraySomeV1, requiredFalse, [(entry: boolean) => entry !== false])) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "contractReference", "contractDigest", "evidenceClass", "contractState", "pipelineState",
    "providerState", "persistenceState", "cleanupState", "nativeAttemptState", "runtimeState",
    "actualNativeSourceImports", "actualSourceOwnerModifications", "actualProductionCapsuleConstructions",
    "actualOwnerAuthorizationsCreated", "actualOwnerAuthorizationSpends", "actualInvocationAuthorizationsCreated",
    "actualInvocationAuthorizationSpends", "actualContextReservations", "actualTrustedClockReads",
    "actualNoncesIssued", "actualPrivacyOperationsResolved", "actualPrivacyKeysResolved", "actualSourceLookups",
    "actualSourceInvocations", "actualDescriptorInspections", "actualRawObservationsCreated",
    "actualRawObservationExports", "actualRawObservationDigests", "actualRawObservationPersistenceWrites",
    "actualPrivacyTransforms", "actualExecutableProviderPreflights", "actualExecutableProviderCalls",
    "actualBootProviderPreflights", "actualBootProviderCalls", "actualProcessSessionProviderPreflights",
    "actualProcessSessionProviderCalls", "actualHarnessProviderPreflights", "actualHarnessProviderCalls",
    "actualDriverProviderPreflights", "actualDriverProviderCalls", "actualProviderValidations",
    "actualProviderTransforms", "actualCanonicalEnvelopes", "actualSignerCalls", "actualSignatureVerifications",
    "actualPostgresqlReads", "actualPostgresqlWrites", "actualHighWaterReads", "actualHighWaterWrites",
    "actualHighWaterCasRequests", "actualRecoveryRuns", "actualCleanupReservations", "actualProcessTerminations",
    "actualCleanupObserverCalls", "actualCleanupEnvelopes", "actualAcceptanceReferencesReleased",
    "actualCandidateAssemblies", "actualPhysicalAuthorizations", "actualPhysicalAttempts",
    "actualNativeListenerAttempts", "actualTimerCreations", "actualNetworkIoEvents", "actualExternalProviderCalls",
    "actualProtectedValuesRead", "actualCommandsExecuted", "actualDeployments", "actualDnsChanges",
    "actualTerminalAmbiguities", "externalEffectOccurred", "targetRuntimeBlockerCleared",
    "physicalQualificationAccepted", "candidateEligible", "activationEligible", "runtimeWired", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const actuals = [record.actualNativeSourceImports, record.actualSourceOwnerModifications,
    record.actualProductionCapsuleConstructions, record.actualOwnerAuthorizationsCreated,
    record.actualOwnerAuthorizationSpends, record.actualInvocationAuthorizationsCreated,
    record.actualInvocationAuthorizationSpends, record.actualContextReservations, record.actualTrustedClockReads,
    record.actualNoncesIssued, record.actualPrivacyOperationsResolved, record.actualPrivacyKeysResolved,
    record.actualSourceLookups, record.actualSourceInvocations, record.actualDescriptorInspections,
    record.actualRawObservationsCreated, record.actualRawObservationExports, record.actualRawObservationDigests,
    record.actualRawObservationPersistenceWrites, record.actualPrivacyTransforms,
    record.actualExecutableProviderPreflights, record.actualExecutableProviderCalls,
    record.actualBootProviderPreflights, record.actualBootProviderCalls,
    record.actualProcessSessionProviderPreflights, record.actualProcessSessionProviderCalls,
    record.actualHarnessProviderPreflights, record.actualHarnessProviderCalls, record.actualDriverProviderPreflights,
    record.actualDriverProviderCalls, record.actualProviderValidations, record.actualProviderTransforms,
    record.actualCanonicalEnvelopes, record.actualSignerCalls, record.actualSignatureVerifications,
    record.actualPostgresqlReads, record.actualPostgresqlWrites, record.actualHighWaterReads,
    record.actualHighWaterWrites, record.actualHighWaterCasRequests, record.actualRecoveryRuns,
    record.actualCleanupReservations, record.actualProcessTerminations, record.actualCleanupObserverCalls,
    record.actualCleanupEnvelopes, record.actualAcceptanceReferencesReleased, record.actualCandidateAssemblies,
    record.actualPhysicalAuthorizations, record.actualPhysicalAttempts, record.actualNativeListenerAttempts,
    record.actualTimerCreations, record.actualNetworkIoEvents, record.actualExternalProviderCalls,
    record.actualProtectedValuesRead, record.actualCommandsExecuted, record.actualDeployments, record.actualDnsChanges,
    record.actualTerminalAmbiguities];
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1
    || record.contractReference !== connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1.contractReference
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1.contractDigest
    || record.evidenceClass !== "repository_contract_non_execution"
    || record.contractState !== "implemented_inert_unwired" || record.pipelineState !== "not_implemented"
    || record.providerState !== "not_implemented" || record.persistenceState !== "not_implemented"
    || record.cleanupState !== "not_implemented" || record.nativeAttemptState !== "not_attempted"
    || record.runtimeState !== "not_wired"
    || actuals.length !== 58 || reflectApplyV1(arraySomeV1, actuals, [(entry: number) => entry !== 0])
    || grants.length !== 8 || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])
    || record.externalEffectOccurred || record.targetRuntimeBlockerCleared || record.physicalQualificationAccepted
    || record.candidateEligible || record.activationEligible || record.runtimeWired) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineContractV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackObservationAttestationPipelineStatusV1);
