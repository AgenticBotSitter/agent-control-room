import { timingSafeEqual } from "node:crypto";
import {
  IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
  parseIdeaLabHermes021ConnectionEnrollmentEnvelopeV1,
  type IdeaLabHermes021ConnectionEnrollmentEnvelopeV1,
} from "../../idea-lab/v1";
import {
  NodeProtocolAuthenticator,
  isConnectionEnrollmentDeliveryIdV1,
  opaqueTokenDigest,
  ProtocolAuthenticationError,
  type ProtocolAuthenticationCode,
  type ProtocolRateLimitGuard,
  type ReplayGuard,
  type SignedNodeFrame,
  type TrustedKeyResolver,
  type TrustedProtocolKey,
} from "../../node-protocol/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import {
  dataMethodV1,
  exactHostErrorCodeV1,
  exactHostDataArrayV1,
  exactHostDataSnapshotV1,
  exactHostUint8ArrayV1,
  isHostProxyV1,
  ownDataPropertyValueV1,
} from "../../security/host-value";
import {
  buildConnectionEnrollmentProtectedDeliveryV1,
  type ConnectionEnrollmentProtectedDeliverySourceV1,
  type ConnectionEnrollmentProtectedDeliveryV1,
} from "./intake";

export const CONNECTION_ENROLLMENT_NODE_DELIVERY_RECEIPT_V1 =
  "control-room-connection-enrollment-node-delivery-receipt/v1" as const;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const authTagPattern = /^hmac-sha256:[a-f0-9]{64}$/;
const deliveryReferencePattern = /^delivery:[a-f0-9]{24}$/;
const capturedNumberIsSafeInteger = Number.isSafeInteger;

const objectConstructorV1 = Object;
const objectGetOwnPropertyDescriptorV1 = Object.getOwnPropertyDescriptor;
const objectGetOwnPropertyDescriptorsV1 = Object.getOwnPropertyDescriptors;
const objectGetPrototypeOfV1 = Object.getPrototypeOf;
const objectDefinePropertyV1 = Object.defineProperty;
const objectFreezeV1 = Object.freeze;
const objectKeysV1 = Object.keys;
const arrayConstructorV1 = Array;
const arrayIsArrayV1 = Array.isArray;
const arrayMapV1 = Array.prototype.map;
const arrayJoinV1 = Array.prototype.join;
const arraySortV1 = Array.prototype.sort;
const arraySomeV1 = Array.prototype.some;
const arrayIncludesV1 = Array.prototype.includes;
const arrayIteratorV1 = Array.prototype[Symbol.iterator];
const setConstructorV1 = Set;
const setPrototypeV1 = Set.prototype;
const setHasV1 = Set.prototype.has;
const numberConstructorV1 = Number;
const numberIsFiniteV1 = Number.isFinite;
const numberIsSafeIntegerV1 = Number.isSafeInteger;
const jsonObjectV1 = JSON;
const jsonParseV1 = JSON.parse;
const jsonStringifyV1 = JSON.stringify;
const dateConstructorV1 = Date;
const datePrototypeV1 = Date.prototype;
const dateParseV1 = Date.parse;
const dateGetTimeV1 = Date.prototype.getTime;
const dateToISOStringV1 = Date.prototype.toISOString;
const stringConstructorV1 = String;
const stringPrototypeV1 = String.prototype;
const stringSliceV1 = String.prototype.slice;
const reflectObjectV1 = Reflect;
const reflectApplyV1 = Reflect.apply;
const reflectOwnKeysV1 = Reflect.ownKeys;
const regexpConstructorV1 = RegExp;
const regexpPrototypeV1 = RegExp.prototype;
const regexpExecV1 = RegExp.prototype.exec;
const bufferConstructorV1 = Buffer;
const bufferFromV1 = Buffer.from;
const bufferByteLengthV1 = Buffer.byteLength;
const bufferToStringV1 = Buffer.prototype.toString;
const globalBufferGetterV1 = objectGetOwnPropertyDescriptorV1(globalThis, "Buffer")?.get;
if (typeof globalBufferGetterV1 !== "function") throw new Error("Buffer runtime unavailable");
const protocolAuthenticationErrorPrototypeV1 = ProtocolAuthenticationError.prototype;

function capturedProtocolAuthenticationCodeV1(value: unknown): ProtocolAuthenticationCode | undefined {
  const code = exactHostErrorCodeV1(value, protocolAuthenticationErrorPrototypeV1, "code");
  return code === "malformed_frame" || code === "unsupported_version" || code === "expired"
    || code === "unauthenticated" || code === "forbidden" || code === "replayed" || code === "rate_limited"
    ? code : undefined;
}

const runtimeSentinelKeyV1 = new Uint8Array(32);
for (let index = 0; index < runtimeSentinelKeyV1.length; index += 1) runtimeSentinelKeyV1[index] = 149;
const runtimeSentinelMaterialV1 = { cr13aLive040: ["runtime", 4, true], revision: 1 };
const runtimeSentinelDigestV1 = sha256Digest(runtimeSentinelMaterialV1);
const runtimeSentinelAuthTagV1 = hmacSha256Tag(runtimeSentinelKeyV1, runtimeSentinelMaterialV1);

