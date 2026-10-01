-- The updater schema's guards: the rules a grant alone cannot express.
--
-- Applied by the updater's fixed DDL, like 0002_schema.sql, and owned by the
-- deployer login. Every function below:
--
--   * is SECURITY DEFINER, so it runs as the table's owner and can read the
--     release-schema tables it needs to check an owner session against, which
--     the web login cannot see from here;
--   * pins `search_path = pg_catalog, updater, pg_temp` (R10b), so a schema an
--     attacker can write to cannot shadow a name the body resolves;
--   * schema-qualifies every object, for the same reason;
--   * is REVOKEd from PUBLIC, so the only way to invoke one is as the owner.
--
-- Each guard is written to fail CLOSED: a condition it cannot evaluate raises
-- rather than returning a row that would let the insert through. A guard that
-- cannot run must not read as a guard that passed.

-- ---------------------------------------------------------------------------
-- reject_append_only_mutation — the repository's existing append-only refusal
-- ---------------------------------------------------------------------------
-- Schema `updater` cannot use `public.reject_append_only_mutation()` without
-- giving every trigger in this schema a dependency on a release-schema object
-- the migrator owns. §9.3 step 4 restores schema `updater` with `--no-owner`
-- and `--exclude-schema=updater`, so a function that lived only in `public`
-- would be missing at exactly the moment the guards are needed most. The
-- updater's fixed DDL therefore carries its own copy, and the database digest
-- for the release schema is unaffected by it living here.
CREATE OR REPLACE FUNCTION updater.reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'updater table % is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION updater.reject_append_only_mutation() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The owner session a web-inserted row must carry
-- ---------------------------------------------------------------------------
-- R16: approval and registration rows need the owner session. §5.4: a stolen
-- owner cookie can view, Pause, Stop, back up and check-and-continue, and
-- cannot install or roll back, because those need a passkey; what the session
-- adds here is the requirement that SOME live owner session made the request.
--
-- WHAT THE DEPLOYER MAY READ, AND WHY IT IS EXACTLY THIS MUCH. The function
-- below is SECURITY DEFINER, so it runs as its owner — the deployer — and it
-- checks the owner session against `public.control_web_sessions`,
-- `public.control_identities` and `public.control_role_grants`. Those are the
-- three canonical tables that say "this is a live human owner with a live
-- tenant-wide grant", and the deployer is granted SELECT on them for exactly
-- this purpose.
--
-- That grant is the whole reason this design does not use a table-wide "the web
-- may insert if it holds any session" rule: the check has to read something the
-- web login cannot forge, and the session row is the one thing the owner holds
-- that no other login can create. It is SELECT only. The deployer cannot insert,
-- update or delete a session, cannot read any other release table, and cannot
-- reach anything the owner session is not: no plan, no candidate, no review, no
-- task. If the deployer role is ever compromised, what it gains here is the
-- ability to ASK whether a given token digest is a live owner session — which is
-- not an authority, because the answer is a boolean about a digest it would
-- already have to possess.
--
-- The two-shape rule the existing migrations use (`is_work_intake_session`)
-- applies: the function is STABLE, has one argument, is not leakproof, has
-- `parallel` unsafe, and its search_path is pinned, so a later preflight can
-- pin its exact identity rather than trusting this comment.
-- The one read of the release schema the deployer holds
-- --------------------------------------------------
-- `owner_session_is_live` is SECURITY DEFINER and owned by the deployer, so it
-- needs SELECT on the three tables it checks. This is the deployer's ENTIRE
-- reach into schema `public`, and it is three read-only tables that say who the
-- owner is.
--
-- THE GRANT CANNOT BE MADE HERE, and the reason is the whole reason this file
-- runs as the deployer rather than as the installer. `control_web_sessions` is
-- owned by `control_room_schema_owner` — the release migrator. A GRANT is made
-- by the object's owner or by a role with grant authority, so the deployer
-- cannot grant itself SELECT on a table it does not own: PostgreSQL refuses with
-- "permission denied for column tenant_id of relation control_web_sessions"
-- (measured, not assumed). Making the grant from the installer's half instead
-- would be worse: the installer holds SCHEMA-OWNER authority over the release
-- schema, so a grant issued there is a grant the release side made, which is
-- exactly the coupling R10 removes.
--
-- So the three grants are issued by the MIGRATOR, from the release ledger's own
-- side, in `db/roles/updater_release_reader_roles.sql` — a reviewed, idempotent
-- role file in the place every other release-schema grant in this repository
-- lives, so it is applied by the installer and the live upgrade, and its exact
-- text is asserted by the existing role-manifest and preflight tests. It grants
-- SELECT on three tables to a role the release path must never manage (see
-- 0001_deployer_role.sql), and the updater's loader asserts on every start that
-- the deployer's reach into `public` is EXACTLY those three tables — so this
-- grant is both granted and bounded, and a fourth table would fail the updater
-- at startup rather than sit unnoticed.
--
-- What the deployer gains is the ability to ask, for a token digest it already
-- holds, whether that digest is a live owner session. That is a boolean, not an
-- authority: it cannot create, extend, revoke or steal a session, and it cannot
-- read any other release table.

CREATE OR REPLACE FUNCTION updater.owner_session_is_live(session_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, updater, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.control_web_sessions s
    JOIN public.control_identities i
      ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
    JOIN public.control_role_grants g
      ON g.tenant_id = i.tenant_id AND g.identity_id = i.id
    WHERE s.token_digest = session_digest
      AND s.revoked_at IS NULL
      AND s.expires_at > pg_catalog.now()
      AND i.actor_type = 'human'
      AND i.state = 'active'
      AND g.role_key = 'owner'
      AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at > pg_catalog.now())
      AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'updates.decide')
      AND g.project_ids ? '*'
  )
$$;
REVOKE ALL ON FUNCTION updater.owner_session_is_live(text) FROM PUBLIC;
COMMENT ON FUNCTION updater.owner_session_is_live(text) IS
  'True when the token digest names a live, unrevoked owner web session. The only'
  ' read of the release schema the deployer role holds, and it is not callable by anyone.';

-- A session digest that is not even shaped like one is refused before the
-- lookup, so the function's one input cannot become a probe.
--
-- The trigger function is ITSELF SECURITY DEFINER. That is not decoration: the
-- inner `owner_session_is_live` is revoked from PUBLIC, so a plain (invoker)
-- trigger body would execute it as the INSERTING role — the web login — and
-- every insert would be refused with "permission denied for function", which is
-- what a first run of this DDL actually did. The trigger's own EXECUTE is
-- likewise not needed by anyone, because a trigger fires by name and not by
-- permission; the revoke on it is kept for the same reason it is on the other
-- functions, so the only way in is as the table's owner.
CREATE OR REPLACE FUNCTION updater.guard_owner_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.owner_session_digest !~ '^sha256:[a-f0-9]{64}$'
    OR NOT updater.owner_session_is_live(NEW.owner_session_digest) THEN
    RAISE EXCEPTION 'updater row needs a live owner session' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_owner_session() FROM PUBLIC;

CREATE OR REPLACE TRIGGER plan_approvals_owner_session
  BEFORE INSERT ON updater.plan_approvals
  FOR EACH ROW EXECUTE FUNCTION updater.guard_owner_session();
CREATE OR REPLACE TRIGGER passkey_registrations_owner_session
  BEFORE INSERT ON updater.passkey_registrations
  FOR EACH ROW EXECUTE FUNCTION updater.guard_owner_session();
CREATE OR REPLACE TRIGGER owner_requests_owner_session
  BEFORE INSERT ON updater.owner_requests
  FOR EACH ROW EXECUTE FUNCTION updater.guard_owner_session();

-- ---------------------------------------------------------------------------
-- A registration row is only accepted for a registration the updater opened
-- ---------------------------------------------------------------------------
-- P-1's fourth clause, and it is the guard the one-row rule rests on. R is a
-- 32-byte secret the installer holds as a digest; the web is handed it in a URL
-- fragment and can insert anything it likes. Without this check a page on
-- another port, or a loopback bot that saw the fragment, could insert a
-- registration for a digest the installer never issued, and the installer's
-- one-row rule would then be counting rows nobody authorised. Three refusals:
--
--   * UNKNOWN: there is no `passkey_open_registrations` row with this digest.
--     The updater writes that table from its own ledger, so "the updater never
--     opened this" is a fact the database can see and the web cannot fake.
--   * CONSUMED: the updater already finished with this registration (used or
--     refused). Stated by name so a late insert is refused for the reason it
--     actually failed, rather than looking like an expiry race.
--   * EXPIRED: past `expires_at` at the DATABASE clock. Thirty minutes (§5.1).
--
-- And a cap: at most MAX_REGISTRATION_ROWS_V1 rows per digest. Four is enough to
-- make every racer visible — the installer's rule is "exactly one", so two rows
-- already refuses — and small enough that a flood of 10 000 junk inserts against
-- one open digest is refused by the fourth rather than filling a table.
CREATE TABLE IF NOT EXISTS updater.passkey_registrations_limits (
  max_rows_per_registration integer NOT NULL CHECK (max_rows_per_registration BETWEEN 1 AND 8),
  PRIMARY KEY (max_rows_per_registration)
);
-- One row, written by the updater at apply time. A table rather than a literal in
-- the body because a limit an operator cannot see is a limit nobody reviews; the
-- INSERT below is the updater's, so the web has no path to it (it holds no
-- INSERT here).
INSERT INTO updater.passkey_registrations_limits (max_rows_per_registration) VALUES (4)
  ON CONFLICT DO NOTHING;

