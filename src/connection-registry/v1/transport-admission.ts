import { Buffer } from "node:buffer";
import {
  isConnectionEnrollmentDeliveryIdV1,
  NODE_PROTOCOL_MAX_FRAME_BYTES,
} from "../../node-protocol/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import {
  dataMethodV1,
  exactHostDataSnapshotV1,
  exactHostErrorCodeV1,
  isHostProxyV1,
} from "../../security/host-value";
import {
  assertConnectionEnrollmentNodeIngressRuntimeV1,
  ConnectionEnrollmentNodeIngressErrorV1,
  parseConnectionEnrollmentNodeIngressReceiptV1,
  type ConnectionEnrollmentNodeIngressPortV1,
  type ConnectionEnrollmentNodeIngressReceiptV1,
} from "./node-ingress";

export const CONNECTION_ENROLLMENT_TRANSPORT_ADMISSION_RECEIPT_V1 =
  "control-room-connection-enrollment-transport-admission-receipt/v1" as const;

const digestPatternV1 = /^sha256:[a-f0-9]{64}$/;
const admissionIdPatternV1 = /^transport-admission:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
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
const regexpExecV1 = RegExp.prototype.exec;
const reflectApplyV1 = Reflect.apply;
const reflectOwnKeysV1 = Reflect.ownKeys;
const stringSliceV1 = String.prototype.slice;
const bufferByteLengthV1 = Buffer.byteLength;
// Async functions use the realm's intrinsic Promise even when a harness wraps
// the global Promise constructor. Probe that exact prototype once at import.
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
const ingressErrorPrototypeV1 = ConnectionEnrollmentNodeIngressErrorV1.prototype;
const discardPromiseSettlementV1 = (): undefined => undefined;

function patternMatchesV1(pattern: RegExp, value: string): boolean {
  return reflectApplyV1(regexpExecV1, pattern, [value]) !== null;
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
  if (!constructorDescriptor || !("value" in constructorDescriptor)
    || constructorDescriptor.value !== promiseConstructorV1
    || !thenDescriptor || !("value" in thenDescriptor) || thenDescriptor.value !== promiseThenV1
    || !speciesDescriptor || !("get" in speciesDescriptor) || speciesDescriptor.get !== promiseSpeciesGetterV1
    || speciesDescriptor.set !== undefined) return false;
  return true;
}

function exactNativePromiseV1(value: unknown): value is Promise<unknown> {
  if (!intrinsicNativePromiseV1(value) || !exactPromiseRuntimeV1()) return false;
  const keys = reflectOwnKeysV1(value);
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] === "string") return false;
  }
  return true;
}

function safelyObservablePromiseSelectionV1(value: Promise<unknown>): boolean {
  const ownConstructor = objectGetOwnPropertyDescriptorV1(value, "constructor");
  const selectedConstructor = ownConstructor === undefined
    ? objectGetOwnPropertyDescriptorV1(promisePrototypeV1, "constructor")
    : ownConstructor;
  if (!selectedConstructor || !("value" in selectedConstructor)) return false;
  if (selectedConstructor.value === undefined) return true;
  if (selectedConstructor.value !== promiseConstructorV1) return false;
  const speciesDescriptor = objectGetOwnPropertyDescriptorV1(promiseConstructorV1, symbolSpeciesV1);
  return Boolean(speciesDescriptor && "get" in speciesDescriptor
    && speciesDescriptor.get === promiseSpeciesGetterV1 && speciesDescriptor.set === undefined);
}

/**
 * Mark a malformed same-realm Promise observed without reading its `then`.
 * Acceptance still requires the complete Promise runtime to remain exact, but
 * cleanup needs only a demonstrably inert effective constructor/species path
 * because it calls the already-captured intrinsic method. Every behavioral or
 * foreign selection stays completely untouched.
 */
