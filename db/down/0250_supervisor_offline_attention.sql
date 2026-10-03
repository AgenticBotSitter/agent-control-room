-- Reverses 0250 only: the two guards and their triggers.
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE DOES NOT REVOKE THE GRANT
-- ---------------------------------------------------------------------------
-- 0250's authority -- `GRANT UPDATE (state, payload) ON control_action_inbox TO
-- control_room_task_coordinator` -- lives in db/roles/task_coordinator_roles.sql,
-- not in the migration, and that placement is load-bearing.
--
-- The migrator applies db/migrations/*.sql BEFORE any role file creates the
-- coordinator (the order is fixed in tests/support/attack-kit/real-postgres.ts:
-- `applyMigrations` first, role files after). So a role-guarded GRANT written
-- inside a MIGRATION is always false, always skipped, and never reported: the
-- file applies cleanly, the migration reports success, and the coordinator
-- permanently lacks the privilege. The first version of 0250 carried the grant
-- in the migration and the lane measured exactly that -- "permission denied for
-- table control_action_inbox" on the resolution, with no UPDATE row at all in
-- information_schema.column_privileges.
--
-- A down migration cannot reverse a role file's grant anyway, and a down that
-- tried would revoke a privilege the role file re-grants on the next
-- provision -- leaving the database and its declared authority disagreeing,
-- which is worse than either state alone. The authority is read at
-- provisioning; the guards are read at migration. Those are two different
-- moments and this file is only about one of them.
--
-- So what a down DOES leave consistent is the database in front of the roles:
-- the guards go, so nothing can write through this feature's rules, and the
-- coordinator keeps exactly the UPDATE its role file declares. That is the
-- state the database was in before 0250.
-- ---------------------------------------------------------------------------
--
-- The guards and their triggers go first, so nothing can write through them
-- while they are being removed. The functions are dropped after the triggers
-- because a trigger naming a missing function would refuse every INSERT on
-- this table -- including the ones the work-batch and pipeline-loop paths make,
-- which is a far worse failure than a leftover guard.
--
-- The rows are deliberately NOT deleted. They are the owner's attention list:
-- an acknowledged "this worker was offline" is a fact about the installation,
-- and a down migration is not a reason to forget it. Every other down file in
-- this repository takes the same position -- it removes the mechanism, not the
-- history.
BEGIN;

DROP TRIGGER IF EXISTS control_action_inbox_supervisor_offline_update_guard ON public.control_action_inbox;
DROP TRIGGER IF EXISTS control_action_inbox_supervisor_offline_insert_guard ON public.control_action_inbox;
DROP FUNCTION IF EXISTS public.guard_supervisor_offline_attention_update();
DROP FUNCTION IF EXISTS public.guard_supervisor_offline_attention_insert();

COMMIT;
