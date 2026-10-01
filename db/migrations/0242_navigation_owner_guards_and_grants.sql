-- MIG-N part 3: what may write a chore, a visit or a pin, what may never change
-- one, and the exact grants the private-web API needs. (Navigation + Home §3a,
-- §3b: Done, Snooze, Pin this page.)
--
-- The rule this file enforces is narrow on purpose. A chore is the OWNER's own
-- statement about their own week: it schedules nothing, executes nothing and
-- starts no work. So the write guard does not check a fine-grained action
-- string — it re-reads the live role grant inside the database and requires the
-- identity named on the row to be an ACTIVE HUMAN OWNER with a tenant-wide
-- grant, at the time the row was written. That is the same predicate 0195
-- (module install approval) and 0209 (declared output) use, and it is checked
-- here rather than trusted from the caller because the caller is a login, not a
-- person: the web login holding INSERT is not the same thing as the owner of
-- this particular chore.
--
-- This is deliberately the OWNER's grant that is checked, not "any caller with
-- some grant". A row for identity A can only be written while A holds the owner
-- grant, so an operator-role login cannot record chores on the owner's behalf
-- and an owner cannot forge a row for a different identity — which is what keeps
-- one owner's rows unreadable and unwritable by another at the database, not
-- only in the service.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Every write to a chore. One function for INSERT and UPDATE on purpose: Done
-- and Snooze are the same kind of act (the owner moving their own chore's state
-- forward) and a second function would be a second copy of the owner check to
-- keep in step with this one.
CREATE FUNCTION guard_recurring_chore_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- A time in the future is not a chore's own record of when it was last done;
  -- it would make the next due date unreachable until the clock caught up. A
  -- small backdate window covers a device whose clock is slightly behind, and
  -- is the same bound 0195 and 0209 use.
  IF NEW.created_at > pg_catalog.statement_timestamp() + interval '1 minute'
    OR NEW.updated_at > pg_catalog.statement_timestamp() + interval '1 minute'
    OR NEW.updated_at < pg_catalog.statement_timestamp() - interval '5 minutes' THEN
    RAISE EXCEPTION 'recurring chore time rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_done_at IS NOT NULL AND (NEW.last_done_at < NEW.created_at - interval '1 minute'
    OR NEW.last_done_at > pg_catalog.statement_timestamp() + interval '1 minute') THEN
    RAISE EXCEPTION 'recurring chore time rejected' USING ERRCODE = '23514';
  END IF;
  -- A snooze is a bounded future hold, never a backdate: a snoozed_until in the
  -- past would be indistinguishable from "not snoozed" while silently hiding
  -- the chore from its owner's panel until the next read anyway. Refused rather
  -- than clamped, so a caller that meant something else hears about it.
  IF NEW.snoozed_until IS NOT NULL AND NEW.snoozed_until <= pg_catalog.statement_timestamp() THEN
    RAISE EXCEPTION 'recurring chore snooze rejected' USING ERRCODE = '23514';
  END IF;
  -- The row cannot be re-pointed at another identity, another tenant, or
  -- another chore, and its own cadence and title are frozen once written. A
  -- cadence change is a NEW chore, not an edit: recomputing "when was this next
  -- due" from a changed cadence while last_done_at stays put would silently
  -- rewrite the owner's history of when they last did it. There is no update
  -- path for those columns in the grant (0242) either, so this is the database
  -- refusing what the grant already withholds.
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id <> OLD.tenant_id OR NEW.chore_id <> OLD.chore_id
    OR NEW.owner_identity_id <> OLD.owner_identity_id OR NEW.title <> OLD.title
    OR NEW.target_page_key <> OLD.target_page_key OR NEW.plain_schedule <> OLD.plain_schedule
    OR NEW.cron_expression <> OLD.cron_expression OR NEW.timezone <> OLD.timezone
    OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'recurring chore rejected' USING ERRCODE = '23514';
  END IF;
  -- Only the two actions the panel offers move a chore, and both move it FORWARD:
  --   * Done pushes last_done_at forward, which pushes the next due date out.
  --   * Snooze pushes snoozed_until forward, which hides it until then.
  -- Neither may be rewound, so a retry with a stale value or a lost response
  -- cannot make a chore due again after the owner marked it done. This is the
  -- same monotonic rule 0219 applies to the surface cursor, and it is enforced
  -- in the database as well as in the service so a second caller cannot skip it.
  IF TG_OP = 'UPDATE' AND (NEW.last_done_at IS DISTINCT FROM OLD.last_done_at
      AND (OLD.last_done_at IS NOT NULL AND NEW.last_done_at < OLD.last_done_at))
    THEN
    RAISE EXCEPTION 'recurring chore rejected' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.snoozed_until IS DISTINCT FROM OLD.snoozed_until
    AND OLD.snoozed_until IS NOT NULL AND NEW.snoozed_until < OLD.snoozed_until THEN
    RAISE EXCEPTION 'recurring chore rejected' USING ERRCODE = '23514';
  END IF;
  -- The live owner grant, re-read here. Same shape and same reason as 0195's
  -- guard: whoever holds INSERT still cannot write a chore for an identity that
  -- is not the active human owner of this tenant right now, nor outside a
  -- tenant-wide grant.
  IF NOT EXISTS (SELECT 1 FROM public.control_identities i
      JOIN public.control_role_grants g ON g.tenant_id = i.tenant_id AND g.identity_id = i.id
      WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.owner_identity_id
        AND i.actor_type = 'human' AND i.state = 'active'
        AND g.role_key = 'owner' AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > NEW.updated_at)
        AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'projects.read')
        AND g.project_ids ? '*') THEN
    RAISE EXCEPTION 'recurring chore needs the owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_recurring_chore_write() FROM PUBLIC;

