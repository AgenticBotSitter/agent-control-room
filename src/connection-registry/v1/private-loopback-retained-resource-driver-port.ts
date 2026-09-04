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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_IMPLEMENTATION_V1 =
  "control-room-connection-enrollment-private-loopback-retained-resource-driver-port-implementation/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-retained-resource-driver-port-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_SCENARIOS_V1 = objectFreezeV1([
  "accepted_then_closed",
  "rejected_before_acceptance",
  "ambiguous_after_acceptance",
  "cleanup_failed_then_recovered",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_STATES_V1 = objectFreezeV1([
  "created",
  "prepared",
  "accepted",
  "failed_before_acceptance",
  "ambiguous_after_acceptance",
  "cleanup_failed",
  "closed_verified",
] as const);

export type ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortScenarioV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_SCENARIOS_V1[number];
export type ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStateV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_STATES_V1[number];

export type ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_IMPLEMENTATION_V1;
  implementationReference: string;
  live170ProductCommit: "7e76e1980541075f9a1fa45479d20f06a823ef29";
  acceptedLive170ReviewSha256: "3581dcf33774e730614346d57594738236acf0932fa581214af7931af67c1381";
  resourceClass: "repository_fake_retained_listener";
  transferMode: "same_fake_resource_atomic_one_use";
  scenarioSet: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_SCENARIOS_V1;
  maximumHandoffs: 1;
  resourceFakeExported: false;
  locatorOrHandleExported: false;
  replacementResourceAllowed: false;
  retryRebindReopenAllowed: false;
  realDriverPortImplemented: false;
  realCustodyProviderImplemented: false;
  repositoryFakeOnly: true;
  runtimeWired: false;
  exclusivePortCustodyMissing: true;
  clearsExclusivePortCustodyBlocker: false;
  activationEligible: false;
  actualNativeBackendConstructions: 0;
  actualListenerAttempts: 0;
  actualNetworkIoEvents: 0;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  implementationDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_STATUS_V1;
  implementationReference: string;
  implementationDigest: string;
  evidenceClass: "repository_fake";
  scenario: ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortScenarioV1;
  state: ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStateV1;
  handoffOutcome: "not_attempted" | "accepted" | "failed_before_acceptance" | "ambiguous_after_acceptance";
  cleanupOutcome: "not_attempted" | "closed_verified" | "cleanup_failed";
  prepareCalls: number;
  handoffCalls: number;
  closeCalls: number;
  recoverCalls: number;
  transitionCount: number;
  fakeResourceCreatedSimulated: boolean;
  sameResourceIdentityVerifiedSimulated: boolean;
  continuousCustodyVerifiedSimulated: boolean;
  handoffSpentSimulated: boolean;
  driverAcceptedSimulated: boolean;
  replacementResourceCreatedSimulated: false;
  terminalCloseSimulated: boolean;
  independentZeroResourceObservationSimulated: boolean;
  recoveryCheckedSimulated: boolean;
  realDriverPortImplemented: false;
  realCustodyProviderImplemented: false;
  driverReservationHandoffGapPresent: true;
  exclusivePortCustodyMissing: true;
  clearsExclusivePortCustodyBlocker: false;
  activationEligible: false;
  actualHostObservations: 0;
  actualPortSelections: 0;
  actualPortReservations: 0;
  actualNativeResourcesCreated: 0;
  actualNativeResourcesRetained: 0;
  actualHandoffCapabilitiesIssued: 0;
  actualHandoffCapabilitiesSpent: 0;
  actualDriverHandoffCalls: 0;
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

export interface ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortFakeV1 {
  prepare(): Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1>;
  handoff(): Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1>;
  status(): ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1;
  close(): Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1>;
  recover(): Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1>;
}

