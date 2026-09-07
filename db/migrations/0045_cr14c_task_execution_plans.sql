-- Planning lineage is not a scheduler or an approval. No private-web privileges are added.
CREATE TABLE control_task_execution_plans (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  source_job_id text NOT NULL,
  job_id text NOT NULL,
  plan jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,source_job_id),
  UNIQUE (tenant_id,job_id),
  FOREIGN KEY (tenant_id,source_job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT
);
CREATE TRIGGER control_task_execution_plans_immutable BEFORE UPDATE OR DELETE ON control_task_execution_plans
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_task_execution_plans_no_truncate BEFORE TRUNCATE ON control_task_execution_plans
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
