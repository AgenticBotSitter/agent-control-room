-- U05: a lost worker heartbeat must produce ONE owner attention item, and it
-- must be resolvable when the worker comes back.
--
-- WHAT WAS BROKEN, MEASURED ON POSTGRESQL 17 AS control_room_task_coordinator.
-- `SupervisorReconcilerV1.refreshAgentHeartbeatHealth` writes
-- `control_supervisor_agent_health` with state 'suspect' and
-- safe_reason_code 'heartbeat_lost', and that is all it did. It created ZERO
-- `control_action_inbox` rows, so:
--
--   * the owner push dispatcher, whose only source of candidates is an OPEN
--     attention item of kind failure/ambiguity/incident
--     (`OwnerPushDispatcherV1.adoptOpenAttention`), had nothing to send. An idle
--     bot going offline is invisible to the owner's phone entirely.
--   * Home's attention surface reads the same inbox, so the red box did not
--     light either.
--
-- The task-stall path was NOT confused with this and is not changed here:
-- `reconcileStalled` already creates its own item for a stalled job, and that
-- item is about a JOB. A worker that loses its heartbeat while idle has no job,
-- so it is a different fact and needs its own record.
--
-- ---------------------------------------------------------------------------
-- WHY A DETERMINISTIC ID AND NOT A GENERATED ONE
-- ---------------------------------------------------------------------------
-- The item's id is `attention:supervisor-agent:<digest>` where the digest is
-- `md5(tenant_id || '/' || worker_id)` truncated to 32 hex characters -- the
-- same construction 0202 and 0204 already use for their deterministic
-- `planner-needs-you:` items, chosen for the same two reasons.
--
-- It is `md5` and not sha256 because this is a NAMESPACE, not an integrity
-- claim. The value decides which row a worker maps to and nothing else; it is
-- not a signature over anything an attacker chooses, and it is not compared
-- against a value computed anywhere else. pgcrypto is not installed on this
-- database and adding an extension for a naming function would be a much larger
-- change to the installation than the behaviour is worth. The same reasoning is
-- why 0202 uses it.
--
-- Dedup is therefore a PRIMARY KEY property, not a query with a "does one
-- already exist" race in it. `refreshAgentHeartbeatHealth` runs every
-- supervisor cycle (30 s in production), so a worker that stays offline would
-- otherwise create a new row on every cycle: 2 880 items a day, each one a push
-- candidate the owner cannot dismiss. Two lines of SQL would avoid it; a key
-- that cannot repeat is the only version of that which is true under 20
-- concurrent cycles.
--
-- The digest is of the TENANT and the WORKER, not of the incident. So a worker
-- that goes offline, recovers, and goes offline again reuses the SAME item,
-- which is what the owner wants: one worker, one outstanding "this worker is
-- offline" question, reopened rather than duplicated. The history of the
-- outages is in `control_supervisor_agent_health`, which is where a history
-- belongs.
--
-- ---------------------------------------------------------------------------
-- WHY THE ITEM IS RESOLVED RATHER THAN EXPIRED
-- ---------------------------------------------------------------------------
-- `control_action_inbox.state` is ('open','resolved','expired'). Resolving on
-- recovery is the honest transition: the question the item asked -- "is this
-- worker reachable?" -- has an answer, and the answer is yes. Expiry would
-- leave it open-looking with a clock running, and the item would keep
-- reappearing in the owner's list.
--
-- Resolution is idempotent and one-directional: the WHERE clause matches only
-- 'open' rows, so resolving an already-resolved item updates nothing. A worker
-- that flaps therefore leaves exactly one open item at any time, and the owner's
-- list is not a log of flaps.
--
-- The UPDATE carries the payload's state alongside the column, because that is
-- the convention every other resolver on this table follows (0102's work-batch
-- resolver, 0154's pipeline-loop resolver) and because a page that renders
-- `payload.state` and finds 'open' on a resolved row would show a resolved item
-- as still open. The two move together or the item lies.
--
-- ---------------------------------------------------------------------------
-- SCOPE, AND WHAT IS DELIBERATELY NOT HERE
-- ---------------------------------------------------------------------------
-- This migration creates NO table. The item lives in the existing canonical
-- inbox, which is the point: there is no second place for "the owner has to look
-- at this", no second reader to bind to Home, and no second push-candidate
-- source. The push dispatcher and Home both already read this table; U05 is
-- about the table being EMPTY, not about its shape.
--
-- It adds one guard (so the coordinator's existing INSERT grant cannot be used
-- to open a forged "this worker is offline" item) and exactly one new grant: the
-- coordinator's UPDATE on two columns, without which resolution is impossible.
-- No index is needed: the existing `idx_control_action_inbox_open(tenant_id,
-- state, created_at DESC)` serves both the dedup lookup and the open-item
-- reader.
--
-- The guard is a row trigger rather than a SECURITY DEFINER function, which is
-- the pattern 0202 uses for exactly this situation. A definer would be a second
-- way for the coordinator to write the table, and the guard is strictly
-- stronger than a function here: it fires for EVERY writer, including a
-- privileged one, and it states the rule as a property of the row.
--
-- `project_id` is deliberately NULL. A worker is not a task and has no project,
-- and the supervisor's worker rows do not carry one
-- (`refreshAgentHeartbeatHealth` selects only worker_id, node_id and the fleet's
-- telemetry expiry). Inventing a project would make the item belong to
-- something it is not about, and 0102's guard on this table refuses items whose
-- project does not match their work item.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Only the supervisor's own derived item may claim this namespace.
-- ---------------------------------------------------------------------------
-- The rule is stated over the ROW, so it holds for any writer:
--
--   * the id must be the deterministic one for this (tenant, worker). A caller
--     that picks its own id inside this prefix is inventing an item, and a
--     caller OUTSIDE the prefix is not this feature at all and is passed
--     through untouched -- every other writer on this table (0102's work-batch
--     items, 0154's pipeline-loop items, the reconciler's own incident items)
--     keeps working exactly as before, which is the point of scoping the guard
--     to one prefix.
--   * the payload's evidence must name the SAME worker the id does. Otherwise a
--     caller could hold a real worker's id -- which is guessable, since the
--     digest is md5 of two public-ish strings -- and attach evidence about a
--     different worker, and the owner's page would render one worker with
--     another's history.
--   * the kind must be 'incident' and the initial state 'open'. A resolved item
--     may not be INSERTED as open-then-closed in one row, because the guard is
--     the only place that can see the difference and there is no reason for a
--     caller to want one.
--
-- The insert is a SECURITY INVOKER path, so the coordinator holds the INSERT it
-- already has. What it does NOT hold is the ability to write a row that is not
-- this row.
CREATE FUNCTION guard_supervisor_offline_attention_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  worker text;
BEGIN
  IF NEW.id NOT LIKE 'attention:supervisor-agent:%' THEN
    RETURN NEW;
  END IF;
  -- The worker id is a NAMED payload field, not something recovered from the
  -- evidence. An earlier version took it from the evidence id and hashed it,
  -- which cannot work: the guard has to RECOMPUTE the digest to check the id,
  -- and a digest is not invertible. So the worker is stated plainly in the
  -- payload, and the guard checks (a) that the stated worker is the one the id
  -- was derived from and (b) that it is a worker the supervisor has actually
  -- recorded as lost. Both are facts the database can see.
  --
  -- The field is a fixed key rather than free text, and its value is bounded by
  -- 0177's own CHECK pattern on `control_supervisor_agent_health.worker_id`, so
  -- it cannot carry a quote, a space or a tag into the payload.
  worker := NEW.payload->>'workerId';
  IF NEW.project_id IS NOT NULL OR NEW.work_item_id IS NOT NULL
    OR NEW.kind <> 'incident' OR NEW.state <> 'open'
    OR NEW.id <> 'attention:supervisor-agent:' || substring(pg_catalog.md5(
         NEW.tenant_id || '/' || worker) from 1 for 32)
    OR worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$'
    OR jsonb_typeof(NEW.payload->'evidence') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.payload->'evidence') < 1
    -- The reason code is this feature's and no other. A caller that opened the
    -- item for a different reason would be claiming a worker outage it did not
    -- observe, and the owner's page would render our reason with their evidence.
    OR NEW.payload->>'reasonCode' IS DISTINCT FROM 'worker_heartbeat_lost'
    -- A live worker in the supervisor's own record is the fact that makes the
    -- item true. Without this the item is an assertion anyone with INSERT can
    -- make about any worker id, including a worker that is answering
    -- heartbeats this very cycle.
    OR NOT EXISTS (SELECT 1 FROM public.control_supervisor_agent_health h
         WHERE h.tenant_id = NEW.tenant_id AND h.worker_id = worker
           AND h.state = 'suspect' AND h.safe_reason_code = 'heartbeat_lost') THEN
    RAISE EXCEPTION 'supervisor offline attention item rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_supervisor_offline_attention_insert() FROM PUBLIC;
