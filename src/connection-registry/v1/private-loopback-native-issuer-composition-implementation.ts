import { assertNoSecretMaterial, sha256Digest } from "../../security";

const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const objectDefinePropertiesV1 = Object.defineProperties;
const objectSetPrototypeOfV1 = Object.setPrototypeOf;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;
const arrayIncludesV1 = Array.prototype.includes;
const arraySliceV1 = Array.prototype.slice;
const arrayPushV1 = Array.prototype.push;
const promiseConstructorV1 = Promise;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_IMPLEMENTATION_V1 =
  "control-room-connection-enrollment-private-loopback-native-issuer-composition-implementation/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_IMPLEMENTATION_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-native-issuer-composition-implementation-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_SCENARIOS_V1 = objectFreezeV1([
  "transferred_then_closed",
  "rejected_before_effect_marker",
  "ambiguous_after_effect_marker",
  "adapter_rejected_issuer_closes",
  "adapter_acceptance_uncertain",
  "cleanup_failed_then_observed_absent",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_STATES_V1 = objectFreezeV1([
  "created",
  "failed_before_effect",
  "ambiguous_after_effect",
  "issuer_retained",
  "owner_unresolved",
  "transferred",
  "cleanup_failed",
  "closed_verified",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_HISTORY_EVENTS_V1 = objectFreezeV1([
  "bindings_verified", "expiry_verified", "attempt_claimed", "pre_effect_rejected", "locator_authority_spent",
  "custody_authority_spent", "effect_uncertainty_marked", "factory_retrieved", "native_settlement_ambiguous",
  "fake_resource_created", "listener_settled", "private_locator_observed", "adapter_offered", "adapter_rejected",
  "adapter_acceptance_uncertain", "adapter_accepted", "ownership_transferred", "close_attempted", "cleanup_failed",
  "cleanup_closed_verified", "independent_absence_observed", "cleanup_observed_absent", "tombstoned", "checkpointed",
] as const);

export type ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionScenarioV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_SCENARIOS_V1[number];
export type ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStateV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_STATES_V1[number];
export type ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionHistoryEventV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_HISTORY_EVENTS_V1[number];

export type ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1 = Readonly<{
  implementationVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_IMPLEMENTATION_V1;
  implementationReference: string;
  live230ProductCommit: "3974f165f106cb0fe616b2f0e91a18e45b1b4c2d";
  acceptedLive230ReviewSha256: "eb6957f2f577b77ce7c68fb2f8e92e80004a987e3fa83ba1bdee993f6f59d58a";
  scenarioSet: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_SCENARIOS_V1;
  stateSet: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_STATES_V1;
  executionClass: "repository_owned_inert_ports";
  bindingValidationMode: "exact_live230_identity_before_claim";
  expiryValidationMode: "repository_owned_simulated_unexpired_before_claim";
  maximumRuns: 1;
  maximumBindingChecks: 1;
  maximumExpiryChecks: 1;
  maximumClaims: 1;
  maximumLocatorSpends: 1;
  maximumCustodySpends: 1;
  maximumEffectMarkers: 1;
  maximumFactoryRetrievals: 1;
  maximumFakeResources: 1;
  maximumListenerSettlements: 1;
  maximumLocatorObservations: 1;
  maximumAdapterAccepts: 1;
  maximumOwnershipTransfers: 1;
  maximumCloses: 1;
  callerDependencyAccepted: false;
  privatePortsExported: false;
  fakeResourceExported: false;
  retryRebindReopenAllowed: false;
  realCompositionImplemented: false;
  live220ImportedOrConsumed: false;
  realAdapterCalled: false;
  livePersistenceImplemented: false;
  runtimeWired: false;
  externalEffectOccurred: false;
  clearsCustodyOrHandoffBlocker: false;
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
  implementationDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_IMPLEMENTATION_STATUS_V1;
  implementationReference: string;
  implementationDigest: string;
  evidenceClass: "repository_fake";
  scenario: ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionScenarioV1;
  state: ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStateV1;
  custodyOwner: "none" | "issuer" | "adapter" | "unresolved";
  cleanupOutcome: "not_required" | "closed_verified" | "failed" | "observed_absent_after_failure";
  runCalls: number;
  bindingCheckCalls: number;
  expiryCheckCalls: number;
  claimCalls: number;
  locatorSpendCalls: number;
  custodySpendCalls: number;
  effectMarkerCalls: number;
  factoryRetrievalCalls: number;
  fakeResourceCreateCalls: number;
  listenerSettlementCalls: number;
  locatorObservationCalls: number;
  adapterAcceptCalls: number;
  ownershipTransferCalls: number;
  closeCalls: number;
  independentObservationCalls: number;
  tombstoneCalls: number;
  checkpointCalls: number;
  transitionCount: number;
  history: readonly ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionHistoryEventV1[];
  bindingsVerifiedSimulated: boolean;
  expiryVerifiedSimulated: boolean;
  attemptClaimedSimulated: boolean;
  locatorAuthoritySpentSimulated: boolean;
  custodyAuthoritySpentSimulated: boolean;
  effectUncertaintyMarkedSimulated: boolean;
  fakeResourceCreatedSimulated: boolean;
  fakeResourceRetainedSimulated: boolean;
  privateLocatorObservedSimulated: boolean;
  exactResourceIdentityVerifiedSimulated: boolean;
  continuousCustodyVerifiedSimulated: boolean;
  adapterAcceptedSimulated: boolean;
  ownershipTransferredSimulated: boolean;
  terminalCloseSimulated: boolean;
  independentZeroResourceObservationSimulated: boolean;
  tombstonedSimulated: boolean;
  checkpointedSimulated: boolean;
  replacementResourceCreatedSimulated: false;
  actualHostObservations: 0;
  actualPortSelections: 0;
  actualPortReservations: 0;
  actualFactoryRetrievals: 0;
  actualNativeBackendConstructions: 0;
  actualNativeResourcesCreated: 0;
  actualNativeResourcesRetained: 0;
  actualListenerAttempts: 0;
  actualCloseAttempts: 0;
  actualLocatorObservations: 0;
  actualCapabilitiesIssued: 0;
  actualCapabilitiesSpent: 0;
  actualAdapterAcceptCalls: 0;
  actualDriverCalls: 0;
  actualPersistenceWrites: 0;
  actualTimerCreations: 0;
  actualNetworkIoEvents: 0;
  actualProtectedValuesRead: 0;
  runtimeWired: false;
  externalEffectOccurred: false;
  clearsCustodyOrHandoffBlocker: false;
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

export interface ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1 {
  run(): Promise<ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1>;
  status(): ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1;
}

export class ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1 extends Error {
  readonly safeCode: "invalid_implementation" | "invalid_scenario" | "invalid_composition" | "invalid_status" |
    "status_mismatch" | "integrity_failed";

  constructor(code: unknown) {
    const allowed = ["invalid_implementation", "invalid_scenario", "invalid_composition", "invalid_status",
      "status_mismatch", "integrity_failed"] as const;
    const safeCode = typeof code === "string" && reflectApplyV1(arrayIncludesV1, allowed, [code])
      ? code as ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1["safeCode"]
      : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

type CustodyOwnerV1 = ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1["custodyOwner"];
type CleanupOutcomeV1 =
  ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1["cleanupOutcome"];

type CompositionStateV1 = {
  scenario: ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionScenarioV1;
  state: ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionStateV1;
  custodyOwner: CustodyOwnerV1;
  cleanupOutcome: CleanupOutcomeV1;
  counts: number[];
  transitionCount: number;
  flags: boolean[];
  history: readonly ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionHistoryEventV1[];
  fakeResource?: object;
  runStarted: boolean;
  runPromise: Promise<ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1>;
  resolveRun: (value: ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1) => void;
  rejectRun: (reason: ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1) => void;
};

const implementationRecordsV1 = new WeakSet<object>();
const implementationDigestsV1 = new WeakMap<object, string>();
const compositionsV1 = new WeakSet<object>();
const compositionStatesV1 = new WeakMap<object, CompositionStateV1>();
const fakeResourcesV1 = new WeakSet<object>();
const statusRecordsV1 = new WeakSet<object>();
const statusCompositionsV1 = new WeakMap<object, object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1["safeCode"]):
never {
  throw new ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "native issuer composition implementation record"); }
  catch { failV1("integrity_failed"); }
}

const implementationSeedV1 = sha256Digest({
  live230ProductCommit: "3974f165f106cb0fe616b2f0e91a18e45b1b4c2d",
  acceptedLive230ReviewSha256: "eb6957f2f577b77ce7c68fb2f8e92e80004a987e3fa83ba1bdee993f6f59d58a",
  scenarios: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_SCENARIOS_V1,
  states: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_STATES_V1,
});

const implementationMaterialV1 = {
  implementationVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_IMPLEMENTATION_V1,
  implementationReference: `native-issuer-composition-implementation:${reflectApplyV1(stringSliceV1,
    implementationSeedV1, [7, 31])}`,
  live230ProductCommit: "3974f165f106cb0fe616b2f0e91a18e45b1b4c2d" as const,
  acceptedLive230ReviewSha256: "eb6957f2f577b77ce7c68fb2f8e92e80004a987e3fa83ba1bdee993f6f59d58a" as const,
  scenarioSet: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_SCENARIOS_V1,
  stateSet: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_STATES_V1,
  executionClass: "repository_owned_inert_ports" as const,
  bindingValidationMode: "exact_live230_identity_before_claim" as const,
  expiryValidationMode: "repository_owned_simulated_unexpired_before_claim" as const,
  maximumRuns: 1 as const,
  maximumBindingChecks: 1 as const,
  maximumExpiryChecks: 1 as const,
  maximumClaims: 1 as const,
  maximumLocatorSpends: 1 as const,
  maximumCustodySpends: 1 as const,
  maximumEffectMarkers: 1 as const,
  maximumFactoryRetrievals: 1 as const,
  maximumFakeResources: 1 as const,
  maximumListenerSettlements: 1 as const,
  maximumLocatorObservations: 1 as const,
  maximumAdapterAccepts: 1 as const,
  maximumOwnershipTransfers: 1 as const,
  maximumCloses: 1 as const,
  callerDependencyAccepted: false as const,
  privatePortsExported: false as const,
  fakeResourceExported: false as const,
  retryRebindReopenAllowed: false as const,
  realCompositionImplemented: false as const,
  live220ImportedOrConsumed: false as const,
  realAdapterCalled: false as const,
  livePersistenceImplemented: false as const,
  runtimeWired: false as const,
  externalEffectOccurred: false as const,
  clearsCustodyOrHandoffBlocker: false as const,
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

safePublicRecordV1(implementationMaterialV1);
export const connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1 = objectFreezeV1({
  ...implementationMaterialV1,
  implementationDigest: sha256Digest(implementationMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1;
reflectApplyV1(weakSetAddV1, implementationRecordsV1,
  [connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1]);
reflectApplyV1(weakMapSetV1, implementationDigestsV1,
  [connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1,
    connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1.implementationDigest]);

const statusDigestV1 = sha256Digest({
  implementationDigest: connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1.implementationDigest,
  evidenceClass: "repository_fake_branded_status",
});

function readStateV1(composition: unknown): CompositionStateV1 {
  if (composition === null || typeof composition !== "object"
    || reflectApplyV1(weakSetHasV1, compositionsV1, [composition]) !== true) failV1("invalid_composition");
  const state = reflectApplyV1(weakMapGetV1, compositionStatesV1, [composition]) as CompositionStateV1 | undefined;
  if (!state) failV1("integrity_failed");
  return state;
}

function statusV1(composition: object, state: CompositionStateV1):
ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1 {
  const material = {
    statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_IMPLEMENTATION_STATUS_V1,
    implementationReference: connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1
      .implementationReference,
    implementationDigest: connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1
      .implementationDigest,
    evidenceClass: "repository_fake" as const,
    scenario: state.scenario,
    state: state.state,
    custodyOwner: state.custodyOwner,
    cleanupOutcome: state.cleanupOutcome,
    runCalls: state.counts[0] ?? 0,
    bindingCheckCalls: state.counts[1] ?? 0,
    expiryCheckCalls: state.counts[2] ?? 0,
    claimCalls: state.counts[3] ?? 0,
    locatorSpendCalls: state.counts[4] ?? 0,
    custodySpendCalls: state.counts[5] ?? 0,
    effectMarkerCalls: state.counts[6] ?? 0,
    factoryRetrievalCalls: state.counts[7] ?? 0,
    fakeResourceCreateCalls: state.counts[8] ?? 0,
    listenerSettlementCalls: state.counts[9] ?? 0,
    locatorObservationCalls: state.counts[10] ?? 0,
    adapterAcceptCalls: state.counts[11] ?? 0,
    ownershipTransferCalls: state.counts[12] ?? 0,
    closeCalls: state.counts[13] ?? 0,
    independentObservationCalls: state.counts[14] ?? 0,
    tombstoneCalls: state.counts[15] ?? 0,
    checkpointCalls: state.counts[16] ?? 0,
    transitionCount: state.transitionCount,
    history: state.history,
    bindingsVerifiedSimulated: state.flags[0] ?? false,
    expiryVerifiedSimulated: state.flags[1] ?? false,
    attemptClaimedSimulated: state.flags[2] ?? false,
    locatorAuthoritySpentSimulated: state.flags[3] ?? false,
    custodyAuthoritySpentSimulated: state.flags[4] ?? false,
    effectUncertaintyMarkedSimulated: state.flags[5] ?? false,
    fakeResourceCreatedSimulated: state.flags[6] ?? false,
    fakeResourceRetainedSimulated: state.flags[7] ?? false,
    privateLocatorObservedSimulated: state.flags[8] ?? false,
    exactResourceIdentityVerifiedSimulated: state.flags[9] ?? false,
    continuousCustodyVerifiedSimulated: state.flags[10] ?? false,
    adapterAcceptedSimulated: state.flags[11] ?? false,
    ownershipTransferredSimulated: state.flags[12] ?? false,
    terminalCloseSimulated: state.flags[13] ?? false,
    independentZeroResourceObservationSimulated: state.flags[14] ?? false,
    tombstonedSimulated: state.flags[15] ?? false,
    checkpointedSimulated: state.flags[16] ?? false,
    replacementResourceCreatedSimulated: false as const,
    actualHostObservations: 0 as const,
    actualPortSelections: 0 as const,
    actualPortReservations: 0 as const,
    actualFactoryRetrievals: 0 as const,
    actualNativeBackendConstructions: 0 as const,
    actualNativeResourcesCreated: 0 as const,
    actualNativeResourcesRetained: 0 as const,
    actualListenerAttempts: 0 as const,
    actualCloseAttempts: 0 as const,
    actualLocatorObservations: 0 as const,
    actualCapabilitiesIssued: 0 as const,
    actualCapabilitiesSpent: 0 as const,
    actualAdapterAcceptCalls: 0 as const,
    actualDriverCalls: 0 as const,
    actualPersistenceWrites: 0 as const,
    actualTimerCreations: 0 as const,
    actualNetworkIoEvents: 0 as const,
    actualProtectedValuesRead: 0 as const,
    runtimeWired: false as const,
    externalEffectOccurred: false as const,
    clearsCustodyOrHandoffBlocker: false as const,
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
  const status = objectFreezeV1(reflectApplyV1(objectSetPrototypeOfV1, undefined,
    [{ ...material, statusDigest: statusDigestV1 }, null]) as
      ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1);
  reflectApplyV1(weakSetAddV1, statusRecordsV1, [status]);
  reflectApplyV1(weakMapSetV1, statusCompositionsV1, [status, composition]);
  reflectApplyV1(weakMapSetV1, statusDigestsV1, [status, status.statusDigest]);
  return status;
}

function incrementV1(state: CompositionStateV1, index: number): void {
  state.counts[index] = (state.counts[index] ?? 0) + 1;
}

function appendHistoryV1(
  state: CompositionStateV1,
  event: ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionHistoryEventV1,
): void {
  const next = reflectApplyV1(arraySliceV1, state.history, [0]) as
    ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionHistoryEventV1[];
  reflectApplyV1(arrayPushV1, next, [event]);
  state.history = objectFreezeV1(next);
  state.transitionCount = next.length;
}

function finishV1(state: CompositionStateV1): void {
  incrementV1(state, 14); state.flags[14] = true; appendHistoryV1(state, "independent_absence_observed");
  if (state.cleanupOutcome === "failed") {
    state.cleanupOutcome = "observed_absent_after_failure";
    appendHistoryV1(state, "cleanup_observed_absent");
  }
  incrementV1(state, 15); state.flags[15] = true; appendHistoryV1(state, "tombstoned");
  incrementV1(state, 16); state.flags[16] = true; appendHistoryV1(state, "checkpointed");
  state.fakeResource = undefined;
  state.flags[7] = false;
  state.custodyOwner = "none";
  state.state = "closed_verified";
}

function executeV1(composition: object, state: CompositionStateV1):
ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1 {
  incrementV1(state, 0);
  incrementV1(state, 1); state.flags[0] = true; appendHistoryV1(state, "bindings_verified");
  incrementV1(state, 2); state.flags[1] = true; appendHistoryV1(state, "expiry_verified");
  incrementV1(state, 3);
  if (state.scenario === "rejected_before_effect_marker") {
    appendHistoryV1(state, "pre_effect_rejected");
    state.state = "failed_before_effect";
    return statusV1(composition, state);
  }
  state.flags[2] = true; appendHistoryV1(state, "attempt_claimed");
  incrementV1(state, 4); state.flags[3] = true; appendHistoryV1(state, "locator_authority_spent");
  incrementV1(state, 5); state.flags[4] = true; appendHistoryV1(state, "custody_authority_spent");
  incrementV1(state, 6); state.flags[5] = true; appendHistoryV1(state, "effect_uncertainty_marked");
  incrementV1(state, 7); appendHistoryV1(state, "factory_retrieved");
  if (state.scenario === "ambiguous_after_effect_marker") {
    appendHistoryV1(state, "native_settlement_ambiguous");
    state.state = "ambiguous_after_effect";
    state.custodyOwner = "unresolved";
    return statusV1(composition, state);
  }

  const fakeResource = objectFreezeV1({});
  reflectApplyV1(weakSetAddV1, fakeResourcesV1, [fakeResource]);
  state.fakeResource = fakeResource;
  incrementV1(state, 8); state.flags[6] = true; state.flags[7] = true;
  appendHistoryV1(state, "fake_resource_created");
  state.custodyOwner = "issuer";
  incrementV1(state, 9); state.flags[10] = true; appendHistoryV1(state, "listener_settled");
  incrementV1(state, 10); state.flags[8] = true; appendHistoryV1(state, "private_locator_observed");
  incrementV1(state, 11); appendHistoryV1(state, "adapter_offered");
  if (reflectApplyV1(weakSetHasV1, fakeResourcesV1, [state.fakeResource]) !== true
    || state.fakeResource !== fakeResource) failV1("integrity_failed");
  state.flags[9] = true;
  state.flags[10] = true;

  if (state.scenario === "adapter_acceptance_uncertain") {
    appendHistoryV1(state, "adapter_acceptance_uncertain");
    state.state = "owner_unresolved";
    state.custodyOwner = "unresolved";
    return statusV1(composition, state);
  }

  if (state.scenario === "adapter_rejected_issuer_closes") {
    appendHistoryV1(state, "adapter_rejected");
    state.state = "issuer_retained";
  } else {
    state.flags[11] = true;
    appendHistoryV1(state, "adapter_accepted");
    incrementV1(state, 12);
    state.flags[12] = true;
    appendHistoryV1(state, "ownership_transferred");
    state.custodyOwner = "adapter";
    state.state = "transferred";
  }

  incrementV1(state, 13); appendHistoryV1(state, "close_attempted");
  if (state.scenario === "cleanup_failed_then_observed_absent") {
    state.cleanupOutcome = "failed";
    state.state = "cleanup_failed";
    appendHistoryV1(state, "cleanup_failed");
  } else {
    state.cleanupOutcome = "closed_verified";
    appendHistoryV1(state, "cleanup_closed_verified");
  }
  state.flags[13] = true;
  finishV1(state);
  return statusV1(composition, state);
}

export function parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1 {
  if (value === null || typeof value !== "object"
    || reflectApplyV1(weakSetHasV1, implementationRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_implementation");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1;
  const digest = reflectApplyV1(weakMapGetV1, implementationDigestsV1, [record]) as string | undefined;
  if (digest !== record.implementationDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1
    || record.scenarioSet !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_SCENARIOS_V1
    || record.stateSet !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_STATES_V1) {
    failV1("integrity_failed");
  }
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1 {
  if (value === null || typeof value !== "object"
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1;
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  if (digest !== record.statusDigest) failV1("integrity_failed");
  return record;
}

export function assertConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1(
  composition: unknown,
  status: unknown,
): ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1 {
  readStateV1(composition);
  const parsed = parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1(status);
  if (reflectApplyV1(weakMapGetV1, statusCompositionsV1, [parsed]) !== composition) failV1("status_mismatch");
  return parsed;
}

export function createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1(scenario: unknown):
ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1 {
  if (typeof scenario !== "string" || !reflectApplyV1(arrayIncludesV1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ISSUER_COMPOSITION_SCENARIOS_V1, [scenario])) {
    failV1("invalid_scenario");
  }
  let resolveRunV1!: (value: ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1) => void;
  let rejectRunV1!: (reason: ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1) => void;
  const runPromise = new promiseConstructorV1<
  ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1>((resolve, reject) => {
    resolveRunV1 = resolve;
    rejectRunV1 = reject;
  });
  const state: CompositionStateV1 = {
    scenario: scenario as ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionScenarioV1,
    state: "created",
    custodyOwner: "none",
    cleanupOutcome: "not_required",
    counts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    transitionCount: 0,
    flags: [false, false, false, false, false, false, false, false, false, false, false, false, false, false,
      false, false, false],
    history: objectFreezeV1([]),
    runStarted: false,
    runPromise,
    resolveRun: resolveRunV1,
    rejectRun: rejectRunV1,
  };
  const composition = {} as ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1;
  const run = function run(this: unknown):
  Promise<ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1> {
    const current = readStateV1(this);
    if (!current.runStarted) {
      current.runStarted = true;
      try {
        current.resolveRun(executeV1(composition, current));
      } catch {
        if (current.flags[5]) {
          current.state = "ambiguous_after_effect";
          current.custodyOwner = current.fakeResource ? "issuer" : "unresolved";
          appendHistoryV1(current, "native_settlement_ambiguous");
        } else {
          current.state = "failed_before_effect";
          appendHistoryV1(current, "pre_effect_rejected");
        }
        current.rejectRun(new ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1(
          "integrity_failed"));
      }
    }
    return current.runPromise;
  };
  const status = function status(this: unknown):
  ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1 {
    return statusV1(composition, readStateV1(this));
  };
  objectFreezeV1(run);
  objectFreezeV1(status);
  reflectApplyV1(objectDefinePropertiesV1, undefined, [composition, {
    run: { value: run, enumerable: true },
    status: { value: status, enumerable: true },
  }]);
  objectFreezeV1(composition);
  reflectApplyV1(weakSetAddV1, compositionsV1, [composition]);
  reflectApplyV1(weakMapSetV1, compositionStatesV1, [composition, state]);
  return composition;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1);
objectFreezeV1(assertConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionImplementationStatusV1);
objectFreezeV1(createConnectionEnrollmentPrivateLoopbackNativeIssuerCompositionFakeV1);
