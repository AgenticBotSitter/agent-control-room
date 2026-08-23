-- CR-5A device identity and replay state. Enrollment secrets are stored only as
-- one-way digests; node private keys never enter Control Room.

CREATE TABLE node_enrollment_tokens (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  token_digest text NOT NULL CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  node_class text NOT NULL,
  state text NOT NULL CHECK (state IN ('issued','consumed','revoked','expired')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, token_digest),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '15 minutes'),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
);

CREATE TABLE node_enrollment_challenges (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  token_id text NOT NULL,
  challenge_nonce text NOT NULL,
  node_class text NOT NULL,
  supported_protocols jsonb NOT NULL,
  server_trust_keys jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('issued','consumed','expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, token_id),
  UNIQUE (tenant_id, challenge_nonce),
  FOREIGN KEY (tenant_id, token_id) REFERENCES node_enrollment_tokens(tenant_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '5 minutes'),
  CHECK (jsonb_typeof(supported_protocols) = 'array'),
  CHECK (jsonb_typeof(server_trust_keys) = 'array'),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
);

CREATE TABLE control_node_keys (
  id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  node_id text NOT NULL,
  algorithm text NOT NULL CHECK (algorithm = 'ed25519'),
  public_key_spki text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('active','retired','revoked')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, node_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fingerprint),
  FOREIGN KEY (tenant_id, node_id) REFERENCES control_nodes(tenant_id, id) ON DELETE RESTRICT,
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_control_node_keys_one_active
  ON control_node_keys(tenant_id, node_id) WHERE state = 'active';

CREATE TABLE node_protocol_connections (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  node_id text NOT NULL,
  connection_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('node_to_server','server_to_node')),
  last_sequence bigint NOT NULL CHECK (last_sequence > 0),
  last_message_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, node_id, connection_id, direction),
  FOREIGN KEY (tenant_id, node_id) REFERENCES control_nodes(tenant_id, id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE TABLE node_protocol_replay (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  node_id text NOT NULL,
  key_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('node_to_server','server_to_node')),
  message_id text NOT NULL,
  nonce_digest text NOT NULL CHECK (nonce_digest ~ '^sha256:[a-f0-9]{64}$'),
  connection_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, node_id, direction, message_id),
  UNIQUE (tenant_id, node_id, key_id, nonce_digest),
  UNIQUE (tenant_id, node_id, connection_id, direction, sequence),
  FOREIGN KEY (tenant_id, node_id, key_id) REFERENCES control_node_keys(tenant_id, node_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, node_id, connection_id, direction)
    REFERENCES node_protocol_connections(tenant_id, node_id, connection_id, direction) ON DELETE CASCADE,
  CHECK (expires_at >= received_at)
);

CREATE INDEX idx_node_enrollment_tokens_expiry ON node_enrollment_tokens(state, expires_at);
CREATE INDEX idx_node_protocol_replay_expiry ON node_protocol_replay(expires_at);

CREATE OR REPLACE FUNCTION protect_enrollment_token()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
     OR NEW.node_class IS DISTINCT FROM OLD.node_class
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'enrollment token identity is immutable';
  END IF;
  IF OLD.state <> 'issued' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
    RAISE EXCEPTION 'terminal enrollment token cannot be restored';
  END IF;
  IF OLD.state = 'issued' AND NEW.state NOT IN ('issued','consumed','revoked','expired') THEN
    RAISE EXCEPTION 'invalid enrollment token state transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER node_enrollment_tokens_protected
BEFORE UPDATE ON node_enrollment_tokens
FOR EACH ROW EXECUTE FUNCTION protect_enrollment_token();

CREATE OR REPLACE FUNCTION protect_enrollment_challenge()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.token_id IS DISTINCT FROM OLD.token_id
     OR NEW.challenge_nonce IS DISTINCT FROM OLD.challenge_nonce
     OR NEW.node_class IS DISTINCT FROM OLD.node_class
     OR NEW.supported_protocols IS DISTINCT FROM OLD.supported_protocols
     OR NEW.server_trust_keys IS DISTINCT FROM OLD.server_trust_keys
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'enrollment challenge identity is immutable';
  END IF;
  IF OLD.state <> 'issued' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
    RAISE EXCEPTION 'terminal enrollment challenge cannot be restored';
  END IF;
  IF OLD.state = 'issued' AND NEW.state NOT IN ('issued','consumed','expired') THEN
    RAISE EXCEPTION 'invalid enrollment challenge state transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER node_enrollment_challenges_protected
BEFORE UPDATE ON node_enrollment_challenges
FOR EACH ROW EXECUTE FUNCTION protect_enrollment_challenge();

CREATE TRIGGER node_protocol_replay_update_protected
BEFORE UPDATE ON node_protocol_replay
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER node_protocol_replay_truncate_protected
BEFORE TRUNCATE ON node_protocol_replay
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- Identity keys cannot be replaced in place. Rotation retires/revokes the old
-- row and inserts a new key with a new immutable key ID.
CREATE OR REPLACE FUNCTION protect_node_key_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.node_id IS DISTINCT FROM OLD.node_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.algorithm IS DISTINCT FROM OLD.algorithm
     OR NEW.public_key_spki IS DISTINCT FROM OLD.public_key_spki
     OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'node key identity is immutable';
  END IF;
  IF OLD.state = 'revoked' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'revoked node keys cannot be restored or rewritten';
  END IF;
  IF OLD.state = 'retired' AND NEW.state NOT IN ('retired','revoked') THEN
    RAISE EXCEPTION 'retired node keys cannot become active';
  END IF;
  IF OLD.state = 'active' AND NEW.state NOT IN ('active','retired','revoked') THEN
    RAISE EXCEPTION 'invalid node key state transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER control_node_keys_identity_immutable
BEFORE UPDATE ON control_node_keys
FOR EACH ROW EXECUTE FUNCTION protect_node_key_identity();

CREATE OR REPLACE FUNCTION reject_node_key_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'node key history is append-preserving';
END;
$$;

CREATE TRIGGER control_node_keys_delete_protected
BEFORE DELETE ON control_node_keys
FOR EACH ROW EXECUTE FUNCTION reject_node_key_delete();
