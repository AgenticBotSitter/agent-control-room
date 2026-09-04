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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-exclusive-port-custody-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_RESULT_V1 =
  "control-room-connection-enrollment-private-loopback-exclusive-port-custody-result/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_PROOFS_V1 = objectFreezeV1([
  "accepted_target_runtime_attestation_reference",
  "accepted_private_locator_broker_reference",
  "custody_provider_implementation_and_epoch",
  "qualification_candidate_and_attempt_identity",
  "literal_private_ipv4_loopback_and_selected_port",
  "retained_native_listener_reservation_identity",
  "exclusive_bind_and_no_reuse_observation",
  "durable_pre_effect_reservation_marker",
  "independent_high_water_checkpoint",
  "trusted_observed_expiry_time_and_nonce",
  "one_use_handoff_capability_and_compatible_driver_identity",
  "independent_native_resource_observations",
  "terminal_close_spend_and_tombstone_identity",
] as const);

export type ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_CONTRACT_V1;
  policyReference: string;
  live150ProductCommit: "f089f896073fcc5aab24616a17fac592eba5146b";
  acceptedLive150ReviewSha256: "e7047c506fad1f969563d3bb1ae31df28083761b2470bc322a91c4aa733abd67";
  resourceClass: "retained_ipv4_loopback_tcp_listener";
  exclusivityBasis: "same_native_resource_continuously_held";
  selectionMode: "operating_system_selected_private_port";
  ownershipScope: "single_target_locator_candidate_attempt_epoch_reservation_handoff";
  maximumFuturePreHandoffCustodyLifetimeSeconds: 30;
  maximumFutureHandoffs: 1;
  retryRebindReopenAllowed: false;
  sameNativeResourceTransferRequired: true;
  requiredPrivateProofs: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_PROOFS_V1;
  acceptedPhysicalDriverSupportsReservationHandoff: false;
  driverReservationHandoffGapPresent: true;
  realCustodyProviderImplemented: false;
  realHandoffCapabilityImplemented: false;
  clearsExclusivePortCustodyBlocker: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  contractDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1 = Readonly<{
  resultVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_RESULT_V1;
  resultReference: string;
  policyReference: string;
  contractDigest: string;
  evidenceClass: "repository_fake";
  resourceClass: "retained_ipv4_loopback_tcp_listener";
  requiredPrivateProofs: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_PROOFS_V1;
  acceptedPhysicalDriverSupportsReservationHandoff: false;
  driverReservationHandoffGapPresent: true;
  targetRuntimeAttestationProvided: false;
  privateLocatorBrokerProvided: false;
  custodyProviderPresent: false;
  operatingSystemPortSelected: false;
  nativeReservationCreated: false;
  nativeResourceRetained: false;
  exclusiveBindObserved: false;
  noReuseObserved: false;
  preEffectMarkerCommitted: false;
  independentCheckpointPresent: false;
  handoffCapabilityIssued: false;
  sameNativeResourceTransferred: false;
  independentResourceObservationPresent: false;
  terminalCloseObserved: false;
  terminalTombstoneRecorded: false;
  exclusivePortCustodyAccepted: false;
  exclusivePortCustodyMissing: true;
  clearsExclusivePortCustodyBlocker: false;
  activationEligible: false;
  hostObservationAttempts: 0;
  portSelectionsMade: 0;
  portReservationsMade: 0;
  nativeResourcesRetained: 0;
  handoffCapabilitiesIssued: 0;
  handoffCapabilitiesSpent: 0;
  nativeBackendConstructions: 0;
  listenerAttemptsMade: 0;
  ipcListenerAttemptsMade: 0;
  socketAttemptsMade: 0;
  timerCreations: 0;
  networkIoEventsObserved: 0;
  protectedValuesRead: 0;
  externalEffectOccurred: false;
  runtimeWired: false;
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

export class ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_result" | "integrity_failed";
  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_result" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const resultRecordsV1 = new WeakSet<object>();
const resultDigestsV1 = new WeakMap<object, string>();

function failV1(code: "invalid_contract" | "invalid_result" | "integrity_failed"): never {
  throw new ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "exclusive port custody record"); }
  catch { failV1("integrity_failed"); }
}

