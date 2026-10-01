-- MIG-A (plan v4.3 §2.1), fix round 3: close the error-channel cross-tenant read,
-- de-duplicate Needs-you per description, and give an escalated description a
-- deliberate way out.
--
-- This file exists because three round-3 review findings reached past round 2's
-- fixes. Each section names the measurement that proved the hole, because a fix
-- without the number it closes is a fix nobody can check later.
--
--   1. N-B1 (HIGH): the tenant-bound VIEW was not a `security_barrier`, so the
--      caller's own cheap filter ran FIRST on every row -- including other
--      tenants' -- and a cast or a 1/0 in that filter turned another tenant's
--      row into an error message.
--   2. N-B3 (MEDIUM): a description that failed twice could never run again in
--      that project, and every further press added another Needs-you item.
--   3. N9: 0204's guard recomputed only the `initial` project scope, so a
--      `resplit` raise was refused by its own pre-check.
--
-- WHAT THIS FILE DOES NOT DO, stated first so the numbers are not oversold: it
-- does not make the intake login blind. It still reads its own tenant's current
-- suggestion, it still appends one, and the owner still reads its own. A
-- security_barrier costs a little speed on a small view and buys the one property
-- 0203 claimed and did not have: an error from one of these views reveals nothing
-- about a row the caller could not already read.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. `security_barrier` on the views the shared logins read.
-- ---------------------------------------------------------------------------
--
-- THE MEASUREMENT (N-B1, real PostgreSQL 17, as the production logins). The
-- intake login was bound to tenant A; tenant B held one current suggestion. As
-- the bound intake login:
--
--   reloptions of work_batch_current_split_suggestions        = null
--   SELECT count(*) WHERE tenant_id = B                                    -> 0
--   WHERE (proposal->'tasks'->0->>'title')::int = 0      ERROR ... the title
--   WHERE (proposal::text)::int = 0                     ERROR ... the proposal
--   WHERE request_key::int = 0                          ERROR ... the key
--   WHERE CASE WHEN proposal::text LIKE '%SECRET%' THEN 1/0 ELSE 1 END = 0
--                                                    ERROR: division by zero
--   the same cast on the BASE table                                     -> no error
--
-- The base table is safe and the view is not, and the difference is one reloption.
-- A view runs with its OWNER's rights, so it bypasses the base table's RLS. What
-- it does NOT bypass is PostgreSQL's QUAL ORDER: for a plain view, a filter the
-- CALLER adds is evaluated on every row the view produces, and only then is the
-- view's own WHERE clause applied. The predicate in 0203 is a SECURITY DEFINER
-- SQL function -- costed high, never inlined -- so it is the late filter, and
-- the caller's cheap `::int` cast is the early one. A built-in cast needs no
-- function the caller may create, and TEMP is revoked from the intake login, so
-- this was reachable with nothing but PostgreSQL.
--
-- `security_barrier = true` is exactly the promise that fixes it: the view's own
-- qualifiers are evaluated BEFORE any qual the caller supplies. PostgreSQL's own
-- guidance is that a view whose WHERE clause is a defence rather than a
-- convenience must be a barrier.
--
-- THE SWEEP, and what it does and does not buy. The review asked for every other
-- view granted to a shared login to be checked for the same SHAPE, so each of the
-- remaining five was measured with the same four casts as a tenant-crossing
-- caller, and the results are recorded beside the statements below rather than
-- asserted in prose. The rule is the same in every case: a view owned by the
-- schema owner, reading a table that a shared login may reach, exposes the rows
-- its owner can see to a caller filter that runs first.
--
--   work_batch_effective_queue_admissions  (0104)  base has RLS
--   pipeline_ordered_stage_runs            (0105)  base has no RLS
--   installation_effective_operations_mode (0155)  base has RLS
--   control_planner_open_needs_you         (0202)  no RLS, all rows by design
--   control_project_planner_selections     (0201)  no RLS, all rows by design
--
-- The LAST TWO are stated honestly because a barrier does NOT help them and this
-- file does not pretend otherwise. Neither has a tenant predicate, so a barrier
-- only orders quals that do not exist; what they return to a shared login is every
-- row, by design, and the owner store filters by tenant in its own SQL. They are
-- given the reloption anyway because it costs nothing and means the next migration
-- does not have to re-derive the argument, but the fix for a cross-tenant READ of
-- those two would be a predicate, not a reloption, and that is not this file's
-- job.
--
-- This is a RELATION property, not a column set, so it changes no grant, no
-- predicate and no result: on a correct install every one of these views returns
-- exactly what it returned before.
ALTER VIEW work_batch_current_split_suggestions SET (security_barrier = true);
ALTER VIEW work_batch_effective_queue_admissions SET (security_barrier = true);
ALTER VIEW pipeline_ordered_stage_runs SET (security_barrier = true);
ALTER VIEW installation_effective_operations_mode SET (security_barrier = true);
ALTER VIEW control_planner_open_needs_you SET (security_barrier = true);
ALTER VIEW control_project_planner_selections SET (security_barrier = true);

