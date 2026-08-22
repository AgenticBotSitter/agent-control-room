CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS adapter_registry (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  source_system text NOT NULL,
  contract_version text NOT NULL,
  authority_mode text NOT NULL CHECK (authority_mode IN ('control_room_native', 'source_scheduled', 'advisory')),
  status text NOT NULL DEFAULT 'fixture' CHECK (status IN ('fixture', 'pending', 'online', 'degraded', 'offline', 'disabled')),
  project_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  supported_read_operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  supported_commands jsonb NOT NULL DEFAULT '[]'::jsonb,
  redaction_policy_version text NOT NULL,
  cursor_retention_days integer NOT NULL CHECK (cursor_retention_days > 0),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system, id)
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  adapter_id text NOT NULL REFERENCES adapter_registry(id) ON DELETE RESTRICT,
  source_record_id text NOT NULL,
  source_version text NOT NULL,
  source_checksum text,
  title text NOT NULL,
  description text,
  deep_link text,
  normalized_state text NOT NULL CHECK (normalized_state IN ('planned', 'ready', 'running', 'waiting', 'blocked', 'needs_attention', 'review', 'complete', 'failed', 'cancelled')),
  domain_state text NOT NULL,
  health text NOT NULL CHECK (health IN ('healthy', 'watch', 'at_risk', 'blocked')),
  progress_percent numeric(5,2) CHECK (progress_percent BETWEEN 0 AND 100),
  forecast_at timestamptz,
  attention_count integer NOT NULL DEFAULT 0 CHECK (attention_count >= 0),
  blocker_count integer NOT NULL DEFAULT 0 CHECK (blocker_count >= 0),
  priority integer NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  authority_mode text NOT NULL CHECK (authority_mode IN ('control_room_native', 'source_scheduled', 'advisory')),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adapter_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS work_items (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  adapter_id text NOT NULL REFERENCES adapter_registry(id) ON DELETE RESTRICT,
  source_record_id text NOT NULL,
  source_version text NOT NULL,
  title text NOT NULL,
  deep_link text,
  normalized_state text NOT NULL CHECK (normalized_state IN ('planned', 'ready', 'running', 'waiting', 'blocked', 'needs_attention', 'review', 'complete', 'failed', 'cancelled')),
  domain_state text NOT NULL,
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 100),
  progress_percent numeric(5,2) CHECK (progress_percent BETWEEN 0 AND 100),
  required_capability text,
  current_worker_id text,
  current_agent_id text,
  placement_policy jsonb,
  downstream_unlock_count integer NOT NULL DEFAULT 0 CHECK (downstream_unlock_count >= 0),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adapter_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS executions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id text NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  adapter_id text NOT NULL REFERENCES adapter_registry(id) ON DELETE RESTRICT,
  source_record_id text NOT NULL,
  source_version text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  state text NOT NULL CHECK (state IN ('queued', 'leased', 'running', 'paused', 'succeeded', 'failed')),
  worker_id text,
  agent_id text,
  route_id text,
  progress_percent numeric(5,2) CHECK (progress_percent BETWEEN 0 AND 100),
  lease_observed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  safe_failure_code text,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adapter_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS blockers (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id text REFERENCES work_items(id) ON DELETE SET NULL,
  adapter_id text NOT NULL REFERENCES adapter_registry(id) ON DELETE RESTRICT,
  source_record_id text NOT NULL,
  source_version text NOT NULL,
  blocker_type text NOT NULL,
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  responsible_role text NOT NULL CHECK (responsible_role IN ('system', 'operator', 'customer', 'project', 'provider')),
  safe_remedy text,
  deep_link text,
  opened_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adapter_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS attention_items (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id text REFERENCES work_items(id) ON DELETE SET NULL,
  adapter_id text NOT NULL REFERENCES adapter_registry(id) ON DELETE RESTRICT,
  source_record_id text NOT NULL,
  source_version text NOT NULL,
  attention_type text NOT NULL CHECK (attention_type IN ('approval', 'question', 'review', 'decision')),
  title text NOT NULL,
  summary text NOT NULL,
  deep_link text,
  due_at timestamptz,
  created_at_source timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adapter_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS machine_nodes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  editable_name text NOT NULL,
  os text NOT NULL CHECK (os IN ('windows', 'macos', 'linux', 'cloud')),
  hardware_fingerprint text,
  inventory jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_runtimes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  machine_id text NOT NULL REFERENCES machine_nodes(id) ON DELETE RESTRICT,
  editable_name text NOT NULL,
  state text NOT NULL CHECK (state IN ('online', 'idle', 'busy', 'draining', 'degraded', 'offline', 'maintenance')),
  state_reason text,
  software_fingerprint text,
  available_slots integer NOT NULL DEFAULT 0 CHECK (available_slots >= 0),
  total_slots integer NOT NULL DEFAULT 1 CHECK (total_slots > 0),
  scratch_class text NOT NULL CHECK (scratch_class IN ('healthy', 'caution', 'low', 'critical')),
  allocation_mode text NOT NULL CHECK (allocation_mode IN ('exclusive', 'preferred', 'shared', 'opportunistic', 'manual')),
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_identities (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  editable_name text NOT NULL,
  agent_type text NOT NULL CHECK (agent_type IN ('hermes', 'manager', 'human', 'service')),
  state text NOT NULL CHECK (state IN ('available', 'working', 'waiting', 'offline')),
  allowed_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_work_item_id text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS capabilities (
  id text PRIMARY KEY,
  capability_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  category text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_capability_routes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  worker_id text NOT NULL REFERENCES worker_runtimes(id) ON DELETE CASCADE,
  capability_id text NOT NULL REFERENCES capabilities(id) ON DELETE RESTRICT,
  runtime_name text NOT NULL,
  verification text NOT NULL CHECK (verification IN ('verified', 'provisional', 'expired', 'unavailable')),
  estimated_duration_minutes numeric(12,2),
  estimated_cost_usd numeric(12,4),
  quality_class text,
  privacy_class text CHECK (privacy_class IN ('local', 'approved_provider', 'restricted')),
  benchmark_version text,
  benchmark_observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (worker_id, capability_id, runtime_name)
);

CREATE TABLE IF NOT EXISTS projection_cursors (
  adapter_id text NOT NULL REFERENCES adapter_registry(id) ON DELETE CASCADE,
  stream text NOT NULL,
  cursor_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (adapter_id, stream)
);

CREATE TABLE IF NOT EXISTS projection_changes (
  adapter_id text NOT NULL REFERENCES adapter_registry(id) ON DELETE CASCADE,
  stream text NOT NULL,
  sequence bigint NOT NULL,
  cursor_value text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert', 'remove')),
  record_kind text NOT NULL CHECK (record_kind IN ('project', 'work_item', 'execution', 'blocker', 'attention', 'worker', 'agent')),
  record_id text NOT NULL,
  source_version text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (adapter_id, stream, sequence),
  UNIQUE (adapter_id, stream, record_id, source_version)
);

CREATE TABLE IF NOT EXISTS command_receipts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  adapter_id text NOT NULL REFERENCES adapter_registry(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  source_command_id text,
  status text NOT NULL CHECK (status IN ('accepted', 'rejected', 'already_applied', 'scheduled')),
  expected_version text,
  applied_version text,
  safe_reason_code text,
  safe_message text NOT NULL,
  requested_by_id text NOT NULL,
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('human', 'agent', 'service')),
  received_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (adapter_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent', 'worker', 'service', 'adapter')),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  correlation_id text,
  idempotency_key text,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_tenant_workspace_state ON projects(tenant_id, workspace_id, normalized_state);
CREATE INDEX IF NOT EXISTS idx_work_items_project_state_priority ON work_items(project_id, normalized_state, priority DESC);
CREATE INDEX IF NOT EXISTS idx_executions_project_state ON executions(project_id, state);
CREATE INDEX IF NOT EXISTS idx_blockers_project_severity ON blockers(project_id, severity, opened_at);
CREATE INDEX IF NOT EXISTS idx_attention_project_due ON attention_items(project_id, due_at);
CREATE INDEX IF NOT EXISTS idx_workers_machine_state ON worker_runtimes(machine_id, state);
CREATE INDEX IF NOT EXISTS idx_audit_scope_time ON audit_events(tenant_id, workspace_id, project_id, occurred_at DESC);
