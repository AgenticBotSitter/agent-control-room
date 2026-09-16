import {
  jobRecordSchema,
  requestRecordSchema,
  scheduleRecordSchema,
  workflowRecordSchema,
  type ScheduleRecord,
} from "../../domain/v1";
import type { ProposedWorkBundle } from "../../persistence/canonical-store";
import type { DatabaseClient } from "../../persistence/database";
import { sha256Digest } from "../../security";
import {
  EMPTY_SCHEDULE_REUSABLE_CONTEXT_BINDING_DIGEST_V1,
  ScheduledTaskAdmissionError,
  ScheduledTaskAdmissionServiceV1,
  computeScheduledTaskDefinitionDigestV1,
  computeScheduledTaskSourceBundleDigestV1,
  type ScheduledReusableContextV1,
  type ScheduledTaskAdmissionInputV1,
  type ScheduledTaskAdmissionReceiptV1,
} from "./scheduled-task-admission";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

/**
 * Automatic occurrence-to-canonical-task dispatch.
 *
 * This service derives the canonical admission input from a materialised occurrence and
 * delegates to `ScheduledTaskAdmissionServiceV1.admit`. It is not a scheduler: recurrence
 * stays with `calculateScheduleOccurrencesV1`, the durable record stays with
 * `ScheduleOccurrenceStore`, and admission stays the only authority that creates work.
 * Dispatch adds no execution authority — an admitted occurrence still starts no work.
 */
export type ScheduledTaskDispatchRefusalV1 =
  | "invalid_dispatch"
  | "occurrence_unknown"
  | "occurrence_not_due"
  | "occurrence_cancelled"
  | "occurrence_conflict"
  | "definition_changed"
  | "schedule_not_active"
  | "target_not_admissible"
  | "source_unavailable"
  | "recovery_window_expired"
  | "outbox_not_delivered"
  | "admission_refused";

export class ScheduledTaskDispatchErrorV1 extends Error {
  constructor(readonly safeCode: ScheduledTaskDispatchRefusalV1) { super(safeCode); }
}

export interface ScheduledTaskDispatchRequestV1 {
  tenantId: string;
  scheduleId: string;
  occurrenceKey: string;
  reusableContexts?: ScheduledReusableContextV1[];
}

export interface ScheduledTaskDispatchOutcomeV1 {
  contractVersion: "control-room-scheduled-task-dispatch/v1";
  tenantId: string;
  scheduleId: string;
  occurrenceKey: string;
  occurrenceScheduledFor: string;
  state: "dispatched";
  replayed: boolean;
  receipt: ScheduledTaskAdmissionReceiptV1;
}

export interface ScheduledTaskDispatchBatchV1 {
  contractVersion: "control-room-scheduled-task-dispatch-batch/v1";
  tenantId: string;
  dispatched: ScheduledTaskDispatchOutcomeV1[];
  refused: Array<{ occurrenceKey: string; safeCode: ScheduledTaskDispatchRefusalV1 }>;
}

interface ScheduleRow { project_id: string; state: string; payload: unknown; }
interface OccurrenceRow {
  tenant_id: string; schedule_id: string; occurrence_key: string; target_type: string;
  target_id: string; definition_digest: string; scheduled_for: string | Date;
  state: "pending" | "dispatched" | "cancelled";
}

function refuse(safeCode: ScheduledTaskDispatchRefusalV1): ScheduledTaskDispatchErrorV1 {
  return new ScheduledTaskDispatchErrorV1(safeCode);
}

function instant(value: string | Date): string { return new Date(value).toISOString(); }

function validRequest(value: ScheduledTaskDispatchRequestV1): boolean {
  return SAFE_ID.test(value.tenantId) && SAFE_ID.test(value.scheduleId) && SAFE_ID.test(value.occurrenceKey);
}

