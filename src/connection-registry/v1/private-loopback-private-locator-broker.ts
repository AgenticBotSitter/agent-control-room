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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-locator-broker-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RESULT_V1 =
  "control-room-connection-enrollment-private-loopback-locator-broker-result/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_PRIVATE_BINDINGS_V1 = objectFreezeV1([
  "accepted_target_runtime_attestation_reference",
  "broker_boot_process_session_epoch",
  "broker_implementation_and_policy_identity",
  "qualification_candidate_identity",
  "qualification_attempt_identity",
  "observed_literal_ipv4_loopback_address",
  "selected_private_port_and_reservation_handle",
  "exclusive_reservation_proof",
  "independent_resource_observation_reference",
  "fresh_one_use_nonce",
  "trusted_issue_and_expiry_time",
  "durable_issuance_marker",
  "independent_high_water_checkpoint",
  "one_use_capability_and_terminal_tombstone_identity",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RETAINED_BLOCKERS_V1 = objectFreezeV1([
  "private_locator_broker_missing",
  "exclusive_port_custody_missing",
] as const);

export type ConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_CONTRACT_V1;
  policyReference: string;
  live140ProductCommit: "6e716bd77c26ad7f70343ddd687dff990f5db12f";
  acceptedLive140ReviewSha256: "483ab05695b5cecaa6fe02ca4cc63b2e640733ac42270e2a435364c6be0ea6d8";
  locatorClass: "private_ipv4_loopback";
  transportClass: "private_tcp_qualification_listener";
  publicationMode: "private_never_public_or_serialized";
  capabilityScope: "single_target_candidate_attempt_epoch_reservation_spend";
  maximumFutureCapabilityLifetimeSeconds: 30;
  maximumFutureCapabilitySpends: 1;
  automaticRetryAllowed: false;
  terminalTombstoneRequired: true;
  requiredPrivateBindings: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_PRIVATE_BINDINGS_V1;
  retainedBlockers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RETAINED_BLOCKERS_V1;
  publicLocatorMaterialAllowed: false;
  realBrokerImplemented: false;
  realCapabilityImplemented: false;
  clearsPrivateLocatorBrokerBlocker: false;
  clearsExclusivePortCustodyBlocker: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  contractDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1 = Readonly<{
  resultVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RESULT_V1;
  resultReference: string;
  policyReference: string;
  contractDigest: string;
  evidenceClass: "repository_fake";
  locatorClass: "private_ipv4_loopback";
  transportClass: "private_tcp_qualification_listener";
  requiredPrivateBindings: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_PRIVATE_BINDINGS_V1;
  retainedBlockers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RETAINED_BLOCKERS_V1;
  targetRuntimeAttestationProvided: false;
  brokerProviderPresent: false;
  addressObserved: false;
  interfaceEnumerated: false;
  dnsResolved: false;
  portSelected: false;
  exclusivePortReserved: false;
  locatorMaterialPresent: false;
  locatorMaterialPublic: false;
  capabilityIssued: false;
  capabilitySpent: false;
  durableIssuanceRecorded: false;
  independentCheckpointPresent: false;
  driverHandoffPerformed: false;
  cleanupEvidencePresent: false;
  privateLocatorBrokerMissing: true;
  exclusivePortCustodyMissing: true;
  clearsPrivateLocatorBrokerBlocker: false;
  clearsExclusivePortCustodyBlocker: false;
  activationEligible: false;
  hostObservationAttempts: 0;
  interfaceEnumerationAttempts: 0;
  dnsResolutionAttempts: 0;
  portSelectionsMade: 0;
  portReservationsMade: 0;
  capabilitiesIssued: 0;
  capabilitySpends: 0;
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

export class ConnectionEnrollmentPrivateLoopbackLocatorBrokerErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_result" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_result" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackLocatorBrokerErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const resultRecordsV1 = new WeakSet<object>();
const resultDigestsV1 = new WeakMap<object, string>();

function failV1(code: "invalid_contract" | "invalid_result" | "integrity_failed"): never {
  throw new ConnectionEnrollmentPrivateLoopbackLocatorBrokerErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "private locator broker record"); }
  catch { failV1("integrity_failed"); }
}

