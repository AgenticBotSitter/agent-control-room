import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
  parseIdeaLabHermes021ConnectionEnrollmentEnvelopeV1,
  type IdeaLabHermes021ConnectionEnrollmentEnvelopeV1,
} from "../../idea-lab/v1";
import {
  NodeProtocolAuthenticator,
  opaqueTokenDigest,
  ProtocolAuthenticationError,
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
const capturedNumberIsSafeInteger = Number.isSafeInteger;

const receiptSchema = z.object({
  contractVersion: z.literal(CONNECTION_ENROLLMENT_NODE_DELIVERY_RECEIPT_V1),
  deliveryReference: z.string().regex(/^delivery:[a-f0-9]{24}$/),
  protocolFrameDigest: z.string().regex(digestPattern),
  deliveryEvidenceDigest: z.string().regex(digestPattern),
  receivedAt: z.string(),
  protocolDisposition: z.enum(["accepted", "duplicate"]),
  ledgerDisposition: z.enum(["accepted", "duplicate"]),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  receiptDigest: z.string().regex(digestPattern),
}).strict();

export type ConnectionEnrollmentNodeDeliveryReceiptV1 = z.infer<typeof receiptSchema>;

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
  protocol_message_digest,protocol_frame_digest,envelope_digest,protected_delivery_digest,payload_digest,
  previous_record_digest,record_digest,record_auth_tag,
  to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,payload`;
const deliveryColumns = `tenant_id,delivery_id,sequence,node_id,connection_id,key_id_digest,
  protocol_message_digest,protocol_frame_digest,envelope_digest,protected_delivery_digest,payload_digest,
  previous_record_digest,record_digest,record_auth_tag,received_at,payload`;

function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function exactInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
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
  return capturedRows(await query.call(tx, statement, params), maximum);
}

function headMaterial(row: Omit<DeliveryHeadRowV1, "head_auth_tag">) {
  return { tenantId: row.tenant_id, lastSequence: Number(row.last_sequence),
    lastRecordDigest: row.last_record_digest, updatedAt: row.updated_at };
}

function recordMaterial(row: Omit<DeliveryRowV1, "record_auth_tag" | "payload" | "record_digest">) {
  return {
    tenantId: row.tenant_id, deliveryId: row.delivery_id, sequence: Number(row.sequence), nodeId: row.node_id,
    connectionId: row.connection_id, keyIdDigest: row.key_id_digest,
    protocolMessageDigest: row.protocol_message_digest, protocolFrameDigest: row.protocol_frame_digest,
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
  const captured = exactHostDataSnapshotV1(value, ["contractVersion", "deliveryReference", "protocolFrameDigest",
    "deliveryEvidenceDigest", "receivedAt", "protocolDisposition", "ledgerDisposition", "grantsApproval",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "receiptDigest"]);
  if (!captured) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
  let parsed: ConnectionEnrollmentNodeDeliveryReceiptV1;
  try { parsed = receiptSchema.parse(captured); }
  catch { throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed"); }
  if (!exactInstant(parsed.receivedAt) || sha256Digest(unsignedReceipt(parsed)) !== parsed.receiptDigest) {
    throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
  }
  try { assertNoSecretMaterial(parsed, "connection enrollment node delivery receipt"); }
  catch { throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed"); }
  return Object.freeze(parsed);
}

function captureStoredPayload(value: unknown): StoredPayloadV1 {
  const captured = exactHostDataSnapshotV1(value, ["deliveryId", "authenticatedAt", "envelope"]);
  if (!captured || typeof captured.deliveryId !== "string" || !idPattern.test(captured.deliveryId)
    || !exactInstant(captured.authenticatedAt)) {
    throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
  }
  let envelope: IdeaLabHermes021ConnectionEnrollmentEnvelopeV1;
  try { envelope = parseIdeaLabHermes021ConnectionEnrollmentEnvelopeV1(captured.envelope); }
  catch { throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed"); }
  return Object.freeze({ deliveryId: captured.deliveryId, authenticatedAt: captured.authenticatedAt, envelope });
}

export class ConnectionEnrollmentNodeDeliveryErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_input" | "authentication_failed" | "wrong_message_type" |
    "scope_mismatch" | "replay_conflict" | "integrity_failed") {
    super(safeCode); this.name = "ConnectionEnrollmentNodeDeliveryErrorV1";
  }
}

/** Exact-row resolver used only by this hostile live-ingress boundary. */
class ProtectedNodeKeyResolverV1 implements TrustedKeyResolver {
  readonly #query: DatabaseSession["query"];

  constructor(db: DatabaseClient) {
    const query = dataMethodV1(db, "query") as DatabaseSession["query"] | undefined;
    if (!query) throw new ConnectionEnrollmentNodeDeliveryErrorV1("invalid_input");
    this.#query = ((statement, params = []) => query.call(db, statement, params)) as DatabaseSession["query"];
  }

  async resolve(input: { tenantId: string; actorId: string; senderKind: "node" | "control_room"; keyId: string }):
  Promise<TrustedProtocolKey | undefined> {
    if (input.senderKind !== "node") return undefined;
    const rows = capturedRows(await this.#query(`SELECT k.tenant_id,k.node_id,k.id AS key_id,k.algorithm,
      k.public_key_spki,k.state AS key_state,n.state AS node_state,
      to_char(k.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_from,
      CASE WHEN k.valid_until IS NULL THEN NULL ELSE
        to_char(k.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS valid_until
      FROM control_node_keys k JOIN control_nodes n ON n.tenant_id=k.tenant_id AND n.id=k.node_id
      WHERE k.tenant_id=$1 AND k.node_id=$2 AND k.id=$3`,
    [input.tenantId,input.actorId,input.keyId]), 1);
    if (!rows[0]) return undefined;
    const captured = exactHostDataSnapshotV1(rows[0], ["tenant_id", "node_id", "key_id", "algorithm",
      "public_key_spki", "key_state", "node_state", "valid_from", "valid_until"]);
    if (!captured || rows.length !== 1 || captured.tenant_id !== input.tenantId
      || captured.node_id !== input.actorId || captured.key_id !== input.keyId || captured.algorithm !== "ed25519"
      || typeof captured.public_key_spki !== "string" || !["active", "retired", "revoked"].includes(
        captured.key_state as string)
      || !["active", "draining", "offline", "pending_enrollment", "quarantined", "revoked"].includes(
        captured.node_state as string)
      || !exactInstant(captured.valid_from)
      || (captured.valid_until !== null && !exactInstant(captured.valid_until))) {
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    }
    return Object.freeze({ tenantId: captured.tenant_id as string, actorId: captured.node_id as string,
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
    this.#transaction = ((callback) => transaction.call(db, callback)) as DatabaseClient["transaction"];
  }

  async consume(frame: SignedNodeFrame, receivedAt: string): Promise<"accepted" | "duplicate"> {
    if (frame.senderKind !== "node") throw new Error("node principal required");
    return this.#transaction(async (tx) => {
      const frameDigest = sha256Digest(frame), nonceDigest = opaqueTokenDigest(frame.nonce);
      const priorRows = await safeQuery(tx, `SELECT message_id,nonce_digest,connection_id,sequence,frame_digest
        FROM node_protocol_replay WHERE tenant_id=$1 AND node_id=$2 AND key_id=$3
        AND (message_id=$4 OR nonce_digest=$5) FOR UPDATE`,
      [frame.tenantId,frame.actorId,frame.keyId,frame.messageId,nonceDigest], 2);
      if (priorRows.length) {
        const prior = priorRows.length === 1 ? exactHostDataSnapshotV1(priorRows[0],
          ["message_id", "nonce_digest", "connection_id", "sequence", "frame_digest"]) : undefined;
        if (prior && prior.message_id === frame.messageId && prior.nonce_digest === nonceDigest
          && prior.connection_id === frame.connectionId && Number(prior.sequence) === frame.sequence
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
        if (!connection || !capturedNumberIsSafeInteger(Number(connection.last_sequence))
          || frame.sequence !== Number(connection.last_sequence) + 1) throw new Error("non-monotonic sequence");
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
    const transaction = dataMethodV1(db, "transaction") as DatabaseClient["transaction"] | undefined;
    const rateConsume = dataMethodV1(rateLimit, "consume") as ProtocolRateLimitGuard["consume"] | undefined;
    const integrityKey = exactHostUint8ArrayV1(integrityKeyValue, 128);
    if (!db || typeof db !== "object" || isHostProxyV1(db) || !transaction
      || !rateLimit || typeof rateLimit !== "object" || isHostProxyV1(rateLimit) || !rateConsume
      || !integrityKey || integrityKey.byteLength !== 32) {
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("invalid_input");
    }
    this.#transaction = ((callback) => transaction.call(db, callback)) as DatabaseClient["transaction"];
    this.#integrityKey = integrityKey.copy();
    this.#authenticator = new NodeProtocolAuthenticator(
      new ProtectedNodeKeyResolverV1(db),
      new ProtectedEnrollmentReplayGuardV1(db),
      Object.freeze({ consume: (input: Parameters<ProtocolRateLimitGuard["consume"]>[0]) =>
        rateConsume.call(rateLimit, input) }),
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
      valid = row.tenant_id === tenantId && capturedNumberIsSafeInteger(Number(row.last_sequence))
        && Number(row.last_sequence) > 0 && digestPattern.test(row.last_record_digest)
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
      "protected_delivery_digest", "payload_digest", "previous_record_digest", "record_digest", "record_auth_tag",
      "received_at", "payload"]);
    if (!captured) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    const row = captured as unknown as DeliveryRowV1, payload = captureStoredPayload(row.payload);
    const delivery = buildConnectionEnrollmentProtectedDeliveryV1(payload);
    let valid = false;
    try {
      const { record_digest: _recordDigest, record_auth_tag: _recordAuthTag,
        payload: _payload, ...digestInput } = row;
      void _recordDigest; void _recordAuthTag; void _payload;
      valid = row.tenant_id === tenantId && idPattern.test(row.delivery_id) && idPattern.test(row.node_id)
        && idPattern.test(row.connection_id) && Number(row.sequence) === expectedSequence
        && row.previous_record_digest === expectedPreviousDigest && row.delivery_id === payload.deliveryId
        && row.received_at === payload.authenticatedAt && payload.envelope.body.tenantId === row.tenant_id
        && payload.envelope.body.nodeId === row.node_id && payload.envelope.body.connectionId === row.connection_id
        && row.key_id_digest === sha256Digest({ keyId: payload.envelope.attestation.keyId })
        && row.envelope_digest === sha256Digest(payload.envelope)
        && row.protected_delivery_digest === sha256Digest(delivery)
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
    if (Number(head.last_sequence) !== rows.length || head.last_record_digest !== previous) {
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    }
    return { head, rows, deliveries };
  }

  async deliver(raw: unknown, optionsValue: unknown): Promise<ConnectionEnrollmentNodeDeliveryReceiptV1> {
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
    } catch (error) {
      if (error instanceof ProtocolAuthenticationError) {
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
    if (frame.body.enrollmentContract !== IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1
      || frame.body.enrollmentContract !== envelope.body.contractVersion
      || frame.body.envelopeDigest !== sha256Digest(envelope) || envelope.body.tenantId !== frame.tenantId
      || envelope.body.nodeId !== frame.actorId || envelope.body.connectionId !== frame.connectionId
      || envelope.attestation.keyId !== frame.keyId) {
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("scope_mismatch");
    }
    const payload = Object.freeze({ deliveryId: frame.body.deliveryId,
      authenticatedAt: options.receivedAt, envelope });
    const delivery = buildConnectionEnrollmentProtectedDeliveryV1(payload);
    const protocolFrameDigest = sha256Digest(frame), protocolMessageDigest = sha256Digest({
      tenantId: frame.tenantId, nodeId: frame.actorId, messageId: frame.messageId,
    });
    let ledgerDisposition: "accepted" | "duplicate" = "accepted";
    try {
      ledgerDisposition = await this.#transaction(async (tx) => {
        const tenantRows = await safeQuery(tx, `SELECT id AS tenant_id FROM tenants WHERE id=$1 FOR UPDATE`,
          [frame.tenantId], 1);
        if (tenantRows.length !== 1 || ownDataPropertyValueV1(tenantRows[0], "tenant_id") !== frame.tenantId) {
          throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
        }
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
            || row.received_at !== options.receivedAt) {
            throw new ConnectionEnrollmentNodeDeliveryErrorV1("replay_conflict");
          }
          return "duplicate" as const;
        }
        const sequence = stream.rows.length + 1;
        const rowBase: Omit<DeliveryRowV1, "record_auth_tag" | "payload" | "record_digest"> = {
          tenant_id: frame.tenantId, delivery_id: frame.body.deliveryId, sequence, node_id: frame.actorId,
          connection_id: frame.connectionId, key_id_digest: sha256Digest({ keyId: frame.keyId }),
          protocol_message_digest: protocolMessageDigest, protocol_frame_digest: protocolFrameDigest,
          envelope_digest: frame.body.envelopeDigest, protected_delivery_digest: sha256Digest(delivery),
          payload_digest: sha256Digest(payload), previous_record_digest: stream.head?.last_record_digest ?? null,
          received_at: options.receivedAt as string,
        };
        const recordDigest = this.#recordDigest(rowBase), row = { ...rowBase, record_digest: recordDigest };
        const inserted = await safeQuery(tx, `INSERT INTO control_connection_enrollment_protocol_deliveries
          (${deliveryColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
          RETURNING tenant_id`, [row.tenant_id,row.delivery_id,row.sequence,row.node_id,row.connection_id,
          row.key_id_digest,row.protocol_message_digest,row.protocol_frame_digest,row.envelope_digest,
          row.protected_delivery_digest,row.payload_digest,row.previous_record_digest,row.record_digest,
          this.#recordTag(row),row.received_at,JSON.stringify(payload)], 1);
        if (inserted.length !== 1 || ownDataPropertyValueV1(inserted[0], "tenant_id") !== frame.tenantId) {
          throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
        }
        const nextHead: Omit<DeliveryHeadRowV1, "head_auth_tag"> = { tenant_id: frame.tenantId,
          last_sequence: sequence, last_record_digest: recordDigest, updated_at: options.receivedAt as string };
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
        return "accepted" as const;
      });
    } catch (error) {
      if (error instanceof ConnectionEnrollmentNodeDeliveryErrorV1) throw error;
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    }
    const material: Omit<ConnectionEnrollmentNodeDeliveryReceiptV1, "receiptDigest"> = {
      contractVersion: CONNECTION_ENROLLMENT_NODE_DELIVERY_RECEIPT_V1,
      deliveryReference: `delivery:${delivery.deliveryEvidenceDigest.slice(7, 31)}`,
      protocolFrameDigest,
      deliveryEvidenceDigest: delivery.deliveryEvidenceDigest,
      receivedAt: options.receivedAt as string,
      protocolDisposition: authenticated.delivery,
      ledgerDisposition,
      grantsApproval: false,
      grantsNetworkAuthority: false,
      grantsCommandAuthority: false,
      grantsLeaseAuthority: false,
      grantsExecutionAuthority: false,
    };
    return parseConnectionEnrollmentNodeDeliveryReceiptV1({ ...material, receiptDigest: sha256Digest(material) });
  }

  async read(inputValue: unknown): Promise<ConnectionEnrollmentProtectedDeliveryV1> {
    const input = exactHostDataSnapshotV1(inputValue, ["deliveryId", "receivedAt"]);
    if (!input || typeof input.deliveryId !== "string" || !idPattern.test(input.deliveryId)
      || !exactInstant(input.receivedAt)) throw new ConnectionEnrollmentNodeDeliveryErrorV1("invalid_input");
    try {
      return await this.#transaction(async (tx) => {
        const selected = await safeQuery(tx, `SELECT tenant_id FROM control_connection_enrollment_protocol_deliveries
          WHERE delivery_id=$1 FOR UPDATE`, [input.deliveryId], 1);
        if (selected.length !== 1) throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
        const tenantId = ownDataPropertyValueV1(selected[0], "tenant_id");
        if (typeof tenantId !== "string" || !idPattern.test(tenantId)) {
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
    } catch (error) {
      if (error instanceof ConnectionEnrollmentNodeDeliveryErrorV1) throw error;
      throw new ConnectionEnrollmentNodeDeliveryErrorV1("integrity_failed");
    }
  }
}
