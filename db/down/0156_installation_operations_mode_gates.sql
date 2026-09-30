BEGIN;
LOCK TABLE control_attempts, work_batch_queue_admissions, control_native_task_queue IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  -- A live revision with a non-running mode is the only thing that makes these
  -- guards bite. Refuse the down migration while one exists: dropping the
  -- triggers would silently re-open the installation to new claims and starts
  -- that the owner is still relying on being refused.
  IF EXISTS (SELECT 1 FROM public.installation_operations_mode_revisions WHERE mode <> 'running') THEN
    RAISE EXCEPTION '0156 down migration refused: a non-running installation operations mode revision exists';
  END IF;
END $$;
DROP TRIGGER control_native_task_queue_operations_mode ON control_native_task_queue;
DROP FUNCTION guard_installation_operations_mode_start();
DROP TRIGGER work_batch_queue_admissions_operations_mode ON work_batch_queue_admissions;
DROP FUNCTION guard_installation_operations_mode_admission();
DROP TRIGGER control_attempts_operations_mode_claim ON control_attempts;
DROP FUNCTION guard_installation_operations_mode_claim();
COMMIT;
