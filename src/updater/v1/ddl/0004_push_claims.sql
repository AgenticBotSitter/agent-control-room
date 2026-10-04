-- Scheduled notices (U06) and recoverable push claims (U03, U07, U02).
--
-- This file is the updater's own schema, applied by the updater at startup as
-- control_room_deployer. It is deliberately NOT a db/migrations file: nothing
-- in the release ledger may create, alter or grant anything in schema `updater`,
-- because those tables hold the owner's approval and the R10a rule is that the
-- account whose SQL a candidate controls must not own them. The loader
-- (src/updater/v1/schema-installer.ts) runs this after 0003.
--
-- ===========================================================================
-- WHAT WAS BROKEN, MEASURED ON POSTGRESQL 17 AS control_room_deployer
-- ===========================================================================
--
-- U06. `pending()` selected every unsent row and never mentioned `not_before`,
-- and `begin()` did the same. `enqueue_cooling_off_notices` queues the 12-hour
-- repeat with `not_before = now() + 12 hours`, and the sender returned it as
-- sendable immediately. The design's requirement is that the owner is warned
-- AGAIN at 12 h; sending the repeat at queue time means the phone rings once,
-- at the wrong time, and the second required warning never happens.
--
-- U07. `begin()` writes `last_error_code='updater_push_reserved'` and nothing
-- else records that the claim happened: no owner, no instant. A process that
-- died between `begin()` and `finish()` left the row reserved, and BOTH halves
-- of the loop then exclude it forever -- `pending()` filters the code out, and
-- `begin()`'s WHERE clause refuses to re-claim a reserved row. The updater
-- could be restarted a hundred times and the row would stay reserved until the
-- ten-attempt bound, which the reserved state also prevents reaching. The
-- measured result: a queued owner warning is invisible and unsendable
-- permanently, with no record anywhere that it was ever claimed.
--
-- U03. The same strand, at the last attempt. Even a recovery query that
-- recovered stale reservations has to exclude `attempts >= 10`, because a
-- recovered row at the bound cannot be claimed again. So a crash on the
-- final attempt leaves a row reserved at the bound: not claimable, not
-- sendable, not terminal, and not visible. That is the worst of the three
-- outcomes -- it looks live and behaves dead.
--
-- U02. `reserved` with no owner means a LIVE dispatcher's claim is
-- indistinguishable from a DEAD one's, so any recovery that treats age alone
-- as the signal will eventually steal a reservation from a slow-but-live send
-- and push the same warning twice. Ownership plus fencing is what makes
-- "stale" mean "abandoned" rather than "slow".
--
-- ===========================================================================
-- THE DESIGN
-- ===========================================================================
--
-- Three columns, one index, one trigger change, one recovery function.
--
-- `claim_token text`  the OWNER of the reservation: a per-process value
--   `claim:<uuid>`, so two dispatchers on one row are distinguishable and only
--   the holder can settle it. NULL means unclaimed.
--
-- `claim_at timestamptz`  WHEN the claim was taken. Staleness is a
--   comparison against the DATABASE clock, not the caller's, so a host with a
--   wrong clock cannot steal a live claim or pin a dead one forever.
--
-- `claim_expires_at timestamptz`  the DEADLINE of the claim: `claim_at` plus
--   the send bound. This is the fencing value. A live dispatcher renews it
--   around each send; a dispatcher that stops renewing has its claim taken over
--   by a later recovery. The takeover is a compare-and-set on the token, so a
--   dispatcher that comes back cannot settle a row whose claim was taken from
--   it -- it is refused, not silently credited.
--
-- WHY THE TOKEN AND NOT JUST AN INSTANT. An age comparison alone answers "is
-- this old?" and cannot answer "is this still MINE?". Two dispatchers can both
-- consider a 5-minute-old reservation stale, both re-claim it, and both send:
-- the second steal is invisible because the first's `finish()` would still
-- match on the id alone. With the token, the second steal changes the row and
-- the first dispatcher's settle matches zero rows -- measured, not assumed, by
-- the concurrency test in tests/updater-push-claims-postgres.test.ts.
--
-- WHY RECOVERY IS TERMINAL AT THE BOUND. A row that crashed on its last
-- attempt has no attempt left, and re-driving it would be a fresh push for a
-- warning the owner may already have received. So recovery at `attempts >=
-- 10` writes an explicit terminal outcome: `last_error_code =
-- 'updater_push_claim_expired'` and `sent_at = now()`. The row is then
-- excluded by `sent_at IS NULL` in every later query, so it can never be
-- claimed again, and it is VISIBLE: the code says the push was given up, and a
-- row that says so is answerable by an operator in one query. A row left
-- reserved forever is answerable by nobody.
--
-- WHY `sent_at` IS THE MARKER RATHER THAN A NEW COLUMN. `sent_at` is already
-- the table's only terminal flag, the schema CHECKs
-- `(sent_at IS NULL) OR attempts > 0`, and `guard_push_update` already refuses
-- any UPDATE of a row whose `sent_at` is set. So a failed delivery and an
-- abandoned claim share one honest representation: the attempt is spent, the
-- row is finished, and `last_error_code` distinguishes WHY. A second terminal
-- column would have needed a new CHECK, a new guard branch, and a new grant
-- story for no additional meaning.

