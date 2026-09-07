-- CR13A-LIVE-020: protected, durable Hermes connection enrollment registry.

CREATE TABLE control_connection_registry_heads (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
  last_record_digest text CHECK (last_record_digest IS NULL OR last_record_digest ~ '^sha256:[a-f0-9]{64}$'),
  head_auth_tag text NOT NULL CHECK (head_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL,
  CHECK ((last_sequence=0 AND last_record_digest IS NULL) OR (last_sequence>0 AND last_record_digest IS NOT NULL))
);

CREATE TABLE control_connection_enrollments (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  connection_id text NOT NULL,
  enrollment_id text NOT NULL,
  node_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  sequence bigint NOT NULL CHECK (sequence > 0),
  result_digest text NOT NULL CHECK (result_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  previous_record_digest text CHECK (previous_record_digest IS NULL OR previous_record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_digest text NOT NULL UNIQUE CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id,connection_id,revision),
  UNIQUE (tenant_id,enrollment_id),
  UNIQUE (tenant_id,sequence),
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT,
  CHECK (expires_at > issued_at),
  CHECK (recorded_at >= issued_at - interval '5 minutes'),
  CHECK ((sequence=1 AND previous_record_digest IS NULL) OR (sequence>1 AND previous_record_digest IS NOT NULL))
);

CREATE INDEX idx_control_connection_enrollments_current
  ON control_connection_enrollments(tenant_id,connection_id,revision DESC);
CREATE INDEX idx_control_connection_enrollments_expiry
  ON control_connection_enrollments(tenant_id,expires_at);
CREATE INDEX idx_control_connection_enrollments_chain
  ON control_connection_enrollments(tenant_id,sequence);

CREATE TRIGGER control_connection_enrollments_append_only
  BEFORE UPDATE OR DELETE ON control_connection_enrollments
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_connection_enrollments_truncate_guard
  BEFORE TRUNCATE ON control_connection_enrollments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- This is deliberately separate from control_node_fleet_current. The fleet
-- projection can be rebuilt or directly repaired, while this receipt may be
-- written only by the authenticated node-protocol ingress with the server key.
CREATE TABLE control_connection_authenticated_telemetry_receipts (
  tenant_id text NOT NULL,
  node_id text NOT NULL,
  signal_sequence bigint NOT NULL CHECK (signal_sequence > 0),
  signal_digest text NOT NULL CHECK (signal_digest ~ '^sha256:[a-f0-9]{64}$'),
  message_id_digest text NOT NULL CHECK (message_id_digest ~ '^sha256:[a-f0-9]{64}$'),
  key_id_digest text NOT NULL CHECK (key_id_digest ~ '^sha256:[a-f0-9]{64}$'),
  connection_id_digest text NOT NULL CHECK (connection_id_digest ~ '^sha256:[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  authenticated_at timestamptz NOT NULL,
  receipt_auth_tag text NOT NULL CHECK (receipt_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,node_id),
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT,
  CHECK (expires_at > observed_at),
  CHECK (authenticated_at >= observed_at - interval '5 minutes')
);
