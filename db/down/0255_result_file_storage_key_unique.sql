-- Revoke exactly what 0255 granted: the uniqueness of a storage key across
-- every tenant and project. 0206's own `UNIQUE (tenant_id, project_id,
-- storage_key)` is NOT dropped — 0255 added beside it, and a rollback returns to
-- the pre-0255 state, where two rows in different tenants could still share one
-- key and two rows in the same tenant and project still could not.

ALTER TABLE control_result_files
  DROP CONSTRAINT control_result_files_storage_key_unique;