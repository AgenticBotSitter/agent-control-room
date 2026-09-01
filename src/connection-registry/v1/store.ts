import { timingSafeEqual } from "node:crypto";
import {
  buildIdeaLabHermes021ConnectionRosterV1,
  parseIdeaLabHermes021ConnectionSafeResultV1,
  type IdeaLabHermes021ConnectionRosterV1,
  type IdeaLabHermes021ConnectionSafeResultV1,
} from "../../idea-lab/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { dataMethodV1, exactHostDataSnapshotV1, exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";

interface EnrollmentRowV1 {
  tenant_id: string;
  connection_id: string;
  enrollment_id: string;
  node_id: string;
  revision: number | string;
  result_digest: string;
  payload_digest: string;
  record_auth_tag: string;
  issued_at: string | Date;
  expires_at: string | Date;
  recorded_at: string | Date;
  payload: unknown;
}

const columns = `tenant_id,connection_id,enrollment_id,node_id,revision,result_digest,payload_digest,
  record_auth_tag,issued_at,expires_at,recorded_at,payload`;

function instant(value: string | Date): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rowMaterial(row: Omit<EnrollmentRowV1, "record_auth_tag" | "payload">) {
  return {
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    enrollmentId: row.enrollment_id,
    nodeId: row.node_id,
    revision: Number(row.revision),
    resultDigest: row.result_digest,
    payloadDigest: row.payload_digest,
    issuedAt: instant(row.issued_at),
    expiresAt: instant(row.expires_at),
    recordedAt: instant(row.recorded_at),
  };
}

export class ConnectionRegistryErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_input" | "scope_mismatch" | "replay_conflict" |
    "capacity_exceeded" | "integrity_failed" | "source_unavailable") {
    super(safeCode); this.name = "ConnectionRegistryErrorV1";
  }
}

/**
 * Durable server-only enrollment registry. Raw signed identifiers are protected
 * values and are never returned by the Connection Center projection.
 */
export class ConnectionRegistryStoreV1 {
  readonly #query: DatabaseClient["query"];
  readonly #transaction: DatabaseClient["transaction"];
  readonly #key: Uint8Array;

  constructor(db: DatabaseClient, integrityKeyValue: unknown) {
    const key = exactHostUint8ArrayV1(integrityKeyValue, 128);
    const query = dataMethodV1(db, "query") as DatabaseClient["query"] | undefined;
    const transaction = dataMethodV1(db, "transaction") as DatabaseClient["transaction"] | undefined;
    if (!db || typeof db !== "object" || isHostProxyV1(db) || !query || !transaction || !key || key.byteLength !== 32) {
      throw new ConnectionRegistryErrorV1("invalid_input");
    }
    this.#query = ((statement, params) => query.call(db, statement, params)) as DatabaseClient["query"];
    this.#transaction = ((callback) => transaction.call(db, callback)) as DatabaseClient["transaction"];
    this.#key = key.copy();
  }

  #tag(row: Omit<EnrollmentRowV1, "record_auth_tag" | "payload">): string {
    return hmacSha256Tag(this.#key, { kind: "connection_enrollment", ...rowMaterial(row) });
  }

  #verify(row: EnrollmentRowV1, tenantId: string): IdeaLabHermes021ConnectionSafeResultV1 {
    let value: IdeaLabHermes021ConnectionSafeResultV1;
    try { value = parseIdeaLabHermes021ConnectionSafeResultV1(row.payload); }
    catch { throw new ConnectionRegistryErrorV1("integrity_failed"); }
    let valid = false;
    try {
      valid = row.tenant_id === tenantId && value.tenantId === tenantId
        && row.connection_id === value.connectionId && row.enrollment_id === value.enrollmentId
        && row.node_id === value.nodeId && row.result_digest === value.resultDigest
        && row.payload_digest === sha256Digest(value)
        && instant(row.issued_at) === value.issuedAt && instant(row.expires_at) === value.expiresAt
        && same(row.record_auth_tag, this.#tag(row));
    } catch { valid = false; }
    if (!valid) throw new ConnectionRegistryErrorV1("integrity_failed");
    try { assertNoSecretMaterial(value, "connection enrollment"); }
    catch { throw new ConnectionRegistryErrorV1("integrity_failed"); }
    return value;
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
    if (Date.parse(enrollment.issuedAt) > recorded + 5 * 60_000
      || Date.parse(enrollment.expiresAt) <= recorded) throw new ConnectionRegistryErrorV1("invalid_input");
    try { assertNoSecretMaterial(enrollment, "connection enrollment"); }
    catch { throw new ConnectionRegistryErrorV1("invalid_input"); }
    try {
      return await this.#transaction((tx) => this.#persist(tx, enrollment, recordedAtValue));
    } catch (error) {
      if (error instanceof ConnectionRegistryErrorV1) throw error;
      throw new ConnectionRegistryErrorV1("source_unavailable");
    }
  }

