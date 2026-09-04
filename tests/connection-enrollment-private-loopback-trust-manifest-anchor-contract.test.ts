import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_BINDING_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_BINDING_SCHEMA_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_INVARIANTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_SETTLEMENTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_REQUEST_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_ROLE_REQUIREMENTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_STATE_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_DEPLOYMENT_MANIFEST_BODY_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INDEPENDENT_ANCHOR_ROLES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_LIFECYCLE_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_ROTATION_OVERLAP_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_ROTATION_OVERLAP_SCHEMA_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_DUAL_SIGNATURE_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_PIN_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_BODY_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_SIGNATURE_SCOPES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_REVISION_STATES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SIGNED_ENVELOPE_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SPLIT_COMMIT_RECOVERY_CASES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_PROHIBITED_EFFECTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_QUARANTINE_TRIGGERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_ARTIFACT_SIGNATURE_ENTRY_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_ARTIFACT_SIGNATURE_POLICIES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_BODY_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_STATUSES_V1,
  ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1,
  connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
  connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1,
  parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
  parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1,
} from "../src/connection-registry/v1/private-loopback-trust-manifest-anchor-contract";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1,
} from "../src/connection-registry/v1/private-loopback-owner-native-authorization-contract";
import * as connectionRegistryBarrel from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");
const moduleName = "private-loopback-trust-manifest-anchor-contract";
const modulePath = resolve(root, "src/connection-registry/v1", `${moduleName}.ts`);
type SafeCode = ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1
    && error.safeCode === code && error.message === code && error.stack === undefined);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:ts|tsx|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("CR13A-LIVE-490 binds the exact accepted LIVE-480 product and evidence", async () => {
  const contract = connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1;
  assert.equal(contract.live480ProductCommit, "6d510d6f1b80a98c00c16fcf2b55837afc1cea87");
  assert.equal(contract.live480ProductTree, "ac8655e1240d25bea9150ae9678f6ad5df56593c");
  const review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_480_INDEPENDENT_REVIEW.md"));
  const acceptance = await readFile(resolve(root, "docs/CR13A_LIVE_480_ACCEPTANCE.md"));
  assert.equal(createHash("sha256").update(review).digest("hex"), contract.acceptedLive480ReviewSha256);
  assert.equal(createHash("sha256").update(acceptance).digest("hex"), contract.acceptedLive480AcceptanceSha256);
  assert.equal(contract.acceptedProductBindingSchema,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1);
  assert.equal(contract.acceptedKeyBindingSchema,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1);
  assert.equal(contract.acceptedKeyRoles,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1(contract), contract);
});

