-- MIG-A (plan v4.3 §2.1): the orchestrator's re-split suggestion.
--
-- The database only lets agents insert work_batch_revisions revision 1 (0093) and only
-- lets a human owner write revision 2+ (0102). So a "split it again" answer from a
-- planner is stored as its OWN append-only record bound to the exact revision it
-- answers, and the owner "uses" it by having it pre-fill the owner's own revision
-- form. Nothing here starts work, writes a revision, approves, admits, assigns or
-- grants execution authority.
--
-- Binding rules, all enforced in guard_work_batch_split_suggestion_insert below:
--   1. the proposer is an ACTIVE agent identity whose only accepted work-batch grant
--      is exactly ["work_batches.propose"] (low risk, no external effects, no strong
--      factor), scoped to this project, unexpired and unrevoked;
--   2. the batch still EXISTS in state 'proposed' -- an approved, partially approved,
--      rejected or superseded batch accepts no new suggestion;
--   3. the batch's CURRENT version equals the suggestion's base_revision, and the
--      suggestion's base_revision_digest is the digest of that revision's stored
--      proposal. A suggestion can therefore never be bound to a revision the batch
--      has not reached, whatever the caller asserts;
--   4. the proposer is the batch's OWN proposer. Plan §2.1 gives the orchestrator only
--      work_batches.propose on the existing work-intake login, and an agent that did
--      not propose this batch has no standing to re-split it.
--
-- "A new revision voids older suggestions" is NOT a mutation: this table is
-- append-only, and voiding is derived. read_work_batch_current_split_suggestions()
-- returns only suggestions whose base_revision is the batch's current version, so
-- a newer revision simply makes every older suggestion invisible to the owner, and
-- the row remains as the durable record of what was proposed against what.
--
-- The request_key is the caller's idempotency key. Uniqueness on
-- (tenant_id, project_id, batch_id, request_key) makes an exact replay return the
-- stored row rather than a second one, so a retried planner run is free of
-- duplicates; a replay whose content differs is refused by
-- guard_work_batch_split_suggestion_replay_conflict below.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- The suggestion's binding is (batch, revision, revision_digest), so the revision
-- side of that reference has to be a real key rather than a two-part lookup the
-- guard happens to run. 0093's (tenant_id,batch_id,revision) is already unique, so
-- this is a strict superset of it: every existing row already satisfies it, and
-- adding it cannot fail on a populated database.
ALTER TABLE work_batch_revisions
  ADD CONSTRAINT work_batch_revisions_batch_revision_digest_key UNIQUE (tenant_id,batch_id,revision,revision_digest);

CREATE TABLE work_batch_split_suggestions (
  id text NOT NULL CHECK (id ~ '^split-suggestion:[a-f0-9]{32}$'),
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  batch_id text NOT NULL,
  request_key text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$'),
  base_revision bigint NOT NULL CHECK (base_revision >= 1),
  base_revision_digest text NOT NULL CHECK (base_revision_digest ~ '^sha256:[a-f0-9]{64}$'),
  proposed_by_identity_id text NOT NULL,
  proposed_by_actor_type text NOT NULL CHECK (proposed_by_actor_type='agent'),
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal)='object'),
  proposal_digest text NOT NULL CHECK (proposal_digest ~ '^sha256:[a-f0-9]{64}$'),
  suggestion_digest text NOT NULL CHECK (suggestion_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,batch_id,project_id) REFERENCES work_batches(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,proposed_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  -- The bound revision is a real revision of THIS batch, and its stored digest is
  -- the one the suggestion names. Without this, a caller could bind a suggestion to
  -- a revision number that exists but whose content it never read.
  FOREIGN KEY (tenant_id,batch_id,base_revision,base_revision_digest)
    REFERENCES work_batch_revisions(tenant_id,batch_id,revision,revision_digest) ON DELETE RESTRICT
);

-- The write guard. SECURITY INVOKER, like 0110's dismissal guard: it reads only what
-- the caller's own grants already let it read, so it cannot become a read side
-- channel for identities, grants or other tenants' batches.
CREATE FUNCTION guard_work_batch_split_suggestion_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE batch public.work_batches%ROWTYPE;
  revision_digest text;
