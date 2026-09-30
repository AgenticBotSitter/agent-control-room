BEGIN;
DROP TRIGGER fleet_presence_transitions_no_truncate ON fleet_presence_transitions;
DROP TRIGGER fleet_presence_transitions_no_change ON fleet_presence_transitions;
DROP TRIGGER fleet_presence_transitions_guard ON fleet_presence_transitions;
DROP FUNCTION guard_fleet_presence_transition_insert();
DROP TRIGGER fleet_worker_agents_no_truncate ON fleet_worker_agents;
DROP TRIGGER fleet_worker_agents_no_delete ON fleet_worker_agents;
DROP TRIGGER fleet_worker_agents_guard ON fleet_worker_agents;
DROP FUNCTION guard_fleet_worker_agent_write();
DROP TRIGGER fleet_worker_presence_guard ON fleet_worker_presence;
DROP FUNCTION guard_fleet_presence_write();
CREATE FUNCTION guard_fleet_presence_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fleet_workers w
      WHERE w.tenant_id=NEW.tenant_id AND w.worker_id=NEW.worker_id AND w.state='active')
    OR NEW.last_seen_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR (TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.worker_id<>OLD.worker_id)) THEN
    RAISE EXCEPTION 'fleet presence rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_presence_write() FROM PUBLIC;
CREATE TRIGGER fleet_worker_presence_guard BEFORE INSERT OR UPDATE ON fleet_worker_presence
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_presence_write();
COMMIT;
