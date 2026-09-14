-- Durable shared-work declarations. A lease timeout or disconnect never releases
-- one of these holders; only separately verified no-start/process-retirement does.

ALTER TABLE control_leases
  ADD CONSTRAINT uq_control_leases_resource_lineage
  UNIQUE (tenant_id,id,job_id,attempt_id,node_id);

CREATE TABLE control_work_resources (
  tenant_id text NOT NULL,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('repository','logical')),
  canonical_key text NOT NULL CHECK (canonical_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$'),
  comparison_key text NOT NULL CHECK (comparison_key=lower(canonical_key)),
  configuration_digest text NOT NULL CHECK (configuration_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL,
  coordinator_lock boolean NOT NULL DEFAULT false CHECK (coordinator_lock IS FALSE),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,comparison_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
CREATE TRIGGER control_work_resources_no_mutation
  BEFORE UPDATE OR DELETE ON control_work_resources
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_work_resources_no_truncate
  BEFORE TRUNCATE ON control_work_resources
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE control_attempt_resource_admissions (
  tenant_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  lease_id text NOT NULL,
  node_id text NOT NULL,
  repository_resource_id text NOT NULL,
  base_revision text NOT NULL CHECK (char_length(base_revision) BETWEEN 1 AND 180
    AND base_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]*$'),
  workspace_intent_digest text NOT NULL CHECK (workspace_intent_digest ~ '^sha256:[a-f0-9]{64}$'),
  declaration_digest text NOT NULL CHECK (declaration_digest ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('held','retired')),
  version bigint NOT NULL CHECK (version >= 1),
  acquired_at timestamptz NOT NULL,
  retired_at timestamptz,
  retirement_kind text CHECK (retirement_kind IS NULL OR retirement_kind IN ('trusted_no_start','trusted_process_retired')),
  retirement_proof_digest text CHECK (retirement_proof_digest IS NULL OR retirement_proof_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  coordinator_lock boolean NOT NULL DEFAULT false CHECK (coordinator_lock IS FALSE),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,attempt_id),
  UNIQUE (tenant_id,lease_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id,job_id,node_id)
    REFERENCES control_attempts(tenant_id,id,job_id,node_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,lease_id,job_id,attempt_id,node_id)
    REFERENCES control_leases(tenant_id,id,job_id,attempt_id,node_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,repository_resource_id)
    REFERENCES control_work_resources(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((state='held' AND retired_at IS NULL AND retirement_kind IS NULL AND retirement_proof_digest IS NULL)
    OR (state='retired' AND retired_at IS NOT NULL AND retirement_kind IS NOT NULL
      AND retirement_proof_digest IS NOT NULL AND retired_at>=acquired_at))
);
CREATE INDEX idx_control_attempt_resource_admissions_held
  ON control_attempt_resource_admissions(tenant_id,repository_resource_id,attempt_id)
  WHERE state='held';

CREATE FUNCTION guard_attempt_resource_admission_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state<>'held' OR NEW.state<>'retired' OR NEW.version<>OLD.version+1
    OR (to_jsonb(NEW)-ARRAY['state','version','retired_at','retirement_kind','retirement_proof_digest'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','retired_at','retirement_kind','retirement_proof_digest']) THEN
    RAISE EXCEPTION 'attempt resource admission update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_attempt_resource_admission_update() FROM PUBLIC;
CREATE TRIGGER control_attempt_resource_admissions_guard
  BEFORE UPDATE ON control_attempt_resource_admissions
  FOR EACH ROW EXECUTE FUNCTION guard_attempt_resource_admission_update();
CREATE TRIGGER control_attempt_resource_admissions_no_delete
  BEFORE DELETE ON control_attempt_resource_admissions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_attempt_resource_admissions_no_truncate
  BEFORE TRUNCATE ON control_attempt_resource_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE control_attempt_resource_scopes (
  tenant_id text NOT NULL,
  admission_id text NOT NULL,
  resource_id text NOT NULL,
  access_mode text NOT NULL CHECK (access_mode IN ('read','write')),
  scope_kind text NOT NULL CHECK (scope_kind IN ('file','tree','logical')),
  path text NOT NULL,
  path_fold text NOT NULL CHECK (path_fold=lower(path)),
  coordinator_lock boolean NOT NULL DEFAULT false CHECK (coordinator_lock IS FALSE),
  PRIMARY KEY (tenant_id,admission_id,resource_id,scope_kind,path_fold),
  FOREIGN KEY (tenant_id,admission_id)
    REFERENCES control_attempt_resource_admissions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,resource_id)
    REFERENCES control_work_resources(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((scope_kind='logical' AND path='' AND path_fold='')
    OR (scope_kind='tree' AND path='' AND path_fold='')
    OR (scope_kind IN ('file','tree') AND char_length(path) BETWEEN 1 AND 512
      AND path ~ '^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9_][A-Za-z0-9._-]{0,127})*$'))
);
CREATE INDEX idx_control_attempt_resource_scopes_conflict
  ON control_attempt_resource_scopes(tenant_id,resource_id,access_mode,path_fold);
CREATE TRIGGER control_attempt_resource_scopes_no_mutation
  BEFORE UPDATE OR DELETE ON control_attempt_resource_scopes
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_attempt_resource_scopes_no_truncate
  BEFORE TRUNCATE ON control_attempt_resource_scopes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
