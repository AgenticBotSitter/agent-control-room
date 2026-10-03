-- Improve Control Room desk, first slice. Requests bind owner text to an existing
-- authenticated pipeline template. Update candidates and decisions are inert:
-- they carry no deployment, database, service or release authority.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_improvement_requests (
  tenant_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 8000),
  pipeline_template_id text NOT NULL,
  pipeline_template_version bigint NOT NULL CHECK (pipeline_template_version >= 1),
  pipeline_template_digest text NOT NULL CHECK (pipeline_template_digest ~ '^sha256:[a-f0-9]{64}$'),
  selected_worker_ids jsonb NOT NULL CHECK (jsonb_typeof(selected_worker_ids) = 'array'),
  lead_worker_id text NOT NULL,
  pipeline_run_id text NOT NULL,
  owner_identity_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_identity_id, idempotency_key),
  UNIQUE (tenant_id, pipeline_run_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, pipeline_template_id, project_id)
    REFERENCES pipeline_templates(tenant_id, id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, pipeline_run_id, project_id)
    REFERENCES pipeline_runs(tenant_id, id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE control_update_candidates (
  tenant_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  improvement_request_id text NOT NULL,
  pipeline_run_id text NOT NULL,
  base_revision text NOT NULL CHECK (base_revision ~ '^[a-f0-9]{40}$'),
  candidate_revision text NOT NULL CHECK (candidate_revision ~ '^[a-f0-9]{40}$'),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  changed_areas jsonb NOT NULL CHECK (jsonb_typeof(changed_areas) = 'array'),
  test_results jsonb NOT NULL CHECK (jsonb_typeof(test_results) = 'array'),
  database_changes jsonb NOT NULL CHECK (jsonb_typeof(database_changes) = 'object'),
  lead_worker_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('ready', 'accepted', 'declined')),
  version bigint NOT NULL CHECK (version >= 1),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, pipeline_run_id),
  FOREIGN KEY (tenant_id, improvement_request_id) REFERENCES control_improvement_requests(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, pipeline_run_id, project_id)
    REFERENCES pipeline_runs(tenant_id, id, project_id) ON DELETE RESTRICT,
  CHECK (base_revision <> candidate_revision),
  CHECK ((state = 'ready' AND decided_at IS NULL) OR (state <> 'ready' AND decided_at IS NOT NULL))
);

CREATE TABLE control_update_candidate_decisions (
  tenant_id text NOT NULL,
  id text NOT NULL,
  candidate_id text NOT NULL,
  project_id text NOT NULL,
  candidate_version bigint NOT NULL CHECK (candidate_version >= 1),
  candidate_record_digest text NOT NULL CHECK (candidate_record_digest ~ '^sha256:[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('accept', 'decline')),
  owner_identity_id text NOT NULL,
  idempotency_key text NOT NULL,
  decision_digest text NOT NULL CHECK (decision_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_identity_id, idempotency_key),
  UNIQUE (tenant_id, candidate_id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES control_update_candidates(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX control_improvement_requests_project_created
  ON control_improvement_requests(tenant_id, project_id, created_at DESC);
CREATE INDEX control_update_candidates_ready_created
  ON control_update_candidates(tenant_id, state, created_at DESC);

-- Requests and owner decisions are append only.
CREATE TRIGGER control_improvement_requests_immutable BEFORE UPDATE OR DELETE ON control_improvement_requests
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_improvement_requests_no_truncate BEFORE TRUNCATE ON control_improvement_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_update_candidate_decisions_immutable BEFORE UPDATE OR DELETE ON control_update_candidate_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_update_candidate_decisions_no_truncate BEFORE TRUNCATE ON control_update_candidate_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_update_candidates_no_delete BEFORE DELETE ON control_update_candidates
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_update_candidates_no_truncate BEFORE TRUNCATE ON control_update_candidates
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- A candidate is born ready, and only for a succeeded run whose sign-off stage
-- succeeded under the named lead. Whoever holds INSERT cannot publish one
-- already accepted, nor one the pipeline never signed off.
CREATE FUNCTION guard_update_candidate_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state <> 'ready' OR NEW.version <> 1 OR NEW.decided_at IS NOT NULL THEN
    RAISE EXCEPTION 'update candidate must be published ready' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control_improvement_requests request
      JOIN pipeline_runs run ON run.tenant_id=request.tenant_id AND run.id=request.pipeline_run_id
        AND run.project_id=request.project_id AND run.state='succeeded'
      JOIN pipeline_stage_runs stage ON stage.tenant_id=run.tenant_id AND stage.pipeline_run_id=run.id
        AND stage.project_id=run.project_id AND stage.stage_kind='signoff' AND stage.state='succeeded'
        AND stage.worker_id=NEW.lead_worker_id
      WHERE request.tenant_id=NEW.tenant_id AND request.id=NEW.improvement_request_id
        AND request.project_id=NEW.project_id AND request.pipeline_run_id=NEW.pipeline_run_id
        AND request.lead_worker_id=NEW.lead_worker_id) THEN
    RAISE EXCEPTION 'update candidate has no signed-off pipeline' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_update_candidate_insert() FROM PUBLIC;
CREATE TRIGGER control_update_candidates_insert_guard BEFORE INSERT ON control_update_candidates
  FOR EACH ROW EXECUTE FUNCTION guard_update_candidate_insert();

-- An owner decision binds the exact ready candidate version and digest, and its
-- author must hold an active owner grant able to take a high-risk decision.
CREATE FUNCTION guard_update_candidate_decision_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM control_update_candidates candidate
      WHERE candidate.tenant_id=NEW.tenant_id AND candidate.id=NEW.candidate_id AND candidate.project_id=NEW.project_id
        AND candidate.state='ready' AND candidate.version=NEW.candidate_version
        AND candidate.record_digest=NEW.candidate_record_digest) THEN
    RAISE EXCEPTION 'update candidate decision is stale' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control_role_grants g
      WHERE g.tenant_id=NEW.tenant_id AND g.identity_id=NEW.owner_identity_id AND g.role_key='owner'
        AND g.risk_ceiling IN ('high','critical') AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > NEW.decided_at)
        AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'updates.decide')
        AND (g.project_ids ? '*' OR g.project_ids ? NEW.project_id)) THEN
    RAISE EXCEPTION 'update candidate decision needs the owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_update_candidate_decision_insert() FROM PUBLIC;
CREATE TRIGGER control_update_candidate_decisions_insert_guard BEFORE INSERT ON control_update_candidate_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_update_candidate_decision_insert();

-- The only transition is ready -> accepted/declined, one version up, and only
-- when the matching owner decision row already exists.
CREATE FUNCTION guard_update_candidate_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.state <> 'ready' OR NEW.state NOT IN ('accepted','declined') OR NEW.version <> OLD.version + 1
    OR (to_jsonb(NEW)-ARRAY['state','version','decided_at'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','decided_at']) THEN
    RAISE EXCEPTION 'update candidate transition rejected' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control_update_candidate_decisions d
      WHERE d.tenant_id=OLD.tenant_id AND d.candidate_id=OLD.id AND d.candidate_version=OLD.version
        AND d.candidate_record_digest=OLD.record_digest AND d.decided_at=NEW.decided_at
        AND d.decision = CASE NEW.state WHEN 'accepted' THEN 'accept' ELSE 'decline' END) THEN
    RAISE EXCEPTION 'update candidate transition has no owner decision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_update_candidate_update() FROM PUBLIC;
CREATE TRIGGER control_update_candidates_update_guard BEFORE UPDATE ON control_update_candidates
  FOR EACH ROW EXECUTE FUNCTION guard_update_candidate_update();
