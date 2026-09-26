import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag } from "../../security";
import { advanceRemoteWorkerEnrollmentRecordV1, createRemoteWorkerEnrollmentRecordV1,
  type RemoteWorkerEnrollmentRecordV1, verifyRemoteWorkerEnrollmentRecordV1 } from "./remote-worker-enrollment-record";

export const REMOTE_WORKER_ENROLLMENT_STORE_V1 =
  "control-room.remote-worker-enrollment-store/v1" as const;

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.number().int().min(0);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const unavailable = (): never => { throw new Error("remote_worker_enrollment_unavailable"); };

type Row = { tenant_id: string; worker_id: string; revision: number | string; node_id: string;
  node_key_id: string; enrollment_id: string; state: string; record: unknown; auth_tag: string };
type VerifiedRevision = Readonly<{ record: RemoteWorkerEnrollmentRecordV1; authTag: string }>;

const tag = (key: Uint8Array, record: RemoteWorkerEnrollmentRecordV1) => hmacSha256Tag(key,
  { purpose: "remote-worker-enrollment-revision/v1", record });
const validKey = (key: Uint8Array) => key instanceof Uint8Array && key.length === 32;

function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifyRow(key: Uint8Array, value: Row): VerifiedRevision {
  const record = verifyRemoteWorkerEnrollmentRecordV1(value.record);
  if (value.tenant_id !== record.tenantId || value.worker_id !== record.workerId
    || Number(value.revision) !== record.revision || value.node_id !== record.nodeId
    || value.node_key_id !== record.nodeKeyId || value.enrollment_id !== record.enrollmentId
    || value.state !== record.state || !same(value.auth_tag, tag(key, record))) unavailable();
  return Object.freeze({ record, authTag: value.auth_tag });
}

async function lockTenant(tx: DatabaseSession, tenantId: string): Promise<void> {
  if ((await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId])).rows.length !== 1) unavailable();
}

async function revisions(tx: DatabaseSession, key: Uint8Array, tenantId: string, workerId: string,
  lock = false): Promise<readonly VerifiedRevision[]> {
  const rows = (await tx.query<Row>(`SELECT tenant_id,worker_id,revision,node_id,node_key_id,enrollment_id,state,record,auth_tag
    FROM control_remote_worker_enrollment_revisions WHERE tenant_id=$1 AND worker_id=$2
    ORDER BY revision ASC${lock ? " FOR UPDATE" : ""}`, [tenantId, workerId])).rows;
  const verified = rows.map(row => verifyRow(key, row));
  for (let index = 0; index < verified.length; index += 1) {
    const current = verified[index]!.record;
    if (current.revision !== index) unavailable();
    if (index > 0) {
      const prior = verified[index - 1]!.record;
      const expected = (() => {
        try { return advanceRemoteWorkerEnrollmentRecordV1(prior, { expectedRevision: prior.revision,
          state: current.state, evidenceDigest: current.evidenceDigest, now: current.updatedAt }); }
        catch { return unavailable(); }
      })();
      if (expected.recordDigest !== current.recordDigest) unavailable();
    }
  }
  return Object.freeze(verified);
}

type NodeKeyRow = { node_state: string; identity_key_id: string; key_state: string;
  valid_from: string | Date; valid_until: string | Date | null; revoked_at: string | Date | null };

async function nodeKey(tx: DatabaseSession, record: RemoteWorkerEnrollmentRecordV1, lock: boolean): Promise<NodeKeyRow> {
  const rows = (await tx.query<NodeKeyRow>(`SELECT n.state AS node_state,n.identity_key_id,k.state AS key_state,
      k.valid_from,k.valid_until,k.revoked_at FROM control_nodes n JOIN control_node_keys k
      ON k.tenant_id=n.tenant_id AND k.node_id=n.id
    WHERE n.tenant_id=$1 AND n.id=$2 AND k.id=$3${lock ? " FOR UPDATE" : ""}`,
  [record.tenantId, record.nodeId, record.nodeKeyId])).rows;
  if (rows.length !== 1) unavailable();
  return rows[0]!;
}

function millis(value: string | Date): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result)) unavailable();
  return result;
}

function requireCurrentKey(row: NodeKeyRow, record: RemoteWorkerEnrollmentRecordV1, nowValue: unknown): void {
  const now = Date.parse(instant.parse(nowValue));
  if (row.node_state !== "active" || row.identity_key_id !== record.nodeKeyId || row.key_state !== "active"
    || row.revoked_at !== null || millis(row.valid_from) > now
    || row.valid_until !== null && millis(row.valid_until) <= now) unavailable();
}

async function append(tx: DatabaseSession, key: Uint8Array, record: RemoteWorkerEnrollmentRecordV1): Promise<boolean> {
  const result = await tx.query(`INSERT INTO control_remote_worker_enrollment_revisions
    (tenant_id,worker_id,revision,node_id,node_key_id,enrollment_id,adapter_id,adapter_revision,
      capability_digest,enrollment_digest,release_binding_digest,state,enrolled_at,updated_at,evidence_digest,
      previous_record_digest,record,auth_tag)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)
    ON CONFLICT (tenant_id,worker_id,revision) DO NOTHING RETURNING revision`,
  [record.tenantId, record.workerId, record.revision, record.nodeId, record.nodeKeyId, record.enrollmentId,
    record.adapterId, record.adapterRevision, record.capabilityDigest, record.enrollmentDigest,
    record.releaseBindingDigest, record.state, record.enrolledAt, record.updatedAt, record.evidenceDigest ?? null,
    record.previousRecordDigest, JSON.stringify(record), tag(key, record)]);
  return result.rows.length === 1;
}

