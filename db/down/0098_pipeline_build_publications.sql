BEGIN;
LOCK TABLE control_pipeline_build_publications IN ACCESS EXCLUSIVE MODE;
LOCK TABLE pipeline_stage_runs IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM control_pipeline_build_publications) THEN
    RAISE EXCEPTION '0098 down migration refused: retained build publication history exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pipeline_stage_runs
    WHERE allowed_paths IS NOT NULL OR maximum_changed_files IS NOT NULL OR maximum_changed_bytes IS NOT NULL) THEN
    RAISE EXCEPTION '0098 down migration refused: authenticated build write policy exists';
  END IF;
END $$;
DROP TABLE control_pipeline_build_publications;
ALTER TABLE pipeline_stage_runs DROP CONSTRAINT ck_pipeline_stage_build_policy;
ALTER TABLE pipeline_stage_runs DROP COLUMN maximum_changed_bytes;
ALTER TABLE pipeline_stage_runs DROP COLUMN maximum_changed_files;
ALTER TABLE pipeline_stage_runs DROP COLUMN allowed_paths;
CREATE OR REPLACE FUNCTION guard_pipeline_stage_run_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked record;
BEGIN
  SELECT project_id,pipeline_run_id,stage_kind,stage_ordinal INTO linked FROM control_jobs
    WHERE tenant_id=NEW.tenant_id AND id=NEW.current_job_id;
  IF linked.project_id IS DISTINCT FROM NEW.project_id
    OR linked.pipeline_run_id IS DISTINCT FROM NEW.pipeline_run_id
    OR linked.stage_kind IS DISTINCT FROM NEW.stage_kind
    OR linked.stage_ordinal IS DISTINCT FROM NEW.stage_ordinal THEN
    RAISE EXCEPTION 'pipeline stage lineage rejected';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.worker_id<>OLD.worker_id OR NEW.worker_kind<>OLD.worker_kind
    OR NEW.node_id<>OLD.node_id OR NEW.selection_key<>OLD.selection_key OR NEW.model<>OLD.model
    OR NEW.effort<>OLD.effort OR NEW.pipeline_run_id<>OLD.pipeline_run_id
    OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.profile IS DISTINCT FROM OLD.profile
    OR NEW.stage_kind<>OLD.stage_kind OR NEW.stage_ordinal<>OLD.stage_ordinal OR NEW.role<>OLD.role) THEN
    RAISE EXCEPTION 'pipeline stage immutable selection rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_pipeline_stage_run_write() FROM PUBLIC;
COMMIT;
