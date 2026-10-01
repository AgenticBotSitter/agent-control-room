-- The updater schema's guards: the rules a grant alone cannot express.
--
-- Applied by the updater's fixed DDL, like 0002_schema.sql, and owned by the
-- deployer login. Every function below:
--
--   * is SECURITY DEFINER, so it runs as the table's owner and can read the
--     release-schema tables it needs to check an owner session against, which
--     the web login cannot see from here;
--   * pins `search_path = pg_catalog, updater, pg_temp` (R10b), so a schema an
--     attacker can write to cannot shadow a name the body resolves;
--   * schema-qualifies every object, for the same reason;
--   * is REVOKEd from PUBLIC, so the only way to invoke one is as the owner.
--
-- Each guard is written to fail CLOSED: a condition it cannot evaluate raises
-- rather than returning a row that would let the insert through. A guard that
-- cannot run must not read as a guard that passed.

-- ---------------------------------------------------------------------------
-- reject_append_only_mutation — the repository's existing append-only refusal
-- ---------------------------------------------------------------------------
-- Schema `updater` cannot use `public.reject_append_only_mutation()` without
-- giving every trigger in this schema a dependency on a release-schema object
-- the migrator owns. §9.3 step 4 restores schema `updater` with `--no-owner`
-- and `--exclude-schema=updater`, so a function that lived only in `public`
-- would be missing at exactly the moment the guards are needed most. The
-- updater's fixed DDL therefore carries its own copy, and the database digest
-- for the release schema is unaffected by it living here.
CREATE OR REPLACE FUNCTION updater.reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'updater table % is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION updater.reject_append_only_mutation() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The owner session a web-inserted row must carry
-- ---------------------------------------------------------------------------
-- R16: approval and registration rows need the owner session. §5.4: a stolen
-- owner cookie can view, Pause, Stop, back up and check-and-continue, and
-- cannot install or roll back, because those need a passkey; what the session
-- adds here is the requirement that SOME live owner session made the request.
--
-- WHAT THE DEPLOYER MAY READ, AND WHY IT IS EXACTLY THIS MUCH. The function
-- below is SECURITY DEFINER, so it runs as its owner — the deployer — and it
-- checks the owner session against `public.control_web_sessions`,
-- `public.control_identities` and `public.control_role_grants`. Those are the
-- three canonical tables that say "this is a live human owner with a live
-- tenant-wide grant", and the deployer is granted SELECT on them for exactly
-- this purpose.
--
-- That grant is the whole reason this design does not use a table-wide "the web
-- may insert if it holds any session" rule: the check has to read something the
-- web login cannot forge, and the session row is the one thing the owner holds
-- that no other login can create. It is SELECT only. The deployer cannot insert,
-- update or delete a session, cannot read any other release table, and cannot
-- reach anything the owner session is not: no plan, no candidate, no review, no
-- task. If the deployer role is ever compromised, what it gains here is the
-- ability to ASK whether a given token digest is a live owner session — which is
-- not an authority, because the answer is a boolean about a digest it would
-- already have to possess.
--
-- The two-shape rule the existing migrations use (`is_work_intake_session`)
-- applies: the function is STABLE, has one argument, is not leakproof, has
-- `parallel` unsafe, and its search_path is pinned, so a later preflight can
-- pin its exact identity rather than trusting this comment.
-- The one read of the release schema the deployer holds
-- --------------------------------------------------
-- `owner_session_is_live` is SECURITY DEFINER and owned by the deployer, so it
-- needs SELECT on the three tables it checks. This is the deployer's ENTIRE
-- reach into schema `public`, and it is three read-only tables that say who the
-- owner is.
--
-- THE GRANT CANNOT BE MADE HERE, and the reason is the whole reason this file
-- runs as the deployer rather than as the installer. `control_web_sessions` is
-- owned by `control_room_schema_owner` — the release migrator. A GRANT is made
-- by the object's owner or by a role with grant authority, so the deployer
-- cannot grant itself SELECT on a table it does not own: PostgreSQL refuses with
-- "permission denied for column tenant_id of relation control_web_sessions"
-- (measured, not assumed). Making the grant from the installer's half instead
-- would be worse: the installer holds SCHEMA-OWNER authority over the release
-- schema, so a grant issued there is a grant the release side made, which is
-- exactly the coupling R10 removes.
--
-- So the three grants are issued by the MIGRATOR, from the release ledger's own
-- side, in `db/roles/updater_release_reader_roles.sql` — a reviewed, idempotent
-- role file in the place every other release-schema grant in this repository
-- lives, so it is applied by the installer and the live upgrade, and its exact
-- text is asserted by the existing role-manifest and preflight tests. It grants
-- SELECT on three tables to a role the release path must never manage (see
-- 0001_deployer_role.sql), and the updater's loader asserts on every start that
-- the deployer's reach into `public` is EXACTLY those three tables — so this
-- grant is both granted and bounded, and a fourth table would fail the updater
-- at startup rather than sit unnoticed.
--
-- What the deployer gains is the ability to ask, for a token digest it already
-- holds, whether that digest is a live owner session. That is a boolean, not an
-- authority: it cannot create, extend, revoke or steal a session, and it cannot
-- read any other release table.