test("CR13A-LIVE-490 freezes every exact ordered vocabulary and the complete key schema", () => {
  const fixtures: Array<[readonly string[], string[]]> = [
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_PIN_FIELDS_V1, [
      "pin_schema_version", "deployment_product_commit", "deployment_product_tree",
      "owner_root_public_key_algorithm", "owner_root_key_id_digest", "owner_root_revision",
      "owner_root_sha256_fingerprint", "replacement_policy_digest", "pin_product_review_sha256",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_SIGNATURE_SCOPES_V1, [
      "trust_registry_genesis", "trust_registry_revision", "dual_signed_owner_root_rotation_statement",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_BODY_FIELDS_V1, [
      "rotation_schema_version", "prior_root_key_id_digest", "prior_root_revision",
      "prior_root_sha256_fingerprint", "successor_root_key_id_digest", "successor_root_public_key_algorithm",
      "successor_root_revision", "successor_root_sha256_fingerprint", "newly_pinned_deployment_product_commit",
      "newly_pinned_deployment_product_tree", "newly_pinned_deployment_product_review_sha256",
      "rotation_reason", "not_before", "expires_at",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_FIELDS_V1, [
      "role", "key_id_digest", "algorithm", "fingerprint", "revision", "status", "not_before",
      "expires_at", "revoked_at_or_zero",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_STATUSES_V1, [
      "pending", "active", "verification_only", "revoked", "destroyed",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_LIFECYCLE_RULES_V1, [
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
      "destruction_requires_separately_accepted_archive_retention_proof", "unknown_key_state_is_terminal",
      "active_revision_is_monotonic_and_never_reactivates_a_lower_revision",
      "one_role_has_at_most_one_open_signed_overlap_declaration",
      "manifest_selects_exactly_one_revision_during_registry_overlap",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_BODY_FIELDS_V1, [
      "registry_schema_version", "registry_id_digest", "registry_sequence", "prior_registry_digest",
      "policy_revision", "product_catalog_revision", "ordered_key_entries",
      "ordered_rotation_overlap_declarations",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SIGNED_ENVELOPE_FIELDS_V1, [
      "envelope_version", "codec_version", "body", "canonical_body_digest", "ordered_signatures",
      "envelope_digest",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_DEPLOYMENT_MANIFEST_BODY_FIELDS_V1, [
      "manifest_schema_version", "manifest_id_digest", "manifest_sequence", "prior_manifest_digest",
      "policy_revision", "product_catalog_revision", "trust_registry_id_digest", "trust_registry_sequence",
      "trust_registry_digest", "trust_registry_anchor_revision", "trust_registry_anchor_head_digest",
      "manifest_anchor_revision", "manifest_anchor_head_digest", "tenant_id_digest", "project_id_digest",
      "connection_id_digest", "node_id_digest", "target_platform_family", "target_runtime_family",
      "deployment_id_digest", "live440_architecture_commit", "live440_architecture_tree", "live440_design_sha256",
      "live440_review_sha256", "live450_architecture_commit", "live450_design_sha256", "live450_review_sha256",
      "live460_product_commit", "live460_product_tree", "live460_review_sha256",
      "ordered_component_product_bindings", "ordered_key_role_bindings", "allowed_effect_classes",
      "prohibited_effect_classes", "prohibited_effect_ceilings_digest", "manifest_not_before",
      "manifest_expires_at",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INDEPENDENT_ANCHOR_ROLES_V1, [
      "trust_registry_anchor", "deployment_manifest_anchor", "composite_owner_attempt_anchor",
      "attestation_anchor", "cleanup_anchor",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_STATE_FIELDS_V1, [
      "anchor_schema_version", "anchor_role", "stream_id_digest", "monotonic_revision",
      "authenticated_head_digest", "last_request_id_digest", "authentication_tag",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_REQUEST_FIELDS_V1, [
      "request_schema_version", "anchor_role", "stream_id_digest", "request_id_digest", "expected_revision",
      "expected_head_digest", "desired_revision", "desired_head_digest", "deadline_at",
      "writer_key_binding_digest", "request_authentication_tag",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_FIELDS_V1, [
      "receipt_schema_version", "anchor_role", "stream_id_digest", "request_id_digest", "request_body_digest",
      "observed_prior_revision", "observed_prior_head_digest", "settled_revision", "settled_head_digest",
      "settlement", "settled_at", "request_deadline_at", "receipt_authentication_tag",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_DUAL_SIGNATURE_FIELDS_V1, [
      "envelope_schema_version", "canonical_rotation_body", "canonical_rotation_body_digest",
      "prior_root_key_id_digest", "prior_root_revision", "prior_root_signature_algorithm", "prior_root_signature",
      "successor_root_key_id_digest", "successor_root_revision", "successor_root_signature_algorithm",
      "successor_root_signature",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_ARTIFACT_SIGNATURE_ENTRY_FIELDS_V1, [
      "signer_role", "signature_algorithm", "signing_key_id_digest", "signing_key_fingerprint",
      "signing_key_revision", "signed_body_digest", "signature",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_ROTATION_OVERLAP_FIELDS_V1, [
      "overlap_schema_version", "overlap_id_digest", "role", "prior_key_entry_digest", "prior_revision",
      "successor_key_entry_digest", "successor_revision", "overlap_not_before", "overlap_expires_at",
      "authorizing_registry_sequence", "dependent_manifest_id_digest", "dependent_manifest_sequence",
      "dependent_manifest_transition_digest",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_BINDING_FIELDS_V1, [
      "anchor_role", "adapter_component_role", "adapter_product_binding_digest", "writer_key_role",
      "writer_key_binding_digest", "stream_domain", "protected_destination_digest", "custody_domain_digest",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_SETTLEMENTS_V1, [
      "desired_state_adopted", "proven_expected_state_unchanged", "proven_authenticated_conflict",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_INVARIANTS_V1, [
      "receipt_request_id_and_body_digest_match_one_exact_immutable_request",
      "desired_state_adopted_requires_exact_desired_revision_and_head",
      "proven_expected_state_unchanged_requires_exact_expected_revision_and_head",
      "proven_authenticated_conflict_requires_state_distinct_from_expected_and_desired",
      "settled_at_is_not_after_the_exclusive_request_deadline",
      "unknown_timeout_or_malformed_outcome_has_no_receipt_and_quarantines",
      "receipt_cannot_authorize_retry_reconstruction_signing_or_cross_role_adoption",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_REVISION_STATES_V1, ["pending_anchor", "adopted", "revoked"]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SPLIT_COMMIT_RECOVERY_CASES_V1, [
      "pending_database_and_old_anchor_reissue_identical_cas_only",
      "pending_database_and_exact_desired_anchor_finalize_predetermined_adoption",
      "adopted_database_and_matching_anchor_read_current", "old_database_and_anchor_ahead_quarantine",
      "database_ahead_and_anchor_old_or_different_quarantine", "missing_database_record_quarantine",
      "forked_chain_quarantine", "unknown_cas_outcome_quarantine",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_QUARANTINE_TRIGGERS_V1, [
      "missing_component_or_key", "substituted_component_or_key", "duplicated_component_or_key",
      "revoked_component_key_or_manifest", "expired_component_key_or_manifest",
      "wrong_scope_product_key_or_anchor", "behaviorally_supplied_component", "unreviewed_component_product",
      "signature_or_chain_mismatch", "anchor_or_database_rollback_fork_or_uncertainty",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_PROHIBITED_EFFECTS_V1, [
      "key_generation_import_read_write_export_or_destruction", "signature_or_verification_operation",
      "trust_registry_read_or_write", "deployment_manifest_read_or_write", "anchor_read_write_or_compare_and_swap",
      "database_read_write_migration_or_transaction", "filesystem_environment_host_process_or_clock_read",
      "credential_or_secret_store_access", "source_or_provider_lookup_or_invocation", "capsule_construction",
      "listener_socket_or_network_access", "timer_handler_or_process_creation", "arbitrary_command_or_shell",
      "ssh_mcp_or_plugin", "application_or_runtime_activation", "candidate_assembly_or_physical_qualification",
      "deployment_dns_or_hosting_change", "public_endpoint_or_non_private_network",
      "caller_dependency_injection_or_generic_locator", "every_undeclared_effect",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_RULES_V1, [
      "bind_exact_accepted_live_480_product_tree_review_and_acceptance",
      "pin_one_owner_root_algorithm_key_id_revision_and_fingerprint_out_of_band",
      "forbid_database_environment_manifest_registry_or_runtime_from_replacing_owner_root_pin",
      "keep_owner_root_private_key_offline_and_out_of_runtime", "limit_owner_root_signatures_to_three_exact_scopes",
      "require_dual_root_signatures_and_newly_pinned_deployment_product_for_normal_root_rotation",
      "signatures_are_outside_rotation_body_and_both_cover_one_exact_canonical_body_digest",
      "forbid_automatic_root_rotation_when_compromise_makes_old_root_unavailable",
      "make_trust_registry_a_strict_canonical_owner_root_signed_chain",
      "require_root_signature_at_genesis_and_root_plus_trust_registry_signer_on_every_later_registry_revision",
      "require_every_signature_entry_to_repeat_the_one_exact_canonical_body_digest",
      "make_registry_sequence_monotonic_and_prior_digest_zero_only_at_genesis",
      "order_registry_keys_by_role_then_revision_and_require_unique_role_revision_pairs",
      "require_exact_key_roles_statuses_time_intervals_and_pairwise_distinct_material",
      "permit_only_explicit_bounded_300_second_rotation_overlap",
      "bind_each_overlap_to_prior_and_successor_entries_registry_authorization_and_dependent_manifest_transition",
      "forbid_inferred_oversized_overlapping_reversed_stale_replayed_or_lower_revision_overlap",
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
      "bind_each_anchor_to_one_exact_adapter_product_writer_key_stream_destination_and_custody_domain",
      "limit_anchor_state_to_stream_revision_head_last_request_and_authentication",
      "forbid_anchors_from_storing_or_deciding_business_state", "forbid_cross_role_anchor_adoption",
      "append_pending_database_revision_before_one_exact_idempotent_anchor_cas",
      "append_adopted_only_after_exact_receipt_and_current_anchor_verification",
      "accept_only_three_closed_receipt_settlements_with_exact_request_revision_head_and_deadline_invariants",
      "create_no_receipt_for_unknown_timeout_or_malformed_anchor_outcome",
      "reject_old_valid_signature_after_authenticated_anchor_advances", "apply_exact_closed_split_commit_recovery_matrix",
      "permit_recovery_to_reissue_only_the_byte_identical_stored_cas_request",
      "forbid_recovery_from_reconstructing_signing_substituting_rolling_back_or_activating",
      "quarantine_compromise_fork_missing_state_and_every_unknown_outcome",
      "use_postgresql_as_sole_global_write_authority",
      "perform_no_import_time_or_contract_construction_host_or_protected_read",
      "keep_complete_transitive_production_import_graph_inert",
      "export_no_signer_resolver_reader_writer_store_cas_or_dependency_factory",
      "grant_no_approval_qualification_candidate_activation_network_command_lease_or_execution_authority",
    ]],
  ];
  for (const [actual, expected] of fixtures) {
    assert.deepEqual(actual, expected);
    assert.equal(new Set(actual).size, actual.length);
    assert.equal(Object.isFrozen(actual), true);
  }
  const expectedKeyRoles = [
    "out_of_band_owner_root", "trust_registry_signer", "trust_anchor_writer", "deployment_manifest_signer",
    "manifest_anchor_writer", "owner_authorization_sealing", "owner_state", "product_attempt_state",
    "owner_attempt_anchor_writer", "broker_invocation_sealing", "broker_invocation_state",
    "broker_invocation_consumption", "privacy_transform", "running_executable_content_provider",
    "operating_system_boot_session_provider", "attestor_process_session_provider",
    "running_qualification_harness_provider", "running_physical_driver_provider", "platform_signer", "launch_ipc",
    "settlement_ipc", "attestation_database_state", "attestation_anchor_writer", "cleanup_signer",
    "cleanup_database_state", "cleanup_anchor_writer", "tls_transport", "node_channel",
  ];
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1, expectedKeyRoles);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1, {
    fields: fixtures[3]?.[1],
    allowedRoles: expectedKeyRoles,
    statuses: fixtures[4]?.[1], ordering: "role_order_then_revision_ascending", uniqueBy: "role_and_revision",
    everyRoleRequired: true, atLeastOneCurrentActiveRevisionPerRequiredRole: true,
    maximumActiveRevisionsPerRoleDuringDeclaredOverlap: 2,
    maximumActiveRevisionsPerRoleOutsideDeclaredOverlap: 1, extraFieldsAllowed: false,
  });
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1.allowedRoles.length, 28);
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1), true);
});

test("CR13A-LIVE-490 makes root recovery manual and rotation narrowly bounded", () => {
  const contract = connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1;
  assert.equal(contract.maximumRotationOverlapSeconds, 300);
  assert.equal(contract.outOfBandOwnerRootRequired, true);
  assert.equal(contract.ownerRootSigningMaterialOfflineRequired, true);
  assert.equal(contract.rootRuntimeSigningAllowed, false);
  assert.equal(contract.rootPinReplaceableByRuntime, false);
  assert.equal(contract.rootPinReplaceableByDatabase, false);
  assert.equal(contract.rootPinReplaceableByManifest, false);
  assert.equal(contract.rootPinReplaceableByTrustRegistry, false);
  assert.equal(contract.automaticCompromiseRotationAllowed, false);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_SIGNATURE_SCOPES_V1.length, 3);
  assert.doesNotMatch(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_BODY_FIELDS_V1.join(" "), /signature/);
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_DUAL_SIGNATURE_FIELDS_V1
    .includes("prior_root_signature"));
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_DUAL_SIGNATURE_FIELDS_V1
    .includes("successor_root_signature"));
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_ARTIFACT_SIGNATURE_POLICIES_V1, [
    { artifact: "trust_registry_genesis", orderedSignerRoles: ["out_of_band_owner_root"], exactSignatureCount: 1 },
    { artifact: "trust_registry_revision",
      orderedSignerRoles: ["out_of_band_owner_root", "trust_registry_signer"], exactSignatureCount: 2 },
    { artifact: "deployment_manifest", orderedSignerRoles: ["deployment_manifest_signer"], exactSignatureCount: 1 },
  ]);
  for (const policy of CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_ARTIFACT_SIGNATURE_POLICIES_V1) {
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.orderedSignerRoles), true);
    assert.equal(new Set(policy.orderedSignerRoles).size, policy.exactSignatureCount);
  }
});

test("CR13A-LIVE-490 makes every key overlap explicit, bounded, monotonic, and manifest-bound", () => {
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_ROTATION_OVERLAP_SCHEMA_V1, {
    fields: ["overlap_schema_version", "overlap_id_digest", "role", "prior_key_entry_digest", "prior_revision",
      "successor_key_entry_digest", "successor_revision", "overlap_not_before", "overlap_expires_at",
      "authorizing_registry_sequence", "dependent_manifest_id_digest", "dependent_manifest_sequence",
      "dependent_manifest_transition_digest"],
    allowedRoles: [...CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1],
    requiredRegistrySignerRoles: ["out_of_band_owner_root", "trust_registry_signer"],
    requiredDependentManifestSignerRole: "deployment_manifest_signer",
    successorRevisionStrictlyGreaterThanPrior: true, lowerRevisionReactivationAllowed: false,
    overlappingDeclarationsForRoleAllowed: false, declarationReplayAllowed: false,
    maximumDurationSeconds: 300, extraFieldsAllowed: false,
  });
  assert.equal(Object.isFrozen(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_ROTATION_OVERLAP_SCHEMA_V1), true);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_BODY_FIELDS_V1.at(-1),
    "ordered_rotation_overlap_declarations");
});

test("CR13A-LIVE-490 binds all products, keys, trust state, scope, effects, and five anchors", () => {
  const contract = connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1;
  assert.equal(contract.acceptedProductBindingSchema.exactCardinality, 42);
  assert.equal(contract.acceptedKeyBindingSchema.exactCardinality, 28);
  assert.equal(contract.acceptedProductBindingSchema.fields.length, 4);
  assert.equal(contract.acceptedKeyBindingSchema.fields.length, 10);
  assert.equal(contract.exactProductAndKeyBindingsRequired, true);
  assert.deepEqual(contract.independentAnchorRoles, [
    "trust_registry_anchor", "deployment_manifest_anchor", "composite_owner_attempt_anchor",
    "attestation_anchor", "cleanup_anchor",
  ]);
  assert.equal(contract.allFiveAnchorsIndependentRequired, true);
  assert.equal(contract.anchorBusinessStateAllowed, false);
  assert.equal(contract.crossRoleAnchorAdoptionAllowed, false);
  assert.equal(contract.postgresqlSoleGlobalWriteAuthorityRequired, true);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_ROLE_REQUIREMENTS_V1, [
    { anchorRole: "trust_registry_anchor", adapterComponentRole: "trust_registry_anchor_adapter",
      writerKeyRole: "trust_anchor_writer", streamDomain: "trust_registry_head" },
    { anchorRole: "deployment_manifest_anchor", adapterComponentRole: "manifest_anchor_adapter",
      writerKeyRole: "manifest_anchor_writer", streamDomain: "deployment_manifest_head" },
    { anchorRole: "composite_owner_attempt_anchor", adapterComponentRole: "owner_attempt_anchor_adapter",
      writerKeyRole: "owner_attempt_anchor_writer", streamDomain: "composite_owner_attempt_head" },
    { anchorRole: "attestation_anchor", adapterComponentRole: "attestation_anchor_adapter",
      writerKeyRole: "attestation_anchor_writer", streamDomain: "attestation_head" },
    { anchorRole: "cleanup_anchor", adapterComponentRole: "cleanup_anchor_adapter",
      writerKeyRole: "cleanup_anchor_writer", streamDomain: "cleanup_head" },
  ]);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_BINDING_SCHEMA_V1.pairwiseDistinctFields,
    ["anchor_role", "adapter_component_role", "adapter_product_binding_digest", "writer_key_role",
      "writer_key_binding_digest", "stream_domain", "protected_destination_digest", "custody_domain_digest"]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_BINDING_SCHEMA_V1.exactCardinality, 5);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_BINDING_SCHEMA_V1
    .sharedWriterAdapterDestinationCustodyOrStreamAllowed, false);
  for (const requirement of CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_ROLE_REQUIREMENTS_V1) {
    assert.equal(Object.isFrozen(requirement), true);
  }
});

test("CR13A-LIVE-490 closes split-commit recovery without signing, substitution, rollback, or activation", () => {
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SPLIT_COMMIT_RECOVERY_CASES_V1.length, 8);
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SPLIT_COMMIT_RECOVERY_CASES_V1
    .includes("unknown_cas_outcome_quarantine"));
  assert.equal(connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1
    .recoveryMaySignSubstituteRollbackOrActivate, false);
  assert.equal(connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1.maximumCurrentProtectedOperations, 0);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_SETTLEMENTS_V1,
    ["desired_state_adopted", "proven_expected_state_unchanged", "proven_authenticated_conflict"]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_INVARIANTS_V1.length, 7);
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_INVARIANTS_V1
    .includes("unknown_timeout_or_malformed_outcome_has_no_receipt_and_quarantines"));
});

test("CR13A-LIVE-490 requires protective properties while implementing and granting nothing", () => {
  const contract = connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1;
  for (const key of ["outOfBandOwnerRootRequired", "ownerRootSigningMaterialOfflineRequired",
    "pairwiseDistinctKeyMaterialRequired", "exactProductAndKeyBindingsRequired", "allFiveAnchorsIndependentRequired",
    "postgresqlSoleGlobalWriteAuthorityRequired", "transitiveImportInertiaRequired", "repositoryContractOnly",
  ] as const) assert.equal(contract[key], true, key);
  for (const key of ["rootRuntimeSigningAllowed", "rootPinReplaceableByRuntime", "rootPinReplaceableByDatabase",
    "rootPinReplaceableByManifest", "rootPinReplaceableByTrustRegistry", "automaticCompromiseRotationAllowed",
    "historicalKeyNewWritesAllowed", "anchorBusinessStateAllowed", "crossRoleAnchorAdoptionAllowed",
    "recoveryMaySignSubstituteRollbackOrActivate", "callerDependencyInjectionAllowed", "rootPinImplemented",
    "keyRegistryImplemented", "manifestImplemented", "anchorImplemented", "signerOrVerifierImplemented",
    "storeOrMigrationImplemented", "runtimeWired", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority",
  ] as const) assert.equal(contract[key], false, key);
  assert.deepEqual([contract.maximumCurrentOwnerRootPins, contract.maximumCurrentKeyEntries,
    contract.maximumCurrentTrustRegistryRevisions, contract.maximumCurrentDeploymentManifestRevisions,
    contract.maximumCurrentAnchorStates, contract.maximumCurrentProtectedOperations], [0, 0, 0, 0, 0, 0]);
});

test("CR13A-LIVE-490 publishes 44 zero actuals, eight false grants, and no blocker clearance", () => {
  const status = connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1(status), status);
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(actuals.length, 44);
  assert.deepEqual(actuals, new Array(44).fill(0));
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.externalEffectOccurred, false);
  assert.equal(status.targetRuntimeBlockerCleared, false);
  assert.equal(status.physicalQualificationAccepted, false);
  assert.equal(status.candidateEligible, false);
  assert.equal(status.activationEligible, false);
  assert.equal(status.runtimeState, "not_wired");
});