const policySeedV1 = sha256Digest({
  live150ProductCommit: "f089f896073fcc5aab24616a17fac592eba5146b",
  acceptedLive150ReviewSha256: "e7047c506fad1f969563d3bb1ae31df28083761b2470bc322a91c4aa733abd67",
  resourceClass: "retained_ipv4_loopback_tcp_listener",
  requiredPrivateProofs: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_PROOFS_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_CONTRACT_V1,
  policyReference: `exclusive-port-policy:${reflectApplyV1(stringSliceV1, policySeedV1, [7, 31])}`,
  live150ProductCommit: "f089f896073fcc5aab24616a17fac592eba5146b" as const,
  acceptedLive150ReviewSha256: "e7047c506fad1f969563d3bb1ae31df28083761b2470bc322a91c4aa733abd67" as const,
  resourceClass: "retained_ipv4_loopback_tcp_listener" as const,
  exclusivityBasis: "same_native_resource_continuously_held" as const,
  selectionMode: "operating_system_selected_private_port" as const,
  ownershipScope: "single_target_locator_candidate_attempt_epoch_reservation_handoff" as const,
  maximumFuturePreHandoffCustodyLifetimeSeconds: 30 as const,
  maximumFutureHandoffs: 1 as const,
  retryRebindReopenAllowed: false as const,
  sameNativeResourceTransferRequired: true as const,
  requiredPrivateProofs: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_PROOFS_V1,
  acceptedPhysicalDriverSupportsReservationHandoff: false as const,
  driverReservationHandoffGapPresent: true as const,
  realCustodyProviderImplemented: false as const,
  realHandoffCapabilityImplemented: false as const,
  clearsExclusivePortCustodyBlocker: false as const,
  grantsApproval: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(contractMaterialV1);
export const connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1;
reflectApplyV1(weakSetAddV1, contractRecordsV1, [connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1, [connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1,
  connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1.contractDigest]);

const resultMaterialV1 = {
  resultVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_RESULT_V1,
  resultReference: `exclusive-port-fake:${reflectApplyV1(stringSliceV1,
    connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1.contractDigest, [7, 31])}`,
  policyReference: connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1.policyReference,
  contractDigest: connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1.contractDigest,
  evidenceClass: "repository_fake" as const,
  resourceClass: "retained_ipv4_loopback_tcp_listener" as const,
  requiredPrivateProofs: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_PROOFS_V1,
  acceptedPhysicalDriverSupportsReservationHandoff: false as const,
  driverReservationHandoffGapPresent: true as const,
  targetRuntimeAttestationProvided: false as const,
  privateLocatorBrokerProvided: false as const,
  custodyProviderPresent: false as const,
  operatingSystemPortSelected: false as const,
  nativeReservationCreated: false as const,
  nativeResourceRetained: false as const,
  exclusiveBindObserved: false as const,
  noReuseObserved: false as const,
  preEffectMarkerCommitted: false as const,
  independentCheckpointPresent: false as const,
  handoffCapabilityIssued: false as const,
  sameNativeResourceTransferred: false as const,
  independentResourceObservationPresent: false as const,
  terminalCloseObserved: false as const,
  terminalTombstoneRecorded: false as const,
  exclusivePortCustodyAccepted: false as const,
  exclusivePortCustodyMissing: true as const,
  clearsExclusivePortCustodyBlocker: false as const,
  activationEligible: false as const,
  hostObservationAttempts: 0 as const,
  portSelectionsMade: 0 as const,
  portReservationsMade: 0 as const,
  nativeResourcesRetained: 0 as const,
  handoffCapabilitiesIssued: 0 as const,
  handoffCapabilitiesSpent: 0 as const,
  nativeBackendConstructions: 0 as const,
  listenerAttemptsMade: 0 as const,
  ipcListenerAttemptsMade: 0 as const,
  socketAttemptsMade: 0 as const,
  timerCreations: 0 as const,
  networkIoEventsObserved: 0 as const,
  protectedValuesRead: 0 as const,
  externalEffectOccurred: false as const,
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

safePublicRecordV1(resultMaterialV1);
export const connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1 = objectFreezeV1({
  ...resultMaterialV1,
  resultDigest: sha256Digest(resultMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1;
reflectApplyV1(weakSetAddV1, resultRecordsV1, [connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1]);
reflectApplyV1(weakMapSetV1, resultDigestsV1, [connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1,
  connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1.resultDigest]);

export function parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "policyReference", "live150ProductCommit", "acceptedLive150ReviewSha256", "resourceClass",
    "exclusivityBasis", "selectionMode", "ownershipScope", "maximumFuturePreHandoffCustodyLifetimeSeconds",
    "maximumFutureHandoffs", "retryRebindReopenAllowed", "sameNativeResourceTransferRequired",
    "requiredPrivateProofs", "acceptedPhysicalDriverSupportsReservationHandoff", "driverReservationHandoffGapPresent",
    "realCustodyProviderImplemented", "realHandoffCapabilityImplemented", "clearsExclusivePortCustodyBlocker",
    "grantsApproval", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "contractDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1
    || record.requiredPrivateProofs !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_PROOFS_V1
    || record.acceptedPhysicalDriverSupportsReservationHandoff || !record.driverReservationHandoffGapPresent
    || record.realCustodyProviderImplemented || record.realHandoffCapabilityImplemented
    || record.clearsExclusivePortCustodyBlocker || record.grantsApproval || record.grantsNetworkAuthority
    || record.grantsCommandAuthority || record.grantsLeaseAuthority || record.grantsExecutionAuthority) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, resultRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_result");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1;
  const captured = exactHostDataSnapshotV1(record, [
    "resultVersion", "resultReference", "policyReference", "contractDigest", "evidenceClass", "resourceClass",
    "requiredPrivateProofs", "acceptedPhysicalDriverSupportsReservationHandoff", "driverReservationHandoffGapPresent",
    "targetRuntimeAttestationProvided", "privateLocatorBrokerProvided", "custodyProviderPresent",
    "operatingSystemPortSelected", "nativeReservationCreated", "nativeResourceRetained", "exclusiveBindObserved",
    "noReuseObserved", "preEffectMarkerCommitted", "independentCheckpointPresent", "handoffCapabilityIssued",
    "sameNativeResourceTransferred", "independentResourceObservationPresent", "terminalCloseObserved",
    "terminalTombstoneRecorded", "exclusivePortCustodyAccepted", "exclusivePortCustodyMissing",
    "clearsExclusivePortCustodyBlocker", "activationEligible", "hostObservationAttempts", "portSelectionsMade",
    "portReservationsMade", "nativeResourcesRetained", "handoffCapabilitiesIssued", "handoffCapabilitiesSpent",
    "nativeBackendConstructions", "listenerAttemptsMade", "ipcListenerAttemptsMade", "socketAttemptsMade",
    "timerCreations", "networkIoEventsObserved", "protectedValuesRead", "externalEffectOccurred", "runtimeWired",
    "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "resultDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, resultDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.resultDigest
    || record !== connectionEnrollmentPrivateLoopbackExclusivePortCustodyRepositoryFakeV1
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1.contractDigest
    || record.policyReference !== connectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1.policyReference
    || record.requiredPrivateProofs !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_EXCLUSIVE_PORT_CUSTODY_PROOFS_V1
    || record.evidenceClass !== "repository_fake" || record.acceptedPhysicalDriverSupportsReservationHandoff
    || !record.driverReservationHandoffGapPresent || record.exclusivePortCustodyAccepted
    || !record.exclusivePortCustodyMissing || record.clearsExclusivePortCustodyBlocker
    || record.externalEffectOccurred || record.runtimeWired || record.hostObservationAttempts !== 0
    || record.portSelectionsMade !== 0 || record.portReservationsMade !== 0 || record.nativeResourcesRetained !== 0
    || record.handoffCapabilitiesIssued !== 0 || record.handoffCapabilitiesSpent !== 0
    || record.nativeBackendConstructions !== 0 || record.listenerAttemptsMade !== 0
    || record.ipcListenerAttemptsMade !== 0 || record.socketAttemptsMade !== 0 || record.timerCreations !== 0
    || record.networkIoEventsObserved !== 0 || record.protectedValuesRead !== 0) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyErrorV1,
  parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyContractV1,
  parseConnectionEnrollmentPrivateLoopbackExclusivePortCustodyResultV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackExclusivePortCustodyErrorV1.prototype);
