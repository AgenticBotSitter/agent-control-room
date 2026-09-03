import {
  createServer as createNodeNetServerV1,
  Server as NodeNetServerV1,
  Socket as NodeNetSocketV1,
  type Server,
  type Socket,
} from "node:net";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import {
  exactHostDataSnapshotV1,
  isHostProxyV1,
} from "../../security/host-value";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
  ConnectionEnrollmentPrivateLoopbackFrameDecoderV1,
} from "./private-loopback-framing";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1,
  parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1,
  type ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1,
} from "./private-loopback-native-driver-contract";

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_IMPLEMENTATION_V1 =
  "control-room-connection-enrollment-private-loopback-physical-native-implementation/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-physical-native-status/v1" as const;

const objectFreezeV1 = Object.freeze;
const objectGetPrototypeOfV1 = Object.getPrototypeOf;
const objectIsFrozenV1 = Object.isFrozen;
const arrayIncludesV1 = Array.prototype.includes;
const numberIsSafeIntegerV1 = Number.isSafeInteger;
const reflectApplyV1 = Reflect.apply;
const reflectOwnKeysV1 = Reflect.ownKeys;
const regexpExecV1 = RegExp.prototype.exec;
const stringSliceV1 = String.prototype.slice;
const promiseConstructorV1 = Promise;
const uint8ArrayConstructorV1 = Uint8Array;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;
const clearTimeoutV1 = globalThis.clearTimeout;
const setTimeoutV1 = globalThis.setTimeout;
const createServerV1 = createNodeNetServerV1;
const serverCloseV1 = NodeNetServerV1.prototype.close;
const serverListenV1 = NodeNetServerV1.prototype.listen;
const serverOnV1 = NodeNetServerV1.prototype.on;
const serverOnceV1 = NodeNetServerV1.prototype.once;
const socketDestroyV1 = NodeNetSocketV1.prototype.destroy;
const socketOnV1 = NodeNetSocketV1.prototype.on;
const socketPauseV1 = NodeNetSocketV1.prototype.pause;
const socketResumeV1 = NodeNetSocketV1.prototype.resume;
const literalIpv4LoopbackV1 = "127.0.0.1" as const;
const nativeAttemptReferencePatternV1 = /^native-attempt:[a-f0-9]{24}$/;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATES_V1 = objectFreezeV1([
  "created",
  "prepared",
  "starting",
  "listening",
  "draining",
  "closed",
  "failed_before_bind",
  "ambiguous_after_marker",
  "cleanup_failed",
  "recovery_checked",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_FAKE_SCENARIOS_V1 = objectFreezeV1([
  "closed_verified",
  "failed_before_bind",
  "ambiguous_after_marker",
  "cleanup_failed",
] as const);

export type ConnectionEnrollmentPrivateLoopbackPhysicalNativeStateV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATES_V1[number];
export type ConnectionEnrollmentPrivateLoopbackPhysicalNativeFakeScenarioV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_FAKE_SCENARIOS_V1[number];

export type ConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_IMPLEMENTATION_V1;
  implementationReference: string;
  driverContractDigest: string;
  operationSet: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1;
  serverModule: "node:net";
  bindPolicy: "literal_ipv4_loopback_only";
  portPolicy: "opaque_private_capability_only";
  maximumConcurrentConnections: 1;
  maximumQueuedConnections: 0;
  oneFramePerConnection: true;
  automaticRestartAllowed: false;
  nativeImplementationPresent: true;
  nativeFactoryExported: false;
  bindCapabilityIssuerPresent: false;
  runtimeWired: false;
  repositoryFakeTestOnly: true;
  physicalQualificationAccepted: false;
  activationEligible: false;
  listenerAttemptsMade: 0;
  networkIoEventsObserved: 0;
  externalEffectOccurred: false;
  requiresIndependentReview: true;
  requiresFreshOwnerAuthorizationForPhysicalAttempt: true;
  status: "implemented_unwired_review_required";
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  implementationDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATUS_V1;
  implementationReference: string;
  implementationDigest: string;
  driverContractDigest: string;
  evidenceMode: "repository_fake";
  scenario: ConnectionEnrollmentPrivateLoopbackPhysicalNativeFakeScenarioV1;
  state: ConnectionEnrollmentPrivateLoopbackPhysicalNativeStateV1;
  prepareCalls: number;
  startCalls: number;
  statusCalls: number;
  closeCalls: number;
  recoverCalls: number;
  transitionCount: number;
  preEffectMarkerSimulated: boolean;
  bindCallSimulated: boolean;
  cleanupVerifiedSimulated: boolean;
  recoveryChecked: boolean;
  nativeImplementationPresent: true;
  nativeDriverAccepted: false;
  physicalQualificationAccepted: false;
  activationEligible: false;
  listenerAttemptsMade: 0;
  networkIoEventsObserved: 0;
  runtimeWired: false;
  externalEffectOccurred: false;
  automaticRetryAllowed: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  statusDigest: string;
}>;

export interface ConnectionEnrollmentPrivateLoopbackPhysicalNativeFakeDriverV1 {
  prepare(): Promise<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1>;
  start(): Promise<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1>;
  status(): ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1;
  close(): Promise<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1>;
  recover(): Promise<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1>;
}

export class ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_configuration" | "invalid_implementation" | "invalid_driver" |
    "invalid_status" | "sequence_conflict" | "start_already_consumed" | "recovery_not_terminal" |
    "native_activation_unavailable" | "integrity_failed") {
    super(safeCode);
    this.name = "ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1";
  }
}