  async #persist(tx: DatabaseSession, value: IdeaLabHermes021ConnectionSafeResultV1,
    recordedAt: string): Promise<{ replayed: boolean; revision: number }> {
    const tenant = await tx.query(`SELECT id FROM tenants WHERE id=$1 FOR UPDATE`, [value.tenantId]);
    if (!tenant.rows[0]) throw new ConnectionRegistryErrorV1("scope_mismatch");
    const priorEnrollment = await tx.query<EnrollmentRowV1>(`SELECT ${columns} FROM control_connection_enrollments
      WHERE tenant_id=$1 AND enrollment_id=$2 FOR UPDATE`, [value.tenantId, value.enrollmentId]);
    if (priorEnrollment.rows[0]) {
      const verified = this.#verify(priorEnrollment.rows[0], value.tenantId);
      if (verified.resultDigest !== value.resultDigest) throw new ConnectionRegistryErrorV1("replay_conflict");
      return { replayed: true, revision: Number(priorEnrollment.rows[0].revision) };
    }
    const latestResult = await tx.query<EnrollmentRowV1>(`SELECT ${columns} FROM control_connection_enrollments
      WHERE tenant_id=$1 AND connection_id=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
    [value.tenantId, value.connectionId]);
    const latest = latestResult.rows[0];
    const currentRows = (await tx.query<EnrollmentRowV1>(`SELECT ${columns} FROM (
      SELECT DISTINCT ON (connection_id) ${columns} FROM control_connection_enrollments
      WHERE tenant_id=$1 ORDER BY connection_id,revision DESC) current ORDER BY connection_id`, [value.tenantId])).rows;
    const activeOtherConnections = currentRows.map((row) => this.#verify(row, value.tenantId))
      .filter((candidate) => candidate.connectionId !== value.connectionId
        && Date.parse(candidate.expiresAt) > Date.parse(recordedAt));
    if (activeOtherConnections.some((candidate) => candidate.connectorRouteDigest === value.connectorRouteDigest
      || candidate.profileIdentityDigest === value.profileIdentityDigest)) {
      throw new ConnectionRegistryErrorV1("replay_conflict");
    }
    let revision = 1;
    if (latest) {
      const prior = this.#verify(latest, value.tenantId);
      if (Date.parse(value.issuedAt) <= Date.parse(prior.issuedAt)
        || Date.parse(value.expiresAt) <= Date.parse(prior.expiresAt)) {
        throw new ConnectionRegistryErrorV1("replay_conflict");
      }
      revision = Number(latest.revision) + 1;
    } else {
      if (activeOtherConnections.length >= 32) throw new ConnectionRegistryErrorV1("capacity_exceeded");
    }
    const row: Omit<EnrollmentRowV1, "record_auth_tag" | "payload"> = {
      tenant_id: value.tenantId, connection_id: value.connectionId, enrollment_id: value.enrollmentId,
      node_id: value.nodeId, revision, result_digest: value.resultDigest, payload_digest: sha256Digest(value),
      issued_at: value.issuedAt, expires_at: value.expiresAt, recorded_at: recordedAt,
    };
    await tx.query(`INSERT INTO control_connection_enrollments(${columns})
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [row.tenant_id,row.connection_id,row.enrollment_id,row.node_id,row.revision,row.result_digest,row.payload_digest,
      this.#tag(row),row.issued_at,row.expires_at,row.recorded_at,JSON.stringify(value)]);
    return { replayed: false, revision };
  }

  async read(input: { tenantId: string; now: string }): Promise<IdeaLabHermes021ConnectionRosterV1> {
    const captured = exactHostDataSnapshotV1(input, ["tenantId", "now"]);
    const nowValue = captured?.now, tenantId = captured?.tenantId;
    const now = typeof nowValue === "string" ? Date.parse(nowValue) : Number.NaN;
    if (typeof tenantId !== "string" || !Number.isFinite(now) || new Date(now).toISOString() !== nowValue) {
      throw new ConnectionRegistryErrorV1("invalid_input");
    }
    let rows: EnrollmentRowV1[];
    try {
      rows = (await this.#query<EnrollmentRowV1>(`SELECT ${columns} FROM (
        SELECT DISTINCT ON (connection_id) ${columns} FROM control_connection_enrollments
        WHERE tenant_id=$1 ORDER BY connection_id,revision DESC) current ORDER BY connection_id`, [tenantId])).rows;
    } catch { throw new ConnectionRegistryErrorV1("source_unavailable"); }
    const connections = rows.map((row) => this.#verify(row, tenantId))
      .filter((value) => Date.parse(value.expiresAt) > now);
    try { return buildIdeaLabHermes021ConnectionRosterV1({ tenantId, evaluatedAt: nowValue, connections }); }
    catch { throw new ConnectionRegistryErrorV1("integrity_failed"); }
  }
}