function observeMalformedIntrinsicPromiseV1(value: unknown): void {
  if (!intrinsicNativePromiseV1(value) || !safelyObservablePromiseSelectionV1(value)) return;
  try {
    reflectApplyV1(promiseThenV1, value, [discardPromiseSettlementV1, discardPromiseSettlementV1]);
  } catch {
    // The admission still returns only its bounded integrity result. Never
    // inspect, serialize, or rethrow the dependency value or observer failure.
  }
}

export type ConnectionEnrollmentTransportAdmissionConfigurationV1 = Readonly<{
  admissionId: string;
  transport: "ssh_tunnel";
  listenerVisibility: "private_loopback";
  channelIdentityDigest: string;
  maximumFrameBytes: number;
}>;

export type ConnectionEnrollmentTransportAdmissionInputV1 = Readonly<{
  rawFrame: string;
  /** An untrusted routing hint that must match authenticated frame evidence. */
  deliveryId: string;
}>;

export type ConnectionEnrollmentTransportAdmissionReceiptV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_TRANSPORT_ADMISSION_RECEIPT_V1;
  admissionReference: string;
  admissionPolicyDigest: string;
  transport: "ssh_tunnel";
  listenerVisibility: "private_loopback";
  channelIdentityDigest: string;
  maximumFrameBytes: number;
  ingressReference: string;
  ingressReceiptDigest: string;
  protocolFrameDigest: string;
  deliveryEvidenceDigest: string;
  enrollmentResultDigest: string;
  registryRevision: number;
  receivedAt: string;
  protocolDisposition: "accepted" | "duplicate";
  ledgerDisposition: "accepted" | "duplicate";
  enrollmentDisposition: "accepted";
  opensListener: false;
  performsNetworkIo: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}>;

export interface ConnectionEnrollmentTransportClockV1 {
  /** A synchronous server-owned clock. Transport input cannot supply chronology. */
  now(): unknown;
}

export interface ConnectionEnrollmentTransportAdmissionPortV1 {
  admit(input: unknown): Promise<ConnectionEnrollmentTransportAdmissionReceiptV1>;
}

export class ConnectionEnrollmentTransportAdmissionErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_configuration" | "invalid_input" | "frame_too_large" |
    "time_unavailable" | "disabled" | "authentication_failed" | "wrong_message_type" |
    "scope_mismatch" | "enrollment_rejected" | "replay_conflict" | "integrity_failed") {
    super(safeCode);
    this.name = "ConnectionEnrollmentTransportAdmissionErrorV1";
  }
}

function parseConfigurationV1(value: unknown): ConnectionEnrollmentTransportAdmissionConfigurationV1 {
  try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
  catch { throw new ConnectionEnrollmentTransportAdmissionErrorV1("invalid_configuration"); }
  const configuration = exactHostDataSnapshotV1(value,
    ["admissionId", "transport", "listenerVisibility", "channelIdentityDigest", "maximumFrameBytes"]);
  if (!configuration || typeof configuration.admissionId !== "string"
    || configuration.admissionId.length < 23 || configuration.admissionId.length > 160
    || !patternMatchesV1(admissionIdPatternV1, configuration.admissionId)
    || configuration.transport !== "ssh_tunnel"
    || configuration.listenerVisibility !== "private_loopback"
    || typeof configuration.channelIdentityDigest !== "string"
    || !patternMatchesV1(digestPatternV1, configuration.channelIdentityDigest)
    || !numberIsSafeIntegerV1(configuration.maximumFrameBytes)
    || (configuration.maximumFrameBytes as number) < 4_096
    || (configuration.maximumFrameBytes as number) > NODE_PROTOCOL_MAX_FRAME_BYTES) {
    throw new ConnectionEnrollmentTransportAdmissionErrorV1("invalid_configuration");
  }
  return objectFreezeV1({
    admissionId: configuration.admissionId,
    transport: "ssh_tunnel",
    listenerVisibility: "private_loopback",
    channelIdentityDigest: configuration.channelIdentityDigest,
    maximumFrameBytes: configuration.maximumFrameBytes,
  }) as ConnectionEnrollmentTransportAdmissionConfigurationV1;
}

