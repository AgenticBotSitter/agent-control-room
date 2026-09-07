-- Borrowed discovery memory belongs to the same PostgreSQL authority as articles.
CREATE TABLE control_abs_discovery_baselines (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  source_id text NOT NULL,
  source_url text NOT NULL,
  checked_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, workspace_id, project_id, source_id, source_url, checked_at),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER control_abs_discovery_baseline_immutable BEFORE UPDATE OR DELETE ON control_abs_discovery_baselines
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_abs_discovery_baseline_no_truncate BEFORE TRUNCATE ON control_abs_discovery_baselines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