function exactOwnMethodV1(value: object, key: PropertyKey, expected: unknown): boolean {
  const descriptor = objectGetOwnPropertyDescriptorV1(value, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.value === expected;
}

function exactGlobalValueV1(key: PropertyKey, expected: unknown): boolean {
  const descriptor = objectGetOwnPropertyDescriptorV1(globalThis, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.value === expected;
}

function exactGlobalGetterV1(key: PropertyKey, expected: unknown): boolean {
  const descriptor = objectGetOwnPropertyDescriptorV1(globalThis, key);
  return descriptor !== undefined && !("value" in descriptor) && descriptor.get === expected;
}

function assertCanonicalRuntimeV1(): void {
  if (!exactGlobalValueV1("Object", objectConstructorV1) || !exactGlobalValueV1("Array", arrayConstructorV1)
    || !exactGlobalValueV1("Number", numberConstructorV1) || !exactGlobalValueV1("JSON", jsonObjectV1)
    || !exactGlobalValueV1("Date", dateConstructorV1) || !exactGlobalValueV1("String", stringConstructorV1)
    || !exactGlobalValueV1("RegExp", regexpConstructorV1) || !exactGlobalValueV1("Reflect", reflectObjectV1)
    || !exactGlobalValueV1("Set", setConstructorV1) || !exactGlobalGetterV1("Buffer", globalBufferGetterV1)
    || !exactOwnMethodV1(objectConstructorV1, "getOwnPropertyDescriptor", objectGetOwnPropertyDescriptorV1)
    || !exactOwnMethodV1(objectConstructorV1, "getOwnPropertyDescriptors", objectGetOwnPropertyDescriptorsV1)
    || !exactOwnMethodV1(objectConstructorV1, "getPrototypeOf", objectGetPrototypeOfV1)
    || !exactOwnMethodV1(objectConstructorV1, "defineProperty", objectDefinePropertyV1)
    || !exactOwnMethodV1(objectConstructorV1, "freeze", objectFreezeV1)
    || !exactOwnMethodV1(objectConstructorV1, "keys", objectKeysV1)
    || !exactOwnMethodV1(arrayConstructorV1, "isArray", arrayIsArrayV1)
    || !exactOwnMethodV1(Array.prototype, "map", arrayMapV1)
    || !exactOwnMethodV1(Array.prototype, "join", arrayJoinV1)
    || !exactOwnMethodV1(Array.prototype, "sort", arraySortV1)
    || !exactOwnMethodV1(Array.prototype, "some", arraySomeV1)
    || !exactOwnMethodV1(Array.prototype, "includes", arrayIncludesV1)
    || !exactOwnMethodV1(Array.prototype, Symbol.iterator, arrayIteratorV1)
    || !exactOwnMethodV1(setPrototypeV1, "has", setHasV1)
    || !exactOwnMethodV1(numberConstructorV1, "isFinite", numberIsFiniteV1)
    || !exactOwnMethodV1(numberConstructorV1, "isSafeInteger", numberIsSafeIntegerV1)
    || !exactOwnMethodV1(jsonObjectV1, "parse", jsonParseV1)
    || !exactOwnMethodV1(jsonObjectV1, "stringify", jsonStringifyV1)
    || !exactOwnMethodV1(dateConstructorV1, "parse", dateParseV1)
    || !exactOwnMethodV1(datePrototypeV1, "getTime", dateGetTimeV1)
    || !exactOwnMethodV1(datePrototypeV1, "toISOString", dateToISOStringV1)
    || !exactOwnMethodV1(stringPrototypeV1, "slice", stringSliceV1)
    || !exactOwnMethodV1(regexpPrototypeV1, "exec", regexpExecV1)
    || !exactOwnMethodV1(reflectObjectV1, "apply", reflectApplyV1)
    || !exactOwnMethodV1(reflectObjectV1, "ownKeys", reflectOwnKeysV1)
    || !exactOwnMethodV1(bufferConstructorV1, "from", bufferFromV1)
    || !exactOwnMethodV1(bufferConstructorV1, "byteLength", bufferByteLengthV1)
    || !exactOwnMethodV1(Buffer.prototype, "toString", bufferToStringV1)
    || sha256Digest(runtimeSentinelMaterialV1) !== runtimeSentinelDigestV1
    || hmacSha256Tag(runtimeSentinelKeyV1, runtimeSentinelMaterialV1) !== runtimeSentinelAuthTagV1) {
    throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
  }
}

function patternMatchesV1(pattern: RegExp, value: string): boolean {
  return reflectApplyV1(regexpExecV1, pattern, [value]) !== null;
}

export type ConnectionEnrollmentNodeDeliveryReceiptV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_NODE_DELIVERY_RECEIPT_V1;
  deliveryReference: string;
  protocolFrameDigest: string;
  deliveryEvidenceDigest: string;
  receivedAt: string;
  protocolDisposition: "accepted" | "duplicate";
  ledgerDisposition: "accepted" | "duplicate";
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}>;

interface DeliveryHeadRowV1 {
  tenant_id: string;
  last_sequence: number | string;
  last_record_digest: string;
  head_auth_tag: string;
  updated_at: string;
}

interface DeliveryRowV1 {
  tenant_id: string;
  delivery_id: string;
  sequence: number | string;
  node_id: string;
  connection_id: string;
  key_id_digest: string;
  protocol_message_digest: string;
  protocol_frame_digest: string;
  initial_protocol_disposition: "accepted" | "duplicate";
  envelope_digest: string;
  protected_delivery_digest: string;
  payload_digest: string;
  previous_record_digest: string | null;
  record_digest: string;
  record_auth_tag: string;
  received_at: string;
  payload: unknown;
}

interface StoredPayloadV1 {
  deliveryId: string;
  authenticatedAt: string;
  envelope: IdeaLabHermes021ConnectionEnrollmentEnvelopeV1;
}

const selectedDeliveryColumns = `tenant_id,delivery_id,sequence,node_id,connection_id,key_id_digest,
  protocol_message_digest,protocol_frame_digest,initial_protocol_disposition,envelope_digest,
  protected_delivery_digest,payload_digest,
  previous_record_digest,record_digest,record_auth_tag,
  to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,payload`;
const deliveryColumns = `tenant_id,delivery_id,sequence,node_id,connection_id,key_id_digest,
  protocol_message_digest,protocol_frame_digest,initial_protocol_disposition,envelope_digest,
  protected_delivery_digest,payload_digest,
  previous_record_digest,record_digest,record_auth_tag,received_at,payload`;

function same(left: string, right: string): boolean {
  try { return timingSafeEqual(bufferFromV1(left), bufferFromV1(right)); }
  catch { return false; }
}

function exactInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = dateParseV1(value);
  if (!numberIsFiniteV1(milliseconds)) return false;
  try {
    const parsed = new dateConstructorV1(milliseconds);
    const epoch = reflectApplyV1(dateGetTimeV1, parsed, []) as number;
    const canonical = reflectApplyV1(dateToISOStringV1, parsed, []) as string;
    return epoch === milliseconds && canonical === value;
  } catch { return false; }
}

