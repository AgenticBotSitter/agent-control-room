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

-- The advisory lock below is what serialises the count, so it must be allowed
-- to outlast the ordinary statement budget: a caller queued behind a peer that
-- is committing a claim waits for that commit, not for a deadline. The gateway
-- pool's own statement and transaction budgets remain the real bound on a claim.
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
  -- beforehand. hashtextextended over the tenant and worker id is the same key
  -- discipline 0100 uses for project scope, applied per worker: two workers
  -- never meet on this lock, and two claims for one worker always do.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(json_build_array(NEW.tenant_id, NEW.worker_id)::text, 0));

  SELECT w.max_concurrent INTO worker_max_concurrent
  FROM public.fleet_workers w
  WHERE w.tenant_id=NEW.tenant_id AND w.worker_id=NEW.worker_id;

  -- No worker row: 0140's own guard already refuses this claim, and this
  -- function must not read a NULL ceiling as "unlimited".
  IF worker_max_concurrent IS NULL THEN
    RAISE EXCEPTION 'fleet claim rejected' USING ERRCODE='P0001';
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

-- Runs AFTER 0140's own guard, so every other admissibility question is
-- answered first and this one is the last word on capacity. Both fire for the
-- same INSERT, in name order, and neither can be bypassed by a login.
CREATE TRIGGER fleet_claims_capacity_guard
  BEFORE INSERT ON public.fleet_claims
  FOR EACH ROW EXECUTE FUNCTION public.enforce_fleet_worker_claim_capacity();

-- 0140's own capacity clause is now redundant and, worse, wrong: it counted an
-- elapsed 'active' lease and it did so without a lock. Removing it leaves every
-- other clause of that guard exactly as it was, so the replacement is scoped to
-- the capacity question and nothing else.
CREATE OR REPLACE FUNCTION public.guard_fleet_claim_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
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
    RAISE EXCEPTION 'fleet claim rejected' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_fleet_claim_insert() FROM PUBLIC;
