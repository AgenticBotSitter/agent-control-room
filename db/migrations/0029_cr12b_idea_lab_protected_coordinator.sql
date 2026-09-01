-- CR12B-IDEA-030: append-only Bot Mode execution truth and owner-bound promotion evidence.

CREATE TABLE control_idea_bot_run_events (
  run_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared','running','completed','cancelled','failed_definite','ambiguous')),
  run_digest text NOT NULL CHECK (run_digest ~ '^sha256:[a-f0-9]{64}$'),
  run_auth_tag text NOT NULL CHECK (run_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (run_id,version),
  UNIQUE (tenant_id,run_digest),
  FOREIGN KEY (tenant_id,session_id) REFERENCES control_idea_sessions(tenant_id,session_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_idea_owner_authorizations (
  authorization_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  idea_decision_id text NOT NULL,
  policy_decision_id text NOT NULL,
  owner_identity_id text NOT NULL,
  owner_identity_digest text NOT NULL CHECK (owner_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  authorization_digest text NOT NULL CHECK (authorization_digest ~ '^sha256:[a-f0-9]{64}$'),
  authorization_auth_tag text NOT NULL CHECK (authorization_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  authorized_at timestamptz NOT NULL,
  UNIQUE (tenant_id,session_id),
  UNIQUE (tenant_id,idea_decision_id),
  UNIQUE (tenant_id,policy_decision_id),
  FOREIGN KEY (tenant_id,session_id) REFERENCES control_idea_sessions(tenant_id,session_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,policy_decision_id) REFERENCES control_policy_decisions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX idx_control_idea_bot_run_latest ON control_idea_bot_run_events(run_id,version DESC);

CREATE TRIGGER control_idea_bot_run_events_append_only BEFORE UPDATE OR DELETE ON control_idea_bot_run_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_bot_run_events_truncate_guard BEFORE TRUNCATE ON control_idea_bot_run_events FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_owner_authorizations_append_only BEFORE UPDATE OR DELETE ON control_idea_owner_authorizations FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_owner_authorizations_truncate_guard BEFORE TRUNCATE ON control_idea_owner_authorizations FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
