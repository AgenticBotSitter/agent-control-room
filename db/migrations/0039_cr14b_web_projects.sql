-- Supplemental state for ordinary browser sessions and manually created projects.
-- Identity/grant and project records remain the existing canonical tables.
CREATE TABLE control_web_sessions (
  tenant_id text NOT NULL,
  token_digest text NOT NULL CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  identity_id text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, token_digest),
  FOREIGN KEY (tenant_id, identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > issued_at)
);

CREATE TABLE control_manual_project_heads (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('active','paused','completed','archived')),
  version bigint NOT NULL CHECK (version > 0 AND version <= 9007199254740991),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE TABLE control_web_project_commands (
  tenant_id text NOT NULL,
  identity_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, identity_id, idempotency_key),
  FOREIGN KEY (tenant_id, identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER control_web_project_commands_append_only BEFORE UPDATE OR DELETE ON control_web_project_commands
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_web_project_commands_truncate_guard BEFORE TRUNCATE ON control_web_project_commands
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
