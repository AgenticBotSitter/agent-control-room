BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON control_news_task_proposal_links FROM control_room_private_web';
  END IF;
END $$;
DROP TRIGGER control_news_task_proposal_links_no_truncate ON control_news_task_proposal_links;
DROP TRIGGER control_news_task_proposal_links_immutable ON control_news_task_proposal_links;
DROP TABLE control_news_task_proposal_links;
COMMIT;