BEGIN
  SELECT * INTO batch FROM public.work_batches b
    WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.batch_id;
  IF NOT FOUND OR batch.project_id<>NEW.project_id
    OR batch.state<>'proposed'
    OR batch.version<>NEW.base_revision
    OR batch.proposed_by_identity_id<>NEW.proposed_by_identity_id THEN
    RAISE EXCEPTION 'work batch split suggestion insert rejected';
  END IF;
  -- The bound digest must be that exact revision's own digest. A revision row for the
  -- number exists by the foreign key, so this compares content, not presence.
  SELECT r.revision_digest INTO revision_digest FROM public.work_batch_revisions r
    WHERE r.tenant_id=NEW.tenant_id AND r.batch_id=NEW.batch_id AND r.revision=NEW.base_revision;
  IF revision_digest IS DISTINCT FROM NEW.base_revision_digest THEN
    RAISE EXCEPTION 'work batch split suggestion insert rejected';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM public.control_identities i
      JOIN public.control_role_grants g ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.proposed_by_identity_id
        AND i.actor_type='agent' AND i.state='active'
        AND g.role_key='work_batch_proposer'
        AND g.allowed_actions='["work_batches.propose"]'::jsonb
        AND g.risk_ceiling='low' AND NOT g.allow_external_effects AND NOT g.require_strong_factor
        AND (g.project_ids @> pg_catalog.to_jsonb(ARRAY[NEW.project_id]::text[]) OR g.project_ids @> '["*"]'::jsonb)
        AND (g.revoked_at IS NULL OR g.revoked_at>pg_catalog.statement_timestamp())
        AND (g.expires_at IS NULL OR g.expires_at>pg_catalog.statement_timestamp())
    ) THEN
    RAISE EXCEPTION 'work batch split suggestion insert rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_work_batch_split_suggestion_insert() FROM PUBLIC;
CREATE TRIGGER work_batch_split_suggestions_guard BEFORE INSERT ON public.work_batch_split_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.guard_work_batch_split_suggestion_insert();
CREATE TRIGGER work_batch_split_suggestions_append_only BEFORE UPDATE OR DELETE
  ON public.work_batch_split_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER work_batch_split_suggestions_no_truncate BEFORE TRUNCATE
  ON public.work_batch_split_suggestions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
REVOKE ALL ON work_batch_split_suggestions FROM PUBLIC;

-- A replay that carries DIFFERENT content under a request key already used must be
-- refused, and it must be refused by a rule rather than by luck.
--
-- A request key names ONE suggestion, and that is the whole idempotency contract:
-- a second append under a key already used is refused, whatever it carries. The
-- unique index on (tenant, project, batch, request key) says exactly that, with
-- no trigger and no second code path to get wrong.
--
-- Two trigger designs were measured and abandoned before arriving here, and the
-- reasons are why this is an index:
--
--   - A row-level BEFORE trigger that SELECTs the table to find the existing row
--     deadlocks against `ON CONFLICT`: the statement has already taken the index
--     lock that read wants. Measured -- twenty concurrent inserts on one batch
--     HUNG until the statement timeout fired.
--   - A statement-level BEFORE trigger with a transition table cannot exist.
--     PostgreSQL refuses it outright: "transition table name can only be
--     specified for an AFTER trigger", so there is nothing to compare against.
--   - An AFTER trigger cannot help either, because the unique index has already
--     aborted the statement by then.
--
-- The content is deliberately NOT part of this key, and the reason is that a
-- differing replay must be refused rather than admitted: a request key that
-- already carries one suggestion must not be able to carry a second, different
-- one, whoever asks. Putting the content in the key would have made the two
-- cases indistinguishable to the database and let the second one in.
--
-- The cost, stated plainly: the refusal arrives as PostgreSQL's own 23505 with
-- this index's name, not as a bespoke reason code. The adapter maps it
-- (intake_suggestion_replay_conflict), so the application never reads the text.
CREATE UNIQUE INDEX work_batch_split_suggestions_request_key_unique
  ON public.work_batch_split_suggestions (tenant_id,project_id,batch_id,request_key);

