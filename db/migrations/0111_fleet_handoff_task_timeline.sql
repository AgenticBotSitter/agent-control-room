-- Tango tier 1: hand-off with a note. A fleet worker already had a way to
-- report a blocker and release its lease back to the job's pool (0140,
-- gateway-store.ts `blocker()`); the required note landed in the audit log
-- and in fleet_worker_events, but never reached the owner's task timeline.
-- This migration only grants the existing fleet gateway login the same
-- presentation-only project-event privilege other lifecycle writers already
-- hold (0107). It creates no schema object, widens no claim, lease, offer or
-- release authority, and changes no down-migration data.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') THEN
    EXECUTE 'GRANT SELECT, INSERT ON control_project_event_stream_heads, control_project_events TO control_room_fleet_gateway';
    EXECUTE 'GRANT UPDATE (last_sequence, last_event_digest, head_auth_tag, updated_at) ON control_project_event_stream_heads TO control_room_fleet_gateway';
  END IF;
END;
$$;
