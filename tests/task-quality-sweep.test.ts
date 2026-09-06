import assert from "node:assert/strict";
import test from "node:test";
import { taskQualityCoordinatorFixture, deferredQuality } from "./helpers/task-quality-coordinator";
import type { DatabaseClient } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { TaskQualityCoordinator } from "../src/web/v1/task-quality-coordinator";

type Fixture = Awaited<ReturnType<typeof taskQualityCoordinatorFixture>>;
const signal = () => new AbortController().signal;
const sweep = (x: Fixture) => x.owner.quality!.sweep({ projectId: x.request.projectId }, signal());
const verifications = async (x: Fixture) => (await x.f.db.query(
  "SELECT id FROM control_completion_gate_records WHERE kind='verification' AND parent_id=$1", [x.target.id])).rows;

test("restricted sweep discovers the actual saved native result, waits for owner review, completes and excludes it later", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close); await x.verifyRole();
  const calls = [...x.local.calls], waiting = await sweep(x);
  assert.deepEqual([waiting.tenantId, waiting.workspaceId, waiting.projectId], [x.request.tenantId, x.f.scope.workspaceId, x.request.projectId]);
  assert.equal(waiting.grantsApproval, false); assert.equal(waiting.grantsExecutionAuthority, false); assert.equal(waiting.nextRunId, null);
  assert.equal(waiting.items.length, 1); const item = waiting.items[0];
  assert.equal(item.runId, x.request.runId); assert.equal(item.jobId, x.request.jobId); assert.equal(item.status, "reconciled");
  if (item.status !== "reconciled") throw new Error("missing exact reconciliation");
  assert.equal(item.result.disposition, "waiting_review"); assert.equal(item.result.verification, "recorded");
  assert.equal(item.result.targetDigest, x.request.targetDigest); assert.equal(item.result.contentHash, x.request.contentHash);
  assert.equal((await verifications(x)).length, 1); assert.equal((await x.states()).job.state, "leased");
  await x.ownerReview(); const completed = await sweep(x); assert.equal(completed.items.length, 1);
  const done = completed.items[0]; assert.equal(done.status, "reconciled");
  if (done.status !== "reconciled") throw new Error("missing completed reconciliation");
  assert.equal(done.result.disposition, "completed");
  const state = await x.states(); assert.deepEqual([state.job.state, state.attempt.state, state.lease.state], ["succeeded", "succeeded", "released"]);
  assert.deepEqual((await sweep(x)).items, []);
  const replay = await x.reconcile(); assert.equal(replay.disposition, "completed"); assert.equal(replay.completion?.replayed, true);
  assert.deepEqual(x.local.calls, calls); assert.equal(x.local.effects.countFull(), 1); assert.equal((await verifications(x)).length, 1);
});

test("missing stored bytes produce one explicit unavailable item without exposing an error or successful completion", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  const owner = x.createOwner({ quality: { ...x.config.quality!, results: { ...x.f.ownerConfig.results,
    storage: { read: async () => { throw new Error("synthetic private storage details"); } } } } }); t.after(() => owner.close());
  const result = await owner.quality!.sweep({ projectId: x.request.projectId }, signal());
  assert.deepEqual(result.items, [{ runId: x.request.runId, jobId: x.request.jobId, status: "unavailable", requiresReconciliation: true }]);
  assert.equal(result.nextRunId, null); assert.equal(JSON.stringify(result).includes("synthetic private storage details"), false);
  assert.deepEqual(await verifications(x), []); assert.equal((await x.states()).job.state, "leased");
});

test("sweep rejects malformed requests, unavailable scope and pre-admission cancellation without evidence writes", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  for (const request of [{ projectId: x.request.projectId, tenantId: "tenant:other" }, { projectId: x.request.projectId, afterRunId: "../outside" },
    { projectId: x.request.projectId, targetDigest: x.request.targetDigest }, { projectId: "" }])
    await assert.rejects(async () => x.owner.quality!.sweep(request, signal()));
  await assert.rejects(x.owner.quality!.sweep({ projectId: "project:other" }, signal()));
  const scoped = x.createOwner({ scope: { ...x.f.scope, workspaceId: "workspace:other" } }); t.after(() => scoped.close());
  await assert.rejects(scoped.quality!.sweep({ projectId: x.request.projectId }, signal()));
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(x.owner.quality!.sweep({ projectId: x.request.projectId }, aborted.signal));
  assert.deepEqual(await verifications(x), []); assert.equal((await x.states()).job.state, "leased");
});

