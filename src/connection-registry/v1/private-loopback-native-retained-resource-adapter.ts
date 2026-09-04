import type { Server } from "node:net";
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
const arrayIncludesV1 = Array.prototype.includes;
const promiseConstructorV1 = Promise;
const promiseResolveV1 = Promise.resolve;
const promiseThenV1 = Promise.prototype.then;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_IMPLEMENTATION_V1 =
  "control-room-connection-enrollment-private-loopback-native-retained-resource-adapter-implementation/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-native-retained-resource-adapter-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_SCENARIOS_V1 = objectFreezeV1([
  "accepted_then_closed",
  "rejected_before_acceptance",
  "ambiguous_after_acceptance",
  "cleanup_failed_then_recovered",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_STATES_V1 = objectFreezeV1([
  "created",
  "prepared",
  "accepted",
  "failed_before_acceptance",
  "ambiguous_after_acceptance",
  "cleanup_failed",
  "closed_verified",
] as const);

export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterScenarioV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_SCENARIOS_V1[number];
export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStateV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_STATES_V1[number];

export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_IMPLEMENTATION_V1;
  implementationReference: string;
  live180ProductCommit: "052afc3b4a61f1c6f1957a567f5305f3a2c5bca0";
  acceptedLive180ReviewSha256: "05c4d57ad9f247916102acdc090c071b22a9b7a9623d1984779caf41d8acfd76";
  nativeServerTypeContract: "node:net.Server_type_only";
  transferMode: "same_retained_server_atomic_one_use";
  scenarioSet: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_SCENARIOS_V1;
  maximumAccepts: 1;
  typeOnlyNativeReference: true;
  nativeServerIssuerPresent: false;
  nativeServerExported: false;
  nativeHandleOrLocatorExported: false;
  numericPortBindCompatible: false;
  replacementServerAllowed: false;
  retryRebindReopenAllowed: false;
  realNativeRetainedResourceAdapterImplemented: false;
  driverAcceptedRealRetainedResource: false;
  repositoryFakeOnly: true;
  runtimeWired: false;
  driverReservationHandoffGapCleared: false;
  exclusivePortCustodyProvided: false;
  activationEligible: false;
  actualNativeServersReceived: 0;
  actualNativeBackendConstructions: 0;
  actualListenerAttempts: 0;
  actualNetworkIoEvents: 0;
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

export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_STATUS_V1;
  implementationReference: string;
  implementationDigest: string;
  evidenceClass: "repository_fake";
  scenario: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterScenarioV1;
  state: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStateV1;
  acceptanceOutcome: "not_attempted" | "accepted" | "failed_before_acceptance" | "ambiguous_after_acceptance";
  cleanupOutcome: "not_attempted" | "closed_verified" | "cleanup_failed";
  prepareCalls: number;
  acceptCalls: number;
  closeCalls: number;
  recoverCalls: number;
  transitionCount: number;
  fakeServerCreatedSimulated: boolean;
  sameServerIdentityVerifiedSimulated: boolean;
  continuousCustodyVerifiedSimulated: boolean;
  acceptanceSpentSimulated: boolean;
  driverAcceptedSimulated: boolean;
  ownershipTransitionSimulated: boolean;
  replacementServerCreatedSimulated: false;
  terminalCloseSimulated: boolean;
  independentZeroResourceObservationSimulated: boolean;
  recoveryCheckedSimulated: boolean;
  nativeServerIssuerPresent: false;
  realNativeRetainedResourceAdapterImplemented: false;
  driverAcceptedRealRetainedResource: false;
  driverReservationHandoffGapCleared: false;
  exclusivePortCustodyProvided: false;
  activationEligible: false;
  actualHostObservations: 0;
  actualPortSelections: 0;
  actualPortReservations: 0;
  actualNativeServersReceived: 0;
  actualNativeResourcesCreated: 0;
  actualNativeResourcesRetained: 0;
  actualHandoffCapabilitiesIssued: 0;
  actualHandoffCapabilitiesSpent: 0;
  actualDriverAcceptCalls: 0;
  actualNativeBackendConstructions: 0;
  actualListenerAttempts: 0;
  actualIpcListenerAttempts: 0;
  actualSocketAttempts: 0;
  actualTimerCreations: 0;
  actualNetworkIoEvents: 0;
  protectedValuesRead: 0;
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
  statusDigest: string;
}>;

