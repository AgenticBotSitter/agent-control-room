import {
  arch as observeOsArchitectureV1,
  platform as observeOsPlatformV1,
  release as observeOsReleaseV1,
  uptime as observeOsUptimeV1,
} from "node:os";
import * as nativeProcessNamespaceV1 from "node:process";
import type { DatabaseClient } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { exactHostDataSnapshotV1, exactHostErrorCodeV1, isHostProxyV1 } from "../../security/host-value";
import {
  connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
  parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
} from "./private-loopback-atomic-source-lookup-bridge-contract";
import {
  ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1,
  ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1,
  type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationConsumptionV1,
  type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRecheckV1,
} from "./private-loopback-invocation-authorization-store";

const arraySomeV1 = Array.prototype.some;
const arrayIncludesV1 = Array.prototype.includes;
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

const consumeForInvocationV1 =
  ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype.consumeForInvocation;
const recheckAfterConsumptionV1 =
  ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype.recheckAfterConsumption;
const storeErrorPrototypeV1 = ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1.prototype;

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
  atomicSourceRetrievable: true;
  retrievalGuardedByPrivateSpendRecheck: true;
  lookupBridgeBarrelExported: false;
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
  evidenceClass: "repository_private_lookup_ready_non_native_execution";
  sourceState: "stored_private_lookup_guarded_uninvoked";
  lookupBridgeState: "implemented_unwired";
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
const privateAtomicNativeObservationSourceRecordsV1 = new WeakSet<object>();

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
  atomicSourceRetrievable: true as const,
  retrievalGuardedByPrivateSpendRecheck: true as const,
  lookupBridgeBarrelExported: false as const,
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
const quarantinedAtomicNativeObservationSourceV1 = createQuarantinedAtomicNativeObservationSourceV1();
reflectApplyV1(weakSetAddV1, privateAtomicNativeObservationSourceRecordsV1,
  [quarantinedAtomicNativeObservationSourceV1]);
reflectApplyV1(weakMapSetV1, quarantinedAtomicNativeObservationSourcesV1,
  [connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1,
    quarantinedAtomicNativeObservationSourceV1]);

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
  evidenceClass: "repository_private_lookup_ready_non_native_execution" as const,
  sourceState: "stored_private_lookup_guarded_uninvoked" as const,
  lookupBridgeState: "implemented_unwired" as const,
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
    "atomicSourceExported", "atomicSourceRetrievable", "retrievalGuardedByPrivateSpendRecheck",
    "lookupBridgeBarrelExported", "atomicSourceInvoked",
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
    || !record.atomicSourceRetrievable || !record.retrievalGuardedByPrivateSpendRecheck
    || record.lookupBridgeBarrelExported || record.atomicSourceInvoked || !record.descriptorValidationSourcePresent
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
    "lookupBridgeState", "nativeBindingState", "descriptorState", "observationState", "attestationState", "candidateState",
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
    || record.evidenceClass !== "repository_private_lookup_ready_non_native_execution"
    || record.sourceState !== "stored_private_lookup_guarded_uninvoked"
    || record.lookupBridgeState !== "implemented_unwired"
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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_IMPLEMENTATION_V1 =
  "control-room-connection-enrollment-private-loopback-atomic-source-lookup-composition-implementation/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-atomic-source-lookup-composition-status/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_RESULT_V1 =
  "control-room-connection-enrollment-private-loopback-atomic-source-lookup-composition-result/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_TERMINAL_OUTCOMES_V1 =
  objectFreezeV1([
    "rejected_before_spend",
    "terminal_spend_uncertain",
    "terminal_already_consumed",
    "terminal_recheck_failed",
    "terminal_source_lookup_failed",
    "completed_lookup_and_stopped_before_invocation",
  ] as const);

export type ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionTerminalOutcomeV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_TERMINAL_OUTCOMES_V1[number];

