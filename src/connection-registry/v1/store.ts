import { timingSafeEqual } from "node:crypto";
import {
  buildIdeaLabHermes021ConnectionRosterV1,
  parseIdeaLabHermes021ConnectionSafeResultV1,
  type IdeaLabHermes021ConnectionRosterV1,
  type IdeaLabHermes021ConnectionSafeResultV1,
} from "../../idea-lab/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { dataMethodV1, exactHostDataArrayV1, exactHostDataSnapshotV1, exactHostErrorCodeV1,
  exactHostUint8ArrayV1, isHostProxyV1, ownDataPropertyValueV1 } from "../../security/host-value";

interface RegistryHeadRowV1 {
  tenant_id: string;
  last_sequence: number | string;
  last_record_digest: string | null;
  head_auth_tag: string;
  updated_at: string;
}

interface EnrollmentRowV1 {
  tenant_id: string;
  connection_id: string;
  enrollment_id: string;
  node_id: string;
  revision: number | string;
  sequence: number | string;
  result_digest: string;
  payload_digest: string;
  previous_record_digest: string | null;
  record_digest: string;
  record_auth_tag: string;
  issued_at: string;
  expires_at: string;
  recorded_at: string;
  payload: unknown;
}

const columns = `tenant_id,connection_id,enrollment_id,node_id,revision,sequence,result_digest,payload_digest,
  previous_record_digest,record_digest,record_auth_tag,issued_at,expires_at,recorded_at,payload`;
const selectedColumns = `tenant_id,connection_id,enrollment_id,node_id,revision,sequence,result_digest,payload_digest,
  previous_record_digest,record_digest,record_auth_tag,
  to_char(issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,
  to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
  to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,payload`;
const capturedArraySort = Array.prototype.sort;
const capturedReflectApply = Reflect.apply;

function instant(value: string): string {
  if (typeof value !== "string") throw new ConnectionRegistryErrorV1("integrity_failed");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new ConnectionRegistryErrorV1("integrity_failed");
  return new Date(milliseconds).toISOString();
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function headMaterial(row: Omit<RegistryHeadRowV1, "head_auth_tag">) {
  return { tenantId: row.tenant_id, lastSequence: Number(row.last_sequence),
    lastRecordDigest: row.last_record_digest, updatedAt: instant(row.updated_at) };
}

function recordMaterial(row: Omit<EnrollmentRowV1, "record_auth_tag" | "payload" | "record_digest">) {
  return {
    tenantId: row.tenant_id, connectionId: row.connection_id, enrollmentId: row.enrollment_id, nodeId: row.node_id,
    revision: Number(row.revision), sequence: Number(row.sequence), resultDigest: row.result_digest,
    payloadDigest: row.payload_digest, previousRecordDigest: row.previous_record_digest,
    issuedAt: instant(row.issued_at), expiresAt: instant(row.expires_at), recordedAt: instant(row.recorded_at),
  };
}

function capturedRows(value: unknown, maximum: number): unknown[] {
  const rows = exactHostDataArrayV1(ownDataPropertyValueV1(value, "rows"), maximum);
  if (!rows) throw new ConnectionRegistryErrorV1("integrity_failed");
  return rows;
}

async function safeQuery(tx: DatabaseSession, statement: string, params: unknown[], maximum = 10_000): Promise<unknown[]> {
  const query = dataMethodV1(tx, "query");
  if (!query) throw new ConnectionRegistryErrorV1("integrity_failed");
  return capturedRows(await query.call(tx, statement, params), maximum);
}

export class ConnectionRegistryErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_input" | "scope_mismatch" | "replay_conflict" |
    "capacity_exceeded" | "integrity_failed" | "source_unavailable") {
    super(safeCode); this.name = "ConnectionRegistryErrorV1";
  }
}
const connectionRegistryErrorPrototypeV1 = ConnectionRegistryErrorV1.prototype;

function capturedRegistryErrorCodeV1(value: unknown): ConnectionRegistryErrorV1["safeCode"] | undefined {
  const code = exactHostErrorCodeV1(value, connectionRegistryErrorPrototypeV1, "safeCode");
  return code === "invalid_input" || code === "scope_mismatch" || code === "replay_conflict"
    || code === "capacity_exceeded" || code === "integrity_failed" || code === "source_unavailable"
    ? code : undefined;
}

