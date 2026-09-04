import {
  arch as observeOsArchitectureV1,
  platform as observeOsPlatformV1,
  release as observeOsReleaseV1,
  uptime as observeOsUptimeV1,
} from "node:os";
import * as nativeProcessNamespaceV1 from "node:process";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";

const arraySomeV1 = Array.prototype.some;
const numberIsFiniteV1 = Number.isFinite;
const numberIsSafeIntegerV1 = Number.isSafeInteger;
const objectConstructorV1 = Object;
const objectFreezeV1 = Object.freeze;
const objectGetOwnPropertyDescriptorV1 = Object.getOwnPropertyDescriptor;
const objectIsFrozenV1 = Object.isFrozen;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const stringTrimV1 = String.prototype.trim;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_SOURCE_V1 =
  "control-room-connection-enrollment-private-loopback-unreachable-atomic-native-observation-source/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_SOURCE_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-unreachable-atomic-native-observation-source-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_PROPERTIES_V1 =
  objectFreezeV1(["version", "execPath", "pid", "ppid"] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_OPERATIONS_V1 =
  objectFreezeV1([
    "node:process.version",
    "node:process.execPath",
    "node:process.pid",
    "node:process.ppid",
    "node:os.platform",
    "node:os.arch",
    "node:os.release",
    "node:os.uptime",
  ] as const);

export type ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1 = Readonly<{
  implementationVersion:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_SOURCE_V1;
  implementationReference: string;
  live320ProductCommit: "0c906419652adceb5e771637ae269b52fd1c77cd";
  acceptedLive320ReviewSha256: "da7d247d874d543877c18215ae9e8fbbba7ba838065fe6a9d410772e776799d6";
  validatedProperties:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_PROPERTIES_V1;
  capturedOperations:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_OPERATIONS_V1;
  intendedPlatformFamily: "macos";
  intendedRuntimeFamily: "node";
  staticProcessNamespaceCaptured: true;
  staticOsOperationsCaptured: true;
  atomicSourcePresent: true;
  atomicSourcePrivate: true;
  atomicSourceFrozen: true;
  atomicSourceNoInput: true;
  atomicSourceSynchronous: true;
  atomicSourceStoredOnce: true;
  atomicSourceExported: false;
  atomicSourceRetrievable: false;
  atomicSourceInvoked: false;
  descriptorValidationSourcePresent: true;
  directDescriptorValueConsumptionSourcePresent: true;
  secondNamespaceReadPresent: false;
  ambientGlobalProcessUsed: false;
  callerBindingAccepted: false;
  callerDescriptorAccepted: false;
  callbackAccepted: false;
  promiseOrAwaitPresent: false;
  timerPresent: false;
  automaticRetryPresent: false;
  replacementBindingPresent: false;
  nativeValueRead: false;
  rawObservationCreated: false;
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
  candidateAssemblerImplemented: false;
  ownerAuthorizationPresent: false;
  physicalAttemptPerformed: false;
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

export type ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1 = Readonly<{
  statusVersion:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_SOURCE_STATUS_V1;
  implementationReference: string;
  implementationDigest: string;
  evidenceClass: "repository_static_non_execution";
  sourceState: "stored_unreachable_uninvoked";
  nativeBindingState: "static_sources_captured_unread";
  descriptorState: "not_inspected";
  observationState: "not_created";
  attestationState: "not_created";
  candidateState: "not_assembled";
  runtimeState: "not_wired";
  actualSourceLookups: 0;
  actualSourceInvocations: 0;
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
  actualRawObservationExports: 0;
  actualRawObservationSerializations: 0;
  actualRawObservationLogs: 0;
  actualRawObservationDigests: 0;
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
  actualTimerCreations: 0;
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

export class ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1 extends Error {
  readonly safeCode: "invalid_implementation" | "invalid_status" | "source_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_implementation" || code === "invalid_status" || code === "source_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

type PrivateAtomicNativeObservationV1 = Readonly<{
  platform: string;
  architecture: string;
  release: string;
  uptimeSeconds: number;
  runtimeVersion: string;
  executablePath: string;
  processIdentifier: number;
  parentProcessIdentifier: number;
}>;
type PrivateAtomicNativeObservationSourceV1 = () => PrivateAtomicNativeObservationV1;

const implementationRecordsV1 = new WeakSet<object>();
const implementationDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();
const quarantinedAtomicNativeObservationSourcesV1 =
  new WeakMap<object, PrivateAtomicNativeObservationSourceV1>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1["safeCode"]):
never {
  throw new ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "unreachable atomic native observation source record"); }
  catch { failV1("integrity_failed"); }
}

function hasExactNativeDataShapeV1(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & {
  value: unknown;
  writable: true;
  enumerable: true;
  configurable: false;
} {
  return descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined
    && descriptor.writable === true && descriptor.enumerable === true && descriptor.configurable === false;
}

function nonEmptyStringV1(value: unknown): value is string {
  return typeof value === "string" && reflectApplyV1(stringTrimV1, value, []).length > 0;
}

/*
 * LIVE-330 creates real atomic observation source but stores it without any lookup. Creating this function reads no
 * descriptor or native value. Invocation remains separately gated and does not occur in this block.
 */
function createQuarantinedAtomicNativeObservationSourceV1(): PrivateAtomicNativeObservationSourceV1 {
  const privateAtomicNativeObservationSourceV1 = (): PrivateAtomicNativeObservationV1 => {
    try {
      const versionDescriptor = reflectApplyV1(objectGetOwnPropertyDescriptorV1, objectConstructorV1,
        [nativeProcessNamespaceV1, "version"]) as PropertyDescriptor | undefined;
      const execPathDescriptor = reflectApplyV1(objectGetOwnPropertyDescriptorV1, objectConstructorV1,
        [nativeProcessNamespaceV1, "execPath"]) as PropertyDescriptor | undefined;
      const pidDescriptor = reflectApplyV1(objectGetOwnPropertyDescriptorV1, objectConstructorV1,
        [nativeProcessNamespaceV1, "pid"]) as PropertyDescriptor | undefined;
      const ppidDescriptor = reflectApplyV1(objectGetOwnPropertyDescriptorV1, objectConstructorV1,
        [nativeProcessNamespaceV1, "ppid"]) as PropertyDescriptor | undefined;

      if (!hasExactNativeDataShapeV1(versionDescriptor) || !hasExactNativeDataShapeV1(execPathDescriptor)
        || !hasExactNativeDataShapeV1(pidDescriptor) || !hasExactNativeDataShapeV1(ppidDescriptor)) {
        failV1("integrity_failed");
      }

      const runtimeVersion = versionDescriptor.value;
      const executablePath = execPathDescriptor.value;
      const processIdentifier = pidDescriptor.value;
      const parentProcessIdentifier = ppidDescriptor.value;
      if (!nonEmptyStringV1(runtimeVersion) || !nonEmptyStringV1(executablePath)
        || !numberIsSafeIntegerV1(processIdentifier) || (processIdentifier as number) <= 0
        || !numberIsSafeIntegerV1(parentProcessIdentifier) || (parentProcessIdentifier as number) < 0) {
        failV1("integrity_failed");
      }

      const platform = reflectApplyV1(observeOsPlatformV1, undefined, []) as unknown;
      const architecture = reflectApplyV1(observeOsArchitectureV1, undefined, []) as unknown;
      const release = reflectApplyV1(observeOsReleaseV1, undefined, []) as unknown;
      const uptimeSeconds = reflectApplyV1(observeOsUptimeV1, undefined, []) as unknown;
      if (!nonEmptyStringV1(platform) || !nonEmptyStringV1(architecture) || !nonEmptyStringV1(release)
        || typeof uptimeSeconds !== "number" || !numberIsFiniteV1(uptimeSeconds) || uptimeSeconds < 0) {
        failV1("integrity_failed");
      }

      return objectFreezeV1({
        platform,
        architecture,
        release,
        uptimeSeconds,
        runtimeVersion,
        executablePath,
        processIdentifier,
        parentProcessIdentifier,
      });
    } catch {
      failV1("integrity_failed");
    }
  };
  return objectFreezeV1(privateAtomicNativeObservationSourceV1);
}

const implementationSeedV1 = sha256Digest({
  live320ProductCommit: "0c906419652adceb5e771637ae269b52fd1c77cd",
  acceptedLive320ReviewSha256: "da7d247d874d543877c18215ae9e8fbbba7ba838065fe6a9d410772e776799d6",
  validatedProperties: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_PROPERTIES_V1,
  capturedOperations: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_OPERATIONS_V1,
});

const implementationMaterialV1 = {
  implementationVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_SOURCE_V1,
  implementationReference: `unreachable-atomic-native-observation:${reflectApplyV1(stringSliceV1,
    implementationSeedV1, [7, 31])}`,
  live320ProductCommit: "0c906419652adceb5e771637ae269b52fd1c77cd" as const,
  acceptedLive320ReviewSha256: "da7d247d874d543877c18215ae9e8fbbba7ba838065fe6a9d410772e776799d6" as const,
  validatedProperties: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_PROPERTIES_V1,
  capturedOperations: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_OPERATIONS_V1,
  intendedPlatformFamily: "macos" as const,
  intendedRuntimeFamily: "node" as const,
  staticProcessNamespaceCaptured: true as const,
  staticOsOperationsCaptured: true as const,
  atomicSourcePresent: true as const,
  atomicSourcePrivate: true as const,
  atomicSourceFrozen: true as const,
  atomicSourceNoInput: true as const,
  atomicSourceSynchronous: true as const,
  atomicSourceStoredOnce: true as const,
  atomicSourceExported: false as const,
  atomicSourceRetrievable: false as const,
  atomicSourceInvoked: false as const,
  descriptorValidationSourcePresent: true as const,
  directDescriptorValueConsumptionSourcePresent: true as const,
  secondNamespaceReadPresent: false as const,
  ambientGlobalProcessUsed: false as const,
  callerBindingAccepted: false as const,
  callerDescriptorAccepted: false as const,
  callbackAccepted: false as const,
  promiseOrAwaitPresent: false as const,
  timerPresent: false as const,
  automaticRetryPresent: false as const,
  replacementBindingPresent: false as const,
  nativeValueRead: false as const,
  rawObservationCreated: false as const,
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
  candidateAssemblerImplemented: false as const,
  ownerAuthorizationPresent: false as const,
  physicalAttemptPerformed: false as const,
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
export const connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1 = objectFreezeV1({
  ...implementationMaterialV1,
  implementationDigest: sha256Digest(implementationMaterialV1),
});
reflectApplyV1(weakSetAddV1, implementationRecordsV1,
  [connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1]);
reflectApplyV1(weakMapSetV1, implementationDigestsV1,
  [connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1,
    connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1.implementationDigest]);
reflectApplyV1(weakMapSetV1, quarantinedAtomicNativeObservationSourcesV1,
  [connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1,
    createQuarantinedAtomicNativeObservationSourceV1()]);

const zeroActualsV1 = {
  actualSourceLookups: 0 as const,
  actualSourceInvocations: 0 as const,
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
  actualRawObservationExports: 0 as const,
  actualRawObservationSerializations: 0 as const,
  actualRawObservationLogs: 0 as const,
  actualRawObservationDigests: 0 as const,
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
  actualTimerCreations: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualProviderCalls: 0 as const,
  actualProtectedValuesRead: 0 as const,
  actualCommandsExecuted: 0 as const,
};

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_SOURCE_STATUS_V1,
  implementationReference:
    connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1.implementationReference,
  implementationDigest:
    connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1.implementationDigest,
  evidenceClass: "repository_static_non_execution" as const,
  sourceState: "stored_unreachable_uninvoked" as const,
  nativeBindingState: "static_sources_captured_unread" as const,
  descriptorState: "not_inspected" as const,
  observationState: "not_created" as const,
  attestationState: "not_created" as const,
  candidateState: "not_assembled" as const,
  runtimeState: "not_wired" as const,
  ...zeroActualsV1,
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
export const connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1,
    connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, implementationRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_implementation");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1;
  const captured = exactHostDataSnapshotV1(record, [
    "implementationVersion", "implementationReference", "live320ProductCommit", "acceptedLive320ReviewSha256",
    "validatedProperties", "capturedOperations", "intendedPlatformFamily", "intendedRuntimeFamily",
    "staticProcessNamespaceCaptured", "staticOsOperationsCaptured", "atomicSourcePresent", "atomicSourcePrivate",
    "atomicSourceFrozen", "atomicSourceNoInput", "atomicSourceSynchronous", "atomicSourceStoredOnce",
    "atomicSourceExported", "atomicSourceRetrievable", "atomicSourceInvoked",
    "descriptorValidationSourcePresent", "directDescriptorValueConsumptionSourcePresent",
    "secondNamespaceReadPresent", "ambientGlobalProcessUsed", "callerBindingAccepted", "callerDescriptorAccepted",
    "callbackAccepted", "promiseOrAwaitPresent", "timerPresent", "automaticRetryPresent",
    "replacementBindingPresent", "nativeValueRead", "rawObservationCreated", "rawObservationExported",
    "rawObservationSerialized", "rawObservationLogged", "rawObservationPersisted", "rawObservationDigested",
    "attestationImplemented", "signerImplemented", "trustedClockImplemented", "nonceImplemented",
    "replayCheckpointImplemented", "candidateAssemblerImplemented", "ownerAuthorizationPresent",
    "physicalAttemptPerformed", "targetRuntimeBlockerCleared", "physicalQualificationAccepted", "runtimeWired",
    "candidateEligible", "activationEligible", "repositorySourceOnly", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "implementationDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, implementationDigestsV1, [record]) as string | undefined;
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.implementationDigest
    || record !== connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1
    || record.live320ProductCommit !== "0c906419652adceb5e771637ae269b52fd1c77cd"
    || record.acceptedLive320ReviewSha256 !==
      "da7d247d874d543877c18215ae9e8fbbba7ba838065fe6a9d410772e776799d6"
    || record.validatedProperties !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_PROPERTIES_V1
    || record.capturedOperations !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_UNREACHABLE_ATOMIC_NATIVE_OBSERVATION_OPERATIONS_V1
    || !record.staticProcessNamespaceCaptured || !record.staticOsOperationsCaptured || !record.atomicSourcePresent
    || !record.atomicSourcePrivate || !record.atomicSourceFrozen || !record.atomicSourceNoInput
    || !record.atomicSourceSynchronous || !record.atomicSourceStoredOnce || record.atomicSourceExported
    || record.atomicSourceRetrievable || record.atomicSourceInvoked || !record.descriptorValidationSourcePresent
    || !record.directDescriptorValueConsumptionSourcePresent || record.secondNamespaceReadPresent
    || record.ambientGlobalProcessUsed || record.callerBindingAccepted || record.callerDescriptorAccepted
    || record.callbackAccepted || record.promiseOrAwaitPresent || record.timerPresent || record.automaticRetryPresent
    || record.replacementBindingPresent || record.nativeValueRead || record.rawObservationCreated
    || record.rawObservationExported || record.rawObservationSerialized || record.rawObservationLogged
    || record.rawObservationPersisted || record.rawObservationDigested || record.attestationImplemented
    || record.signerImplemented || record.trustedClockImplemented || record.nonceImplemented
    || record.replayCheckpointImplemented || record.candidateAssemblerImplemented || record.ownerAuthorizationPresent
    || record.physicalAttemptPerformed || record.targetRuntimeBlockerCleared || record.physicalQualificationAccepted
    || record.runtimeWired || record.candidateEligible || record.activationEligible || !record.repositorySourceOnly
    || grants.length !== 8 || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "implementationReference", "implementationDigest", "evidenceClass", "sourceState",
    "nativeBindingState", "descriptorState", "observationState", "attestationState", "candidateState",
    "runtimeState", "actualSourceLookups", "actualSourceInvocations", "actualDescriptorInspections",
    "actualProcessVersionReads", "actualProcessExecPathReads", "actualProcessIdReads",
    "actualParentProcessIdReads", "actualOsPlatformCalls", "actualOsArchitectureCalls", "actualOsReleaseCalls",
    "actualOsUptimeCalls", "actualHostObservations", "actualEnvironmentReads", "actualPathReads",
    "actualRawObservationReturns", "actualRawObservationExports", "actualRawObservationSerializations",
    "actualRawObservationLogs", "actualRawObservationDigests", "actualAttestationsCreated", "actualSignerCalls",
    "actualClockReads", "actualNoncesIssued", "actualCheckpointWrites", "actualPersistenceWrites",
    "actualCandidateAssemblerEntries", "actualOwnerAuthorizationSpends", "actualPhysicalAttempts",
    "actualNativeListenerAttempts", "actualTimerCreations", "actualNetworkIoEvents", "actualProviderCalls",
    "actualProtectedValuesRead", "actualCommandsExecuted", "externalEffectOccurred", "targetRuntimeBlockerCleared",
    "physicalQualificationAccepted", "runtimeWired", "candidateEligible", "activationEligible", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const actuals = [record.actualSourceLookups, record.actualSourceInvocations, record.actualDescriptorInspections,
    record.actualProcessVersionReads, record.actualProcessExecPathReads, record.actualProcessIdReads,
    record.actualParentProcessIdReads, record.actualOsPlatformCalls, record.actualOsArchitectureCalls,
    record.actualOsReleaseCalls, record.actualOsUptimeCalls, record.actualHostObservations,
    record.actualEnvironmentReads, record.actualPathReads, record.actualRawObservationReturns,
    record.actualRawObservationExports, record.actualRawObservationSerializations, record.actualRawObservationLogs,
    record.actualRawObservationDigests, record.actualAttestationsCreated, record.actualSignerCalls,
    record.actualClockReads, record.actualNoncesIssued, record.actualCheckpointWrites, record.actualPersistenceWrites,
    record.actualCandidateAssemblerEntries, record.actualOwnerAuthorizationSpends, record.actualPhysicalAttempts,
    record.actualNativeListenerAttempts, record.actualTimerCreations, record.actualNetworkIoEvents,
    record.actualProviderCalls, record.actualProtectedValuesRead, record.actualCommandsExecuted];
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1
    || record.implementationReference !==
      connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1.implementationReference
    || record.implementationDigest !==
      connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1.implementationDigest
    || record.evidenceClass !== "repository_static_non_execution"
    || record.sourceState !== "stored_unreachable_uninvoked"
    || record.nativeBindingState !== "static_sources_captured_unread" || record.descriptorState !== "not_inspected"
    || record.observationState !== "not_created" || record.attestationState !== "not_created"
    || record.candidateState !== "not_assembled" || record.runtimeState !== "not_wired"
    || actuals.length !== 34 || reflectApplyV1(arraySomeV1, actuals, [(entry: number) => entry !== 0])
    || grants.length !== 8 || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])
    || record.externalEffectOccurred || record.targetRuntimeBlockerCleared || record.physicalQualificationAccepted
    || record.runtimeWired || record.candidateEligible || record.activationEligible) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1);
