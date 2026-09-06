import assert from "node:assert/strict";
import test from "node:test";
import { taskQualityCoordinatorFixture, deferredQuality } from "./helpers/task-quality-coordinator";
import type { DatabaseClient } from "../src/persistence/database";
import { verifyTaskCoordinatorDatabase, verifyPrivateDatabase, readPrivateWebSchemaDigest, privateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import { sha256Digest } from "../src/security";

type Fixture = Awaited<ReturnType<typeof taskQualityCoordinatorFixture>>;
const verificationRows = async (x: Fixture) => (await x.f.db.query("SELECT * FROM control_completion_gate_records WHERE kind='verification' AND parent_id=$1", [x.target.id])).rows;
const completionRows = async (x: Fixture) => (await x.f.db.query("SELECT * FROM control_transition_events WHERE actor_id='service:native-task-completion' AND entity_id=$1", [x.registration.jobId])).rows;

test("exact non-superuser coordinator passes preflight and reconciles real structure evidence, owner review and canonical completion", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  const role = (await x.f.db.query<{ current_user: string; rolsuper: boolean }>(
    "SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.deepEqual(role, { current_user: "quality_coordinator_test", rolsuper: false });
  assert.equal(await readPrivateWebSchemaDigest(x.f.db), privateWebSchemaDigest);
  await assert.rejects(verifyTaskCoordinatorDatabase(x.f.db, x.connection, x.preflightScope, x.f.clock()), /preflight_failed/);
  await x.verifyRole();
  await assert.rejects(verifyPrivateDatabase(x.checked, x.connection, x.preflightScope, x.f.clock()), /preflight_failed/);
  const calls = [...x.local.calls], initial = await x.reconcile();
  assert.equal(initial.disposition, "waiting_review"); assert.equal(initial.verification, "recorded"); assert.equal("completion" in initial, false);
  assert.equal((await verificationRows(x)).length, 1); assert.equal((await x.states()).job.state, "leased");
  await x.ownerReview();
  const completed = await x.reconcile(); assert.equal(completed.disposition, "completed"); assert.equal(completed.verification, "replayed");
  assert.equal(completed.completion?.replayed, false); assert.equal(completed.completion?.receipt.grantsExecutionAuthority, false);
  assert.equal(completed.completion?.receipt.jobId, x.request.jobId); assert.equal(completed.completion?.receipt.runId, x.request.runId);
  const state = await x.states(); assert.equal(state.job.state, "succeeded"); assert.equal(state.attempt.state, "succeeded"); assert.equal(state.lease.state, "released");
  const replay = await x.reconcile(); assert.equal(replay.disposition, "completed"); assert.equal(replay.completion?.replayed, true);
  assert.deepEqual(replay.completion?.receipt, completed.completion?.receipt);
  assert.equal((await verificationRows(x)).length, 1); assert.equal((await completionRows(x)).length, 2);
  assert.equal((await x.f.db.query("SELECT id FROM control_artifact_manifests WHERE job_id=$1", [x.request.jobId])).rows.length, 1);
  assert.deepEqual(x.local.calls, calls); assert.equal(x.local.effects.countFull(), 1);
});

test("coordinator quality role cannot author reviews, targets, agent checks or native result/run evidence", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close); await x.reconcile();
  let count = 0;
  const insertGate = (kind: string, patch: unknown) => x.f.db.query(`INSERT INTO control_completion_gate_records
    (id,tenant_id,project_id,kind,record_key,subject_id,parent_id,record_digest,record_auth_tag,payload,occurred_at)
    SELECT $1,tenant_id,project_id,$2,$1,subject_id,parent_id,record_digest,record_auth_tag,
      jsonb_set(payload,'{id}',to_jsonb($1::text)) || $3::jsonb,occurred_at
    FROM control_completion_gate_records WHERE kind='verification' AND parent_id=$4 LIMIT 1`,
  [`verification:coordinator-forbidden:${++count}`, kind, JSON.stringify(patch), x.target.id]);
  for (const kind of ["review", "finding", "profile", "target", "revision", "preference", "approval_request", "approval_decision"])
    await assert.rejects(insertGate(kind, {}));
  for (const patch of [{ verifier: { actorId: "agent:test", actorType: "agent" } }, { verifier: { actorId: "identity:test", actorType: "human" } },
    { grantsApproval: true }, { grantsExecutionAuthority: true }]) await assert.rejects(insertGate("verification", patch));
  for (const sql of ["INSERT INTO control_harness_runs DEFAULT VALUES", "INSERT INTO control_harness_run_events DEFAULT VALUES",
    "INSERT INTO control_native_artifact_receipts DEFAULT VALUES", "INSERT INTO control_artifact_manifests DEFAULT VALUES",
    "INSERT INTO control_node_job_events DEFAULT VALUES", "INSERT INTO control_native_review_plans DEFAULT VALUES",
    "INSERT INTO control_effect_intents DEFAULT VALUES", "INSERT INTO control_approvals DEFAULT VALUES",
    "UPDATE control_harness_runs SET state='succeeded'", "DELETE FROM control_completion_gate_records"])
    await assert.rejects(x.f.db.query(sql), /permission denied|append-only/);
  await assert.rejects(x.review(), /permission denied|insert rejected/);
  assert.equal((await verificationRows(x)).length, 1); assert.deepEqual(await completionRows(x), []);
});

