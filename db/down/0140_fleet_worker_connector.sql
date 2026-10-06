BEGIN;
LOCK TABLE fleet_enrollment_codes, fleet_workers, fleet_worker_credentials, fleet_worker_presence,
  fleet_work_offers, fleet_claims, fleet_worker_events, fleet_results, fleet_result_files,
  fleet_result_reviews IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM fleet_enrollment_codes) OR EXISTS (SELECT 1 FROM fleet_workers)
    OR EXISTS (SELECT 1 FROM fleet_work_offers) OR EXISTS (SELECT 1 FROM fleet_claims) THEN
    RAISE EXCEPTION 'fleet worker connector down migration refused: records exist';
  END IF;
END $$;
DROP TRIGGER control_requests_fleet_gateway_guard ON control_requests;
DROP TRIGGER control_workflows_fleet_gateway_guard ON control_workflows;
DROP FUNCTION guard_fleet_gateway_workflow_write();
DROP TRIGGER control_jobs_fleet_gateway_guard ON control_jobs;
DROP FUNCTION guard_fleet_gateway_job_write();
DROP TRIGGER control_leases_fleet_gateway_guard ON control_leases;
DROP TRIGGER control_attempts_fleet_gateway_guard ON control_attempts;
DROP FUNCTION guard_fleet_gateway_attempt_lease_write();
DROP TRIGGER control_identities_fleet_gateway_bound ON control_identities;
DROP TRIGGER control_nodes_fleet_gateway_bound ON control_nodes;
DROP FUNCTION enforce_fleet_gateway_enrollment_bound();
DROP TRIGGER control_nodes_fleet_gateway_guard ON control_nodes;
DROP FUNCTION guard_fleet_gateway_node_write();
DROP TRIGGER control_role_grants_fleet_gateway_guard ON control_role_grants;
DROP FUNCTION guard_fleet_gateway_grant_write();
DROP TRIGGER control_identities_fleet_gateway_guard ON control_identities;
DROP FUNCTION guard_fleet_gateway_identity_write();
DROP TABLE fleet_result_reviews;
DROP TABLE fleet_result_files;
DROP TABLE fleet_results;
DROP TABLE fleet_worker_events;
DROP TABLE fleet_claims;
DROP TABLE fleet_work_offers;
DROP TABLE fleet_worker_presence;
DROP TABLE fleet_worker_credentials;
DROP TABLE fleet_workers;
DROP TABLE fleet_enrollment_codes;
DROP FUNCTION guard_fleet_result_review_insert();
DROP FUNCTION enforce_fleet_result_files_complete();
DROP FUNCTION guard_fleet_result_file_insert();
DROP FUNCTION guard_fleet_result_insert();
DROP FUNCTION guard_fleet_worker_event_insert();
DROP FUNCTION fleet_claim_is_live(text,text,text);
DROP FUNCTION enforce_fleet_claim_lease();
DROP FUNCTION guard_fleet_claim_insert();
DROP FUNCTION guard_fleet_offer_write();
DROP FUNCTION guard_fleet_presence_write();
DROP FUNCTION guard_fleet_credential_write();
DROP FUNCTION guard_fleet_worker_write();
DROP FUNCTION guard_fleet_enrollment_code_write();
DROP TABLE fleet_gateway_role_anchor;
COMMIT;
