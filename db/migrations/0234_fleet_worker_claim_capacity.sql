-- A fleet worker's maxConcurrent is a CEILING, and 0140's check was a plain
-- read-then-compare: the guard counted the worker's live claims and refused
-- past the ceiling, but nothing serialised the two, so several callers that
-- each held a stale count of one all saw "two live is under two" and all
-- inserted. The ceiling held only because the gateway claim path happens to
-- take a tenant row lock first. That is an accident of one caller, not a
-- property of the database, and the ledger reports maxConcurrent to the owner
-- as if the database were enforcing it.
--
-- Two changes, both at the boundary:
--
--   1. The count is serialised per worker by a transaction-scoped advisory
--      lock, so the compare and the insert cannot interleave. Every caller that
--      inserts a claim for a worker now waits for the previous one's
--      transaction, whatever the application did beforehand. The lock is taken
--      on the worker's own identity, so workers never block each other.
--
--   2. Only a lease that is BOTH in state 'active' AND not past its expiry
--      occupies a slot. 0140 counted state alone, so a machine that crashed
--      with an elapsed lease kept its own capacity occupied until somebody
--      reconciled it, and an owner watching "2 tasks in progress" on a worker
--      that had died was seeing the database's memory, not the machine's work.
--
-- The refusal is a distinct SQLSTATE, '54000' (program_limit_exceeded), so the
-- claim path can tell "this worker is at its ceiling" from "this claim is not
-- admissible" and from every other database fault. 23514 would be
-- indistinguishable from 0140's lease-scope and declaration refusals, and
-- P0001 from a revoked worker, a stale offer or a lapsed credential.
--
-- The code is 54, not the 53 that reads most naturally, and the choice is
-- forced by the driver. `definiteSqlState` in src/web/v1/private-pg-driver.ts
-- deliberately treats class 53 as NOT proving what the server did and quarantines
-- the whole pool on it, because a resource-exhaustion error can arrive after
-- partial work. 53000 would therefore have turned an ordinary, expected,
-- retry-later outcome -- a worker at its own configured limit -- into a
-- poisoned database for the whole gateway. 54 is a definite refusal: the server
-- rejected the statement and did nothing. It is also a class nothing in this
-- schema already raises, so it cannot be confused with a fault from elsewhere.

-- The advisory lock is what serialises the count, so this file's own
-- transaction has to be allowed to outlast the ordinary statement budget: a
-- caller queued behind a peer committing a claim waits for that commit, not for
-- a deadline. `SET LOCAL` scopes that to THIS transaction and is reverted at
-- its commit, so nothing here changes a runtime caller's settings.
--
-- At runtime the bound on that wait belongs to whoever opened the transaction.
-- The gateway pool sets lock_timeout=2s (src/web/v1/private-pg-options.ts), so
-- a caller that queues behind a peer for longer than two seconds is cancelled
-- by the pool with 55P03 (lock_not_available) rather than by this file. That is
-- deliberate: the wait is bounded by the caller's own transaction budget, and
-- 55P03 is a fault the claim path does not map to conflict, so it surfaces
-- rather than being silently absorbed. The gateway claim path takes a tenant row
-- lock before this function, which is what keeps its own waits short.
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '20s';

CREATE OR REPLACE FUNCTION enforce_fleet_worker_claim_capacity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  worker_max_concurrent bigint;
  live_claims bigint;
