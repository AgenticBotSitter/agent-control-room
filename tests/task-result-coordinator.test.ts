import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { nativeTaskLifecycleFixture } from "./helpers/native-task-lifecycle";
import { nativeRevisedExecutionFixture, revisedText } from "./helpers/native-revised-result";
import { qualityText } from "./helpers/native-quality-completion";
import { NativeTaskResultService } from "../src/node-control/native-task-result-service";
import { TaskResultCoordinator } from "../src/web/v1/task-result-coordinator";
import { createTaskCoordinatorLifecycle } from "../src/web/v1/task-coordinator-lifecycle";
import { verifyNativeResultDatabase } from "../src/web/v1/private-database-preflight";
import type { TaskQualityConfiguration } from "../src/web/v1/task-quality-coordinator";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const signal = () => new AbortController().signal;
type Base = Awaited<ReturnType<typeof nativeTaskLifecycleFixture>>["f"];
async function fixtureAdmin<T>(f: Base, work: () => Promise<T>): Promise<T> {
  // PGlite retains SET LOCAL SESSION AUTHORIZATION after commit. Restore the synthetic
  // administrator only for labelled setup/capture/readback; every writer pool call below
  // independently re-enters its actual restricted identity before running test operations.
  await f.raw.exec("SET SESSION AUTHORIZATION postgres; RESET ROLE");
  assert.equal((await f.db.query<{ current_user: string }>("SELECT current_user")).rows[0].current_user, "postgres");
  return work();
}
async function writer(f: Base, wrapResults: (db: DatabaseClient) => DatabaseClient = db => db) {
  await f.raw.exec(await readFile("db/roles/native_results_roles.sql", "utf8"));
  await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await f.raw.exec(`CREATE ROLE result_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE result_coordinator_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_results TO result_test; GRANT control_room_task_coordinator TO result_coordinator_test;
    SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
    SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
  const pool = (login: "result_test" | "result_coordinator_test") => {
    let available = true, closes = 0;
    const client: DatabaseClient = {
      query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
      transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
      transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
        await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
        return work(tx);
      }, check),
    };
    return { client, isAvailable: () => available, unavailable: () => { available = false; },
      close: async () => { available = false; closes++; }, closes: () => closes };
  };
  const results = pool("result_test"), coordinator = pool("result_coordinator_test");
  // Sole preflight adaptation: known PGlite TEMP metadata limitation. Actual SQL roles/guards remain real.
  const checked: DatabaseClient = { ...results.client, transaction: work => results.client.transaction(tx => work({
    async query<T>(sql: string, params?: unknown[]) { const value = await tx.query<T>(sql, params);
      if (sql.includes("AS database_temp")) value.rows = value.rows.map(row => ({ ...row, database_temp: false })); return value; },
  })) };
  const quality: TaskQualityConfiguration = { ...f.ownerConfig, scenarios: [] };
  const owner = createTaskCoordinatorLifecycle({ scope: f.scope, planning: f.plannerConfig, routes: [f.route], quality,
    database: coordinator, resultDatabase: { ...results, client: wrapResults(results.client) }, clock: f.clock });
  const verify = () => verifyNativeResultDatabase(checked, { host: "127.0.0.1", port: 5432, database: "template1",
    username: "result_test", password: "synthetic-only", majorVersion: 17 },
  { ...f.scope, ownerIdentityId: "identity:test", issuer: f.accessTrust.issuer }, f.clock());
  const direct = (db = results.client, config = quality, clock = f.clock) => new TaskResultCoordinator(db, f.scope, f.plannerConfig, config, clock);
  return { results, coordinator, owner, verify, direct, quality };
}
async function initialFixture(wrapResults?: (db: DatabaseClient) => DatabaseClient) {
  const x = await nativeTaskLifecycleFixture();
  try {
    // Run registration and fake progress/capture are fixture preparation, not writer authority.
    await x.f.runs.create(x.registration); const w = await writer(x.f, wrapResults);
    const request = { projectId: x.registration.projectId, jobId: x.registration.jobId, runId: x.registration.id };
    const capture = () => fixtureAdmin(x.f, async () => {
      await x.handoff.start(); await x.publish(); x.advance(); await x.handoff.poll(); await x.publish();
      x.advance(); x.setResult(qualityText); await x.handoff.poll(); const completed = await x.publish();
      // Deliberately no submission dependency: only the separately restricted owner may create the target.
      return new NativeTaskResultService(x.f.auth, x.f.runs, x.f.results).ingest(completed.raw, new TextEncoder().encode(qualityText), x.options());
    });
    return { ...x, ...w, request, capture, close: async () => { await w.owner.close(); await x.close(); } };
  } catch (error) { await x.close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof initialFixture>>;
const gateRows = async (x: Fixture) => (await x.results.client.query("SELECT * FROM control_completion_gate_records ORDER BY id")).rows;
const plans = async (x: Fixture) => (await x.results.client.query("SELECT * FROM control_native_review_plans WHERE run_id=$1", [x.request.runId])).rows;
const checkpoint = (x: Fixture) => x.f.checkpoints.read(`completion-gate:${x.registration.tenantId}`);
async function sourceState(x: Fixture) {
  return fixtureAdmin(x.f, async () => ({ job: await x.f.canonical.get(x.registration.tenantId, "job", x.request.jobId),
    attempt: await x.f.canonical.get(x.registration.tenantId, "attempt", x.registration.attemptId),
    lease: await x.f.canonical.get(x.registration.tenantId, "lease", x.registration.nativeTask!.leaseId) }));
}
function intercept(db: DatabaseClient, after: (sql: string) => void): DatabaseClient {
  const wrap = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
    const result = await tx.query<T>(sql, params); after(sql); return result;
  } });
  return { ...db, transaction: work => db.transaction(tx => work(wrap(tx))),
    transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
}

test("restricted owner registers and submits a real initial native result without canonical or quality acceptance effects", async t => {
  const x = await initialFixture(); t.after(x.close); await x.verify(); const before = await sourceState(x), cp = checkpoint(x);
  const registered = await x.owner.results!.register(x.request, signal());
  assert.equal(registered.replayed, false); assert.equal(registered.receipt.startsWork, false);
  assert.equal(registered.receipt.grantsExecutionAuthority, false); assert.deepEqual(checkpoint(x), cp);
  assert.equal((await plans(x)).length, 1); assert.deepEqual(await x.owner.results!.register(x.request, signal()), { ...registered, replayed: true });
  await x.capture(); const calls = [...x.local.calls], gate = await gateRows(x), beforeSubmit = checkpoint(x)!;
  const saved = await x.owner.results!.submit(x.request, signal()); assert.equal(saved.replayed, false);
  assert.equal(saved.receipt.qualityAccepted, false); assert.equal(saved.receipt.rootSubjectId, x.request.jobId);
  assert.equal(saved.receipt.revisionNumber, 0); assert.equal(saved.receipt.targetId, registered.receipt.targetId);
  assert.equal(checkpoint(x)!.revision, beforeSubmit.revision + 1); assert.equal((await gateRows(x)).length, gate.length + 1);
  const target = await x.f.reviewStore.snapshot(x.registration.tenantId, saved.receipt.targetId);
  assert.equal(target.status, "pending"); assert.equal(target.target.producer.actorId, x.registration.nodeId);
  const concurrent = await Promise.all([x.owner.results!.submit(x.request, signal()), x.owner.results!.submit(x.request, signal())]);
  for (const value of concurrent) assert.deepEqual(value, { ...saved, replayed: true });
  assert.deepEqual(await sourceState(x), before); assert.deepEqual(x.local.calls, calls);
  assert.equal((await x.results.client.query(`SELECT a.id FROM audit_events a JOIN control_native_artifact_receipts r
    ON r.artifact_id=a.target_id AND r.tenant_id=a.tenant_id WHERE a.action='task.result.submitted_for_review' AND r.run_id=$1`, [x.request.runId])).rows.length, 1);
  assert.equal(JSON.stringify(saved).includes(qualityText), false);
});

test("restricted writer binds and submits an actual revised child; original generation is explicitly privileged fixture setup", async t => {
  const x = await nativeRevisedExecutionFixture(); t.after(x.close);
  const queries: { sql: string; params: unknown[] }[] = [];
  const w = await writer(x.f, db => ({ ...db, transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) { queries.push({ sql, params: params ?? [] }); return tx.query<T>(sql, params); },
  }), check) })); t.after(() => w.owner.close()); await w.verify();
  const request = { projectId: x.plan.projectId, jobId: x.plan.job.id, runId: x.registration.id };
  const states = () => fixtureAdmin(x.f, async () => ({ source: await x.sourceStates(), child: await x.childStates() }));
  const priorStates = await states(), before = x.f.checkpoints.read(`completion-gate:${x.plan.tenantId}`)!;
  const registered = await w.owner.results!.register(request, signal()); assert.equal(registered.replayed, false);
  const firstGate = queries.findIndex(value => value.sql.includes("control_completion_gate_integrity") && value.sql.includes("FOR UPDATE"));
  const sourceRun = queries.findIndex(value => value.sql.includes("control_harness_runs") && value.sql.includes("FOR UPDATE") && value.params.includes(x.source.runId));
  const sourceJob = queries.findIndex(value => value.sql.includes("control_jobs") && value.sql.includes("FOR UPDATE")
    && (value.params.includes(x.source.jobId) || value.params.includes(x.source.runId)));
  assert.ok(firstGate >= 0 && sourceRun >= 0 && sourceRun < firstGate && sourceJob >= 0 && sourceJob < firstGate,
    "actual predecessor native run and job locks must precede the first gate lock");
  const delivered = await fixtureAdmin(x.f, () => x.deliver(revisedText, false)), calls = x.counters();
  const saved = await w.owner.results!.submit(request, signal()); assert.equal(saved.replayed, false);
  assert.equal(saved.receipt.contentHash, delivered.artifact.contentHash); assert.equal(saved.receipt.rootSubjectId, x.source.target.subjectId);
  assert.equal(saved.receipt.revisionNumber, 1); assert.equal(saved.receipt.jobId, x.plan.job.id);
  assert.equal(x.f.checkpoints.read(`completion-gate:${x.plan.tenantId}`)!.revision, before.revision + 2);
  assert.equal((await x.f.reviewStore.snapshot(x.plan.tenantId, x.source.target.id)).status, "superseded");
  const target = (await x.f.reviewStore.snapshot(x.plan.tenantId, saved.receipt.targetId)).target;
  assert.equal(target.producer.actorId, x.registration.nodeId); assert.equal(target.supersedesTargetId, x.source.target.id);
  assert.deepEqual(await w.owner.results!.submit(request, signal()), { ...saved, replayed: true });
  assert.deepEqual(await states(), priorStates); assert.deepEqual(x.counters(), calls);
});

test("writer refuses wrong scope, caller profile/context, unavailable bytes and invalid saved-plan signing key", async t => {
  const x = await initialFixture(); t.after(x.close); const before = await gateRows(x);
  for (const patch of [{ projectId: "project:other" }, { jobId: "job:other" }, { runId: "run:other" },
    { acceptanceProfileId: "profile:caller" }, { revision: {} }, { bytes: "caller bytes" }])
    await assert.rejects(async () => x.owner.results!.register({ ...x.request, ...patch }, signal()));
  await x.owner.results!.register(x.request, signal()); await x.capture();
  for (const read of [async () => undefined, async () => new TextEncoder().encode("Changed saved bytes")])
    await assert.rejects(x.direct(x.results.client, { ...x.quality, results: { ...x.quality.results, storage: { read } } }).submit(x.request, signal()));
  const planning = { ...x.f.plannerConfig, integrityKey: new Uint8Array(32).fill(91) };
  await assert.rejects(new TaskResultCoordinator(x.results.client, x.f.scope, planning, x.quality, x.f.clock).submit(x.request, signal()));
  assert.deepEqual(await gateRows(x), before);
});

test("new registration retains its native deadline through the final outer precommit", async t => {
  const x = await initialFixture(); t.after(x.close); const deadline = Date.parse(x.registration.nativeTask!.deadline);
  let now = deadline - 1, reached = false;
  const db: DatabaseClient = { ...x.results.client, transactionWithPreCommitCheck: (work, check) =>
    x.results.client.transactionWithPreCommitCheck(work, () => { reached = true; now = deadline; check(); }) };
  const gate = await gateRows(x), cp = checkpoint(x);
  await assert.rejects(x.direct(db, x.quality, () => now).register(x.request, signal()));
  assert.equal(reached, true); assert.deepEqual(await plans(x), []);
  assert.deepEqual(await gateRows(x), gate); assert.deepEqual(checkpoint(x), cp);
});

test("writer health loss after durable commit rejects acknowledgement and all retained lifecycle handles", async t => {
  let loseHealth = () => {}; let committed = false;
  const x = await initialFixture(db => ({ ...db, async transactionWithPreCommitCheck(work, check) {
    const result = await db.transactionWithPreCommitCheck(work, check); committed = true; loseHealth(); return result;
  } })); t.after(x.close); loseHealth = x.results.unavailable;
  await assert.rejects(x.owner.results!.register(x.request, signal())); assert.equal(committed, true);
  assert.equal((await plans(x)).length, 1, "uncertain acknowledgement must not erase the durable binding");
  await assert.rejects(x.owner.results!.register(x.request, signal()));
  await assert.rejects(x.owner.results!.submit(x.request, signal()));
  assert.equal((await x.direct().register(x.request, signal())).replayed, true,
    "explicit fresh service readback can inspect the saved binding, not revive the unhealthy lifecycle");
});

test("fresh registration refuses expired deadlines, but exact registered binding replays after expiry and project closure", async t => {
  for (const registered of [false, true]) await t.test(String(registered), async t => {
    const x = await initialFixture(); t.after(x.close);
    const saved = registered ? await x.owner.results!.register(x.request, signal()) : undefined;
    x.f.setNow(Date.parse(x.registration.nativeTask!.deadline) + 1);
    // Privileged fixture preparation models closure only; the writer is never given project mutation rights.
    await fixtureAdmin(x.f, () => x.f.db.query("UPDATE control_manual_project_heads SET lifecycle='archived' WHERE project_id=$1", [x.request.projectId]));
    if (saved) assert.deepEqual(await x.owner.results!.register(x.request, signal()), { ...saved, replayed: true });
    else { await assert.rejects(x.owner.results!.register(x.request, signal())); assert.deepEqual(await plans(x), []); }
  });
});

test("SQL errors and final-precommit cancellation or time rollback leave no target or checkpoint advance", async t => {
  for (const mode of ["sql", "cancel", "clock"] as const) await t.test(mode, async t => {
    const x = await initialFixture(); t.after(x.close); await x.owner.results!.register(x.request, signal()); await x.capture();
    const before = await gateRows(x), cp = checkpoint(x), abort = new AbortController(), start = x.f.clock(); let now = start, wrote = false;
    const observed = intercept(x.results.client, sql => {
      if (sql.includes("INSERT INTO audit_events")) { wrote = true;
        assert.deepEqual(checkpoint(x), cp, "nested checkpoint must remain staged before outer precommit");
        if (mode === "sql") throw new Error("synthetic_result_sql_failure");
        if (mode === "clock") now = start + 100;
      }
    });
    const db: DatabaseClient = { ...observed, transactionWithPreCommitCheck: (work, check) => observed.transactionWithPreCommitCheck(work, () => {
      if (mode === "cancel") abort.abort(); if (mode === "clock") now = start + 50; check();
    }) };
    await assert.rejects(x.direct(db, x.quality, () => now).submit(x.request, abort.signal));
    assert.equal(wrote, true); assert.deepEqual(await gateRows(x), before); assert.deepEqual(checkpoint(x), cp);
  });
});

test("lost acknowledgement of register or submit reconciles one durable binding and checkpoint without native replay", async t => {
  for (const operation of ["register", "submit"] as const) await t.test(operation, async t => {
    const x = await initialFixture(); t.after(x.close);
    if (operation === "submit") { await x.owner.results!.register(x.request, signal()); await x.capture(); }
    const calls = [...x.local.calls]; let committed = false;
    const db: DatabaseClient = { ...x.results.client, async transactionWithPreCommitCheck(work, check) {
      await x.results.client.transactionWithPreCommitCheck(work, check); committed = true; throw new Error("synthetic_result_ack_lost");
    } };
    await assert.rejects(x.direct(db)[operation](x.request, signal())); assert.equal(committed, true);
    const cp = checkpoint(x), gate = await gateRows(x);
    assert.equal((await x.owner.results![operation](x.request, signal())).replayed, true);
    assert.deepEqual(checkpoint(x), cp); assert.deepEqual(await gateRows(x), gate); assert.deepEqual(x.local.calls, calls);
  });
});

test("source generation invalidation at result precommit rolls back registration and submission", async t => {
  for (const operation of ["register", "submit"] as const) await t.test(operation, async t => {
    const x = await initialFixture(); t.after(x.close);
    if (operation === "submit") { await x.owner.results!.register(x.request, signal()); await x.capture(); }
    const beforePlans = await plans(x), beforeGate = await gateRows(x), cp = checkpoint(x), calls = [...x.local.calls];
    let current = true, reachedCommit = false;
    const db: DatabaseClient = { ...x.results.client,
      transactionWithPreCommitCheck: (work, check) => x.results.client.transactionWithPreCommitCheck(work, () => {
        reachedCommit = true; current = false; check();
      }) };
    await assert.rejects(x.direct(db)[operation](x.request, signal(), () => {
      if (!current) throw new Error("synthetic_source_generation_replaced");
    }), /synthetic_source_generation_replaced/);
    assert.equal(reachedCommit, true);
    assert.deepEqual(await plans(x), beforePlans); assert.deepEqual(await gateRows(x), beforeGate);
    assert.deepEqual(checkpoint(x), cp); assert.deepEqual(x.local.calls, calls);
  });
});

test("input capture, cancellation and writer health/close invalidate only bounded owner operations", async t => {
  const x = await initialFixture(); t.after(x.close);
  const abort = new AbortController(); abort.abort(); await assert.rejects(x.owner.results!.register(x.request, abort.signal));
  const request = { ...x.request }, pending = x.owner.results!.register(request, signal()); request.jobId = "job:mutated";
  assert.equal((await pending).receipt.jobId, x.request.jobId);
  x.results.unavailable(); await assert.rejects(x.owner.results!.register(x.request, signal()));
  const retained = x.owner.results!; await x.owner.close(); await x.owner.close();
  assert.equal(x.results.closes(), 1); assert.equal(x.coordinator.closes(), 1);
  await assert.rejects(retained.submit(x.request, signal()));
});
