-- MIG-I: the push-attempt head is a delivery record and nothing else.
--
-- The owner attention ITEM is the product authority for "what does the owner
-- need to look at". This table is only ever the phone's record of having
-- tried. So the guard pins every property of the item except the retry
-- bookkeeping: the link may not be repointed, an attempt may not be
-- decremented, a delivered item may never return to a sendable state, and the
-- attempt count may never exceed the bound the column itself carries.
--
-- Without this, a caller holding INSERT and UPDATE (delivery_state, updated_at)
-- on owner_web_push_deliveries could reset a delivered head to 'pending' and
-- make the owner's phone alert again for a stall they have already answered.
-- One Needs-you item, one push, for the life of the installation.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE FUNCTION guard_owner_push_attempt_head_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.action_inbox_id IS DISTINCT FROM OLD.action_inbox_id
    OR NEW.link IS DISTINCT FROM OLD.link
    OR NEW.attempt_count<OLD.attempt_count
    OR NEW.attempt_count>OLD.attempt_count+1
    -- A delivery is permanent. There is no path back to 'pending' or
    -- 'reserved', which is the whole "exactly once" property. The same is true
    -- of a permanent failure: an item that has stopped trying stays stopped, so
    -- a caller cannot reopen an exhausted head and re-alert the phone.
    OR (OLD.state='delivered' AND NEW.state<>'delivered')
    OR (OLD.state='delivered' AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR (OLD.state='failed' AND NEW.state<>'failed')
    OR (OLD.state='failed' AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.state='reserved' AND NEW.state='reserved' AND NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
      AND NEW.attempt_count=OLD.attempt_count)
  ) THEN
    RAISE EXCEPTION 'owner push attempt head rejected';
  END IF;
  IF NEW.next_attempt_at>pg_catalog.statement_timestamp()+interval '1 day'
    OR NEW.updated_at>pg_catalog.statement_timestamp()+interval '1 day' THEN
    RAISE EXCEPTION 'owner push attempt head rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_owner_push_attempt_head_write() FROM PUBLIC;
CREATE TRIGGER control_owner_push_attempt_heads_guard BEFORE UPDATE ON control_owner_push_attempt_heads
  FOR EACH ROW EXECUTE FUNCTION public.guard_owner_push_attempt_head_write();
