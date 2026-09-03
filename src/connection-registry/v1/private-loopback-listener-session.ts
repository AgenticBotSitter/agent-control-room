import { assertNoSecretMaterial, sha256Digest } from "../../security";
import {
  dataMethodV1,
  exactHostDataSnapshotV1,
  exactHostErrorCodeV1,
  isHostProxyV1,
} from "../../security/host-value";
import { assertConnectionEnrollmentNodeIngressRuntimeV1 } from "./node-ingress";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
  ConnectionEnrollmentPrivateLoopbackFrameDecoderV1,
  ConnectionEnrollmentPrivateLoopbackFramingErrorV1,
  toConnectionEnrollmentTransportAdmissionInputV1,
} from "./private-loopback-framing";
import {
  ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1,
  ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1,
  parseConnectionEnrollmentPrivateLoopbackListenerPlanV1,
  type ConnectionEnrollmentPrivateLoopbackListenerPlanV1,
} from "./private-loopback-listener-lifecycle";
import {
  ConnectionEnrollmentTransportAdmissionErrorV1,
  parseConnectionEnrollmentTransportAdmissionReceiptV1,
  type ConnectionEnrollmentTransportAdmissionPortV1,
  type ConnectionEnrollmentTransportAdmissionReceiptV1,
} from "./transport-admission";

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_SESSION_V1 =
  "control-room-connection-enrollment-private-loopback-listener-session/v1" as const;

const digestPatternV1 = /^sha256:[a-f0-9]{64}$/;
const listenerIdPatternV1 = /^private-loopback-listener:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const sessionReferencePatternV1 = /^listener-session:[a-f0-9]{24}$/;
const admissionReferencePatternV1 = /^transport-admission-reference:[a-f0-9]{24}$/;
const ingressReferencePatternV1 = /^ingress:[a-f0-9]{24}$/;
const objectFreezeV1 = Object.freeze;
const objectGetOwnPropertyDescriptorV1 = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOfV1 = Object.getPrototypeOf;
const numberIsFiniteV1 = Number.isFinite;
const numberIsSafeIntegerV1 = Number.isSafeInteger;
const dateConstructorV1 = Date;
const dateParseV1 = Date.parse;
const dateGetTimeV1 = Date.prototype.getTime;
const dateToISOStringV1 = Date.prototype.toISOString;
const reflectApplyV1 = Reflect.apply;
const reflectOwnKeysV1 = Reflect.ownKeys;
const regexpExecV1 = RegExp.prototype.exec;
const stringSliceV1 = String.prototype.slice;
const promiseProbeV1 = (async () => undefined)();
const promisePrototypeV1 = objectGetPrototypeOfV1(promiseProbeV1);
const promiseConstructorDescriptorV1 = objectGetOwnPropertyDescriptorV1(promisePrototypeV1, "constructor");
const promiseThenDescriptorV1 = objectGetOwnPropertyDescriptorV1(promisePrototypeV1, "then");
if (!promiseConstructorDescriptorV1 || !("value" in promiseConstructorDescriptorV1)
  || typeof promiseConstructorDescriptorV1.value !== "function" || isHostProxyV1(promiseConstructorDescriptorV1.value)
  || !promiseThenDescriptorV1 || !("value" in promiseThenDescriptorV1)
  || typeof promiseThenDescriptorV1.value !== "function" || isHostProxyV1(promiseThenDescriptorV1.value)) {
  throw new Error("Promise runtime unavailable");
}
const promiseConstructorV1 = promiseConstructorDescriptorV1.value;
const promiseThenV1 = promiseThenDescriptorV1.value;
const symbolSpeciesV1 = Symbol.species;
const promiseSpeciesDescriptorV1 = objectGetOwnPropertyDescriptorV1(promiseConstructorV1, symbolSpeciesV1);
if (!promiseSpeciesDescriptorV1 || !("get" in promiseSpeciesDescriptorV1)
  || typeof promiseSpeciesDescriptorV1.get !== "function" || isHostProxyV1(promiseSpeciesDescriptorV1.get)
  || promiseSpeciesDescriptorV1.set !== undefined) {
  throw new Error("Promise species runtime unavailable");
}
const promiseSpeciesGetterV1 = promiseSpeciesDescriptorV1.get;
const discardPromiseSettlementV1 = (): undefined => undefined;

