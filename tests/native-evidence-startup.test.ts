import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { PrivateApplication } from "../src/web/v1/private-process";
import { createPrivateTaskBootstrap, type PrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import type { TaskQualityConfiguration } from "../src/web/v1/task-quality-coordinator";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion";
import { taskStartupFixture } from "./helpers/task-startup";

type QualityFixture = Awaited<ReturnType<typeof nativeQualityCompletionFixture>>;
type Pool = ReturnType<typeof restrictedPool>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function qualityConfiguration(x: QualityFixture): TaskQualityConfiguration {
  return {
    integrityKey: Uint8Array.from(x.f.ownerConfig.integrityKey),
    harnessIntegrityKey: Uint8Array.from(x.f.ownerConfig.harnessIntegrityKey),
    checkpoints: x.f.ownerConfig.checkpoints,
    results: { ...x.f.ownerConfig.results, integrityKey: Uint8Array.from(x.f.ownerConfig.results.integrityKey) },
    scenarios: [{ ...x.scenario, rules: { ...x.scenario.rules,
      requiredHeadings: [...x.scenario.rules.requiredHeadings], forbiddenTerms: [...x.scenario.rules.forbiddenTerms] } }],
  };
}

function restrictedPool(startup: Awaited<ReturnType<typeof taskStartupFixture>>, login: string) {
  let closes = 0, available = true;
  const client: DatabaseClient = {
    query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
    transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
    transactionWithPreCommitCheck: (work, check) => startup.db.transactionWithPreCommitCheck(async tx => {
      await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
      const session: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
        return result;
      } };
      return work(session);
    }, check),
  };
  return { client, close: async () => { closes++; available = false; }, isAvailable: () => available,
    closes: () => closes, quarantine: () => { available = false; } };
}

async function evidenceStartupFixture() {
  const x = await nativeQualityCompletionFixture();
  const startup = await taskStartupFixture(x.f.assignmentFixture);
  await startup.raw.exec(await readFile("db/roles/native_results_roles.sql", "utf8"));
  await startup.raw.exec(await readFile("db/roles/native_evidence_roles.sql", "utf8"));
  await startup.raw.exec(`CREATE ROLE result_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE evidence_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_results TO result_test; GRANT control_room_native_evidence TO evidence_test`);
  const result = restrictedPool(startup, "result_test"), evidence = restrictedPool(startup, "evidence_test");
  const quality = qualityConfiguration(x);
  const resultDatabase = { ...startup.config.coordinator.database, username: "result_test" };
  const evidenceDatabase = { ...startup.config.coordinator.database, username: "evidence_test" };
  const evidenceSettings = { database: evidenceDatabase,
    integrityKey: new Uint8Array(32).fill(75),
    storage: { ...x.f.config, integrityKey: Uint8Array.from(x.f.config.integrityKey) },
    enrollments: [{ ...x.f.prepared.enrollment }] };
  const config: PrivateTaskStartupConfiguration = { ...startup.config, coordinator: { ...startup.config.coordinator,
    quality, resultDatabase, evidence: evidenceSettings } };
  // Capture the expected routing independently of the caller-owned configuration that tests mutate.
  const webUsername = startup.config.web.database.username;
  const coordinatorUsername = startup.config.coordinator.database.username;
  const resultUsername = resultDatabase.username;
  const evidenceUsername = evidenceDatabase.username;
  const openDatabase = (database: { username: string }) => {
    if (database.username === webUsername) return startup.web;
    if (database.username === coordinatorUsername) return startup.coordinator;
    if (database.username === resultUsername) return result;
    if (database.username === evidenceUsername) return evidence;
    throw new Error("unexpected_test_database");
  };
  return { x, startup, result, evidence, quality, resultDatabase, evidenceDatabase, evidenceSettings, config, openDatabase };
}