type InternalStartResultV1 = "listening" | "failed_before_bind" | "ambiguous_after_marker";
type InternalCloseResultV1 = "closed" | "cleanup_failed";
type InternalRecoverResultV1 = "closed_verified" | "failed_before_bind" | "ambiguous_after_marker" |
  "cleanup_failed" | "integrity_failed";

type InternalDriverPortV1 = Readonly<{
  mode: "repository_fake" | "node_net_unwired";
  prepare(): Promise<void>;
  start(): Promise<InternalStartResultV1>;
  close(): Promise<InternalCloseResultV1>;
  recover(): Promise<InternalRecoverResultV1>;
}>;

type InternalDriverStateV1 = {
  contract: ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1;
  implementation: ConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1;
  scenario: ConnectionEnrollmentPrivateLoopbackPhysicalNativeFakeScenarioV1;
  port: InternalDriverPortV1;
  state: ConnectionEnrollmentPrivateLoopbackPhysicalNativeStateV1;
  prepareCalls: number;
  startCalls: number;
  statusCalls: number;
  closeCalls: number;
  recoverCalls: number;
  transitionCount: number;
  startConsumed: boolean;
  preEffectMarkerSimulated: boolean;
  bindCallSimulated: boolean;
  cleanupVerifiedSimulated: boolean;
  recoveryChecked: boolean;
  terminalStatus?: ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1;
  preparePromise?: Promise<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1>;
  closePromise?: Promise<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1>;
  recoverPromise?: Promise<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1>;
};

const implementationsV1 = new WeakSet<object>();
const implementationContractsV1 = new WeakMap<object, ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1>();
const statusRecordsV1 = new WeakSet<object>();
const statusDriversV1 = new WeakMap<object, object>();
const driversV1 = new WeakSet<object>();
const driverStatesV1 = new WeakMap<object, InternalDriverStateV1>();
const internalPortsV1 = new WeakSet<object>();

function weakSetContainsV1(set: WeakSet<object>, value: unknown): value is object {
  return value !== null && typeof value === "object" && !isHostProxyV1(value)
    && reflectApplyV1(weakSetHasV1, set, [value]) === true;
}

function readDriverStateV1(driver: unknown): InternalDriverStateV1 {
  if (!weakSetContainsV1(driversV1, driver)) {
    throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("invalid_driver");
  }
  const state = reflectApplyV1(weakMapGetV1, driverStatesV1, [driver]) as InternalDriverStateV1 | undefined;
  if (!state) throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("integrity_failed");
  return state;
}

function safePublicRecordV1(value: unknown, label: string,
  code: ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1["safeCode"]): void {
  try { assertNoSecretMaterial(value, label); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1(code); }
}

function implementationReferenceV1(contractDigest: string): string {
  const digest = sha256Digest({
    contractDigest,
    module: "node:net",
    bindPolicy: "literal_ipv4_loopback_only",
    operations: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1,
  });
  return `physical-native-implementation:${reflectApplyV1(stringSliceV1, digest, [7, 31])}`;
}

