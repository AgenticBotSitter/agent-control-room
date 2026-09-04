import { sha256Digest } from "../../security/canonical-digest";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";
import { assertNoSecretMaterial } from "../../security/redaction";

const arraySomeV1 = Array.prototype.some;
const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-owner-native-authorization-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-owner-native-authorization-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_FIELDS_V1 =
  objectFreezeV1([
    "component_role",
    "product_commit",
    "product_tree",
    "independent_review_sha256",
  ] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_ROLES_V1 =
  objectFreezeV1([
    "source_owner",
    "runner",
    "capsule_lexical_graph",
    "child_entrypoint",
    "owner_attended_parent_harness",
    "owner_authorization_contract",
    "owner_authorization_store",
    "broker_invocation_contract",
    "broker_invocation_store",
    "context_reservation",
    "cleanup_reservation",
    "privacy_transform",
    "running_executable_content_provider",
    "operating_system_boot_session_provider",
    "attestor_process_session_provider",
    "running_qualification_harness_provider",
    "running_physical_driver_provider",
    "platform_signer",
    "owner_registration_closure_writer",
    "owner_consumption_product_closure_writer",
    "owner_anchor_settlement_writer",
    "context_reservation_writer",
    "cleanup_reservation_writer",
    "attestation_pending_writer",
    "attestation_finalizer",
    "cleanup_pending_writer",
    "cleanup_finalizer",
    "final_acceptance_writer",
    "protected_high_water_adapter",
    "private_verifier",
    "cleanup_observer",
    "cleanup_signer",
    "parent_finalizer",
    "public_projector",
    "owner_present_issuer",
    "trust_registry_resolver",
    "deployment_manifest_resolver",
    "owner_attempt_anchor_adapter",
    "attestation_anchor_adapter",
    "cleanup_anchor_adapter",
    "trust_registry_anchor_adapter",
    "manifest_anchor_adapter",
  ] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_FIELDS_V1 =
  objectFreezeV1([
    "role",
    "key_id_digest",
    "algorithm",
    "fingerprint",
    "revision",
    "status",
    "not_before",
    "expires_at",
    "revoked_at_or_zero",
    "trust_registry_entry_digest",
  ] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1 =
  objectFreezeV1({
    fields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_FIELDS_V1,
    orderedRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_ROLES_V1,
    exactCardinality: 42 as const,
    duplicateRolesAllowed: false as const,
    extraFieldsAllowed: false as const,
  });

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1 = objectFreezeV1([
  "body_schema_version",
  "live440_architecture_commit",
  "live440_architecture_tree",
  "live440_design_sha256",
  "live440_review_sha256",
  "live450_architecture_commit",
  "live450_design_sha256",
  "live450_review_sha256",
  "live460_product_commit",
  "live460_product_tree",
  "live460_review_sha256",
  "ordered_component_product_bindings",
  "tenant_id_digest",
  "project_id_digest",
  "connection_id_digest",
  "node_id_digest",
  "target_platform_family",
  "target_runtime_family",
  "deployment_id_digest",
  "policy_id_digest",
  "operation_id",
  "candidate_proposal_id_digest",
  "attempt_id_digest",
  "deployment_manifest_id_digest",
  "deployment_manifest_digest",
  "deployment_manifest_sequence",
  "trust_registry_id_digest",
  "trust_registry_digest",
  "trust_registry_sequence",
  "manifest_anchor_revision",
  "manifest_anchor_head_digest",
  "trust_registry_anchor_revision",
  "trust_registry_anchor_head_digest",
  "protected_product_catalog_revision",
  "owner_policy_revision",
  "owner_authorization_id_digest",
  "strong_factor_policy_revision",
  "strong_factor_evidence_class",
  "owner_nonce_digest",
  "issued_at",
  "not_before",
  "expires_at",
  "cleanup_deadline",
  "broker_authorization_id_digest",
  "broker_nonce_digest",
  "broker_body_digest",
  "broker_registration_identity_digest",
  "broker_sealing_key_revision",
  "broker_not_before",
  "broker_expires_at",
  "broker_scope_digest",
  "context_reservation_intent_digest",
  "cleanup_reservation_intent_digest",
  "cleanup_subject_resource_set_digest",
  "required_cleanup_fact_names",
  "ordered_provider_subject_scope_digests",
  "private_postgresql_destination_digest",
  "owner_attempt_anchor_destination_digest",
  "attestation_anchor_destination_digest",
  "cleanup_anchor_destination_digest",
  "ordered_key_role_bindings",
  "logical_operation_budget_digest",
  "allowed_effect_classes",
  "prohibited_effect_classes",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1 = objectFreezeV1([
  "envelope_version",
  "codec_version",
  "signature_algorithm",
  "body",
  "canonical_body_digest",
  "owner_sealing_key_id",
  "owner_sealing_key_fingerprint",
  "owner_sealing_key_revision",
  "authentication_tag",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RESERVATION_INTENTS_V1 =
  objectFreezeV1([
    "context_reservation_intent",
    "after_exit_cleanup_reservation_intent",
  ] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROVIDER_SCOPES_V1 = objectFreezeV1([
  "running_executable_content",
  "operating_system_boot_session",
  "attestor_process_session",
  "running_qualification_harness_artifact",
  "running_physical_driver_artifact",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CLEANUP_FACTS_V1 = objectFreezeV1([
  "qualification_process_absent",
  "descendants_absent",
  "listeners_and_enumerated_resources_absent",
  "temporary_database_closed",
  "disposable_root_absent",
  "bounded_residue_scan_clean",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ALLOWED_EFFECTS_V1 = objectFreezeV1([
  "private_postgresql_transactions",
  "protected_high_water_state_reads",
  "protected_high_water_compare_and_swap",
  "eight_value_local_source_read",
  "five_bounded_local_supplementary_reads",
  "fixed_disposable_child_creation",
  "bounded_parent_to_child_launch_frame",
  "bounded_child_to_parent_settlement_frame",
  "one_platform_signature",
  "disposable_child_exit_or_termination",
  "one_after_exit_cleanup_observation",
  "one_after_exit_cleanup_signature",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROHIBITED_EFFECTS_V1 =
  objectFreezeV1([
    "listener_or_inbound_server_socket",
    "undeclared_outbound_socket",
    "public_endpoint",
    "non_private_network",
    "external_model_or_provider_call",
    "arbitrary_command_or_shell",
    "ssh",
    "mcp",
    "plugin",
    "application_or_runtime_activation",
    "candidate_assembly",
    "physical_listener_attempt",
    "deployment",
    "dns_change",
    "hosting_change",
    "credential_export",
    "arbitrary_file_read",
    "every_undeclared_effect",
  ] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PUBLIC_TERMINAL_FIELDS_V1 =
  objectFreezeV1([
    "schema_version",
    "live460_contract_product",
    "live460_contract_tree",
    "source_owner_product",
    "source_owner_tree",
    "runner_product",
    "runner_tree",
    "accepted_product_set_digest",
    "coarse_outcome",
    "owner_authorization_use_count",
    "broker_authorization_use_count",
    "source_lookup_count",
    "source_invocation_count",
    "ordered_provider_invocation_counts",
    "platform_signature_count",
    "cleanup_observation_count",
    "cleanup_signature_count",
    "child_creation_count",
    "launch_frame_count",
    "settlement_frame_count",
    "finalization_count",
    "review_submission_count",
    "review_state",
    "review_product_digest_or_zero",
    "review_evidence_digest_or_zero",
    "authority_grants",
    "prohibited_effect_grants",
    "public_object_digest",
  ] as const);

function budgetV1<const Operation extends string, const AggregateMaximum extends number>(
  operation: Operation,
  aggregateMaximum: AggregateMaximum,
) {
  return objectFreezeV1({
    operation,
    aggregateMaximum,
    scopeMode: "single_scope" as const,
    maximumPerScope: aggregateMaximum,
  });
}

function providerBudgetV1<const Operation extends string>(operation: Operation) {
  return objectFreezeV1({
    operation,
    aggregateMaximum: 5 as const,
    scopeMode: "ordered_provider_scopes" as const,
    maximumPerScope: 1 as const,
  });
}

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_OPERATION_BUDGET_V1 = objectFreezeV1([
  budgetV1("registration_nonce_transaction", 1),
  budgetV1("registration_anchor_cas", 1),
  budgetV1("registration_anchor_finalization", 1),
  budgetV1("trust_registry_authenticated_reads", 4),
  budgetV1("deployment_manifest_authenticated_reads", 4),
  budgetV1("trust_anchor_reads", 4),
  budgetV1("manifest_anchor_reads", 4),
  budgetV1("owner_store_read_transactions", 5),
  budgetV1("owner_attempt_anchor_reads", 4),
  budgetV1("trusted_postgresql_time_reads", 7),
  budgetV1("context_reservation_appends", 1),
  budgetV1("context_reservation_head_advances", 1),
  budgetV1("context_reservation_terminal_tombstones", 1),
  budgetV1("cleanup_reservation_appends", 1),
  budgetV1("cleanup_reservation_head_advances", 1),
  budgetV1("cleanup_reservation_terminal_tombstones", 1),
  budgetV1("owner_consumption_product_attempt_transactions", 1),
  budgetV1("owner_attempt_anchor_cas", 1),
  budgetV1("owner_attempt_anchor_finalization", 1),
  budgetV1("broker_consumption_transactions", 1),
  budgetV1("broker_head_advances", 1),
  budgetV1("broker_rechecks", 1),
  budgetV1("source_lookups", 1),
  budgetV1("source_invocations", 1),
  providerBudgetV1("provider_reservations"),
  providerBudgetV1("provider_invocations"),
  budgetV1("privacy_transforms", 1),
  budgetV1("platform_signatures", 1),
  budgetV1("private_verifications", 1),
  budgetV1("attestation_pending_appends", 1),
  budgetV1("attestation_head_advances", 1),
  budgetV1("attestation_anchor_reads", 4),
  budgetV1("attestation_anchor_cas", 1),
  budgetV1("attestation_finalizations", 1),
  budgetV1("disposable_child_creations", 1),
  budgetV1("launch_ipc_frames", 1),
  budgetV1("settlement_ipc_frames", 1),
  budgetV1("disposable_child_terminations", 1),
  budgetV1("cleanup_observations", 1),
  budgetV1("cleanup_signatures", 1),
  budgetV1("cleanup_pending_appends", 1),
  budgetV1("cleanup_head_advances", 1),
  budgetV1("cleanup_anchor_reads", 3),
  budgetV1("cleanup_anchor_cas", 1),
  budgetV1("cleanup_finalizations", 1),
  budgetV1("final_acceptance_appends", 1),
  budgetV1("public_projections", 1),
  budgetV1("independent_review_submissions", 1),
  budgetV1("read_only_recovery_queries_per_immutable_request", 1),
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATES_V1 = objectFreezeV1([
  "registration_pending_anchor",
  "registered_unspent",
  "preflight_validated_unspent",
  "consumption_product_pending_anchor",
  "consumed_product_attempt_closed",
  "already_consumed_terminal",
  "rejected_before_consumption",
  "terminal_consumption_or_product_attempt_ambiguous",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_TERMINAL_OUTCOMES_V1 =
  objectFreezeV1([
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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1 = objectFreezeV1([
  "out_of_band_owner_root",
  "trust_registry_signer",
  "trust_anchor_writer",
  "deployment_manifest_signer",
  "manifest_anchor_writer",
  "owner_authorization_sealing",
  "owner_state",
  "product_attempt_state",
  "owner_attempt_anchor_writer",
  "broker_invocation_sealing",
  "broker_invocation_state",
  "broker_invocation_consumption",
  "privacy_transform",
  "running_executable_content_provider",
  "operating_system_boot_session_provider",
  "attestor_process_session_provider",
  "running_qualification_harness_provider",
  "running_physical_driver_provider",
  "platform_signer",
  "launch_ipc",
  "settlement_ipc",
  "attestation_database_state",
  "attestation_anchor_writer",
  "cleanup_signer",
  "cleanup_database_state",
  "cleanup_anchor_writer",
  "tls_transport",
  "node_channel",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1 =
  objectFreezeV1({
    fields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_FIELDS_V1,
    orderedRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1,
    exactCardinality: 28 as const,
    duplicateRolesAllowed: false as const,
    extraFieldsAllowed: false as const,
  });

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RULES_V1 = objectFreezeV1([
  "bind_exact_accepted_live_470_product_tree_design_review_and_acceptance",
  "bind_every_component_to_exact_product_commit_tree_and_independent_review",
  "bind_every_key_role_to_exact_closed_key_binding",
  "treat_owner_body_and_envelope_as_closed_canonical_data",
  "bind_complete_broker_authorization_registration_body_nonce_key_and_scope",
  "bind_exact_manifest_trust_registry_catalog_and_anchor_heads",
  "bind_owner_present_issuer_strong_factor_policy_and_evidence_class",
  "bind_all_five_ordered_provider_subject_scope_digests",
  "bind_canonical_private_database_and_anchor_destinations",
  "bind_context_and_cleanup_reservation_intents_not_reservations",
  "materialize_cleanup_then_context_only_inside_authorized_capsule_entry",
  "return_no_reservation_object_handle_or_capability_to_caller",
  "apply_exact_operation_budget_and_zero_every_undeclared_effect",
  "apply_one_per_ordered_provider_scope_and_aggregate_five_ceiling",
  "limit_owner_window_to_300_seconds",
  "limit_context_and_child_to_60_seconds_inside_owner_window",
  "start_cleanup_only_after_authenticated_child_exit",
  "complete_cleanup_within_120_seconds_of_exit_and_600_seconds_of_issue",
  "complete_finalization_within_30_seconds_of_accepted_cleanup",
  "require_pairwise_distinct_manifest_bound_key_roles",
  "retain_historical_keys_for_verification_only_and_forbid_new_writes",
  "use_postgresql_as_sole_global_write_authority",
  "anchor_all_four_owner_store_heads_independently",
  "atomically_close_owner_consumption_product_attempt_heads_and_anchor_request",
  "exclude_candidate_attempt_and_authorization_relabels_from_product_pair_uniqueness",
  "permit_only_same_idempotent_anchor_request_during_recovery",
  "never_resume_after_consumption_or_anchor_uncertainty",
  "keep_capsule_lexical_inside_exact_live_440_source_owner",
  "permit_only_two_sealed_envelopes_as_source_runner_arguments",
  "keep_child_stages_1_through_31_and_parent_stages_32_through_35",
  "permit_one_bounded_authenticated_frame_in_each_ipc_direction",
  "require_closed_sanitized_public_schema_for_every_terminal_path",
  "require_stage_36_different_report_only_review_before_candidate_assembly",
  "keep_every_transitive_production_import_inert_until_authorized_entry",
  "implement_and_accept_providers_and_pipeline_components_before_capsule_assembly",
  "implement_exact_live_440_source_owner_last",
  "grant_no_issuer_store_key_database_anchor_capsule_provider_source_process_or_native_authority",
] as const);

export type ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CONTRACT_V1;
  contractReference: string;
  live470ProductCommit: "b1f1055f05bc4c53485caa89ddc456953fce4326";
  live470ProductTree: "a396d40e7c4c5f0c1dc3bab4d073b462863a408b";
  acceptedLive470ReviewedDesignSha256: "29980084a8d0fd1839a79e0f5402cc0f2038179bdecadd666295bd090497f7c4";
  acceptedLive470FinalDesignSha256: "ea4636bd9cb7a3ac78d774b5e8085e44089ef737e50b9c009cb79f7cdd99d8a6";
  acceptedLive470ReviewSha256: "252e5f80eaca7bf78d98d50601c3472f74e73e4cd8ee1879f5fa53c8ab0dad1f";
  acceptedLive470AcceptanceSha256: "41d6725a6cd55513a526f18a908a22270fa102d264c3d1f6ee0e6da31cbee7f5";
  productBindingFields:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_FIELDS_V1;
  productBindingRoles:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_ROLES_V1;
  keyBindingFields:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_FIELDS_V1;
  productBindingSchema:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1;
  keyBindingSchema:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1;
  bodyFields: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1;
  envelopeFields: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1;
  reservationIntents: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RESERVATION_INTENTS_V1;
  providerSubjectScopes: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROVIDER_SCOPES_V1;
  requiredCleanupFacts: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CLEANUP_FACTS_V1;
  allowedEffects: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ALLOWED_EFFECTS_V1;
  prohibitedEffects: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROHIBITED_EFFECTS_V1;
  publicTerminalFields:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PUBLIC_TERMINAL_FIELDS_V1;
  operationBudget: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_OPERATION_BUDGET_V1;
  authorizationStates: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATES_V1;
  terminalOutcomes: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_TERMINAL_OUTCOMES_V1;
  keyRoles: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1;
  rules: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RULES_V1;
  maximumOwnerWindowSeconds: 300;
  maximumContextAndChildLifetimeSeconds: 60;
  maximumCleanupAfterExitSeconds: 120;
  maximumCleanupAfterIssueSeconds: 600;
  maximumFinalizationAfterCleanupSeconds: 30;
  maximumCurrentOwnerAuthorizations: 0;
  maximumCurrentReservationMaterializations: 0;
  maximumCurrentProductAttempts: 0;
  maximumCurrentProcesses: 0;
  maximumCurrentNativeCalls: 0;
  ownerPresentIssuerRequired: true;
  strongFactorRevisionRequired: true;
  completeBrokerBindingRequired: true;
  exactManifestTrustAndAnchorBindingRequired: true;
  providerSubjectScopeDigestsRequired: true;
  canonicalPrivateDestinationDigestsRequired: true;
  reservationIntentsAreNotCapabilities: true;
  postgresqlSoleGlobalWriteAuthorityRequired: true;
  independentAllOwnerHeadAnchorRequired: true;
  atomicOwnerConsumptionProductClosureRequired: true;
  noResumeAfterConsumptionUncertaintyRequired: true;
  sameModuleLexicalCapsuleRequired: true;
  closedPublicTerminalSchemaRequired: true;
  transitiveImportInertiaRequired: true;
  bodyExtraFieldsAllowed: false;
  envelopeExtraFieldsAllowed: false;
  reservationObjectInEnvelopeAllowed: false;
  callerDependencyInjectionAllowed: false;
  retryOrResumeAfterUncertaintyAllowed: false;
  issuerImplemented: false;
  storeImplemented: false;
  keyRolesImplemented: false;
  manifestOrTrustImplemented: false;
  independentAnchorImplemented: false;
  contextOrCleanupReservationImplemented: false;
  productionCapsuleImplemented: false;
  supplementaryProvidersImplemented: false;
  sourceOwnerModified: false;
  ipcOrProcessImplemented: false;
  nativeExecutionImplemented: false;
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

export type ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATUS_V1;
  contractReference: string;
  contractDigest: string;
  evidenceClass: "repository_contract_non_execution";
  contractState: "implemented_inert_unwired";
  ownerBodyState: "vocabulary_only";
  ownerEnvelopeState: "vocabulary_only";
  issuerState: "not_implemented";
  storeState: "not_implemented";
  anchorState: "not_implemented";
  capsuleState: "not_implemented";
  nativeAttemptState: "not_attempted";
  runtimeState: "not_wired";
  actualOwnerBodiesCreated: 0;
  actualOwnerEnvelopesCreated: 0;
  actualOwnerAuthorizationsIssued: 0;
  actualOwnerAuthorizationsRegistered: 0;
  actualOwnerAuthorizationSpends: 0;
  actualStrongFactorChecks: 0;
  actualOwnerPresentChecks: 0;
  actualNoncesIssued: 0;
  actualReservationIntentsIssued: 0;
  actualContextReservations: 0;
  actualCleanupReservations: 0;
  actualRegistrationTransactions: 0;
  actualConsumptionTransactions: 0;
  actualProductAttemptClosures: 0;
  actualPostgresqlReads: 0;
  actualPostgresqlWrites: 0;
  actualTrustedClockReads: 0;
  actualTrustRegistryReads: 0;
  actualManifestReads: 0;
  actualProtectedKeysResolved: 0;
  actualKeyOperations: 0;
  actualAnchorReads: 0;
  actualAnchorWrites: 0;
  actualAnchorCasRequests: 0;
  actualRecoveryQueries: 0;
  actualRecoveryWrites: 0;
  actualProductionCapsuleConstructions: 0;
  actualNativeSourceImports: 0;
  actualSourceOwnerModifications: 0;
  actualSourceLookups: 0;
  actualSourceInvocations: 0;
  actualRawObservations: 0;
  actualPrivacyTransforms: 0;
  actualProviderPreflights: 0;
  actualProviderReservations: 0;
  actualProviderCalls: 0;
  actualSignerCalls: 0;
  actualVerifierCalls: 0;
  actualAttestationWrites: 0;
  actualChildProcessesCreated: 0;
  actualIpcFrames: 0;
  actualProcessTerminations: 0;
  actualCleanupObserverCalls: 0;
  actualCleanupWrites: 0;
  actualFinalizerCalls: 0;
  actualPublicProjections: 0;
  actualReviewSubmissions: 0;
  actualCandidateAssemblies: 0;
  actualPhysicalAuthorizations: 0;
  actualPhysicalAttempts: 0;
  actualNativeListenerAttempts: 0;
  actualTimersCreated: 0;
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

export class ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "authorization_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "authorization_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "owner native authorization contract record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live470ProductCommit: "b1f1055f05bc4c53485caa89ddc456953fce4326",
  live470ProductTree: "a396d40e7c4c5f0c1dc3bab4d073b462863a408b",
  acceptedLive470ReviewedDesignSha256: "29980084a8d0fd1839a79e0f5402cc0f2038179bdecadd666295bd090497f7c4",
  acceptedLive470FinalDesignSha256: "ea4636bd9cb7a3ac78d774b5e8085e44089ef737e50b9c009cb79f7cdd99d8a6",
  acceptedLive470ReviewSha256: "252e5f80eaca7bf78d98d50601c3472f74e73e4cd8ee1879f5fa53c8ab0dad1f",
  acceptedLive470AcceptanceSha256: "41d6725a6cd55513a526f18a908a22270fa102d264c3d1f6ee0e6da31cbee7f5",
  productBindingFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_FIELDS_V1,
  productBindingRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_ROLES_V1,
  keyBindingFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_FIELDS_V1,
  productBindingSchema: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1,
  keyBindingSchema: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1,
  bodyFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1,
  envelopeFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1,
  reservationIntents: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RESERVATION_INTENTS_V1,
  providerSubjectScopes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROVIDER_SCOPES_V1,
  requiredCleanupFacts: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CLEANUP_FACTS_V1,
  allowedEffects: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ALLOWED_EFFECTS_V1,
  prohibitedEffects: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROHIBITED_EFFECTS_V1,
  publicTerminalFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PUBLIC_TERMINAL_FIELDS_V1,
  operationBudget: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_OPERATION_BUDGET_V1,
  authorizationStates: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATES_V1,
  terminalOutcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_TERMINAL_OUTCOMES_V1,
  keyRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RULES_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CONTRACT_V1,
  contractReference: `owner-native-authorization:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live470ProductCommit: "b1f1055f05bc4c53485caa89ddc456953fce4326" as const,
  live470ProductTree: "a396d40e7c4c5f0c1dc3bab4d073b462863a408b" as const,
  acceptedLive470ReviewedDesignSha256:
    "29980084a8d0fd1839a79e0f5402cc0f2038179bdecadd666295bd090497f7c4" as const,
  acceptedLive470FinalDesignSha256:
    "ea4636bd9cb7a3ac78d774b5e8085e44089ef737e50b9c009cb79f7cdd99d8a6" as const,
  acceptedLive470ReviewSha256:
    "252e5f80eaca7bf78d98d50601c3472f74e73e4cd8ee1879f5fa53c8ab0dad1f" as const,
  acceptedLive470AcceptanceSha256:
    "41d6725a6cd55513a526f18a908a22270fa102d264c3d1f6ee0e6da31cbee7f5" as const,
  productBindingFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_FIELDS_V1,
  productBindingRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_ROLES_V1,
  keyBindingFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_FIELDS_V1,
  productBindingSchema: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1,
  keyBindingSchema: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1,
  bodyFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1,
  envelopeFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1,
  reservationIntents: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RESERVATION_INTENTS_V1,
  providerSubjectScopes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROVIDER_SCOPES_V1,
  requiredCleanupFacts: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CLEANUP_FACTS_V1,
  allowedEffects: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ALLOWED_EFFECTS_V1,
  prohibitedEffects: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROHIBITED_EFFECTS_V1,
  publicTerminalFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PUBLIC_TERMINAL_FIELDS_V1,
  operationBudget: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_OPERATION_BUDGET_V1,
  authorizationStates: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATES_V1,
  terminalOutcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_TERMINAL_OUTCOMES_V1,
  keyRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RULES_V1,
  maximumOwnerWindowSeconds: 300 as const,
  maximumContextAndChildLifetimeSeconds: 60 as const,
  maximumCleanupAfterExitSeconds: 120 as const,
  maximumCleanupAfterIssueSeconds: 600 as const,
  maximumFinalizationAfterCleanupSeconds: 30 as const,
  maximumCurrentOwnerAuthorizations: 0 as const,
  maximumCurrentReservationMaterializations: 0 as const,
  maximumCurrentProductAttempts: 0 as const,
  maximumCurrentProcesses: 0 as const,
  maximumCurrentNativeCalls: 0 as const,
  ownerPresentIssuerRequired: true as const,
  strongFactorRevisionRequired: true as const,
  completeBrokerBindingRequired: true as const,
  exactManifestTrustAndAnchorBindingRequired: true as const,
  providerSubjectScopeDigestsRequired: true as const,
  canonicalPrivateDestinationDigestsRequired: true as const,
  reservationIntentsAreNotCapabilities: true as const,
  postgresqlSoleGlobalWriteAuthorityRequired: true as const,
  independentAllOwnerHeadAnchorRequired: true as const,
  atomicOwnerConsumptionProductClosureRequired: true as const,
  noResumeAfterConsumptionUncertaintyRequired: true as const,
  sameModuleLexicalCapsuleRequired: true as const,
  closedPublicTerminalSchemaRequired: true as const,
  transitiveImportInertiaRequired: true as const,
  bodyExtraFieldsAllowed: false as const,
  envelopeExtraFieldsAllowed: false as const,
  reservationObjectInEnvelopeAllowed: false as const,
  callerDependencyInjectionAllowed: false as const,
  retryOrResumeAfterUncertaintyAllowed: false as const,
  issuerImplemented: false as const,
  storeImplemented: false as const,
  keyRolesImplemented: false as const,
  manifestOrTrustImplemented: false as const,
  independentAnchorImplemented: false as const,
  contextOrCleanupReservationImplemented: false as const,
  productionCapsuleImplemented: false as const,
  supplementaryProvidersImplemented: false as const,
  sourceOwnerModified: false as const,
  ipcOrProcessImplemented: false as const,
  nativeExecutionImplemented: false as const,
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
export const connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
reflectApplyV1(weakSetAddV1, contractRecordsV1,
  [connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1,
  [connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
    connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1.contractDigest]);

const zeroActualsV1 = {
  actualOwnerBodiesCreated: 0 as const,
  actualOwnerEnvelopesCreated: 0 as const,
  actualOwnerAuthorizationsIssued: 0 as const,
  actualOwnerAuthorizationsRegistered: 0 as const,
  actualOwnerAuthorizationSpends: 0 as const,
  actualStrongFactorChecks: 0 as const,
  actualOwnerPresentChecks: 0 as const,
  actualNoncesIssued: 0 as const,
  actualReservationIntentsIssued: 0 as const,
  actualContextReservations: 0 as const,
  actualCleanupReservations: 0 as const,
  actualRegistrationTransactions: 0 as const,
  actualConsumptionTransactions: 0 as const,
  actualProductAttemptClosures: 0 as const,
  actualPostgresqlReads: 0 as const,
  actualPostgresqlWrites: 0 as const,
  actualTrustedClockReads: 0 as const,
  actualTrustRegistryReads: 0 as const,
  actualManifestReads: 0 as const,
  actualProtectedKeysResolved: 0 as const,
  actualKeyOperations: 0 as const,
  actualAnchorReads: 0 as const,
  actualAnchorWrites: 0 as const,
  actualAnchorCasRequests: 0 as const,
  actualRecoveryQueries: 0 as const,
  actualRecoveryWrites: 0 as const,
  actualProductionCapsuleConstructions: 0 as const,
  actualNativeSourceImports: 0 as const,
  actualSourceOwnerModifications: 0 as const,
  actualSourceLookups: 0 as const,
  actualSourceInvocations: 0 as const,
  actualRawObservations: 0 as const,
  actualPrivacyTransforms: 0 as const,
  actualProviderPreflights: 0 as const,
  actualProviderReservations: 0 as const,
  actualProviderCalls: 0 as const,
  actualSignerCalls: 0 as const,
  actualVerifierCalls: 0 as const,
  actualAttestationWrites: 0 as const,
  actualChildProcessesCreated: 0 as const,
  actualIpcFrames: 0 as const,
  actualProcessTerminations: 0 as const,
  actualCleanupObserverCalls: 0 as const,
  actualCleanupWrites: 0 as const,
  actualFinalizerCalls: 0 as const,
  actualPublicProjections: 0 as const,
  actualReviewSubmissions: 0 as const,
  actualCandidateAssemblies: 0 as const,
  actualPhysicalAuthorizations: 0 as const,
  actualPhysicalAttempts: 0 as const,
  actualNativeListenerAttempts: 0 as const,
  actualTimersCreated: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualExternalProviderCalls: 0 as const,
  actualProtectedValuesRead: 0 as const,
  actualCommandsExecuted: 0 as const,
  actualDeployments: 0 as const,
  actualDnsChanges: 0 as const,
  actualTerminalAmbiguities: 0 as const,
};

const statusKeysV1 = objectFreezeV1([
  "statusVersion", "contractReference", "contractDigest", "evidenceClass", "contractState", "ownerBodyState",
  "ownerEnvelopeState", "issuerState", "storeState", "anchorState", "capsuleState", "nativeAttemptState",
  "runtimeState", "actualOwnerBodiesCreated", "actualOwnerEnvelopesCreated", "actualOwnerAuthorizationsIssued",
  "actualOwnerAuthorizationsRegistered", "actualOwnerAuthorizationSpends", "actualStrongFactorChecks",
  "actualOwnerPresentChecks", "actualNoncesIssued", "actualReservationIntentsIssued", "actualContextReservations",
  "actualCleanupReservations", "actualRegistrationTransactions", "actualConsumptionTransactions",
  "actualProductAttemptClosures", "actualPostgresqlReads", "actualPostgresqlWrites", "actualTrustedClockReads",
  "actualTrustRegistryReads", "actualManifestReads", "actualProtectedKeysResolved", "actualKeyOperations",
  "actualAnchorReads", "actualAnchorWrites", "actualAnchorCasRequests", "actualRecoveryQueries",
  "actualRecoveryWrites", "actualProductionCapsuleConstructions", "actualNativeSourceImports",
  "actualSourceOwnerModifications", "actualSourceLookups", "actualSourceInvocations", "actualRawObservations",
  "actualPrivacyTransforms", "actualProviderPreflights", "actualProviderReservations", "actualProviderCalls",
  "actualSignerCalls", "actualVerifierCalls", "actualAttestationWrites", "actualChildProcessesCreated",
  "actualIpcFrames", "actualProcessTerminations", "actualCleanupObserverCalls", "actualCleanupWrites",
  "actualFinalizerCalls", "actualPublicProjections", "actualReviewSubmissions", "actualCandidateAssemblies",
  "actualPhysicalAuthorizations", "actualPhysicalAttempts", "actualNativeListenerAttempts", "actualTimersCreated",
  "actualNetworkIoEvents", "actualExternalProviderCalls", "actualProtectedValuesRead", "actualCommandsExecuted",
  "actualDeployments", "actualDnsChanges", "actualTerminalAmbiguities", "externalEffectOccurred",
  "targetRuntimeBlockerCleared", "physicalQualificationAccepted", "candidateEligible", "activationEligible",
  "runtimeWired", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
  "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
  "grantsExecutionAuthority", "statusDigest",
] as const);

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1.contractDigest,
  evidenceClass: "repository_contract_non_execution" as const,
  contractState: "implemented_inert_unwired" as const,
  ownerBodyState: "vocabulary_only" as const,
  ownerEnvelopeState: "vocabulary_only" as const,
  issuerState: "not_implemented" as const,
  storeState: "not_implemented" as const,
  anchorState: "not_implemented" as const,
  capsuleState: "not_implemented" as const,
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
export const connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1,
    connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "contractReference", "live470ProductCommit", "live470ProductTree",
    "acceptedLive470ReviewedDesignSha256", "acceptedLive470FinalDesignSha256", "acceptedLive470ReviewSha256",
    "acceptedLive470AcceptanceSha256", "productBindingFields", "productBindingRoles", "keyBindingFields",
    "productBindingSchema", "keyBindingSchema",
    "bodyFields", "envelopeFields", "reservationIntents",
    "providerSubjectScopes", "requiredCleanupFacts", "allowedEffects", "prohibitedEffects", "publicTerminalFields",
    "operationBudget", "authorizationStates", "terminalOutcomes", "keyRoles", "rules",
    "maximumOwnerWindowSeconds", "maximumContextAndChildLifetimeSeconds", "maximumCleanupAfterExitSeconds",
    "maximumCleanupAfterIssueSeconds", "maximumFinalizationAfterCleanupSeconds",
    "maximumCurrentOwnerAuthorizations", "maximumCurrentReservationMaterializations",
    "maximumCurrentProductAttempts", "maximumCurrentProcesses", "maximumCurrentNativeCalls",
    "ownerPresentIssuerRequired", "strongFactorRevisionRequired", "completeBrokerBindingRequired",
    "exactManifestTrustAndAnchorBindingRequired", "providerSubjectScopeDigestsRequired",
    "canonicalPrivateDestinationDigestsRequired", "reservationIntentsAreNotCapabilities",
    "postgresqlSoleGlobalWriteAuthorityRequired", "independentAllOwnerHeadAnchorRequired",
    "atomicOwnerConsumptionProductClosureRequired", "noResumeAfterConsumptionUncertaintyRequired",
    "sameModuleLexicalCapsuleRequired", "closedPublicTerminalSchemaRequired", "transitiveImportInertiaRequired",
    "bodyExtraFieldsAllowed", "envelopeExtraFieldsAllowed", "reservationObjectInEnvelopeAllowed",
    "callerDependencyInjectionAllowed", "retryOrResumeAfterUncertaintyAllowed", "issuerImplemented",
    "storeImplemented", "keyRolesImplemented", "manifestOrTrustImplemented", "independentAnchorImplemented",
    "contextOrCleanupReservationImplemented", "productionCapsuleImplemented", "supplementaryProvidersImplemented",
    "sourceOwnerModified", "ipcOrProcessImplemented", "nativeExecutionImplemented", "runtimeWired",
    "repositoryContractOnly", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "contractDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  const requiredTrue = [record.ownerPresentIssuerRequired, record.strongFactorRevisionRequired,
    record.completeBrokerBindingRequired, record.exactManifestTrustAndAnchorBindingRequired,
    record.providerSubjectScopeDigestsRequired, record.canonicalPrivateDestinationDigestsRequired,
    record.reservationIntentsAreNotCapabilities, record.postgresqlSoleGlobalWriteAuthorityRequired,
    record.independentAllOwnerHeadAnchorRequired, record.atomicOwnerConsumptionProductClosureRequired,
    record.noResumeAfterConsumptionUncertaintyRequired, record.sameModuleLexicalCapsuleRequired,
    record.closedPublicTerminalSchemaRequired, record.transitiveImportInertiaRequired, record.repositoryContractOnly];
  const requiredFalse = [record.bodyExtraFieldsAllowed, record.envelopeExtraFieldsAllowed,
    record.reservationObjectInEnvelopeAllowed, record.callerDependencyInjectionAllowed,
    record.retryOrResumeAfterUncertaintyAllowed, record.issuerImplemented, record.storeImplemented,
    record.keyRolesImplemented, record.manifestOrTrustImplemented, record.independentAnchorImplemented,
    record.contextOrCleanupReservationImplemented, record.productionCapsuleImplemented,
    record.supplementaryProvidersImplemented, record.sourceOwnerModified, record.ipcOrProcessImplemented,
    record.nativeExecutionImplemented, record.runtimeWired, record.grantsApproval,
    record.grantsQualificationAuthority, record.grantsCandidateAuthority, record.grantsActivationAuthority,
    record.grantsNetworkAuthority, record.grantsCommandAuthority, record.grantsLeaseAuthority,
    record.grantsExecutionAuthority];
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1
    || record.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CONTRACT_V1
    || record.live470ProductCommit !== "b1f1055f05bc4c53485caa89ddc456953fce4326"
    || record.live470ProductTree !== "a396d40e7c4c5f0c1dc3bab4d073b462863a408b"
    || record.productBindingFields !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_FIELDS_V1
    || record.productBindingRoles !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_ROLES_V1
    || record.keyBindingFields !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_FIELDS_V1
    || record.productBindingSchema !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1
    || record.keyBindingSchema !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1
    || record.bodyFields !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1
    || record.envelopeFields !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1
    || record.reservationIntents !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RESERVATION_INTENTS_V1
    || record.providerSubjectScopes !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROVIDER_SCOPES_V1
    || record.requiredCleanupFacts !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CLEANUP_FACTS_V1
    || record.allowedEffects !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ALLOWED_EFFECTS_V1
    || record.prohibitedEffects !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROHIBITED_EFFECTS_V1
    || record.publicTerminalFields !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PUBLIC_TERMINAL_FIELDS_V1
    || record.operationBudget !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_OPERATION_BUDGET_V1
    || record.authorizationStates !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATES_V1
    || record.terminalOutcomes !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_TERMINAL_OUTCOMES_V1
    || record.keyRoles !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1
    || record.rules !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RULES_V1
    || record.maximumOwnerWindowSeconds !== 300 || record.maximumContextAndChildLifetimeSeconds !== 60
    || record.maximumCleanupAfterExitSeconds !== 120 || record.maximumCleanupAfterIssueSeconds !== 600
    || record.maximumFinalizationAfterCleanupSeconds !== 30 || record.maximumCurrentOwnerAuthorizations !== 0
    || record.maximumCurrentReservationMaterializations !== 0 || record.maximumCurrentProductAttempts !== 0
    || record.maximumCurrentProcesses !== 0 || record.maximumCurrentNativeCalls !== 0
    || requiredTrue.length !== 15 || reflectApplyV1(arraySomeV1, requiredTrue, [(entry: boolean) => entry !== true])
    || requiredFalse.length !== 25 || reflectApplyV1(arraySomeV1, requiredFalse, [(entry: boolean) => entry !== false])) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1;
  const captured = exactHostDataSnapshotV1(record, statusKeysV1);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const actuals = [record.actualOwnerBodiesCreated, record.actualOwnerEnvelopesCreated,
    record.actualOwnerAuthorizationsIssued, record.actualOwnerAuthorizationsRegistered,
    record.actualOwnerAuthorizationSpends, record.actualStrongFactorChecks, record.actualOwnerPresentChecks,
    record.actualNoncesIssued, record.actualReservationIntentsIssued, record.actualContextReservations,
    record.actualCleanupReservations, record.actualRegistrationTransactions, record.actualConsumptionTransactions,
    record.actualProductAttemptClosures, record.actualPostgresqlReads, record.actualPostgresqlWrites,
    record.actualTrustedClockReads, record.actualTrustRegistryReads, record.actualManifestReads,
    record.actualProtectedKeysResolved, record.actualKeyOperations, record.actualAnchorReads, record.actualAnchorWrites,
    record.actualAnchorCasRequests, record.actualRecoveryQueries, record.actualRecoveryWrites,
    record.actualProductionCapsuleConstructions, record.actualNativeSourceImports, record.actualSourceOwnerModifications,
    record.actualSourceLookups, record.actualSourceInvocations, record.actualRawObservations,
    record.actualPrivacyTransforms, record.actualProviderPreflights, record.actualProviderReservations,
    record.actualProviderCalls, record.actualSignerCalls, record.actualVerifierCalls, record.actualAttestationWrites,
    record.actualChildProcessesCreated, record.actualIpcFrames, record.actualProcessTerminations,
    record.actualCleanupObserverCalls, record.actualCleanupWrites, record.actualFinalizerCalls,
    record.actualPublicProjections, record.actualReviewSubmissions, record.actualCandidateAssemblies,
    record.actualPhysicalAuthorizations, record.actualPhysicalAttempts, record.actualNativeListenerAttempts,
    record.actualTimersCreated, record.actualNetworkIoEvents, record.actualExternalProviderCalls,
    record.actualProtectedValuesRead, record.actualCommandsExecuted, record.actualDeployments, record.actualDnsChanges,
    record.actualTerminalAmbiguities];
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1
    || record.contractReference !== connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1.contractReference
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1.contractDigest
    || record.evidenceClass !== "repository_contract_non_execution"
    || record.contractState !== "implemented_inert_unwired" || record.ownerBodyState !== "vocabulary_only"
    || record.ownerEnvelopeState !== "vocabulary_only" || record.issuerState !== "not_implemented"
    || record.storeState !== "not_implemented" || record.anchorState !== "not_implemented"
    || record.capsuleState !== "not_implemented" || record.nativeAttemptState !== "not_attempted"
    || record.runtimeState !== "not_wired"
    || actuals.length !== 59 || reflectApplyV1(arraySomeV1, actuals, [(entry: number) => entry !== 0])
    || grants.length !== 8 || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])
    || record.externalEffectOccurred || record.targetRuntimeBlockerCleared || record.physicalQualificationAccepted
    || record.candidateEligible || record.activationEligible || record.runtimeWired) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1);
