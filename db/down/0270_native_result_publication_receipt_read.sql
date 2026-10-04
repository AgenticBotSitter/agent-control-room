-- Revoke exactly what 0270 granted, and nothing else: the four SELECT grants
-- control_room_native_results holds on the tables 0210's publication guard chain
-- reads -- control_result_upload_sessions, control_result_upload_chunks,
-- control_result_publications and fleet_workers.
--
-- With them gone, 0207's producer guard is unevaluable again for a FLEET set and
-- that publish fails with `42501 permission denied for table fleet_workers`,
-- which is the pre-0270 behaviour, and the point: this file reverses one
-- migration, it does not rewrite the authoritative statement.
--
-- The role file keeps granting the reads, so re-applying 0270 (or upgrading
-- forward again) restores them. Only the SELECTs go: the gateway's INSERT on the
-- upload sessions and on publications is untouched, so nothing here can mint a
-- receipt or an upload session, and 0209's and 0210's own guards still stand.
--
-- It must not be confused with 0210's down, which revokes SELECT and INSERT from
-- this role as part of DROPPING the publication table: 0210 is the migration that
-- created control_result_publications, and downing 0270 alone must leave that
-- table -- and the upload tables, which 0209 created -- standing.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_native_results') THEN
    EXECUTE 'REVOKE SELECT ON control_result_upload_sessions, control_result_upload_chunks FROM control_room_native_results';
    EXECUTE 'REVOKE SELECT ON control_result_publications FROM control_room_native_results';
    EXECUTE 'REVOKE SELECT ON fleet_workers FROM control_room_native_results';
  END IF;
END $$;