CREATE TRIGGER control_action_inbox_supervisor_offline_insert_guard
  BEFORE INSERT ON public.control_action_inbox
  FOR EACH ROW EXECUTE FUNCTION public.guard_supervisor_offline_attention_insert();

-- ---------------------------------------------------------------------------
-- Only the resolution this feature defines may move this item.
-- ---------------------------------------------------------------------------
-- A row trigger on UPDATE, scoped to the same prefix. The coordinator needs
-- UPDATE (state, payload) to resolve, and that grant would otherwise let it
-- repoint an item at a different worker, turn a resolved item back into an
-- open one, or rewrite the evidence. The rule here is narrow and all three are
-- refused:
--
--   * identity is immutable: tenant, project, work item, kind, created_at and
--     expires_at may not move. An item about one worker stays about it.
--   * the transition is one-directional: open -> resolved only. A resolved item
--     cannot be reopened, so a caller cannot use this item to re-alert the phone
--     for a worker that is fine.
--   * the payload may change only its `state`. Everything else -- the action,
--     the reason, the evidence, the legal responses -- is what the owner was
--     shown when the item was created, and rewriting it after the fact would
--     make the page and the history disagree.
--
-- `control_action_inbox` has no `updated_at` column (0019), so the resolution
-- instant lives in the payload's `state` move only. The reconciler's own
-- incident items are resolved the same way, and their `resolvedAt` is written
-- by the caller in the payload; this guard permits a `resolvedAt` add so a
-- resolver may record WHEN, without permitting any change to the text the
-- owner was shown.
CREATE FUNCTION guard_supervisor_offline_attention_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.id NOT LIKE 'attention:supervisor-agent:%' THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.id <> OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
    OR NEW.kind <> OLD.kind
    OR NEW.delivery_state <> OLD.delivery_state
    OR NEW.created_at <> OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    -- The transition is open -> resolved, OR resolved -> open when the worker
    -- has gone offline AGAIN. Both are the supervisor acting on a fresh
    -- observation, and neither is a third party reopening a warning: the
    -- row's own `id` is the digest of (tenant, worker), so the only writer that
    -- can produce this id is the code that observed this worker, and the guard
    -- above refuses any insert into this namespace that does not have a live
    -- 'suspect' health row behind it.
    --
    -- What is still refused is a resolution that CHANGES the item: a different
    -- reason, a different subject, a different action. Those are the columns
    -- this guard pins, and they are pinned for both directions.
    OR NEW.state NOT IN ('open','resolved')
    OR (OLD.state = NEW.state AND OLD.state NOT IN ('open','resolved'))
    OR (NEW.payload - 'state' - 'resolvedAt')
       IS DISTINCT FROM (OLD.payload - 'state' - 'resolvedAt') THEN
    RAISE EXCEPTION 'supervisor offline attention update rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_supervisor_offline_attention_update() FROM PUBLIC;
