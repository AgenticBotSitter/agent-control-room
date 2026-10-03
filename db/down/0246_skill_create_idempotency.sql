-- Reverses only what 0246 granted and created, and nothing else.
--
-- 0246 created exactly one table (`control_skill_create_actions`) and granted
-- the private web login SELECT and INSERT on it. So this file drops that table
-- and revokes exactly that pair. No pre-existing skill table, grant, trigger or
-- function is touched: `control_skills`, `control_skill_versions` and
-- `control_task_skill_bindings` are 0186's and are left exactly as they were.
--
-- Both statements sit inside a role-existence check so this also runs on a
-- database where the private web role was never installed.

BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON control_skill_create_actions FROM control_room_private_web';
  END IF;
END $$;
DROP TABLE IF EXISTS control_skill_create_actions;
COMMIT;
