-- Mac-local readiness signals. On the Mac there is no remote node intake: the task
-- host derives one capability and one telemetry signal per local worker node from
-- the pinned-executable readiness it already verifies, and records them through
-- the task-coordinator login (db/roles/task_coordinator_roles.sql).
--
-- This guard confines that login to exactly those local nodes and exactly that
-- shape. It can never write a signal for a remote or enrolled node, never claim
-- verified trust, never rewrite signal history, and the live current row is only
-- ever a newer copy of a history row it already appended. Grants nothing by
-- itself. Other roles and the superuser are unaffected.

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
    IF TG_TABLE_NAME='control_node_fleet_signals' AND (
      -- Host-reported only, short-lived, and the stored envelope agrees with every column.
      NEW.trust IS DISTINCT FROM 'reported'
      OR NEW.expires_at <= NEW.observed_at OR NEW.expires_at > NEW.observed_at + interval '5 minutes'
      OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id
      OR NEW.payload->>'nodeId' IS DISTINCT FROM NEW.node_id
      OR NEW.payload->>'kind' IS DISTINCT FROM NEW.signal_kind
      OR NEW.payload->'sequence' IS DISTINCT FROM to_jsonb(NEW.signal_sequence)
      OR NEW.payload->>'trust' IS DISTINCT FROM NEW.trust
      OR NEW.payload->>'fingerprint' IS DISTINCT FROM NEW.fingerprint
      OR NEW.payload->>'source' IS DISTINCT FROM
        CASE NEW.signal_kind WHEN 'telemetry' THEN 'telemetry_port' ELSE 'probe_runner' END
      OR (NEW.payload->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at
      OR (NEW.payload->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at
      -- Strictly the next sequence for this node and kind.
      OR NEW.signal_sequence IS DISTINCT FROM 1 + coalesce((SELECT max(s.signal_sequence) FROM control_node_fleet_signals s
        WHERE s.tenant_id=NEW.tenant_id AND s.node_id=NEW.node_id AND s.signal_kind=NEW.signal_kind),0)) THEN
      RAISE EXCEPTION 'task coordinator fleet signal rejected';
    END IF;
    IF TG_TABLE_NAME='control_node_fleet_current' AND (
      -- The live row is an exact copy of an appended history row, and only moves forward.
      (TG_OP='UPDATE' AND NEW.signal_sequence <= OLD.signal_sequence)
      OR NOT EXISTS (SELECT 1 FROM control_node_fleet_signals s WHERE s.tenant_id=NEW.tenant_id
        AND s.node_id=NEW.node_id AND s.signal_kind=NEW.signal_kind AND s.signal_sequence=NEW.signal_sequence
        AND s.fingerprint=NEW.fingerprint AND s.trust=NEW.trust AND s.observed_at=NEW.observed_at
        AND s.expires_at=NEW.expires_at AND s.payload=NEW.payload)) THEN
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
