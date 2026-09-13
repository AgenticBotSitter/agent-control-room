import type { DatabaseSession } from "../persistence/database";
import { scheduleRecordSchema } from "../domain/v1";
import { projectScheduleStatus } from "./planning";
import { projectScheduleStatusSchema } from "./status-wire";

const iso = (value: string | Date) => new Date(value).toISOString();
/** Caller must first authorize this project in the same shared session transaction.
 * Reads existing records only; cannot create occurrences, acknowledge an outbox or dispatch. */
export async function readProjectScheduleStatus(tx: DatabaseSession,
  scope: { tenantId: string; projectId: string }, now: string) {
  const windowEndsAt = new Date(Date.parse(now) + 7 * 86400_000).toISOString();
  // Touch the occurrence source even when no schedules exist. Otherwise a missing
  // table or grant could be misreported as a truthful empty schedule catalog.
  await tx.query(`SELECT 1 FROM control_schedule_occurrences WHERE tenant_id=$1 LIMIT 1`, [scope.tenantId]);
  const rows = (await tx.query<{ id: string; tenant_id: string; project_id: string; state: string;
    version: number; created_at: string | Date; updated_at: string | Date;
    next_run_at: string | Date | null; payload: unknown }>(
    `SELECT id,tenant_id,project_id,state,version,created_at,updated_at,next_run_at,payload
     FROM control_schedules WHERE tenant_id=$1 AND project_id=$2 ORDER BY id COLLATE "C" LIMIT 11`,
    [scope.tenantId, scope.projectId])).rows;
  const schedules = [];
  for (const row of rows.slice(0, 10)) {
    const schedule = scheduleRecordSchema.parse(row.payload);
    if (row.tenant_id !== scope.tenantId || row.project_id !== scope.projectId || schedule.id !== row.id
      || schedule.tenantId !== row.tenant_id || schedule.projectId !== row.project_id || schedule.state !== row.state
      || schedule.version !== Number(row.version) || iso(schedule.createdAt) !== iso(row.created_at)
      || iso(schedule.updatedAt) !== iso(row.updated_at)
      || (schedule.nextRunAt ? iso(schedule.nextRunAt) : null) !== (row.next_run_at ? iso(row.next_run_at) : null))
      throw new Error("schedule_status_unavailable");
    const occurrences = (await tx.query<{ tenant_id: string; schedule_id: string; occurrence_key: string;
      target_type: string; target_id: string; definition_digest: string; scheduled_for: string | Date;
      local_time: string; state: string; created_at: string | Date; dispatched_at: string | Date | null }>(
      `SELECT tenant_id,schedule_id,occurrence_key,target_type,target_id,definition_digest,scheduled_for,
       local_time,state,created_at,dispatched_at FROM control_schedule_occurrences
       WHERE tenant_id=$1 AND schedule_id=$2 ORDER BY scheduled_for DESC,occurrence_key COLLATE "C" LIMIT 21`,
      [scope.tenantId, schedule.id])).rows;
    schedules.push(projectScheduleStatus({ ...scope, schedule, now, windowEndsAt,
      additionalOccurrencesOmitted: occurrences.length > 20,
      occurrences: occurrences.slice(0, 20).map(item => ({ tenantId: item.tenant_id, scheduleId: item.schedule_id,
        occurrenceKey: item.occurrence_key, targetType: item.target_type, targetId: item.target_id,
        definitionDigest: item.definition_digest, scheduledFor: iso(item.scheduled_for), localTime: item.local_time,
        state: item.state, createdAt: iso(item.created_at), dispatchedAt: item.dispatched_at ? iso(item.dispatched_at) : null })) }));
  }
  return projectScheduleStatusSchema.parse({ projectId: scope.projectId, observedAt: now, windowEndsAt,
    schedules, additionalSchedulesOmitted: rows.length > 10, automaticExecutionEnabled: false });
}
