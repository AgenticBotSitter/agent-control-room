import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";

const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const objectValuesV1 = Object.values;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;
const arrayIncludesV1 = Array.prototype.includes;
const promiseConstructorV1 = Promise;
const promiseResolveV1 = Promise.resolve;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_IMPLEMENTATION_V1 =
  "control-room-connection-enrollment-private-loopback-native-retained-resource-issuer-implementation/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-native-retained-resource-issuer-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_SCENARIOS_V1 = objectFreezeV1([
  "retained_transferred_then_closed",
  "rejected_before_effect",
  "ambiguous_after_effect_marker",
  "adapter_rejected_after_retention",
  "cleanup_failed_then_recovered",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATES_V1 = objectFreezeV1([
  "created",
  "claimed",
  "effect_marked",
  "retained",
  "transferred",
  "failed_before_effect",
  "ambiguous_after_effect",
  "cleanup_failed",
  "closed_verified",
] as const);

export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerScenarioV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_SCENARIOS_V1[number];
export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATES_V1[number];

export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1 = Readonly<{
  implementationVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_IMPLEMENTATION_V1;
  implementationReference: string;
  live200ProductCommit: "9e3cb2afdcd3008dcdac94d113db991f34e49175";
  acceptedLive200ReviewSha256: "82caf0b6ffc0a66661448a9780d0557221faa179f43956d6b2f691a7a1404185";
  scenarioSet: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_SCENARIOS_V1;
  stateSet: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATES_V1;
  resourceClass: "repository_fake_retained_ipv4_loopback_listener";
  maximumAttempts: 1;
  maximumFakeResources: 1;
  maximumTransfers: 1;
  maximumCloses: 1;
  fakeResourceExported: false;
  callerResourceAccepted: false;
  numericPortAccepted: false;
  retryRebindReopenAllowed: false;
  realIssuerImplemented: false;
  realAdapterCalled: false;
  livePersistenceImplemented: false;
  repositoryFakeOnly: true;
  driverReservationHandoffGapPresent: true;
  exclusivePortCustodyMissing: true;
  clearsCustodyOrHandoffBlocker: false;
  candidateEligible: false;
  activationEligible: false;
  runtimeWired: false;
  actualNativeBackendConstructions: 0;
  actualListenerAttempts: 0;
  actualNetworkIoEvents: 0;
  actualPersistenceWrites: 0;
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

export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATUS_V1;
  implementationReference: string;
  implementationDigest: string;
  evidenceClass: "repository_fake";
  scenario: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerScenarioV1;
  state: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateV1;
  claimOutcome: "not_attempted" | "claimed" | "rejected_before_effect";
  retentionOutcome: "not_attempted" | "retained" | "ambiguous_after_effect";
  transferOutcome: "not_attempted" | "accepted" | "rejected_after_retention";
  cleanupOutcome: "not_attempted" | "closed_verified" | "cleanup_failed";
  claimCalls: number;
  effectMarkerCalls: number;
  retentionCalls: number;
  transferCalls: number;
  closeCalls: number;
  recoverCalls: number;
  transitionCount: number;
  attemptClaimedSimulated: boolean;
  locatorSpentSimulated: boolean;
  custodySpentSimulated: boolean;
  effectUncertaintyMarkedSimulated: boolean;
  fakeResourceCreatedSimulated: boolean;
  fakeResourceRetainedSimulated: boolean;
  sameResourceIdentityVerifiedSimulated: boolean;
  continuousCustodyVerifiedSimulated: boolean;
  adapterAcceptedSimulated: boolean;
  ownershipTransferredSimulated: boolean;
  terminalCloseSimulated: boolean;
  independentZeroResourceObservationSimulated: boolean;
  recoveryCheckedSimulated: boolean;
  replacementResourceCreatedSimulated: false;
  realIssuerImplemented: false;
  realAdapterCalled: false;
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
  statusDigest: string;
}>;

export interface ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1 {
  claim(): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
  markEffect(): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
  settleRetention(): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
  transfer(): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
  close(): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
  recover(): Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
  status(): ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1;
}

