CREATE TABLE control_node_fleet_signals (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  node_id text NOT NULL,
  signal_kind text NOT NULL CHECK (signal_kind IN ('discovery','telemetry','capability','benchmark')),
  signal_sequence bigint NOT NULL CHECK (signal_sequence > 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  trust text NOT NULL CHECK (trust IN ('reported','verified','blocked','unavailable')),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,node_id,signal_kind,signal_sequence),
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_node_fleet_current (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  node_id text NOT NULL,
  signal_kind text NOT NULL CHECK (signal_kind IN ('discovery','telemetry','capability','benchmark')),
  signal_sequence bigint NOT NULL CHECK (signal_sequence > 0),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  trust text NOT NULL CHECK (trust IN ('reported','verified','blocked','unavailable')),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id,node_id,signal_kind),
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX idx_control_node_fleet_current_freshness ON control_node_fleet_current(tenant_id,signal_kind,expires_at);