CREATE TRIGGER recurring_chores_guard BEFORE INSERT OR UPDATE ON recurring_chores
  FOR EACH ROW EXECUTE FUNCTION public.guard_recurring_chore_write();

-- A chore is removed only by its down migration. An owner who wants one gone
-- needs a new migration; a DELETE path would be a way to erase the record of
-- what the owner was asked to do, and nothing in the panel needs one — Done
-- stops the row appearing, which is the action the owner actually wants.
CREATE TRIGGER recurring_chores_no_delete BEFORE DELETE ON recurring_chores
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER recurring_chores_no_truncate BEFORE TRUNCATE ON recurring_chores
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- ---------------------------------------------------------------------------------------
-- page_visits: an observation the owner cannot forge on someone else's behalf, and cannot
-- rewind. Both properties are the same two clauses the chore guard uses, kept in one
-- function because a visit is exactly that: the owner opening their own page.
-- ---------------------------------------------------------------------------------------
--
-- `last_opened_at` and `open_count` MUST MOVE FORWARD. The tile rule reads
-- "most recently opened, most recent first" and takes the top few, so a visit
-- that moved backwards would reorder the owner's own Home — and a retry from a
-- tab that lost its response, arriving late, would otherwise push a page the
-- owner just opened back down the list. GREATEST in the service's upsert plus
-- this guard means neither a stale retry nor a hand-written UPDATE can do it.
--
-- The row cannot be re-pointed at another owner, tenant or page: a visit
-- counter is a fact about one owner opening one page.
CREATE FUNCTION guard_page_visit_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.last_opened_at > pg_catalog.statement_timestamp() + interval '1 minute'
    OR NEW.updated_at > pg_catalog.statement_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'page visit rejected' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id <> OLD.tenant_id OR NEW.page_key <> OLD.page_key
    OR NEW.owner_identity_id <> OLD.owner_identity_id
    OR NEW.last_opened_at < OLD.last_opened_at
    OR NEW.open_count < OLD.open_count) THEN
    RAISE EXCEPTION 'page visit rejected' USING ERRCODE = '23514';
  END IF;
  -- The same live-owner read 0195 and the chore guard above use, for the same
  -- reason: holding INSERT is not the same as being the owner whose Home this is.
  IF NOT EXISTS (SELECT 1 FROM public.control_identities i
      JOIN public.control_role_grants g ON g.tenant_id = i.tenant_id AND g.identity_id = i.id
      WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.owner_identity_id
        AND i.actor_type = 'human' AND i.state = 'active'
        AND g.role_key = 'owner' AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > NEW.updated_at)
        AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'projects.read')
        AND g.project_ids ? '*') THEN
    RAISE EXCEPTION 'page visit needs the owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_page_visit_write() FROM PUBLIC;
CREATE TRIGGER page_visits_guard BEFORE INSERT OR UPDATE ON page_visits
  FOR EACH ROW EXECUTE FUNCTION public.guard_page_visit_write();

