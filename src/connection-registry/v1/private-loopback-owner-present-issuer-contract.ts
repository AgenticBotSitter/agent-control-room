import { sha256Digest } from "../../security/canonical-digest";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";
import { assertNoSecretMaterial } from "../../security/redaction";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1,
  connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
} from "./private-loopback-owner-native-authorization-contract";
import {
  connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
} from "./private-loopback-trust-manifest-anchor-contract";

const arraySomeV1 = Array.prototype.some;
const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-owner-present-issuer-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-owner-present-issuer-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_BINDING_FIELDS_V1 = objectFreezeV1([
  "role",
  "product_commit",
  "product_tree",
  "independent_review_sha256",
  "key_role",
  "key_id_digest",
  "key_fingerprint",
  "key_revision",
  "trust_registry_entry_digest",
  "owner_present_issuer_product_binding_digest",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_ROLES_V1 = objectFreezeV1([
  "owner_presence_challenge_minter",
  "strong_factor_verifier",
  "owner_issuer_attempt_and_replay_guard_store",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_KEY_ROLES_V1 = objectFreezeV1([
  "owner_presence_challenge_state",
  "strong_factor_evidence_verification",
  "owner_issuer_attempt_and_replay_guard_state",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_BINDING_SCHEMA_V1 = objectFreezeV1({
  fields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_BINDING_FIELDS_V1,
  orderedRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_ROLES_V1,
  orderedKeyRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_KEY_ROLES_V1,
  exactCardinality: 3 as const,
  everyProductCommitTreeReviewAndKeyBindingRequired: true as const,
  everyBindingSelectedByCurrentSignedManifestAndTrustRegistry: true as const,
  everyBindingTransitivelyOwnedByOwnerPresentIssuerProductReview: true as const,
  pairwiseDistinctProductsAndKeysRequired: true as const,
  callerSuppliedBindingAllowed: false as const,
  extraFieldsAllowed: false as const,
});

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_FIELDS_V1 = objectFreezeV1([
  "request_schema_version",
  "request_id_digest",
  "accepted_owner_authorization_contract_digest",
  "accepted_trust_manifest_anchor_contract_digest",
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
  "source_owner_product_binding_digest",
  "runner_product_binding_digest",
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
  "owner_policy_revision",
  "strong_factor_policy_revision",
  "required_strong_factor_evidence_class",
  "ordered_issuer_dependency_bindings",
  "requested_authorization_lifetime_seconds",
  "owner_facing_scope_summary_digest",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_SCHEMA_V1 = objectFreezeV1({
  fields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_FIELDS_V1,
  source: "module_minted_before_attempt_reservation_and_current_manifest_and_trust_preflight" as const,
  callerConstructible: false as const,
  arbitraryOptionsAllowed: false as const,
  callbacksAllowed: false as const,
  dependencyInjectionAllowed: false as const,
  rawAuthorizationBodyAllowed: false as const,
  rawCredentialOrOwnerIdentityAllowed: false as const,
  extraFieldsAllowed: false as const,
});

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_CEREMONY_FIELDS_V1 = objectFreezeV1([
  "ceremony_schema_version",
  "ceremony_id_digest",
  "request_id_digest",
  "issuer_product_commit",
  "issuer_product_tree",
  "issuer_independent_review_sha256",
  "owner_presence_channel",
  "owner_facing_scope_summary_digest",
  "challenge_digest",
  "ceremony_started_at",
  "ceremony_expires_at",
  "challenge_issued_at",
  "challenge_not_before",
  "challenge_expires_at",
  "owner_presence_confirmation_digest",
  "owner_presence_confirmed_at",
  "owner_policy_revision",
  "strong_factor_policy_revision",
  "required_strong_factor_evidence_class",
  "ceremony_result",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_CHANNELS_V1 = objectFreezeV1([
  "target_host_owner_attended_native_confirmation",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_RESULTS_V1 = objectFreezeV1([
  "confirmed_for_exact_request",
  "declined",
  "cancelled",
  "expired",
  "terminal_ambiguous",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_CLASSES_V1 = objectFreezeV1([
  objectFreezeV1({
    evidenceClass: "platform_phishing_resistant_user_verification" as const,
    phishingResistant: true as const,
    hardwareProtectedRequired: true as const,
    separateOwnerPresenceRequired: true as const,
  }),
  objectFreezeV1({
    evidenceClass: "roaming_hardware_phishing_resistant_user_verification" as const,
    phishingResistant: true as const,
    hardwareProtectedRequired: true as const,
    separateOwnerPresenceRequired: true as const,
  }),
  objectFreezeV1({
    evidenceClass: "password_manager_totp_with_separate_owner_presence" as const,
    phishingResistant: false as const,
    hardwareProtectedRequired: false as const,
    separateOwnerPresenceRequired: true as const,
  }),
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_EVIDENCE_FIELDS_V1 = objectFreezeV1([
  "evidence_schema_version",
  "evidence_id_digest",
  "ceremony_id_digest",
  "request_id_digest",
  "verifier_product_commit",
  "verifier_product_tree",
  "verifier_independent_review_sha256",
  "verifier_key_role",
  "verifier_key_id_digest",
  "verifier_key_fingerprint",
  "verifier_key_revision",
  "verifier_trust_registry_entry_digest",
  "strong_factor_policy_revision",
  "evidence_class",
  "challenge_digest",
  "owner_presence_confirmation_digest",
  "credential_reference_digest",
  "verification_assertion_digest",
  "verification_issued_at",
  "verification_expires_at",
  "verification_observed_at",
  "replay_guard_digest",
  "user_verification_performed",
  "owner_presence_performed",
  "phishing_resistant",
  "hardware_protected",
  "verification_result",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_RESULTS_V1 = objectFreezeV1([
  "verified_for_exact_challenge",
  "rejected",
  "cancelled",
  "expired",
  "revoked",
  "terminal_ambiguous",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_PREFLIGHT_FIELDS_V1 = objectFreezeV1([
  "preflight_schema_version",
  "request_id_digest",
  "owner_root_pin_product_digest",
  "trust_registry_id_digest",
  "trust_registry_sequence",
  "trust_registry_digest",
  "trust_registry_anchor_revision",
  "trust_registry_anchor_head_digest",
  "deployment_manifest_id_digest",
  "deployment_manifest_sequence",
  "deployment_manifest_digest",
  "manifest_anchor_revision",
  "manifest_anchor_head_digest",
  "owner_present_issuer_product_binding_digest",
  "owner_authorization_sealing_key_binding_digest",
  "ordered_issuer_dependency_bindings_digest",
  "owner_policy_revision",
  "strong_factor_policy_revision",
  "required_strong_factor_evidence_class",
  "preflight_result",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FINAL_TRUST_RECHECK_FIELDS_V1 = objectFreezeV1([
  "recheck_schema_version",
  "request_id_digest",
  "attempt_marker_digest",
  "ceremony_id_digest",
  "challenge_digest",
  "owner_presence_confirmation_digest",
  "strong_factor_evidence_digest",
  "ordered_issuer_dependency_bindings_digest",
  "owner_root_pin_product_digest",
  "trust_registry_id_digest",
  "trust_registry_sequence",
  "trust_registry_digest",
  "trust_registry_anchor_revision",
  "trust_registry_anchor_head_digest",
  "deployment_manifest_id_digest",
  "deployment_manifest_sequence",
  "deployment_manifest_digest",
  "manifest_anchor_revision",
  "manifest_anchor_head_digest",
  "owner_present_issuer_product_binding_digest",
  "owner_authorization_sealing_key_binding_digest",
  "owner_policy_revision",
  "strong_factor_policy_revision",
  "rechecked_at",
  "recheck_result",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_PREFLIGHT_RESULTS_V1 = objectFreezeV1([
  "current_exact_scope_accepted",
  "missing_or_unreadable",
  "signature_chain_invalid",
  "anchor_mismatch_or_rollback",
  "product_or_key_binding_invalid",
  "scope_or_policy_mismatch",
  "expired_revoked_or_not_yet_valid",
  "terminal_ambiguous",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FINAL_TRUST_RECHECK_RESULTS_V1 = objectFreezeV1([
  "all_initial_bindings_still_current_for_exact_evidence",
  "trust_manifest_anchor_or_dependency_changed",
  "scope_policy_or_evidence_mismatch",
  "ceremony_challenge_or_factor_expired",
  "trusted_time_rollback_or_skew",
  "terminal_ambiguous",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_CHALLENGE_FIELDS_V1 = objectFreezeV1([
  "challenge_schema_version",
  "challenge_id_digest",
  "request_id_digest",
  "attempt_marker_digest",
  "tenant_id_digest",
  "node_id_digest",
  "source_owner_product_binding_digest",
  "runner_product_binding_digest",
  "attempt_id_digest",
  "owner_facing_scope_summary_digest",
  "challenge_minter_binding_digest",
  "challenge_minter_key_binding_digest",
  "replay_guard_store_binding_digest",
  "challenge_domain",
  "challenge_random_digest",
  "minimum_entropy_bits",
  "issued_at",
  "not_before",
  "expires_at",
  "single_use_reservation_id_digest",
  "single_use_reservation_record_digest",
  "challenge_body_digest",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_CHALLENGE_DOMAINS_V1 = objectFreezeV1([
  "control_room_owner_present_native_authorization_challenge_v1",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_ATTEMPT_MARKER_FIELDS_V1 = objectFreezeV1([
  "marker_schema_version",
  "tenant_id_digest",
  "node_id_digest",
  "source_owner_product_binding_digest",
  "runner_product_binding_digest",
  "attempt_id_digest",
  "request_id_digest",
  "ceremony_id_digest_or_zero",
  "challenge_reservation_digest_or_zero",
  "factor_effect_marker_digest_or_zero",
  "sealing_effect_marker_digest_or_zero",
  "state",
  "prior_record_digest",
  "record_digest",
  "state_authentication_tag",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_ATTEMPT_MARKER_STATES_V1 = objectFreezeV1([
  "request_reserved",
  "challenge_reserved_attempt_burned",
  "factor_verification_started",
  "factor_verified",
  "sealing_started",
  "issued_unregistered",
  "terminal_refused_before_challenge",
  "terminal_closed_after_challenge",
  "terminal_ambiguous",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_CHRONOLOGY_INVARIANTS_V1 = objectFreezeV1([
  "attempt_marker_commits_before_initial_preflight_or_any_owner_or_factor_effect",
  "initial_preflight_accepts_before_challenge_minting",
  "challenge_reservation_commits_before_challenge_display_or_factor_verification",
  "ceremony_started_at_is_not_after_challenge_issued_at",
  "challenge_issued_at_is_not_after_challenge_not_before",
  "challenge_not_before_is_not_after_owner_presence_confirmed_at",
  "owner_presence_confirmed_at_is_not_after_factor_verification_issued_at",
  "factor_verification_issued_at_is_not_after_verification_observed_at",
  "verification_observed_at_is_not_after_final_trust_rechecked_at",
  "final_trust_rechecked_at_is_not_after_nonce_and_body_time",
  "nonce_and_body_time_is_not_after_immediate_pre_seal_time",
  "every_acceptance_time_is_at_or_after_its_inclusive_not_before",
  "every_acceptance_time_is_strictly_before_challenge_factor_ceremony_and_authorization_expiry",
  "no_evidence_timestamp_may_be_future_dated_beyond_five_second_skew",
  "trusted_time_is_read_at_challenge_factor_acceptance_final_recheck_nonce_body_and_pre_seal_boundaries",
  "any_time_unavailability_rollback_skew_expiry_or_uncertainty_is_terminal",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_UNIQUENESS_RULES_V1 = objectFreezeV1([
  "one_request_id_maps_to_one_tenant_node_source_runner_attempt_tuple",
  "one_attempt_tuple_maps_to_exactly_one_request_and_one_ceremony",
  "one_challenge_reservation_one_factor_call_and_one_seal_maximum_per_attempt_tuple",
  "challenge_reservation_durably_burns_the_attempt_tuple_before_owner_display",
  "success_or_any_post_marker_uncertainty_permanently_burns_the_attempt_tuple",
  "known_pre_challenge_refusal_closes_the_attempt_tuple_without_authorization",
  "any_owner_authorized_restart_requires_new_request_attempt_ceremony_challenge_and_nonce",
  "source_owner_or_runner_relabeling_cannot_reopen_an_attempt_tuple",
  "exact_replay_returns_inert_terminal_truth_and_never_reexecutes_an_effect",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUSTED_TIME_NONCE_INTENT_FIELDS_V1 = objectFreezeV1([
  "intent_schema_version",
  "ceremony_id_digest",
  "request_id_digest",
  "attempt_marker_digest",
  "final_trust_recheck_digest",
  "trusted_time_authority_class",
  "authorization_nonce_domain",
  "minimum_nonce_entropy_bits",
  "nonce_uniqueness_scope",
  "maximum_clock_skew_seconds",
  "maximum_authorization_lifetime_seconds",
  "manifest_and_trust_recheck_required_before_body_construction",
  "fresh_nonce_required_after_strong_factor_verification",
  "nonce_reservation_required_during_registration",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUSTED_TIME_AUTHORITIES_V1 = objectFreezeV1([
  "private_postgresql_transaction_time",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STAGES_V1 = objectFreezeV1([
  "attempt_scope_reserved",
  "accepted_product_and_policy_preflight",
  "trusted_challenge_minted_and_reserved",
  "owner_presence_confirmation_observed",
  "strong_factor_verification_observed",
  "current_trust_rechecked",
  "fresh_authorization_nonce_and_trusted_time_observed",
  "canonical_owner_body_constructed",
  "owner_authorization_sealed",
  "private_unregistered_output_delivered",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STATES_V1 = objectFreezeV1([
  "inert_contract_only",
  "attempt_scope_reservation_pending",
  "preflight_pending",
  "owner_presence_pending",
  "strong_factor_pending",
  "trust_recheck_pending",
  "time_nonce_pending",
  "body_construction_pending",
  "sealing_pending",
  "issued_unregistered",
  "terminal_refused",
  "terminal_ambiguous",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_DECISIONS_V1 = objectFreezeV1([
  "sealed_authorization_issued_unregistered",
  "known_refusal_before_authorization_construction",
  "terminal_issuer_outcome_ambiguous",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REFUSALS_V1 = objectFreezeV1([
  "accepted_predecessor_evidence_mismatch",
  "request_not_module_minted",
  "request_or_attempt_tuple_already_reserved_or_burned",
  "request_scope_or_policy_mismatch",
  "trust_manifest_or_anchor_not_current",
  "issuer_product_or_sealing_key_not_current",
  "unsupported_or_downgraded_strong_factor_class",
  "owner_presence_not_confirmed_for_exact_request",
  "owner_declined_cancelled_or_timed_out",
  "strong_factor_not_verified_for_exact_challenge",
  "strong_factor_evidence_stale_revoked_replayed_or_mismatched",
  "trusted_time_unavailable_or_rollback_suspected",
  "fresh_nonce_unavailable_or_duplicate_suspected",
  "requested_lifetime_invalid_or_exceeds_ceiling",
  "body_or_envelope_canonicalization_failed",
  "trust_changed_before_body_construction",
  "every_unknown_or_undeclared_condition",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUED_OUTPUT_FIELDS_V1 = objectFreezeV1([
  "output_schema_version",
  "decision",
  "request_id_digest",
  "ceremony_id_digest",
  "sealed_owner_native_authorization_envelope",
  "sealed_envelope_digest",
  "issuer_product_commit",
  "issuer_product_tree",
  "issuer_independent_review_sha256",
  "issued_at",
  "not_before",
  "expires_at",
  "registration_required",
  "output_digest",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_REFUSAL_OUTPUT_FIELDS_V1 = objectFreezeV1([
  "output_schema_version",
  "decision",
  "safe_refusal_code",
  "request_and_attempt_tuple_terminally_closed",
  "owner_action_may_start_new_attempt_ceremony",
  "authorization_created",
  "authorization_registered",
  "output_digest",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_PROHIBITED_EFFECTS_V1 = objectFreezeV1([
  "owner_prompt_or_user_interface",
  "keychain_secret_store_or_credential_access",
  "biometric_or_authenticator_access",
  "raw_totp_password_pin_credential_or_owner_identity_read",
  "strong_factor_verification_call",
  "clock_read_or_trusted_time_query",
  "nonce_randomness_or_replay_guard_generation",
  "owner_authorization_body_construction",
  "canonical_authorization_encoding_or_sealing",
  "signature_mac_or_verification_operation",
  "root_registry_manifest_or_anchor_resolution",
  "authorization_registration_reservation_consumption_or_revocation",
  "database_read_write_migration_or_transaction",
  "filesystem_environment_host_or_process_read",
  "source_or_provider_lookup_or_invocation",
  "listener_socket_or_network_access",
  "timer_handler_or_process_creation",
  "arbitrary_command_or_shell",
  "ssh_mcp_or_plugin",
  "application_or_runtime_activation",
  "candidate_assembly_or_physical_qualification",
  "deployment_dns_or_hosting_change",
  "caller_dependency_injection_or_generic_locator",
  "every_undeclared_effect",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_RULES_V1 = objectFreezeV1([
  "bind_exact_accepted_live_480_product_tree_review_and_acceptance",
  "bind_exact_accepted_live_490_product_tree_review_and_acceptance",
  "require_separately_accepted_manifest_and_registry_extension_for_all_three_issuer_dependency_roles_and_keys_before_protected_implementation",
  "bind_each_challenge_minter_factor_verifier_and_replay_guard_product_tree_review_and_key_to_current_signed_manifest_and_registry",
  "require_pairwise_distinct_dependency_products_and_keys_transitively_owned_by_the_owner_present_issuer_review",
  "accept_only_module_minted_request_identity_before_attempt_reservation_and_current_manifest_and_trust_preflight",
  "bind_request_to_exact_tenant_project_connection_node_source_owner_runner_deployment_policy_operation_candidate_and_attempt_scope",
  "bind_request_to_current_manifest_registry_and_both_current_anchor_heads",
  "bind_owner_present_issuer_and_owner_authorization_sealing_key_to_current_manifest_and_registry",
  "persist_one_authenticated_attempt_marker_before_initial_preflight_or_any_owner_factor_sealing_or_network_effect",
  "reject_every_reused_request_or_tenant_node_source_owner_runner_attempt_tuple",
  "mint_one_domain_separated_256_bit_minimum_entropy_challenge_after_preflight_using_private_postgresql_transaction_time",
  "durably_reserve_the_challenge_and_burn_the_attempt_tuple_before_owner_display_or_factor_verification",
  "present_one_exact_owner_facing_scope_summary_on_the_target_host",
  "require_separate_owner_presence_and_strong_factor_evidence_for_the_same_exact_challenge",
  "permit_only_one_policy_selected_strong_factor_class_without_fallback_or_downgrade",
  "mark_totp_class_non_phishing_resistant_and_require_separate_owner_presence",
  "never_treat_login_session_ui_click_or_conversational_approval_as_strong_factor_evidence",
  "never_retain_log_return_or_publicly_project_raw_credential_biometric_code_owner_identity_or_assertion",
  "bind_factor_evidence_to_exact_rooted_verifier_product_tree_review_key_policy_class_ceremony_request_challenge_and_replay_guard",
  "independently_verify_factor_evidence_with_the_current_rooted_verifier_key_for_the_exact_scope",
  "perform_at_most_one_strong_factor_verification_for_one_request_attempt_tuple",
  "reject_stale_revoked_replayed_mismatched_or_ambiguous_factor_evidence",
  "recheck_current_root_registry_manifest_anchors_all_dependency_products_and_keys_scope_policy_challenge_and_factor_evidence_after_factor_verification",
  "enforce_the_exact_declared_chronology_using_fresh_private_postgresql_time_at_each_security_boundary",
  "reject_future_dated_expired_out_of_order_rollback_skewed_or_time_uncertain_evidence_as_terminal",
  "obtain_fresh_256_bit_minimum_authorization_nonce_only_after_factor_verification",
  "use_only_private_postgresql_transaction_time_for_issuer_security_decisions",
  "bind_inclusive_not_before_exclusive_expiry_and_maximum_300_second_authorization_lifetime",
  "construct_the_exact_live_480_body_internally_after_final_trust_recheck",
  "seal_once_with_exact_current_owner_authorization_key_and_live_480_envelope_schema",
  "return_only_one_private_sealed_unregistered_envelope_and_never_body_key_nonce_or_evidence",
  "require_separate_authenticated_registration_and_nonce_reservation_before_capsule_use",
  "never_treat_issuance_as_registration_consumption_qualification_candidate_activation_or_execution",
  "make_every_post_verifier_or_post_sealing_uncertainty_terminal_without_retry_or_resume",
  "permanently_burn_the_request_and_attempt_tuple_after_challenge_reservation_success_or_any_post_marker_uncertainty",
  "close_every_known_pre_challenge_refusal_and_require_new_request_attempt_ceremony_challenge_and_nonce_for_restart",
  "make_exact_replay_return_only_inert_terminal_truth_without_reexecuting_any_effect",
  "perform_no_import_time_or_contract_construction_host_or_protected_read",
  "keep_complete_transitive_production_import_graph_inert",
  "export_no_issuer_verifier_prompt_clock_nonce_sealer_resolver_store_or_dependency_factory",
  "grant_no_approval_qualification_candidate_activation_network_command_lease_or_execution_authority",
] as const);

export class ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "issuer_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "issuer_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "owner present issuer contract record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live480ProductCommit: "6d510d6f1b80a98c00c16fcf2b55837afc1cea87",
  live480ProductTree: "ac8655e1240d25bea9150ae9678f6ad5df56593c",
  live490ProductCommit: "dc313b1f2ff5982fe0ffa3b505db36025036601f",
  live490ProductTree: "de7b73195fdbc4eb08097e2da7eb7cd97e4f48a3",
  acceptedLive480ReviewSha256: "854d3688cd9a02dd57d2c645580d8c195e577e3673bedcdf11ba0073af14e71d",
  acceptedLive480AcceptanceSha256: "5f549c3f05ce77cd5a536e9b711a4e7a1c5bddde7ee8d75fd68474fe6578ab46",
  acceptedLive490ReviewSha256: "56b03b7941971c50867553dc26c65a74cb9e4e291ba1a2543f5a9ac2708b2eb7",
  acceptedLive490AcceptanceSha256: "2307475e02a176465c158cbe93b4a8c8a2b39ec6f3bb74cfba2281441a484f9d",
  issuerDependencyBindingSchema: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_BINDING_SCHEMA_V1,
  requestSchema: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_SCHEMA_V1,
  ceremonyFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_CEREMONY_FIELDS_V1,
  strongFactorClasses: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_CLASSES_V1,
  strongFactorEvidenceFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_EVIDENCE_FIELDS_V1,
  trustPreflightFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_PREFLIGHT_FIELDS_V1,
  finalTrustRecheckFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FINAL_TRUST_RECHECK_FIELDS_V1,
  ownerChallengeFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_CHALLENGE_FIELDS_V1,
  issuerAttemptMarkerFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_ATTEMPT_MARKER_FIELDS_V1,
  chronologyInvariants: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_CHRONOLOGY_INVARIANTS_V1,
  uniquenessRules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_UNIQUENESS_RULES_V1,
  timeNonceIntentFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUSTED_TIME_NONCE_INTENT_FIELDS_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STAGES_V1,
  decisions: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_DECISIONS_V1,
  refusals: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REFUSALS_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_RULES_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_CONTRACT_V1,
  contractReference: `owner-present-issuer:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live480ProductCommit: "6d510d6f1b80a98c00c16fcf2b55837afc1cea87" as const,
  live480ProductTree: "ac8655e1240d25bea9150ae9678f6ad5df56593c" as const,
  acceptedLive480ReviewSha256: "854d3688cd9a02dd57d2c645580d8c195e577e3673bedcdf11ba0073af14e71d" as const,
  acceptedLive480AcceptanceSha256: "5f549c3f05ce77cd5a536e9b711a4e7a1c5bddde7ee8d75fd68474fe6578ab46" as const,
  live490ProductCommit: "dc313b1f2ff5982fe0ffa3b505db36025036601f" as const,
  live490ProductTree: "de7b73195fdbc4eb08097e2da7eb7cd97e4f48a3" as const,
  acceptedLive490ReviewSha256: "56b03b7941971c50867553dc26c65a74cb9e4e291ba1a2543f5a9ac2708b2eb7" as const,
  acceptedLive490AcceptanceSha256: "2307475e02a176465c158cbe93b4a8c8a2b39ec6f3bb74cfba2281441a484f9d" as const,
  acceptedOwnerAuthorizationContract: connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
  acceptedTrustManifestAnchorContract: connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
  acceptedOwnerAuthorizationBodyFields:
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1,
  acceptedOwnerAuthorizationEnvelopeFields:
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1,
  issuerDependencyBindingFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_BINDING_FIELDS_V1,
  issuerDependencyRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_ROLES_V1,
  issuerDependencyKeyRoles: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_KEY_ROLES_V1,
  issuerDependencyBindingSchema: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_BINDING_SCHEMA_V1,
  requestFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_FIELDS_V1,
  requestSchema: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_SCHEMA_V1,
  ceremonyFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_CEREMONY_FIELDS_V1,
  ownerPresenceChannels: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_CHANNELS_V1,
  ownerPresenceResults: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_RESULTS_V1,
  strongFactorClasses: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_CLASSES_V1,
  strongFactorEvidenceFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_EVIDENCE_FIELDS_V1,
  strongFactorResults: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_RESULTS_V1,
  trustPreflightFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_PREFLIGHT_FIELDS_V1,
  trustPreflightResults: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_PREFLIGHT_RESULTS_V1,
  finalTrustRecheckFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FINAL_TRUST_RECHECK_FIELDS_V1,
  finalTrustRecheckResults: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FINAL_TRUST_RECHECK_RESULTS_V1,
  ownerChallengeFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_CHALLENGE_FIELDS_V1,
  ownerChallengeDomains: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_CHALLENGE_DOMAINS_V1,
  issuerAttemptMarkerFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_ATTEMPT_MARKER_FIELDS_V1,
  issuerAttemptMarkerStates: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_ATTEMPT_MARKER_STATES_V1,
  chronologyInvariants: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_CHRONOLOGY_INVARIANTS_V1,
  uniquenessRules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_UNIQUENESS_RULES_V1,
  trustedTimeNonceIntentFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUSTED_TIME_NONCE_INTENT_FIELDS_V1,
  trustedTimeAuthorities: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUSTED_TIME_AUTHORITIES_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STAGES_V1,
  states: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STATES_V1,
  decisions: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_DECISIONS_V1,
  refusals: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REFUSALS_V1,
  issuedOutputFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUED_OUTPUT_FIELDS_V1,
  refusalOutputFields: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_REFUSAL_OUTPUT_FIELDS_V1,
  prohibitedEffects: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_PROHIBITED_EFFECTS_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_RULES_V1,
  minimumChallengeEntropyBits: 256 as const,
  minimumAuthorizationNonceEntropyBits: 256 as const,
  maximumTrustedTimeReadsPerCeremony: 5 as const,
  maximumClockSkewSeconds: 5 as const,
  maximumChallengeLifetimeSeconds: 120 as const,
  maximumStrongFactorEvidenceLifetimeSeconds: 120 as const,
  maximumCeremonyLifetimeSeconds: 300 as const,
  maximumAuthorizationLifetimeSeconds: 300 as const,
  maximumCurrentAttemptMarkers: 0 as const,
  maximumCurrentChallengeReservations: 0 as const,
  maximumCurrentCeremonies: 0 as const,
  maximumCurrentStrongFactorVerifications: 0 as const,
  maximumCurrentAuthorizationsIssued: 0 as const,
  ownerPresenceRequired: true as const,
  strongFactorRequired: true as const,
  finalTrustRecheckRequired: true as const,
  freshNonceRequired: true as const,
  trustedTimeRequired: true as const,
  separateRegistrationRequired: true as const,
  trustManifestIssuerDependencyExtensionRequired: true as const,
  durableAttemptBurnRequired: true as const,
  transitiveImportInertiaRequired: true as const,
  callerConstructibleRequestAllowed: false as const,
  loginSessionAsStrongFactorAllowed: false as const,
  conversationalApprovalAsStrongFactorAllowed: false as const,
  factorFallbackOrDowngradeAllowed: false as const,
  rawCredentialOrOwnerIdentityRetentionAllowed: false as const,
  retryAfterUncertaintyAllowed: false as const,
  issuanceGrantsNativeAuthority: false as const,
  issuerImplemented: false as const,
  promptOrVerifierImplemented: false as const,
  clockOrNonceImplemented: false as const,
  bodyConstructionOrSealingImplemented: false as const,
  trustResolutionImplemented: false as const,
  storeOrRegistrationImplemented: false as const,
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
export const connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
export type ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1 =
  Readonly<typeof connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1>;
reflectApplyV1(weakSetAddV1, contractRecordsV1, [connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1, [connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1,
  connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1.contractDigest]);

const zeroActualsV1 = {
  actualAttemptMarkerWrites: 0 as const,
  actualRequestsAccepted: 0 as const,
  actualTrustPreflights: 0 as const,
  actualChallengesGenerated: 0 as const,
  actualChallengeReservations: 0 as const,
  actualOwnerPrompts: 0 as const,
  actualOwnerPresenceConfirmations: 0 as const,
  actualStrongFactorCalls: 0 as const,
  actualStrongFactorEvidenceRecords: 0 as const,
  actualCredentialsOrOwnerIdentitiesRead: 0 as const,
  actualBiometricOrAuthenticatorReads: 0 as const,
  actualKeychainOrCredentialStoreReads: 0 as const,
  actualTrustedTimeReads: 0 as const,
  actualClockReads: 0 as const,
  actualNoncesGenerated: 0 as const,
  actualReplayGuardsGenerated: 0 as const,
  actualTrustRechecks: 0 as const,
  actualOwnerAuthorizationBodiesConstructed: 0 as const,
  actualCanonicalEncodings: 0 as const,
  actualSealOperations: 0 as const,
  actualSignatureOrMacOperations: 0 as const,
  actualVerificationOperations: 0 as const,
  actualAuthorizationsIssued: 0 as const,
  actualAuthorizationsRegistered: 0 as const,
  actualNonceReservations: 0 as const,
  actualAuthorizationConsumptions: 0 as const,
  actualDatabaseReads: 0 as const,
  actualDatabaseWrites: 0 as const,
  actualMigrations: 0 as const,
  actualRegistryManifestOrAnchorReads: 0 as const,
  actualFilesystemReads: 0 as const,
  actualEnvironmentReads: 0 as const,
  actualHostReads: 0 as const,
  actualProcessesCreated: 0 as const,
  actualTimersCreated: 0 as const,
  actualSourceOrProviderCalls: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualNativeAttempts: 0 as const,
  actualCapsuleConstructions: 0 as const,
  actualCandidateAssemblies: 0 as const,
  actualDeployments: 0 as const,
  actualDnsOrHostingChanges: 0 as const,
};

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1.contractDigest,
  evidenceClass: "repository_contract_non_execution" as const,
  contractState: "implemented_inert_unwired" as const,
  issuerState: "vocabulary_only" as const,
  ownerPresenceState: "not_implemented" as const,
  strongFactorState: "not_implemented" as const,
  timeNonceState: "not_implemented" as const,
  sealingState: "not_implemented" as const,
  registrationState: "not_implemented" as const,
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
export const connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
export type ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1 =
  Readonly<typeof connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1>;
reflectApplyV1(weakSetAddV1, statusRecordsV1, [connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1, [connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1,
  connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1.statusDigest]);

const contractKeysV1 = objectFreezeV1([
  "contractVersion", "contractReference", "live480ProductCommit", "live480ProductTree",
  "acceptedLive480ReviewSha256", "acceptedLive480AcceptanceSha256", "live490ProductCommit", "live490ProductTree",
  "acceptedLive490ReviewSha256", "acceptedLive490AcceptanceSha256", "acceptedOwnerAuthorizationContract",
  "acceptedTrustManifestAnchorContract", "acceptedOwnerAuthorizationBodyFields",
  "acceptedOwnerAuthorizationEnvelopeFields", "issuerDependencyBindingFields", "issuerDependencyRoles",
  "issuerDependencyKeyRoles", "issuerDependencyBindingSchema", "requestFields", "requestSchema", "ceremonyFields",
  "ownerPresenceChannels", "ownerPresenceResults", "strongFactorClasses", "strongFactorEvidenceFields",
  "strongFactorResults", "trustPreflightFields", "trustPreflightResults", "finalTrustRecheckFields",
  "finalTrustRecheckResults", "ownerChallengeFields", "ownerChallengeDomains", "issuerAttemptMarkerFields",
  "issuerAttemptMarkerStates", "chronologyInvariants", "uniquenessRules", "trustedTimeNonceIntentFields",
  "trustedTimeAuthorities", "stages", "states", "decisions", "refusals", "issuedOutputFields",
  "refusalOutputFields", "prohibitedEffects", "rules", "minimumChallengeEntropyBits",
  "minimumAuthorizationNonceEntropyBits", "maximumTrustedTimeReadsPerCeremony",
  "maximumClockSkewSeconds", "maximumChallengeLifetimeSeconds", "maximumStrongFactorEvidenceLifetimeSeconds",
  "maximumCeremonyLifetimeSeconds", "maximumAuthorizationLifetimeSeconds", "maximumCurrentAttemptMarkers",
  "maximumCurrentChallengeReservations", "maximumCurrentCeremonies",
  "maximumCurrentStrongFactorVerifications", "maximumCurrentAuthorizationsIssued", "ownerPresenceRequired",
  "strongFactorRequired", "finalTrustRecheckRequired", "freshNonceRequired", "trustedTimeRequired",
  "separateRegistrationRequired", "trustManifestIssuerDependencyExtensionRequired", "durableAttemptBurnRequired",
  "transitiveImportInertiaRequired", "callerConstructibleRequestAllowed",
  "loginSessionAsStrongFactorAllowed", "conversationalApprovalAsStrongFactorAllowed",
  "factorFallbackOrDowngradeAllowed", "rawCredentialOrOwnerIdentityRetentionAllowed",
  "retryAfterUncertaintyAllowed", "issuanceGrantsNativeAuthority", "issuerImplemented",
  "promptOrVerifierImplemented", "clockOrNonceImplemented", "bodyConstructionOrSealingImplemented",
  "trustResolutionImplemented", "storeOrRegistrationImplemented", "runtimeWired", "repositoryContractOnly",
  "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
  "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
  "contractDigest",
] as const);

const statusKeysV1 = objectFreezeV1([
  "statusVersion", "contractReference", "contractDigest", "evidenceClass", "contractState", "issuerState",
  "ownerPresenceState", "strongFactorState", "timeNonceState", "sealingState", "registrationState",
  "runtimeState", "actualAttemptMarkerWrites", "actualRequestsAccepted", "actualTrustPreflights",
  "actualChallengesGenerated", "actualChallengeReservations", "actualOwnerPrompts",
  "actualOwnerPresenceConfirmations", "actualStrongFactorCalls", "actualStrongFactorEvidenceRecords",
  "actualCredentialsOrOwnerIdentitiesRead", "actualBiometricOrAuthenticatorReads",
  "actualKeychainOrCredentialStoreReads", "actualTrustedTimeReads", "actualClockReads", "actualNoncesGenerated",
  "actualReplayGuardsGenerated", "actualTrustRechecks", "actualOwnerAuthorizationBodiesConstructed",
  "actualCanonicalEncodings", "actualSealOperations", "actualSignatureOrMacOperations",
  "actualVerificationOperations", "actualAuthorizationsIssued", "actualAuthorizationsRegistered",
  "actualNonceReservations", "actualAuthorizationConsumptions", "actualDatabaseReads", "actualDatabaseWrites",
  "actualMigrations", "actualRegistryManifestOrAnchorReads", "actualFilesystemReads", "actualEnvironmentReads",
  "actualHostReads", "actualProcessesCreated", "actualTimersCreated", "actualSourceOrProviderCalls",
  "actualNetworkIoEvents", "actualNativeAttempts", "actualCapsuleConstructions", "actualCandidateAssemblies",
  "actualDeployments", "actualDnsOrHostingChanges", "externalEffectOccurred", "targetRuntimeBlockerCleared",
  "physicalQualificationAccepted", "candidateEligible", "activationEligible", "runtimeWired", "grantsApproval",
  "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
  "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
  "statusDigest",
] as const);

export function parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1;
  const captured = exactHostDataSnapshotV1(record, contractKeysV1);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  const requiredTrue = [record.ownerPresenceRequired, record.strongFactorRequired,
    record.finalTrustRecheckRequired, record.freshNonceRequired, record.trustedTimeRequired,
    record.separateRegistrationRequired, record.trustManifestIssuerDependencyExtensionRequired,
    record.durableAttemptBurnRequired, record.transitiveImportInertiaRequired, record.repositoryContractOnly];
  const requiredFalse = [record.callerConstructibleRequestAllowed, record.loginSessionAsStrongFactorAllowed,
    record.conversationalApprovalAsStrongFactorAllowed, record.factorFallbackOrDowngradeAllowed,
    record.rawCredentialOrOwnerIdentityRetentionAllowed, record.retryAfterUncertaintyAllowed,
    record.issuanceGrantsNativeAuthority, record.issuerImplemented, record.promptOrVerifierImplemented,
    record.clockOrNonceImplemented, record.bodyConstructionOrSealingImplemented, record.trustResolutionImplemented,
    record.storeOrRegistrationImplemented, record.runtimeWired, record.grantsApproval,
    record.grantsQualificationAuthority, record.grantsCandidateAuthority, record.grantsActivationAuthority,
    record.grantsNetworkAuthority, record.grantsCommandAuthority, record.grantsLeaseAuthority,
    record.grantsExecutionAuthority];
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1
    || record.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_CONTRACT_V1
    || record.acceptedOwnerAuthorizationContract !==
      connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1
    || record.acceptedTrustManifestAnchorContract !== connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1
    || record.live480ProductCommit !== "6d510d6f1b80a98c00c16fcf2b55837afc1cea87"
    || record.live490ProductCommit !== "dc313b1f2ff5982fe0ffa3b505db36025036601f"
    || record.requestSchema !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_SCHEMA_V1
    || record.issuerDependencyBindingSchema !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ISSUER_DEPENDENCY_BINDING_SCHEMA_V1
    || record.minimumChallengeEntropyBits !== 256 || record.minimumAuthorizationNonceEntropyBits !== 256
    || record.maximumTrustedTimeReadsPerCeremony !== 5 || record.maximumClockSkewSeconds !== 5
    || record.maximumChallengeLifetimeSeconds !== 120
    || record.maximumStrongFactorEvidenceLifetimeSeconds !== 120
    || record.maximumCeremonyLifetimeSeconds !== 300 || record.maximumAuthorizationLifetimeSeconds !== 300
    || record.maximumCurrentAttemptMarkers !== 0 || record.maximumCurrentChallengeReservations !== 0
    || record.maximumCurrentCeremonies !== 0 || record.maximumCurrentStrongFactorVerifications !== 0
    || record.maximumCurrentAuthorizationsIssued !== 0
    || requiredTrue.length !== 10 || reflectApplyV1(arraySomeV1, requiredTrue, [(entry: boolean) => entry !== true])
    || requiredFalse.length !== 22 || reflectApplyV1(arraySomeV1, requiredFalse, [(entry: boolean) => entry !== false])) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1;
  const captured = exactHostDataSnapshotV1(record, statusKeysV1);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const actuals = [record.actualAttemptMarkerWrites, record.actualRequestsAccepted, record.actualTrustPreflights,
    record.actualChallengesGenerated, record.actualChallengeReservations, record.actualOwnerPrompts,
    record.actualOwnerPresenceConfirmations, record.actualStrongFactorCalls, record.actualStrongFactorEvidenceRecords,
    record.actualCredentialsOrOwnerIdentitiesRead, record.actualBiometricOrAuthenticatorReads,
    record.actualKeychainOrCredentialStoreReads, record.actualTrustedTimeReads, record.actualClockReads,
    record.actualNoncesGenerated, record.actualReplayGuardsGenerated, record.actualTrustRechecks,
    record.actualOwnerAuthorizationBodiesConstructed, record.actualCanonicalEncodings, record.actualSealOperations,
    record.actualSignatureOrMacOperations, record.actualVerificationOperations, record.actualAuthorizationsIssued,
    record.actualAuthorizationsRegistered, record.actualNonceReservations, record.actualAuthorizationConsumptions,
    record.actualDatabaseReads, record.actualDatabaseWrites, record.actualMigrations,
    record.actualRegistryManifestOrAnchorReads, record.actualFilesystemReads, record.actualEnvironmentReads,
    record.actualHostReads, record.actualProcessesCreated, record.actualTimersCreated,
    record.actualSourceOrProviderCalls, record.actualNetworkIoEvents, record.actualNativeAttempts,
    record.actualCapsuleConstructions, record.actualCandidateAssemblies, record.actualDeployments,
    record.actualDnsOrHostingChanges];
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1
    || record.statusVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STATUS_V1
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1.contractDigest
    || actuals.length !== 42 || reflectApplyV1(arraySomeV1, actuals, [(entry: number) => entry !== 0])
    || grants.length !== 8 || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])
    || record.externalEffectOccurred !== false || record.targetRuntimeBlockerCleared !== false
    || record.physicalQualificationAccepted !== false || record.candidateEligible !== false
    || record.activationEligible !== false || record.runtimeWired !== false) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1);
