-- Inert locking support for the owner-trusted local CLI delivery path, which reads
-- its prior receipt with SELECT ... FOR UPDATE through the task-coordinator login.
-- FOR UPDATE needs a column UPDATE privilege; only this immutable false-valued lock
-- column is granted (db/roles/task_coordinator_roles.sql), as with the other
-- *_lock columns. The append-only trigger still rejects every real UPDATE.
ALTER TABLE control_worker_delivery_receipts ADD COLUMN coordinator_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_worker_delivery_receipts_coordinator_lock CHECK (coordinator_lock IS FALSE);
