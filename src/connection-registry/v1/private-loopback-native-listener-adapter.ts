import { assertNoSecretMaterial, sha256Digest } from "../../security";
import {
  exactHostDataArrayV1,
  exactHostDataSnapshotV1,
} from "../../security/host-value";
import { assertConnectionEnrollmentNodeIngressRuntimeV1 } from "./node-ingress";
import {
  parseConnectionEnrollmentPrivateLoopbackListenerPlanV1,
  type ConnectionEnrollmentPrivateLoopbackListenerPlanV1,
} from "./private-loopback-listener-lifecycle";
import type { ConnectionEnrollmentPrivateLoopbackListenerPortV1 } from "./private-loopback-framing";

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_ADAPTER_V1 =
  "control-room-connection-enrollment-private-loopback-native-listener-adapter/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_READINESS_V1 =
  "control-room-connection-enrollment-private-loopback-native-listener-readiness/v1" as const;

const objectFreezeV1 = Object.freeze;
const objectGetPrototypeOfV1 = Object.getPrototypeOf;
const objectIsFrozenV1 = Object.isFrozen;
const regexpExecV1 = RegExp.prototype.exec;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;
const digestPatternV1 = /^sha256:[a-f0-9]{64}$/;
const listenerReferencePatternV1 = /^native-listener:[a-f0-9]{24}$/;
const readinessReferencePatternV1 = /^native-listener-readiness:[a-f0-9]{24}$/;
const nativeListenerReadinessRecordsV1 = new WeakSet<object>();
const nativeListenerAdaptersV1 = new WeakSet<object>();

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1 = objectFreezeV1([
  "native_driver_unaccepted",
  "owner_activation_missing",
  "platform_qualification_missing",
  "exclusive_port_evidence_missing",
  "tunnel_peer_evidence_missing",
  "host_key_custody_evidence_missing",
  "connection_deadline_evidence_missing",
  "idle_deadline_evidence_missing",
  "admission_deadline_evidence_missing",
  "backpressure_evidence_missing",
  "shutdown_cleanup_evidence_missing",
  "process_recovery_evidence_missing",
] as const);

export type ConnectionEnrollmentPrivateLoopbackNativeListenerBlockerV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1[number];

export type ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_READINESS_V1;
  readinessReference: string;
  adapterContract: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_ADAPTER_V1;
  listenerReference: string;
  listenerPlanDigest: string;
  transport: "ssh_tunnel";
  listenerVisibility: "private_loopback";
  bindPolicy: "literal_ipv4_loopback_only";
  portPolicy: "private_and_unpublished";
  maximumConcurrentConnections: 1;
  maximumQueuedConnections: 0;
  oneFramePerConnection: true;
  automaticRestartAllowed: false;
  activationMode: "disabled";
  nativeDriverAccepted: false;
  ownerActivationAccepted: false;
  platformQualificationAccepted: false;
  exclusivePortOwnershipProven: false;
  tunnelPeerAuthenticated: false;
  hostKeyCustodyProven: false;
  connectionDeadlineProven: false;
  idleDeadlineProven: false;
  admissionDeadlineProven: false;
  backpressureProven: false;
  shutdownCleanupProven: false;
  processRecoveryProven: false;
  activationEligible: false;
  status: "blocked_before_native_listener";
  blockerCodes: readonly ConnectionEnrollmentPrivateLoopbackNativeListenerBlockerV1[];
  listenerEnabled: false;
  listenerAttemptsMade: 0;
  networkIoEventsObserved: 0;
  automaticRetryAllowed: false;
  opensListener: false;
  performsNetworkIo: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  readinessDigest: string;
}>;

export class ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_configuration" | "invalid_readiness" | "disabled" |
    "integrity_failed") {
    super(safeCode);
    this.name = "ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1";
  }
}

function patternMatchesV1(pattern: RegExp, value: string): boolean {
  return reflectApplyV1(regexpExecV1, pattern, [value]) !== null;
}

function readinessReferenceV1(planDigest: string): string {
  return `native-listener-readiness:${reflectApplyV1(stringSliceV1, planDigest, [7, 31])}`;
}

function listenerReferenceV1(plan: ConnectionEnrollmentPrivateLoopbackListenerPlanV1): string {
  const digest = sha256Digest({ listenerId: plan.listenerId, listenerPlanDigest: plan.planDigest });
  return `native-listener:${reflectApplyV1(stringSliceV1, digest, [7, 31])}`;
}

function weakSetContainsV1(set: WeakSet<object>, value: unknown): value is object {
  return value !== null && typeof value === "object" && reflectApplyV1(weakSetHasV1, set, [value]);
}

function assertAdapterRuntimeV1(code: ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1["safeCode"]):
void {
  try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1(code); }
}