export class ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortErrorV1 extends Error {
  readonly safeCode: "invalid_implementation" | "invalid_scenario" | "invalid_driver" | "invalid_status" |
    "sequence_conflict" | "handoff_already_consumed" | "recovery_not_available" | "integrity_failed";
  constructor(code: unknown) {
    const allowed = ["invalid_implementation", "invalid_scenario", "invalid_driver", "invalid_status",
      "sequence_conflict", "handoff_already_consumed", "recovery_not_available", "integrity_failed"] as const;
    const safeCode = typeof code === "string" && reflectApplyV1(arrayIncludesV1, allowed, [code])
      ? code as ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortErrorV1["safeCode"]
      : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

type DriverStateV1 = {
  scenario: ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortScenarioV1;
  state: ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStateV1;
  handoffOutcome: ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1["handoffOutcome"];
  cleanupOutcome: ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1["cleanupOutcome"];
  prepareCalls: number;
  handoffCalls: number;
  closeCalls: number;
  recoverCalls: number;
  transitionCount: number;
  handoffConsumed: boolean;
  fakeResource?: object;
  fakeResourceCreatedSimulated: boolean;
  sameResourceIdentityVerifiedSimulated: boolean;
  continuousCustodyVerifiedSimulated: boolean;
  handoffSpentSimulated: boolean;
  driverAcceptedSimulated: boolean;
  terminalCloseSimulated: boolean;
  independentZeroResourceObservationSimulated: boolean;
  recoveryCheckedSimulated: boolean;
  preparePromise?: Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1>;
  handoffPromise?: Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1>;
  closePromise?: Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1>;
  recoverPromise?: Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1>;
};

const implementationRecordsV1 = new WeakSet<object>();
const implementationDigestsV1 = new WeakMap<object, string>();
const driversV1 = new WeakSet<object>();
const driverStatesV1 = new WeakMap<object, DriverStateV1>();
const fakeResourcesV1 = new WeakSet<object>();
const statusRecordsV1 = new WeakSet<object>();
const statusDriversV1 = new WeakMap<object, object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "retained resource driver port record"); }
  catch { failV1("integrity_failed"); }
}

function settledV1<T>(value: T): Promise<T> {
  return reflectApplyV1(promiseResolveV1, promiseConstructorV1, [value]) as Promise<T>;
}

const implementationSeedV1 = sha256Digest({
  live170ProductCommit: "7e76e1980541075f9a1fa45479d20f06a823ef29",
  acceptedLive170ReviewSha256: "3581dcf33774e730614346d57594738236acf0932fa581214af7931af67c1381",
  transferMode: "same_fake_resource_atomic_one_use",
  scenarios: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_SCENARIOS_V1,
});

const implementationMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_IMPLEMENTATION_V1,
  implementationReference: `retained-resource-driver-port:${reflectApplyV1(stringSliceV1,
    implementationSeedV1, [7, 31])}`,
  live170ProductCommit: "7e76e1980541075f9a1fa45479d20f06a823ef29" as const,
  acceptedLive170ReviewSha256: "3581dcf33774e730614346d57594738236acf0932fa581214af7931af67c1381" as const,
  resourceClass: "repository_fake_retained_listener" as const,
  transferMode: "same_fake_resource_atomic_one_use" as const,
  scenarioSet: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_SCENARIOS_V1,
  maximumHandoffs: 1 as const,
  resourceFakeExported: false as const,
  locatorOrHandleExported: false as const,
  replacementResourceAllowed: false as const,
  retryRebindReopenAllowed: false as const,
  realDriverPortImplemented: false as const,
  realCustodyProviderImplemented: false as const,
  repositoryFakeOnly: true as const,
  runtimeWired: false as const,
  exclusivePortCustodyMissing: true as const,
  clearsExclusivePortCustodyBlocker: false as const,
  activationEligible: false as const,
  actualNativeBackendConstructions: 0 as const,
  actualListenerAttempts: 0 as const,
  actualNetworkIoEvents: 0 as const,
  externalEffectOccurred: false as const,
  grantsApproval: false as const,
  grantsQualificationAuthority: false as const,
  grantsActivationAuthority: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(implementationMaterialV1);
