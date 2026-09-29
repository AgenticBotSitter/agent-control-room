-- Allow the existing least-privilege lifecycle writers to append authenticated
-- project activity in the same transaction as their canonical state change.
-- Fresh installations receive the same grants from the role definitions.
--
-- The publisher's `SELECT workspace_id FROM projects` is part of that path: the
-- durable result publication appends its activity event through the same
-- transaction, and the stream-head lookup refuses a project whose workspace the
-- caller did not name. That `projects` grant exists only in the fresh-install
-- role file, which an upgraded installation never re-runs, so it is granted
-- here for the upgrade path. No schema object is created, so the private-web
-- schema digest is unchanged.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'control_room_private_web', 'control_room_task_coordinator',
    'control_room_native_evidence', 'control_room_local_result_publisher'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT, INSERT ON control_project_event_stream_heads, control_project_events TO %I', role_name);
      EXECUTE format('GRANT UPDATE (last_sequence, last_event_digest, head_auth_tag, updated_at) ON control_project_event_stream_heads TO %I', role_name);
    END IF;
  END LOOP;
  -- Least privilege: scoped to the one table the publisher's new query reads.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_local_result_publisher') THEN
    EXECUTE 'GRANT SELECT ON projects TO control_room_local_result_publisher';
  END IF;
END;
$$;
