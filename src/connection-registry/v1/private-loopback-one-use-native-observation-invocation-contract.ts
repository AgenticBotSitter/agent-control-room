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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_INVOCATION_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-one-use-native-observation-invocation-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_INVOCATION_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-one-use-native-observation-invocation-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OPERATIONS_V1 =
  objectFreezeV1(["observe_target_runtime_once"] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BINDINGS_V1 = objectFreezeV1([
  "source_implementation_reference",
  "source_implementation_digest",
  "tenant_id",
  "project_id",
  "connection_id",
  "node_id",
  "target_platform_family",
  "target_runtime_family",
  "candidate_id",
  "attempt_id",
  "operation",
  "nonce",
  "issued_at",
  "not_before",
  "expires_at",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_RULES_V1 = objectFreezeV1([
  "require_authenticated_authorization",
  "bind_exact_accepted_source",
  "bind_complete_target_candidate_attempt_lineage",
  "allow_exactly_one_operation",
  "require_fresh_nonce",
  "use_trusted_broker_time",
  "verify_independent_replay_state",
  "recheck_immediately_before_consumption",
  "consume_atomically_before_lookup",
  "recheck_trusted_time_after_transaction",
  "treat_commit_uncertainty_as_terminal",
  "keep_lookup_and_invocation_same_module_private",
  "allow_at_most_one_lookup_and_one_invocation",
  "prohibit_retry_fallback_or_replacement",
  "keep_raw_observation_private_and_sanitize_outcome",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_STAGES_V1 = objectFreezeV1([
  "accepted_unreachable_source",
  "one_use_invocation_contract",
  "authenticated_authorization_store_and_replay_checkpoint",
  "final_trusted_time_and_lineage_validation",
  "atomic_authorization_consumption",
  "post_transaction_trusted_time_recheck",
  "same_module_private_source_lookup",
  "single_synchronous_private_source_invocation",
  "private_raw_observation_handoff",
  "trusted_observation_to_attestation_binding_and_signature",
  "durable_attestation_replay_checkpoint",
  "private_physical_candidate_assembly",
  "fresh_one_use_owner_authorization",
  "single_owner_attended_physical_attempt_and_sanitized_evidence",
  "different_independent_review",
  "separate_runtime_activation_approval",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BLOCKERS_V1 = objectFreezeV1([
  "invocation_authorization_store_missing",
  "invocation_authorization_authentication_key_missing",
  "trusted_broker_clock_missing",
  "fresh_nonce_issuer_missing",
  "independent_invocation_replay_checkpoint_missing",
  "atomic_authorization_consumption_missing",
  "private_same_module_lookup_bridge_missing",
  "private_raw_observation_handoff_missing",
  "observation_attestation_binding_missing",
  "platform_evidence_signer_missing",
  "durable_attestation_replay_checkpoint_missing",
  "private_candidate_assembler_missing",
  "fresh_owner_authorization_missing",
  "physical_qualification_missing",
  "runtime_activation_approval_missing",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OUTCOMES_V1 = objectFreezeV1([
  "not_attempted",
  "rejected_before_consumption",
  "failed_precommit_without_spend",
  "terminal_ambiguity_at_or_after_commit",
  "spent_source_failure",
] as const);

export type ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_INVOCATION_CONTRACT_V1;
  contractReference: string;
  live330ProductCommit: "06be655d188c45902c015f85225673dfc31c445d";
  acceptedLive330ReviewSha256: "da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85";
  operations: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OPERATIONS_V1;
  requiredBindings: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BINDINGS_V1;
  rules: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_RULES_V1;
  stages: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_STAGES_V1;
  blockers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BLOCKERS_V1;
  outcomes: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OUTCOMES_V1;
  maximumAuthorizations: 1;
  maximumSourceLookups: 1;
  maximumSourceInvocations: 1;
  authenticatedAuthorizationRequired: true;
  trustedBrokerTimeRequired: true;
  freshNonceRequired: true;
  independentReplayCheckpointRequired: true;
  atomicConsumeBeforeLookupRequired: true;
  postTransactionTimeRecheckRequired: true;
  sameModuleRequired: true;
  rawObservationPrivateRequired: true;
  retryAfterCommitUncertaintyAllowed: false;
  retryAfterSourceFailureAllowed: false;
  callerNativeBindingAllowed: false;
  callerCallableAllowed: false;
  callbackAllowed: false;
  replacementBindingAllowed: false;
  fallbackAllowed: false;
  partialObservationAllowed: false;
  contractImplemented: true;
  authorizationStoreImplemented: false;
  authorizationCreated: false;
  authorizationConsumed: false;
  replayCheckpointImplemented: false;
  lookupBridgeImplemented: false;
  sourceLookedUp: false;
  sourceInvoked: false;
  rawObservationCreated: false;
  attestationImplemented: false;
  candidateAssemblerImplemented: false;
  ownerAuthorizationPresent: false;
  physicalAttemptPerformed: false;
  runtimeWired: false;
  activationEligible: false;
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

export type ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_INVOCATION_STATUS_V1;
  contractReference: string;
  contractDigest: string;
  evidenceClass: "repository_contract_non_execution";
  authorizationState: "not_implemented";
  replayState: "not_implemented";
  lookupState: "not_implemented";
  invocationState: "not_attempted";
  observationState: "not_created";
  attestationState: "not_created";
  candidateState: "not_assembled";
  runtimeState: "not_wired";
  actualNativeSourceImports: 0;
  actualNativeSourceModifications: 0;
  actualAuthorizationStores: 0;
  actualAuthenticationKeys: 0;
  actualAuthorizationsCreated: 0;
  actualAuthorizationValidations: 0;
  actualAuthorizationConsumptions: 0;
  actualReplayReads: 0;
  actualReplayWrites: 0;
  actualClockReads: 0;
  actualNoncesIssued: 0;
  actualSourceLookups: 0;
  actualSourceInvocations: 0;
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
  actualRawObservationReturns: 0;
  actualAttestationsCreated: 0;
  actualSignerCalls: 0;
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

export class ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "invocation_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "invocation_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "one use native observation invocation contract record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live330ProductCommit: "06be655d188c45902c015f85225673dfc31c445d",
  acceptedLive330ReviewSha256: "da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85",
  operations: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OPERATIONS_V1,
  requiredBindings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BINDINGS_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_RULES_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BLOCKERS_V1,
  outcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OUTCOMES_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_INVOCATION_CONTRACT_V1,
  contractReference: `one-use-native-observation-invocation:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live330ProductCommit: "06be655d188c45902c015f85225673dfc31c445d" as const,
  acceptedLive330ReviewSha256: "da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85" as const,
  operations: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OPERATIONS_V1,
  requiredBindings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BINDINGS_V1,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_RULES_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BLOCKERS_V1,
  outcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OUTCOMES_V1,
  maximumAuthorizations: 1 as const,
  maximumSourceLookups: 1 as const,
  maximumSourceInvocations: 1 as const,
  authenticatedAuthorizationRequired: true as const,
  trustedBrokerTimeRequired: true as const,
  freshNonceRequired: true as const,
  independentReplayCheckpointRequired: true as const,
  atomicConsumeBeforeLookupRequired: true as const,
  postTransactionTimeRecheckRequired: true as const,
  sameModuleRequired: true as const,
  rawObservationPrivateRequired: true as const,
  retryAfterCommitUncertaintyAllowed: false as const,
  retryAfterSourceFailureAllowed: false as const,
  callerNativeBindingAllowed: false as const,
  callerCallableAllowed: false as const,
  callbackAllowed: false as const,
  replacementBindingAllowed: false as const,
  fallbackAllowed: false as const,
  partialObservationAllowed: false as const,
  contractImplemented: true as const,
  authorizationStoreImplemented: false as const,
  authorizationCreated: false as const,
  authorizationConsumed: false as const,
  replayCheckpointImplemented: false as const,
  lookupBridgeImplemented: false as const,
  sourceLookedUp: false as const,
  sourceInvoked: false as const,
  rawObservationCreated: false as const,
  attestationImplemented: false as const,
  candidateAssemblerImplemented: false as const,
  ownerAuthorizationPresent: false as const,
  physicalAttemptPerformed: false as const,
  runtimeWired: false as const,
  activationEligible: false as const,
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
export const connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
reflectApplyV1(weakSetAddV1, contractRecordsV1,
  [connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1,
  [connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1,
    connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1.contractDigest]);

const zeroActualsV1 = {
  actualNativeSourceImports: 0 as const,
  actualNativeSourceModifications: 0 as const,
  actualAuthorizationStores: 0 as const,
  actualAuthenticationKeys: 0 as const,
  actualAuthorizationsCreated: 0 as const,
  actualAuthorizationValidations: 0 as const,
  actualAuthorizationConsumptions: 0 as const,
  actualReplayReads: 0 as const,
  actualReplayWrites: 0 as const,
  actualClockReads: 0 as const,
  actualNoncesIssued: 0 as const,
  actualSourceLookups: 0 as const,
  actualSourceInvocations: 0 as const,
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
  actualRawObservationReturns: 0 as const,
  actualAttestationsCreated: 0 as const,
  actualSignerCalls: 0 as const,
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
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_INVOCATION_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1.contractDigest,
  evidenceClass: "repository_contract_non_execution" as const,
  authorizationState: "not_implemented" as const,
  replayState: "not_implemented" as const,
  lookupState: "not_implemented" as const,
  invocationState: "not_attempted" as const,
  observationState: "not_created" as const,
  attestationState: "not_created" as const,
  candidateState: "not_assembled" as const,
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
export const connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1,
    connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "contractReference", "live330ProductCommit", "acceptedLive330ReviewSha256", "operations",
    "requiredBindings", "rules", "stages", "blockers", "outcomes", "maximumAuthorizations",
    "maximumSourceLookups", "maximumSourceInvocations", "authenticatedAuthorizationRequired",
    "trustedBrokerTimeRequired", "freshNonceRequired", "independentReplayCheckpointRequired",
    "atomicConsumeBeforeLookupRequired", "postTransactionTimeRecheckRequired", "sameModuleRequired",
    "rawObservationPrivateRequired", "retryAfterCommitUncertaintyAllowed", "retryAfterSourceFailureAllowed",
    "callerNativeBindingAllowed", "callerCallableAllowed", "callbackAllowed", "replacementBindingAllowed",
    "fallbackAllowed", "partialObservationAllowed", "contractImplemented", "authorizationStoreImplemented",
    "authorizationCreated", "authorizationConsumed", "replayCheckpointImplemented", "lookupBridgeImplemented",
    "sourceLookedUp", "sourceInvoked", "rawObservationCreated", "attestationImplemented",
    "candidateAssemblerImplemented", "ownerAuthorizationPresent", "physicalAttemptPerformed", "runtimeWired",
    "activationEligible", "repositoryContractOnly", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "contractDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  const falseValues = [record.retryAfterCommitUncertaintyAllowed, record.retryAfterSourceFailureAllowed,
    record.callerNativeBindingAllowed, record.callerCallableAllowed, record.callbackAllowed,
    record.replacementBindingAllowed, record.fallbackAllowed, record.partialObservationAllowed,
    record.authorizationStoreImplemented, record.authorizationCreated, record.authorizationConsumed,
    record.replayCheckpointImplemented, record.lookupBridgeImplemented, record.sourceLookedUp, record.sourceInvoked,
    record.rawObservationCreated, record.attestationImplemented, record.candidateAssemblerImplemented,
    record.ownerAuthorizationPresent, record.physicalAttemptPerformed, record.runtimeWired, record.activationEligible,
    record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1
    || record.live330ProductCommit !== "06be655d188c45902c015f85225673dfc31c445d"
    || record.acceptedLive330ReviewSha256 !==
      "da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85"
    || record.operations !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OPERATIONS_V1
    || record.requiredBindings !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BINDINGS_V1
    || record.rules !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_RULES_V1
    || record.stages !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_STAGES_V1
    || record.blockers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BLOCKERS_V1
    || record.outcomes !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OUTCOMES_V1
    || record.maximumAuthorizations !== 1 || record.maximumSourceLookups !== 1
    || record.maximumSourceInvocations !== 1 || !record.authenticatedAuthorizationRequired
    || !record.trustedBrokerTimeRequired || !record.freshNonceRequired || !record.independentReplayCheckpointRequired
    || !record.atomicConsumeBeforeLookupRequired || !record.postTransactionTimeRecheckRequired
    || !record.sameModuleRequired || !record.rawObservationPrivateRequired || !record.contractImplemented
    || !record.repositoryContractOnly || reflectApplyV1(arraySomeV1, falseValues,
      [(entry: boolean) => entry !== false])) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "contractReference", "contractDigest", "evidenceClass", "authorizationState", "replayState",
    "lookupState", "invocationState", "observationState", "attestationState", "candidateState", "runtimeState",
    "actualNativeSourceImports", "actualNativeSourceModifications", "actualAuthorizationStores",
    "actualAuthenticationKeys", "actualAuthorizationsCreated", "actualAuthorizationValidations",
    "actualAuthorizationConsumptions", "actualReplayReads", "actualReplayWrites", "actualClockReads",
    "actualNoncesIssued", "actualSourceLookups", "actualSourceInvocations", "actualDescriptorInspections",
    "actualProcessVersionReads", "actualProcessExecPathReads", "actualProcessIdReads",
    "actualParentProcessIdReads", "actualOsPlatformCalls", "actualOsArchitectureCalls", "actualOsReleaseCalls",
    "actualOsUptimeCalls", "actualHostObservations", "actualEnvironmentReads", "actualPathReads",
    "actualRawObservationReturns", "actualAttestationsCreated", "actualSignerCalls", "actualPersistenceWrites",
    "actualCandidateAssemblerEntries", "actualOwnerAuthorizationSpends", "actualPhysicalAttempts",
    "actualNativeListenerAttempts", "actualTimerCreations", "actualNetworkIoEvents", "actualProviderCalls",
    "actualProtectedValuesRead", "actualCommandsExecuted", "actualTerminalAmbiguities", "externalEffectOccurred",
    "targetRuntimeBlockerCleared", "physicalQualificationAccepted", "runtimeWired", "candidateEligible",
    "activationEligible", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const actuals = [record.actualNativeSourceImports, record.actualNativeSourceModifications,
    record.actualAuthorizationStores, record.actualAuthenticationKeys, record.actualAuthorizationsCreated,
    record.actualAuthorizationValidations, record.actualAuthorizationConsumptions, record.actualReplayReads,
    record.actualReplayWrites, record.actualClockReads, record.actualNoncesIssued, record.actualSourceLookups,
    record.actualSourceInvocations, record.actualDescriptorInspections, record.actualProcessVersionReads,
    record.actualProcessExecPathReads, record.actualProcessIdReads, record.actualParentProcessIdReads,
    record.actualOsPlatformCalls, record.actualOsArchitectureCalls, record.actualOsReleaseCalls,
    record.actualOsUptimeCalls, record.actualHostObservations, record.actualEnvironmentReads, record.actualPathReads,
    record.actualRawObservationReturns, record.actualAttestationsCreated, record.actualSignerCalls,
    record.actualPersistenceWrites, record.actualCandidateAssemblerEntries, record.actualOwnerAuthorizationSpends,
    record.actualPhysicalAttempts, record.actualNativeListenerAttempts, record.actualTimerCreations,
    record.actualNetworkIoEvents, record.actualProviderCalls, record.actualProtectedValuesRead,
    record.actualCommandsExecuted, record.actualTerminalAmbiguities];
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1
    || record.contractReference !==
      connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1.contractReference
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1.contractDigest
    || record.evidenceClass !== "repository_contract_non_execution" || record.authorizationState !== "not_implemented"
    || record.replayState !== "not_implemented" || record.lookupState !== "not_implemented"
    || record.invocationState !== "not_attempted" || record.observationState !== "not_created"
    || record.attestationState !== "not_created" || record.candidateState !== "not_assembled"
    || record.runtimeState !== "not_wired" || actuals.length !== 39
    || reflectApplyV1(arraySomeV1, actuals, [(entry: number) => entry !== 0]) || grants.length !== 8
    || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false]) || record.externalEffectOccurred
    || record.targetRuntimeBlockerCleared || record.physicalQualificationAccepted || record.runtimeWired
    || record.candidateEligible || record.activationEligible) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1);
