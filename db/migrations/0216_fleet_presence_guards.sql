-- MIG-F guards. Only an advancing authenticated check-in may write online;
-- graceful offline must match the current session; time-driven unreachable is
-- accepted only after the 90 second window. Role grants are in 0217.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DROP TRIGGER fleet_worker_presence_guard ON fleet_worker_presence;
DROP FUNCTION guard_fleet_presence_write();
CREATE FUNCTION guard_fleet_presence_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fleet_workers w
      WHERE w.tenant_id=NEW.tenant_id AND w.worker_id=NEW.worker_id AND w.state='active')
    OR NEW.last_seen_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR NEW.state_changed_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR (TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.worker_id<>OLD.worker_id)) THEN
    RAISE EXCEPTION 'fleet presence rejected';
  END IF;
  IF NEW.presence_state='online' AND (NEW.session_id IS NULL OR NEW.graceful_offline_at IS NOT NULL
      OR (TG_OP='UPDATE' AND NEW.last_seen_at<OLD.last_seen_at)
      OR (EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='control_room_fleet_gateway')
        AND NOT pg_catalog.pg_has_role(session_user,'control_room_fleet_gateway','member'))) THEN
    RAISE EXCEPTION 'fleet presence rejected';
  END IF;
  IF TG_OP='UPDATE' AND NEW.presence_state='offline'
    AND (OLD.session_id IS DISTINCT FROM NEW.session_id OR NEW.graceful_offline_at IS NULL
      OR (EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='control_room_fleet_gateway')
        AND NOT pg_catalog.pg_has_role(session_user,'control_room_fleet_gateway','member'))) THEN
    RAISE EXCEPTION 'fleet presence rejected';
  END IF;
  IF NEW.presence_state='unreachable' AND (TG_OP<>'UPDATE' OR OLD.presence_state<>'online'
      OR NEW.last_seen_at<>OLD.last_seen_at OR NEW.session_id IS DISTINCT FROM OLD.session_id
      OR NEW.state_changed_at<OLD.last_seen_at+interval '90 seconds'
      OR (EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='control_room_task_coordinator')
        AND NOT pg_catalog.pg_has_role(session_user,'control_room_task_coordinator','member'))) THEN
    RAISE EXCEPTION 'fleet presence rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_presence_write() FROM PUBLIC;
CREATE TRIGGER fleet_worker_presence_guard BEFORE INSERT OR UPDATE ON fleet_worker_presence
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_presence_write();

CREATE FUNCTION guard_fleet_worker_agent_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fleet_workers w
      WHERE w.tenant_id=NEW.tenant_id AND w.worker_id=NEW.worker_id AND w.state='active')
    OR NEW.last_reported_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR NEW.state_changed_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR (TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.worker_id<>OLD.worker_id OR NEW.agent_id<>OLD.agent_id))
    OR (NEW.presence_state='unreachable' AND (TG_OP<>'UPDATE' OR OLD.presence_state<>'online'
      OR NEW.last_reported_at<>OLD.last_reported_at OR NEW.session_id<>OLD.session_id
      OR NEW.state_changed_at<OLD.last_reported_at+interval '90 seconds'
      OR (EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='control_room_task_coordinator')
        AND NOT pg_catalog.pg_has_role(session_user,'control_room_task_coordinator','member'))))
    OR (NEW.presence_state IN ('online','offline')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='control_room_fleet_gateway')
      AND NOT pg_catalog.pg_has_role(session_user,'control_room_fleet_gateway','member')) THEN
    RAISE EXCEPTION 'fleet worker agent presence rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_worker_agent_write() FROM PUBLIC;
CREATE TRIGGER fleet_worker_agents_guard BEFORE INSERT OR UPDATE ON fleet_worker_agents
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_worker_agent_write();

CREATE FUNCTION guard_fleet_presence_transition_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.source='connector' AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='control_room_fleet_gateway')
      AND NOT pg_catalog.pg_has_role(session_user,'control_room_fleet_gateway','member'))
    OR (NEW.source='supervisor' AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='control_room_task_coordinator')
      AND NOT pg_catalog.pg_has_role(session_user,'control_room_task_coordinator','member')) THEN
    RAISE EXCEPTION 'fleet presence transition rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_presence_transition_insert() FROM PUBLIC;
CREATE TRIGGER fleet_presence_transitions_guard BEFORE INSERT ON fleet_presence_transitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_presence_transition_insert();

CREATE TRIGGER fleet_worker_agents_no_delete BEFORE DELETE ON fleet_worker_agents
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER fleet_worker_agents_no_truncate BEFORE TRUNCATE ON fleet_worker_agents
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER fleet_presence_transitions_no_change BEFORE UPDATE OR DELETE ON fleet_presence_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER fleet_presence_transitions_no_truncate BEFORE TRUNCATE ON fleet_presence_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