test("optional evidence receiver verifies four distinct roles before install and captures configuration", async t => {
  const f = await evidenceStartupFixture(); t.after(f.x.close);
  let app!: PrivateApplication, installs = 0;
  const opened: string[] = [], preflights: { username: string; current_user: string; session_user: string; rolsuper: boolean }[] = [];
  const bootstrap = createPrivateTaskBootstrap({ clock: f.x.f.clock, openDatabase: database => {
    opened.push(database.username);
    const pool = f.openDatabase(database), db = pool.client;
    const observe = <T>(work: (tx: DatabaseSession) => Promise<T>) => async (tx: DatabaseSession): Promise<T> => work({ async query<U>(sql: string, params?: unknown[]) {
      const value = await tx.query<U>(sql, params);
      if (sql.includes("AS database_temp")) {
        const identity = (await tx.query<{ current_user: string; session_user: string; rolsuper: boolean }>(
          "SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0]!;
        preflights.push({ username: database.username, ...identity });
      }
      return value;
    } });
    return { ...pool, client: { ...db, transaction: work => db.transaction(observe(work)),
      transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(observe(work), check) } };
  }, install: value => { assert.equal(preflights.length, 4); app = value; installs++; } });

  const starting = bootstrap.start(f.config);
  f.config.coordinator.evidence!.database.username = "mutated_evidence_login";
  f.evidenceSettings.enrollments[0]!.nodeId = "node:mutated";
  f.evidenceSettings.integrityKey.fill(0);
  f.evidenceSettings.storage.integrityKey.fill(0);
  f.evidenceSettings.storage.storage = { put: async () => { throw new Error("mutated_put"); }, read: async () => undefined };
  const runtime = await starting;
  assert.equal(installs, 1); assert.equal(runtime.isReady(), true);
  assert.deepEqual(opened, ["web_test", "coordinator_test", "result_test", "evidence_test"]);
  assert.deepEqual(preflights, [
    { username: "web_test", current_user: "web_test", session_user: "web_test", rolsuper: false },
    { username: "coordinator_test", current_user: "coordinator_test", session_user: "coordinator_test", rolsuper: false },
    { username: "result_test", current_user: "result_test", session_user: "result_test", rolsuper: false },
    { username: "evidence_test", current_user: "evidence_test", session_user: "evidence_test", rolsuper: false },
  ]);
  assert.deepEqual(Object.keys(runtime).sort(), ["close", "evidence", "isReady", "quality", "results"]);
  assert.deepEqual(Object.keys(app).sort(), ["close", "evidence", "handle", "isReady", "quality", "results"]);
  assert.ok(runtime.evidence);
  assert.deepEqual(Object.keys(runtime.evidence).sort(), ["receive", "register", "tenantId", "workspaceId"]);
  for (const forbidden of ["client", "database", "password", "integrityKey", "harnessIntegrityKey", "evidence_test"])
    assert.equal(JSON.stringify(runtime).includes(forbidden), false, forbidden);

  const input = { projectId: f.x.registration.projectId, jobId: f.x.registration.jobId,
    attemptId: f.x.registration.attemptId, inputDigest: f.x.f.assignmentFixture.prepared.receipt.inputDigest };
  const registered = await runtime.evidence.register(input, new AbortController().signal);
  assert.equal(registered.replayed, true); assert.equal(registered.receipt.targetId, f.x.target.id);
  assert.equal(registered.receipt.runId, f.x.registration.id); assert.equal(registered.receipt.startsWork, false);
  assert.equal(registered.receipt.grantsExecutionAuthority, false);
  await f.startup.raw.exec("SET SESSION AUTHORIZATION postgres");

  const retained = runtime.evidence, closing = runtime.close();
  assert.equal(runtime.close(), closing); assert.equal(runtime.isReady(), false); await closing;
  assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1);
  assert.equal(f.result.closes(), 1); assert.equal(f.evidence.closes(), 1);
  await assert.rejects(retained.register(input, new AbortController().signal), { message: "task_coordinator_unavailable" });
});

test("omitting evidence preserves the exact prior three-pool result-writer surface", async t => {
  const f = await evidenceStartupFixture(); t.after(f.x.close);
  const prior = { ...f.config, coordinator: { ...f.config.coordinator, evidence: undefined } };
  let app!: PrivateApplication, opens = 0;
  const runtime = await createPrivateTaskBootstrap({ clock: f.x.f.clock,
    openDatabase: database => { opens++; return f.openDatabase(database); }, install: value => { app = value; } }).start(prior);
  assert.equal(opens, 3); assert.deepEqual(Object.keys(runtime).sort(), ["close", "isReady", "quality", "results"]);
  assert.deepEqual(Object.keys(app).sort(), ["close", "handle", "isReady", "quality", "results"]);
  assert.equal("evidence" in runtime, false); assert.equal("evidence" in app, false);
  await runtime.close(); assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1);
  assert.equal(f.result.closes(), 1); assert.equal(f.evidence.closes(), 0);
});

