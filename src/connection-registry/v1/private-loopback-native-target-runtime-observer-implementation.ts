import {
  arch as observeOsArchitectureV1,
  platform as observeOsPlatformV1,
  release as observeOsReleaseV1,
  uptime as observeOsUptimeV1,
} from "node:os";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";

const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const objectEntriesV1 = Object.entries;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_IMPLEMENTATION_V1 =
  "control-room-connection-enrollment-private-loopback-native-target-runtime-observer-implementation/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-native-target-runtime-observer-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_CAPTURED_OPERATIONS_V1 =
  objectFreezeV1([
    "node:os.platform",
    "node:os.arch",
    "node:os.release",
    "node:os.uptime",
    "process.version",
    "process.execPath",
    "process.pid",
    "process.ppid",
  ] as const);

export type ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1 = Readonly<{
  implementationVersion:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_IMPLEMENTATION_V1;
  implementationReference: string;
  live280ProductCommit: "c1743b7f7b5c8362cec3d33b149e3f51c5e5fda6";
  acceptedLive280RereviewSha256: "bd8281cf4e0336eba7f55de2b8cde9e39e9305860a2a8287e3dcf74af52d7853";
  capturedOperations:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_CAPTURED_OPERATIONS_V1;
  intendedPlatformFamily: "macos";
  intendedRuntimeFamily: "node";
  observerSourcePresent: true;
  observerPrivate: true;
  observerStoredOnce: true;
  observerExported: false;
  observerRetrievable: false;
  observerInvoked: false;
  observerAcceptsCallerInput: false;
  rawObservationExported: false;
  rawObservationSerialized: false;
  rawObservationLogged: false;
  rawObservationPersisted: false;
  rawObservationDigested: false;
  attestationImplemented: false;
  signerImplemented: false;
  trustedClockImplemented: false;
  nonceImplemented: false;
  replayCheckpointImplemented: false;
  candidateBindingImplemented: false;
  ownerAuthorizationPresent: false;
  targetRuntimeBlockerCleared: false;
  physicalQualificationAccepted: false;
  runtimeWired: false;
  candidateEligible: false;
  activationEligible: false;
  repositorySourceOnly: true;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  implementationDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_STATUS_V1;
  implementationReference: string;
  implementationDigest: string;
  evidenceClass: "repository_static_non_execution";
  observerState: "stored_unreachable_uninvoked";
  observationState: "not_observed";
  attestationState: "not_created";
  candidateState: "not_assembled";
  runtimeState: "not_wired";
  actualObserverLookups: 0;
  actualObserverInvocations: 0;
  actualOsPlatformCalls: 0;
  actualOsArchitectureCalls: 0;
  actualOsReleaseCalls: 0;
  actualOsUptimeCalls: 0;
  actualProcessVersionReads: 0;
  actualProcessExecPathReads: 0;
  actualProcessIdReads: 0;
  actualParentProcessIdReads: 0;
  actualHostObservations: 0;
  actualEnvironmentReads: 0;
  actualRawObservationReturns: 0;
  actualRawObservationExports: 0;
  actualAttestationsCreated: 0;
  actualSignerCalls: 0;
  actualCheckpointWrites: 0;
  actualPersistenceWrites: 0;
  actualNativeListenerAttempts: 0;
  actualTimerCreations: 0;
  actualNetworkIoEvents: 0;
  actualProtectedValuesRead: 0;
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

export class ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1 extends Error {
  readonly safeCode: "invalid_implementation" | "invalid_status" | "observer_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_implementation" || code === "invalid_status" || code === "observer_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

type PrivateNativeTargetRuntimeObservationV1 = Readonly<{
  platform: string;
  architecture: string;
  release: string;
  uptimeSeconds: number;
  runtimeVersion: string;
  executablePath: string;
  processIdentifier: number;
  parentProcessIdentifier: number;
}>;
type PrivateNativeTargetRuntimeObserverV1 = () => PrivateNativeTargetRuntimeObservationV1;

const implementationRecordsV1 = new WeakSet<object>();
const implementationDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();
const quarantinedNativeTargetRuntimeObserversV1 = new WeakMap<object, PrivateNativeTargetRuntimeObserverV1>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "native target runtime observer record"); }
  catch { failV1("integrity_failed"); }
}

/*
 * LIVE-290 stores this real observer source without any lookup operation. Creating the function reads no host or
 * process value. Invoking it would be a native observation and remains outside this block.
 */
