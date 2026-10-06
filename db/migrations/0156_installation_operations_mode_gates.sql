-- Honour the installation operations mode at the three places a claim or a
-- start actually enters the database.
--
-- Each guard is a BEFORE INSERT trigger on the table that row must pass through,
-- so it runs inside the same transaction as the claim or the enqueue. There is
-- no application-side check to forget, no second transaction to lose a race
-- against, and no login that can reach the insert while bypassing the guard.
--
-- "Running work finishes" is not implemented here and must not be: these
-- triggers only ever see a NEW attempt, admission or enqueue row, so a running
-- attempt is left completely alone. The installation operations mode service's
-- own stop path goes through control_transition_events (an UPDATE of an
-- existing row), never through an insert this migration guards.
--
-- The mode read is inlined rather than called through a helper function. Every
-- function in this schema is ungranted by default, and a guard that depended on
-- an EXECUTE privilege would fail closed the moment a role file stopped naming
-- it — a failure nothing in the application would distinguish from ordinary
-- contention. No recorded revision means running: the absence of an owner
-- decision is not itself a decision, and failing closed would take a freshly
-- migrated installation offline.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- 1. The claim path. Every ordinary assignment, every pipeline stage
--    assignment and every scheduled assignment creates its attempt here, and
--    the canonical store creates the attempt and the lease together.
CREATE FUNCTION guard_installation_operations_mode_claim() RETURNS trigger
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mode text;
BEGIN
  SELECT m.mode INTO mode FROM public.installation_operations_mode_revisions m
    WHERE m.tenant_id = NEW.tenant_id ORDER BY m.revision DESC LIMIT 1;
  IF mode IS NULL OR mode = 'running' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'installation operations mode % refuses a new claim', mode
    USING ERRCODE = 'object_not_in_prerequisite_state';
END $$;
REVOKE ALL ON FUNCTION public.guard_installation_operations_mode_claim() FROM PUBLIC;
CREATE TRIGGER control_attempts_operations_mode_claim
  BEFORE INSERT ON public.control_attempts
  FOR EACH ROW EXECUTE FUNCTION public.guard_installation_operations_mode_claim();

-- 2. The work-batch agent queue. An admission appends an owner-approved item to
--    a named worker's queue at the next position; that is the moment work is
--    promised to a worker, before any claim exists.
CREATE FUNCTION guard_installation_operations_mode_admission() RETURNS trigger
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mode text;
BEGIN
  SELECT m.mode INTO mode FROM public.installation_operations_mode_revisions m
    WHERE m.tenant_id = NEW.tenant_id ORDER BY m.revision DESC LIMIT 1;
  IF mode IS NULL OR mode = 'running' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'installation operations mode % refuses a new queue admission', mode
    USING ERRCODE = 'object_not_in_prerequisite_state';
END $$;
REVOKE ALL ON FUNCTION public.guard_installation_operations_mode_admission() FROM PUBLIC;
CREATE TRIGGER work_batch_queue_admissions_operations_mode
  BEFORE INSERT ON public.work_batch_queue_admissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_installation_operations_mode_admission();

-- 3. The start path. The native task queue row is the recorded intent to hand a
--    claimed attempt to a worker, so it is a start even where the claim
--    predates the mode being set.
CREATE FUNCTION guard_installation_operations_mode_start() RETURNS trigger
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE mode text;
BEGIN
  SELECT m.mode INTO mode FROM public.installation_operations_mode_revisions m
    WHERE m.tenant_id = NEW.tenant_id ORDER BY m.revision DESC LIMIT 1;
  IF mode IS NULL OR mode = 'running' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'installation operations mode % refuses a new start', mode
    USING ERRCODE = 'object_not_in_prerequisite_state';
END $$;
REVOKE ALL ON FUNCTION public.guard_installation_operations_mode_start() FROM PUBLIC;
CREATE TRIGGER control_native_task_queue_operations_mode
  BEFORE INSERT ON public.control_native_task_queue
  FOR EACH ROW EXECUTE FUNCTION public.guard_installation_operations_mode_start();