function patternMatchesV1(pattern: RegExp, value: string): boolean {
  return reflectApplyV1(regexpExecV1, pattern, [value]) !== null;
}

function isDigestV1(value: unknown): value is string {
  return typeof value === "string" && patternMatchesV1(digestPatternV1, value);
}

function exactInstantV1(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = dateParseV1(value);
  if (!numberIsFiniteV1(milliseconds)) return false;
  try {
    const date = new dateConstructorV1(milliseconds);
    return reflectApplyV1(dateGetTimeV1, date, []) === milliseconds
      && reflectApplyV1(dateToISOStringV1, date, []) === value;
  } catch { return false; }
}

function intrinsicNativePromiseV1(value: unknown): value is Promise<unknown> {
  return value !== null && value !== undefined && typeof value === "object" && !isHostProxyV1(value)
    && objectGetPrototypeOfV1(value) === promisePrototypeV1;
}

function exactPromiseRuntimeV1(): boolean {
  const constructorDescriptor = objectGetOwnPropertyDescriptorV1(promisePrototypeV1, "constructor");
  const thenDescriptor = objectGetOwnPropertyDescriptorV1(promisePrototypeV1, "then");
  const speciesDescriptor = objectGetOwnPropertyDescriptorV1(promiseConstructorV1, symbolSpeciesV1);
  return Boolean(constructorDescriptor && "value" in constructorDescriptor
    && constructorDescriptor.value === promiseConstructorV1
    && thenDescriptor && "value" in thenDescriptor && thenDescriptor.value === promiseThenV1
    && speciesDescriptor && "get" in speciesDescriptor && speciesDescriptor.get === promiseSpeciesGetterV1
    && speciesDescriptor.set === undefined);
}

function exactNativePromiseV1(value: unknown): value is Promise<unknown> {
  if (!intrinsicNativePromiseV1(value) || !exactPromiseRuntimeV1()) return false;
  const keys = reflectOwnKeysV1(value);
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] === "string") return false;
  }
  return true;
}

function observeMalformedIntrinsicPromiseV1(value: unknown): void {
  if (!intrinsicNativePromiseV1(value) || !exactPromiseRuntimeV1()
    || objectGetOwnPropertyDescriptorV1(value, "constructor") !== undefined) return;
  try {
    reflectApplyV1(promiseThenV1, value, [discardPromiseSettlementV1, discardPromiseSettlementV1]);
  } catch {
    // Keep malformed dependency settlement observed without inspecting it.
  }
}

export type ConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_SESSION_V1;
  sessionReference: string;
  listenerId: string;
  listenerPlanDigest: string;
  listenerReceiptDigest: string;
  protectedFrameDigest: string;
  admissionInputDigest: string;
  frameChunks: number;
  admissionReference: string;
  admissionReceiptDigest: string;
  ingressReference: string;
  channelIdentityDigest: string;
  protocolFrameDigest: string;
  deliveryEvidenceDigest: string;
  enrollmentResultDigest: string;
  registryRevision: number;
  receivedAt: string;
  protocolDisposition: "accepted" | "duplicate";
  ledgerDisposition: "accepted" | "duplicate";
  enrollmentDisposition: "accepted";
  listenerEvidenceMode: "repository_fake";
  listenerEventCount: 6;
  admissionCompleted: true;
  nativeListenerQualified: false;
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

export class ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_configuration" | "invalid_observation" | "state_conflict" |
    "frame_rejected" | "listener_rejected" | "admission_rejected" | "admission_mismatch" |
    "incomplete_session" | "integrity_failed") {
    super(safeCode);
    this.name = "ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1";
  }
}

const sessionErrorPrototypeV1 = ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1.prototype;
const framingErrorPrototypeV1 = ConnectionEnrollmentPrivateLoopbackFramingErrorV1.prototype;
const lifecycleErrorPrototypeV1 = ConnectionEnrollmentPrivateLoopbackListenerLifecycleErrorV1.prototype;
const admissionErrorPrototypeV1 = ConnectionEnrollmentTransportAdmissionErrorV1.prototype;

