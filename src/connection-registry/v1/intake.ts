import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  parseIdeaLabHermes021ConnectionEnrollmentEnvelopeV1,
  sanitizeIdeaLabHermes021ConnectionEnrollmentV1,
  type IdeaLabHermes021ConnectionEnrollmentEnvelopeV1,
  type IdeaLabHermes021ConnectionSafeResultV1,
} from "../../idea-lab/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { isConnectionEnrollmentDeliveryIdV1 } from "../../node-protocol/v1";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import {
  dataMethodV1,
  exactHostDataArrayV1,
  exactHostDataSnapshotV1,
  exactHostErrorCodeV1,
  exactHostUint8ArrayV1,
  isHostProxyV1,
  ownDataPropertyValueV1,
} from "../../security/host-value";
import { ConnectionRegistryErrorV1, ConnectionRegistryStoreV1 } from "./store";

const connectionRegistryErrorPrototypeV1 = ConnectionRegistryErrorV1.prototype;

export const CONNECTION_ENROLLMENT_PROTECTED_DELIVERY_V1 =
  "control-room-connection-enrollment-protected-delivery/v1" as const;
export const CONNECTION_ENROLLMENT_INTAKE_RECEIPT_V1 =
  "control-room-connection-enrollment-intake-receipt/v1" as const;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const base64urlPattern = /^[A-Za-z0-9_-]{40,256}$/;
const capturedNumberIsSafeInteger = Number.isSafeInteger;

const receiptSchema = z.object({
  contractVersion: z.literal(CONNECTION_ENROLLMENT_INTAKE_RECEIPT_V1),
  intakeReference: z.string().regex(/^intake:[a-f0-9]{24}$/),
  deliveryEvidenceDigest: z.string().regex(digestPattern),
  enrollmentResultDigest: z.string().regex(digestPattern),
  registryRevision: z.number().int().positive(),
  recordedAt: z.string(),
  disposition: z.literal("accepted"),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  receiptDigest: z.string().regex(digestPattern),
}).strict();

export type ConnectionEnrollmentIntakeReceiptV1 = z.infer<typeof receiptSchema>;

export interface ConnectionEnrollmentProtectedDeliverySourceV1 {
  /** Server-held capability. It is never implemented by an HTTP or browser caller. */
  read(input: { deliveryId: string; receivedAt: string }): Promise<unknown>;
}

interface CapturedDeliveryV1 {
  contractVersion: typeof CONNECTION_ENROLLMENT_PROTECTED_DELIVERY_V1;
  deliveryId: string;
  deliveryBasis: "protected_server_source";
  tenantId: string;
  nodeId: string;
  connectionId: string;
  keyId: string;
  authenticatedAt: string;
  envelopeDigest: string;
  envelope: IdeaLabHermes021ConnectionEnrollmentEnvelopeV1;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  deliveryEvidenceDigest: string;
}

export type ConnectionEnrollmentProtectedDeliveryV1 = Readonly<CapturedDeliveryV1>;

interface TrustedNodeKeyRowV1 {
  tenant_id: string;
  node_id: string;
  key_id: string;
  algorithm: string;
  public_key_spki: string;
  key_state: string;
  node_state: string;
  valid_from: string;
  valid_until: string | null;
}

interface IntakeHeadRowV1 {
  tenant_id: string;
  last_sequence: number | string;
  last_audit_record_digest: string | null;
  head_auth_tag: string;
  updated_at: string;
}

interface IntakeRowV1 {
  tenant_id: string;
  delivery_id: string;
  enrollment_id: string;
  connection_id: string;
  node_id: string;
  key_id_digest: string;
  sequence: number | string;
  delivery_evidence_digest: string;
  envelope_digest: string;
  enrollment_result_digest: string;
  registry_revision: number | string;
  payload_digest: string;
  previous_audit_record_digest: string | null;
  audit_record_digest: string;
  receipt_auth_tag: string;
  received_at: string;
  payload: unknown;
}

