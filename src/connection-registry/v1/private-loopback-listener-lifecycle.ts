import { NODE_PROTOCOL_MAX_FRAME_BYTES } from "../../node-protocol/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { exactHostDataSnapshotV1, exactHostErrorCodeV1 } from "../../security/host-value";
import { assertConnectionEnrollmentNodeIngressRuntimeV1 } from "./node-ingress";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
  parseConnectionEnrollmentPrivateLoopbackProtectedFrameV1,
  type ConnectionEnrollmentPrivateLoopbackProtectedFrameV1,
} from "./private-loopback-framing";

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_PLAN_V1 =
  "control-room-connection-enrollment-private-loopback-listener-plan/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_REHEARSAL_V1 =
  "control-room-connection-enrollment-private-loopback-listener-rehearsal/v1" as const;

const digestPatternV1 = /^sha256:[a-f0-9]{64}$/;
const listenerIdPatternV1 = /^private-loopback-listener:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const rehearsalReferencePatternV1 = /^listener-rehearsal:[a-f0-9]{24}$/;
const objectFreezeV1 = Object.freeze;
const numberIsSafeIntegerV1 = Number.isSafeInteger;
const reflectApplyV1 = Reflect.apply;
const regexpExecV1 = RegExp.prototype.exec;
const stringSliceV1 = String.prototype.slice;

function patternMatchesV1(pattern: RegExp, value: string): boolean {
  return reflectApplyV1(regexpExecV1, pattern, [value]) !== null;
}

function isDigestV1(value: unknown): value is string {
  return typeof value === "string" && patternMatchesV1(digestPatternV1, value);
}

export type ConnectionEnrollmentPrivateLoopbackListenerPlanConfigurationV1 = Readonly<{
  listenerId: string;
  endpointIdentityDigest: string;
  ownerIdentityDigest: string;
  tunnelPeerIdentityDigest: string;
  tunnelHostKeyDigest: string;
  channelIdentityDigest: string;
  maximumFrameBytes: number;
  maximumChunks: number;
  maximumConnectionDurationMs: number;
  idleTimeoutMs: number;
  shutdownGraceMs: number;
}>;

export type ConnectionEnrollmentPrivateLoopbackListenerPlanV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_PLAN_V1;
  listenerId: string;
  transport: "ssh_tunnel";
  listenerVisibility: "private_loopback";
  addressFamily: "ipv4";
  bindAddress: "127.0.0.1";
  framing: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1;
  endpointIdentityDigest: string;
  ownerIdentityDigest: string;
  tunnelPeerIdentityDigest: string;
  tunnelHostKeyDigest: string;
  channelIdentityDigest: string;
  maximumFrameBytes: number;
  maximumChunks: number;
  maximumConcurrentConnections: 1;
  maximumQueuedConnections: 0;
  maximumConnectionDurationMs: number;
  idleTimeoutMs: number;
  shutdownGraceMs: number;
  oneFramePerConnection: true;
  automaticRestartAllowed: false;
  effectMode: "repository_fake_only";
  opensListener: false;
  performsNetworkIo: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  planDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_REHEARSAL_V1;
  rehearsalReference: string;
  listenerId: string;
  planDigest: string;
  evidenceMode: "repository_fake";
  disposition: "passed";
  eventCount: 6;
  frameDigest: string;
  frameBytes: number;
  frameChunks: number;
  maximumObservedConcurrentConnections: 1;
  maximumObservedQueuedConnections: 0;
  bindPolicyMatched: true;
  capacityPolicyMatched: true;
  tunnelPolicyMatched: true;
  framePolicyMatched: true;
  cleanupPolicyMatched: true;
  actualBindObserved: false;
  exclusivePortOwnershipProven: false;
  tunnelPeerAuthenticated: false;
  hostKeyCustodyProven: false;
  nativeCleanupEvidenceAccepted: false;
  listenerEnabled: false;
  opensListener: false;
  performsNetworkIo: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}>;

export class ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_configuration" | "invalid_plan" | "invalid_observation" |
    "sequence_conflict" | "bind_identity_mismatch" | "tunnel_identity_mismatch" |
    "capacity_exceeded" | "lifetime_exceeded" | "frame_rejected" | "cleanup_failed" |
    "incomplete_lifecycle" | "state_conflict" | "integrity_failed") {
    super(safeCode);
    this.name = "ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1";
  }
}

const lifecycleErrorPrototypeV1 = ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1.prototype;

