import type { DatabaseClient } from "../../persistence/database";
import { jobRecordSchema } from "../../domain/v1/validators";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

export interface WorkerBoardTaskV1 { projectId: string; jobId: string; title: string; since: string; }
/** An assignment that was recorded and whose lease is no longer live. Reported
 * as itself, never as the worker's current task (R7-03): the owner sees that the
 * work was assigned and that nothing holds it now, instead of being told a bot
 * is working on it. */
export interface WorkerBoardDeadAssignmentV1 { projectId: string; jobId: string; title: string; since: string; }
export interface WorkerBoardResultV1 { projectId: string; jobId: string; title: string; status: "succeeded" | "failed" | "cancelled" | "orphaned"; finishedAt: string; }
export interface WorkerBoardAttributionV1 {
  workerId: string;
  currentTask: WorkerBoardTaskV1 | null;
  deadAssignment: WorkerBoardDeadAssignmentV1 | null;
  recentResults: readonly WorkerBoardResultV1[];
}
export interface WorkerBoardReadV1 { observedAt: string; workers: readonly WorkerBoardAttributionV1[]; }

/**
 * Bounded, tenant-scoped attribution over canonical records.  The registered
 * fleet list itself (identity, platform, self-reported state) is a separate
 * read over `src/operator-surfaces/v1`, served through `/api/v1/operator-surface`
 * under its own role — never `control_room_private_web`, which has no SELECT on
 * `control_nodes`.  This read exists only to overlay a worker's current task and
 * recent results onto that list, keyed by `node_id`, so it sources the worker
 * set from `control_attempts` (which the private web role can read) instead of
 * `control_nodes`.  A node with no recorded attempt has no attribution row here,
 * which the caller already treats identically to an absent one: no current
 * task, no recent results, both reported unknown rather than idle or empty.
 */
export class DatabaseWorkerBoardReadSourceV1 {
  constructor(private readonly db: DatabaseClient) {}

