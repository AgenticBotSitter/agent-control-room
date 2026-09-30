-- Reverses only what 0220 granted, guarded on role existence like 0190.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE UPDATE (seen_through,updated_at) ON owner_surface_cursors FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT, INSERT ON owner_surface_cursors FROM control_room_private_web';
  END IF;
END $$;
COMMIT;
