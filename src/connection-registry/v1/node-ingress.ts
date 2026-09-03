import { createHash } from "node:crypto";
import { isConnectionEnrollmentDeliveryIdV1, type ProtocolRateLimitGuard } from "../../node-protocol/v1";
import type { DatabaseClient } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import {
  dataMethodV1,
  exactHostErrorCodeV1,
  exactHostDataSnapshotV1,
  exactHostUint8ArrayV1,
  isHostProxyV1,
} from "../../security/host-value";
import {
  ConnectionEnrollmentIntakeErrorV1,
  ConnectionEnrollmentIntakeServiceV1,
  parseConnectionEnrollmentIntakeReceiptV1,
  parseConnectionEnrollmentProtectedDeliveryV1,
  type ConnectionEnrollmentIntakeReceiptV1,
} from "./intake";
import {
  ConnectionEnrollmentNodeDeliveryErrorV1,
  DatabaseConnectionEnrollmentNodeDeliveryAdapterV1,
  parseConnectionEnrollmentNodeDeliveryReceiptV1,
  type ConnectionEnrollmentNodeDeliveryReceiptV1,
} from "./node-delivery";

export const CONNECTION_ENROLLMENT_NODE_INGRESS_RECEIPT_V1 =
  "control-room-connection-enrollment-node-ingress-receipt/v1" as const;

const digestPatternV1 = /^sha256:[a-f0-9]{64}$/;
const ingressReferencePatternV1 = /^ingress:[a-f0-9]{24}$/;
const deliveryReferencePatternV1 = /^delivery:[a-f0-9]{24}$/;
const intakeReferencePatternV1 = /^intake:[a-f0-9]{24}$/;
const objectConstructorV1 = Object;
const objectGetOwnPropertyDescriptorV1 = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOfV1 = Object.getPrototypeOf;
const objectFreezeV1 = Object.freeze;
const objectKeysV1 = Object.keys;
const arrayConstructorV1 = Array;
const arrayIsArrayV1 = Array.isArray;
const arrayMapV1 = Array.prototype.map;
const arrayJoinV1 = Array.prototype.join;
const arraySortV1 = Array.prototype.sort;
const numberConstructorV1 = Number;
const numberIsFiniteV1 = Number.isFinite;
const numberIsSafeIntegerV1 = Number.isSafeInteger;
const jsonObjectV1 = JSON;
const jsonStringifyV1 = JSON.stringify;
const dateConstructorV1 = Date;
const datePrototypeV1 = Date.prototype;
const dateParseV1 = Date.parse;
const dateGetTimeV1 = Date.prototype.getTime;
const dateToISOStringV1 = Date.prototype.toISOString;
const stringConstructorV1 = String;
const stringPrototypeV1 = String.prototype;
const stringSliceV1 = String.prototype.slice;
const regexpConstructorV1 = RegExp;
const regexpPrototypeV1 = RegExp.prototype;
const regexpExecV1 = RegExp.prototype.exec;
const reflectObjectV1 = Reflect;
const reflectApplyV1 = Reflect.apply;
const uint8ArrayConstructorV1 = Uint8Array;
const uint8ArrayPrototypeV1 = Uint8Array.prototype;
const typedArrayPrototypeV1 = objectGetPrototypeOfV1(uint8ArrayPrototypeV1);
const uint8ArrayFillV1 = Uint8Array.prototype.fill;
const hashProbeV1 = createHash("sha256");
const hashPrototypeV1 = objectGetPrototypeOfV1(hashProbeV1);
const hashUpdateCandidateV1 = objectGetOwnPropertyDescriptorV1(hashPrototypeV1, "update")?.value as unknown;
const hashDigestCandidateV1 = objectGetOwnPropertyDescriptorV1(hashPrototypeV1, "digest")?.value as unknown;
if (typeof hashUpdateCandidateV1 !== "function" || typeof hashDigestCandidateV1 !== "function") {
  throw new Error("hash runtime unavailable");
}
const hashUpdateV1 = hashUpdateCandidateV1;
const hashDigestV1 = hashDigestCandidateV1;
reflectApplyV1(hashUpdateV1, hashProbeV1, ["", "utf8"]);
reflectApplyV1(hashDigestV1, hashProbeV1, ["hex"]);
const runtimeSentinelMaterialV1 = { cr13aLive050: ["runtime", 5, true], revision: 1 };
const runtimeSentinelDigestV1 = sha256Digest(runtimeSentinelMaterialV1);
const deliveryErrorPrototypeV1 = ConnectionEnrollmentNodeDeliveryErrorV1.prototype;
const intakeErrorPrototypeV1 = ConnectionEnrollmentIntakeErrorV1.prototype;

