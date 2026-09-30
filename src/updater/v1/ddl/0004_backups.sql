-- Schema `updater`, part 4: the backup ledger (design item 19a, R5i, R17a/c, §9.5).
--
-- This is the updater's FIXED DDL, applied on every start like 0002 and 0003. It
-- is not the release migration ledger, and nothing in db/migrations/ creates,
-- alters or grants anything here. The migrator — the account whose SQL a
-- candidate controls — still holds nothing in this schema, not even USAGE
-- (R10a), which is the whole reason the backup record lives here rather than
-- beside the release tables: a candidate must not be able to declare its own
-- nightly backup healthy, or unblock its own database plan.
--
-- WHAT THIS FILE IS. Two tables and four guards:
--
--   backup_generations  one row per backup attempt, successful or not
--   backup_state        the singleton: policy bounds, last attempt, last
--                       success, last failure, next due
--   backup_is_fresh()   the one predicate §9.5 turns into a red badge, a push
--                       and a refusal of database plans
--   guard_plan_backup_fresh()   the refusal itself
--   guard_backup_generation_immutable()  a failed attempt can never be
--                       rewritten into a good one
--   guard_backup_state_update()  the failure counter and the last-success
--                       clock move forward only
--
-- WHY THE LEDGER IS IN THE DATABASE AND NOT ONLY ON DISK. §9.5's promise is
-- "a failure or a backup older than 26 h ... blocks DB plans until fixed". A
-- file the updater writes and then trusts is a file a crash can leave stale, and
-- a rule enforced in application code is a rule the next version can forget.
-- Here the same predicate is enforced by the database, on the row the plan
-- insert reads, using pg_catalog.now() — so a plan minted while the disk has no
-- good dump is refused even if the updater's own clock, or its own code, is
-- wrong.
--
-- THE CARRY-FORWARD FROM reports/reviews/daemons4.marvin.md ("New finding,
-- pre-existing"): a failed run used to leave an empty generation directory,
-- and name-pattern retention then counted it as a generation and deleted a GOOD
-- dump to keep the count at 14. Two halves close that here, and both are
-- asserted rather than asserted-in-prose:
--   * the row shape constraint below makes a `failed` row physically unable to
--     carry a dump digest, a size, a schema digest or a completion time, so it
--     cannot be counted as a dump at all;
--   * the retention read in src/updater/v1/backup-store.mjs counts only
--     `verified` rows, and the sweep in backup-runner.mjs deletes a directory
--     unless it has BOTH a valid manifest AND a verified row.
-- The partial index below is what makes the retention read cheap and is the
-- third half: a failed row is not even in the index retention walks.

-- ---------------------------------------------------------------------------
-- backup_generations
-- ---------------------------------------------------------------------------
-- `generation_id` is derived from pg_catalog.now() and formatted, not chosen by
-- a caller, so the directory name on disk and the row in here are the same
-- identifier and neither can be pointed at a path the other did not name
-- (R-FS: a value read from a lower-writable directory is never used as a path).
-- The hour/minute/second format keeps a generation name sortable and keeps it
-- inside the updater's bounded-id grammar.
--
-- `row_counts` is the per-table row count read from the SOURCE inside the same
-- exported snapshot the dump was taken from, and re-read from the scratch
-- restore cluster to prove the dump contains the same state. It is an array of
-- {table,count} objects, bounded at 64 KiB: a database with tens of thousands
-- of tables would exceed that, and a verify that cannot be bounded is a verify
-- that can be used to make the updater do unbounded work.
--
-- The per-table row-count array's shape, as an IMMUTABLE function rather than
-- an inline CHECK expression.
--
-- PostgreSQL refuses a subquery inside a CHECK constraint ("cannot use subquery
-- in check constraint", SQLSTATE 0A000), and the check genuinely needs to look
-- at the ARRAY'S ELEMENTS rather than at the array as a whole. An IMMUTABLE
-- SQL function is the supported way to express that, and it is safe here for
-- the reason the language is IMMUTABLE and it reads no table: PostgreSQL may
-- evaluate it during a restore of a dumped row, and a constraint that changed
-- its verdict between install and reload would be a worse defect than a missing
-- one. Anything this function cannot decide is false.
CREATE OR REPLACE FUNCTION updater.backup_row_counts_shape(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, updater, pg_temp AS $$
  SELECT pg_catalog.jsonb_typeof(value) = 'array'
     AND pg_catalog.jsonb_array_length(value) BETWEEN 1 AND 4096
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(value) AS entry
        WHERE pg_catalog.jsonb_typeof(entry) <> 'object'
           OR pg_catalog.jsonb_typeof(entry -> 'table') <> 'string'
           OR pg_catalog.jsonb_typeof(entry -> 'count') <> 'number'
           OR entry ->> 'table' !~ '^[a-z0-9_]{1,63}$'
           OR (entry ->> 'count')::bigint < 0)
$$;

CREATE TABLE IF NOT EXISTS updater.backup_generations (
  generation_id text PRIMARY KEY CHECK (generation_id ~
    '^backup:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$'),
  -- 'verified' means the dump was written, hashed, restore-verified into a
  -- scratch cluster and compared. Nothing else may ever set it: see
  -- guard_backup_generation_immutable() and the shape constraint.
  state text NOT NULL CHECK (state IN ('verified','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- The dump's own sha256 (of the PLAINTEXT dump, so it is comparable with a
  -- dump taken with encryption off) and the sha256 of the file as it sits on
  -- disk (which differs when the dump is encrypted at rest). Recording both is
  -- what lets a future restore say "this file is the one that verified" without
  -- re-reading the source.
  dump_sha256 text CHECK (dump_sha256 IS NULL OR dump_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  dump_bytes bigint CHECK (dump_bytes IS NULL OR (dump_bytes > 0 AND dump_bytes < 1099511627776)),
  file_sha256 text CHECK (file_sha256 IS NULL OR file_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  -- The SHAPE digest, not the release's ownership-bearing schema digest: a
  -- restore runs with --no-owner, so ownership is not in the dump and cannot
  -- be compared across one. See src/updater/v1/backup-evidence.mjs.
  shape_digest text CHECK (shape_digest IS NULL OR shape_digest ~ '^sha256:[a-f0-9]{64}$'),
  row_counts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (octet_length(row_counts::text) <= 65536),
  row_counts_digest text CHECK (row_counts_digest IS NULL OR row_counts_digest ~ '^sha256:[a-f0-9]{64}$'),
  -- Whether the dump is sealed on disk. Required when the backup root is
  -- outside the install root: the owner's external drive has ownership
  -- disabled, so R-FS cannot be the thing that protects a plaintext dump.
  encrypted boolean NOT NULL DEFAULT false,
  -- The exported snapshot the dump and the evidence were both taken from. Kept
  -- for the operator, bounded, and never parsed back into a query.
  snapshot_xid text CHECK (snapshot_xid IS NULL OR snapshot_xid ~ '^[0-9A-Fa-f:]{1,64}$'),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  failure_detail text CHECK (failure_detail IS NULL OR length(failure_detail) <= 200),
  -- Item 18's pin. §9.2 keeps a pre-update dump until the next successful
  -- database update plus seven days, which outranks the 14-generation rule.
  -- The column exists now so retention has to respect it from the first run
  -- rather than gaining an exception later that could evict a pre-image.
  retain_until timestamptz,
  -- THE SHAPE CONSTRAINT IS THE daemons4 FIX. A `failed` row cannot carry a
  -- digest, a size, a schema digest or a row-count digest, so retention has
  -- nothing to mistake for a dump; and a `verified` row cannot exist without all
  -- of them, so "verified" is never a claim with no evidence behind it.
  CONSTRAINT backup_generation_verified_shape CHECK (
    (state = 'verified'
      AND completed_at IS NOT NULL
      AND dump_sha256 IS NOT NULL AND dump_bytes IS NOT NULL AND file_sha256 IS NOT NULL
      AND shape_digest IS NOT NULL AND row_counts_digest IS NOT NULL
      AND jsonb_array_length(row_counts) > 0
      AND failure_code IS NULL)
    OR
    (state = 'failed'
      AND completed_at IS NOT NULL
      AND failure_code IS NOT NULL
      AND dump_sha256 IS NULL AND dump_bytes IS NULL AND file_sha256 IS NULL
      AND shape_digest IS NULL AND row_counts_digest IS NULL)
  ),
  CONSTRAINT backup_generation_completed_after_created CHECK (completed_at IS NULL OR completed_at >= created_at),
  CONSTRAINT backup_generation_retention_pin CHECK (retain_until IS NULL OR retain_until > created_at),
  -- A `verified` row must carry real counts; a `failed` row carries none.
  CONSTRAINT backup_generation_counts_shape CHECK (
    (state = 'verified' AND updater.backup_row_counts_shape(row_counts))
    OR (state = 'failed' AND row_counts = '[]'::jsonb)
  )
);

-- The retention read and the freshness read both walk this index and nothing
-- else, which is what keeps "the newest 14 verified dumps" a bounded query no
-- matter how many failures have accumulated.
CREATE INDEX IF NOT EXISTS backup_generations_verified_recent
  ON updater.backup_generations(completed_at DESC, generation_id DESC) WHERE state = 'verified';
CREATE INDEX IF NOT EXISTS backup_generations_attempted
  ON updater.backup_generations(created_at DESC, generation_id DESC);

-- ---------------------------------------------------------------------------
-- backup_state — one row, the updater's own memory of the backup
-- ---------------------------------------------------------------------------
-- `max_age_seconds` and `kept_generations` are the running policy's values, not
-- constants frozen into this file, so a policy change in updater/current/policy
-- takes effect on the next start without an updater-class plan just to widen a
-- number. They are bounded by their own CHECKs, which is the load-bearing part:
-- the freshness rule is "a verified dump within `max_age_seconds`", so a caller
-- that could set it to 604800 (seven days) would make the rule much weaker
-- than §9.5's 26 hours while still satisfying the type. The one-hour floor keeps
-- it impossible to make the rule vacuous, and the updater's own store reads the
-- value back through `policy()`, which re-applies the same bounds rather than
-- trusting the row.
CREATE TABLE IF NOT EXISTS updater.backup_state (
  singleton boolean PRIMARY KEY CHECK (singleton),
  max_age_seconds integer NOT NULL CHECK (max_age_seconds BETWEEN 3600 AND 604800),
  kept_generations integer NOT NULL CHECK (kept_generations BETWEEN 1 AND 100),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_failure_code text CHECK (last_failure_code IS NULL OR last_failure_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  last_failure_at timestamptz,
  -- Set on every attempt, from pg_catalog.now(), so the 02:30 schedule is
  -- evaluated by the database's clock and not by the Mac's (design: DB now()
  -- everywhere; a clock jump cannot make the nightly fire twice or never).
  next_due_at timestamptz NOT NULL DEFAULT now(),
  -- A failure retries sooner than a success: an hour, not a day, so a broken
  -- backup is repaired within the hour instead of at the next 02:30.
  consecutive_failures integer NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0 AND consecutive_failures < 100000),
  last_generation_id text REFERENCES updater.backup_generations(generation_id) ON DELETE RESTRICT,
  CONSTRAINT backup_state_failure_pair CHECK ((last_failure_code IS NULL) = (last_failure_at IS NULL)),
  CONSTRAINT backup_state_attempt_pair CHECK ((last_failure_at IS NULL) = (last_attempt_at IS NULL)
    OR last_failure_at <= last_attempt_at)
);
INSERT INTO updater.backup_state (singleton, max_age_seconds, kept_generations)
  VALUES (true, 93600, 14)
  ON CONFLICT (singleton) DO NOTHING;

-- ---------------------------------------------------------------------------
-- backup_is_fresh — the one predicate behind the badge, the push and the
-- refusal (design §9.5, §12)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because the plan trigger calls it while the INSERT may come
-- from a session that must not be able to read this table; it returns a boolean
-- and nothing else, and it is REVOKEd from PUBLIC so the only way to ask is
-- through the guard.
--
-- It fails CLOSED in the only way a boolean function can: if the policy row is
-- missing there is no bound to compare against, and `now() - NULL` is NULL, so
-- the EXISTS cannot match and the answer is false. A missing policy therefore
-- blocks database plans rather than waving them through.
CREATE OR REPLACE FUNCTION updater.backup_is_fresh() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE
  bound timestamptz;
BEGIN
  SELECT pg_catalog.now() - make_interval(secs => s.max_age_seconds)
    INTO bound
  FROM updater.backup_state s WHERE s.singleton;
  -- A missing policy row leaves `bound` NULL, so the comparison below is never
  -- true and the answer is false. That is the fail-closed direction: no policy
  -- means no bound to prove a backup against, and a database plan is not
  -- admitted on a rule that could not be evaluated.
  IF bound IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM updater.backup_generations g
     WHERE g.state = 'verified' AND g.completed_at > bound
  );
END;
$$;
REVOKE ALL ON FUNCTION updater.backup_is_fresh() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- guard_plan_backup_fresh — a database plan cannot open without a fresh backup
-- ---------------------------------------------------------------------------
-- §9.5: "A failure or a backup older than 26 h makes the Home badge red, sends
-- a push, and blocks DB plans until fixed." §9.7 lists "the nightly backup
-- failing" among the things the automatic path refuses, with nothing changed and
-- a plain reason.
--
-- The refusal is at INSERT as well as at the transition to `approved`. Refusing
-- only on approval would let the plan be built, published and rendered, and the
-- owner would be asked to approve a plan that can never run; refusing on INSERT
-- means the watcher learns immediately and can report `attended_upgrade_required`
-- with this code, which is what the card shows.
--
-- The advisory lock is the same one the plan-open guard takes, taken in the same
-- order, so a plan insert and a backup completion are serialised: without it a
-- plan could be admitted microseconds before the last good backup's max_age
-- lapses, and the rule would depend on which of two racing transactions
-- committed first.
CREATE OR REPLACE FUNCTION updater.guard_plan_backup_fresh() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.kind <> 'database' THEN RETURN NEW; END IF;
  IF NEW.state NOT IN ('building','ready_for_approval','approved') THEN RETURN NEW; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('updater:open-plan', 0));
  IF NOT updater.backup_is_fresh() THEN
    RAISE EXCEPTION 'updater database plan refused: no verified backup within the policy age (code updater_database_backup_stale)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_plan_backup_fresh() FROM PUBLIC;
CREATE OR REPLACE TRIGGER plans_backup_fresh_guard BEFORE INSERT OR UPDATE ON updater.plans
  FOR EACH ROW EXECUTE FUNCTION updater.guard_plan_backup_fresh();

-- ---------------------------------------------------------------------------
-- A generation row is written once, EXCEPT for exactly one transition.
--
-- The exception is the point. The row is born `failed` with
-- `failure_code='backup_in_progress'` BEFORE any dump byte exists (so a
-- `kill -9` mid-dump leaves a durable red record rather than an empty
-- directory), and the SAME row is completed to `verified` at the end. Without
-- this exception the durability is worthless: the row could never be completed
-- and every backup would be recorded as a failure.
--
-- So the guard permits precisely: `failed`/`backup_in_progress` ->
-- `verified`/NULL, on the row's own primary key, and nothing else. Every other
-- UPDATE is refused, and in particular:
--   * a `verified` row can never become `failed` again, and
--   * a completed `failed` row can never be revived, so a retried or replayed
--     completion cannot resurrect a generation with no dump behind it.
-- That is the daemons4 empty-generation defect closed at the storage layer: the
-- only way to reach `verified` is through a run that really finished.
--
-- `retain_until` is separately mutable, and only upwards: item 18 pins a
-- pre-image dump until the next successful database update plus seven days, and
-- the retention rule must never be able to unpin one that already exists.
CREATE OR REPLACE FUNCTION updater.guard_backup_generation_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.generation_id IS DISTINCT FROM OLD.generation_id THEN
    RAISE EXCEPTION 'updater backup generation id is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'failed' OR OLD.failure_code <> 'backup_in_progress' THEN
    IF (to_jsonb(NEW) - ARRAY['retain_until']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['retain_until']) THEN
      RAISE EXCEPTION 'updater backup generation content is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- The one permitted transition, stated rather than left to the shape
    -- constraint: an in-flight attempt may complete, and it may complete only
    -- into `verified` with the failure cleared.
    IF NEW.state <> 'verified' OR NEW.failure_code IS NOT NULL THEN
      RAISE EXCEPTION 'updater backup generation may only complete in flight' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.retain_until IS NOT NULL AND OLD.retain_until IS NOT NULL AND NEW.retain_until < OLD.retain_until THEN
    RAISE EXCEPTION 'updater backup generation retention pin cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_backup_generation_immutable() FROM PUBLIC;
CREATE OR REPLACE TRIGGER backup_generations_immutable_guard BEFORE UPDATE ON updater.backup_generations
  FOR EACH ROW EXECUTE FUNCTION updater.guard_backup_generation_immutable();

-- ---------------------------------------------------------------------------
-- The singleton's bookkeeping moves forward only
-- ---------------------------------------------------------------------------
-- The badge is a function of this row, so the row is the thing worth protecting
-- rather than the badge. Three properties, each of which a mistake or an
-- attacker would want:
--   * the failure pair clears and sets as a pair, so "failed" cannot become
--     "healthy" by clearing the code and leaving the timestamp;
--   * last_success_at and last_failure_at never move backwards, so a wrong
--     clock cannot manufacture a fresh-looking backup;
--   * consecutive_failures moves by one, so a caller cannot zero it in one
--     statement to reset the retry schedule.
CREATE OR REPLACE FUNCTION updater.guard_backup_state_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.singleton IS DISTINCT FROM OLD.singleton THEN
    RAISE EXCEPTION 'updater backup state is a singleton' USING ERRCODE = '23514';
  END IF;
  IF (NEW.last_failure_code IS NULL) IS DISTINCT FROM (NEW.last_failure_at IS NULL) THEN
    RAISE EXCEPTION 'updater backup failure code and time must be set or cleared together' USING ERRCODE = '23514';
  END IF;
  IF OLD.last_failure_code IS NOT NULL AND NEW.last_failure_code IS NULL
      AND (OLD.last_attempt_at IS NOT NULL AND NEW.last_success_at IS NOT NULL
           AND NEW.last_success_at < OLD.last_attempt_at) THEN
    RAISE EXCEPTION 'updater backup recovered before the failure it clears' USING ERRCODE = '23514';
  END IF;
  IF OLD.last_success_at IS NOT NULL AND NEW.last_success_at IS NOT NULL
      AND NEW.last_success_at < OLD.last_success_at THEN
    RAISE EXCEPTION 'updater backup last success moved backwards' USING ERRCODE = '23514';
  END IF;
  IF OLD.last_failure_at IS NOT NULL AND NEW.last_failure_at IS NOT NULL
      AND NEW.last_failure_at < OLD.last_failure_at THEN
    RAISE EXCEPTION 'updater backup last failure moved backwards' USING ERRCODE = '23514';
  END IF;
  IF NEW.consecutive_failures < OLD.consecutive_failures - 1 OR NEW.consecutive_failures > OLD.consecutive_failures + 1 THEN
    RAISE EXCEPTION 'updater backup failure counter moved by more than one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_backup_state_update() FROM PUBLIC;
CREATE OR REPLACE TRIGGER backup_state_update_guard BEFORE UPDATE ON updater.backup_state
  FOR EACH ROW EXECUTE FUNCTION updater.guard_backup_state_update();

-- ---------------------------------------------------------------------------
-- Grants: nobody but the updater writes here
-- ---------------------------------------------------------------------------
-- The web reads a display projection of the backup state and nothing else; the
-- red badge on Home is rendered from these columns (§12 lists "nightly backup
-- failed / > 26 h" as a Home badge). It is given no INSERT, so a compromised
-- release cannot queue an "it's fine" push or clear a failure, and the push
-- queue remains the only thing it may enqueue — where the existing push guard
-- still refuses it the updater's own template prefix (R12).
REVOKE ALL ON SCHEMA updater FROM PUBLIC;
-- The dump digest, the file digest and the per-table row counts are not shown to
-- the web: the badge needs state and ages, and the rest is the operator's. So
-- there is no table-wide SELECT here — the grant is column-scoped, and the
-- REVOKE runs first so a table-wide grant an operator added earlier is undone
-- by the same statement (measured: the earlier GRANT would survive a later
-- narrower GRANT, because grants accumulate).
REVOKE ALL ON updater.backup_generations, updater.backup_state FROM control_room_private_web;
GRANT SELECT (generation_id, state, created_at, completed_at, encrypted, failure_code, retain_until)
  ON updater.backup_generations TO control_room_private_web;
GRANT SELECT (singleton, max_age_seconds, kept_generations, last_attempt_at, last_success_at,
  last_failure_code, last_failure_at, next_due_at, consecutive_failures, last_generation_id)
  ON updater.backup_state TO control_room_private_web;

-- PUBLIC holds nothing, and neither does any role that is not the deployer.
ALTER DEFAULT PRIVILEGES IN SCHEMA updater REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA updater REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA updater REVOKE ALL ON FUNCTIONS FROM PUBLIC;