-- SECURITY DEFINER IS LOAD-BEARING HERE, and for the same reason it is on
-- `guard_owner_session` above: this trigger fires for the WEB login, which
-- holds only five columns of `passkey_open_registrations` and none of
-- `passkey_registrations_limits`. A plain invoker body would run the SELECT as
-- the web and fail with `permission denied for table passkey_open_registrations`
-- — so every web insert would be refused and the feature would look like a
-- permissions problem rather than a missing `SECURITY DEFINER`. Measured, not
-- assumed: that is the first run of this DDL.
--
-- What the definer body gains is the ability to ASK whether a digest is open, an
-- unexpired and under the cap. It cannot open one, extend one or mark one
-- consumed, and the web cannot call it: the only caller is this trigger, which
-- fires by name and not by permission.
--
-- THE ADVISORY LOCK IS THE CAP'S ACTUAL MECHANISM, and without it the cap does
-- not work at all. A BEFORE INSERT trigger that SELECTs a count and compares it
-- to a limit is a read-then-write with nothing in between, so fifty racers each
-- observe "zero rows" and all fifty land. That is exactly what the first real-PG
-- run of this lane measured: 50 concurrent registrations produced 50 rows and the
-- cap of 4 was never once consulted, because every one of those transactions ran
-- its SELECT before any of them committed.
--
-- `pg_advisory_xact_lock` is transaction-scoped, so it serialises the racers on
-- the digest and each one counts what the previous one committed. The lock is
-- keyed on a HASH of the digest, so two unrelated registrations do not queue
-- behind each other, and it is taken in the same order the guard then reads, so
-- there is no window between "I have the lock" and "I have counted".
--
-- This is the same discipline the one-open-plan rule in 0003 uses, and for the
-- same reason: a count a caller could interleave with is not a bound.
CREATE OR REPLACE FUNCTION updater.guard_passkey_registration_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE
  open_consumed_at timestamptz;
  open_expires_at timestamptz;
  existing_rows integer;
  cap integer;
BEGIN
  -- The advisory lock below serialises the racers, but a serialised racer only
  -- counts what the previous one committed if its SNAPSHOT is taken after the
  -- lock — which is READ COMMITTED's per-statement snapshot. Under REPEATABLE
  -- READ (or SERIALIZABLE) the snapshot is fixed at the transaction's first
  -- statement, so every racer that began before the others committed counts the
  -- same stale number and all of them land: 20 racers put 20 rows past a cap of
  -- 4 (review passkey2 DB-2). The web login chooses its own isolation level, so
  -- the cap refuses to be evaluated anywhere it cannot hold, the same way the
  -- fleet claim-capacity guard (0234) does. 0A000 is a feature class: the insert
  -- is unsupported in that mode, not retryable in it.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'updater registration row cap cannot be enforced in a % transaction',
      pg_catalog.current_setting('transaction_isolation') USING ERRCODE = '0A000';
  END IF;
  -- Only the two columns the guard actually needs, and no `SELECT *`: a definer
  -- body that read a column it did not need would be reading as the deployer, and
  -- the narrower the read the smaller that is. (`mode` was selected here once and
  -- never consulted — a dead read in a SECURITY DEFINER body is still a read, so
  -- it is gone rather than left as a hint that `mode` matters here.)
  SELECT o.consumed_at, o.expires_at INTO open_consumed_at, open_expires_at
    FROM updater.passkey_open_registrations o WHERE o.registration_digest = NEW.registration_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'updater registration digest is not open' USING ERRCODE = '42501';
  END IF;
  IF open_consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'updater registration was already consumed at %', open_consumed_at
      USING ERRCODE = '42501';
  END IF;
  IF open_expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'updater registration expired at %', open_expires_at USING ERRCODE = '42501';
  END IF;
  -- The cap comes from a row rather than a literal, so it is visible and
  -- reviewable. A missing row would make the comparison NULL, and NULL is not
  -- TRUE, so the guard would refuse every insert — which is the safe direction
  -- for a limit that cannot be read.
  SELECT l.max_rows_per_registration INTO cap FROM updater.passkey_registrations_limits l LIMIT 1;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('updater:registration-rows:' || NEW.registration_digest, 0));
  SELECT count(*)::integer INTO existing_rows FROM updater.passkey_registrations r
    WHERE r.registration_digest = NEW.registration_digest;
  IF existing_rows >= COALESCE(cap, 1) THEN
    RAISE EXCEPTION 'updater registration already has % rows', existing_rows USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_passkey_registration_open() FROM PUBLIC;
CREATE OR REPLACE TRIGGER passkey_registrations_open_guard BEFORE INSERT ON updater.passkey_registrations
  FOR EACH ROW EXECUTE FUNCTION updater.guard_passkey_registration_open();