test("CR13A-LIVE-490 rejects copies, accessors, Symbols, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1({
    ...connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1(Object.freeze({
    ...connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
    independentAnchorRoles: Object.freeze(["trust_registry_anchor", "trust_registry_anchor"]),
  })), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1({
    ...connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1(Symbol("trust")),
    "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("trust accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("trust proxy"); },
    get() { executions += 1; throw new Error("trust proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1(proxy), "invalid_status");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-490 rejects signature, overlap, anchor, and receipt-policy substitution", () => {
  const contract = connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1;
  const substitutions = [
    { trustArtifactSignaturePolicies: Object.freeze([
      Object.freeze({ artifact: "trust_registry_revision",
        orderedSignerRoles: Object.freeze(["trust_registry_signer", "out_of_band_owner_root"]),
        exactSignatureCount: 2 }),
    ]) },
    { trustArtifactSignaturePolicies: Object.freeze([
      Object.freeze({ artifact: "trust_registry_revision",
        orderedSignerRoles: Object.freeze(["out_of_band_owner_root", "trust_registry_signer"]),
        exactSignatureCount: 1 }),
    ]) },
    { trustArtifactSignatureEntryFields: Object.freeze([
      "signer_role", "signature_algorithm", "signing_key_id_digest", "signing_key_fingerprint",
      "signing_key_revision", "different_body_digest", "signature",
    ]) },
    { ownerRootRotationBodyFields: Object.freeze([
      ...CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_BODY_FIELDS_V1, "prior_root_signature",
    ]) },
    { keyRotationOverlapSchema: Object.freeze({
      ...CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_ROTATION_OVERLAP_SCHEMA_V1, maximumDurationSeconds: 301,
    }) },
    { keyRotationOverlapSchema: Object.freeze({
      ...CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_ROTATION_OVERLAP_SCHEMA_V1,
      lowerRevisionReactivationAllowed: true, overlappingDeclarationsForRoleAllowed: true,
    }) },
    { anchorBindingSchema: Object.freeze({
      ...CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_BINDING_SCHEMA_V1,
      sharedWriterAdapterDestinationCustodyOrStreamAllowed: true,
    }) },
    { anchorCasReceiptSettlements: Object.freeze([
      ...CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_SETTLEMENTS_V1, "unknown_success",
    ]) },
  ];
  for (const substitution of substitutions) {
    expectCode(() => parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1(Object.freeze({
      ...contract, ...substitution,
    })), "invalid_contract");
  }
});

test("CR13A-LIVE-490 freezes records, parsers, nested schemas, and safe errors", () => {
  for (const value of [connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
    connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1,
    ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1,
    ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1.prototype,
    parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
    parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1.fields,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1.allowedRoles,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1.statuses]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const error = new ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1("raw trust material");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-490 parsers retain captured intrinsics after ambient replacement", () => {
  const originalIsFrozen = Object.isFrozen;
  const originalWeakSetHas = WeakSet.prototype.has;
  const originalWeakMapGet = WeakMap.prototype.get;
  const originalArraySome = Array.prototype.some;
  const originalReflectApply = Reflect.apply;
  const executions = new Array(5).fill(0);
  let parsedContract: unknown;
  let parsedStatus: unknown;
  try {
    Object.isFrozen = () => { executions[0] += 1; return false; };
    WeakSet.prototype.has = function () { executions[1] += 1; return false; };
    WeakMap.prototype.get = function () { executions[2] += 1; return undefined; };
    Array.prototype.some = function () { executions[3] += 1; throw new Error("trust ambient"); };
    Reflect.apply = () => { executions[4] += 1; throw new Error("trust ambient"); };
    parsedContract = parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1(
      connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1);
    parsedStatus = parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1(
      connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1);
  } finally {
    Object.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Array.prototype.some = originalArraySome;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(parsedContract, connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1);
  assert.equal(parsedStatus, connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1);
  assert.deepEqual(executions, new Array(5).fill(0));
});

test("CR13A-LIVE-490 transitive production import graph is exact and effect-inert", async () => {
  const graph = new Map<string, readonly string[]>([
    ["src/connection-registry/v1/private-loopback-trust-manifest-anchor-contract.ts", [
      "../../security/canonical-digest", "../../security/host-value", "../../security/redaction",
      "./private-loopback-owner-native-authorization-contract",
    ]],
    ["src/connection-registry/v1/private-loopback-owner-native-authorization-contract.ts", [
      "../../security/canonical-digest", "../../security/host-value", "../../security/redaction",
    ]],
    ["src/security/canonical-digest.ts", ["node:crypto"]],
    ["src/security/host-value.ts", ["node:util"]],
    ["src/security/redaction.ts", []],
  ]);
  const prohibitedModules = /^(?:node:)?(?:fs|fs\/promises|net|http|https|http2|tls|dgram|dns|dns\/promises|child_process|cluster|worker_threads|os|process)$|^(?:postgres|@electric-sql\/pglite)$/;
  const effectNames = new Set([
    "fetch", "setTimeout", "setInterval", "createServer", "listen", "connect", "createConnection", "request",
    "spawn", "spawnSync", "fork", "readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile",
    "appendFileSync", "open", "openSync", "rm", "rmSync", "unlink", "unlinkSync", "query", "transaction",
    "getaddrinfo", "lookup", "chdir", "cwd", "exit", "kill",
  ]);
  const expectedExports = new Map<string, readonly string[]>([
    ["src/connection-registry/v1/private-loopback-trust-manifest-anchor-contract.ts", [
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_CONTRACT_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_STATUS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_PIN_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_SIGNATURE_SCOPES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_BODY_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_DUAL_SIGNATURE_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_ARTIFACT_SIGNATURE_ENTRY_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_ARTIFACT_SIGNATURE_POLICIES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_STATUSES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_ROTATION_OVERLAP_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_ROTATION_OVERLAP_SCHEMA_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_LIFECYCLE_RULES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_BODY_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SIGNED_ENVELOPE_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_DEPLOYMENT_MANIFEST_BODY_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INDEPENDENT_ANCHOR_ROLES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_BINDING_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_ROLE_REQUIREMENTS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_BINDING_SCHEMA_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_STATE_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_REQUEST_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_SETTLEMENTS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_INVARIANTS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_REVISION_STATES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SPLIT_COMMIT_RECOVERY_CASES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_QUARANTINE_TRIGGERS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_PROHIBITED_EFFECTS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_RULES_V1",
      "ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1",
      "connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1",
      "ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1",
      "connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1",
      "ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1",
      "parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1",
      "parseConnectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1",
    ]],
    ["src/connection-registry/v1/private-loopback-owner-native-authorization-contract.ts", [
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CONTRACT_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATUS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_ROLES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RESERVATION_INTENTS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROVIDER_SCOPES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CLEANUP_FACTS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ALLOWED_EFFECTS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROHIBITED_EFFECTS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PUBLIC_TERMINAL_FIELDS_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_OPERATION_BUDGET_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_TERMINAL_OUTCOMES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1",
      "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RULES_V1",
      "ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1",
      "ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1",
      "ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1",
      "connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1",
      "connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1",
      "parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1",
      "parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1",
    ]],
    ["src/security/canonical-digest.ts", ["canonicalJson", "sha256Digest"]],
    ["src/security/host-value.ts", [
      "isHostProxyV1", "ownDataPropertyValueV1", "exactHostErrorCodeV1", "ownAccessorPropertyGetterV1",
      "dataPropertyValueV1", "dataMethodV1", "exactHostDataSnapshotV1", "exactHostDataArrayV1",
      "HostCancellationSignalV1", "HostCancellationControllerV1", "createHostCancellationControllerV1",
      "exactHostCancellationSignalV1", "hostCancellationAbortedV1", "HostCancellationSubscriptionV1",
      "subscribeHostCancellationV1", "ExactHostUint8ArrayV1", "hostUint8ArrayByteLengthV1",
      "exactHostUint8ArrayV1", "wipeHostUint8ArrayV1", "HostResultCollectorV1", "createHostResultCollectorV1",
    ]],
    ["src/security/redaction.ts", ["RedactionResult", "containsSecretMaterial", "assertNoSecretMaterial",
      "redactSecrets"]],
  ]);
  const expectedTopLevelCalls = new Map<string, readonly string[]>([
    ["src/connection-registry/v1/private-loopback-trust-manifest-anchor-contract.ts",
      ["objectFreezeV1", "reflectApplyV1", "safePublicRecordV1", "sha256Digest"]],
    ["src/connection-registry/v1/private-loopback-owner-native-authorization-contract.ts",
      ["budgetV1", "objectFreezeV1", "providerBudgetV1", "reflectApplyV1", "safePublicRecordV1", "sha256Digest"]],
    ["src/security/canonical-digest.ts", []],
    ["src/security/host-value.ts", ["objectCreate", "objectFreeze", "objectGetOwnPropertyDescriptor",
      "objectGetPrototypeOf"]],
    ["src/security/redaction.ts", []],
  ]);
  const expectedTopLevelConstructors = new Map<string, readonly string[]>([
    ["src/connection-registry/v1/private-loopback-trust-manifest-anchor-contract.ts", ["WeakMap", "WeakSet"]],
    ["src/connection-registry/v1/private-loopback-owner-native-authorization-contract.ts", ["WeakMap", "WeakSet"]],
    ["src/security/canonical-digest.ts", []], ["src/security/host-value.ts", ["Error", "WeakMap"]],
    ["src/security/redaction.ts", []],
  ]);
  const discovered = new Set<string>();
  const pending = [modulePath];
  while (pending.length > 0) {
    const file = pending.pop();
    assert.ok(file);
    const relativeFile = relative(root, file);
    if (discovered.has(relativeFile)) continue;
    discovered.add(relativeFile);
    const text = await readFile(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports: string[] = [];
    for (const statement of source.statements) {
      let specifier: string | undefined;
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifier = statement.moduleSpecifier.text;
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier
        && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifier = statement.moduleSpecifier.text;
      } else if (ts.isImportEqualsDeclaration(statement)
        && ts.isExternalModuleReference(statement.moduleReference)
        && statement.moduleReference.expression && ts.isStringLiteral(statement.moduleReference.expression)) {
        specifier = statement.moduleReference.expression.text;
      }
      if (specifier === undefined) continue;
      imports.push(specifier);
      assert.doesNotMatch(specifier, prohibitedModules, `${relativeFile}: prohibited dependency ${specifier}`);
      if (specifier.startsWith(".")) pending.push(`${resolve(dirname(file), specifier)}.ts`);
    }
    assert.deepEqual(imports, graph.get(relativeFile), `${relativeFile}: import graph drift`);

    const exportedNames: string[] = [];
    for (const statement of source.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      const hasExport = modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true;
      if (hasExport && ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) exportedNames.push(declaration.name.text);
        }
      } else if (hasExport && (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)
        || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement))
        && statement.name && ts.isIdentifier(statement.name)) {
        exportedNames.push(statement.name.text);
      } else if (ts.isExportDeclaration(statement) && statement.exportClause
        && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) exportedNames.push(element.name.text);
      }
    }
    assert.deepEqual(exportedNames, expectedExports.get(relativeFile), `${relativeFile}: export surface drift`);

    const topLevelCalls = new Set<string>();
    const topLevelConstructors = new Set<string>();
    const inspectTopLevel = (node: ts.Node, insideFunctionOrClass = false): void => {
      const nested = insideFunctionOrClass || ts.isFunctionLike(node) || ts.isClassLike(node);
      if (!insideFunctionOrClass && ts.isCallExpression(node)) {
        const calledName = ts.isIdentifier(node.expression) ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(source);
        topLevelCalls.add(calledName);
      } else if (!insideFunctionOrClass && ts.isNewExpression(node)) {
        const calledName = ts.isIdentifier(node.expression) ? node.expression.text : node.expression.getText(source);
        topLevelConstructors.add(calledName);
      }
      ts.forEachChild(node, (child) => inspectTopLevel(child, nested));
    };
    for (const statement of source.statements) inspectTopLevel(statement);
    assert.deepEqual([...topLevelCalls].sort(), [...(expectedTopLevelCalls.get(relativeFile) ?? [])].sort(),
      `${relativeFile}: top-level call drift`);
    assert.deepEqual([...topLevelConstructors].sort(),
      [...(expectedTopLevelConstructors.get(relativeFile) ?? [])].sort(), `${relativeFile}: constructor drift`);
    const taintedAliases = new Set(effectNames);
    let changed = true;
    while (changed) {
      changed = false;
      const discoverAliases = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const initializerName = ts.isIdentifier(node.initializer) ? node.initializer.text
            : ts.isPropertyAccessExpression(node.initializer) ? node.initializer.name.text : undefined;
          if (initializerName && taintedAliases.has(initializerName) && !taintedAliases.has(node.name.text)) {
            taintedAliases.add(node.name.text);
            changed = true;
          }
        }
        ts.forEachChild(node, discoverAliases);
      };
      discoverAliases(source);
    }
    const violations: string[] = [];
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) violations.push("dynamic import");
        const calledName = ts.isIdentifier(node.expression) ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
        if (calledName === "require" || calledName === "createRequire") violations.push(`loader call ${calledName}`);
        if (calledName && taintedAliases.has(calledName)) violations.push(`effect call ${calledName}`);
      } else if (ts.isNewExpression(node)) {
        const calledName = ts.isIdentifier(node.expression) ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
        if (calledName && taintedAliases.has(calledName)) violations.push(`effect construction ${calledName}`);
      } else if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === "process"
        && ["env", "argv", "pid", "platform"].includes(node.name.text)) {
        violations.push(`process.${node.name.text}`);
      } else if (ts.isIdentifier(node) && effectNames.has(node.text)) violations.push(`effect reference ${node.text}`);
      else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
        && effectNames.has(node.argumentExpression.text)) violations.push(`effect element ${node.argumentExpression.text}`);
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    assert.deepEqual(violations, [], `${relativeFile}: transitive effect path`);
  }
  assert.deepEqual([...discovered].sort(), [...graph.keys()].sort());
});

