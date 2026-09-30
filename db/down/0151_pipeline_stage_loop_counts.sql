BEGIN;
-- 0151 alone: the counted fix rounds. A populated counter is this installation's
-- only record of how many rounds it has spent, so the down path refuses while one
-- exists rather than silently discarding it. It grants nothing and touches no
-- other table; the per-round receipt key belongs to 0154 and is not revoked here.
LOCK TABLE pipeline_stage_loop_counts IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pipeline_stage_loop_counts) THEN
    RAISE EXCEPTION 'pipeline loop-count down migration refused: counted rounds exist';
  END IF;
END $$;
DROP POLICY pipeline_stage_loop_counts_work_intake_scope ON pipeline_stage_loop_counts;
DROP POLICY pipeline_stage_loop_counts_existing_access ON pipeline_stage_loop_counts;
DROP TRIGGER pipeline_stage_loop_counts_no_truncate ON pipeline_stage_loop_counts;
DROP TRIGGER pipeline_stage_loop_counts_immutable ON pipeline_stage_loop_counts;
DROP TABLE pipeline_stage_loop_counts;
COMMIT;
