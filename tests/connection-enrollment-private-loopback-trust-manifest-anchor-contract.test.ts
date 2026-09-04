import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_RECEIPT_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_CAS_REQUEST_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ANCHOR_STATE_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_DEPLOYMENT_MANIFEST_BODY_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INDEPENDENT_ANCHOR_ROLES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_KEY_LIFECYCLE_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_PIN_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_SIGNATURE_SCOPES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_REVISION_STATES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SIGNED_ENVELOPE_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SPLIT_COMMIT_RECOVERY_CASES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_PROHIBITED_EFFECTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_ANCHOR_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_MANIFEST_QUARANTINE_TRIGGERS_V1,
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
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_FIELDS_V1, [
      "rotation_schema_version", "prior_root_key_id_digest", "prior_root_revision",
      "prior_root_sha256_fingerprint", "successor_root_key_id_digest", "successor_root_public_key_algorithm",
      "successor_root_revision", "successor_root_sha256_fingerprint", "newly_pinned_deployment_product_commit",
      "newly_pinned_deployment_product_tree", "newly_pinned_deployment_product_review_sha256",
      "rotation_reason", "not_before", "expires_at", "prior_root_signature", "successor_root_signature",
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
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_BODY_FIELDS_V1, [
      "registry_schema_version", "registry_id_digest", "registry_sequence", "prior_registry_digest",
      "policy_revision", "product_catalog_revision", "ordered_key_entries",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SIGNED_ENVELOPE_FIELDS_V1, [
      "envelope_version", "codec_version", "signature_algorithm", "body", "canonical_body_digest",
      "signing_key_id_digest", "signing_key_fingerprint", "signing_key_revision", "authentication_tag",
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
      "receipt_schema_version", "anchor_role", "stream_id_digest", "request_id_digest",
      "observed_prior_revision", "observed_prior_head_digest", "settled_revision", "settled_head_digest",
      "settlement", "settled_at", "receipt_authentication_tag",
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
      "forbid_anchors_from_storing_or_deciding_business_state", "forbid_cross_role_anchor_adoption",
      "append_pending_database_revision_before_one_exact_idempotent_anchor_cas",
      "append_adopted_only_after_exact_receipt_and_current_anchor_verification",
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
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_REGISTRY_KEY_ENTRY_SCHEMA_V1, {
    fields: fixtures[3]?.[1],
    allowedRoles: [...CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1],
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
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_FIELDS_V1.includes("prior_root_signature"));
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_ROOT_ROTATION_FIELDS_V1.includes("successor_root_signature"));
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
});

test("CR13A-LIVE-490 closes split-commit recovery without signing, substitution, rollback, or activation", () => {
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SPLIT_COMMIT_RECOVERY_CASES_V1.length, 8);
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SPLIT_COMMIT_RECOVERY_CASES_V1
    .includes("unknown_cas_outcome_quarantine"));
  assert.equal(connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1
    .recoveryMaySignSubstituteRollbackOrActivate, false);
  assert.equal(connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1.maximumCurrentProtectedOperations, 0);
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
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      imports.push(specifier);
      assert.doesNotMatch(specifier, prohibitedModules, `${relativeFile}: prohibited import ${specifier}`);
      if (specifier.startsWith(".")) pending.push(`${resolve(dirname(file), specifier)}.ts`);
    }
    assert.deepEqual(imports, graph.get(relativeFile), `${relativeFile}: import graph drift`);
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

test("CR13A-LIVE-490 has only the safe connection-registry barrel as a production consumer", async () => {
  const consumers: string[] = [];
  const barrel = resolve(root, "src/connection-registry/v1/index.ts");
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    if ((await readFile(file, "utf8")).includes(moduleName)) consumers.push(file);
  }
  assert.deepEqual(consumers, [barrel]);
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