const policySeedV1 = sha256Digest({
  live140ProductCommit: "6e716bd77c26ad7f70343ddd687dff990f5db12f",
  acceptedLive140ReviewSha256: "483ab05695b5cecaa6fe02ca4cc63b2e640733ac42270e2a435364c6be0ea6d8",
  locatorClass: "private_ipv4_loopback",
  transportClass: "private_tcp_qualification_listener",
  requiredPrivateBindings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_PRIVATE_BINDINGS_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_CONTRACT_V1,
  policyReference: `private-locator-policy:${reflectApplyV1(stringSliceV1, policySeedV1, [7, 31])}`,
  live140ProductCommit: "6e716bd77c26ad7f70343ddd687dff990f5db12f" as const,
  acceptedLive140ReviewSha256: "483ab05695b5cecaa6fe02ca4cc63b2e640733ac42270e2a435364c6be0ea6d8" as const,
  locatorClass: "private_ipv4_loopback" as const,
  transportClass: "private_tcp_qualification_listener" as const,
  publicationMode: "private_never_public_or_serialized" as const,
  capabilityScope: "single_target_candidate_attempt_epoch_reservation_spend" as const,
  maximumFutureCapabilityLifetimeSeconds: 30 as const,
  maximumFutureCapabilitySpends: 1 as const,
  automaticRetryAllowed: false as const,
  terminalTombstoneRequired: true as const,
  requiredPrivateBindings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_PRIVATE_BINDINGS_V1,
  retainedBlockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RETAINED_BLOCKERS_V1,
  publicLocatorMaterialAllowed: false as const,
  realBrokerImplemented: false as const,
  realCapabilityImplemented: false as const,
  clearsPrivateLocatorBrokerBlocker: false as const,
  clearsExclusivePortCustodyBlocker: false as const,
  grantsApproval: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(contractMaterialV1);
export const connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1;
reflectApplyV1(weakSetAddV1, contractRecordsV1, [connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1, [connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1,
  connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1.contractDigest]);

const resultMaterialV1 = {
  resultVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RESULT_V1,
  resultReference: `private-locator-fake:${reflectApplyV1(stringSliceV1,
    connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1.contractDigest, [7, 31])}`,
  policyReference: connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1.policyReference,
  contractDigest: connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1.contractDigest,
  evidenceClass: "repository_fake" as const,
  locatorClass: "private_ipv4_loopback" as const,
  transportClass: "private_tcp_qualification_listener" as const,
  requiredPrivateBindings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_PRIVATE_BINDINGS_V1,
  retainedBlockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RETAINED_BLOCKERS_V1,
  targetRuntimeAttestationProvided: false as const,
  brokerProviderPresent: false as const,
  addressObserved: false as const,
  interfaceEnumerated: false as const,
  dnsResolved: false as const,
  portSelected: false as const,
  exclusivePortReserved: false as const,
  locatorMaterialPresent: false as const,
  locatorMaterialPublic: false as const,
  capabilityIssued: false as const,
  capabilitySpent: false as const,
  durableIssuanceRecorded: false as const,
  independentCheckpointPresent: false as const,
  driverHandoffPerformed: false as const,
  cleanupEvidencePresent: false as const,
  privateLocatorBrokerMissing: true as const,
  exclusivePortCustodyMissing: true as const,
  clearsPrivateLocatorBrokerBlocker: false as const,
  clearsExclusivePortCustodyBlocker: false as const,
  activationEligible: false as const,
  hostObservationAttempts: 0 as const,
  interfaceEnumerationAttempts: 0 as const,
  dnsResolutionAttempts: 0 as const,
  portSelectionsMade: 0 as const,
  portReservationsMade: 0 as const,
  capabilitiesIssued: 0 as const,
  capabilitySpends: 0 as const,
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
export const connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1 = objectFreezeV1({
  ...resultMaterialV1,
  resultDigest: sha256Digest(resultMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1;
reflectApplyV1(weakSetAddV1, resultRecordsV1, [connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1]);
reflectApplyV1(weakMapSetV1, resultDigestsV1, [connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1,
  connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1.resultDigest]);

export function parseConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "policyReference", "live140ProductCommit", "acceptedLive140ReviewSha256", "locatorClass",
    "transportClass", "publicationMode", "capabilityScope", "maximumFutureCapabilityLifetimeSeconds",
    "maximumFutureCapabilitySpends", "automaticRetryAllowed", "terminalTombstoneRequired",
    "requiredPrivateBindings", "retainedBlockers", "publicLocatorMaterialAllowed", "realBrokerImplemented",
    "realCapabilityImplemented", "clearsPrivateLocatorBrokerBlocker", "clearsExclusivePortCustodyBlocker",
    "grantsApproval", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "contractDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1
    || record.requiredPrivateBindings !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_PRIVATE_BINDINGS_V1
    || record.retainedBlockers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RETAINED_BLOCKERS_V1
    || record.publicLocatorMaterialAllowed || record.realBrokerImplemented || record.realCapabilityImplemented
    || record.clearsPrivateLocatorBrokerBlocker || record.clearsExclusivePortCustodyBlocker
    || record.grantsApproval || record.grantsNetworkAuthority || record.grantsCommandAuthority
    || record.grantsLeaseAuthority || record.grantsExecutionAuthority) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, resultRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_result");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1;
  const captured = exactHostDataSnapshotV1(record, [
    "resultVersion", "resultReference", "policyReference", "contractDigest", "evidenceClass", "locatorClass",
    "transportClass", "requiredPrivateBindings", "retainedBlockers", "targetRuntimeAttestationProvided",
    "brokerProviderPresent", "addressObserved", "interfaceEnumerated", "dnsResolved", "portSelected",
    "exclusivePortReserved", "locatorMaterialPresent", "locatorMaterialPublic", "capabilityIssued",
    "capabilitySpent", "durableIssuanceRecorded", "independentCheckpointPresent", "driverHandoffPerformed",
    "cleanupEvidencePresent", "privateLocatorBrokerMissing", "exclusivePortCustodyMissing",
    "clearsPrivateLocatorBrokerBlocker", "clearsExclusivePortCustodyBlocker", "activationEligible",
    "hostObservationAttempts", "interfaceEnumerationAttempts", "dnsResolutionAttempts", "portSelectionsMade",
    "portReservationsMade", "capabilitiesIssued", "capabilitySpends", "nativeBackendConstructions",
    "listenerAttemptsMade", "ipcListenerAttemptsMade", "socketAttemptsMade", "timerCreations",
    "networkIoEventsObserved", "protectedValuesRead", "externalEffectOccurred", "runtimeWired", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "resultDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, resultDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.resultDigest
    || record !== connectionEnrollmentPrivateLoopbackLocatorBrokerRepositoryFakeV1
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1.contractDigest
    || record.policyReference !== connectionEnrollmentPrivateLoopbackLocatorBrokerContractV1.policyReference
    || record.requiredPrivateBindings !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_PRIVATE_BINDINGS_V1
    || record.retainedBlockers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LOCATOR_BROKER_RETAINED_BLOCKERS_V1
    || record.evidenceClass !== "repository_fake" || record.locatorMaterialPublic || record.capabilityIssued
    || record.capabilitySpent || !record.privateLocatorBrokerMissing || !record.exclusivePortCustodyMissing
    || record.clearsPrivateLocatorBrokerBlocker || record.clearsExclusivePortCustodyBlocker
    || record.externalEffectOccurred || record.runtimeWired || record.hostObservationAttempts !== 0
    || record.interfaceEnumerationAttempts !== 0 || record.dnsResolutionAttempts !== 0
    || record.portSelectionsMade !== 0 || record.portReservationsMade !== 0 || record.capabilitiesIssued !== 0
    || record.capabilitySpends !== 0 || record.nativeBackendConstructions !== 0
    || record.listenerAttemptsMade !== 0 || record.ipcListenerAttemptsMade !== 0
    || record.socketAttemptsMade !== 0 || record.timerCreations !== 0 || record.networkIoEventsObserved !== 0
    || record.protectedValuesRead !== 0) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackLocatorBrokerErrorV1,
  parseConnectionEnrollmentPrivateLoopbackLocatorBrokerContractV1,
  parseConnectionEnrollmentPrivateLoopbackLocatorBrokerResultV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackLocatorBrokerErrorV1.prototype);
