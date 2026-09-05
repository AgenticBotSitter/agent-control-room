import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { taskDraft } from "./helpers/web-task";
import { instant } from "./hermes-native-fixture";
import { sha256Digest } from "../src/security";
import { verifyPrivateDatabase, verifyTaskCoordinatorDatabase, readPrivateWebSchemaDigest, privateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import type { DatabaseClient } from "../src/persistence/database";

async function fixture() {
  const f = await taskAssignmentFixture();
  const source = await f.tasks.propose(f.identity, f.profile.projectId, taskDraft, "coordinator-new-source-001");
  await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await f.raw.exec(`CREATE ROLE coordinator_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_task_coordinator TO coordinator_test;
    SET SESSION AUTHORIZATION coordinator_test;
    SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
    SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
  const scope = { ...f.scope, ownerIdentityId: "identity:test", issuer: f.accessTrust.issuer };
  const config = { host: "127.0.0.1" as const, port: 5432, database: "template1", username: "coordinator_test", password: "synthetic-only", majorVersion: 17 as const };
  // Same existing PGlite limitation as the web-role fixture: only TEMP metadata is injected.
  // The unmodified production preflight still rejects that real PGlite metadata.
  const checked: DatabaseClient = { ...f.db, transaction: work => f.db.transaction(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
      return result;
    },
  })) };
  return { ...f, source, scope, config, checked, verify: () => verifyTaskCoordinatorDatabase(checked, config, scope, instant + 8000) };
}

test("exact coordinator role passes its own gate but not the web gate and performs planning, assignment and expiry", async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal(await readPrivateWebSchemaDigest(f.db), privateWebSchemaDigest);
  await assert.rejects(verifyTaskCoordinatorDatabase(f.db, f.config, f.scope, instant + 8000), /preflight_failed/);
  await f.verify(); await assert.rejects(verifyPrivateDatabase(f.checked, f.config, f.scope, instant + 8000), /preflight_failed/);
  const planned = await f.planner.plan(f.identity, f.profile.projectId, f.source.receipt.jobId, sha256Digest(taskDraft));
  assert.equal(planned.replayed, false);
  const saved = await f.coordinator.assign(f.identity, f.profile.projectId, planned.receipt.jobId, f.route.nodeId, planned.receipt.inputDigest);
  assert.equal(saved.replayed, false); assert.equal(saved.receipt.startsWork, false);
  assert.equal((await f.coordinator.assign(f.identity, f.profile.projectId, planned.receipt.jobId, f.route.nodeId, planned.receipt.inputDigest)).replayed, true);
  const expired = await f.create(f.db, () => instant + 70000).expire(f.identity, f.profile.projectId, planned.receipt.jobId, planned.receipt.inputDigest);
  assert.equal(expired.receipt.leaseState, "expired");
});

test("coordinator lock columns cannot change authority and unrelated reads/writes remain denied", async t => {
  const f = await fixture(); t.after(f.close);
  for (const table of ["tenants", "control_nodes", "control_node_keys", "control_manual_project_heads", "projects"]) {
    await f.db.query(`UPDATE ${table} SET coordinator_lock=false`);
    await assert.rejects(f.db.query(`UPDATE ${table} SET coordinator_lock=true`));
  }
  for (const sql of ["UPDATE control_identities SET state='suspended'", "UPDATE control_role_grants SET allowed_actions='[\"*\"]'",
    "UPDATE control_node_keys SET valid_until=valid_until+interval '1 day'", "UPDATE control_nodes SET state='active'",
    "UPDATE control_manual_project_heads SET lifecycle='active'", "UPDATE control_node_fleet_current SET expires_at=expires_at+interval '1 day'",
    "UPDATE control_completion_gate_integrity SET revision=revision+1", "DELETE FROM control_attempts", "TRUNCATE control_outbox",
    "UPDATE audit_events SET actor_id='identity:other'", "SELECT * FROM control_approvals", "SELECT * FROM node_protocol_connections",
    "SELECT * FROM control_harness_runs", "CREATE TABLE coordinator_extra(id text)"])
    await assert.rejects(f.db.query(sql), sql);
  await assert.rejects(f.db.query(`INSERT INTO control_outbox(id,tenant_id,topic,aggregate_type,aggregate_id,idempotency_key,status,available_at,payload)
    VALUES('outbox:forbidden','tenant:test','job.dispatch','job','job:test','forbidden','pending',now(),'{}')`), /coordinator outbox insert rejected/);
});

test("coordinator preflight rejects extra or missing privileges, memberships, disabled guards and stale ownership", async t => {
  for (const change of [
    "GRANT UPDATE (state) ON control_nodes TO control_room_task_coordinator",
    "GRANT UPDATE (valid_until) ON control_node_keys TO control_room_task_coordinator",
    "REVOKE UPDATE (coordinator_lock) ON tenants FROM control_room_task_coordinator",
    "GRANT INSERT ON control_approvals TO control_room_task_coordinator",
    "CREATE ROLE coordinator_extra; GRANT coordinator_extra TO control_room_task_coordinator",
    "ALTER TABLE control_outbox DISABLE TRIGGER control_outbox_task_coordinator_insert",
    "ALTER TABLE control_nodes DROP CONSTRAINT control_nodes_coordinator_lock",
    "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO control_room_task_coordinator",
    "GRANT MAINTAIN ON control_jobs TO control_room_task_coordinator",
    "UPDATE control_identities SET state='suspended'",
  ]) await t.test(change.split(" ").slice(0, 5).join(" "), async t => {
    const f = await fixture(); t.after(f.close); await f.verify();
    await f.raw.exec(`SET SESSION AUTHORIZATION postgres; ${change}; SET SESSION AUTHORIZATION coordinator_test`);
    await assert.rejects(f.verify(), /preflight_failed/);
  });
});