function parsePlanV1(value: unknown): ConnectionEnrollmentPrivateLoopbackListenerPlanV1 {
  try { return parseConnectionEnrollmentPrivateLoopbackListenerPlanV1(value); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("invalid_configuration"); }
}

function materialForPlanV1(plan: ConnectionEnrollmentPrivateLoopbackListenerPlanV1) {
  return {
    contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_READINESS_V1,
    readinessReference: readinessReferenceV1(plan.planDigest),
    adapterContract: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_ADAPTER_V1,
    listenerReference: listenerReferenceV1(plan),
    listenerPlanDigest: plan.planDigest,
    transport: "ssh_tunnel" as const,
    listenerVisibility: "private_loopback" as const,
    bindPolicy: "literal_ipv4_loopback_only" as const,
    portPolicy: "private_and_unpublished" as const,
    maximumConcurrentConnections: 1 as const,
    maximumQueuedConnections: 0 as const,
    oneFramePerConnection: true as const,
    automaticRestartAllowed: false as const,
    activationMode: "disabled" as const,
    nativeDriverAccepted: false as const,
    ownerActivationAccepted: false as const,
    platformQualificationAccepted: false as const,
    exclusivePortOwnershipProven: false as const,
    tunnelPeerAuthenticated: false as const,
    hostKeyCustodyProven: false as const,
    connectionDeadlineProven: false as const,
    idleDeadlineProven: false as const,
    admissionDeadlineProven: false as const,
    backpressureProven: false as const,
    shutdownCleanupProven: false as const,
    processRecoveryProven: false as const,
    activationEligible: false as const,
    status: "blocked_before_native_listener" as const,
    blockerCodes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1,
    listenerEnabled: false as const,
    listenerAttemptsMade: 0 as const,
    networkIoEventsObserved: 0 as const,
    automaticRetryAllowed: false as const,
    opensListener: false as const,
    performsNetworkIo: false as const,
    grantsApproval: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
}

export function createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(planValue: unknown):
ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1 {
  assertAdapterRuntimeV1("invalid_configuration");
  const plan = parsePlanV1(planValue), material = materialForPlanV1(plan);
  try { assertNoSecretMaterial(material, "private loopback native listener readiness"); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("invalid_configuration"); }
  const readiness = objectFreezeV1({ ...material, readinessDigest: sha256Digest(material) });
  reflectApplyV1(weakSetAddV1, nativeListenerReadinessRecordsV1, [readiness]);
  return readiness;
}

const readinessKeysV1 = [
  "contractVersion", "readinessReference", "adapterContract", "listenerReference", "listenerPlanDigest", "transport",
  "listenerVisibility", "bindPolicy", "portPolicy", "maximumConcurrentConnections", "maximumQueuedConnections",
  "oneFramePerConnection", "automaticRestartAllowed", "activationMode", "nativeDriverAccepted",
  "ownerActivationAccepted", "platformQualificationAccepted", "exclusivePortOwnershipProven",
  "tunnelPeerAuthenticated", "hostKeyCustodyProven", "connectionDeadlineProven", "idleDeadlineProven",
  "admissionDeadlineProven", "backpressureProven", "shutdownCleanupProven", "processRecoveryProven",
  "activationEligible", "status", "blockerCodes", "listenerEnabled", "listenerAttemptsMade",
  "networkIoEventsObserved", "automaticRetryAllowed", "opensListener", "performsNetworkIo", "grantsApproval",
  "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
  "readinessDigest",
] as const;

export function parseConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1 {
  assertAdapterRuntimeV1("invalid_readiness");
  if (!weakSetContainsV1(nativeListenerReadinessRecordsV1, value) || !objectIsFrozenV1(value)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("invalid_readiness");
  }
  const captured = exactHostDataSnapshotV1(value, readinessKeysV1);
  if (!captured) throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("invalid_readiness");
  const blockers = exactHostDataArrayV1(captured.blockerCodes,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1.length);
  if (!blockers || blockers.length !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1.length) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("invalid_readiness");
  }
  for (let index = 0; index < CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1.length;
    index += 1) {
    if (blockers[index] !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1[index]) {
      throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("invalid_readiness");
    }
  }
  if (captured.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_READINESS_V1
    || captured.adapterContract !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_ADAPTER_V1
    || typeof captured.listenerReference !== "string"
    || !patternMatchesV1(listenerReferencePatternV1, captured.listenerReference)
    || typeof captured.listenerPlanDigest !== "string"
    || !patternMatchesV1(digestPatternV1, captured.listenerPlanDigest)
    || typeof captured.readinessReference !== "string"
    || !patternMatchesV1(readinessReferencePatternV1, captured.readinessReference)
    || captured.readinessReference !== readinessReferenceV1(captured.listenerPlanDigest)
    || captured.transport !== "ssh_tunnel" || captured.listenerVisibility !== "private_loopback"
    || captured.bindPolicy !== "literal_ipv4_loopback_only"
    || captured.portPolicy !== "private_and_unpublished"
    || captured.maximumConcurrentConnections !== 1 || captured.maximumQueuedConnections !== 0
    || captured.oneFramePerConnection !== true || captured.automaticRestartAllowed !== false
    || captured.activationMode !== "disabled" || captured.nativeDriverAccepted !== false
    || captured.ownerActivationAccepted !== false || captured.platformQualificationAccepted !== false
    || captured.exclusivePortOwnershipProven !== false || captured.tunnelPeerAuthenticated !== false
    || captured.hostKeyCustodyProven !== false || captured.connectionDeadlineProven !== false
    || captured.idleDeadlineProven !== false || captured.admissionDeadlineProven !== false
    || captured.backpressureProven !== false || captured.shutdownCleanupProven !== false
    || captured.processRecoveryProven !== false || captured.activationEligible !== false
    || captured.status !== "blocked_before_native_listener" || captured.listenerEnabled !== false
    || captured.listenerAttemptsMade !== 0 || captured.networkIoEventsObserved !== 0
    || captured.automaticRetryAllowed !== false || captured.opensListener !== false
    || captured.performsNetworkIo !== false || captured.grantsApproval !== false
    || captured.grantsNetworkAuthority !== false || captured.grantsCommandAuthority !== false
    || captured.grantsLeaseAuthority !== false || captured.grantsExecutionAuthority !== false
    || typeof captured.readinessDigest !== "string" || !patternMatchesV1(digestPatternV1, captured.readinessDigest)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("invalid_readiness");
  }
  const material: Record<string, unknown> = {
    ...captured,
    blockerCodes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1,
  };
  delete material.readinessDigest;
  if (sha256Digest(material) !== captured.readinessDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("invalid_readiness");
  }
  try { assertNoSecretMaterial(material, "private loopback native listener readiness"); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("invalid_readiness"); }
  return value as ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1;
}