-- ---------------------------------------------------------------------------
-- What the updater may change about an open registration
-- ---------------------------------------------------------------------------
-- `passkey_open_registrations` is the updater's own table: it inserts the row and
-- sets `consumed_at`, and nothing else. The mode, the options object, the
-- add-challenge and the expiry are what the web will be shown, so a change to any
-- of them after the row exists is a change to what the owner is asked to approve
-- — and only the updater's ledger may decide that. Deleting the row is refused
-- outright, because the consumed marker is what makes a late web insert fail by
-- name; a deleted row would make it look merely expired.
CREATE OR REPLACE FUNCTION updater.guard_open_registration() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'updater open registrations are not deletable' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['consumed_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['consumed_at']) THEN
    RAISE EXCEPTION 'updater open registration content is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'updater open registration was already consumed' USING ERRCODE = '23514';
  END IF;
  IF NEW.consumed_at IS NULL OR NEW.consumed_at < OLD.created_at THEN
    RAISE EXCEPTION 'updater open registration must be consumed with a timestamp' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_open_registration() FROM PUBLIC;
CREATE OR REPLACE TRIGGER passkey_open_registrations_update_guard BEFORE UPDATE OR DELETE
  ON updater.passkey_open_registrations FOR EACH ROW EXECUTE FUNCTION updater.guard_open_registration();

-- ---------------------------------------------------------------------------
-- The per-plan-per-hour refusal aggregate (R16, P-3, P-4)
-- ---------------------------------------------------------------------------
-- `record_approval_refusal` is the whole of P-3 in one statement, and the reason
-- it is a function rather than two queries the caller runs in sequence is that
-- the answer the caller needs — the new count, and whether this refusal was the
-- first of its hour — is only computable atomically.
--
-- HOW THE ATOMICITY IS OBTAINED. Two statements, in one function, inside the
-- caller's transaction, and the second one is a plain `INSERT ... ON CONFLICT DO
-- UPDATE ... RETURNING`:
--
--   1. `INSERT INTO updater.approval_refusals ... ON CONFLICT (approval_id) DO
--      NOTHING RETURNING approval_id`. The RETURNING clause reports a row ONLY
--      when this transaction was the one that claimed the approval id. So a
--      replayed approval — a retried NOTIFY, a re-read of the queue — returns no
--      row, does not bump the bucket, and does not re-earn `first_in_hour`. That
--      is P-3's idempotency clause, enforced by a primary key rather than by a
--      read-then-write a caller could interleave.
--   2. `INSERT INTO updater.approval_refusal_buckets ... ON CONFLICT (plan_id,
--      bucket_start) DO UPDATE SET count = count + 1, last_approval_id = EXCLUDED
--      .last_approval_id RETURNING count, first_in_hour, (xmax = 0) AS first_in_hour_claimed`.
--
-- Under 50 concurrent callers on one plan-hour, PostgreSQL's ON CONFLICT makes
-- exactly one of the 50 inserts create the row; the other 49 wait for that
-- transaction and then UPDATE it. `first_in_hour` is the INSERT's own
-- `approval_id`, so it is set once, by the winner, and the `(xmax = 0)` test is
-- reported as well so the caller can check which of the two it was — which is
-- how "exactly one firstInHour per plan-hour" is proved rather than assumed.
--
-- The bucket is `date_trunc('hour', now())`: the DATABASE's clock, so an updater
-- whose own clock is skewed or moving backwards cannot open a second bucket for
-- an hour that already has one. The caller's `observed_at` is recorded but never
-- used to choose the bucket.
--
-- `first_in_hour` here means "this call was the first of its hour". It is NOT the
-- same as "this alert still needs sending": the delivery columns below are the
-- durable half, and they are separate so that a journal or push sink that failed
-- after this statement committed is re-driven rather than lost.
-- `RETURNS TABLE (count integer, first_in_hour boolean, bucket_start timestamptz)`
-- creates OUT parameters with those names, and they are IN SCOPE inside the body
-- — so a bare `bucket_start` in the INSERT's value list, in the ON CONFLICT
-- inference clause or in the RETURNING resolves to the OUT parameter and
-- PostgreSQL refuses with 42702 ("column reference bucket_start is ambiguous").
--
-- Two fixes were needed and one was not enough, which is why this is written
-- down: the INSERT and the RETURNING take a table alias (`AS b`), and the
-- conflict target is named by CONSTRAINT rather than by an `(plan_id,
-- bucket_start)` column list — an inference list has no alias to qualify it
-- with, so naming the constraint is the only way to express "the primary key"
-- from inside a function whose parameters are named after the key's columns.
-- Measured, not assumed: the first two real-PG runs failed with 42702 and only
-- the third, with both fixes, applied cleanly.
--
-- On `xmax = 0`: an INSERT that did not collide has `xmax = 0`, and an INSERT
-- that took the DO UPDATE path has the updating transaction's xid there. That is
-- how the caller learns whether it was the first of the hour, and it is a
-- property of the row PostgreSQL just wrote rather than a read anybody could
-- interleave with.
CREATE OR REPLACE FUNCTION updater.record_approval_refusal(p_approval_id text, p_plan_id text, p_reason text)
RETURNS TABLE (count integer, first_in_hour boolean, bucket_start timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE
  claimed boolean;
  bucket timestamptz;
BEGIN
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'updater refusal refused under session_replication_role=%',
      current_setting('session_replication_role') USING ERRCODE = '42501';
  END IF;
  bucket := pg_catalog.date_trunc('hour', pg_catalog.now());
  INSERT INTO updater.approval_refusals (approval_id, plan_id, reason, bucket_start)
    VALUES (p_approval_id, p_plan_id, p_reason, bucket)
    ON CONFLICT (approval_id) DO NOTHING
    RETURNING TRUE INTO claimed;
  IF claimed IS NULL THEN
    RAISE EXCEPTION 'updater refusal is not an approval' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    INSERT INTO updater.approval_refusal_buckets AS b (plan_id, bucket_start, count, first_in_hour, last_approval_id)
      VALUES (p_plan_id, bucket, 1, p_approval_id, p_approval_id)
      ON CONFLICT ON CONSTRAINT approval_refusal_buckets_pkey DO UPDATE
        SET count = b.count + 1,
            last_approval_id = EXCLUDED.last_approval_id
      RETURNING b.count, (b.xmax = 0), b.bucket_start;
END;
$$;
REVOKE ALL ON FUNCTION updater.record_approval_refusal(text, text, text) FROM PUBLIC;

-- The refusal rows are evidence that a decision was made, so they are
-- append-only like every other evidence table. The BUCKETS are different: their
-- count and their delivery timestamps are the updater's own bookkeeping and must
-- move, so they are guarded rather than frozen — the count may only rise by one,
-- the identity of the bucket may not change, and a delivered bucket may not
-- become undelivered.
CREATE OR REPLACE TRIGGER approval_refusals_immutable BEFORE UPDATE OR DELETE
  ON updater.approval_refusals FOR EACH ROW EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER approval_refusals_no_truncate BEFORE TRUNCATE ON updater.approval_refusals
  FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER approval_refusal_buckets_no_truncate BEFORE TRUNCATE
  ON updater.approval_refusal_buckets FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();

CREATE OR REPLACE FUNCTION updater.guard_refusal_bucket() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['count','last_approval_id','journaled_at','pushed_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['count','last_approval_id','journaled_at','pushed_at']) THEN
    RAISE EXCEPTION 'updater refusal bucket identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.count <> OLD.count AND NEW.count <> OLD.count + 1 THEN
    RAISE EXCEPTION 'updater refusal count refused: % -> %', OLD.count, NEW.count USING ERRCODE = '23514';
  END IF;
  -- Delivery is one-way. A bucket that was journaled cannot become un-journaled,
  -- or a re-drive that failed halfway could put the same hour back in the queue
  -- and the owner would see the same line twice.
  IF (OLD.journaled_at IS NOT NULL AND NEW.journaled_at IS NULL)
     OR (OLD.pushed_at IS NOT NULL AND NEW.pushed_at IS NULL) THEN
    RAISE EXCEPTION 'updater refusal delivery cannot be undone' USING ERRCODE = '23514';
  END IF;
  IF NEW.journaled_at IS NOT NULL AND NEW.journaled_at < NEW.bucket_start THEN
    RAISE EXCEPTION 'updater refusal journaled before the bucket began' USING ERRCODE = '23514';
  END IF;
  IF NEW.pushed_at IS NOT NULL AND NEW.pushed_at < NEW.bucket_start THEN
    RAISE EXCEPTION 'updater refusal pushed before the bucket began' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_refusal_bucket() FROM PUBLIC;
CREATE OR REPLACE TRIGGER approval_refusal_buckets_update_guard BEFORE UPDATE
  ON updater.approval_refusal_buckets FOR EACH ROW EXECUTE FUNCTION updater.guard_refusal_bucket();

-- ---------------------------------------------------------------------------
-- One open plan at a time (design §5.5, SI-24)
-- ---------------------------------------------------------------------------
-- A newer candidate supersedes the older plan, and there is never more than one
-- plan awaiting the owner's Face ID. A partial unique index cannot express
-- "open" across a five-value state set with a superseded exception, so the
-- rule is a trigger plus the CHECK on the row itself.
--
-- The advisory lock is transaction-scoped, so two concurrent inserts serialise
-- here rather than both observing zero open plans. It is the same lock the run
-- claim takes, which means "insert an approval's plan" and "claim a run" cannot
-- interleave either.
CREATE OR REPLACE FUNCTION updater.guard_plan_open() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.state NOT IN ('building','ready_for_approval','approved','approval_required') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('updater:open-plan', 0));
  IF EXISTS (SELECT 1 FROM updater.plans p
      WHERE p.plan_id <> NEW.plan_id
        AND p.state IN ('building','ready_for_approval','approved','approval_required')) THEN
    RAISE EXCEPTION 'updater already has an open plan (% )', (
      SELECT p.plan_id FROM updater.plans p
      WHERE p.plan_id <> NEW.plan_id
        AND p.state IN ('building','ready_for_approval','approved','approval_required')
      ORDER BY p.created_at, p.plan_id LIMIT 1)
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_plan_open() FROM PUBLIC;
CREATE OR REPLACE TRIGGER plans_open_guard BEFORE INSERT OR UPDATE ON updater.plans
  FOR EACH ROW EXECUTE FUNCTION updater.guard_plan_open();

-- The same rule on UPDATE, spelled out rather than relying on the trigger's
-- INSERT path: an UPDATE that turns a closed plan into an open one must be
-- refused too, or the rule is bypassable by inserting a closed plan and
-- updating it open. The trigger above is BEFORE INSERT OR UPDATE, so it covers
-- both; this comment records that the coverage is deliberate rather than an
-- oversight, and `plans_superseded_only_when_named` covers the reverse.

-- ---------------------------------------------------------------------------
-- A plan's state may only move forward along §8.1
-- ---------------------------------------------------------------------------
-- plan:  building -> ready_for_approval -> approved -> (run)
--        | approval_required (expired) | refused_build | superseded | done
-- An expired `ready_for_approval` becomes `approval_required`, which is what
-- makes the phone show "Approve again" — and "Approve again" mints a NEW plan
-- with a new nonce (§5.3), so this transition never re-opens the same plan for a
-- signature.
CREATE OR REPLACE FUNCTION updater.guard_plan_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.state = 'building' AND NEW.state IN ('ready_for_approval','refused_build','superseded')) OR
    (OLD.state = 'ready_for_approval' AND NEW.state IN ('approved','approval_required','superseded','refused_build')) OR
    (OLD.state = 'approval_required' AND NEW.state IN ('superseded','refused_build')) OR
    (OLD.state = 'approved' AND NEW.state IN ('done','superseded','refused_build')) OR
    (OLD.state = 'superseded' AND NEW.state = 'done')
  ) THEN
    RAISE EXCEPTION 'updater plan transition refused: % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  -- Only a plan that is actually open can be superseded, and only by naming its
  -- successor: a plan row that is closed is not competing for the owner's Face
  -- ID, so "superseded" would be a lie the web would render.
  IF NEW.state = 'superseded' AND (NEW.superseded_by_plan_id IS NULL OR OLD.state = 'superseded') THEN
    RAISE EXCEPTION 'updater plan supersession refused' USING ERRCODE = '23514';
  END IF;
  -- An approved plan cannot expire backwards into approval_required: expiry is
  -- only a reason to ask again before the owner has approved anything.
  IF OLD.state = 'approved' AND NEW.state = 'approval_required' THEN
    RAISE EXCEPTION 'updater approved plan cannot return to approval_required' USING ERRCODE = '23514';
  END IF;
  -- B2's second half. A plan with a LIVE run is not competing for the owner's
  -- Face ID — it is the thing an update is already being executed from — so it
  -- may not be superseded. Without this, a newer commit landing while an update
  -- was mid-flight moved the plan out from under its own run, and the run's next
  -- step was refused (the plan was no longer `approved`). At `switched` that left
  -- the new code live with no health check and no rollback: the exact wedge §8.5
  -- exists to prevent.
  --
  -- `finished_at IS NULL` rather than a state list, because "live" is already one
  -- database property (`runs_one_live` is a partial unique index on exactly this
  -- predicate). Deriving it from a list of states would add a second definition
  -- of liveness that could disagree with the index. A TERMINAL run does not
  -- block: once a run has finished, the newer plan may supersede freely.
  IF NEW.state = 'superseded' AND EXISTS (
      SELECT 1 FROM updater.runs r WHERE r.plan_id = OLD.plan_id AND r.finished_at IS NULL) THEN
    RAISE EXCEPTION 'updater plan cannot be superseded while its run is live' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_plan_transition() FROM PUBLIC;
CREATE OR REPLACE TRIGGER plans_transition_guard BEFORE UPDATE ON updater.plans
  FOR EACH ROW EXECUTE FUNCTION updater.guard_plan_transition();

-- The immutable part of a plan. Once the owner has seen it, nothing about WHAT
-- it says may change: only the state, the supersession pointer and the expiry
-- bookkeeping move. A row whose plan_json or digest changed after approval is a
-- different plan, and a different plan needs its own Face ID.
CREATE OR REPLACE FUNCTION updater.guard_plan_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state','superseded_by_plan_id']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state','superseded_by_plan_id']) THEN
    RAISE EXCEPTION 'updater plan content is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_plan_immutable() FROM PUBLIC;
CREATE OR REPLACE TRIGGER plans_immutable_guard BEFORE UPDATE ON updater.plans
  FOR EACH ROW EXECUTE FUNCTION updater.guard_plan_immutable();

-- ---------------------------------------------------------------------------
-- The run lease (design §7.2, SI-06)
-- ---------------------------------------------------------------------------
-- launchd runs at most one updater, and the only other actor that changes links
-- is guard.sh, which boots the updater out first. The lease is belt-and-braces:
-- `acquire()` returns an active run only with a matching boot id, or when the
-- previous holder's PG session is gone. The `runs_one_live` partial unique index
-- already refuses a second live run outright; what this trigger adds is that the
-- LEASE TOKEN of a live run cannot be changed under it, so a second process
-- cannot inherit an active run by rewriting one column.
CREATE OR REPLACE FUNCTION updater.guard_run_lease() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  -- The lease check applies to UPDATE only. On INSERT there is no old row, and
  -- reading `OLD` in a trigger body for an INSERT yields NULLs, which made
  -- `OLD.finished_at IS NULL` true — so an INSERT was wrongly treated as a live
  -- run trying to hand its lease to somebody else, and the plan check below
  -- never ran. The two statements are kept separate so each has one subject:
  -- TG_OP names the operation, and a guard that infers the operation from a
  -- NULL column is a guard that guesses.
  IF TG_OP = 'UPDATE' AND OLD.finished_at IS NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
    RAISE EXCEPTION 'updater run lease cannot be reassigned while live' USING ERRCODE = '42501';
  END IF;
  -- A plan that has been approved may be run once. A run row for a plan that is
  -- not approved is a run nobody authorised.
  --
  -- ON INSERT ONLY, and this is B2's first half rather than a convenience. The
  -- check answered "is this run authorised?", and an approval is a moment, not a
  -- property: the run row it authorises is created once and then walks a run of
  -- states that can outlast both the plan's 72-hour expiry and the plan itself
  -- being superseded by a newer release. Re-asking on every UPDATE made the
  -- answer change under a run that was already in flight, and the failure mode
  -- was the worst kind: at `switched` the new code was already live, so refusing
  -- `restarted` left no health check, and refusing `rollback_started` left no way
  -- back. A newer commit landing mid-run, or the deadline passing during a pause,
  -- could strand Control Room on the new version permanently.
  --
  -- What the check is still load-bearing for: the INSERT. That is where an
  -- unauthorised run would be created, and the INSERT is the only place a run
  -- can come into existence. A run already in flight was authorised when it was
  -- created, and the plan's later state is the watcher's business — which the
  -- next guard refuses (a plan with a live run cannot be superseded).
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM updater.plans p WHERE p.plan_id = NEW.plan_id
      AND p.state = 'approved' AND p.expires_at > pg_catalog.now()) THEN
    RAISE EXCEPTION 'updater run needs an approved, unexpired plan' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_run_lease() FROM PUBLIC;
CREATE OR REPLACE TRIGGER runs_lease_guard BEFORE INSERT OR UPDATE ON updater.runs
  FOR EACH ROW EXECUTE FUNCTION updater.guard_run_lease();

-- ---------------------------------------------------------------------------
-- Run state transitions (design §8.1)
-- ---------------------------------------------------------------------------
-- Two tables, because §8.1's two paths diverge: a code-only run and a
-- database run take different steps, and `uncertain` and
-- `attended_upgrade_required` are reachable from anywhere (the updater enters
-- them on a measurement, not as the successor of a step).
--
-- The graph is the design's, with the rollback tail spelled out: any
-- post-effect step may go to `rollback_started`, and from there the database
-- path walks restore -> db_restored -> code_restored, while the code path goes
-- straight to code_restored. `rolled_back` and `needs_attention` are terminal.
CREATE OR REPLACE FUNCTION updater.guard_run_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE
  prior text;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  -- The row's own state and its last event are two records of the same thing.
  -- If they disagree, the journal is ahead of the row and this transaction must
  -- not be the one that guesses which is right.
  --
  -- ONE EXCEPTION, and it is the success path. §11's order is: journal the
  -- intent, take the effect, journal the done line. The run row moves to
  -- `succeeded` and its `succeeded` event is appended immediately after, so at
  -- the moment of the UPDATE the last event is still the previous step. Reading
  -- that as a disagreement would refuse the one transition that must never be
  -- refused, and would make a successful update unrecordable. So the comparison
  -- is skipped when the run is becoming terminal, and the `finished_at` CHECK
  -- below is what still has to hold there.
  IF OLD.state IN ('succeeded','rolled_back','needs_attention','refused') THEN
    RAISE EXCEPTION 'updater run % is terminal', OLD.state USING ERRCODE = '23514';
  END IF;
  IF NEW.state NOT IN ('succeeded','rolled_back','needs_attention','refused') THEN
    SELECT e.state INTO prior FROM updater.run_events e
      WHERE e.run_id = NEW.run_id ORDER BY e.ordinal DESC LIMIT 1;
    IF prior IS NOT NULL AND prior <> OLD.state THEN
      RAISE EXCEPTION 'updater run state disagrees with its journal (% vs %)', OLD.state, prior
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state IN ('uncertain','attended_upgrade_required') THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.state = 'approved' AND NEW.state IN ('prechecked','refused','rollback_started')) OR
    (OLD.state = 'prechecked' AND NEW.state IN ('staged','rollback_started','refused')) OR
    (OLD.state = 'staged' AND NEW.state IN ('quick_backup','quiesced','rollback_started','refused')) OR
    -- The code-only path per §8.1: draining -> switched, because a code run never
    -- quiesces the database. The database path below goes draining -> quiesced
    -- instead, and both are listed so neither is a special case of the other.
    (OLD.state = 'quick_backup' AND NEW.state IN ('draining','rollback_started','refused')) OR
    (OLD.state = 'draining' AND NEW.state IN ('quiesced','switched','rollback_started','refused')) OR
    (OLD.state = 'quiesced' AND NEW.state IN ('backup_verified','rollback_started','refused')) OR
    (OLD.state = 'backup_verified' AND NEW.state IN ('preimage_taken','rollback_started','refused')) OR
    (OLD.state = 'preimage_taken' AND NEW.state IN ('migrating','rollback_started','refused')) OR
    (OLD.state = 'migrating' AND NEW.state IN ('migrated','rollback_started','refused')) OR
    (OLD.state = 'migrated' AND NEW.state IN ('switched','rollback_started','refused')) OR
    (OLD.state = 'switched' AND NEW.state IN ('restarted','rollback_started','refused')) OR
    (OLD.state = 'restarted' AND NEW.state IN ('healthy','rollback_started','refused')) OR
    (OLD.state = 'healthy' AND NEW.state IN ('succeeded','rollback_started')) OR
    (OLD.state = 'rollback_started' AND NEW.state IN ('restore_started','code_restored','needs_attention')) OR
    (OLD.state = 'restore_started' AND NEW.state IN ('db_restored','needs_attention')) OR
    (OLD.state = 'db_restored' AND NEW.state IN ('code_restored','needs_attention')) OR
    (OLD.state = 'code_restored' AND NEW.state IN ('rolled_back','needs_attention')) OR
    -- B3: THE WAY OUT OF `uncertain`. `uncertain` is reachable from anywhere
    -- (the row above returns early for it) and it had no successor here, so the
    -- state was a dead end in the database: §11's "Check and continue" measures
    -- and then records `succeeded` or `rolled_back`, and the runner settles a
    -- `rollback_required` measurement through `rollback_started` — and every one
    -- of those three moves was refused `23514 upddater run transition refused`.
    -- The owner's only button could not clear the state it existed to clear, on
    -- the install-night path, against the real database.
    --
    -- The three successors are exactly the ones the design's §11 measurement can
    -- justify, and nothing else. What is deliberately ABSENT is the whole
    -- forward path — `uncertain -> prechecked`, `uncertain -> switched`,
    -- `uncertain -> restarted`, `uncertain -> healthy` — because a run that
    -- measured "I don't know" must not then decide to try the next step; that is
    -- the rule `uncertain` exists to enforce.
    --
    -- `uncertain -> attended_upgrade_required` is NOT listed because it cannot
    -- reach this table: the early return above fires first, since the NEW state
    -- is itself `attended_upgrade_required`. Listing it would look like a
    -- permission and be dead text.
    --
    -- §9.7's hand-off is a state of its own with the same need — the attended
    -- upgrader the owner watches has to be able to record what it found — so it
    -- is listed too. It is reachable from anywhere and, unlike `uncertain`, its
    -- exit is a hand-off the owner is present for, so it carries no measurement
    -- requirement below.
    (OLD.state = 'uncertain' AND NEW.state IN ('succeeded','rolled_back','rollback_started')) OR
    (OLD.state = 'attended_upgrade_required' AND NEW.state IN ('succeeded','rolled_back','rollback_started'))
  ) THEN
    RAISE EXCEPTION 'updater run transition refused: % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  -- §11 is exact about the two measured exits: the updater "makes the updater
  -- measure: link targets, the served release id, `pg/current`, the schema digest
  -- and full health. If those prove a consistent known-good pair, it records
  -- `succeeded` or `rolled_back` with `detail.measured=true`". So the
  -- measurement is not only something the runner promises to have done — it is
  -- something the row carries, and this makes the carrying load-bearing: a run
  -- cannot leave `uncertain` as "succeeded" without an answer recorded, which is
  -- the difference between "we looked and it is fine" and "we gave up on
  -- looking".
  --
  -- Only the exits FROM `uncertain` are annotated. `rollback_started` is
  -- deliberately exempt: rolling back is the direction that cannot make anything
  -- worse, so permitting it unconditionally is the conservative half. And a run
  -- that arrives at `rolled_back` the long way (`rollback_started` ->
  -- `code_restored` -> `rolled_back`) is already past this check.
  IF OLD.state = 'uncertain' AND NEW.state IN ('succeeded','rolled_back')
      AND NEW.detail->>'measured' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'updater run leaves uncertain only on a recorded measurement' USING ERRCODE = '23514';
  END IF;
  -- Only a terminal state may carry a finish time, and only a live one may not.
  IF NEW.finished_at IS NOT NULL AND NEW.state NOT IN ('succeeded','rolled_back','needs_attention','refused') THEN
    RAISE EXCEPTION 'updater run finish time refused in state %', NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_run_state() FROM PUBLIC;
CREATE OR REPLACE TRIGGER runs_state_guard BEFORE UPDATE ON updater.runs
  FOR EACH ROW EXECUTE FUNCTION updater.guard_run_state();

-- The journal mirror is append-only and its ordinals are the run's step numbers.
-- The first event must be the run's opening state, and each ordinal must be the
-- previous one plus one: a step cannot be skipped in the record even if the
-- state machine would have allowed the jump.
CREATE OR REPLACE FUNCTION updater.guard_run_event_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE prior_ordinal bigint;
BEGIN
  SELECT e.ordinal INTO prior_ordinal FROM updater.run_events e
    WHERE e.run_id = NEW.run_id ORDER BY e.ordinal DESC LIMIT 1;
  IF prior_ordinal IS NULL THEN
    IF NEW.ordinal <> 1 THEN
      RAISE EXCEPTION 'updater run must start at ordinal 1' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.ordinal <> prior_ordinal + 1 THEN
    RAISE EXCEPTION 'updater run ordinal refused: % after %', NEW.ordinal, prior_ordinal
      USING ERRCODE = '23514';
  END IF;
  -- The event's state must be the run's current state, and the run must not
  -- already be finished. A mirror row for a run that has ended is a record of
  -- something that did not happen.
  IF NOT EXISTS (SELECT 1 FROM updater.runs r WHERE r.run_id = NEW.run_id
      AND r.state = NEW.state AND r.finished_at IS NULL) THEN
    RAISE EXCEPTION 'updater run event does not match a live run state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_run_event_insert() FROM PUBLIC;
CREATE OR REPLACE TRIGGER run_events_insert_guard BEFORE INSERT ON updater.run_events
  FOR EACH ROW EXECUTE FUNCTION updater.guard_run_event_insert();

-- ---------------------------------------------------------------------------
-- B4: the run row and its journal mirror move in ONE statement
-- ---------------------------------------------------------------------------
-- WHY A FUNCTION, AND WHY IT IS NOT OPTIONAL. The runner moved the run row and
-- then wrote the matching `run_events` row as two separate statements
-- (`store.transition` then `store.appendEvent`). Between them is a window in
-- which the row says `switched` and the last event still says `draining` — and
-- `guard_run_state` refuses any later non-terminal move whose last event differs
-- from the row, precisely because it must not guess which record is right. So a
-- kill in that window wedged the run permanently at `switched`: `restarted` was
-- refused, `rollback_started` was refused, "Check and continue" was refused, and
-- Control Room was left running the new code with no health check and no way
-- back. A guard that detects a wedge is not the same as not having one.
--
-- ATOMICITY IS THE POINT. PostgreSQL guarantees that one statement either
-- completes in full or is rolled back in full, with or without a `BEGIN`: so a
-- single `SELECT updater.record_run_step(...)` is the atomic pair, and the
-- caller's two statements cannot interleave with anything. That is what closes
-- the window, and it is why this is a function and not a stored procedure with
-- its own transaction: a `BEGIN`/`COMMIT` inside the function would still be
-- atomic for the row, but it would detach the move from whatever else the caller
-- was doing and would commit the row alone if the caller's next statement failed
-- — the same wedge with a new name.
--
-- THE CALLER OWNS NOTHING ELSE. The lease token is checked inside the statement,
-- and it is checked in BOTH places that filter on it: the row lock below and the
-- UPDATE that follows. The second is what makes the guard load-bearing on its
-- own — measured, with the token removed from the lock alone, the impostor's
-- call is still refused, because the UPDATE refuses it too. The lock's copy is
-- defence in depth and it is what makes ownership the FIRST thing decided,
-- before the function has read anything about the row; both must hold, because a
-- statement that filtered on the token only after reading the row would have
-- consulted a run it had no business reading.
--
-- The return value is `jsonb` of the row rather than the composite type, on
-- purpose: a composite return arrives at a client driver as an unparsed string,
-- and a caller that has to `JSON.parse` its own result to learn which state the
-- run is in is a caller this function has not simplified. The store spreads the
-- object, so `transition()`'s callers see the same shape they always did.
--
-- `p_terminal` moves `finished_at` with the state, so the row's terminal shape
-- (`runs_finished_shape`) is satisfied by the same atomic statement. When it is
-- true the mirror row is NOT written: `guard_run_event_insert` requires the run
-- to be unfinished (`finished_at IS NULL`), so a terminal step has no mirror
-- event, and the existing exception in `guard_run_state` (which skips the
-- row/journal comparison when the run is becoming terminal) is what keeps that
-- consistent. Both halves of that decision are in the database, not split
-- between this function and a caller that has to know.
-- WHY THE ROW IS LOCKED FIRST, AND WHY THAT IS NOT OPTIONAL. `guard_run_state`
-- already returns early when `NEW.state = OLD.state` (a no-op move is not a
-- transition), which means the statement alone cannot tell a REPEAT of the
-- current state from a real advance. Without the lock below, twenty concurrent
-- callers all asked for `approved -> prechecked` and all twenty got it: the
-- measure was twenty `succeeded` rows and ordinals 1 through 20, twenty mirror
-- events for one step. That is worse than the wedge it replaced, because the
-- run's journal is the audit trail the recovery path reads — twenty copies of one
-- step is a journal that lies about how the run got where it is.
--
-- So the function is REPEAT-SAFE, which is the runner's own requirement on every
-- effect it takes (design §8.1): a step that is already recorded is a no-op that
-- returns the row, and only a genuine advance writes a mirror event. A repeat
-- therefore costs nothing, writes nothing, and — the part that matters — does not
-- poison the ordinal chain for every later step.
--
-- The lock is `FOR UPDATE` on the run row, taken BEFORE the update and in the
-- same statement. It is what makes the read of the prior state and the write of
-- the new one one fact: a second caller blocks on that row until the first has
-- committed, and then observes the state the first left. Without it the two read
-- the same `prior_state` and both advance. It is also why twenty callers cannot
-- deadlock here — they all want the same single row, in the same order.
CREATE OR REPLACE FUNCTION updater.record_run_step(
  p_run_id text, p_lease_token text, p_state text, p_detail jsonb DEFAULT '{}'::jsonb,
  p_terminal boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE
  prior_state text;
  moved updater.runs;
BEGIN
  -- The lock and the read of the prior state, together. `FOR UPDATE` takes the
  -- row lock and returns the row as it was; everything after this line sees a
  -- state no other caller can change until this statement ends.
  SELECT r.state INTO prior_state FROM updater.runs r
    WHERE r.run_id = p_run_id AND r.lease_token = p_lease_token AND r.finished_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'updater run lease lost for %', p_run_id USING ERRCODE = '42501';
  END IF;
  -- Already there: a repeat of the step that is recorded. Return the row as it
  -- stands and write nothing, so the mirror keeps one row per step.
  IF prior_state = p_state AND NOT p_terminal THEN
    SELECT r.* INTO moved FROM updater.runs r WHERE r.run_id = p_run_id;
    RETURN pg_catalog.to_jsonb(moved);
  END IF;
  UPDATE updater.runs SET state = p_state, detail = p_detail,
      finished_at = CASE WHEN p_terminal THEN pg_catalog.now() ELSE NULL END
    WHERE run_id = p_run_id AND lease_token = p_lease_token AND finished_at IS NULL
    RETURNING * INTO moved;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'updater run lease lost for %', p_run_id USING ERRCODE = '42501';
  END IF;
  -- The mirror row, in the same statement. The ordinal is the last one plus one,
  -- read inside this same snapshot while the row lock is still held, so two
  -- callers racing for the next step serialise on the lock above and each gets
  -- one ordinal. The second is refused by `guard_run_event_insert`'s primary key
  -- rather than overwriting the first, which is a visible refusal rather than a
  -- silent loss.
  IF NOT p_terminal THEN
    INSERT INTO updater.run_events(run_id, ordinal, state, detail)
      SELECT p_run_id,
        COALESCE((SELECT max(e.ordinal) FROM updater.run_events e WHERE e.run_id = p_run_id), 0) + 1,
        p_state, p_detail;
  END IF;
  RETURN pg_catalog.to_jsonb(moved);
END;
$$;
REVOKE ALL ON FUNCTION updater.record_run_step(text, text, text, jsonb, boolean) FROM PUBLIC;
COMMENT ON FUNCTION updater.record_run_step(text, text, text, jsonb, boolean) IS
  'Moves a run to its next state and writes the matching journal mirror row in one'
  ' statement, which PostgreSQL commits or rolls back as a unit. The lease token is'
  ' re-checked inside the statement, so a caller without it moves nothing. A'
  ' terminal step writes no mirror row.';

-- ---------------------------------------------------------------------------
-- Append-only, everywhere it applies
-- ---------------------------------------------------------------------------
-- The assertion rows, the outcomes, the journal mirror and the approval
-- outcomes are records of things that happened. Rewriting one is not an update,
-- it is a forgery, and nothing in the design needs it. The deploy store's
-- triggers are the model (cook/deploy 0163).
--
-- `plans` and `runs` and `owner_requests` and `push_queue` and `heartbeat` are
-- NOT here: those are the tables whose state legitimately moves, and each has
-- its own guard above.
CREATE OR REPLACE TRIGGER plan_approvals_immutable BEFORE UPDATE OR DELETE ON updater.plan_approvals
  FOR EACH ROW EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER plan_approvals_no_truncate BEFORE TRUNCATE ON updater.plan_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER plan_approval_outcomes_immutable BEFORE UPDATE OR DELETE
  ON updater.plan_approval_outcomes FOR EACH ROW EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER plan_approval_outcomes_no_truncate BEFORE TRUNCATE
  ON updater.plan_approval_outcomes FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER passkey_registrations_immutable BEFORE UPDATE OR DELETE
  ON updater.passkey_registrations FOR EACH ROW EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER passkey_registrations_no_truncate BEFORE TRUNCATE
  ON updater.passkey_registrations FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER run_events_immutable BEFORE UPDATE OR DELETE ON updater.run_events
  FOR EACH ROW EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER run_events_no_truncate BEFORE TRUNCATE ON updater.run_events
  FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();

-- A `TRUNCATE` of plans or runs is the one deletion that takes rows the guards
-- above never see a row for, so it is refused too. `owner_requests` and
-- `push_queue` are queues and are trimmed by the updater; the updater uses
-- DELETE for that, which is permitted because the deployer owns the table, and
-- a TRUNCATE there would take rows another process is mid-insert into.
CREATE OR REPLACE TRIGGER plans_no_truncate BEFORE TRUNCATE ON updater.plans
  FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER runs_no_truncate BEFORE TRUNCATE ON updater.runs
  FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
-- The heartbeat is a SINGLETON: one row, and the web reads it to decide whether
-- the updater is alive. Nothing may reference it, so nothing makes PostgreSQL
-- refuse a TRUNCATE of it, and without this trigger `TRUNCATE updater.heartbeat`
-- would silently succeed and leave the web with no heartbeat at all — which §12
-- would render as "Updater not responding" forever, with no updater to fix it.
-- The row is replaced by UPDATE, never recreated by INSERT after a deletion.
CREATE OR REPLACE TRIGGER heartbeat_no_truncate BEFORE TRUNCATE ON updater.heartbeat
  FOR EACH STATEMENT EXECUTE FUNCTION updater.reject_append_only_mutation();
CREATE OR REPLACE TRIGGER heartbeat_no_delete BEFORE DELETE ON updater.heartbeat
  FOR EACH ROW EXECUTE FUNCTION updater.reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- A push row is the web's request to say something, not the message
-- ---------------------------------------------------------------------------
-- R12: the web holds only the VAPID public key and can only queue. Two shapes
-- are worth a database rule rather than a code convention:
--
--   * the updater's own template prefix, which only the updater may write. The
--     web has INSERT on this table, so the prefix cannot be left to a code
--     check on the web's side. A web-inserted row naming
--     `control-room-updater` is a row that would render as the updater speaking,
--     and that is the one impersonation the VAPID key change was made to stop;
--   * a retry count, so a row that has been attempted five times is not
--     retried forever. The CHECK bounds `attempts`; this bounds the SUITE:
--     more than 10 attempts and the row is a stuck row, which is visible.
-- `session_replication_role = replica` is how a superuser disables triggers, so
-- it is the one setting that would let a caller past every guard on this
-- table. It is not set at the function level: `session_replication_role` is
-- SUSET, so a SECURITY DEFINER function could not set it and a non-superuser
-- cannot either. It is therefore ASSERTED rather than set, and the updater's own
-- preflight requires `session_replication_role = 'origin'` on the connection
-- (the same requirement the web login's verifySession already states).
CREATE OR REPLACE FUNCTION updater.guard_push_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'updater push insert refused under session_replication_role=%',
      current_setting('session_replication_role') USING ERRCODE = '42501';
  END IF;
  -- The prefix rule is about the INSERTING ROLE, not about the string. Only the
  -- updater may speak as the updater, and `current_user` inside a plain invoker
  -- trigger IS the inserting role — so the web is refused and the updater is not,
  -- for the same statement.
  --
  -- It was previously written as a test on the template ALONE, which refused the
  -- updater too and therefore also refused `enqueue_cooling_off_notices` (a
    -- SECURITY DEFINER function whose inserts run with the updater's privileges but
    -- still fire this trigger). The test that "the web cannot queue a
    -- control-room-updater push" passed for the wrong reason — the updater could
    -- not queue one either — and nothing measured the half that mattered. Measured,
    -- not assumed: that is what the first real-PG run of item 10a showed.
  IF NEW.template LIKE 'control-room-updater%' AND current_user <> 'control_room_deployer' THEN
    RAISE EXCEPTION 'only the updater may use its own push template' USING ERRCODE = '42501';
  END IF;
  IF NEW.sent_at IS NOT NULL OR NEW.attempts <> 0 THEN
    RAISE EXCEPTION 'updater push must be queued unsent' USING ERRCODE = '42501';
  END IF;
  -- Everything below is about rows the WEB writes, and the updater is exempt for
  -- the same reason it is exempt from the prefix rule: it is the one writer whose
  -- rows these namespaces exist for.
  IF current_user <> 'control_room_deployer' THEN
    -- THE IDEMPOTENCY KEY IS THE UPDATER'S NAMESPACE (review passkey2 DB-1).
    -- Both of the updater's keys are predictable — `passkey-cooling-off:<cred>:*`
    -- from a credential id the attacker minted, `passkey-refusal:<plan>:<hour>`
    -- from a plan id and a clock — and the updater's inserts are `ON CONFLICT DO
    -- NOTHING`. So a web that could set a key could pre-claim one with a harmless
    -- row and the updater's warning would silently never be queued. That was
    -- measured on real PG: "2 warnings queued", zero sent. The web has no use for
    -- a key at all, so it may not set one.
    IF NEW.idempotency_key IS NOT NULL THEN
      RAISE EXCEPTION 'only the updater may set a push idempotency key' USING ERRCODE = '42501';
    END IF;
    -- Only the updater schedules (review passkey2 DB-5). A web row is sent at
    -- once: no `not_before`, and queued at the DATABASE's now() — the insert's
    -- own transaction time, which is what the column default gives it. The
    -- earlier rule only refused `not_before <> queued_at`, so a web row with
    -- both set 30 days ahead passed and sat in the queue as a scheduled send.
    IF NEW.not_before IS NOT NULL OR NEW.queued_at IS DISTINCT FROM pg_catalog.now() THEN
      RAISE EXCEPTION 'only the updater may schedule a push' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_push_insert() FROM PUBLIC;
CREATE OR REPLACE TRIGGER push_queue_insert_guard BEFORE INSERT ON updater.push_queue
  FOR EACH ROW EXECUTE FUNCTION updater.guard_push_insert();

-- The updater updates a push row to record the attempt. It is the only writer
-- that may, and only the four bookkeeping columns may move.
CREATE OR REPLACE FUNCTION updater.guard_push_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['sent_at','attempts','last_error_code'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['sent_at','attempts','last_error_code']) THEN
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
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_push_update() FROM PUBLIC;
CREATE OR REPLACE TRIGGER push_queue_update_guard BEFORE UPDATE ON updater.push_queue
  FOR EACH ROW EXECUTE FUNCTION updater.guard_push_update();

-- ---------------------------------------------------------------------------
-- The cooling-off notices (R14c, P-5)
-- ---------------------------------------------------------------------------
-- §5.1 step 7: "the updater pushes 'A new passkey was added on your Mac. It
-- becomes active in 24 hours. If this wasn't you, run `sudo
-- /usr/local/bin/control-room passkey revoke <n>`.' to every existing
-- subscription at once and again at 12 h."
--
-- `enqueue_cooling_off_notices` is P-5 in one statement, and the parts of it
-- that matter are these:
--
--   * IT IS IDEMPOTENT ON `credential_id`. The key is
--     `passkey-cooling-off:<credentialId>:now` and `...:repeat`, and
--     `push_queue.idempotency_key` is UNIQUE. A retried call — the updater
--     restarting mid-registration, or an operator re-running `passkey add` — adds
--     no second row, so the owner cannot be told twice about the same key.
--   * IT IS ONE TRANSACTION. Both rows commit together or neither does, so
--     "there is a 12 h reminder" is never false by half.
--   * IT REFUSES WITH ZERO SUBSCRIPTIONS. This is the case the review called out
--     (P-5, "the owner must know nobody was told"): an add with nobody to tell
--     RAISEs rather than returning success, so `completeRegistration` burns R
--     and writes no passkey. A silently successful add with no notice is exactly
--     the failure the 24 h cooling-off exists to catch.
--
-- WHY THE TEXT IS A BOUNDED ARGUMENT AND NOT PROSE THE CALLER CHOOSES. The body
-- is the design's §5.1 wording, with the number substituted; `p_number` is the
-- ledger position and `p_cooling_off_until` is the instant, both of which the
-- updater owns. The template id is the updater's reserved prefix, so
-- `guard_push_insert`'s rule (only the updater may use `control-room-updater%`)
-- holds for these rows too — the function is SECURITY DEFINER but still runs the
-- table's triggers, so it could not use the prefix if it were not the updater.
CREATE OR REPLACE FUNCTION updater.enqueue_cooling_off_notices(p_credential_id text, p_number integer,
  p_cooling_off_until timestamptz, p_repeat_at timestamptz)
RETURNS TABLE (enqueued integer, subscriptions integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE
  reached integer;
  own integer;
  body_text text;
  key_now text;
  key_repeat text;
BEGIN
  IF p_number < 1 OR p_number > 32
     OR p_repeat_at <= pg_catalog.now() OR p_cooling_off_until <= pg_catalog.now() THEN
    RAISE EXCEPTION 'updater cooling-off notice arguments refused' USING ERRCODE = '23501';
  END IF;
  -- How many browsers the owner has. Read as the updater, which holds SELECT on
  -- the three subscription columns it needs (see db/roles, item 10a's second
  -- grant file); with none, the add must fail rather than pass quietly.
  SELECT count(*)::integer INTO reached FROM public.owner_web_push_subscriptions s
    WHERE s.expires_at IS NULL OR s.expires_at > pg_catalog.now();
  IF reached = 0 THEN
    RAISE EXCEPTION 'updater cooling-off notice has no subscriptions to send to' USING ERRCODE = '23503';
  END IF;
  body_text := 'A new passkey was added on your Mac. It becomes active in 24 hours. '
    || 'If this wasn''t you, run sudo /usr/local/bin/control-room passkey revoke ' || p_number::text || '.';
  key_now := 'passkey-cooling-off:' || p_credential_id || ':now';
  key_repeat := 'passkey-cooling-off:' || p_credential_id || ':repeat';
  INSERT INTO updater.push_queue (id, idempotency_key, template, title, body, queued_at, not_before)
    VALUES ('push:' || pg_catalog.gen_random_uuid()::text, key_now, 'control-room-updater.passkey_cooling_off',
      'A new passkey was added', body_text, pg_catalog.now(), NULL)
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  INSERT INTO updater.push_queue (id, idempotency_key, template, title, body, queued_at, not_before)
    VALUES ('push:' || pg_catalog.gen_random_uuid()::text, key_repeat, 'control-room-updater.passkey_cooling_off',
      'A new passkey was added', body_text, pg_catalog.now(), p_repeat_at)
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  -- COUNT ONLY THE UPDATER'S OWN NOTICES (review passkey2 DB-1). `ON CONFLICT
  -- DO NOTHING` is what makes a retry idempotent, and it is also what would hide
  -- a key someone else already holds: the old count was of ANY row under the two
  -- keys, so a squatted "Weekly summary" row counted as a queued warning. A key
  -- counts here only when its row is this notice — the updater's template, the
  -- design's title, this body, and the right schedule shape — and anything else
  -- under the key RAISES, so `completeRegistration` burns R and writes no key
  -- rather than trusting a warning nobody will receive. The guard on
  -- `push_queue` already stops the web setting a key; this is the second wall,
  -- and it is the one that would still hold if that grant ever widened.
  SELECT count(*)::integer INTO own FROM updater.push_queue p
    WHERE p.template = 'control-room-updater.passkey_cooling_off'
      AND p.title = 'A new passkey was added' AND p.body = body_text
      AND ((p.idempotency_key = key_now AND p.not_before IS NULL)
        OR (p.idempotency_key = key_repeat AND p.not_before IS NOT NULL));
  IF own <> 2 THEN
    RAISE EXCEPTION 'updater cooling-off notice key is held by a row the updater did not write'
      USING ERRCODE = '42501';
  END IF;
  -- `reached` counts every live subscription row, including ones the web login
  -- inserted and ones in any tenant (review passkey2 DB-7). It is a sanity check
  -- that SOMEBODY could be told, not proof that the owner was: real delivery is
  -- item 21's dispatch, which must fan each notice out to the owner's
  -- subscriptions with the root VAPID key and honour `not_before`.
  RETURN QUERY SELECT own, reached;
END;
$$;
REVOKE ALL ON FUNCTION updater.enqueue_cooling_off_notices(text, integer, timestamptz, timestamptz) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The cooling-off repeat is a SCHEDULING question the queue does not answer yet
-- ---------------------------------------------------------------------------
-- `push_queue` has no `not_before` column, so a 12 h repeat cannot simply be
-- queued with a future `queued_at`: the dispatch loop reads unsent rows and would
-- send it at once, which is the opposite of the requirement. The column is added
-- here, with the dispatch side a one-line change in item 21 (`WHERE sent_at IS
-- NULL AND queued_at <= now()` becomes `... AND not_before <= now()`), and the
-- guard above is written against it from the start so the two cannot disagree.
ALTER TABLE updater.push_queue ADD COLUMN IF NOT EXISTS not_before timestamptz;
-- A row may not be sent before it was queued, and a NULL is the ordinary
-- "send at once" case, so the CHECK is one-sided.
--
-- THE `DO` BLOCK IS NOT COSMETIC. PostgreSQL has no `ADD CONSTRAINT IF NOT
-- EXISTS`, and the updater applies this file at EVERY startup — so the unguarded
-- form fails on the second apply with `constraint "..." already exists`, which is
-- an updater that cannot restart. The existing schema lane caught exactly this,
-- which is what that lane's "a second apply changes nothing and refuses nothing"
-- assertion is for. Every ADD CONSTRAINT in this schema is therefore wrapped; the
-- ones inside `0002_schema.sql` are wrapped the same way.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'updater' AND t.relname = 'push_queue'
       AND c.conname = 'push_not_before_after_queued') THEN
    ALTER TABLE updater.push_queue ADD CONSTRAINT push_not_before_after_queued
      CHECK (not_before IS NULL OR not_before >= queued_at) NOT VALID;
  END IF;
END;
$$;
ALTER TABLE updater.push_queue VALIDATE CONSTRAINT push_not_before_after_queued;
-- The repeat row must carry one; the immediate rows must not need to. Stated as a
-- guard on the UPDATE path so a future change cannot quietly move a scheduled
-- notice into the past, which would turn the 12 h reminder into a second
-- immediate alert.
CREATE OR REPLACE FUNCTION updater.guard_push_schedule() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.not_before IS NOT NULL AND NEW.not_before < NEW.queued_at THEN
    RAISE EXCEPTION 'updater push not_before precedes its queue time' USING ERRCODE = '23514';
  END IF;
  IF NEW.sent_at IS NOT NULL AND NEW.not_before IS NOT NULL AND NEW.sent_at < NEW.not_before THEN
    RAISE EXCEPTION 'updater push was sent before it was due' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_push_schedule() FROM PUBLIC;
CREATE OR REPLACE TRIGGER push_queue_schedule_guard BEFORE UPDATE ON updater.push_queue
  FOR EACH ROW EXECUTE FUNCTION updater.guard_push_schedule();

-- ---------------------------------------------------------------------------
-- The owner request's handling, and the heartbeat's shape
-- ---------------------------------------------------------------------------
-- `handled_at`/`handled_outcome` move exactly once, from NULL to a value, and
-- the web can set neither (it has no UPDATE grant). A second handling attempt on
-- an already-handled request is refused, which is what stops a retrying caller
-- from acting twice on one phone tap.
CREATE OR REPLACE FUNCTION updater.guard_owner_request_handled() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['handled_at','handled_outcome'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['handled_at','handled_outcome']) THEN
    RAISE EXCEPTION 'updater owner request content is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.handled_at IS NOT NULL THEN
    RAISE EXCEPTION 'updater owner request already handled' USING ERRCODE = '23514';
  END IF;
  IF NEW.handled_at IS NOT NULL AND NEW.handled_at < NEW.requested_at THEN
    RAISE EXCEPTION 'updater owner request handled before it was requested' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_owner_request_handled() FROM PUBLIC;
CREATE OR REPLACE TRIGGER owner_requests_update_guard BEFORE UPDATE ON updater.owner_requests
  FOR EACH ROW EXECUTE FUNCTION updater.guard_owner_request_handled();

-- The heartbeat is a singleton the updater upserts. A second row would make
-- "is the updater alive" ambiguous, so the key is `singleton` constrained to
-- true and the updater's upsert is the only write path. This trigger refuses a
-- heartbeat whose reported state contradicts the live run's state, because a
-- banner that says "idle" while a run is mid-migration is exactly the lie §12
-- exists to prevent.
CREATE OR REPLACE FUNCTION updater.guard_heartbeat() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
BEGIN
  IF NEW.singleton IS NOT TRUE THEN
    RAISE EXCEPTION 'updater heartbeat is a singleton' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM updater.runs r WHERE r.finished_at IS NULL)
    AND NEW.reported_state NOT IN ('running','awaiting_approval') THEN
    RAISE EXCEPTION 'updater heartbeat contradicts a live run' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM updater.runs r WHERE r.finished_at IS NULL)
    AND NEW.reported_state IN ('running','awaiting_approval') THEN
    RAISE EXCEPTION 'updater heartbeat claims work with no live run' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_heartbeat() FROM PUBLIC;
CREATE OR REPLACE TRIGGER heartbeat_guard BEFORE INSERT OR UPDATE ON updater.heartbeat
  FOR EACH ROW EXECUTE FUNCTION updater.guard_heartbeat();

-- ---------------------------------------------------------------------------
-- M1, HALF TWO: the approval a request cites must be for THAT kind of plan
-- ---------------------------------------------------------------------------
-- The first M1 CHECK makes `requires_passkey` honest. This makes the cited
-- `approval_id` mean something: the web login may insert into
-- `owner_requests`, so it chose the approval, and nothing stopped it choosing an
-- approval that belongs to an INSTALL plan and citing it for a rollback. The row
-- was well formed on every column — a real approval id, a real plan — and the
-- rollback it authorised had the owner's Face ID over the wrong bytes. The
-- review measured exactly that (P5c) and it was refused today only because the
-- rollback port is unbound, which is not a control.
--
-- §5.6's rule is one sentence: `rollback` needs a passkey against a
-- `kind:"rollback"` plan, and `serve_accepted` against a `kind:"setting"` plan.
-- The mapping is written as a CASE so the two kinds cannot drift from the design
-- when one is added, and so a request kind with no expected kind at all is
-- refused rather than defaulting to "anything".
--
-- It is a TRIGGER, not a CHECK, because a CHECK may not read another table —
-- `plan_approvals.plan_id` and `plans.kind` are one and two joins away. And it
-- is BEFORE INSERT, which is the only moment the row is the web's to choose; the
-- content is immutable afterwards (`guard_owner_request_handled` refuses any
-- change beyond `handled_at`/`handled_outcome`), so checking at INSERT is
-- checking it for good.
--
-- IT IS NOT SECURITY DEFINER, and that is a measured choice rather than an
-- oversight. An earlier draft made it SECURITY DEFINER on the assumption that
-- the web login holds no privilege on `plans` — the reason
-- `guard_owner_session` above needs it. Measured on a real cluster:
-- `0002_schema.sql` grants the web login SELECT on `updater.plans` in full (it
-- renders the owner's plan cards), and separately on `(id, plan_id, received_at)`
-- of `plan_approvals`, which is every column this body reads. So the invoker
-- body has what it needs, and the definer would be pure extra authority.
--
-- Leaving it INVOKER means the guard holds exactly the web login's own reach:
-- it can ask which kind one named plan is, and it can do nothing the web could
-- not already do by hand — no approval, no state change, no other plan's kind.
-- `guard_owner_session` keeps SECURITY DEFINER because `control_web_sessions`
-- really is unreadable from the web side; this one does not, so it must not
-- borrow that justification.
CREATE OR REPLACE FUNCTION updater.guard_owner_request_approval_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, updater, pg_temp AS $$
DECLARE
  approval_plan text;
  plan_kind text;
  expected_kind text;
BEGIN
  IF NEW.approval_id IS NULL THEN RETURN NEW; END IF;
  SELECT CASE NEW.request_kind
      WHEN 'rollback' THEN 'rollback'
      WHEN 'serve_accepted' THEN 'setting'
    END INTO expected_kind;
  SELECT a.plan_id INTO approval_plan FROM updater.plan_approvals a WHERE a.id = NEW.approval_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'updater owner request cites an approval that does not exist' USING ERRCODE = '23514';
  END IF;
  SELECT p.kind INTO plan_kind FROM updater.plans p WHERE p.plan_id = approval_plan;
  IF NOT FOUND OR plan_kind IS DISTINCT FROM expected_kind THEN
    RAISE EXCEPTION 'updater owner request % needs an approval for a % plan, not %',
      NEW.request_kind, expected_kind, plan_kind USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION updater.guard_owner_request_approval_kind() FROM PUBLIC;
CREATE OR REPLACE TRIGGER owner_requests_approval_kind_guard BEFORE INSERT ON updater.owner_requests
  FOR EACH ROW EXECUTE FUNCTION updater.guard_owner_request_approval_kind();
