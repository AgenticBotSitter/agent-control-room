import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const functionStatement = /CREATE(?: OR REPLACE)? FUNCTION\s+([a-z0-9_]+)\s*\([^)]*\)\s+RETURNS[\s\S]*?\$\$[\s\S]*?\$\$\s*;/giu;
const hardenedSearchPath = /SET\s+search_path\s*=\s*pg_catalog\s*,\s*public\s*,\s*pg_temp(?=\s+(?:AS|\$\$))/iu;
const legacyUnpinnedTriggers = [
  "0002_allocation_simulation_audit.sql:reject_append_only_mutation",
  "0003_canonical_domain_delivery.sql:validate_control_payload_mirror",
  "0004_cr4b_review_hardening.sql:validate_control_payload_mirror",
  "0006_cr4d_audit_chain.sql:validate_audit_chain_fields",
  "0008_cr5a_node_protocol_identity.sql:protect_enrollment_token",
  "0008_cr5a_node_protocol_identity.sql:protect_enrollment_challenge",
  "0008_cr5a_node_protocol_identity.sql:protect_node_key_identity",
  "0008_cr5a_node_protocol_identity.sql:reject_node_key_delete",
  "0040_cr14b_private_web_lock_support.sql:protect_private_web_session",
  "0041_cr14c_private_task_proposals.sql:guard_private_web_proposal_insert",
  "0043_cr14c_owner_result_review.sql:guard_private_web_quality_insert",
  "0046_cr14c_coordinator_lock_support.sql:guard_task_coordinator_outbox_insert",
  "0053_cr14c_owner_result_verification.sql:guard_private_web_quality_insert",
  "0054_cr14c_quality_coordinator.sql:guard_task_coordinator_quality_insert",
  "0055_cr14c_native_result_writer.sql:guard_native_results_gate_insert",
  "0071_cr15b_native_result_write_reservations.sql:guard_native_result_write_reservation_update",
  "0075_project_coordination_authority.sql:guard_project_coordinator_head_update",
  "0075_project_coordination_authority.sql:guard_project_delegation_policy_update",
  "0076_project_work_resource_admission.sql:guard_attempt_resource_admission_update",
  "0077_durable_result_write_reservations.sql:guard_durable_result_write_reservation_update",
  "0078_github_webhook_replays.sql:guard_github_webhook_replay_update",
  "0078_github_webhook_replays.sql:guard_github_webhook_replay_delete",
  "0079_github_worker_wake_hints.sql:guard_github_worker_wake_hint_update",
  "0079_github_worker_wake_hints.sql:guard_github_worker_wake_hint_delete",
  "0086_mac_local_owner_review_profile.sql:guard_private_web_quality_insert",
  "0087_mac_local_fleet_signals.sql:guard_task_coordinator_fleet_signal",
  "0092_phase2b_mac_local_quality_profile.sql:guard_private_web_quality_insert",
  "0092_phase2b_mac_local_quality_profile.sql:guard_native_results_gate_insert",
];

test("all migration functions preserve the pinned search-path boundary", async () => {
  const names = (await readdir("db/migrations"))
    .filter(name => name.endsWith(".sql"))
    .sort();
  const missing = [];
  for (const name of names) {
    const source = await readFile(`db/migrations/${name}`, "utf8");
    for (const match of source.matchAll(functionStatement)) {
      const statement = match[0];
      if (/RETURNS\s+trigger\b/iu.test(statement) || /SECURITY\s+DEFINER/iu.test(statement)) {
        if (!hardenedSearchPath.test(statement)) missing.push(`${name}:${match[1]}`);
      }
    }
  }
  assert.deepEqual(missing, legacyUnpinnedTriggers,
    `unexpected unsafe function search_path set: ${missing.join(", ")}`);
});

test("production restricted roles cannot create temporary database objects", async () => {
  const [provision, roles, databaseAcl] = await Promise.all([
    readFile("db/roles/production_provision.sql", "utf8"),
    readFile("db/roles/production_roles.sql", "utf8"),
    readFile("db/roles/private_web_database.sql", "utf8")]);
  for (const source of [provision, roles, databaseAcl]) {
    assert.match(source, /REVOKE\s+(?:CREATE,\s*)?TEMPORARY\s+ON\s+DATABASE\s+%I\s+FROM\s+PUBLIC/iu);
  }
  const expectedRoles = new Map([
    [roles, ["control_room_application", "control_room_reader", "control_room_backup",
      "control_room_schedule_admissions", "control_room_github_broker", "control_room_work_intake"]],
    [provision, ["control_room_application", "control_room_app", "control_room_schedule_admissions",
      "control_room_scheduler", "control_room_github_broker", "control_room_work_intake",
      "control_room_work_intake_agent"]],
  ]);
  for (const [source, roleNames] of expectedRoles) {
    for (const role of roleNames) {
      assert.match(source,
        new RegExp(`REVOKE\\s+TEMPORARY\\s+ON\\s+DATABASE\\s+%I\\s+FROM\\s+${role}\\b`, "u"));
    }
  }
});

test("work-intake shared-ledger policies remain restrictive and session-scoped", async () => {
  const migration = await readFile("db/migrations/0093_work_batch_intake.sql", "utf8");
  const policy = name => migration.match(new RegExp(`CREATE POLICY\\s+${name}\\b[\\s\\S]*?;`, "u"))?.[0] ?? "";
  const normalize = source => source.replace(/\s+/gu, " ").trim();
  const idempotency = policy("control_idempotency_work_intake_scope");
  const audit = policy("audit_events_work_intake_scope");
  assert.equal(normalize(idempotency), normalize(`
    CREATE POLICY control_idempotency_work_intake_scope ON control_idempotency
      AS RESTRICTIVE FOR ALL
      USING (NOT public.is_work_intake_session()
        OR operation_scope ~ '^work-batches\\.propose/v1:[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$')
      WITH CHECK (NOT public.is_work_intake_session()
        OR operation_scope ~ '^work-batches\\.propose/v1:[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$');`));
  assert.equal(normalize(audit), normalize(`
    CREATE POLICY audit_events_work_intake_scope ON audit_events
      AS RESTRICTIVE FOR ALL
      USING (NOT public.is_work_intake_session()
        OR (id ~ '^audit:work-intake[-:]' AND action IN (
          'work_batches.propose','work_batches.propose.replayed',
          'work_batches.propose.refused','work_batches.action.refused')))
      WITH CHECK (NOT public.is_work_intake_session()
        OR (id ~ '^audit:work-intake[-:]' AND action IN (
          'work_batches.propose','work_batches.propose.replayed',
          'work_batches.propose.refused','work_batches.action.refused')));`));
});
