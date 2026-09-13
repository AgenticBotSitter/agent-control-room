-- One immutable, inert canonical proposal receipt per exact schedule occurrence.
-- This table is neither a queue nor evidence that execution started.
CREATE TABLE control_scheduled_task_admissions (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  schedule_id text NOT NULL,
  occurrence_key text NOT NULL,
  source_request_id text NOT NULL,
  source_workflow_id text NOT NULL,
  source_job_id text NOT NULL,
  source_bundle_digest text NOT NULL CHECK (source_bundle_digest ~ '^sha256:[a-f0-9]{64}$'),
  schedule_definition_digest text NOT NULL CHECK (schedule_definition_digest ~ '^sha256:[a-f0-9]{64}$'),
  context_binding_digest text NOT NULL CHECK (context_binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  destination_request_id text NOT NULL,
  destination_workflow_id text NOT NULL,
  destination_job_id text NOT NULL,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  admitted_at timestamptz NOT NULL,
  starts_work boolean NOT NULL DEFAULT false CHECK (starts_work = false),
  grants_execution_authority boolean NOT NULL DEFAULT false CHECK (grants_execution_authority = false),
  permits_assignment boolean NOT NULL DEFAULT false CHECK (permits_assignment = false),
  permits_retry boolean NOT NULL DEFAULT false CHECK (permits_retry = false),
  permits_cancellation boolean NOT NULL DEFAULT false CHECK (permits_cancellation = false),
  PRIMARY KEY (tenant_id,schedule_id,occurrence_key),
  UNIQUE (tenant_id,destination_job_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,schedule_id,occurrence_key)
    REFERENCES control_schedule_occurrences(tenant_id,schedule_id,occurrence_key) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,schedule_id) REFERENCES control_schedules(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_request_id) REFERENCES control_requests(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_workflow_id) REFERENCES control_workflows(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_job_id) REFERENCES control_jobs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,destination_request_id) REFERENCES control_requests(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,destination_workflow_id) REFERENCES control_workflows(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,destination_job_id) REFERENCES control_jobs(tenant_id,id) ON DELETE RESTRICT
);

CREATE TRIGGER control_scheduled_task_admissions_append_only
  BEFORE UPDATE OR DELETE ON control_scheduled_task_admissions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_scheduled_task_admissions_truncate_guard
  BEFORE TRUNCATE ON control_scheduled_task_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
