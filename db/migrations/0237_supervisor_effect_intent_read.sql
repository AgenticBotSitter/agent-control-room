-- The supervisor reconciler is the only lease-expiry owner, for local and for
-- fleet work alike. Its candidate query computes `outcome_uncertain` partly
-- from control_effect_intents: an intent still executing, confirmed or
-- ambiguous means the effect may already have happened outside the system, so
-- the attempt cannot be blindly requeued.
--
-- db/roles/task_coordinator_roles.sql now grants the coordinator SELECT on that
-- table, but a role file is only read when the module is provisioned. An
-- installation provisioned before this file existed keeps the older ACL, and
-- Postgres checks the privilege on every relation the statement names -- not
-- only the ones it evaluates -- so every eligible stalled candidate would fail
-- with insufficient_privilege and stall detection would be silently dead.
--
-- This is the same convergence the other grant migrations perform (0046, 0054,
-- 0087, 0157): the role may not exist yet, so the grant is guarded by the
-- role's existence, and the role file stays the authoritative statement.
-- Read only: an effect intent is created and moved by the path that owns the
-- external effect, never by the supervisor.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT ON control_effect_intents TO control_room_task_coordinator';
  END IF;
END $$;