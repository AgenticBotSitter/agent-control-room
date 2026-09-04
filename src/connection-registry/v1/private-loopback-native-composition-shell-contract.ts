import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";

const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-native-composition-shell-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-native-composition-shell-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CALL_GRAPH_V1 = objectFreezeV1([
  "enter_non_exported_no_input_native_composition",
  "verify_exact_accepted_live250_product_and_review",
  "verify_module_owned_implementation_composition_attempt_epoch_window_and_expiry",
  "verify_durable_claim_locator_spend_custody_spend_and_uncertainty_marker",
  "enter_live250_synchronous_private_bridge_section",
  "consume_bridge_once_before_private_factory_lookup",
  "hand_exact_factory_directly_into_shell_lexical_scope",
  "record_private_factory_receipt_without_return_serialization_log_or_digest",
  "invoke_exact_factory_once_separately_from_retrieval",
  "classify_native_settlement_without_retry",
  "retain_continuous_issuer_custody_over_exact_created_resource",
  "observe_private_locator_and_offer_same_resource_to_exact_adapter_once",
  "atomically_transfer_custody_after_acceptance_and_close_once_by_current_owner",
  "durably_reconcile_cleanup_absence_tombstone_and_checkpoint_without_reopen",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_FAILURES_V1 = objectFreezeV1([
  "definite_before_bridge_consumption",
  "terminal_identity_failure_after_bridge_consumption",
  "ambiguous_after_factory_lookup_even_without_proven_invocation",
  "definite_factory_failure_before_resource_creation",
  "adapter_rejected_issuer_retains_custody",
  "adapter_acceptance_uncertain_owner_unresolved",
  "cleanup_failed_observe_same_resource_only_no_reopen",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CUSTODY_V1 = objectFreezeV1([
  "factory_lexically_private_and_never_returned",
  "factory_receipt_does_not_prove_invocation",
  "factory_invocation_does_not_prove_resource_creation",
  "issuer_owns_exact_created_resource_before_adapter_acceptance",
  "adapter_rejection_preserves_issuer_ownership",
  "uncertain_acceptance_forbids_guessed_owner",
  "exact_acceptance_atomically_transfers_same_object",
  "current_owner_alone_may_close_exact_object_once",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_RESTART_V1 = objectFreezeV1([
  "durable_reconciliation_only",
  "no_bridge_reentry",
  "no_factory_lookup",
  "no_factory_invocation",
  "no_replacement_resource",
  "same_retained_resource_observation_or_close_only",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_PRIVACY_V1 = objectFreezeV1([
  "same_source_module_and_lexical_scope_only",
  "non_exported_shell_and_bridge",
  "no_public_getter_capability_or_callback",
  "no_caller_supplied_dependency_or_native_input",
  "no_factory_return_serialization_logging_or_digest",
  "no_resource_or_locator_export",
  "no_native_diagnostic_or_protected_value_in_evidence",
  "fixed_safe_public_status_only",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_BLOCKERS_V1 = objectFreezeV1([
  "native_composition_shell_not_implemented",
  "factory_retrieval_bridge_not_implemented",
  "real_factory_not_retrieved_or_invoked",
  "live_persistence_not_composed",
  "exact_private_adapter_not_composed",
  "physical_qualification_not_accepted",
  "runtime_not_wired",
] as const);

export type ConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CONTRACT_V1;
  contractReference: string;
  live250ProductCommit: "9b855d4193837fdf6d0d0fce1dcfd65a94cce49f";
  acceptedLive250ReviewSha256: "2dcb825f522345c214064ded31134e00fecbfee9aa2121a65d507398081eaca6";
  callGraph: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CALL_GRAPH_V1;
  failures: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_FAILURES_V1;
  custody: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CUSTODY_V1;
  restart: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_RESTART_V1;
  privacy: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_PRIVACY_V1;
  maximumShellEntries: 1;
  maximumBridgeConsumptions: 1;
  maximumFactoryLookups: 1;
  maximumFactoryReceipts: 1;
  maximumFactoryInvocations: 1;
  maximumNativeConstructions: 1;
  maximumListenerAttempts: 1;
  maximumLocatorObservations: 1;
  maximumAdapterAccepts: 1;
  maximumOwnershipTransfers: 1;
  maximumCloses: 1;
  maximumIndependentObservations: 1;
  maximumTombstones: 1;
  maximumCheckpoints: 1;
  retrievalSeparateFromInvocation: true;
  factoryReceiptProvesInvocation: false;
  factoryInvocationProvesResourceCreation: false;
  postLookupRetryAllowed: false;
  restartRetrievalOrInvocationAllowed: false;
  sameSourceModuleRequired: true;
  callerDependencyAccepted: false;
  publicShellOrBridgeExportAllowed: false;
  factoryReturnSerializationLoggingOrDigestAllowed: false;
  resourceOrLocatorExportAllowed: false;
  shellImplemented: false;
  bridgeImplemented: false;
  live220ImportedOrModified: false;
  live240ImportedOrModified: false;
  realFactoryReachable: false;
  realFactoryRetrieved: false;
  realFactoryInvoked: false;
  nativeEffectReachable: false;
  repositoryContractOnly: true;
  runtimeWired: false;
  clearsCustodyOrHandoffBlocker: false;
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
  contractDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_STATUS_V1;
  contractReference: string;
  contractDigest: string;
  evidenceClass: "repository_contract";
  blockers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_BLOCKERS_V1;
  shellState: "not_implemented";
  bridgeState: "not_implemented";
  factoryState: "sealed_unretrieved_uninvoked";
  resourceState: "not_created_or_retained";
  locatorState: "not_observed_or_exposed";
  custodyState: "not_established";
  restartState: "no_native_composition_state_exists";
  actualShellEntries: 0;
  actualBridgeConsumptions: 0;
  actualFactoryLookups: 0;
  actualFactoryReceipts: 0;
  actualFactoryInvocations: 0;
  actualNativeBackendConstructions: 0;
  actualNativeResourcesCreated: 0;
  actualNativeResourcesRetained: 0;
  actualListenerAttempts: 0;
  actualLocatorObservations: 0;
  actualAdapterAcceptCalls: 0;
  actualOwnershipTransfers: 0;
  actualCloseAttempts: 0;
  actualIndependentObservations: 0;
  actualTombstones: 0;
  actualCheckpoints: 0;
  actualPersistenceWrites: 0;
  actualTimerCreations: 0;
  actualNetworkIoEvents: 0;
  actualProtectedValuesRead: 0;
  runtimeWired: false;
  externalEffectOccurred: false;
  clearsCustodyOrHandoffBlocker: false;
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

export class ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "shell_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "shell_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "native composition shell record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live250ProductCommit: "9b855d4193837fdf6d0d0fce1dcfd65a94cce49f",
  acceptedLive250ReviewSha256: "2dcb825f522345c214064ded31134e00fecbfee9aa2121a65d507398081eaca6",
  callGraph: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CALL_GRAPH_V1,
  failures: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_FAILURES_V1,
  custody: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CUSTODY_V1,
  restart: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_RESTART_V1,
  privacy: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_PRIVACY_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CONTRACT_V1,
  contractReference: `native-composition-shell:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live250ProductCommit: "9b855d4193837fdf6d0d0fce1dcfd65a94cce49f" as const,
  acceptedLive250ReviewSha256: "2dcb825f522345c214064ded31134e00fecbfee9aa2121a65d507398081eaca6" as const,
  callGraph: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CALL_GRAPH_V1,
  failures: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_FAILURES_V1,
  custody: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CUSTODY_V1,
  restart: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_RESTART_V1,
  privacy: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_PRIVACY_V1,
  maximumShellEntries: 1 as const,
  maximumBridgeConsumptions: 1 as const,
  maximumFactoryLookups: 1 as const,
  maximumFactoryReceipts: 1 as const,
  maximumFactoryInvocations: 1 as const,
  maximumNativeConstructions: 1 as const,
  maximumListenerAttempts: 1 as const,
  maximumLocatorObservations: 1 as const,
  maximumAdapterAccepts: 1 as const,
  maximumOwnershipTransfers: 1 as const,
  maximumCloses: 1 as const,
  maximumIndependentObservations: 1 as const,
  maximumTombstones: 1 as const,
  maximumCheckpoints: 1 as const,
  retrievalSeparateFromInvocation: true as const,
  factoryReceiptProvesInvocation: false as const,
  factoryInvocationProvesResourceCreation: false as const,
  postLookupRetryAllowed: false as const,
  restartRetrievalOrInvocationAllowed: false as const,
  sameSourceModuleRequired: true as const,
  callerDependencyAccepted: false as const,
  publicShellOrBridgeExportAllowed: false as const,
  factoryReturnSerializationLoggingOrDigestAllowed: false as const,
  resourceOrLocatorExportAllowed: false as const,
  shellImplemented: false as const,
  bridgeImplemented: false as const,
  live220ImportedOrModified: false as const,
  live240ImportedOrModified: false as const,
  realFactoryReachable: false as const,
  realFactoryRetrieved: false as const,
  realFactoryInvoked: false as const,
  nativeEffectReachable: false as const,
  repositoryContractOnly: true as const,
  runtimeWired: false as const,
  clearsCustodyOrHandoffBlocker: false as const,
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

safePublicRecordV1(contractMaterialV1);
export const connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
reflectApplyV1(weakSetAddV1, contractRecordsV1, [connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1, [connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1,
  connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1.contractDigest]);

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1.contractDigest,
  evidenceClass: "repository_contract" as const,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_BLOCKERS_V1,
  shellState: "not_implemented" as const,
  bridgeState: "not_implemented" as const,
  factoryState: "sealed_unretrieved_uninvoked" as const,
  resourceState: "not_created_or_retained" as const,
  locatorState: "not_observed_or_exposed" as const,
  custodyState: "not_established" as const,
  restartState: "no_native_composition_state_exists" as const,
  actualShellEntries: 0 as const,
  actualBridgeConsumptions: 0 as const,
  actualFactoryLookups: 0 as const,
  actualFactoryReceipts: 0 as const,
  actualFactoryInvocations: 0 as const,
  actualNativeBackendConstructions: 0 as const,
  actualNativeResourcesCreated: 0 as const,
  actualNativeResourcesRetained: 0 as const,
  actualListenerAttempts: 0 as const,
  actualLocatorObservations: 0 as const,
  actualAdapterAcceptCalls: 0 as const,
  actualOwnershipTransfers: 0 as const,
  actualCloseAttempts: 0 as const,
  actualIndependentObservations: 0 as const,
  actualTombstones: 0 as const,
  actualCheckpoints: 0 as const,
  actualPersistenceWrites: 0 as const,
  actualTimerCreations: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualProtectedValuesRead: 0 as const,
  runtimeWired: false as const,
  externalEffectOccurred: false as const,
  clearsCustodyOrHandoffBlocker: false as const,
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
export const connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1, [connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1, [connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1,
  connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "contractReference", "live250ProductCommit", "acceptedLive250ReviewSha256", "callGraph",
    "failures", "custody", "restart", "privacy", "maximumShellEntries", "maximumBridgeConsumptions",
    "maximumFactoryLookups", "maximumFactoryReceipts", "maximumFactoryInvocations", "maximumNativeConstructions",
    "maximumListenerAttempts", "maximumLocatorObservations", "maximumAdapterAccepts", "maximumOwnershipTransfers",
    "maximumCloses", "maximumIndependentObservations", "maximumTombstones", "maximumCheckpoints",
    "retrievalSeparateFromInvocation", "factoryReceiptProvesInvocation", "factoryInvocationProvesResourceCreation",
    "postLookupRetryAllowed", "restartRetrievalOrInvocationAllowed", "sameSourceModuleRequired",
    "callerDependencyAccepted", "publicShellOrBridgeExportAllowed",
    "factoryReturnSerializationLoggingOrDigestAllowed", "resourceOrLocatorExportAllowed", "shellImplemented",
    "bridgeImplemented", "live220ImportedOrModified", "live240ImportedOrModified", "realFactoryReachable",
    "realFactoryRetrieved", "realFactoryInvoked", "nativeEffectReachable", "repositoryContractOnly", "runtimeWired",
    "clearsCustodyOrHandoffBlocker", "candidateEligible", "activationEligible", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority",
    "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority", "contractDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1
    || record.callGraph !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CALL_GRAPH_V1
    || record.failures !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_FAILURES_V1
    || record.custody !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_CUSTODY_V1
    || record.restart !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_RESTART_V1
    || record.privacy !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_PRIVACY_V1
    || record.shellImplemented || record.bridgeImplemented || record.live220ImportedOrModified
    || record.live240ImportedOrModified || record.realFactoryReachable || record.realFactoryRetrieved
    || record.realFactoryInvoked || record.nativeEffectReachable || !record.repositoryContractOnly
    || record.runtimeWired || record.clearsCustodyOrHandoffBlocker || record.candidateEligible
    || record.activationEligible) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "contractReference", "contractDigest", "evidenceClass", "blockers", "shellState", "bridgeState",
    "factoryState", "resourceState", "locatorState", "custodyState", "restartState", "actualShellEntries",
    "actualBridgeConsumptions", "actualFactoryLookups", "actualFactoryReceipts", "actualFactoryInvocations",
    "actualNativeBackendConstructions", "actualNativeResourcesCreated", "actualNativeResourcesRetained",
    "actualListenerAttempts", "actualLocatorObservations", "actualAdapterAcceptCalls", "actualOwnershipTransfers",
    "actualCloseAttempts", "actualIndependentObservations", "actualTombstones", "actualCheckpoints",
    "actualPersistenceWrites", "actualTimerCreations", "actualNetworkIoEvents", "actualProtectedValuesRead",
    "runtimeWired", "externalEffectOccurred", "clearsCustodyOrHandoffBlocker", "candidateEligible",
    "activationEligible", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1
    || record.contractReference !== connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1
      .contractReference
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1.contractDigest
    || record.blockers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_COMPOSITION_SHELL_BLOCKERS_V1
    || record.shellState !== "not_implemented" || record.bridgeState !== "not_implemented"
    || record.factoryState !== "sealed_unretrieved_uninvoked" || record.runtimeWired || record.externalEffectOccurred
    || record.clearsCustodyOrHandoffBlocker || record.candidateEligible || record.activationEligible) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function assessConnectionEnrollmentPrivateLoopbackNativeCompositionShellV1():
ConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1 {
  return connectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1;
}

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1,
  parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellContractV1,
  parseConnectionEnrollmentPrivateLoopbackNativeCompositionShellStatusV1,
  assessConnectionEnrollmentPrivateLoopbackNativeCompositionShellV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeCompositionShellErrorV1.prototype);
