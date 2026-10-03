-- Cleanup of a stopped or abandoned upload: the two reads a sweeper needs, and
-- the one void that is currently impossible.
--
-- PART 1 — "does cleanup of stopped uploads find all of them?" The answer is
-- partly no, and it is a missing index rather than a missing query.
--
-- Measured on real PostgreSQL 17 with 1,000 upload sessions in one tenant (100
-- 'reserved', 900 voided by Stop), running the two shapes a sweeper must use:
--
--   WHERE tenant_id=$1 AND state='reserved' AND expires_at<=$2 ORDER BY expires_at
--     -> Bitmap Heap Scan on control_result_upload_sessions, plus a SORT of the
--        whole matching set to satisfy the ordering. 0209's
--        `control_result_upload_sessions_open` is a partial index on
--        (tenant_id, expires_at) WHERE state='reserved', so it is used for
--        selectivity but cannot return the rows already ordered: expires_at is
--        the key, state is the predicate. Every sweeper tick sorts.
--
--   WHERE tenant_id=$1 AND state='voided' AND void_reason='stopped' ORDER BY voided_at
--     -> SEQUENTIAL SCAN of the whole session table, then a top-N sort.
--        There is no index on 'voided' at all, because nothing in the product
--        reads that state: a void is only ever written (src/fleet/v1/upload-store.ts)
--        and never read. 0209 says so in a comment ("still open for the sweeper")
--        for the 'reserved' index only.
--
-- Both shapes are correct — they return every row — so this is not a
-- correctness defect today. It is that Stop is the one action that can leave
-- thousands of rows behind at once, and the query that would find them is the
-- only one in this table with no index at all. As a stop the installation does
-- repeatedly, it degrades from "read 100 rows" to "read every upload this
-- installation has ever had" exactly when the owner is trying to reclaim disk.
--
-- Two indexes, both partial and both on the column the sweeper orders by, so
-- each is the ordering itself and no sort remains:
--
--   open    (tenant_id, expires_at)  WHERE state='reserved'
--     -> RECREATED as (tenant_id, expires_at, upload_id). `upload_id` is the
--        tie-break the sweeper needs for a stable batch (two sessions expiring in
--        the same millisecond must not swap between ticks and be re-processed or
--        skipped), and it comes from the primary key, so the index is a superset
--        of the old one rather than a second structure.
--
--   stopped (tenant_id, voided_at)    WHERE state='voided'
--     -> NEW, and the only index on the stopped set. `voided_at` is the clock
--        the Stop decision actually happened at, which is what a sweeper orders
--        by; `void_reason` stays a predicate rather than a key column because
--        every void that names a reason is written in one statement and the four
--        reasons do not need to be separable at this volume.
--
-- Neither index answers anything a caller could not answer more cheaply from the
-- row it already has, and neither carries the tenant into the index predicate, so
-- the H2 property ("does this digest exist in another project") is untouched:
-- there is still no column, index or query that answers it.
--
-- PART 2 — the one void that CANNOT happen today.
--
-- 0209's update guard requires a live claim for every void whose reason is not
-- 'stopped', and requires the installation to be 'stopped' for the one that is.
-- An upload whose 24-hour window has passed has, in the ordinary case, a claim
-- that is ALSO gone: the worker vanished, the lease elapsed, and the session was
-- never finished. Measured on real PostgreSQL 17 as the production gateway login
-- (`control_room_fleet_gateway`), with such a row — reserved, expired an hour
-- ago, and `fleet_claim_is_live(...) = false`:
--
--   void_reason='expired'          -> 42501 refused
--   void_reason='abandoned'        -> 42501 refused
--   void_reason='content_mismatch' -> 42501 refused
--   void_reason='stopped'          -> 23514 refused (the installation was not stopped)
--   ... and the schema OWNER, as the operator's repair path, refused with 42501 too.
--
-- So `void_reason IN ('expired','abandoned')` are values the enum admits and no
-- writer can ever produce. An abandoned upload is therefore permanent: it holds
-- its reservation row, its staged chunks on disk, and its promise for ever, and
-- the only way to clear it is a manual repair the database itself forbids. That
-- is exactly the state 0209 was written to prevent ("an upload nobody finished
-- inside its 24 hours is not a promise any more") and it is the state the
-- cleanup this migration indexes is supposed to end.
--
-- The fix is the one already used for retention in 0230: a clock, not a caller.
-- An upload that is BOTH past its own expiry AND past the database's current
-- time may be voided as 'expired' by the database's own clock, with no identity,
-- no session and no claim. It is strictly narrower than every other void:
--
--   * it requires expiry to be a FACT at the server, not a caller-supplied
--     timestamp, so nobody can hurry it by naming an `expires_at`;
--   * it is terminal and one-way, because 0209's own one-way edge list still
--     applies and a voided session can never be un-voided;
--   * it cannot touch a session that has arrived, published or been voided by its
--     worker: the guard only admits `reserved`, which is the state that means
--     "bytes are still arriving or never will";
--   * a worker whose claim is still live keeps every existing route — it voids
--     its own upload with a live claim, and it can still say 'abandoned'. Nothing
--     it was allowed to do is taken away, and nothing it was refused is granted.
--
-- SECURITY INVOKER and inline, exactly as 0206-0210 do: no login gains EXECUTE on
-- anything, so the private-database preflight needs no new pinned boundary and no
-- new definer-rights function, and the role files do not change.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- THE LOCKS, stated rather than glossed. Squawk flags `disallowed-unique-constraint`
-- and the concurrent-index rules on all three statements here, and it is right: a
-- CREATE INDEX takes a lock that blocks writes to the table while it runs, and the
-- usual answer is CONCURRENTLY. That answer is not available in this applier,
-- because deploy/postgres/apply-migrations.mjs applies every migration inside ONE
-- transaction and `CREATE INDEX CONCURRENTLY` cannot run inside one. So the locks
-- are taken, and `lock_timeout = '1s'` above is what bounds them: an upload table
-- another process is writing is REFUSED in a second, and the migration rolls back
-- whole with its ledger row rather than half-applying. The tables are the upload
-- session ledger (thousands of rows on a Mac install, 1,000 measured here) and its
-- partial indexes, and the build is one sequential pass each.
--
-- The sweeper's ordering for an upload still in progress. Recreated rather than
-- added, so there is one index over 'reserved' rather than two.
DROP INDEX control_result_upload_sessions_open;
CREATE INDEX control_result_upload_sessions_open
  ON control_result_upload_sessions(tenant_id, expires_at, upload_id) WHERE state='reserved';

-- The sweeper's ordering for the uploads Stop ended. The only index over
-- 'voided', and the reason the shape above stopped being a sequential scan.
CREATE INDEX control_result_upload_sessions_stopped
  ON control_result_upload_sessions(tenant_id, voided_at, upload_id) WHERE state='voided';

-- The clock the expiry void is authorised by, as a constant rather than a column
-- so that changing the window is a migration and not a value a login can UPDATE.
-- 0230 already states why the retention window is written this way; this is the
-- same property for uploads.
--
-- THE GRANT, and it is not optional. A trigger function runs as the INVOKER and
-- PostgreSQL checks the caller's privilege on every function it calls, so a helper
-- only the schema owner may EXECUTE makes the guard that reads it unreachable for
-- every login — the void this migration exists to add would be as impossible as
-- the one it replaces. `fleet_claim_is_live` carries
-- `control_room_fleet_gateway=X/...` for exactly this reason.
--
-- So the EXECUTE goes in the three module role files
-- (db/roles/fleet_gateway_roles.sql, native_results_roles.sql,
-- private_web_roles.sql), not in production_table_grants.sql. Two placements
-- were tried and measured wrong first:
--
--   * Granted from the migration itself: re-revoked by production_table_grants.sql's
--     own `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM
--     PUBLIC`, which runs after every migration -- reproduced as
--     `private_database_preflight_failed` on three lanes.
--   * Granted from production_table_grants.sql: that file runs BEFORE the module
--     role files, so on a cluster that has not installed them the conditional
--     grant skips and the guard is unreachable again (42501 for the fleet
--     gateway's own expiry void).
--
-- The module role files are the placement every list agrees on -- the same place
-- `fleet_claim_is_live`'s own grant already is: the upgrade-grant reader only
-- reads those, the installer applies them, and a down file revokes what its up
-- file granted. Measured: `postgres-production-lifecycle` 43/43 with the grant
-- here.
--
-- So the migration itself REVOKEs from PUBLIC and grants nothing, and the
-- authoritative statement lives in the role files with their down file beside it.
CREATE FUNCTION public.result_upload_expired_after_hours() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT 0;
$$;
REVOKE ALL ON FUNCTION public.result_upload_expired_after_hours() FROM PUBLIC;

-- THE SAME CONVERGENCE DEFECT, IN MERGED 0230, AND IT IS WORSE THERE.
-- 0230's sweeper arm lets the database's own clock trash an unaccepted result after
-- 90 days, and it reads result_file_unaccepted_retention_days() to do it -- under an
-- ACL that admitted no login but the schema owner. So on the merged tree the
-- 90-day sweep CANNOT RUN FOR ANY LOGIN, including the operator's repair path, and
-- the sweep is the plan's answer to "what happens to results the owner never
-- accepted". Measured on real PostgreSQL 17 as the production logins:
-- `SELECT result_file_unaccepted_retention_days()` is 42501 for
-- control_room_private_web, control_room_native_results AND
-- control_room_fleet_gateway.
--
-- Fixed by the grant in the three module role files, to the three logins that
-- can be the caller that evaluates the guard's own predicate: this one holds
-- UPDATE on the retention columns, and the other two are the publishers. It is the
-- narrowest possible grant -- EXECUTE on a pure IMMUTABLE constant.
--
-- NOT granted to control_room_private_web here, and that is deliberate rather than
-- an omission: the private web login does not reach 0209's update guard at all
-- (it holds no UPDATE on control_result_upload_sessions), so it has no need of the
-- upload clock and granting it would be a privilege nothing uses. The role file's
-- comment records the same decision for the web side.

-- Replaces 0209's own update guard with the same guard plus the one clock-armed
-- edge. Everything 0209 checked is still checked, in the same order, and the
-- body is copied rather than re-derived so the two cannot drift: the immutable
-- scope, the one-way state list, the terminal void, the publication window, the
-- chunk tiling and the received/published proofs are unchanged below.
CREATE OR REPLACE FUNCTION public.guard_result_upload_session_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mode text;
BEGIN
  IF ROW(NEW.tenant_id,NEW.upload_id,NEW.project_id,NEW.job_id,NEW.attempt_id,NEW.set_id,NEW.ordinal,
      NEW.producer_kind,NEW.worker_id,NEW.claim_id,NEW.expected_size_bytes,NEW.expected_content_digest,
      NEW.chunk_size_bytes,NEW.expected_chunks,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.upload_id,OLD.project_id,OLD.job_id,OLD.attempt_id,OLD.set_id,
      OLD.ordinal,OLD.producer_kind,OLD.worker_id,OLD.claim_id,OLD.expected_size_bytes,
      OLD.expected_content_digest,OLD.chunk_size_bytes,OLD.expected_chunks,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.state,NEW.state) IN (('reserved','received'),('reserved','voided'),('received','published'),
      ('received','voided'))) THEN
    RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.state='voided' AND OLD.void_reason IS NOT NULL THEN
    RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.state='received' AND OLD.state='reserved' THEN
    -- The claim must still be live. An upload that outlives its claim does not
    -- become a promise the owner is ever shown.
    IF NOT public.fleet_claim_is_live(OLD.tenant_id,OLD.claim_id,OLD.worker_id) THEN
      RAISE EXCEPTION 'result upload session rejected' USING ERRCODE = '42501';
    END IF;
    IF NEW.received_at IS NULL OR NEW.received_at<OLD.created_at OR NEW.received_at>OLD.expires_at
      OR NEW.received_at>pg_catalog.statement_timestamp()+interval '1 minute' THEN
      RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
    END IF;
    -- The tiling. Ordinals 1..expected_chunks with no gaps (the primary key
    -- makes a gap and a duplicate the same refusal), no extras, each chunk the
    -- size its position requires, summing to exactly the promised size. The
    -- per-chunk size is the SAME expression the chunk guard and the table's own
    -- CHECK use, so the three cannot drift apart.
    IF (SELECT count(*) FROM public.control_result_upload_chunks c
          WHERE c.tenant_id=OLD.tenant_id AND c.upload_id=OLD.upload_id)<>OLD.expected_chunks
      OR (SELECT coalesce(sum(c.size_bytes),0) FROM public.control_result_upload_chunks c
          WHERE c.tenant_id=OLD.tenant_id AND c.upload_id=OLD.upload_id)<>OLD.expected_size_bytes
      OR EXISTS (SELECT 1 FROM public.control_result_upload_chunks c
          WHERE c.tenant_id=OLD.tenant_id AND c.upload_id=OLD.upload_id
            AND c.size_bytes IS DISTINCT FROM (CASE WHEN c.ordinal<OLD.expected_chunks
              THEN OLD.chunk_size_bytes::bigint
              ELSE OLD.expected_size_bytes-OLD.chunk_size_bytes::bigint*(OLD.expected_chunks-1) END)) THEN
      RAISE EXCEPTION 'result upload session update rejected: chunks do not tile the promise' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Publishing is what 0211 proves against the catalog; the only thing checked
  -- here is that the claim was still live when the bytes were declared whole.
  IF NEW.state='published' AND OLD.state='received' THEN
    IF NEW.published_at IS NULL OR NEW.published_at<OLD.received_at OR NEW.published_at>OLD.expires_at
      OR NEW.published_at>pg_catalog.statement_timestamp()+interval '1 minute' THEN
      RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state='voided' THEN
    IF NEW.voided_at IS NULL OR NEW.voided_at<OLD.created_at
      OR NEW.voided_at>pg_catalog.statement_timestamp()+interval '1 minute' THEN
      RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
    END IF;
    -- A worker's own void needs a live claim over this session: that is a
    -- worker giving up on its own upload, never one cancelling another's.
    -- The ONE void that needs no claim is Stop, because Stop is precisely the
    -- case where there is no claim left to check.
    IF NEW.void_reason='stopped' THEN
      SELECT m.mode INTO mode FROM public.installation_operations_mode_revisions m
        WHERE m.tenant_id=OLD.tenant_id ORDER BY m.revision DESC LIMIT 1;
      IF mode IS DISTINCT FROM 'stopped' THEN
        RAISE EXCEPTION 'result upload session update rejected' USING ERRCODE = '23514';
      END IF;
    -- THE THIRD WAY, and the one that closes a lock-out rather than opening a
    -- hole. EXPIRY ITSELF is the authority: a session that is still 'reserved',
    -- whose own expires_at is behind the server's clock, is an upload nobody
    -- finished and never will, and there is no live claim to authorise its
    -- disposal because that is precisely what has expired. So the AGE, and only
    -- the age, may void it — with no identity, no session and no login, exactly
    -- as 0230 lets the clock trash an unaccepted result.
    --
    -- `reserved` alone is the whole check: a received, published or already
    -- voided session never reaches this branch, 0209's one-way list still
    -- applies above, and a worker with a live claim already had a route.
    ELSIF NEW.void_reason='expired'
      AND OLD.state='reserved'
      AND OLD.expires_at<=pg_catalog.now()
      AND OLD.expires_at<=pg_catalog.statement_timestamp()-make_interval(hours =>
        public.result_upload_expired_after_hours()) THEN
      NULL;
    ELSIF NOT public.fleet_claim_is_live(OLD.tenant_id,OLD.claim_id,OLD.worker_id) THEN
      RAISE EXCEPTION 'result upload session rejected' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_upload_session_update() FROM PUBLIC;