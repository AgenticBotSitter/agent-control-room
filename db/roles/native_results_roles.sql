-- OFFLINE OPERATOR SETUP ONLY. Never executed by application startup.
-- One separate LOGIN may inherit only this fresh NOLOGIN role, with no ownership/admin rights.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_native_results') THEN
    CREATE ROLE control_room_native_results NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE control_room_native_results NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_native_results;
GRANT SELECT ON workspaces, control_identities, control_role_grants, projects,
  control_jobs, control_workflows, control_requests, control_task_execution_plans,
  control_attempts, control_task_model_selections,
  control_harness_runs, control_harness_run_events, control_codex_result_publications, control_native_review_plans,
  control_artifact_manifests, control_native_artifact_receipts,
  control_completion_gate_records, control_completion_gate_integrity, audit_events,
  control_audit_chain_heads, control_idea_sessions, control_idea_canonical_task_links,
  control_idea_contributions, control_idea_decisions TO control_room_native_results;
GRANT INSERT ON control_native_review_plans, control_completion_gate_records,
  audit_events, control_audit_chain_heads, control_idea_contributions TO control_room_native_results;
GRANT UPDATE (result_lock) ON control_jobs TO control_room_native_results;
GRANT UPDATE (coordinator_lock) ON control_harness_runs, projects TO control_room_native_results;
GRANT UPDATE (results_lock) ON control_native_review_plans, control_native_artifact_receipts TO control_room_native_results;
GRANT UPDATE (web_lock) ON control_completion_gate_records TO control_room_native_results;
GRANT UPDATE (web_lock, revision, record_count, state_digest, state_auth_tag)
  ON control_completion_gate_integrity TO control_room_native_results;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_native_results;
GRANT EXECUTE ON FUNCTION is_work_intake_session() TO control_room_native_results;
GRANT SELECT ON work_intake_tenant_binding TO control_room_native_results;
-- Result-file catalog (0206-0208). This login publishes results, so it records
-- the catalog row for the attempt it just published: one declared set, then its
-- file, then the set stored. It cannot accept, quarantine or delete anything,
-- and 0207's producer trigger refuses any native set without a matching
-- published receipt, so this is "record what I published", not "claim I did".
-- SELECT as well as INSERT: 0206's deferred completeness trigger runs as the
-- invoker and counts this login's own files when the set commits, so without
-- the read every publication would fail 42501 at COMMIT rather than publish.
GRANT SELECT ON control_result_file_sets, control_result_files TO control_room_native_results;
GRANT INSERT ON control_result_file_sets, control_result_files TO control_room_native_results;
-- The two state moves a publisher makes: a file's bytes are on disk, and the set
-- now matches them. `stored_at` is CHECK-pinned to the state column, so this
-- cannot write a timestamp that disagrees with the state it accompanies.
GRANT UPDATE (state, stored_at) ON control_result_files TO control_room_native_results;
GRANT UPDATE (state, stored_at, manifest_digest) ON control_result_file_sets TO control_room_native_results;
-- Text-copy derivations (0212-0213). This login records what it converted: one
-- finished row per attempt, carrying the source digest the converter actually
-- hashed and a reference to the catalog file it produced. 0212's insert guard
-- refuses any row whose source is not a real catalog file with that digest, and
-- refuses a 'succeeded' row that does not name a STORED derived file in the
-- same set, so this INSERT is permission to record a conversion, not to claim
-- one. No UPDATE — a derivation is never rewritten — and no DELETE.
GRANT SELECT, INSERT ON control_text_copy_derivations TO control_room_native_results;

COMMIT;