export interface ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterFakeV1 {
  prepare(): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1>;
  accept(): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1>;
  status(): ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1;
  close(): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1>;
  recover(): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1>;
}

export class ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterErrorV1 extends Error {
  readonly safeCode: "invalid_implementation" | "invalid_scenario" | "invalid_adapter" | "invalid_status" |
    "status_mismatch" | "sequence_conflict" | "recovery_not_available" | "native_issuer_unavailable" |
    "integrity_failed";
  constructor(code: unknown) {
    const allowed = ["invalid_implementation", "invalid_scenario", "invalid_adapter", "invalid_status",
      "status_mismatch", "sequence_conflict", "recovery_not_available", "native_issuer_unavailable",
      "integrity_failed"] as const;
    const safeCode = typeof code === "string" && reflectApplyV1(arrayIncludesV1, allowed, [code])
      ? code as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterErrorV1["safeCode"]
      : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

type AdapterStateV1 = {
  scenario: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterScenarioV1;
  state: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStateV1;
  acceptanceOutcome: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1["acceptanceOutcome"];
  cleanupOutcome: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1["cleanupOutcome"];
  prepareCalls: number;
  acceptCalls: number;
  closeCalls: number;
  recoverCalls: number;
  transitionCount: number;
  acceptanceConsumed: boolean;
  fakeServer?: object;
  fakeServerCreatedSimulated: boolean;
  sameServerIdentityVerifiedSimulated: boolean;
  continuousCustodyVerifiedSimulated: boolean;
  acceptanceSpentSimulated: boolean;
  driverAcceptedSimulated: boolean;
  ownershipTransitionSimulated: boolean;
  terminalCloseSimulated: boolean;
  independentZeroResourceObservationSimulated: boolean;
  recoveryCheckedSimulated: boolean;
  preparePromise?: Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1>;
  acceptPromise?: Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1>;
  closePromise?: Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1>;
  recoverPromise?: Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1>;
};

const implementationRecordsV1 = new WeakSet<object>();
const implementationDigestsV1 = new WeakMap<object, string>();
const adaptersV1 = new WeakSet<object>();
const adapterStatesV1 = new WeakMap<object, AdapterStateV1>();
const fakeServersV1 = new WeakSet<object>();
const statusRecordsV1 = new WeakSet<object>();
const statusAdaptersV1 = new WeakMap<object, object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "native retained resource adapter record"); }
  catch { failV1("integrity_failed"); }
}

function settledV1<T>(value: T): Promise<T> {
  return reflectApplyV1(promiseResolveV1, promiseConstructorV1, [value]) as Promise<T>;
}

const implementationSeedV1 = sha256Digest({
  live180ProductCommit: "052afc3b4a61f1c6f1957a567f5305f3a2c5bca0",
  acceptedLive180ReviewSha256: "05c4d57ad9f247916102acdc090c071b22a9b7a9623d1984779caf41d8acfd76",
  nativeServerTypeContract: "node:net.Server_type_only",
  transferMode: "same_retained_server_atomic_one_use",
  scenarios: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_SCENARIOS_V1,
});

const implementationMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_IMPLEMENTATION_V1,
  implementationReference: `native-retained-resource-adapter:${reflectApplyV1(stringSliceV1,
    implementationSeedV1, [7, 31])}`,
  live180ProductCommit: "052afc3b4a61f1c6f1957a567f5305f3a2c5bca0" as const,
  acceptedLive180ReviewSha256: "05c4d57ad9f247916102acdc090c071b22a9b7a9623d1984779caf41d8acfd76" as const,
  nativeServerTypeContract: "node:net.Server_type_only" as const,
  transferMode: "same_retained_server_atomic_one_use" as const,
  scenarioSet: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_SCENARIOS_V1,
  maximumAccepts: 1 as const,
  typeOnlyNativeReference: true as const,
  nativeServerIssuerPresent: false as const,
  nativeServerExported: false as const,
  nativeHandleOrLocatorExported: false as const,
  numericPortBindCompatible: false as const,
  replacementServerAllowed: false as const,
  retryRebindReopenAllowed: false as const,
  realNativeRetainedResourceAdapterImplemented: false as const,
  driverAcceptedRealRetainedResource: false as const,
  repositoryFakeOnly: true as const,
  runtimeWired: false as const,
  driverReservationHandoffGapCleared: false as const,
  exclusivePortCustodyProvided: false as const,
  activationEligible: false as const,
  actualNativeServersReceived: 0 as const,
  actualNativeBackendConstructions: 0 as const,
  actualListenerAttempts: 0 as const,
  actualNetworkIoEvents: 0 as const,
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

