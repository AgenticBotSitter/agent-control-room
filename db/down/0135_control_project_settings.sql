BEGIN;
LOCK TABLE control_project_settings IN ACCESS EXCLUSIVE MODE;
DROP TABLE control_project_settings;
COMMIT;
