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
