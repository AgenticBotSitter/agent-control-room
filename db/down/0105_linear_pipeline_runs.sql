BEGIN;
LOCK TABLE control_jobs, pipeline_templates, pipeline_runs, pipeline_stage_runs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pipeline_templates) OR EXISTS (SELECT 1 FROM pipeline_runs)
    OR EXISTS (SELECT 1 FROM pipeline_stage_runs)
    OR EXISTS (SELECT 1 FROM control_jobs WHERE pipeline_run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'linear pipeline down migration refused: records exist';
  END IF;
  -- A later migration may hold a foreign key into these tables -- S7b's 0151
  -- keeps its counted rounds pointing at pipeline_runs, and cook/v1's 0160 does
  -- the same. Dropping the table with such a key still attached fails with a
  -- bare dependency error naming an object the operator never asked to remove.
  -- Refuse by name instead, and say which later migration to reverse first.
  -- The keys 0105 owns are excluded: this file drops both of their tables
  -- itself, in order, and a self-reference is not a later migration.
  IF EXISTS (SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND con.contype = 'f'
      AND con.confrelid IN ('pipeline_runs'::regclass, 'pipeline_templates'::regclass,
        'pipeline_stage_runs'::regclass)
      AND con.conname NOT IN ('fk_control_jobs_pipeline_run',
        'pipeline_runs_tenant_id_template_id_project_id_fkey',
        'pipeline_stage_runs_tenant_id_pipeline_run_id_project_id_fkey')) THEN
    RAISE EXCEPTION 'linear pipeline down migration refused: a later migration depends on its tables';
  END IF;
END $$;
DROP VIEW pipeline_ordered_stage_runs;
DROP TRIGGER pipeline_stage_runs_guard ON pipeline_stage_runs;
DROP FUNCTION guard_pipeline_stage_run_write();
DROP TABLE pipeline_stage_runs;
DROP TRIGGER control_jobs_pipeline_lineage_write_once ON control_jobs;
DROP FUNCTION guard_control_job_pipeline_lineage();
ALTER TABLE control_jobs DROP CONSTRAINT fk_control_jobs_pipeline_run;
ALTER TABLE control_jobs DROP CONSTRAINT ck_control_jobs_pipeline_columns_all_or_none;
ALTER TABLE control_jobs DROP COLUMN pipeline_run_id;
ALTER TABLE control_jobs DROP COLUMN stage_ordinal;
ALTER TABLE control_jobs DROP COLUMN stage_kind;
DROP TABLE pipeline_runs;
DROP TABLE pipeline_templates;
COMMIT;
