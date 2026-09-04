import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ALLOWED_EFFECTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CLEANUP_FACTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_OPERATION_BUDGET_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROVIDER_SCOPES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROHIBITED_EFFECTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_ROLES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PUBLIC_TERMINAL_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RESERVATION_INTENTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_TERMINAL_OUTCOMES_V1,
  ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1,
  connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
  connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1,
  parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
  parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1,
} from "../src/connection-registry/v1/private-loopback-owner-native-authorization-contract";
import * as connectionRegistryBarrel from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");
const moduleName = "private-loopback-owner-native-authorization-contract";
const modulePath = resolve(root, "src/connection-registry/v1", `${moduleName}.ts`);
type SafeCode = ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1
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

test("CR13A-LIVE-480 binds the exact accepted LIVE-470 product and evidence", async () => {
  const contract = connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1;
  assert.equal(contract.live470ProductCommit, "b1f1055f05bc4c53485caa89ddc456953fce4326");
  assert.equal(contract.live470ProductTree, "a396d40e7c4c5f0c1dc3bab4d073b462863a408b");
  const design = await readFile(resolve(root,
    "docs/CR13A_LIVE_470_PRODUCTION_CAPSULE_OWNER_NATIVE_AUTHORIZATION_DESIGN.md"));
  const review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_470_ARCHITECTURE_REVIEW.md"));
  const acceptance = await readFile(resolve(root, "docs/CR13A_LIVE_470_ARCHITECTURE_ACCEPTANCE.md"));
  assert.equal(createHash("sha256").update(design).digest("hex"), contract.acceptedLive470FinalDesignSha256);
  assert.equal(createHash("sha256").update(review).digest("hex"), contract.acceptedLive470ReviewSha256);
  assert.equal(createHash("sha256").update(acceptance).digest("hex"), contract.acceptedLive470AcceptanceSha256);
  assert.equal(contract.acceptedLive470ReviewedDesignSha256,
    "29980084a8d0fd1839a79e0f5402cc0f2038179bdecadd666295bd090497f7c4");
  assert.equal(contract.productBindingSchema,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1);
  assert.equal(contract.keyBindingSchema,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1(contract), contract);
});