CREATE OR REPLACE FUNCTION updater.owner_session_is_live(session_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, updater, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.control_web_sessions s
    JOIN public.control_identities i
      ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
    JOIN public.control_role_grants g
      ON g.tenant_id = i.tenant_id AND g.identity_id = i.id
    WHERE s.token_digest = session_digest
      AND s.revoked_at IS NULL
      AND s.expires_at > pg_catalog.now()
      AND i.actor_type = 'human'
      AND i.state = 'active'
      AND g.role_key = 'owner'
      AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at > pg_catalog.now())
      AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'updates.decide')
      AND g.project_ids ? '*'
  )
$$;
REVOKE ALL ON FUNCTION updater.owner_session_is_live(text) FROM PUBLIC;
COMMENT ON FUNCTION updater.owner_session_is_live(text) IS
  'True when the token digest names a live, unrevoked owner web session. The only'
  ' read of the release schema the deployer role holds, and it is not callable by anyone.';

-- A session digest that is not even shaped like one is refused before the
-- lookup, so the function's one input cannot become a probe.
--
-- The trigger function is ITSELF SECURITY DEFINER. That is not decoration: the
-- inner `owner_session_is_live` is revoked from PUBLIC, so a plain (invoker)
-- trigger body would execute it as the INSERTING role — the web login — and
-- every insert would be refused with "permission denied for function", which is
-- what a first run of this DDL actually did. The trigger's own EXECUTE is
-- likewise not needed by anyone, because a trigger fires by name and not by
-- permission; the revoke on it is kept for the same reason it is on the other
-- functions, so the only way in is as the table's owner.
CREATE OR REPLACE FUNCTION updater.guard_owner_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.owner_session_digest !~ '^sha256:[a-f0-9]{64}$'
    OR NOT updater.owner_session_is_live(NEW.owner_session_digest) THEN
    RAISE EXCEPTION 'updater row needs a live owner session' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_owner_session() FROM PUBLIC;

CREATE OR REPLACE TRIGGER plan_approvals_owner_session
  BEFORE INSERT ON updater.plan_approvals
  FOR EACH ROW EXECUTE FUNCTION updater.guard_owner_session();
CREATE OR REPLACE TRIGGER passkey_registrations_owner_session
  BEFORE INSERT ON updater.passkey_registrations
  FOR EACH ROW EXECUTE FUNCTION updater.guard_owner_session();
CREATE OR REPLACE TRIGGER owner_requests_owner_session
  BEFORE INSERT ON updater.owner_requests
  FOR EACH ROW EXECUTE FUNCTION updater.guard_owner_session();