safePublicRecordV1(implementationMaterialV1);
export const connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1 = objectFreezeV1({
  ...implementationMaterialV1,
  implementationDigest: sha256Digest(implementationMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1;
reflectApplyV1(weakSetAddV1, implementationRecordsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1]);
reflectApplyV1(weakMapSetV1, implementationDigestsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1,
    connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1.implementationDigest]);

function readStateV1(adapter: unknown): AdapterStateV1 {
  if (adapter === null || typeof adapter !== "object" || isHostProxyV1(adapter)
    || reflectApplyV1(weakSetHasV1, adaptersV1, [adapter]) !== true) failV1("invalid_adapter");
  const state = reflectApplyV1(weakMapGetV1, adapterStatesV1, [adapter]) as AdapterStateV1 | undefined;
  if (!state) failV1("integrity_failed");
  return state;
}

function statusV1(adapter: object, state: AdapterStateV1):
ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1 {
  const material = {
    statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_STATUS_V1,
    implementationReference: connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1
      .implementationReference,
    implementationDigest: connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1
      .implementationDigest,
    evidenceClass: "repository_fake" as const,
    scenario: state.scenario,
    state: state.state,
    acceptanceOutcome: state.acceptanceOutcome,
    cleanupOutcome: state.cleanupOutcome,
    prepareCalls: state.prepareCalls,
    acceptCalls: state.acceptCalls,
    closeCalls: state.closeCalls,
    recoverCalls: state.recoverCalls,
    transitionCount: state.transitionCount,
    fakeServerCreatedSimulated: state.fakeServerCreatedSimulated,
    sameServerIdentityVerifiedSimulated: state.sameServerIdentityVerifiedSimulated,
    continuousCustodyVerifiedSimulated: state.continuousCustodyVerifiedSimulated,
    acceptanceSpentSimulated: state.acceptanceSpentSimulated,
    driverAcceptedSimulated: state.driverAcceptedSimulated,
    ownershipTransitionSimulated: state.ownershipTransitionSimulated,
    replacementServerCreatedSimulated: false as const,
    terminalCloseSimulated: state.terminalCloseSimulated,
    independentZeroResourceObservationSimulated: state.independentZeroResourceObservationSimulated,
    recoveryCheckedSimulated: state.recoveryCheckedSimulated,
    nativeServerIssuerPresent: false as const,
    realNativeRetainedResourceAdapterImplemented: false as const,
    driverAcceptedRealRetainedResource: false as const,
    driverReservationHandoffGapCleared: false as const,
    exclusivePortCustodyProvided: false as const,
    activationEligible: false as const,
    actualHostObservations: 0 as const,
    actualPortSelections: 0 as const,
    actualPortReservations: 0 as const,
    actualNativeServersReceived: 0 as const,
    actualNativeResourcesCreated: 0 as const,
    actualNativeResourcesRetained: 0 as const,
    actualHandoffCapabilitiesIssued: 0 as const,
    actualHandoffCapabilitiesSpent: 0 as const,
    actualDriverAcceptCalls: 0 as const,
    actualNativeBackendConstructions: 0 as const,
    actualListenerAttempts: 0 as const,
    actualIpcListenerAttempts: 0 as const,
    actualSocketAttempts: 0 as const,
    actualTimerCreations: 0 as const,
    actualNetworkIoEvents: 0 as const,
    protectedValuesRead: 0 as const,
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
  safePublicRecordV1(material);
  const status = objectFreezeV1({ ...material, statusDigest: sha256Digest(material) });
  reflectApplyV1(weakSetAddV1, statusRecordsV1, [status]);
  reflectApplyV1(weakMapSetV1, statusAdaptersV1, [status, adapter]);
  reflectApplyV1(weakMapSetV1, statusDigestsV1, [status, status.statusDigest]);
  return status;
}

export function parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, implementationRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_implementation");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "implementationReference", "live180ProductCommit", "acceptedLive180ReviewSha256",
    "nativeServerTypeContract", "transferMode", "scenarioSet", "maximumAccepts", "typeOnlyNativeReference",
    "nativeServerIssuerPresent", "nativeServerExported", "nativeHandleOrLocatorExported",
    "numericPortBindCompatible", "replacementServerAllowed", "retryRebindReopenAllowed",
    "realNativeRetainedResourceAdapterImplemented", "driverAcceptedRealRetainedResource", "repositoryFakeOnly",
    "runtimeWired", "driverReservationHandoffGapCleared", "exclusivePortCustodyProvided", "activationEligible",
    "actualNativeServersReceived", "actualNativeBackendConstructions", "actualListenerAttempts",
    "actualNetworkIoEvents", "externalEffectOccurred", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "implementationDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, implementationDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.implementationDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1
    || record.scenarioSet !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_SCENARIOS_V1
    || record.maximumAccepts !== 1 || !record.typeOnlyNativeReference || record.nativeServerIssuerPresent
    || record.nativeServerExported || record.nativeHandleOrLocatorExported || record.numericPortBindCompatible
    || record.replacementServerAllowed || record.retryRebindReopenAllowed
    || record.realNativeRetainedResourceAdapterImplemented || record.driverAcceptedRealRetainedResource
    || !record.repositoryFakeOnly || record.runtimeWired || record.driverReservationHandoffGapCleared
    || record.exclusivePortCustodyProvided || record.activationEligible || record.actualNativeServersReceived !== 0
    || record.actualNativeBackendConstructions !== 0 || record.actualListenerAttempts !== 0
    || record.actualNetworkIoEvents !== 0 || record.externalEffectOccurred || record.grantsApproval
    || record.grantsQualificationAuthority || record.grantsCandidateAuthority || record.grantsActivationAuthority
    || record.grantsNetworkAuthority || record.grantsCommandAuthority || record.grantsLeaseAuthority
    || record.grantsExecutionAuthority) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "implementationReference", "implementationDigest", "evidenceClass", "scenario", "state",
    "acceptanceOutcome", "cleanupOutcome", "prepareCalls", "acceptCalls", "closeCalls", "recoverCalls",
    "transitionCount", "fakeServerCreatedSimulated", "sameServerIdentityVerifiedSimulated",
    "continuousCustodyVerifiedSimulated", "acceptanceSpentSimulated", "driverAcceptedSimulated",
    "ownershipTransitionSimulated", "replacementServerCreatedSimulated", "terminalCloseSimulated",
    "independentZeroResourceObservationSimulated", "recoveryCheckedSimulated", "nativeServerIssuerPresent",
    "realNativeRetainedResourceAdapterImplemented", "driverAcceptedRealRetainedResource",
    "driverReservationHandoffGapCleared", "exclusivePortCustodyProvided", "activationEligible",
    "actualHostObservations", "actualPortSelections", "actualPortReservations", "actualNativeServersReceived",
    "actualNativeResourcesCreated", "actualNativeResourcesRetained", "actualHandoffCapabilitiesIssued",
    "actualHandoffCapabilitiesSpent", "actualDriverAcceptCalls", "actualNativeBackendConstructions",
    "actualListenerAttempts", "actualIpcListenerAttempts", "actualSocketAttempts", "actualTimerCreations",
    "actualNetworkIoEvents", "protectedValuesRead", "runtimeWired", "externalEffectOccurred", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "statusDigest",
  ]);
  const adapter = reflectApplyV1(weakMapGetV1, statusAdaptersV1, [record]) as object | undefined;
  const privateDigest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  if (!captured || !adapter || reflectApplyV1(weakSetHasV1, adaptersV1, [adapter]) !== true
    || privateDigest !== record.statusDigest
    || record.implementationReference !==
      connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1.implementationReference
    || record.implementationDigest !==
      connectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1.implementationDigest
    || record.evidenceClass !== "repository_fake" || record.replacementServerCreatedSimulated
    || record.nativeServerIssuerPresent || record.realNativeRetainedResourceAdapterImplemented
    || record.driverAcceptedRealRetainedResource || record.driverReservationHandoffGapCleared
    || record.exclusivePortCustodyProvided || record.activationEligible || record.actualHostObservations !== 0
    || record.actualPortSelections !== 0 || record.actualPortReservations !== 0
    || record.actualNativeServersReceived !== 0 || record.actualNativeResourcesCreated !== 0
    || record.actualNativeResourcesRetained !== 0 || record.actualHandoffCapabilitiesIssued !== 0
    || record.actualHandoffCapabilitiesSpent !== 0 || record.actualDriverAcceptCalls !== 0
    || record.actualNativeBackendConstructions !== 0 || record.actualListenerAttempts !== 0
    || record.actualIpcListenerAttempts !== 0 || record.actualSocketAttempts !== 0
    || record.actualTimerCreations !== 0 || record.actualNetworkIoEvents !== 0 || record.protectedValuesRead !== 0
    || record.runtimeWired || record.externalEffectOccurred || record.grantsApproval
    || record.grantsQualificationAuthority || record.grantsCandidateAuthority || record.grantsActivationAuthority
    || record.grantsNetworkAuthority || record.grantsCommandAuthority || record.grantsLeaseAuthority
    || record.grantsExecutionAuthority) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function assertConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1(
  adapterValue: unknown,
  statusValue: unknown,
): void {
  readStateV1(adapterValue);
  const status = parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1(statusValue);
  const origin = reflectApplyV1(weakMapGetV1, statusAdaptersV1, [status]) as object | undefined;
  if (origin !== adapterValue) failV1("status_mismatch");
}