function unsignedReceiptV1(receipt: ConnectionEnrollmentTransportAdmissionReceiptV1):
Omit<ConnectionEnrollmentTransportAdmissionReceiptV1, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = receipt;
  void _receiptDigest;
  return unsigned;
}

export function parseConnectionEnrollmentTransportAdmissionReceiptV1(value: unknown):
ConnectionEnrollmentTransportAdmissionReceiptV1 {
  try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
  catch { throw new ConnectionEnrollmentTransportAdmissionErrorV1("integrity_failed"); }
  const captured = exactHostDataSnapshotV1(value, ["contractVersion", "admissionReference",
    "admissionPolicyDigest", "transport", "listenerVisibility", "channelIdentityDigest", "maximumFrameBytes",
    "ingressReference", "ingressReceiptDigest", "protocolFrameDigest", "deliveryEvidenceDigest",
    "enrollmentResultDigest", "registryRevision", "receivedAt", "protocolDisposition", "ledgerDisposition",
    "enrollmentDisposition", "opensListener", "performsNetworkIo", "grantsApproval", "grantsNetworkAuthority",
    "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority", "receiptDigest"]);
  if (!captured) throw new ConnectionEnrollmentTransportAdmissionErrorV1("integrity_failed");
  const receipt = captured as unknown as ConnectionEnrollmentTransportAdmissionReceiptV1;
  if (receipt.contractVersion !== CONNECTION_ENROLLMENT_TRANSPORT_ADMISSION_RECEIPT_V1
    || typeof receipt.admissionReference !== "string"
    || !patternMatchesV1(admissionReferencePatternV1, receipt.admissionReference)
    || typeof receipt.admissionPolicyDigest !== "string"
    || !patternMatchesV1(digestPatternV1, receipt.admissionPolicyDigest)
    || receipt.transport !== "ssh_tunnel" || receipt.listenerVisibility !== "private_loopback"
    || typeof receipt.channelIdentityDigest !== "string"
    || !patternMatchesV1(digestPatternV1, receipt.channelIdentityDigest)
    || !numberIsSafeIntegerV1(receipt.maximumFrameBytes) || receipt.maximumFrameBytes < 4_096
    || receipt.maximumFrameBytes > NODE_PROTOCOL_MAX_FRAME_BYTES
    || typeof receipt.ingressReference !== "string"
    || !patternMatchesV1(ingressReferencePatternV1, receipt.ingressReference)
    || typeof receipt.ingressReceiptDigest !== "string"
    || !patternMatchesV1(digestPatternV1, receipt.ingressReceiptDigest)
    || typeof receipt.protocolFrameDigest !== "string"
    || !patternMatchesV1(digestPatternV1, receipt.protocolFrameDigest)
    || typeof receipt.deliveryEvidenceDigest !== "string"
    || !patternMatchesV1(digestPatternV1, receipt.deliveryEvidenceDigest)
    || typeof receipt.enrollmentResultDigest !== "string"
    || !patternMatchesV1(digestPatternV1, receipt.enrollmentResultDigest)
    || !numberIsSafeIntegerV1(receipt.registryRevision) || receipt.registryRevision < 1
    || !exactInstantV1(receipt.receivedAt)
    || (receipt.protocolDisposition !== "accepted" && receipt.protocolDisposition !== "duplicate")
    || (receipt.ledgerDisposition !== "accepted" && receipt.ledgerDisposition !== "duplicate")
    || receipt.enrollmentDisposition !== "accepted" || receipt.opensListener !== false
    || receipt.performsNetworkIo !== false || receipt.grantsApproval !== false
    || receipt.grantsNetworkAuthority !== false || receipt.grantsCommandAuthority !== false
    || receipt.grantsLeaseAuthority !== false || receipt.grantsExecutionAuthority !== false
    || typeof receipt.receiptDigest !== "string" || !patternMatchesV1(digestPatternV1, receipt.receiptDigest)
    || sha256Digest(unsignedReceiptV1(receipt)) !== receipt.receiptDigest) {
    throw new ConnectionEnrollmentTransportAdmissionErrorV1("integrity_failed");
  }
  try { assertNoSecretMaterial(receipt, "connection enrollment transport admission receipt"); }
  catch { throw new ConnectionEnrollmentTransportAdmissionErrorV1("integrity_failed"); }
  return objectFreezeV1(receipt);
}

