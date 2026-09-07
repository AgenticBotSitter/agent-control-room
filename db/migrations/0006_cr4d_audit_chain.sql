ALTER TABLE audit_events ADD COLUMN chain_version integer NOT NULL DEFAULT 0 CHECK (chain_version IN (0, 1));
ALTER TABLE audit_events ADD COLUMN chain_partition text;
ALTER TABLE audit_events ADD COLUMN chain_sequence bigint;
ALTER TABLE audit_events ADD COLUMN event_digest text;
ALTER TABLE audit_events ADD COLUMN prev_hash text;
ALTER TABLE audit_events ADD COLUMN event_hash text;

CREATE TABLE control_audit_chain_heads (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  chain_partition text NOT NULL,
  head_hash text NOT NULL CHECK (head_hash ~ '^sha256:[0-9a-f]{64}$'),
  event_count bigint NOT NULL CHECK (event_count >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, chain_partition)
);

CREATE TABLE control_audit_anchors (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  chain_partition text NOT NULL,
  head_hash text NOT NULL CHECK (head_hash ~ '^sha256:[0-9a-f]{64}$'),
  event_count bigint NOT NULL CHECK (event_count >= 0),
  anchor_kind text NOT NULL,
  safe_reference text,
  anchored_at timestamptz NOT NULL,
  UNIQUE (tenant_id, chain_partition, head_hash),
  FOREIGN KEY (tenant_id, chain_partition) REFERENCES control_audit_chain_heads(tenant_id, chain_partition) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_audit_events_chain_sequence
  ON audit_events(tenant_id, chain_partition, chain_sequence)
  WHERE chain_version = 1;
CREATE INDEX idx_audit_events_chain_verify
  ON audit_events(tenant_id, chain_partition, chain_sequence)
  WHERE chain_version = 1;

CREATE OR REPLACE FUNCTION validate_audit_chain_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.chain_version = 1 AND (
    NEW.chain_partition IS NULL OR NEW.chain_sequence IS NULL OR NEW.event_digest !~ '^sha256:[0-9a-f]{64}$'
    OR NEW.prev_hash !~ '^sha256:[0-9a-f]{64}$' OR NEW.event_hash !~ '^sha256:[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'audit chain v1 fields are incomplete';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_events_chain_fields ON audit_events;
CREATE TRIGGER audit_events_chain_fields
BEFORE INSERT OR UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION validate_audit_chain_fields();

DROP TRIGGER IF EXISTS control_audit_anchors_append_only ON control_audit_anchors;
CREATE TRIGGER control_audit_anchors_append_only
BEFORE UPDATE OR DELETE ON control_audit_anchors
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
DROP TRIGGER IF EXISTS control_audit_anchors_truncate_guard ON control_audit_anchors;
CREATE TRIGGER control_audit_anchors_truncate_guard
BEFORE TRUNCATE ON control_audit_anchors
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