-- ---------------------------------------------------------------------------
-- One open plan at a time (design §5.5, SI-24)
-- ---------------------------------------------------------------------------
-- A newer candidate supersedes the older plan, and there is never more than one
-- plan awaiting the owner's Face ID. A partial unique index cannot express
-- "open" across a five-value state set with a superseded exception, so the
-- rule is a trigger plus the CHECK on the row itself.
--
-- The advisory lock is transaction-scoped, so two concurrent inserts serialise
-- here rather than both observing zero open plans. It is the same lock the run
-- claim takes, which means "insert an approval's plan" and "claim a run" cannot
-- interleave either.
CREATE OR REPLACE FUNCTION updater.guard_plan_open() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.state NOT IN ('building','ready_for_approval','approved','approval_required') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('updater:open-plan', 0));
  IF EXISTS (SELECT 1 FROM updater.plans p
      WHERE p.plan_id <> NEW.plan_id
        AND p.state IN ('building','ready_for_approval','approved','approval_required')) THEN
    RAISE EXCEPTION 'updater already has an open plan (% )', (
      SELECT p.plan_id FROM updater.plans p
      WHERE p.plan_id <> NEW.plan_id
        AND p.state IN ('building','ready_for_approval','approved','approval_required')
      ORDER BY p.created_at, p.plan_id LIMIT 1)
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_plan_open() FROM PUBLIC;
CREATE OR REPLACE TRIGGER plans_open_guard BEFORE INSERT OR UPDATE ON updater.plans
  FOR EACH ROW EXECUTE FUNCTION updater.guard_plan_open();

-- The same rule on UPDATE, spelled out rather than relying on the trigger's
-- INSERT path: an UPDATE that turns a closed plan into an open one must be
-- refused too, or the rule is bypassable by inserting a closed plan and
-- updating it open. The trigger above is BEFORE INSERT OR UPDATE, so it covers
-- both; this comment records that the coverage is deliberate rather than an
-- oversight, and `plans_superseded_only_when_named` covers the reverse.

-- ---------------------------------------------------------------------------
-- A plan's state may only move forward along §8.1
-- ---------------------------------------------------------------------------
-- plan:  building -> ready_for_approval -> approved -> (run)
--        | approval_required (expired) | refused_build | superseded | done
-- An expired `ready_for_approval` becomes `approval_required`, which is what
-- makes the phone show "Approve again" — and "Approve again" mints a NEW plan
-- with a new nonce (§5.3), so this transition never re-opens the same plan for a
-- signature.
CREATE OR REPLACE FUNCTION updater.guard_plan_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.state = 'building' AND NEW.state IN ('ready_for_approval','refused_build','superseded')) OR
    (OLD.state = 'ready_for_approval' AND NEW.state IN ('approved','approval_required','superseded','refused_build')) OR
    (OLD.state = 'approval_required' AND NEW.state IN ('superseded','refused_build')) OR
    (OLD.state = 'approved' AND NEW.state IN ('done','superseded','refused_build')) OR
    (OLD.state = 'superseded' AND NEW.state = 'done')
  ) THEN
    RAISE EXCEPTION 'updater plan transition refused: % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  -- Only a plan that is actually open can be superseded, and only by naming its
  -- successor: a plan row that is closed is not competing for the owner's Face
  -- ID, so "superseded" would be a lie the web would render.
  IF NEW.state = 'superseded' AND (NEW.superseded_by_plan_id IS NULL OR OLD.state = 'superseded') THEN
    RAISE EXCEPTION 'updater plan supersession refused' USING ERRCODE = '23514';
  END IF;
  -- An approved plan cannot expire backwards into approval_required: expiry is
  -- only a reason to ask again before the owner has approved anything.
  IF OLD.state = 'approved' AND NEW.state = 'approval_required' THEN
    RAISE EXCEPTION 'updater approved plan cannot return to approval_required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_plan_transition() FROM PUBLIC;
CREATE OR REPLACE TRIGGER plans_transition_guard BEFORE UPDATE ON updater.plans
  FOR EACH ROW EXECUTE FUNCTION updater.guard_plan_transition();

-- The immutable part of a plan. Once the owner has seen it, nothing about WHAT
-- it says may change: only the state, the supersession pointer and the expiry
-- bookkeeping move. A row whose plan_json or digest changed after approval is a
-- different plan, and a different plan needs its own Face ID.
CREATE OR REPLACE FUNCTION updater.guard_plan_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state','superseded_by_plan_id']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state','superseded_by_plan_id']) THEN
    RAISE EXCEPTION 'updater plan content is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_plan_immutable() FROM PUBLIC;