-- Confine the shared intake login to the bound tenant and to suggestions of a batch
-- it can already see, as 0093 confines the batches and 0102 the items. Without this
-- the login's SELECT on the new table would be EVERY tenant's suggestions, which no
-- other role has. The row must also belong to the batch's own proposer, which is
-- the same person the write guard requires.
ALTER TABLE work_batch_split_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_batch_split_suggestions_existing_access ON work_batch_split_suggestions
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY work_batch_split_suggestions_work_intake_scope ON work_batch_split_suggestions
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session() OR (
    work_batch_split_suggestions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b)
    AND EXISTS (SELECT 1 FROM public.work_batches w
      WHERE w.tenant_id=work_batch_split_suggestions.tenant_id
        AND w.id=work_batch_split_suggestions.batch_id
        AND w.proposed_by_identity_id=work_batch_split_suggestions.proposed_by_identity_id)))
  WITH CHECK (NOT public.is_work_intake_session() OR (
    work_batch_split_suggestions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b)
    AND EXISTS (SELECT 1 FROM public.work_batches w
      WHERE w.tenant_id=work_batch_split_suggestions.tenant_id
        AND w.id=work_batch_split_suggestions.batch_id
        AND w.proposed_by_identity_id=work_batch_split_suggestions.proposed_by_identity_id)));

-- The owner's read. A plain VIEW, not a SECURITY DEFINER function: a view runs with
-- its owner's rights, so granting the web login SELECT on the view does not grant it
-- anything on the base table, and the private-web preflight's SECURITY DEFINER
-- allow-list does not have to grow a fifth reviewed entry. It is the CURRENT
-- suggestions only: a stale suggestion is history, and offering it would be offering
-- the owner a plan against a revision that no longer exists. starts_work and
-- grants_execution_authority are literal false columns, so a caller cannot mistake
-- this read for an approval.
--
-- suggestion_digest and auth_tag ARE carried. The read adapter re-derives both
-- before it hands a plan to the owner, and a view that could not return them would
-- make that verification impossible on exactly the path where a tampered row would
-- do the most damage. They are integrity material over a proposal the owner is
-- already entitled to read, not a new disclosure.
CREATE VIEW work_batch_current_split_suggestions AS
  SELECT s.tenant_id, s.project_id, s.batch_id, s.id, s.request_key, s.base_revision,
    s.base_revision_digest, s.proposal, s.proposal_digest, s.suggestion_digest,
    s.proposed_by_identity_id, s.auth_tag, s.created_at,
    false AS starts_work, false AS grants_execution_authority
  FROM public.work_batch_split_suggestions s
  JOIN public.work_batches b ON b.tenant_id=s.tenant_id AND b.id=s.batch_id
  WHERE s.base_revision=b.version AND b.state='proposed';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_work_intake') THEN
    -- The shared intake login is the proposer the orchestrator runs as, so it
    -- appends one suggestion and reads back the CURRENT one -- which is the view,
    -- because a stale suggestion must not be readable back as if it were live. It
    -- is granted no UPDATE, DELETE or TRUNCATE on the table, and the triggers
    -- above would refuse a mutation even for a role that had one.
    EXECUTE 'GRANT SELECT, INSERT ON work_batch_split_suggestions TO control_room_work_intake';
    EXECUTE 'GRANT SELECT ON work_batch_current_split_suggestions TO control_room_work_intake';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    -- The owner web login reads the CURRENT view and holds NO privilege at all on
    -- the base table, so no web path can enumerate a stale suggestion, insert one,
    -- or reach another project. The owner's authority is the app's own authenticated
    -- owner binding, the same one 0110's dismissals rely on.
    EXECUTE 'GRANT SELECT ON work_batch_current_split_suggestions TO control_room_private_web';
  END IF;
END $$;

-- A down migration is intentionally operator-authored and data refusing: it
-- revokes only what this file granted, then refuses while any suggestion exists.
-- Production recovery never silently drops these records.