test("sweep captures project and cursor before asynchronous lifecycle admission", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close); const entered = deferredQuality(), release = deferredQuality();
  let first = true;
  const db: DatabaseClient = { ...x.f.db, async transactionWithPreCommitCheck(work, check) {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return x.f.db.transactionWithPreCommitCheck(work, check);
  } };
  const owner = x.createOwner({ database: { ...x.config.database, client: db } }); t.after(() => owner.close());
  const request = { projectId: x.request.projectId, afterRunId: undefined as string | undefined };
  const pending = owner.quality!.sweep(request, signal()); request.projectId = "project:changed"; request.afterRunId = x.request.runId;
  await entered.promise; release.resolve(); const result = await pending;
  assert.equal(result.projectId, x.request.projectId); assert.equal(result.items.length, 1); assert.equal(result.items[0].runId, x.request.runId);
});

test("project reassignment after enumeration makes the candidate unavailable before any stored bytes are read", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  await x.asMigrator(() => x.f.db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:sweep:other',$1,'Other synthetic workspace')", [x.request.tenantId]));
  let reassigned = false, reads = 0;
  const db: DatabaseClient = { ...x.f.db, async transactionWithPreCommitCheck(work, check) {
    let enumerated = false;
    const value = await x.f.db.transactionWithPreCommitCheck(tx => work({ async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (sql.includes("SELECT r.id AS run_id,j.id AS job_id FROM control_harness_runs")) enumerated = true;
      return result;
    } }), check);
    if (enumerated && !reassigned) {
      reassigned = true;
      await x.asMigrator(() => x.f.db.query("UPDATE projects SET workspace_id='workspace:sweep:other' WHERE id=$1", [x.request.projectId]));
    }
    return value;
  } };
  const owner = x.createOwner({ database: { ...x.config.database, client: db }, quality: { ...x.config.quality!,
    results: { ...x.f.ownerConfig.results, storage: { read: async (...args) => {
      reads++; return x.f.ownerConfig.results.storage.read(...args);
    } } } } }); t.after(() => owner.close());
  const result = await owner.quality!.sweep({ projectId: x.request.projectId }, signal());
  assert.equal(reassigned, true); assert.equal(reads, 0);
  assert.deepEqual(result.items, [{ runId: x.request.runId, jobId: x.request.jobId, status: "unavailable", requiresReconciliation: true }]);
  assert.deepEqual(await verifications(x), []); assert.equal((await x.states()).job.state, "leased");
});

test("one-shot database unavailability after the candidate scope query rejects the whole sweep before reading bytes", async t => {
  for (const mode of ["false_return", "thrown_error"] as const) await t.test(mode, async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  let scopeRead = false, injected = false, reads = 0;
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (sql.includes("SELECT p.id FROM control_harness_runs r")) scopeRead = true;
      return result;
    },
  }), check) };
  const owner = x.createOwner({ database: { ...x.config.database, client: db, isAvailable: () => {
    if (scopeRead && !injected) {
      injected = true;
      if (mode === "thrown_error") throw new Error("one-shot synthetic database availability failure");
      return false;
    }
    return x.config.database.isAvailable();
  } }, quality: { ...x.config.quality!, results: { ...x.f.ownerConfig.results, storage: { read: async (...args) => {
    reads++; return x.f.ownerConfig.results.storage.read(...args);
  } } } } }); t.after(() => owner.close());
  await assert.rejects(owner.quality!.sweep({ projectId: x.request.projectId }, signal()), /task_coordinator_unavailable/);
  assert.equal(scopeRead, true); assert.equal(injected, true); assert.equal(reads, 0); assert.equal(owner.isReady(), true);
  assert.deepEqual(await verifications(x), []); assert.equal((await x.states()).job.state, "leased");
  const recovered = await owner.quality!.sweep({ projectId: x.request.projectId }, signal());
  assert.equal(recovered.items[0].status, "reconciled");
  if (recovered.items[0].status !== "reconciled") throw new Error("missing recovered reconciliation");
  assert.equal(recovered.items[0].result.disposition, "waiting_review");
  assert.ok(reads > 0); assert.equal((await verifications(x)).length, 1);
  });
});

