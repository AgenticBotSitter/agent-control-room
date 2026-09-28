BEGIN;
LOCK TABLE control_jobs, pipeline_templates, pipeline_runs, pipeline_stage_runs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pipeline_templates) OR EXISTS (SELECT 1 FROM pipeline_runs)
    OR EXISTS (SELECT 1 FROM pipeline_stage_runs)
    OR EXISTS (SELECT 1 FROM control_jobs WHERE pipeline_run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'linear pipeline down migration refused: records exist';
  END IF;
END $$;
DROP VIEW pipeline_ordered_stage_runs;
DROP TRIGGER pipeline_stage_runs_guard ON pipeline_stage_runs;
DROP FUNCTION guard_pipeline_stage_run_write();
DROP TABLE pipeline_stage_runs;
ALTER TABLE control_jobs DROP CONSTRAINT fk_control_jobs_pipeline_run;
ALTER TABLE control_jobs DROP CONSTRAINT ck_control_jobs_pipeline_columns_all_or_none;
ALTER TABLE control_jobs DROP COLUMN pipeline_run_id;
ALTER TABLE control_jobs DROP COLUMN stage_ordinal;
ALTER TABLE control_jobs DROP COLUMN stage_kind;
DROP TABLE pipeline_runs;
DROP TABLE pipeline_templates;
COMMIT;