test("CR13A-LIVE-480 freezes every exact ordered vocabulary and nested binding schema", () => {
  const expectedBodyFields = [
    "body_schema_version", "live440_architecture_commit", "live440_architecture_tree", "live440_design_sha256",
    "live440_review_sha256", "live450_architecture_commit", "live450_design_sha256", "live450_review_sha256",
    "live460_product_commit", "live460_product_tree", "live460_review_sha256", "ordered_component_product_bindings",
    "tenant_id_digest", "project_id_digest", "connection_id_digest", "node_id_digest", "target_platform_family",
    "target_runtime_family", "deployment_id_digest", "policy_id_digest", "operation_id",
    "candidate_proposal_id_digest", "attempt_id_digest", "deployment_manifest_id_digest",
    "deployment_manifest_digest", "deployment_manifest_sequence", "trust_registry_id_digest",
    "trust_registry_digest", "trust_registry_sequence", "manifest_anchor_revision", "manifest_anchor_head_digest",
    "trust_registry_anchor_revision", "trust_registry_anchor_head_digest", "protected_product_catalog_revision",
    "owner_policy_revision", "owner_authorization_id_digest", "strong_factor_policy_revision",
    "strong_factor_evidence_class", "owner_nonce_digest", "issued_at", "not_before", "expires_at",
    "cleanup_deadline", "broker_authorization_id_digest", "broker_nonce_digest", "broker_body_digest",
    "broker_registration_identity_digest", "broker_sealing_key_revision", "broker_not_before", "broker_expires_at",
    "broker_scope_digest", "context_reservation_intent_digest", "cleanup_reservation_intent_digest",
    "cleanup_subject_resource_set_digest", "required_cleanup_fact_names", "ordered_provider_subject_scope_digests",
    "private_postgresql_destination_digest", "owner_attempt_anchor_destination_digest",
    "attestation_anchor_destination_digest", "cleanup_anchor_destination_digest", "ordered_key_role_bindings",
    "logical_operation_budget_digest", "allowed_effect_classes", "prohibited_effect_classes",
  ];
  const expectedProductBindingFields = [
    "component_role", "product_commit", "product_tree", "independent_review_sha256",
  ];
  const expectedProductBindingRoles = [
    "source_owner", "runner", "capsule_lexical_graph", "child_entrypoint", "owner_attended_parent_harness",
    "owner_authorization_contract", "owner_authorization_store", "broker_invocation_contract",
    "broker_invocation_store", "context_reservation", "cleanup_reservation", "privacy_transform",
    "running_executable_content_provider", "operating_system_boot_session_provider",
    "attestor_process_session_provider", "running_qualification_harness_provider", "running_physical_driver_provider",
    "platform_signer", "owner_registration_closure_writer", "owner_consumption_product_closure_writer",
    "owner_anchor_settlement_writer", "context_reservation_writer", "cleanup_reservation_writer",
    "attestation_pending_writer", "attestation_finalizer", "cleanup_pending_writer", "cleanup_finalizer",
    "final_acceptance_writer", "protected_high_water_adapter", "private_verifier", "cleanup_observer",
    "cleanup_signer", "parent_finalizer", "public_projector", "owner_present_issuer", "trust_registry_resolver",
    "deployment_manifest_resolver", "owner_attempt_anchor_adapter", "attestation_anchor_adapter",
    "cleanup_anchor_adapter", "trust_registry_anchor_adapter", "manifest_anchor_adapter",
  ];
  const expectedKeyBindingFields = [
    "role", "key_id_digest", "algorithm", "fingerprint", "revision", "status", "not_before", "expires_at",
    "revoked_at_or_zero", "trust_registry_entry_digest",
  ];
  const expectedEnvelopeFields = [
    "envelope_version", "codec_version", "signature_algorithm", "body", "canonical_body_digest",
    "owner_sealing_key_id", "owner_sealing_key_fingerprint", "owner_sealing_key_revision", "authentication_tag",
  ];
  const expectedReservationIntents = ["context_reservation_intent", "after_exit_cleanup_reservation_intent"];
  const expectedProviderScopes = [
    "running_executable_content", "operating_system_boot_session", "attestor_process_session",
    "running_qualification_harness_artifact", "running_physical_driver_artifact",
  ];
  const expectedCleanupFacts = [
    "qualification_process_absent", "descendants_absent", "listeners_and_enumerated_resources_absent",
    "temporary_database_closed", "disposable_root_absent", "bounded_residue_scan_clean",
  ];
  const expectedAllowedEffects = [
    "private_postgresql_transactions", "protected_high_water_state_reads", "protected_high_water_compare_and_swap",
    "eight_value_local_source_read", "five_bounded_local_supplementary_reads", "fixed_disposable_child_creation",
    "bounded_parent_to_child_launch_frame", "bounded_child_to_parent_settlement_frame", "one_platform_signature",
    "disposable_child_exit_or_termination", "one_after_exit_cleanup_observation", "one_after_exit_cleanup_signature",
  ];
  const expectedProhibitedEffects = [
    "listener_or_inbound_server_socket", "undeclared_outbound_socket", "public_endpoint", "non_private_network",
    "external_model_or_provider_call", "arbitrary_command_or_shell", "ssh", "mcp", "plugin",
    "application_or_runtime_activation", "candidate_assembly", "physical_listener_attempt", "deployment",
    "dns_change", "hosting_change", "credential_export", "arbitrary_file_read", "every_undeclared_effect",
  ];
  const expectedPublicTerminalFields = [
    "schema_version", "live460_contract_product", "live460_contract_tree", "source_owner_product",
    "source_owner_tree", "runner_product", "runner_tree", "accepted_product_set_digest", "coarse_outcome",
    "owner_authorization_use_count", "broker_authorization_use_count", "source_lookup_count",
    "source_invocation_count", "ordered_provider_invocation_counts", "platform_signature_count",
    "cleanup_observation_count", "cleanup_signature_count", "child_creation_count", "launch_frame_count",
    "settlement_frame_count", "finalization_count", "review_submission_count", "review_state",
    "review_product_digest_or_zero", "review_evidence_digest_or_zero", "authority_grants",
    "prohibited_effect_grants", "public_object_digest",
  ];
  const expectedStates = [
    "registration_pending_anchor", "registered_unspent", "preflight_validated_unspent",
    "consumption_product_pending_anchor", "consumed_product_attempt_closed", "already_consumed_terminal",
    "rejected_before_consumption", "terminal_consumption_or_product_attempt_ambiguous",
  ];
  const expectedOutcomes = [
    "rejected_before_spend", "terminal_owner_authorization_spent_or_uncertain",
    "terminal_invocation_authorization_spent_or_uncertain", "terminal_recheck_or_context_finalization_failed",
    "terminal_source_lookup_failed", "terminal_source_invocation_failed_or_uncertain",
    "terminal_source_raw_validation_failed", "terminal_source_intake_failed",
    "terminal_supplementary_provider_failed_or_uncertain", "private_evidence_pipeline_failed_or_uncertain",
    "private_target_runtime_attestation_accepted_for_exact_candidate_proposal_only",
  ];
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
  const expectedRules = [
    "bind_exact_accepted_live_470_product_tree_design_review_and_acceptance",
    "bind_every_component_to_exact_product_commit_tree_and_independent_review",
    "bind_every_key_role_to_exact_closed_key_binding", "treat_owner_body_and_envelope_as_closed_canonical_data",
    "bind_complete_broker_authorization_registration_body_nonce_key_and_scope",
    "bind_exact_manifest_trust_registry_catalog_and_anchor_heads",
    "bind_owner_present_issuer_strong_factor_policy_and_evidence_class",
    "bind_all_five_ordered_provider_subject_scope_digests", "bind_canonical_private_database_and_anchor_destinations",
    "bind_context_and_cleanup_reservation_intents_not_reservations",
    "materialize_cleanup_then_context_only_inside_authorized_capsule_entry",
    "return_no_reservation_object_handle_or_capability_to_caller",
    "apply_exact_operation_budget_and_zero_every_undeclared_effect",
    "apply_one_per_ordered_provider_scope_and_aggregate_five_ceiling", "limit_owner_window_to_300_seconds",
    "limit_context_and_child_to_60_seconds_inside_owner_window", "start_cleanup_only_after_authenticated_child_exit",
    "complete_cleanup_within_120_seconds_of_exit_and_600_seconds_of_issue",
    "complete_finalization_within_30_seconds_of_accepted_cleanup",
    "require_pairwise_distinct_manifest_bound_key_roles",
    "retain_historical_keys_for_verification_only_and_forbid_new_writes", "use_postgresql_as_sole_global_write_authority",
    "anchor_all_four_owner_store_heads_independently",
    "atomically_close_owner_consumption_product_attempt_heads_and_anchor_request",
    "exclude_candidate_attempt_and_authorization_relabels_from_product_pair_uniqueness",
    "permit_only_same_idempotent_anchor_request_during_recovery", "never_resume_after_consumption_or_anchor_uncertainty",
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
  ];
  const expectedVocabularies: Array<[readonly string[], string[]]> = [
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1, expectedBodyFields],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_FIELDS_V1,
      expectedProductBindingFields],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_ROLES_V1,
      expectedProductBindingRoles],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_FIELDS_V1,
      expectedKeyBindingFields],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1, expectedEnvelopeFields],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RESERVATION_INTENTS_V1,
      expectedReservationIntents],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROVIDER_SCOPES_V1, expectedProviderScopes],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_CLEANUP_FACTS_V1, expectedCleanupFacts],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ALLOWED_EFFECTS_V1, expectedAllowedEffects],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROHIBITED_EFFECTS_V1,
      expectedProhibitedEffects],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PUBLIC_TERMINAL_FIELDS_V1,
      expectedPublicTerminalFields],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_STATES_V1, expectedStates],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_TERMINAL_OUTCOMES_V1, expectedOutcomes],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_ROLES_V1, expectedKeyRoles],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_RULES_V1, expectedRules],
  ];
  for (const [actual, expected] of expectedVocabularies) {
    assert.deepEqual(actual, expected);
    assert.equal(new Set(actual).size, actual.length);
    assert.equal(Object.isFrozen(actual), true);
  }
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1, {
    fields: expectedProductBindingFields, orderedRoles: expectedProductBindingRoles, exactCardinality: 42,
    duplicateRolesAllowed: false, extraFieldsAllowed: false,
  });
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1, {
    fields: expectedKeyBindingFields, orderedRoles: expectedKeyRoles, exactCardinality: 28,
    duplicateRolesAllowed: false, extraFieldsAllowed: false,
  });
  for (const schema of [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PRODUCT_BINDING_SCHEMA_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_KEY_BINDING_SCHEMA_V1]) {
    assert.equal(Object.isFrozen(schema), true);
    assert.equal(Object.isFrozen(schema.fields), true);
    assert.equal(Object.isFrozen(schema.orderedRoles), true);
    assert.equal(schema.orderedRoles.length, schema.exactCardinality);
  }
});