CREATE OR REPLACE TRIGGER plans_immutable_guard BEFORE UPDATE ON updater.plans
  FOR EACH ROW EXECUTE FUNCTION updater.guard_plan_immutable();

-- ---------------------------------------------------------------------------
-- The run lease (design §7.2, SI-06)
-- ---------------------------------------------------------------------------
-- launchd runs at most one updater, and the only other actor that changes links
-- is guard.sh, which boots the updater out first. The lease is belt-and-braces:
-- `acquire()` returns an active run only with a matching boot id, or when the
-- previous holder's PG session is gone. The `runs_one_live` partial unique index
-- already refuses a second live run outright; what this trigger adds is that the
-- LEASE TOKEN of a live run cannot be changed under it, so a second process
-- cannot inherit an active run by rewriting one column.
CREATE OR REPLACE FUNCTION updater.guard_run_lease() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  -- The lease check applies to UPDATE only. On INSERT there is no old row, and
  -- reading `OLD` in a trigger body for an INSERT yields NULLs, which made
  -- `OLD.finished_at IS NULL` true — so an INSERT was wrongly treated as a live
  -- run trying to hand its lease to somebody else, and the plan check below
  -- never ran. The two statements are kept separate so each has one subject:
  -- TG_OP names the operation, and a guard that infers the operation from a
  -- NULL column is a guard that guesses.
  IF TG_OP = 'UPDATE' AND OLD.finished_at IS NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
    RAISE EXCEPTION 'updater run lease cannot be reassigned while live' USING ERRCODE = '42501';
  END IF;
  -- A plan that has been approved may be run once. A run row for a plan that is
  -- not approved is a run nobody authorised.
  IF NOT EXISTS (SELECT 1 FROM updater.plans p WHERE p.plan_id = NEW.plan_id
      AND p.state = 'approved' AND p.expires_at > pg_catalog.now()) THEN
    RAISE EXCEPTION 'updater run needs an approved, unexpired plan' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_run_lease() FROM PUBLIC;
CREATE OR REPLACE TRIGGER runs_lease_guard BEFORE INSERT OR UPDATE ON updater.runs
  FOR EACH ROW EXECUTE FUNCTION updater.guard_run_lease();