-- The barrier has to be PINNED, or it is a one-line change nothing notices. The
-- schema digest could carry it -- `readPrivateWebSchemaDigest` records columns,
-- constraints, indexes, triggers, policies and functions, and NOT a view's
-- reloptions, so dropping the barrier changed no digest at all. The preflight
-- names the six views instead, which fails the STARTUP of every login on a
-- database where one of them lost the property, whether or not anyone re-runs
-- the digest.
--
-- ---------------------------------------------------------------------------
-- 2. The Needs-you item is keyed on the SCOPE THAT ESCALATED, not on the fresh
--    request key the browser mints per press.
-- ---------------------------------------------------------------------------
--
-- THE MEASUREMENT (N-B3, real coordinator, PostgreSQL stores). Six presses of ONE
-- description, a fresh `orchestrator:<uuid>` key each, against a broken planner:
-- 5 Needs-you items and 5 open inbox items, because the ledger's identity was the
-- request key and the request key is new every time.
--
-- The fix is to make the ledger's identity the thing that actually escalated: the
-- project-and-description scope. Two descriptions in one project therefore still
-- get two items -- the property the project scope exists to protect -- while any
-- number of presses of ONE description converge on one item and one inbox entry.
--
-- `id` and `action_item_id` become a digest of (tenant, project, scope) rather
-- than an md5 of the request key, truncated to the 32 hex characters 0202's id
-- CHECK allows, so the ledger row and the inbox row are the same item and the
-- inbox's `ON CONFLICT (tenant_id,id)` makes a repeat of the SAME escalation a
-- no-op at the database rather than a promise.
--
-- The `request_key` that first escalated is KEPT, because it is the honest
-- evidence of which request hit the second failure, and the owner-facing view
-- still names it. It stops being the identity.
ALTER TABLE control_planner_needs_you_items
  ADD COLUMN scope_key text CHECK (scope_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$');

-- THE BACKFILL IS DERIVED FROM THE COUNTERS, NOT GUESSED. A row does not record
-- whether it was raised for an `initial` or a `resplit` request, so the kind has
-- to be recovered: the row's own four candidate scopes are recomputed exactly as
-- the guard below recomputes them, and the one that names a LIVE counter at or
-- above the count the row claims is the scope that earned it. A row with no such
-- counter is an escalation the database cannot account for, so this REFUSES
-- rather than writing a scope that matches nothing -- an escalation we cannot
-- place is not an escalation we can de-duplicate.
DO $$ DECLARE
  row_record record;
  candidate record;
  chosen text;
BEGIN
  -- `candidate` is a declared record, not a bare name: plpgsql requires a record
  -- variable or a list of scalars to iterate, and `FOR x IN <query>` over a
  -- one-column query is the query form. Declaring it is what makes the loop legal
  -- -- the first draft wrote `FOR candidate IN ...` with no DECLARE and failed at
  -- apply time with "loop variable of loop over rows must be a record variable".
  FOR row_record IN
    SELECT n.tenant_id,n.project_id,n.id,n.request_key,n.failure_count,n.owner_request_digest
    FROM public.control_planner_needs_you_items n WHERE n.scope_key IS NULL
  LOOP
    chosen := NULL;
    -- The project scopes are tried BEFORE the request scopes, deterministically.
    -- A request scope is derived from the request key alone, so it is the weaker
    -- of the two claims -- but it is only taken when no project scope names a live
    -- counter, and both are refused unless the guard below re-derives them.
    FOR candidate IN
      SELECT s FROM (VALUES
        (public.planner_failure_scope_key('project', jsonb_build_object('kind','initial',
          'tenantId',row_record.tenant_id::text,'projectId',row_record.project_id::text,
          'ownerRequest',row_record.owner_request_digest::text))),
        (public.planner_failure_scope_key('project', jsonb_build_object('kind','resplit',
          'tenantId',row_record.tenant_id::text,'projectId',row_record.project_id::text,
          'ownerRequest',row_record.owner_request_digest::text))),
        (public.planner_failure_scope_key('initial', jsonb_build_object(
          'tenantId',row_record.tenant_id::text,'projectId',row_record.project_id::text,
          'requestKey',row_record.request_key::text))),
        (public.planner_failure_scope_key('resplit', jsonb_build_object(
          'tenantId',row_record.tenant_id::text,'projectId',row_record.project_id::text,
          'requestKey',row_record.request_key::text)))
      ) AS scopes(s) ORDER BY (s LIKE 'project:%') DESC, s
    LOOP
      IF EXISTS (SELECT 1 FROM public.control_planner_failure_counters c
          WHERE c.tenant_id=row_record.tenant_id AND c.project_id=row_record.project_id
            AND c.scope_key=candidate.s AND c.failure_count>=row_record.failure_count
            AND c.cleared_at IS NULL) THEN
        chosen := candidate.s; EXIT;
      END IF;
    END LOOP;
    IF chosen IS NULL THEN
      RAISE EXCEPTION 'planner needs-you backfill cannot place an existing escalation';
    END IF;
    UPDATE public.control_planner_needs_you_items SET scope_key=chosen
      WHERE tenant_id=row_record.tenant_id AND id=row_record.id;
  END LOOP;
END $$;
ALTER TABLE control_planner_needs_you_items ALTER COLUMN scope_key SET NOT NULL;

-- ONE item per escalating scope per tenant. This is the index that ends the
-- flood, and it is also what the adapter's ON CONFLICT names. The existing
-- `UNIQUE (tenant_id,project_id,request_key)` stays: it is what makes a repeat of
-- the SAME request a no-op, and this is what makes a repeat of the SAME
-- DESCRIPTION a no-op. Neither subsumes the other.
CREATE UNIQUE INDEX control_planner_needs_you_scope_unique
  ON public.control_planner_needs_you_items (tenant_id,project_id,scope_key);

-- ---------------------------------------------------------------------------
-- 3. The deliberate owner retry: a description that escalated can be tried
--    again, and trying it again RESETS.
-- ---------------------------------------------------------------------------
--
-- THE PROBLEM. `count(projectScope) >= 2` was checked BEFORE the planner, and the
-- only thing that ever cleared the counter was a success on the SAME description
-- -- which can never happen, because the description is refused before the planner
-- ever runs. Nothing else in the system touched the counter: not changing the
-- chief of staff, not the Needs-you item, not the passage of time. A description
-- that hit one transient planner fault was dead in that project forever, and the
-- copy the owner was shown ("try again, or choose another chief of staff") named
-- two things that did not work.
--
-- THE FIX. A retry after escalation is a DELIBERATE owner act, made explicit
-- rather than inferred, and it is bounded so it is not a run loop:
--
--   * `owner_retry_cleared_at` is a ONE-SHOT LATCH, not a count reset. Setting
--     the count back to 1 would also let the press through and would need no
--     schema change, but it would throw away the fact that the description has
--     failed twice, which is what the guard and the owner's inbox item are
--     evidence of. A latch keeps the count, keeps the evidence, and makes "the
--     owner asked once" itself a record.
--   * The latch is granted by `control_room_planner_grant_owner_retry` below,
--     which is SECURITY DEFINER and takes exactly the scope keys the caller's own
--     request computed. It refuses a counter that is not live at >= 2, and refuses
--     one that already holds a latch, so at most ONE retry exists per escalation
--     and a new escalation (two fresh failures) is what earns the next one.
--   * The coordinator SPENDS the latch in one conditional UPDATE that removes the
--     latch and changes nothing else, before it runs. The count stays at 2 or
--     more while that run is in flight, so every other press is still refused by
--     the counter; the run then either succeeds (the counter is cleared and the
--     description is ordinary again) or fails (the count goes up, the description
--     is still escalated, and the owner is asked again). So one owner grant is one
--     run, however the presses arrive.
--
--     (Fix round 5 changed this. The first version spent the latch by CLEARING the
--     counter, so a failed retry restarted at 1 -- but every concurrent press then
--     read "not escalated" and ran (R5-M1), and the read added to stop them could
--     not tell a spend from a success, which locked any description that failed
--     once and then worked (R5-B1). No database has run this file; it is amended
--     in place rather than followed by a new migration.)
--
--   WHAT "ONLY THE OWNER CAN ASK" DOES AND DOES NOT MEAN HERE, corrected after
--   round 4 measured it. It is true that the ONLY way to SET a latch from SQL is
--   this function, and that after round 4's removal of the coordinator's EXECUTE
--   (db/roles/task_coordinator_roles.sql now REVOKEs it, and no coordinator code
--   called it) the only login holding EXECUTE is the owner's own web login. It is
--   NOT true that the database keeps the coordinator out of the counter table: it
--   holds a six-column UPDATE (0202's five plus `owner_retry_cleared_at`) and has
--   since 0202, so it can UNSET a latch and can clear an escalated counter with no
--   success at all. The trigger constrains WHICH transitions are legal, not who
--   asks. The bound "one run per owner grant" is therefore enforced by the
--   COORDINATOR -- the latch is spent in one conditional UPDATE that reports
--   whether it spent one, and the press runs only then -- and not by the database
--   against that login. The claims in this file's earlier draft and in the store comment
--   were false and have been corrected rather than left standing.
ALTER TABLE control_planner_failure_counters
  ADD COLUMN owner_retry_cleared_at timestamptz;
-- A latch is only meaningful on a LIVE counter at the escalation point. A cleared
-- counter carries no failure to retry, and one below 2 never escalated, so a latch
-- there would be a claim about nothing. This is the same rule as the trigger's,
-- which is what stops a statement satisfying the CHECK without being a grant.
ALTER TABLE control_planner_failure_counters
  ADD CONSTRAINT control_planner_failure_counters_retry_check
  CHECK (owner_retry_cleared_at IS NULL OR (cleared_at IS NULL AND failure_count >= 2));
CREATE INDEX control_planner_failure_counters_owner_retry
  ON public.control_planner_failure_counters (tenant_id,project_id,scope_key)
  WHERE owner_retry_cleared_at IS NOT NULL;

-- The ONE admitted transition, widened by exactly one value and one shape. The
-- rules that 0202 already stated are kept byte-identical; what is new is:
--
--   * NULL -> a timestamp, ONLY on a row that was live, uncleared and at >= 2, so
--     it cannot be used to fake the precondition it then satisfies, and it leaves
--     the count, the last failure and the clear stamp untouched, so it cannot lower
--     the evidence or resurrect a counter `clear()` zeroed.
--   * a timestamp -> NULL as the SPEND (nothing else changes: the count stays at
--     2 or more until the granted run's own outcome), or as part of a clear (the
--     success that ends the escalation).
--   * an increment carries the latch unchanged, whatever it is.
CREATE OR REPLACE FUNCTION guard_planner_failure_counter_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.failure_count<>1 OR NEW.cleared_at IS NOT NULL OR NEW.last_failure_at IS NULL
      OR NEW.owner_retry_cleared_at IS NOT NULL THEN
      RAISE EXCEPTION 'planner failure counter insert rejected';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.version<>OLD.version+1
    OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'planner failure counter update rejected';
  END IF;
  -- The owner retry, as its own branch so the rules above stay byte-identical to
  -- 0202's. Everything the retry does NOT touch is compared, and the two that
  -- could lower the evidence are refused rather than merely unchanged.
  IF OLD.owner_retry_cleared_at IS NULL AND NEW.owner_retry_cleared_at IS NOT NULL THEN
    IF NEW.failure_count IS DISTINCT FROM OLD.failure_count
      OR NEW.last_failure_at IS DISTINCT FROM OLD.last_failure_at
      OR NEW.cleared_at IS DISTINCT FROM OLD.cleared_at
      OR OLD.cleared_at IS NOT NULL OR OLD.failure_count<2 THEN
      RAISE EXCEPTION 'planner failure counter update rejected';
    END IF;
    RETURN NEW;
  END IF;
  -- A latch that CHANGES to a new value is refused, so it can be granted once and
  -- not re-stamped by a later writer. The one remaining legal change is NOT NULL
  -- -> NULL, and only the spend and the clear below may make it.
  IF NEW.owner_retry_cleared_at IS DISTINCT FROM OLD.owner_retry_cleared_at
    AND NEW.owner_retry_cleared_at IS NOT NULL THEN
    RAISE EXCEPTION 'planner failure counter update rejected';
  END IF;
  -- THE SPEND: the latch goes NOT NULL -> NULL and NOTHING ELSE moves. The count
  -- stays at 2 or more, so while the run the owner granted is in flight the
  -- description is still escalated and every other press is refused by the
  -- counter itself; that run's own outcome then clears it (success) or increments
  -- it (failure). Fix round 5 (R5-B1, R5-M1): the first spend zeroed the count and
  -- stamped `cleared_at` here, so every peer read "not escalated" and ran, and the
  -- read added to hold them could not tell a spend from a success, which locked
  -- any description that failed once and then worked.
  IF OLD.owner_retry_cleared_at IS NOT NULL AND NEW.owner_retry_cleared_at IS NULL
    AND NEW.failure_count=OLD.failure_count
    AND NEW.last_failure_at IS NOT DISTINCT FROM OLD.last_failure_at
    AND NEW.cleared_at IS NOT DISTINCT FROM OLD.cleared_at THEN
    RETURN NEW;
  END IF;
  -- An increment carries the latch UNCHANGED. Counting a failure is not a way to
  -- spend or drop an owner's retry; before round 5 this branch did not compare the
  -- column, so an increment could silently discard a granted retry.
  IF NEW.failure_count=OLD.failure_count+1
    AND NEW.last_failure_at IS NOT NULL AND NEW.cleared_at IS NULL
    AND NEW.owner_retry_cleared_at IS NOT DISTINCT FROM OLD.owner_retry_cleared_at THEN
    RETURN NEW;
  END IF;
  -- The clear: the success transition, which ends an escalation. A latch still
  -- standing on the row (one the press did not need to spend) ends with it, so it
  -- cannot outlive the escalation it belonged to and authorise a later run.
  IF NEW.failure_count=0 AND NEW.cleared_at IS NOT NULL
    AND NEW.last_failure_at IS NOT NULL AND NEW.owner_retry_cleared_at IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'planner failure counter update rejected';
END $$;

-- ---------------------------------------------------------------------------
-- 4. The Needs-you guard, rebuilt for the scope identity and BOTH request kinds.
-- ---------------------------------------------------------------------------
--
-- Two changes, each answering a measured failure:
--
--   a. The project's scope is recomputed for `initial` AND for `resplit`. 0204
--      recomputed only `initial`, so a raise from a re-split passed the adapter's
--      own check and was then refused by this trigger -- measured: "planner needs-
--      you insert rejected" on a resplit raise whose counter was at 2. The
--      application accepts both kinds (plannerNeedsYouScopeKeysV1), so the guard
--      now accepts both.
--
--   b. The row must name a `scope_key` that (i) is one of the scopes this request
--      could have incremented, and (ii) names a LIVE counter at or above the count
--      the row claims. That is 0204's rule, expressed against the column that now
--      carries the identity, so the two are checked against each other rather than
--      one being trusted. Matching the counter on the scope the row NAMES -- and
--      requiring that scope to be one this request could have owned -- is what
--      stops one project's second failure licensing an escalation for a different
--      description, and one description's count licensing a raise about another
--      scope.
--
-- SECURITY DEFINER is kept, for 0204's measured reason: the digest comparison
-- calls `planner_failure_scope_key`, and a plain trigger function runs as the
-- INSERTing role, which has no EXECUTE on it. It writes nothing and returns only
-- the row.
CREATE OR REPLACE FUNCTION guard_planner_needs_you_item_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  project_key_initial text;
  project_key_resplit text;
  request_key_initial text;
  request_key_resplit text;
BEGIN
  project_key_initial := public.planner_failure_scope_key('project', jsonb_build_object(
    'kind', 'initial', 'tenantId', NEW.tenant_id::text, 'projectId', NEW.project_id::text,
    'ownerRequest', NEW.owner_request_digest));
  project_key_resplit := public.planner_failure_scope_key('project', jsonb_build_object(
    'kind', 'resplit', 'tenantId', NEW.tenant_id::text, 'projectId', NEW.project_id::text,
    'ownerRequest', NEW.owner_request_digest));
  request_key_initial := public.planner_failure_scope_key('initial', jsonb_build_object(
    'tenantId', NEW.tenant_id::text, 'projectId', NEW.project_id::text, 'requestKey', NEW.request_key::text));
  request_key_resplit := public.planner_failure_scope_key('resplit', jsonb_build_object(
    'tenantId', NEW.tenant_id::text, 'projectId', NEW.project_id::text, 'requestKey', NEW.request_key::text));
  IF NEW.failure_count<2 OR NEW.reason_code<>'orchestrator_failed_twice'
    OR NEW.id<>'planner-needs-you:' || substring(pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(NEW.tenant_id || '/' || NEW.project_id || '/' || NEW.scope_key,'UTF8')),'hex') from 1 for 32)
    OR NEW.action_item_id IS DISTINCT FROM 'attention:planner:' || substring(pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(NEW.tenant_id || '/' || NEW.project_id || '/' || NEW.scope_key,'UTF8')),'hex') from 1 for 32)
    OR NEW.scope_key NOT IN (project_key_initial, project_key_resplit, request_key_initial, request_key_resplit)
    OR NOT EXISTS (SELECT 1 FROM public.control_identities i
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.raised_by_identity_id
        AND i.actor_type='agent' AND i.state='active')
    OR NOT EXISTS (SELECT 1 FROM public.control_planner_failure_counters c
      WHERE c.tenant_id=NEW.tenant_id AND c.project_id=NEW.project_id
        AND c.scope_key=NEW.scope_key
        AND c.failure_count>=NEW.failure_count AND c.cleared_at IS NULL) THEN
    RAISE EXCEPTION 'planner needs-you insert rejected';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 5. The owner-facing ledger carries the scope, so the item is addressable by the
