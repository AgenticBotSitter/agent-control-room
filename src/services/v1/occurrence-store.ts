import type { DatabaseClient } from "../../persistence/database";
import type { ScheduleOccurrenceV1 } from "./recurrence";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const digest = /^sha256:[a-f0-9]{64}$/;
function instant(value: string): boolean { const parsed = new Date(value); return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value; }
function json(value: unknown): string { return JSON.stringify(value); }

export class ScheduleOccurrenceError extends Error {
  constructor(readonly safeCode: "invalid_occurrence" | "occurrence_conflict" | "outbox_not_delivered" | "occurrence_cancelled") { super(safeCode); }
}

export interface ScheduleOccurrenceProposalV1 extends ScheduleOccurrenceV1 {
  tenantId: string;
  targetType: "workflow" | "job" | "service_check";
  targetId: string;
  definitionDigest: string;
  createdAt: string;
}

export interface StoredScheduleOccurrenceV1 extends ScheduleOccurrenceProposalV1 {
  state: "pending" | "dispatched" | "cancelled";
  dispatchedAt?: string;
}

function valid(input: ScheduleOccurrenceProposalV1): boolean {
  return [input.tenantId,input.scheduleId,input.occurrenceKey,input.targetId].every((value) => safeId.test(value))
    && ["workflow","job","service_check"].includes(input.targetType) && digest.test(input.definitionDigest)
    && instant(input.scheduledFor) && /^[0-9TZ:.+-]{16,40}$/.test(input.localTime) && instant(input.createdAt);
}

function same(row: StoredScheduleOccurrenceV1, input: ScheduleOccurrenceProposalV1): boolean {
  return row.tenantId === input.tenantId && row.scheduleId === input.scheduleId && row.occurrenceKey === input.occurrenceKey
    && row.targetType === input.targetType && row.targetId === input.targetId && row.definitionDigest === input.definitionDigest
    && row.scheduledFor === input.scheduledFor && row.localTime === input.localTime;
}

/** Durable occurrence proposal and outbox record only; it does not dispatch or execute the target. */
export class ScheduleOccurrenceStore {
  constructor(private readonly db: DatabaseClient) {}

  async materialize(input: ScheduleOccurrenceProposalV1): Promise<{ occurrence: StoredScheduleOccurrenceV1; replayed: boolean }> {
    if (!valid(input)) throw new ScheduleOccurrenceError("invalid_occurrence");
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query<Row>(`INSERT INTO control_schedule_occurrences (tenant_id,schedule_id,occurrence_key,target_type,target_id,definition_digest,scheduled_for,local_time,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) ON CONFLICT DO NOTHING RETURNING *`, [input.tenantId,input.scheduleId,input.occurrenceKey,input.targetType,input.targetId,input.definitionDigest,input.scheduledFor,input.localTime,input.createdAt]);
      if (inserted.rows[0]) {
        const occurrence = rowToOccurrence(inserted.rows[0]);
        await tx.query(`INSERT INTO control_outbox (id,tenant_id,topic,aggregate_type,aggregate_id,idempotency_key,status,available_at,payload) VALUES ($1,$2,'schedule.occurrence.created','schedule_occurrence',$3,$4,'pending',$5,$6::jsonb)`, [outboxId(input),input.tenantId,input.occurrenceKey,input.occurrenceKey,input.createdAt,json({ scheduleId: input.scheduleId, occurrenceKey: input.occurrenceKey, targetType: input.targetType, targetId: input.targetId, scheduledFor: input.scheduledFor, definitionDigest: input.definitionDigest })]);
        return { occurrence, replayed: false };
      }
      const prior = await tx.query<Row>(`SELECT * FROM control_schedule_occurrences WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 FOR UPDATE`, [input.tenantId,input.scheduleId,input.occurrenceKey]);
      const occurrence = prior.rows[0] && rowToOccurrence(prior.rows[0]);
      if (!occurrence || !same(occurrence, input)) throw new ScheduleOccurrenceError("occurrence_conflict");
      return { occurrence, replayed: true };
    });
  }

  async acknowledgeDelivery(input: { tenantId: string; scheduleId: string; occurrenceKey: string; deliveredAt: string }): Promise<{ occurrence: StoredScheduleOccurrenceV1; replayed: boolean }> {
    if (![input.tenantId,input.scheduleId,input.occurrenceKey].every((value) => safeId.test(value)) || !instant(input.deliveredAt)) throw new ScheduleOccurrenceError("invalid_occurrence");
    return this.db.transaction(async (tx) => {
      const prior = await tx.query<Row>(`SELECT * FROM control_schedule_occurrences WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 FOR UPDATE`, [input.tenantId,input.scheduleId,input.occurrenceKey]);
      const occurrence = prior.rows[0] && rowToOccurrence(prior.rows[0]);
      if (!occurrence) throw new ScheduleOccurrenceError("invalid_occurrence");
      if (occurrence.state === "cancelled") throw new ScheduleOccurrenceError("occurrence_cancelled");
      if (occurrence.state === "dispatched") return { occurrence, replayed: true };
      const delivered = await tx.query<{ id: string }>(`SELECT id FROM control_outbox WHERE tenant_id=$1 AND id=$2 AND status='delivered'`, [input.tenantId,outboxId(occurrence)]);
      if (!delivered.rows.length) throw new ScheduleOccurrenceError("outbox_not_delivered");
      const updated = await tx.query<Row>(`UPDATE control_schedule_occurrences SET state='dispatched',dispatched_at=$4 WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3 RETURNING *`, [input.tenantId,input.scheduleId,input.occurrenceKey,input.deliveredAt]);
      return { occurrence: rowToOccurrence(updated.rows[0]), replayed: false };
    });
  }

  async reconcileDelivered(input: { tenantId: string; deliveredAt: string }): Promise<number> {
    if (!safeId.test(input.tenantId) || !instant(input.deliveredAt)) throw new ScheduleOccurrenceError("invalid_occurrence");
    const result = await this.db.query<{ occurrence_key: string }>(`UPDATE control_schedule_occurrences s SET state='dispatched',dispatched_at=$2 WHERE s.tenant_id=$1 AND s.state='pending' AND EXISTS (SELECT 1 FROM control_outbox o WHERE o.tenant_id=s.tenant_id AND o.id=('outbox:schedule:' || s.tenant_id || ':' || s.schedule_id || ':' || s.occurrence_key) AND o.status='delivered') RETURNING s.occurrence_key`, [input.tenantId,input.deliveredAt]);
    return result.rows.length;
  }
}

interface Row { tenant_id: string; schedule_id: string; occurrence_key: string; target_type: StoredScheduleOccurrenceV1["targetType"]; target_id: string; definition_digest: string; scheduled_for: string | Date; local_time: string; state: StoredScheduleOccurrenceV1["state"]; created_at: string | Date; dispatched_at: string | Date | null; }
function toInstant(value: string | Date): string { return new Date(value).toISOString(); }
function rowToOccurrence(row: Row): StoredScheduleOccurrenceV1 { return { tenantId: row.tenant_id, scheduleId: row.schedule_id, occurrenceKey: row.occurrence_key, targetType: row.target_type, targetId: row.target_id, definitionDigest: row.definition_digest, scheduledFor: toInstant(row.scheduled_for), localTime: row.local_time, createdAt: toInstant(row.created_at), state: row.state, ...(row.dispatched_at ? { dispatchedAt: toInstant(row.dispatched_at) } : {}) }; }
function outboxId(input: ScheduleOccurrenceProposalV1): string { return `outbox:schedule:${input.tenantId}:${input.scheduleId}:${input.occurrenceKey}`; }
