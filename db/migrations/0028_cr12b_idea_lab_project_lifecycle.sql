-- CR12B: bounded business-idea panels, owner promotion, and durable project lifecycle history.

CREATE TABLE control_idea_sessions (
  session_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  session_digest text NOT NULL CHECK (session_digest ~ '^sha256:[a-f0-9]{64}$'),
  session_auth_tag text NOT NULL CHECK (session_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  participant_count integer NOT NULL CHECK (participant_count BETWEEN 3 AND 6),
  max_rounds integer NOT NULL CHECK (max_rounds BETWEEN 1 AND 3),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id,session_id),
  UNIQUE (tenant_id,session_digest),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_idea_contributions (
  contribution_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  session_digest text NOT NULL CHECK (session_digest ~ '^sha256:[a-f0-9]{64}$'),
  participant_id text NOT NULL,
  round integer NOT NULL CHECK (round BETWEEN 1 AND 3),
  contribution_digest text NOT NULL CHECK (contribution_digest ~ '^sha256:[a-f0-9]{64}$'),
  contribution_auth_tag text NOT NULL CHECK (contribution_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  contributed_at timestamptz NOT NULL,
  UNIQUE (tenant_id,contribution_id),
  UNIQUE (tenant_id,contribution_digest),
  UNIQUE (tenant_id,session_id,participant_id,round),
  FOREIGN KEY (tenant_id,session_id) REFERENCES control_idea_sessions(tenant_id,session_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,session_digest) REFERENCES control_idea_sessions(tenant_id,session_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_idea_syntheses (
  synthesis_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  session_digest text NOT NULL CHECK (session_digest ~ '^sha256:[a-f0-9]{64}$'),
  synthesis_digest text NOT NULL CHECK (synthesis_digest ~ '^sha256:[a-f0-9]{64}$'),
  synthesis_auth_tag text NOT NULL CHECK (synthesis_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  recommendation text NOT NULL CHECK (recommendation IN ('promote','save','reject')),
  overall_score integer NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  payload jsonb NOT NULL,
  synthesized_at timestamptz NOT NULL,
  UNIQUE (tenant_id,synthesis_id),
  UNIQUE (tenant_id,session_id),
  UNIQUE (tenant_id,synthesis_digest),
  FOREIGN KEY (tenant_id,session_id) REFERENCES control_idea_sessions(tenant_id,session_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,session_digest) REFERENCES control_idea_sessions(tenant_id,session_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_idea_decisions (
  decision_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  synthesis_digest text NOT NULL CHECK (synthesis_digest ~ '^sha256:[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('create_project','save','reject')),
  project_id text,
  decision_digest text NOT NULL CHECK (decision_digest ~ '^sha256:[a-f0-9]{64}$'),
  decision_auth_tag text NOT NULL CHECK (decision_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  decided_at timestamptz NOT NULL,
  CHECK ((decision = 'create_project') = (project_id IS NOT NULL)),
  UNIQUE (tenant_id,decision_id),
  UNIQUE (tenant_id,session_id),
  UNIQUE (tenant_id,decision_digest),
  FOREIGN KEY (tenant_id,session_id) REFERENCES control_idea_sessions(tenant_id,session_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,synthesis_digest) REFERENCES control_idea_syntheses(tenant_id,synthesis_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_project_lifecycle_events (
  event_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  source_idea_session_id text NOT NULL,
  source_decision_digest text NOT NULL CHECK (source_decision_digest ~ '^sha256:[a-f0-9]{64}$'),
  from_state text CHECK (from_state IS NULL OR from_state IN ('active','paused','completed','archived')),
  to_state text NOT NULL CHECK (to_state IN ('active','paused','completed','archived')),
  version bigint NOT NULL CHECK (version > 0),
  project_snapshot_digest text NOT NULL CHECK (project_snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  event_digest text NOT NULL CHECK (event_digest ~ '^sha256:[a-f0-9]{64}$'),
  event_auth_tag text NOT NULL CHECK (event_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  CHECK ((version = 1 AND from_state IS NULL) OR (version > 1 AND from_state IS NOT NULL)),
  UNIQUE (tenant_id,event_id),
  UNIQUE (tenant_id,event_digest),
  UNIQUE (tenant_id,project_id,version),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_idea_session_id) REFERENCES control_idea_sessions(tenant_id,session_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_decision_digest) REFERENCES control_idea_decisions(tenant_id,decision_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE control_idea_decisions
  ADD FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_control_idea_contributions_session ON control_idea_contributions(tenant_id,session_id,round,participant_id);
CREATE INDEX idx_control_project_lifecycle_latest ON control_project_lifecycle_events(tenant_id,project_id,version DESC);

CREATE TRIGGER control_idea_sessions_append_only BEFORE UPDATE OR DELETE ON control_idea_sessions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_contributions_append_only BEFORE UPDATE OR DELETE ON control_idea_contributions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_syntheses_append_only BEFORE UPDATE OR DELETE ON control_idea_syntheses FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_decisions_append_only BEFORE UPDATE OR DELETE ON control_idea_decisions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_project_lifecycle_events_append_only BEFORE UPDATE OR DELETE ON control_project_lifecycle_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_sessions_truncate_guard BEFORE TRUNCATE ON control_idea_sessions FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_contributions_truncate_guard BEFORE TRUNCATE ON control_idea_contributions FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_syntheses_truncate_guard BEFORE TRUNCATE ON control_idea_syntheses FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_decisions_truncate_guard BEFORE TRUNCATE ON control_idea_decisions FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_project_lifecycle_events_truncate_guard BEFORE TRUNCATE ON control_project_lifecycle_events FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