const intakeColumns = `tenant_id,delivery_id,enrollment_id,connection_id,node_id,key_id_digest,sequence,
  delivery_evidence_digest,envelope_digest,enrollment_result_digest,registry_revision,payload_digest,
  previous_audit_record_digest,audit_record_digest,receipt_auth_tag,received_at,payload`;
const selectedIntakeColumns = `tenant_id,delivery_id,enrollment_id,connection_id,node_id,key_id_digest,sequence,
  delivery_evidence_digest,envelope_digest,enrollment_result_digest,registry_revision,payload_digest,
  previous_audit_record_digest,audit_record_digest,receipt_auth_tag,
  to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,payload`;

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
  if (!rows) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
  return rows;
}

async function safeQuery(tx: DatabaseSession, statement: string, params: unknown[], maximum = 10_000): Promise<unknown[]> {
  const query = dataMethodV1(tx, "query");
  if (!query) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
  return capturedRows(await query.call(tx, statement, params), maximum);
}

function requireReturnedTenant(rows: unknown[], tenantId: string): void {
  if (rows.length !== 1) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
  const captured = exactHostDataSnapshotV1(rows[0], ["tenant_id"]);
  if (!captured || captured.tenant_id !== tenantId) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
}

function unsignedReceipt(value: ConnectionEnrollmentIntakeReceiptV1): Omit<ConnectionEnrollmentIntakeReceiptV1,
  "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = value;
  void _receiptDigest;
  return unsigned;
}

