-- Reverses 0234 only: the capacity guard and its trigger, and the shape of
-- 0140's own claim guard as 0234 left it.
--
-- 0140's capacity clause is restored verbatim -- the read-then-compare that
-- counted an elapsed lease and serialised nothing -- because that clause IS
-- 0140's, and 0234 removed it. Restoring it is not a statement that it is
-- correct; it is 0140's behaviour, put back exactly as it was, so a down
-- returns the database to the state before this migration rather than to some
-- third state that never existed.
--
-- "Exactly as it was" is a claim about bytes, and it is load-bearing: the
-- private-web schema digest hashes pg_get_functiondef, so a down that merely
-- restored the clause's MEANING would still move the digest, and a database
-- that went up and then down would no longer be the database it started as.
-- The function below is therefore 0140's body character for character -- its
-- header, its END $$, and its bare RAISE, none of them restated -- with one
-- change: OR REPLACE and the public. qualifier, which is what this file has to
-- say in order to replace a function it does not drop.
BEGIN;

DROP TRIGGER fleet_claims_zz_capacity_guard ON public.fleet_claims;
DROP FUNCTION public.enforce_fleet_worker_claim_capacity();

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
      AND l.state='active')
    OR (SELECT pg_catalog.count(*) FROM public.fleet_claims fc JOIN public.control_leases l
        ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
      WHERE fc.tenant_id=NEW.tenant_id AND fc.worker_id=NEW.worker_id AND l.state='active')>=worker.max_concurrent THEN
    RAISE EXCEPTION 'fleet claim rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_claim_insert() FROM PUBLIC;
COMMIT;