export function describeConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1(contractValue: unknown):
ConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1 {
  let contract: ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1;
  try { contract = parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1(contractValue); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("invalid_configuration"); }
  const material = {
    contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_IMPLEMENTATION_V1,
    implementationReference: implementationReferenceV1(contract.contractDigest),
    driverContractDigest: contract.contractDigest,
    operationSet: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1,
    serverModule: "node:net" as const,
    bindPolicy: "literal_ipv4_loopback_only" as const,
    portPolicy: "opaque_private_capability_only" as const,
    maximumConcurrentConnections: 1 as const,
    maximumQueuedConnections: 0 as const,
    oneFramePerConnection: true as const,
    automaticRestartAllowed: false as const,
    nativeImplementationPresent: true as const,
    nativeFactoryExported: false as const,
    bindCapabilityIssuerPresent: false as const,
    runtimeWired: false as const,
    repositoryFakeTestOnly: true as const,
    physicalQualificationAccepted: false as const,
    activationEligible: false as const,
    listenerAttemptsMade: 0 as const,
    networkIoEventsObserved: 0 as const,
    externalEffectOccurred: false as const,
    requiresIndependentReview: true as const,
    requiresFreshOwnerAuthorizationForPhysicalAttempt: true as const,
    status: "implemented_unwired_review_required" as const,
    grantsApproval: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  safePublicRecordV1(material, "physical native implementation", "invalid_configuration");
  const implementation = objectFreezeV1({ ...material, implementationDigest: sha256Digest(material) });
  reflectApplyV1(weakSetAddV1, implementationsV1, [implementation]);
  reflectApplyV1(weakMapSetV1, implementationContractsV1, [implementation, contract]);
  return implementation;
}

export function parseConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1 {
  if (!weakSetContainsV1(implementationsV1, value) || !objectIsFrozenV1(value)) {
    throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("invalid_implementation");
  }
  const contract = reflectApplyV1(weakMapGetV1, implementationContractsV1, [value]) as
    ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1 | undefined;
  if (!contract) throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("integrity_failed");
  const implementation = value as ConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1;
  const captured = exactHostDataSnapshotV1(implementation, [
    "contractVersion", "implementationReference", "driverContractDigest", "operationSet", "serverModule",
    "bindPolicy", "portPolicy", "maximumConcurrentConnections", "maximumQueuedConnections",
    "oneFramePerConnection", "automaticRestartAllowed", "nativeImplementationPresent", "nativeFactoryExported",
    "bindCapabilityIssuerPresent", "runtimeWired", "repositoryFakeTestOnly", "physicalQualificationAccepted",
    "activationEligible", "listenerAttemptsMade", "networkIoEventsObserved", "externalEffectOccurred",
    "requiresIndependentReview", "requiresFreshOwnerAuthorizationForPhysicalAttempt", "status", "grantsApproval",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "implementationDigest",
  ]);
  const { implementationDigest: _digest, ...unsigned } = implementation;
  void _digest;
  if (!captured || sha256Digest(unsigned) !== implementation.implementationDigest
    || implementation.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_IMPLEMENTATION_V1
    || implementation.implementationReference !== implementationReferenceV1(contract.contractDigest)
    || implementation.driverContractDigest !== contract.contractDigest
    || implementation.operationSet !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1
    || implementation.serverModule !== "node:net" || implementation.bindPolicy !== "literal_ipv4_loopback_only"
    || implementation.portPolicy !== "opaque_private_capability_only"
    || implementation.maximumConcurrentConnections !== 1 || implementation.maximumQueuedConnections !== 0
    || implementation.oneFramePerConnection !== true || implementation.automaticRestartAllowed !== false
    || implementation.nativeImplementationPresent !== true || implementation.nativeFactoryExported !== false
    || implementation.bindCapabilityIssuerPresent !== false || implementation.runtimeWired !== false
    || implementation.repositoryFakeTestOnly !== true || implementation.physicalQualificationAccepted !== false
    || implementation.activationEligible !== false || implementation.listenerAttemptsMade !== 0
    || implementation.networkIoEventsObserved !== 0 || implementation.externalEffectOccurred !== false
    || implementation.requiresIndependentReview !== true
    || implementation.requiresFreshOwnerAuthorizationForPhysicalAttempt !== true
    || implementation.status !== "implemented_unwired_review_required" || implementation.grantsApproval !== false
    || implementation.grantsNetworkAuthority !== false || implementation.grantsCommandAuthority !== false
    || implementation.grantsLeaseAuthority !== false || implementation.grantsExecutionAuthority !== false) {
    throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("invalid_implementation");
  }
  safePublicRecordV1(implementation, "physical native implementation", "invalid_implementation");
  return implementation;
}

function fakePortV1(scenario: ConnectionEnrollmentPrivateLoopbackPhysicalNativeFakeScenarioV1): InternalDriverPortV1 {
  const port = objectFreezeV1({
    mode: "repository_fake" as const,
    prepare: objectFreezeV1(async () => undefined),
    start: objectFreezeV1(async (): Promise<InternalStartResultV1> => {
      if (scenario === "failed_before_bind") return "failed_before_bind";
      if (scenario === "ambiguous_after_marker") return "ambiguous_after_marker";
      return "listening";
    }),
    close: objectFreezeV1(async (): Promise<InternalCloseResultV1> =>
      scenario === "cleanup_failed" ? "cleanup_failed" : "closed"),
    recover: objectFreezeV1(async (): Promise<InternalRecoverResultV1> => scenario),
  });
  reflectApplyV1(weakSetAddV1, internalPortsV1, [port]);
  return port;
}

function statusMaterialV1(driver: object, countStatusCall: boolean):
Omit<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1, "statusDigest"> {
  const state = readDriverStateV1(driver);
  if (countStatusCall) state.statusCalls += 1;
  return {
    contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATUS_V1,
    implementationReference: state.implementation.implementationReference,
    implementationDigest: state.implementation.implementationDigest,
    driverContractDigest: state.contract.contractDigest,
    evidenceMode: "repository_fake",
    scenario: state.scenario,
    state: state.state,
    prepareCalls: state.prepareCalls,
    startCalls: state.startCalls,
    statusCalls: state.statusCalls,
    closeCalls: state.closeCalls,
    recoverCalls: state.recoverCalls,
    transitionCount: state.transitionCount,
    preEffectMarkerSimulated: state.preEffectMarkerSimulated,
    bindCallSimulated: state.bindCallSimulated,
    cleanupVerifiedSimulated: state.cleanupVerifiedSimulated,
    recoveryChecked: state.recoveryChecked,
    nativeImplementationPresent: true,
    nativeDriverAccepted: false,
    physicalQualificationAccepted: false,
    activationEligible: false,
    listenerAttemptsMade: 0,
    networkIoEventsObserved: 0,
    runtimeWired: false,
    externalEffectOccurred: false,
    automaticRetryAllowed: false,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
}

function sealStatusV1(driver: object, countStatusCall = false):
ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1 {
  const material = statusMaterialV1(driver, countStatusCall);
  safePublicRecordV1(material, "physical native fake status", "integrity_failed");
  const status = objectFreezeV1({ ...material, statusDigest: sha256Digest(material) });
  reflectApplyV1(weakSetAddV1, statusRecordsV1, [status]);
  reflectApplyV1(weakMapSetV1, statusDriversV1, [status, driver]);
  return status;
}

function isScenarioV1(value: unknown): value is ConnectionEnrollmentPrivateLoopbackPhysicalNativeFakeScenarioV1 {
  return value === "closed_verified" || value === "failed_before_bind"
    || value === "ambiguous_after_marker" || value === "cleanup_failed";
}

export function parseConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1 {
  if (!weakSetContainsV1(statusRecordsV1, value) || !objectIsFrozenV1(value)) {
    throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("invalid_status");
  }
  const driver = reflectApplyV1(weakMapGetV1, statusDriversV1, [value]) as object | undefined;
  if (!driver || !weakSetContainsV1(driversV1, driver)) {
    throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("invalid_status");
  }
  const status = value as ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1;
  const state = readDriverStateV1(driver);
  const captured = exactHostDataSnapshotV1(status, [
    "contractVersion", "implementationReference", "implementationDigest", "driverContractDigest", "evidenceMode",
    "scenario", "state", "prepareCalls", "startCalls", "statusCalls", "closeCalls", "recoverCalls",
    "transitionCount", "preEffectMarkerSimulated", "bindCallSimulated", "cleanupVerifiedSimulated",
    "recoveryChecked", "nativeImplementationPresent", "nativeDriverAccepted", "physicalQualificationAccepted",
    "activationEligible", "listenerAttemptsMade", "networkIoEventsObserved", "runtimeWired",
    "externalEffectOccurred", "automaticRetryAllowed", "grantsApproval", "grantsNetworkAuthority",
    "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority", "statusDigest",
  ]);
  const { statusDigest: _digest, ...unsigned } = status;
  void _digest;
  if (!captured || status.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATUS_V1
    || status.implementationReference !== state.implementation.implementationReference
    || status.implementationDigest !== state.implementation.implementationDigest
    || status.driverContractDigest !== state.contract.contractDigest || status.evidenceMode !== "repository_fake"
    || !isScenarioV1(status.scenario)
    || reflectApplyV1(arrayIncludesV1, CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_NATIVE_STATES_V1,
      [status.state]) !== true
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [status.prepareCalls]) || status.prepareCalls < 0
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [status.startCalls]) || status.startCalls < 0
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [status.statusCalls]) || status.statusCalls < 0
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [status.closeCalls]) || status.closeCalls < 0
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [status.recoverCalls]) || status.recoverCalls < 0
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [status.transitionCount]) || status.transitionCount < 0
    || typeof status.preEffectMarkerSimulated !== "boolean" || typeof status.bindCallSimulated !== "boolean"
    || typeof status.cleanupVerifiedSimulated !== "boolean" || typeof status.recoveryChecked !== "boolean"
    || status.nativeImplementationPresent !== true || status.nativeDriverAccepted !== false
    || status.physicalQualificationAccepted !== false || status.activationEligible !== false
    || status.listenerAttemptsMade !== 0 || status.networkIoEventsObserved !== 0 || status.runtimeWired !== false
    || status.externalEffectOccurred !== false || status.automaticRetryAllowed !== false
    || status.grantsApproval !== false || status.grantsNetworkAuthority !== false
    || status.grantsCommandAuthority !== false || status.grantsLeaseAuthority !== false
    || status.grantsExecutionAuthority !== false || sha256Digest(unsigned) !== status.statusDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("invalid_status");
  }
  safePublicRecordV1(status, "physical native fake status", "invalid_status");
  return status;
}

