-- Per-task model evidence and assignment ownership scopes (2026-09-27).
-- Browser drafts may request a protected choice, but only the coordinator may
-- materialize the worker-resolved model/provider/profile used for execution.
CREATE TABLE control_task_model_selections (
  tenant_id text NOT NULL REFERENCES tenants(id),
  project_id text NOT NULL,
  job_id text NOT NULL,
  worker_kind text,
  selection_key text,
  model text,
  effort text,
  provider text,
  profile text,
  inherited_from_job_id text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, job_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES control_jobs(tenant_id, id),
  CHECK (worker_kind IS NULL OR worker_kind IN ('codex','claude-code','hermes')),
  CHECK (selection_key IS NULL OR selection_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$'),
  CHECK (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$'),
  CHECK (effort IS NULL OR effort IN ('default','low','medium','high','xhigh','max')),
  CHECK (provider IS NULL OR provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$'),
  CHECK (profile IS NULL OR profile ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$'),
  CHECK ((worker_kind IS NULL AND model IS NULL AND provider IS NULL AND profile IS NULL)
    OR (worker_kind IS NOT NULL AND selection_key IS NOT NULL AND model IS NOT NULL AND effort IS NOT NULL)),
  CHECK ((worker_kind = 'hermes') = (provider IS NOT NULL AND profile IS NOT NULL))
);

-- Proposal scopes reuse the canonical repository-relative file/tree grammar.
CREATE TABLE control_task_declared_scopes (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('file','tree')),
  path text NOT NULL,
  path_fold text NOT NULL,
  PRIMARY KEY (tenant_id, job_id, scope_kind, path_fold),
  FOREIGN KEY (tenant_id, job_id) REFERENCES control_jobs(tenant_id, id),
  CHECK (path = path_fold),
  CHECK ((scope_kind='tree' AND path='') OR path ~ '^[a-z0-9_][a-z0-9._-]{0,127}(/[a-z0-9_][a-z0-9._-]{0,127})*$')
);

-- These are scopes owned by control_leases, not a second lease authority.
-- Terminal/released/expired canonical leases cease to conflict automatically.
CREATE TABLE control_assignment_lease_scopes (
  tenant_id text NOT NULL,
  lease_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  node_id text NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('file','tree')),
  path text NOT NULL,
  path_fold text NOT NULL,
  PRIMARY KEY (tenant_id, lease_id, scope_kind, path_fold),
  FOREIGN KEY (tenant_id, lease_id) REFERENCES control_leases(tenant_id, id),
  CHECK (path = path_fold),
  CHECK ((scope_kind='tree' AND path='') OR path ~ '^[a-z0-9_][a-z0-9._-]{0,127}(/[a-z0-9_][a-z0-9._-]{0,127})*$')
);

CREATE INDEX control_assignment_lease_scopes_project_path
  ON control_assignment_lease_scopes(tenant_id, project_id, scope_kind, path_fold);