function mapIngressFailureV1(error: unknown): never {
  const code = exactHostErrorCodeV1(error, ingressErrorPrototypeV1, "safeCode");
  if (code === "invalid_input" || code === "disabled" || code === "authentication_failed"
    || code === "wrong_message_type" || code === "scope_mismatch" || code === "enrollment_rejected"
    || code === "replay_conflict" || code === "integrity_failed") {
    throw new ConnectionEnrollmentTransportAdmissionErrorV1(code);
  }
  throw new ConnectionEnrollmentTransportAdmissionErrorV1("integrity_failed");
}

/**
 * Effect-free handoff for one already-decoded transport frame. It opens no
 * listener, performs no I/O, and derives rate-limit identity from frozen
 * server configuration rather than frame or request fields.
 */
export class ConnectionEnrollmentTransportAdmissionV1 implements ConnectionEnrollmentTransportAdmissionPortV1 {
  readonly #receive: (input: unknown) => unknown;
  readonly #now: ConnectionEnrollmentTransportClockV1["now"];
  readonly #configuration: ConnectionEnrollmentTransportAdmissionConfigurationV1;
  readonly #admissionPolicyDigest: string;
  readonly #transportIdentity: string;

  constructor(ingress: ConnectionEnrollmentNodeIngressPortV1, configurationValue: unknown,
    clock: ConnectionEnrollmentTransportClockV1) {
    try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
    catch { throw new ConnectionEnrollmentTransportAdmissionErrorV1("invalid_configuration"); }
    if (!ingress || typeof ingress !== "object" || isHostProxyV1(ingress)
      || !clock || typeof clock !== "object" || isHostProxyV1(clock)) {
      throw new ConnectionEnrollmentTransportAdmissionErrorV1("invalid_configuration");
    }
    const receive = dataMethodV1(ingress, "receive") as ConnectionEnrollmentNodeIngressPortV1["receive"] | undefined;
    const now = dataMethodV1(clock, "now") as ConnectionEnrollmentTransportClockV1["now"] | undefined;
    if (!receive || !now) throw new ConnectionEnrollmentTransportAdmissionErrorV1("invalid_configuration");
    const configuration = parseConfigurationV1(configurationValue);
    this.#receive = (input) => reflectApplyV1(receive, ingress, [input]);
    this.#now = (() => reflectApplyV1(now, clock, [])) as ConnectionEnrollmentTransportClockV1["now"];
    this.#configuration = configuration;
    this.#admissionPolicyDigest = sha256Digest(configuration);
    this.#transportIdentity = `transport:ssh_tunnel:${reflectApplyV1(stringSliceV1,
      sha256Digest({ admissionPolicyDigest: this.#admissionPolicyDigest,
        channelIdentityDigest: configuration.channelIdentityDigest }), [7]) as string}`;
  }

  async admit(inputValue: unknown): Promise<ConnectionEnrollmentTransportAdmissionReceiptV1> {
    try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
    catch { throw new ConnectionEnrollmentTransportAdmissionErrorV1("integrity_failed"); }
    const input = exactHostDataSnapshotV1(inputValue, ["rawFrame", "deliveryId"]);
    if (!input || typeof input.rawFrame !== "string" || input.rawFrame.length < 2
      || !isConnectionEnrollmentDeliveryIdV1(input.deliveryId)) {
      throw new ConnectionEnrollmentTransportAdmissionErrorV1("invalid_input");
    }
    const frameBytes = reflectApplyV1(bufferByteLengthV1, Buffer, [input.rawFrame, "utf8"]) as number;
    if (!numberIsSafeIntegerV1(frameBytes) || frameBytes < 2) {
      throw new ConnectionEnrollmentTransportAdmissionErrorV1("invalid_input");
    }
    if (frameBytes > this.#configuration.maximumFrameBytes) {
      throw new ConnectionEnrollmentTransportAdmissionErrorV1("frame_too_large");
    }

    let clockValue: unknown;
    try {
      clockValue = this.#now();
    } catch { throw new ConnectionEnrollmentTransportAdmissionErrorV1("time_unavailable"); }
    try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
    catch { throw new ConnectionEnrollmentTransportAdmissionErrorV1("integrity_failed"); }
    if (!exactInstantV1(clockValue)) {
      throw new ConnectionEnrollmentTransportAdmissionErrorV1("time_unavailable");
    }
    const receivedAt = clockValue;

    let pending: unknown;
    try {
      pending = this.#receive({ rawFrame: input.rawFrame, deliveryId: input.deliveryId,
        receivedAt, transportIdentity: this.#transportIdentity });
    } catch (error) { mapIngressFailureV1(error); }
    try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
    catch {
      observeMalformedIntrinsicPromiseV1(pending);
      throw new ConnectionEnrollmentTransportAdmissionErrorV1("integrity_failed");
    }
    if (!exactNativePromiseV1(pending)) {
      observeMalformedIntrinsicPromiseV1(pending);
      throw new ConnectionEnrollmentTransportAdmissionErrorV1("integrity_failed");
    }

    let ingressReceipt: ConnectionEnrollmentNodeIngressReceiptV1;
    try {
      const receiptValue = await pending;
      ingressReceipt = parseConnectionEnrollmentNodeIngressReceiptV1(receiptValue);
    } catch (error) { mapIngressFailureV1(error); }

    const material: Omit<ConnectionEnrollmentTransportAdmissionReceiptV1, "receiptDigest"> = {
      contractVersion: CONNECTION_ENROLLMENT_TRANSPORT_ADMISSION_RECEIPT_V1,
      admissionReference: `transport-admission-reference:${reflectApplyV1(stringSliceV1,
        sha256Digest({ admissionPolicyDigest: this.#admissionPolicyDigest,
          ingressReference: ingressReceipt.ingressReference }), [7, 31]) as string}`,
      admissionPolicyDigest: this.#admissionPolicyDigest,
      transport: this.#configuration.transport,
      listenerVisibility: this.#configuration.listenerVisibility,
      channelIdentityDigest: this.#configuration.channelIdentityDigest,
      maximumFrameBytes: this.#configuration.maximumFrameBytes,
      ingressReference: ingressReceipt.ingressReference,
      ingressReceiptDigest: sha256Digest(ingressReceipt),
      protocolFrameDigest: ingressReceipt.protocolFrameDigest,
      deliveryEvidenceDigest: ingressReceipt.deliveryEvidenceDigest,
      enrollmentResultDigest: ingressReceipt.enrollmentResultDigest,
      registryRevision: ingressReceipt.registryRevision,
      receivedAt: ingressReceipt.receivedAt,
      protocolDisposition: ingressReceipt.protocolDisposition,
      ledgerDisposition: ingressReceipt.ledgerDisposition,
      enrollmentDisposition: "accepted",
      opensListener: false,
      performsNetworkIo: false,
      grantsApproval: false,
      grantsNetworkAuthority: false,
      grantsCommandAuthority: false,
      grantsLeaseAuthority: false,
      grantsExecutionAuthority: false,
    };
    return parseConnectionEnrollmentTransportAdmissionReceiptV1({ ...material,
      receiptDigest: sha256Digest(material) });
  }
}

/** Default runtime truth until a separately approved private transport exists. */
export class DisabledConnectionEnrollmentTransportAdmissionV1
implements ConnectionEnrollmentTransportAdmissionPortV1 {
  async admit(_input: unknown): Promise<never> {
    void _input;
    throw new ConnectionEnrollmentTransportAdmissionErrorV1("disabled");
  }
}