test("invalid evidence topology and authority bindings are rejected before opening any pool", async t => {
  const f = await evidenceStartupFixture(); t.after(f.x.close); let effects = 0;
  const evidence = f.config.coordinator.evidence!;
  const wrongKey = Uint8Array.from(evidence.storage.integrityKey); wrongKey[0] ^= 1;
  const variants: PrivateTaskStartupConfiguration[] = [
    { ...f.config, coordinator: { ...f.config.coordinator, quality: undefined } },
    { ...f.config, coordinator: { ...f.config.coordinator, resultDatabase: undefined } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      evidence: { ...evidence, database: { ...evidence.database, username: f.config.web.database.username } } } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      evidence: { ...evidence, database: { ...evidence.database, username: f.config.coordinator.database.username } } } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      evidence: { ...evidence, database: { ...evidence.database, username: f.resultDatabase.username } } } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      evidence: { ...evidence, database: { ...evidence.database, port: 5433 } } } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      evidence: { ...evidence, integrityKey: new Uint8Array(31) } } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      evidence: { ...evidence, storage: { ...evidence.storage, integrityKey: wrongKey } } } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      evidence: { ...evidence, enrollments: [{ ...evidence.enrollments[0]!, tenantId: "tenant:other" }] } } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      evidence: { ...evidence, enrollments: [evidence.enrollments[0]!, evidence.enrollments[0]!] } } },
  ];
  for (const config of variants) {
    const bootstrap = createPrivateTaskBootstrap({ openDatabase: () => { effects++; throw new Error(); }, install: () => { effects++; } });
    await assert.rejects(bootstrap.start(config), { message: "private_task_startup_config_invalid" });
    await assert.rejects(bootstrap.start(f.config), /already_attempted/);
  }
  assert.equal(effects, 0);
});

test("fourth-pool open, preflight, alias, health and install failures close each acquired resource once", async t => {
  for (const failure of ["fourth-open", "preflight", "extra-rights", "resource-alias", "client-alias", "unavailable", "install"] as const)
    await t.test(failure, async t => {
      const f = await evidenceStartupFixture(); t.after(f.x.close); let opens = 0, installs = 0;
      if (failure === "preflight")
        await f.startup.raw.exec("REVOKE SELECT ON control_native_delivery_receipts FROM control_room_native_evidence");
      if (failure === "extra-rights")
        await f.startup.raw.exec("GRANT SELECT ON control_completion_gate_records TO control_room_native_evidence");
      if (failure === "unavailable") f.evidence.quarantine();
      const bootstrap = createPrivateTaskBootstrap({ clock: f.x.f.clock, openDatabase: database => {
        opens++;
        if (failure === "fourth-open" && opens === 4) throw new Error("private fourth-open detail");
        if (failure === "resource-alias" && opens === 4) return f.result;
        if (failure === "client-alias" && opens === 4) return { ...f.evidence, client: f.result.client };
        return f.openDatabase(database);
      }, install: () => { installs++; if (failure === "install") throw new Error("private install detail"); } });
      await assert.rejects(bootstrap.start(f.config), { message: "private_task_startup_prerequisites_failed" });
      assert.equal(installs, failure === "install" ? 1 : 0);
      assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1); assert.equal(f.result.closes(), 1);
      assert.equal(f.evidence.closes(), ["fourth-open", "resource-alias"].includes(failure) ? 0 : 1);
    });
});