function result(value: VerifiedRevision, replayed: boolean) {
  return Object.freeze({ record: value.record, auditReceipt: Object.freeze({ recordDigest: value.record.recordDigest,
    previousRecordDigest: value.record.previousRecordDigest, revision: value.record.revision,
    state: value.record.state, recordedAt: value.record.updatedAt, authTag: value.authTag }), replayed,
    startsWork: false as const, grantsExecutionAuthority: false as const });
}

/** Creates revision zero or proves an exact retry. */
export async function createRemoteWorkerEnrollmentInStoreV1(tx: DatabaseSession, key: Uint8Array,
  input: Parameters<typeof createRemoteWorkerEnrollmentRecordV1>[0]) {
  if (!validKey(key)) unavailable();
  const record = createRemoteWorkerEnrollmentRecordV1(input);
  assertNoSecretMaterial(record, "remote worker enrollment");
  await lockTenant(tx, record.tenantId);
  requireCurrentKey(await nodeKey(tx, record, true), record, record.updatedAt);
  const existing = await revisions(tx, key, record.tenantId, record.workerId, true);
  if (existing.length > 0) {
    if (existing[0]!.record.recordDigest !== record.recordDigest) unavailable();
    return result(existing[0]!, true);
  }
  if (!await append(tx, key, record)) unavailable();
  return result(Object.freeze({ record, authTag: tag(key, record) }), false);
}

/** Reads the current enrolled authority and rechecks every expected binding plus live node/key state. */
async function readCurrentRemoteWorkerEnrollment(tx: DatabaseSession, key: Uint8Array,
  input: Readonly<{ tenantId: unknown; workerId: unknown; nodeId: unknown; nodeKeyId: unknown;
    adapterId: unknown; adapterRevision: unknown; capabilityDigest: unknown; enrollmentId: unknown;
    enrollmentDigest: unknown; releaseBindingDigest: unknown; now: unknown }>, lock: boolean): Promise<RemoteWorkerEnrollmentRecordV1> {
  if (!validKey(key)) unavailable();
  const tenantId = id.parse(input.tenantId), workerId = id.parse(input.workerId);
  // Enrollment writers take this fence before appending a revision.  A
  // terminal-result transaction must take it too, otherwise it could read an
  // enrolled row while a revocation is about to append a newer one.
  if (lock) await lockTenant(tx, tenantId);
  const current = (await revisions(tx, key, tenantId, workerId, lock)).at(-1)?.record ?? unavailable();
  if (current.state !== "enrolled" || current.nodeId !== id.parse(input.nodeId)
    || current.nodeKeyId !== id.parse(input.nodeKeyId) || current.adapterId !== id.parse(input.adapterId)
    || current.adapterRevision !== z.string().min(7).max(180).parse(input.adapterRevision)
    || current.capabilityDigest !== digest.parse(input.capabilityDigest)
    || current.enrollmentId !== id.parse(input.enrollmentId)
    || current.enrollmentDigest !== digest.parse(input.enrollmentDigest)
    || current.releaseBindingDigest !== digest.parse(input.releaseBindingDigest)) unavailable();
  requireCurrentKey(await nodeKey(tx, current, lock), current, input.now);
  return current;
}

/** Read-only current authority check. It does not reserve a lifecycle fence. */
export async function readCurrentRemoteWorkerEnrollmentV1(tx: DatabaseSession, key: Uint8Array,
  input: Parameters<typeof readCurrentRemoteWorkerEnrollment>[2]): Promise<RemoteWorkerEnrollmentRecordV1> {
  return readCurrentRemoteWorkerEnrollment(tx, key, input, false);
}

/**
 * Current authority check for a transaction which will mutate receipt-bound
 * remote evidence. It serializes against enrollment lifecycle changes.
 */
export async function readLockedCurrentRemoteWorkerEnrollmentV1(tx: DatabaseSession, key: Uint8Array,
  input: Parameters<typeof readCurrentRemoteWorkerEnrollment>[2]): Promise<RemoteWorkerEnrollmentRecordV1> {
  return readCurrentRemoteWorkerEnrollment(tx, key, input, true);
}

/** Appends one reviewed lifecycle change; it never starts or contacts a worker. */
export async function advanceRemoteWorkerEnrollmentInStoreV1(tx: DatabaseSession, key: Uint8Array,
  input: Readonly<{ tenantId: unknown; workerId: unknown; expectedRevision: unknown;
    state: unknown; evidenceDigest: unknown; now: unknown }>) {
  if (!validKey(key)) unavailable();
  const tenantId = id.parse(input.tenantId), workerId = id.parse(input.workerId);
  await lockTenant(tx, tenantId);
  const journal = await revisions(tx, key, tenantId, workerId, true);
  const expectedRevision = revision.parse(input.expectedRevision);
  const current = journal.at(expectedRevision)?.record;
  if (!current) throw new Error("remote_worker_enrollment_conflict");
  await nodeKey(tx, current, true);
  let next: RemoteWorkerEnrollmentRecordV1;
  try { next = advanceRemoteWorkerEnrollmentRecordV1(current, input); }
  catch { throw new Error("remote_worker_enrollment_conflict"); }
  assertNoSecretMaterial(next, "remote worker enrollment");
  const saved = journal.at(expectedRevision + 1);
  if (saved) {
    if (saved.record.recordDigest !== next.recordDigest) unavailable();
    return result(saved, true);
  }
  if (journal.length !== expectedRevision + 1) throw new Error("remote_worker_enrollment_conflict");
  if (!await append(tx, key, next)) unavailable();
  return result(Object.freeze({ record: next, authTag: tag(key, next) }), false);
}