export class ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateErrorV1 extends Error {
  readonly safeCode: "invalid_implementation" | "invalid_scenario" | "invalid_issuer" | "invalid_status" |
    "status_mismatch" | "sequence_conflict" | "recovery_not_available" | "integrity_failed";
  constructor(code: unknown) {
    const allowed = ["invalid_implementation", "invalid_scenario", "invalid_issuer", "invalid_status",
      "status_mismatch", "sequence_conflict", "recovery_not_available", "integrity_failed"] as const;
    const safeCode = typeof code === "string" && reflectApplyV1(arrayIncludesV1, allowed, [code])
      ? code as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateErrorV1["safeCode"]
      : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

type IssuerStateV1 = {
  scenario: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerScenarioV1;
  state: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateV1;
  claimOutcome: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1["claimOutcome"];
  retentionOutcome: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1["retentionOutcome"];
  transferOutcome: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1["transferOutcome"];
  cleanupOutcome: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1["cleanupOutcome"];
  claimCalls: number;
  effectMarkerCalls: number;
  retentionCalls: number;
  transferCalls: number;
  closeCalls: number;
  recoverCalls: number;
  transitionCount: number;
  attemptClaimedSimulated: boolean;
  locatorSpentSimulated: boolean;
  custodySpentSimulated: boolean;
  effectUncertaintyMarkedSimulated: boolean;
  fakeResource?: object;
  fakeAdapter?: object;
  fakeResourceCreatedSimulated: boolean;
  fakeResourceRetainedSimulated: boolean;
  sameResourceIdentityVerifiedSimulated: boolean;
  continuousCustodyVerifiedSimulated: boolean;
  adapterAcceptedSimulated: boolean;
  ownershipTransferredSimulated: boolean;
  terminalCloseSimulated: boolean;
  independentZeroResourceObservationSimulated: boolean;
  recoveryCheckedSimulated: boolean;
  claimPromise?: Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
  effectPromise?: Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
  retentionPromise?: Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
  transferPromise?: Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
  closePromise?: Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
  recoverPromise?: Promise<ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1>;
};

const implementationRecordsV1 = new WeakSet<object>();
const implementationDigestsV1 = new WeakMap<object, string>();
const issuersV1 = new WeakSet<object>();
const issuerStatesV1 = new WeakMap<object, IssuerStateV1>();
const fakeResourcesV1 = new WeakSet<object>();
const fakeAdaptersV1 = new WeakSet<object>();
const statusRecordsV1 = new WeakSet<object>();
const statusIssuersV1 = new WeakMap<object, object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "native retained resource issuer state record"); }
  catch { failV1("integrity_failed"); }
}

function settledV1<T>(value: T): Promise<T> {
  return reflectApplyV1(promiseResolveV1, promiseConstructorV1, [value]) as Promise<T>;
}

const implementationSeedV1 = sha256Digest({
  live200ProductCommit: "9e3cb2afdcd3008dcdac94d113db991f34e49175",
  acceptedLive200ReviewSha256: "82caf0b6ffc0a66661448a9780d0557221faa179f43956d6b2f691a7a1404185",
  scenarios: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_SCENARIOS_V1,
  states: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATES_V1,
});

