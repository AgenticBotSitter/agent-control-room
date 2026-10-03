BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON control_module_install_approvals FROM control_room_private_web';
  END IF;
END $$;
LOCK TABLE control_module_install_approvals IN ACCESS EXCLUSIVE MODE;
DROP TRIGGER control_module_install_approvals_insert_guard ON control_module_install_approvals;
DROP TRIGGER control_module_install_approvals_no_truncate ON control_module_install_approvals;
DROP TRIGGER control_module_install_approvals_immutable ON control_module_install_approvals;
DROP TABLE control_module_install_approvals;
DROP FUNCTION guard_module_install_approval_insert();
COMMIT;