test("cancellation at a verification-writing precommit rejects the sweep and preserves the original checkpoint", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close); const abort = new AbortController();
  const before = x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`); let wrote = false;
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) { const result = await tx.query<T>(sql, params);
      if (sql.includes("INSERT INTO control_completion_gate_records")) wrote = true; return result; },
  }), () => { if (wrote) abort.abort(); return check(); }) };
  const owner = x.createOwner({ database: { ...x.config.database, client: db } }); t.after(() => owner.close());
  await assert.rejects(owner.quality!.sweep({ projectId: x.request.projectId }, abort.signal)); assert.equal(wrote, true);
  assert.deepEqual(await verifications(x), []); assert.deepEqual(x.f.checkpoints.read(`completion-gate:${x.request.tenantId}`), before);
  assert.equal((await x.states()).job.state, "leased");
});

test("sweep rejects invalid clocks before SQL and elapsed or rollback time after an awaited result read", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close); let transactions = 0;
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: (...args) => { transactions++; return x.f.db.transactionWithPreCommitCheck(...args); } };
  for (const now of [-1, NaN, Infinity, 0.5]) {
    const owner = x.createOwner({ database: { ...x.config.database, client: db }, clock: () => now }); t.after(() => owner.close());
    await assert.rejects(owner.quality!.sweep({ projectId: x.request.projectId }, signal()));
  }
  assert.equal(transactions, 0);
  for (const offset of [-1, 10_001]) {
    let now = x.f.clock(), read = false;
    const owner = x.createOwner({ clock: () => now, quality: { ...x.config.quality!, results: { ...x.f.ownerConfig.results,
      storage: { read: async (...args) => { const bytes = await x.f.ownerConfig.results.storage.read(...args); read = true; now += offset; return bytes; } } } } });
    t.after(() => owner.close()); await assert.rejects(owner.quality!.sweep({ projectId: x.request.projectId }, signal())); assert.equal(read, true);
  }
  assert.deepEqual(await verifications(x), []); assert.equal((await x.states()).job.state, "leased");
});

test("forced lifecycle drain makes an in-flight sweep uncertain and prevents late evidence writes", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  const entered = deferredQuality(), release = deferredQuality(), settled = deferredQuality(); let reading = false;
  const db: DatabaseClient = { ...x.f.db, async transactionWithPreCommitCheck(work, check) {
    try { return await x.f.db.transactionWithPreCommitCheck(work, check); } finally { if (reading) settled.resolve(); }
  } };
  const owner = x.createOwner({ drainMs: 1, database: { ...x.config.database, client: db }, quality: { ...x.config.quality!,
    results: { ...x.f.ownerConfig.results, storage: { read: async (...args) => {
      reading = true; entered.resolve(); await release.promise; return x.f.ownerConfig.results.storage.read(...args);
    } } } } });
  const pending = assert.rejects(owner.quality!.sweep({ projectId: x.request.projectId }, signal()));
  await entered.promise; await assert.rejects(owner.close(), /uncertain/); release.resolve(); await pending; await settled.promise;
  await assert.rejects(owner.quality!.sweep({ projectId: x.request.projectId }, signal()));
  assert.deepEqual(await verifications(x), []); assert.equal((await x.states()).job.state, "leased");
});

test("direct sweep rejects one-shot clock and supplied-currentness failures even when the capability immediately recovers", async t => {
  for (const mode of ["rollback", "nan", "throwing_clock", "supplied_currentness"] as const) await t.test(mode, async t => {
    const x = await taskQualityCoordinatorFixture(); t.after(x.close);
    let armed = false, injected = false;
    const clock = () => {
      if (armed && !injected && mode !== "supplied_currentness") {
        injected = true;
        if (mode === "throwing_clock") throw new Error("one-shot synthetic clock failure");
        return mode === "nan" ? NaN : x.f.clock() - 1;
      }
      return x.f.clock();
    };
    const assertCurrent = () => {
      if (armed && !injected && mode === "supplied_currentness") {
        injected = true; throw new Error("one-shot synthetic currentness failure");
      }
    };
    const coordinator = new TaskQualityCoordinator(x.f.db, x.f.scope, { ...x.config.quality!,
      results: { ...x.f.ownerConfig.results, storage: { read: async (...args) => {
        const bytes = await x.f.ownerConfig.results.storage.read(...args); armed = true; return bytes;
      } } } }, clock);
    await assert.rejects(coordinator.sweep({ projectId: x.request.projectId }, signal(), assertCurrent), /task_quality_unavailable/);
    assert.equal(injected, true); assert.equal(clock(), x.f.clock()); assert.doesNotThrow(assertCurrent);
    assert.deepEqual(await verifications(x), []); assert.equal((await x.states()).job.state, "leased");
    // Recovery may start a fresh operation, but cannot convert the interrupted one
    // into a successful response containing an ordinary unavailable candidate.
    const recovered = await coordinator.sweep({ projectId: x.request.projectId }, signal(), assertCurrent);
    assert.equal(recovered.items[0].status, "reconciled");
    if (recovered.items[0].status !== "reconciled") throw new Error("missing recovered reconciliation");
    assert.equal(recovered.items[0].result.disposition, "waiting_review");
  });
});

test("a one-shot nested reconcile clock failure rejects the outer sweep instead of becoming an unavailable item", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  let nested = false, injected = false;
  const clock = () => {
    if (nested && !injected) { injected = true; return NaN; }
    return x.f.clock();
  };
  const coordinator = new TaskQualityCoordinator(x.f.db, x.f.scope, x.config.quality!, clock);
  const reconcile = coordinator.reconcile.bind(coordinator);
  // Arm at the public nested operation boundary, after genuine candidate inspection.
  coordinator.reconcile = (...args) => { nested = true; return reconcile(...args); };
  await assert.rejects(coordinator.sweep({ projectId: x.request.projectId }, signal(), () => {}), /task_quality_unavailable/);
  assert.equal(nested, true); assert.equal(injected, true); assert.equal(clock(), x.f.clock());
  assert.deepEqual(await verifications(x), []); assert.equal((await x.states()).job.state, "leased");
  const recovered = await coordinator.sweep({ projectId: x.request.projectId }, signal(), () => {});
  assert.equal(recovered.items[0].status, "reconciled");
});

test("real SQL keyset pagination bounds synthetic candidate indexes and never treats them as authenticated results", async t => {
  const x = await taskQualityCoordinatorFixture(); t.after(x.close);
  const names = ["Z", "a", "A", "z", "B", "b", "C"], candidates = names.map(name => ({ runId: `run:sweep:${name}`, jobId: `job:sweep:${name}` }));
  await x.asMigrator(async () => {
    // Only discovery indexes are seeded here. Copied native/receipt HMACs deliberately do
    // not authenticate these synthetic identities, so real inspection must reject each.
    async function clone(table: string, key: string, value: string, patch: Record<string, unknown>, payloadPatch?: Record<string, unknown>) {
      const row = (await x.f.db.query<{ row: Record<string, unknown> }>(`SELECT to_jsonb(source) AS row FROM ${table} source WHERE ${key}=$1`, [value])).rows[0].row;
      const next = { ...row, ...patch, ...(payloadPatch ? { payload: { ...row.payload as object, ...payloadPatch } } : {}) };
      await x.f.db.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`, [JSON.stringify(next)]);
    }
    for (const item of candidates) {
      const attemptId = `attempt:sweep:${item.runId.slice(-1)}`, artifactId = `artifact:sweep:${item.runId.slice(-1)}`;
      await clone("control_jobs", "id", x.request.jobId, { id: item.jobId }, { id: item.jobId });
      await clone("control_attempts", "id", x.registration.attemptId, { id: attemptId, job_id: item.jobId }, { id: attemptId, jobId: item.jobId });
      await clone("control_harness_runs", "id", x.request.runId, { id: item.runId, job_id: item.jobId, attempt_id: attemptId,
        native_session_key_digest: sha256Digest(item.runId) }, { id: item.runId, jobId: item.jobId, attemptId });
      await clone("control_artifact_manifests", "id", x.artifact.artifactId, { id: artifactId, job_id: item.jobId, attempt_id: attemptId },
        { id: artifactId, jobId: item.jobId, attemptId });
      await clone("control_native_review_plans", "run_id", x.request.runId, { run_id: item.runId, job_id: item.jobId });
      await clone("control_native_artifact_receipts", "run_id", x.request.runId, { run_id: item.runId, job_id: item.jobId, attempt_id: attemptId, artifact_id: artifactId });
    }
  });
  // The actual fixture's result also participates. Its expected disposition is reconciled;
  // synthetic rows prove SQL order/bounds/continuation, not seven native executions.
  const ordered = [...candidates, { runId: x.request.runId, jobId: x.request.jobId }].sort((a, b) => a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
  const first = await sweep(x); assert.deepEqual(first.items.map(({ runId }) => runId), ordered.slice(0, 5).map(item => item.runId));
  assert.equal(first.nextRunId, ordered[4].runId);
  const second = await x.owner.quality!.sweep({ projectId: x.request.projectId, afterRunId: first.nextRunId! }, signal());
  assert.deepEqual(second.items.map(({ runId }) => runId), ordered.slice(5).map(item => item.runId)); assert.equal(second.nextRunId, null);
  for (const item of [...first.items, ...second.items]) {
    if (item.runId === x.request.runId) assert.equal(item.status, "reconciled");
    else assert.deepEqual(item, { ...candidates.find(candidate => candidate.runId === item.runId), status: "unavailable", requiresReconciliation: true });
  }
  const repeated = await sweep(x); assert.deepEqual(repeated.items.map(item => item.runId), first.items.map(item => item.runId));
  assert.equal((await verifications(x)).length, 1); assert.equal((await x.states()).job.state, "leased");
});
