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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-atomic-source-lookup-bridge-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-atomic-source-lookup-bridge-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_RULES_V1 = objectFreezeV1([
  "bind_exact_accepted_unreachable_atomic_source",
  "bind_exact_accepted_private_spend_recheck_composition",
  "require_own_exact_fresh_spend_and_immediate_recheck",
  "use_unbroken_private_control_flow_as_authority",
  "reject_public_success_result_as_lookup_authority",
  "reject_receipt_boolean_digest_identity_or_caller_assertion_as_authority",
  "consolidate_final_success_branch_and_source_storage_in_one_private_module",
  "prohibit_exported_map_key_source_getter_callback_token_or_bridge",
  "perform_at_most_one_private_source_lookup",
  "require_exact_existing_module_owned_source",
  "handoff_source_directly_to_separately_gated_private_invocation",
  "erase_lexical_receipt_and_source_references_on_settlement",
  "treat_missing_uncertain_or_substituted_source_as_terminal",
  "prohibit_retry_replacement_refund_unconsume_fallback_or_second_lookup",
  "keep_raw_observation_private",
  "publish_only_sanitized_non_authorizing_status",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STAGES_V1 = objectFreezeV1([
  "accepted_unreachable_atomic_source",
  "accepted_private_fresh_spend_recheck_composition",
  "atomic_source_lookup_bridge_contract",
  "future_private_same_module_consolidation",
  "exact_fresh_atomic_spend",
  "exact_immediate_post_transaction_recheck",
  "private_in_flow_success_decision",
  "single_same_module_private_source_lookup",
  "single_synchronous_private_source_invocation",
  "private_raw_observation_handoff",
  "trusted_observation_attestation_and_replay_checkpoint",
  "private_physical_candidate_and_owner_authorization",
  "single_owner_attended_physical_attempt",
  "separate_runtime_activation_approval",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_BLOCKERS_V1 = objectFreezeV1([
  "live400_private_success_not_exposed_and_must_remain_unexported",
  "live330_private_source_has_no_lookup",
  "same_module_consolidation_not_implemented",
  "private_source_lookup_bridge_not_implemented",
  "one_use_source_invocation_not_implemented",
  "private_raw_observation_handoff_missing",
  "observation_attestation_binding_missing",
  "platform_evidence_signer_missing",
  "durable_attestation_replay_checkpoint_missing",
  "private_candidate_assembler_missing",
  "fresh_owner_authorization_missing",
  "physical_qualification_missing",
  "runtime_activation_approval_missing",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_OUTCOMES_V1 = objectFreezeV1([
  "not_attempted",
  "rejected_before_spend",
  "terminal_spend_uncertain",
  "terminal_already_consumed",
  "terminal_recheck_failed",
  "terminal_private_provenance_failed",
  "terminal_source_lookup_failed",
] as const);

export type ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_CONTRACT_V1;
  contractReference: string;
  live330ProductCommit: "06be655d188c45902c015f85225673dfc31c445d";
  acceptedLive330ReviewSha256: "da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85";
  live400ProductCommit: "ccce7c84ebfbf955f05fb7b150c1ccf9b80535b3";
  acceptedLive400ReviewSha256: "fab7088cf3bcfbcd8a9a14de6af9d58e8ca3471057230ea8cc73acb6660f86ce";
  rules: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_RULES_V1;
  stages: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STAGES_V1;
  blockers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_BLOCKERS_V1;
  outcomes: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_OUTCOMES_V1;
  maximumFutureSourceLookups: 1;
  maximumCurrentSourceLookups: 0;
  maximumFutureSourceInvocations: 1;
  sameModuleConsolidationRequired: true;
  unbrokenPrivateControlFlowRequired: true;
  exactFreshSpendRequired: true;
  exactImmediateRecheckRequired: true;
  exactStoredSourceRequired: true;
  directPrivateInvocationHandoffRequired: true;
  rawObservationPrivateRequired: true;
  publicSuccessResultAuthorizesLookup: false;
  callerSuppliedSuccessAllowed: false;
  callerSuppliedReceiptAllowed: false;
  publicObjectIdentityAuthorizesLookup: false;
  exportedBridgeAllowed: false;
  callbackAllowed: false;
  retryAllowed: false;
  replacementAuthorizationAllowed: false;
  refundOrUnconsumeAllowed: false;
  fallbackAllowed: false;
  secondLookupAllowed: false;
  contractImplemented: true;
  live330DependencyAccepted: true;
  live400DependencyAccepted: true;
  sameModuleConsolidationImplemented: false;
  privateSuccessStateImplemented: false;
  lookupBridgeImplemented: false;
  sourceLookedUp: false;
  sourceInvoked: false;
  rawObservationCreated: false;
  attestationImplemented: false;
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

export type ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STATUS_V1;
  contractReference: string;
  contractDigest: string;
  evidenceClass: "repository_contract_non_execution";
  sourceState: "accepted_stored_unreachable_uninvoked";
  compositionState: "accepted_stopped_before_lookup";
  bridgeState: "contract_only";
  lookupState: "not_implemented";
  invocationState: "not_attempted";
  runtimeState: "not_wired";
  actualCompositionCalls: 0;
  actualAuthorizationValidations: 0;
  actualAuthorizationConsumptions: 0;
  actualDatabaseTransactions: 0;
  actualDatabaseClockReads: 0;
  actualPostTransactionRechecks: 0;
  actualPrivateSuccessStatesCreated: 0;
  actualPublicSuccessResultsConsumed: 0;
  actualReceiptsAccepted: 0;
  actualReceiptExports: 0;
  actualExportedBridges: 0;
  actualCallbacksAccepted: 0;
  actualSourceImports: 0;
  actualSourceModifications: 0;
  actualSameModuleConsolidations: 0;
  actualSourceMapLookups: 0;
  actualSourceLookups: 0;
  actualSourceInvocations: 0;
  actualNativeReads: 0;
  actualRawObservationReturns: 0;
  actualAttestationsCreated: 0;
  actualSignerCalls: 0;
  actualPersistenceWrites: 0;
  actualCandidateAssemblerEntries: 0;
  actualOwnerAuthorizationSpends: 0;
  actualPhysicalAttempts: 0;
  actualNativeListenerAttempts: 0;
  actualNetworkIoEvents: 0;
  actualProviderCalls: 0;
  actualProtectedValuesRead: 0;
  actualCommandsExecuted: 0;
  actualTerminalAmbiguities: 0;
  externalEffectOccurred: false;
  sourceBoundaryCrossed: false;
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

export class ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "lookup_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "lookup_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "atomic source lookup bridge contract record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live330ProductCommit: "06be655d188c45902c015f85225673dfc31c445d",
  acceptedLive330ReviewSha256: "da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85",
  live400ProductCommit: "ccce7c84ebfbf955f05fb7b150c1ccf9b80535b3",
  acceptedLive400ReviewSha256: "fab7088cf3bcfbcd8a9a14de6af9d58e8ca3471057230ea8cc73acb6660f86ce",
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_RULES_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_BLOCKERS_V1,
  outcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_OUTCOMES_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_CONTRACT_V1,
  contractReference: `atomic-source-lookup-bridge:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live330ProductCommit: "06be655d188c45902c015f85225673dfc31c445d" as const,
  acceptedLive330ReviewSha256: "da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85" as const,
  live400ProductCommit: "ccce7c84ebfbf955f05fb7b150c1ccf9b80535b3" as const,
  acceptedLive400ReviewSha256: "fab7088cf3bcfbcd8a9a14de6af9d58e8ca3471057230ea8cc73acb6660f86ce" as const,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_RULES_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_BLOCKERS_V1,
  outcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_OUTCOMES_V1,
  maximumFutureSourceLookups: 1 as const,
  maximumCurrentSourceLookups: 0 as const,
  maximumFutureSourceInvocations: 1 as const,
  sameModuleConsolidationRequired: true as const,
  unbrokenPrivateControlFlowRequired: true as const,
  exactFreshSpendRequired: true as const,
  exactImmediateRecheckRequired: true as const,
  exactStoredSourceRequired: true as const,
  directPrivateInvocationHandoffRequired: true as const,
  rawObservationPrivateRequired: true as const,
  publicSuccessResultAuthorizesLookup: false as const,
  callerSuppliedSuccessAllowed: false as const,
  callerSuppliedReceiptAllowed: false as const,
  publicObjectIdentityAuthorizesLookup: false as const,
  exportedBridgeAllowed: false as const,
  callbackAllowed: false as const,
  retryAllowed: false as const,
  replacementAuthorizationAllowed: false as const,
  refundOrUnconsumeAllowed: false as const,
  fallbackAllowed: false as const,
  secondLookupAllowed: false as const,
  contractImplemented: true as const,
  live330DependencyAccepted: true as const,
  live400DependencyAccepted: true as const,
  sameModuleConsolidationImplemented: false as const,
  privateSuccessStateImplemented: false as const,
  lookupBridgeImplemented: false as const,
  sourceLookedUp: false as const,
  sourceInvoked: false as const,
  rawObservationCreated: false as const,
  attestationImplemented: false as const,
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
export const connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
reflectApplyV1(weakSetAddV1, contractRecordsV1,
  [connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1,
  [connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
    connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1.contractDigest]);

const zeroActualsV1 = {
  actualCompositionCalls: 0 as const,
  actualAuthorizationValidations: 0 as const,
  actualAuthorizationConsumptions: 0 as const,
  actualDatabaseTransactions: 0 as const,
  actualDatabaseClockReads: 0 as const,
  actualPostTransactionRechecks: 0 as const,
  actualPrivateSuccessStatesCreated: 0 as const,
  actualPublicSuccessResultsConsumed: 0 as const,
  actualReceiptsAccepted: 0 as const,
  actualReceiptExports: 0 as const,
  actualExportedBridges: 0 as const,
  actualCallbacksAccepted: 0 as const,
  actualSourceImports: 0 as const,
  actualSourceModifications: 0 as const,
  actualSameModuleConsolidations: 0 as const,
  actualSourceMapLookups: 0 as const,
  actualSourceLookups: 0 as const,
  actualSourceInvocations: 0 as const,
  actualNativeReads: 0 as const,
  actualRawObservationReturns: 0 as const,
  actualAttestationsCreated: 0 as const,
  actualSignerCalls: 0 as const,
  actualPersistenceWrites: 0 as const,
  actualCandidateAssemblerEntries: 0 as const,
  actualOwnerAuthorizationSpends: 0 as const,
  actualPhysicalAttempts: 0 as const,
  actualNativeListenerAttempts: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualProviderCalls: 0 as const,
  actualProtectedValuesRead: 0 as const,
  actualCommandsExecuted: 0 as const,
  actualTerminalAmbiguities: 0 as const,
};

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1.contractDigest,
  evidenceClass: "repository_contract_non_execution" as const,
  sourceState: "accepted_stored_unreachable_uninvoked" as const,
  compositionState: "accepted_stopped_before_lookup" as const,
  bridgeState: "contract_only" as const,
  lookupState: "not_implemented" as const,
  invocationState: "not_attempted" as const,
  runtimeState: "not_wired" as const,
  ...zeroActualsV1,
  externalEffectOccurred: false as const,
  sourceBoundaryCrossed: false as const,
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
export const connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1,
    connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "contractReference", "live330ProductCommit", "acceptedLive330ReviewSha256",
    "live400ProductCommit", "acceptedLive400ReviewSha256", "rules", "stages", "blockers", "outcomes",
    "maximumFutureSourceLookups", "maximumCurrentSourceLookups", "maximumFutureSourceInvocations",
    "sameModuleConsolidationRequired", "unbrokenPrivateControlFlowRequired", "exactFreshSpendRequired",
    "exactImmediateRecheckRequired", "exactStoredSourceRequired", "directPrivateInvocationHandoffRequired",
    "rawObservationPrivateRequired", "publicSuccessResultAuthorizesLookup", "callerSuppliedSuccessAllowed",
    "callerSuppliedReceiptAllowed", "publicObjectIdentityAuthorizesLookup", "exportedBridgeAllowed",
    "callbackAllowed", "retryAllowed", "replacementAuthorizationAllowed", "refundOrUnconsumeAllowed",
    "fallbackAllowed", "secondLookupAllowed", "contractImplemented", "live330DependencyAccepted",
    "live400DependencyAccepted", "sameModuleConsolidationImplemented", "privateSuccessStateImplemented",
    "lookupBridgeImplemented", "sourceLookedUp", "sourceInvoked", "rawObservationCreated",
    "attestationImplemented", "candidateAssemblerImplemented", "ownerAuthorizationPresent",
    "physicalAttemptPerformed", "runtimeWired", "repositoryContractOnly", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "contractDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  const falseValues = [record.publicSuccessResultAuthorizesLookup, record.callerSuppliedSuccessAllowed,
    record.callerSuppliedReceiptAllowed, record.publicObjectIdentityAuthorizesLookup, record.exportedBridgeAllowed,
    record.callbackAllowed, record.retryAllowed, record.replacementAuthorizationAllowed,
    record.refundOrUnconsumeAllowed, record.fallbackAllowed, record.secondLookupAllowed,
    record.sameModuleConsolidationImplemented, record.privateSuccessStateImplemented, record.lookupBridgeImplemented,
    record.sourceLookedUp, record.sourceInvoked, record.rawObservationCreated, record.attestationImplemented,
    record.candidateAssemblerImplemented, record.ownerAuthorizationPresent, record.physicalAttemptPerformed,
    record.runtimeWired, record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1
    || record.live330ProductCommit !== "06be655d188c45902c015f85225673dfc31c445d"
    || record.acceptedLive330ReviewSha256 !==
      "da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85"
    || record.live400ProductCommit !== "ccce7c84ebfbf955f05fb7b150c1ccf9b80535b3"
    || record.acceptedLive400ReviewSha256 !==
      "fab7088cf3bcfbcd8a9a14de6af9d58e8ca3471057230ea8cc73acb6660f86ce"
    || record.rules !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_RULES_V1
    || record.stages !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STAGES_V1
    || record.blockers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_BLOCKERS_V1
    || record.outcomes !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_OUTCOMES_V1
    || record.maximumFutureSourceLookups !== 1 || record.maximumCurrentSourceLookups !== 0
    || record.maximumFutureSourceInvocations !== 1 || !record.sameModuleConsolidationRequired
    || !record.unbrokenPrivateControlFlowRequired || !record.exactFreshSpendRequired
    || !record.exactImmediateRecheckRequired || !record.exactStoredSourceRequired
    || !record.directPrivateInvocationHandoffRequired || !record.rawObservationPrivateRequired
    || !record.contractImplemented || !record.live330DependencyAccepted || !record.live400DependencyAccepted
    || !record.repositoryContractOnly || reflectApplyV1(arraySomeV1, falseValues,
      [(entry: boolean) => entry !== false])) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "contractReference", "contractDigest", "evidenceClass", "sourceState", "compositionState",
    "bridgeState", "lookupState", "invocationState", "runtimeState", "actualCompositionCalls",
    "actualAuthorizationValidations", "actualAuthorizationConsumptions", "actualDatabaseTransactions",
    "actualDatabaseClockReads", "actualPostTransactionRechecks", "actualPrivateSuccessStatesCreated",
    "actualPublicSuccessResultsConsumed", "actualReceiptsAccepted", "actualReceiptExports",
    "actualExportedBridges", "actualCallbacksAccepted", "actualSourceImports", "actualSourceModifications",
    "actualSameModuleConsolidations", "actualSourceMapLookups", "actualSourceLookups",
    "actualSourceInvocations", "actualNativeReads", "actualRawObservationReturns", "actualAttestationsCreated",
    "actualSignerCalls", "actualPersistenceWrites", "actualCandidateAssemblerEntries",
    "actualOwnerAuthorizationSpends", "actualPhysicalAttempts", "actualNativeListenerAttempts",
    "actualNetworkIoEvents", "actualProviderCalls", "actualProtectedValuesRead", "actualCommandsExecuted",
    "actualTerminalAmbiguities", "externalEffectOccurred", "sourceBoundaryCrossed", "targetRuntimeBlockerCleared",
    "physicalQualificationAccepted", "runtimeWired", "candidateEligible", "activationEligible", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const actuals = [record.actualCompositionCalls, record.actualAuthorizationValidations,
    record.actualAuthorizationConsumptions, record.actualDatabaseTransactions, record.actualDatabaseClockReads,
    record.actualPostTransactionRechecks, record.actualPrivateSuccessStatesCreated,
    record.actualPublicSuccessResultsConsumed, record.actualReceiptsAccepted, record.actualReceiptExports,
    record.actualExportedBridges, record.actualCallbacksAccepted, record.actualSourceImports,
    record.actualSourceModifications, record.actualSameModuleConsolidations, record.actualSourceMapLookups,
    record.actualSourceLookups, record.actualSourceInvocations, record.actualNativeReads,
    record.actualRawObservationReturns, record.actualAttestationsCreated, record.actualSignerCalls,
    record.actualPersistenceWrites, record.actualCandidateAssemblerEntries, record.actualOwnerAuthorizationSpends,
    record.actualPhysicalAttempts, record.actualNativeListenerAttempts, record.actualNetworkIoEvents,
    record.actualProviderCalls, record.actualProtectedValuesRead, record.actualCommandsExecuted,
    record.actualTerminalAmbiguities];
  const falseValues = [record.externalEffectOccurred, record.sourceBoundaryCrossed,
    record.targetRuntimeBlockerCleared, record.physicalQualificationAccepted, record.runtimeWired,
    record.candidateEligible, record.activationEligible, record.grantsApproval, record.grantsQualificationAuthority,
    record.grantsCandidateAuthority, record.grantsActivationAuthority, record.grantsNetworkAuthority,
    record.grantsCommandAuthority, record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1
    || record.contractReference !== connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1.contractReference
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1.contractDigest
    || record.evidenceClass !== "repository_contract_non_execution"
    || record.sourceState !== "accepted_stored_unreachable_uninvoked"
    || record.compositionState !== "accepted_stopped_before_lookup" || record.bridgeState !== "contract_only"
    || record.lookupState !== "not_implemented" || record.invocationState !== "not_attempted"
    || record.runtimeState !== "not_wired" || actuals.length !== 32
    || reflectApplyV1(arraySomeV1, actuals, [(entry: number) => entry !== 0])
    || reflectApplyV1(arraySomeV1, falseValues, [(entry: boolean) => entry !== false])) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1);
