import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { nativeTaskLifecycleFixture } from "./helpers/native-task-lifecycle";
import { qualityText } from "./helpers/native-quality-completion";
import { NativeEvidenceReceiver } from "../src/web/v1/native-evidence-receiver";
import { TaskResultCoordinator } from "../src/web/v1/task-result-coordinator";
import { verifyNativeEvidenceDatabase, verifyNativeResultDatabase } from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { sha256Digest } from "../src/security";

const signal = () => new AbortController().signal;
async function fixture() {
  const x = await nativeTaskLifecycleFixture();
  try {
    // Accepted dispatch/enrollment/authentication are synthetic privileged fixture setup.
    // Do not call x.register(), f.runs.create(), x.publish(), or a privileged result capture.
    const admin = async <T>(work: () => Promise<T>): Promise<T> => {
      // PGlite retains SET LOCAL SESSION AUTHORIZATION after commit. Restore postgres only
      // for fake producer/protocol authentication and observer readback, never tested writes.
      await x.f.raw.exec("SET SESSION AUTHORIZATION postgres; RESET ROLE");
      return work();
    };
    await x.f.raw.exec(await readFile("db/roles/native_evidence_roles.sql", "utf8"));
    await x.f.raw.exec(await readFile("db/roles/native_results_roles.sql", "utf8"));
    await x.f.raw.exec(`CREATE ROLE evidence_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE evidence_result_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT control_room_native_evidence TO evidence_test; GRANT control_room_native_results TO evidence_result_test;
      SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
      SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
    const observedRoles: string[] = [];
    const pool = (login: "evidence_test" | "evidence_result_test"): DatabaseClient => {
      const db: DatabaseClient = { query: (sql, params) => db.transaction(tx => tx.query(sql, params)),
        transaction: work => db.transactionWithPreCommitCheck(work, () => {}),
        transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(async tx => {
          await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
          const who = (await tx.query<{ current_user: string; session_user: string }>("SELECT current_user,session_user")).rows[0];
          assert.equal(who.current_user, login); assert.equal(who.session_user, login); observedRoles.push(login);
          return work(tx);
        }, check) };
      return db;
    };
    const evidence = pool("evidence_test"), resultsDb = pool("evidence_result_test");
    const adjusted = (db: DatabaseClient): DatabaseClient => ({ ...db, transaction: work => db.transaction(tx => work({
      async query<T>(sql: string, params?: unknown[]) { const result = await tx.query<T>(sql, params);
        // Sole existing metadata adaptation: PGlite TEMP privilege reporting.
        if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false })); return result; },
    })) });
    const config = { host: "127.0.0.1" as const, port: 5432, database: "template1", password: "synthetic-only", majorVersion: 17 as const };
    const scope = { ...x.f.scope, ownerIdentityId: "identity:test", issuer: x.f.accessTrust.issuer };
    const verify = async () => {
      await verifyNativeEvidenceDatabase(adjusted(evidence), { ...config, username: "evidence_test" }, scope, x.f.clock());
      await verifyNativeResultDatabase(adjusted(resultsDb), { ...config, username: "evidence_result_test" }, scope, x.f.clock());
    };
    const resultService = new TaskResultCoordinator(resultsDb, x.f.scope, x.f.plannerConfig,
      { ...x.f.ownerConfig, scenarios: [] }, x.f.clock);
    const results = { ...x.f.scope, register: resultService.register.bind(resultService), submit: resultService.submit.bind(resultService) };
    // Exact key used by canonical-approval-storage.ts NativeApprovalPacketStore, not plannerConfig.integrityKey.
    const deliveryKey = new Uint8Array(32).fill(75);
    const receiverConfig = { scope: x.f.scope, integrityKey: deliveryKey, harnessIntegrityKey: x.f.harnessKey,
      enrollments: [x.f.prepared.enrollment], storage: x.f.config, results, clock: x.f.clock };
    const create = (db = evidence, extra: Partial<typeof receiverConfig> = {}) => new NativeEvidenceReceiver(db, { ...receiverConfig, ...extra });
    const receiver = create();
    const request = { projectId: x.registration.projectId, jobId: x.registration.jobId,
      attemptId: x.registration.attemptId, inputDigest: x.registration.nativeTask!.inputDigest };
    const produce = (phase: "start" | "running" | "completed") => admin(async () => {
      if (phase === "start") await x.handoff.start();
      else { x.advance(); if (phase === "completed") x.setResult(qualityText); await x.handoff.poll(); }
      return x.queueSnapshot();
    });
    const receive = (raw: string, bytes?: Uint8Array, abort = signal(), current = receiver) =>
      admin(() => current.receive(x.session, raw, bytes, abort));
    const acknowledge = () => admin(x.acknowledgeSnapshot);
    const state = () => admin(async () => ({
      job: await x.f.canonical.get(x.registration.tenantId, "job", request.jobId),
      attempt: await x.f.canonical.get(x.registration.tenantId, "attempt", request.attemptId),
      lease: await x.f.canonical.get(x.registration.tenantId, "lease", x.registration.nativeTask!.leaseId),
      outbox: (await x.f.db.query("SELECT * FROM control_outbox ORDER BY id")).rows,
    }));
    const counts = () => admin(async () => ({
      runs: (await x.f.db.query("SELECT * FROM control_harness_runs WHERE id=$1", [x.registration.id])).rows,
      events: (await x.f.db.query("SELECT * FROM control_harness_run_events WHERE run_id=$1 ORDER BY sequence", [x.registration.id])).rows,
      artifacts: (await x.f.db.query("SELECT * FROM control_artifact_manifests WHERE job_id=$1", [request.jobId])).rows,
      receipts: (await x.f.db.query("SELECT * FROM control_native_artifact_receipts WHERE run_id=$1", [x.registration.id])).rows,
      plans: (await x.f.db.query("SELECT * FROM control_native_review_plans WHERE run_id=$1", [x.registration.id])).rows,
    }));
    return { ...x, admin, evidence, resultsDb, resultService, results, receiver, create, request, verify, produce, receive,
      acknowledge, state, counts, observedRoles };
  } catch (error) { await x.close(); throw error; }
}

test("restricted receiver derives initial run from accepted delivery then records signed progress, captures bytes and submits the exact result", async t => {
  const x = await fixture(); t.after(x.close); await x.verify(); const before = await x.state();
  assert.equal((await x.counts()).runs.length, 0);
  const bound = await x.receiver.register(x.request, signal()); assert.equal(bound.replayed, false);
  assert.equal(bound.receipt.runId, x.registration.id); assert.equal(bound.receipt.startsWork, false);
  assert.equal(bound.receipt.grantsExecutionAuthority, false);
  const created = await x.counts(); assert.equal(created.runs.length, 1); assert.equal(created.plans.length, 1);
  assert.equal(created.events.length, 0); assert.equal(created.artifacts.length, 0);
  // Registration timestamp is asserted below from the actual stored receipt rather than arrival-time assumptions.
  const delivery = await x.evidence.query<{ record: { frame: { body: { recordedAt: string } }; receivedAt: string } }>(
    "SELECT record FROM control_native_delivery_receipts WHERE job_id=$1 AND attempt_id=$2", [x.request.jobId, x.request.attemptId]);
  assert.equal((created.runs[0].payload as { createdAt: string }).createdAt, delivery.rows[0].record.frame.body.recordedAt);
  for (const phase of ["start", "running"] as const) {
    const wire = await x.produce(phase), observed = await x.receive(wire.raw); await x.acknowledge();
    assert.equal(observed.runId, x.registration.id); assert.equal(observed.executionAuthorized, false); assert.equal(observed.submission, undefined);
  }
  const wire = await x.produce("completed"), bytes = new TextEncoder().encode(qualityText);
  const saved = await x.receive(wire.raw, bytes); await x.acknowledge();
  assert.equal(saved.state, "succeeded"); assert.equal(saved.replayed, false); assert.equal(saved.executionAuthorized, false);
  assert.equal(saved.submission!.qualityAccepted, false); assert.equal(saved.submission!.targetId, bound.receipt.targetId);
  assert.equal(saved.submission!.contentHash, wire.body.result!.contentHash);
  const target = await x.admin(() => x.f.reviewStore.snapshot(x.registration.tenantId, bound.receipt.targetId));
  assert.equal(target.status, "pending"); assert.equal(target.target.producer.actorId, x.registration.nodeId);
  assert.equal(JSON.stringify(saved).includes(qualityText), false);
  const calls = [...x.local.calls], counts = await x.counts(), cp = x.f.checkpoints.read(`completion-gate:${x.registration.tenantId}`);
  assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.deepEqual(await x.f.config.storage.read(counts.artifacts[0].id as string), bytes);
  const replayWire = await x.admin(x.queueSnapshot); // Fresh signed protocol frame, same recorded native snapshot; no native poll/start.
  const replay = await x.receive(replayWire.raw, bytes); await x.acknowledge();
  assert.equal(replay.replayed, true); assert.deepEqual(replay.submission, saved.submission);
  assert.deepEqual(await x.receiver.register(x.request, signal()), { ...bound, replayed: true });
  assert.deepEqual(await x.counts(), counts); assert.deepEqual(await x.state(), before); assert.deepEqual(x.local.calls, calls);
  assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.registration.tenantId}`), cp);
  assert.ok(x.observedRoles.includes("evidence_test")); assert.ok(x.observedRoles.includes("evidence_result_test"));
});

