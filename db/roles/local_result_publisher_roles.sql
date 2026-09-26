-- OFFLINE OPERATOR SETUP ONLY. Startup verifies this profile; it never provisions it.
-- Fifth Mac-local login (owner decision 2026-09-25). Rights are exactly what
-- createOwnerTrustedLocalCliPublishV1 (run registration + workflowIdForJob)
-- and publishDurableResultV1 (with the durable reservation Postgres port)
-- execute, in one transaction. Review-tray registration
-- (DurableResultReviewSubmissionServiceV1) is NOT here: it runs under the
-- existing control_room_native_results login.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_local_result_publisher') THEN
    CREATE ROLE control_room_local_result_publisher NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE control_room_local_result_publisher NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_local_result_publisher;
-- Plain reads: workflowIdForJob and verifyRecordedIdentity look up control_jobs,
-- control_attempts and adapter_registry with no locking clause.
-- Startup installation check (verifyDatabase): the owner's workspace, identity and
-- active owner grant, read-only, as every other results-type login reads them.
GRANT SELECT ON workspaces, control_identities, control_role_grants TO control_room_local_result_publisher;
GRANT SELECT ON control_jobs, control_attempts, adapter_registry,
  control_harness_runs, control_harness_run_events, control_artifact_manifests, control_native_artifact_receipts,
  control_durable_result_write_reservations, control_native_review_plans,
  audit_events, control_audit_chain_heads
  TO control_room_local_result_publisher;
GRANT INSERT ON control_harness_runs, control_artifact_manifests, control_native_artifact_receipts,
  control_durable_result_write_reservations, control_native_review_plans,
  audit_events, control_audit_chain_heads
  TO control_room_local_result_publisher;
-- HarnessRunStoreV1.create() takes `SELECT ... FOR UPDATE` on control_harness_runs
-- before every insert (replay check); ensureNeutralReviewPlan does the same on
-- control_native_review_plans. Neither table is ever really updated by this role.
GRANT UPDATE (publisher_lock) ON control_harness_runs TO control_room_local_result_publisher;
GRANT UPDATE (publisher_lock) ON control_native_review_plans TO control_room_local_result_publisher;
-- The durable reservation port genuinely mutates these five columns
-- (DurableReservationPostgresPort.compareAndSwap); identity and created_at stay immutable.
GRANT UPDATE (state,contract_digest,reservation,auth_tag,updated_at)
  ON control_durable_result_write_reservations TO control_room_local_result_publisher;
GRANT UPDATE (head_hash,event_count,updated_at) ON control_audit_chain_heads TO control_room_local_result_publisher;
COMMIT;