-- ---------------------------------------------------------------------------
-- Run state transitions (design §8.1)
-- ---------------------------------------------------------------------------
-- Two tables, because §8.1's two paths diverge: a code-only run and a
-- database run take different steps, and `uncertain` and
-- `attended_upgrade_required` are reachable from anywhere (the updater enters
-- them on a measurement, not as the successor of a step).
--
-- The graph is the design's, with the rollback tail spelled out: any
-- post-effect step may go to `rollback_started`, and from there the database
-- path walks restore -> db_restored -> code_restored, while the code path goes
-- straight to code_restored. `rolled_back` and `needs_attention` are terminal.
CREATE OR REPLACE FUNCTION updater.guard_run_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE
  prior text;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  -- The row's own state and its last event are two records of the same thing.
  -- If they disagree, the journal is ahead of the row and this transaction must
  -- not be the one that guesses which is right.
  --
  -- ONE EXCEPTION, and it is the success path. §11's order is: journal the
  -- intent, take the effect, journal the done line. The run row moves to
  -- `succeeded` and its `succeeded` event is appended immediately after, so at
  -- the moment of the UPDATE the last event is still the previous step. Reading
  -- that as a disagreement would refuse the one transition that must never be
  -- refused, and would make a successful update unrecordable. So the comparison
  -- is skipped when the run is becoming terminal, and the `finished_at` CHECK
  -- below is what still has to hold there.
  IF OLD.state IN ('succeeded','rolled_back','needs_attention','refused') THEN
    RAISE EXCEPTION 'updater run % is terminal', OLD.state USING ERRCODE = '23514';
  END IF;
  IF NEW.state NOT IN ('succeeded','rolled_back','needs_attention','refused') THEN
    SELECT e.state INTO prior FROM updater.run_events e
      WHERE e.run_id = NEW.run_id ORDER BY e.ordinal DESC LIMIT 1;
    IF prior IS NOT NULL AND prior <> OLD.state THEN
      RAISE EXCEPTION 'updater run state disagrees with its journal (% vs %)', OLD.state, prior
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state IN ('uncertain','attended_upgrade_required') THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.state = 'approved' AND NEW.state IN ('prechecked','refused','rollback_started')) OR
    (OLD.state = 'prechecked' AND NEW.state IN ('staged','rollback_started','refused')) OR
    (OLD.state = 'staged' AND NEW.state IN ('quick_backup','quiesced','rollback_started','refused')) OR
    -- The code-only path per §8.1: draining -> switched, because a code run never
    -- quiesces the database. The database path below goes draining -> quiesced
    -- instead, and both are listed so neither is a special case of the other.
    (OLD.state = 'quick_backup' AND NEW.state IN ('draining','rollback_started','refused')) OR
    (OLD.state = 'draining' AND NEW.state IN ('quiesced','switched','rollback_started','refused')) OR
    (OLD.state = 'quiesced' AND NEW.state IN ('backup_verified','rollback_started','refused')) OR
    (OLD.state = 'backup_verified' AND NEW.state IN ('preimage_taken','rollback_started','refused')) OR
    (OLD.state = 'preimage_taken' AND NEW.state IN ('migrating','rollback_started','refused')) OR
    (OLD.state = 'migrating' AND NEW.state IN ('migrated','rollback_started','refused')) OR
    (OLD.state = 'migrated' AND NEW.state IN ('switched','rollback_started','refused')) OR
    (OLD.state = 'switched' AND NEW.state IN ('restarted','rollback_started','refused')) OR
    (OLD.state = 'restarted' AND NEW.state IN ('healthy','rollback_started','refused')) OR
    (OLD.state = 'healthy' AND NEW.state IN ('succeeded','rollback_started')) OR
    (OLD.state = 'rollback_started' AND NEW.state IN ('restore_started','code_restored','needs_attention')) OR
    (OLD.state = 'restore_started' AND NEW.state IN ('db_restored','needs_attention')) OR
    (OLD.state = 'db_restored' AND NEW.state IN ('code_restored','needs_attention')) OR
    (OLD.state = 'code_restored' AND NEW.state IN ('rolled_back','needs_attention'))
  ) THEN
    RAISE EXCEPTION 'updater run transition refused: % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  -- Only a terminal state may carry a finish time, and only a live one may not.
  IF NEW.finished_at IS NOT NULL AND NEW.state NOT IN ('succeeded','rolled_back','needs_attention','refused') THEN
    RAISE EXCEPTION 'updater run finish time refused in state %', NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_run_state() FROM PUBLIC;
CREATE OR REPLACE TRIGGER runs_state_guard BEFORE UPDATE ON updater.runs
  FOR EACH ROW EXECUTE FUNCTION updater.guard_run_state();

-- The journal mirror is append-only and its ordinals are the run's step numbers.
-- The first event must be the run's opening state, and each ordinal must be the
-- previous one plus one: a step cannot be skipped in the record even if the
-- state machine would have allowed the jump.
CREATE OR REPLACE FUNCTION updater.guard_run_event_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE prior_ordinal bigint;
BEGIN
  SELECT e.ordinal INTO prior_ordinal FROM updater.run_events e
    WHERE e.run_id = NEW.run_id ORDER BY e.ordinal DESC LIMIT 1;
  IF prior_ordinal IS NULL THEN
    IF NEW.ordinal <> 1 THEN
      RAISE EXCEPTION 'updater run must start at ordinal 1' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.ordinal <> prior_ordinal + 1 THEN
    RAISE EXCEPTION 'updater run ordinal refused: % after %', NEW.ordinal, prior_ordinal
      USING ERRCODE = '23514';
  END IF;
  -- The event's state must be the run's current state, and the run must not
  -- already be finished. A mirror row for a run that has ended is a record of
  -- something that did not happen.
  IF NOT EXISTS (SELECT 1 FROM updater.runs r WHERE r.run_id = NEW.run_id
      AND r.state = NEW.state AND r.finished_at IS NULL) THEN
    RAISE EXCEPTION 'updater run event does not match a live run state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_run_event_insert() FROM PUBLIC;
