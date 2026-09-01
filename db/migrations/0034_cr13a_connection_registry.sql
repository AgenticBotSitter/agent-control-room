-- CR13A-LIVE-020: protected, durable Hermes connection enrollment registry.

CREATE TABLE control_connection_enrollments (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  connection_id text NOT NULL,
  enrollment_id text NOT NULL,
  node_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  result_digest text NOT NULL CHECK (result_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id,connection_id,revision),
  UNIQUE (tenant_id,enrollment_id),
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT,
  CHECK (expires_at > issued_at),
  CHECK (recorded_at >= issued_at - interval '5 minutes')
);

CREATE INDEX idx_control_connection_enrollments_current
  ON control_connection_enrollments(tenant_id,connection_id,revision DESC);
CREATE INDEX idx_control_connection_enrollments_expiry
  ON control_connection_enrollments(tenant_id,expires_at);

CREATE TRIGGER control_connection_enrollments_append_only
  BEFORE UPDATE OR DELETE ON control_connection_enrollments
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_connection_enrollments_truncate_guard
  BEFORE TRUNCATE ON control_connection_enrollments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
