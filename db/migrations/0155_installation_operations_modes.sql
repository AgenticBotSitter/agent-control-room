-- Installation-wide operations mode: the owner-facing Pause / Drain / Stop
-- switch, recorded as authenticated, append-only revisions.
--
-- This is an operation-wide state for the whole installation, not a per-project
-- coordination policy. The effective mode is the highest revision per tenant;
-- it is derived, never updated in place, so the record of who changed it and
-- when is complete by construction rather than by an audit convention.
--
-- These rows grant no worker route, no queue position, no execution authority
-- and no effect on a running process by themselves. They are only ever read by
-- the guards below and by the owner session that writes them.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE installation_operations_mode_revisions (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision >= 1),
  mode text NOT NULL CHECK (mode IN ('running','paused','draining','stopped')),
  reason text NOT NULL,
  set_by_identity_id text NOT NULL,
  set_at timestamptz NOT NULL,
  record jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,revision),
  FOREIGN KEY (tenant_id,set_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT ck_installation_operations_mode_mirrors CHECK (
    (record->>'schema'='control-room.installation-operations-mode/v1') IS TRUE
    AND (record->>'tenantId'=tenant_id) IS TRUE
    AND ((record->>'revision')::bigint=revision) IS TRUE
    AND (record->>'mode'=mode) IS TRUE
    AND (record->>'reason'=reason) IS TRUE
    AND (record->>'setByIdentityId'=set_by_identity_id) IS TRUE
    -- The record carries the same instant as an ISO string; the instant is what
    -- must match, not its formatting. A record whose timestamp is off by even a
    -- microsecond from the column is rejected.
    AND ((record->>'setAt')::timestamptz = set_at) IS TRUE
  )
);

-- The one read every gate uses is inlined into the guard functions themselves
-- (see 0156) rather than exposed as a callable function. Every function in this
-- schema is granted to nobody by default, and a guard that depends on an
-- EXECUTE grant would be one role-file change away from failing closed in a
-- way nothing here would notice. An installation with no recorded mode is
-- running: the absence of an owner decision is not itself a decision, and
-- failing closed would take a freshly migrated installation offline.

CREATE VIEW installation_effective_operations_mode AS
  SELECT r.* FROM installation_operations_mode_revisions r
  WHERE r.revision = (SELECT max(m.revision) FROM installation_operations_mode_revisions m
    WHERE m.tenant_id = r.tenant_id);
ALTER VIEW installation_effective_operations_mode OWNER TO CURRENT_USER;
REVOKE ALL ON installation_effective_operations_mode FROM PUBLIC;

CREATE INDEX installation_operations_mode_revisions_current
  ON installation_operations_mode_revisions(tenant_id,revision DESC);

-- A revision is appended, never rewritten or deleted, and the numbering has no
-- gaps: a deleted or skipped revision would make the effective mode a fiction.
CREATE FUNCTION guard_installation_operations_mode_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE latest bigint; next_set_at timestamptz;
BEGIN
  IF public.is_work_intake_session() THEN
    RAISE EXCEPTION 'installation operations mode insert rejected';
  END IF;
  SELECT max(revision), max(set_at) INTO latest, next_set_at
    FROM public.installation_operations_mode_revisions WHERE tenant_id = NEW.tenant_id;
  IF latest IS NULL THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'installation operations mode insert rejected'; END IF;
  ELSIF NEW.revision <> latest + 1 OR NEW.set_at < next_set_at THEN
    RAISE EXCEPTION 'installation operations mode insert rejected';
  END IF;
  -- Only the owner's own human session writes this. A worker, an agent and the
  -- shared intake login are all refused here, not merely in the application.
  IF NOT EXISTS (
    SELECT 1 FROM public.control_identities i
    JOIN public.control_role_grants g ON g.tenant_id = i.tenant_id AND g.identity_id = i.id
    WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.set_by_identity_id
      AND i.actor_type = 'human' AND i.state = 'active' AND g.role_key = 'owner'
      AND (g.allowed_actions @> '["operations.set_mode"]'::jsonb
        OR g.allowed_actions @> '["*"]'::jsonb)
      AND (g.revoked_at IS NULL OR g.revoked_at > pg_catalog.statement_timestamp())
      AND (g.expires_at IS NULL OR g.expires_at > pg_catalog.statement_timestamp())
  ) THEN
    RAISE EXCEPTION 'installation operations mode insert rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_installation_operations_mode_insert() FROM PUBLIC;
CREATE TRIGGER installation_operations_mode_revisions_guard
  BEFORE INSERT ON public.installation_operations_mode_revisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_installation_operations_mode_insert();
CREATE TRIGGER installation_operations_mode_revisions_immutable
  BEFORE UPDATE OR DELETE ON public.installation_operations_mode_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER installation_operations_mode_revisions_no_truncate
  BEFORE TRUNCATE ON public.installation_operations_mode_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

ALTER TABLE installation_operations_mode_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY installation_operations_mode_revisions_existing_access ON installation_operations_mode_revisions
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY installation_operations_mode_revisions_work_intake_scope ON installation_operations_mode_revisions
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session() OR
    installation_operations_mode_revisions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b))
  WITH CHECK (NOT public.is_work_intake_session() OR
    installation_operations_mode_revisions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b));
