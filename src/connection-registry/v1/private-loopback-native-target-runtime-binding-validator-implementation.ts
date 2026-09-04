import * as nativeProcessNamespaceV1 from "node:process";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";

const arrayFilterV1 = Array.prototype.filter;
const arrayMapV1 = Array.prototype.map;
const arraySomeV1 = Array.prototype.some;
const objectConstructorV1 = Object;
const objectFreezeV1 = Object.freeze;
const objectGetOwnPropertyDescriptorV1 = Object.getOwnPropertyDescriptor;
const objectIsFrozenV1 = Object.isFrozen;
const objectEntriesV1 = Object.entries;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const stringStartsWithV1 = String.prototype.startsWith;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_IMPLEMENTATION_V1 =
  "control-room-connection-enrollment-private-loopback-native-target-runtime-binding-validator-implementation/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-native-target-runtime-binding-validator-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_PROPERTIES_V1 =
  objectFreezeV1([
    "node:process.version",
    "node:process.execPath",
    "node:process.pid",
    "node:process.ppid",
  ] as const);

export type ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1 = Readonly<{
  implementationVersion:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_IMPLEMENTATION_V1;
  implementationReference: string;
  live300ProductCommit: "aca7b98405fd12163b74fbc949a6a671d69fe310";
  acceptedLive300ReviewSha256: "86721e47c4c3c743aee97d5c577a1701242f799fdf6063c3dfbcfd3997d1758e";
  validatedProperties:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_PROPERTIES_V1;
  staticNodeProcessNamespaceImported: true;
  ambientGlobalProcessUsed: false;
  callerBindingAccepted: false;
  validatorSourcePresent: true;
  validatorPrivate: true;
  validatorStoredOnce: true;
  validatorExported: false;
  validatorRetrievable: false;
  validatorInvoked: false;
  validatorAcceptsCallerInput: false;
  descriptorInspectionPerformed: false;
  processValueRead: false;
  observerImported: false;
  observerComposed: false;
  rawObservationCreated: false;
  attestationImplemented: false;
  replayCheckpointImplemented: false;
  candidateAssemblerImplemented: false;
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

export type ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_STATUS_V1;
  implementationReference: string;
  implementationDigest: string;
  evidenceClass: "repository_static_non_execution";
  nativeBindingState: "static_namespace_captured_unread";
  validatorState: "stored_unreachable_uninvoked";
  descriptorState: "not_inspected";
  observerState: "not_composed";
  observationState: "not_created";
  attestationState: "not_created";
  candidateState: "not_assembled";
  runtimeState: "not_wired";
  actualValidatorLookups: 0;
  actualValidatorInvocations: 0;
  actualDescriptorInspections: 0;
  actualProcessVersionReads: 0;
  actualProcessExecPathReads: 0;
  actualProcessIdReads: 0;
  actualParentProcessIdReads: 0;
  actualHostObservations: 0;
  actualEnvironmentReads: 0;
  actualPathReads: 0;
  actualRawObservationReturns: 0;
  actualAttestationsCreated: 0;
  actualSignerCalls: 0;
  actualNoncesIssued: 0;
  actualClockReads: 0;
  actualCheckpointWrites: 0;
  actualPersistenceWrites: 0;
  actualNativeListenerAttempts: 0;
  actualNetworkIoEvents: 0;
  actualProtectedValuesRead: 0;
  actualObserverLookups: 0;
  actualObserverInvocations: 0;
  actualCandidateAssemblerEntries: 0;
  actualOwnerAuthorizationSpends: 0;
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

export class ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1 extends Error {
  readonly safeCode: "invalid_implementation" | "invalid_status" | "validator_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_implementation" || code === "invalid_status"
      || code === "validator_unavailable" || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

type PrivateNativeTargetRuntimeBindingValidationV1 = Readonly<{ valid: true }>;
type PrivateNativeTargetRuntimeBindingValidatorV1 = () => PrivateNativeTargetRuntimeBindingValidationV1;

const implementationRecordsV1 = new WeakSet<object>();
const implementationDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();
const quarantinedNativeTargetRuntimeBindingValidatorsV1 =
  new WeakMap<object, PrivateNativeTargetRuntimeBindingValidatorV1>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1["safeCode"]):
never {
  throw new ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "native target runtime binding validator record"); }
  catch { failV1("integrity_failed"); }
}

/*
 * LIVE-310 stores this real validator source without any lookup operation. Creating the function inspects no
 * descriptor and reads no process value. Invocation would cross a native trust boundary and remains forbidden here.
 */