export const connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1 = objectFreezeV1({
  ...implementationMaterialV1,
  implementationDigest: sha256Digest(implementationMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1;
reflectApplyV1(weakSetAddV1, implementationRecordsV1,
  [connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1]);
reflectApplyV1(weakMapSetV1, implementationDigestsV1,
  [connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1,
    connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1.implementationDigest]);

function readStateV1(driver: unknown): DriverStateV1 {
  if (driver === null || typeof driver !== "object" || isHostProxyV1(driver)
    || reflectApplyV1(weakSetHasV1, driversV1, [driver]) !== true) failV1("invalid_driver");
  const state = reflectApplyV1(weakMapGetV1, driverStatesV1, [driver]) as DriverStateV1 | undefined;
  if (!state) failV1("integrity_failed");
  return state;
}

function statusV1(driver: object, state: DriverStateV1):
ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1 {
  const material = {
    statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_STATUS_V1,
    implementationReference: connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1
      .implementationReference,
    implementationDigest: connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1
      .implementationDigest,
    evidenceClass: "repository_fake" as const,
    scenario: state.scenario,
    state: state.state,
    handoffOutcome: state.handoffOutcome,
    cleanupOutcome: state.cleanupOutcome,
    prepareCalls: state.prepareCalls,
    handoffCalls: state.handoffCalls,
    closeCalls: state.closeCalls,
    recoverCalls: state.recoverCalls,
    transitionCount: state.transitionCount,
    fakeResourceCreatedSimulated: state.fakeResourceCreatedSimulated,
    sameResourceIdentityVerifiedSimulated: state.sameResourceIdentityVerifiedSimulated,
    continuousCustodyVerifiedSimulated: state.continuousCustodyVerifiedSimulated,
    handoffSpentSimulated: state.handoffSpentSimulated,
    driverAcceptedSimulated: state.driverAcceptedSimulated,
    replacementResourceCreatedSimulated: false as const,
    terminalCloseSimulated: state.terminalCloseSimulated,
    independentZeroResourceObservationSimulated: state.independentZeroResourceObservationSimulated,
    recoveryCheckedSimulated: state.recoveryCheckedSimulated,
    realDriverPortImplemented: false as const,
    realCustodyProviderImplemented: false as const,
    driverReservationHandoffGapPresent: true as const,
    exclusivePortCustodyMissing: true as const,
    clearsExclusivePortCustodyBlocker: false as const,
    activationEligible: false as const,
    actualHostObservations: 0 as const,
    actualPortSelections: 0 as const,
    actualPortReservations: 0 as const,
    actualNativeResourcesCreated: 0 as const,
    actualNativeResourcesRetained: 0 as const,
    actualHandoffCapabilitiesIssued: 0 as const,
    actualHandoffCapabilitiesSpent: 0 as const,
    actualDriverHandoffCalls: 0 as const,
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
  reflectApplyV1(weakMapSetV1, statusDriversV1, [status, driver]);
  reflectApplyV1(weakMapSetV1, statusDigestsV1, [status, status.statusDigest]);
  return status;
}

export function parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, implementationRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_implementation");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "implementationReference", "live170ProductCommit", "acceptedLive170ReviewSha256",
    "resourceClass", "transferMode", "scenarioSet", "maximumHandoffs", "resourceFakeExported",
    "locatorOrHandleExported", "replacementResourceAllowed", "retryRebindReopenAllowed",
    "realDriverPortImplemented", "realCustodyProviderImplemented", "repositoryFakeOnly", "runtimeWired",
    "exclusivePortCustodyMissing", "clearsExclusivePortCustodyBlocker", "activationEligible",
    "actualNativeBackendConstructions", "actualListenerAttempts", "actualNetworkIoEvents", "externalEffectOccurred",
    "grantsApproval", "grantsQualificationAuthority", "grantsActivationAuthority", "grantsNetworkAuthority",
    "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority", "implementationDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, implementationDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.implementationDigest
    || record !== connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1
    || record.scenarioSet !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_SCENARIOS_V1
    || record.maximumHandoffs !== 1 || record.resourceFakeExported || record.locatorOrHandleExported
    || record.replacementResourceAllowed || record.retryRebindReopenAllowed || record.realDriverPortImplemented
    || record.realCustodyProviderImplemented || !record.repositoryFakeOnly || record.runtimeWired
    || !record.exclusivePortCustodyMissing || record.clearsExclusivePortCustodyBlocker || record.activationEligible
    || record.actualNativeBackendConstructions !== 0 || record.actualListenerAttempts !== 0
    || record.actualNetworkIoEvents !== 0 || record.externalEffectOccurred || record.grantsApproval
    || record.grantsQualificationAuthority || record.grantsActivationAuthority || record.grantsNetworkAuthority
    || record.grantsCommandAuthority || record.grantsLeaseAuthority || record.grantsExecutionAuthority) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "implementationReference", "implementationDigest", "evidenceClass", "scenario", "state",
    "handoffOutcome", "cleanupOutcome", "prepareCalls", "handoffCalls", "closeCalls", "recoverCalls",
    "transitionCount", "fakeResourceCreatedSimulated", "sameResourceIdentityVerifiedSimulated",
    "continuousCustodyVerifiedSimulated", "handoffSpentSimulated", "driverAcceptedSimulated",
    "replacementResourceCreatedSimulated", "terminalCloseSimulated",
    "independentZeroResourceObservationSimulated", "recoveryCheckedSimulated", "realDriverPortImplemented",
    "realCustodyProviderImplemented", "driverReservationHandoffGapPresent", "exclusivePortCustodyMissing",
    "clearsExclusivePortCustodyBlocker", "activationEligible", "actualHostObservations", "actualPortSelections",
    "actualPortReservations", "actualNativeResourcesCreated", "actualNativeResourcesRetained",
    "actualHandoffCapabilitiesIssued", "actualHandoffCapabilitiesSpent", "actualDriverHandoffCalls",
    "actualNativeBackendConstructions", "actualListenerAttempts", "actualIpcListenerAttempts", "actualSocketAttempts",
    "actualTimerCreations", "actualNetworkIoEvents", "protectedValuesRead", "runtimeWired", "externalEffectOccurred",
    "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "statusDigest",
  ]);
  const driver = reflectApplyV1(weakMapGetV1, statusDriversV1, [record]) as object | undefined;
  const privateDigest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  if (!captured || !driver || reflectApplyV1(weakSetHasV1, driversV1, [driver]) !== true
    || privateDigest !== record.statusDigest
    || record.implementationReference !== connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1
      .implementationReference
    || record.implementationDigest !== connectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1
      .implementationDigest
    || record.evidenceClass !== "repository_fake" || record.replacementResourceCreatedSimulated
    || record.realDriverPortImplemented || record.realCustodyProviderImplemented
    || !record.driverReservationHandoffGapPresent || !record.exclusivePortCustodyMissing
    || record.clearsExclusivePortCustodyBlocker || record.activationEligible || record.actualHostObservations !== 0
    || record.actualPortSelections !== 0 || record.actualPortReservations !== 0
    || record.actualNativeResourcesCreated !== 0 || record.actualNativeResourcesRetained !== 0
    || record.actualHandoffCapabilitiesIssued !== 0 || record.actualHandoffCapabilitiesSpent !== 0
    || record.actualDriverHandoffCalls !== 0 || record.actualNativeBackendConstructions !== 0
    || record.actualListenerAttempts !== 0 || record.actualIpcListenerAttempts !== 0
    || record.actualSocketAttempts !== 0 || record.actualTimerCreations !== 0 || record.actualNetworkIoEvents !== 0
    || record.protectedValuesRead !== 0 || record.runtimeWired || record.externalEffectOccurred
    || record.grantsApproval || record.grantsQualificationAuthority || record.grantsCandidateAuthority
    || record.grantsActivationAuthority || record.grantsNetworkAuthority || record.grantsCommandAuthority
    || record.grantsLeaseAuthority || record.grantsExecutionAuthority) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1(
  scenarioValue: unknown,
): ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortFakeV1 {
  if (typeof scenarioValue !== "string"
    || !reflectApplyV1(arrayIncludesV1,
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_RETAINED_RESOURCE_DRIVER_PORT_SCENARIOS_V1, [scenarioValue])) {
    failV1("invalid_scenario");
  }
  const state: DriverStateV1 = {
    scenario: scenarioValue as ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortScenarioV1,
    state: "created",
    handoffOutcome: "not_attempted",
    cleanupOutcome: "not_attempted",
    prepareCalls: 0,
    handoffCalls: 0,
    closeCalls: 0,
    recoverCalls: 0,
    transitionCount: 0,
    handoffConsumed: false,
    fakeResourceCreatedSimulated: false,
    sameResourceIdentityVerifiedSimulated: false,
    continuousCustodyVerifiedSimulated: false,
    handoffSpentSimulated: false,
    driverAcceptedSimulated: false,
    terminalCloseSimulated: false,
    independentZeroResourceObservationSimulated: false,
    recoveryCheckedSimulated: false,
  };

  function prepare(this: unknown): Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1> {
    const current = readStateV1(this);
    if (current.preparePromise) return current.preparePromise;
    if (current.state !== "created") failV1("sequence_conflict");
    current.prepareCalls += 1;
    current.transitionCount += 1;
    current.fakeResource = objectFreezeV1({});
    reflectApplyV1(weakSetAddV1, fakeResourcesV1, [current.fakeResource]);
    current.fakeResourceCreatedSimulated = true;
    current.state = "prepared";
    current.preparePromise = settledV1(statusV1(this as object, current));
    return current.preparePromise;
  }

  function handoff(this: unknown): Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1> {
    const current = readStateV1(this);
    if (current.handoffPromise) return current.handoffPromise;
    if (current.handoffConsumed) failV1("handoff_already_consumed");
    if (current.state !== "prepared" || !current.fakeResource
      || reflectApplyV1(weakSetHasV1, fakeResourcesV1, [current.fakeResource]) !== true) failV1("sequence_conflict");
    current.handoffConsumed = true;
    current.handoffCalls += 1;
    current.transitionCount += 1;
    current.sameResourceIdentityVerifiedSimulated = true;
    current.continuousCustodyVerifiedSimulated = true;
    current.handoffSpentSimulated = true;
    if (current.scenario === "rejected_before_acceptance") {
      current.state = "failed_before_acceptance";
      current.handoffOutcome = "failed_before_acceptance";
    } else if (current.scenario === "ambiguous_after_acceptance") {
      current.state = "ambiguous_after_acceptance";
      current.handoffOutcome = "ambiguous_after_acceptance";
    } else {
      current.state = "accepted";
      current.handoffOutcome = "accepted";
      current.driverAcceptedSimulated = true;
    }
    current.handoffPromise = settledV1(statusV1(this as object, current));
    return current.handoffPromise;
  }

  function status(this: unknown): ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1 {
    return statusV1(this as object, readStateV1(this));
  }

  function close(this: unknown): Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1> {
    const current = readStateV1(this);
    if (current.closePromise) return current.closePromise;
    if (current.state !== "accepted" && current.state !== "failed_before_acceptance"
      && current.state !== "ambiguous_after_acceptance") failV1("sequence_conflict");
    const settle = (): ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1 => {
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
        current.fakeResource = undefined;
      }
      return statusV1(this as object, current);
    };
    current.closePromise = current.handoffPromise
      ? reflectApplyV1(promiseThenV1, current.handoffPromise, [settle]) as
        Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1>
      : settledV1(settle());
    return current.closePromise;
  }

  function recover(this: unknown): Promise<ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1> {
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
    current.fakeResource = undefined;
    current.recoverPromise = settledV1(statusV1(this as object, current));
    return current.recoverPromise;
  }

  for (const method of [prepare, handoff, status, close, recover]) objectFreezeV1(method);
  const driver = objectFreezeV1({ prepare, handoff, status, close, recover });
  reflectApplyV1(weakSetAddV1, driversV1, [driver]);
  reflectApplyV1(weakMapSetV1, driverStatesV1, [driver, state]);
  return driver;
}

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortErrorV1,
  parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortStatusV1,
  createConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortRepositoryFakeV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackRetainedResourceDriverPortErrorV1.prototype);