function capturedRows(value: unknown, maximum: number): unknown[] {
  const rows = exactHostDataArrayV1(ownDataPropertyValueV1(value, "rows"), maximum);
  if (!rows) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
  return rows;
}

async function safeQuery(tx: DatabaseSession, statement: string, params: unknown[], maximum = 10_000):
Promise<unknown[]> {
  const query = dataMethodV1(tx, "query");
  if (!query) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
  const result = await reflectApplyV1(query, tx, [statement, params]);
  assertCanonicalRuntimeV1();
  return capturedRows(result, maximum);
}

function headMaterial(row: Omit<DeliveryHeadRowV1, "head_auth_tag">) {
  return { tenantId: row.tenant_id, lastSequence: numberConstructorV1(row.last_sequence),
    lastRecordDigest: row.last_record_digest, updatedAt: row.updated_at };
}

function recordMaterial(row: Omit<DeliveryRowV1, "record_auth_tag" | "payload" | "record_digest">) {
  return {
    tenantId: row.tenant_id, deliveryId: row.delivery_id, sequence: numberConstructorV1(row.sequence),
    nodeId: row.node_id,
    connectionId: row.connection_id, keyIdDigest: row.key_id_digest,
    protocolMessageDigest: row.protocol_message_digest, protocolFrameDigest: row.protocol_frame_digest,
    initialProtocolDisposition: row.initial_protocol_disposition,
    envelopeDigest: row.envelope_digest, protectedDeliveryDigest: row.protected_delivery_digest,
    payloadDigest: row.payload_digest, previousRecordDigest: row.previous_record_digest, receivedAt: row.received_at,
  };
}

function unsignedReceipt(value: ConnectionEnrollmentNodeDeliveryReceiptV1):
Omit<ConnectionEnrollmentNodeDeliveryReceiptV1, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = value;
  void _receiptDigest;
  return unsigned;
}

export function parseConnectionEnrollmentNodeDeliveryReceiptV1(value: unknown):
ConnectionEnrollmentNodeDeliveryReceiptV1 {
  assertCanonicalRuntimeV1();
  const captured = exactHostDataSnapshotV1(value, ["contractVersion", "deliveryReference", "protocolFrameDigest",
    "deliveryEvidenceDigest", "receivedAt", "protocolDisposition", "ledgerDisposition", "grantsApproval",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "receiptDigest"]);
  if (!captured) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
  const parsed = captured as unknown as ConnectionEnrollmentNodeDeliveryReceiptV1;
  if (parsed.contractVersion !== CONNECTION_ENROLLMENT_NODE_DELIVERY_RECEIPT_V1
    || typeof parsed.deliveryReference !== "string"
    || !patternMatchesV1(deliveryReferencePattern, parsed.deliveryReference)
    || typeof parsed.protocolFrameDigest !== "string" || !patternMatchesV1(digestPattern, parsed.protocolFrameDigest)
    || typeof parsed.deliveryEvidenceDigest !== "string"
    || !patternMatchesV1(digestPattern, parsed.deliveryEvidenceDigest)
    || !exactInstant(parsed.receivedAt)
    || (parsed.protocolDisposition !== "accepted" && parsed.protocolDisposition !== "duplicate")
    || (parsed.ledgerDisposition !== "accepted" && parsed.ledgerDisposition !== "duplicate")
    || parsed.grantsApproval !== false || parsed.grantsNetworkAuthority !== false
    || parsed.grantsCommandAuthority !== false || parsed.grantsLeaseAuthority !== false
    || parsed.grantsExecutionAuthority !== false || typeof parsed.receiptDigest !== "string"
    || !patternMatchesV1(digestPattern, parsed.receiptDigest)
    || sha256Digest(unsignedReceipt(parsed)) !== parsed.receiptDigest) {
    throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
  }
  try { assertNoSecretMaterial(parsed, "connection enrollment node delivery receipt"); }
  catch { throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed"); }
  assertCanonicalRuntimeV1();
  return objectFreezeV1(parsed);
}

function captureStoredPayload(value: unknown): StoredPayloadV1 {
  const captured = exactHostDataSnapshotV1(value, ["deliveryId", "authenticatedAt", "envelope"]);
  if (!captured || !isConnectionEnrollmentDeliveryIdV1(captured.deliveryId)
    || !exactInstant(captured.authenticatedAt)) {
    throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
  }
  let envelope: IdeaLabHermes021ConnectionEnrollmentEnvelopeV1;
  try { envelope = parseIdeaLabHermes021ConnectionEnrollmentEnvelopeV1(captured.envelope); }
  catch { throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed"); }
  return objectFreezeV1({ deliveryId: captured.deliveryId, authenticatedAt: captured.authenticatedAt, envelope });
}

export class ConnectionEnrollmentNodeDeliveryErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_input" | "authentication_failed" | "wrong_message_type" |
    "scope_mismatch" | "replay_conflict" | "integrity_failed") {
    super(safeCode); this.name = "ConnectionEnrollmentNodeDeliveryErrorV1";
  }
}
const connectionEnrollmentNodeDeliveryErrorPrototypeV1 = ConnectionEnrollmentNodeDeliveryErrorV1.prototype;

