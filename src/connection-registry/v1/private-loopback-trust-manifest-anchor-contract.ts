import { sha256Digest } from "../../security/canonical-digest";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";
import { assertNoSecretMaterial } from "../../security/redaction";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1,
} from "./private-loopback-owner-native-authorization-contract";

const arraySomeV1 = Array.prototype.some;
const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-trust-manifest-anchor-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-trust-manifest-anchor-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_PIN_FIELDS_V1 = objectFreezeV1([
  "pin_schema_version",
  "deployment_product_commit",
  "deployment_product_tree",
  "owner_root_public_key_algorithm",
  "owner_root_key_id_digest",
  "owner_root_revision",
  "owner_root_sha256_fingerprint",
  "replacement_policy_digest",
  "pin_product_review_sha256",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_SIGNATURE_SCOPES_V1 = objectFreezeV1([
  "trust_registry_genesis",
  "trust_registry_revision",
  "dual_signed_owner_root_rotation_statement",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_FIELDS_V1 = objectFreezeV1([
  "rotation_schema_version",
  "prior_root_key_id_digest",
  "prior_root_revision",
  "prior_root_sha256_fingerprint",
  "successor_root_key_id_digest",
  "successor_root_public_key_algorithm",
  "successor_root_revision",
  "successor_root_sha256_fingerprint",
  "newly_pinned_deployment_product_commit",
  "newly_pinned_deployment_product_tree",
  "newly_pinned_deployment_product_review_sha256",
  "rotation_reason",
  "not_before",
  "expires_at",
  "prior_root_signature",
  "successor_root_signature",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_FIELDS_V1 = objectFreezeV1([
  "role",
  "key_id_digest",
  "algorithm",
  "fingerprint",
  "revision",
  "status",
  "not_before",
  "expires_at",
  "revoked_at_or_zero",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_STATUSES_V1 = objectFreezeV1([
  "pending",
  "active",
  "verification_only",
  "revoked",
  "destroyed",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1 = objectFreezeV1({
  fields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_FIELDS_V1,
  allowedRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1,
  statuses: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_STATUSES_V1,
  ordering: "role_order_then_revision_ascending" as const,
  uniqueBy: "role_and_revision" as const,
  everyRoleRequired: true as const,
  atLeastOneCurrentActiveRevisionPerRequiredRole: true as const,
  maximumActiveRevisionsPerRoleDuringDeclaredOverlap: 2 as const,
  maximumActiveRevisionsPerRoleOutsideDeclaredOverlap: 1 as const,
  extraFieldsAllowed: false as const,
});

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_LIFECYCLE_RULES_V1 = objectFreezeV1([
  "activation_requires_current_manifest_role_purpose_scope_and_time",
  "all_key_material_is_pairwise_byte_distinct_across_roles_and_revisions",
  "public_key_bytes_cannot_equal_any_other_role_key_bytes",
  "rotation_adopts_trust_revision_before_dependent_manifest",
  "rotation_overlap_is_explicit_and_at_most_300_seconds",
  "old_active_key_moves_to_verification_only_or_revoked_after_manifest_advance",
  "historical_public_verification_keys_are_retained",
  "historical_symmetric_keys_accept_only_existing_records_for_verification",
  "historical_keys_cannot_authenticate_or_sign_new_writes",
  "each_key_epoch_cross_links_prior_epoch_final_revision_and_digest",
  "revocation_stops_new_writes_and_quarantines_dependent_unsettled_attempts",
  "destruction_requires_separately_accepted_archive_retention_proof",
  "unknown_key_state_is_terminal",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_BODY_FIELDS_V1 = objectFreezeV1([
  "registry_schema_version",
  "registry_id_digest",
  "registry_sequence",
  "prior_registry_digest",
  "policy_revision",
  "product_catalog_revision",
  "ordered_key_entries",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SIGNED_ENVELOPE_FIELDS_V1 = objectFreezeV1([
  "envelope_version",
  "codec_version",
  "signature_algorithm",
  "body",
  "canonical_body_digest",
  "signing_key_id_digest",
  "signing_key_fingerprint",
  "signing_key_revision",
  "authentication_tag",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_DEPLOYMENT_MANIFEST_BODY_FIELDS_V1 = objectFreezeV1([
  "manifest_schema_version",
  "manifest_id_digest",
  "manifest_sequence",
  "prior_manifest_digest",
  "policy_revision",
  "product_catalog_revision",
  "trust_registry_id_digest",
  "trust_registry_sequence",
  "trust_registry_digest",
  "trust_registry_anchor_revision",
  "trust_registry_anchor_head_digest",
  "manifest_anchor_revision",
  "manifest_anchor_head_digest",
  "tenant_id_digest",
  "project_id_digest",
  "connection_id_digest",
  "node_id_digest",
  "target_platform_family",
  "target_runtime_family",
  "deployment_id_digest",
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
  "ordered_key_role_bindings",
  "allowed_effect_classes",
  "prohibited_effect_classes",
  "prohibited_effect_ceilings_digest",
  "manifest_not_before",
  "manifest_expires_at",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INDEPENDENT_ANCHOR_ROLES_V1 = objectFreezeV1([
  "trust_registry_anchor",
  "deployment_manifest_anchor",
  "composite_owner_attempt_anchor",
  "attestation_anchor",
  "cleanup_anchor",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_STATE_FIELDS_V1 = objectFreezeV1([
  "anchor_schema_version",
  "anchor_role",
  "stream_id_digest",
  "monotonic_revision",
  "authenticated_head_digest",
  "last_request_id_digest",
  "authentication_tag",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_REQUEST_FIELDS_V1 = objectFreezeV1([
  "request_schema_version",
  "anchor_role",
  "stream_id_digest",
  "request_id_digest",
  "expected_revision",
  "expected_head_digest",
  "desired_revision",
  "desired_head_digest",
  "deadline_at",
  "writer_key_binding_digest",
  "request_authentication_tag",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_FIELDS_V1 = objectFreezeV1([
  "receipt_schema_version",
  "anchor_role",
  "stream_id_digest",
  "request_id_digest",
  "observed_prior_revision",
  "observed_prior_head_digest",
  "settled_revision",
  "settled_head_digest",
  "settlement",
  "settled_at",
  "receipt_authentication_tag",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_REVISION_STATES_V1 = objectFreezeV1([
  "pending_anchor",
  "adopted",
  "revoked",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SPLIT_COMMIT_RECOVERY_CASES_V1 = objectFreezeV1([
  "pending_database_and_old_anchor_reissue_identical_cas_only",
  "pending_database_and_exact_desired_anchor_finalize_predetermined_adoption",
  "adopted_database_and_matching_anchor_read_current",
  "old_database_and_anchor_ahead_quarantine",
  "database_ahead_and_anchor_old_or_different_quarantine",
  "missing_database_record_quarantine",
  "forked_chain_quarantine",
  "unknown_cas_outcome_quarantine",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_QUARANTINE_TRIGGERS_V1 = objectFreezeV1([
  "missing_component_or_key",
  "substituted_component_or_key",
  "duplicated_component_or_key",
  "revoked_component_key_or_manifest",
  "expired_component_key_or_manifest",
  "wrong_scope_product_key_or_anchor",
  "behaviorally_supplied_component",
  "unreviewed_component_product",
  "signature_or_chain_mismatch",
  "anchor_or_database_rollback_fork_or_uncertainty",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_PROHIBITED_EFFECTS_V1 = objectFreezeV1([
  "key_generation_import_read_write_export_or_destruction",
  "signature_or_verification_operation",
  "trust_registry_read_or_write",
  "deployment_manifest_read_or_write",
  "anchor_read_write_or_compare_and_swap",
  "database_read_write_migration_or_transaction",
  "filesystem_environment_host_process_or_clock_read",
  "credential_or_secret_store_access",
  "source_or_provider_lookup_or_invocation",
  "capsule_construction",
  "listener_socket_or_network_access",
  "timer_handler_or_process_creation",
  "arbitrary_command_or_shell",
  "ssh_mcp_or_plugin",
  "application_or_runtime_activation",
  "candidate_assembly_or_physical_qualification",
  "deployment_dns_or_hosting_change",
  "public_endpoint_or_non_private_network",
  "caller_dependency_injection_or_generic_locator",
  "every_undeclared_effect",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_RULES_V1 = objectFreezeV1([
  "bind_exact_accepted_live_480_product_tree_review_and_acceptance",
  "pin_one_owner_root_algorithm_key_id_revision_and_fingerprint_out_of_band",
  "forbid_database_environment_manifest_registry_or_runtime_from_replacing_owner_root_pin",
  "keep_owner_root_private_key_offline_and_out_of_runtime",
  "limit_owner_root_signatures_to_three_exact_scopes",
  "require_dual_root_signatures_and_newly_pinned_deployment_product_for_normal_root_rotation",
  "forbid_automatic_root_rotation_when_compromise_makes_old_root_unavailable",
  "make_trust_registry_a_strict_canonical_owner_root_signed_chain",
  "make_registry_sequence_monotonic_and_prior_digest_zero_only_at_genesis",
  "order_registry_keys_by_role_then_revision_and_require_unique_role_revision_pairs",
  "require_exact_key_roles_statuses_time_intervals_and_pairwise_distinct_material",
  "permit_only_explicit_bounded_300_second_rotation_overlap",
  "retain_historical_keys_for_verification_only_and_forbid_new_writes",
  "make_unknown_revoked_or_destroyed_key_state_fail_closed",
  "make_deployment_manifest_canonical_immutable_and_manifest_key_signed",
  "bind_live440_live450_live460_and_all_42_component_product_tree_review_identities",
  "bind_all_28_key_roles_to_exact_current_registry_entries",
  "bind_exact_tenant_project_connection_node_platform_runtime_deployment_and_policy",
  "bind_current_registry_manifest_and_both_current_anchor_heads",
  "bind_allowed_effects_and_zero_ceilings_for_every_prohibited_effect",
  "keep_manifest_signer_distinct_from_every_runtime_and_business_state_key",
  "separate_all_five_anchor_roles_writer_keys_and_custody_boundaries",
  "limit_anchor_state_to_stream_revision_head_last_request_and_authentication",
  "forbid_anchors_from_storing_or_deciding_business_state",
  "forbid_cross_role_anchor_adoption",
  "append_pending_database_revision_before_one_exact_idempotent_anchor_cas",
  "append_adopted_only_after_exact_receipt_and_current_anchor_verification",
  "reject_old_valid_signature_after_authenticated_anchor_advances",
  "apply_exact_closed_split_commit_recovery_matrix",
  "permit_recovery_to_reissue_only_the_byte_identical_stored_cas_request",
  "forbid_recovery_from_reconstructing_signing_substituting_rolling_back_or_activating",
  "quarantine_compromise_fork_missing_state_and_every_unknown_outcome",
  "use_postgresql_as_sole_global_write_authority",
  "perform_no_import_time_or_contract_construction_host_or_protected_read",
  "keep_complete_transitive_production_import_graph_inert",
  "export_no_signer_resolver_reader_writer_store_cas_or_dependency_factory",
  "grant_no_approval_qualification_candidate_activation_network_command_lease_or_execution_authority",
] as const);

export class ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "trust_material_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "trust_material_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "trust manifest anchor contract record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live480ProductCommit: "6d510d6f1b80a98c00c16fcf2b55837afc1cea87",
  live480ProductTree: "ac8655e1240d25bea9150ae9678f6ad5df56593c",
  acceptedLive480ReviewSha256: "854d3688cd9a02dd57d2c645580d8c195e577e3673bedcdf11ba0073af14e71d",
  acceptedLive480AcceptanceSha256: "5f549c3f05ce77cd5a536e9b711a4e7a1c5bddde7ee8d75fd68474fe6578ab46",
  ownerRootPinFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_PIN_FIELDS_V1,
  ownerRootSignatureScopes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_SIGNATURE_SCOPES_V1,
  ownerRootRotationFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_FIELDS_V1,
  trustRegistryKeyEntrySchema: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1,
  keyLifecycleRules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_LIFECYCLE_RULES_V1,
  trustRegistryBodyFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_BODY_FIELDS_V1,
  signedEnvelopeFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SIGNED_ENVELOPE_FIELDS_V1,
  deploymentManifestBodyFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_DEPLOYMENT_MANIFEST_BODY_FIELDS_V1,
  independentAnchorRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INDEPENDENT_ANCHOR_ROLES_V1,
  anchorStateFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_STATE_FIELDS_V1,
  anchorCasRequestFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_REQUEST_FIELDS_V1,
  anchorCasReceiptFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_FIELDS_V1,
  revisionStates: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_REVISION_STATES_V1,
  splitCommitRecoveryCases: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SPLIT_COMMIT_RECOVERY_CASES_V1,
  quarantineTriggers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_QUARANTINE_TRIGGERS_V1,
  prohibitedEffects: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_PROHIBITED_EFFECTS_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_RULES_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_CONTRACT_V1,
  contractReference: `trust-manifest-anchor:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live480ProductCommit: "6d510d6f1b80a98c00c16fcf2b55837afc1cea87" as const,
  live480ProductTree: "ac8655e1240d25bea9150ae9678f6ad5df56593c" as const,
  acceptedLive480ReviewSha256: "854d3688cd9a02dd57d2c645580d8c195e577e3673bedcdf11ba0073af14e71d" as const,
  acceptedLive480AcceptanceSha256: "5f549c3f05ce77cd5a536e9b711a4e7a1c5bddde7ee8d75fd68474fe6578ab46" as const,
  acceptedProductBindingSchema:
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1,
  acceptedKeyBindingSchema:
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1,
  acceptedKeyRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1,
  ownerRootPinFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_PIN_FIELDS_V1,
  ownerRootSignatureScopes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_SIGNATURE_SCOPES_V1,
  ownerRootRotationFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_FIELDS_V1,
  trustRegistryKeyEntryFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_FIELDS_V1,
  trustRegistryKeyStatuses: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_STATUSES_V1,
  trustRegistryKeyEntrySchema: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1,
  keyLifecycleRules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_LIFECYCLE_RULES_V1,
  trustRegistryBodyFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_BODY_FIELDS_V1,
  signedEnvelopeFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SIGNED_ENVELOPE_FIELDS_V1,
  deploymentManifestBodyFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_DEPLOYMENT_MANIFEST_BODY_FIELDS_V1,
  independentAnchorRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INDEPENDENT_ANCHOR_ROLES_V1,
  anchorStateFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_STATE_FIELDS_V1,
  anchorCasRequestFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_REQUEST_FIELDS_V1,
  anchorCasReceiptFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_FIELDS_V1,
  revisionStates: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_REVISION_STATES_V1,
  splitCommitRecoveryCases: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SPLIT_COMMIT_RECOVERY_CASES_V1,
  quarantineTriggers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_QUARANTINE_TRIGGERS_V1,
  prohibitedEffects: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_PROHIBITED_EFFECTS_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_RULES_V1,
  maximumRotationOverlapSeconds: 300 as const,
  maximumCurrentOwnerRootPins: 0 as const,
  maximumCurrentKeyEntries: 0 as const,
  maximumCurrentTrustRegistryRevisions: 0 as const,
  maximumCurrentDeploymentManifestRevisions: 0 as const,
  maximumCurrentAnchorStates: 0 as const,
  maximumCurrentProtectedOperations: 0 as const,
  outOfBandOwnerRootRequired: true as const,
  ownerRootSigningMaterialOfflineRequired: true as const,
  pairwiseDistinctKeyMaterialRequired: true as const,
  exactProductAndKeyBindingsRequired: true as const,
  allFiveAnchorsIndependentRequired: true as const,
  postgresqlSoleGlobalWriteAuthorityRequired: true as const,
  transitiveImportInertiaRequired: true as const,
  rootRuntimeSigningAllowed: false as const,
  rootPinReplaceableByRuntime: false as const,
  rootPinReplaceableByDatabase: false as const,
  rootPinReplaceableByManifest: false as const,
  rootPinReplaceableByTrustRegistry: false as const,
  automaticCompromiseRotationAllowed: false as const,
  historicalKeyNewWritesAllowed: false as const,
  anchorBusinessStateAllowed: false as const,
  crossRoleAnchorAdoptionAllowed: false as const,
  recoveryMaySignSubstituteRollbackOrActivate: false as const,
  callerDependencyInjectionAllowed: false as const,
  rootPinImplemented: false as const,
  keyRegistryImplemented: false as const,
  manifestImplemented: false as const,
  anchorImplemented: false as const,
  signerOrVerifierImplemented: false as const,
  storeOrMigrationImplemented: false as const,
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
export const connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
export type ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1 =
  Readonly<typeof connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1>;
reflectApplyV1(weakSetAddV1, contractRecordsV1, [connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1, [connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
  connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1.contractDigest]);

const zeroActualsV1 = {
  actualOwnerRootPinsLoaded: 0 as const,
  actualOwnerRootRotationStatements: 0 as const,
  actualTrustRegistryBodiesCreated: 0 as const,
  actualTrustRegistryEnvelopesCreated: 0 as const,
  actualTrustRegistryRevisionsRead: 0 as const,
  actualTrustRegistryRevisionsWritten: 0 as const,
  actualManifestBodiesCreated: 0 as const,
  actualManifestEnvelopesCreated: 0 as const,
  actualManifestRevisionsRead: 0 as const,
  actualManifestRevisionsWritten: 0 as const,
  actualKeyEntriesCreated: 0 as const,
  actualKeyValuesGenerated: 0 as const,
  actualKeyValuesRead: 0 as const,
  actualKeyValuesWritten: 0 as const,
  actualKeyValuesExported: 0 as const,
  actualKeyRotations: 0 as const,
  actualKeyRevocations: 0 as const,
  actualKeyDestructions: 0 as const,
  actualSignatures: 0 as const,
  actualVerifications: 0 as const,
  actualAnchorStatesCreated: 0 as const,
  actualAnchorReads: 0 as const,
  actualAnchorWrites: 0 as const,
  actualAnchorCasRequests: 0 as const,
  actualAnchorCasReceipts: 0 as const,
  actualRecoveryQueries: 0 as const,
  actualRecoveryWrites: 0 as const,
  actualQuarantines: 0 as const,
  actualPostgresqlReads: 0 as const,
  actualPostgresqlWrites: 0 as const,
  actualMigrations: 0 as const,
  actualFilesystemReads: 0 as const,
  actualEnvironmentReads: 0 as const,
  actualHostReads: 0 as const,
  actualClockReads: 0 as const,
  actualCredentialStoreReads: 0 as const,
  actualCapsuleConstructions: 0 as const,
  actualSourceOrProviderCalls: 0 as const,
  actualProcessesCreated: 0 as const,
  actualTimersCreated: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualNativeAttempts: 0 as const,
  actualDeployments: 0 as const,
  actualDnsOrHostingChanges: 0 as const,
};

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1.contractDigest,
  evidenceClass: "repository_contract_non_execution" as const,
  contractState: "implemented_inert_unwired" as const,
  ownerRootState: "vocabulary_only" as const,
  keyRegistryState: "vocabulary_only" as const,
  manifestState: "vocabulary_only" as const,
  anchorState: "vocabulary_only" as const,
  signerState: "not_implemented" as const,
  storeState: "not_implemented" as const,
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
export const connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
export type ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1 =
  Readonly<typeof connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1>;
reflectApplyV1(weakSetAddV1, statusRecordsV1, [connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1, [connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1,
  connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1.statusDigest]);

const contractKeysV1 = objectFreezeV1([
  "contractVersion", "contractReference", "live480ProductCommit", "live480ProductTree",
  "acceptedLive480ReviewSha256", "acceptedLive480AcceptanceSha256", "acceptedProductBindingSchema",
  "acceptedKeyBindingSchema", "acceptedKeyRoles", "ownerRootPinFields", "ownerRootSignatureScopes",
  "ownerRootRotationFields", "trustRegistryKeyEntryFields", "trustRegistryKeyStatuses",
  "trustRegistryKeyEntrySchema", "keyLifecycleRules", "trustRegistryBodyFields", "signedEnvelopeFields",
  "deploymentManifestBodyFields", "independentAnchorRoles", "anchorStateFields", "anchorCasRequestFields",
  "anchorCasReceiptFields", "revisionStates", "splitCommitRecoveryCases", "quarantineTriggers",
  "prohibitedEffects", "rules", "maximumRotationOverlapSeconds", "maximumCurrentOwnerRootPins",
  "maximumCurrentKeyEntries", "maximumCurrentTrustRegistryRevisions", "maximumCurrentDeploymentManifestRevisions",
  "maximumCurrentAnchorStates", "maximumCurrentProtectedOperations", "outOfBandOwnerRootRequired",
  "ownerRootSigningMaterialOfflineRequired", "pairwiseDistinctKeyMaterialRequired", "exactProductAndKeyBindingsRequired",
  "allFiveAnchorsIndependentRequired", "postgresqlSoleGlobalWriteAuthorityRequired",
  "transitiveImportInertiaRequired", "rootRuntimeSigningAllowed", "rootPinReplaceableByRuntime",
  "rootPinReplaceableByDatabase", "rootPinReplaceableByManifest", "rootPinReplaceableByTrustRegistry",
  "automaticCompromiseRotationAllowed", "historicalKeyNewWritesAllowed", "anchorBusinessStateAllowed",
  "crossRoleAnchorAdoptionAllowed", "recoveryMaySignSubstituteRollbackOrActivate",
  "callerDependencyInjectionAllowed", "rootPinImplemented", "keyRegistryImplemented", "manifestImplemented",
  "anchorImplemented", "signerOrVerifierImplemented", "storeOrMigrationImplemented", "runtimeWired",
  "repositoryContractOnly", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
  "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
  "grantsExecutionAuthority", "contractDigest",
] as const);

const statusKeysV1 = objectFreezeV1([
  "statusVersion", "contractReference", "contractDigest", "evidenceClass", "contractState", "ownerRootState",
  "keyRegistryState", "manifestState", "anchorState", "signerState", "storeState", "runtimeState",
  "actualOwnerRootPinsLoaded", "actualOwnerRootRotationStatements", "actualTrustRegistryBodiesCreated",
  "actualTrustRegistryEnvelopesCreated", "actualTrustRegistryRevisionsRead", "actualTrustRegistryRevisionsWritten",
  "actualManifestBodiesCreated", "actualManifestEnvelopesCreated", "actualManifestRevisionsRead",
  "actualManifestRevisionsWritten", "actualKeyEntriesCreated", "actualKeyValuesGenerated", "actualKeyValuesRead",
  "actualKeyValuesWritten", "actualKeyValuesExported", "actualKeyRotations", "actualKeyRevocations",
  "actualKeyDestructions", "actualSignatures", "actualVerifications", "actualAnchorStatesCreated",
  "actualAnchorReads", "actualAnchorWrites", "actualAnchorCasRequests", "actualAnchorCasReceipts",
  "actualRecoveryQueries", "actualRecoveryWrites", "actualQuarantines", "actualPostgresqlReads",
  "actualPostgresqlWrites", "actualMigrations", "actualFilesystemReads", "actualEnvironmentReads", "actualHostReads",
  "actualClockReads", "actualCredentialStoreReads", "actualCapsuleConstructions", "actualSourceOrProviderCalls",
  "actualProcessesCreated", "actualTimersCreated", "actualNetworkIoEvents", "actualNativeAttempts",
  "actualDeployments", "actualDnsOrHostingChanges", "externalEffectOccurred", "targetRuntimeBlockerCleared",
  "physicalQualificationAccepted", "candidateEligible", "activationEligible", "runtimeWired", "grantsApproval",
  "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
  "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
  "statusDigest",
] as const);

export function parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1;
  const captured = exactHostDataSnapshotV1(record, contractKeysV1);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  const requiredTrue = [record.outOfBandOwnerRootRequired, record.ownerRootSigningMaterialOfflineRequired,
    record.pairwiseDistinctKeyMaterialRequired, record.exactProductAndKeyBindingsRequired,
    record.allFiveAnchorsIndependentRequired, record.postgresqlSoleGlobalWriteAuthorityRequired,
    record.transitiveImportInertiaRequired, record.repositoryContractOnly];
  const requiredFalse = [record.rootRuntimeSigningAllowed, record.rootPinReplaceableByRuntime,
    record.rootPinReplaceableByDatabase, record.rootPinReplaceableByManifest,
    record.rootPinReplaceableByTrustRegistry, record.automaticCompromiseRotationAllowed,
    record.historicalKeyNewWritesAllowed, record.anchorBusinessStateAllowed, record.crossRoleAnchorAdoptionAllowed,
    record.recoveryMaySignSubstituteRollbackOrActivate, record.callerDependencyInjectionAllowed,
    record.rootPinImplemented, record.keyRegistryImplemented, record.manifestImplemented, record.anchorImplemented,
    record.signerOrVerifierImplemented, record.storeOrMigrationImplemented, record.runtimeWired,
    record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1
    || record.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_CONTRACT_V1
    || record.live480ProductCommit !== "6d510d6f1b80a98c00c16fcf2b55837afc1cea87"
    || record.live480ProductTree !== "ac8655e1240d25bea9150ae9678f6ad5df56593c"
    || record.acceptedProductBindingSchema !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1
    || record.acceptedKeyBindingSchema !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1
    || record.acceptedKeyRoles !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1
    || record.trustRegistryKeyEntrySchema !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1
    || record.maximumRotationOverlapSeconds !== 300 || record.maximumCurrentOwnerRootPins !== 0
    || record.maximumCurrentKeyEntries !== 0 || record.maximumCurrentTrustRegistryRevisions !== 0
    || record.maximumCurrentDeploymentManifestRevisions !== 0 || record.maximumCurrentAnchorStates !== 0
    || record.maximumCurrentProtectedOperations !== 0
    || requiredTrue.length !== 8 || reflectApplyV1(arraySomeV1, requiredTrue, [(entry: boolean) => entry !== true])
    || requiredFalse.length !== 26 || reflectApplyV1(arraySomeV1, requiredFalse, [(entry: boolean) => entry !== false])) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1;
  const captured = exactHostDataSnapshotV1(record, statusKeysV1);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const actuals = [record.actualOwnerRootPinsLoaded, record.actualOwnerRootRotationStatements,
    record.actualTrustRegistryBodiesCreated, record.actualTrustRegistryEnvelopesCreated,
    record.actualTrustRegistryRevisionsRead, record.actualTrustRegistryRevisionsWritten,
    record.actualManifestBodiesCreated, record.actualManifestEnvelopesCreated, record.actualManifestRevisionsRead,
    record.actualManifestRevisionsWritten, record.actualKeyEntriesCreated, record.actualKeyValuesGenerated,
    record.actualKeyValuesRead, record.actualKeyValuesWritten, record.actualKeyValuesExported,
    record.actualKeyRotations, record.actualKeyRevocations, record.actualKeyDestructions, record.actualSignatures,
    record.actualVerifications, record.actualAnchorStatesCreated, record.actualAnchorReads, record.actualAnchorWrites,
    record.actualAnchorCasRequests, record.actualAnchorCasReceipts, record.actualRecoveryQueries,
    record.actualRecoveryWrites, record.actualQuarantines, record.actualPostgresqlReads,
    record.actualPostgresqlWrites, record.actualMigrations, record.actualFilesystemReads,
    record.actualEnvironmentReads, record.actualHostReads, record.actualClockReads,
    record.actualCredentialStoreReads, record.actualCapsuleConstructions, record.actualSourceOrProviderCalls,
    record.actualProcessesCreated, record.actualTimersCreated, record.actualNetworkIoEvents,
    record.actualNativeAttempts, record.actualDeployments, record.actualDnsOrHostingChanges];
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1
    || record.statusVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_STATUS_V1
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1.contractDigest
    || actuals.length !== 44 || reflectApplyV1(arraySomeV1, actuals, [(entry: number) => entry !== 0])
    || grants.length !== 8 || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])
    || record.externalEffectOccurred !== false || record.targetRuntimeBlockerCleared !== false
    || record.physicalQualificationAccepted !== false || record.candidateEligible !== false
    || record.activationEligible !== false || record.runtimeWired !== false) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1);