function createQuarantinedNativeTargetRuntimeObserverV1(): PrivateNativeTargetRuntimeObserverV1 {
  const privateNativeTargetRuntimeObserverV1 = (): PrivateNativeTargetRuntimeObservationV1 => objectFreezeV1({
    platform: reflectApplyV1(observeOsPlatformV1, undefined, []) as string,
    architecture: reflectApplyV1(observeOsArchitectureV1, undefined, []) as string,
    release: reflectApplyV1(observeOsReleaseV1, undefined, []) as string,
    uptimeSeconds: reflectApplyV1(observeOsUptimeV1, undefined, []) as number,
    runtimeVersion: process.version,
    executablePath: process.execPath,
    processIdentifier: process.pid,
    parentProcessIdentifier: process.ppid,
  });
  return objectFreezeV1(privateNativeTargetRuntimeObserverV1);
}

const implementationSeedV1 = sha256Digest({
  live280ProductCommit: "c1743b7f7b5c8362cec3d33b149e3f51c5e5fda6",
  acceptedLive280RereviewSha256: "bd8281cf4e0336eba7f55de2b8cde9e39e9305860a2a8287e3dcf74af52d7853",
  capturedOperations: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_CAPTURED_OPERATIONS_V1,
  intendedPlatformFamily: "macos",
  intendedRuntimeFamily: "node",
});

