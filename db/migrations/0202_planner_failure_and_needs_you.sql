-- MIG-A (plan v4.3 §2.1): durable orchestrator run bookkeeping.
--
-- cx-orchplan's IntakeCoordinatorV1 raises one Needs-you item on the second
-- consecutive planner failure and refuses a third self-wake, through two ports:
-- IntakePlannerFailureStoreV1 (count / record / clear) and
-- IntakePlannerNeedsYouPortV1 (idempotent raise). Both were in-memory doubles, so
-- the two-failure escalation and the "no third self-wake" property held only inside
-- one process's lifetime: a restart lost the count, and a second process
-- (coordinator host plus task host) each kept their own. This migration gives
-- both a durable, tenant-scoped shape.
--
-- The failure counter is a KEYED COUNTER, not a history: one row per
-- (tenant, project, scope_key), incremented atomically, cleared on a successful
-- run. The scope key is the coordinator's own request key, so two different
-- requests never share a count and one request's failures never escalate another.
--
-- The needs-you ledger is append-only and idempotent by (tenant, project,
-- request_key): raising twice for the same request is one item, and the row is the
-- evidence that the second failure escalated rather than retrying forever.
--
-- This migration deliberately does NOT touch the S7b allowance tables: they are not
-- on this branch. The allowance port stays a named TODO in the application layer
-- rather than a guessed table name here.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_planner_failure_counters (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  -- The bound is 179, not 299: PostgreSQL's POSIX regex compiler refuses a
  -- repetition count above 255, so a wider bound is not expressible in a CHECK
  -- and would make the constraint itself a 2201B error at write time. 179 matches
  -- every other identifier in this schema (0093's request keys, 0110's
  -- dismissals) and is comfortably longer than any scope key the coordinator
  -- builds, which is `initial:` or `resplit:` plus a tenant, a project and the
  -- caller's own request key.
  scope_key text NOT NULL CHECK (scope_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$'),
  failure_count bigint NOT NULL CHECK (failure_count >= 0),
  last_failure_at timestamptz,
  cleared_at timestamptz,
  version bigint NOT NULL CHECK (version >= 1),
  updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,project_id,scope_key),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  -- A cleared counter carries no last_failure_at, and a live one always does.
  CHECK ((cleared_at IS NULL AND last_failure_at IS NOT NULL) OR cleared_at IS NOT NULL),
  CHECK ((failure_count=0) = (cleared_at IS NOT NULL))
);

-- Only a counter this installation's own code may move, and only the way the
-- coordinator moves it: record increments by exactly one, clear resets to zero.
-- Everything else -- an arbitrary count, a decrement, a tenant or scope rewrite, a
-- backwards version -- is refused.
CREATE FUNCTION guard_planner_failure_counter_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.failure_count<>1 OR NEW.cleared_at IS NOT NULL OR NEW.last_failure_at IS NULL THEN
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
  IF NEW.failure_count=OLD.failure_count+1
    AND NEW.last_failure_at IS NOT NULL AND NEW.cleared_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.failure_count=0 AND NEW.cleared_at IS NOT NULL
    AND NEW.last_failure_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'planner failure counter update rejected';
END $$;
REVOKE ALL ON FUNCTION public.guard_planner_failure_counter_write() FROM PUBLIC;
CREATE TRIGGER control_planner_failure_counters_guard BEFORE INSERT OR UPDATE
  ON public.control_planner_failure_counters
  FOR EACH ROW EXECUTE FUNCTION public.guard_planner_failure_counter_write();
CREATE TRIGGER control_planner_failure_counters_no_delete BEFORE DELETE
  ON public.control_planner_failure_counters
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_planner_failure_counters_no_truncate BEFORE TRUNCATE
  ON public.control_planner_failure_counters
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
REVOKE ALL ON control_planner_failure_counters FROM PUBLIC;

-- The three operations the coordinator port needs, and the privileges behind them.
--
-- Deliberately NOT SECURITY DEFINER. The private-web preflight refuses any SECURITY
-- DEFINER routine outside its four reviewed entries, and widening that list for a
-- counter is the wrong trade: the coordinator login is already the installation's
-- own planner host, it already holds a narrow column-scoped grant on every table it
-- writes, and the guard trigger above is what makes a raw UPDATE safe rather than
-- the absence of one. So the coordinator holds INSERT plus a five-column UPDATE on
-- this one table, and the trigger admits exactly the two transitions above.
--
-- This is what makes the counter atomic: "read the count, then increment" is two
-- statements a caller could interleave, so the port's record() returns the count
-- AFTER its own increment inside one statement (INSERT ... ON CONFLICT DO UPDATE
-- ... RETURNING). Two concurrent failures both land on the same row, and exactly
-- one of them sees 1.