ALTER TABLE updater.push_queue ADD COLUMN IF NOT EXISTS claim_token text;
ALTER TABLE updater.push_queue ADD COLUMN IF NOT EXISTS claim_at timestamptz;
ALTER TABLE updater.push_queue ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

-- A claim is a triple or nothing. A half-written claim (a token with no
-- deadline) would be exactly the "reserved forever" shape this file exists to
-- remove, so the constraint refuses it at the source rather than relying on the
-- writer to always set all three.
--
-- The token alphabet matches the `idempotency_key` shape: first character
-- lowercase, then the base64url alphabet with the four separators, so a token
-- can be a credential-scoped key and still cannot be mistaken for one.
ALTER TABLE updater.push_queue DROP CONSTRAINT IF EXISTS push_claim_shape;
ALTER TABLE updater.push_queue ADD CONSTRAINT push_claim_shape CHECK (
  (claim_token IS NULL AND claim_at IS NULL AND claim_expires_at IS NULL)
  OR (claim_token ~ '^claim:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND claim_at IS NOT NULL AND claim_expires_at IS NOT NULL
    AND claim_expires_at >= claim_at));

-- Recovery scans reserved rows by deadline, so the index is on the deadline
-- over the reserved state only. It is PARTIAL for the same reason 0224's is:
-- a full index over a queue that accumulates finished rows would grow without
-- bound for a scan that only ever looks at live claims.
CREATE INDEX IF NOT EXISTS push_queue_claim_due
  ON updater.push_queue(claim_expires_at, id)
  WHERE claim_token IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The claim is updater-only bookkeeping, like `attempts`.