function exactOwnMethodV1(value: object, key: PropertyKey, expected: unknown): boolean {
  const descriptor = objectGetOwnPropertyDescriptorV1(value, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.value === expected;
}

function exactGlobalValueV1(key: PropertyKey, expected: unknown): boolean {
  const descriptor = objectGetOwnPropertyDescriptorV1(globalThis, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.value === expected;
}

function assertCanonicalRuntimeV1(): void {
  if (!exactGlobalValueV1("Object", objectConstructorV1)
    || !exactGlobalValueV1("Array", arrayConstructorV1)
    || !exactGlobalValueV1("Number", numberConstructorV1)
    || !exactGlobalValueV1("JSON", jsonObjectV1)
    || !exactGlobalValueV1("Date", dateConstructorV1)
    || !exactGlobalValueV1("String", stringConstructorV1)
    || !exactGlobalValueV1("RegExp", regexpConstructorV1)
    || !exactGlobalValueV1("Reflect", reflectObjectV1)
    || !exactGlobalValueV1("Uint8Array", uint8ArrayConstructorV1)
    || !exactOwnMethodV1(objectConstructorV1, "getOwnPropertyDescriptor", objectGetOwnPropertyDescriptorV1)
    || !exactOwnMethodV1(objectConstructorV1, "getPrototypeOf", objectGetPrototypeOfV1)
    || !exactOwnMethodV1(objectConstructorV1, "freeze", objectFreezeV1)
    || !exactOwnMethodV1(objectConstructorV1, "keys", objectKeysV1)
    || !exactOwnMethodV1(arrayConstructorV1, "isArray", arrayIsArrayV1)
    || !exactOwnMethodV1(Array.prototype, "map", arrayMapV1)
    || !exactOwnMethodV1(Array.prototype, "join", arrayJoinV1)
    || !exactOwnMethodV1(Array.prototype, "sort", arraySortV1)
    || !exactOwnMethodV1(numberConstructorV1, "isFinite", numberIsFiniteV1)
    || !exactOwnMethodV1(numberConstructorV1, "isSafeInteger", numberIsSafeIntegerV1)
    || !exactOwnMethodV1(jsonObjectV1, "stringify", jsonStringifyV1)
    || !exactOwnMethodV1(dateConstructorV1, "parse", dateParseV1)
    || !exactOwnMethodV1(datePrototypeV1, "getTime", dateGetTimeV1)
    || !exactOwnMethodV1(datePrototypeV1, "toISOString", dateToISOStringV1)
    || !exactOwnMethodV1(stringPrototypeV1, "slice", stringSliceV1)
    || !exactOwnMethodV1(regexpPrototypeV1, "exec", regexpExecV1)
    || !exactOwnMethodV1(reflectObjectV1, "apply", reflectApplyV1)
    || !exactOwnMethodV1(typedArrayPrototypeV1, "fill", uint8ArrayFillV1)
    || !exactOwnMethodV1(hashPrototypeV1, "update", hashUpdateV1)
    || !exactOwnMethodV1(hashPrototypeV1, "digest", hashDigestV1)
    || sha256Digest(runtimeSentinelMaterialV1) !== runtimeSentinelDigestV1) {
    throw new ConnectionEnrollmentNodeIngressErrorV1("integrity_failed");
  }
}

/** Shared runtime assertion for adjacent enrollment ingress boundaries. */
export function assertConnectionEnrollmentNodeIngressRuntimeV1(): void {
  assertCanonicalRuntimeV1();
}

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

export type ConnectionEnrollmentNodeIngressReceiptV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_NODE_INGRESS_RECEIPT_V1;
  ingressReference: string;
  deliveryReference: string;
  intakeReference: string;
  protocolFrameDigest: string;
  deliveryEvidenceDigest: string;
  enrollmentResultDigest: string;
  registryRevision: number;
  receivedAt: string;
  protocolDisposition: "accepted" | "duplicate";
  ledgerDisposition: "accepted" | "duplicate";
  enrollmentDisposition: "accepted";
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}>;

export type ReceiveConnectionEnrollmentNodeIngressV1 = Readonly<{
  rawFrame: string;
  deliveryId: string;
  receivedAt: string;
  /** Transport-derived routing identity. It is never read from the frame body. */
  transportIdentity: string;
}>;

export interface ConnectionEnrollmentNodeIngressPortV1 {
  receive(input: unknown): Promise<ConnectionEnrollmentNodeIngressReceiptV1>;
}

interface ConnectionEnrollmentNodeIngressDeliveryPortV1 {
  deliver(raw: unknown, options: unknown): Promise<unknown>;
  read(input: unknown): Promise<unknown>;
}

interface ConnectionEnrollmentNodeIngressIntakePortV1 {
  ingest(input: unknown): Promise<unknown>;
}

function unsignedReceiptV1(receipt: ConnectionEnrollmentNodeIngressReceiptV1):
Omit<ConnectionEnrollmentNodeIngressReceiptV1, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = receipt;
  void _receiptDigest;
  return unsigned;
}