function createQuarantinedNativeTargetRuntimeBindingValidatorV1():
PrivateNativeTargetRuntimeBindingValidatorV1 {
  const privateNativeTargetRuntimeBindingValidatorV1 = (): PrivateNativeTargetRuntimeBindingValidationV1 => {
    const versionDescriptorV1 = reflectApplyV1(objectGetOwnPropertyDescriptorV1, objectConstructorV1,
      [nativeProcessNamespaceV1, "version"]) as PropertyDescriptor | undefined;
    const execPathDescriptorV1 = reflectApplyV1(objectGetOwnPropertyDescriptorV1, objectConstructorV1,
      [nativeProcessNamespaceV1, "execPath"]) as PropertyDescriptor | undefined;
    const pidDescriptorV1 = reflectApplyV1(objectGetOwnPropertyDescriptorV1, objectConstructorV1,
      [nativeProcessNamespaceV1, "pid"]) as PropertyDescriptor | undefined;
    const ppidDescriptorV1 = reflectApplyV1(objectGetOwnPropertyDescriptorV1, objectConstructorV1,
      [nativeProcessNamespaceV1, "ppid"]) as PropertyDescriptor | undefined;
    const exactDescriptorsV1 = [versionDescriptorV1, execPathDescriptorV1, pidDescriptorV1, ppidDescriptorV1];
    if (reflectApplyV1(arraySomeV1, exactDescriptorsV1,
      [(descriptor: PropertyDescriptor | undefined) => descriptor === undefined || descriptor.get !== undefined
        || descriptor.set !== undefined || descriptor.writable !== true || descriptor.enumerable !== true
        || descriptor.configurable !== false])) {
      failV1("integrity_failed");
    }
    if (typeof versionDescriptorV1?.value !== "string" || typeof execPathDescriptorV1?.value !== "string"
      || typeof pidDescriptorV1?.value !== "number" || typeof ppidDescriptorV1?.value !== "number") {
      failV1("integrity_failed");
    }
    return objectFreezeV1({ valid: true as const });
  };
  return objectFreezeV1(privateNativeTargetRuntimeBindingValidatorV1);
}

const implementationSeedV1 = sha256Digest({
  live300ProductCommit: "aca7b98405fd12163b74fbc949a6a671d69fe310",
  acceptedLive300ReviewSha256: "86721e47c4c3c743aee97d5c577a1701242f799fdf6063c3dfbcfd3997d1758e",
  validatedProperties: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_PROPERTIES_V1,
});

