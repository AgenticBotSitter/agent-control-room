-- Tango tier 1: the "needs breakdown / needs more info" intake gate. A
-- deterministic checker recomputes flags from the proposal text at review
-- time; nothing about a computed flag is stored here. This table records only
-- the owner's one-tap dismissal of one exact flag on one exact batch
-- revision, so an unresolved flag keeps blocking approval of that item across
-- reloads while a dismissal or a further revision resolves it. It grants no
-- approval, queue admission or execution authority.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE work_batch_intake_flag_dismissals (
  id text NOT NULL,
  tenant_id text NOT NULL,
  batch_id text NOT NULL,
  project_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1),
  local_id text NOT NULL CHECK (local_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  flag_kind text NOT NULL CHECK (flag_kind IN ('needs_breakdown','needs_more_info')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  dismissed_by_identity_id text NOT NULL,
  dismissed_at timestamptz NOT NULL,
  dismissal_digest text NOT NULL CHECK (dismissal_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL CHECK (created_at = dismissed_at),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,batch_id,revision,local_id,flag_kind),
  FOREIGN KEY (tenant_id,batch_id,project_id) REFERENCES work_batches(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,dismissed_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);

-- Only an active owner (or a future delegated queue-manager role holding the
-- same work_batches.decide action, per the owner's 2026-09-28 answer 4) may
-- dismiss a flag, and only against the batch's exact current, still-proposed
-- revision. Confirming the local id belongs to that revision's own proposal
-- prevents dismissing a flag against a task that was never actually flagged
-- there. This function is SECURITY INVOKER: it reads no more than the caller's
-- own grants already let it read.
CREATE FUNCTION guard_work_batch_intake_flag_dismissal_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM public.work_batches b
      WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.batch_id AND b.project_id=NEW.project_id
        AND b.state='proposed' AND b.version=NEW.revision
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.work_batch_revisions r
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(r.proposal->'tasks') AS t
      WHERE r.tenant_id=NEW.tenant_id AND r.batch_id=NEW.batch_id AND r.revision=NEW.revision
        AND t->>'localId'=NEW.local_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.control_identities i JOIN public.control_role_grants g
        ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.dismissed_by_identity_id
        AND i.actor_type='human' AND i.state='active' AND g.role_key='owner'
        AND (g.project_ids @> pg_catalog.to_jsonb(ARRAY[NEW.project_id]::text[]) OR g.project_ids @> '["*"]'::jsonb)
        AND (g.allowed_actions @> '["work_batches.decide"]'::jsonb OR g.allowed_actions @> '["*"]'::jsonb)
        AND (g.revoked_at IS NULL OR g.revoked_at>pg_catalog.statement_timestamp())
        AND (g.expires_at IS NULL OR g.expires_at>pg_catalog.statement_timestamp())
    ) THEN
    RAISE EXCEPTION 'work batch intake flag dismissal insert rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_work_batch_intake_flag_dismissal_insert() FROM PUBLIC;
CREATE TRIGGER work_batch_intake_flag_dismissals_guard BEFORE INSERT ON public.work_batch_intake_flag_dismissals
  FOR EACH ROW EXECUTE FUNCTION public.guard_work_batch_intake_flag_dismissal_insert();
CREATE TRIGGER work_batch_intake_flag_dismissals_append_only BEFORE UPDATE OR DELETE ON public.work_batch_intake_flag_dismissals
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER work_batch_intake_flag_dismissals_no_truncate BEFORE TRUNCATE ON public.work_batch_intake_flag_dismissals
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
REVOKE ALL ON work_batch_intake_flag_dismissals FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT, INSERT ON work_batch_intake_flag_dismissals TO control_room_private_web';
  END IF;
END $$;

-- A down migration is intentionally operator-authored and data refusing: it
-- must first lock the table and raise when it contains any row. Production
-- recovery never silently drops these records.