/**
 * Durable server-only enrollment registry. Raw signed identifiers are protected
 * values and are never returned by the Connection Center projection.
 */
export class ConnectionRegistryStoreV1 {
  readonly #transaction: DatabaseClient["transaction"];
  readonly #key: Uint8Array;

  constructor(db: DatabaseClient, integrityKeyValue: unknown) {
    const key = exactHostUint8ArrayV1(integrityKeyValue, 128);
    const query = dataMethodV1(db, "query") as DatabaseClient["query"] | undefined;
    const transaction = dataMethodV1(db, "transaction") as DatabaseClient["transaction"] | undefined;
    if (!db || typeof db !== "object" || isHostProxyV1(db) || !query || !transaction || !key || key.byteLength !== 32) {
      throw new ConnectionRegistryErrorV1("invalid_input");
    }
    this.#transaction = ((callback) => transaction.call(db, callback)) as DatabaseClient["transaction"];
    this.#key = key.copy();
  }

  #headTag(row: Omit<RegistryHeadRowV1, "head_auth_tag">): string {
    return hmacSha256Tag(this.#key, { kind: "connection_registry_head", ...headMaterial(row) });
  }

  #recordDigest(row: Omit<EnrollmentRowV1, "record_auth_tag" | "payload" | "record_digest">): string {
    return sha256Digest({ kind: "connection_enrollment_record", ...recordMaterial(row) });
  }

  #recordTag(row: Omit<EnrollmentRowV1, "record_auth_tag" | "payload">): string {
    const { record_digest: recordDigest, ...withoutDigest } = row;
    return hmacSha256Tag(this.#key, { kind: "connection_enrollment_record", ...recordMaterial(withoutDigest), recordDigest });
  }

  #verifyHead(value: unknown, tenantId: string): RegistryHeadRowV1 {
    const captured = exactHostDataSnapshotV1(value,
      ["tenant_id", "last_sequence", "last_record_digest", "head_auth_tag", "updated_at"]);
    if (!captured) throw new ConnectionRegistryErrorV1("integrity_failed");
    const row = captured as unknown as RegistryHeadRowV1;
    let valid = false;
    try {
      valid = row.tenant_id === tenantId && Number.isSafeInteger(Number(row.last_sequence))
        && Number(row.last_sequence) >= 0 && same(row.head_auth_tag, this.#headTag(row));
    } catch { valid = false; }
    if (!valid) throw new ConnectionRegistryErrorV1("integrity_failed");
    return row;
  }

  #verifyRecord(rowValue: unknown, tenantId: string, expectedSequence: number,
    expectedPreviousDigest: string | null): IdeaLabHermes021ConnectionSafeResultV1 {
    const captured = exactHostDataSnapshotV1(rowValue, ["tenant_id", "connection_id", "enrollment_id", "node_id",
      "revision", "sequence", "result_digest", "payload_digest", "previous_record_digest", "record_digest",
      "record_auth_tag", "issued_at", "expires_at", "recorded_at", "payload"]);
    if (!captured) throw new ConnectionRegistryErrorV1("integrity_failed");
    const row = captured as unknown as EnrollmentRowV1;
    let value: IdeaLabHermes021ConnectionSafeResultV1;
    try { value = parseIdeaLabHermes021ConnectionSafeResultV1(row.payload); }
    catch { throw new ConnectionRegistryErrorV1("integrity_failed"); }
    let valid = false;
    try {
      const { record_digest: _recordDigest, record_auth_tag: _recordAuthTag, payload: _payload, ...digestInput } = row;
      void _recordDigest; void _recordAuthTag; void _payload;
      valid = row.tenant_id === tenantId && value.tenantId === tenantId
        && Number(row.sequence) === expectedSequence && row.previous_record_digest === expectedPreviousDigest
        && row.connection_id === value.connectionId && row.enrollment_id === value.enrollmentId
        && row.node_id === value.nodeId && row.result_digest === value.resultDigest
        && row.payload_digest === sha256Digest(value)
        && instant(row.issued_at) === value.issuedAt && instant(row.expires_at) === value.expiresAt
        && row.record_digest === this.#recordDigest(digestInput)
        && same(row.record_auth_tag, this.#recordTag(row));
    } catch { valid = false; }
    if (!valid) throw new ConnectionRegistryErrorV1("integrity_failed");
    try { assertNoSecretMaterial(value, "connection enrollment"); }
    catch { throw new ConnectionRegistryErrorV1("integrity_failed"); }
    return value;
  }

  async #verifiedStream(tx: DatabaseSession, tenantId: string): Promise<{
    head?: RegistryHeadRowV1; rows: EnrollmentRowV1[]; values: IdeaLabHermes021ConnectionSafeResultV1[];
  }> {
    const headRows = await safeQuery(tx, `SELECT tenant_id,last_sequence,last_record_digest,head_auth_tag,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      FROM control_connection_registry_heads WHERE tenant_id=$1 FOR UPDATE`, [tenantId], 1);
    const rawRows = await safeQuery(tx, `SELECT ${selectedColumns} FROM control_connection_enrollments
      WHERE tenant_id=$1 ORDER BY sequence`, [tenantId]);
    if (!headRows[0]) {
      if (rawRows.length) throw new ConnectionRegistryErrorV1("integrity_failed");
      return { rows: [], values: [] };
    }
    const head = this.#verifyHead(headRows[0], tenantId), rows: EnrollmentRowV1[] = [];
    const values: IdeaLabHermes021ConnectionSafeResultV1[] = [];
    let previous: string | null = null;
    for (let index = 0; index < rawRows.length; index += 1) {
      values.push(this.#verifyRecord(rawRows[index], tenantId, index + 1, previous));
      const captured = exactHostDataSnapshotV1(rawRows[index], ["tenant_id", "connection_id", "enrollment_id", "node_id",
        "revision", "sequence", "result_digest", "payload_digest", "previous_record_digest", "record_digest",
        "record_auth_tag", "issued_at", "expires_at", "recorded_at", "payload"]);
      if (!captured) throw new ConnectionRegistryErrorV1("integrity_failed");
      rows[index] = captured as unknown as EnrollmentRowV1;
      previous = rows[index]!.record_digest;
    }
    if (Number(head.last_sequence) !== rows.length || head.last_record_digest !== previous) {
      throw new ConnectionRegistryErrorV1("integrity_failed");
    }
    return { head, rows, values };
  }

  async enrollAuthenticated(value: unknown, recordedAtValue: string,
    binding: { tenantId: string; nodeId: string; connectionId: string }): Promise<{ replayed: boolean; revision: number }> {
    let enrollment: IdeaLabHermes021ConnectionSafeResultV1;
    try { enrollment = parseIdeaLabHermes021ConnectionSafeResultV1(value); }
    catch { throw new ConnectionRegistryErrorV1("invalid_input"); }
    const capturedBinding = exactHostDataSnapshotV1(binding, ["tenantId", "nodeId", "connectionId"]);
    const recorded = typeof recordedAtValue === "string" ? Date.parse(recordedAtValue) : Number.NaN;
    if (!capturedBinding || !Number.isFinite(recorded) || new Date(recorded).toISOString() !== recordedAtValue
      || enrollment.tenantId !== capturedBinding.tenantId || enrollment.nodeId !== capturedBinding.nodeId
      || enrollment.connectionId !== capturedBinding.connectionId) throw new ConnectionRegistryErrorV1("scope_mismatch");
    if (enrollment.evaluatedAt !== recordedAtValue || Date.parse(enrollment.issuedAt) > recorded + 5 * 60_000
      || Date.parse(enrollment.expiresAt) <= recorded) throw new ConnectionRegistryErrorV1("invalid_input");
    try { assertNoSecretMaterial(enrollment, "connection enrollment"); }
    catch { throw new ConnectionRegistryErrorV1("invalid_input"); }
    try { return await this.#transaction((tx) => this.#persist(tx, enrollment, recordedAtValue)); }
    catch (error) {
      const code = capturedRegistryErrorCodeV1(error);
      if (code) throw new ConnectionRegistryErrorV1(code);
      throw new ConnectionRegistryErrorV1("source_unavailable");
    }
  }

  async #persist(tx: DatabaseSession, value: IdeaLabHermes021ConnectionSafeResultV1,
    recordedAt: string): Promise<{ replayed: boolean; revision: number }> {
    const tenants = await safeQuery(tx, `SELECT id FROM tenants WHERE id=$1 FOR UPDATE`, [value.tenantId], 1);
    const tenant = exactHostDataSnapshotV1(tenants[0], ["id"]);
    if (!tenant || tenant.id !== value.tenantId) throw new ConnectionRegistryErrorV1("scope_mismatch");
    const origin: Omit<RegistryHeadRowV1, "head_auth_tag"> = { tenant_id: value.tenantId, last_sequence: 0,
      last_record_digest: null, updated_at: recordedAt };
    await safeQuery(tx, `INSERT INTO control_connection_registry_heads(tenant_id,last_sequence,last_record_digest,head_auth_tag,updated_at)
      VALUES($1,0,NULL,$2,$3) ON CONFLICT(tenant_id) DO NOTHING RETURNING tenant_id`,
    [value.tenantId, this.#headTag(origin), recordedAt], 1);
    const stream = await this.#verifiedStream(tx, value.tenantId);
    let priorIndex = -1;
    for (let index = 0; index < stream.values.length; index += 1) {
      if (stream.values[index]!.enrollmentId === value.enrollmentId) { priorIndex = index; break; }
    }
    if (priorIndex >= 0) {
      const prior = stream.values[priorIndex]!;
      if (prior.resultDigest !== value.resultDigest) throw new ConnectionRegistryErrorV1("replay_conflict");
      return { replayed: true, revision: Number(stream.rows[priorIndex]!.revision) };
    }
    if (stream.head && Date.parse(recordedAt) < Date.parse(stream.head.updated_at)) {
      throw new ConnectionRegistryErrorV1("replay_conflict");
    }
    const latestByConnection: Array<{ row: EnrollmentRowV1; value: IdeaLabHermes021ConnectionSafeResultV1 }> = [];
    for (let index = 0; index < stream.rows.length; index += 1) {
      const candidate = { row: stream.rows[index]!, value: stream.values[index]! };
      let replaced = false;
      for (let current = 0; current < latestByConnection.length; current += 1) {
        if (latestByConnection[current]!.value.connectionId === candidate.value.connectionId) {
          latestByConnection[current] = candidate; replaced = true; break;
        }
      }
      if (!replaced) latestByConnection[latestByConnection.length] = candidate;
    }
    let latest: { row: EnrollmentRowV1; value: IdeaLabHermes021ConnectionSafeResultV1 } | undefined;
    const activeOtherConnections: IdeaLabHermes021ConnectionSafeResultV1[] = [];
    for (const candidate of latestByConnection) {
      if (candidate.value.connectionId === value.connectionId) latest = candidate;
      else if (Date.parse(candidate.value.expiresAt) > Date.parse(recordedAt)) {
        activeOtherConnections[activeOtherConnections.length] = candidate.value;
      }
    }
    for (const candidate of activeOtherConnections) if (candidate.connectorRouteDigest === value.connectorRouteDigest
      || candidate.profileIdentityDigest === value.profileIdentityDigest) throw new ConnectionRegistryErrorV1("replay_conflict");
    let revision = 1;
    if (latest) {
      if (Date.parse(value.issuedAt) <= Date.parse(latest.value.issuedAt)
        || Date.parse(value.expiresAt) <= Date.parse(latest.value.expiresAt)) {
        throw new ConnectionRegistryErrorV1("replay_conflict");
      }
      revision = Number(latest.row.revision) + 1;
    } else if (activeOtherConnections.length >= 32) throw new ConnectionRegistryErrorV1("capacity_exceeded");

    const sequence = stream.rows.length + 1;
    const rowBase: Omit<EnrollmentRowV1, "record_auth_tag" | "payload" | "record_digest"> = {
      tenant_id: value.tenantId, connection_id: value.connectionId, enrollment_id: value.enrollmentId,
      node_id: value.nodeId, revision, sequence, result_digest: value.resultDigest, payload_digest: sha256Digest(value),
      previous_record_digest: stream.head?.last_record_digest ?? null,
      issued_at: value.issuedAt, expires_at: value.expiresAt, recorded_at: recordedAt,
    };
    const recordDigest = this.#recordDigest(rowBase);
    const row = { ...rowBase, record_digest: recordDigest };
    await safeQuery(tx, `INSERT INTO control_connection_enrollments(${columns})
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) RETURNING tenant_id`,
    [row.tenant_id,row.connection_id,row.enrollment_id,row.node_id,row.revision,row.sequence,row.result_digest,
      row.payload_digest,row.previous_record_digest,row.record_digest,this.#recordTag(row),row.issued_at,row.expires_at,
      row.recorded_at,JSON.stringify(value)], 1);
    const nextHead: Omit<RegistryHeadRowV1, "head_auth_tag"> = { tenant_id: value.tenantId, last_sequence: sequence,
      last_record_digest: recordDigest, updated_at: recordedAt };
    const updated = await safeQuery(tx, `UPDATE control_connection_registry_heads SET last_sequence=$1,last_record_digest=$2,
      head_auth_tag=$3,updated_at=$4 WHERE tenant_id=$5 RETURNING tenant_id`,
    [sequence,recordDigest,this.#headTag(nextHead),recordedAt,value.tenantId], 1);
    const updatedHead = exactHostDataSnapshotV1(updated[0], ["tenant_id"]);
    if (!updatedHead || updatedHead.tenant_id !== value.tenantId) throw new ConnectionRegistryErrorV1("integrity_failed");
    return { replayed: false, revision };
  }

  async read(input: { tenantId: string; now: string }): Promise<IdeaLabHermes021ConnectionRosterV1> {
    return this.#readWith(input, this.#transaction);
  }

  /** Caller owns authorization and the transaction; uses the same integrity verification as read(). */
  async readInSession(session: DatabaseSession, input: { tenantId: string; now: string }): Promise<IdeaLabHermes021ConnectionRosterV1> {
    return this.#readWith(input, async callback => callback(session));
  }

  async #readWith(input: { tenantId: string; now: string }, transaction: DatabaseClient["transaction"]): Promise<IdeaLabHermes021ConnectionRosterV1> {
    const captured = exactHostDataSnapshotV1(input, ["tenantId", "now"]);
    const nowValue = captured?.now, tenantId = captured?.tenantId;
    const now = typeof nowValue === "string" ? Date.parse(nowValue) : Number.NaN;
    if (typeof tenantId !== "string" || !Number.isFinite(now) || new Date(now).toISOString() !== nowValue) {
      throw new ConnectionRegistryErrorV1("invalid_input");
    }
    try {
      return await transaction(async (tx) => {
        const stream = await this.#verifiedStream(tx, tenantId);
        const current: IdeaLabHermes021ConnectionSafeResultV1[] = [];
        for (const value of stream.values) {
          let replaced = false;
          for (let index = 0; index < current.length; index += 1) if (current[index]!.connectionId === value.connectionId) {
            current[index] = value; replaced = true; break;
          }
          if (!replaced) current[current.length] = value;
        }
        const connections: IdeaLabHermes021ConnectionSafeResultV1[] = [];
        for (const value of current) if (Date.parse(value.expiresAt) > now) connections[connections.length] = value;
        capturedReflectApply(capturedArraySort, connections,
          [(left: IdeaLabHermes021ConnectionSafeResultV1, right: IdeaLabHermes021ConnectionSafeResultV1) => (
            left.connectionId < right.connectionId ? -1 : left.connectionId > right.connectionId ? 1 : 0)]);
        try { return buildIdeaLabHermes021ConnectionRosterV1({ tenantId, evaluatedAt: nowValue, connections }); }
        catch { throw new ConnectionRegistryErrorV1("integrity_failed"); }
      });
    } catch (error) {
      const code = capturedRegistryErrorCodeV1(error);
      if (code) throw new ConnectionRegistryErrorV1(code);
      throw new ConnectionRegistryErrorV1("source_unavailable");
    }
  }
}