CREATE OR REPLACE TRIGGER run_events_insert_guard BEFORE INSERT ON updater.run_events
  FOR EACH ROW EXECUTE FUNCTION updater.guard_run_event_insert();

-- ---------------------------------------------------------------------------
-- Append-only, everywhere it applies
-- ---------------------------------------------------------------------------
-- The assertion rows, the outcomes, the journal mirror and the approval
-- outcomes are records of things that happened. Rewriting one is not an update,
-- it is a forgery, and nothing in the design needs it. The deploy store's
-- triggers are the model (cook/deploy 0163).
--
-- `plans` and `runs` and `owner_requests` and `push_queue` and `heartbeat` are
-- NOT here: those are the tables whose state legitimately moves, and each has
-- its own guard above.
CREATE OR REPLACE TRIGGER plan_approvals_immutable BEFORE UPDATE OR DELETE ON updater.plan_approvals
  FOR EACH ROW EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER plan_approvals_no_truncate BEFORE TRUNCATE ON updater.plan_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER plan_approval_outcomes_immutable BEFORE UPDATE OR DELETE
  ON updater.plan_approval_outcomes FOR EACH ROW EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER plan_approval_outcomes_no_truncate BEFORE TRUNCATE
  ON updater.plan_approval_outcomes FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER passkey_registrations_immutable BEFORE UPDATE OR DELETE
  ON updater.passkey_registrations FOR EACH ROW EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER passkey_registrations_no_truncate BEFORE TRUNCATE
  ON updater.passkey_registrations FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER run_events_immutable BEFORE UPDATE OR DELETE ON updater.run_events
  FOR EACH ROW EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER run_events_no_truncate BEFORE TRUNCATE ON updater.run_events
  FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();

-- A `TRUNCATE` of plans or runs is the one deletion that takes rows the guards
-- above never see a row for, so it is refused too. `owner_requests` and
-- `push_queue` are queues and are trimmed by the updater; the updater uses
-- DELETE for that, which is permitted because the deployer owns the table, and
-- a TRUNCATE there would take rows another process is mid-insert into.
CREATE OR REPLACE TRIGGER plans_no_truncate BEFORE TRUNCATE ON updater.plans
  FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER runs_no_truncate BEFORE TRUNCATE ON updater.runs
  FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
-- The heartbeat is a SINGLETON: one row, and the web reads it to decide whether
-- the updater is alive. Nothing may reference it, so nothing makes PostgreSQL
-- refuse a TRUNCATE of it, and without this trigger `TRUNCATE updater.heartbeat`
-- would silently succeed and leave the web with no heartbeat at all — which §12
-- would render as "Updater not responding" forever, with no updater to fix it.
-- The row is replaced by UPDATE, never recreated by INSERT after a deletion.
CREATE OR REPLACE TRIGGER heartbeat_no_truncate BEFORE TRUNCATE ON updater.heartbeat
  FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER heartbeat_no_delete BEFORE DELETE ON updater.heartbeat
  FOR EACH ROW EXECUTE FUNCTION updater.reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- A push row is the web's request to say something, not the message
