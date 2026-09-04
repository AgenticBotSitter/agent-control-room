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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-retained-resource-handoff-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_RESULT_V1 =
  "control-room-connection-enrollment-private-loopback-retained-resource-handoff-result/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_PROOFS_V1 = objectFreezeV1([
  "accepted_exclusive_port_custody_contract_reference",
  "same_retained_resource_private_identity",
  "module_private_handoff_brand_and_issuer_epoch",
  "qualification_candidate_attempt_reservation_handoff_scope",
  "one_use_unspent_handoff_state",
  "pre_handoff_continuous_custody_observation",
  "atomic_driver_acceptance_and_owner_transition",
  "driver_listener_configuration_identity",
  "post_handoff_same_resource_observation",
  "failure_or_uncertainty_terminal_close",
  "independent_zero_resource_observation",
  "durable_spend_close_tombstone_chain",
] as const);

export type ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_CONTRACT_V1;
  policyReference: string;
  live160ProductCommit: "97d46c74e413d21c1f81c9704b9eb0b66447be5c";
  acceptedLive160ReviewSha256: "0a0837acbd36ba9292e8b3f37b57d4900290aa03c54c3c13c73413aebd8345a6";
  resourceClass: "retained_ipv4_loopback_tcp_listener";
  transferMode: "same_retained_resource_atomic_one_use";
  handoffSurface: "module_private_non_serializable";
  locatorExposure: "none";
  ownershipTransition: "custody_provider_to_physical_driver";
  maximumFutureHandoffs: 1;
  driverMayBindNewResource: false;
  custodyMayCloseBeforeDriverAcceptance: false;
  retryRebindReopenAllowed: false;
  requiredPrivateProofs: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_PROOFS_V1;
  acceptedPhysicalDriverHandoffPortImplemented: false;
  driverReservationHandoffGapPresent: true;
  realHandoffPortImplemented: false;
  realHandoffCapabilityImplemented: false;
  clearsExclusivePortCustodyBlocker: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  contractDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1 = Readonly<{
  resultVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_RESULT_V1;
  resultReference: string;
  policyReference: string;
  contractDigest: string;
  evidenceClass: "repository_fake";
  resourceClass: "retained_ipv4_loopback_tcp_listener";
  transferMode: "same_retained_resource_atomic_one_use";
  requiredPrivateProofs: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_PROOFS_V1;
  acceptedPhysicalDriverHandoffPortImplemented: false;
  driverReservationHandoffGapPresent: true;
  exclusivePortCustodyProvided: false;
  handoffPortPresent: false;
  privateHandoffAccepted: false;
  sameResourceIdentityVerified: false;
  continuousCustodyVerified: false;
  oneUseStateVerified: false;
  atomicOwnershipTransitionObserved: false;
  driverAcceptedRetainedResource: false;
  driverCreatedReplacementResource: false;
  locatorExposed: false;
  preAcceptanceCloseObserved: false;
  retryRebindReopenObserved: false;
  terminalCloseObserved: false;
  independentZeroResourceObservationPresent: false;
  durableTombstoneRecorded: false;
  exclusivePortCustodyAccepted: false;
  exclusivePortCustodyMissing: true;
  clearsExclusivePortCustodyBlocker: false;
  activationEligible: false;
  hostObservationAttempts: 0;
  portSelectionsMade: 0;
  portReservationsMade: 0;
  nativeResourcesCreated: 0;
  nativeResourcesRetained: 0;
  handoffCapabilitiesIssued: 0;
  handoffCapabilitiesSpent: 0;
  driverHandoffCalls: 0;
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

export class ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_result" | "integrity_failed";
  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_result" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const resultRecordsV1 = new WeakSet<object>();
const resultDigestsV1 = new WeakMap<object, string>();

function failV1(code: "invalid_contract" | "invalid_result" | "integrity_failed"): never {
  throw new ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "retained resource handoff record"); }
  catch { failV1("integrity_failed"); }
}

