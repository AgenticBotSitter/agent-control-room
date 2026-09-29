BEGIN;
LOCK TABLE control_idea_promotion_task_links IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_idea_promotion_task_links) THEN
    RAISE EXCEPTION 'idea promotion task links down migration refused: records exist';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON control_idea_promotion_task_links FROM control_room_private_web';
  END IF;
END $$;
DROP TRIGGER control_idea_promotion_task_links_no_truncate ON control_idea_promotion_task_links;
DROP TRIGGER control_idea_promotion_task_links_append_only ON control_idea_promotion_task_links;
DROP TABLE control_idea_promotion_task_links;
COMMIT;