/** Maps an admission refusal onto the dispatch vocabulary so callers see one refusal surface. */
function mapAdmissionCode(code: ScheduledTaskAdmissionError["safeCode"]): ScheduledTaskDispatchRefusalV1 {
  switch (code) {
    case "recovery_window_expired": return "recovery_window_expired";
    case "occurrence_conflict": return "occurrence_conflict";
    case "occurrence_cancelled": return "occurrence_cancelled";
    case "outbox_not_delivered": return "outbox_not_delivered";
    case "schedule_not_active": return "schedule_not_active";
    default: return "admission_refused";
  }
}

export class ScheduledTaskDispatchServiceV1 {
  readonly #admissions: ScheduledTaskAdmissionServiceV1;

  constructor(private readonly db: DatabaseClient, private readonly now: () => number) {
    this.#admissions = new ScheduledTaskAdmissionServiceV1(db, now);
  }

  /**
   * Drives one pending occurrence to canonical admission.
   *
   * Refusals are returned before admission is attempted and are never repaired silently:
   * a stale occurrence whose schedule definition moved on refuses as `definition_changed`
   * rather than being re-materialised or admitted against the new definition.
   */
  async dispatchOne(value: ScheduledTaskDispatchRequestV1): Promise<ScheduledTaskDispatchOutcomeV1> {
    if (!validRequest(value)) throw refuse("invalid_dispatch");
    const { tenantId, scheduleId, occurrenceKey } = value;

    const scheduleRow = (await this.db.query<ScheduleRow>(
      "SELECT project_id,state,payload FROM control_schedules WHERE tenant_id=$1 AND id=$2",
      [tenantId, scheduleId],
    )).rows[0];
    if (!scheduleRow) throw refuse("occurrence_unknown");
    let schedule: ScheduleRecord;
    try { schedule = scheduleRecordSchema.parse(scheduleRow.payload) as ScheduleRecord; }
    catch { throw refuse("occurrence_unknown"); }

    const occurrence = (await this.db.query<OccurrenceRow>(
      "SELECT * FROM control_schedule_occurrences WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3",
      [tenantId, scheduleId, occurrenceKey],
    )).rows[0];
    if (!occurrence) throw refuse("occurrence_unknown");
    if (occurrence.state === "cancelled") throw refuse("occurrence_cancelled");
    if (occurrence.state === "dispatched") {
      const prior = await this.db.query<{ occurrence_key: string }>(
        "SELECT occurrence_key FROM control_scheduled_task_admissions WHERE tenant_id=$1 AND schedule_id=$2 AND occurrence_key=$3",
        [tenantId, scheduleId, occurrenceKey],
      );
      if (!prior.rows[0]) throw refuse("occurrence_conflict");
    }
    const now = this.now();
    if (!Number.isFinite(now)) throw refuse("invalid_dispatch");
    if (Date.parse(instant(occurrence.scheduled_for)) > now) throw refuse("occurrence_not_due");
    if (occurrence.target_type !== "job" || schedule.targetType !== "job") throw refuse("target_not_admissible");
    if (schedule.state !== "active") throw refuse("schedule_not_active");

    // Stable occurrence identity: the recorded definition digest is the authority. If the
    // schedule now digests differently the occurrence is stale and must not be dispatched.
    const definitionDigest = computeScheduledTaskDefinitionDigestV1(schedule);
    if (definitionDigest !== occurrence.definition_digest) throw refuse("definition_changed");
    if (schedule.projectId !== scheduleRow.project_id) throw refuse("occurrence_conflict");

    const project = (await this.db.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM projects WHERE tenant_id=$1 AND id=$2",
      [tenantId, schedule.projectId],
    )).rows[0];
    if (!project) throw refuse("source_unavailable");

