-- 0210's publication guards must be satisfiable by the login that publishes a
-- result set through the byte store.
--
-- THE BUG THIS FIXES. `control_room_native_results` holds
--
--   GRANT INSERT ON control_result_file_sets, control_result_files
--   GRANT UPDATE (state, stored_at)              ON control_result_files
--   GRANT UPDATE (state, stored_at, manifest_digest) ON control_result_file_sets
--
-- which is precisely a declaration of a set, its files, and the declared -> stored
-- move. That move fires FOUR guards on control_result_file_sets and TWO on
-- control_result_files, all SECURITY INVOKER (deliberately -- see 0210), so at
-- COMMIT every one of them runs as this login and PostgreSQL checks the caller's
-- privilege on every relation each body names. This login could not read ANY of the
-- four tables those guards read:
--
--   0206 guard_result_file_set_write        reads control_attempts      (readable)
--   0207 guard_result_file_set_producer     reads fleet_workers          NOT readable
--   0210 guard_result_file_upload_stored    reads control_result_upload_sessions  NOT readable
--   0210 enforce_result_set_published       reads control_result_publications     NOT readable
--
-- Measured on real PostgreSQL 17 as control_room_results on this tree, with the
-- 0210 schema applied:
--
--   SELECT count(*) FROM control_result_publications       -> 42501
--   SELECT count(*) FROM control_result_upload_sessions    -> 42501
--   SELECT count(*) FROM control_result_upload_chunks      -> 42501
--   SELECT count(*) FROM fleet_workers                     -> 42501
--   SELECT count(*) FROM control_result_file_sets          -> ok
--   SELECT count(*) FROM control_attempts                  -> ok
--
-- So a publish of a FLEET set as this login was refused at the FIRST guard to ask,
-- with the login's own permission the reason -- and a four-hour load run lost 21 of
-- 40 chunk publishes to exactly this.
--
-- WHICH BRANCHES ACTUALLY NEED THE READS, and this was MEASURED rather than
-- assumed, because the answer decides how much is granted:
--
--   * A NATIVE set does NOT need any of them. 0210's enforce_result_set_published
--     keys on `producer_kind='fleet'`, and that conjunct makes the whole IF false
--     before the NOT EXISTS is planned. MEASURED with a scratch trigger identical
--     to the shipped one: a native row passed while a fleet row was refused 42501
--     for the same unreadable relation, in one transaction, from one login. So the
--     permission check FOLLOWS the branch -- it is not made once at plan time for
--     the whole function, which is the claim the original report made.
--
--   * A FLEET set needs all four, and is refused without them: 0207's guard first
--     (fleet_workers), then 0210's upload guard
--     (control_result_upload_sessions), then 0210's deferred publication guard
--     (control_result_publications) at COMMIT.
--
-- SCOPE. SELECT only, on the four tables the guard chain reads, for one login.
-- Nothing else. In particular:
--
--   * This login still cannot MINT, rewrite or delete an upload session: INSERT on
--     those stays with the fleet gateway (fleet_gateway_roles.sql:117) and 0209's
--     own guards still stand.
--   * It still cannot mint, rewrite or delete a publication receipt: INSERT stays
--     with the fleet gateway (fleet_gateway_roles.sql:129), and 0210's
--     guard_result_publication_update plus its no-delete and no-truncate triggers
--     make a receipt immutable.
--   * fleet_workers is a worker's own record -- its capabilities, its presence, its
--     credential state. SELECT on it is what 0207's guard needs to check that a
--     fleet set names a worker that exists and is active; 0208 already gives the
--     owner's web login a SELECT on the fleet tables for its own screens, and
--     production_table_grants.sql revokes the whole family from
--     control_room_application / control_room_reader / control_room_backup, so this
--     is a deliberate widening to ONE narrow login rather than to a hosted group.
--   * control_result_upload_chunks is included because 0209's reservation guard
--     reads it on the same path (the sessions' chunk tiling), so a read that stops
--     one table short would leave the next guard unevaluable.
--
-- WHY GRANTS AND NOT DEFiner. Making the guards SECURITY DEFINER would fix this in
-- one line and would hand EVERY writer of the catalog the fleet gateway's and the
-- owner's data by borrowing the guards' rights -- including for a NATIVE set, whose
-- branch is provably dead. A grant is strictly narrower: SELECT conveys the read the
-- guards perform and nothing else, and it is confined to the two producer branches
-- that genuinely take it.
--
-- WHY NO TEST CAUGHT IT. No test in this repository performs a FLEET set's stored
-- transition as `control_room_results`; tests/result-upload-ingress-postgres.test.ts
-- does the fleet publish as the GATEWAY, which holds all three grants. So the whole
-- native-publisher path through 0210's guards was unexercised.
--
-- Same convergence as 0237, 0238 and 0271: the role file is the authoritative
-- statement of the grants and is only read when the module is provisioned, so an
-- installation provisioned before this migration existed keeps the older ACL. The
-- role may not exist either -- several suites apply migrations to a role-less
-- database -- so each grant is guarded by its existence.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_native_results') THEN
    -- The two upload-artefact tables: 0210's guard_result_file_upload_stored reads
    -- the sessions on the file's own stored transition, and 0209's reservation
    -- guard reads both on the same publish.
    EXECUTE 'GRANT SELECT ON control_result_upload_sessions, control_result_upload_chunks TO control_room_native_results';
    -- The publication receipt 0210's deferred guard reads at COMMIT.
    EXECUTE 'GRANT SELECT ON control_result_publications TO control_room_native_results';
    -- The worker 0207's producer guard checks is active, for a FLEET set only.
    EXECUTE 'GRANT SELECT ON fleet_workers TO control_room_native_results';
  END IF;
END $$;