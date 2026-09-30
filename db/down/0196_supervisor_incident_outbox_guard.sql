BEGIN;
CREATE OR REPLACE FUNCTION guard_task_coordinator_outbox_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator'
    AND pg_has_role(current_user,oid,'MEMBER'))
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    IF NEW.topic IS DISTINCT FROM 'domain.transition' OR NEW.status IS DISTINCT FROM 'pending'
      OR NEW.aggregate_type NOT IN ('request','workflow','job','attempt','lease') THEN
      RAISE EXCEPTION 'task coordinator outbox insert rejected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_task_coordinator_outbox_insert() FROM PUBLIC;
COMMIT;