const policySeedV1 = sha256Digest({
  live160ProductCommit: "97d46c74e413d21c1f81c9704b9eb0b66447be5c",
  acceptedLive160ReviewSha256: "0a0837acbd36ba9292e8b3f37b57d4900290aa03c54c3c13c73413aebd8345a6",
  resourceClass: "retained_ipv4_loopback_tcp_listener",
  requiredPrivateProofs: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_PROOFS_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_CONTRACT_V1,
  policyReference: `retained-resource-handoff-policy:${reflectApplyV1(stringSliceV1, policySeedV1, [7, 31])}`,
  live160ProductCommit: "97d46c74e413d21c1f81c9704b9eb0b66447be5c" as const,
  acceptedLive160ReviewSha256: "0a0837acbd36ba9292e8b3f37b57d4900290aa03c54c3c13c73413aebd8345a6" as const,
  resourceClass: "retained_ipv4_loopback_tcp_listener" as const,
  transferMode: "same_retained_resource_atomic_one_use" as const,
  handoffSurface: "module_private_non_serializable" as const,
  locatorExposure: "none" as const,
  ownershipTransition: "custody_provider_to_physical_driver" as const,
  maximumFutureHandoffs: 1 as const,
  driverMayBindNewResource: false as const,
  custodyMayCloseBeforeDriverAcceptance: false as const,
  retryRebindReopenAllowed: false as const,
  requiredPrivateProofs: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_PROOFS_V1,
  acceptedPhysicalDriverHandoffPortImplemented: false as const,
  driverReservationHandoffGapPresent: true as const,
  realHandoffPortImplemented: false as const,
  realHandoffCapabilityImplemented: false as const,
  clearsExclusivePortCustodyBlocker: false as const,
  grantsApproval: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(contractMaterialV1);
export const connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1;
reflectApplyV1(weakSetAddV1, contractRecordsV1,
  [connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1,
  [connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1,
    connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1.contractDigest]);

const resultMaterialV1 = {
  resultVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_RESULT_V1,
  resultReference: `retained-resource-handoff-fake:${reflectApplyV1(stringSliceV1,
    connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1.contractDigest, [7, 31])}`,
  policyReference: connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1.policyReference,
  contractDigest: connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1.contractDigest,
  evidenceClass: "repository_fake" as const,
  resourceClass: "retained_ipv4_loopback_tcp_listener" as const,
  transferMode: "same_retained_resource_atomic_one_use" as const,
  requiredPrivateProofs: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_PROOFS_V1,
  acceptedPhysicalDriverHandoffPortImplemented: false as const,
  driverReservationHandoffGapPresent: true as const,
  exclusivePortCustodyProvided: false as const,
  handoffPortPresent: false as const,
  privateHandoffAccepted: false as const,
  sameResourceIdentityVerified: false as const,
  continuousCustodyVerified: false as const,
  oneUseStateVerified: false as const,
  atomicOwnershipTransitionObserved: false as const,
  driverAcceptedRetainedResource: false as const,
  driverCreatedReplacementResource: false as const,
  locatorExposed: false as const,
  preAcceptanceCloseObserved: false as const,
  retryRebindReopenObserved: false as const,
  terminalCloseObserved: false as const,
  independentZeroResourceObservationPresent: false as const,
  durableTombstoneRecorded: false as const,
  exclusivePortCustodyAccepted: false as const,
  exclusivePortCustodyMissing: true as const,
  clearsExclusivePortCustodyBlocker: false as const,
  activationEligible: false as const,
  hostObservationAttempts: 0 as const,
  portSelectionsMade: 0 as const,
  portReservationsMade: 0 as const,
  nativeResourcesCreated: 0 as const,
  nativeResourcesRetained: 0 as const,
  handoffCapabilitiesIssued: 0 as const,
  handoffCapabilitiesSpent: 0 as const,
  driverHandoffCalls: 0 as const,
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
export const connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1 = objectFreezeV1({
  ...resultMaterialV1,
  resultDigest: sha256Digest(resultMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1;
reflectApplyV1(weakSetAddV1, resultRecordsV1,
  [connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1]);
reflectApplyV1(weakMapSetV1, resultDigestsV1,
  [connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1,
    connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1.resultDigest]);

export function parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "policyReference", "live160ProductCommit", "acceptedLive160ReviewSha256", "resourceClass",
    "transferMode", "handoffSurface", "locatorExposure", "ownershipTransition", "maximumFutureHandoffs",
    "driverMayBindNewResource", "custodyMayCloseBeforeDriverAcceptance", "retryRebindReopenAllowed",
    "requiredPrivateProofs", "acceptedPhysicalDriverHandoffPortImplemented", "driverReservationHandoffGapPresent",
    "realHandoffPortImplemented", "realHandoffCapabilityImplemented", "clearsExclusivePortCustodyBlocker",
    "grantsApproval", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "contractDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1
    || record.requiredPrivateProofs !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_PROOFS_V1
    || record.acceptedPhysicalDriverHandoffPortImplemented || !record.driverReservationHandoffGapPresent
    || record.realHandoffPortImplemented || record.realHandoffCapabilityImplemented
    || record.clearsExclusivePortCustodyBlocker || record.grantsApproval || record.grantsNetworkAuthority
    || record.grantsCommandAuthority || record.grantsLeaseAuthority || record.grantsExecutionAuthority) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, resultRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_result");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1;
  const captured = exactHostDataSnapshotV1(record, [
    "resultVersion", "resultReference", "policyReference", "contractDigest", "evidenceClass", "resourceClass",
    "transferMode", "requiredPrivateProofs", "acceptedPhysicalDriverHandoffPortImplemented",
    "driverReservationHandoffGapPresent", "exclusivePortCustodyProvided", "handoffPortPresent",
    "privateHandoffAccepted", "sameResourceIdentityVerified", "continuousCustodyVerified", "oneUseStateVerified",
    "atomicOwnershipTransitionObserved", "driverAcceptedRetainedResource", "driverCreatedReplacementResource",
    "locatorExposed", "preAcceptanceCloseObserved", "retryRebindReopenObserved", "terminalCloseObserved",
    "independentZeroResourceObservationPresent", "durableTombstoneRecorded", "exclusivePortCustodyAccepted",
    "exclusivePortCustodyMissing", "clearsExclusivePortCustodyBlocker", "activationEligible",
    "hostObservationAttempts", "portSelectionsMade", "portReservationsMade", "nativeResourcesCreated",
    "nativeResourcesRetained", "handoffCapabilitiesIssued", "handoffCapabilitiesSpent", "driverHandoffCalls",
    "nativeBackendConstructions", "listenerAttemptsMade", "ipcListenerAttemptsMade", "socketAttemptsMade",
    "timerCreations", "networkIoEventsObserved", "protectedValuesRead", "externalEffectOccurred", "runtimeWired",
    "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "resultDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, resultDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.resultDigest
    || record !== connectionEnrollmentPrivateLoopbackRetainedResourceHandoffRepositoryFakeV1
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1.contractDigest
    || record.policyReference !== connectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1.policyReference
    || record.requiredPrivateProofs !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_HANDOFF_PROOFS_V1
    || record.evidenceClass !== "repository_fake" || record.acceptedPhysicalDriverHandoffPortImplemented
    || !record.driverReservationHandoffGapPresent || record.exclusivePortCustodyAccepted
    || !record.exclusivePortCustodyMissing || record.clearsExclusivePortCustodyBlocker
    || record.externalEffectOccurred || record.runtimeWired || record.hostObservationAttempts !== 0
    || record.portSelectionsMade !== 0 || record.portReservationsMade !== 0 || record.nativeResourcesCreated !== 0
    || record.nativeResourcesRetained !== 0 || record.handoffCapabilitiesIssued !== 0
    || record.handoffCapabilitiesSpent !== 0 || record.driverHandoffCalls !== 0
    || record.nativeBackendConstructions !== 0 || record.listenerAttemptsMade !== 0
    || record.ipcListenerAttemptsMade !== 0 || record.socketAttemptsMade !== 0 || record.timerCreations !== 0
    || record.networkIoEventsObserved !== 0 || record.protectedValuesRead !== 0) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffErrorV1,
  parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffContractV1,
  parseConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffResultV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackRetainedResourceHandoffErrorV1.prototype);
