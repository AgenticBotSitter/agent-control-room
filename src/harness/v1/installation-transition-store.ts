import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { advanceInstallationTransitionV1, createInstallationTransitionV1,
  verifyInstallationTransitionV1, type InstallationTransitionV1 } from "./installation-transition";

/** Authority-database journal for reviewed installation transitions only. */
export const INSTALLATION_TRANSITION_STORE_V1 = "control-room.installation-transition-store/v1" as const;

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const revision = z.number().int().min(0);
const state = z.enum(["prepared", "admission_paused", "drained", "proofs_verified", "committed", "failed", "rollback_ready", "rolled_back"]);
const rowSchema = z.object({ tenant_id: id, transition_id: id, revision: z.union([z.number(), z.string()]).transform(value => revision.parse(Number(value))),
  plan_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), state, record: z.unknown(), auth_tag: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/) }).strict();
type Row = z.output<typeof rowSchema>;

const fail = (): never => { throw new Error("installation_transition_unavailable"); };
const tag = (key: Uint8Array, tenantId: string, record: InstallationTransitionV1) => hmacSha256Tag(key,
  { purpose: "installation-transition-revision/v1", tenantId, record });
const keyIsValid = (key: Uint8Array) => key instanceof Uint8Array && key.length === 32;

function verifyRow(key: Uint8Array, tenantId: string, value: unknown): InstallationTransitionV1 {
  const row = rowSchema.parse(value), record = verifyInstallationTransitionV1(row.record);
  const expected = Buffer.from(tag(key, tenantId, record)), actual = Buffer.from(row.auth_tag);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
    || row.tenant_id !== tenantId || row.transition_id !== record.transitionId || row.revision !== record.revision
    || row.plan_digest !== record.planDigest || row.state !== record.state) fail();
  return record;
}

async function lockTenant(tx: DatabaseSession, tenantId: string): Promise<void> {
  const locked = await tx.query<{ id: string }>("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId]);
  if (locked.rows.length !== 1) fail();
}

async function journal(tx: DatabaseSession, key: Uint8Array, tenantId: string, transitionId: string): Promise<readonly InstallationTransitionV1[]> {
  const rows = (await tx.query<Row>(`SELECT tenant_id,transition_id,revision,plan_digest,state,record,auth_tag
    FROM control_installation_transition_revisions WHERE tenant_id=$1 AND transition_id=$2 ORDER BY revision ASC`, [tenantId, transitionId])).rows;
  const records = rows.map(row => verifyRow(key, tenantId, row));
  if (rows.some(row => row.tenant_id !== tenantId || row.transition_id !== transitionId)) fail();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.revision !== index || (index === 0 && record.state !== "prepared")
      || (index > 0 && record.planDigest !== records[0]!.planDigest)) fail();
    if (index > 0) {
      const prior = records[index - 1]!;
      const actionByState = { admission_paused: "pause_admission", drained: "record_drain", proofs_verified: "verify_proofs",
        committed: "commit", failed: "fail", rollback_ready: "prepare_rollback", rolled_back: "rollback" } as const;
      const action = actionByState[record.state as keyof typeof actionByState];
      if (!action) fail();
      try {
        const expected = advanceInstallationTransitionV1(prior, { expectedRevision: prior.revision, action,
        now: record.updatedAt, ...(record.evidenceDigest ? { evidenceDigest: record.evidenceDigest } : {}),
        ...(record.failureDigest ? { failureDigest: record.failureDigest } : {}),
        ...(action === "record_drain" && record.drainStatus ? { drainStatus: record.drainStatus } : {}) });
        if (sha256Digest(expected) !== sha256Digest(record)) fail();
      } catch { fail(); }
    }
  }
  return Object.freeze(records);
}

async function append(tx: DatabaseSession, key: Uint8Array, tenantId: string, record: InstallationTransitionV1): Promise<boolean> {
  const inserted = await tx.query<{ revision: number }>(`INSERT INTO control_installation_transition_revisions
    (tenant_id,transition_id,revision,plan_digest,state,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
    ON CONFLICT (tenant_id,transition_id,revision) DO NOTHING RETURNING revision`,
  [tenantId, record.transitionId, record.revision, record.planDigest, record.state, JSON.stringify(record), tag(key, tenantId, record)]);
  return inserted.rows.length === 1;
}