const implementationMaterialV1 = {
  implementationVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_IMPLEMENTATION_V1,
  implementationReference: `native-target-runtime-observer:${reflectApplyV1(stringSliceV1,
    implementationSeedV1, [7, 31])}`,
  live280ProductCommit: "c1743b7f7b5c8362cec3d33b149e3f51c5e5fda6" as const,
  acceptedLive280RereviewSha256: "bd8281cf4e0336eba7f55de2b8cde9e39e9305860a2a8287e3dcf74af52d7853" as const,
  capturedOperations: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_CAPTURED_OPERATIONS_V1,
  intendedPlatformFamily: "macos" as const,
  intendedRuntimeFamily: "node" as const,
  observerSourcePresent: true as const,
  observerPrivate: true as const,
  observerStoredOnce: true as const,
  observerExported: false as const,
  observerRetrievable: false as const,
  observerInvoked: false as const,
  observerAcceptsCallerInput: false as const,
  rawObservationExported: false as const,
  rawObservationSerialized: false as const,
  rawObservationLogged: false as const,
  rawObservationPersisted: false as const,
  rawObservationDigested: false as const,
  attestationImplemented: false as const,
  signerImplemented: false as const,
  trustedClockImplemented: false as const,
  nonceImplemented: false as const,
  replayCheckpointImplemented: false as const,
  candidateBindingImplemented: false as const,
  ownerAuthorizationPresent: false as const,
  targetRuntimeBlockerCleared: false as const,
  physicalQualificationAccepted: false as const,
  runtimeWired: false as const,
  candidateEligible: false as const,
  activationEligible: false as const,
  repositorySourceOnly: true as const,
  grantsApproval: false as const,
  grantsQualificationAuthority: false as const,
  grantsCandidateAuthority: false as const,
  grantsActivationAuthority: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(implementationMaterialV1);
export const connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1 = objectFreezeV1({
  ...implementationMaterialV1,
  implementationDigest: sha256Digest(implementationMaterialV1),
});
reflectApplyV1(weakSetAddV1, implementationRecordsV1,
  [connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1]);
reflectApplyV1(weakMapSetV1, implementationDigestsV1,
  [connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1,
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1.implementationDigest]);
reflectApplyV1(weakMapSetV1, quarantinedNativeTargetRuntimeObserversV1,
  [connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1,
    createQuarantinedNativeTargetRuntimeObserverV1()]);

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_STATUS_V1,
  implementationReference:
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1.implementationReference,
  implementationDigest:
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1.implementationDigest,
  evidenceClass: "repository_static_non_execution" as const,
  observerState: "stored_unreachable_uninvoked" as const,
  observationState: "not_observed" as const,
  attestationState: "not_created" as const,
  candidateState: "not_assembled" as const,
  runtimeState: "not_wired" as const,
  actualObserverLookups: 0 as const,
  actualObserverInvocations: 0 as const,
  actualOsPlatformCalls: 0 as const,
  actualOsArchitectureCalls: 0 as const,
  actualOsReleaseCalls: 0 as const,
  actualOsUptimeCalls: 0 as const,
  actualProcessVersionReads: 0 as const,
  actualProcessExecPathReads: 0 as const,
  actualProcessIdReads: 0 as const,
  actualParentProcessIdReads: 0 as const,
  actualHostObservations: 0 as const,
  actualEnvironmentReads: 0 as const,
  actualRawObservationReturns: 0 as const,
  actualRawObservationExports: 0 as const,
  actualAttestationsCreated: 0 as const,
  actualSignerCalls: 0 as const,
  actualCheckpointWrites: 0 as const,
  actualPersistenceWrites: 0 as const,
  actualNativeListenerAttempts: 0 as const,
  actualTimerCreations: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualProtectedValuesRead: 0 as const,
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
export const connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1,
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, implementationRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_implementation");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1;
  const captured = exactHostDataSnapshotV1(record, [
    "implementationVersion", "implementationReference", "live280ProductCommit", "acceptedLive280RereviewSha256",
    "capturedOperations", "intendedPlatformFamily", "intendedRuntimeFamily", "observerSourcePresent",
    "observerPrivate", "observerStoredOnce", "observerExported", "observerRetrievable", "observerInvoked",
    "observerAcceptsCallerInput", "rawObservationExported", "rawObservationSerialized", "rawObservationLogged",
    "rawObservationPersisted", "rawObservationDigested", "attestationImplemented", "signerImplemented",
    "trustedClockImplemented", "nonceImplemented", "replayCheckpointImplemented", "candidateBindingImplemented",
    "ownerAuthorizationPresent", "targetRuntimeBlockerCleared", "physicalQualificationAccepted", "runtimeWired",
    "candidateEligible", "activationEligible", "repositorySourceOnly", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "implementationDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, implementationDigestsV1, [record]) as string | undefined;
  if (!captured || digest !== record.implementationDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1
    || record.capturedOperations !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_OBSERVER_CAPTURED_OPERATIONS_V1
    || !record.observerSourcePresent || !record.observerPrivate || !record.observerStoredOnce
    || record.observerExported || record.observerRetrievable || record.observerInvoked
    || record.observerAcceptsCallerInput || record.rawObservationExported || record.rawObservationSerialized
    || record.rawObservationLogged || record.rawObservationPersisted || record.rawObservationDigested
    || record.attestationImplemented || record.signerImplemented || record.trustedClockImplemented
    || record.nonceImplemented || record.replayCheckpointImplemented || record.candidateBindingImplemented
    || record.ownerAuthorizationPresent || record.targetRuntimeBlockerCleared || record.physicalQualificationAccepted
    || record.runtimeWired || record.candidateEligible || record.activationEligible || !record.repositorySourceOnly) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "implementationReference", "implementationDigest", "evidenceClass", "observerState",
    "observationState", "attestationState", "candidateState", "runtimeState", "actualObserverLookups",
    "actualObserverInvocations", "actualOsPlatformCalls", "actualOsArchitectureCalls", "actualOsReleaseCalls",
    "actualOsUptimeCalls", "actualProcessVersionReads", "actualProcessExecPathReads", "actualProcessIdReads",
    "actualParentProcessIdReads", "actualHostObservations", "actualEnvironmentReads", "actualRawObservationReturns",
    "actualRawObservationExports", "actualAttestationsCreated", "actualSignerCalls", "actualCheckpointWrites",
    "actualPersistenceWrites", "actualNativeListenerAttempts", "actualTimerCreations", "actualNetworkIoEvents",
    "actualProtectedValuesRead", "externalEffectOccurred", "targetRuntimeBlockerCleared",
    "physicalQualificationAccepted", "runtimeWired", "candidateEligible", "activationEligible", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const entries = captured
    ? reflectApplyV1(objectEntriesV1, undefined, [captured]) as Array<[string, unknown]> : [];
  const actualValues = entries.filter(([key]) => key.startsWith("actual")).map(([, entry]) => entry);
  const grantValues = entries.filter(([key]) => key.startsWith("grants")).map(([, entry]) => entry);
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1
    || actualValues.length !== 22 || actualValues.some((entry) => entry !== 0)
    || grantValues.length !== 8 || grantValues.some((entry) => entry !== false)
    || record.externalEffectOccurred || record.targetRuntimeBlockerCleared || record.physicalQualificationAccepted
    || record.runtimeWired || record.candidateEligible || record.activationEligible) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverImplementationV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeObserverStatusV1);
