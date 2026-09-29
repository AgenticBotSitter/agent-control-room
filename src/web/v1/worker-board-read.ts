import type { DatabaseClient } from "../../persistence/database";
import { jobRecordSchema } from "../../domain/v1/validators";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

export interface WorkerBoardTaskV1 { projectId: string; jobId: string; title: string; since: string; }
export interface WorkerBoardResultV1 { projectId: string; jobId: string; title: string; status: "succeeded" | "failed" | "cancelled" | "orphaned"; finishedAt: string; }
export interface WorkerBoardAttributionV1 {
  workerId: string;
  currentTask: WorkerBoardTaskV1 | null;
  recentResults: readonly WorkerBoardResultV1[];
}
export interface WorkerBoardReadV1 { observedAt: string; workers: readonly WorkerBoardAttributionV1[]; }

/**
 * Bounded, tenant-scoped attribution over canonical records.  Worker cards are
 * node cards, so `node_id` is the identity used for both an active attempt and
 * its terminal attempt history.  `worker_id` remains canonical attempt evidence
 * but is not used to guess a mapping to a registered node.
 */
export class DatabaseWorkerBoardReadSourceV1 {
  constructor(private readonly db: DatabaseClient) {}

  async read(input: { tenantId: string; now: string }): Promise<WorkerBoardReadV1> {
    if (!safeId.test(input.tenantId) || Number.isNaN(Date.parse(input.now))) throw new Error("invalid_worker_board_scope");
    const result = await this.db.query<{
      worker_id: string; current_project_id: string | null; current_job_id: string | null;
      current_payload: unknown | null; current_since: string | Date | null;
      result_project_id: string | null; result_job_id: string | null; result_payload: unknown | null;
      result_state: string | null; result_finished_at: string | Date | null; result_rank: number | string | null;
    }>(`WITH bounded_nodes AS (SELECT id,tenant_id FROM control_nodes WHERE tenant_id=$1 ORDER BY id LIMIT 500)
      SELECT n.id AS worker_id,
      current_job.project_id AS current_project_id,current_job.id AS current_job_id,current_job.payload AS current_payload,
      COALESCE(current_lease.acquired_at,current_attempt.started_at,current_attempt.updated_at) AS current_since,
      terminal_job.project_id AS result_project_id,terminal_job.id AS result_job_id,terminal_job.payload AS result_payload,
      terminal_attempt.state AS result_state,terminal_attempt.finished_at AS result_finished_at,terminal.result_rank
      FROM bounded_nodes n
      LEFT JOIN LATERAL (
        SELECT a.id,a.job_id,a.started_at,a.updated_at FROM control_attempts a
        WHERE a.tenant_id=n.tenant_id AND a.node_id=n.id AND a.state IN ('leased','running','waiting')
        ORDER BY CASE a.state WHEN 'running' THEN 0 WHEN 'leased' THEN 1 ELSE 2 END,a.updated_at DESC,a.id LIMIT 1
      ) current_attempt ON true
      LEFT JOIN control_jobs current_job ON current_job.tenant_id=n.tenant_id AND current_job.id=current_attempt.job_id
      LEFT JOIN control_leases current_lease ON current_lease.tenant_id=n.tenant_id AND current_lease.attempt_id=current_attempt.id
        AND current_lease.state='active' AND current_lease.expires_at>$2::timestamptz
      LEFT JOIN LATERAL (
        SELECT a.id,a.job_id,a.state,a.finished_at,row_number() OVER (ORDER BY a.finished_at DESC,a.id DESC) AS result_rank
        FROM control_attempts a WHERE a.tenant_id=n.tenant_id AND a.node_id=n.id
          AND a.state IN ('succeeded','failed','cancelled','orphaned') AND a.finished_at IS NOT NULL
        ORDER BY a.finished_at DESC,a.id DESC LIMIT 3
      ) terminal ON true
      LEFT JOIN control_attempts terminal_attempt ON terminal_attempt.tenant_id=n.tenant_id AND terminal_attempt.id=terminal.id
      LEFT JOIN control_jobs terminal_job ON terminal_job.tenant_id=n.tenant_id AND terminal_job.id=terminal.job_id
      ORDER BY n.id,terminal.result_rank`, [input.tenantId, input.now]);
    const byWorker = new Map<string, { currentTask: WorkerBoardTaskV1 | null; recentResults: WorkerBoardResultV1[] }>();
    for (const row of result.rows) {
      let worker = byWorker.get(row.worker_id);
      if (!worker) { worker = { currentTask: null, recentResults: [] }; byWorker.set(row.worker_id, worker); }
      if (row.current_job_id && row.current_project_id && row.current_payload && row.current_since && !worker.currentTask) {
        const job = jobRecordSchema.safeParse(row.current_payload);
        if (!job.success || job.data.projectId !== row.current_project_id) throw new Error("invalid_worker_board_record");
        worker.currentTask = { projectId: row.current_project_id, jobId: row.current_job_id, title: job.data.jobType,
          since: new Date(row.current_since).toISOString() };
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
      currentTask: value.currentTask, recentResults: value.recentResults.slice(0, 3) })) };
  }
}