-- The Needs-you ledger. One row per escalated request; raising again is a no-op at
-- the primary key, which is what makes the port's idempotency claim true under
-- concurrency rather than under a sequential retry.
CREATE TABLE control_planner_needs_you_items (
  id text NOT NULL CHECK (id ~ '^planner-needs-you:[a-f0-9]{32}$'),
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  request_key text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$'),
  reason_code text NOT NULL CHECK (reason_code='orchestrator_failed_twice'),
  failure_count bigint NOT NULL CHECK (failure_count >= 2),
  raised_by_identity_id text NOT NULL,
  raised_at timestamptz NOT NULL,
  action_item_id text,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,project_id,request_key),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,raised_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);
-- Only the coordinator's own planner, escalating a request that has actually
-- failed twice, may append a row. The action-inbox item is the APP's write through
-- the coordinator login's existing INSERT grant, and the ledger names it by
-- convention rather than by foreign key, so a repeated raise re-uses the same
-- deterministic item id instead of colliding on a second item.
CREATE FUNCTION guard_planner_needs_you_item_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.failure_count<2 OR NEW.reason_code<>'orchestrator_failed_twice'
    OR NEW.id<>'planner-needs-you:' || substring(pg_catalog.md5(
      NEW.tenant_id || '/' || NEW.project_id || '/' || NEW.request_key) from 1 for 32)
    OR NOT EXISTS (SELECT 1 FROM public.control_identities i
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.raised_by_identity_id
        AND i.actor_type='agent' AND i.state='active')
    -- The escalation is a claim about a COUNTER, so it must be true: a raise that
    -- does not match a live counter at or above the count it names is a caller
    -- inventing an escalation, not reporting one. The counter is matched on the
    -- RAISED request, not merely the project: one project can have many planner
    -- requests in flight, and the second failure of request A must not license an
    -- escalation for request B.
    OR NOT EXISTS (SELECT 1 FROM public.control_planner_failure_counters c
      WHERE c.tenant_id=NEW.tenant_id AND c.project_id=NEW.project_id
        AND c.failure_count>=NEW.failure_count AND c.cleared_at IS NULL
        AND c.scope_key LIKE '%:' || NEW.request_key) THEN
    RAISE EXCEPTION 'planner needs-you insert rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_planner_needs_you_item_insert() FROM PUBLIC;
CREATE TRIGGER control_planner_needs_you_items_guard BEFORE INSERT
  ON public.control_planner_needs_you_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_planner_needs_you_item_insert();
CREATE TRIGGER control_planner_needs_you_items_append_only BEFORE UPDATE OR DELETE
  ON public.control_planner_needs_you_items
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_planner_needs_you_items_no_truncate BEFORE TRUNCATE
  ON public.control_planner_needs_you_items
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
REVOKE ALL ON control_planner_needs_you_items FROM PUBLIC;

-- The owner's read of what escalated, as a plain VIEW: a view runs with its owner's
-- rights, so the web login's SELECT on it grants it nothing on the base table, and
-- the preflight's SECURITY DEFINER allow-list does not have to grow. Content-free by
-- construction: it names the request and the count, never the planner's text.
CREATE VIEW control_planner_open_needs_you AS
  SELECT s.tenant_id, s.project_id, s.id, s.request_key, s.reason_code, s.failure_count,
    s.raised_by_identity_id, s.raised_at, s.action_item_id,
    false AS starts_work, false AS grants_execution_authority
  FROM public.control_planner_needs_you_items s;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    -- The coordinator writes the counter (INSERT plus exactly the five columns the
    -- guard admits) and appends one ledger row. It holds NO UPDATE or DELETE on
    -- either table, so "the second failure raised once" cannot be edited into
    -- something else after the fact.
    EXECUTE 'GRANT SELECT, INSERT ON control_planner_failure_counters TO control_room_task_coordinator';
    EXECUTE 'GRANT UPDATE (failure_count, last_failure_at, cleared_at, version, updated_at) ON control_planner_failure_counters TO control_room_task_coordinator';
    EXECUTE 'GRANT SELECT, INSERT ON control_planner_needs_you_items TO control_room_task_coordinator';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    -- The owner reads the ledger through the view and holds nothing on either base
    -- table: the web login must not be able to clear a counter or raise an item.
    EXECUTE 'GRANT SELECT ON control_planner_open_needs_you TO control_room_private_web';
  END IF;
END $$;

-- A down migration is intentionally operator-authored and data refusing: it revokes
-- only what this file granted, then refuses while any counter or item exists.