CREATE TRIGGER control_action_inbox_supervisor_offline_update_guard
  BEFORE UPDATE ON public.control_action_inbox
  FOR EACH ROW EXECUTE FUNCTION public.guard_supervisor_offline_attention_update();

-- ---------------------------------------------------------------------------
-- The one grant resolution needs.
-- ---------------------------------------------------------------------------
-- The coordinator already holds INSERT on this table (task_coordinator_roles.sql
-- line 93) and holds no UPDATE at all on it: it can open an attention item and
-- can never close one. That is the correct asymmetry for a login that only ever
-- escalates, and it is why resolution needed a new decision rather than a line
-- of code.
--
-- Two columns, the same pair the private web holds for the owner's own
-- resolution (private_web_roles.sql line 206). It is not a table-wide UPDATE:
-- `delivery_state` stays unwritable here, because this feature never requests
-- delivery through the inbox and a coordinator that could set it would be
-- asserting a push it did not make.
--
-- The role may not exist yet -- several suites apply migrations to a role-less
-- database -- so the grant is guarded by the role's existence, and the role file
-- stays the authoritative statement of what the coordinator holds. The same
-- convergence as 0237, 0238, 0157 and 0046/0054/0087.
--
-- NO DELETE. A resolved item is history: the record that a worker was offline
-- and the owner was told is worth keeping, and a coordinator that could delete
-- its own escalations would leave no evidence of having made them.
--
-- THE GRANT IS IN db/roles/task_coordinator_roles.sql, NOT HERE, and moving it
-- here is a mistake this file made once and the reason is worth recording.
--
-- The migrator applies `db/migrations/*.sql` BEFORE any role file creates
-- `control_room_task_coordinator` (the order is fixed in
-- tests/support/attack-kit/real-postgres.ts: migrations at the `applyMigrations`
-- call, roles after it). So a grant guarded by
-- `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=...)` inside a MIGRATION is
-- always false, always skipped, and never noticed -- the file applies cleanly,
-- the migration reports success, and the coordinator permanently lacks the
-- privilege. Measured: the first version of this migration carried the guarded
-- GRANT here, the lane reported "permission denied for table
-- control_action_inbox" on the resolution, and reading
-- `information_schema.column_privileges` showed no UPDATE row at all.
--
-- The 0237/0238 shape -- a migration whose whole body is a role-guarded GRANT --
-- works there because those files' grants are read from a role file that the
-- PROVISIONING step applies after the roles exist. This file is not that: it
-- creates triggers, and its grant has to converge the same way, which means it
-- belongs in the role file.
DO $$ BEGIN
  -- Deliberately empty. The UPDATE grant is `GRANT UPDATE (state, payload) ON
  -- control_action_inbox` in db/roles/task_coordinator_roles.sql, applied by
  -- provisioning once the role exists. See the comment above.
END $$;