export function parseConnectionEnrollmentNodeIngressReceiptV1(value: unknown):
ConnectionEnrollmentNodeIngressReceiptV1 {
  assertCanonicalRuntimeV1();
  const captured = exactHostDataSnapshotV1(value, ["contractVersion", "ingressReference", "deliveryReference",
    "intakeReference", "protocolFrameDigest", "deliveryEvidenceDigest", "enrollmentResultDigest",
    "registryRevision", "receivedAt", "protocolDisposition", "ledgerDisposition", "enrollmentDisposition",
    "grantsApproval", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "receiptDigest"]);
  if (!captured) throw new ConnectionEnrollmentNodeIngressErrorV1("integrity_failed");
  const receipt = captured as unknown as ConnectionEnrollmentNodeIngressReceiptV1;
  if (receipt.contractVersion !== CONNECTION_ENROLLMENT_NODE_INGRESS_RECEIPT_V1
    || typeof receipt.ingressReference !== "string"
    || !patternMatchesV1(ingressReferencePatternV1, receipt.ingressReference)
    || typeof receipt.deliveryReference !== "string"
    || !patternMatchesV1(deliveryReferencePatternV1, receipt.deliveryReference)
    || typeof receipt.intakeReference !== "string"
    || !patternMatchesV1(intakeReferencePatternV1, receipt.intakeReference)
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
    || receipt.enrollmentDisposition !== "accepted"
    || receipt.grantsApproval !== false || receipt.grantsNetworkAuthority !== false
    || receipt.grantsCommandAuthority !== false || receipt.grantsLeaseAuthority !== false
    || receipt.grantsExecutionAuthority !== false || typeof receipt.receiptDigest !== "string"
    || !patternMatchesV1(digestPatternV1, receipt.receiptDigest)
    || sha256Digest(unsignedReceiptV1(receipt)) !== receipt.receiptDigest) {
    throw new ConnectionEnrollmentNodeIngressErrorV1("integrity_failed");
  }
  try { assertNoSecretMaterial(receipt, "connection enrollment node ingress receipt"); }
  catch { throw new ConnectionEnrollmentNodeIngressErrorV1("integrity_failed"); }
  return objectFreezeV1(receipt);
}

export class ConnectionEnrollmentNodeIngressErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_input" | "disabled" | "authentication_failed" |
    "wrong_message_type" | "scope_mismatch" | "enrollment_rejected" | "replay_conflict" | "integrity_failed") {
    super(safeCode);
    this.name = "ConnectionEnrollmentNodeIngressErrorV1";
  }
}
const ingressErrorPrototypeV1 = ConnectionEnrollmentNodeIngressErrorV1.prototype;

function capturedIngressErrorCodeV1(value: unknown): ConnectionEnrollmentNodeIngressErrorV1["safeCode"] | undefined {
  const code = exactHostErrorCodeV1(value, ingressErrorPrototypeV1, "safeCode");
  return code === "invalid_input" || code === "disabled" || code === "authentication_failed"
    || code === "wrong_message_type" || code === "scope_mismatch" || code === "enrollment_rejected"
    || code === "replay_conflict" || code === "integrity_failed" ? code : undefined;
}

function mapDeliveryFailureV1(error: unknown): never {
  const code = exactHostErrorCodeV1(error, deliveryErrorPrototypeV1, "safeCode");
  if (code === "invalid_input" || code === "authentication_failed" || code === "wrong_message_type"
    || code === "scope_mismatch" || code === "replay_conflict") {
      throw new ConnectionEnrollmentNodeIngressErrorV1(code);
    }
  throw new ConnectionEnrollmentNodeIngressErrorV1("integrity_failed");
}

function mapIntakeFailureV1(error: unknown): never {
  const code = exactHostErrorCodeV1(error, intakeErrorPrototypeV1, "safeCode");
  if (code !== undefined) {
    if (code === "unauthenticated_delivery") {
      throw new ConnectionEnrollmentNodeIngressErrorV1("enrollment_rejected");
    }
    if (code === "replay_conflict") {
      throw new ConnectionEnrollmentNodeIngressErrorV1("replay_conflict");
    }
  }
  throw new ConnectionEnrollmentNodeIngressErrorV1("integrity_failed");
}

/**
 * Server-only coordinator. A transport may supply a routing hint, but trust is
 * derived only from the authenticated delivery ledger and the independent
 * enrollment intake. This class opens no listener and performs no network I/O.
 */
class ConnectionEnrollmentNodeIngressCoordinatorV1 implements ConnectionEnrollmentNodeIngressPortV1 {
  readonly #deliver: ConnectionEnrollmentNodeIngressDeliveryPortV1["deliver"];
  readonly #read: ConnectionEnrollmentNodeIngressDeliveryPortV1["read"];
  readonly #ingest: ConnectionEnrollmentNodeIngressIntakePortV1["ingest"];

  constructor(delivery: ConnectionEnrollmentNodeIngressDeliveryPortV1,
    intake: ConnectionEnrollmentNodeIngressIntakePortV1) {
    const deliver = dataMethodV1(delivery, "deliver") as
      ConnectionEnrollmentNodeIngressDeliveryPortV1["deliver"] | undefined;
    const read = dataMethodV1(delivery, "read") as
      ConnectionEnrollmentNodeIngressDeliveryPortV1["read"] | undefined;
    const ingest = dataMethodV1(intake, "ingest") as
      ConnectionEnrollmentNodeIngressIntakePortV1["ingest"] | undefined;
    if (!delivery || typeof delivery !== "object" || isHostProxyV1(delivery) || !deliver || !read
      || !intake || typeof intake !== "object" || isHostProxyV1(intake) || !ingest) {
      throw new ConnectionEnrollmentNodeIngressErrorV1("invalid_input");
    }
    this.#deliver = ((raw, options) => reflectApplyV1(deliver, delivery, [raw, options])) as
      ConnectionEnrollmentNodeIngressDeliveryPortV1["deliver"];
    this.#read = ((input) => reflectApplyV1(read, delivery, [input])) as
      ConnectionEnrollmentNodeIngressDeliveryPortV1["read"];
    this.#ingest = ((input) => reflectApplyV1(ingest, intake, [input])) as
      ConnectionEnrollmentNodeIngressIntakePortV1["ingest"];
  }

