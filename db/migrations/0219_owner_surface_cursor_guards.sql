-- MIG-G monotonic acknowledgement guard. The service also uses GREATEST so
-- two tabs or a lost-response retry cannot move an owner's cursor backwards.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE FUNCTION guard_owner_surface_cursor_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.seen_through>pg_catalog.statement_timestamp()+interval '1 minute'
    OR NEW.updated_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR (TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.identity_id<>OLD.identity_id
      OR NEW.surface<>OLD.surface OR NEW.seen_through<OLD.seen_through)) THEN
    RAISE EXCEPTION 'owner surface cursor rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_owner_surface_cursor_write() FROM PUBLIC;
CREATE TRIGGER owner_surface_cursors_guard BEFORE INSERT OR UPDATE ON owner_surface_cursors
  FOR EACH ROW EXECUTE FUNCTION public.guard_owner_surface_cursor_write();
CREATE TRIGGER owner_surface_cursors_no_delete BEFORE DELETE ON owner_surface_cursors
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER owner_surface_cursors_no_truncate BEFORE TRUNCATE ON owner_surface_cursors
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
