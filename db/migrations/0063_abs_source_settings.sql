CREATE TABLE control_abs_source_settings (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  source_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,workspace_id,project_id,source_id,revision),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER control_abs_source_settings_immutable BEFORE UPDATE OR DELETE ON control_abs_source_settings
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_abs_source_settings_no_truncate BEFORE TRUNCATE ON control_abs_source_settings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
