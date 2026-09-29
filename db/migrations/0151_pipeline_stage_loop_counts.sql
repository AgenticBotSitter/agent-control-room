-- S7b: the counted fix rounds. `max_loops` (per stage) and `max_total_loops`
-- (per run) were already stored, signed and surfaced, and never compared to
-- anything. This table is the counter they were always meant to be read
-- against, and the only writer is the advance transaction that already holds
-- the run row lock. No trigger, scheduler, provider invocation or external
-- effect is added.
--
-- A stage's first attempt is round 0, so a stage with `max_loops = 0` still
-- runs once and can never loop back. The service clamps each stored limit to
-- the product ceiling of 2 fix rounds per stage and 6 per run, so a template
-- can lower those limits and never raise them.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE pipeline_stage_loop_counts (
  id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  pipeline_run_id text NOT NULL,
  stage_ordinal bigint NOT NULL CHECK (stage_ordinal >= 0),
  -- The worker this stage runs on. The per-agent daily allowance is counted
  -- against exactly this id, so it can never be widened by a plan shape change.
  worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 180),
  -- The round this row opens, zero for a stage's first attempt, and the
  -- effective ceilings that round was admitted under.
  loop_index bigint NOT NULL CHECK (loop_index >= 0),
  max_loops bigint NOT NULL CHECK (max_loops >= 0),
  max_total_loops bigint NOT NULL CHECK (max_total_loops >= 0),
  -- Every round this run has started, including this one.
  run_total_loops bigint NOT NULL CHECK (run_total_loops >= 0),
  reason_code text NOT NULL CHECK (reason_code = 'stage_advanced'),
  receipt_id text NOT NULL,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  coordinator_lock boolean NOT NULL DEFAULT false CHECK (coordinator_lock IS FALSE),
  PRIMARY KEY (tenant_id, id),
  -- One counted round per stage per run. A second receipt for the same round
  -- cannot be appended, so a replayed advance can never inflate a count.
  UNIQUE (tenant_id, pipeline_run_id, stage_ordinal, loop_index),
  FOREIGN KEY (tenant_id, pipeline_run_id, project_id)
    REFERENCES pipeline_runs(tenant_id, id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, pipeline_run_id, stage_ordinal)
    REFERENCES pipeline_stage_runs(tenant_id, pipeline_run_id, stage_ordinal) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, receipt_id)
    REFERENCES pipeline_advance_receipts(tenant_id, id) ON DELETE RESTRICT,
  -- The round this row opens is inside the per-stage ceiling, whatever wrote it.
  CHECK (loop_index <= max_loops),
  -- The run total this row reaches is inside the run-wide ceiling: two stages
  -- each under their own limit still cannot pass the run ceiling together.
  CHECK (run_total_loops <= max_total_loops),
  -- The run total is at least this stage's rounds up to and including this one.
  CHECK (run_total_loops >= loop_index + 1)
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX pipeline_stage_loop_counts_hourly_window
  ON pipeline_stage_loop_counts(tenant_id, recorded_at DESC, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX pipeline_stage_loop_counts_agent_daily
  ON pipeline_stage_loop_counts(tenant_id, worker_id, recorded_at, id);

CREATE TRIGGER pipeline_stage_loop_counts_immutable BEFORE UPDATE OR DELETE ON public.pipeline_stage_loop_counts
  FOR EACH ROW EXECUTE FUNCTION public.reject_pipeline_unattended_history_mutation();
CREATE TRIGGER pipeline_stage_loop_counts_no_truncate BEFORE TRUNCATE ON public.pipeline_stage_loop_counts
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_pipeline_unattended_history_mutation();

REVOKE ALL ON pipeline_stage_loop_counts FROM PUBLIC;

-- No shared login is granted this table. If one ever is, the work-intake
-- session must still see and write only its bound tenant, as 0104, 0108 and
-- 0109 confine their tables.
ALTER TABLE pipeline_stage_loop_counts ENABLE ROW LEVEL SECURITY;
CREATE POLICY pipeline_stage_loop_counts_existing_access ON pipeline_stage_loop_counts
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY pipeline_stage_loop_counts_work_intake_scope ON pipeline_stage_loop_counts
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session() OR
    pipeline_stage_loop_counts.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b))
  WITH CHECK (NOT public.is_work_intake_session() OR
    pipeline_stage_loop_counts.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b));

-- Existing installations already have these NOLOGIN roles. Keep the upgrade
-- grant as narrow as the fresh-install role files: the coordinator counts
-- rounds and appends them, and its only updatable column is the false-valued
-- lock it needs for the row lock.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT, INSERT ON pipeline_stage_loop_counts TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (coordinator_lock) ON pipeline_stage_loop_counts TO control_room_task_coordinator';
  END IF;
END $$;
