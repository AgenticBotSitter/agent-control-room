CREATE TABLE control_action_inbox (
  id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text,
  work_item_id text,
  kind text NOT NULL CHECK (kind IN ('approval','question','review','failure','ambiguity','incident','authority_expiry','native_session')),
  state text NOT NULL CHECK (state IN ('open','resolved','expired')),
  delivery_state text NOT NULL CHECK (delivery_state IN ('not_requested','pending','delivered','failed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id,id),
  CHECK (expires_at IS NULL OR expires_at >= created_at)
);
CREATE INDEX idx_control_action_inbox_open ON control_action_inbox(tenant_id,state,created_at DESC);

CREATE TABLE control_owner_focus_pins (
  id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  level text NOT NULL CHECK (level IN ('p0','today')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,project_id),
  CHECK (expires_at IS NULL OR expires_at >= created_at)
);

CREATE TABLE control_owner_focus_command_receipts (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  command_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,command_id),
  UNIQUE (tenant_id,idempotency_key)
);
