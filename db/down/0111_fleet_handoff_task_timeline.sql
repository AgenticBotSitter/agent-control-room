-- Reverses only this migration's grant. control_room_fleet_gateway held
-- nothing on either project-event table before 0111, so this revoke is fully
-- symmetric: it returns the role to its pre-0111 privilege exactly.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') THEN
    EXECUTE 'REVOKE UPDATE (last_sequence, last_event_digest, head_auth_tag, updated_at) ON control_project_event_stream_heads FROM control_room_fleet_gateway';
    EXECUTE 'REVOKE SELECT, INSERT ON control_project_event_stream_heads, control_project_events FROM control_room_fleet_gateway';
  END IF;
END;
$$;
COMMIT;
