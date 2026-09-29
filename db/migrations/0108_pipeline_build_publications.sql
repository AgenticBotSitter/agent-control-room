-- S6: immutable build-stage write bounds and canonical pull-request evidence.
-- These records grant no merge, retry, completion, approval, or execution authority.

ALTER TABLE pipeline_stage_runs ADD COLUMN allowed_paths jsonb;
ALTER TABLE pipeline_stage_runs ADD COLUMN maximum_changed_files integer;
ALTER TABLE pipeline_stage_runs ADD COLUMN maximum_changed_bytes integer;
ALTER TABLE pipeline_stage_runs ADD CONSTRAINT ck_pipeline_stage_build_policy CHECK (
  (stage_kind='build' AND jsonb_typeof(allowed_paths)='array'
    AND jsonb_array_length(allowed_paths) BETWEEN 1 AND 100
    AND maximum_changed_files BETWEEN 1 AND 500
    AND maximum_changed_bytes BETWEEN 1 AND 16777216)
  OR (stage_kind='build' AND allowed_paths IS NULL
    AND maximum_changed_files IS NULL AND maximum_changed_bytes IS NULL)
  OR (stage_kind<>'build' AND allowed_paths IS NULL
    AND maximum_changed_files IS NULL AND maximum_changed_bytes IS NULL));

CREATE TABLE control_pipeline_build_publications (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  pipeline_run_id text NOT NULL,
  stage_ordinal integer NOT NULL CHECK(stage_ordinal>=0),
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  harness_run_id text NOT NULL,
  artifact_id text NOT NULL,
  result_revision integer NOT NULL CHECK(result_revision>0),
  delivery_digest text NOT NULL CHECK(delivery_digest ~ '^sha256:[a-f0-9]{64}$'),
  retained_result_digest text NOT NULL CHECK(retained_result_digest ~ '^sha256:[a-f0-9]{64}$'),
  plan_digest text NOT NULL CHECK(plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  evidence_digest text NOT NULL CHECK(evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  evidence jsonb NOT NULL,
  auth_tag text NOT NULL CHECK(auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,pipeline_run_id,stage_ordinal),
  UNIQUE (tenant_id,delivery_digest),
  UNIQUE (tenant_id,evidence_digest),
  FOREIGN KEY (tenant_id,pipeline_run_id,stage_ordinal)
    REFERENCES pipeline_stage_runs(tenant_id,pipeline_run_id,stage_ordinal) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id,job_id)
    REFERENCES control_attempts(tenant_id,id,job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,harness_run_id)
    REFERENCES control_harness_runs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,artifact_id)
    REFERENCES control_artifact_manifests(tenant_id,id) ON DELETE RESTRICT,
  CHECK (evidence->>'schema'='control-room.pull-request-publication-evidence/v1'
    AND evidence->>'deliveryDigest'=delivery_digest
    AND evidence->>'retainedResultDigest'=retained_result_digest
    AND evidence->>'planDigest'=plan_digest
    AND evidence->>'evidenceDigest'=evidence_digest)
);
CREATE TRIGGER control_pipeline_build_publications_immutable BEFORE UPDATE OR DELETE
  ON public.control_pipeline_build_publications FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_pipeline_build_publications_no_truncate BEFORE TRUNCATE
  ON public.control_pipeline_build_publications FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

CREATE OR REPLACE FUNCTION guard_pipeline_stage_run_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE linked record;
BEGIN
  SELECT project_id,pipeline_run_id,stage_kind,stage_ordinal INTO linked FROM public.control_jobs
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
    OR NEW.stage_kind<>OLD.stage_kind OR NEW.stage_ordinal<>OLD.stage_ordinal OR NEW.role<>OLD.role
    OR NEW.allowed_paths IS DISTINCT FROM OLD.allowed_paths
    OR NEW.maximum_changed_files IS DISTINCT FROM OLD.maximum_changed_files
    OR NEW.maximum_changed_bytes IS DISTINCT FROM OLD.maximum_changed_bytes) THEN
    RAISE EXCEPTION 'pipeline stage immutable selection rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_pipeline_stage_run_write() FROM PUBLIC;
