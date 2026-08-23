import { assertNoSecretMaterial, sha256Digest } from "../security";
import type { DatabaseClient, DatabaseSession } from "../persistence/database";
import type { AuditAnchor, AuditInput, AuditVerification } from "./types";

const genesisHash = `sha256:${"0".repeat(64)}`;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function auditPartition(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) throw new Error("Audit occurredAt is invalid");
  return `month:${date.toISOString().slice(0, 7)}`;
}

function normalizeOccurredAt(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) throw new Error("Audit occurredAt is invalid");
  return date.toISOString();
}

function eventMaterial(input: AuditInput) {
  return {
    id: input.id,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    actorId: input.actorId,
    actorType: input.actorType,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    correlationId: input.correlationId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    safeMetadata: input.safeMetadata ?? {},
    occurredAt: normalizeOccurredAt(input.occurredAt),
  };
}

type StoredAuditEvent = AuditInput & {
  chain_sequence: number | string;
  event_digest: string;
  prev_hash: string;
  event_hash: string;
};

function chainHash(partition: string, sequence: number, previousHash: string, eventDigest: string): string {
  return sha256Digest({ chainVersion: 1, partition, sequence, previousHash, eventDigest });
}

function safeCount(value: number | string, label: string): number {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${label} is outside the supported safe integer range`);
  return count;
}

async function verifyWith(db: DatabaseSession, tenantId: string, chainPartition: string): Promise<AuditVerification> {
  const events = await db.query<StoredAuditEvent>(
    `SELECT id,tenant_id as "tenantId",workspace_id as "workspaceId",project_id as "projectId",
      actor_id as "actorId",actor_type as "actorType",action,target_type as "targetType",target_id as "targetId",
      correlation_id as "correlationId",idempotency_key as "idempotencyKey",safe_metadata as "safeMetadata",
      occurred_at as "occurredAt",chain_sequence,event_digest,prev_hash,event_hash FROM audit_events
     WHERE tenant_id=$1 AND chain_partition=$2 AND chain_version=1 ORDER BY chain_sequence`,
    [tenantId, chainPartition],
  );
  let previousHash = genesisHash;
  for (let index = 0; index < events.rows.length; index += 1) {
    const event = events.rows[index];
    const sequence = safeCount(event.chain_sequence, "Audit sequence");
    const expectedSequence = index + 1;
    if (sequence !== expectedSequence || event.prev_hash !== previousHash) {
      return { valid: false, chainPartition, checkedEvents: index, reasonCode: "chain_link_mismatch" };
    }
    if (sha256Digest(eventMaterial(event)) !== event.event_digest) {
      return { valid: false, chainPartition, checkedEvents: index, reasonCode: "event_digest_mismatch" };
    }
    const expectedHash = chainHash(chainPartition, sequence, event.prev_hash, event.event_digest);
    if (event.event_hash !== expectedHash) return { valid: false, chainPartition, checkedEvents: index, reasonCode: "event_hash_mismatch" };
    previousHash = event.event_hash;
  }
  const head = await db.query<{ head_hash: string; event_count: number | string }>(
    `SELECT head_hash,event_count FROM control_audit_chain_heads WHERE tenant_id=$1 AND chain_partition=$2`,
    [tenantId, chainPartition],
  );
  if (!head.rows[0] || safeCount(head.rows[0].event_count, "Audit event count") !== events.rows.length || head.rows[0].head_hash !== previousHash) {
    return { valid: false, chainPartition, checkedEvents: events.rows.length, reasonCode: "head_mismatch" };
  }
  return { valid: true, chainPartition, checkedEvents: events.rows.length, headHash: previousHash };
}

export async function appendAuditWith(tx: DatabaseSession, input: AuditInput): Promise<{ replayed: boolean; eventHash: string }> {
  assertNoSecretMaterial(input, "Audit event");
  const normalizedInput = { ...input, occurredAt: normalizeOccurredAt(input.occurredAt) };
  const eventDigest = sha256Digest(eventMaterial(normalizedInput));
  const existing = await tx.query<{ event_digest: string; event_hash: string }>(
    `SELECT event_digest,event_hash FROM audit_events WHERE id=$1`,
    [input.id],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].event_digest !== eventDigest) throw new Error("Audit ID reused with different event content");
    return { replayed: true, eventHash: existing.rows[0].event_hash };
  }

  const partition = auditPartition(normalizedInput.occurredAt);
  await tx.query(
    `INSERT INTO control_audit_chain_heads (tenant_id,chain_partition,head_hash,event_count,updated_at)
     VALUES ($1,$2,$3,0,$4) ON CONFLICT DO NOTHING`,
    [normalizedInput.tenantId, partition, genesisHash, normalizedInput.occurredAt],
  );
  const head = await tx.query<{ head_hash: string; event_count: number | string }>(
    `SELECT head_hash,event_count FROM control_audit_chain_heads
     WHERE tenant_id=$1 AND chain_partition=$2 FOR UPDATE`,
    [normalizedInput.tenantId, partition],
  );
  const current = head.rows[0];
  if (!current) throw new Error("Audit chain head disappeared");
  const currentCount = safeCount(current.event_count, "Audit event count");
  const sequence = currentCount + 1;
  const eventHash = chainHash(partition, sequence, current.head_hash, eventDigest);
  await tx.query(
    `INSERT INTO audit_events (
       id,tenant_id,workspace_id,project_id,actor_id,actor_type,action,target_type,target_id,
       correlation_id,idempotency_key,safe_metadata,occurred_at,chain_version,chain_partition,chain_sequence,event_digest,prev_hash,event_hash
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,1,$14,$15,$16,$17,$18)`,
    [normalizedInput.id, normalizedInput.tenantId, normalizedInput.workspaceId ?? null, normalizedInput.projectId ?? null, normalizedInput.actorId, normalizedInput.actorType,
      normalizedInput.action, normalizedInput.targetType, normalizedInput.targetId, normalizedInput.correlationId ?? null, normalizedInput.idempotencyKey ?? null,
      json(normalizedInput.safeMetadata ?? {}), normalizedInput.occurredAt, partition, sequence, eventDigest, current.head_hash, eventHash],
  );
  const updated = await tx.query<{ event_hash: string }>(
    `UPDATE control_audit_chain_heads SET head_hash=$1,event_count=$2,updated_at=$3
     WHERE tenant_id=$4 AND chain_partition=$5 AND head_hash=$6 AND event_count=$7
     RETURNING head_hash`,
    [eventHash, sequence, normalizedInput.occurredAt, normalizedInput.tenantId, partition, current.head_hash, currentCount],
  );
  if (!updated.rows[0]) throw new Error("Audit chain head changed during append");
  return { replayed: false, eventHash };
}

export class AuditStore {
  constructor(private readonly db: DatabaseClient) {}

  async append(input: AuditInput): Promise<{ replayed: boolean; eventHash: string }> {
    return this.db.transaction((tx) => appendAuditWith(tx, input));
  }

  async verify(tenantId: string, chainPartition: string): Promise<AuditVerification> {
    return verifyWith(this.db, tenantId, chainPartition);
  }

  async recordAnchor(anchor: AuditAnchor): Promise<void> {
    assertNoSecretMaterial(anchor, "Audit anchor");
    await this.db.transaction(async (tx) => {
      if (!Number.isSafeInteger(anchor.eventCount) || anchor.eventCount < 1) throw new Error("Audit anchor event count is invalid");
      const current = await tx.query<{ head_hash: string; event_count: number | string }>(
        `SELECT head_hash,event_count FROM control_audit_chain_heads WHERE tenant_id=$1 AND chain_partition=$2 FOR UPDATE`,
        [anchor.tenantId, anchor.chainPartition],
      );
      if (!current.rows[0] || current.rows[0].head_hash !== anchor.headHash
        || safeCount(current.rows[0].event_count, "Audit event count") !== anchor.eventCount) {
        throw new Error("Audit anchor does not match the current chain head");
      }
      const verified = await verifyWith(tx, anchor.tenantId, anchor.chainPartition);
      if (!verified.valid || verified.headHash !== anchor.headHash || verified.checkedEvents !== anchor.eventCount) {
        throw new Error("Audit anchor does not match a verified chain");
      }
      await tx.query(
        `INSERT INTO control_audit_anchors (id,tenant_id,chain_partition,head_hash,event_count,anchor_kind,safe_reference,anchored_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,chain_partition,head_hash) DO NOTHING`,
        [anchor.id, anchor.tenantId, anchor.chainPartition, anchor.headHash, anchor.eventCount, anchor.anchorKind, anchor.safeReference ?? null, anchor.anchoredAt],
      );
    });
  }
}
