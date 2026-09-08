-- Explicit disposable restored DB only; same owned evaluation primary and roles.
DO $$ BEGIN
  IF current_database() <> 'cr_f8_restore' THEN RAISE EXCEPTION 'wrong fixture database'; END IF;
  IF (SELECT count(*) FROM cr_f8.tasks WHERE id='fixture-task-1' AND status='awaiting_review') <> 1 THEN
    RAISE EXCEPTION 'required restored row mismatch'; END IF;
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='cr_f8.tasks'::regclass) <> 'cr_f8_owner' THEN
    RAISE EXCEPTION 'owner mismatch'; END IF;
  IF NOT has_table_privilege('cr_f8_reader','cr_f8.tasks','SELECT') THEN RAISE EXCEPTION 'reader missing'; END IF;
  IF has_table_privilege('cr_f8_reader','cr_f8.tasks','INSERT') THEN RAISE EXCEPTION 'reader overprivileged'; END IF;
  IF has_schema_privilege('cr_f8_stranger','cr_f8','USAGE') THEN RAISE EXCEPTION 'stranger access'; END IF;
END $$;
SET ROLE cr_f8_reader;
SELECT count(*) AS restored_reader_rows FROM cr_f8.tasks;
RESET ROLE;
