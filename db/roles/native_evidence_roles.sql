-- OFFLINE OPERATOR SETUP ONLY. Startup verifies this profile; it never provisions it.
BEGIN;
CREATE ROLE control_room_native_evidence NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_native_evidence;
GRANT SELECT ON workspaces, control_identities, control_role_grants, projects,
  control_jobs, control_attempts, control_leases, control_harness_runs, control_harness_run_events,
  control_native_delivery_envelopes, control_native_transmission_intents, control_native_delivery_receipts,
  control_artifact_manifests, control_native_artifact_receipts, audit_events, control_audit_chain_heads
  TO control_room_native_evidence;
GRANT INSERT ON control_harness_runs, control_harness_run_events, control_artifact_manifests,
  control_native_artifact_receipts, audit_events, control_audit_chain_heads TO control_room_native_evidence;
GRANT UPDATE (result_lock) ON control_jobs TO control_room_native_evidence;
GRANT UPDATE (evidence_lock) ON control_attempts, control_leases TO control_room_native_evidence;
GRANT UPDATE (coordinator_lock) ON projects TO control_room_native_evidence;
GRANT UPDATE (state,last_sequence,run_digest,run_auth_tag,payload,updated_at,last_observed_at)
  ON control_harness_runs TO control_room_native_evidence;
GRANT UPDATE (head_hash,event_count,updated_at) ON control_audit_chain_heads TO control_room_native_evidence;
COMMIT;
