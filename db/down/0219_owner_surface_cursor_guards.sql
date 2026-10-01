BEGIN;
DROP TRIGGER owner_surface_cursors_no_truncate ON owner_surface_cursors;
DROP TRIGGER owner_surface_cursors_no_delete ON owner_surface_cursors;
DROP TRIGGER owner_surface_cursors_guard ON owner_surface_cursors;
DROP FUNCTION guard_owner_surface_cursor_write();
COMMIT;
