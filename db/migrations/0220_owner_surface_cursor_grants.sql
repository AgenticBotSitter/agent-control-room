-- MIG-G exact private-web rights: read, first acknowledgement insert, and the
-- two columns needed for monotonic retry-safe advancement. No delete.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    GRANT SELECT, INSERT ON owner_surface_cursors TO control_room_private_web;
    GRANT UPDATE (seen_through,updated_at) ON owner_surface_cursors TO control_room_private_web;
  END IF;
END $$;
