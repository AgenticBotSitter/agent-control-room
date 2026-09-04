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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-fresh-spend-recheck-composition-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-fresh-spend-recheck-composition-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RULES_V1 = objectFreezeV1([
  "keep_spend_and_recheck_in_one_private_control_flow",
  "obtain_fresh_spend_from_own_immediately_preceding_call",
  "accept_only_fresh_consumption_receipt",
  "bind_recheck_to_same_sealed_authorization_and_spend",
  "perform_exactly_one_post_transaction_database_time_recheck",
  "accept_only_recheck_from_own_immediately_preceding_call",
  "keep_spend_and_recheck_receipts_private_and_nonexported",
  "stop_immediately_before_first_source_lookup",
  "treat_precommit_failure_as_rejected_without_source_authority",
  "treat_commit_uncertainty_as_terminal_without_retry",
  "treat_recheck_failure_after_spend_as_terminal_without_retry",
  "prohibit_replay_replacement_fallback_or_second_authorization",
  "preserve_private_source_isolation",
  "publish_only_sanitized_non_authorizing_status",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STAGES_V1 = objectFreezeV1([
  "accepted_atomic_authorization_consumption",
  "accepted_post_transaction_database_time_recheck",
  "fresh_spend_recheck_composition_contract",
  "private_same_control_flow_implementation",
  "fresh_atomic_spend",
  "post_transaction_database_time_recheck",
  "mandatory_stop_before_source_lookup",
  "same_module_private_source_lookup",
  "single_synchronous_private_source_invocation",
  "private_raw_observation_handoff",
  "trusted_observation_attestation_and_replay_checkpoint",
  "private_physical_candidate_assembly",
  "fresh_owner_authorization_and_owner_attended_attempt",
  "different_independent_review",
  "separate_runtime_activation_approval",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_BLOCKERS_V1 = objectFreezeV1([
  "private_fresh_spend_recheck_composition_missing",
  "private_same_module_lookup_bridge_missing",
  "private_source_invocation_missing",
  "private_raw_observation_handoff_missing",
  "observation_attestation_binding_missing",
  "platform_evidence_signer_missing",
  "durable_attestation_replay_checkpoint_missing",
  "private_candidate_assembler_missing",
  "fresh_owner_authorization_missing",
  "physical_qualification_missing",
  "runtime_activation_approval_missing",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_OUTCOMES_V1 = objectFreezeV1([
  "not_attempted",
  "rejected_before_spend",
  "terminal_ambiguity_at_or_after_spend",
  "spent_recheck_rejected",
  "completed_and_stopped_before_lookup",
] as const);

export type ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_CONTRACT_V1;
  contractReference: string;
  live370ProductCommit: "6f908ccd1f65f48a5d874fa0da96afe301d8decf";
  acceptedLive370ReviewSha256: "c1b22f9b8012328f4709c608c4a53292be279f47070aec6136ab40293618f490";
  live380ProductCommit: "1b79bbc75dfe74ce0777bcc33cbcc801054113f0";
  acceptedLive380ReviewSha256: "4a5f60f8ca2ad08ee04f1603773279aef97558edfa27acda1604592f8ae610bd";
  rules: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RULES_V1;
  stages: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STAGES_V1;
  blockers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_BLOCKERS_V1;
  outcomes: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_OUTCOMES_V1;
  maximumSpendCalls: 1;
  maximumRecheckCalls: 1;
  maximumSourceLookups: 0;
  samePrivateControlFlowRequired: true;
  ownFreshSpendRequired: true;
  ownImmediateRecheckRequired: true;
  sameSealedAuthorizationRequired: true;
  stopBeforeLookupRequired: true;
  receiptsPrivateRequired: true;
  callerSuppliedReceiptAllowed: false;
  receiptExportAllowed: false;
  replayAllowed: false;
  automaticRetryAllowed: false;
  replacementAuthorizationAllowed: false;
  fallbackAllowed: false;
  contractImplemented: true;
  spendImplementationAccepted: true;
  recheckImplementationAccepted: true;
  compositionImplemented: false;
  sourceLookupImplemented: false;
  sourceInvoked: false;
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

export type ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STATUS_V1;
  contractReference: string;
  contractDigest: string;
  evidenceClass: "repository_contract_non_execution";
  compositionState: "contract_only";
  spendState: "accepted_dependency_not_called";
  recheckState: "accepted_dependency_not_called";
  lookupState: "not_implemented";
  invocationState: "not_attempted";
  runtimeState: "not_wired";
  actualCompositionCalls: 0;
  actualAuthorizationValidations: 0;
  actualAuthorizationConsumptions: 0;
  actualDatabaseTransactions: 0;
  actualDatabaseClockReads: 0;
  actualPostTransactionRechecks: 0;
  actualReceiptExports: 0;
  actualReplayAttempts: 0;
  actualRetryAttempts: 0;
  actualReplacementAuthorizations: 0;
  actualFallbackAttempts: 0;
  actualSourceImports: 0;
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

export class ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "composition_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "composition_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "fresh spend recheck composition contract record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live370ProductCommit: "6f908ccd1f65f48a5d874fa0da96afe301d8decf",
  acceptedLive370ReviewSha256: "c1b22f9b8012328f4709c608c4a53292be279f47070aec6136ab40293618f490",
  live380ProductCommit: "1b79bbc75dfe74ce0777bcc33cbcc801054113f0",
  acceptedLive380ReviewSha256: "4a5f60f8ca2ad08ee04f1603773279aef97558edfa27acda1604592f8ae610bd",
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RULES_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_BLOCKERS_V1,
  outcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_OUTCOMES_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_CONTRACT_V1,
  contractReference: `fresh-spend-recheck-composition:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live370ProductCommit: "6f908ccd1f65f48a5d874fa0da96afe301d8decf" as const,
  acceptedLive370ReviewSha256: "c1b22f9b8012328f4709c608c4a53292be279f47070aec6136ab40293618f490" as const,
  live380ProductCommit: "1b79bbc75dfe74ce0777bcc33cbcc801054113f0" as const,
  acceptedLive380ReviewSha256: "4a5f60f8ca2ad08ee04f1603773279aef97558edfa27acda1604592f8ae610bd" as const,
  rules: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RULES_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_BLOCKERS_V1,
  outcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_OUTCOMES_V1,
  maximumSpendCalls: 1 as const,
  maximumRecheckCalls: 1 as const,
  maximumSourceLookups: 0 as const,
  samePrivateControlFlowRequired: true as const,
  ownFreshSpendRequired: true as const,
  ownImmediateRecheckRequired: true as const,
  sameSealedAuthorizationRequired: true as const,
  stopBeforeLookupRequired: true as const,
  receiptsPrivateRequired: true as const,
  callerSuppliedReceiptAllowed: false as const,
  receiptExportAllowed: false as const,
  replayAllowed: false as const,
  automaticRetryAllowed: false as const,
  replacementAuthorizationAllowed: false as const,
  fallbackAllowed: false as const,
  contractImplemented: true as const,
  spendImplementationAccepted: true as const,
  recheckImplementationAccepted: true as const,
  compositionImplemented: false as const,
  sourceLookupImplemented: false as const,
  sourceInvoked: false as const,
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
export const connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
reflectApplyV1(weakSetAddV1, contractRecordsV1,
  [connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1,
  [connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1,
    connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1.contractDigest]);

const zeroActualsV1 = {
  actualCompositionCalls: 0 as const,
  actualAuthorizationValidations: 0 as const,
  actualAuthorizationConsumptions: 0 as const,
  actualDatabaseTransactions: 0 as const,
  actualDatabaseClockReads: 0 as const,
  actualPostTransactionRechecks: 0 as const,
  actualReceiptExports: 0 as const,
  actualReplayAttempts: 0 as const,
  actualRetryAttempts: 0 as const,
  actualReplacementAuthorizations: 0 as const,
  actualFallbackAttempts: 0 as const,
  actualSourceImports: 0 as const,
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
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1.contractDigest,
  evidenceClass: "repository_contract_non_execution" as const,
  compositionState: "contract_only" as const,
  spendState: "accepted_dependency_not_called" as const,
  recheckState: "accepted_dependency_not_called" as const,
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
export const connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1,
    connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "contractReference", "live370ProductCommit", "acceptedLive370ReviewSha256",
    "live380ProductCommit", "acceptedLive380ReviewSha256", "rules", "stages", "blockers", "outcomes",
    "maximumSpendCalls", "maximumRecheckCalls", "maximumSourceLookups", "samePrivateControlFlowRequired",
    "ownFreshSpendRequired", "ownImmediateRecheckRequired", "sameSealedAuthorizationRequired",
    "stopBeforeLookupRequired", "receiptsPrivateRequired", "callerSuppliedReceiptAllowed", "receiptExportAllowed",
    "replayAllowed", "automaticRetryAllowed", "replacementAuthorizationAllowed", "fallbackAllowed",
    "contractImplemented", "spendImplementationAccepted", "recheckImplementationAccepted",
    "compositionImplemented", "sourceLookupImplemented", "sourceInvoked", "runtimeWired",
    "repositoryContractOnly", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "contractDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  const falseValues = [record.callerSuppliedReceiptAllowed, record.receiptExportAllowed, record.replayAllowed,
    record.automaticRetryAllowed, record.replacementAuthorizationAllowed, record.fallbackAllowed,
    record.compositionImplemented, record.sourceLookupImplemented, record.sourceInvoked, record.runtimeWired,
    record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1
    || record.live370ProductCommit !== "6f908ccd1f65f48a5d874fa0da96afe301d8decf"
    || record.acceptedLive370ReviewSha256 !==
      "c1b22f9b8012328f4709c608c4a53292be279f47070aec6136ab40293618f490"
    || record.live380ProductCommit !== "1b79bbc75dfe74ce0777bcc33cbcc801054113f0"
    || record.acceptedLive380ReviewSha256 !==
      "4a5f60f8ca2ad08ee04f1603773279aef97558edfa27acda1604592f8ae610bd"
    || record.rules !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RULES_V1
    || record.stages !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STAGES_V1
    || record.blockers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_BLOCKERS_V1
    || record.outcomes !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_OUTCOMES_V1
    || record.maximumSpendCalls !== 1 || record.maximumRecheckCalls !== 1 || record.maximumSourceLookups !== 0
    || !record.samePrivateControlFlowRequired || !record.ownFreshSpendRequired || !record.ownImmediateRecheckRequired
    || !record.sameSealedAuthorizationRequired || !record.stopBeforeLookupRequired || !record.receiptsPrivateRequired
    || !record.contractImplemented || !record.spendImplementationAccepted || !record.recheckImplementationAccepted
    || !record.repositoryContractOnly || reflectApplyV1(arraySomeV1, falseValues,
      [(entry: boolean) => entry !== false])) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "contractReference", "contractDigest", "evidenceClass", "compositionState", "spendState",
    "recheckState", "lookupState", "invocationState", "runtimeState", "actualCompositionCalls",
    "actualAuthorizationValidations", "actualAuthorizationConsumptions", "actualDatabaseTransactions",
    "actualDatabaseClockReads", "actualPostTransactionRechecks", "actualReceiptExports", "actualReplayAttempts",
    "actualRetryAttempts", "actualReplacementAuthorizations", "actualFallbackAttempts", "actualSourceImports",
    "actualSourceLookups", "actualSourceInvocations", "actualNativeReads", "actualRawObservationReturns",
    "actualAttestationsCreated", "actualSignerCalls", "actualPersistenceWrites", "actualCandidateAssemblerEntries",
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
    record.actualPostTransactionRechecks, record.actualReceiptExports, record.actualReplayAttempts,
    record.actualRetryAttempts, record.actualReplacementAuthorizations, record.actualFallbackAttempts,
    record.actualSourceImports, record.actualSourceLookups, record.actualSourceInvocations, record.actualNativeReads,
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
    || record !== connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1
    || record.contractReference !==
      connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1.contractReference
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1.contractDigest
    || record.evidenceClass !== "repository_contract_non_execution" || record.compositionState !== "contract_only"
    || record.spendState !== "accepted_dependency_not_called"
    || record.recheckState !== "accepted_dependency_not_called" || record.lookupState !== "not_implemented"
    || record.invocationState !== "not_attempted" || record.runtimeState !== "not_wired"
    || actuals.length !== 28 || reflectApplyV1(arraySomeV1, actuals, [(entry: number) => entry !== 0])
    || reflectApplyV1(arraySomeV1, falseValues, [(entry: boolean) => entry !== false])) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1);