function isLifecycleSafeCodeV1(value: string | undefined):
value is ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1["safeCode"] {
  return value === "invalid_configuration" || value === "invalid_plan" || value === "invalid_observation"
    || value === "sequence_conflict" || value === "bind_identity_mismatch"
    || value === "tunnel_identity_mismatch" || value === "capacity_exceeded"
    || value === "lifetime_exceeded" || value === "frame_rejected" || value === "cleanup_failed"
    || value === "incomplete_lifecycle" || value === "state_conflict" || value === "integrity_failed";
}

function validatePlanLimitsV1(value: Record<string, unknown>): boolean {
  return numberIsSafeIntegerV1(value.maximumFrameBytes)
    && (value.maximumFrameBytes as number) >= 4_096
    && (value.maximumFrameBytes as number) <= NODE_PROTOCOL_MAX_FRAME_BYTES
    && numberIsSafeIntegerV1(value.maximumChunks)
    && (value.maximumChunks as number) >= 1 && (value.maximumChunks as number) <= 4_096
    && numberIsSafeIntegerV1(value.maximumConnectionDurationMs)
    && (value.maximumConnectionDurationMs as number) >= 1_000
    && (value.maximumConnectionDurationMs as number) <= 300_000
    && numberIsSafeIntegerV1(value.idleTimeoutMs)
    && (value.idleTimeoutMs as number) >= 100
    && (value.idleTimeoutMs as number) <= (value.maximumConnectionDurationMs as number)
    && numberIsSafeIntegerV1(value.shutdownGraceMs)
    && (value.shutdownGraceMs as number) >= 100
    && (value.shutdownGraceMs as number) <= 30_000
    && (value.shutdownGraceMs as number) <= (value.maximumConnectionDurationMs as number);
}

function unsignedPlanV1(value: ConnectionEnrollmentPrivateLoopbackListenerPlanV1):
Omit<ConnectionEnrollmentPrivateLoopbackListenerPlanV1, "planDigest"> {
  const { planDigest: _planDigest, ...unsigned } = value;
  void _planDigest;
  return unsigned;
}

function assertPublicSafeV1(value: unknown, label: string,
  errorCode: ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1["safeCode"]): void {
  try { assertNoSecretMaterial(value, label); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1(errorCode); }
}

function assertListenerLifecycleRuntimeV1(
  errorCode: ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1["safeCode"],
): void {
  try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1(errorCode); }
}

