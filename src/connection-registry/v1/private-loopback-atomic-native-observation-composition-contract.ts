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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-atomic-native-observation-composition-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-atomic-native-observation-composition-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_RULES_V1 = objectFreezeV1([
  "co_locate_static_native_sources",
  "keep_consolidated_callable_private",
  "reject_cross_module_callable_export_or_lookup",
  "reject_caller_native_bindings_and_descriptors",
  "validate_exact_own_data_descriptors",
  "require_writable_enumerable_nonconfigurable_shape",
  "consume_validated_descriptor_values_once",
  "prohibit_second_namespace_read",
  "remain_synchronous_without_interleaving",
  "validate_os_observation_shape_and_bounds",
  "treat_partial_or_uncertain_observation_as_terminal",
  "keep_raw_observation_private",
  "sanitize_public_evidence",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STAGES_V1 =
  objectFreezeV1([
    "accepted_observer_source",
    "accepted_binding_validator_source",
    "atomic_composition_contract",
    "same_module_unreachable_source_consolidation",
    "one_use_retrieval_and_invocation_authorization",
    "private_raw_observation",
    "trusted_clock_nonce_candidate_and_attempt_binding",
    "platform_signature",
    "durable_replay_checkpoint",
    "private_physical_candidate_assembly",
    "fresh_one_use_owner_authorization",
    "single_owner_attended_physical_attempt",
    "sanitized_result_and_independent_absence_evidence",
    "different_independent_review",
    "separate_runtime_activation_approval",
  ] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_BLOCKERS_V1 =
  objectFreezeV1([
    "atomic_native_observation_composition_missing",
    "one_use_composition_retrieval_authority_missing",
    "private_composition_lookup_missing",
    "private_composition_invocation_missing",
    "private_raw_observation_missing",
    "trusted_clock_missing",
    "fresh_nonce_missing",
    "platform_evidence_signer_missing",
    "durable_replay_checkpoint_missing",
    "target_runtime_attestation_missing",
    "private_candidate_assembler_missing",
    "fresh_owner_authorization_missing",
    "physical_qualification_missing",
    "runtime_activation_approval_missing",
  ] as const);

export type ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_CONTRACT_V1;
  contractReference: string;
  live290ProductCommit: "3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba";
  acceptedLive290ReviewSha256: "df2f3fb2fd414d595f020395dfc69fde2857c413e82d8d206383e66c6555c9b6";
  live310IntegrationProduct: "d95738bf79f9f12f6986f28b8f7548b661f0587a";
  acceptedLive310ReviewSha256: "db3c721a2ad20b9f533202bc48275df6617035d30eb27df52900d8f97dbdb20e";
  rules: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_RULES_V1;
  stages: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STAGES_V1;
  blockers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_BLOCKERS_V1;
  maximumCompositionEntries: 1;
  sameModuleRequired: true;
  noInputRequired: true;
  synchronousRequired: true;
  validatedDescriptorValueConsumptionRequired: true;
  secondNamespaceReadAllowed: false;
  crossModuleCallableExportAllowed: false;
  callerBindingAllowed: false;
  callerDescriptorAllowed: false;
  callbackAllowed: false;
  promiseOrAwaitAllowed: false;
  timerAllowed: false;
  automaticRetryAllowed: false;
  replacementBindingAllowed: false;
  partialObservationAllowed: false;
  repositoryFakeSatisfiesRealObservation: false;
  compositionContractImplemented: true;
  atomicCompositionImplemented: false;
  compositionRetrievable: false;
  compositionInvoked: false;
  descriptorValidationImplemented: false;
  rawObservationImplemented: false;
  attestationImplemented: false;
  replayCheckpointImplemented: false;
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

export type ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STATUS_V1;
  contractReference: string;
  contractDigest: string;
  evidenceClass: "repository_contract_non_execution";
  compositionState: "contract_only";
  observerSourceState: "accepted_isolated_unreachable_uninvoked";
  validatorSourceState: "accepted_isolated_unreachable_uninvoked";
  descriptorState: "not_inspected";
  observationState: "not_created";
  attestationState: "not_created";
  candidateState: "not_assembled";
  runtimeState: "not_wired";
  actualNativeSourceImports: 0;
  actualNativeSourceModifications: 0;
  actualCompositionImplementations: 0;
  actualCompositionLookups: 0;
  actualCompositionInvocations: 0;
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
  actualClockReads: 0;
  actualNoncesIssued: 0;
  actualCheckpointWrites: 0;
  actualPersistenceWrites: 0;
  actualCandidateAssemblerEntries: 0;
  actualOwnerAuthorizationSpends: 0;
  actualPhysicalAttempts: 0;
  actualNativeListenerAttempts: 0;
  actualNetworkIoEvents: 0;
  actualProviderCalls: 0;
  actualProtectedValuesRead: 0;
  actualCommandsExecuted: 0;
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

export class ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "composition_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "composition_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1["safeCode"]):
never {
  throw new ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "atomic native observation composition record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live290ProductCommit: "3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba",
  acceptedLive290ReviewSha256: "df2f3fb2fd414d595f020395dfc69fde2857c413e82d8d206383e66c6555c9b6",
  live310IntegrationProduct: "d95738bf79f9f12f6986f28b8f7548b661f0587a",
  acceptedLive310ReviewSha256: "db3c721a2ad20b9f533202bc48275df6617035d30eb27df52900d8f97dbdb20e",
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_RULES_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_BLOCKERS_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_CONTRACT_V1,
  contractReference: `atomic-native-observation-composition:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live290ProductCommit: "3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba" as const,
  acceptedLive290ReviewSha256: "df2f3fb2fd414d595f020395dfc69fde2857c413e82d8d206383e66c6555c9b6" as const,
  live310IntegrationProduct: "d95738bf79f9f12f6986f28b8f7548b661f0587a" as const,
  acceptedLive310ReviewSha256: "db3c721a2ad20b9f533202bc48275df6617035d30eb27df52900d8f97dbdb20e" as const,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_RULES_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_BLOCKERS_V1,
  maximumCompositionEntries: 1 as const,
  sameModuleRequired: true as const,
  noInputRequired: true as const,
  synchronousRequired: true as const,
  validatedDescriptorValueConsumptionRequired: true as const,
  secondNamespaceReadAllowed: false as const,
  crossModuleCallableExportAllowed: false as const,
  callerBindingAllowed: false as const,
  callerDescriptorAllowed: false as const,
  callbackAllowed: false as const,
  promiseOrAwaitAllowed: false as const,
  timerAllowed: false as const,
  automaticRetryAllowed: false as const,
  replacementBindingAllowed: false as const,
  partialObservationAllowed: false as const,
  repositoryFakeSatisfiesRealObservation: false as const,
  compositionContractImplemented: true as const,
  atomicCompositionImplemented: false as const,
  compositionRetrievable: false as const,
  compositionInvoked: false as const,
  descriptorValidationImplemented: false as const,
  rawObservationImplemented: false as const,
  attestationImplemented: false as const,
  replayCheckpointImplemented: false as const,
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
export const connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
reflectApplyV1(weakSetAddV1, contractRecordsV1,
  [connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1,
  [connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1,
    connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1.contractDigest]);

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1.contractDigest,
  evidenceClass: "repository_contract_non_execution" as const,
  compositionState: "contract_only" as const,
  observerSourceState: "accepted_isolated_unreachable_uninvoked" as const,
  validatorSourceState: "accepted_isolated_unreachable_uninvoked" as const,
  descriptorState: "not_inspected" as const,
  observationState: "not_created" as const,
  attestationState: "not_created" as const,
  candidateState: "not_assembled" as const,
  runtimeState: "not_wired" as const,
  actualNativeSourceImports: 0 as const,
  actualNativeSourceModifications: 0 as const,
  actualCompositionImplementations: 0 as const,
  actualCompositionLookups: 0 as const,
  actualCompositionInvocations: 0 as const,
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
  actualClockReads: 0 as const,
  actualNoncesIssued: 0 as const,
  actualCheckpointWrites: 0 as const,
  actualPersistenceWrites: 0 as const,
  actualCandidateAssemblerEntries: 0 as const,
  actualOwnerAuthorizationSpends: 0 as const,
  actualPhysicalAttempts: 0 as const,
  actualNativeListenerAttempts: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualProviderCalls: 0 as const,
  actualProtectedValuesRead: 0 as const,
  actualCommandsExecuted: 0 as const,
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
export const connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1,
    connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "contractReference", "live290ProductCommit", "acceptedLive290ReviewSha256",
    "live310IntegrationProduct", "acceptedLive310ReviewSha256", "rules", "stages", "blockers",
    "maximumCompositionEntries", "sameModuleRequired", "noInputRequired", "synchronousRequired",
    "validatedDescriptorValueConsumptionRequired", "secondNamespaceReadAllowed",
    "crossModuleCallableExportAllowed", "callerBindingAllowed", "callerDescriptorAllowed", "callbackAllowed",
    "promiseOrAwaitAllowed", "timerAllowed", "automaticRetryAllowed", "replacementBindingAllowed",
    "partialObservationAllowed", "repositoryFakeSatisfiesRealObservation", "compositionContractImplemented",
    "atomicCompositionImplemented", "compositionRetrievable", "compositionInvoked",
    "descriptorValidationImplemented", "rawObservationImplemented", "attestationImplemented",
    "replayCheckpointImplemented", "candidateAssemblerImplemented", "ownerAuthorizationPresent",
    "physicalAttemptPerformed", "runtimeWired", "activationEligible", "repositoryContractOnly", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "contractDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  const grantValues = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1
    || record.live290ProductCommit !== "3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba"
    || record.acceptedLive290ReviewSha256 !==
      "df2f3fb2fd414d595f020395dfc69fde2857c413e82d8d206383e66c6555c9b6"
    || record.live310IntegrationProduct !== "d95738bf79f9f12f6986f28b8f7548b661f0587a"
    || record.acceptedLive310ReviewSha256 !==
      "db3c721a2ad20b9f533202bc48275df6617035d30eb27df52900d8f97dbdb20e"
    || record.rules !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_RULES_V1
    || record.stages !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_STAGES_V1
    || record.blockers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_NATIVE_OBSERVATION_COMPOSITION_BLOCKERS_V1
    || record.maximumCompositionEntries !== 1 || !record.sameModuleRequired || !record.noInputRequired
    || !record.synchronousRequired || !record.validatedDescriptorValueConsumptionRequired
    || record.secondNamespaceReadAllowed || record.crossModuleCallableExportAllowed || record.callerBindingAllowed
    || record.callerDescriptorAllowed || record.callbackAllowed || record.promiseOrAwaitAllowed || record.timerAllowed
    || record.automaticRetryAllowed || record.replacementBindingAllowed || record.partialObservationAllowed
    || record.repositoryFakeSatisfiesRealObservation || !record.compositionContractImplemented
    || record.atomicCompositionImplemented || record.compositionRetrievable || record.compositionInvoked
    || record.descriptorValidationImplemented || record.rawObservationImplemented || record.attestationImplemented
    || record.replayCheckpointImplemented || record.candidateAssemblerImplemented || record.ownerAuthorizationPresent
    || record.physicalAttemptPerformed || record.runtimeWired || record.activationEligible
    || !record.repositoryContractOnly || grantValues.length !== 8
    || reflectApplyV1(arraySomeV1, grantValues, [(entry: boolean) => entry !== false])) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "contractReference", "contractDigest", "evidenceClass", "compositionState",
    "observerSourceState", "validatorSourceState", "descriptorState", "observationState", "attestationState",
    "candidateState", "runtimeState", "actualNativeSourceImports", "actualNativeSourceModifications",
    "actualCompositionImplementations", "actualCompositionLookups", "actualCompositionInvocations",
    "actualDescriptorInspections", "actualProcessVersionReads", "actualProcessExecPathReads", "actualProcessIdReads",
    "actualParentProcessIdReads", "actualOsPlatformCalls", "actualOsArchitectureCalls", "actualOsReleaseCalls",
    "actualOsUptimeCalls", "actualHostObservations", "actualEnvironmentReads", "actualPathReads",
    "actualRawObservationReturns", "actualAttestationsCreated", "actualSignerCalls", "actualClockReads",
    "actualNoncesIssued", "actualCheckpointWrites", "actualPersistenceWrites", "actualCandidateAssemblerEntries",
    "actualOwnerAuthorizationSpends", "actualPhysicalAttempts", "actualNativeListenerAttempts",
    "actualNetworkIoEvents", "actualProviderCalls", "actualProtectedValuesRead", "actualCommandsExecuted",
    "externalEffectOccurred", "targetRuntimeBlockerCleared", "physicalQualificationAccepted", "runtimeWired",
    "candidateEligible", "activationEligible", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const actualValues = [record.actualNativeSourceImports, record.actualNativeSourceModifications,
    record.actualCompositionImplementations, record.actualCompositionLookups, record.actualCompositionInvocations,
    record.actualDescriptorInspections, record.actualProcessVersionReads, record.actualProcessExecPathReads,
    record.actualProcessIdReads, record.actualParentProcessIdReads, record.actualOsPlatformCalls,
    record.actualOsArchitectureCalls, record.actualOsReleaseCalls, record.actualOsUptimeCalls,
    record.actualHostObservations, record.actualEnvironmentReads, record.actualPathReads,
    record.actualRawObservationReturns, record.actualAttestationsCreated, record.actualSignerCalls,
    record.actualClockReads, record.actualNoncesIssued, record.actualCheckpointWrites, record.actualPersistenceWrites,
    record.actualCandidateAssemblerEntries, record.actualOwnerAuthorizationSpends, record.actualPhysicalAttempts,
    record.actualNativeListenerAttempts, record.actualNetworkIoEvents, record.actualProviderCalls,
    record.actualProtectedValuesRead, record.actualCommandsExecuted];
  const grantValues = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1
    || record.contractReference !==
      connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1.contractReference
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1.contractDigest
    || record.evidenceClass !== "repository_contract_non_execution" || record.compositionState !== "contract_only"
    || record.observerSourceState !== "accepted_isolated_unreachable_uninvoked"
    || record.validatorSourceState !== "accepted_isolated_unreachable_uninvoked"
    || record.descriptorState !== "not_inspected" || record.observationState !== "not_created"
    || record.attestationState !== "not_created" || record.candidateState !== "not_assembled"
    || record.runtimeState !== "not_wired"
    || actualValues.length !== 32 || reflectApplyV1(arraySomeV1, actualValues, [(entry: number) => entry !== 0])
    || grantValues.length !== 8 || reflectApplyV1(arraySomeV1, grantValues, [(entry: boolean) => entry !== false])
    || record.externalEffectOccurred || record.targetRuntimeBlockerCleared || record.physicalQualificationAccepted
    || record.runtimeWired || record.candidateEligible || record.activationEligible) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionContractV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackAtomicNativeObservationCompositionStatusV1);