const implementationMaterialV1 = {
  implementationVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_IMPLEMENTATION_V1,
  implementationReference: `native-retained-resource-issuer-state:${reflectApplyV1(stringSliceV1,
    implementationSeedV1, [7, 31])}`,
  live200ProductCommit: "9e3cb2afdcd3008dcdac94d113db991f34e49175" as const,
  acceptedLive200ReviewSha256: "82caf0b6ffc0a66661448a9780d0557221faa179f43956d6b2f691a7a1404185" as const,
  scenarioSet: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_SCENARIOS_V1,
  stateSet: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATES_V1,
  resourceClass: "repository_fake_retained_ipv4_loopback_listener" as const,
  maximumAttempts: 1 as const,
  maximumFakeResources: 1 as const,
  maximumTransfers: 1 as const,
  maximumCloses: 1 as const,
  fakeResourceExported: false as const,
  callerResourceAccepted: false as const,
  numericPortAccepted: false as const,
  retryRebindReopenAllowed: false as const,
  realIssuerImplemented: false as const,
  realAdapterCalled: false as const,
  livePersistenceImplemented: false as const,
  repositoryFakeOnly: true as const,
  driverReservationHandoffGapPresent: true as const,
  exclusivePortCustodyMissing: true as const,
  clearsCustodyOrHandoffBlocker: false as const,
  candidateEligible: false as const,
  activationEligible: false as const,
  runtimeWired: false as const,
  actualNativeBackendConstructions: 0 as const,
  actualListenerAttempts: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualPersistenceWrites: 0 as const,
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
export const connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1 = objectFreezeV1({
  ...implementationMaterialV1,
  implementationDigest: sha256Digest(implementationMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1;
reflectApplyV1(weakSetAddV1, implementationRecordsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1]);
reflectApplyV1(weakMapSetV1, implementationDigestsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1,
    connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1.implementationDigest]);

function readStateV1(issuer: unknown): IssuerStateV1 {
  if (issuer === null || typeof issuer !== "object" || isHostProxyV1(issuer)
    || reflectApplyV1(weakSetHasV1, issuersV1, [issuer]) !== true) failV1("invalid_issuer");
  const state = reflectApplyV1(weakMapGetV1, issuerStatesV1, [issuer]) as IssuerStateV1 | undefined;
  if (!state) failV1("integrity_failed");
  return state;
}

function statusV1(issuer: object, state: IssuerStateV1):
ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1 {
  const material = {
    statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATUS_V1,
    implementationReference: connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1
      .implementationReference,
    implementationDigest: connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1
      .implementationDigest,
    evidenceClass: "repository_fake" as const,
    scenario: state.scenario,
    state: state.state,
    claimOutcome: state.claimOutcome,
    retentionOutcome: state.retentionOutcome,
    transferOutcome: state.transferOutcome,
    cleanupOutcome: state.cleanupOutcome,
    claimCalls: state.claimCalls,
    effectMarkerCalls: state.effectMarkerCalls,
    retentionCalls: state.retentionCalls,
    transferCalls: state.transferCalls,
    closeCalls: state.closeCalls,
    recoverCalls: state.recoverCalls,
    transitionCount: state.transitionCount,
    attemptClaimedSimulated: state.attemptClaimedSimulated,
    locatorSpentSimulated: state.locatorSpentSimulated,
    custodySpentSimulated: state.custodySpentSimulated,
    effectUncertaintyMarkedSimulated: state.effectUncertaintyMarkedSimulated,
    fakeResourceCreatedSimulated: state.fakeResourceCreatedSimulated,
    fakeResourceRetainedSimulated: state.fakeResourceRetainedSimulated,
    sameResourceIdentityVerifiedSimulated: state.sameResourceIdentityVerifiedSimulated,
    continuousCustodyVerifiedSimulated: state.continuousCustodyVerifiedSimulated,
    adapterAcceptedSimulated: state.adapterAcceptedSimulated,
    ownershipTransferredSimulated: state.ownershipTransferredSimulated,
    terminalCloseSimulated: state.terminalCloseSimulated,
    independentZeroResourceObservationSimulated: state.independentZeroResourceObservationSimulated,
    recoveryCheckedSimulated: state.recoveryCheckedSimulated,
    replacementResourceCreatedSimulated: false as const,
    realIssuerImplemented: false as const,
    realAdapterCalled: false as const,
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
  safePublicRecordV1(material);
  const status = objectFreezeV1({ ...material, statusDigest: sha256Digest(material) });
  reflectApplyV1(weakSetAddV1, statusRecordsV1, [status]);
  reflectApplyV1(weakMapSetV1, statusIssuersV1, [status, issuer]);
  reflectApplyV1(weakMapSetV1, statusDigestsV1, [status, status.statusDigest]);
  return status;
}

export function parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, implementationRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_implementation");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1;
  const captured = exactHostDataSnapshotV1(record, [
    "implementationVersion", "implementationReference", "live200ProductCommit", "acceptedLive200ReviewSha256",
    "scenarioSet", "stateSet", "resourceClass", "maximumAttempts", "maximumFakeResources", "maximumTransfers",
    "maximumCloses", "fakeResourceExported", "callerResourceAccepted", "numericPortAccepted",
    "retryRebindReopenAllowed", "realIssuerImplemented", "realAdapterCalled", "livePersistenceImplemented",
    "repositoryFakeOnly", "driverReservationHandoffGapPresent", "exclusivePortCustodyMissing",
    "clearsCustodyOrHandoffBlocker", "candidateEligible", "activationEligible", "runtimeWired",
    "actualNativeBackendConstructions", "actualListenerAttempts", "actualNetworkIoEvents", "actualPersistenceWrites",
    "externalEffectOccurred", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "implementationDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, implementationDigestsV1, [record]) as string | undefined;
  if (!captured || digest !== record.implementationDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1
    || record.scenarioSet !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_SCENARIOS_V1
    || record.stateSet !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATES_V1
    || !record.repositoryFakeOnly || !record.driverReservationHandoffGapPresent || !record.exclusivePortCustodyMissing
    || record.realIssuerImplemented || record.realAdapterCalled || record.livePersistenceImplemented
    || record.clearsCustodyOrHandoffBlocker || record.candidateEligible || record.activationEligible
    || record.runtimeWired || record.externalEffectOccurred) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "implementationReference", "implementationDigest", "evidenceClass", "scenario", "state",
    "claimOutcome", "retentionOutcome", "transferOutcome", "cleanupOutcome", "claimCalls", "effectMarkerCalls",
    "retentionCalls", "transferCalls", "closeCalls", "recoverCalls", "transitionCount", "attemptClaimedSimulated",
    "locatorSpentSimulated", "custodySpentSimulated", "effectUncertaintyMarkedSimulated",
    "fakeResourceCreatedSimulated", "fakeResourceRetainedSimulated", "sameResourceIdentityVerifiedSimulated",
    "continuousCustodyVerifiedSimulated", "adapterAcceptedSimulated", "ownershipTransferredSimulated",
    "terminalCloseSimulated", "independentZeroResourceObservationSimulated", "recoveryCheckedSimulated",
    "replacementResourceCreatedSimulated", "realIssuerImplemented", "realAdapterCalled",
    "driverReservationHandoffGapPresent", "exclusivePortCustodyMissing", "clearsCustodyOrHandoffBlocker",
    "candidateEligible", "activationEligible", "actualHostObservations", "actualPortSelections",
    "actualPortReservations", "actualNativeResourcesCreated", "actualNativeResourcesRetained",
    "actualCapabilitiesIssued", "actualCapabilitiesSpent", "actualDriverAcceptCalls",
    "actualNativeBackendConstructions", "actualListenerAttempts", "actualIpcListenerAttempts", "actualSocketAttempts",
    "actualTimerCreations", "actualNetworkIoEvents", "actualProtectedValuesRead", "actualPersistenceWrites",
    "runtimeWired", "externalEffectOccurred", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  if (!captured || digest !== record.statusDigest
    || record.implementationReference !== connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1
      .implementationReference
    || record.implementationDigest !== connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1
      .implementationDigest
    || !reflectApplyV1(arrayIncludesV1,
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_SCENARIOS_V1, [record.scenario])
    || !reflectApplyV1(arrayIncludesV1,
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_STATES_V1, [record.state])
    || record.evidenceClass !== "repository_fake" || record.replacementResourceCreatedSimulated
    || record.realIssuerImplemented || record.realAdapterCalled || !record.driverReservationHandoffGapPresent
    || !record.exclusivePortCustodyMissing || record.clearsCustodyOrHandoffBlocker || record.candidateEligible
    || record.activationEligible || record.runtimeWired || record.externalEffectOccurred) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function assertConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1(
  issuer: unknown,
  status: unknown,
): ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1 {
  const state = readStateV1(issuer);
  const record = parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1(status);
  if (reflectApplyV1(weakMapGetV1, statusIssuersV1, [record]) !== issuer || record.scenario !== state.scenario) {
    failV1("status_mismatch");
  }
  return record;
}

export function createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1(scenario: unknown):
ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1 {
  if (typeof scenario !== "string" || !reflectApplyV1(arrayIncludesV1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_SCENARIOS_V1, [scenario])) {
    failV1("invalid_scenario");
  }
  const state: IssuerStateV1 = {
    scenario: scenario as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerScenarioV1,
    state: "created", claimOutcome: "not_attempted", retentionOutcome: "not_attempted",
    transferOutcome: "not_attempted", cleanupOutcome: "not_attempted", claimCalls: 0, effectMarkerCalls: 0,
    retentionCalls: 0, transferCalls: 0, closeCalls: 0, recoverCalls: 0, transitionCount: 0,
    attemptClaimedSimulated: false, locatorSpentSimulated: false, custodySpentSimulated: false,
    effectUncertaintyMarkedSimulated: false, fakeResourceCreatedSimulated: false,
    fakeResourceRetainedSimulated: false, sameResourceIdentityVerifiedSimulated: false,
    continuousCustodyVerifiedSimulated: false, adapterAcceptedSimulated: false,
    ownershipTransferredSimulated: false, terminalCloseSimulated: false,
    independentZeroResourceObservationSimulated: false, recoveryCheckedSimulated: false,
  };
  const issuer: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1 = {
    claim() {
      const current = readStateV1(this);
      if (current.claimPromise) return current.claimPromise;
      if (current.state !== "created") failV1("sequence_conflict");
      current.claimCalls = 1;
      current.transitionCount += 1;
      if (current.scenario === "rejected_before_effect") {
        current.state = "failed_before_effect";
        current.claimOutcome = "rejected_before_effect";
      } else {
        current.state = "claimed";
        current.claimOutcome = "claimed";
        current.attemptClaimedSimulated = true;
        current.locatorSpentSimulated = true;
        current.custodySpentSimulated = true;
      }
      current.claimPromise = settledV1(statusV1(issuer, current));
      return current.claimPromise;
    },
    markEffect() {
      const current = readStateV1(this);
      if (current.effectPromise) return current.effectPromise;
      if (current.state !== "claimed") failV1("sequence_conflict");
      current.effectMarkerCalls = 1;
      current.transitionCount += 1;
      current.state = "effect_marked";
      current.effectUncertaintyMarkedSimulated = true;
      current.effectPromise = settledV1(statusV1(issuer, current));
      return current.effectPromise;
    },
    settleRetention() {
      const current = readStateV1(this);
      if (current.retentionPromise) return current.retentionPromise;
      if (current.state !== "effect_marked") failV1("sequence_conflict");
      current.retentionCalls = 1;
      current.transitionCount += 1;
      if (current.scenario === "ambiguous_after_effect_marker") {
        current.state = "ambiguous_after_effect";
        current.retentionOutcome = "ambiguous_after_effect";
      } else {
        const fakeResource = objectFreezeV1({});
        const fakeAdapter = objectFreezeV1({});
        reflectApplyV1(weakSetAddV1, fakeResourcesV1, [fakeResource]);
        reflectApplyV1(weakSetAddV1, fakeAdaptersV1, [fakeAdapter]);
        current.fakeResource = fakeResource;
        current.fakeAdapter = fakeAdapter;
        current.state = "retained";
        current.retentionOutcome = "retained";
        current.fakeResourceCreatedSimulated = true;
        current.fakeResourceRetainedSimulated = true;
        current.sameResourceIdentityVerifiedSimulated = true;
        current.continuousCustodyVerifiedSimulated = true;
      }
      current.retentionPromise = settledV1(statusV1(issuer, current));
      return current.retentionPromise;
    },
    transfer() {
      const current = readStateV1(this);
      if (current.transferPromise) return current.transferPromise;
      if (current.state !== "retained" || !current.fakeResource || !current.fakeAdapter
        || !reflectApplyV1(weakSetHasV1, fakeResourcesV1, [current.fakeResource])
        || !reflectApplyV1(weakSetHasV1, fakeAdaptersV1, [current.fakeAdapter])) failV1("sequence_conflict");
      current.transferCalls = 1;
      current.transitionCount += 1;
      if (current.scenario === "adapter_rejected_after_retention") {
        current.state = "ambiguous_after_effect";
        current.transferOutcome = "rejected_after_retention";
      } else {
        current.state = "transferred";
        current.transferOutcome = "accepted";
        current.adapterAcceptedSimulated = true;
        current.ownershipTransferredSimulated = true;
      }
      current.transferPromise = settledV1(statusV1(issuer, current));
      return current.transferPromise;
    },
    close() {
      const current = readStateV1(this);
      if (current.closePromise) return current.closePromise;
      if (current.state !== "transferred" && current.state !== "retained"
        && current.state !== "ambiguous_after_effect") failV1("sequence_conflict");
      current.closeCalls = 1;
      current.transitionCount += 1;
      if (current.scenario === "cleanup_failed_then_recovered") {
        current.state = "cleanup_failed";
        current.cleanupOutcome = "cleanup_failed";
      } else {
        current.state = "closed_verified";
        current.cleanupOutcome = "closed_verified";
        current.fakeResourceRetainedSimulated = false;
        current.terminalCloseSimulated = true;
        current.independentZeroResourceObservationSimulated = true;
      }
      current.closePromise = settledV1(statusV1(issuer, current));
      return current.closePromise;
    },
    recover() {
      const current = readStateV1(this);
      if (current.recoverPromise) return current.recoverPromise;
      if (current.state !== "cleanup_failed") failV1("recovery_not_available");
      current.recoverCalls = 1;
      current.transitionCount += 1;
      current.state = "closed_verified";
      current.cleanupOutcome = "closed_verified";
      current.fakeResourceRetainedSimulated = false;
      current.terminalCloseSimulated = true;
      current.independentZeroResourceObservationSimulated = true;
      current.recoveryCheckedSimulated = true;
      current.recoverPromise = settledV1(statusV1(issuer, current));
      return current.recoverPromise;
    },
    status() { return statusV1(this, readStateV1(this)); },
  };
  for (const method of reflectApplyV1(objectValuesV1, Object, [issuer])) objectFreezeV1(method);
  objectFreezeV1(issuer);
  reflectApplyV1(weakSetAddV1, issuersV1, [issuer]);
  reflectApplyV1(weakMapSetV1, issuerStatesV1, [issuer, state]);
  return issuer;
}

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateErrorV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1,
  assertConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStatusV1,
  createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerFakeV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerStateErrorV1.prototype);