export function createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1(
  scenarioValue: unknown,
): ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterFakeV1 {
  if (typeof scenarioValue !== "string" || !reflectApplyV1(arrayIncludesV1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ADAPTER_SCENARIOS_V1, [scenarioValue])) {
    failV1("invalid_scenario");
  }
  const state: AdapterStateV1 = {
    scenario: scenarioValue as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterScenarioV1,
    state: "created",
    acceptanceOutcome: "not_attempted",
    cleanupOutcome: "not_attempted",
    prepareCalls: 0,
    acceptCalls: 0,
    closeCalls: 0,
    recoverCalls: 0,
    transitionCount: 0,
    acceptanceConsumed: false,
    fakeServerCreatedSimulated: false,
    sameServerIdentityVerifiedSimulated: false,
    continuousCustodyVerifiedSimulated: false,
    acceptanceSpentSimulated: false,
    driverAcceptedSimulated: false,
    ownershipTransitionSimulated: false,
    terminalCloseSimulated: false,
    independentZeroResourceObservationSimulated: false,
    recoveryCheckedSimulated: false,
  };

  function prepare(this: unknown): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1> {
    const current = readStateV1(this);
    if (current.preparePromise) return current.preparePromise;
    if (current.state !== "created") failV1("sequence_conflict");
    current.prepareCalls += 1;
    current.transitionCount += 1;
    current.fakeServer = objectFreezeV1({});
    reflectApplyV1(weakSetAddV1, fakeServersV1, [current.fakeServer]);
    current.fakeServerCreatedSimulated = true;
    current.state = "prepared";
    current.preparePromise = settledV1(statusV1(this as object, current));
    return current.preparePromise;
  }

  function accept(this: unknown): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1> {
    const current = readStateV1(this);
    if (current.acceptPromise) return current.acceptPromise;
    if (current.acceptanceConsumed || current.state !== "prepared" || !current.fakeServer
      || reflectApplyV1(weakSetHasV1, fakeServersV1, [current.fakeServer]) !== true) failV1("sequence_conflict");
    current.acceptanceConsumed = true;
    current.acceptCalls += 1;
    current.transitionCount += 1;
    current.sameServerIdentityVerifiedSimulated = true;
    current.continuousCustodyVerifiedSimulated = true;
    current.acceptanceSpentSimulated = true;
    if (current.scenario === "rejected_before_acceptance") {
      current.state = "failed_before_acceptance";
      current.acceptanceOutcome = "failed_before_acceptance";
    } else if (current.scenario === "ambiguous_after_acceptance") {
      current.state = "ambiguous_after_acceptance";
      current.acceptanceOutcome = "ambiguous_after_acceptance";
    } else {
      current.state = "accepted";
      current.acceptanceOutcome = "accepted";
      current.driverAcceptedSimulated = true;
      current.ownershipTransitionSimulated = true;
    }
    current.acceptPromise = settledV1(statusV1(this as object, current));
    return current.acceptPromise;
  }

  function status(this: unknown): ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1 {
    return statusV1(this as object, readStateV1(this));
  }

  function close(this: unknown): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1> {
    const current = readStateV1(this);
    if (current.closePromise) return current.closePromise;
    if (current.state !== "accepted" && current.state !== "failed_before_acceptance"
      && current.state !== "ambiguous_after_acceptance") failV1("sequence_conflict");
    const settle = (): ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1 => {
      current.closeCalls += 1;
      current.transitionCount += 1;
      if (current.scenario === "cleanup_failed_then_recovered") {
        current.state = "cleanup_failed";
        current.cleanupOutcome = "cleanup_failed";
      } else {
        current.state = "closed_verified";
        current.cleanupOutcome = "closed_verified";
        current.terminalCloseSimulated = true;
        current.independentZeroResourceObservationSimulated = true;
        current.fakeServer = undefined;
      }
      return statusV1(this as object, current);
    };
    current.closePromise = current.acceptPromise
      ? reflectApplyV1(promiseThenV1, current.acceptPromise, [settle]) as
        Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1>
      : settledV1(settle());
    return current.closePromise;
  }

  function recover(this: unknown): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1> {
    const current = readStateV1(this);
    if (current.recoverPromise) return current.recoverPromise;
    if (current.state !== "cleanup_failed") failV1("recovery_not_available");
    current.recoverCalls += 1;
    current.transitionCount += 1;
    current.state = "closed_verified";
    current.cleanupOutcome = "closed_verified";
    current.terminalCloseSimulated = true;
    current.independentZeroResourceObservationSimulated = true;
    current.recoveryCheckedSimulated = true;
    current.fakeServer = undefined;
    current.recoverPromise = settledV1(statusV1(this as object, current));
    return current.recoverPromise;
  }

  for (const method of [prepare, accept, status, close, recover]) objectFreezeV1(method);
  const adapter = objectFreezeV1({ prepare, accept, status, close, recover });
  reflectApplyV1(weakSetAddV1, adaptersV1, [adapter]);
  reflectApplyV1(weakMapSetV1, adapterStatesV1, [adapter, state]);
  return adapter;
}

function rejectUnissuedNativeRetainedServerV1(_server: Server): never {
  void _server;
  return failV1("native_issuer_unavailable");
}
objectFreezeV1(rejectUnissuedNativeRetainedServerV1);
void rejectUnissuedNativeRetainedServerV1;

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterErrorV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1,
  assertConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterStatusV1,
  createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterRepositoryFakeV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceAdapterErrorV1.prototype);