function isSessionSafeCodeV1(value: string | undefined):
value is ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1["safeCode"] {
  return value === "invalid_configuration" || value === "invalid_observation" || value === "state_conflict"
    || value === "frame_rejected" || value === "listener_rejected" || value === "admission_rejected"
    || value === "admission_mismatch" || value === "incomplete_session" || value === "integrity_failed";
}

function sessionReferenceV1(planDigest: string, listenerReceiptDigest: string,
  admissionReceiptDigest: string): string {
  return `listener-session:${reflectApplyV1(stringSliceV1, sha256Digest({ planDigest, listenerReceiptDigest,
    admissionReceiptDigest }), [7, 31])}`;
}

function unsignedReceiptV1(value: ConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1):
Omit<ConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = value;
  void _receiptDigest;
  return unsigned;
}

export function parseConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1 {
  try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1("integrity_failed"); }
  const captured = exactHostDataSnapshotV1(value, ["contractVersion", "sessionReference", "listenerId",
    "listenerPlanDigest", "listenerReceiptDigest", "protectedFrameDigest", "admissionInputDigest", "frameChunks",
    "admissionReference", "admissionReceiptDigest", "ingressReference", "channelIdentityDigest",
    "protocolFrameDigest", "deliveryEvidenceDigest", "enrollmentResultDigest", "registryRevision", "receivedAt",
    "protocolDisposition", "ledgerDisposition", "enrollmentDisposition", "listenerEvidenceMode",
    "listenerEventCount", "admissionCompleted",
    "nativeListenerQualified", "actualBindObserved", "exclusivePortOwnershipProven",
    "tunnelPeerAuthenticated", "hostKeyCustodyProven", "nativeCleanupEvidenceAccepted", "listenerEnabled",
    "opensListener", "performsNetworkIo", "grantsApproval", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "receiptDigest"]);
  if (!captured) throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1("integrity_failed");
  const receipt = captured as unknown as ConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1;
  if (receipt.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_SESSION_V1
    || typeof receipt.listenerId !== "string" || receipt.listenerId.length < 27 || receipt.listenerId.length > 160
    || !patternMatchesV1(listenerIdPatternV1, receipt.listenerId) || !isDigestV1(receipt.listenerPlanDigest)
    || !isDigestV1(receipt.listenerReceiptDigest) || !isDigestV1(receipt.admissionReceiptDigest)
    || !isDigestV1(receipt.protectedFrameDigest) || !isDigestV1(receipt.admissionInputDigest)
    || !numberIsSafeIntegerV1(receipt.frameChunks) || receipt.frameChunks < 1 || receipt.frameChunks > 4_096
    || typeof receipt.sessionReference !== "string"
    || !patternMatchesV1(sessionReferencePatternV1, receipt.sessionReference)
    || receipt.sessionReference !== sessionReferenceV1(receipt.listenerPlanDigest, receipt.listenerReceiptDigest,
      receipt.admissionReceiptDigest)
    || typeof receipt.admissionReference !== "string"
    || !patternMatchesV1(admissionReferencePatternV1, receipt.admissionReference)
    || typeof receipt.ingressReference !== "string"
    || !patternMatchesV1(ingressReferencePatternV1, receipt.ingressReference)
    || !isDigestV1(receipt.channelIdentityDigest) || !isDigestV1(receipt.protocolFrameDigest)
    || !isDigestV1(receipt.deliveryEvidenceDigest) || !isDigestV1(receipt.enrollmentResultDigest)
    || !numberIsSafeIntegerV1(receipt.registryRevision) || receipt.registryRevision < 1
    || !exactInstantV1(receipt.receivedAt)
    || (receipt.protocolDisposition !== "accepted" && receipt.protocolDisposition !== "duplicate")
    || (receipt.ledgerDisposition !== "accepted" && receipt.ledgerDisposition !== "duplicate")
    || receipt.enrollmentDisposition !== "accepted" || receipt.listenerEvidenceMode !== "repository_fake"
    || receipt.listenerEventCount !== 6 || receipt.admissionCompleted !== true
    || receipt.nativeListenerQualified !== false || receipt.actualBindObserved !== false
    || receipt.exclusivePortOwnershipProven !== false || receipt.tunnelPeerAuthenticated !== false
    || receipt.hostKeyCustodyProven !== false || receipt.nativeCleanupEvidenceAccepted !== false
    || receipt.listenerEnabled !== false || receipt.opensListener !== false || receipt.performsNetworkIo !== false
    || receipt.grantsApproval !== false || receipt.grantsNetworkAuthority !== false
    || receipt.grantsCommandAuthority !== false || receipt.grantsLeaseAuthority !== false
    || receipt.grantsExecutionAuthority !== false || !isDigestV1(receipt.receiptDigest)
    || sha256Digest(unsignedReceiptV1(receipt)) !== receipt.receiptDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1("integrity_failed");
  }
  try { assertNoSecretMaterial(receipt, "private loopback listener session receipt"); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1("integrity_failed"); }
  return objectFreezeV1(receipt);
}