-- ---------------------------------------------------------------------------
-- `guard_push_update` pins the content columns and admits changes to
-- `sent_at`, `attempts` and `last_error_code`. The three claim columns are the
-- same kind of value and are added to the same admission list, so a
-- compromised or buggy caller cannot re-point a live claim at a token it
-- invented, move a deadline into the past to make a live claim look abandoned,
-- or clear a token to bypass the fencing compare-and-set.
--
-- The move is done in a DO block for the reason the file above states: there is
-- no `ALTER FUNCTION ... OR REPLACE` that can add a trigger argument, but
-- `CREATE OR REPLACE FUNCTION` keeps the same identity, so replacing the body
-- is enough -- the trigger already points at it.
CREATE OR REPLACE FUNCTION updater.guard_push_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['sent_at','attempts','last_error_code','claim_token','claim_at','claim_expires_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['sent_at','attempts','last_error_code','claim_token','claim_at','claim_expires_at']) THEN
    RAISE EXCEPTION 'updater push content is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'updater push attempts refused: % -> %', OLD.attempts, NEW.attempts
      USING ERRCODE = '23514';
  END IF;
  IF OLD.sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'updater push already sent' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts > 10 THEN
    RAISE EXCEPTION 'updater push exceeded its retry budget' USING ERRCODE = '23514';
  END IF;
  -- THE CLAIM TRIPLE MOVES TOGETHER. Both directions are ordinary: acquiring a
  -- claim is NULL -> token, settling one is token -> NULL, and a recovery does
  -- either. So there is no single direction to forbid, and an earlier version
  -- that tried to refuse "the token's nullness changed" refused every claim and
  -- every settle alike (measured on the first real run: "updater push claim
  -- released without a token change" on the very first claim).
  --
  -- What IS refused is a PARTIAL move -- a token with no deadline, or a deadline
  -- with no token. That is `push_claim_shape`'s job and it is a column CHECK, so
  -- it holds whatever statement writes the row, and repeating it here would be a
  -- second copy of one rule rather than a second wall.
  --
  -- A claim may only change HANDS once, and only when it has EXPIRED.
  --
  -- This is the U02 property, stated as a rule on the row rather than trusted
  -- to the caller: a token that differs from the live one cannot be written
  -- while the live one is still within its deadline, so no second dispatcher
  -- can take a row from a first one that has not been abandoned. The takeover
  -- of an expired claim is allowed because that is not a steal -- it is the
  -- recovery, and it is the only path by which a row whose owner died becomes
  -- sendable again.
  --
  -- `claim_push` enforces the same condition in its WHERE clause, so this is
  -- redundancy with a different failure mode, not a second copy of one check:
  -- the WHERE clause is what makes a takeover a single atomic statement, and
  -- this is what refuses a takeover that arrives as anything other than
  -- `claim_push` or `recover_expired_push_claims`.
  IF OLD.claim_token IS NOT NULL AND NEW.claim_token IS NOT NULL
     AND NEW.claim_token <> OLD.claim_token
     AND OLD.claim_expires_at > pg_catalog.now() THEN
    RAISE EXCEPTION 'updater push live claim cannot be stolen' USING ERRCODE = '23514';
  END IF;
  -- A claim that is being RELEASED must not also be extended. A settle that
  -- cleared the token while pushing the deadline further out would leave a row
  -- the owner of which no longer claims it, and a later recovery would find a
  -- live deadline on a claim nobody holds -- the "reserved forever" shape this
  -- whole file exists to remove, reached from the other direction.
  IF OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL
     AND NEW.claim_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'updater push claim released with a live deadline' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_push_update() FROM PUBLIC;
DROP TRIGGER IF EXISTS push_queue_update_guard ON updater.push_queue;
CREATE OR REPLACE TRIGGER push_queue_update_guard BEFORE UPDATE ON updater.push_queue
  FOR EACH ROW EXECUTE FUNCTION updater.guard_push_update();

-- ---------------------------------------------------------------------------
-- Recovery: a claim whose deadline passed returns to the queue, or terminates.
-- ---------------------------------------------------------------------------
-- ONE FUNCTION, both outcomes, in one statement per row, because the decision
-- "retry or give up" is a property of the row and splitting it across two
-- callers is how the two could disagree about the same row.
--
-- The outcomes:
--
--   * `attempts < 10` -- the deadline passed and the row still has budget, so
--     the claim is RELEASED: the code and the triple go, `attempts` is NOT
--     decremented, and `next_attempt_at` is set to now so the very next tick
--     re-claims it. The attempt stays spent, which is the conservative
--     direction: it can only stop earlier, never later.
--
--   * `attempts >= 10` -- the deadline passed on the LAST attempt, so the row
--     is TERMINAL: `sent_at = now()` with
--     `last_error_code = 'updater_push_claim_expired'`. This is U03. It is a
--     real terminal state and not a deletion, because "we tried eight times and
--     a ninth claim was abandoned" is a fact an operator needs, and a row that
--     vanished or stayed reserved cannot answer it.
--
-- The signature returns the ids it changed, so a caller can log them and a
-- test can assert them without re-querying by predicate. `p_limit` is bounded
-- so a large abandoned queue cannot hold one statement open.
CREATE OR REPLACE FUNCTION updater.recover_expired_push_claims(p_limit integer DEFAULT 64)
RETURNS TABLE (id text, outcome text)
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE
  lost record;
  claimed integer;
  abandoned integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 512 THEN
    RAISE EXCEPTION 'updater push recovery limit refused' USING ERRCODE = '22023';
  END IF;
  -- The candidates are taken with `FOR UPDATE SKIP LOCKED` in a cursor and the
  -- decision is taken PER ROW in a loop, rather than as a set of sibling
  -- data-modifying CTEs. Both alternatives were tried against the real cluster
  -- and both are wrong in a way worth recording:
  --
  --   * Two sibling data-modifying CTEs cannot see each other's output: they
  --     share one snapshot, so the RETURN clause named relations that did not
  --     exist ("relation released does not exist", measured on the first real
  --     run). The result set was a fiction.
  --   * A TEMP TABLE holding the candidate set works, but it needs TEMP
  --     privilege on the database, which `control_room_deployer` deliberately
  --     does not hold -- holding database-level TEMP would make it a
  --     database-level principal, which is exactly what 0002's grant
  --     convergence refuses. Making recovery require a privilege the deployer
  --     must not have is not a design, it is a grant the owner would have to
  --     widen to make a warning deliverable.
  --
  -- A row-at-a-time loop in a plpgsql function with a pinned search_path needs
  -- no privilege beyond the function's own, and the lock is held for the whole
  -- row, so a concurrent recovery walks past it. The bound is `p_limit`, so the
  -- loop is bounded too.
  FOR lost IN
    SELECT q.id, q.attempts FROM updater.push_queue q
     WHERE q.sent_at IS NULL AND q.claim_token IS NOT NULL
       AND q.claim_expires_at <= pg_catalog.now()
     ORDER BY q.claim_expires_at, q.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    -- The budget is the whole decision, and it is read from the locked row
    -- rather than from the cursor: a claim that another transaction released
    -- between the cursor opening and this row's turn simply fails the
    -- `claim_token IS NOT NULL` test below and is skipped.
    IF lost.attempts < 10 THEN
      -- `last_error_code` goes with the claim, and that is load-bearing rather
      -- than tidiness: `pending()` excludes rows carrying
      -- 'updater_push_reserved', so a recovery that cleared only the claim
      -- columns would release the row into a state that is STILL invisible to
      -- selection. Measured on the first real run: the recovery reported
      -- 'released', the row's claim was gone, and `pending()` still did not
      -- offer it. The two are one fact and are written in one statement.
      UPDATE updater.push_queue q
         SET claim_token = NULL, claim_at = NULL, claim_expires_at = NULL,
             last_error_code = NULL
       WHERE q.id = lost.id AND q.claim_token IS NOT NULL AND q.attempts < 10;
      GET DIAGNOSTICS claimed = ROW_COUNT;
      IF claimed > 0 THEN id := lost.id; outcome := 'released'; END IF;
    ELSE
      UPDATE updater.push_queue q
         SET claim_token = NULL, claim_at = NULL, claim_expires_at = NULL,
             sent_at = pg_catalog.now(), last_error_code = 'updater_push_claim_expired'
       WHERE q.id = lost.id AND q.claim_token IS NOT NULL AND q.attempts >= 10 AND q.sent_at IS NULL;
      GET DIAGNOSTICS abandoned = ROW_COUNT;
      IF abandoned > 0 THEN id := lost.id; outcome := 'terminated'; END IF;
    END IF;
    IF outcome IS NOT NULL THEN RETURN NEXT; END IF;
    id := NULL; outcome := NULL;
  END LOOP;
  RETURN;
END;
$$;
REVOKE ALL ON FUNCTION updater.recover_expired_push_claims(integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Take a claim with its fencing token, atomically.
-- ---------------------------------------------------------------------------
-- This is the statement the store's `begin()` calls, and it is a function
-- rather than a bare UPDATE for one reason: the deadline must be computed from
-- the claim instant inside the SAME statement that writes the instant. Two
-- statements would leave a window in which a claim exists with no deadline, and
-- `push_claim_shape` refuses that window -- so two statements would deadlock
-- against their own constraint on a clock that moved.
--
-- The due-time check is INSIDE the function and not left to the caller: this is
-- the U06 claim-side half. A scheduled notice is not claimable before
-- `not_before`, whoever asks, and the check is the database's clock.
--
-- The attempt is spent in the same statement, so a claim is never held without
-- its cost having been paid, which is what makes the terminal rule in recovery
-- ("`attempts >= 10` means the budget is gone") true rather than approximate.
--
-- The previous claim is EXPIRED before the new one is written, and that is
-- allowed because this function is the one caller the guard admits as a
-- recovery decision.
CREATE OR REPLACE FUNCTION updater.claim_push(p_id text, p_claim_token text, p_hold_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE
  hold integer;
BEGIN
  IF p_id IS NULL OR p_id !~ '^push:[0-9a-f-]{36}$'
     OR p_claim_token IS NULL
     OR p_claim_token !~ '^claim:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p_hold_seconds IS NULL OR p_hold_seconds < 5 OR p_hold_seconds > 3600 THEN
    RAISE EXCEPTION 'updater push claim arguments refused' USING ERRCODE = '22023';
  END IF;
  hold := p_hold_seconds;
  -- The claim expires only if it is ALREADY expired, so a live claim cannot be
  -- taken over by a second dispatcher no matter how many callers try. An
  -- expired claim IS taken over, and that is the recovery path in the same
  -- statement: no window, no separate call, no second rule.
  --
  -- `attempts < 10` is the budget, and it is in the WHERE clause rather than in
  -- a separate branch, so a claim can never be taken on a row that has no
  -- attempt left: the terminal rule in recovery depends on exactly that.
  UPDATE updater.push_queue q
     SET attempts = q.attempts + 1,
         last_error_code = 'updater_push_reserved',
         claim_token = p_claim_token,
         claim_at = pg_catalog.now(),
         claim_expires_at = pg_catalog.now() + make_interval(secs => hold)
   WHERE q.id = p_id
     AND q.sent_at IS NULL
     AND q.attempts < 10
     AND (q.claim_token IS NULL OR q.claim_expires_at <= pg_catalog.now())
     AND (q.not_before IS NULL OR q.not_before <= pg_catalog.now());
  -- Zero rows matched means one of: the row is sent, it is at its attempt
  -- bound, a LIVE dispatcher holds the claim, or it is not yet due. All four
  -- are ordinary outcomes for the caller -- `pending()` and the sender both
  -- treat "not claimable" as a skip -- so a refusal is a returned false rather
  -- than an exception. `FOUND` is set by the UPDATE and is the honest answer.
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION updater.claim_push(text, text, integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Renew a claim the caller still holds.
-- ---------------------------------------------------------------------------
-- A multi-phone fan-out is N round trips, so the claim deadline has to cover
-- the whole attempt rather than one send: renewing is what separates "slow"
-- from "abandoned" for a dispatcher that is genuinely still working. The
-- compare-and-set is on the token, so a renew after a takeover updates zero
-- rows and the caller learns it no longer owns the row instead of extending
-- someone else's deadline.
CREATE OR REPLACE FUNCTION updater.renew_push_claim(p_id text, p_claim_token text, p_hold_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE
  hold integer;
BEGIN
  IF p_id IS NULL OR p_id !~ '^push:[0-9a-f-]{36}$'
     OR p_claim_token IS NULL
     OR p_claim_token !~ '^claim:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p_hold_seconds IS NULL OR p_hold_seconds < 5 OR p_hold_seconds > 3600 THEN
    RAISE EXCEPTION 'updater push claim arguments refused' USING ERRCODE = '22023';
  END IF;
  hold := p_hold_seconds;
  UPDATE updater.push_queue q
     SET claim_expires_at = pg_catalog.now() + make_interval(secs => hold)
   WHERE q.id = p_id
     AND q.sent_at IS NULL
     AND q.claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION updater.renew_push_claim(text, text, integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Settle a claim the caller still holds.
-- ---------------------------------------------------------------------------
-- The token is in the WHERE clause, so the fencing is the SET itself: a
-- dispatcher whose claim was taken over updates zero rows, and the store
-- returns false rather than letting that process report a delivery for a row
-- another process is now sending.
--
-- Clearing the claim triple in the same statement as the settlement is what
-- keeps the two facts together. A settle that left the claim behind would put
-- the row in a state no later query can claim (sent_at set) while recovery
-- still believed a claim was live on it.
CREATE OR REPLACE FUNCTION updater.settle_push_claim(p_id text, p_claim_token text, p_sent boolean, p_error_code text)
RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF p_id IS NULL OR p_id !~ '^push:[0-9a-f-]{36}$'
     OR p_claim_token IS NULL
     OR p_claim_token !~ '^claim:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p_sent IS NULL
     OR p_error_code IS NOT NULL
      AND (p_error_code !~ '^[a-z][a-z0-9_]{1,63}$') THEN
    RAISE EXCEPTION 'updater push settle arguments refused' USING ERRCODE = '22023';
  END IF;
  UPDATE updater.push_queue q
     SET sent_at = CASE WHEN p_sent THEN pg_catalog.now() ELSE NULL END,
         last_error_code = p_error_code,
         claim_token = NULL, claim_at = NULL, claim_expires_at = NULL
   WHERE q.id = p_id
     AND q.sent_at IS NULL
     AND q.claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION updater.settle_push_claim(text, text, boolean, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The `not_before` guard gains its schedule check.
-- ---------------------------------------------------------------------------
-- The existing `guard_push_schedule` refuses a `not_before` that precedes its
-- queue time and a row sent before it was due. Both stay. What is added is the
-- claim-side check that the store and this schema now share: a row may not be
-- RESERVED before it is due, only sent. Without it, the column check is about
-- the timestamps on the row and says nothing about the instant the claim was
-- taken, so a caller that wrote `not_before` correctly and then claimed the row
-- early would satisfy every existing guard.
--
-- `NEW.attempts > OLD.attempts` is the claim's own signal (only `claim_push`
-- increments it, and only in the same statement that takes the token), so the
-- check fires on the claim and not on every bookkeeping update.
CREATE OR REPLACE FUNCTION updater.guard_push_schedule() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.not_before IS NOT NULL AND NEW.not_before < NEW.queued_at THEN
    RAISE EXCEPTION 'updater push not_before precedes its queue time' USING ERRCODE = '23514';
  END IF;
  IF NEW.sent_at IS NOT NULL AND NEW.not_before IS NOT NULL AND NEW.sent_at < NEW.not_before THEN
    RAISE EXCEPTION 'updater push was sent before it was due' USING ERRCODE = '23514';
  END IF;
  -- The claim-side check is on the CLAIM, not on the attempt counter. An
  -- earlier version gated it on `NEW.attempts > OLD.attempts`, reasoning that
  -- only `claim_push` increments attempts and so only it can take a claim. That
  -- is true of the function and false of the TABLE: a direct UPDATE can write a
  -- claim without touching attempts, so the guard stood down for exactly the
  -- writer it was meant to catch (measured -- the assertion it was written for
  -- did not fire). A row may therefore not hold a claim taken before its due
  -- time, whoever wrote it, and the check is stated on the claim itself.
  IF NEW.claim_at IS NOT NULL AND NEW.not_before IS NOT NULL AND NEW.claim_at < NEW.not_before THEN
    RAISE EXCEPTION 'updater push was claimed before it was due' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_push_schedule() FROM PUBLIC;
DROP TRIGGER IF EXISTS push_queue_schedule_guard ON updater.push_queue;
CREATE OR REPLACE TRIGGER push_queue_schedule_guard BEFORE UPDATE ON updater.push_queue
  FOR EACH ROW EXECUTE FUNCTION updater.guard_push_schedule();
