-- Mac-local readiness signals. On the Mac there is no remote node intake: the task
-- host derives one capability and one telemetry signal per local worker node from
-- the pinned-executable readiness it already verifies, and records them through
-- the task-coordinator login (db/roles/task_coordinator_roles.sql).
--
-- This guard confines that login to exactly those local nodes. It can never write
-- a signal for a remote or enrolled node, never rewrite signal history, and grants
-- nothing by itself. Other roles and the superuser are unaffected.

-- SELECT ... FOR UPDATE needs a column UPDATE privilege; only this immutable
-- false-valued lock column is granted, as with the other *_lock columns.
ALTER TABLE control_node_fleet_signals ADD COLUMN coordinator_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_node_fleet_signals_coordinator_lock CHECK (coordinator_lock IS FALSE);

CREATE FUNCTION guard_task_coordinator_fleet_signal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator'
    AND pg_has_role(current_user,oid,'MEMBER'))
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    IF TG_TABLE_NAME='control_node_fleet_signals' AND TG_OP<>'INSERT' THEN
      RAISE EXCEPTION 'task coordinator fleet signal rejected';
    END IF;
    IF NEW.signal_kind NOT IN ('capability','telemetry')
      OR NOT EXISTS (SELECT 1 FROM control_nodes n WHERE n.tenant_id=NEW.tenant_id AND n.id=NEW.node_id
        AND n.payload->>'platform'='macos' AND n.payload->>'policyVersion'='mac-local/v1'
        AND n.payload->>'minimumProtocolVersion'='local-only') THEN
      RAISE EXCEPTION 'task coordinator fleet signal rejected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_task_coordinator_fleet_signal() FROM PUBLIC;
CREATE TRIGGER control_node_fleet_signals_task_coordinator BEFORE INSERT OR UPDATE ON control_node_fleet_signals
  FOR EACH ROW EXECUTE FUNCTION guard_task_coordinator_fleet_signal();
CREATE TRIGGER control_node_fleet_current_task_coordinator BEFORE INSERT OR UPDATE ON control_node_fleet_current
  FOR EACH ROW EXECUTE FUNCTION guard_task_coordinator_fleet_signal();
