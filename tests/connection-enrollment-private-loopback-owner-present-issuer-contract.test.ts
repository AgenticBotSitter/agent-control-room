import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_CEREMONY_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_CHANNELS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_RESULTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUED_OUTPUT_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_DECISIONS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_PROHIBITED_EFFECTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REFUSALS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_SCHEMA_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STAGES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STATES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_REFUSAL_OUTPUT_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_CLASSES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_EVIDENCE_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_RESULTS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUSTED_TIME_AUTHORITIES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUSTED_TIME_NONCE_INTENT_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_PREFLIGHT_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_PREFLIGHT_RESULTS_V1,
  ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1,
  connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1,
  connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1,
  parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1,
  parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1,
} from "../src/connection-registry/v1/private-loopback-owner-present-issuer-contract";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1,
  connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1,
} from "../src/connection-registry/v1/private-loopback-owner-native-authorization-contract";
import {
  connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1,
} from "../src/connection-registry/v1/private-loopback-trust-manifest-anchor-contract";
import * as connectionRegistryBarrel from "../src/connection-registry/v1";

const root = resolve(import.meta.dirname, "..");
const moduleName = "private-loopback-owner-present-issuer-contract";
const modulePath = resolve(root, "src/connection-registry/v1", `${moduleName}.ts`);
type SafeCode = ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1
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

test("CR13A-LIVE-500 binds exact accepted LIVE-480 and LIVE-490 products and evidence", async () => {
  const contract = connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1;
  assert.equal(contract.live480ProductCommit, "6d510d6f1b80a98c00c16fcf2b55837afc1cea87");
  assert.equal(contract.live480ProductTree, "ac8655e1240d25bea9150ae9678f6ad5df56593c");
  assert.equal(contract.live490ProductCommit, "dc313b1f2ff5982fe0ffa3b505db36025036601f");
  assert.equal(contract.live490ProductTree, "de7b73195fdbc4eb08097e2da7eb7cd97e4f48a3");
  const live480Review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_480_INDEPENDENT_REVIEW.md"));
  const live480Acceptance = await readFile(resolve(root, "docs/CR13A_LIVE_480_ACCEPTANCE.md"));
  const live490Review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_490_INDEPENDENT_REVIEW.md"));
  const live490Acceptance = await readFile(resolve(root, "docs/CR13A_LIVE_490_ACCEPTANCE.md"));
  assert.equal(createHash("sha256").update(live480Review).digest("hex"), contract.acceptedLive480ReviewSha256);
  assert.equal(createHash("sha256").update(live480Acceptance).digest("hex"),
    contract.acceptedLive480AcceptanceSha256);
  assert.equal(createHash("sha256").update(live490Review).digest("hex"), contract.acceptedLive490ReviewSha256);
  assert.equal(createHash("sha256").update(live490Acceptance).digest("hex"),
    contract.acceptedLive490AcceptanceSha256);
  assert.equal(contract.acceptedOwnerAuthorizationContract,
    connectionEnrollmentPrivateLoopbackOwnerNativeAuthorizationContractV1);
  assert.equal(contract.acceptedTrustManifestAnchorContract,
    connectionEnrollmentPrivateLoopbackTrustManifestAnchorContractV1);
  assert.equal(contract.acceptedOwnerAuthorizationBodyFields,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_BODY_FIELDS_V1);
  assert.equal(contract.acceptedOwnerAuthorizationEnvelopeFields,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_NATIVE_AUTHORIZATION_ENVELOPE_FIELDS_V1);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1(contract), contract);
});

