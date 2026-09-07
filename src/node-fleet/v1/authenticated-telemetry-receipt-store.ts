import { timingSafeEqual } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import {
  dataMethodV1,
  exactHostDataArrayV1,
  exactHostDataSnapshotV1,
  exactHostUint8ArrayV1,
  isHostProxyV1,
  ownDataPropertyValueV1,
} from "../../security/host-value";

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

interface ReceiptRowV1 {
  tenant_id: string;
  node_id: string;
  signal_sequence: number | string;
  signal_digest: string;
  message_id_digest: string;
  key_id_digest: string;
  connection_id_digest: string;
  observed_at: string;
  expires_at: string;
  authenticated_at: string;
  receipt_auth_tag: string;
}

export interface AuthenticatedTelemetryReceiptInputV1 {
  tenantId: string;
  nodeId: string;
  signalSequence: number;
  signalDigest: string;
  messageId: string;
  keyId: string;
  connectionId: string;
  observedAt: string;
  expiresAt: string;
  authenticatedAt: string;
}

export interface AuthenticatedTelemetryReceiptV1 {
  tenantId: string;
  nodeId: string;
  signalSequence: number;
  signalDigest: string;
  observedAt: string;
  expiresAt: string;
  authenticatedAt: string;
}

export class AuthenticatedTelemetryReceiptErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_input" | "identity_mismatch" | "sequence_conflict" |
    "integrity_failed" | "source_unavailable") {
    super(safeCode); this.name = "AuthenticatedTelemetryReceiptErrorV1";
  }
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function exactInstant(value: unknown): value is string {
  return typeof value === "string" && instantPattern.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function rowMaterial(row: Omit<ReceiptRowV1, "receipt_auth_tag">) {
  return {
    kind: "authenticated_telemetry_receipt",
    tenantId: row.tenant_id,
    nodeId: row.node_id,
    signalSequence: Number(row.signal_sequence),
    signalDigest: row.signal_digest,
    messageIdDigest: row.message_id_digest,
    keyIdDigest: row.key_id_digest,
    connectionIdDigest: row.connection_id_digest,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    authenticatedAt: row.authenticated_at,
  };
}

function capturedRows(value: unknown, maximum: number): unknown[] {
  const rows = exactHostDataArrayV1(ownDataPropertyValueV1(value, "rows"), maximum);
  if (!rows) throw new AuthenticatedTelemetryReceiptErrorV1("integrity_failed");
  return rows;
}

async function safeQuery(session: DatabaseSession, statement: string, params: unknown[], maximum: number): Promise<unknown[]> {
  const query = dataMethodV1(session, "query");
  if (!query) throw new AuthenticatedTelemetryReceiptErrorV1("integrity_failed");
  return capturedRows(await query.call(session, statement, params), maximum);
}

/**
 * Server-only keyed receipt store. Its write port is called by
 * NodeFleetSignalIngress only after node-protocol signature, key, scope,
 * lifetime, replay, and rate-limit checks have succeeded.
 */
export class AuthenticatedTelemetryReceiptStoreV1 {
  readonly #query: DatabaseClient["query"];
  readonly #transaction: DatabaseClient["transaction"];
  readonly #key: Uint8Array;

  constructor(db: DatabaseClient, integrityKeyValue: unknown) {
    const key = exactHostUint8ArrayV1(integrityKeyValue, 128);
    const query = dataMethodV1(db, "query") as DatabaseClient["query"] | undefined;
    const transaction = dataMethodV1(db, "transaction") as DatabaseClient["transaction"] | undefined;
    if (!db || typeof db !== "object" || isHostProxyV1(db) || !query || !transaction || !key || key.byteLength !== 32) {
      throw new AuthenticatedTelemetryReceiptErrorV1("invalid_input");
    }
    this.#query = ((statement, params) => query.call(db, statement, params)) as DatabaseClient["query"];
    this.#transaction = ((callback) => transaction.call(db, callback)) as DatabaseClient["transaction"];
    this.#key = key.copy();
  }

  #tag(row: Omit<ReceiptRowV1, "receipt_auth_tag">): string {
    return hmacSha256Tag(this.#key, rowMaterial(row));
  }

  #verifiedRow(value: unknown, tenantId: string, nodeId: string): ReceiptRowV1 {
    const row = exactHostDataSnapshotV1(value, ["tenant_id", "node_id", "signal_sequence", "signal_digest",
      "message_id_digest", "key_id_digest", "connection_id_digest", "observed_at", "expires_at",
      "authenticated_at", "receipt_auth_tag"]);
    if (!row) throw new AuthenticatedTelemetryReceiptErrorV1("integrity_failed");
    const typed = row as unknown as ReceiptRowV1;
    const sequence = Number(typed.signal_sequence);
    let valid = false;
    try {
      valid = typed.tenant_id === tenantId && typed.node_id === nodeId
        && Number.isSafeInteger(sequence) && sequence > 0
        && digestPattern.test(typed.signal_digest) && digestPattern.test(typed.message_id_digest)
        && digestPattern.test(typed.key_id_digest) && digestPattern.test(typed.connection_id_digest)
        && exactInstant(typed.observed_at) && exactInstant(typed.expires_at) && exactInstant(typed.authenticated_at)
        && Date.parse(typed.expires_at) > Date.parse(typed.observed_at)
        && same(typed.receipt_auth_tag, this.#tag(typed));
    } catch { valid = false; }
    if (!valid) throw new AuthenticatedTelemetryReceiptErrorV1("integrity_failed");
    return typed;
  }

  async recordAfterAuthenticatedIngress(inputValue: unknown): Promise<{ replayed: boolean }> {
    const input = exactHostDataSnapshotV1(inputValue, ["tenantId", "nodeId", "signalSequence", "signalDigest",
      "messageId", "keyId", "connectionId", "observedAt", "expiresAt", "authenticatedAt"]);
    if (!input || typeof input.tenantId !== "string" || typeof input.nodeId !== "string"
      || typeof input.messageId !== "string" || typeof input.keyId !== "string" || typeof input.connectionId !== "string"
      || !idPattern.test(input.tenantId) || !idPattern.test(input.nodeId) || !idPattern.test(input.messageId)
      || !idPattern.test(input.keyId) || !idPattern.test(input.connectionId)
      || !Number.isSafeInteger(input.signalSequence) || Number(input.signalSequence) < 1
      || typeof input.signalDigest !== "string" || !digestPattern.test(input.signalDigest)
      || !exactInstant(input.observedAt) || !exactInstant(input.expiresAt) || !exactInstant(input.authenticatedAt)
      || Date.parse(input.expiresAt) <= Date.parse(input.observedAt)
      || Date.parse(input.authenticatedAt) < Date.parse(input.observedAt) - 5 * 60_000) {
      throw new AuthenticatedTelemetryReceiptErrorV1("invalid_input");
    }
    const row: Omit<ReceiptRowV1, "receipt_auth_tag"> = {
      tenant_id: input.tenantId, node_id: input.nodeId, signal_sequence: Number(input.signalSequence),
      signal_digest: input.signalDigest, message_id_digest: sha256Digest({ messageId: input.messageId }),
      key_id_digest: sha256Digest({ keyId: input.keyId }),
      connection_id_digest: sha256Digest({ connectionId: input.connectionId }),
      observed_at: input.observedAt, expires_at: input.expiresAt, authenticated_at: input.authenticatedAt,
    };
    try {
      return await this.#transaction(async (tx) => {
        const nodes = await safeQuery(tx, `SELECT id FROM control_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [row.tenant_id, row.node_id], 1);
        const node = exactHostDataSnapshotV1(nodes[0], ["id"]);
        if (!node || node.id !== row.node_id) throw new AuthenticatedTelemetryReceiptErrorV1("identity_mismatch");
        const priorRows = await safeQuery(tx, `SELECT tenant_id,node_id,signal_sequence,signal_digest,message_id_digest,
          key_id_digest,connection_id_digest,
          to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
          to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
          to_char(authenticated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS authenticated_at,
          receipt_auth_tag
          FROM control_connection_authenticated_telemetry_receipts WHERE tenant_id=$1 AND node_id=$2 FOR UPDATE`,
        [row.tenant_id, row.node_id], 1);
        if (priorRows.length) {
          const prior = this.#verifiedRow(priorRows[0], row.tenant_id, row.node_id);
          if (Number(prior.signal_sequence) === Number(row.signal_sequence)) {
            if (same(prior.signal_digest, row.signal_digest)
              && same(prior.message_id_digest, row.message_id_digest)
              && same(prior.key_id_digest, row.key_id_digest)
              && same(prior.connection_id_digest, row.connection_id_digest)
              && prior.observed_at === row.observed_at && prior.expires_at === row.expires_at) return { replayed: true };
            throw new AuthenticatedTelemetryReceiptErrorV1("sequence_conflict");
          }
          if (Number(row.signal_sequence) !== Number(prior.signal_sequence) + 1
            || Date.parse(row.observed_at) < Date.parse(prior.observed_at)
            || Date.parse(row.authenticated_at) < Date.parse(prior.authenticated_at)) {
            throw new AuthenticatedTelemetryReceiptErrorV1("sequence_conflict");
          }
        } else if (Number(row.signal_sequence) !== 1) {
          throw new AuthenticatedTelemetryReceiptErrorV1("sequence_conflict");
        }
        await safeQuery(tx, `INSERT INTO control_connection_authenticated_telemetry_receipts
          (tenant_id,node_id,signal_sequence,signal_digest,message_id_digest,key_id_digest,connection_id_digest,
           observed_at,expires_at,authenticated_at,receipt_auth_tag)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT(tenant_id,node_id) DO UPDATE SET signal_sequence=EXCLUDED.signal_sequence,
          signal_digest=EXCLUDED.signal_digest,message_id_digest=EXCLUDED.message_id_digest,
          key_id_digest=EXCLUDED.key_id_digest,connection_id_digest=EXCLUDED.connection_id_digest,
          observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,
          authenticated_at=EXCLUDED.authenticated_at,receipt_auth_tag=EXCLUDED.receipt_auth_tag
          RETURNING tenant_id`, [row.tenant_id,row.node_id,row.signal_sequence,row.signal_digest,row.message_id_digest,
          row.key_id_digest,row.connection_id_digest,row.observed_at,row.expires_at,row.authenticated_at,this.#tag(row)], 1);
        return { replayed: false };
      });
    } catch (error) {
      if (error instanceof AuthenticatedTelemetryReceiptErrorV1) throw error;
      throw new AuthenticatedTelemetryReceiptErrorV1("source_unavailable");
    }
  }

  async read(inputValue: unknown): Promise<AuthenticatedTelemetryReceiptV1 | undefined> {
    return this.#readWith(inputValue, this.#query);
  }

  /** Read in an already authorized transaction without opening another pool checkout. */
  async readInSession(session: DatabaseSession, inputValue: unknown): Promise<AuthenticatedTelemetryReceiptV1 | undefined> {
    return this.#readWith(inputValue, (statement, params) => session.query(statement, params));
  }

  async #readWith(inputValue: unknown, query: DatabaseSession["query"]): Promise<AuthenticatedTelemetryReceiptV1 | undefined> {
    const input = exactHostDataSnapshotV1(inputValue, ["tenantId", "nodeId"]);
    if (!input || typeof input.tenantId !== "string" || typeof input.nodeId !== "string"
      || !idPattern.test(input.tenantId) || !idPattern.test(input.nodeId)) {
      throw new AuthenticatedTelemetryReceiptErrorV1("invalid_input");
    }
    try {
      const rows = capturedRows(await query(`SELECT tenant_id,node_id,signal_sequence,signal_digest,
        message_id_digest,key_id_digest,connection_id_digest,
        to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
        to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
        to_char(authenticated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS authenticated_at,
        receipt_auth_tag
        FROM control_connection_authenticated_telemetry_receipts WHERE tenant_id=$1 AND node_id=$2`,
      [input.tenantId, input.nodeId]), 1);
      if (!rows.length) return undefined;
      const row = this.#verifiedRow(rows[0], input.tenantId, input.nodeId);
      return Object.freeze({ tenantId: row.tenant_id, nodeId: row.node_id,
        signalSequence: Number(row.signal_sequence), signalDigest: row.signal_digest,
        observedAt: row.observed_at, expiresAt: row.expires_at, authenticatedAt: row.authenticated_at });
    } catch (error) {
      if (error instanceof AuthenticatedTelemetryReceiptErrorV1) throw error;
      throw new AuthenticatedTelemetryReceiptErrorV1("source_unavailable");
    }
  }
}
