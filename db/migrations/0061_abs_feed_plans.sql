-- Immutable proposed feed inputs. Jobs/leases/effects remain canonical domain records.
CREATE TABLE control_abs_feed_plans (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,job_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id) REFERENCES control_jobs(tenant_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER control_abs_feed_plan_immutable BEFORE UPDATE OR DELETE ON control_abs_feed_plans
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_abs_feed_plan_no_truncate BEFORE TRUNCATE ON control_abs_feed_plans
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
