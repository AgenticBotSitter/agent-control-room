-- ONLY an owned disposable PostgreSQL primary, created by the evaluation controller.
-- NOT a production provisioning script. Required fresh DB name: cr_f8_source.
-- Execute through psql --no-psqlrc --set ON_ERROR_STOP=1 on explicit fixture target.
DO $$ BEGIN
  IF current_database() <> 'cr_f8_source' THEN RAISE EXCEPTION 'wrong fixture database'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public') THEN
    RAISE EXCEPTION 'fixture database not empty';
  END IF;
END $$;
CREATE ROLE cr_f8_owner NOLOGIN;
CREATE ROLE cr_f8_reader NOLOGIN;
CREATE ROLE cr_f8_stranger NOLOGIN;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA cr_f8 AUTHORIZATION cr_f8_owner;
SET ROLE cr_f8_owner;
CREATE TABLE cr_f8.tasks(id text PRIMARY KEY, status text NOT NULL);
INSERT INTO cr_f8.tasks VALUES ('fixture-task-1', 'awaiting_review');
GRANT USAGE ON SCHEMA cr_f8 TO cr_f8_reader;
GRANT SELECT ON cr_f8.tasks TO cr_f8_reader;
RESET ROLE;
