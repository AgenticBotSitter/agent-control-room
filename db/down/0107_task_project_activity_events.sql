-- Reverses the project activity grants. No schema object is dropped: the stream
-- tables belong to migration 0033, and the events they hold are canonical
-- presentation records, so the refusal below is about privilege, not data.
--
-- A down migration returns an installation to the state the PREVIOUS release
-- expects, so it may revoke only what this migration added. The four roles are
-- therefore not symmetric, and the asymmetry is the point:
--
--  * `control_room_private_web` already held SELECT on both activity tables on
--    main -- db/roles/private_web_roles.sql grants it, and main's private-web
--    startup preflight (privateWebReadTables) refuses to start the web process
--    without that read. Revoking it here would leave a rolled-back install in a
--    state main cannot run, so the down file removes only this migration's
--    INSERT and its four stream-head UPDATE columns.
--  * The other three held nothing on either table on main, so their SELECT is
--    this migration's and goes with it.
BEGIN;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'control_room_task_coordinator', 'control_room_native_evidence',
    'control_room_local_result_publisher'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE UPDATE (last_sequence, last_event_digest, head_auth_tag, updated_at) ON control_project_event_stream_heads FROM %I', role_name);
      EXECUTE format('REVOKE SELECT, INSERT ON control_project_event_stream_heads, control_project_events FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE UPDATE (last_sequence, last_event_digest, head_auth_tag, updated_at) ON control_project_event_stream_heads FROM control_room_private_web';
    EXECUTE 'REVOKE INSERT ON control_project_event_stream_heads, control_project_events FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_local_result_publisher') THEN
    EXECUTE 'REVOKE SELECT ON projects FROM control_room_local_result_publisher';
  END IF;
END;
$$;
COMMIT;