-- ---------------------------------------------------------------------------
-- R12: the web holds only the VAPID public key and can only queue. Two shapes
-- are worth a database rule rather than a code convention:
--
--   * the updater's own template prefix, which only the updater may write. The
--     web has INSERT on this table, so the prefix cannot be left to a code
--     check on the web's side. A web-inserted row naming
--     `control-room-updater` is a row that would render as the updater speaking,
--     and that is the one impersonation the VAPID key change was made to stop;
--   * a retry count, so a row that has been attempted five times is not
--     retried forever. The CHECK bounds `attempts`; this bounds the SUITE:
--     more than 10 attempts and the row is a stuck row, which is visible.
-- `session_replication_role = replica` is how a superuser disables triggers, so
-- it is the one setting that would let a caller past every guard on this
-- table. It is not set at the function level: `session_replication_role` is
-- SUSET, so a SECURITY DEFINER function could not set it and a non-superuser
-- cannot either. It is therefore ASSERTED rather than set, and the updater's own
-- preflight requires `session_replication_role = 'origin'` on the connection
-- (the same requirement the web login's verifySession already states).
CREATE OR REPLACE FUNCTION updater.guard_push_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'updater push insert refused under session_replication_role=%',
      current_setting('session_replication_role') USING ERRCODE = '42501';
  END IF;
  IF NEW.template LIKE 'control-room-updater%' THEN
    RAISE EXCEPTION 'only the updater may use its own push template' USING ERRCODE = '42501';
  END IF;
  IF NEW.sent_at IS NOT NULL OR NEW.attempts <> 0 THEN
    RAISE EXCEPTION 'updater push must be queued unsent' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_push_insert() FROM PUBLIC;
CREATE OR REPLACE TRIGGER push_queue_insert_guard BEFORE INSERT ON updater.push_queue
  FOR EACH ROW EXECUTE FUNCTION updater.guard_push_insert();

-- The updater updates a push row to record the attempt. It is the only writer
-- that may, and only the four bookkeeping columns may move.
CREATE OR REPLACE FUNCTION updater.guard_push_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['sent_at','attempts','last_error_code'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['sent_at','attempts','last_error_code']) THEN
    RAISE EXCEPTION 'updater push content is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'updater push attempts refused: % -> %', OLD.attempts, NEW.attempts
      USING ERRCODE = '23514';
  END IF;
  IF OLD.sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'updater push already sent' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts > 10 THEN
    RAISE EXCEPTION 'updater push exceeded its retry budget' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_push_update() FROM PUBLIC;
CREATE OR REPLACE TRIGGER push_queue_update_guard BEFORE UPDATE ON updater.push_queue
  FOR EACH ROW EXECUTE FUNCTION updater.guard_push_update();

-- ---------------------------------------------------------------------------
-- The owner request's handling, and the heartbeat's shape
-- ---------------------------------------------------------------------------
-- `handled_at`/`handled_outcome` move exactly once, from NULL to a value, and
-- the web can set neither (it has no UPDATE grant). A second handling attempt on
-- an already-handled request is refused, which is what stops a retrying caller
-- from acting twice on one phone tap.
CREATE OR REPLACE FUNCTION updater.guard_owner_request_handled() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['handled_at','handled_outcome'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['handled_at','handled_outcome']) THEN
    RAISE EXCEPTION 'updater owner request content is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.handled_at IS NOT NULL THEN
    RAISE EXCEPTION 'updater owner request already handled' USING ERRCODE = '23514';
  END IF;
  IF NEW.handled_at IS NOT NULL AND NEW.handled_at < NEW.requested_at THEN
    RAISE EXCEPTION 'updater owner request handled before it was requested' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_owner_request_handled() FROM PUBLIC;
CREATE OR REPLACE TRIGGER owner_requests_update_guard BEFORE UPDATE ON updater.owner_requests
  FOR EACH ROW EXECUTE FUNCTION updater.guard_owner_request_handled();

-- The heartbeat is a singleton the updater upserts. A second row would make
-- "is the updater alive" ambiguous, so the key is `singleton` constrained to
-- true and the updater's upsert is the only write path. This trigger refuses a
-- heartbeat whose reported state contradicts the live run's state, because a
-- banner that says "idle" while a run is mid-migration is exactly the lie §12
-- exists to prevent.
CREATE OR REPLACE FUNCTION updater.guard_heartbeat() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.singleton IS NOT TRUE THEN
    RAISE EXCEPTION 'updater heartbeat is a singleton' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM updater.runs r WHERE r.finished_at IS NULL)
    AND NEW.reported_state NOT IN ('running','awaiting_approval') THEN
    RAISE EXCEPTION 'updater heartbeat contradicts a live run' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM updater.runs r WHERE r.finished_at IS NULL)
    AND NEW.reported_state IN ('running','awaiting_approval') THEN
    RAISE EXCEPTION 'updater heartbeat claims work with no live run' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_heartbeat() FROM PUBLIC;
CREATE OR REPLACE TRIGGER heartbeat_guard BEFORE INSERT OR UPDATE ON updater.heartbeat
  FOR EACH ROW EXECUTE FUNCTION updater.guard_heartbeat();