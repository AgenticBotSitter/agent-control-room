CREATE TABLE IF NOT EXISTS workspace_agent_grants (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  allowed_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_id)
);

CREATE TABLE IF NOT EXISTS project_worker_allocations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worker_id text NOT NULL REFERENCES worker_runtimes(id) ON DELETE CASCADE,
  capability_id text REFERENCES capabilities(id) ON DELETE RESTRICT,
  allocation_mode text NOT NULL CHECK (allocation_mode IN ('exclusive', 'preferred', 'shared', 'opportunistic', 'manual')),
  min_share numeric(5,2) NOT NULL DEFAULT 0 CHECK (min_share BETWEEN 0 AND 100),
  target_share numeric(5,2) NOT NULL DEFAULT 0 CHECK (target_share BETWEEN 0 AND 100),
  max_share numeric(5,2) NOT NULL DEFAULT 100 CHECK (max_share BETWEEN 0 AND 100),
  schedule jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, worker_id, capability_id)
);

CREATE TABLE IF NOT EXISTS capability_benchmarks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  route_id text NOT NULL REFERENCES worker_capability_routes(id) ON DELETE CASCADE,
  benchmark_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('passed', 'passed_slow', 'failed', 'expired')),
  score numeric(12,4),
  duration_seconds numeric(14,3),
  safe_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  environment_fingerprint text NOT NULL,
  observed_at timestamptz NOT NULL,
  UNIQUE (route_id, benchmark_version, environment_fingerprint)
);

CREATE TABLE IF NOT EXISTS simulator_runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  input_snapshot jsonb NOT NULL,
  decision jsonb NOT NULL,
  explanation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recommendations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  worker_id text REFERENCES worker_runtimes(id) ON DELETE SET NULL,
  recommendation_type text NOT NULL,
  title text NOT NULL,
  evidence jsonb NOT NULL,
  assumptions jsonb NOT NULL,
  projected_impact jsonb NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_allocations_worker_project ON project_worker_allocations(worker_id, project_id);
CREATE INDEX IF NOT EXISTS idx_benchmarks_route_observed ON capability_benchmarks(route_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_scope_status ON recommendations(tenant_id, workspace_id, project_id, status);

CREATE OR REPLACE FUNCTION reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'append-only relation % does not permit %', TG_TABLE_NAME, TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
DROP TRIGGER IF EXISTS projection_changes_append_only ON projection_changes;
CREATE TRIGGER projection_changes_append_only
BEFORE UPDATE OR DELETE ON projection_changes
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS command_receipts_append_only ON command_receipts;
CREATE TRIGGER command_receipts_append_only
BEFORE UPDATE OR DELETE ON command_receipts
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