test("CR13A-LIVE-480 freezes every operation ceiling including one-per-provider lanes", () => {
  const single = (operation: string, maximum: number) => ({
    operation, aggregateMaximum: maximum, scopeMode: "single_scope", maximumPerScope: maximum,
  });
  const expected = [
    single("registration_nonce_transaction", 1), single("registration_anchor_cas", 1),
    single("registration_anchor_finalization", 1), single("trust_registry_authenticated_reads", 4),
    single("deployment_manifest_authenticated_reads", 4), single("trust_anchor_reads", 4),
    single("manifest_anchor_reads", 4), single("owner_store_read_transactions", 5),
    single("owner_attempt_anchor_reads", 4), single("trusted_postgresql_time_reads", 7),
    single("context_reservation_appends", 1), single("context_reservation_head_advances", 1),
    single("context_reservation_terminal_tombstones", 1), single("cleanup_reservation_appends", 1),
    single("cleanup_reservation_head_advances", 1), single("cleanup_reservation_terminal_tombstones", 1),
    single("owner_consumption_product_attempt_transactions", 1), single("owner_attempt_anchor_cas", 1),
    single("owner_attempt_anchor_finalization", 1), single("broker_consumption_transactions", 1),
    single("broker_head_advances", 1), single("broker_rechecks", 1), single("source_lookups", 1),
    single("source_invocations", 1),
    { operation: "provider_reservations", aggregateMaximum: 5, scopeMode: "ordered_provider_scopes",
      maximumPerScope: 1 },
    { operation: "provider_invocations", aggregateMaximum: 5, scopeMode: "ordered_provider_scopes",
      maximumPerScope: 1 },
    single("privacy_transforms", 1), single("platform_signatures", 1), single("private_verifications", 1),
    single("attestation_pending_appends", 1), single("attestation_head_advances", 1),
    single("attestation_anchor_reads", 4), single("attestation_anchor_cas", 1),
    single("attestation_finalizations", 1), single("disposable_child_creations", 1),
    single("launch_ipc_frames", 1), single("settlement_ipc_frames", 1), single("disposable_child_terminations", 1),
    single("cleanup_observations", 1), single("cleanup_signatures", 1), single("cleanup_pending_appends", 1),
    single("cleanup_head_advances", 1), single("cleanup_anchor_reads", 3), single("cleanup_anchor_cas", 1),
    single("cleanup_finalizations", 1), single("final_acceptance_appends", 1), single("public_projections", 1),
    single("independent_review_submissions", 1), single("read_only_recovery_queries_per_immutable_request", 1),
  ];
  const actual = CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_OPERATION_BUDGET_V1;
  assert.deepEqual(actual, expected);
  assert.equal(actual.length, 49);
  assert.equal(new Set(actual.map(({ operation }) => operation)).size, actual.length);
  for (const budget of actual) {
    assert.equal(Object.isFrozen(budget), true);
    assert.equal(Number.isSafeInteger(budget.aggregateMaximum), true);
    assert.equal(Number.isSafeInteger(budget.maximumPerScope), true);
    assert.ok(budget.aggregateMaximum > 0);
    assert.ok(budget.maximumPerScope > 0);
  }
  const providerBudgets = actual.filter(({ scopeMode }) => scopeMode === "ordered_provider_scopes");
  assert.deepEqual(providerBudgets.map(({ operation }) => operation), ["provider_reservations", "provider_invocations"]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROVIDER_SCOPES_V1.length, 5);
  assert.equal(new Set(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_PROVIDER_SCOPES_V1).size, 5);
});

