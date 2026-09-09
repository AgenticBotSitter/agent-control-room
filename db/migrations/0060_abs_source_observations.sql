-- Retained source health uses the same PostgreSQL authority as story versions.
-- No feed URL, response body, credential, runtime activation or role grant here.
CREATE TABLE control_abs_source_observations (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  source_id text NOT NULL,
  status_digest text NOT NULL CHECK (status_digest ~ '^sha256:[a-f0-9]{64}$'),
  checked_at timestamptz NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,workspace_id,project_id,source_id,status_digest),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX control_abs_source_latest ON control_abs_source_observations
  (tenant_id,workspace_id,project_id,source_id,checked_at DESC,sequence DESC);
CREATE TRIGGER control_abs_source_immutable BEFORE UPDATE OR DELETE ON control_abs_source_observations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_abs_source_no_truncate BEFORE TRUNCATE ON control_abs_source_observations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