-- Visits are an observation with no use after the fact: the tile rule only ever
-- reads the most recent, and a deleted row is indistinguishable from one that
-- was never opened. There is no DELETE grant either.
CREATE TRIGGER page_visits_no_delete BEFORE DELETE ON page_visits
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER page_visits_no_truncate BEFORE TRUNCATE ON page_visits
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- ---------------------------------------------------------------------------------------
-- page_pins: this one IS deletable, deliberately and only here.
-- ---------------------------------------------------------------------------------------
-- "Pin this page" is a toggle (§3c), so unpinning is a real owner action with no
-- other spelling — unlike a chore, where Done is the action and the row is the
-- record. So page_pins gets a DELETE grant and no append-only trigger on it,
-- while page_visits keeps both. That asymmetry is the reason the two tables are
-- not one table with a nullable flag.
--
-- A pin can be re-pointed or have its order rewritten only by the owner, checked
-- the same way as above. `pinned_at` is NOT required to move forward: a pin that
-- already exists and is re-pinned is the owner putting it back at the back of
-- their own order, which is their decision to make, not a forgery.
CREATE FUNCTION guard_page_pin_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.pinned_at > pg_catalog.statement_timestamp() + interval '1 minute'
    OR NEW.updated_at > pg_catalog.statement_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'page pin rejected' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id <> OLD.tenant_id OR NEW.page_key <> OLD.page_key
    OR NEW.owner_identity_id <> OLD.owner_identity_id) THEN
    RAISE EXCEPTION 'page pin rejected' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.control_identities i
      JOIN public.control_role_grants g ON g.tenant_id = i.tenant_id AND g.identity_id = i.id
      WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.owner_identity_id
        AND i.actor_type = 'human' AND i.state = 'active'
        AND g.role_key = 'owner' AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > NEW.updated_at)
        AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'projects.read')
        AND g.project_ids ? '*') THEN
    RAISE EXCEPTION 'page pin needs the owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_page_pin_write() FROM PUBLIC;
CREATE TRIGGER page_pins_guard BEFORE INSERT OR UPDATE ON page_pins
  FOR EACH ROW EXECUTE FUNCTION public.guard_page_pin_write();

-- A pin is never removed except by the owner unpinning it, and the guard above
-- is a BEFORE INSERT OR UPDATE trigger, so DELETE is left to the owner's own
-- DELETE grant and to the down migration. A TRUNCATE is refused for every table
-- regardless of grant: nothing in the application should ever empty these.
CREATE TRIGGER page_pins_no_truncate BEFORE TRUNCATE ON page_pins
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- ---------------------------------------------------------------------------------------
-- Grants: exactly what the private-web API needs, and nothing more.
-- ---------------------------------------------------------------------------------------
--
-- Every one of these tables is read with a tenant_id AND owner_identity_id
-- predicate, and every write names the owner from the authenticated session, so
-- the grant is what makes it IMPOSSIBLE for the web login to reach another
-- owner's rows rather than merely unlikely. A login holding a table-wide SELECT
-- can see every row; the isolation is in the query, and the owner grant inside
-- each guard is what stops a forged one.
--
-- recurring_chores: SELECT, INSERT (the owner declares one) and column-scoped
-- UPDATE of exactly the four columns Done and Snooze move (last_done_at,
-- snoozed_until, updated_at — and updated_at only because the table's own CHECK
-- requires updated_at >= created_at and the guard requires it to advance). No
-- DELETE: a chore is removed only by its down migration, which 0240 states and
-- which the guard enforces.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT, INSERT ON recurring_chores TO control_room_private_web';
    EXECUTE 'GRANT UPDATE (last_done_at, snoozed_until, updated_at) ON recurring_chores TO control_room_private_web';
    -- page_visits: an upsert on every navigation. GREATEST in the statement keeps
    -- it retry-safe; the guard refuses any decrease outright.
    EXECUTE 'GRANT SELECT, INSERT ON page_visits TO control_room_private_web';
    EXECUTE 'GRANT UPDATE (last_opened_at, open_count, updated_at) ON page_visits TO control_room_private_web';
    -- page_pins: the only table in this migration that grants DELETE, because
    -- "Pin this page" is a toggle and unpinning needs a spelling. It is still
    -- scoped to the owner's own rows by the same predicate as the SELECT.
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON page_pins TO control_room_private_web';
    EXECUTE 'GRANT UPDATE (pinned_at, updated_at) ON page_pins TO control_room_private_web';
  END IF;
END $$;