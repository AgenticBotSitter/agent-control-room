-- M2 fix: migration 0046's coordinator outbox guard only ever recognised the
-- coordinator's own domain-transition topics. The supervisor watchdog's
-- ServiceIncidentStore also inserts into control_outbox, under the same
-- coordinator login, when it opens or resolves a machine-health incident --
-- so every unhealthy-machine cycle had its incident insert rejected by this
-- trigger, including the FIRST cycle, which host startup awaits directly.
-- This widens the guard to also admit exactly the service-incident outbox
-- shape the incident store writes; it grants no new authority, since the
-- coordinator already held INSERT on control_outbox and on the incident
-- tables themselves (task_coordinator_roles.sql, migration 0178).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE OR REPLACE FUNCTION guard_task_coordinator_outbox_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator'
    AND pg_has_role(current_user,oid,'MEMBER'))
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    IF NEW.status IS DISTINCT FROM 'pending' OR NOT (
      (NEW.topic IS NOT DISTINCT FROM 'domain.transition'
        AND NEW.aggregate_type IN ('request','workflow','job','attempt','lease'))
      OR (NEW.aggregate_type IS NOT DISTINCT FROM 'service_incident'
        AND NEW.topic IN ('service.incident.opened','service.incident.resolved'))
    ) THEN
      RAISE EXCEPTION 'task coordinator outbox insert rejected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_task_coordinator_outbox_insert() FROM PUBLIC;