    const jobPayload = (await this.db.query<{ payload: unknown }>(
      "SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2", [tenantId, occurrence.target_id],
    )).rows[0]?.payload;
    let job; let workflow; let request;
    try { job = jobRecordSchema.parse(jobPayload); } catch { throw refuse("source_unavailable"); }
    const workflowPayload = (await this.db.query<{ payload: unknown }>(
      "SELECT payload FROM control_workflows WHERE tenant_id=$1 AND id=$2", [tenantId, job.workflowId],
    )).rows[0]?.payload;
    try { workflow = workflowRecordSchema.parse(workflowPayload); } catch { throw refuse("source_unavailable"); }
    const requestPayload = (await this.db.query<{ payload: unknown }>(
      "SELECT payload FROM control_requests WHERE tenant_id=$1 AND id=$2", [tenantId, workflow.requestId],
    )).rows[0]?.payload;
    if (!requestPayload) throw refuse("source_unavailable");
    try { request = requestRecordSchema.parse(requestPayload); } catch { throw refuse("source_unavailable"); }

    const bundle = { request, workflow, job } as unknown as ProposedWorkBundle;
    const reusableContexts = value.reusableContexts ?? [];
    const input: ScheduledTaskAdmissionInputV1 = {
      tenantId,
      workspaceId: project.workspace_id,
      projectId: schedule.projectId,
      scheduleId,
      occurrenceKey,
      scheduleDefinitionDigest: occurrence.definition_digest,
      source: { requestId: workflow.requestId, workflowId: workflow.id, jobId: job.id,
        bundleDigest: computeScheduledTaskSourceBundleDigestV1(bundle) },
      contextBinding: {
        reusableContexts,
        bindingDigest: reusableContexts.length
          ? sha256Digest({ contractVersion: "control-room-scheduled-context-binding/v1", reusableContexts })
          : EMPTY_SCHEDULE_REUSABLE_CONTEXT_BINDING_DIGEST_V1,
      },
    };

    let receipt: ScheduledTaskAdmissionReceiptV1; let replayed: boolean;
    try { ({ receipt, replayed } = await this.#admissions.admit(input)); }
    catch (error) {
      if (error instanceof ScheduledTaskAdmissionError) throw refuse(mapAdmissionCode(error.safeCode));
      throw error;
    }
    return {
      contractVersion: "control-room-scheduled-task-dispatch/v1",
      tenantId, scheduleId, occurrenceKey,
      occurrenceScheduledFor: instant(occurrence.scheduled_for),
      state: "dispatched",
      replayed,
      receipt,
    };
  }

  /**
   * Dispatches every pending occurrence for one schedule in scheduled-for order.
   * A refused occurrence is reported and skipped; it never aborts the rest of the batch.
   */
  async dispatchDue(value: { tenantId: string; scheduleId: string; limit?: number }): Promise<ScheduledTaskDispatchBatchV1> {
    if (!SAFE_ID.test(value.tenantId) || !SAFE_ID.test(value.scheduleId)) throw refuse("invalid_dispatch");
    const limit = value.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw refuse("invalid_dispatch");
    const now = this.now();
    if (!Number.isFinite(now)) throw refuse("invalid_dispatch");
    const pending = (await this.db.query<{ occurrence_key: string }>(
      `SELECT occurrence_key FROM control_schedule_occurrences
        WHERE tenant_id=$1 AND schedule_id=$2 AND state='pending' AND scheduled_for <= $4::timestamptz
        ORDER BY scheduled_for ASC, occurrence_key ASC LIMIT $3`,
      [value.tenantId, value.scheduleId, limit, new Date(now).toISOString()],
    )).rows;
    const dispatched: ScheduledTaskDispatchOutcomeV1[] = [];
    const refused: Array<{ occurrenceKey: string; safeCode: ScheduledTaskDispatchRefusalV1 }> = [];
    for (const row of pending) {
      try {
        dispatched.push(await this.dispatchOne({
          tenantId: value.tenantId, scheduleId: value.scheduleId, occurrenceKey: row.occurrence_key,
        }));
      } catch (error) {
        if (error instanceof ScheduledTaskDispatchErrorV1) refused.push({ occurrenceKey: row.occurrence_key, safeCode: error.safeCode });
        else throw error;
      }
    }
    return { contractVersion: "control-room-scheduled-task-dispatch-batch/v1", tenantId: value.tenantId, dispatched, refused };
  }
}