export type ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1 = Readonly<{
  implementationVersion:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_IMPLEMENTATION_V1;
  implementationReference: string;
  live410ProductCommit: "e4d58ff35a44e66454cae8e778b31362902dab6b";
  acceptedLive410ReviewSha256: "c3f79f0ad2634a2bcbb0abd39eeb21c1b54154e1389a020b0839343f3ffb0bbf";
  terminalOutcomes:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_TERMINAL_OUTCOMES_V1;
  maximumSpendCallsPerFlow: 1;
  maximumRecheckCallsPerFlow: 1;
  maximumSourceLookupsPerFlow: 1;
  maximumSourceInvocationsPerFlow: 0;
  sameSourceOwningModule: true;
  exactStoreConstructedInsideFactory: true;
  exactStoreMethodsCaptured: true;
  sameSealedAuthorizationValueRequired: true;
  exactFreshReceiptPrivatelyForwarded: true;
  exactModuleOwnedSourceRequired: true;
  sourceFunctionRemainsPrivate: true;
  receiptsAcceptedFromCaller: false;
  receiptsReturnedToCaller: false;
  sourceAcceptedFromCaller: false;
  sourceReturnedToCaller: false;
  callbackAccepted: false;
  automaticRetryImplemented: false;
  replacementAuthorizationImplemented: false;
  fallbackImplemented: false;
  sourceLookupImplemented: true;
  sourceInvocationImplemented: false;
  implementationBarrelExported: false;
  runtimeWired: false;
  productionDatabaseConfigured: false;
  externalEffectOccurred: false;
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

export type ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_STATUS_V1;
  implementationReference: string;
  implementationDigest: string;
  evidenceClass: "repository_implementation_unwired_non_native_execution";
  compositionState: "implemented_unwired";
  sourceState: "stored_private_lookup_guarded_uninvoked";
  runtimeState: "not_wired";
  actualFactoryCalls: 0;
  actualCompositionCalls: 0;
  actualAuthorizationConsumptions: 0;
  actualPostTransactionRechecks: 0;
  actualReceiptInputs: 0;
  actualReceiptExports: 0;
  actualRetryAttempts: 0;
  actualReplacementAuthorizations: 0;
  actualFallbackAttempts: 0;
  actualSourceLookups: 0;
  actualSourceInvocations: 0;
  actualNativeReads: 0;
  actualRawObservationReturns: 0;
  actualAttestationsCreated: 0;
  actualCandidateAssemblerEntries: 0;
  actualOwnerAuthorizationSpends: 0;
  actualPhysicalAttempts: 0;
  actualNativeListenerAttempts: 0;
  actualNetworkIoEvents: 0;
  actualProviderCalls: 0;
  actualProtectedValuesRead: 0;
  actualCommandsExecuted: 0;
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

export type ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1 = Readonly<{
  resultVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_RESULT_V1;
  implementationReference: string;
  implementationDigest: string;
  outcome: ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionTerminalOutcomeV1;
  spendState: "not_spent" | "spent" | "unknown_or_spent";
  spendCalls: 1;
  recheckCalls: 0 | 1;
  sourceLookupCalls: 0 | 1;
  postTransactionTimeRechecked: boolean;
  sourceLookupPerformed: boolean;
  terminal: true;
  retryAllowedByResult: false;
  receiptExported: false;
  sourceExported: false;
  sourceInvocationPerformed: false;
  nativeReadPerformed: false;
  rawObservationCreated: false;
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

export interface ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionRunnerV1 {
  run(sealedAuthorization: unknown):
    Promise<ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1>;
}

export class ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionErrorV1 extends Error {
  readonly safeCode: "invalid_implementation" | "invalid_status" | "invalid_result" | "invalid_factory_input"
    | "integrity_failed";

  constructor(code: unknown) {
    const allowed = ["invalid_implementation", "invalid_status", "invalid_result", "invalid_factory_input",
      "integrity_failed"] as const;
    const safeCode = typeof code === "string" && reflectApplyV1(arrayIncludesV1, allowed, [code])
      ? code as ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionErrorV1["safeCode"]
      : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const lookupImplementationRecordsV1 = new WeakSet<object>();
const lookupImplementationDigestsV1 = new WeakMap<object, string>();
const lookupStatusRecordsV1 = new WeakSet<object>();
const lookupStatusDigestsV1 = new WeakMap<object, string>();
const lookupResultRecordsV1 = new WeakSet<object>();
const lookupResultDigestsV1 = new WeakMap<object, string>();

function failLookupCompositionV1(
  code: ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionErrorV1["safeCode"],
): never {
  throw new ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionErrorV1(code);
}

function safeLookupPublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "atomic source lookup composition record"); }
  catch { failLookupCompositionV1("integrity_failed"); }
}

const lookupImplementationSeedV1 = sha256Digest({
  live410ProductCommit: "e4d58ff35a44e66454cae8e778b31362902dab6b",
  acceptedLive410ReviewSha256: "c3f79f0ad2634a2bcbb0abd39eeb21c1b54154e1389a020b0839343f3ffb0bbf",
  terminalOutcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_TERMINAL_OUTCOMES_V1,
  sourceImplementationReference:
    connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1.implementationReference,
  sourceImplementationDigest:
    connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1.implementationDigest,
});

const lookupImplementationMaterialV1 = {
  implementationVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_IMPLEMENTATION_V1,
  implementationReference: `atomic-source-lookup-composition:${reflectApplyV1(stringSliceV1,
    lookupImplementationSeedV1, [7, 31])}`,
  live410ProductCommit: "e4d58ff35a44e66454cae8e778b31362902dab6b" as const,
  acceptedLive410ReviewSha256:
    "c3f79f0ad2634a2bcbb0abd39eeb21c1b54154e1389a020b0839343f3ffb0bbf" as const,
  terminalOutcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_TERMINAL_OUTCOMES_V1,
  maximumSpendCallsPerFlow: 1 as const,
  maximumRecheckCallsPerFlow: 1 as const,
  maximumSourceLookupsPerFlow: 1 as const,
  maximumSourceInvocationsPerFlow: 0 as const,
  sameSourceOwningModule: true as const,
  exactStoreConstructedInsideFactory: true as const,
  exactStoreMethodsCaptured: true as const,
  sameSealedAuthorizationValueRequired: true as const,
  exactFreshReceiptPrivatelyForwarded: true as const,
  exactModuleOwnedSourceRequired: true as const,
  sourceFunctionRemainsPrivate: true as const,
  receiptsAcceptedFromCaller: false as const,
  receiptsReturnedToCaller: false as const,
  sourceAcceptedFromCaller: false as const,
  sourceReturnedToCaller: false as const,
  callbackAccepted: false as const,
  automaticRetryImplemented: false as const,
  replacementAuthorizationImplemented: false as const,
  fallbackImplemented: false as const,
  sourceLookupImplemented: true as const,
  sourceInvocationImplemented: false as const,
  implementationBarrelExported: false as const,
  runtimeWired: false as const,
  productionDatabaseConfigured: false as const,
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

safeLookupPublicRecordV1(lookupImplementationMaterialV1);
export const connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1 = objectFreezeV1({
  ...lookupImplementationMaterialV1,
  implementationDigest: sha256Digest(lookupImplementationMaterialV1),
});
reflectApplyV1(weakSetAddV1, lookupImplementationRecordsV1,
  [connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1]);
reflectApplyV1(weakMapSetV1, lookupImplementationDigestsV1,
  [connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1,
    connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1.implementationDigest]);

const lookupZeroActualsV1 = {
  actualFactoryCalls: 0 as const,
  actualCompositionCalls: 0 as const,
  actualAuthorizationConsumptions: 0 as const,
  actualPostTransactionRechecks: 0 as const,
  actualReceiptInputs: 0 as const,
  actualReceiptExports: 0 as const,
  actualRetryAttempts: 0 as const,
  actualReplacementAuthorizations: 0 as const,
  actualFallbackAttempts: 0 as const,
  actualSourceLookups: 0 as const,
  actualSourceInvocations: 0 as const,
  actualNativeReads: 0 as const,
  actualRawObservationReturns: 0 as const,
  actualAttestationsCreated: 0 as const,
  actualCandidateAssemblerEntries: 0 as const,
  actualOwnerAuthorizationSpends: 0 as const,
  actualPhysicalAttempts: 0 as const,
  actualNativeListenerAttempts: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualProviderCalls: 0 as const,
  actualProtectedValuesRead: 0 as const,
  actualCommandsExecuted: 0 as const,
};

const lookupStatusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_STATUS_V1,
  implementationReference:
    connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1.implementationReference,
  implementationDigest:
    connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1.implementationDigest,
  evidenceClass: "repository_implementation_unwired_non_native_execution" as const,
  compositionState: "implemented_unwired" as const,
  sourceState: "stored_private_lookup_guarded_uninvoked" as const,
  runtimeState: "not_wired" as const,
  ...lookupZeroActualsV1,
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

safeLookupPublicRecordV1(lookupStatusMaterialV1);
export const connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1 = objectFreezeV1({
  ...lookupStatusMaterialV1,
  statusDigest: sha256Digest(lookupStatusMaterialV1),
});
reflectApplyV1(weakSetAddV1, lookupStatusRecordsV1,
  [connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1]);
reflectApplyV1(weakMapSetV1, lookupStatusDigestsV1,
  [connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1,
    connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1.statusDigest]);

function buildLookupResultV1(
  outcome: ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionTerminalOutcomeV1,
): ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1 {
  const spendState = outcome === "rejected_before_spend" ? "not_spent" as const
    : outcome === "terminal_spend_uncertain" ? "unknown_or_spent" as const : "spent" as const;
  const recheckCalls = outcome === "terminal_recheck_failed"
    || outcome === "terminal_source_lookup_failed"
    || outcome === "completed_lookup_and_stopped_before_invocation" ? 1 as const : 0 as const;
  const sourceLookupCalls = outcome === "terminal_source_lookup_failed"
    || outcome === "completed_lookup_and_stopped_before_invocation" ? 1 as const : 0 as const;
  const postTransactionTimeRechecked = outcome === "terminal_source_lookup_failed"
    || outcome === "completed_lookup_and_stopped_before_invocation";
  const sourceLookupPerformed = outcome === "completed_lookup_and_stopped_before_invocation";
  const material = {
    resultVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_RESULT_V1,
    implementationReference:
      connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1.implementationReference,
    implementationDigest:
      connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1.implementationDigest,
    outcome,
    spendState,
    spendCalls: 1 as const,
    recheckCalls,
    sourceLookupCalls,
    postTransactionTimeRechecked,
    sourceLookupPerformed,
    terminal: true as const,
    retryAllowedByResult: false as const,
    receiptExported: false as const,
    sourceExported: false as const,
    sourceInvocationPerformed: false as const,
    nativeReadPerformed: false as const,
    rawObservationCreated: false as const,
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
  safeLookupPublicRecordV1(material);
  const result = objectFreezeV1({ ...material, resultDigest: sha256Digest(material) });
  reflectApplyV1(weakSetAddV1, lookupResultRecordsV1, [result]);
  reflectApplyV1(weakMapSetV1, lookupResultDigestsV1, [result, result.resultDigest]);
  return result;
}

async function runPrivateAtomicSourceLookupCompositionV1(
  store: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1,
  sealedAuthorization: unknown,
): Promise<ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1> {
  try {
    if (parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1(
      connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
    ) !== connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1) {
      return buildLookupResultV1("rejected_before_spend");
    }
  } catch {
    return buildLookupResultV1("rejected_before_spend");
  }

  let freshReceipt: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationConsumptionV1 | undefined;
  let recheckReceipt: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRecheckV1 | undefined;
  let privateSource: PrivateAtomicNativeObservationSourceV1 | undefined;
  try {
    try {
      freshReceipt = await reflectApplyV1(consumeForInvocationV1, store, [sealedAuthorization]) as
        ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationConsumptionV1;
    } catch (error) {
      const code = exactHostErrorCodeV1(error, storeErrorPrototypeV1, "safeCode");
      return buildLookupResultV1(code === "terminal_ambiguity" || code === undefined
        ? "terminal_spend_uncertain" : "rejected_before_spend");
    }

    if (freshReceipt.freshConsumption !== true
      || freshReceipt.state !== "consumed_pending_post_transaction_time_recheck") {
      return buildLookupResultV1("terminal_already_consumed");
    }

    try {
      recheckReceipt = await reflectApplyV1(recheckAfterConsumptionV1, store,
        [sealedAuthorization, freshReceipt]) as ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRecheckV1;
    } catch {
      return buildLookupResultV1("terminal_recheck_failed");
    }

    if (recheckReceipt.state !== "consumed_and_post_transaction_time_rechecked"
      || recheckReceipt.postTransactionTimeRechecked !== true
      || recheckReceipt.sourceLookupPerformed !== false
      || recheckReceipt.sourceInvocationPerformed !== false
      || recheckReceipt.nativeReadPerformed !== false) {
      return buildLookupResultV1("terminal_recheck_failed");
    }

    privateSource = reflectApplyV1(weakMapGetV1, quarantinedAtomicNativeObservationSourcesV1,
      [connectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1]) as
        PrivateAtomicNativeObservationSourceV1 | undefined;
    if (typeof privateSource !== "function" || !objectIsFrozenV1(privateSource)
      || privateSource !== quarantinedAtomicNativeObservationSourceV1
      || reflectApplyV1(weakSetHasV1, privateAtomicNativeObservationSourceRecordsV1, [privateSource]) !== true) {
      return buildLookupResultV1("terminal_source_lookup_failed");
    }

    return buildLookupResultV1("completed_lookup_and_stopped_before_invocation");
  } finally {
    freshReceipt = undefined;
    recheckReceipt = undefined;
    privateSource = undefined;
  }
}

export const createConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionV1 = objectFreezeV1((
  database: DatabaseClient,
  protectedKeys: unknown,
): ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionRunnerV1 => {
  let store: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1;
  try {
    store = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(database, protectedKeys);
  } catch {
    failLookupCompositionV1("invalid_factory_input");
  }
  const run = objectFreezeV1((sealedAuthorization: unknown) =>
    runPrivateAtomicSourceLookupCompositionV1(store, sealedAuthorization));
  return objectFreezeV1({ run });
});

export function parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, lookupImplementationRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failLookupCompositionV1("invalid_implementation");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1;
  const captured = exactHostDataSnapshotV1(record, [
    "implementationVersion", "implementationReference", "live410ProductCommit", "acceptedLive410ReviewSha256",
    "terminalOutcomes", "maximumSpendCallsPerFlow", "maximumRecheckCallsPerFlow",
    "maximumSourceLookupsPerFlow", "maximumSourceInvocationsPerFlow", "sameSourceOwningModule",
    "exactStoreConstructedInsideFactory", "exactStoreMethodsCaptured", "sameSealedAuthorizationValueRequired",
    "exactFreshReceiptPrivatelyForwarded", "exactModuleOwnedSourceRequired", "sourceFunctionRemainsPrivate",
    "receiptsAcceptedFromCaller", "receiptsReturnedToCaller", "sourceAcceptedFromCaller",
    "sourceReturnedToCaller", "callbackAccepted", "automaticRetryImplemented",
    "replacementAuthorizationImplemented", "fallbackImplemented", "sourceLookupImplemented",
    "sourceInvocationImplemented", "implementationBarrelExported", "runtimeWired",
    "productionDatabaseConfigured", "externalEffectOccurred", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "implementationDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, lookupImplementationDigestsV1, [record]) as string | undefined;
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.implementationDigest
    || record !== connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1
    || record.live410ProductCommit !== "e4d58ff35a44e66454cae8e778b31362902dab6b"
    || record.acceptedLive410ReviewSha256 !==
      "c3f79f0ad2634a2bcbb0abd39eeb21c1b54154e1389a020b0839343f3ffb0bbf"
    || record.terminalOutcomes !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_TERMINAL_OUTCOMES_V1
    || record.maximumSpendCallsPerFlow !== 1 || record.maximumRecheckCallsPerFlow !== 1
    || record.maximumSourceLookupsPerFlow !== 1 || record.maximumSourceInvocationsPerFlow !== 0
    || !record.sameSourceOwningModule || !record.exactStoreConstructedInsideFactory
    || !record.exactStoreMethodsCaptured || !record.sameSealedAuthorizationValueRequired
    || !record.exactFreshReceiptPrivatelyForwarded || !record.exactModuleOwnedSourceRequired
    || !record.sourceFunctionRemainsPrivate || record.receiptsAcceptedFromCaller || record.receiptsReturnedToCaller
    || record.sourceAcceptedFromCaller || record.sourceReturnedToCaller || record.callbackAccepted
    || record.automaticRetryImplemented || record.replacementAuthorizationImplemented || record.fallbackImplemented
    || !record.sourceLookupImplemented || record.sourceInvocationImplemented || record.implementationBarrelExported
    || record.runtimeWired || record.productionDatabaseConfigured || record.externalEffectOccurred
    || grants.length !== 8 || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])) {
    failLookupCompositionV1("integrity_failed");
  }
  safeLookupPublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, lookupStatusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failLookupCompositionV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "implementationReference", "implementationDigest", "evidenceClass", "compositionState",
    "sourceState", "runtimeState", "actualFactoryCalls", "actualCompositionCalls",
    "actualAuthorizationConsumptions", "actualPostTransactionRechecks", "actualReceiptInputs",
    "actualReceiptExports", "actualRetryAttempts", "actualReplacementAuthorizations", "actualFallbackAttempts",
    "actualSourceLookups", "actualSourceInvocations", "actualNativeReads", "actualRawObservationReturns",
    "actualAttestationsCreated", "actualCandidateAssemblerEntries", "actualOwnerAuthorizationSpends",
    "actualPhysicalAttempts", "actualNativeListenerAttempts", "actualNetworkIoEvents", "actualProviderCalls",
    "actualProtectedValuesRead", "actualCommandsExecuted", "externalEffectOccurred", "sourceBoundaryCrossed",
    "targetRuntimeBlockerCleared", "physicalQualificationAccepted", "runtimeWired", "candidateEligible",
    "activationEligible", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, lookupStatusDigestsV1, [record]) as string | undefined;
  const actuals = [record.actualFactoryCalls, record.actualCompositionCalls, record.actualAuthorizationConsumptions,
    record.actualPostTransactionRechecks, record.actualReceiptInputs, record.actualReceiptExports,
    record.actualRetryAttempts, record.actualReplacementAuthorizations, record.actualFallbackAttempts,
    record.actualSourceLookups, record.actualSourceInvocations, record.actualNativeReads,
    record.actualRawObservationReturns, record.actualAttestationsCreated, record.actualCandidateAssemblerEntries,
    record.actualOwnerAuthorizationSpends, record.actualPhysicalAttempts, record.actualNativeListenerAttempts,
    record.actualNetworkIoEvents, record.actualProviderCalls, record.actualProtectedValuesRead,
    record.actualCommandsExecuted];
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1
    || record.implementationReference !==
      connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1.implementationReference
    || record.implementationDigest !==
      connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1.implementationDigest
    || record.evidenceClass !== "repository_implementation_unwired_non_native_execution"
    || record.compositionState !== "implemented_unwired"
    || record.sourceState !== "stored_private_lookup_guarded_uninvoked" || record.runtimeState !== "not_wired"
    || actuals.length !== 22 || reflectApplyV1(arraySomeV1, actuals, [(entry: number) => entry !== 0])
    || grants.length !== 8 || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])
    || record.externalEffectOccurred || record.sourceBoundaryCrossed || record.targetRuntimeBlockerCleared
    || record.physicalQualificationAccepted || record.runtimeWired || record.candidateEligible
    || record.activationEligible) failLookupCompositionV1("integrity_failed");
  safeLookupPublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, lookupResultRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failLookupCompositionV1("invalid_result");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1;
  const captured = exactHostDataSnapshotV1(record, [
    "resultVersion", "implementationReference", "implementationDigest", "outcome", "spendState", "spendCalls",
    "recheckCalls", "sourceLookupCalls", "postTransactionTimeRechecked", "sourceLookupPerformed", "terminal",
    "retryAllowedByResult", "receiptExported", "sourceExported", "sourceInvocationPerformed",
    "nativeReadPerformed", "rawObservationCreated", "externalEffectOccurred", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "resultDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, lookupResultDigestsV1, [record]) as string | undefined;
  const expectedSpendState = record.outcome === "rejected_before_spend" ? "not_spent"
    : record.outcome === "terminal_spend_uncertain" ? "unknown_or_spent" : "spent";
  const expectedRecheckCalls = record.outcome === "terminal_recheck_failed"
    || record.outcome === "terminal_source_lookup_failed"
    || record.outcome === "completed_lookup_and_stopped_before_invocation" ? 1 : 0;
  const expectedLookupCalls = record.outcome === "terminal_source_lookup_failed"
    || record.outcome === "completed_lookup_and_stopped_before_invocation" ? 1 : 0;
  const expectedRechecked = record.outcome === "terminal_source_lookup_failed"
    || record.outcome === "completed_lookup_and_stopped_before_invocation";
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.resultDigest
    || record.resultVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_RESULT_V1
    || record.implementationReference !==
      connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1.implementationReference
    || record.implementationDigest !==
      connectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1.implementationDigest
    || !reflectApplyV1(arrayIncludesV1,
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_COMPOSITION_TERMINAL_OUTCOMES_V1,
      [record.outcome])
    || record.spendState !== expectedSpendState || record.spendCalls !== 1
    || record.recheckCalls !== expectedRecheckCalls || record.sourceLookupCalls !== expectedLookupCalls
    || record.postTransactionTimeRechecked !== expectedRechecked
    || record.sourceLookupPerformed !== (record.outcome === "completed_lookup_and_stopped_before_invocation")
    || record.terminal !== true || record.retryAllowedByResult !== false || record.receiptExported !== false
    || record.sourceExported !== false || record.sourceInvocationPerformed !== false
    || record.nativeReadPerformed !== false || record.rawObservationCreated !== false
    || record.externalEffectOccurred !== false
    || grants.length !== 8 || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])) {
    failLookupCompositionV1("integrity_failed");
  }
  safeLookupPublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackUnreachableAtomicNativeObservationSourceStatusV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionImplementationV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionStatusV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupCompositionResultV1);
