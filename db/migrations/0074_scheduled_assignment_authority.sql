-- Owner-authored standing authority and immutable effect-free assignment evidence.
-- Neither table is a scheduler, queue, native cancellation record, or execution grant.
CREATE TABLE control_schedule_assignment_policies (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  schedule_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','paused','revoked')),
  version integer NOT NULL CHECK (version >= 1),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  owner_identity_id text NOT NULL,
  owner_identity_digest text NOT NULL CHECK (owner_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  schedule_definition_digest text NOT NULL CHECK (schedule_definition_digest ~ '^sha256:[a-f0-9]{64}$'),
  source_bundle_digest text NOT NULL CHECK (source_bundle_digest ~ '^sha256:[a-f0-9]{64}$'),
  reusable_context_policy_digest text NOT NULL CHECK (reusable_context_policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  allowed_executor text NOT NULL,
  required_capability text NOT NULL,
  node_id text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK (valid_until > valid_from),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,schedule_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,schedule_id) REFERENCES control_schedules(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_scheduled_task_plans (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  schedule_id text NOT NULL,
  occurrence_key text NOT NULL,
  admission_receipt_digest text NOT NULL CHECK (admission_receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  policy_id text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version >= 1),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  owner_identity_id text NOT NULL,
  owner_identity_digest text NOT NULL CHECK (owner_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  context_binding_digest text NOT NULL CHECK (context_binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  planned_job_id text NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  planned_at timestamptz NOT NULL,
  starts_work boolean NOT NULL DEFAULT false CHECK (starts_work = false),
  grants_execution_authority boolean NOT NULL DEFAULT false CHECK (grants_execution_authority = false),
  PRIMARY KEY (tenant_id,schedule_id,occurrence_key),
  UNIQUE (tenant_id,planned_job_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,schedule_id,occurrence_key)
    REFERENCES control_scheduled_task_admissions(tenant_id,schedule_id,occurrence_key) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,policy_id) REFERENCES control_schedule_assignment_policies(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,planned_job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT
);
CREATE TRIGGER control_scheduled_task_plans_immutable
  BEFORE UPDATE OR DELETE ON control_scheduled_task_plans
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_scheduled_task_plans_no_truncate
  BEFORE TRUNCATE ON control_scheduled_task_plans
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE control_scheduled_task_assignments (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  schedule_id text NOT NULL,
  occurrence_key text NOT NULL,
  admission_receipt_digest text NOT NULL CHECK (admission_receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  policy_id text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version >= 1),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  owner_identity_id text NOT NULL,
  owner_identity_digest text NOT NULL CHECK (owner_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  context_binding_digest text NOT NULL CHECK (context_binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  planned_job_id text NOT NULL,
  attempt_id text NOT NULL,
  lease_id text NOT NULL,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  assigned_at timestamptz NOT NULL,
  starts_work boolean NOT NULL DEFAULT false CHECK (starts_work = false),
  grants_execution_authority boolean NOT NULL DEFAULT false CHECK (grants_execution_authority = false),
  claims_native_cancellation boolean NOT NULL DEFAULT false CHECK (claims_native_cancellation = false),
  releases_capacity boolean NOT NULL DEFAULT false CHECK (releases_capacity = false),
  PRIMARY KEY (tenant_id,schedule_id,occurrence_key),
  UNIQUE (tenant_id,planned_job_id),
  UNIQUE (tenant_id,attempt_id),
  UNIQUE (tenant_id,lease_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,schedule_id,occurrence_key)
    REFERENCES control_scheduled_task_plans(tenant_id,schedule_id,occurrence_key) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,policy_id) REFERENCES control_schedule_assignment_policies(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,planned_job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,lease_id) REFERENCES control_leases(tenant_id,id) ON DELETE RESTRICT
);

CREATE TRIGGER control_scheduled_task_assignments_immutable
  BEFORE UPDATE OR DELETE ON control_scheduled_task_assignments
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_scheduled_task_assignments_no_truncate
  BEFORE TRUNCATE ON control_scheduled_task_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