const implementationMaterialV1 = {
  implementationVersion:
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_IMPLEMENTATION_V1,
  implementationReference: `native-target-runtime-binding-validator:${reflectApplyV1(stringSliceV1,
    implementationSeedV1, [7, 31])}`,
  live300ProductCommit: "aca7b98405fd12163b74fbc949a6a671d69fe310" as const,
  acceptedLive300ReviewSha256: "86721e47c4c3c743aee97d5c577a1701242f799fdf6063c3dfbcfd3997d1758e" as const,
  validatedProperties: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_PROPERTIES_V1,
  staticNodeProcessNamespaceImported: true as const,
  ambientGlobalProcessUsed: false as const,
  callerBindingAccepted: false as const,
  validatorSourcePresent: true as const,
  validatorPrivate: true as const,
  validatorStoredOnce: true as const,
  validatorExported: false as const,
  validatorRetrievable: false as const,
  validatorInvoked: false as const,
  validatorAcceptsCallerInput: false as const,
  descriptorInspectionPerformed: false as const,
  processValueRead: false as const,
  observerImported: false as const,
  observerComposed: false as const,
  rawObservationCreated: false as const,
  attestationImplemented: false as const,
  replayCheckpointImplemented: false as const,
  candidateAssemblerImplemented: false as const,
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
export const connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1 =
  objectFreezeV1({ ...implementationMaterialV1, implementationDigest: sha256Digest(implementationMaterialV1) });
reflectApplyV1(weakSetAddV1, implementationRecordsV1,
  [connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1]);
reflectApplyV1(weakMapSetV1, implementationDigestsV1,
  [connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1,
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1.implementationDigest]);
reflectApplyV1(weakMapSetV1, quarantinedNativeTargetRuntimeBindingValidatorsV1,
  [connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1,
    createQuarantinedNativeTargetRuntimeBindingValidatorV1()]);

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_STATUS_V1,
  implementationReference:
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1.implementationReference,
  implementationDigest:
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1.implementationDigest,
  evidenceClass: "repository_static_non_execution" as const,
  nativeBindingState: "static_namespace_captured_unread" as const,
  validatorState: "stored_unreachable_uninvoked" as const,
  descriptorState: "not_inspected" as const,
  observerState: "not_composed" as const,
  observationState: "not_created" as const,
  attestationState: "not_created" as const,
  candidateState: "not_assembled" as const,
  runtimeState: "not_wired" as const,
  actualValidatorLookups: 0 as const,
  actualValidatorInvocations: 0 as const,
  actualDescriptorInspections: 0 as const,
  actualProcessVersionReads: 0 as const,
  actualProcessExecPathReads: 0 as const,
  actualProcessIdReads: 0 as const,
  actualParentProcessIdReads: 0 as const,
  actualHostObservations: 0 as const,
  actualEnvironmentReads: 0 as const,
  actualPathReads: 0 as const,
  actualRawObservationReturns: 0 as const,
  actualAttestationsCreated: 0 as const,
  actualSignerCalls: 0 as const,
  actualNoncesIssued: 0 as const,
  actualClockReads: 0 as const,
  actualCheckpointWrites: 0 as const,
  actualPersistenceWrites: 0 as const,
  actualNativeListenerAttempts: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualProtectedValuesRead: 0 as const,
  actualObserverLookups: 0 as const,
  actualObserverInvocations: 0 as const,
  actualCandidateAssemblerEntries: 0 as const,
  actualOwnerAuthorizationSpends: 0 as const,
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
export const connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1,
    connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, implementationRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_implementation");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1;
  const captured = exactHostDataSnapshotV1(record, [
    "implementationVersion", "implementationReference", "live300ProductCommit", "acceptedLive300ReviewSha256",
    "validatedProperties", "staticNodeProcessNamespaceImported", "ambientGlobalProcessUsed",
    "callerBindingAccepted", "validatorSourcePresent", "validatorPrivate", "validatorStoredOnce",
    "validatorExported", "validatorRetrievable", "validatorInvoked", "validatorAcceptsCallerInput",
    "descriptorInspectionPerformed", "processValueRead", "observerImported", "observerComposed",
    "rawObservationCreated", "attestationImplemented", "replayCheckpointImplemented",
    "candidateAssemblerImplemented", "ownerAuthorizationPresent", "targetRuntimeBlockerCleared",
    "physicalQualificationAccepted", "runtimeWired", "candidateEligible", "activationEligible",
    "repositorySourceOnly", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "implementationDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, implementationDigestsV1, [record]) as string | undefined;
  if (!captured || digest !== record.implementationDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1
    || record.validatedProperties !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_TARGET_RUNTIME_BINDING_VALIDATOR_PROPERTIES_V1
    || !record.staticNodeProcessNamespaceImported || record.ambientGlobalProcessUsed || record.callerBindingAccepted
    || !record.validatorSourcePresent || !record.validatorPrivate || !record.validatorStoredOnce
    || record.validatorExported || record.validatorRetrievable || record.validatorInvoked
    || record.validatorAcceptsCallerInput || record.descriptorInspectionPerformed || record.processValueRead
    || record.observerImported || record.observerComposed || record.rawObservationCreated
    || record.attestationImplemented || record.replayCheckpointImplemented || record.candidateAssemblerImplemented
    || record.ownerAuthorizationPresent || record.targetRuntimeBlockerCleared || record.physicalQualificationAccepted
    || record.runtimeWired || record.candidateEligible || record.activationEligible || !record.repositorySourceOnly) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "implementationReference", "implementationDigest", "evidenceClass", "nativeBindingState",
    "validatorState", "descriptorState", "observerState", "observationState", "attestationState",
    "candidateState", "runtimeState", "actualValidatorLookups", "actualValidatorInvocations",
    "actualDescriptorInspections", "actualProcessVersionReads", "actualProcessExecPathReads",
    "actualProcessIdReads", "actualParentProcessIdReads", "actualHostObservations", "actualEnvironmentReads",
    "actualPathReads", "actualRawObservationReturns", "actualAttestationsCreated", "actualSignerCalls",
    "actualNoncesIssued", "actualClockReads", "actualCheckpointWrites", "actualPersistenceWrites",
    "actualNativeListenerAttempts", "actualNetworkIoEvents", "actualProtectedValuesRead", "actualObserverLookups",
    "actualObserverInvocations", "actualCandidateAssemblerEntries", "actualOwnerAuthorizationSpends",
    "externalEffectOccurred", "targetRuntimeBlockerCleared", "physicalQualificationAccepted", "runtimeWired",
    "candidateEligible", "activationEligible", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const entries = captured
    ? reflectApplyV1(objectEntriesV1, undefined, [captured]) as Array<[string, unknown]> : [];
  const actualEntries = reflectApplyV1(arrayFilterV1, entries,
    [([key]: [string, unknown]) => reflectApplyV1(stringStartsWithV1, key, ["actual"])]) as
      Array<[string, unknown]>;
  const grantEntries = reflectApplyV1(arrayFilterV1, entries,
    [([key]: [string, unknown]) => reflectApplyV1(stringStartsWithV1, key, ["grants"])]) as
      Array<[string, unknown]>;
  const actualValues = reflectApplyV1(arrayMapV1, actualEntries,
    [([, entry]: [string, unknown]) => entry]) as unknown[];
  const grantValues = reflectApplyV1(arrayMapV1, grantEntries,
    [([, entry]: [string, unknown]) => entry]) as unknown[];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1
    || actualValues.length !== 24 || reflectApplyV1(arraySomeV1, actualValues, [(entry: unknown) => entry !== 0])
    || grantValues.length !== 8 || reflectApplyV1(arraySomeV1, grantValues, [(entry: unknown) => entry !== false])
    || record.externalEffectOccurred || record.targetRuntimeBlockerCleared || record.physicalQualificationAccepted
    || record.runtimeWired || record.candidateEligible || record.activationEligible) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorImplementationV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackNativeTargetRuntimeBindingValidatorStatusV1);