function transitionV1(state: InternalDriverStateV1, next: ConnectionEnrollmentPrivateLoopbackPhysicalNativeStateV1):
void {
  state.state = next;
  state.transitionCount += 1;
  state.terminalStatus = undefined;
}

class RepositoryFakePhysicalNativeDriverV1 implements
ConnectionEnrollmentPrivateLoopbackPhysicalNativeFakeDriverV1 {
  constructor(contract: ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1,
    implementation: ConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1,
    scenario: ConnectionEnrollmentPrivateLoopbackPhysicalNativeFakeScenarioV1) {
    const port = fakePortV1(scenario);
    if (!weakSetContainsV1(internalPortsV1, port)) {
      throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("integrity_failed");
    }
    reflectApplyV1(weakSetAddV1, driversV1, [this]);
    reflectApplyV1(weakMapSetV1, driverStatesV1, [this, {
      contract,
      implementation,
      scenario,
      port,
      state: "created",
      prepareCalls: 0,
      startCalls: 0,
      statusCalls: 0,
      closeCalls: 0,
      recoverCalls: 0,
      transitionCount: 0,
      startConsumed: false,
      preEffectMarkerSimulated: false,
      bindCallSimulated: false,
      cleanupVerifiedSimulated: false,
      recoveryChecked: false,
    } satisfies InternalDriverStateV1]);
    objectFreezeV1(this);
  }

  async prepare(): Promise<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1> {
    const state = readDriverStateV1(this);
    state.prepareCalls += 1;
    if (state.state !== "created") {
      throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("sequence_conflict");
    }
    if (state.preparePromise) return await state.preparePromise;
    state.preparePromise = (async () => {
      await state.port.prepare();
      transitionV1(state, "prepared");
      return sealStatusV1(this);
    })();
    return await state.preparePromise;
  }

  async start(): Promise<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1> {
    const state = readDriverStateV1(this);
    state.startCalls += 1;
    if (state.startConsumed) {
      throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("start_already_consumed");
    }
    if (state.state !== "prepared") {
      throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("sequence_conflict");
    }
    state.startConsumed = true;
    state.preEffectMarkerSimulated = true;
    transitionV1(state, "starting");
    let result: InternalStartResultV1;
    try { result = await state.port.start(); }
    catch {
      state.bindCallSimulated = true;
      transitionV1(state, "ambiguous_after_marker");
      return sealStatusV1(this);
    }
    if (result === "failed_before_bind") {
      state.preEffectMarkerSimulated = false;
      transitionV1(state, "failed_before_bind");
    } else if (result === "ambiguous_after_marker") {
      state.bindCallSimulated = true;
      transitionV1(state, "ambiguous_after_marker");
    } else {
      state.bindCallSimulated = true;
      transitionV1(state, "listening");
    }
    return sealStatusV1(this);
  }

  status(): ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1 {
    return sealStatusV1(this, true);
  }

  async close(): Promise<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1> {
    const state = readDriverStateV1(this);
    state.closeCalls += 1;
    if (state.state === "recovery_checked" && state.terminalStatus) return state.terminalStatus;
    if (state.closePromise) return await state.closePromise;
    if (state.terminalStatus && (state.state === "closed" || state.state === "failed_before_bind"
      || state.state === "cleanup_failed"
      || state.state === "recovery_checked")) return state.terminalStatus;
    if (state.state === "failed_before_bind" || state.state === "cleanup_failed"
      || state.state === "recovery_checked") {
      state.terminalStatus = sealStatusV1(this);
      return state.terminalStatus;
    }
    if (state.state !== "listening" && state.state !== "ambiguous_after_marker") {
      throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("sequence_conflict");
    }
    const priorState = state.state;
    state.closePromise = (async () => {
      if (priorState === "listening") transitionV1(state, "draining");
      let result: InternalCloseResultV1;
      try { result = await state.port.close(); }
      catch { result = "cleanup_failed"; }
      if (result === "cleanup_failed") transitionV1(state, "cleanup_failed");
      else if (priorState === "ambiguous_after_marker") {
        state.cleanupVerifiedSimulated = true;
        state.terminalStatus = sealStatusV1(this);
        return state.terminalStatus;
      }
      else {
        state.cleanupVerifiedSimulated = true;
        transitionV1(state, "closed");
      }
      state.terminalStatus = sealStatusV1(this);
      return state.terminalStatus;
    })();
    return await state.closePromise;
  }

  async recover(): Promise<ConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1> {
    const state = readDriverStateV1(this);
    state.recoverCalls += 1;
    if (state.recoverPromise) return await state.recoverPromise;
    if (state.state === "recovery_checked" && state.terminalStatus) return state.terminalStatus;
    if (state.state !== "closed" && state.state !== "failed_before_bind"
      && state.state !== "ambiguous_after_marker" && state.state !== "cleanup_failed") {
      throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("recovery_not_terminal");
    }
    state.recoverPromise = (async () => {
      const result = await state.port.recover();
      const expected = state.state === "closed" ? "closed_verified" : state.state;
      if (result !== expected) {
        throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("integrity_failed");
      }
      state.recoveryChecked = true;
      transitionV1(state, "recovery_checked");
      state.terminalStatus = sealStatusV1(this);
      return state.terminalStatus;
    })();
    return await state.recoverPromise;
  }
}