function capturedDeliveryErrorCodeV1(value: unknown): ConnectionEnrollmentNodeDeliveryErrorV1["safeCode"] | undefined {
  const code = exactHostErrorCodeV1(value, connectionEnrollmentNodeDeliveryErrorPrototypeV1, "safeCode");
  return code === "invalid_input" || code === "authentication_failed" || code === "wrong_message_type"
    || code === "scope_mismatch" || code === "replay_conflict" || code === "integrity_failed" ? code : undefined;
}

/** Exact-row resolver used only by this hostile live-ingress boundary. */
class ProtectedNodeKeyResolverV1 implements TrustedKeyResolver {
  readonly #query: DatabaseSession["query"];

  constructor(db: DatabaseClient) {
    const query = dataMethodV1(db, "query") as DatabaseSession["query"] | undefined;
    if (!query) throw new ConnectionEnrollmentNodeDeliveryErrorV1("invalid_input");
    this.#query = ((statement, params = []) => reflectApplyV1(query, db, [statement, params])) as
      DatabaseSession["query"];
  }

  async resolve(input: { tenantId: string; actorId: string; senderKind: "node" | "control_room"; keyId: string }):
  Promise<TrustedProtocolKey | undefined> {
    if (input.senderKind !== "node") return undefined;
    const queryResult = await this.#query(`SELECT k.tenant_id,k.node_id,k.id AS key_id,k.algorithm,
      k.public_key_spki,k.state AS key_state,n.state AS node_state,
      to_char(k.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_from,
      CASE WHEN k.valid_until IS NULL THEN NULL ELSE
        to_char(k.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS valid_until
      FROM control_node_keys k JOIN control_nodes n ON n.tenant_id=k.tenant_id AND n.id=k.node_id
      WHERE k.tenant_id=$1 AND k.node_id=$2 AND k.id=$3`,
    [input.tenantId,input.actorId,input.keyId]);
    assertCanonicalRuntimeV1();
    const rows = capturedRows(queryResult, 1);
    if (!rows[0]) return undefined;
    const captured = exactHostDataSnapshotV1(rows[0], ["tenant_id", "node_id", "key_id", "algorithm",
      "public_key_spki", "key_state", "node_state", "valid_from", "valid_until"]);
    if (!captured || rows.length !== 1 || captured.tenant_id !== input.tenantId
      || captured.node_id !== input.actorId || captured.key_id !== input.keyId || captured.algorithm !== "ed25519"
      || typeof captured.public_key_spki !== "string"
      || (captured.key_state !== "active" && captured.key_state !== "retired"
        && captured.key_state !== "revoked")
      || (captured.node_state !== "active" && captured.node_state !== "draining"
        && captured.node_state !== "offline" && captured.node_state !== "pending_enrollment"
        && captured.node_state !== "quarantined" && captured.node_state !== "revoked")
      || !exactInstant(captured.valid_from)
      || (captured.valid_until !== null && !exactInstant(captured.valid_until))) {
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    }
    return objectFreezeV1({ tenantId: captured.tenant_id as string, actorId: captured.node_id as string,
      senderKind: "node" as const, keyId: captured.key_id as string, algorithm: "ed25519" as const,
      publicKeySpki: captured.public_key_spki, state: captured.key_state as TrustedProtocolKey["state"],
      principalState: captured.node_state as TrustedProtocolKey["principalState"],
      validFrom: captured.valid_from as string,
      ...(captured.valid_until ? { validUntil: captured.valid_until as string } : {}) });
  }
}

/** Replay persistence hardened against behavioral database results. */
class ProtectedEnrollmentReplayGuardV1 implements ReplayGuard {
  readonly #transaction: DatabaseClient["transaction"];

  constructor(db: DatabaseClient) {
    const transaction = dataMethodV1(db, "transaction") as DatabaseClient["transaction"] | undefined;
    if (!transaction) throw new ConnectionEnrollmentNodeDeliveryErrorV1("invalid_input");
    this.#transaction = ((callback) => reflectApplyV1(transaction, db, [callback])) as DatabaseClient["transaction"];
  }

  async consume(frame: SignedNodeFrame, receivedAt: string): Promise<"accepted" | "duplicate"> {
    if (frame.senderKind !== "node") throw new Error("node principal required");
    const disposition = await this.#transaction(async (tx) => {
      const frameDigest = sha256Digest(frame), nonceDigest = opaqueTokenDigest(frame.nonce);
      const priorRows = await safeQuery(tx, `SELECT message_id,nonce_digest,connection_id,sequence,frame_digest
        FROM node_protocol_replay WHERE tenant_id=$1 AND node_id=$2 AND key_id=$3
        AND (message_id=$4 OR nonce_digest=$5) FOR UPDATE`,
      [frame.tenantId,frame.actorId,frame.keyId,frame.messageId,nonceDigest], 2);
      if (priorRows.length) {
        const prior = priorRows.length === 1 ? exactHostDataSnapshotV1(priorRows[0],
          ["message_id", "nonce_digest", "connection_id", "sequence", "frame_digest"]) : undefined;
        if (prior && prior.message_id === frame.messageId && prior.nonce_digest === nonceDigest
          && prior.connection_id === frame.connectionId
          && numberConstructorV1(prior.sequence) === frame.sequence
          && prior.frame_digest === frameDigest) return "duplicate";
        throw new Error("protocol replay conflict");
      }
      const connectionRows = await safeQuery(tx, `SELECT last_sequence FROM node_protocol_connections
        WHERE tenant_id=$1 AND node_id=$2 AND connection_id=$3 AND direction=$4 FOR UPDATE`,
      [frame.tenantId,frame.actorId,frame.connectionId,frame.direction], 1);
      if (!connectionRows.length) {
        if (frame.sequence !== 1 || frame.type !== "connection.hello") throw new Error("connection hello required");
        const inserted = await safeQuery(tx, `INSERT INTO node_protocol_connections
          (tenant_id,node_id,connection_id,direction,last_sequence,last_message_id,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING tenant_id`,
        [frame.tenantId,frame.actorId,frame.connectionId,frame.direction,frame.sequence,frame.messageId,receivedAt], 1);
        if (inserted.length !== 1 || ownDataPropertyValueV1(inserted[0], "tenant_id") !== frame.tenantId) {
          throw new Error("connection persistence failed");
        }
      } else {
        const connection = connectionRows.length === 1
          ? exactHostDataSnapshotV1(connectionRows[0], ["last_sequence"]) : undefined;
        const lastSequence = connection ? numberConstructorV1(connection.last_sequence) : -1;
        if (!connection || !capturedNumberIsSafeInteger(lastSequence)
          || frame.sequence !== lastSequence + 1) throw new Error("non-monotonic sequence");
        const updated = await safeQuery(tx, `UPDATE node_protocol_connections SET last_sequence=$1,
          last_message_id=$2,updated_at=$3 WHERE tenant_id=$4 AND node_id=$5 AND connection_id=$6
          AND direction=$7 RETURNING tenant_id`, [frame.sequence,frame.messageId,receivedAt,frame.tenantId,
          frame.actorId,frame.connectionId,frame.direction], 1);
        if (updated.length !== 1 || ownDataPropertyValueV1(updated[0], "tenant_id") !== frame.tenantId) {
          throw new Error("connection persistence failed");
        }
      }
      const insertedReplay = await safeQuery(tx, `INSERT INTO node_protocol_replay
        (tenant_id,node_id,key_id,direction,message_id,nonce_digest,connection_id,sequence,received_at,expires_at,
          frame_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING tenant_id`,
      [frame.tenantId,frame.actorId,frame.keyId,frame.direction,frame.messageId,nonceDigest,frame.connectionId,
        frame.sequence,receivedAt,frame.expiresAt,frameDigest], 1);
      if (insertedReplay.length !== 1 || ownDataPropertyValueV1(insertedReplay[0], "tenant_id") !== frame.tenantId) {
        throw new Error("replay persistence failed");
      }
      return "accepted";
    });
    assertCanonicalRuntimeV1();
    return disposition;
  }
}

/**
 * Effect-free repository adapter. No listener or route is created here. A
 * separately configured server transport may call deliver() with one raw frame;
 * the durable read() capability is then consumed only by the protected intake.
 */
export class DatabaseConnectionEnrollmentNodeDeliveryAdapterV1
implements ConnectionEnrollmentProtectedDeliverySourceV1 {
  readonly #transaction: DatabaseClient["transaction"];
  readonly #authenticator: NodeProtocolAuthenticator;
  readonly #integrityKey: Uint8Array;

  constructor(db: DatabaseClient, integrityKeyValue: unknown, rateLimit: ProtocolRateLimitGuard) {
    assertCanonicalRuntimeV1();
    const transaction = dataMethodV1(db, "transaction") as DatabaseClient["transaction"] | undefined;
    const rateConsume = dataMethodV1(rateLimit, "consume") as ProtocolRateLimitGuard["consume"] | undefined;
    const integrityKey = exactHostUint8ArrayV1(integrityKeyValue, 128);
    if (!db || typeof db !== "object" || isHostProxyV1(db) || !transaction
      || !rateLimit || typeof rateLimit !== "object" || isHostProxyV1(rateLimit) || !rateConsume
      || !integrityKey || integrityKey.byteLength !== 32) {
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("invalid_input");
    }
    this.#transaction = ((callback) => reflectApplyV1(transaction, db, [callback])) as DatabaseClient["transaction"];
    this.#integrityKey = integrityKey.copy();
    this.#authenticator = new NodeProtocolAuthenticator(
      new ProtectedNodeKeyResolverV1(db),
      new ProtectedEnrollmentReplayGuardV1(db),
      objectFreezeV1({ consume: async (input: Parameters<ProtocolRateLimitGuard["consume"]>[0]) => {
        await reflectApplyV1(rateConsume, rateLimit, [input]);
        assertCanonicalRuntimeV1();
      } }),
    );
  }

  #headTag(row: Omit<DeliveryHeadRowV1, "head_auth_tag">): string {
    return hmacSha256Tag(this.#integrityKey, { kind: "connection_enrollment_delivery_head", ...headMaterial(row) });
  }

  #recordDigest(row: Omit<DeliveryRowV1, "record_auth_tag" | "payload" | "record_digest">): string {
    return sha256Digest({ kind: "connection_enrollment_node_delivery", ...recordMaterial(row) });
  }

  #recordTag(row: Omit<DeliveryRowV1, "record_auth_tag" | "payload">): string {
    const { record_digest: recordDigest, ...withoutDigest } = row;
    return hmacSha256Tag(this.#integrityKey, { kind: "connection_enrollment_node_delivery",
      ...recordMaterial(withoutDigest), recordDigest });
  }

  #verifyHead(value: unknown, tenantId: string): DeliveryHeadRowV1 {
    const captured = exactHostDataSnapshotV1(value,
      ["tenant_id", "last_sequence", "last_record_digest", "head_auth_tag", "updated_at"]);
    if (!captured) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    const row = captured as unknown as DeliveryHeadRowV1;
    let valid = false;
    try {
      const lastSequence = numberConstructorV1(row.last_sequence);
      valid = row.tenant_id === tenantId && capturedNumberIsSafeInteger(lastSequence)
        && lastSequence > 0 && patternMatchesV1(digestPattern, row.last_record_digest)
        && patternMatchesV1(authTagPattern, row.head_auth_tag)
        && exactInstant(row.updated_at) && same(row.head_auth_tag, this.#headTag(row));
    } catch { valid = false; }
    if (!valid) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    return row;
  }

  #verifyRow(value: unknown, tenantId: string, expectedSequence: number,
    expectedPreviousDigest: string | null): { row: DeliveryRowV1; payload: StoredPayloadV1;
      delivery: ConnectionEnrollmentProtectedDeliveryV1 } {
    const captured = exactHostDataSnapshotV1(value, ["tenant_id", "delivery_id", "sequence", "node_id",
      "connection_id", "key_id_digest", "protocol_message_digest", "protocol_frame_digest", "envelope_digest",
      "initial_protocol_disposition", "protected_delivery_digest", "payload_digest", "previous_record_digest",
      "record_digest", "record_auth_tag", "received_at", "payload"]);
    if (!captured) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    const row = captured as unknown as DeliveryRowV1, payload = captureStoredPayload(row.payload);
    const delivery = buildConnectionEnrollmentProtectedDeliveryV1(payload);
    let valid = false;
    try {
      const { record_digest: _recordDigest, record_auth_tag: _recordAuthTag,
        payload: _payload, ...digestInput } = row;
      void _recordDigest; void _recordAuthTag; void _payload;
      valid = row.tenant_id === tenantId && isConnectionEnrollmentDeliveryIdV1(row.delivery_id)
        && patternMatchesV1(idPattern, row.node_id) && patternMatchesV1(idPattern, row.connection_id)
        && numberConstructorV1(row.sequence) === expectedSequence
        && (row.initial_protocol_disposition === "accepted" || row.initial_protocol_disposition === "duplicate")
        && row.previous_record_digest === expectedPreviousDigest && row.delivery_id === payload.deliveryId
        && row.received_at === payload.authenticatedAt && payload.envelope.body.tenantId === row.tenant_id
        && payload.envelope.body.nodeId === row.node_id && payload.envelope.body.connectionId === row.connection_id
        && row.key_id_digest === sha256Digest({ keyId: payload.envelope.attestation.keyId })
        && row.envelope_digest === sha256Digest(payload.envelope)
        && row.protected_delivery_digest === sha256Digest(delivery)
        && patternMatchesV1(digestPattern, row.record_digest)
        && patternMatchesV1(authTagPattern, row.record_auth_tag)
        && row.payload_digest === sha256Digest(payload) && row.record_digest === this.#recordDigest(digestInput)
        && same(row.record_auth_tag, this.#recordTag(row));
    } catch { valid = false; }
    if (!valid) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    return { row, payload, delivery };
  }

  async #verifiedStream(tx: DatabaseSession, tenantId: string): Promise<{
    head?: DeliveryHeadRowV1;
    rows: DeliveryRowV1[];
    deliveries: ConnectionEnrollmentProtectedDeliveryV1[];
  }> {
    const headRows = await safeQuery(tx, `SELECT tenant_id,last_sequence,last_record_digest,head_auth_tag,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      FROM control_connection_enrollment_delivery_heads WHERE tenant_id=$1 FOR UPDATE`, [tenantId], 1);
    const rawRows = await safeQuery(tx, `SELECT ${selectedDeliveryColumns}
      FROM control_connection_enrollment_protocol_deliveries WHERE tenant_id=$1 ORDER BY sequence FOR UPDATE`,
    [tenantId]);
    if (!headRows[0]) {
      if (rawRows.length) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
      return { rows: [], deliveries: [] };
    }
    const head = this.#verifyHead(headRows[0], tenantId), rows: DeliveryRowV1[] = [],
      deliveries: ConnectionEnrollmentProtectedDeliveryV1[] = [];
    let previous: string | null = null;
    for (let index = 0; index < rawRows.length; index += 1) {
      const verified = this.#verifyRow(rawRows[index], tenantId, index + 1, previous);
      rows[index] = verified.row; deliveries[index] = verified.delivery; previous = verified.row.record_digest;
    }
    if (numberConstructorV1(head.last_sequence) !== rows.length || head.last_record_digest !== previous) {
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    }
    return { head, rows, deliveries };
  }

  async deliver(raw: unknown, optionsValue: unknown): Promise<ConnectionEnrollmentNodeDeliveryReceiptV1> {
    assertCanonicalRuntimeV1();
    const options = exactHostDataSnapshotV1(optionsValue, ["receivedAt", "transportIdentity"]);
    if (typeof raw !== "string" || !options || !exactInstant(options.receivedAt)
      || typeof options.transportIdentity !== "string" || options.transportIdentity.length < 3
      || options.transportIdentity.length > 256) {
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("invalid_input");
    }
    let authenticated: Awaited<ReturnType<NodeProtocolAuthenticator["verify"]>>;
    try {
      authenticated = await this.#authenticator.verify(raw, {
        expectedDirection: "node_to_server",
        receivedAt: options.receivedAt,
        transportIdentity: options.transportIdentity,
      });
      assertCanonicalRuntimeV1();
    } catch (error) {
      if (capturedProtocolAuthenticationCodeV1(error) !== undefined) {
        throw new ConnectionEnrollmentNodeDeliveryErrorV1("authentication_failed");
      }
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    }
    const frame = authenticated.frame;
    if (frame.type !== "connection.enrollment.deliver") {
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("wrong_message_type");
    }
    let envelope: IdeaLabHermes021ConnectionEnrollmentEnvelopeV1;
    try { envelope = parseIdeaLabHermes021ConnectionEnrollmentEnvelopeV1(frame.body.envelope); }
    catch { throw new ConnectionEnrollmentNodeDeliveryErrorV1("scope_mismatch"); }
    assertCanonicalRuntimeV1();
    if (frame.body.enrollmentContract !== IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1
      || frame.body.enrollmentContract !== envelope.body.contractVersion
      || frame.body.envelopeDigest !== sha256Digest(envelope) || envelope.body.tenantId !== frame.tenantId
      || envelope.body.nodeId !== frame.actorId || envelope.body.connectionId !== frame.connectionId
      || envelope.attestation.keyId !== frame.keyId) {
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("scope_mismatch");
    }
    const protocolFrameDigest = sha256Digest(frame), protocolMessageDigest = sha256Digest({
      tenantId: frame.tenantId, nodeId: frame.actorId, messageId: frame.messageId,
    }), nonceDigest = opaqueTokenDigest(frame.nonce);
    let result: {
      delivery: ConnectionEnrollmentProtectedDeliveryV1;
      canonicalReceivedAt: string;
      protocolDisposition: "accepted" | "duplicate";
      ledgerDisposition: "accepted" | "duplicate";
    };
    try {
      result = await this.#transaction(async (tx) => {
        const tenantRows = await safeQuery(tx, `SELECT id AS tenant_id FROM tenants WHERE id=$1 FOR UPDATE`,
          [frame.tenantId], 1);
        if (tenantRows.length !== 1 || ownDataPropertyValueV1(tenantRows[0], "tenant_id") !== frame.tenantId) {
          throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
        }
        const replayRows = await safeQuery(tx, `SELECT tenant_id,node_id,key_id,direction,message_id,nonce_digest,
          connection_id,sequence,frame_digest,
          to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at
          FROM node_protocol_replay WHERE tenant_id=$1 AND node_id=$2 AND key_id=$3 AND direction=$4
          AND message_id=$5 FOR UPDATE`, [frame.tenantId,frame.actorId,frame.keyId,frame.direction,frame.messageId], 1);
        const replay = replayRows.length === 1 ? exactHostDataSnapshotV1(replayRows[0], ["tenant_id", "node_id",
          "key_id", "direction", "message_id", "nonce_digest", "connection_id", "sequence", "frame_digest",
          "received_at"]) : undefined;
        if (!replay || replay.tenant_id !== frame.tenantId || replay.node_id !== frame.actorId
          || replay.key_id !== frame.keyId || replay.direction !== frame.direction
          || replay.message_id !== frame.messageId || replay.nonce_digest !== nonceDigest
          || replay.connection_id !== frame.connectionId
          || numberConstructorV1(replay.sequence) !== frame.sequence || replay.frame_digest !== protocolFrameDigest
          || !exactInstant(replay.received_at)) {
          throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
        }
        const canonicalReceivedAt = replay.received_at;
        const payload = objectFreezeV1({ deliveryId: frame.body.deliveryId,
          authenticatedAt: canonicalReceivedAt, envelope });
        let delivery: ConnectionEnrollmentProtectedDeliveryV1;
        try { delivery = buildConnectionEnrollmentProtectedDeliveryV1(payload); }
        catch { throw new ConnectionEnrollmentNodeDeliveryErrorV1("scope_mismatch"); }
        const stream = await this.#verifiedStream(tx, frame.tenantId);
        let existingIndex = -1;
        for (let index = 0; index < stream.rows.length; index += 1) {
          const row = stream.rows[index]!;
          if (row.delivery_id === frame.body.deliveryId || row.protocol_message_digest === protocolMessageDigest) {
            if (existingIndex >= 0) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
            existingIndex = index;
          }
        }
        if (existingIndex >= 0) {
          const row = stream.rows[existingIndex]!, existingDelivery = stream.deliveries[existingIndex]!;
          if (row.delivery_id !== frame.body.deliveryId || row.protocol_message_digest !== protocolMessageDigest
            || row.protocol_frame_digest !== protocolFrameDigest || row.envelope_digest !== frame.body.envelopeDigest
            || row.protected_delivery_digest !== sha256Digest(delivery)
            || existingDelivery.deliveryEvidenceDigest !== delivery.deliveryEvidenceDigest
            || row.received_at !== canonicalReceivedAt) {
            throw new ConnectionEnrollmentNodeDeliveryErrorV1("replay_conflict");
          }
          return { delivery: existingDelivery, canonicalReceivedAt,
            protocolDisposition: row.initial_protocol_disposition, ledgerDisposition: "accepted" as const };
        }
        const sequence = stream.rows.length + 1;
        const rowBase: Omit<DeliveryRowV1, "record_auth_tag" | "payload" | "record_digest"> = {
          tenant_id: frame.tenantId, delivery_id: frame.body.deliveryId, sequence, node_id: frame.actorId,
          connection_id: frame.connectionId, key_id_digest: sha256Digest({ keyId: frame.keyId }),
          protocol_message_digest: protocolMessageDigest, protocol_frame_digest: protocolFrameDigest,
          initial_protocol_disposition: authenticated.delivery,
          envelope_digest: frame.body.envelopeDigest, protected_delivery_digest: sha256Digest(delivery),
          payload_digest: sha256Digest(payload), previous_record_digest: stream.head?.last_record_digest ?? null,
          received_at: canonicalReceivedAt,
        };
        const recordDigest = this.#recordDigest(rowBase), row = { ...rowBase, record_digest: recordDigest };
        const inserted = await safeQuery(tx, `INSERT INTO control_connection_enrollment_protocol_deliveries
          (${deliveryColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
          RETURNING tenant_id`, [row.tenant_id,row.delivery_id,row.sequence,row.node_id,row.connection_id,
          row.key_id_digest,row.protocol_message_digest,row.protocol_frame_digest,row.initial_protocol_disposition,
          row.envelope_digest,
          row.protected_delivery_digest,row.payload_digest,row.previous_record_digest,row.record_digest,
          this.#recordTag(row),row.received_at,
          reflectApplyV1(jsonStringifyV1, jsonObjectV1, [payload]) as string], 1);
        if (inserted.length !== 1 || ownDataPropertyValueV1(inserted[0], "tenant_id") !== frame.tenantId) {
          throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
        }
        const nextHead: Omit<DeliveryHeadRowV1, "head_auth_tag"> = { tenant_id: frame.tenantId,
          last_sequence: sequence, last_record_digest: recordDigest, updated_at: canonicalReceivedAt };
        const headResult = stream.head
          ? await safeQuery(tx, `UPDATE control_connection_enrollment_delivery_heads SET last_sequence=$1,
            last_record_digest=$2,head_auth_tag=$3,updated_at=$4 WHERE tenant_id=$5 RETURNING tenant_id`,
          [nextHead.last_sequence,nextHead.last_record_digest,this.#headTag(nextHead),nextHead.updated_at,
            nextHead.tenant_id], 1)
          : await safeQuery(tx, `INSERT INTO control_connection_enrollment_delivery_heads
            (tenant_id,last_sequence,last_record_digest,head_auth_tag,updated_at)
            VALUES($1,$2,$3,$4,$5) RETURNING tenant_id`, [nextHead.tenant_id,nextHead.last_sequence,
            nextHead.last_record_digest,this.#headTag(nextHead),nextHead.updated_at], 1);
        if (headResult.length !== 1 || ownDataPropertyValueV1(headResult[0], "tenant_id") !== frame.tenantId) {
          throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
        }
        return { delivery, canonicalReceivedAt,
          protocolDisposition: authenticated.delivery, ledgerDisposition: "accepted" as const };
      });
      assertCanonicalRuntimeV1();
    } catch (error) {
      const code = capturedDeliveryErrorCodeV1(error);
      if (code) throw new ConnectionEnrollmentNodeDeliveryErrorV1(code);
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    }
    const material: Omit<ConnectionEnrollmentNodeDeliveryReceiptV1, "receiptDigest"> = {
      contractVersion: CONNECTION_ENROLLMENT_NODE_DELIVERY_RECEIPT_V1,
      deliveryReference: `delivery:${reflectApplyV1(stringSliceV1, result.delivery.deliveryEvidenceDigest,
        [7, 31]) as string}`,
      protocolFrameDigest,
      deliveryEvidenceDigest: result.delivery.deliveryEvidenceDigest,
      receivedAt: result.canonicalReceivedAt,
      protocolDisposition: result.protocolDisposition,
      ledgerDisposition: result.ledgerDisposition,
      grantsApproval: false,
      grantsNetworkAuthority: false,
      grantsCommandAuthority: false,
      grantsLeaseAuthority: false,
      grantsExecutionAuthority: false,
    };
    return parseConnectionEnrollmentNodeDeliveryReceiptV1({ ...material, receiptDigest: sha256Digest(material) });
  }

  async read(inputValue: unknown): Promise<ConnectionEnrollmentProtectedDeliveryV1> {
    assertCanonicalRuntimeV1();
    const input = exactHostDataSnapshotV1(inputValue, ["deliveryId", "receivedAt"]);
    if (!input || !isConnectionEnrollmentDeliveryIdV1(input.deliveryId)
      || !exactInstant(input.receivedAt)) throw new ConnectionEnrollmentNodeDeliveryErrorV1("invalid_input");
    try {
      const result = await this.#transaction(async (tx) => {
        const selected = await safeQuery(tx, `SELECT tenant_id FROM control_connection_enrollment_protocol_deliveries
          WHERE delivery_id=$1 FOR UPDATE`, [input.deliveryId], 1);
        if (selected.length !== 1) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
        const tenantId = ownDataPropertyValueV1(selected[0], "tenant_id");
        if (typeof tenantId !== "string" || !patternMatchesV1(idPattern, tenantId)) {
          throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
        }
        const stream = await this.#verifiedStream(tx, tenantId);
        let found: { row: DeliveryRowV1; delivery: ConnectionEnrollmentProtectedDeliveryV1 } | undefined;
        for (let index = 0; index < stream.rows.length; index += 1) {
          if (stream.rows[index]!.delivery_id === input.deliveryId) {
            if (found) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
            found = { row: stream.rows[index]!, delivery: stream.deliveries[index]! };
          }
        }
        if (!found || found.row.received_at !== input.receivedAt
          || found.delivery.authenticatedAt !== input.receivedAt) {
          throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
        }
        return found.delivery;
      });
      assertCanonicalRuntimeV1();
      return result;
    } catch (error) {
      const code = capturedDeliveryErrorCodeV1(error);
      if (code) throw new ConnectionEnrollmentNodeDeliveryErrorV1(code);
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    }
  }
}
