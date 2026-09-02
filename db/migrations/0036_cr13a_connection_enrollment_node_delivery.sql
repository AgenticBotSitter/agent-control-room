-- CR13A-LIVE-040 authenticated node-protocol delivery ledger. The table is a
-- protected server-side source for enrollment intake; it does not create a web
-- mutation path, network listener, connection authority, or execution grant.

CREATE TABLE control_connection_enrollment_delivery_heads (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  last_sequence bigint NOT NULL CHECK (last_sequence BETWEEN 1 AND 10000),
  last_record_digest text NOT NULL CHECK (last_record_digest ~ '^sha256:[a-f0-9]{64}$'),
  head_auth_tag text NOT NULL CHECK (head_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL
);

CREATE TABLE control_connection_enrollment_protocol_deliveries (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id text NOT NULL CHECK (
    char_length(delivery_id) BETWEEN 3 AND 160
    AND delivery_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 10000),
  node_id text NOT NULL,
  connection_id text NOT NULL,
  key_id_digest text NOT NULL CHECK (key_id_digest ~ '^sha256:[a-f0-9]{64}$'),
  protocol_message_digest text NOT NULL CHECK (protocol_message_digest ~ '^sha256:[a-f0-9]{64}$'),
  protocol_frame_digest text NOT NULL CHECK (protocol_frame_digest ~ '^sha256:[a-f0-9]{64}$'),
  initial_protocol_disposition text NOT NULL CHECK (initial_protocol_disposition IN ('accepted','duplicate')),
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^sha256:[a-f0-9]{64}$'),
  protected_delivery_digest text NOT NULL CHECK (protected_delivery_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  previous_record_digest text CHECK (
    previous_record_digest IS NULL OR previous_record_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  record_digest text NOT NULL UNIQUE CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id,delivery_id),
  UNIQUE (delivery_id),
  UNIQUE (tenant_id,sequence),
  UNIQUE (tenant_id,protocol_message_digest),
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT,
  CHECK (
    (sequence = 1 AND previous_record_digest IS NULL)
    OR (sequence > 1 AND previous_record_digest IS NOT NULL)
  )
);

CREATE INDEX idx_control_connection_enrollment_protocol_deliveries_sequence
  ON control_connection_enrollment_protocol_deliveries(tenant_id,sequence);

CREATE TRIGGER control_connection_enrollment_protocol_deliveries_append_only
  BEFORE UPDATE OR DELETE ON control_connection_enrollment_protocol_deliveries
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_connection_enrollment_protocol_deliveries_truncate_guard
  BEFORE TRUNCATE ON control_connection_enrollment_protocol_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_connection_enrollment_delivery_heads_delete_guard
  BEFORE DELETE ON control_connection_enrollment_delivery_heads
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_connection_enrollment_delivery_heads_truncate_guard
  BEFORE TRUNCATE ON control_connection_enrollment_delivery_heads
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
