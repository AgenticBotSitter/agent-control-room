CREATE TABLE control_ready_frontier_handoffs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (request_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$'),
  project_id text NOT NULL CHECK (project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$'),
  job_id text NOT NULL,
  reservation_id text NOT NULL,
  state text NOT NULL CHECK (state = 'pending_internal_handoff'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  available_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > available_at),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,request_id),
  UNIQUE (tenant_id,job_id),
  UNIQUE (tenant_id,reservation_id),
  FOREIGN KEY (tenant_id,job_id) REFERENCES control_jobs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,reservation_id) REFERENCES control_resource_reservations(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX idx_control_ready_frontier_handoffs_pending
  ON control_ready_frontier_handoffs(tenant_id,state,available_at);
