-- Restore the private-web ownership boundary on the shared action inbox.
-- Private web may resolve work-batch notifications, but it must not mutate
-- attention records owned by another subsystem.

CREATE OR REPLACE FUNCTION guard_work_batch_notification_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='control_room_private_web'
      AND pg_catalog.pg_has_role(session_user,r.oid,'member')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles s WHERE s.rolname=session_user AND NOT s.rolsuper))
    AND OLD.id NOT LIKE 'attention:work-batch:%' THEN
    RAISE EXCEPTION 'private web action inbox update rejected';
  END IF;
  IF OLD.id LIKE 'attention:work-batch:%' AND (
    NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.kind<>OLD.kind
    OR OLD.state<>'open' OR NEW.state<>'resolved' OR NEW.delivery_state<>OLD.delivery_state
    OR NEW.created_at<>OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.payload<>pg_catalog.jsonb_set(OLD.payload,'{state}','"resolved"'::jsonb)
    OR NOT EXISTS (SELECT 1 FROM public.work_batches b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.work_item_id
      AND b.project_id=NEW.project_id AND b.state IN ('approved','partially_approved','rejected'))
  ) THEN RAISE EXCEPTION 'work batch notification update rejected'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_work_batch_notification_update() FROM PUBLIC;