export function createConnectionEnrollmentPrivateLoopbackListenerPlanV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackListenerPlanV1 {
  assertListenerLifecycleRuntimeV1("invalid_configuration");
  const captured = exactHostDataSnapshotV1(value, ["listenerId", "endpointIdentityDigest", "ownerIdentityDigest",
    "tunnelPeerIdentityDigest", "tunnelHostKeyDigest", "channelIdentityDigest", "maximumFrameBytes", "maximumChunks",
    "maximumConnectionDurationMs", "idleTimeoutMs", "shutdownGraceMs"]);
  if (!captured || typeof captured.listenerId !== "string" || captured.listenerId.length < 27
    || captured.listenerId.length > 160 || !patternMatchesV1(listenerIdPatternV1, captured.listenerId)
    || !isDigestV1(captured.endpointIdentityDigest) || !isDigestV1(captured.ownerIdentityDigest)
    || !isDigestV1(captured.tunnelPeerIdentityDigest) || !isDigestV1(captured.tunnelHostKeyDigest)
    || !isDigestV1(captured.channelIdentityDigest) || !validatePlanLimitsV1(captured)) {
    throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1("invalid_configuration");
  }
  const material = {
    contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_PLAN_V1,
    listenerId: captured.listenerId,
    transport: "ssh_tunnel" as const,
    listenerVisibility: "private_loopback" as const,
    addressFamily: "ipv4" as const,
    bindAddress: "127.0.0.1" as const,
    framing: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
    endpointIdentityDigest: captured.endpointIdentityDigest,
    ownerIdentityDigest: captured.ownerIdentityDigest,
    tunnelPeerIdentityDigest: captured.tunnelPeerIdentityDigest,
    tunnelHostKeyDigest: captured.tunnelHostKeyDigest,
    channelIdentityDigest: captured.channelIdentityDigest,
    maximumFrameBytes: captured.maximumFrameBytes,
    maximumChunks: captured.maximumChunks,
    maximumConcurrentConnections: 1 as const,
    maximumQueuedConnections: 0 as const,
    maximumConnectionDurationMs: captured.maximumConnectionDurationMs,
    idleTimeoutMs: captured.idleTimeoutMs,
    shutdownGraceMs: captured.shutdownGraceMs,
    oneFramePerConnection: true as const,
    automaticRestartAllowed: false as const,
    effectMode: "repository_fake_only" as const,
    opensListener: false as const,
    performsNetworkIo: false as const,
    grantsApproval: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  assertPublicSafeV1(material, "private loopback listener plan", "invalid_configuration");
  return parseConnectionEnrollmentPrivateLoopbackListenerPlanV1({
    ...material,
    planDigest: sha256Digest(material),
  });
}

export function parseConnectionEnrollmentPrivateLoopbackListenerPlanV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackListenerPlanV1 {
  assertListenerLifecycleRuntimeV1("invalid_plan");
  const captured = exactHostDataSnapshotV1(value, ["contractVersion", "listenerId", "transport",
    "listenerVisibility", "addressFamily", "bindAddress", "framing", "endpointIdentityDigest",
    "ownerIdentityDigest", "tunnelPeerIdentityDigest", "tunnelHostKeyDigest", "channelIdentityDigest",
    "maximumFrameBytes", "maximumChunks", "maximumConcurrentConnections", "maximumQueuedConnections",
    "maximumConnectionDurationMs", "idleTimeoutMs", "shutdownGraceMs", "oneFramePerConnection",
    "automaticRestartAllowed", "effectMode", "opensListener", "performsNetworkIo", "grantsApproval",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "planDigest"]);
  if (!captured) throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1("invalid_plan");
  const plan = captured as unknown as ConnectionEnrollmentPrivateLoopbackListenerPlanV1;
  if (plan.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_PLAN_V1
    || typeof plan.listenerId !== "string" || plan.listenerId.length < 27 || plan.listenerId.length > 160
    || !patternMatchesV1(listenerIdPatternV1, plan.listenerId)
    || plan.transport !== "ssh_tunnel" || plan.listenerVisibility !== "private_loopback"
    || plan.addressFamily !== "ipv4" || plan.bindAddress !== "127.0.0.1"
    || plan.framing !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1
    || !isDigestV1(plan.endpointIdentityDigest) || !isDigestV1(plan.ownerIdentityDigest)
    || !isDigestV1(plan.tunnelPeerIdentityDigest) || !isDigestV1(plan.tunnelHostKeyDigest)
    || !isDigestV1(plan.channelIdentityDigest) || !validatePlanLimitsV1(plan)
    || plan.maximumConcurrentConnections !== 1 || plan.maximumQueuedConnections !== 0
    || plan.oneFramePerConnection !== true || plan.automaticRestartAllowed !== false
    || plan.effectMode !== "repository_fake_only" || plan.opensListener !== false
    || plan.performsNetworkIo !== false || plan.grantsApproval !== false
    || plan.grantsNetworkAuthority !== false || plan.grantsCommandAuthority !== false
    || plan.grantsLeaseAuthority !== false || plan.grantsExecutionAuthority !== false
    || !isDigestV1(plan.planDigest) || sha256Digest(unsignedPlanV1(plan)) !== plan.planDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1("invalid_plan");
  }
  assertPublicSafeV1(plan, "private loopback listener plan", "invalid_plan");
  return objectFreezeV1(plan);
}

function unsignedReceiptV1(value: ConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1):
Omit<ConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = value;
  void _receiptDigest;
  return unsigned;
}