test("evidence operations share graceful drain and fourth-pool health invalidates retained commands", async t => {
  const f = await evidenceStartupFixture(); t.after(f.x.close);
  const entered = deferred(), release = deferred(); let hold = false, entries = 0;
  const evidence: Pool = { ...f.evidence, client: { ...f.evidence.client,
    transactionWithPreCommitCheck: async <T>(work: (tx: DatabaseSession) => Promise<T>, check: () => void) => {
      if (hold) { entries++; if (entries === 8) entered.resolve(); await release.promise; }
      return f.evidence.client.transactionWithPreCommitCheck(work, check);
    },
  } };
  const runtime = await createPrivateTaskBootstrap({ clock: f.x.f.clock,
    openDatabase: database => database.username === "evidence_test" ? evidence : f.openDatabase(database), install: () => {} }).start(f.config);
  assert.ok(runtime.evidence);
  const input = { projectId: f.x.registration.projectId, jobId: f.x.registration.jobId,
    attemptId: f.x.registration.attemptId, inputDigest: f.x.f.assignmentFixture.prepared.receipt.inputDigest };
  hold = true;
  const saving = Array.from({ length: 8 }, () => runtime.evidence!.register(input, new AbortController().signal));
  await entered.promise;
  await assert.rejects(runtime.evidence.register(input, new AbortController().signal),
    { message: "task_coordinator_unavailable" });
  const closing = runtime.close(); assert.equal(runtime.isReady(), false); assert.equal(f.evidence.closes(), 0);
  release.resolve(); assert.ok((await Promise.all(saving)).every(value => value.replayed)); await closing;
  assert.equal(f.startup.coordinator.closes(), 1); assert.equal(f.result.closes(), 1); assert.equal(f.evidence.closes(), 1);

  const unhealthy = await evidenceStartupFixture(); t.after(unhealthy.x.close);
  const second = await createPrivateTaskBootstrap({ clock: unhealthy.x.f.clock,
    openDatabase: unhealthy.openDatabase, install: () => {} }).start(unhealthy.config);
  assert.ok(second.evidence); unhealthy.evidence.quarantine(); assert.equal(second.isReady(), false);
  await assert.rejects(second.evidence.register({ projectId: unhealthy.x.registration.projectId,
    jobId: unhealthy.x.registration.jobId, attemptId: unhealthy.x.registration.attemptId,
    inputDigest: unhealthy.x.f.assignmentFixture.prepared.receipt.inputDigest }, new AbortController().signal),
  { message: "task_coordinator_unavailable" });
  await second.close(); assert.equal(unhealthy.evidence.closes(), 1);
});

test("a failed evidence close makes cleanup uncertain without retry", async t => {
  const f = await evidenceStartupFixture(); t.after(f.x.close); let evidenceCloses = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: f.x.f.clock, openDatabase: database => {
    const pool = f.openDatabase(database);
    return database.username === "evidence_test" ? { ...pool, close: async () => { evidenceCloses++; throw new Error("private close detail"); } } : pool;
  }, install: () => { throw new Error("private install detail"); } });
  await assert.rejects(bootstrap.start(f.config), { message: "private_task_startup_cleanup_uncertain" });
  assert.equal(evidenceCloses, 1); assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1);
  assert.equal(f.result.closes(), 1);
  await assert.rejects(bootstrap.start(f.config), /already_attempted/); assert.equal(evidenceCloses, 1);
});