--    description that escalated and the retry can name it.
-- ---------------------------------------------------------------------------
--
-- `CREATE OR REPLACE VIEW` cannot add a column, so the view is dropped and
-- recreated -- and it is recreated as a `security_barrier` view, like every other
-- one in section 1. The column list is otherwise identical, so the existing owner
-- read keeps working; `scope_key` is ADDED and is a digest, never the owner's
-- words, so the ledger stays content-free exactly as 0202's header promised.
DROP VIEW control_planner_open_needs_you;
CREATE VIEW control_planner_open_needs_you WITH (security_barrier = true) AS
  SELECT s.tenant_id, s.project_id, s.id, s.request_key, s.reason_code, s.failure_count,
    s.raised_by_identity_id, s.raised_at, s.action_item_id, s.scope_key,
    false AS starts_work, false AS grants_execution_authority
  FROM public.control_planner_needs_you_items s;
-- THE DROP DISCARDS THE VIEW'S GRANTS. A recreated view is a new relation with a
-- NULL ACL, so control_room_private_web loses the SELECT 0202 gave it at this
-- point (measured in review round 5: the ACL is NULL after this statement on a
-- database that had the grant). It is restored by db/roles/private_web_roles.sql,
-- which re-grants SELECT on the view and runs as a `grants` entry after every
-- migration, so installs and upgrades converge. A cluster that applies this file
-- by hand must re-run the role files, or the owner's Needs-you read fails 42501.
-- (An earlier draft said the grant "survives the DROP/CREATE"; it does not.)