test("CR13A-LIVE-490 has only the safe barrel and dependency-ordered LIVE-500 contract as consumers", async () => {
  const consumers: string[] = [];
  const barrel = resolve(root, "src/connection-registry/v1/index.ts");
  const live500Contract = resolve(root,
    "src/connection-registry/v1/private-loopback-owner-present-issuer-contract.ts");
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    if ((await readFile(file, "utf8")).includes(moduleName)) consumers.push(file);
  }
  assert.deepEqual(consumers.sort(), [barrel, live500Contract].sort());
  assert.equal(connectionRegistryBarrel.connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
    connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1);
});

test("CR13A-LIVE-490 public evidence is sanitized and honestly reports zero effects", async () => {
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
    status: connectionEnrollmentPrivateLoopbackTrustManifestAnchorStatusV1,
    error: new ConnectionEnrollmentPrivateLoopbackTrustManifestAnchorErrorV1("raw trust material"),
  });
  assert.doesNotMatch(serialized, /\/Users\/|127\.0\.0\.1|localhost|raw trust material|stack/);
  assert.doesNotMatch(serialized, /username|password|credentialValue|privateKeyValue/);
  const status = await readFile(resolve(root, "docs/BUILD_STATUS.md"), "utf8");
  assert.match(status, /CR13A-LIVE-490/);
  assert.match(status, /repository-only|inert|zero/i);
});
