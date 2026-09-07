-- PostgreSQL locking SELECT requires an UPDATE privilege. Grant only an inert column
-- for records whose authority-bearing fields the task coordinator must never change.
ALTER TABLE tenants ADD COLUMN coordinator_lock boolean NOT NULL DEFAULT false
  CONSTRAINT tenants_coordinator_lock CHECK (coordinator_lock IS FALSE);
ALTER TABLE control_nodes ADD COLUMN coordinator_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_nodes_coordinator_lock CHECK (coordinator_lock IS FALSE);
ALTER TABLE control_node_keys ADD COLUMN coordinator_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_node_keys_coordinator_lock CHECK (coordinator_lock IS FALSE);
ALTER TABLE control_manual_project_heads ADD COLUMN coordinator_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_manual_project_heads_coordinator_lock CHECK (coordinator_lock IS FALSE);
ALTER TABLE projects ADD COLUMN coordinator_lock boolean NOT NULL DEFAULT false
  CONSTRAINT projects_coordinator_lock CHECK (coordinator_lock IS FALSE);

-- This first coordinator owns domain transitions, not executor commands. Role checks are
-- invoker-security, tolerate the role not being provisioned yet, and cannot grant permissions.
CREATE FUNCTION guard_task_coordinator_outbox_insert() RETURNS trigger
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
CREATE TRIGGER control_outbox_task_coordinator_insert BEFORE INSERT ON control_outbox
  FOR EACH ROW EXECUTE FUNCTION guard_task_coordinator_outbox_insert();
