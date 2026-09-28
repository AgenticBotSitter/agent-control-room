-- S4: inert linear pipeline definitions and projections.  These records do
-- not create attempts, leases, delivery intents, scheduler jobs or execution
-- authority.

CREATE TABLE pipeline_templates (
  id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  stages jsonb NOT NULL,
  max_stages integer NOT NULL CHECK (max_stages BETWEEN 1 AND 32),
  max_total_loops integer NOT NULL CHECK (max_total_loops BETWEEN 0 AND 96),
  may_advance_unattended boolean NOT NULL DEFAULT false CHECK (may_advance_unattended=false),
  max_duration_seconds integer NOT NULL CHECK (max_duration_seconds BETWEEN 60 AND 604800),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,project_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(stages)='array'),
  CHECK (updated_at>=created_at)
);

CREATE TABLE pipeline_runs (
  id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  request_id text NOT NULL,
  template_id text NOT NULL,
  template_version integer NOT NULL CHECK (template_version >= 1),
  template_digest text NOT NULL CHECK (template_digest ~ '^sha256:[a-f0-9]{64}$'),
  workflow_id text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  state text NOT NULL CHECK (state IN ('proposed','active','paused','succeeded','failed','cancelled')),
  started_at timestamptz,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  current_stage_ordinal integer CHECK (current_stage_ordinal IS NULL OR current_stage_ordinal>=0),
  unattended boolean NOT NULL DEFAULT false CHECK (unattended=false),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,project_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,request_id) REFERENCES control_requests(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workflow_id,project_id)
    REFERENCES control_workflows(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,template_id,project_id)
    REFERENCES pipeline_templates(tenant_id,id,project_id) ON DELETE RESTRICT,
  CHECK (completed_at IS NULL OR completed_at>=updated_at)
);

ALTER TABLE control_jobs ADD COLUMN stage_kind text
  CHECK (stage_kind IS NULL OR stage_kind IN ('plan','build','check','signoff','effect'));
ALTER TABLE control_jobs ADD COLUMN stage_ordinal integer
  CHECK (stage_ordinal IS NULL OR stage_ordinal>=0);
ALTER TABLE control_jobs ADD COLUMN pipeline_run_id text;
ALTER TABLE control_jobs ADD CONSTRAINT ck_control_jobs_pipeline_columns_all_or_none CHECK (
  (stage_kind IS NULL AND stage_ordinal IS NULL AND pipeline_run_id IS NULL)
  OR (stage_kind IS NOT NULL AND stage_ordinal IS NOT NULL AND pipeline_run_id IS NOT NULL)) NOT VALID;
ALTER TABLE control_jobs ADD CONSTRAINT fk_control_jobs_pipeline_run
  FOREIGN KEY (tenant_id,pipeline_run_id,project_id)
    REFERENCES pipeline_runs(tenant_id,id,project_id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE control_jobs VALIDATE CONSTRAINT ck_control_jobs_pipeline_columns_all_or_none;
ALTER TABLE control_jobs VALIDATE CONSTRAINT fk_control_jobs_pipeline_run;

CREATE TABLE pipeline_stage_runs (
  id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  pipeline_run_id text NOT NULL,
  stage_ordinal integer NOT NULL CHECK (stage_ordinal>=0),
  stage_kind text NOT NULL CHECK (stage_kind IN ('plan','build','check','signoff','effect')),
  role text NOT NULL CHECK (role IN ('planner','builder','checker','validator','effecter')),
  worker_id text NOT NULL,
  worker_kind text NOT NULL CHECK (worker_kind IN ('codex','claude-code','hermes')),
  node_id text NOT NULL,
  selection_key text NOT NULL,
  model text NOT NULL,
  effort text NOT NULL CHECK (effort IN ('default','low','medium','high','xhigh','max')),
  provider text,
  profile text,
  current_job_id text NOT NULL,
  current_attempt_id text,
  current_lease_id text,
  state text NOT NULL CHECK (state IN ('proposed','active','paused','succeeded','failed','cancelled','uncertain')),
  max_loops integer NOT NULL CHECK (max_loops BETWEEN 0 AND 20),
  handoff_from_result_digest text CHECK (handoff_from_result_digest IS NULL OR handoff_from_result_digest ~ '^sha256:[a-f0-9]{64}$'),
  signoff_review_id text,
  started_at timestamptz,
  finished_at timestamptz,
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,pipeline_run_id,stage_ordinal),
  FOREIGN KEY (tenant_id,pipeline_run_id,project_id)
    REFERENCES pipeline_runs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,current_job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,current_attempt_id,current_job_id)
    REFERENCES control_attempts(tenant_id,id,job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,current_lease_id) REFERENCES control_leases(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((stage_kind='build' AND role='builder') OR (stage_kind='check' AND role='checker')
    OR (stage_kind='signoff' AND role='validator') OR (stage_kind='plan' AND role='planner')
    OR (stage_kind='effect' AND role='effecter')),
  CHECK (finished_at IS NULL OR started_at IS NOT NULL),
  CHECK ((worker_kind='hermes' AND provider IS NOT NULL AND profile IS NOT NULL)
    OR (worker_kind<>'hermes' AND provider IS NULL AND profile IS NULL)),
  CHECK (current_lease_id IS NULL OR current_attempt_id IS NOT NULL)
);

CREATE FUNCTION guard_pipeline_stage_run_write() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER pipeline_stage_runs_guard BEFORE INSERT OR UPDATE ON pipeline_stage_runs
  FOR EACH ROW EXECUTE FUNCTION guard_pipeline_stage_run_write();

CREATE VIEW pipeline_ordered_stage_runs AS
  SELECT s.* FROM pipeline_stage_runs s ORDER BY s.tenant_id,s.pipeline_run_id,s.stage_ordinal;
REVOKE ALL ON pipeline_ordered_stage_runs FROM PUBLIC;

CREATE INDEX pipeline_runs_project_updated ON pipeline_runs(tenant_id,project_id,updated_at DESC);
CREATE INDEX pipeline_stage_runs_current_job ON pipeline_stage_runs(tenant_id,current_job_id);
