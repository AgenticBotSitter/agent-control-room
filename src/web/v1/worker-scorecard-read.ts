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
  unknownReview: number;
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
export interface WorkerScorecardReadV1 { observedAt: string; groups: readonly WorkerScorecardGroupV1[]; olderGroupsOmitted: number }

/** "Who caught it" reviewer labels are derived only from the reviewer principal
 * already carried on the completion-gate review record — never guessed from a
 * worker's own kind. An agent reviewer with no recorded harness, or a service
 * actor, still gets a plain label rather than being folded into "Owner". */
function catcherLabel(actorType: string | null, harness: string | null): string {
  if (actorType === null) return "Not recorded";
  if (actorType === "human") return "Owner";
  if (actorType === "agent") {
    const label = harness === "codex" ? "Codex" : harness === "claude" ? "Claude" : harness === "hermes" ? "Hermes" : "Agent";
    return `${label} checker`;
  }
  if (actorType === "service") return "Automated check";
  return "Not recorded";
}

/** One already-grouped row per worker/model/effort/provider/profile. Counts are
 * `bigint` in PostgreSQL, so the driver hands them over as decimal strings; the
 * browser wire is a plain JSON integer, so each one is checked rather than
 * coerced through `Number`. */
type GroupedRow = {
  worker_kind: string; model: string; effort: string; provider: string | null; profile: string | null;
  finished_30: string; passed_first_time_30: string; needed_fixes_30: string; failed_or_blocked_30: string;
  unknown_review_30: string;
  finished_7: string; passed_first_time_7: string; needed_fixes_7: string; failed_or_blocked_7: string;
  unknown_review_7: string;
  catcher_pairs_7: Record<string, string> | null; catcher_pairs_30: Record<string, string> | null;
};

/** A count is a non-negative integer, and the wire carries it as one. */
function countValue(value: string): number {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new Error("invalid_worker_scorecard_record");
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error("invalid_worker_scorecard_record");
  return count;
}

/** `{ "human/none": "2", "agent/claude": "1" }` becomes the owner's familiar
 * "Owner (2), Claude checker (1)" list, ordered by count then label. */