test("evidence SQL profile cannot author canonical transitions, approvals, review bindings, quality records or outbox", async t => {
  const x = await fixture(); t.after(x.close); await x.verify(); const before = await x.state();
  for (const sql of ["UPDATE control_jobs SET state='succeeded'", "UPDATE control_attempts SET state='succeeded'",
    "UPDATE control_leases SET state='released'", "INSERT INTO control_transition_events DEFAULT VALUES",
    "INSERT INTO control_outbox DEFAULT VALUES", "INSERT INTO control_approvals DEFAULT VALUES",
    "INSERT INTO control_native_review_plans DEFAULT VALUES", "INSERT INTO control_completion_gate_records DEFAULT VALUES",
    "INSERT INTO control_task_execution_plans DEFAULT VALUES", "INSERT INTO control_native_delivery_receipts DEFAULT VALUES",
    "DELETE FROM control_harness_runs", "TRUNCATE control_native_artifact_receipts"])
    await assert.rejects(x.evidence.query(sql), /permission denied|append-only/);
  for (const table of ["control_attempts", "control_leases"])
    await assert.rejects(x.evidence.query(`UPDATE ${table} SET evidence_lock=true`));
  assert.deepEqual(await x.state(), before); assert.equal((await x.counts()).runs.length, 0);
});

