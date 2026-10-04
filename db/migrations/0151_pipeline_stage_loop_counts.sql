-- S7b: the loop ceilings, enforced against the round count that already exists.
-- `max_loops` (per stage) and `max_total_loops` (per run) were already stored,
-- signed and surfaced, and never compared to anything.
--
-- The count is NOT stored a second time. One build stage spans N jobs and N
-- attempts as the loop runs (MULTI_AGENT_PIPELINES_DESIGN.md §"The loop lives
-- in the attempt chain"), so the rounds a stage has run are exactly the distinct
-- pipeline jobs that carry its stage_ordinal. This table is therefore a signed
-- RECEIPT of that count at the moment the advance refused or admitted it — an
-- append-only record of what the ceiling was compared against, not a second
-- authority that could disagree with the job chain.
--
-- And because a fix round is a new planned job, the advance receipt is keyed per
-- round, so each round has its own durable receipt. A stage's first receipt stays
-- history rather than being reused, and a replayed advance still lands on the same
-- key, because the round is derived from the immutable job chain.
--
-- No trigger, scheduler, provider invocation, merge or external effect is added.

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
  -- The round this row records, zero for a stage's first attempt, and the
  -- effective ceilings it was admitted under.
  loop_index bigint NOT NULL CHECK (loop_index >= 0),
  max_loops bigint NOT NULL CHECK (max_loops >= 0),
  max_total_loops bigint NOT NULL CHECK (max_total_loops >= 0),
  -- Every round this run has started, including this one.
  run_total_loops bigint NOT NULL CHECK (run_total_loops >= 0),
  reason_code text NOT NULL CHECK (reason_code IN
    ('stage_advanced','stage_loop_limit_reached','run_loop_limit_reached')),
  -- The receipt that admitted or refused this round, so a recorded count is
  -- always traceable to the exact decision it justified.
  receipt_id text NOT NULL,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  coordinator_lock boolean NOT NULL DEFAULT false CHECK (coordinator_lock IS FALSE),
  PRIMARY KEY (tenant_id, id),
  -- One record per stage per run per round. A replayed advance cannot append a
  -- second one, and a refusal at the same round is recognised by its reason.
  UNIQUE (tenant_id, pipeline_run_id, stage_ordinal, loop_index, reason_code),
  FOREIGN KEY (tenant_id, pipeline_run_id, project_id)
    REFERENCES pipeline_runs(tenant_id, id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, pipeline_run_id, stage_ordinal)
    REFERENCES pipeline_stage_runs(tenant_id, pipeline_run_id, stage_ordinal) ON DELETE RESTRICT,
  -- A recorded round is inside the per-stage ceiling it was compared against.
  CHECK (loop_index <= max_loops),
  -- Two stages each under their own limit still cannot pass the run ceiling.
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
-- grant as narrow as the fresh-install role files.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT, INSERT ON pipeline_stage_loop_counts TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (coordinator_lock) ON pipeline_stage_loop_counts TO control_room_task_coordinator';
  END IF;
END $$;
