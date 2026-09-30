-- Reverses ONLY what 0227 added: the CHECK constraint, the two functions it
-- calls, and the EXECUTE grant the constraint needs to be evaluable at all.
-- owner_web_push_subscriptions is 0173's table and its grants are left exactly
-- as they were -- this file is the last of the push series, and rolling back the
-- allow list must not drop a table an earlier migration created.
--
-- The EXECUTE revoke comes first, before the functions are dropped, so a role
-- holding it is not left with a grant naming an object that no longer exists.
BEGIN;
ALTER TABLE owner_web_push_subscriptions DROP CONSTRAINT owner_web_push_subscriptions_endpoint_allowed;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION owner_push_endpoint_host(text) FROM control_room_private_web';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION owner_push_endpoint_allowed(text) FROM control_room_private_web';
  END IF;
END $$;
DROP FUNCTION public.owner_push_endpoint_allowed(text);
DROP FUNCTION public.owner_push_endpoint_host(text);
COMMIT;