export function parseConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1 {
  assertListenerLifecycleRuntimeV1("integrity_failed");
  const captured = exactHostDataSnapshotV1(value, ["contractVersion", "rehearsalReference", "listenerId",
    "planDigest", "evidenceMode", "disposition", "eventCount", "frameDigest", "frameBytes", "frameChunks",
    "maximumObservedConcurrentConnections", "maximumObservedQueuedConnections", "bindPolicyMatched",
    "capacityPolicyMatched", "tunnelPolicyMatched", "framePolicyMatched", "cleanupPolicyMatched",
    "actualBindObserved", "exclusivePortOwnershipProven", "tunnelPeerAuthenticated", "hostKeyCustodyProven",
    "nativeCleanupEvidenceAccepted", "listenerEnabled", "opensListener", "performsNetworkIo", "grantsApproval",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "receiptDigest"]);
  if (!captured) throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1("integrity_failed");
  const receipt = captured as unknown as ConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1;
  if (receipt.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_REHEARSAL_V1
    || typeof receipt.rehearsalReference !== "string"
    || !patternMatchesV1(rehearsalReferencePatternV1, receipt.rehearsalReference)
    || typeof receipt.listenerId !== "string" || !patternMatchesV1(listenerIdPatternV1, receipt.listenerId)
    || !isDigestV1(receipt.planDigest) || receipt.evidenceMode !== "repository_fake"
    || receipt.disposition !== "passed" || receipt.eventCount !== 6 || !isDigestV1(receipt.frameDigest)
    || !numberIsSafeIntegerV1(receipt.frameBytes) || receipt.frameBytes < 2
    || receipt.frameBytes > NODE_PROTOCOL_MAX_FRAME_BYTES
    || !numberIsSafeIntegerV1(receipt.frameChunks) || receipt.frameChunks < 1 || receipt.frameChunks > 4_096
    || receipt.maximumObservedConcurrentConnections !== 1 || receipt.maximumObservedQueuedConnections !== 0
    || receipt.bindPolicyMatched !== true || receipt.capacityPolicyMatched !== true
    || receipt.tunnelPolicyMatched !== true || receipt.framePolicyMatched !== true
    || receipt.cleanupPolicyMatched !== true || receipt.actualBindObserved !== false
    || receipt.exclusivePortOwnershipProven !== false || receipt.tunnelPeerAuthenticated !== false
    || receipt.hostKeyCustodyProven !== false || receipt.nativeCleanupEvidenceAccepted !== false
    || receipt.listenerEnabled !== false || receipt.opensListener !== false || receipt.performsNetworkIo !== false
    || receipt.grantsApproval !== false || receipt.grantsNetworkAuthority !== false
    || receipt.grantsCommandAuthority !== false || receipt.grantsLeaseAuthority !== false
    || receipt.grantsExecutionAuthority !== false || !isDigestV1(receipt.receiptDigest)
    || sha256Digest(unsignedReceiptV1(receipt)) !== receipt.receiptDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1("integrity_failed");
  }
  assertPublicSafeV1(receipt, "private loopback listener rehearsal receipt", "integrity_failed");
  return objectFreezeV1(receipt);
}

function requireObservationV1(value: unknown, keys: readonly string[], plan:
ConnectionEnrollmentPrivateLoopbackListenerPlanV1, sequence: number): Record<string, unknown> {
  const captured = exactHostDataSnapshotV1(value, keys);
  if (!captured || captured.sequence !== sequence || captured.listenerId !== plan.listenerId
    || captured.planDigest !== plan.planDigest || captured.evidenceMode !== "repository_fake"
    || captured.nativeEvidenceAccepted !== false) {
    throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1(
      captured && captured.sequence !== sequence ? "sequence_conflict" : "invalid_observation",
    );
  }
  return captured;
}

type ConnectionEnrollmentPrivateLoopbackListenerRehearsalStateV1 =
  "planned" | "bound" | "connected" | "framed" | "connection_closed" | "draining" | "closed" | "complete" |
  "failed";

/**
 * Effect-free lifecycle rehearsal. It invokes no adapter and accepts only
 * repository-fake observations; a passing receipt explicitly proves no native
 * bind, tunnel authentication, port ownership, or cleanup evidence.
 */
export class ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1 {
  readonly #plan: ConnectionEnrollmentPrivateLoopbackListenerPlanV1;
  #state: ConnectionEnrollmentPrivateLoopbackListenerRehearsalStateV1 = "planned";
  #frame: ConnectionEnrollmentPrivateLoopbackProtectedFrameV1 | undefined;
  #frameChunks: number | undefined;
  #lastConnectionAgeMs: number | undefined;
  #drainElapsedMs: number | undefined;

  constructor(planValue: unknown) {
    this.#plan = parseConnectionEnrollmentPrivateLoopbackListenerPlanV1(planValue);
  }