-- ---------------------------------------------------------------------------
-- 6. The owner retry, as a READY-MADE OPERATION.
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER, and deliberately so: the whole point is that the owner's web
-- login keeps NO privilege at all on control_planner_failure_counters. 0202 says
-- so in terms ("the web login must not be able to clear a counter or raise an
-- item") and the preflight's column audit enforces it for every column, so
-- granting the web login an UPDATE here would mean weakening a reviewed invariant
-- and restating it. One pinned function is the smaller change: the private-web
-- preflight grows one allow-list entry for it, pinned exactly as 0203's
-- visibility predicate is, and no login gains a column.
--
-- It is an `UPDATE ... WHERE scope_key = ANY(keys)` with no other predicate a
-- caller controls, so it cannot touch a counter outside the scopes this request
-- computed, and the trigger above refuses the write unless the preconditions hold
-- -- the function does not decide, it only offers. It returns how many counters
-- were granted, so "nothing was granted" is observable rather than silent, which
-- is what lets the owner path tell "you already have a retry waiting" from "there
-- was nothing to retry".
CREATE FUNCTION control_room_planner_grant_owner_retry(tenant text, project text, keys text[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE changed integer;
BEGIN
  -- GREATEST, not statement_timestamp(), and the reason is a real measured
  -- failure rather than a style choice. The table's guard requires
  -- `NEW.updated_at >= OLD.updated_at`, and the two writers of this column do not
  -- share a clock: the coordinator's store stamps an INJECTED `now` (which is what
  -- makes its writes testable and replayable), while a SQL function can only use
  -- the server's. Stamping the server's time here made the very next store write
  -- -- the owner's granted retry, then the run that spends it -- fail with
  -- "planner failure counter update rejected", because the injected clock was
  -- BEHIND the value this statement had just written. GREATEST makes the
  -- column monotonic no matter which clock each writer holds, which is the only
  -- property the guard actually asks for.
  UPDATE public.control_planner_failure_counters SET owner_retry_cleared_at=statement_timestamp(),
    version=version+1, updated_at=GREATEST(updated_at, statement_timestamp())
  WHERE control_planner_failure_counters.tenant_id=tenant
    AND control_planner_failure_counters.project_id=project
    AND control_planner_failure_counters.scope_key=ANY(keys)
    AND control_planner_failure_counters.cleared_at IS NULL
    AND control_planner_failure_counters.failure_count>=2
    AND control_planner_failure_counters.owner_retry_cleared_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION control_room_planner_grant_owner_retry(text, text, text[]) FROM PUBLIC;
COMMENT ON FUNCTION control_room_planner_grant_owner_retry(text, text, text[]) IS
  'Record that the owner deliberately asked to retry an escalated description, for the given counters. Admits only a live counter at >= 2 that has not already been granted a retry, and never touches the failure count. Returns how many counters were granted, so "nothing was granted" is observable rather than silent.';

-- NO GRANT IS MADE HERE, and the reason is install order rather than taste.
--
-- This is a `migrate` entry; the role files (db/roles/*.sql) are separate
-- `grants` entries that run afterwards, so at this point in the run the two
-- logins do not exist yet and a role-existence guard here would silently grant
-- nothing. Measured rather than reasoned: the guard version of this file applied
-- cleanly and every call failed with 42501 "permission denied for function
-- control_room_planner_grant_owner_retry". The last role file then ends with
-- `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON FUNCTIONS FROM PUBLIC`, so a grant
-- issued from a migration is also revoked before anyone uses it.
--
-- The two EXECUTE grants therefore live where the rest of these logins'
-- privileges live: db/roles/task_coordinator_roles.sql (the coordinator, which
-- runs the presses) and db/roles/private_web_roles.sql (the owner, who asks).
-- That is the same place 0203's visibility predicate and 0204's scope key are
-- granted, and for the same reason.

-- A down migration is intentionally operator-authored and data refusing: it
-- revokes only what this file granted (the function, the two EXECUTE grants, the
-- two indexes, the added columns' constraints and the latch column), restores
-- 0202's view body and guard, and resets the six barriers. It restores the
-- cross-tenant error-channel read, the per-press inbox flood and the permanent
-- lockout this file closed, so the lead runs it only on a disposable cluster.
--
-- IT IS NOT AN OWNER ROLLBACK PATH, and two measured reasons say so (review
-- round 5, R5-L1):
--   * It leaves the applier's ledger rows in place, as every down file in this
--     repository does, so the ledger still claims this file is applied.
--   * Down then up again restores every name, type, default, constraint, index,
--     trigger, policy, function, ACL and comment -- but NOT column positions: the
--     re-added `owner_retry_cleared_at` and `scope_key` land one position later,
--     both schema digests (the applier's and the private-web preflight's) include
--     positions, and so the next applier run refuses with
--     `migration_live_schema_drift` and every login refuses to start.
-- A real rollback is a restore from backup.