function labelCounts(pairs: Record<string, string> | null): WorkerScorecardCatcherV1[] {
  if (!pairs) return [];
  const counts = new Map<string, number>();
  for (const [pair, raw] of Object.entries(pairs)) {
    const separator = pair.indexOf("/");
    const label = catcherLabel(separator < 0 ? null : pair.slice(0, separator),
      separator < 0 ? null : pair.slice(separator + 1));
    counts.set(label, (counts.get(label) ?? 0) + countValue(raw));
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function windowBucket(): WorkerScorecardWindowV1 { return { finished: 0, passedFirstTime: 0, neededFixes: 0, failedOrBlocked: 0, unknownReview: 0, caughtBy: [] }; }

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

  async read(input: { tenantId: string; workspaceId: string; now: string }): Promise<WorkerScorecardReadV1> {
    if (!safeId.test(input.tenantId) || !safeId.test(input.workspaceId) || Number.isNaN(Date.parse(input.now)))
      throw new Error("invalid_worker_scorecard_scope");
    const now = new Date(input.now);
    const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // The counts are GROUPED IN SQL, over the whole window, rather than read row
    // by row under a row cap. A row cap is not a smaller number: with one
    // LIMIT over the input, a busy model pushes an older model's entire
    // history out of the query, so the board silently reported a smaller fleet
    // and a biased pass count with nothing to say so. Grouping returns one row
    // per worker/model/effort/provider/profile instead, which is bounded by the
    // shape of the fleet rather than by its throughput.
    //
    // The window is closed on BOTH sides. `finished_at >= windowStart` alone
    // also admitted a stage finished in the future, which counted towards
    // "last 7/30 days" whenever the clock disagreed with a recorded finish. The
    // upper bound is the observation instant this read already captured, so the
    // same instant always describes the same window.
    //
    // Reviewer LABELS stay in this module. SQL counts each distinct
    // (actorType, harness) pair per group and this code maps each pair to its
    // label exactly once, so the wording and its "Not recorded" fallback cannot
    // drift into a second copy written in SQL.
    //
    // WORKSPACE SCOPE. Every row is reached through `projects.workspace_id`, so
    // a workspace's scorecard can only ever contain that workspace's own build
    // stages. The scope is enforced in SQL rather than by the caller filtering a
    // returned view: a read that is handed another workspace's groups and then
    // filters them has already held them. `projects` is readable by the same web
    // role and adds no grant.
    const result = await this.db.query<GroupedRow>(`WITH scoped_stage_runs AS (
        SELECT s.worker_kind,s.model,s.effort,s.provider,s.profile,s.state,s.current_job_id,s.project_id,s.finished_at
        FROM pipeline_stage_runs s
        JOIN projects p ON p.tenant_id=s.tenant_id AND p.id=s.project_id AND p.workspace_id=$5
        WHERE s.tenant_id=$1 AND s.stage_kind='build' AND s.role='builder'
          -- A stage the OWNER cancelled is not the bot's outcome. Admitting it
          -- here and counting every non-succeeded state as "failed or blocked"
          -- (R7-04) made cancelling work lower the bot's standing. It is
          -- dropped rather than given its own bucket so 'finished' stays equal
          -- to the sum of the categories the owner actually reads
          -- (M3-SCORE-03), and the states that remain are the ones that say
          -- something about the work: a real failure and an outcome nobody can
          -- vouch for.
          AND s.state IN ('succeeded','failed','uncertain')
          AND s.finished_at>=$2::timestamptz AND s.finished_at<=$3::timestamptz
      ), classified AS (
        SELECT s.worker_kind,s.model,s.effort,s.provider,s.profile,s.state,s.finished_at,
          (s.finished_at>=$4::timestamptz) AS in_seven_days,
          (last_round.revision_number)::int AS revision_number,
          catcher.actor_type AS catcher_actor_type, catcher.harness AS catcher_harness
        FROM scoped_stage_runs s
        -- R7-01: a review target is keyed by the subject that PRODUCED the
        -- result -- the EXECUTION job, not the stage's own source job. The
        -- stage row names the proposal job the owner wrote
        -- (PipelineServiceV1.instantiate), and the execution job is reachable
        -- only through control_task_execution_plans, so joining the target on
        -- 's.current_job_id' matched nothing the product ever wrote and every
        -- real stage read as "review outcome unknown".
        --
        -- A fix round is the same stage with a new round: the revision's plan
        -- carries 'revision.rootSubjectId', the FIRST execution job, and its own
        -- revisionNumber, and the revised target keeps that root subject with
        -- revisionNumber>0 (native-review-plan.ts, completionReviewTargetSchemaV1).
        -- So the lineage is entered at its ROOT (revisionNumber 0) from either
        -- the round's execution job or the revision's root subject, and the
        -- stage's outcome is the LAST target in that lineage -- which is what
        -- makes a fixed stage read as a fix rather than as a first-time pass.
        --
        -- There is deliberately no fallback back to 's.current_job_id'. A review
        -- target's subject is always the job that PRODUCED the result: the
        -- harness run is bound to an execution job, and 'verifyNativeReviewTarget'
        -- refuses any target whose subjectId is not that job. A stage with no
        -- execution plan therefore has no review outcome at all, and reporting
        -- "unknown" is the truth; matching the proposal job again is the exact
        -- confusion this join had.
        LEFT JOIN control_task_execution_plans ep
          ON ep.tenant_id=$1 AND ep.project_id=s.project_id AND ep.source_job_id=s.current_job_id
        -- int10: the root lookup is a LATERAL index probe per stage, like the last
        -- round below. As a plain join over int9's workspace-scoped CTE the planner
        -- read ALL gate records once and hashed them (measured at 3,000 stages);
        -- the subject index is the access path r7tfix's R7-PERF test pins.
        LEFT JOIN LATERAL (
          SELECT rt.id, rt.subject_id
          FROM control_completion_gate_records rt
          WHERE rt.tenant_id=$1 AND rt.kind='target' AND rt.project_id=s.project_id
            AND rt.subject_id=COALESCE(ep.plan->'revision'->>'rootSubjectId',ep.job_id)
            AND (rt.payload->>'revisionNumber')::int=0
          ORDER BY rt.occurred_at, rt.id LIMIT 1
        ) root_target ON true
        LEFT JOIN LATERAL (
          -- The newest revision of that lineage, in ONE bounded step: every
          -- target in a revision lineage shares its rootTargetId, and
          -- 'max(revisionNumber)' is the round the stage finished on.
          SELECT t.payload->>'revisionNumber' AS revision_number
          FROM control_completion_gate_records t
          WHERE t.tenant_id=$1 AND t.kind='target' AND t.project_id=s.project_id
            -- The subject_id equality is the INDEX, not a second way of saying
            -- the same thing. Matching only 'payload->>'rootTargetId'' forced a
            -- sequential scan of the gate records once per stage: measured on
            -- PostgreSQL 17 as this role at 3,000 stages, 4,573 ms, growing as
            -- stages x records. subject_id is the leading predicate of
            -- idx_control_completion_gate_subject (tenant_id, project_id, kind,
            -- subject_id, occurred_at, id), so the same lookup is 23 ms for
            -- identical output. It is also TRUE of every row the product
            -- writes: each target in a lineage keeps the root execution job as
            -- its subject (nativeReviewTarget carries revision.rootSubjectId
            -- onto every round), which is exactly what this lineage is entered
            -- by. Do not drop it as redundant with the payload equality.
            AND t.subject_id=root_target.subject_id AND t.payload->>'rootTargetId'=root_target.id
          ORDER BY (t.payload->>'revisionNumber')::int DESC LIMIT 1
        ) last_round ON root_target.id IS NOT NULL
        LEFT JOIN LATERAL (
          -- The reviewer principal lives under the reviewer's own object in the
          -- payload, not at the top level. Reading the top level yields NULL for
          -- every row and every catcher label silently becomes "Not recorded".
          -- Found on real PostgreSQL: the "Claude checker" label disappeared
          -- while the counts stayed right.
          --
          -- "Who caught it" is a change_requested review on the lineage BELOW
          -- the round that finally landed, so it is scoped to the same
          -- rootTargetId as the stage's own target and to the rounds before it
          -- (prior_target.revisionNumber below the stage's last round). Without
          -- that bound it would credit the reviewer of a changes_requested
          -- review on the FINAL accepted target, which caught nothing.
          SELECT rev.payload->'reviewer'->>'actorType' AS actor_type,
            rev.payload->'reviewer'->>'harness' AS harness
          FROM control_completion_gate_records prior_target
          JOIN control_completion_gate_records rev
            -- Same index, same reason as the last-round lateral above. A
            -- review's subject_id IS its targetId (store.ts describe(): a
            -- review is recorded with subjectId = value.targetId), so this is
            -- not a new restriction but the indexed form of the payload
            -- equality beside it. The project_id here is what stops a review
            -- stored under another project catching a stage in this one.
            ON rev.tenant_id=$1 AND rev.kind='review' AND rev.project_id=s.project_id AND rev.subject_id=prior_target.id AND rev.payload->>'targetId'=prior_target.id
            AND rev.payload->>'decision'='changes_requested'
          WHERE prior_target.tenant_id=$1 AND prior_target.kind='target'
            AND prior_target.project_id=s.project_id
            AND prior_target.subject_id=root_target.subject_id AND prior_target.payload->>'rootTargetId'=root_target.id
            AND (last_round.revision_number)::int>0
            AND (prior_target.payload->>'revisionNumber')::int<(last_round.revision_number)::int
          ORDER BY (prior_target.payload->>'revisionNumber')::int DESC LIMIT 1
        ) catcher ON true
      ), counted AS (
        SELECT worker_kind,model,effort,provider,profile,
          max(finished_at) AS last_finished_at,
          count(*)::bigint AS finished_30,
          count(*) FILTER (WHERE state='succeeded' AND revision_number=0)::bigint AS passed_first_time_30,
          count(*) FILTER (WHERE state='succeeded' AND revision_number>0)::bigint AS needed_fixes_30,
          count(*) FILTER (WHERE state<>'succeeded')::bigint AS failed_or_blocked_30,
          -- A succeeded row whose completion-gate target is absent (the LEFT
          -- JOIN returns no revision number) has no outcome category of its
          -- own. Counting it here, rather than silently inside passedFirstTime
          -- or dropping it from every category, is what M3-SCORE-03 requires:
          -- finished must equal the sum of every displayed category.
          count(*) FILTER (WHERE state='succeeded' AND revision_number IS NULL)::bigint AS unknown_review_30,
          count(*) FILTER (WHERE in_seven_days)::bigint AS finished_7,
          count(*) FILTER (WHERE in_seven_days AND state='succeeded' AND revision_number=0)::bigint AS passed_first_time_7,
          count(*) FILTER (WHERE in_seven_days AND state='succeeded' AND revision_number>0)::bigint AS needed_fixes_7,
          count(*) FILTER (WHERE in_seven_days AND state<>'succeeded')::bigint AS failed_or_blocked_7,
          count(*) FILTER (WHERE in_seven_days AND state='succeeded' AND revision_number IS NULL)::bigint AS unknown_review_7
        FROM classified
        GROUP BY worker_kind,model,effort,provider,profile
      ), reviewer_pairs AS (
        -- One row per (reviewer pair, in_seven_days) with the count measured
        -- over exactly that span.
        SELECT worker_kind,model,effort,provider,profile,in_seven_days,
          coalesce(catcher_actor_type,'none')||'/'||coalesce(catcher_harness,'none') AS reviewer_pair,
          count(*)::bigint AS pair_count
        FROM classified
        WHERE state='succeeded' AND revision_number>0
        GROUP BY worker_kind,model,effort,provider,profile,in_seven_days,
          coalesce(catcher_actor_type,'none')||'/'||coalesce(catcher_harness,'none')
      ), reviewer_totals AS (
        -- SUM pair_count per reviewer pair BEFORE any aggregation. This is
        -- PG-R6-06: grouping by in_seven_days alone emitted the SAME
        -- reviewer_pair twice -- once inside seven days, once outside -- and
        -- jsonb_object_agg keeps the last duplicate key WITHOUT erroring, so the
        -- owner's reviewer credit became whichever of the two counts the
        -- database happened to read last. Measured on PostgreSQL 17 with one
        -- reviewed fix inside seven days and one outside: the 30-day map said
        -- "1" when the 7-day row was inserted first and "2" when it was second,
        -- for identical data.
        --
        -- A 7-day fix is also a 30-day fix, so the 30-day map is every
        -- reviewed fix in 30 days and the 7-day map only those inside seven
        -- days. Labelling each fix with ONE window instead (the obvious
        -- simplification) drops the recent fixes out of the 30-day total
        -- entirely: measured, one fix inside seven days and one outside gave a
        -- 30-day credit of 1 rather than 2. Verified on PostgreSQL 17 that this
        -- form is stable across three insertion orders and keeps two different
        -- reviewers for the same group as separate keys.
        SELECT worker_kind,model,effort,provider,profile,
          jsonb_object_agg(reviewer_pair, total_pair_count::text) AS pairs_30,
          jsonb_object_agg(reviewer_pair, seven_day_pair_count::text) FILTER (WHERE seven_day_pair_count IS NOT NULL) AS pairs_7
        FROM (
          SELECT worker_kind,model,effort,provider,profile,reviewer_pair,
            sum(pair_count)::bigint AS total_pair_count,
            sum(pair_count) FILTER (WHERE in_seven_days)::bigint AS seven_day_pair_count
          FROM reviewer_pairs GROUP BY worker_kind,model,effort,provider,profile,reviewer_pair
        ) totals GROUP BY worker_kind,model,effort,provider,profile
      )
      SELECT c.worker_kind,c.model,c.effort,c.provider,c.profile,
        c.finished_30,c.passed_first_time_30,c.needed_fixes_30,c.failed_or_blocked_30,c.unknown_review_30,
        c.finished_7,c.passed_first_time_7,c.needed_fixes_7,c.failed_or_blocked_7,c.unknown_review_7,
        (SELECT k.pairs_7 FROM reviewer_totals k
          WHERE k.worker_kind=c.worker_kind AND k.model=c.model AND k.effort=c.effort
          AND k.provider IS NOT DISTINCT FROM c.provider AND k.profile IS NOT DISTINCT FROM c.profile) AS catcher_pairs_7,
        (SELECT k.pairs_30 FROM reviewer_totals k
          WHERE k.worker_kind=c.worker_kind AND k.model=c.model AND k.effort=c.effort
          AND k.provider IS NOT DISTINCT FROM c.provider AND k.profile IS NOT DISTINCT FROM c.profile) AS catcher_pairs_30
      FROM counted c
      -- Newest-group-first, so a JS-side cap on the NUMBER OF GROUPS keeps the
      -- fleet's most recently active groups. The per-ROW cap that pushed an
      -- older model's whole history out of the query is gone (M3-SCORE-U01):
      -- this ordering is only for the separate, much higher GROUP cap the
      -- browser wire still enforces (M3-SCORE-02), and it has to drop the
      -- least-recently-active groups rather than an arbitrary query-plan slice.
      ORDER BY c.last_finished_at DESC`, [input.tenantId, windowStart, now.toISOString(), sevenDaysAgo, input.workspaceId]);
    const groups = new Map<string, WorkerScorecardGroupV1>();
    for (const row of result.rows) {
      if (!WORKER_KINDS.includes(row.worker_kind as WorkerKind) || !EFFORTS.includes(row.effort as Effort)) throw new Error("invalid_worker_scorecard_record");
      const key = JSON.stringify([row.worker_kind, row.model, row.effort, row.provider, row.profile]);
      const group = { workerKind: row.worker_kind as WorkerKind, model: row.model, effort: row.effort as Effort,
        provider: row.provider, profile: row.profile, last7Days: windowBucket(), last30Days: windowBucket() };
      groups.set(key, group);
      for (const [suffix, finished, passedFirstTime, neededFixes, failedOrBlocked, unknownReview, pairs] of [
        ["30", row.finished_30, row.passed_first_time_30, row.needed_fixes_30, row.failed_or_blocked_30, row.unknown_review_30, row.catcher_pairs_30],
        ["7", row.finished_7, row.passed_first_time_7, row.needed_fixes_7, row.failed_or_blocked_7, row.unknown_review_7, row.catcher_pairs_7],
      ] as const) {
        const bucket = suffix === "7" ? group.last7Days : group.last30Days;
        bucket.finished = countValue(finished);
        bucket.passedFirstTime = countValue(passedFirstTime);
        bucket.neededFixes = countValue(neededFixes);
        bucket.failedOrBlocked = countValue(failedOrBlocked);
        bucket.unknownReview = countValue(unknownReview);
        bucket.caughtBy = labelCounts(pairs);
      }
    }
    // Query order is newest-group-first; retain the most recently active
    // groups before sorting their display labels. Declare every omitted group
    // explicitly rather than silently truncating the board.
    return { observedAt: input.now, olderGroupsOmitted: Math.max(0, groups.size - 200), groups: [...groups.values()].slice(0, 200).sort((a, b) =>
      a.workerKind.localeCompare(b.workerKind) || a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort)) };
  }
}
