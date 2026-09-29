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

