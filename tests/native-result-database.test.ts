import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion";
import { verifyNativeResultDatabase, verifyPrivateDatabase, verifyTaskCoordinatorDatabase,
  readPrivateWebSchemaDigest, privateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

async function fixture() {
  // Complete result/profile/target are privileged synthetic setup for SQL denial tests only.
  // task-result-coordinator.test.ts separately exercises actual restricted registration and submission.
  const x = await nativeQualityCompletionFixture();
  try {
    await x.f.raw.exec(await readFile("db/roles/native_results_roles.sql", "utf8"));
    await x.f.raw.exec(`CREATE ROLE result_database_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT control_room_native_results TO result_database_test;
      SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
      SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
    const client: DatabaseClient = {
      query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
      transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
      transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(async tx => {
        await tx.query("SET LOCAL SESSION AUTHORIZATION result_database_test"); return work(tx);
      }, check),
    };
    const adjusted = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      // Existing, documented PGlite limitation only; no role/grant/guard metadata is simulated.
      if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false })); return result;
    } });
    const checked: DatabaseClient = { ...client, transaction: work => client.transaction(tx => work(adjusted(tx))) };
    const config = { host: "127.0.0.1" as const, port: 5432, database: "template1", username: "result_database_test",
      password: "synthetic-only", majorVersion: 17 as const };
    const scope = { ...x.f.scope, ownerIdentityId: "identity:test", issuer: x.f.accessTrust.issuer };
    return { ...x, client, checked, config, scope, verify: () => verifyNativeResultDatabase(checked, config, scope, x.f.clock()) };
  } catch (error) { await x.close(); throw error; }
}

test("the actual native-result login passes only its exact role gate with the known PGlite TEMP exception", async t => {
  const x = await fixture(); t.after(x.close);
  assert.equal(await readPrivateWebSchemaDigest(x.client), privateWebSchemaDigest);
  await assert.rejects(verifyNativeResultDatabase(x.client, x.config, x.scope, x.f.clock()), /preflight_failed/);
  await x.verify();
  await assert.rejects(verifyPrivateDatabase(x.checked, x.config, x.scope, x.f.clock()), /preflight_failed/);
  await assert.rejects(verifyTaskCoordinatorDatabase(x.checked, x.config, x.scope, x.f.clock()), /preflight_failed/);
  const identity = (await x.client.query<{ current_user: string; session_user: string }>("SELECT current_user,session_user")).rows[0];
  assert.equal(identity.current_user, "result_database_test"); assert.equal(identity.session_user, identity.current_user);
});

test("result writer has inert locks but no canonical, native, artifact, approval or outbox write authority", async t => {
  const x = await fixture(); t.after(x.close); const before = await x.states();
  for (const [table, column] of [["control_jobs", "result_lock"], ["control_harness_runs", "coordinator_lock"],
    ["projects", "coordinator_lock"], ["control_completion_gate_records", "web_lock"], ["control_completion_gate_integrity", "web_lock"]]) {
    // FOR UPDATE needs the inert UPDATE privilege; no authority-bearing record content changes.
    await x.client.transaction(tx => tx.query(`SELECT * FROM ${table} FOR UPDATE`));
    if (table === "control_completion_gate_records") await assert.rejects(x.client.query(`UPDATE ${table} SET ${column}=false`), /append-only/);
    else await x.client.query(`UPDATE ${table} SET ${column}=false`);
    await assert.rejects(x.client.query(`UPDATE ${table} SET ${column}=true`));
  }
  for (const sql of ["UPDATE control_jobs SET state='succeeded'", "UPDATE control_jobs SET payload=payload",
    "INSERT INTO control_jobs DEFAULT VALUES", "INSERT INTO control_requests DEFAULT VALUES", "INSERT INTO control_workflows DEFAULT VALUES",
    "INSERT INTO control_task_execution_plans DEFAULT VALUES", "UPDATE control_attempts SET state='succeeded'",
    "INSERT INTO control_attempts DEFAULT VALUES", "UPDATE control_leases SET state='released'", "INSERT INTO control_leases DEFAULT VALUES",
    "INSERT INTO control_transition_events DEFAULT VALUES", "INSERT INTO control_outbox DEFAULT VALUES",
    "INSERT INTO control_harness_runs DEFAULT VALUES", "UPDATE control_harness_runs SET payload=payload",
    "INSERT INTO control_harness_run_events DEFAULT VALUES", "INSERT INTO control_native_artifact_receipts DEFAULT VALUES",
    "INSERT INTO control_artifact_manifests DEFAULT VALUES", "INSERT INTO control_approvals DEFAULT VALUES",
    "INSERT INTO control_effect_intents DEFAULT VALUES", "INSERT INTO control_completion_gate_integrity DEFAULT VALUES",
    "UPDATE control_native_review_plans SET plan=plan", "DELETE FROM control_native_review_plans",
    "DELETE FROM control_completion_gate_records", "TRUNCATE audit_events", "SELECT * FROM node_protocol_connections",
    "SELECT * FROM control_approvals", "CREATE TABLE result_extra(id text)"])
    await assert.rejects(x.client.query(sql), /permission denied|append-only/);
  assert.deepEqual(await x.states(), before);
});

test("gate insert guard refuses profiles, owner reviews, findings, checks and approvals plus unlinked native targets/revisions", async t => {
  const x = await fixture(); t.after(x.close);
  const before = (await x.client.query("SELECT * FROM control_completion_gate_records ORDER BY id")).rows;
  let index = 0;
  const insert = (kind: string, patch: Record<string, unknown>, sameTarget = false) => {
    const id = sameTarget ? x.target.id : `record:result-writer-denied:${++index}`;
    return x.client.query(`INSERT INTO control_completion_gate_records
      (id,tenant_id,project_id,kind,record_key,subject_id,parent_id,record_digest,record_auth_tag,payload,occurred_at)
      SELECT $1,tenant_id,project_id,$2,$1,subject_id,parent_id,record_digest,record_auth_tag,
        jsonb_set(payload,'{id}',to_jsonb($1::text)) || $3::jsonb,occurred_at
      FROM control_completion_gate_records WHERE id=$4 AND kind='target'`, [id, kind, JSON.stringify(patch), x.target.id]);
  };
  for (const kind of ["profile", "review", "finding", "verification", "preference", "approval_request", "approval_decision"])
    await assert.rejects(insert(kind, {}), /native result gate insert rejected/);
  await assert.rejects(insert("target", {}), /native result target insert rejected/);
  for (const patch of [{ producer: { actorId: "identity:test", actorType: "human" } },
    { producer: { actorId: "node:other", actorType: "agent" } }, { acceptanceProfileId: "profile:other" },
    { subjectDigest: `sha256:${"0".repeat(64)}` }, { rootTargetId: "target:other" }, { revisionNumber: 1 }])
    await assert.rejects(insert("target", patch, true), /native result target insert rejected/);
  for (const patch of [{}, { grantsApproval: true }, { grantsExecutionAuthority: true }])
    await assert.rejects(insert("revision", patch), /native result revision insert rejected/);
  assert.deepEqual((await x.client.query("SELECT * FROM control_completion_gate_records ORDER BY id")).rows, before);
});

test("result preflight rejects extra/missing rights, mixed membership and disabled writer guards", async t => {
  for (const change of [
    "GRANT UPDATE (state) ON control_jobs TO control_room_native_results",
    "GRANT INSERT ON control_artifact_manifests TO control_room_native_results",
    "REVOKE INSERT ON control_native_review_plans FROM control_room_native_results",
    "REVOKE UPDATE (result_lock) ON control_jobs FROM control_room_native_results",
    "CREATE ROLE result_extra_role NOLOGIN; GRANT result_extra_role TO result_database_test",
    "ALTER TABLE control_completion_gate_records DISABLE TRIGGER control_completion_gate_native_results",
  ]) await t.test(change, async t => {
    const x = await fixture(); t.after(x.close); await x.verify();
    // Exact disposable administrative mutation models a misconfigured pool; no repository role file changes.
    await x.f.raw.exec(change); await assert.rejects(x.verify(), /preflight_failed/);
  });
});
