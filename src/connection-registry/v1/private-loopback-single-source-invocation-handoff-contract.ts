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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-single-source-invocation-handoff-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-single-source-invocation-handoff-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_PROPERTIES_V1 = objectFreezeV1([
  "platform",
  "architecture",
  "release",
  "uptimeSeconds",
  "runtimeVersion",
  "executablePath",
  "processIdentifier",
  "parentProcessIdentifier",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_RULES_V1 = objectFreezeV1([
  "bind_exact_accepted_one_use_invocation_contract",
  "bind_exact_accepted_private_lookup_composition",
  "use_unbroken_private_control_flow_as_invocation_authority",
  "reject_public_lookup_result_receipt_identity_digest_boolean_or_assertion_as_authority",
  "require_exact_frozen_module_minted_source",
  "invoke_source_synchronously_directly_and_at_most_once",
  "invoke_source_without_receiver_or_arguments",
  "prohibit_promise_timer_event_queue_worker_or_callback_boundary",
  "accept_only_exact_frozen_own_data_raw_observation",
  "reject_partial_extra_inherited_accessor_proxy_or_substituted_raw_state",
  "keep_raw_observation_lexical_private_and_unexported",
  "prohibit_raw_return_serialization_logging_hashing_persistence_cache_or_diagnostics",
  "handoff_raw_observation_directly_to_separately_gated_same_module_attestation",
  "create_no_public_result_before_private_handoff_settles",
  "erase_lexical_source_and_raw_references_on_settlement",
  "treat_invocation_validation_handoff_or_uncertainty_failure_as_terminal_spent",
  "prohibit_retry_replacement_refund_unconsume_fallback_second_lookup_or_second_invocation",
  "keep_raw_observation_separate_from_attestation_candidate_approval_and_activation",
  "publish_only_sanitized_non_authorizing_terminal_status",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_STAGES_V1 = objectFreezeV1([
  "accepted_private_spend_recheck_lookup_composition",
  "single_source_invocation_handoff_contract",
  "future_same_module_single_source_invocation",
  "private_exact_raw_observation_validation",
  "direct_same_module_attestation_handoff",
  "trusted_time_nonce_lineage_and_signer_binding",
  "platform_signature",
  "durable_attestation_replay_checkpoint",
  "private_physical_candidate_assembly",
  "fresh_one_use_owner_authorization",
  "single_owner_attended_physical_qualification",
  "different_independent_qualification_review",
  "separate_runtime_activation_decision",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_BLOCKERS_V1 = objectFreezeV1([
  "single_source_invocation_not_implemented",
  "private_raw_observation_validation_not_implemented",
  "private_raw_observation_handoff_missing",
  "observation_attestation_binding_missing",
  "trusted_attestation_clock_missing",
  "fresh_attestation_nonce_missing",
  "platform_evidence_signer_missing",
  "durable_attestation_replay_checkpoint_missing",
  "private_candidate_assembler_missing",
  "fresh_owner_authorization_missing",
  "physical_qualification_missing",
  "runtime_activation_approval_missing",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_OUTCOMES_V1 = objectFreezeV1([
  "not_attempted",
  "rejected_before_invocation",
  "terminal_source_invocation_failed",
  "terminal_raw_observation_invalid",
  "terminal_private_handoff_unavailable",
  "completed_private_handoff_and_stopped_before_attestation",
] as const);

export type ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_CONTRACT_V1;
  contractReference: string;
  live340ProductCommit: "3108a8759863c4692ade2d5532e88cd28f259779";
  acceptedLive340ReviewSha256: "bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af";
  live420ProductCommit: "c1287817079e6951ab5d1fbe24829cccc517687d";
  acceptedLive420ReviewSha256: "6b472475d1e8d8bb9193b1b1df133316b8a939fbdec8c52e1e5b63bfd2308119";
  rawObservationProperties:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_PROPERTIES_V1;
  rules: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_RULES_V1;
  stages: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_STAGES_V1;
  blockers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_BLOCKERS_V1;
  outcomes: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_OUTCOMES_V1;
  maximumFutureSourceInvocations: 1;
  maximumCurrentSourceInvocations: 0;
  maximumFutureNativeOperations: 8;
  maximumCurrentNativeOperations: 0;
  sameSourceOwningModuleRequired: true;
  unbrokenPrivateControlFlowRequired: true;
  exactModuleMintedSourceRequired: true;
  synchronousInvocationRequired: true;
  noReceiverRequired: true;
  noArgumentsRequired: true;
  exactFrozenOwnDataObservationRequired: true;
  directPrivateAttestationHandoffRequired: true;
  sourceAndRawReferenceErasureRequired: true;
  publicLookupResultAuthorizesInvocation: false;
  callerSourceAllowed: false;
  callerRawObservationAllowed: false;
  callerNativeBindingAllowed: false;
  callbackOrContinuationAllowed: false;
  asynchronousBoundaryAllowed: false;
  rawObservationExportAllowed: false;
  rawObservationDigestAllowed: false;
  rawObservationPersistenceAllowed: false;
  retryAllowed: false;
  replacementAuthorizationAllowed: false;
  refundOrUnconsumeAllowed: false;
  fallbackAllowed: false;
  secondLookupAllowed: false;
  secondInvocationAllowed: false;
  contractImplemented: true;
  live340DependencyAccepted: true;
  live420DependencyAccepted: true;
  sourceInvocationImplemented: false;
  rawObservationValidationImplemented: false;
  rawObservationHandoffImplemented: false;
  attestationImplemented: false;
  signerImplemented: false;
  replayCheckpointImplemented: false;
  candidateAssemblerImplemented: false;
  ownerAuthorizationPresent: false;
  physicalAttemptPerformed: false;
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

export type ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_STATUS_V1;
  contractReference: string;
  contractDigest: string;
  evidenceClass: "repository_contract_non_execution";
  lookupState: "accepted_guarded_private_uninvoked";
  invocationState: "contract_only_not_attempted";
  rawObservationState: "not_created";
  attestationState: "not_implemented";
  runtimeState: "not_wired";
  actualSourceModuleImports: 0;
  actualSourceModifications: 0;
  actualCompositionCalls: 0;
  actualAuthorizationSpends: 0;
  actualPostTransactionRechecks: 0;
  actualSourceLookups: 0;
  actualSourceInvocations: 0;
  actualInvocationArguments: 0;
  actualDescriptorInspections: 0;
  actualProcessVersionReads: 0;
  actualProcessExecPathReads: 0;
  actualProcessIdReads: 0;
  actualParentProcessIdReads: 0;
  actualOsPlatformCalls: 0;
  actualOsArchitectureCalls: 0;
  actualOsReleaseCalls: 0;
  actualOsUptimeCalls: 0;
  actualHostObservations: 0;
  actualEnvironmentReads: 0;
  actualPathReads: 0;
  actualRawObservationsCreated: 0;
  actualRawObservationReturns: 0;
  actualRawObservationExports: 0;
  actualRawObservationSerializations: 0;
  actualRawObservationLogs: 0;
  actualRawObservationDigests: 0;
  actualRawObservationPersistenceWrites: 0;
  actualPrivateAttestationHandoffs: 0;
  actualAttestationsCreated: 0;
  actualSignerCalls: 0;
  actualClockReads: 0;
  actualNoncesIssued: 0;
  actualCheckpointWrites: 0;
  actualPersistenceWrites: 0;
  actualCandidateAssemblerEntries: 0;
  actualOwnerAuthorizationSpends: 0;
  actualPhysicalAttempts: 0;
  actualNativeListenerAttempts: 0;
  actualTimerCreations: 0;
  actualNetworkIoEvents: 0;
  actualProviderCalls: 0;
  actualProtectedValuesRead: 0;
  actualCommandsExecuted: 0;
  actualTerminalAmbiguities: 0;
  externalEffectOccurred: false;
  targetRuntimeBlockerCleared: false;
  physicalQualificationAccepted: false;
  runtimeWired: false;
  candidateEligible: false;
  activationEligible: false;
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

export class ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "invocation_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "invocation_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "single source invocation handoff contract record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live340ProductCommit: "3108a8759863c4692ade2d5532e88cd28f259779",
  acceptedLive340ReviewSha256: "bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af",
  live420ProductCommit: "c1287817079e6951ab5d1fbe24829cccc517687d",
  acceptedLive420ReviewSha256: "6b472475d1e8d8bb9193b1b1df133316b8a939fbdec8c52e1e5b63bfd2308119",
  rawObservationProperties: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_PROPERTIES_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_RULES_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_BLOCKERS_V1,
  outcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_OUTCOMES_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_CONTRACT_V1,
  contractReference: `single-source-invocation-handoff:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live340ProductCommit: "3108a8759863c4692ade2d5532e88cd28f259779" as const,
  acceptedLive340ReviewSha256: "bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af" as const,
  live420ProductCommit: "c1287817079e6951ab5d1fbe24829cccc517687d" as const,
  acceptedLive420ReviewSha256: "6b472475d1e8d8bb9193b1b1df133316b8a939fbdec8c52e1e5b63bfd2308119" as const,
  rawObservationProperties: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_PROPERTIES_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_RULES_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_BLOCKERS_V1,
  outcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_OUTCOMES_V1,
  maximumFutureSourceInvocations: 1 as const,
  maximumCurrentSourceInvocations: 0 as const,
  maximumFutureNativeOperations: 8 as const,
  maximumCurrentNativeOperations: 0 as const,
  sameSourceOwningModuleRequired: true as const,
  unbrokenPrivateControlFlowRequired: true as const,
  exactModuleMintedSourceRequired: true as const,
  synchronousInvocationRequired: true as const,
  noReceiverRequired: true as const,
  noArgumentsRequired: true as const,
  exactFrozenOwnDataObservationRequired: true as const,
  directPrivateAttestationHandoffRequired: true as const,
  sourceAndRawReferenceErasureRequired: true as const,
  publicLookupResultAuthorizesInvocation: false as const,
  callerSourceAllowed: false as const,
  callerRawObservationAllowed: false as const,
  callerNativeBindingAllowed: false as const,
  callbackOrContinuationAllowed: false as const,
  asynchronousBoundaryAllowed: false as const,
  rawObservationExportAllowed: false as const,
  rawObservationDigestAllowed: false as const,
  rawObservationPersistenceAllowed: false as const,
  retryAllowed: false as const,
  replacementAuthorizationAllowed: false as const,
  refundOrUnconsumeAllowed: false as const,
  fallbackAllowed: false as const,
  secondLookupAllowed: false as const,
  secondInvocationAllowed: false as const,
  contractImplemented: true as const,
  live340DependencyAccepted: true as const,
  live420DependencyAccepted: true as const,
  sourceInvocationImplemented: false as const,
  rawObservationValidationImplemented: false as const,
  rawObservationHandoffImplemented: false as const,
  attestationImplemented: false as const,
  signerImplemented: false as const,
  replayCheckpointImplemented: false as const,
  candidateAssemblerImplemented: false as const,
  ownerAuthorizationPresent: false as const,
  physicalAttemptPerformed: false as const,
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
export const connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
reflectApplyV1(weakSetAddV1, contractRecordsV1,
  [connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1,
  [connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1,
    connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1.contractDigest]);

const zeroActualsV1 = {
  actualSourceModuleImports: 0 as const,
  actualSourceModifications: 0 as const,
  actualCompositionCalls: 0 as const,
  actualAuthorizationSpends: 0 as const,
  actualPostTransactionRechecks: 0 as const,
  actualSourceLookups: 0 as const,
  actualSourceInvocations: 0 as const,
  actualInvocationArguments: 0 as const,
  actualDescriptorInspections: 0 as const,
  actualProcessVersionReads: 0 as const,
  actualProcessExecPathReads: 0 as const,
  actualProcessIdReads: 0 as const,
  actualParentProcessIdReads: 0 as const,
  actualOsPlatformCalls: 0 as const,
  actualOsArchitectureCalls: 0 as const,
  actualOsReleaseCalls: 0 as const,
  actualOsUptimeCalls: 0 as const,
  actualHostObservations: 0 as const,
  actualEnvironmentReads: 0 as const,
  actualPathReads: 0 as const,
  actualRawObservationsCreated: 0 as const,
  actualRawObservationReturns: 0 as const,
  actualRawObservationExports: 0 as const,
  actualRawObservationSerializations: 0 as const,
  actualRawObservationLogs: 0 as const,
  actualRawObservationDigests: 0 as const,
  actualRawObservationPersistenceWrites: 0 as const,
  actualPrivateAttestationHandoffs: 0 as const,
  actualAttestationsCreated: 0 as const,
  actualSignerCalls: 0 as const,
  actualClockReads: 0 as const,
  actualNoncesIssued: 0 as const,
  actualCheckpointWrites: 0 as const,
  actualPersistenceWrites: 0 as const,
  actualCandidateAssemblerEntries: 0 as const,
  actualOwnerAuthorizationSpends: 0 as const,
  actualPhysicalAttempts: 0 as const,
  actualNativeListenerAttempts: 0 as const,
  actualTimerCreations: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualProviderCalls: 0 as const,
  actualProtectedValuesRead: 0 as const,
  actualCommandsExecuted: 0 as const,
  actualTerminalAmbiguities: 0 as const,
};

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1.contractDigest,
  evidenceClass: "repository_contract_non_execution" as const,
  lookupState: "accepted_guarded_private_uninvoked" as const,
  invocationState: "contract_only_not_attempted" as const,
  rawObservationState: "not_created" as const,
  attestationState: "not_implemented" as const,
  runtimeState: "not_wired" as const,
  ...zeroActualsV1,
  externalEffectOccurred: false as const,
  targetRuntimeBlockerCleared: false as const,
  physicalQualificationAccepted: false as const,
  runtimeWired: false as const,
  candidateEligible: false as const,
  activationEligible: false as const,
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
export const connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1,
    connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "contractReference", "live340ProductCommit", "acceptedLive340ReviewSha256",
    "live420ProductCommit", "acceptedLive420ReviewSha256", "rawObservationProperties", "rules", "stages",
    "blockers", "outcomes", "maximumFutureSourceInvocations", "maximumCurrentSourceInvocations",
    "maximumFutureNativeOperations", "maximumCurrentNativeOperations", "sameSourceOwningModuleRequired",
    "unbrokenPrivateControlFlowRequired", "exactModuleMintedSourceRequired", "synchronousInvocationRequired",
    "noReceiverRequired", "noArgumentsRequired", "exactFrozenOwnDataObservationRequired",
    "directPrivateAttestationHandoffRequired", "sourceAndRawReferenceErasureRequired",
    "publicLookupResultAuthorizesInvocation", "callerSourceAllowed", "callerRawObservationAllowed",
    "callerNativeBindingAllowed", "callbackOrContinuationAllowed", "asynchronousBoundaryAllowed",
    "rawObservationExportAllowed", "rawObservationDigestAllowed", "rawObservationPersistenceAllowed", "retryAllowed",
    "replacementAuthorizationAllowed", "refundOrUnconsumeAllowed", "fallbackAllowed", "secondLookupAllowed",
    "secondInvocationAllowed", "contractImplemented", "live340DependencyAccepted", "live420DependencyAccepted",
    "sourceInvocationImplemented", "rawObservationValidationImplemented", "rawObservationHandoffImplemented",
    "attestationImplemented", "signerImplemented", "replayCheckpointImplemented", "candidateAssemblerImplemented",
    "ownerAuthorizationPresent", "physicalAttemptPerformed", "runtimeWired", "repositoryContractOnly",
    "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "contractDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  const requiredTrue = [record.sameSourceOwningModuleRequired, record.unbrokenPrivateControlFlowRequired,
    record.exactModuleMintedSourceRequired, record.synchronousInvocationRequired, record.noReceiverRequired,
    record.noArgumentsRequired, record.exactFrozenOwnDataObservationRequired,
    record.directPrivateAttestationHandoffRequired, record.sourceAndRawReferenceErasureRequired,
    record.contractImplemented, record.live340DependencyAccepted, record.live420DependencyAccepted,
    record.repositoryContractOnly];
  const requiredFalse = [record.publicLookupResultAuthorizesInvocation, record.callerSourceAllowed,
    record.callerRawObservationAllowed, record.callerNativeBindingAllowed, record.callbackOrContinuationAllowed,
    record.asynchronousBoundaryAllowed, record.rawObservationExportAllowed, record.rawObservationDigestAllowed,
    record.rawObservationPersistenceAllowed, record.retryAllowed, record.replacementAuthorizationAllowed,
    record.refundOrUnconsumeAllowed, record.fallbackAllowed, record.secondLookupAllowed, record.secondInvocationAllowed,
    record.sourceInvocationImplemented, record.rawObservationValidationImplemented,
    record.rawObservationHandoffImplemented, record.attestationImplemented, record.signerImplemented,
    record.replayCheckpointImplemented, record.candidateAssemblerImplemented, record.ownerAuthorizationPresent,
    record.physicalAttemptPerformed, record.runtimeWired, record.grantsApproval, record.grantsQualificationAuthority,
    record.grantsCandidateAuthority, record.grantsActivationAuthority, record.grantsNetworkAuthority,
    record.grantsCommandAuthority, record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1
    || record.live340ProductCommit !== "3108a8759863c4692ade2d5532e88cd28f259779"
    || record.acceptedLive340ReviewSha256 !==
      "bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af"
    || record.live420ProductCommit !== "c1287817079e6951ab5d1fbe24829cccc517687d"
    || record.acceptedLive420ReviewSha256 !==
      "6b472475d1e8d8bb9193b1b1df133316b8a939fbdec8c52e1e5b63bfd2308119"
    || record.rawObservationProperties !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_PROPERTIES_V1
    || record.rules !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_RULES_V1
    || record.stages !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_STAGES_V1
    || record.blockers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_BLOCKERS_V1
    || record.outcomes !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_OUTCOMES_V1
    || record.maximumFutureSourceInvocations !== 1 || record.maximumCurrentSourceInvocations !== 0
    || record.maximumFutureNativeOperations !== 8 || record.maximumCurrentNativeOperations !== 0
    || reflectApplyV1(arraySomeV1, requiredTrue, [(entry: boolean) => entry !== true])
    || reflectApplyV1(arraySomeV1, requiredFalse, [(entry: boolean) => entry !== false])) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "contractReference", "contractDigest", "evidenceClass", "lookupState", "invocationState",
    "rawObservationState", "attestationState", "runtimeState", "actualSourceModuleImports",
    "actualSourceModifications", "actualCompositionCalls", "actualAuthorizationSpends",
    "actualPostTransactionRechecks", "actualSourceLookups", "actualSourceInvocations", "actualInvocationArguments",
    "actualDescriptorInspections", "actualProcessVersionReads", "actualProcessExecPathReads",
    "actualProcessIdReads", "actualParentProcessIdReads", "actualOsPlatformCalls", "actualOsArchitectureCalls",
    "actualOsReleaseCalls", "actualOsUptimeCalls", "actualHostObservations", "actualEnvironmentReads",
    "actualPathReads", "actualRawObservationsCreated", "actualRawObservationReturns", "actualRawObservationExports",
    "actualRawObservationSerializations", "actualRawObservationLogs", "actualRawObservationDigests",
    "actualRawObservationPersistenceWrites", "actualPrivateAttestationHandoffs", "actualAttestationsCreated",
    "actualSignerCalls", "actualClockReads", "actualNoncesIssued", "actualCheckpointWrites",
    "actualPersistenceWrites", "actualCandidateAssemblerEntries", "actualOwnerAuthorizationSpends",
    "actualPhysicalAttempts", "actualNativeListenerAttempts", "actualTimerCreations", "actualNetworkIoEvents",
    "actualProviderCalls", "actualProtectedValuesRead", "actualCommandsExecuted", "actualTerminalAmbiguities",
    "externalEffectOccurred", "targetRuntimeBlockerCleared", "physicalQualificationAccepted", "runtimeWired",
    "candidateEligible", "activationEligible", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const actuals = [record.actualSourceModuleImports, record.actualSourceModifications, record.actualCompositionCalls,
    record.actualAuthorizationSpends, record.actualPostTransactionRechecks, record.actualSourceLookups,
    record.actualSourceInvocations, record.actualInvocationArguments, record.actualDescriptorInspections,
    record.actualProcessVersionReads, record.actualProcessExecPathReads, record.actualProcessIdReads,
    record.actualParentProcessIdReads, record.actualOsPlatformCalls, record.actualOsArchitectureCalls,
    record.actualOsReleaseCalls, record.actualOsUptimeCalls, record.actualHostObservations,
    record.actualEnvironmentReads, record.actualPathReads, record.actualRawObservationsCreated,
    record.actualRawObservationReturns, record.actualRawObservationExports, record.actualRawObservationSerializations,
    record.actualRawObservationLogs, record.actualRawObservationDigests, record.actualRawObservationPersistenceWrites,
    record.actualPrivateAttestationHandoffs, record.actualAttestationsCreated, record.actualSignerCalls,
    record.actualClockReads, record.actualNoncesIssued, record.actualCheckpointWrites, record.actualPersistenceWrites,
    record.actualCandidateAssemblerEntries, record.actualOwnerAuthorizationSpends, record.actualPhysicalAttempts,
    record.actualNativeListenerAttempts, record.actualTimerCreations, record.actualNetworkIoEvents,
    record.actualProviderCalls, record.actualProtectedValuesRead, record.actualCommandsExecuted,
    record.actualTerminalAmbiguities];
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1
    || record.contractReference !== connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1.contractReference
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1.contractDigest
    || record.evidenceClass !== "repository_contract_non_execution"
    || record.lookupState !== "accepted_guarded_private_uninvoked"
    || record.invocationState !== "contract_only_not_attempted" || record.rawObservationState !== "not_created"
    || record.attestationState !== "not_implemented" || record.runtimeState !== "not_wired"
    || actuals.length !== 44 || reflectApplyV1(arraySomeV1, actuals, [(entry: number) => entry !== 0])
    || grants.length !== 8 || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])
    || record.externalEffectOccurred || record.targetRuntimeBlockerCleared || record.physicalQualificationAccepted
    || record.runtimeWired || record.candidateEligible || record.activationEligible) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1);
