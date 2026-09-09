CREATE TABLE control_abs_story_archives (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  archived boolean NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,workspace_id,project_id,story_id,revision),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER control_abs_story_archives_immutable BEFORE UPDATE OR DELETE ON control_abs_story_archives
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_abs_story_archives_no_truncate BEFORE TRUNCATE ON control_abs_story_archives
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