test("CR13A-LIVE-480 preserves exact time relationships", () => {
  const contract = connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1;
  assert.equal(contract.maximumOwnerWindowSeconds, 300);
  assert.equal(contract.maximumContextAndChildLifetimeSeconds, 60);
  assert.equal(contract.maximumCleanupAfterExitSeconds, 120);
  assert.equal(contract.maximumCleanupAfterIssueSeconds, 600);
  assert.equal(contract.maximumFinalizationAfterCleanupSeconds, 30);
});

test("CR13A-LIVE-480 requires complete owner authority while implementing none", () => {
  const contract = connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1;
  for (const key of ["ownerPresentIssuerRequired", "strongFactorRevisionRequired", "completeBrokerBindingRequired",
    "exactManifestTrustAndAnchorBindingRequired", "providerSubjectScopeDigestsRequired",
    "canonicalPrivateDestinationDigestsRequired", "reservationIntentsAreNotCapabilities",
    "postgresqlSoleGlobalWriteAuthorityRequired", "independentAllOwnerHeadAnchorRequired",
    "atomicOwnerConsumptionProductClosureRequired", "noResumeAfterConsumptionUncertaintyRequired",
    "sameModuleLexicalCapsuleRequired", "closedPublicTerminalSchemaRequired", "transitiveImportInertiaRequired",
    "repositoryContractOnly",
  ] as const) assert.equal(contract[key], true, key);
  for (const key of ["bodyExtraFieldsAllowed", "envelopeExtraFieldsAllowed", "reservationObjectInEnvelopeAllowed",
    "callerDependencyInjectionAllowed", "retryOrResumeAfterUncertaintyAllowed", "issuerImplemented",
    "storeImplemented", "keyRolesImplemented", "manifestOrTrustImplemented", "independentAnchorImplemented",
    "contextOrCleanupReservationImplemented", "productionCapsuleImplemented", "supplementaryProvidersImplemented",
    "sourceOwnerModified", "ipcOrProcessImplemented", "nativeExecutionImplemented", "runtimeWired",
    "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
  ] as const) assert.equal(contract[key], false, key);
  assert.deepEqual([
    contract.maximumCurrentOwnerAuthorizations, contract.maximumCurrentReservationMaterializations,
    contract.maximumCurrentProductAttempts, contract.maximumCurrentProcesses, contract.maximumCurrentNativeCalls,
  ], [0, 0, 0, 0, 0]);
});

