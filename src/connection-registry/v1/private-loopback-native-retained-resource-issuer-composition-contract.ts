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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-native-issuer-composition-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-native-issuer-composition-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BINDINGS_V1 = objectFreezeV1([
  "tenant_workspace_project",
  "node_connection_route",
  "qualification_candidate_attempt_epoch",
  "owner_window_and_expiry",
  "connection_enrollment",
  "target_runtime_attestation",
  "tunnel_peer_proof",
  "host_key_custody_proof",
  "live200_issuer_contract",
  "live210_state_machine",
  "live220_private_factory",
  "live190_same_server_adapter",
  "private_locator_policy",
  "exclusive_custody_policy",
  "repository_clock",
  "signer_boundary",
  "persistence_boundary",
  "independent_zero_resource_observer",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_MARKERS_V1 = objectFreezeV1([
  "attempt_claim",
  "locator_spend",
  "custody_spend",
  "effect_uncertainty",
  "native_settlement",
  "adapter_acceptance",
  "ownership_transfer",
  "cleanup_outcome",
  "attempt_tombstone",
  "external_high_water_checkpoint",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_ORDER_V1 = objectFreezeV1([
  "verify_exact_bindings_and_expiry",
  "durably_claim_attempt",
  "durably_spend_locator_authority",
  "durably_spend_custody_authority",
  "durably_mark_effect_uncertainty",
  "retrieve_exact_private_factory_once",
  "construct_one_server",
  "listen_once_on_literal_ipv4_loopback",
  "observe_private_locator_once",
  "retain_exact_server_in_issuer_custody",
  "offer_exact_server_to_exact_adapter_once",
  "atomically_transfer_custody_after_acceptance",
  "close_once_by_current_owner",
  "durably_record_cleanup_outcome",
  "independently_observe_zero_resource",
  "durably_tombstone_and_checkpoint",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_FAILURES_V1 = objectFreezeV1([
  "definite_before_effect_marker",
  "ambiguous_after_effect_marker",
  "adapter_rejected_issuer_retains_custody",
  "adapter_acceptance_uncertain_owner_unresolved",
  "cleanup_failed_no_reopen_observation_only",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_PROOFS_V1 = objectFreezeV1([
  "all_bindings_verified_before_claim",
  "claim_and_spends_durable_before_native_call",
  "uncertainty_durable_before_native_settlement",
  "one_factory_retrieval",
  "one_server_construction",
  "one_listener_attempt",
  "one_private_locator_observation",
  "continuous_exact_server_custody",
  "one_exact_adapter_acceptance",
  "atomic_same_object_transfer",
  "one_close_by_current_owner",
  "ambiguity_never_retried",
  "cleanup_failure_never_claimed_closed",
  "independent_zero_resource_before_terminal_success",
  "no_public_resource_locator_capability_or_authority",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BLOCKERS_V1 = objectFreezeV1([
  "composition_not_implemented",
  "factory_retrieval_not_authorized",
  "live_bindings_not_supplied",
  "durable_spends_not_performed",
  "private_locator_not_observed",
  "same_server_adapter_not_called",
  "physical_qualification_not_accepted",
  "runtime_not_wired",
] as const);

export type ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_CONTRACT_V1;
  contractReference: string;
  live220ProductCommit: "2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9";
  acceptedLive220ReviewSha256: "4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30";
  bindings: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BINDINGS_V1;
  markers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_MARKERS_V1;
  order: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_ORDER_V1;
  failures: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_FAILURES_V1;
  proofs: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_PROOFS_V1;
  maximumFactoryRetrievals: 1;
  maximumServerConstructions: 1;
  maximumListenerAttempts: 1;
  maximumLocatorObservations: 1;
  maximumAdapterAccepts: 1;
  maximumOwnershipTransfers: 1;
  maximumCloses: 1;
  callerFactoryAccepted: false;
  callerServerAccepted: false;
  callerAdapterAccepted: false;
  callerLocatorAccepted: false;
  callerEffectClientAccepted: false;
  numericPortHandoffAllowed: false;
  retryRebindReopenAllowed: false;
  realCompositionImplemented: false;
  live220ImportedOrConsumed: false;
  nativeFactoryRetrieved: false;
  nativeFactoryInvoked: false;
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

export type ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_STATUS_V1;
  contractReference: string;
  contractDigest: string;
  evidenceClass: "repository_contract";
  blockers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BLOCKERS_V1;
  compositionState: "not_implemented";
  factoryState: "not_retrieved_or_invoked";
  resourceState: "not_created_or_retained";
  locatorState: "not_observed_or_spent";
  handoffState: "not_issued_or_spent";
  cleanupState: "not_required";
  actualHostObservations: 0;
  actualPortSelections: 0;
  actualPortReservations: 0;
  actualFactoryRetrievals: 0;
  actualNativeBackendConstructions: 0;
  actualNativeResourcesCreated: 0;
  actualNativeResourcesRetained: 0;
  actualListenerAttempts: 0;
  actualCloseAttempts: 0;
  actualLocatorObservations: 0;
  actualCapabilitiesIssued: 0;
  actualCapabilitiesSpent: 0;
  actualAdapterAcceptCalls: 0;
  actualDriverCalls: 0;
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

export class ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "composition_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "composition_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "native issuer composition record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live220ProductCommit: "2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9",
  acceptedLive220ReviewSha256: "4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30",
  bindings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BINDINGS_V1,
  markers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_MARKERS_V1,
  order: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_ORDER_V1,
  failures: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_FAILURES_V1,
  proofs: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_PROOFS_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_CONTRACT_V1,
  contractReference: `native-issuer-composition:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live220ProductCommit: "2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9" as const,
  acceptedLive220ReviewSha256: "4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30" as const,
  bindings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BINDINGS_V1,
  markers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_MARKERS_V1,
  order: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_ORDER_V1,
  failures: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_FAILURES_V1,
  proofs: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_PROOFS_V1,
  maximumFactoryRetrievals: 1 as const,
  maximumServerConstructions: 1 as const,
  maximumListenerAttempts: 1 as const,
  maximumLocatorObservations: 1 as const,
  maximumAdapterAccepts: 1 as const,
  maximumOwnershipTransfers: 1 as const,
  maximumCloses: 1 as const,
  callerFactoryAccepted: false as const,
  callerServerAccepted: false as const,
  callerAdapterAccepted: false as const,
  callerLocatorAccepted: false as const,
  callerEffectClientAccepted: false as const,
  numericPortHandoffAllowed: false as const,
  retryRebindReopenAllowed: false as const,
  realCompositionImplemented: false as const,
  live220ImportedOrConsumed: false as const,
  nativeFactoryRetrieved: false as const,
  nativeFactoryInvoked: false as const,
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
export const connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
reflectApplyV1(weakSetAddV1, contractRecordsV1, [connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1, [connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1,
  connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1.contractDigest]);

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1.contractDigest,
  evidenceClass: "repository_contract" as const,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BLOCKERS_V1,
  compositionState: "not_implemented" as const,
  factoryState: "not_retrieved_or_invoked" as const,
  resourceState: "not_created_or_retained" as const,
  locatorState: "not_observed_or_spent" as const,
  handoffState: "not_issued_or_spent" as const,
  cleanupState: "not_required" as const,
  actualHostObservations: 0 as const,
  actualPortSelections: 0 as const,
  actualPortReservations: 0 as const,
  actualFactoryRetrievals: 0 as const,
  actualNativeBackendConstructions: 0 as const,
  actualNativeResourcesCreated: 0 as const,
  actualNativeResourcesRetained: 0 as const,
  actualListenerAttempts: 0 as const,
  actualCloseAttempts: 0 as const,
  actualLocatorObservations: 0 as const,
  actualCapabilitiesIssued: 0 as const,
  actualCapabilitiesSpent: 0 as const,
  actualAdapterAcceptCalls: 0 as const,
  actualDriverCalls: 0 as const,
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
export const connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1, [connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1, [connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1,
  connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "contractReference", "live220ProductCommit", "acceptedLive220ReviewSha256", "bindings",
    "markers", "order", "failures", "proofs", "maximumFactoryRetrievals", "maximumServerConstructions",
    "maximumListenerAttempts", "maximumLocatorObservations", "maximumAdapterAccepts", "maximumOwnershipTransfers",
    "maximumCloses", "callerFactoryAccepted", "callerServerAccepted", "callerAdapterAccepted",
    "callerLocatorAccepted", "callerEffectClientAccepted", "numericPortHandoffAllowed", "retryRebindReopenAllowed",
    "realCompositionImplemented", "live220ImportedOrConsumed", "nativeFactoryRetrieved", "nativeFactoryInvoked",
    "repositoryContractOnly", "runtimeWired", "clearsCustodyOrHandoffBlocker", "candidateEligible",
    "activationEligible", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "contractDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1
    || record.bindings !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BINDINGS_V1
    || record.markers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_MARKERS_V1
    || record.order !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_ORDER_V1
    || record.failures !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_FAILURES_V1
    || record.proofs !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_PROOFS_V1
    || record.realCompositionImplemented || record.live220ImportedOrConsumed || record.nativeFactoryRetrieved
    || record.nativeFactoryInvoked || !record.repositoryContractOnly || record.runtimeWired
    || record.clearsCustodyOrHandoffBlocker || record.candidateEligible || record.activationEligible) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "contractReference", "contractDigest", "evidenceClass", "blockers", "compositionState",
    "factoryState", "resourceState", "locatorState", "handoffState", "cleanupState", "actualHostObservations",
    "actualPortSelections", "actualPortReservations", "actualFactoryRetrievals", "actualNativeBackendConstructions",
    "actualNativeResourcesCreated", "actualNativeResourcesRetained", "actualListenerAttempts", "actualCloseAttempts",
    "actualLocatorObservations", "actualCapabilitiesIssued", "actualCapabilitiesSpent", "actualAdapterAcceptCalls",
    "actualDriverCalls", "actualPersistenceWrites", "actualTimerCreations", "actualNetworkIoEvents",
    "actualProtectedValuesRead", "runtimeWired", "externalEffectOccurred", "clearsCustodyOrHandoffBlocker",
    "candidateEligible", "activationEligible", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1
    || record.contractReference !== connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1
      .contractReference
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1.contractDigest
    || record.blockers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_BLOCKERS_V1
    || record.compositionState !== "not_implemented" || record.factoryState !== "not_retrieved_or_invoked"
    || record.runtimeWired || record.externalEffectOccurred || record.clearsCustodyOrHandoffBlocker
    || record.candidateEligible || record.activationEligible) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function assessConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionV1():
ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1 {
  return connectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1;
}

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionErrorV1,
  parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionContractV1,
  parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStatusV1,
  assessConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionErrorV1.prototype);