export function parseConnectionEnrollmentIntakeReceiptV1(value: unknown): ConnectionEnrollmentIntakeReceiptV1 {
  const captured = exactHostDataSnapshotV1(value, ["contractVersion", "intakeReference", "deliveryEvidenceDigest",
    "enrollmentResultDigest", "registryRevision", "recordedAt", "disposition", "grantsApproval",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "receiptDigest"]);
  if (!captured) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
  let parsed: ConnectionEnrollmentIntakeReceiptV1;
  try { parsed = receiptSchema.parse(captured); }
  catch { throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed"); }
  if (!exactInstant(parsed.recordedAt) || sha256Digest(unsignedReceipt(parsed)) !== parsed.receiptDigest) {
    throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
  }
  try { assertNoSecretMaterial(parsed, "connection enrollment intake receipt"); }
  catch { throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed"); }
  return Object.freeze(parsed);
}

function deliveryMaterial(delivery: Omit<CapturedDeliveryV1, "envelope" | "deliveryEvidenceDigest">) {
  return delivery;
}

/**
 * Packages a delivery returned by the server-held source capability. This does
 * not claim transport authentication: the intake independently verifies the
 * signed envelope against the active database key before any registry write.
 */
export function buildConnectionEnrollmentProtectedDeliveryV1(inputValue: unknown):
ConnectionEnrollmentProtectedDeliveryV1 {
  const input = exactHostDataSnapshotV1(inputValue, ["deliveryId", "authenticatedAt", "envelope"]);
  if (!input || !isConnectionEnrollmentDeliveryIdV1(input.deliveryId)
    || !exactInstant(input.authenticatedAt)) throw new ConnectionEnrollmentIntakeErrorV1("invalid_input");
  let envelope: IdeaLabHermes021ConnectionEnrollmentEnvelopeV1;
  try { envelope = parseIdeaLabHermes021ConnectionEnrollmentEnvelopeV1(input.envelope); }
  catch { throw new ConnectionEnrollmentIntakeErrorV1("invalid_input"); }
  const material: Omit<CapturedDeliveryV1, "envelope" | "deliveryEvidenceDigest"> = {
    contractVersion: CONNECTION_ENROLLMENT_PROTECTED_DELIVERY_V1,
    deliveryId: input.deliveryId,
    deliveryBasis: "protected_server_source",
    tenantId: envelope.body.tenantId,
    nodeId: envelope.body.nodeId,
    connectionId: envelope.body.connectionId,
    keyId: envelope.attestation.keyId,
    authenticatedAt: input.authenticatedAt as string,
    envelopeDigest: sha256Digest(envelope),
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return Object.freeze({ ...material, envelope,
    deliveryEvidenceDigest: sha256Digest(deliveryMaterial(material)) });
}

/** Strictly validates one protected server-held delivery without trusting its source object. */
export function parseConnectionEnrollmentProtectedDeliveryV1(value: unknown, expectedDeliveryId: string,
  expectedReceivedAt: string): ConnectionEnrollmentProtectedDeliveryV1 {
  const captured = exactHostDataSnapshotV1(value, ["contractVersion", "deliveryId", "deliveryBasis", "tenantId",
    "nodeId", "connectionId", "keyId", "authenticatedAt", "envelopeDigest", "envelope", "grantsApproval",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "deliveryEvidenceDigest"]);
  if (!captured) throw new ConnectionEnrollmentIntakeErrorV1("unauthenticated_delivery");
  let envelope: IdeaLabHermes021ConnectionEnrollmentEnvelopeV1;
  try { envelope = parseIdeaLabHermes021ConnectionEnrollmentEnvelopeV1(captured.envelope); }
  catch { throw new ConnectionEnrollmentIntakeErrorV1("unauthenticated_delivery"); }
  const delivery = { ...captured, envelope } as unknown as CapturedDeliveryV1;
  const fields = [delivery.tenantId, delivery.nodeId, delivery.connectionId, delivery.keyId];
  if (delivery.contractVersion !== CONNECTION_ENROLLMENT_PROTECTED_DELIVERY_V1
    || delivery.deliveryBasis !== "protected_server_source"
    || !isConnectionEnrollmentDeliveryIdV1(delivery.deliveryId)
    || fields.some((field) => typeof field !== "string" || !idPattern.test(field))
    || delivery.deliveryId !== expectedDeliveryId || delivery.authenticatedAt !== expectedReceivedAt
    || !exactInstant(delivery.authenticatedAt) || !digestPattern.test(delivery.envelopeDigest)
    || !digestPattern.test(delivery.deliveryEvidenceDigest)
    || delivery.grantsApproval !== false || delivery.grantsNetworkAuthority !== false
    || delivery.grantsCommandAuthority !== false || delivery.grantsLeaseAuthority !== false
    || delivery.grantsExecutionAuthority !== false || delivery.envelopeDigest !== sha256Digest(envelope)) {
    throw new ConnectionEnrollmentIntakeErrorV1("unauthenticated_delivery");
  }
  const { envelope: _envelope, deliveryEvidenceDigest: _deliveryEvidenceDigest, ...material } = delivery;
  void _envelope; void _deliveryEvidenceDigest;
  if (sha256Digest(deliveryMaterial(material)) !== delivery.deliveryEvidenceDigest) {
    throw new ConnectionEnrollmentIntakeErrorV1("unauthenticated_delivery");
  }
  return Object.freeze(delivery);
}

function captureTrustedKey(value: unknown, delivery: CapturedDeliveryV1, receivedAt: string): TrustedNodeKeyRowV1 {
  const captured = exactHostDataSnapshotV1(value, ["tenant_id", "node_id", "key_id", "algorithm", "public_key_spki",
    "key_state", "node_state", "valid_from", "valid_until"]);
  if (!captured) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
  const row = captured as unknown as TrustedNodeKeyRowV1;
  if (row.tenant_id !== delivery.tenantId || row.node_id !== delivery.nodeId || row.key_id !== delivery.keyId
    || row.algorithm !== "ed25519" || row.key_state !== "active"
    || !["active", "draining", "offline"].includes(row.node_state)
    || typeof row.public_key_spki !== "string" || !base64urlPattern.test(row.public_key_spki)
    || !exactInstant(row.valid_from) || (row.valid_until !== null && !exactInstant(row.valid_until))
    || Date.parse(row.valid_from) > Date.parse(receivedAt)
    || (row.valid_until !== null && Date.parse(row.valid_until) <= Date.parse(receivedAt))) {
    throw new ConnectionEnrollmentIntakeErrorV1("unauthenticated_delivery");
  }
  return row;
}

function headMaterial(row: Omit<IntakeHeadRowV1, "head_auth_tag">) {
  return { tenantId: row.tenant_id, lastSequence: Number(row.last_sequence),
    lastAuditRecordDigest: row.last_audit_record_digest, updatedAt: row.updated_at };
}

function auditMaterial(row: Omit<IntakeRowV1, "receipt_auth_tag" | "payload" | "audit_record_digest">) {
  return {
    tenantId: row.tenant_id, deliveryId: row.delivery_id, enrollmentId: row.enrollment_id,
    connectionId: row.connection_id, nodeId: row.node_id, keyIdDigest: row.key_id_digest,
    sequence: Number(row.sequence), deliveryEvidenceDigest: row.delivery_evidence_digest,
    envelopeDigest: row.envelope_digest, enrollmentResultDigest: row.enrollment_result_digest,
    registryRevision: Number(row.registry_revision), payloadDigest: row.payload_digest,
    previousAuditRecordDigest: row.previous_audit_record_digest, receivedAt: row.received_at,
  };
}

export class ConnectionEnrollmentIntakeErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_input" | "source_unavailable" | "unauthenticated_delivery" |
    "replay_conflict" | "integrity_failed") {
    super(safeCode); this.name = "ConnectionEnrollmentIntakeErrorV1";
  }
}
const connectionEnrollmentIntakeErrorPrototypeV1 = ConnectionEnrollmentIntakeErrorV1.prototype;

function capturedIntakeErrorCodeV1(value: unknown): ConnectionEnrollmentIntakeErrorV1["safeCode"] | undefined {
  const code = exactHostErrorCodeV1(value, connectionEnrollmentIntakeErrorPrototypeV1, "safeCode");
  return code === "invalid_input" || code === "source_unavailable" || code === "unauthenticated_delivery"
    || code === "replay_conflict" || code === "integrity_failed" ? code : undefined;
}

export class DisabledConnectionEnrollmentDeliverySourceV1
implements ConnectionEnrollmentProtectedDeliverySourceV1 {
  async read(): Promise<never> { throw new ConnectionEnrollmentIntakeErrorV1("source_unavailable"); }
}

/**
 * Server-only composition. The delivery source is a server-held capability;
 * no HTTP or browser caller supplies it. Trust comes from verifying the signed
 * enrollment against the current active database key inside this transaction.
 */
export class ConnectionEnrollmentIntakeServiceV1 {
  readonly #transaction: DatabaseClient["transaction"];
  readonly #readDelivery: ConnectionEnrollmentProtectedDeliverySourceV1["read"];
  readonly #registryKey: Uint8Array;
  readonly #auditKey: Uint8Array;

  constructor(db: DatabaseClient, registryIntegrityKey: unknown, auditIntegrityKey: unknown,
    source: ConnectionEnrollmentProtectedDeliverySourceV1) {
    const transaction = dataMethodV1(db, "transaction") as DatabaseClient["transaction"] | undefined;
    const read = dataMethodV1(source, "read") as ConnectionEnrollmentProtectedDeliverySourceV1["read"] | undefined;
    const registryKey = exactHostUint8ArrayV1(registryIntegrityKey, 128);
    const auditKey = exactHostUint8ArrayV1(auditIntegrityKey, 128);
    let keysMatch = !!registryKey && !!auditKey && registryKey.byteLength === auditKey.byteLength;
    if (keysMatch) for (let index = 0; index < registryKey!.byteLength; index += 1) {
      if (registryKey!.byteAt(index) !== auditKey!.byteAt(index)) { keysMatch = false; break; }
    }
    if (!db || typeof db !== "object" || isHostProxyV1(db) || !transaction
      || !source || typeof source !== "object" || isHostProxyV1(source) || !read
      || !registryKey || registryKey.byteLength !== 32 || !auditKey || auditKey.byteLength !== 32
      || keysMatch) {
      throw new ConnectionEnrollmentIntakeErrorV1("invalid_input");
    }
    this.#transaction = ((callback) => transaction.call(db, callback)) as DatabaseClient["transaction"];
    this.#readDelivery = ((input: { deliveryId: string; receivedAt: string }) =>
      read.call(source, input)) as ConnectionEnrollmentProtectedDeliverySourceV1["read"];
    this.#registryKey = registryKey.copy();
    this.#auditKey = auditKey.copy();
  }

  #headTag(row: Omit<IntakeHeadRowV1, "head_auth_tag">): string {
    return hmacSha256Tag(this.#auditKey, { kind: "connection_enrollment_intake_head", ...headMaterial(row) });
  }

  #auditDigest(row: Omit<IntakeRowV1, "receipt_auth_tag" | "payload" | "audit_record_digest">): string {
    return sha256Digest({ kind: "connection_enrollment_intake_record", ...auditMaterial(row) });
  }

  #auditTag(row: Omit<IntakeRowV1, "receipt_auth_tag" | "payload">): string {
    const { audit_record_digest: auditRecordDigest, ...withoutDigest } = row;
    return hmacSha256Tag(this.#auditKey, { kind: "connection_enrollment_intake_record",
      ...auditMaterial(withoutDigest), auditRecordDigest });
  }

  #verifyHead(value: unknown, tenantId: string): IntakeHeadRowV1 {
    const captured = exactHostDataSnapshotV1(value, ["tenant_id", "last_sequence", "last_audit_record_digest",
      "head_auth_tag", "updated_at"]);
    if (!captured) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
    const row = captured as unknown as IntakeHeadRowV1;
    let valid = false;
    try {
      valid = row.tenant_id === tenantId && capturedNumberIsSafeInteger(Number(row.last_sequence))
        && Number(row.last_sequence) >= 0 && exactInstant(row.updated_at)
        && same(row.head_auth_tag, this.#headTag(row));
    } catch { valid = false; }
    if (!valid) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
    return row;
  }

  #verifyRow(value: unknown, tenantId: string, expectedSequence: number,
    expectedPreviousDigest: string | null): { row: IntakeRowV1; receipt: ConnectionEnrollmentIntakeReceiptV1 } {
    const captured = exactHostDataSnapshotV1(value, ["tenant_id", "delivery_id", "enrollment_id", "connection_id",
      "node_id", "key_id_digest", "sequence", "delivery_evidence_digest", "envelope_digest",
      "enrollment_result_digest", "registry_revision", "payload_digest", "previous_audit_record_digest",
      "audit_record_digest", "receipt_auth_tag", "received_at", "payload"]);
    if (!captured) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
    const row = captured as unknown as IntakeRowV1;
    const receipt = parseConnectionEnrollmentIntakeReceiptV1(row.payload);
    let valid = false;
    try {
      const { audit_record_digest: _auditRecordDigest, receipt_auth_tag: _receiptAuthTag,
        payload: _payload, ...digestInput } = row;
      void _auditRecordDigest; void _receiptAuthTag; void _payload;
      valid = row.tenant_id === tenantId && isConnectionEnrollmentDeliveryIdV1(row.delivery_id)
        && idPattern.test(row.enrollment_id)
        && idPattern.test(row.connection_id) && idPattern.test(row.node_id)
        && digestPattern.test(row.key_id_digest) && Number(row.sequence) === expectedSequence
        && row.previous_audit_record_digest === expectedPreviousDigest
        && receipt.deliveryEvidenceDigest === row.delivery_evidence_digest
        && receipt.enrollmentResultDigest === row.enrollment_result_digest
        && receipt.registryRevision === Number(row.registry_revision) && receipt.recordedAt === row.received_at
        && row.payload_digest === sha256Digest(receipt) && row.audit_record_digest === this.#auditDigest(digestInput)
        && same(row.receipt_auth_tag, this.#auditTag(row));
    } catch { valid = false; }
    if (!valid) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
    return { row, receipt };
  }

  async #verifiedStream(tx: DatabaseSession, tenantId: string): Promise<{
    head?: IntakeHeadRowV1;
    rows: IntakeRowV1[];
    receipts: ConnectionEnrollmentIntakeReceiptV1[];
  }> {
    const headRows = await safeQuery(tx, `SELECT tenant_id,last_sequence,last_audit_record_digest,head_auth_tag,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      FROM control_connection_enrollment_intake_heads WHERE tenant_id=$1 FOR UPDATE`, [tenantId], 1);
    const rawRows = await safeQuery(tx, `SELECT ${selectedIntakeColumns}
      FROM control_connection_enrollment_intake_receipts WHERE tenant_id=$1 ORDER BY sequence FOR UPDATE`, [tenantId]);
    if (!headRows[0]) {
      if (rawRows.length) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
      return { rows: [], receipts: [] };
    }
    const head = this.#verifyHead(headRows[0], tenantId), rows: IntakeRowV1[] = [],
      receipts: ConnectionEnrollmentIntakeReceiptV1[] = [];
    let previous: string | null = null;
    for (let index = 0; index < rawRows.length; index += 1) {
      const verified = this.#verifyRow(rawRows[index], tenantId, index + 1, previous);
      rows[index] = verified.row; receipts[index] = verified.receipt;
      previous = verified.row.audit_record_digest;
    }
    if (Number(head.last_sequence) !== rows.length || head.last_audit_record_digest !== previous) {
      throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
    }
    return { head, rows, receipts };
  }

  async #trustedKey(tx: DatabaseSession, delivery: CapturedDeliveryV1,
    receivedAt: string): Promise<TrustedNodeKeyRowV1> {
    const rows = await safeQuery(tx, `SELECT k.tenant_id,k.node_id,k.id AS key_id,k.algorithm,k.public_key_spki,
      k.state AS key_state,n.state AS node_state,
      to_char(k.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_from,
      CASE WHEN k.valid_until IS NULL THEN NULL ELSE
        to_char(k.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS valid_until
      FROM control_node_keys k JOIN control_nodes n ON n.tenant_id=k.tenant_id AND n.id=k.node_id
      WHERE k.tenant_id=$1 AND k.node_id=$2 AND k.id=$3 FOR UPDATE`,
    [delivery.tenantId, delivery.nodeId, delivery.keyId], 1);
    if (rows.length !== 1) throw new ConnectionEnrollmentIntakeErrorV1("unauthenticated_delivery");
    return captureTrustedKey(rows[0], delivery, receivedAt);
  }

  #scopedDatabase(tx: DatabaseSession): DatabaseClient {
    const query = dataMethodV1(tx, "query");
    if (!query) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
    const session = Object.freeze({
      query: <T = Record<string, unknown>>(statement: string, params: unknown[] = []) =>
        query.call(tx, statement, params) as Promise<{ rows: T[] }>,
    });
    return Object.freeze({
      query: session.query,
      transaction: <T>(callback: (databaseSession: DatabaseSession) => Promise<T>) => callback(session),
      transactionWithPreCommitCheck: async <T>(callback: (databaseSession: DatabaseSession) => Promise<T>,
        preCommitCheck: () => void | Promise<void>) => { const result = await callback(session); await preCommitCheck(); return result; },
    });
  }

  async ingest(inputValue: unknown): Promise<{ replayed: boolean; receipt: ConnectionEnrollmentIntakeReceiptV1 }> {
    const input = exactHostDataSnapshotV1(inputValue, ["deliveryId", "receivedAt"]);
    if (!input || !isConnectionEnrollmentDeliveryIdV1(input.deliveryId)
      || !exactInstant(input.receivedAt)) throw new ConnectionEnrollmentIntakeErrorV1("invalid_input");
    let deliveryValue: unknown;
    try { deliveryValue = await this.#readDelivery({ deliveryId: input.deliveryId, receivedAt: input.receivedAt }); }
    catch { throw new ConnectionEnrollmentIntakeErrorV1("source_unavailable"); }
    const delivery = parseConnectionEnrollmentProtectedDeliveryV1(deliveryValue, input.deliveryId, input.receivedAt);
    try {
      return await this.#transaction(async (tx) => {
        const tenantRows = await safeQuery(tx, `SELECT id AS tenant_id FROM tenants WHERE id=$1 FOR UPDATE`,
          [delivery.tenantId], 1);
        requireReturnedTenant(tenantRows, delivery.tenantId);
        const stream = await this.#verifiedStream(tx, delivery.tenantId);

        let existingIndex = -1;
        for (let index = 0; index < stream.rows.length; index += 1) {
          const row = stream.rows[index]!;
          if (row.delivery_id === delivery.deliveryId
            || row.enrollment_id === delivery.envelope.body.enrollmentId) {
            if (existingIndex >= 0) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
            existingIndex = index;
          }
        }
        if (existingIndex >= 0) {
          const row = stream.rows[existingIndex]!, receipt = stream.receipts[existingIndex]!;
          if (row.delivery_id !== delivery.deliveryId
            || row.enrollment_id !== delivery.envelope.body.enrollmentId
            || row.connection_id !== delivery.connectionId || row.node_id !== delivery.nodeId
            || row.key_id_digest !== sha256Digest({ keyId: delivery.keyId })
            || row.delivery_evidence_digest !== delivery.deliveryEvidenceDigest
            || row.envelope_digest !== delivery.envelopeDigest || row.received_at !== input.receivedAt) {
            throw new ConnectionEnrollmentIntakeErrorV1("replay_conflict");
          }
          return Object.freeze({ replayed: true, receipt });
        }

        const key = await this.#trustedKey(tx, delivery, input.receivedAt as string);
        if (!same(key.public_key_spki, delivery.envelope.attestation.publicKeySpki)
          || !same(key.key_id, delivery.envelope.attestation.keyId)) {
          throw new ConnectionEnrollmentIntakeErrorV1("unauthenticated_delivery");
        }
        let enrollment: IdeaLabHermes021ConnectionSafeResultV1;
        try {
          enrollment = sanitizeIdeaLabHermes021ConnectionEnrollmentV1(delivery.envelope, {
            evaluatedAt: input.receivedAt,
            expectedTenantId: delivery.tenantId,
            expectedNodeId: delivery.nodeId,
            expectedConnectionId: delivery.connectionId,
            expectedConnectorRouteDigest: delivery.envelope.body.connectorRouteDigest,
            expectedProfileIdentityDigest: delivery.envelope.body.profileIdentityDigest,
            expectedSshHostKeyFingerprintDigest: delivery.envelope.body.route.sshHostKeyFingerprintDigest,
            trustedNodeKeyId: key.key_id,
            trustedNodePublicKeySpki: key.public_key_spki,
            inputMode: "injected_signed_node_enrollment_only",
          });
        } catch { throw new ConnectionEnrollmentIntakeErrorV1("unauthenticated_delivery"); }

        const registry = new ConnectionRegistryStoreV1(this.#scopedDatabase(tx), this.#registryKey);
        let registryResult: { replayed: boolean; revision: number };
        try {
          registryResult = await registry.enrollAuthenticated(enrollment, input.receivedAt as string,
            { tenantId: delivery.tenantId, nodeId: delivery.nodeId, connectionId: delivery.connectionId });
        } catch (error) {
          const code = exactHostErrorCodeV1(error, connectionRegistryErrorPrototypeV1, "safeCode");
          if (code === "replay_conflict") {
            throw new ConnectionEnrollmentIntakeErrorV1("replay_conflict");
          }
          if (code === "invalid_input" || code === "scope_mismatch") {
            throw new ConnectionEnrollmentIntakeErrorV1("unauthenticated_delivery");
          }
          throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
        }
        if (registryResult.replayed) throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");

        const receiptMaterial: Omit<ConnectionEnrollmentIntakeReceiptV1, "receiptDigest"> = {
          contractVersion: CONNECTION_ENROLLMENT_INTAKE_RECEIPT_V1,
          intakeReference: `intake:${delivery.deliveryEvidenceDigest.slice(7, 31)}`,
          deliveryEvidenceDigest: delivery.deliveryEvidenceDigest,
          enrollmentResultDigest: enrollment.resultDigest,
          registryRevision: registryResult.revision,
          recordedAt: input.receivedAt as string,
          disposition: "accepted",
          grantsApproval: false,
          grantsNetworkAuthority: false,
          grantsCommandAuthority: false,
          grantsLeaseAuthority: false,
          grantsExecutionAuthority: false,
        };
        const receipt = parseConnectionEnrollmentIntakeReceiptV1({ ...receiptMaterial,
          receiptDigest: sha256Digest(receiptMaterial) });
        const sequence = stream.rows.length + 1;
        const rowBase: Omit<IntakeRowV1, "receipt_auth_tag" | "payload" | "audit_record_digest"> = {
          tenant_id: delivery.tenantId, delivery_id: delivery.deliveryId,
          enrollment_id: enrollment.enrollmentId, connection_id: enrollment.connectionId, node_id: enrollment.nodeId,
          key_id_digest: sha256Digest({ keyId: delivery.keyId }), sequence,
          delivery_evidence_digest: delivery.deliveryEvidenceDigest, envelope_digest: delivery.envelopeDigest,
          enrollment_result_digest: enrollment.resultDigest, registry_revision: registryResult.revision,
          payload_digest: sha256Digest(receipt), previous_audit_record_digest: stream.head?.last_audit_record_digest ?? null,
          received_at: input.receivedAt as string,
        };
        const auditRecordDigest = this.#auditDigest(rowBase);
        const row = { ...rowBase, audit_record_digest: auditRecordDigest };
        const insertedReceipt = await safeQuery(tx, `INSERT INTO control_connection_enrollment_intake_receipts(${intakeColumns})
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb) RETURNING tenant_id`,
        [row.tenant_id,row.delivery_id,row.enrollment_id,row.connection_id,row.node_id,row.key_id_digest,row.sequence,
          row.delivery_evidence_digest,row.envelope_digest,row.enrollment_result_digest,row.registry_revision,
          row.payload_digest,row.previous_audit_record_digest,row.audit_record_digest,this.#auditTag(row),row.received_at,
          JSON.stringify(receipt)], 1);
        requireReturnedTenant(insertedReceipt, delivery.tenantId);
        const nextHead: Omit<IntakeHeadRowV1, "head_auth_tag"> = { tenant_id: delivery.tenantId,
          last_sequence: sequence, last_audit_record_digest: auditRecordDigest, updated_at: input.receivedAt as string };
        if (!stream.head) {
          const insertedHead = await safeQuery(tx, `INSERT INTO control_connection_enrollment_intake_heads
            (tenant_id,last_sequence,last_audit_record_digest,head_auth_tag,updated_at)
            VALUES($1,$2,$3,$4,$5) RETURNING tenant_id`, [nextHead.tenant_id,nextHead.last_sequence,
            nextHead.last_audit_record_digest,this.#headTag(nextHead),nextHead.updated_at], 1);
          requireReturnedTenant(insertedHead, delivery.tenantId);
        } else {
          const updatedHead = await safeQuery(tx, `UPDATE control_connection_enrollment_intake_heads SET last_sequence=$1,
            last_audit_record_digest=$2,head_auth_tag=$3,updated_at=$4 WHERE tenant_id=$5 RETURNING tenant_id`,
          [nextHead.last_sequence,nextHead.last_audit_record_digest,this.#headTag(nextHead),nextHead.updated_at,
            nextHead.tenant_id], 1);
          requireReturnedTenant(updatedHead, delivery.tenantId);
        }
        return Object.freeze({ replayed: false, receipt });
      });
    } catch (error) {
      const code = capturedIntakeErrorCodeV1(error);
      if (code) throw new ConnectionEnrollmentIntakeErrorV1(code);
      throw new ConnectionEnrollmentIntakeErrorV1("integrity_failed");
    }
  }
}