  observeBind(value: unknown): void {
    this.#requireState("planned");
    try {
      const observation = requireObservationV1(value, ["sequence", "listenerId", "planDigest", "evidenceMode",
        "observedAddress", "observedAddressFamily", "endpointIdentityDigest", "ownerIdentityDigest",
        "simulatedExclusiveOwnership", "nativeEvidenceAccepted"], this.#plan, 1);
      if (observation.observedAddress !== "127.0.0.1" || observation.observedAddressFamily !== "ipv4"
        || observation.endpointIdentityDigest !== this.#plan.endpointIdentityDigest
        || observation.ownerIdentityDigest !== this.#plan.ownerIdentityDigest
        || observation.simulatedExclusiveOwnership !== true) this.#fail("bind_identity_mismatch");
      this.#state = "bound";
    } catch (error) { this.#mapFailure(error); }
  }

  observeConnectionOpen(value: unknown): void {
    this.#requireState("bound");
    try {
      const observation = requireObservationV1(value, ["sequence", "listenerId", "planDigest", "evidenceMode",
        "activeConnections", "queuedConnections", "tunnelPeerIdentityDigest", "tunnelHostKeyDigest",
        "channelIdentityDigest", "simulatedTunnelAuthenticated", "nativeEvidenceAccepted"], this.#plan, 2);
      if (observation.activeConnections !== 1 || observation.queuedConnections !== 0) {
        this.#fail("capacity_exceeded");
      }
      if (observation.tunnelPeerIdentityDigest !== this.#plan.tunnelPeerIdentityDigest
        || observation.tunnelHostKeyDigest !== this.#plan.tunnelHostKeyDigest
        || observation.channelIdentityDigest !== this.#plan.channelIdentityDigest
        || observation.simulatedTunnelAuthenticated !== true) this.#fail("tunnel_identity_mismatch");
      this.#state = "connected";
    } catch (error) { this.#mapFailure(error); }
  }

  observeFrameComplete(value: unknown): void {
    this.#requireState("connected");
    try {
      const observation = requireObservationV1(value, ["sequence", "listenerId", "planDigest", "evidenceMode",
        "activeConnections", "queuedConnections", "connectionAgeMs", "idleAgeMs", "frameChunks", "protectedFrame",
        "nativeEvidenceAccepted"], this.#plan, 3);
      if (observation.activeConnections !== 1 || observation.queuedConnections !== 0) {
        this.#fail("capacity_exceeded");
      }
      if (!numberIsSafeIntegerV1(observation.connectionAgeMs) || (observation.connectionAgeMs as number) < 0
        || (observation.connectionAgeMs as number) > this.#plan.maximumConnectionDurationMs
        || !numberIsSafeIntegerV1(observation.idleAgeMs) || (observation.idleAgeMs as number) < 0
        || (observation.idleAgeMs as number) > this.#plan.idleTimeoutMs
        || (observation.idleAgeMs as number) > (observation.connectionAgeMs as number)) {
        this.#fail("lifetime_exceeded");
      }
      if (!numberIsSafeIntegerV1(observation.frameChunks) || (observation.frameChunks as number) < 1
        || (observation.frameChunks as number) > this.#plan.maximumChunks) this.#fail("frame_rejected");
      let frame: ConnectionEnrollmentPrivateLoopbackProtectedFrameV1;
      try { frame = parseConnectionEnrollmentPrivateLoopbackProtectedFrameV1(observation.protectedFrame); }
      catch { this.#fail("frame_rejected"); }
      if (frame.listenerId !== this.#plan.listenerId || frame.frameBytes > this.#plan.maximumFrameBytes) {
        this.#fail("frame_rejected");
      }
      this.#frame = frame;
      this.#frameChunks = observation.frameChunks as number;
      this.#lastConnectionAgeMs = observation.connectionAgeMs as number;
      this.#state = "framed";
    } catch (error) { this.#mapFailure(error); }
  }

  observeConnectionClose(value: unknown): void {
    this.#requireState("framed");
    try {
      const observation = requireObservationV1(value, ["sequence", "listenerId", "planDigest", "evidenceMode",
        "activeConnections", "queuedConnections", "connectionAgeMs", "nativeEvidenceAccepted"], this.#plan, 4);
      if (observation.activeConnections !== 0 || observation.queuedConnections !== 0) {
        this.#fail("capacity_exceeded");
      }
      if (!numberIsSafeIntegerV1(observation.connectionAgeMs) || (observation.connectionAgeMs as number) < 0
        || (observation.connectionAgeMs as number) > this.#plan.maximumConnectionDurationMs
        || this.#lastConnectionAgeMs === undefined
        || (observation.connectionAgeMs as number) < this.#lastConnectionAgeMs) {
        this.#fail("lifetime_exceeded");
      }
      this.#state = "connection_closed";
    } catch (error) { this.#mapFailure(error); }
  }

  observeDrainStart(value: unknown): void {
    this.#requireState("connection_closed");
    try {
      const observation = requireObservationV1(value, ["sequence", "listenerId", "planDigest", "evidenceMode",
        "activeConnections", "queuedConnections", "shutdownElapsedMs", "automaticRestartAttempted",
        "nativeEvidenceAccepted"], this.#plan, 5);
      if (observation.activeConnections !== 0 || observation.queuedConnections !== 0) {
        this.#fail("capacity_exceeded");
      }
      if (!numberIsSafeIntegerV1(observation.shutdownElapsedMs) || (observation.shutdownElapsedMs as number) < 0
        || (observation.shutdownElapsedMs as number) > this.#plan.shutdownGraceMs
        || observation.automaticRestartAttempted !== false) this.#fail("cleanup_failed");
      this.#drainElapsedMs = observation.shutdownElapsedMs as number;
      this.#state = "draining";
    } catch (error) { this.#mapFailure(error); }
  }

  observeListenerClose(value: unknown): void {
    this.#requireState("draining");
    try {
      const observation = requireObservationV1(value, ["sequence", "listenerId", "planDigest", "evidenceMode",
        "activeConnections", "queuedConnections", "shutdownElapsedMs", "simulatedCleanupConfirmed",
        "nativeEvidenceAccepted"], this.#plan, 6);
      if (observation.activeConnections !== 0 || observation.queuedConnections !== 0) {
        this.#fail("capacity_exceeded");
      }
      if (!numberIsSafeIntegerV1(observation.shutdownElapsedMs) || (observation.shutdownElapsedMs as number) < 0
        || (observation.shutdownElapsedMs as number) > this.#plan.shutdownGraceMs
        || this.#drainElapsedMs === undefined
        || (observation.shutdownElapsedMs as number) < this.#drainElapsedMs
        || observation.simulatedCleanupConfirmed !== true) this.#fail("cleanup_failed");
      this.#state = "closed";
    } catch (error) { this.#mapFailure(error); }
  }

  finish(): ConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1 {
    try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
    catch { this.#fail("integrity_failed"); }
    if (this.#state === "complete") {
      throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1("state_conflict");
    }
    if (this.#state !== "closed" || !this.#frame || this.#frameChunks === undefined) {
      if (this.#state !== "failed") this.#state = "failed";
      throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1("incomplete_lifecycle");
    }
    const frame = this.#frame;
    const frameChunks = this.#frameChunks;
    this.#frame = undefined;
    this.#frameChunks = undefined;
    this.#state = "complete";
    const material = {
      contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_REHEARSAL_V1,
      rehearsalReference: `listener-rehearsal:${reflectApplyV1(stringSliceV1, this.#plan.planDigest, [7, 31])}`,
      listenerId: this.#plan.listenerId,
      planDigest: this.#plan.planDigest,
      evidenceMode: "repository_fake" as const,
      disposition: "passed" as const,
      eventCount: 6 as const,
      frameDigest: frame.frameDigest,
      frameBytes: frame.frameBytes,
      frameChunks,
      maximumObservedConcurrentConnections: 1 as const,
      maximumObservedQueuedConnections: 0 as const,
      bindPolicyMatched: true as const,
      capacityPolicyMatched: true as const,
      tunnelPolicyMatched: true as const,
      framePolicyMatched: true as const,
      cleanupPolicyMatched: true as const,
      actualBindObserved: false as const,
      exclusivePortOwnershipProven: false as const,
      tunnelPeerAuthenticated: false as const,
      hostKeyCustodyProven: false as const,
      nativeCleanupEvidenceAccepted: false as const,
      listenerEnabled: false as const,
      opensListener: false as const,
      performsNetworkIo: false as const,
      grantsApproval: false as const,
      grantsNetworkAuthority: false as const,
      grantsCommandAuthority: false as const,
      grantsLeaseAuthority: false as const,
      grantsExecutionAuthority: false as const,
    };
    return parseConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1({
      ...material,
      receiptDigest: sha256Digest(material),
    });
  }

  abort(): void {
    this.#frame = undefined;
    this.#frameChunks = undefined;
    this.#state = "failed";
  }

  #requireState(expected: ConnectionEnrollmentPrivateLoopbackListenerRehearsalStateV1): void {
    if (this.#state !== expected) {
      this.#state = "failed";
      throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1("state_conflict");
    }
  }

  #fail(code: ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1["safeCode"]): never {
    this.#frame = undefined;
    this.#frameChunks = undefined;
    this.#state = "failed";
    throw new ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1(code);
  }

  #mapFailure(error: unknown): never {
    const code = exactHostErrorCodeV1(error, lifecycleErrorPrototypeV1, "safeCode");
    this.#fail(isLifecycleSafeCodeV1(code) ? code : "integrity_failed");
  }
}
