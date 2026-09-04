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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-native-retained-resource-issuer-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_RESULT_V1 =
  "control-room-connection-enrollment-private-loopback-native-retained-resource-issuer-result/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_BINDINGS_V1 = objectFreezeV1([
  "tenant_node_connection_route",
  "qualification_candidate_attempt_epoch",
  "fresh_owner_authorization_window",
  "accepted_prerequisite_assessment",
  "accepted_target_runtime_attestation",
  "accepted_private_locator_broker",
  "accepted_exclusive_port_custody",
  "accepted_retained_resource_handoff",
  "accepted_retained_resource_driver_port",
  "accepted_native_retained_resource_adapter",
  "target_runtime_and_tunnel_peer",
  "verified_host_key_digest",
  "fixed_ipv4_loopback_host_policy",
  "private_locator_and_custody_spends",
  "maximum_deadline",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_MARKERS_V1 = objectFreezeV1([
  "pre_effect_intent",
  "attempt_claimed",
  "locator_spent",
  "custody_spent",
  "effect_uncertainty",
  "listen_settled",
  "resource_custody_retained",
  "adapter_acceptance",
  "ownership_transferred",
  "close_outcome",
  "independent_zero_resource_observation",
  "terminal_tombstone",
  "external_checkpoint",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_FAILURES_V1 = objectFreezeV1([
  "definite_before_effect",
  "ambiguous_after_effect_marker",
  "cleanup_failed",
  "recovered_closed_verified",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_PROOFS_V1 = objectFreezeV1([
  "all_private_bindings_verified_before_effect",
  "durable_attempt_and_spends_before_effect",
  "maximum_one_server_creation_and_listen_attempt",
  "same_resource_identity_after_settlement",
  "continuous_custody_until_exact_adapter_acceptance",
  "atomic_adapter_acceptance_and_ownership_transition",
  "no_numeric_port_or_replacement_resource",
  "no_retry_rebind_reopen_or_substitution",
  "failure_and_uncertainty_separated",
  "mandatory_exactly_once_close_after_failure_or_uncertainty",
  "independent_zero_resource_evidence_before_terminal_claim",
  "cleanup_failure_preserved_until_no_reopen_recovery",
  "durable_marker_and_checkpoint_chain",
  "no_public_resource_locator_handle_or_capability",
] as const);

export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CONTRACT_V1;
  policyReference: string;
  live190ProductCommit: "d59c02792e49a79a291e3f9109fc43f2fd22fbd8";
  acceptedLive190ReviewSha256: "29be3e4ba7075397a764d57161bbff953993e6d2d815a4cc9ac353f475ab224a";
  resourceClass: "retained_ipv4_loopback_tcp_listener";
  issuerSurface: "same_module_private_non_serializable";
  requiredBindings: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_BINDINGS_V1;
  requiredMarkers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_MARKERS_V1;
  failureClasses: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_FAILURES_V1;
  requiredProofs: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_PROOFS_V1;
  maximumServerCreations: 1;
  maximumListenAttempts: 1;
  maximumAdapterAcceptances: 1;
  maximumCloseAttempts: 1;
  retryRebindReopenAllowed: false;
  numericPortHandoffAllowed: false;
  publicResourceOrLocatorAllowed: false;
  realIssuerImplemented: false;
  runtimeNetworkModuleImported: false;
  livePersistenceImplemented: false;
  runtimeWired: false;
  clearsCustodyOrHandoffBlocker: false;
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

export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerResultV1 = Readonly<{
  resultVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_RESULT_V1;
  resultReference: string;
  policyReference: string;
  contractDigest: string;
  evidenceClass: "repository_fake";
  requiredBindings: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_BINDINGS_V1;
  requiredMarkers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_MARKERS_V1;
  failureClasses: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_FAILURES_V1;
  requiredProofs: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_PROOFS_V1;
  bindingsVerified: false;
  attemptClaimed: false;
  locatorSpent: false;
  custodySpent: false;
  effectUncertaintyMarked: false;
  nativeServerCreated: false;
  nativeServerRetained: false;
  sameResourceIdentityVerified: false;
  continuousCustodyVerified: false;
  adapterAcceptedExactResource: false;
  ownershipTransferred: false;
  terminalCloseVerified: false;
  independentZeroResourceEvidencePresent: false;
  terminalTombstoneRecorded: false;
  externalCheckpointRecorded: false;
  realIssuerImplemented: false;
  driverReservationHandoffGapPresent: true;
  exclusivePortCustodyMissing: true;
  clearsCustodyOrHandoffBlocker: false;
  candidateEligible: false;
  activationEligible: false;
  actualHostObservations: 0;
  actualPortSelections: 0;
  actualPortReservations: 0;
  actualNativeResourcesCreated: 0;
  actualNativeResourcesRetained: 0;
  actualCapabilitiesIssued: 0;
  actualCapabilitiesSpent: 0;
  actualDriverAcceptCalls: 0;
  actualNativeBackendConstructions: 0;
  actualListenerAttempts: 0;
  actualIpcListenerAttempts: 0;
  actualSocketAttempts: 0;
  actualTimerCreations: 0;
  actualNetworkIoEvents: 0;
  actualProtectedValuesRead: 0;
  actualPersistenceWrites: 0;
  runtimeWired: false;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  resultDigest: string;
}>;

export class ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_result" | "integrity_failed";
  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_result" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const resultRecordsV1 = new WeakSet<object>();
const resultDigestsV1 = new WeakMap<object, string>();

function failV1(code: "invalid_contract" | "invalid_result" | "integrity_failed"): never {
  throw new ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "native retained resource issuer record"); }
  catch { failV1("integrity_failed"); }
}

const policySeedV1 = sha256Digest({
  live190ProductCommit: "d59c02792e49a79a291e3f9109fc43f2fd22fbd8",
  acceptedLive190ReviewSha256: "29be3e4ba7075397a764d57161bbff953993e6d2d815a4cc9ac353f475ab224a",
  resourceClass: "retained_ipv4_loopback_tcp_listener",
  requiredBindings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_BINDINGS_V1,
  requiredMarkers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_MARKERS_V1,
  failureClasses: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_FAILURES_V1,
  requiredProofs: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_PROOFS_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CONTRACT_V1,
  policyReference: `native-retained-resource-issuer-policy:${reflectApplyV1(stringSliceV1, policySeedV1, [7, 31])}`,
  live190ProductCommit: "d59c02792e49a79a291e3f9109fc43f2fd22fbd8" as const,
  acceptedLive190ReviewSha256: "29be3e4ba7075397a764d57161bbff953993e6d2d815a4cc9ac353f475ab224a" as const,
  resourceClass: "retained_ipv4_loopback_tcp_listener" as const,
  issuerSurface: "same_module_private_non_serializable" as const,
  requiredBindings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_BINDINGS_V1,
  requiredMarkers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_MARKERS_V1,
  failureClasses: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_FAILURES_V1,
  requiredProofs: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_PROOFS_V1,
  maximumServerCreations: 1 as const,
  maximumListenAttempts: 1 as const,
  maximumAdapterAcceptances: 1 as const,
  maximumCloseAttempts: 1 as const,
  retryRebindReopenAllowed: false as const,
  numericPortHandoffAllowed: false as const,
  publicResourceOrLocatorAllowed: false as const,
  realIssuerImplemented: false as const,
  runtimeNetworkModuleImported: false as const,
  livePersistenceImplemented: false as const,
  runtimeWired: false as const,
  clearsCustodyOrHandoffBlocker: false as const,
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
export const connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1;
reflectApplyV1(weakSetAddV1, contractRecordsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1,
    connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1.contractDigest]);

const resultMaterialV1 = {
  resultVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_RESULT_V1,
  resultReference: `native-retained-resource-issuer-fake:${reflectApplyV1(stringSliceV1,
    connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1.contractDigest, [7, 31])}`,
  policyReference: connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1.policyReference,
  contractDigest: connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1.contractDigest,
  evidenceClass: "repository_fake" as const,
  requiredBindings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_BINDINGS_V1,
  requiredMarkers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_MARKERS_V1,
  failureClasses: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_FAILURES_V1,
  requiredProofs: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_PROOFS_V1,
  bindingsVerified: false as const,
  attemptClaimed: false as const,
  locatorSpent: false as const,
  custodySpent: false as const,
  effectUncertaintyMarked: false as const,
  nativeServerCreated: false as const,
  nativeServerRetained: false as const,
  sameResourceIdentityVerified: false as const,
  continuousCustodyVerified: false as const,
  adapterAcceptedExactResource: false as const,
  ownershipTransferred: false as const,
  terminalCloseVerified: false as const,
  independentZeroResourceEvidencePresent: false as const,
  terminalTombstoneRecorded: false as const,
  externalCheckpointRecorded: false as const,
  realIssuerImplemented: false as const,
  driverReservationHandoffGapPresent: true as const,
  exclusivePortCustodyMissing: true as const,
  clearsCustodyOrHandoffBlocker: false as const,
  candidateEligible: false as const,
  activationEligible: false as const,
  actualHostObservations: 0 as const,
  actualPortSelections: 0 as const,
  actualPortReservations: 0 as const,
  actualNativeResourcesCreated: 0 as const,
  actualNativeResourcesRetained: 0 as const,
  actualCapabilitiesIssued: 0 as const,
  actualCapabilitiesSpent: 0 as const,
  actualDriverAcceptCalls: 0 as const,
  actualNativeBackendConstructions: 0 as const,
  actualListenerAttempts: 0 as const,
  actualIpcListenerAttempts: 0 as const,
  actualSocketAttempts: 0 as const,
  actualTimerCreations: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualProtectedValuesRead: 0 as const,
  actualPersistenceWrites: 0 as const,
  runtimeWired: false as const,
  externalEffectOccurred: false as const,
  grantsApproval: false as const,
  grantsQualificationAuthority: false as const,
  grantsCandidateAuthority: false as const,
  grantsActivationAuthority: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(resultMaterialV1);
export const connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1 = objectFreezeV1({
  ...resultMaterialV1,
  resultDigest: sha256Digest(resultMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerResultV1;
reflectApplyV1(weakSetAddV1, resultRecordsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1]);
reflectApplyV1(weakMapSetV1, resultDigestsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1,
    connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1.resultDigest]);

export function parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "policyReference", "live190ProductCommit", "acceptedLive190ReviewSha256", "resourceClass",
    "issuerSurface", "requiredBindings", "requiredMarkers", "failureClasses", "requiredProofs",
    "maximumServerCreations", "maximumListenAttempts", "maximumAdapterAcceptances", "maximumCloseAttempts",
    "retryRebindReopenAllowed", "numericPortHandoffAllowed", "publicResourceOrLocatorAllowed",
    "realIssuerImplemented", "runtimeNetworkModuleImported", "livePersistenceImplemented", "runtimeWired",
    "clearsCustodyOrHandoffBlocker", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "contractDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1
    || record.requiredBindings !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_BINDINGS_V1
    || record.requiredMarkers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_MARKERS_V1
    || record.failureClasses !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_FAILURES_V1
    || record.requiredProofs !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_PROOFS_V1
    || record.realIssuerImplemented || record.runtimeNetworkModuleImported || record.livePersistenceImplemented
    || record.runtimeWired || record.clearsCustodyOrHandoffBlocker || record.grantsApproval
    || record.grantsQualificationAuthority || record.grantsCandidateAuthority || record.grantsActivationAuthority
    || record.grantsNetworkAuthority || record.grantsCommandAuthority || record.grantsLeaseAuthority
    || record.grantsExecutionAuthority) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerResultV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerResultV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, resultRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_result");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerResultV1;
  const captured = exactHostDataSnapshotV1(record, [
    "resultVersion", "resultReference", "policyReference", "contractDigest", "evidenceClass", "requiredBindings",
    "requiredMarkers", "failureClasses", "requiredProofs", "bindingsVerified", "attemptClaimed", "locatorSpent",
    "custodySpent", "effectUncertaintyMarked", "nativeServerCreated", "nativeServerRetained",
    "sameResourceIdentityVerified", "continuousCustodyVerified", "adapterAcceptedExactResource",
    "ownershipTransferred", "terminalCloseVerified", "independentZeroResourceEvidencePresent",
    "terminalTombstoneRecorded", "externalCheckpointRecorded", "realIssuerImplemented",
    "driverReservationHandoffGapPresent", "exclusivePortCustodyMissing", "clearsCustodyOrHandoffBlocker",
    "candidateEligible", "activationEligible", "actualHostObservations", "actualPortSelections",
    "actualPortReservations", "actualNativeResourcesCreated", "actualNativeResourcesRetained",
    "actualCapabilitiesIssued", "actualCapabilitiesSpent", "actualDriverAcceptCalls",
    "actualNativeBackendConstructions", "actualListenerAttempts", "actualIpcListenerAttempts", "actualSocketAttempts",
    "actualTimerCreations", "actualNetworkIoEvents", "actualProtectedValuesRead", "actualPersistenceWrites",
    "runtimeWired", "externalEffectOccurred", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "resultDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, resultDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.resultDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerRepositoryFakeV1
    || record.policyReference !== connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1.policyReference
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1.contractDigest
    || record.requiredBindings !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_BINDINGS_V1
    || record.requiredMarkers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_MARKERS_V1
    || record.failureClasses !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_FAILURES_V1
    || record.requiredProofs !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_PROOFS_V1
    || record.evidenceClass !== "repository_fake" || !record.driverReservationHandoffGapPresent
    || !record.exclusivePortCustodyMissing || record.bindingsVerified || record.attemptClaimed || record.locatorSpent
    || record.custodySpent || record.effectUncertaintyMarked || record.nativeServerCreated || record.nativeServerRetained
    || record.sameResourceIdentityVerified || record.continuousCustodyVerified || record.adapterAcceptedExactResource
    || record.ownershipTransferred || record.terminalCloseVerified || record.independentZeroResourceEvidencePresent
    || record.terminalTombstoneRecorded || record.externalCheckpointRecorded || record.realIssuerImplemented
    || record.clearsCustodyOrHandoffBlocker || record.candidateEligible || record.activationEligible
    || record.actualHostObservations !== 0 || record.actualPortSelections !== 0 || record.actualPortReservations !== 0
    || record.actualNativeResourcesCreated !== 0 || record.actualNativeResourcesRetained !== 0
    || record.actualCapabilitiesIssued !== 0 || record.actualCapabilitiesSpent !== 0 || record.actualDriverAcceptCalls !== 0
    || record.actualNativeBackendConstructions !== 0 || record.actualListenerAttempts !== 0
    || record.actualIpcListenerAttempts !== 0 || record.actualSocketAttempts !== 0 || record.actualTimerCreations !== 0
    || record.actualNetworkIoEvents !== 0 || record.actualProtectedValuesRead !== 0 || record.actualPersistenceWrites !== 0
    || record.runtimeWired || record.externalEffectOccurred || record.grantsApproval
    || record.grantsQualificationAuthority || record.grantsCandidateAuthority || record.grantsActivationAuthority
    || record.grantsNetworkAuthority || record.grantsCommandAuthority || record.grantsLeaseAuthority
    || record.grantsExecutionAuthority) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerErrorV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerContractV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerResultV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerErrorV1.prototype);
