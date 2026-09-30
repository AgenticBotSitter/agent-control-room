-- Down for 0213_text_copy_derivation_grants.sql.
--
-- Revokes exactly what the up file granted, and nothing else. 0213 created TWO
-- views and granted SELECT on them to three roles; it created no table, no
-- function and no trigger, and it granted nothing on any pre-existing object.
-- So this revokes those three grants and drops the two views.
--
-- It deliberately does NOT touch control_text_copy_derivations: that table
-- belongs to 0212, and dropping it here would take away an object this migration
-- never created.

BEGIN;

REVOKE SELECT ON control_worker_text_copy_derivations FROM control_room_native_queue_worker;
REVOKE SELECT, INSERT ON control_text_copy_derivations FROM control_room_native_results;
REVOKE SELECT ON control_project_text_copy_derivations FROM control_room_private_web;

DROP VIEW IF EXISTS control_project_text_copy_derivations;
DROP VIEW IF EXISTS control_worker_text_copy_derivations;

COMMIT;
