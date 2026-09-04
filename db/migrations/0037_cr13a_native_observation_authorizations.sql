-- CR13A-LIVE-350 authenticated registration and nonce replay reservation.
-- These append-only tables cannot issue or consume an authorization and do not
-- make the private native-observation source reachable.

CREATE TABLE control_native_observation_authorization_heads (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  last_sequence bigint NOT NULL CHECK (last_sequence BETWEEN 1 AND 10000),
  last_record_digest text NOT NULL CHECK (last_record_digest ~ '^sha256:[a-f0-9]{64}$'),
  head_auth_tag text NOT NULL CHECK (head_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$')
);

CREATE TABLE control_native_observation_authorizations (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 10000),
  authorization_id_digest text NOT NULL CHECK (authorization_id_digest ~ '^sha256:[a-f0-9]{64}$'),
  nonce_digest text NOT NULL CHECK (nonce_digest ~ '^sha256:[a-f0-9]{64}$'),
  body_digest text NOT NULL CHECK (body_digest ~ '^sha256:[a-f0-9]{64}$'),
  authorization_auth_tag text NOT NULL CHECK (authorization_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  previous_record_digest text CHECK (
    previous_record_digest IS NULL OR previous_record_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  record_digest text NOT NULL UNIQUE CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  PRIMARY KEY (tenant_id, authorization_id_digest),
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, nonce_digest),
  CHECK (
    (sequence = 1 AND previous_record_digest IS NULL)
    OR (sequence > 1 AND previous_record_digest IS NOT NULL)
  )
);

CREATE TABLE control_native_observation_authorization_nonces (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  nonce_digest text NOT NULL CHECK (nonce_digest ~ '^sha256:[a-f0-9]{64}$'),
  authorization_id_digest text NOT NULL CHECK (authorization_id_digest ~ '^sha256:[a-f0-9]{64}$'),
  body_digest text NOT NULL CHECK (body_digest ~ '^sha256:[a-f0-9]{64}$'),
  reservation_digest text NOT NULL UNIQUE CHECK (reservation_digest ~ '^sha256:[a-f0-9]{64}$'),
  reservation_auth_tag text NOT NULL CHECK (reservation_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, nonce_digest),
  UNIQUE (tenant_id, authorization_id_digest),
  FOREIGN KEY (tenant_id, authorization_id_digest)
    REFERENCES control_native_observation_authorizations(tenant_id, authorization_id_digest)
    ON DELETE RESTRICT
);

CREATE INDEX idx_control_native_observation_authorizations_sequence
  ON control_native_observation_authorizations(tenant_id, sequence);

CREATE TRIGGER control_native_observation_authorizations_append_only
  BEFORE UPDATE OR DELETE ON control_native_observation_authorizations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_native_observation_authorizations_truncate_guard
  BEFORE TRUNCATE ON control_native_observation_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_native_observation_authorization_nonces_append_only
  BEFORE UPDATE OR DELETE ON control_native_observation_authorization_nonces
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_native_observation_authorization_nonces_truncate_guard
  BEFORE TRUNCATE ON control_native_observation_authorization_nonces
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_native_observation_authorization_heads_delete_guard
  BEFORE DELETE ON control_native_observation_authorization_heads
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_native_observation_authorization_heads_truncate_guard
  BEFORE TRUNCATE ON control_native_observation_authorization_heads
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
