-- OFFLINE OPERATOR SETUP ONLY. Never executed by application startup.
-- The fleet gateway is the control-side service that remote machine
-- connectors talk to. Its LOGIN may inherit ONLY this NOLOGIN role, with no
-- ADMIN option and no object ownership. Workers never receive this login.
--
-- Migration 0140 confines this class further: on shared canonical tables it
-- may only write rows tied to a fleet enrollment, a guarded fleet claim, or an
-- owner decision. It holds no grant on approvals, reviews, owner sessions,
-- delivery, results publication or settings.
BEGIN;
CREATE ROLE control_room_fleet_gateway NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
CREATE ROLE control_room_fleet_owner_authority NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_fleet_gateway;
GRANT USAGE ON SCHEMA public TO control_room_fleet_owner_authority;
-- The marker that identifies this privilege class to the 0140 guards.
GRANT SELECT ON fleet_gateway_role_anchor TO control_room_fleet_gateway;
GRANT EXECUTE ON FUNCTION fleet_claim_is_live(text,text,text) TO control_room_fleet_gateway;
GRANT EXECUTE ON FUNCTION redeem_fleet_enrollment(text,text,text,text,timestamptz) TO control_room_fleet_gateway;
-- The shared audit table's work-intake row policy reads these, as for the
-- coordinator and web roles. Neither grants any intake authority.
GRANT EXECUTE ON FUNCTION is_work_intake_session() TO control_room_fleet_gateway;
GRANT SELECT ON work_intake_tenant_binding TO control_room_fleet_gateway;
GRANT SELECT ON tenants, workspaces, projects, control_manual_project_heads, control_identities,
  control_role_grants, control_nodes, control_requests, control_workflows, control_jobs, control_attempts,
  control_leases, control_job_dependencies, control_task_model_selections, control_task_declared_scopes,
  control_assignment_lease_scopes, control_transition_events, control_outbox, audit_events,
  control_audit_chain_heads, fleet_enrollment_codes, fleet_workers, fleet_worker_credentials,
  fleet_enrollment_redemptions, fleet_worker_presence, fleet_work_offers, fleet_claims, fleet_worker_events, fleet_results,
  fleet_result_files, fleet_result_reviews TO control_room_fleet_gateway;
-- Enrollment: one node, one proposal-only agent identity and grant, the worker
-- row and its first credential, all in the code-consuming transaction.
GRANT INSERT ON control_nodes, control_identities, control_role_grants, fleet_workers,
  fleet_worker_credentials, fleet_worker_presence TO control_room_fleet_gateway;
GRANT UPDATE (state, ended_at) ON fleet_worker_credentials TO control_room_fleet_gateway;
GRANT UPDATE (last_seen_at, connector_version, platform) ON fleet_worker_presence TO control_room_fleet_gateway;
-- Revocation clean-up after the owner revoked the worker on the web path.
GRANT UPDATE (state, version, payload, updated_at) ON control_nodes TO control_room_fleet_gateway;
GRANT UPDATE (state, updated_at) ON control_identities TO control_room_fleet_gateway;
GRANT UPDATE (revoked_at, updated_at) ON control_role_grants TO control_room_fleet_gateway;
-- The shared canonical claim path and its lifecycle transitions.
GRANT INSERT ON control_attempts, control_leases, control_transition_events, control_outbox,
  audit_events, control_audit_chain_heads, control_assignment_lease_scopes,
  fleet_claims, fleet_worker_events, fleet_results, fleet_result_files TO control_room_fleet_gateway;
GRANT DELETE ON control_assignment_lease_scopes TO control_room_fleet_gateway;
GRANT UPDATE (state, version, payload, updated_at) ON control_requests, control_workflows,
  control_jobs, control_attempts, control_leases TO control_room_fleet_gateway;
GRANT UPDATE (expires_at, renewed_at) ON control_leases TO control_room_fleet_gateway;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_fleet_gateway;
-- 0111: a hand-off's required note is presented on the owner's task timeline,
-- exactly like the other lifecycle writers granted in 0107.
GRANT SELECT, INSERT ON control_project_event_stream_heads, control_project_events TO control_room_fleet_gateway;
GRANT UPDATE (last_sequence, last_event_digest, head_auth_tag, updated_at) ON control_project_event_stream_heads TO control_room_fleet_gateway;
-- Row-lock rights only, matching the coordinator's lock order.
GRANT UPDATE (coordinator_lock) ON tenants, control_manual_project_heads, projects TO control_room_fleet_gateway;
-- The 0156 claim guard is SECURITY INVOKER and reads the installation
-- operations mode as whoever inserts the attempt, so a claim login must be able
-- to read the mode or every claim it makes is refused, running included.
GRANT SELECT ON installation_operations_mode_revisions TO control_room_fleet_gateway;

-- The ordinary web login can present fleet data but cannot write any owner
-- decision. A separate protected login inherits only the owner-authority role
-- below; the browser never receives that login.
GRANT SELECT ON fleet_enrollment_codes, fleet_workers, fleet_worker_credentials, fleet_worker_presence,
  fleet_enrollment_redemptions, fleet_work_offers, fleet_claims, fleet_worker_events, fleet_results, fleet_result_files,
  fleet_result_reviews TO control_room_private_web;