test("CR13A-LIVE-480 publishes 59 zero actuals, eight false grants, and no blocker clearance", () => {
  const status = connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1(status), status);
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(actuals.length, 59);
  assert.deepEqual(actuals, new Array(59).fill(0));
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.externalEffectOccurred, false);
  assert.equal(status.targetRuntimeBlockerCleared, false);
  assert.equal(status.nativeAttemptState, "not_attempted");
  assert.equal(status.runtimeState, "not_wired");
});

test("CR13A-LIVE-480 rejects copies, accessors, Symbols, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1({
    ...connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1(Object.freeze({
    ...connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
    providerSubjectScopes: Object.freeze([
      "running_executable_content", "running_executable_content", "attestor_process_session",
      "running_qualification_harness_artifact", "running_physical_driver_artifact",
    ]),
  })), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1({
    ...connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1(Symbol("owner")),
    "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("owner body accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("owner body proxy"); },
    get() { executions += 1; throw new Error("owner body proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1(proxy),
    "invalid_status");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-480 freezes records, parsers, nested budgets, and safe errors", () => {
  for (const value of [connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
    connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1,
    ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1,
    ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1.prototype,
    parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
    parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const error = new ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1("raw owner identity");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-480 parsers retain captured intrinsics after ambient replacement", () => {
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
    Array.prototype.some = function () { executions[3] += 1; throw new Error("owner ambient"); };
    Reflect.apply = () => { executions[4] += 1; throw new Error("owner ambient"); };
    parsedContract = parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1(
      connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1);
    parsedStatus = parseConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1(
      connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1);
  } finally {
    Object.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Array.prototype.some = originalArraySome;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(parsedContract, connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1);
  assert.equal(parsedStatus, connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1);
  assert.deepEqual(executions, new Array(5).fill(0));
});

test("CR13A-LIVE-480 transitive production import graph is exact and effect-inert", async () => {
  const graph = new Map<string, readonly string[]>([
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
    "spawn", "spawnSync", "fork", "readFile", "readFileSync",
    "writeFile", "writeFileSync", "appendFile", "appendFileSync", "open", "openSync", "rm", "rmSync", "unlink",
    "unlinkSync", "query", "transaction", "getaddrinfo", "lookup", "chdir", "cwd", "exit", "kill",
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
      } else if (ts.isPropertyAccessExpression(node)
        && node.expression.getText(source) === "process"
        && ["env", "argv", "pid", "platform"].includes(node.name.text)) {
        violations.push(`process.${node.name.text}`);
      } else if (ts.isIdentifier(node) && effectNames.has(node.text)) {
        violations.push(`effect reference ${node.text}`);
      } else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
        && effectNames.has(node.argumentExpression.text)) {
        violations.push(`effect element reference ${node.argumentExpression.text}`);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    assert.deepEqual(violations, [], `${relativeFile}: transitive effect path`);
    assert.doesNotMatch(text, /private-loopback-unreachable-atomic-native-observation-source/);
    assert.doesNotMatch(text, /insert into|update .* set|compareAndSwap|keychain|child_process|node:os|node:process/i);
    assert.doesNotMatch(text,
      /function (?:issue|register|consume|materialize|resolve|invoke|observe|sign|persist|checkpoint|recover|launch|deploy)/);
  }
  assert.deepEqual([...discovered].sort(), [...graph.keys()].sort());
});

test("CR13A-LIVE-480 has only the safe barrel and dependency-ordered LIVE-490 contract as consumers", async () => {
  const consumers: string[] = [];
  const barrel = resolve(root, "src/connection-registry/v1/index.ts");
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    if ((await readFile(file, "utf8")).includes(moduleName)) consumers.push(file);
  }
  const live490Contract = resolve(root, "src/connection-registry/v1/private-loopback-trust-manifest-anchor-contract.ts");
  assert.deepEqual(consumers.sort(), [barrel, live490Contract].sort());
  assert.equal(connectionRegistryBarrel.connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
    connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1);
});

test("CR13A-LIVE-480 public records are sanitized and durable evidence keeps all effects at zero", async () => {
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
    status: connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationStatusV1,
    error: new ConnectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationErrorV1("raw owner identity"),
  });
  assert.doesNotMatch(serialized, /\/Users\/|127\.0\.0\.1|localhost|raw owner identity|stack/);
  assert.doesNotMatch(serialized, /ownerEmail|username|password|credentialValue|privateKeyValue/);

  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_470_PRODUCTION_CAPSULE_OWNER_NATIVE_AUTHORIZATION_DESIGN.md"), "utf8");
  const acceptance = await readFile(resolve(root, "docs/CR13A_LIVE_470_ARCHITECTURE_ACCEPTANCE.md"), "utf8");
  const status = await readFile(resolve(root, "docs/BUILD_STATUS.md"), "utf8");
  for (const text of [architecture, acceptance, status]) {
    assert.match(text, /CR13A-LIVE-4(?:70|80)/);
    assert.match(text, /zero|no protected|repository-only|inert/i);
  }
});