test("wrong registration scope, input, delivery key and aborted registration create no run or review plan", async t => {
  const x = await fixture(); t.after(x.close); const before = await x.counts();
  for (const patch of [{ projectId: "project:other" }, { jobId: "job:other" }, { attemptId: "attempt:other" },
    { inputDigest: sha256Digest("other input") }, { producer: "node:caller" }])
    await assert.rejects(async () => x.receiver.register({ ...x.request, ...patch }, signal()));
  await assert.rejects(x.create(x.evidence, { integrityKey: x.f.plannerConfig.integrityKey }).register(x.request, signal()));
  const abort = new AbortController(); abort.abort(); await assert.rejects(x.receiver.register(x.request, abort.signal));
  assert.deepEqual(await x.counts(), before);
});

test("wrong completed bytes leave recorded progress but no captured artifact or quality submission", async t => {
  const x = await fixture(); t.after(x.close); await x.receiver.register(x.request, signal());
  for (const phase of ["start", "running"] as const) { const wire = await x.produce(phase); await x.receive(wire.raw); await x.acknowledge(); }
  const wire = await x.produce("completed"), cp = x.f.checkpoints.read(`completion-gate:${x.registration.tenantId}`);
  await assert.rejects(x.receive(wire.raw, new TextEncoder().encode("Wrong output bytes")));
  const counts = await x.counts(); assert.equal(counts.runs[0].state, "succeeded"); assert.equal(counts.artifacts.length, 0);
  assert.equal(counts.receipts.length, 0); assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.registration.tenantId}`), cp);
});

test("aborted receive consumes no new evidence, and wrong workspace prevents run registration", async t => {
  const x = await fixture(); t.after(x.close); const badScope = { ...x.f.scope, workspaceId: "workspace:other" };
  const otherResults = { ...x.results, workspaceId: badScope.workspaceId };
  await assert.rejects(x.create(x.evidence, { scope: badScope, results: otherResults }).register(x.request, signal()));
  await x.receiver.register(x.request, signal()); const wire = await x.produce("start"), before = await x.counts();
  const abort = new AbortController(); abort.abort(); await assert.rejects(x.receive(wire.raw, undefined, abort.signal));
  assert.deepEqual(await x.counts(), before);
});

test("SQL failure in restricted run creation rolls back before review registration or progress", async t => {
  const x = await fixture(); t.after(x.close); let reached = false;
  const wrap = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
    const result = await tx.query<T>(sql, params);
    if (sql.includes("INSERT INTO control_harness_runs")) { reached = true; throw new Error("synthetic_evidence_sql_failure"); }
    return result;
  } });
  const db: DatabaseClient = { ...x.evidence, transactionWithPreCommitCheck: (work, check) =>
    x.evidence.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
  await assert.rejects(x.create(db).register(x.request, signal())); assert.equal(reached, true);
  const counts = await x.counts(); assert.equal(counts.runs.length, 0); assert.equal(counts.plans.length, 0); assert.equal(counts.events.length, 0);
});