-- 0209-0211: the chunked upload path and the combine-input bindings.
--
-- The gateway may RESERVE an upload, send its chunks, finalise it and publish
-- the set's receipt — the four verbs one claim needs to get its files onto the
-- Mac. Every one of those writes is bounded by 0209/0210's own guards, which
-- re-check 0140's `fleet_claim_is_live` on each call, so a claim that has died
-- cannot keep filling an upload.
--
-- ON THE CATALOG: the gateway does hold SELECT on `control_result_file_sets`
-- and `control_result_files`, and the reason is that 0209's reservation guard
-- is SECURITY INVOKER and reads both to pin the promise to the owner-approved
-- row. A guard that could not read them would fail closed on every reservation,
-- which is not a safer installation, it is a broken one.
--
-- That does not weaken §2.6 H2, and it is worth saying exactly why, because
-- "the gateway can read the catalog" sounds like the hole H2 describes and is
-- not. H2 is about a worker being able to NAME another project's file, or to
-- learn from an answer whether a digest already exists. Three things prevent
-- both here, and none of them is the absence of a grant:
--
--   * Every query the gateway makes carries its own claim's project, job and
--     attempt, and 0209's guard re-checks all three against `fleet_claims`
--     before it writes anything. A row about a file that is not this claim's
--     promised output is not addressable.
--   * The storage key is still DERIVED, by 0206, from the tenant, the project,
--     the file's own id and its digest. The gateway can read the key but cannot
--     choose one, so reading it reveals nothing it could not already compute.
--   * There is still no "do you already have that" answer anywhere: no column,
--     no index and no query. A gateway that reads the whole catalog learns the
--     same fact a second copy of this project would — a digest and a name — and
--     cannot turn either into a cross-project read, because every read the byte
--     store answers is keyed on the caller's own project.
GRANT SELECT ON control_result_file_sets, control_result_files TO control_room_fleet_gateway;
GRANT SELECT, INSERT ON control_result_upload_sessions, control_result_upload_chunks
  TO control_room_fleet_gateway;
-- It reads the declarations and bindings, and writes neither. A declared output
-- or input is the OWNER's approval artefact, bound by 0209/0211's guards to a
-- live owner grant, and the binding is written on the same path that accepts the
-- producer's result. A machine that could write either could promise itself
-- somewhere to send files, or hand itself a file to combine.
GRANT SELECT ON control_task_declared_outputs, control_task_declared_inputs, control_job_artifact_inputs
  TO control_room_fleet_gateway;
-- The set's publication receipt, written by the same claim. A gateway may not
-- publish a native-text set (it is not the native path) and 0210's guard
-- refuses any set whose every file lacks a published upload session.
GRANT SELECT, INSERT ON control_result_publications TO control_room_fleet_gateway;
-- Finalise moves a session between its states, and Stop voids one. Both are
-- UPDATE, both on three columns, and both re-checked by 0209's guard: no other
-- column of a session is mutable by any role.
GRANT UPDATE (state, received_at, published_at, voided_at, void_reason)
  ON control_result_upload_sessions TO control_room_fleet_gateway;
-- A file becomes 'stored' only through its own published upload (0210's guard),
-- and a set becomes 'stored' only with its publication receipt. A column grant
-- cannot say "only fleet, only forward", so 0210's two producer-state guards
-- confine THIS role to the single edge declared -> stored on a fleet set and its
-- files; every other catalog move (quarantine, missing, a re-stamp) is refused
-- to it, and db/down/0210 revokes these grants with those guards. Two columns each,
-- and no DELETE anywhere: the catalog is append-only and this role cannot write
-- a name, a digest, a size, a storage key or a producer. A column grant is enough
-- to run the UPDATE - the role may read the tenant, set and ordinal columns it
-- filters on, and a BEFORE trigger still fires under a column grant, which is
-- proved rather than assumed in tests/result-upload-ingress-postgres.test.ts.
GRANT UPDATE (state, stored_at) ON control_result_files TO control_room_fleet_gateway;
GRANT UPDATE (state, stored_at, manifest_digest) ON control_result_file_sets TO control_room_fleet_gateway;
-- The owner-facing declarations, bindings, upload sessions and publication
-- receipts the gateway reaches above are the same rows the web login reads for
-- the owner's approval screen and Project Files. That grant is in
-- private_web_roles.sql and is deliberately NOT repeated here: the upgrade
-- grant reader treats one (role, object, column, privilege) tuple granted by
-- two role files as a duplicate and refuses the whole batch.

GRANT EXECUTE ON FUNCTION is_work_intake_session() TO control_room_fleet_owner_authority;
GRANT SELECT ON work_intake_tenant_binding TO control_room_fleet_owner_authority;
GRANT SELECT ON tenants, workspaces, projects, control_manual_project_heads,
  control_identities, control_role_grants, control_web_sessions, control_requests, control_workflows,
  control_jobs, control_attempts, control_leases, audit_events, control_audit_chain_heads,
  fleet_enrollment_codes, fleet_enrollment_redemptions, fleet_workers, fleet_worker_credentials,
  fleet_worker_presence, fleet_work_offers, fleet_claims, fleet_worker_events, fleet_results,
  fleet_result_files, fleet_result_reviews TO control_room_fleet_owner_authority;
GRANT INSERT ON control_web_sessions, audit_events, control_audit_chain_heads,
  fleet_enrollment_codes, fleet_work_offers, fleet_result_reviews TO control_room_fleet_owner_authority;
GRANT UPDATE (web_lock) ON workspaces, control_identities, control_role_grants TO control_room_fleet_owner_authority;
GRANT UPDATE (revoked_at) ON control_web_sessions TO control_room_fleet_owner_authority;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_fleet_owner_authority;
GRANT UPDATE (state) ON fleet_enrollment_codes TO control_room_fleet_owner_authority;
GRANT UPDATE (state, revoked_at, revoked_by_identity_id) ON fleet_workers TO control_room_fleet_owner_authority;
GRANT UPDATE (state, ended_at) ON fleet_worker_credentials TO control_room_fleet_owner_authority;
GRANT UPDATE (state, closed_at, close_reason) ON fleet_work_offers TO control_room_fleet_owner_authority;
COMMIT;