  async receive(inputValue: unknown): Promise<ConnectionEnrollmentNodeIngressReceiptV1> {
    assertCanonicalRuntimeV1();
    const input = exactHostDataSnapshotV1(inputValue,
      ["rawFrame", "deliveryId", "receivedAt", "transportIdentity"]);
    if (!input || typeof input.rawFrame !== "string" || input.rawFrame.length < 2
      || !isConnectionEnrollmentDeliveryIdV1(input.deliveryId)
      || !exactInstantV1(input.receivedAt) || typeof input.transportIdentity !== "string"
      || input.transportIdentity.length < 3 || input.transportIdentity.length > 256) {
      throw new ConnectionEnrollmentNodeIngressErrorV1("invalid_input");
    }

    let deliveryReceipt: ConnectionEnrollmentNodeDeliveryReceiptV1;
    try {
      const deliveryValue = await this.#deliver(input.rawFrame, {
        receivedAt: input.receivedAt,
        transportIdentity: input.transportIdentity,
      });
      assertCanonicalRuntimeV1();
      deliveryReceipt = parseConnectionEnrollmentNodeDeliveryReceiptV1(deliveryValue);
    } catch (error) { mapDeliveryFailureV1(error); }

    try {
      const protectedDeliveryValue = await this.#read({
        deliveryId: input.deliveryId,
        receivedAt: deliveryReceipt.receivedAt,
      });
      assertCanonicalRuntimeV1();
      const protectedDelivery = parseConnectionEnrollmentProtectedDeliveryV1(protectedDeliveryValue,
        input.deliveryId, deliveryReceipt.receivedAt);
      if (protectedDelivery.deliveryEvidenceDigest !== deliveryReceipt.deliveryEvidenceDigest) {
        throw new ConnectionEnrollmentNodeIngressErrorV1("scope_mismatch");
      }
    } catch (error) {
      const code = capturedIngressErrorCodeV1(error);
      if (code) throw new ConnectionEnrollmentNodeIngressErrorV1(code);
      mapDeliveryFailureV1(error);
    }

    let intakeReceipt: ConnectionEnrollmentIntakeReceiptV1;
    try {
      const intakeValue = await this.#ingest({
        deliveryId: input.deliveryId,
        receivedAt: deliveryReceipt.receivedAt,
      });
      assertCanonicalRuntimeV1();
      const result = exactHostDataSnapshotV1(intakeValue, ["replayed", "receipt"]);
      if (!result || typeof result.replayed !== "boolean") {
        throw new ConnectionEnrollmentNodeIngressErrorV1("integrity_failed");
      }
      intakeReceipt = parseConnectionEnrollmentIntakeReceiptV1(result.receipt);
    } catch (error) {
      const code = capturedIngressErrorCodeV1(error);
      if (code) throw new ConnectionEnrollmentNodeIngressErrorV1(code);
      mapIntakeFailureV1(error);
    }
    if (intakeReceipt.deliveryEvidenceDigest !== deliveryReceipt.deliveryEvidenceDigest
      || intakeReceipt.recordedAt !== deliveryReceipt.receivedAt) {
      throw new ConnectionEnrollmentNodeIngressErrorV1("integrity_failed");
    }
    assertCanonicalRuntimeV1();

    const material: Omit<ConnectionEnrollmentNodeIngressReceiptV1, "receiptDigest"> = {
      contractVersion: CONNECTION_ENROLLMENT_NODE_INGRESS_RECEIPT_V1,
      ingressReference: `ingress:${reflectApplyV1(stringSliceV1,
        sha256Digest({ deliveryReference: deliveryReceipt.deliveryReference,
          intakeReference: intakeReceipt.intakeReference }), [7, 31]) as string}`,
      deliveryReference: deliveryReceipt.deliveryReference,
      intakeReference: intakeReceipt.intakeReference,
      protocolFrameDigest: deliveryReceipt.protocolFrameDigest,
      deliveryEvidenceDigest: deliveryReceipt.deliveryEvidenceDigest,
      enrollmentResultDigest: intakeReceipt.enrollmentResultDigest,
      registryRevision: intakeReceipt.registryRevision,
      receivedAt: deliveryReceipt.receivedAt,
      protocolDisposition: deliveryReceipt.protocolDisposition,
      ledgerDisposition: deliveryReceipt.ledgerDisposition,
      enrollmentDisposition: "accepted",
      grantsApproval: false,
      grantsNetworkAuthority: false,
      grantsCommandAuthority: false,
      grantsLeaseAuthority: false,
      grantsExecutionAuthority: false,
    };
    return parseConnectionEnrollmentNodeIngressReceiptV1({ ...material, receiptDigest: sha256Digest(material) });
  }
}