test("CR13A-LIVE-500 freezes every exact ordered issuer vocabulary", () => {
  const fixtures: Array<[readonly string[], string[]]> = [
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_FIELDS_V1, [
      "request_schema_version", "request_id_digest", "accepted_owner_authorization_contract_digest",
      "accepted_trust_manifest_anchor_contract_digest", "tenant_id_digest", "project_id_digest",
      "connection_id_digest", "node_id_digest", "target_platform_family", "target_runtime_family",
      "deployment_id_digest", "policy_id_digest", "operation_id", "candidate_proposal_id_digest",
      "attempt_id_digest", "deployment_manifest_id_digest", "deployment_manifest_digest",
      "deployment_manifest_sequence", "trust_registry_id_digest", "trust_registry_digest",
      "trust_registry_sequence", "manifest_anchor_revision", "manifest_anchor_head_digest",
      "trust_registry_anchor_revision", "trust_registry_anchor_head_digest", "owner_policy_revision",
      "strong_factor_policy_revision", "required_strong_factor_evidence_class",
      "requested_authorization_lifetime_seconds", "owner_facing_scope_summary_digest",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_CEREMONY_FIELDS_V1, [
      "ceremony_schema_version", "ceremony_id_digest", "request_id_digest", "issuer_product_commit",
      "issuer_product_tree", "issuer_independent_review_sha256", "owner_presence_channel",
      "owner_facing_scope_summary_digest", "challenge_digest", "challenge_issued_at", "challenge_expires_at",
      "owner_presence_confirmation_digest", "owner_presence_confirmed_at", "owner_policy_revision",
      "strong_factor_policy_revision", "required_strong_factor_evidence_class", "ceremony_result",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_CHANNELS_V1,
      ["target_host_owner_attended_native_confirmation"]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_RESULTS_V1,
      ["confirmed_for_exact_request", "declined", "cancelled", "expired", "terminal_ambiguous"]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_EVIDENCE_FIELDS_V1, [
      "evidence_schema_version", "evidence_id_digest", "ceremony_id_digest", "request_id_digest",
      "verifier_product_commit", "verifier_product_tree", "verifier_independent_review_sha256",
      "strong_factor_policy_revision", "evidence_class", "challenge_digest",
      "owner_presence_confirmation_digest", "credential_reference_digest", "verification_assertion_digest",
      "verification_issued_at", "verification_expires_at", "replay_guard_digest",
      "user_verification_performed", "owner_presence_performed", "phishing_resistant", "hardware_protected",
      "verification_result",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_RESULTS_V1,
      ["verified_for_exact_challenge", "rejected", "cancelled", "expired", "revoked", "terminal_ambiguous"]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_PREFLIGHT_FIELDS_V1, [
      "preflight_schema_version", "request_id_digest", "owner_root_pin_product_digest",
      "trust_registry_id_digest", "trust_registry_sequence", "trust_registry_digest",
      "trust_registry_anchor_revision", "trust_registry_anchor_head_digest", "deployment_manifest_id_digest",
      "deployment_manifest_sequence", "deployment_manifest_digest", "manifest_anchor_revision",
      "manifest_anchor_head_digest", "owner_present_issuer_product_binding_digest",
      "owner_authorization_sealing_key_binding_digest", "owner_policy_revision",
      "strong_factor_policy_revision", "required_strong_factor_evidence_class", "preflight_result",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_PREFLIGHT_RESULTS_V1, [
      "current_exact_scope_accepted", "missing_or_unreadable", "signature_chain_invalid",
      "anchor_mismatch_or_rollback", "product_or_key_binding_invalid", "scope_or_policy_mismatch",
      "expired_revoked_or_not_yet_valid", "terminal_ambiguous",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUSTED_TIME_NONCE_INTENT_FIELDS_V1, [
      "intent_schema_version", "ceremony_id_digest", "request_id_digest", "trusted_time_authority_class",
      "authorization_nonce_domain", "minimum_nonce_entropy_bits", "nonce_uniqueness_scope",
      "maximum_clock_skew_seconds", "maximum_authorization_lifetime_seconds",
      "manifest_and_trust_recheck_required_before_body_construction",
      "fresh_nonce_required_after_strong_factor_verification", "nonce_reservation_required_during_registration",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUSTED_TIME_AUTHORITIES_V1,
      ["private_postgresql_transaction_time"]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STAGES_V1, [
      "accepted_product_and_policy_preflight", "owner_presence_challenge_prepared",
      "owner_presence_confirmation_observed", "strong_factor_verification_observed", "current_trust_rechecked",
      "fresh_authorization_nonce_and_trusted_time_observed", "canonical_owner_body_constructed",
      "owner_authorization_sealed", "private_unregistered_output_delivered",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STATES_V1, [
      "inert_contract_only", "preflight_pending", "owner_presence_pending", "strong_factor_pending",
      "trust_recheck_pending", "time_nonce_pending", "body_construction_pending", "sealing_pending",
      "issued_unregistered", "terminal_refused", "terminal_ambiguous",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_DECISIONS_V1, [
      "sealed_authorization_issued_unregistered", "known_refusal_before_authorization_construction",
      "terminal_issuer_outcome_ambiguous",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REFUSALS_V1, [
      "accepted_predecessor_evidence_mismatch", "request_not_module_minted",
      "request_scope_or_policy_mismatch", "trust_manifest_or_anchor_not_current",
      "issuer_product_or_sealing_key_not_current", "unsupported_or_downgraded_strong_factor_class",
      "owner_presence_not_confirmed_for_exact_request", "owner_declined_cancelled_or_timed_out",
      "strong_factor_not_verified_for_exact_challenge",
      "strong_factor_evidence_stale_revoked_replayed_or_mismatched",
      "trusted_time_unavailable_or_rollback_suspected", "fresh_nonce_unavailable_or_duplicate_suspected",
      "requested_lifetime_invalid_or_exceeds_ceiling", "body_or_envelope_canonicalization_failed",
      "trust_changed_before_body_construction", "every_unknown_or_undeclared_condition",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUED_OUTPUT_FIELDS_V1, [
      "output_schema_version", "decision", "request_id_digest", "ceremony_id_digest",
      "sealed_owner_native_authorization_envelope", "sealed_envelope_digest", "issuer_product_commit",
      "issuer_product_tree", "issuer_independent_review_sha256", "issued_at", "not_before", "expires_at",
      "registration_required", "output_digest",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_REFUSAL_OUTPUT_FIELDS_V1, [
      "output_schema_version", "decision", "safe_refusal_code", "owner_action_may_start_new_ceremony",
      "authorization_created", "authorization_registered", "output_digest",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_PROHIBITED_EFFECTS_V1, [
      "owner_prompt_or_user_interface", "keychain_secret_store_or_credential_access",
      "biometric_or_authenticator_access", "raw_totp_password_pin_credential_or_owner_identity_read",
      "strong_factor_verification_call", "clock_read_or_trusted_time_query",
      "nonce_randomness_or_replay_guard_generation", "owner_authorization_body_construction",
      "canonical_authorization_encoding_or_sealing", "signature_mac_or_verification_operation",
      "root_registry_manifest_or_anchor_resolution",
      "authorization_registration_reservation_consumption_or_revocation",
      "database_read_write_migration_or_transaction", "filesystem_environment_host_or_process_read",
      "source_or_provider_lookup_or_invocation", "listener_socket_or_network_access",
      "timer_handler_or_process_creation", "arbitrary_command_or_shell", "ssh_mcp_or_plugin",
      "application_or_runtime_activation", "candidate_assembly_or_physical_qualification",
      "deployment_dns_or_hosting_change", "caller_dependency_injection_or_generic_locator",
      "every_undeclared_effect",
    ]],
    [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_RULES_V1, [
      "bind_exact_accepted_live_480_product_tree_review_and_acceptance",
      "bind_exact_accepted_live_490_product_tree_review_and_acceptance",
      "accept_only_module_minted_request_identity_after_current_manifest_and_trust_preflight",
      "bind_request_to_exact_tenant_project_connection_node_deployment_policy_operation_candidate_and_attempt_scope",
      "bind_request_to_current_manifest_registry_and_both_current_anchor_heads",
      "bind_owner_present_issuer_and_owner_authorization_sealing_key_to_current_manifest_and_registry",
      "present_one_exact_owner_facing_scope_summary_on_the_target_host",
      "require_separate_owner_presence_and_strong_factor_evidence_for_the_same_exact_challenge",
      "permit_only_one_policy_selected_strong_factor_class_without_fallback_or_downgrade",
      "mark_totp_class_non_phishing_resistant_and_require_separate_owner_presence",
      "never_treat_login_session_ui_click_or_conversational_approval_as_strong_factor_evidence",
      "never_retain_log_return_or_publicly_project_raw_credential_biometric_code_owner_identity_or_assertion",
      "bind_factor_evidence_to_exact_verifier_product_policy_class_ceremony_request_challenge_and_replay_guard",
      "perform_at_most_one_strong_factor_verification_for_one_ceremony",
      "reject_stale_revoked_replayed_mismatched_or_ambiguous_factor_evidence",
      "recheck_current_root_registry_manifest_anchors_products_keys_scope_and_policy_after_factor_verification",
      "obtain_fresh_256_bit_minimum_authorization_nonce_only_after_factor_verification",
      "use_only_private_postgresql_transaction_time_for_issuer_security_decisions",
      "bind_inclusive_not_before_exclusive_expiry_and_maximum_300_second_authorization_lifetime",
      "construct_the_exact_live_480_body_internally_after_final_trust_recheck",
      "seal_once_with_exact_current_owner_authorization_key_and_live_480_envelope_schema",
      "return_only_one_private_sealed_unregistered_envelope_and_never_body_key_nonce_or_evidence",
      "require_separate_authenticated_registration_and_nonce_reservation_before_capsule_use",
      "never_treat_issuance_as_registration_consumption_qualification_candidate_activation_or_execution",
      "make_every_post_verifier_or_post_sealing_uncertainty_terminal_without_retry_or_resume",
      "allow_a_new_ceremony_only_after_proven_pre_effect_refusal_with_new_request_challenge_and_nonce",
      "perform_no_import_time_or_contract_construction_host_or_protected_read",
      "keep_complete_transitive_production_import_graph_inert",
      "export_no_issuer_verifier_prompt_clock_nonce_sealer_resolver_store_or_dependency_factory",
      "grant_no_approval_qualification_candidate_activation_network_command_lease_or_execution_authority",
    ]],
  ];
  for (const [actual, expected] of fixtures) {
    assert.deepEqual(actual, expected);
    assert.equal(Object.isFrozen(actual), true);
    assert.equal(new Set(actual).size, actual.length);
  }
});

test("CR13A-LIVE-500 makes strong-factor assurance explicit without hiding TOTP limitations", () => {
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_CLASSES_V1, [
    { evidenceClass: "platform_phishing_resistant_user_verification", phishingResistant: true,
      hardwareProtectedRequired: true, separateOwnerPresenceRequired: true },
    { evidenceClass: "roaming_hardware_phishing_resistant_user_verification", phishingResistant: true,
      hardwareProtectedRequired: true, separateOwnerPresenceRequired: true },
    { evidenceClass: "password_manager_totp_with_separate_owner_presence", phishingResistant: false,
      hardwareProtectedRequired: false, separateOwnerPresenceRequired: true },
  ]);
  for (const factor of CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_CLASSES_V1) {
    assert.equal(Object.isFrozen(factor), true);
    assert.equal(factor.separateOwnerPresenceRequired, true);
  }
  assert.equal(connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1.loginSessionAsStrongFactorAllowed,
    false);
  assert.equal(connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1.conversationalApprovalAsStrongFactorAllowed,
    false);
  assert.equal(connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1.factorFallbackOrDowngradeAllowed,
    false);
});

test("CR13A-LIVE-500 fixes nonce, trusted-time, lifetime, and registration boundaries", () => {
  const contract = connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1;
  assert.equal(contract.minimumAuthorizationNonceEntropyBits, 256);
  assert.equal(contract.maximumClockSkewSeconds, 5);
  assert.equal(contract.maximumChallengeLifetimeSeconds, 120);
  assert.equal(contract.maximumStrongFactorEvidenceLifetimeSeconds, 120);
  assert.equal(contract.maximumCeremonyLifetimeSeconds, 300);
  assert.equal(contract.maximumAuthorizationLifetimeSeconds, 300);
  assert.equal(contract.trustedTimeAuthorities.length, 1);
  assert.equal(contract.trustedTimeAuthorities[0], "private_postgresql_transaction_time");
  assert.equal(contract.separateRegistrationRequired, true);
  assert.equal(contract.issuanceGrantsNativeAuthority, false);
  assert.equal(contract.retryAfterUncertaintyAllowed, false);
});

test("CR13A-LIVE-500 closes caller input, outputs, refusals, and uncertainty", () => {
  const contract = connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1;
  assert.equal(contract.requestSchema.source, "module_minted_after_current_manifest_and_trust_preflight");
  assert.equal(contract.requestSchema.callerConstructible, false);
  assert.equal(contract.requestSchema.rawAuthorizationBodyAllowed, false);
  assert.equal(contract.requestSchema.rawCredentialOrOwnerIdentityAllowed, false);
  assert.equal(contract.issuedOutputFields.includes("sealed_owner_native_authorization_envelope"), true);
  assert.equal(contract.issuedOutputFields.includes("authorization_body" as never), false);
  assert.equal(contract.refusalOutputFields.includes("authorization_created"), true);
  assert.ok(contract.refusals.includes("every_unknown_or_undeclared_condition"));
  assert.ok(contract.rules.includes("make_every_post_verifier_or_post_sealing_uncertainty_terminal_without_retry_or_resume"));
});

test("CR13A-LIVE-500 requires protection while implementing and granting nothing", () => {
  const contract = connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1;
  const requiredTrue = [contract.ownerPresenceRequired, contract.strongFactorRequired,
    contract.finalTrustRecheckRequired, contract.freshNonceRequired, contract.trustedTimeRequired,
    contract.separateRegistrationRequired, contract.transitiveImportInertiaRequired, contract.repositoryContractOnly];
  const requiredFalse = [contract.callerConstructibleRequestAllowed, contract.loginSessionAsStrongFactorAllowed,
    contract.conversationalApprovalAsStrongFactorAllowed, contract.factorFallbackOrDowngradeAllowed,
    contract.rawCredentialOrOwnerIdentityRetentionAllowed, contract.retryAfterUncertaintyAllowed,
    contract.issuanceGrantsNativeAuthority, contract.issuerImplemented, contract.promptOrVerifierImplemented,
    contract.clockOrNonceImplemented, contract.bodyConstructionOrSealingImplemented,
    contract.trustResolutionImplemented, contract.storeOrRegistrationImplemented, contract.runtimeWired,
    contract.grantsApproval, contract.grantsQualificationAuthority, contract.grantsCandidateAuthority,
    contract.grantsActivationAuthority, contract.grantsNetworkAuthority, contract.grantsCommandAuthority,
    contract.grantsLeaseAuthority, contract.grantsExecutionAuthority];
  assert.deepEqual(requiredTrue, new Array(8).fill(true));
  assert.deepEqual(requiredFalse, new Array(22).fill(false));
  assert.equal(contract.prohibitedEffects.length, 24);
  assert.equal(contract.rules.length, 30);
});

test("CR13A-LIVE-500 publishes 39 zero actuals and eight false authority grants", () => {
  const status = connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1(status), status);
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual"));
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants"));
  assert.equal(actuals.length, 39);
  assert.equal(actuals.every(([, value]) => value === 0), true);
  assert.equal(grants.length, 8);
  assert.equal(grants.every(([, value]) => value === false), true);
  assert.equal(status.externalEffectOccurred, false);
  assert.equal(status.targetRuntimeBlockerCleared, false);
  assert.equal(status.physicalQualificationAccepted, false);
  assert.equal(status.candidateEligible, false);
  assert.equal(status.activationEligible, false);
  assert.equal(status.runtimeWired, false);
});

test("CR13A-LIVE-500 rejects copies, accessors, symbols, and proxies without behavior", () => {
  const contract = connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1;
  const status = connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1;
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1(Object.freeze({ ...contract })),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1(Object.freeze({ ...status })),
    "invalid_status");
  for (const value of [null, undefined, "contract", 1, Symbol("contract")]) {
    expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1(value),
      "invalid_contract");
  }
  let accessorExecutions = 0;
  const accessor = Object.freeze(Object.defineProperty({}, "contractVersion", {
    enumerable: true,
    get: () => { accessorExecutions += 1; throw new Error("must not execute"); },
  }));
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1(accessor),
    "invalid_contract");
  assert.equal(accessorExecutions, 0);
  let proxyExecutions = 0;
  const proxy = new Proxy({}, {
    get: () => { proxyExecutions += 1; throw new Error("must not execute"); },
    ownKeys: () => { proxyExecutions += 1; throw new Error("must not execute"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1(proxy),
    "invalid_contract");
  assert.equal(proxyExecutions, 0);
});

test("CR13A-LIVE-500 rejects policy, assurance, lifetime, and predecessor substitution", () => {
  const contract = connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1;
  const substitutions: Record<string, unknown>[] = [
    { live490ProductCommit: "0".repeat(40) },
    { maximumAuthorizationLifetimeSeconds: 301 },
    { minimumAuthorizationNonceEntropyBits: 128 },
    { loginSessionAsStrongFactorAllowed: true },
    { factorFallbackOrDowngradeAllowed: true },
    { retryAfterUncertaintyAllowed: true },
    { issuerImplemented: true },
    { requestSchema: Object.freeze({ ...CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_SCHEMA_V1,
      callerConstructible: true }) },
    { strongFactorClasses: Object.freeze([...CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_CLASSES_V1,
      Object.freeze({ evidenceClass: "sms", phishingResistant: false, hardwareProtectedRequired: false,
        separateOwnerPresenceRequired: false })]) },
  ];
  for (const substitution of substitutions) {
    expectCode(() => parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1(Object.freeze({
      ...contract, ...substitution,
    })), "invalid_contract");
  }
});

test("CR13A-LIVE-500 freezes records, nested policy, parsers, and safe errors", () => {
  for (const value of [connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1,
    connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_SCHEMA_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_SCHEMA_V1.fields,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_CLASSES_V1,
    ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1,
    ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1.prototype,
    parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1,
    parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const error = new ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1("raw factor evidence");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-500 parsers retain captured intrinsics after ambient replacement", () => {
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
    Array.prototype.some = function () { executions[3] += 1; throw new Error("issuer ambient"); };
    Reflect.apply = () => { executions[4] += 1; throw new Error("issuer ambient"); };
    parsedContract = parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1(
      connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1);
    parsedStatus = parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1(
      connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1);
  } finally {
    Object.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Array.prototype.some = originalArraySome;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(parsedContract, connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1);
  assert.equal(parsedStatus, connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1);
  assert.deepEqual(executions, new Array(5).fill(0));
});

test("CR13A-LIVE-500 transitive production import graph is exact and effect-inert", async () => {
  const graph = new Map<string, readonly string[]>([
    ["src/connection-registry/v1/private-loopback-owner-present-issuer-contract.ts", [
      "../../security/canonical-digest", "../../security/host-value", "../../security/redaction",
      "./private-loopback-owner-native-authorization-contract", "./private-loopback-trust-manifest-anchor-contract",
    ]],
    ["src/connection-registry/v1/private-loopback-owner-native-authorization-contract.ts", [
      "../../security/canonical-digest", "../../security/host-value", "../../security/redaction",
    ]],
    ["src/connection-registry/v1/private-loopback-trust-manifest-anchor-contract.ts", [
      "../../security/canonical-digest", "../../security/host-value", "../../security/redaction",
      "./private-loopback-owner-native-authorization-contract",
    ]],
    ["src/security/canonical-digest.ts", ["node:crypto"]],
    ["src/security/host-value.ts", ["node:util"]],
    ["src/security/redaction.ts", []],
  ]);
  const prohibitedModules = /^(?:node:)?(?:fs|fs\/promises|net|http|https|http2|tls|dgram|dns|dns\/promises|child_process|cluster|worker_threads|os|process)$|^(?:postgres|@electric-sql\/pglite)$/;
  const effectNames = new Set(["fetch", "setTimeout", "setInterval", "createServer", "listen", "connect",
    "createConnection", "request", "spawn", "spawnSync", "fork", "readFile", "readFileSync", "writeFile",
    "writeFileSync", "appendFile", "appendFileSync", "open", "openSync", "rm", "rmSync", "unlink",
    "unlinkSync", "query", "transaction", "getaddrinfo", "lookup", "chdir", "cwd", "exit", "kill"]);
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
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    assert.deepEqual(violations, [], `${relativeFile}: transitive effect path`);
  }
  assert.deepEqual([...discovered].sort(), [...graph.keys()].sort());

  const rootSource = ts.createSourceFile(modulePath, await readFile(modulePath, "utf8"), ts.ScriptTarget.Latest,
    true, ts.ScriptKind.TS);
  const exportedNames: string[] = [];
  for (const statement of rootSource.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const hasExport = modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true;
    if (hasExport && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exportedNames.push(declaration.name.text);
      }
    } else if (hasExport && (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)) && statement.name && ts.isIdentifier(statement.name)) {
      exportedNames.push(statement.name.text);
    }
  }
  assert.deepEqual(exportedNames, [
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_CONTRACT_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STATUS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_FIELDS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REQUEST_SCHEMA_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_CEREMONY_FIELDS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_CHANNELS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENCE_RESULTS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_CLASSES_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_EVIDENCE_FIELDS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_STRONG_FACTOR_RESULTS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_PREFLIGHT_FIELDS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUST_PREFLIGHT_RESULTS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUSTED_TIME_NONCE_INTENT_FIELDS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TRUSTED_TIME_AUTHORITIES_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STAGES_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_STATES_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_DECISIONS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_REFUSALS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUED_OUTPUT_FIELDS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_REFUSAL_OUTPUT_FIELDS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_PROHIBITED_EFFECTS_V1",
    "CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_OWNER_PRESENT_ISSUER_RULES_V1",
    "ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerErrorV1",
    "connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1",
    "ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1",
    "connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1",
    "ConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1",
    "parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1",
    "parseConnectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1",
  ]);
});

test("CR13A-LIVE-500 has only the safe connection-registry barrel as a production consumer", async () => {
  assert.equal(connectionRegistryBarrel.connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1,
    connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1);
  const consumers: string[] = [];
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    const text = await readFile(file, "utf8");
    if (text.includes(moduleName)) consumers.push(relative(root, file));
  }
  assert.deepEqual(consumers, ["src/connection-registry/v1/index.ts"]);
});

test("CR13A-LIVE-500 public evidence is sanitized and honestly reports zero effects", async () => {
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackOwnerPresentIssuerContractV1,
    status: connectionEnrollmentPrivateLoopbackOwnerPresentIssuerStatusV1,
  });
  assert.doesNotMatch(serialized, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|gh[pousr]_|sk-|AKIA/i);
  assert.doesNotMatch(serialized, /\/Users\/|\\Users\\|hostname|127\.0\.0\.1|localhost/i);
  const status = await readFile(resolve(root, "docs/BUILD_STATUS.md"), "utf8");
  assert.match(status, /CR13A-LIVE-500/);
  assert.doesNotMatch(status, /CR13A-LIVE-500[^\n]*(?:physically qualified|runtime wired|deployed)/i);
});
