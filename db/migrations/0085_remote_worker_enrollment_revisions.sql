-- Canonical, append-only remote-worker enrollment authority.  A node/key is
-- necessary machine evidence but is not, by itself, authority for a worker.
CREATE TABLE control_remote_worker_enrollment_revisions (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  worker_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  node_id text NOT NULL,
  node_key_id text NOT NULL,
  enrollment_id text NOT NULL,
  adapter_id text NOT NULL,
  adapter_revision text NOT NULL,
  capability_digest text NOT NULL CHECK (capability_digest ~ '^sha256:[a-f0-9]{64}$'),
  enrollment_digest text NOT NULL CHECK (enrollment_digest ~ '^sha256:[a-f0-9]{64}$'),
  release_binding_digest text NOT NULL CHECK (release_binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('enrolled','draining','quarantined','revoked')),
  enrolled_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  evidence_digest text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  previous_record_digest text CHECK (previous_record_digest IS NULL OR previous_record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,worker_id,revision),
  -- Every revision retains the immutable enrollment ID.  Including revision
  -- prevents reuse at the same history position while allowing that one
  -- enrollment's authenticated lifecycle chain to advance.
  UNIQUE (tenant_id,enrollment_id,revision),
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,node_id,node_key_id) REFERENCES control_node_keys(tenant_id,node_id,id) ON DELETE RESTRICT,
  CONSTRAINT ck_remote_worker_enrollment_revision_mirrors CHECK (
    (record->>'schema'='control-room.remote-worker-enrollment-record/v1') IS TRUE
    AND (record->>'tenantId'=tenant_id) IS TRUE
    AND (record->>'workerId'=worker_id) IS TRUE
    AND ((record->>'revision')::bigint=revision) IS TRUE
    AND (record->>'nodeId'=node_id) IS TRUE
    AND (record->>'nodeKeyId'=node_key_id) IS TRUE
    AND (record->>'enrollmentId'=enrollment_id) IS TRUE
    AND (record->>'adapterId'=adapter_id) IS TRUE
    AND (record->>'adapterRevision'=adapter_revision) IS TRUE
    AND (record->>'capabilityDigest'=capability_digest) IS TRUE
    AND (record->>'enrollmentDigest'=enrollment_digest) IS TRUE
    AND (record->>'releaseBindingDigest'=release_binding_digest) IS TRUE
    AND (record->>'state'=state) IS TRUE
    AND ((record->>'enrolledAt')::timestamptz=enrolled_at) IS TRUE
    AND ((record->>'updatedAt')::timestamptz=updated_at) IS TRUE
    AND (record->>'recordDigest' ~ '^sha256:[a-f0-9]{64}$') IS TRUE
    AND ((revision=0 AND state='enrolled' AND evidence_digest IS NULL AND previous_record_digest IS NULL)
      OR (revision>0 AND evidence_digest IS NOT NULL AND previous_record_digest IS NOT NULL))
  ),
  CHECK (updated_at >= enrolled_at)
);

CREATE INDEX control_remote_worker_enrollment_revisions_current
  ON control_remote_worker_enrollment_revisions(tenant_id,worker_id,revision DESC);
CREATE INDEX control_remote_worker_enrollment_revisions_node
  ON control_remote_worker_enrollment_revisions(tenant_id,node_id,revision DESC);

CREATE TRIGGER control_remote_worker_enrollment_revisions_immutable
  BEFORE UPDATE OR DELETE ON control_remote_worker_enrollment_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_remote_worker_enrollment_revisions_no_truncate
  BEFORE TRUNCATE ON control_remote_worker_enrollment_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
