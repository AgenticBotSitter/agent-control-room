-- Authenticated append-only installation-transition journal.  These records
-- preserve the reviewed transition state only; they are not a worker route,
-- scheduler, queue, browser projection, or worker enablement mechanism.
CREATE TABLE control_installation_transition_revisions (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  transition_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('prepared','admission_paused','drained','proofs_verified','committed','failed','rollback_ready','rolled_back')),
  record jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,transition_id,revision),
  CONSTRAINT ck_installation_transition_revision_mirrors CHECK (
    (record->>'schema'='control-room.installation-transition/v1') IS TRUE
    AND (record->>'transitionId'=transition_id) IS TRUE
    AND ((record->>'revision')::bigint=revision) IS TRUE
    AND (record->>'planDigest'=plan_digest) IS TRUE
    AND (record->>'state'=state) IS TRUE
  )
);

CREATE INDEX control_installation_transition_revisions_current
  ON control_installation_transition_revisions(tenant_id,transition_id,revision DESC);

CREATE TRIGGER control_installation_transition_revisions_immutable
  BEFORE UPDATE OR DELETE ON control_installation_transition_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_installation_transition_revisions_no_truncate
  BEFORE TRUNCATE ON control_installation_transition_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
