-- Reverses the project activity grants. No schema object is dropped: the stream
-- tables belong to an earlier migration, and the events they hold are canonical
-- presentation records, so the refusal below is about privilege, not data.
BEGIN;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'control_room_private_web', 'control_room_task_coordinator',
    'control_room_native_evidence', 'control_room_local_result_publisher'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE UPDATE (last_sequence, last_event_digest, head_auth_tag, updated_at) ON control_project_event_stream_heads FROM %I', role_name);
      EXECUTE format('REVOKE SELECT, INSERT ON control_project_event_stream_heads, control_project_events FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_local_result_publisher') THEN
    EXECUTE 'REVOKE SELECT ON projects FROM control_room_local_result_publisher';
  END IF;
END;
$$;
COMMIT;
