import type { DatabaseClient } from "../../persistence/database";
import {
  ScheduledTaskDispatchErrorV1,
  ScheduledTaskDispatchServiceV1,
  type ScheduledTaskDispatchOutcomeV1,
  type ScheduledTaskDispatchRefusalV1,
} from "./scheduled-task-dispatch";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

/**
 * Restart reconciliation for the occurrence-to-canonical-task dispatch path.
 *
 * A process can die after an occurrence's outbox row was delivered but before admission
 * committed. On restart this reconciles exactly that window: delivered-but-unadmitted
 * occurrences are re-driven through the ordinary dispatch path, which keeps admission as
 * the single authority and returns `replayed` for anything already admitted.
 *
 * Canonical admission verifies and acknowledges each recovered occurrence. A dispatched
 * occurrence lacking an admission is reported, not repaired. Callers must follow the
 * keyset cursor to scan past settled or refused history, then start a fresh scan later.
 */
export interface ScheduledTaskRecoveryCursorV1 { scheduledFor: string; occurrenceKey: string; }

export interface ScheduledTaskRecoveryReportV1 {
  contractVersion: "control-room-scheduled-task-recovery/v1";
  tenantId: string;
  scanned: number;
  nextCursor?: ScheduledTaskRecoveryCursorV1;
  recovered: ScheduledTaskDispatchOutcomeV1[];
  refused: Array<{ occurrenceKey: string; safeCode: ScheduledTaskDispatchRefusalV1 }>;
  awaitingDelivery: string[];
  settled: string[];
  orphaned: string[];
}

interface ReconRow { scheduled_for: string | Date; occurrence_key: string; state: "pending" | "dispatched" | "cancelled"; delivered_outbox: number; admissions: number; }

export class ScheduledTaskRecoveryServiceV1 {
  readonly #dispatch: ScheduledTaskDispatchServiceV1;

  constructor(private readonly db: DatabaseClient, now: () => number) {
    this.#dispatch = new ScheduledTaskDispatchServiceV1(db, now);
  }

  async reconcileOnRestart(value: { tenantId: string; scheduleId: string; limit?: number; after?: ScheduledTaskRecoveryCursorV1 }): Promise<ScheduledTaskRecoveryReportV1> {
    if (!SAFE_ID.test(value.tenantId) || !SAFE_ID.test(value.scheduleId)) {
      throw new ScheduledTaskDispatchErrorV1("invalid_dispatch");
    }
    const limit = value.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200
      || (value.after && (!SAFE_ID.test(value.after.occurrenceKey)
        || !Number.isFinite(Date.parse(value.after.scheduledFor))))) {
      throw new ScheduledTaskDispatchErrorV1("invalid_dispatch");
    }
    const rows = (await this.db.query<ReconRow>(
      `SELECT o.occurrence_key, o.state, o.scheduled_for,
          (SELECT count(*)::int FROM control_outbox x
             WHERE x.tenant_id=o.tenant_id AND x.topic='schedule.occurrence.created'
               AND x.aggregate_type='schedule_occurrence' AND x.aggregate_id=o.occurrence_key
               AND x.status='delivered') AS delivered_outbox,
          (SELECT count(*)::int FROM control_scheduled_task_admissions a
             WHERE a.tenant_id=o.tenant_id AND a.schedule_id=o.schedule_id
               AND a.occurrence_key=o.occurrence_key) AS admissions
         FROM control_schedule_occurrences o
        WHERE o.tenant_id=$1 AND o.schedule_id=$2
          AND ($4::timestamptz IS NULL OR (o.scheduled_for,o.occurrence_key) > ($4::timestamptz,$5::text))
        ORDER BY o.scheduled_for ASC, o.occurrence_key ASC LIMIT $3`,
      [value.tenantId, value.scheduleId, limit, value.after?.scheduledFor ?? null, value.after?.occurrenceKey ?? null],
    )).rows;

    const report: ScheduledTaskRecoveryReportV1 = {
      contractVersion: "control-room-scheduled-task-recovery/v1",
      tenantId: value.tenantId,
      scanned: rows.length,
      ...(rows.length === limit ? { nextCursor: {
        scheduledFor: new Date(rows[rows.length - 1].scheduled_for).toISOString(),
        occurrenceKey: rows[rows.length - 1].occurrence_key,
      } } : {}),
      recovered: [], refused: [], awaitingDelivery: [], settled: [], orphaned: [],
    };

    for (const row of rows) {
      if (row.state === "dispatched") {
        // A dispatched occurrence without an admission is a contradiction, not a job to redo.
        if (row.admissions === 0) report.orphaned.push(row.occurrence_key);
        else report.settled.push(row.occurrence_key);
        continue;
      }
      if (row.state === "cancelled") { report.settled.push(row.occurrence_key); continue; }
      if (row.delivered_outbox === 0) { report.awaitingDelivery.push(row.occurrence_key); continue; }
      try {
        report.recovered.push(await this.#dispatch.dispatchOne({
          tenantId: value.tenantId, scheduleId: value.scheduleId, occurrenceKey: row.occurrence_key,
        }));
      } catch (error) {
        if (error instanceof ScheduledTaskDispatchErrorV1) report.refused.push({ occurrenceKey: row.occurrence_key, safeCode: error.safeCode });
        else throw error;
      }
    }
    return report;
  }
}