  async read(input: { tenantId: string; now: string }): Promise<WorkerBoardReadV1> {
    if (!safeId.test(input.tenantId) || Number.isNaN(Date.parse(input.now))) throw new Error("invalid_worker_board_scope");
    const result = await this.db.query<{
      worker_id: string; current_project_id: string | null; current_job_id: string | null;
      current_payload: unknown | null; current_since: string | Date | null;
      dead_project_id: string | null; dead_job_id: string | null; dead_payload: unknown | null; dead_since: string | Date | null;
      result_project_id: string | null; result_job_id: string | null; result_payload: unknown | null;
      result_state: string | null; result_finished_at: string | Date | null; result_rank: number | string | null;
    }>(`WITH bounded_workers AS (
        SELECT DISTINCT node_id FROM control_attempts WHERE tenant_id=$1 AND node_id IS NOT NULL
        ORDER BY node_id LIMIT 500
      )
      SELECT w.node_id AS worker_id,
      current_job.project_id AS current_project_id,current_job.id AS current_job_id,current_job.payload AS current_payload,
      -- A live assignment is a LEASE, not an attempt row in a non-terminal
      -- state. Reaping is the coordinator's job and lags a dead worker, so an
      -- attempt can sit in 'leased'/'running'/'waiting' for hours after its
      -- lease expired: reading that as the worker's current task told the owner
      -- a bot was working on it when nothing held the work (R7-03).
      --
      -- ONE mechanism, inside the lateral that CHOOSES the attempt: a live lease
      -- is part of the join that picks the row, using the same
      -- (state='active' AND expires_at>$2) the coordinator itself uses to decide
      -- what is live. An earlier version also re-checked the lease in a separate
      -- outer join and let the NULL acquired_at suppress the row. That was a
      -- second safety net for the same question, and it HID the bug rather than
      -- fixing it: with the inner condition removed, a dead 'running' attempt
      -- still outranked a live 'leased' one and the current task silently
      -- vanished instead of falling back to the dead assignment. 'since' is the
      -- lease's own acquired_at for the same reason -- it can no longer fall back
      -- to the attempt's creation time and read as when the work started.
      current_attempt.acquired_at AS current_since,
      dead_job.project_id AS dead_project_id,dead_job.id AS dead_job_id,dead_job.payload AS dead_payload,
      COALESCE(dead_attempt.started_at,dead_attempt.updated_at) AS dead_since,
      terminal_job.project_id AS result_project_id,terminal_job.id AS result_job_id,terminal_job.payload AS result_payload,
      terminal.state AS result_state,terminal.finished_at AS result_finished_at,terminal.result_rank
      FROM bounded_workers w
      LEFT JOIN LATERAL (
        SELECT a.id,a.job_id,l.acquired_at FROM control_attempts a
        JOIN control_leases l ON l.tenant_id=a.tenant_id AND l.attempt_id=a.id
          AND l.state='active' AND l.expires_at>$2::timestamptz
        WHERE a.tenant_id=$1 AND a.node_id=w.node_id AND a.state IN ('leased','running','waiting')
        ORDER BY CASE a.state WHEN 'running' THEN 0 WHEN 'leased' THEN 1 ELSE 2 END,l.acquired_at DESC,a.id LIMIT 1
      ) current_attempt ON true
      LEFT JOIN control_jobs current_job ON current_job.tenant_id=$1 AND current_job.id=current_attempt.job_id
      -- A recorded assignment whose lease is GONE is reported as exactly that,
      -- once, and never as current work. The owner can then see the assignment
      -- exists and that nothing holds it now, rather than being told nothing is
      -- recorded at all (which is what dropping it entirely would say). This is
      -- the same question answered for a different row, not a second net over
      -- the first: the two are exact complements of "has a live lease".
      LEFT JOIN LATERAL (
        SELECT a.id,a.job_id,a.created_at AS started_at,a.updated_at FROM control_attempts a
        WHERE a.tenant_id=$1 AND a.node_id=w.node_id AND a.state IN ('leased','running','waiting')
          AND NOT EXISTS (SELECT 1 FROM control_leases l WHERE l.tenant_id=a.tenant_id AND l.attempt_id=a.id
            AND l.state='active' AND l.expires_at>$2::timestamptz)
        ORDER BY a.updated_at DESC,a.id LIMIT 1
      ) dead_attempt ON true
      LEFT JOIN control_jobs dead_job ON dead_job.tenant_id=$1 AND dead_job.id=dead_attempt.job_id
      LEFT JOIN LATERAL (
        SELECT a.id,a.job_id,a.state,a.updated_at AS finished_at,row_number() OVER (ORDER BY a.updated_at DESC,a.id DESC) AS result_rank
        FROM control_attempts a WHERE a.tenant_id=$1 AND a.node_id=w.node_id
          AND a.state IN ('succeeded','failed','cancelled','orphaned') AND a.updated_at IS NOT NULL
        ORDER BY a.updated_at DESC,a.id DESC LIMIT 3
      ) terminal ON true
      LEFT JOIN control_jobs terminal_job ON terminal_job.tenant_id=$1 AND terminal_job.id=terminal.job_id
      ORDER BY w.node_id,terminal.result_rank`, [input.tenantId, input.now]);
    const byWorker = new Map<string, { currentTask: WorkerBoardTaskV1 | null; deadAssignment: WorkerBoardDeadAssignmentV1 | null; recentResults: WorkerBoardResultV1[] }>();
    for (const row of result.rows) {
      let worker = byWorker.get(row.worker_id);
      if (!worker) { worker = { currentTask: null, deadAssignment: null, recentResults: [] }; byWorker.set(row.worker_id, worker); }
      if (row.current_job_id && row.current_project_id && row.current_payload && row.current_since && !worker.currentTask) {
        const job = jobRecordSchema.safeParse(row.current_payload);
        if (!job.success || job.data.projectId !== row.current_project_id) throw new Error("invalid_worker_board_record");
        worker.currentTask = { projectId: row.current_project_id, jobId: row.current_job_id, title: job.data.jobType,
          since: new Date(row.current_since).toISOString() };
      }
      if (row.dead_job_id && row.dead_project_id && row.dead_payload && row.dead_since && !worker.deadAssignment && !worker.currentTask) {
        const job = jobRecordSchema.safeParse(row.dead_payload);
        if (!job.success || job.data.projectId !== row.dead_project_id) throw new Error("invalid_worker_board_record");
        worker.deadAssignment = { projectId: row.dead_project_id, jobId: row.dead_job_id, title: job.data.jobType,
          since: new Date(row.dead_since).toISOString() };
      }
      if (row.result_job_id && row.result_project_id && row.result_payload && row.result_state && row.result_finished_at) {
        const job = jobRecordSchema.safeParse(row.result_payload);
        if (!job.success || job.data.projectId !== row.result_project_id
          || !["succeeded", "failed", "cancelled", "orphaned"].includes(row.result_state)) throw new Error("invalid_worker_board_record");
        worker.recentResults.push({ projectId: row.result_project_id, jobId: row.result_job_id, title: job.data.jobType,
          status: row.result_state as WorkerBoardResultV1["status"], finishedAt: new Date(row.result_finished_at).toISOString() });
      }
    }
    return { observedAt: input.now, workers: [...byWorker.entries()].map(([workerId, value]) => ({ workerId,
      currentTask: value.currentTask, deadAssignment: value.deadAssignment, recentResults: value.recentResults.slice(0, 3) })) };
  }
}
