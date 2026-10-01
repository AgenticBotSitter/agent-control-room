-- Down for 0212_text_copy_derivations.sql.
--
-- Revokes exactly what the up file granted, and nothing else. 0212 created ONE
-- table, THREE indexes, THREE triggers and THREE functions, and it revoked
-- nothing that existed before it. So this drops the triggers, the functions and
-- the indexes it created, and the table itself. It does not touch
-- control_result_files or control_result_file_sets, which 0206 owns, and it
-- does not restore any grant on those tables: 0212 granted no privilege on any
-- existing object, so there is no privilege to restore.

BEGIN;

DROP TRIGGER IF EXISTS control_text_copy_derivations_no_truncate ON control_text_copy_derivations;
DROP TRIGGER IF EXISTS control_text_copy_derivations_no_delete ON control_text_copy_derivations;
DROP TRIGGER IF EXISTS control_text_copy_derivations_update_guard ON control_text_copy_derivations;
DROP TRIGGER IF EXISTS control_text_copy_derivations_guard ON control_text_copy_derivations;

DROP FUNCTION IF EXISTS public.guard_text_copy_derivation_update();
DROP FUNCTION IF EXISTS public.guard_text_copy_derivation_insert();

DROP INDEX IF EXISTS control_text_copy_derivations_converter;
DROP INDEX IF EXISTS control_text_copy_derivations_set;

DROP TABLE IF EXISTS control_text_copy_derivations;

COMMIT;
