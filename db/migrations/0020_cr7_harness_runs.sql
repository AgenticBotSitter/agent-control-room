ALTER TABLE control_attempts ADD CONSTRAINT uq_control_attempts_harness_lineage UNIQUE (tenant_id,id,job_id,node_id);

CREATE TABLE control_harness_runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  node_id text NOT NULL,
  adapter_id text NOT NULL,
  harness text NOT NULL CHECK (harness IN ('hermes','codex','claude','other')),
  native_session_key_digest text NOT NULL CHECK (native_session_key_digest ~ '^sha256:[a-f0-9]{64}$'),
  parent_run_id text,
  revision_of_run_id text,
  state text NOT NULL CHECK (state IN ('discovered','starting','running','waiting_input','waiting_approval','cancelling','disconnected','succeeded','failed','cancelled')),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  run_digest text NOT NULL CHECK (run_digest ~ '^sha256:[a-f0-9]{64}$'),
  run_auth_tag text NOT NULL CHECK (run_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,node_id,adapter_id,native_session_key_digest),
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id,job_id,node_id) REFERENCES control_attempts(tenant_id,id,job_id,node_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,parent_run_id) REFERENCES control_harness_runs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,revision_of_run_id) REFERENCES control_harness_runs(tenant_id,id) ON DELETE RESTRICT,
  CHECK (parent_run_id IS NULL OR revision_of_run_id IS NULL),
  CHECK (parent_run_id IS NULL OR parent_run_id <> id),
  CHECK (revision_of_run_id IS NULL OR revision_of_run_id <> id),
  CHECK (updated_at >= created_at AND last_observed_at >= created_at)
);

CREATE TABLE control_harness_run_events (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  occurred_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('adapter','harness_read','control_room')),
  source_event_key_digest text NOT NULL CHECK (source_event_key_digest ~ '^sha256:[a-f0-9]{64}$'),
  event_digest text NOT NULL CHECK (event_digest ~ '^sha256:[a-f0-9]{64}$'),
  event_auth_tag text NOT NULL CHECK (event_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,run_id,sequence),
  UNIQUE (tenant_id,run_id,source_event_key_digest),
  FOREIGN KEY (tenant_id,run_id) REFERENCES control_harness_runs(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX idx_control_harness_runs_watch ON control_harness_runs(tenant_id,state,last_observed_at DESC);
CREATE INDEX idx_control_harness_events_run ON control_harness_run_events(tenant_id,run_id,sequence);

CREATE TRIGGER control_harness_run_events_append_only
BEFORE UPDATE OR DELETE ON control_harness_run_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER control_harness_run_events_truncate_guard
BEFORE TRUNCATE ON control_harness_run_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