test("quality scope mismatch, cancellation before admission and current bytes fail without successful completion", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  for (const patch of [{ tenantId: "tenant:other" }, { projectId: "project:other" }, { jobId: "job:other" },
    { runId: "run:other" }, { targetDigest: sha256Digest("other target") }, { contentHash: sha256Digest("other bytes") }])
    await assert.rejects(x.reconcile({ ...x.request, ...patch }));
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(x.reconcile(x.request, aborted.signal));
  assert.deepEqual(await verificationRows(x), []); assert.deepEqual(await completionRows(x), []);
  const missing = x.createOwner({ quality: { ...x.config.quality!, results: { ...x.f.ownerConfig.results, storage: { read: async () => undefined } } } });
  t.after(() => missing.close()); await assert.rejects(missing.quality!.reconcile(x.request, new AbortController().signal));
  assert.deepEqual(await verificationRows(x), []); assert.equal((await x.states()).job.state, "leased");
});

test("quality request is captured before asynchronous admission and signal abort rolls back precommit evidence", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  const entered = deferredQuality(), release = deferredQuality(); let first = true;
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: async (work, check) => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return x.f.db.transactionWithPreCommitCheck(work, check);
  } };
  const captured = x.createOwner({ database: { ...x.config.database, client: db } }); t.after(() => captured.close());
  const request = { ...x.request }, pending = captured.quality!.reconcile(request, new AbortController().signal);
  request.jobId = "job:mutated"; request.contentHash = sha256Digest("mutated input");
  await entered.promise; release.resolve(); const saved = await pending;
  assert.equal(saved.disposition, "waiting_review"); assert.equal((await verificationRows(x)).length, 1);
  const abort = new AbortController();
  const cancelledDb: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(work, async () => { abort.abort(); await check(); }) };
  const cancelled = x.createOwner({ database: { ...x.config.database, client: cancelledDb } }); t.after(() => cancelled.close());
  await assert.rejects(cancelled.quality!.reconcile(x.request, abort.signal));
  assert.deepEqual(await completionRows(x), []); assert.equal((await x.states()).job.state, "leased");
});

test("quality coordinator preflight rejects missing and extra native-quality privileges", async t => {
  for (const change of [
    "REVOKE SELECT ON control_harness_run_events FROM control_room_task_coordinator",
    "REVOKE INSERT ON control_completion_gate_records FROM control_room_task_coordinator",
    "GRANT INSERT ON control_harness_runs TO control_room_task_coordinator",
    "GRANT UPDATE (plan) ON control_native_review_plans TO control_room_task_coordinator",
    "GRANT INSERT ON control_artifact_manifests TO control_room_task_coordinator",
    "ALTER TABLE control_completion_gate_records DISABLE TRIGGER control_completion_gate_task_coordinator_quality",
    "ALTER TABLE control_harness_runs DROP CONSTRAINT control_harness_runs_coordinator_lock",
  ]) await t.test(change.split(" ").slice(0, 5).join(" "), async t => {
    const x = await taskQualityCoordinatorFixture(); t.after(x.close); await x.verifyRole();
    await x.asMigrator(() => x.f.raw.exec(change));
    await assert.rejects(x.verifyRole(), /preflight_failed/);
  });
});

