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
const regexpExecV1 = RegExp.prototype.exec;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const digestPatternV1 = /^sha256:[a-f0-9]{64}$/;
const listenerIdPatternV1 = /^private-loopback-listener:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const readinessReferencePatternV1 = /^native-listener-readiness:[a-f0-9]{24}$/;

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
  listenerId: string;
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
    listenerId: plan.listenerId,
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
  assertNoSecretMaterial(material, "private loopback native listener readiness");
  return objectFreezeV1({ ...material, readinessDigest: sha256Digest(material) });
}

const readinessKeysV1 = [
  "contractVersion", "readinessReference", "adapterContract", "listenerId", "listenerPlanDigest", "transport",
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
    || typeof captured.listenerId !== "string" || captured.listenerId.length < 27
    || captured.listenerId.length > 160 || !patternMatchesV1(listenerIdPatternV1, captured.listenerId)
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
  return objectFreezeV1({ ...material, readinessDigest: captured.readinessDigest }) as
    ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1;
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
    this.#readiness = createConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(planValue);
  }

  status(): ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1 {
    return this.#readiness;
  }

  async start(): Promise<void> {
    throw new ConnectionEnrollmentPrivateLoopbackNativeListenerAdapterErrorV1("disabled");
  }

  async close(): Promise<void> {}
}
