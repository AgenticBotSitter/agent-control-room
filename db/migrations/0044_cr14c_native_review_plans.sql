-- Trusted planner only. The private web role receives no privileges on this table.
CREATE TABLE control_native_review_plans (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  run_id text NOT NULL,
  plan jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,run_id),
  UNIQUE (tenant_id,job_id),
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id) REFERENCES control_harness_runs(tenant_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER control_native_review_plans_immutable BEFORE UPDATE OR DELETE ON control_native_review_plans
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_native_review_plans_no_truncate BEFORE TRUNCATE ON control_native_review_plans
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