function equalKeysV1(left: ReturnType<typeof exactHostUint8ArrayV1>,
  right: ReturnType<typeof exactHostUint8ArrayV1>): boolean {
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left.byteAt(index) ?? -1) ^ (right.byteAt(index) ?? -1);
  }
  return difference === 0;
}

/** Production-shaped database composition. It still opens no listener or provider connection. */
export class DatabaseConnectionEnrollmentNodeIngressV1 implements ConnectionEnrollmentNodeIngressPortV1 {
  readonly #coordinator: ConnectionEnrollmentNodeIngressCoordinatorV1;

  constructor(db: DatabaseClient, configurationValue: unknown, rateLimit: ProtocolRateLimitGuard) {
    assertCanonicalRuntimeV1();
    const configuration = exactHostDataSnapshotV1(configurationValue,
      ["deliveryIntegrityKey", "registryIntegrityKey", "intakeAuditIntegrityKey"]);
    const deliveryKey = exactHostUint8ArrayV1(configuration?.deliveryIntegrityKey, 128);
    const registryKey = exactHostUint8ArrayV1(configuration?.registryIntegrityKey, 128);
    const intakeKey = exactHostUint8ArrayV1(configuration?.intakeAuditIntegrityKey, 128);
    if (!deliveryKey || deliveryKey.byteLength !== 32 || !registryKey || registryKey.byteLength !== 32
      || !intakeKey || intakeKey.byteLength !== 32 || equalKeysV1(deliveryKey, registryKey)
      || equalKeysV1(deliveryKey, intakeKey) || equalKeysV1(registryKey, intakeKey)) {
      throw new ConnectionEnrollmentNodeIngressErrorV1("invalid_input");
    }
    const deliveryMaterial = deliveryKey.copy(), registryMaterial = registryKey.copy(), intakeMaterial = intakeKey.copy();
    let coordinator: ConnectionEnrollmentNodeIngressCoordinatorV1;
    try {
      const delivery = new DatabaseConnectionEnrollmentNodeDeliveryAdapterV1(db, deliveryMaterial, rateLimit);
      const intake = new ConnectionEnrollmentIntakeServiceV1(db, registryMaterial, intakeMaterial, delivery);
      coordinator = new ConnectionEnrollmentNodeIngressCoordinatorV1(delivery, intake);
    } catch {
      throw new ConnectionEnrollmentNodeIngressErrorV1("invalid_input");
    } finally {
      reflectApplyV1(uint8ArrayFillV1, deliveryMaterial, [0]);
      reflectApplyV1(uint8ArrayFillV1, registryMaterial, [0]);
      reflectApplyV1(uint8ArrayFillV1, intakeMaterial, [0]);
    }
    assertCanonicalRuntimeV1();
    this.#coordinator = coordinator;
  }

  receive(input: unknown): Promise<ConnectionEnrollmentNodeIngressReceiptV1> {
    return this.#coordinator.receive(input);
  }
}

/** Default runtime truth until an independently approved transport composition exists. */
export class DisabledConnectionEnrollmentNodeIngressV1 implements ConnectionEnrollmentNodeIngressPortV1 {
  async receive(): Promise<never> { throw new ConnectionEnrollmentNodeIngressErrorV1("disabled"); }
}