test("cancellation at the verification-writing precommit leaves both gate records and checkpoint unchanged", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  const abort = new AbortController(), before = x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`);
  let wroteVerification = false, fenced = false;
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (sql.includes("INSERT INTO control_completion_gate_records")) wroteVerification = true;
      return result;
    },
  }), () => { if (wroteVerification) { fenced = true; abort.abort(); } return check(); }) };
  const owner = x.createOwner({ database: { ...x.config.database, client: db } }); t.after(() => owner.close());
  await assert.rejects(owner.quality!.reconcile(x.request, abort.signal));
  assert.equal(wroteVerification, true); assert.equal(fenced, true); assert.deepEqual(await verificationRows(x), []);
  assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`), before);
  assert.equal((await x.states()).job.state, "leased");
});

test("quality configuration is optional and absent configuration exposes no internal reconciliation operation", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  const owner = x.createOwner({ quality: undefined }); t.after(() => owner.close());
  assert.equal(owner.quality, undefined); assert.equal("quality" in owner, false);
  const empty = x.createOwner({ quality: { ...x.config.quality!, scenarios: [] } }); t.after(() => empty.close());
  const waiting = await empty.quality!.reconcile(x.request, new AbortController().signal);
  assert.equal(waiting.disposition, "waiting_review"); assert.equal(waiting.verification, "not_configured");
  assert.deepEqual(await verificationRows(x), []); assert.deepEqual(await completionRows(x), []);
});

test("quality coordinator rejects invalid clocks before SQL and retains high-water across calls", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  let queries = 0;
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: (...args) => {
    queries++; return x.f.db.transactionWithPreCommitCheck(...args);
  } };
  for (const time of [-1, NaN, Infinity, 0.5]) {
    const owner = x.createOwner({ clock: () => time, database: { ...x.config.database, client: db } });
    t.after(() => owner.close());
    await assert.rejects(owner.quality!.reconcile(x.request, new AbortController().signal));
  }
  assert.equal(queries, 0);
  let now = x.f.clock();
  const owner = x.createOwner({ clock: () => now }); t.after(() => owner.close());
  await owner.quality!.reconcile(x.request, new AbortController().signal); now--;
  await assert.rejects(owner.quality!.reconcile(x.request, new AbortController().signal));
  assert.equal((await verificationRows(x)).length, 1); assert.deepEqual(await completionRows(x), []);
});

test("project reassignment after committed verification blocks completion and preserves the already-recorded evidence", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close); await x.ownerReview();
  await x.asMigrator(() => x.f.db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:quality:other',$1,'Other synthetic workspace')", [x.request.tenantId]));
  let reassigned = false;
  const db: DatabaseClient = { ...x.f.db, async transactionWithPreCommitCheck(work, check) {
    let recorded = false;
    const value = await x.f.db.transactionWithPreCommitCheck(tx => work({ async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (sql.includes("INSERT INTO control_completion_gate_records")) recorded = true;
      return result;
    } }), check);
    if (recorded && !reassigned) {
      reassigned = true;
      await x.asMigrator(() => x.f.db.query("UPDATE projects SET workspace_id='workspace:quality:other' WHERE id=$1", [x.request.projectId]));
    }
    return value;
  } };
  const owner = x.createOwner({ database: { ...x.config.database, client: db } }); t.after(() => owner.close());
  await assert.rejects(owner.quality!.reconcile(x.request, new AbortController().signal));
  assert.equal(reassigned, true); assert.equal((await verificationRows(x)).length, 1);
  assert.equal((await x.states()).job.state, "leased"); assert.deepEqual(await completionRows(x), []);
});

test("failed structural evidence and requested changes remain truthful under the coordinator role", async t => {
  for (const mode of ["failed_structure", "changes_requested"] as const) await t.test(mode, async t => {
    const x = await taskQualityCoordinatorFixture(mode === "failed_structure" ? "# Result\nThe required evidence heading is absent." : undefined); t.after(x.close);
    if (mode === "changes_requested") await x.ownerReview("changes_requested");
    const result = await x.reconcile();
    assert.equal(result.disposition, mode === "failed_structure" ? "verification_blocked" : "changes_requested");
    assert.equal(result.verification, mode === "failed_structure" ? "recorded" : "not_run");
    const replay = await x.reconcile(); assert.equal(replay.disposition, result.disposition); assert.equal(replay.verification, "not_run");
    assert.equal((await verificationRows(x)).length, mode === "failed_structure" ? 1 : 0);
    assert.equal((await x.states()).job.state, "leased"); assert.deepEqual(await completionRows(x), []);
  });
});
