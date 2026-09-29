BEGIN;
LOCK TABLE work_batches, work_batch_revisions, work_batch_items, control_action_inbox IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM work_batch_items)
    OR EXISTS (SELECT 1 FROM work_batch_revisions WHERE revision>1)
    OR EXISTS (SELECT 1 FROM work_batches WHERE state<>'proposed' OR version<>1)
    OR EXISTS (SELECT 1 FROM control_action_inbox WHERE id LIKE 'attention:work-batch:%') THEN
    RAISE EXCEPTION 'work batch owner approval down migration refused: records exist';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_work_intake') THEN
    EXECUTE 'REVOKE INSERT ON control_action_inbox FROM control_room_work_intake';
    EXECUTE 'REVOKE SELECT ON work_batch_items FROM control_room_work_intake';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT ON work_batches, work_batch_revisions, work_batch_items, control_action_inbox FROM control_room_private_web';
    EXECUTE 'REVOKE INSERT ON work_batch_revisions, work_batch_items FROM control_room_private_web';
    EXECUTE 'REVOKE UPDATE (state, payload) ON control_action_inbox FROM control_room_private_web';
    EXECUTE 'REVOKE UPDATE (state, approval_identity_id, approved_at, decision_reason_code, decision_digest, decision_auth_tag, version, updated_at) ON work_batches FROM control_room_private_web';
  END IF;
END $$;
DROP TRIGGER control_action_inbox_work_batch_guard ON control_action_inbox;
DROP FUNCTION guard_work_batch_notification_insert();
DROP TRIGGER control_action_inbox_work_batch_update_guard ON control_action_inbox;
DROP FUNCTION guard_work_batch_notification_update();
DROP TRIGGER work_batches_owner_update ON work_batches;
DROP FUNCTION guard_work_batch_owner_update();
DROP TRIGGER work_batch_items_truncate_guard ON work_batch_items;
DROP TRIGGER work_batch_items_append_only ON work_batch_items;
DROP TRIGGER work_batch_items_guard ON work_batch_items;
DROP FUNCTION guard_work_batch_item_insert();
DROP TABLE work_batch_items;
ALTER TABLE work_batches DROP COLUMN decision_auth_tag, DROP COLUMN decision_digest, DROP COLUMN auth_material_version;
CREATE OR REPLACE FUNCTION guard_initial_work_batch_revision_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.revision<>1 OR NEW.reason_code<>'submitted' OR NOT EXISTS (
    SELECT 1 FROM public.work_batches b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.batch_id
      AND b.proposed_by_identity_id=NEW.edited_by_identity_id AND b.proposal=NEW.proposal
      AND b.batch_digest=NEW.revision_digest
  ) THEN
    RAISE EXCEPTION 'initial work batch revision insert rejected';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