/** Creates revision zero, or proves that an exact retry is the saved revision zero. */
export async function createInstallationTransitionRecordV1(tx: DatabaseSession, integrityKey: Uint8Array,
  input: Readonly<{ tenantId: unknown; transitionId: unknown; topologyPlan: unknown; now: unknown }>) {
  if (!keyIsValid(integrityKey)) fail();
  const tenantId = id.parse(input.tenantId);
  await lockTenant(tx, tenantId);
  const record = createInstallationTransitionV1(input);
  assertNoSecretMaterial(record, "installation transition");
  const existing = await journal(tx, integrityKey, tenantId, record.transitionId);
  if (existing.length > 0) {
    if (sha256Digest(existing[0]) !== sha256Digest(record)) fail();
    return Object.freeze({ record: existing[0]!, replayed: true as const, startsWork: false as const,
      grantsExecutionAuthority: false as const });
  }
  if (await append(tx, integrityKey, tenantId, record)) return Object.freeze({ record, replayed: false as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
  const raced = await journal(tx, integrityKey, tenantId, record.transitionId);
  if (raced.length !== 1 || sha256Digest(raced[0]) !== sha256Digest(record)) fail();
  return Object.freeze({ record: raced[0]!, replayed: true as const, startsWork: false as const,
    grantsExecutionAuthority: false as const });
}

/** Appends exactly one reviewed state-machine revision. It starts no work. */
export async function advanceInstallationTransitionRecordV1(tx: DatabaseSession, integrityKey: Uint8Array,
  input: Readonly<{ tenantId: unknown; transitionId: unknown; expectedRevision: unknown; action: unknown; now: unknown;
    evidenceDigest?: unknown; failureDigest?: unknown }>) {
  if (!keyIsValid(integrityKey)) fail();
  const tenantId = id.parse(input.tenantId), transitionId = id.parse(input.transitionId), expectedRevision = revision.parse(input.expectedRevision);
  await lockTenant(tx, tenantId);
  const records = await journal(tx, integrityKey, tenantId, transitionId);
  const current = records.at(expectedRevision);
  if (!current) throw new Error("installation_transition_conflict");
  let next: InstallationTransitionV1;
  try { next = advanceInstallationTransitionV1(current, input); } catch { throw new Error("installation_transition_conflict"); }
  assertNoSecretMaterial(next, "installation transition");
  const savedNext = records.at(expectedRevision + 1);
  if (savedNext) {
    if (sha256Digest(savedNext) !== sha256Digest(next)) fail();
    return Object.freeze({ record: savedNext!, replayed: true as const, startsWork: false as const,
      grantsExecutionAuthority: false as const });
  }
  if (records.length !== expectedRevision + 1) throw new Error("installation_transition_conflict");
  if (await append(tx, integrityKey, tenantId, next)) return Object.freeze({ record: next, replayed: false as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
  const raced = await journal(tx, integrityKey, tenantId, transitionId);
  const racedNext = raced.at(expectedRevision + 1);
  if (!racedNext || sha256Digest(racedNext) !== sha256Digest(next)) fail();
  return Object.freeze({ record: racedNext!, replayed: true as const, startsWork: false as const,
    grantsExecutionAuthority: false as const });
}

/** Reads the latest authenticated transition record. Raw records stay server-only. */
export async function readInstallationTransitionRecordV1(tx: DatabaseSession, integrityKey: Uint8Array,
  input: Readonly<{ tenantId: unknown; transitionId: unknown }>): Promise<InstallationTransitionV1 | null> {
  if (!keyIsValid(integrityKey)) fail();
  const records = await journal(tx, integrityKey, id.parse(input.tenantId), id.parse(input.transitionId));
  return records.at(-1) ?? null;
}

/** Answers only whether a saved transition currently fences new admission for one worker. */
export async function isInstallationTransitionAdmissionPausedV1(tx: DatabaseSession, integrityKey: Uint8Array,
  input: Readonly<{ tenantId: unknown; workerId: unknown }>): Promise<boolean> {
  if (!keyIsValid(integrityKey)) fail();
  const tenantId = id.parse(input.tenantId), workerId = id.parse(input.workerId);
  const transitions = (await tx.query<{ transition_id: string }>(`SELECT DISTINCT transition_id
    FROM control_installation_transition_revisions WHERE tenant_id=$1`, [tenantId])).rows;
  for (const transition of transitions) {
    const record = (await journal(tx, integrityKey, tenantId, id.parse(transition.transition_id))).at(-1);
    if (record?.affectedWorkerIds.includes(workerId) && (record.state === "admission_paused" || record.state === "drained"
      || record.state === "proofs_verified" || record.state === "failed" || record.state === "rollback_ready")) return true;
  }
  return false;
}
