-- OFFLINE OPERATOR SETUP ONLY. Startup verifies this profile; it never provisions it.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_native_evidence') THEN
    CREATE ROLE control_room_native_evidence NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE control_room_native_evidence NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_native_evidence;
GRANT SELECT ON workspaces, control_identities, control_role_grants, projects, control_manual_project_heads,
  control_jobs, control_attempts, control_leases, control_nodes, control_node_keys, control_harness_runs, control_harness_run_events,
  control_native_delivery_envelopes, control_native_transmission_intents, control_native_delivery_receipts,
  control_worker_delivery_receipts, control_worktree_change_audit_plans,
  control_task_execution_plans, control_codex_activation_transmission_intents, control_codex_result_publications,
  control_artifact_manifests, control_native_artifact_receipts, control_native_result_write_reservations,
  control_durable_result_write_reservations,
  audit_events, control_audit_chain_heads
  TO control_room_native_evidence;
GRANT INSERT ON control_harness_runs, control_harness_run_events, control_codex_result_publications, control_artifact_manifests,
  control_native_artifact_receipts, control_native_result_write_reservations,
  control_worktree_change_audit_plans,
  control_durable_result_write_reservations,
  audit_events, control_audit_chain_heads TO control_room_native_evidence;
GRANT UPDATE (state,contract_digest,reservation,auth_tag,updated_at)
  ON control_native_result_write_reservations TO control_room_native_evidence;
GRANT UPDATE (state,contract_digest,reservation,auth_tag,updated_at)
  ON control_durable_result_write_reservations TO control_room_native_evidence;
GRANT UPDATE (result_lock) ON control_jobs TO control_room_native_evidence;
GRANT UPDATE (evidence_lock) ON control_attempts, control_leases TO control_room_native_evidence;
GRANT UPDATE (coordinator_lock) ON projects, control_manual_project_heads, control_nodes, control_node_keys
  TO control_room_native_evidence;
GRANT UPDATE (state,last_sequence,run_digest,run_auth_tag,payload,updated_at,last_observed_at)
  ON control_harness_runs TO control_room_native_evidence;
GRANT UPDATE (head_hash,event_count,updated_at) ON control_audit_chain_heads TO control_room_native_evidence;
COMMIT;
