-- CR13A-LIVE-370 authenticated append-only authorization consumption.
-- A consumption proves one durable spend but grants no source lookup,
-- invocation, native-read, or runtime authority.

CREATE TABLE control_native_observation_authorization_consumption_heads (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  last_sequence bigint NOT NULL CHECK (last_sequence BETWEEN 1 AND 10000),
  last_record_digest text NOT NULL CHECK (last_record_digest ~ '^sha256:[a-f0-9]{64}$'),
  head_auth_tag text NOT NULL CHECK (head_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$')
);

CREATE TABLE control_native_observation_authorization_consumptions (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 10000),
  authorization_id_digest text NOT NULL CHECK (authorization_id_digest ~ '^sha256:[a-f0-9]{64}$'),
  nonce_digest text NOT NULL CHECK (nonce_digest ~ '^sha256:[a-f0-9]{64}$'),
  body_digest text NOT NULL CHECK (body_digest ~ '^sha256:[a-f0-9]{64}$'),
  consumed_at timestamptz NOT NULL,
  previous_record_digest text CHECK (
    previous_record_digest IS NULL OR previous_record_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  record_digest text NOT NULL UNIQUE CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, authorization_id_digest),
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, nonce_digest),
  FOREIGN KEY (tenant_id, authorization_id_digest)
    REFERENCES control_native_observation_authorizations(tenant_id, authorization_id_digest)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, nonce_digest)
    REFERENCES control_native_observation_authorization_nonces(tenant_id, nonce_digest)
    ON DELETE RESTRICT,
  CHECK (
    (sequence = 1 AND previous_record_digest IS NULL)
    OR (sequence > 1 AND previous_record_digest IS NOT NULL)
  )
);

CREATE INDEX idx_control_native_observation_authorization_consumptions_sequence
  ON control_native_observation_authorization_consumptions(tenant_id, sequence);

CREATE TRIGGER control_native_observation_authorization_consumptions_append_only
  BEFORE UPDATE OR DELETE ON control_native_observation_authorization_consumptions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_native_observation_authorization_consumptions_truncate_guard
  BEFORE TRUNCATE ON control_native_observation_authorization_consumptions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_native_observation_authorization_consumption_heads_delete_guard
  BEFORE DELETE ON control_native_observation_authorization_consumption_heads
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_native_observation_authorization_consumption_heads_truncate_guard
  BEFORE TRUNCATE ON control_native_observation_authorization_consumption_heads
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