type SessionStateV1 = "planned" | "bound" | "connected" | "admitting" | "admitted" | "connection_closed" |
  "draining" | "closed" | "complete" | "failed";

/**
 * Coordinates one repository-fake listener lifecycle with one authenticated
 * transport-admission call. It receives no stream or socket and cannot bind.
 */
export class ConnectionEnrollmentPrivateLoopbackListenerSessionV1 {
  readonly #plan: ConnectionEnrollmentPrivateLoopbackListenerPlanV1;
  readonly #lifecycle: ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1;
  readonly #decoder: ConnectionEnrollmentPrivateLoopbackFrameDecoderV1;
  readonly #admit: (input: unknown) => unknown;
  #state: SessionStateV1 = "planned";
  #admissionReceipt: ConnectionEnrollmentTransportAdmissionReceiptV1 | undefined;
  #admissionInputDigest: string | undefined;
  #frameChunks = 0;

  constructor(planValue: unknown, admission: ConnectionEnrollmentTransportAdmissionPortV1) {
    try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
    catch { throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1("invalid_configuration"); }
    if (!admission || typeof admission !== "object" || isHostProxyV1(admission)) {
      throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1("invalid_configuration");
    }
    const admit = dataMethodV1(admission, "admit") as ConnectionEnrollmentTransportAdmissionPortV1["admit"] |
      undefined;
    if (!admit) throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1("invalid_configuration");
    try {
      this.#plan = parseConnectionEnrollmentPrivateLoopbackListenerPlanV1(planValue);
      this.#lifecycle = new ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1(this.#plan);
      this.#decoder = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1({
        listenerId: this.#plan.listenerId,
        transport: this.#plan.transport,
        listenerVisibility: this.#plan.listenerVisibility,
        addressFamily: this.#plan.addressFamily,
        bindAddress: this.#plan.bindAddress,
        framing: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRAMING_V1,
        maximumFrameBytes: this.#plan.maximumFrameBytes,
        maximumChunks: this.#plan.maximumChunks,
      });
      this.#admit = (input) => reflectApplyV1(admit, admission, [input]);
    } catch {
      throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1("invalid_configuration");
    }
  }

  observeBind(value: unknown): void {
    this.#requireState("planned");
    try { this.#lifecycle.observeBind(value); this.#state = "bound"; }
    catch (error) { this.#mapListenerFailure(error); }
  }

  observeConnectionOpen(value: unknown): void {
    this.#requireState("bound");
    try { this.#lifecycle.observeConnectionOpen(value); this.#state = "connected"; }
    catch (error) { this.#mapListenerFailure(error); }
  }

  pushFrameChunk(value: unknown): void {
    this.#requireState("connected");
    try { this.#decoder.push(value); this.#frameChunks += 1; }
    catch (error) { this.#mapFrameFailure(error); }
  }

  async completeFrameAndAdmit(observationValue: unknown): Promise<void> {
    this.#requireState("connected");
    const observation = exactHostDataSnapshotV1(observationValue, ["sequence", "listenerId", "planDigest",
      "evidenceMode", "activeConnections", "queuedConnections", "connectionAgeMs", "idleAgeMs", "frameChunks",
      "nativeEvidenceAccepted"]);
    if (!observation) this.#fail("invalid_observation");
    if (observation.frameChunks !== this.#frameChunks) this.#fail("invalid_observation");
    let admissionInput: Readonly<{ rawFrame: string; deliveryId: string }> | undefined;
    try {
      const protectedFrame = this.#decoder.finish();
      this.#lifecycle.observeFrameComplete({ ...observation, protectedFrame });
      admissionInput = toConnectionEnrollmentTransportAdmissionInputV1(protectedFrame);
      this.#admissionInputDigest = sha256Digest(admissionInput);
      this.#state = "admitting";
    } catch (error) { this.#mapFrameOrListenerFailure(error); }

    let pending: unknown;
    try { pending = this.#admit(admissionInput); }
    catch (error) { this.#mapAdmissionFailure(error); }
    admissionInput = undefined;
    try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
    catch { this.#fail("integrity_failed"); }
    if (!exactNativePromiseV1(pending)) {
      observeMalformedIntrinsicPromiseV1(pending);
      this.#fail("integrity_failed");
    }

    let receipt: ConnectionEnrollmentTransportAdmissionReceiptV1;
    try {
      const result = await pending;
      this.#requireState("admitting");
      assertConnectionEnrollmentNodeIngressRuntimeV1();
      receipt = parseConnectionEnrollmentTransportAdmissionReceiptV1(result);
    } catch (error) { this.#mapAdmissionFailure(error); }
    if (receipt.transport !== this.#plan.transport
      || receipt.listenerVisibility !== this.#plan.listenerVisibility
      || receipt.channelIdentityDigest !== this.#plan.channelIdentityDigest
      || receipt.maximumFrameBytes !== this.#plan.maximumFrameBytes) this.#fail("admission_mismatch");
    this.#admissionReceipt = receipt;
    this.#state = "admitted";
  }

  observeConnectionClose(value: unknown): void {
    this.#requireState("admitted");
    try { this.#lifecycle.observeConnectionClose(value); this.#state = "connection_closed"; }
    catch (error) { this.#mapListenerFailure(error); }
  }

  observeDrainStart(value: unknown): void {
    this.#requireState("connection_closed");
    try { this.#lifecycle.observeDrainStart(value); this.#state = "draining"; }
    catch (error) { this.#mapListenerFailure(error); }
  }

  observeListenerClose(value: unknown): void {
    this.#requireState("draining");
    try { this.#lifecycle.observeListenerClose(value); this.#state = "closed"; }
    catch (error) { this.#mapListenerFailure(error); }
  }

  finish(): ConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1 {
    try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
    catch { this.#fail("integrity_failed"); }
    if (this.#state === "complete") {
      throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1("state_conflict");
    }
    if (this.#state !== "closed" || !this.#admissionReceipt || !this.#admissionInputDigest
      || this.#frameChunks < 1) this.#fail("incomplete_session");
    let listenerReceipt;
    try { listenerReceipt = this.#lifecycle.finish(); }
    catch (error) { this.#mapListenerFailure(error); }
    const admissionReceipt = this.#admissionReceipt;
    const admissionInputDigest = this.#admissionInputDigest;
    const frameChunks = this.#frameChunks;
    if (listenerReceipt.frameChunks !== frameChunks) this.#fail("integrity_failed");
    this.#admissionReceipt = undefined;
    this.#admissionInputDigest = undefined;
    this.#frameChunks = 0;
    this.#state = "complete";
    const material: Omit<ConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1, "receiptDigest"> = {
      contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_LISTENER_SESSION_V1,
      sessionReference: sessionReferenceV1(this.#plan.planDigest, listenerReceipt.receiptDigest,
        admissionReceipt.receiptDigest),
      listenerId: this.#plan.listenerId,
      listenerPlanDigest: this.#plan.planDigest,
      listenerReceiptDigest: listenerReceipt.receiptDigest,
      protectedFrameDigest: listenerReceipt.frameDigest,
      admissionInputDigest,
      frameChunks,
      admissionReference: admissionReceipt.admissionReference,
      admissionReceiptDigest: admissionReceipt.receiptDigest,
      ingressReference: admissionReceipt.ingressReference,
      channelIdentityDigest: admissionReceipt.channelIdentityDigest,
      protocolFrameDigest: admissionReceipt.protocolFrameDigest,
      deliveryEvidenceDigest: admissionReceipt.deliveryEvidenceDigest,
      enrollmentResultDigest: admissionReceipt.enrollmentResultDigest,
      registryRevision: admissionReceipt.registryRevision,
      receivedAt: admissionReceipt.receivedAt,
      protocolDisposition: admissionReceipt.protocolDisposition,
      ledgerDisposition: admissionReceipt.ledgerDisposition,
      enrollmentDisposition: "accepted",
      listenerEvidenceMode: "repository_fake",
      listenerEventCount: 6,
      admissionCompleted: true,
      nativeListenerQualified: false,
      actualBindObserved: false,
      exclusivePortOwnershipProven: false,
      tunnelPeerAuthenticated: false,
      hostKeyCustodyProven: false,
      nativeCleanupEvidenceAccepted: false,
      listenerEnabled: false,
      opensListener: false,
      performsNetworkIo: false,
      grantsApproval: false,
      grantsNetworkAuthority: false,
      grantsCommandAuthority: false,
      grantsLeaseAuthority: false,
      grantsExecutionAuthority: false,
    };
    try {
      return parseConnectionEnrollmentPrivateLoopbackListenerSessionReceiptV1({
        ...material,
        receiptDigest: sha256Digest(material),
      });
    } catch { this.#fail("integrity_failed"); }
  }

  abort(): void {
    if (this.#state === "admitting") {
      throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1("state_conflict");
    }
    if (this.#state === "complete" || this.#state === "failed") return;
    this.#clear();
    this.#state = "failed";
  }

  #requireState(expected: SessionStateV1): void {
    if (this.#state === expected) return;
    if (this.#state === "admitting" || this.#state === "complete" || this.#state === "failed") {
      throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1("state_conflict");
    }
    this.#fail("state_conflict");
  }

  #clear(): void {
    try { this.#decoder.close(); } catch { /* terminal local cleanup */ }
    try { this.#lifecycle.abort(); } catch { /* terminal local cleanup */ }
    this.#admissionReceipt = undefined;
    this.#admissionInputDigest = undefined;
    this.#frameChunks = 0;
  }

  #fail(code: ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1["safeCode"]): never {
    this.#clear();
    this.#state = "failed";
    throw new ConnectionEnrollmentPrivateLoopbackListenerSessionErrorV1(code);
  }

  #mapFrameFailure(error: unknown): never {
    const code = exactHostErrorCodeV1(error, framingErrorPrototypeV1, "safeCode");
    this.#fail(code ? "frame_rejected" : "integrity_failed");
  }

  #mapListenerFailure(error: unknown): never {
    const code = exactHostErrorCodeV1(error, lifecycleErrorPrototypeV1, "safeCode");
    this.#fail(code ? "listener_rejected" : "integrity_failed");
  }

  #mapFrameOrListenerFailure(error: unknown): never {
    if (exactHostErrorCodeV1(error, framingErrorPrototypeV1, "safeCode")) this.#fail("frame_rejected");
    if (exactHostErrorCodeV1(error, lifecycleErrorPrototypeV1, "safeCode")) this.#fail("listener_rejected");
    const ownCode = exactHostErrorCodeV1(error, sessionErrorPrototypeV1, "safeCode");
    this.#fail(isSessionSafeCodeV1(ownCode) ? ownCode : "integrity_failed");
  }

  #mapAdmissionFailure(error: unknown): never {
    if (exactHostErrorCodeV1(error, admissionErrorPrototypeV1, "safeCode")) this.#fail("admission_rejected");
    const ownCode = exactHostErrorCodeV1(error, sessionErrorPrototypeV1, "safeCode");
    this.#fail(isSessionSafeCodeV1(ownCode) ? ownCode : "integrity_failed");
  }
}
