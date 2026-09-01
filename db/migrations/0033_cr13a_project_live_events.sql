-- CR13A-LIVE-000: authenticated, append-only project activity stream.

CREATE TABLE control_project_event_stream_heads (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_event_digest text CHECK (last_event_digest IS NULL OR last_event_digest ~ '^sha256:[a-f0-9]{64}$'),
  head_auth_tag text NOT NULL CHECK (head_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,project_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((last_sequence=0 AND last_event_digest IS NULL) OR (last_sequence>0 AND last_event_digest IS NOT NULL))
);

CREATE TABLE control_project_events (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_id text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN (
    'project','work','agent','review','attention','artifact','automation','transport','system'
  )),
  source_kind text NOT NULL CHECK (source_kind IN (
    'control_room','idea_lab','harness','job','review','node','automation','project_adapter'
  )),
  source_id text NOT NULL,
  source_version text NOT NULL,
  source_event_key_digest text NOT NULL CHECK (source_event_key_digest ~ '^sha256:[a-f0-9]{64}$'),
  source_payload_digest text NOT NULL CHECK (source_payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  previous_event_digest text CHECK (previous_event_digest IS NULL OR previous_event_digest ~ '^sha256:[a-f0-9]{64}$'),
  event_digest text NOT NULL UNIQUE CHECK (event_digest ~ '^sha256:[a-f0-9]{64}$'),
  event_auth_tag text NOT NULL CHECK (event_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id,project_id,sequence),
  UNIQUE (tenant_id,event_id),
  UNIQUE (tenant_id,project_id,source_event_key_digest),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((sequence=1 AND previous_event_digest IS NULL) OR (sequence>1 AND previous_event_digest IS NOT NULL)),
  CHECK (recorded_at >= occurred_at - interval '365 days')
);

CREATE INDEX idx_control_project_events_replay
  ON control_project_events(tenant_id,project_id,sequence);
CREATE INDEX idx_control_project_events_recent
  ON control_project_events(tenant_id,project_id,occurred_at DESC,sequence DESC);

CREATE TRIGGER control_project_events_append_only
  BEFORE UPDATE OR DELETE ON control_project_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_project_events_truncate_guard
  BEFORE TRUNCATE ON control_project_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