for (const methodName of ["prepare", "start", "status", "close", "recover"] as const) {
  const method = RepositoryFakePhysicalNativeDriverV1.prototype[methodName];
  objectFreezeV1(method);
}
objectFreezeV1(RepositoryFakePhysicalNativeDriverV1.prototype);

export function createRepositoryFakeConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverV1(inputValue: unknown):
ConnectionEnrollmentPrivateLoopbackPhysicalNativeFakeDriverV1 {
  const input = exactHostDataSnapshotV1(inputValue, ["contract", "scenario"]);
  if (!input || !isScenarioV1(input.scenario)) {
    throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("invalid_configuration");
  }
  let contract: ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1;
  try { contract = parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1(input.contract); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("invalid_configuration"); }
  const implementation = describeConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1(contract);
  return new RepositoryFakePhysicalNativeDriverV1(contract, implementation, input.scenario);
}

export function assertConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusForDriverV1(
  driverValue: unknown,
  statusValue: unknown,
): void {
  const driver = readDriverStateV1(driverValue);
  const status = parseConnectionEnrollmentPrivateLoopbackPhysicalNativeStatusV1(statusValue);
  const origin = reflectApplyV1(weakMapGetV1, statusDriversV1, [status]) as object | undefined;
  if (origin !== driverValue || status.driverContractDigest !== driver.contract.contractDigest
    || status.implementationDigest !== driver.implementation.implementationDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("invalid_status");
  }
}