/**
 * The first native-listener adapter boundary is deliberately incapable of
 * opening a listener. It owns no native driver and accepts no activation
 * evidence. A later block must introduce and independently review both.
 */
export class DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1 implements
ConnectionEnrollmentPrivateLoopbackListenerPortV1 {
  readonly enabled = false;
  readonly #readiness: ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1;

  constructor(planValue: unknown) {
    if (new.target !== DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1) {
      throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("invalid_configuration");
    }
    this.#readiness = createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(planValue);
    reflectApplyV1(weakSetAddV1, nativeListenerAdaptersV1, [this]);
    objectFreezeV1(this);
  }

  status(): ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1 {
    assertExactNativeListenerAdapterReceiverV1(this);
    return this.#readiness;
  }

  async start(): Promise<void> {
    assertExactNativeListenerAdapterReceiverV1(this);
    throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("disabled");
  }

  async close(): Promise<void> { assertExactNativeListenerAdapterReceiverV1(this); }
}

const nativeListenerAdapterPrototypeV1 =
  DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1.prototype;
const nativeListenerAdapterStatusV1 = nativeListenerAdapterPrototypeV1.status;
const nativeListenerAdapterStartV1 = nativeListenerAdapterPrototypeV1.start;
const nativeListenerAdapterCloseV1 = nativeListenerAdapterPrototypeV1.close;
objectFreezeV1(nativeListenerAdapterPrototypeV1);

function isExactNativeListenerAdapterV1(value: unknown):
value is DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1 {
  return weakSetContainsV1(nativeListenerAdaptersV1, value)
    && objectGetPrototypeOfV1(value) === nativeListenerAdapterPrototypeV1
    && objectIsFrozenV1(value);
}

function assertExactNativeListenerAdapterReceiverV1(value: unknown): asserts value is
DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1 {
  if (!isExactNativeListenerAdapterV1(value)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("integrity_failed");
  }
}

export type BoundDefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1 = Readonly<{
  enabled: false;
  status: () => ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1;
  start: () => Promise<void>;
  close: () => Promise<void>;
}>;

/**
 * Future composition must consume the adapter through this exact-brand binder.
 * The binder rejects lookalikes and returns frozen closures over captured base
 * operations, so consumer dispatch cannot be redirected through caller methods.
 */
export function bindDefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1(value: unknown):
BoundDefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1 {
  assertAdapterRuntimeV1("integrity_failed");
  assertExactNativeListenerAdapterReceiverV1(value);
  return objectFreezeV1({
    enabled: false,
    status: () => reflectApplyV1(nativeListenerAdapterStatusV1, value, []),
    start: () => reflectApplyV1(nativeListenerAdapterStartV1, value, []),
    close: () => reflectApplyV1(nativeListenerAdapterCloseV1, value, []),
  });
}