BEGIN
  -- Serialise every claim insert for this worker, whatever the caller did
  -- beforehand. The key carries a literal tag, so this lock is in its OWN
  -- namespace rather than sharing one with any other lock discipline in this
  -- schema: 0100 keys its lease-scope lock on hashtextextended over
  -- json_build_array(tenant, project), and a fleet worker id is shaped
  -- `fleet-worker:<32 hex>`, which that keyspace would otherwise accept as a
  -- project id. A collision would have been harmless -- a shared key only adds
  -- serialisation, never permits -- but a fleet claim and a project scope lock
  -- serialising against each other is an ordering cycle waiting for the wrong
  -- writer to arrive. The tag makes that impossible by construction.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(json_build_array('fleet_worker_capacity', NEW.tenant_id, NEW.worker_id)::text, 0));

  -- REPEATABLE READ is refused HERE, after the lock is held, which is the only
  -- place the refusal can be made correct. The advisory lock serialises the
  -- inserts, but an RR transaction's snapshot is taken at its FIRST statement,
  -- which for this caller was BEGIN -- before it ever waited on the lock. So the
  -- count below reads the world as it was before the peer claim committed,
  -- every RR caller sees the same stale count, and the ceiling is not a
  -- ceiling: measured on real PostgreSQL 17 as the fleet login, three RR
  -- connections at a ceiling of 2 inserted all three. Serialising the writes is
  -- not enough; the transaction has to be able to SEE the peer before it counts.
  --
  -- SERIALIZABLE is deliberately still allowed. SSI cannot commit a write skew
  -- of this shape: the measured outcome was two winners at the ceiling and one
  -- 40001 (serialization_failure), so its own safety property holds the
  -- ceiling.
  --
  -- 0A000 (feature_not_supported) is the code, and it is on purpose NOT 54000
  -- and NOT P0001. Those two are claim-path refusals the store answers with
  -- `conflict`, which is the right answer for "this worker is busy, try the next
  -- offer" and the wrong answer here: nothing about this worker or this offer
  -- changed, and a connector that swallowed the refusal would sit in an RR
  -- transaction, take the conflict, and keep making claims the database never
  -- counted. 0A000 is in neither refusal set, so it leaves as an unexpected
  -- error and ends the pass -- the caller is told its transaction mode is
  -- unsupported rather than told to come back later. Class 0A is a feature
  -- class, so the driver's `definiteSqlState` records it rather than
  -- quarantining the pool, and the server did nothing either way.
  IF pg_catalog.current_setting('transaction_isolation')='repeatable read' THEN
    RAISE EXCEPTION 'fleet claim capacity cannot be enforced in a repeatable read transaction'
      USING ERRCODE='0A000';
  END IF;

  SELECT w.max_concurrent INTO worker_max_concurrent
  FROM public.fleet_workers w
  WHERE w.tenant_id=NEW.tenant_id AND w.worker_id=NEW.worker_id;

  -- No worker row: 0140's own guard already refuses this claim, and this
  -- function must not read a NULL ceiling as "unlimited". This branch is
  -- reachable precisely because this trigger fires LAST -- see below.
  IF worker_max_concurrent IS NULL THEN
    RAISE EXCEPTION 'fleet claim rejected';
  END IF;

  -- A slot is a claim whose lease is still live. state='active' alone kept a
  -- crashed machine's elapsed lease holding capacity open forever; expiry is
  -- the database's own clock, never a caller's.
  SELECT pg_catalog.count(*) INTO live_claims
  FROM public.fleet_claims fc
  JOIN public.control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
  WHERE fc.tenant_id=NEW.tenant_id AND fc.worker_id=NEW.worker_id
    AND l.state='active' AND l.expires_at>pg_catalog.statement_timestamp();

  IF live_claims>=worker_max_concurrent THEN
    RAISE EXCEPTION 'fleet worker claim capacity reached' USING ERRCODE='54000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_fleet_worker_claim_capacity() FROM PUBLIC;

-- BEFORE triggers on one table fire in NAME order, so the `zz_` here is what
-- puts this guard LAST, after 0140's own `fleet_claims_guard` has answered every
-- question of admissibility. That ordering is the point: a claim that is not
-- otherwise admissible is refused before it takes a lock, so the expensive
-- serialising wait is only ever paid by a claim that could actually be
-- admitted. The first spelling of this trigger sorted BEFORE 0140's, which put
-- capacity first, so an inadmissible claim for a worker at its ceiling was
-- refused `54000 capacity reached` rather than 0140's `P0001 claim rejected` --
-- which is also why the worker-lookup branch above has to handle a missing
-- worker row at all.
--
-- Nothing in the claim path depends on which of the two answers first: a claim
-- refused for either reason is the same `conflict` to the worker.
CREATE TRIGGER fleet_claims_zz_capacity_guard
  BEFORE INSERT ON public.fleet_claims
  FOR EACH ROW EXECUTE FUNCTION public.enforce_fleet_worker_claim_capacity();

-- 0140's own capacity clause is now redundant and, worse, wrong: it counted an
-- elapsed 'active' lease and it did so without a lock. Removing it leaves every
-- other clause of that guard exactly as it was, so the replacement is scoped to
-- the capacity question and nothing else.
--
-- The body below is 0140's, byte for byte, with the three capacity lines
-- removed; db/down/0234 restores those three lines as 0140 wrote them. That is
-- what makes an up-then-down land on the pre-0234 schema digest rather than on
-- a third shape that never existed, because the digest hashes
-- pg_get_functiondef.
CREATE OR REPLACE FUNCTION public.guard_fleet_claim_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE worker public.fleet_workers%ROWTYPE; offer public.fleet_work_offers%ROWTYPE;
BEGIN
  SELECT * INTO worker FROM public.fleet_workers w WHERE w.tenant_id=NEW.tenant_id AND w.worker_id=NEW.worker_id;
  SELECT * INTO offer FROM public.fleet_work_offers o WHERE o.tenant_id=NEW.tenant_id AND o.offer_id=NEW.offer_id;
  IF worker.worker_id IS NULL OR offer.offer_id IS NULL OR worker.state<>'active' OR offer.state<>'open'
    OR worker.node_id<>NEW.node_id OR offer.job_id<>NEW.job_id OR offer.project_id<>NEW.project_id
    OR NOT NEW.project_id=ANY(worker.project_ids) OR NOT offer.capability=ANY(worker.capabilities)
    OR (offer.allowed_worker_ids IS NOT NULL AND NOT NEW.worker_id=ANY(offer.allowed_worker_ids))
    OR NEW.claimed_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR NOT EXISTS (SELECT 1 FROM public.fleet_worker_credentials c WHERE c.tenant_id=NEW.tenant_id
      AND c.worker_id=NEW.worker_id AND c.state='active' AND c.expires_at>pg_catalog.statement_timestamp())
    OR EXISTS (SELECT 1 FROM public.control_leases l WHERE l.tenant_id=NEW.tenant_id AND l.job_id=NEW.job_id
      AND l.state='active') THEN
    RAISE EXCEPTION 'fleet claim rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_claim_insert() FROM PUBLIC;