/*
 * Physical backend. It is intentionally unreachable in LIVE-120: there is no exported factory and no issuer adds
 * an object to nativeBindCapabilitiesV1. A later reviewed block must add the private broker/signer composition and
 * owner-spend path before this function can receive a valid capability. Tests exercise the same five-operation
 * lifecycle only through the exact repository fake above.
 */
type NativeBindCapabilityStateV1 = {
  port: number;
  contractDigest: string;
  implementationDigest: string;
  attemptReference: string;
  startDeadlineMs: number;
  admissionDeadlineMs: number;
  frameDeadlineMs: number;
  totalAttemptDeadlineMs: number;
  backpressureLowWaterBytes: number;
  backpressureHighWaterBytes: number;
  hardBufferedByteCeiling: number;
  spent: boolean;
  released: boolean;
  durableMarkerCommitted: true;
  ownerWindowSpent: true;
  exclusivePortEvidenceReady: true;
  tunnelPeerAuthenticated: true;
  hostKeyCustodyProven: true;
  platformSignerTrustAccepted: true;
};

const nativeBindCapabilitiesV1 = new WeakMap<object, NativeBindCapabilityStateV1>();

function createUnwiredNodeNetPortV1(capabilityValue: unknown,
  contract: ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1,
  implementation: ConnectionEnrollmentPrivateLoopbackPhysicalNativeImplementationV1): InternalDriverPortV1 {
  if (!capabilityValue || typeof capabilityValue !== "object" || isHostProxyV1(capabilityValue)
    || reflectOwnKeysV1(capabilityValue).length !== 0 || objectGetPrototypeOfV1(capabilityValue) !== null) {
    throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("native_activation_unavailable");
  }
  const capability = reflectApplyV1(weakMapGetV1, nativeBindCapabilitiesV1, [capabilityValue]) as
    NativeBindCapabilityStateV1 | undefined;
  if (!capability || capability.spent || capability.released || capability.durableMarkerCommitted !== true
    || capability.ownerWindowSpent !== true || capability.exclusivePortEvidenceReady !== true
    || capability.tunnelPeerAuthenticated !== true || capability.hostKeyCustodyProven !== true
    || capability.platformSignerTrustAccepted !== true || capability.contractDigest !== contract.contractDigest
    || capability.implementationDigest !== implementation.implementationDigest
    || typeof capability.attemptReference !== "string"
    || reflectApplyV1(regexpExecV1, nativeAttemptReferencePatternV1, [capability.attemptReference]) === null
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [capability.port])
    || capability.port < 1 || capability.port > 65_535
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [capability.startDeadlineMs])
    || capability.startDeadlineMs < 100 || capability.startDeadlineMs > contract.shutdownGraceMs
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [capability.admissionDeadlineMs])
    || capability.admissionDeadlineMs < 100 || capability.admissionDeadlineMs > contract.idleTimeoutMs
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [capability.frameDeadlineMs])
    || capability.frameDeadlineMs < 100 || capability.frameDeadlineMs > contract.maximumConnectionDurationMs
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [capability.totalAttemptDeadlineMs])
    || capability.totalAttemptDeadlineMs < 100
    || capability.totalAttemptDeadlineMs > contract.maximumConnectionDurationMs
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [capability.backpressureLowWaterBytes])
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [capability.backpressureHighWaterBytes])
    || !reflectApplyV1(numberIsSafeIntegerV1, Number, [capability.hardBufferedByteCeiling])
    || capability.backpressureLowWaterBytes < 0
    || capability.backpressureHighWaterBytes <= capability.backpressureLowWaterBytes
    || capability.hardBufferedByteCeiling < capability.backpressureHighWaterBytes
    || capability.hardBufferedByteCeiling > contract.maximumFrameBytes + 4) {
    throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("native_activation_unavailable");
  }

  let server: Server | undefined;
  let socket: Socket | undefined;
  let disposition: InternalRecoverResultV1 = "failed_before_bind";
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let admissionTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionCount = 0;
  let wireBytes = 0;
  let terminal = false;
  let listeningObserved = false;
  let ambiguousFailureObserved = false;
  const decoder = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1({
    listenerId: `private-loopback-listener:${reflectApplyV1(stringSliceV1, contract.contractDigest, [7])}`,
    transport: "ssh_tunnel",
    listenerVisibility: "private_loopback",
    addressFamily: "ipv4",
    bindAddress: literalIpv4LoopbackV1,
    framing: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
    maximumFrameBytes: contract.maximumFrameBytes,
    maximumChunks: contract.maximumChunks,
  });

  const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined): void => {
    if (timer !== undefined) reflectApplyV1(clearTimeoutV1, globalThis, [timer]);
  };
  const clearAllTimers = (): void => {
    clearTimer(startTimer);
    clearTimer(admissionTimer);
    clearTimer(connectionTimer);
    clearTimer(idleTimer);
    clearTimer(frameTimer);
    clearTimer(totalTimer);
    startTimer = admissionTimer = connectionTimer = idleTimer = frameTimer = totalTimer = undefined;
  };
  const destroySocket = (target: Socket | undefined): void => {
    if (target && !target.destroyed) reflectApplyV1(socketDestroyV1, target, []);
  };
  const failAfterMarker = (): void => {
    if (terminal) return;
    terminal = true;
    ambiguousFailureObserved = true;
    disposition = "ambiguous_after_marker";
    clearAllTimers();
    destroySocket(socket);
    if (server) {
      try { reflectApplyV1(serverCloseV1, server, []); } catch { disposition = "cleanup_failed"; }
    }
  };
  const resetIdleTimer = (): void => {
    clearTimer(idleTimer);
    idleTimer = reflectApplyV1(setTimeoutV1, globalThis,
      [failAfterMarker, contract.idleTimeoutMs]) as ReturnType<typeof setTimeout>;
  };
  const handleSocket = (candidate: Socket): void => {
    if (terminal || socket || connectionCount >= 1) {
      destroySocket(candidate);
      failAfterMarker();
      return;
    }
    socket = candidate;
    connectionCount += 1;
    clearTimer(admissionTimer);
    connectionTimer = reflectApplyV1(setTimeoutV1, globalThis,
      [failAfterMarker, contract.maximumConnectionDurationMs]) as ReturnType<typeof setTimeout>;
    frameTimer = reflectApplyV1(setTimeoutV1, globalThis,
      [failAfterMarker, capability.frameDeadlineMs]) as ReturnType<typeof setTimeout>;
    resetIdleTimer();
    reflectApplyV1(socketOnV1, candidate, ["data", (chunk: Buffer) => {
      if (terminal || candidate !== socket) return;
      wireBytes += chunk.byteLength;
      let paused = false;
      if (wireBytes >= capability.backpressureHighWaterBytes) {
        reflectApplyV1(socketPauseV1, candidate, []);
        paused = true;
      }
      if (wireBytes > capability.hardBufferedByteCeiling) {
        failAfterMarker();
        return;
      }
      try { decoder.push(new uint8ArrayConstructorV1(chunk)); }
      catch { failAfterMarker(); return; }
      resetIdleTimer();
      if (!terminal && paused && capability.backpressureLowWaterBytes >= 0) {
        reflectApplyV1(socketResumeV1, candidate, []);
      }
    }]);
    reflectApplyV1(socketOnV1, candidate, ["end", () => {
      if (terminal || candidate !== socket) return;
      try { decoder.finish(); }
      catch { failAfterMarker(); return; }
      clearTimer(connectionTimer);
      clearTimer(idleTimer);
      clearTimer(frameTimer);
      destroySocket(candidate);
    }]);
    reflectApplyV1(socketOnV1, candidate, ["error", failAfterMarker]);
  };

  const port = objectFreezeV1({
    mode: "node_net_unwired" as const,
    prepare: objectFreezeV1(async () => {
      if (capability.spent || capability.released) {
        throw new ConnectionEnrollmentPrivateLoopbackPhysicalNativeDriverErrorV1("native_activation_unavailable");
      }
    }),
    start: objectFreezeV1(async (): Promise<InternalStartResultV1> => {
      if (capability.spent || capability.released) return "failed_before_bind";
      capability.spent = true;
      disposition = "ambiguous_after_marker";
      return await new promiseConstructorV1<InternalStartResultV1>((resolve) => {
        let settled = false;
        const finish = (result: InternalStartResultV1): void => {
          if (settled) return;
          settled = true;
          clearTimer(startTimer);
          resolve(result);
        };
        try {
          server = reflectApplyV1(createServerV1, undefined, []) as Server;
          reflectApplyV1(serverOnV1, server, ["connection", handleSocket]);
          reflectApplyV1(serverOnceV1, server, ["error", () => {
            failAfterMarker();
            finish("ambiguous_after_marker");
          }]);
          startTimer = reflectApplyV1(setTimeoutV1, globalThis, [() => {
            failAfterMarker();
            finish("ambiguous_after_marker");
          }, capability.startDeadlineMs]) as
            ReturnType<typeof setTimeout>;
          totalTimer = reflectApplyV1(setTimeoutV1, globalThis,
            [failAfterMarker, capability.totalAttemptDeadlineMs]) as ReturnType<typeof setTimeout>;
          reflectApplyV1(serverListenV1, server, [{
            host: literalIpv4LoopbackV1,
            port: capability.port,
            exclusive: true,
            backlog: 1,
          }, () => {
            if (terminal || settled) return;
            listeningObserved = true;
            admissionTimer = reflectApplyV1(setTimeoutV1, globalThis,
              [failAfterMarker, capability.admissionDeadlineMs]) as ReturnType<typeof setTimeout>;
            finish("listening");
          }]);
        } catch {
          failAfterMarker();
          finish("ambiguous_after_marker");
        }
      });
    }),
    close: objectFreezeV1(async (): Promise<InternalCloseResultV1> => {
      if (terminal && disposition === "cleanup_failed") return "cleanup_failed";
      terminal = true;
      clearAllTimers();
      destroySocket(socket);
      if (server) {
        try {
          const closed = await new promiseConstructorV1<boolean>((resolve) => {
            let settled = false;
            const finish = (result: boolean): void => { if (!settled) { settled = true; resolve(result); } };
            const timer = reflectApplyV1(setTimeoutV1, globalThis,
              [() => finish(false), contract.shutdownGraceMs]) as
              ReturnType<typeof setTimeout>;
            reflectApplyV1(serverCloseV1, server!, [() => {
              reflectApplyV1(clearTimeoutV1, globalThis, [timer]);
              finish(true);
            }]);
          });
          if (!closed) {
            disposition = "cleanup_failed";
            capability.released = true;
            return "cleanup_failed";
          }
        } catch {
          disposition = "cleanup_failed";
          capability.released = true;
          return "cleanup_failed";
        }
      }
      capability.released = true;
      server = undefined;
      socket = undefined;
      disposition = listeningObserved && !ambiguousFailureObserved
        ? "closed_verified" : "ambiguous_after_marker";
      return "closed";
    }),
    recover: objectFreezeV1(async (): Promise<InternalRecoverResultV1> => disposition),
  });
  reflectApplyV1(weakSetAddV1, internalPortsV1, [port]);
  return port;
}

// Preserve the reviewed implementation in this isolated module without creating a runtime construction path.
void createUnwiredNodeNetPortV1;
