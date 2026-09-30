import type { DatabaseClient } from "../../persistence/database";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
const WORKER_KINDS = ["codex", "claude-code", "hermes"] as const;
type Effort = (typeof EFFORTS)[number];
type WorkerKind = (typeof WORKER_KINDS)[number];

export interface WorkerScorecardCatcherV1 { label: string; count: number }
export interface WorkerScorecardWindowV1 {
  finished: number;
  passedFirstTime: number;
  neededFixes: number;
  failedOrBlocked: number;
  caughtBy: WorkerScorecardCatcherV1[];
}
export interface WorkerScorecardGroupV1 {
  workerKind: WorkerKind;
  model: string;
  effort: Effort;
  provider: string | null;
  profile: string | null;
  last7Days: WorkerScorecardWindowV1;
  last30Days: WorkerScorecardWindowV1;
}
export interface WorkerScorecardReadV1 { observedAt: string; groups: readonly WorkerScorecardGroupV1[] }

/** "Who caught it" reviewer labels are derived only from the reviewer principal
 * already carried on the completion-gate review record — never guessed from a
 * worker's own kind. An agent reviewer with no recorded harness, or a service
 * actor, still gets a plain label rather than being folded into "Owner". */
function catcherLabel(reviewer: { actorType?: unknown; harness?: unknown } | null): string {
  if (!reviewer || typeof reviewer !== "object") return "Not recorded";
  if (reviewer.actorType === "human") return "Owner";
  if (reviewer.actorType === "agent") {
    const harness = typeof reviewer.harness === "string" ? reviewer.harness : undefined;
    const label = harness === "codex" ? "Codex" : harness === "claude" ? "Claude" : harness === "hermes" ? "Hermes" : "Agent";
    return `${label} checker`;
  }
  if (reviewer.actorType === "service") return "Automated check";
  return "Not recorded";
}

type Row = {
  worker_kind: string; model: string; effort: string; provider: string | null; profile: string | null;
  state: string; finished_at: string | Date;
  revision_number: string | number | null;
  catcher_reviewer: unknown;
};

function windowBucket(): WorkerScorecardWindowV1 { return { finished: 0, passedFirstTime: 0, neededFixes: 0, failedOrBlocked: 0, caughtBy: [] }; }

/**
 * Read-only worker/model scorecard derived entirely from existing canonical
 * records: `pipeline_stage_runs` (worker attribution) and
 * `control_completion_gate_records` (pass/revise/reviewer evidence). Neither
 * table is written here, and no new grant is required — both are already
 * readable by `control_room_private_web`.
 *
 * Scoped to `stage_kind='build', role='builder'` rows: the completion-gate
 * revision lineage (`revisionNumber`, `rootTargetId`) is defined for build-stage
 * output under review, not for a checker or sign-off stage's own completion. A
 * check/sign-off stage's own throughput is not yet in this first slice.
 */
export class DatabaseWorkerScorecardReadSourceV1 {
  constructor(private readonly db: DatabaseClient) {}

  async read(input: { tenantId: string; now: string }): Promise<WorkerScorecardReadV1> {
    if (!safeId.test(input.tenantId) || Number.isNaN(Date.parse(input.now))) throw new Error("invalid_worker_scorecard_scope");
    const now = new Date(input.now);
    const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).getTime();
    const result = await this.db.query<Row>(`WITH bounded_stage_runs AS (
        SELECT worker_kind,model,effort,provider,profile,state,current_job_id,finished_at
        FROM pipeline_stage_runs
        WHERE tenant_id=$1 AND stage_kind='build' AND role='builder'
          AND state IN ('succeeded','failed','cancelled','uncertain') AND finished_at>=$2::timestamptz
        ORDER BY finished_at DESC LIMIT 2000
      )
      SELECT s.worker_kind,s.model,s.effort,s.provider,s.profile,s.state,s.finished_at,
        target.payload->>'revisionNumber' AS revision_number,
        catcher.reviewer AS catcher_reviewer
      FROM bounded_stage_runs s
      LEFT JOIN control_completion_gate_records target
        ON target.tenant_id=$1 AND target.kind='target' AND target.subject_id=s.current_job_id
      LEFT JOIN LATERAL (
        SELECT rev.payload->'reviewer' AS reviewer
        FROM control_completion_gate_records prior_target
        JOIN control_completion_gate_records rev
          ON rev.tenant_id=$1 AND rev.kind='review' AND rev.payload->>'targetId'=prior_target.id
          AND rev.payload->>'decision'='changes_requested'
        WHERE prior_target.tenant_id=$1 AND prior_target.kind='target'
          AND prior_target.payload->>'rootTargetId'=target.payload->>'rootTargetId'
          AND (target.payload->>'revisionNumber')::int>0
        ORDER BY (prior_target.payload->>'revisionNumber')::int DESC LIMIT 1
      ) catcher ON true
      ORDER BY s.finished_at DESC`, [input.tenantId, windowStart]);
    const groups = new Map<string, WorkerScorecardGroupV1>();
    const catcherCounts = new Map<string, Map<string, number>>();
    for (const row of result.rows) {
      if (!WORKER_KINDS.includes(row.worker_kind as WorkerKind) || !EFFORTS.includes(row.effort as Effort)) throw new Error("invalid_worker_scorecard_record");
      const key = JSON.stringify([row.worker_kind, row.model, row.effort, row.provider, row.profile]);
      let group = groups.get(key);
      if (!group) {
        group = { workerKind: row.worker_kind as WorkerKind, model: row.model, effort: row.effort as Effort,
          provider: row.provider, profile: row.profile, last7Days: windowBucket(), last30Days: windowBucket() };
        groups.set(key, group);
        catcherCounts.set(`${key}:7`, new Map()); catcherCounts.set(`${key}:30`, new Map());
      }
      const finishedAt = new Date(row.finished_at).getTime();
      const windows: { bucket: WorkerScorecardWindowV1; suffix: string }[] = [{ bucket: group.last30Days, suffix: "30" }];
      if (finishedAt >= sevenDaysAgo) windows.push({ bucket: group.last7Days, suffix: "7" });
      const revisionNumber = row.revision_number === null ? null : Number(row.revision_number);
      for (const { bucket, suffix } of windows) {
        bucket.finished += 1;
        if (row.state === "succeeded" && revisionNumber === 0) bucket.passedFirstTime += 1;
        else if (row.state === "succeeded" && revisionNumber !== null && revisionNumber > 0) {
          bucket.neededFixes += 1;
          const label = catcherLabel(row.catcher_reviewer as never);
          const counts = catcherCounts.get(`${key}:${suffix}`)!;
          counts.set(label, (counts.get(label) ?? 0) + 1);
        } else if (row.state !== "succeeded") bucket.failedOrBlocked += 1;
      }
    }
    for (const [key, group] of groups) {
      for (const [suffix, bucket] of [["7", group.last7Days], ["30", group.last30Days]] as const) {
        const counts = catcherCounts.get(`${key}:${suffix}`)!;
        bucket.caughtBy = [...counts.entries()]
          .map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      }
    }
    return { observedAt: input.now, groups: [...groups.values()].sort((a, b) =>
      a.workerKind.localeCompare(b.workerKind) || a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort)) };
  }
}
