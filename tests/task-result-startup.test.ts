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

async function resultStartupFixture() {
  const x = await nativeQualityCompletionFixture();
  const startup = await taskStartupFixture(x.f.assignmentFixture);
  await startup.raw.exec(await readFile("db/roles/native_results_roles.sql", "utf8"));
  await startup.raw.exec(`CREATE ROLE result_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_results TO result_test`);
  let closes = 0, available = true;
  const client: DatabaseClient = {
    query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
    transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
    transactionWithPreCommitCheck: (work, check) => startup.db.transactionWithPreCommitCheck(async tx => {
      await tx.query("SET LOCAL SESSION AUTHORIZATION result_test");
      const session: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
        return result;
      } };
      return work(session);
    }, check),
  };
  const result = { client, close: async () => { closes++; available = false; }, isAvailable: () => available,
    closes: () => closes, quarantine: () => { available = false; } };
  const quality = qualityConfiguration(x);
  const resultDatabase = { ...startup.config.coordinator.database, username: "result_test" };
  const webUsername = startup.config.web.database.username;
  const coordinatorUsername = startup.config.coordinator.database.username;
  const resultUsername = resultDatabase.username;
  const config: PrivateTaskStartupConfiguration = { ...startup.config, coordinator: { ...startup.config.coordinator,
    quality, resultDatabase } };
  const openDatabase = (database: { username: string }) => {
    if (database.username === webUsername) return startup.web;
    if (database.username === coordinatorUsername) return startup.coordinator;
    if (database.username === resultUsername) return result;
    throw new Error("unexpected_test_database");
  };
  return { x, startup, result, quality, resultDatabase, config, openDatabase };
}

test("optional result ownership verifies three distinct roles before install and captures all inputs", async t => {
  const f = await resultStartupFixture(); t.after(f.x.close);
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
    return { ...pool, client: { ...db,
      transaction: work => db.transaction(observe(work)),
      transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(observe(work), check),
    } };
  }, install: value => { assert.equal(preflights.length, 3); app = value; installs++; } });

  const starting = bootstrap.start(f.config);
  f.config.coordinator.resultDatabase!.username = "mutated_result_login";
  f.quality.integrityKey.fill(0); f.quality.harnessIntegrityKey.fill(0); f.quality.results.integrityKey.fill(0);
  f.quality.results.storage = { read: async () => undefined };
  const runtime = await starting;
  assert.equal(installs, 1); assert.equal(runtime.isReady(), true);
  assert.deepEqual(opened, ["web_test", "coordinator_test", "result_test"]);
  assert.deepEqual(preflights, [
    { username: "web_test", current_user: "web_test", session_user: "web_test", rolsuper: false },
    { username: "coordinator_test", current_user: "coordinator_test", session_user: "coordinator_test", rolsuper: false },
    { username: "result_test", current_user: "result_test", session_user: "result_test", rolsuper: false },
  ]);
  assert.deepEqual(Object.keys(runtime).sort(), ["close", "isReady", "quality", "results"]);
  assert.deepEqual(Object.keys(app).sort(), ["close", "handle", "isReady", "quality", "results"]);
  assert.ok(runtime.results);
  assert.deepEqual(Object.keys(runtime.results).sort(), ["register", "submit", "tenantId", "workspaceId"]);
  const exposed = JSON.stringify(runtime);
  for (const forbidden of ["client", "database", "password", "integrityKey", "harnessIntegrityKey", "result_test"])
    assert.equal(exposed.includes(forbidden), false, forbidden);

  const input = { projectId: f.x.registration.projectId, jobId: f.x.registration.jobId, runId: f.x.registration.id };
  const registered = await runtime.results.register(input, new AbortController().signal);
  assert.equal(registered.replayed, true); assert.equal(registered.receipt.targetId, f.x.target.id);
  assert.equal(registered.receipt.startsWork, false); assert.equal(registered.receipt.grantsExecutionAuthority, false);
  const submitted = await runtime.results.submit(input, new AbortController().signal);
  assert.equal(submitted.replayed, true); assert.equal(submitted.receipt.targetId, f.x.target.id);
  assert.equal(submitted.receipt.contentHash, f.x.artifact.contentHash);
  assert.equal(submitted.receipt.qualityAccepted, false); assert.equal(submitted.receipt.grantsExecutionAuthority, false);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(runtime.results.register(input, aborted.signal), { message: "task_result_operation_uncertain" });

  const retained = runtime.results, closing = runtime.close();
  assert.equal(runtime.close(), closing); assert.equal(runtime.isReady(), false); await closing;
  assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1); assert.equal(f.result.closes(), 1);
  await assert.rejects(retained.register(input, new AbortController().signal), { message: "task_coordinator_unavailable" });
  await assert.rejects(retained.submit(input, new AbortController().signal), { message: "task_coordinator_unavailable" });
});

test("absence preserves the exact two-pool startup surface", async t => {
  const f = await taskStartupFixture(); t.after(f.close);
  let app!: PrivateApplication, opens = 0;
  const runtime = await createPrivateTaskBootstrap({ openDatabase: database => { opens++; return f.openDatabase(database); },
    install: value => { app = value; } }).start(f.config);
  assert.equal(opens, 2); assert.deepEqual(Object.keys(runtime).sort(), ["close", "isReady"]);
  assert.deepEqual(Object.keys(app).sort(), ["close", "handle", "isReady"]);
  assert.equal("results" in runtime, false); assert.equal("results" in app, false);
  await runtime.close(); assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 1);
});

test("invalid result topology is rejected before opening any pool", async t => {
  const f = await resultStartupFixture(); t.after(f.x.close); let effects = 0;
  const variants: PrivateTaskStartupConfiguration[] = [
    { ...f.config, coordinator: { ...f.config.coordinator, quality: undefined } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      resultDatabase: { ...f.resultDatabase, username: f.config.web.database.username } } },
    { ...f.config, coordinator: { ...f.config.coordinator,
      resultDatabase: { ...f.resultDatabase, username: f.config.coordinator.database.username } } },
    { ...f.config, coordinator: { ...f.config.coordinator, resultDatabase: { ...f.resultDatabase, port: 5433 } } },
    { ...f.config, coordinator: { ...f.config.coordinator, resultDatabase: { ...f.resultDatabase, database: "another" } } },
  ];
  for (const config of variants) {
    const bootstrap = createPrivateTaskBootstrap({ openDatabase: () => { effects++; throw new Error(); }, install: () => { effects++; } });
    await assert.rejects(bootstrap.start(config), { message: "private_task_startup_config_invalid" });
    await assert.rejects(bootstrap.start(f.config), /already_attempted/);
  }
  assert.equal(effects, 0);
});

test("third-pool open, preflight, alias, health and install failures close every acquired resource once", async t => {
  for (const failure of ["third-open", "preflight", "resource-alias", "client-alias", "unavailable", "install"] as const)
    await t.test(failure, async t => {
      const f = await resultStartupFixture(); t.after(f.x.close); let opens = 0, installs = 0;
      if (failure === "preflight")
        await f.startup.raw.exec("REVOKE SELECT ON control_native_review_plans FROM control_room_native_results");
      if (failure === "unavailable") f.result.quarantine();
      const bootstrap = createPrivateTaskBootstrap({ clock: f.x.f.clock, openDatabase: database => {
        opens++;
        if (failure === "third-open" && opens === 3) throw new Error("private third-open detail");
        if (failure === "resource-alias" && opens === 3) return f.startup.coordinator;
        if (failure === "client-alias" && opens === 3) return { ...f.result, client: f.startup.coordinator.client };
        return f.openDatabase(database);
      }, install: () => { installs++; if (failure === "install") throw new Error("private install detail"); } });
      await assert.rejects(bootstrap.start(f.config), { message: "private_task_startup_prerequisites_failed" });
      assert.equal(installs, failure === "install" ? 1 : 0);
      assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1);
      assert.equal(f.result.closes(), ["third-open", "resource-alias"].includes(failure) ? 0 : 1);
    });
});

test("result operations share graceful drain and result-pool health invalidates the whole runtime", async t => {
  const f = await resultStartupFixture(); t.after(f.x.close);
  const entered = deferred(), release = deferred(); let hold = false;
  const result = { ...f.result, client: { ...f.result.client,
    transactionWithPreCommitCheck: async <T>(work: (tx: DatabaseSession) => Promise<T>, check: () => void) => {
      if (hold) { entered.resolve(); await release.promise; }
      return f.result.client.transactionWithPreCommitCheck(work, check);
    },
  } };
  const runtime = await createPrivateTaskBootstrap({ clock: f.x.f.clock,
    openDatabase: database => database.username === "result_test" ? result : f.openDatabase(database), install: () => {} }).start(f.config);
  assert.ok(runtime.results);
  const input = { projectId: f.x.registration.projectId, jobId: f.x.registration.jobId, runId: f.x.registration.id };
  hold = true;
  const saving = runtime.results.register(input, new AbortController().signal); await entered.promise;
  const closing = runtime.close(); assert.equal(runtime.isReady(), false); assert.equal(f.result.closes(), 0);
  release.resolve(); assert.equal((await saving).replayed, true); await closing;
  assert.equal(f.startup.coordinator.closes(), 1); assert.equal(f.result.closes(), 1);

  const unhealthy = await resultStartupFixture(); t.after(unhealthy.x.close);
  const second = await createPrivateTaskBootstrap({ clock: unhealthy.x.f.clock,
    openDatabase: unhealthy.openDatabase, install: () => {} }).start(unhealthy.config);
  assert.ok(second.results); unhealthy.result.quarantine(); assert.equal(second.isReady(), false);
  await assert.rejects(second.results.submit({ projectId: unhealthy.x.registration.projectId,
    jobId: unhealthy.x.registration.jobId, runId: unhealthy.x.registration.id }, new AbortController().signal),
  { message: "task_coordinator_unavailable" });
  await second.close(); assert.equal(unhealthy.result.closes(), 1);
});

test("result-pool health lost after transaction acknowledgement reports uncertainty", async t => {
  const f = await resultStartupFixture(); t.after(f.x.close); let fence = false;
  const result = { ...f.result, client: { ...f.result.client,
    async transactionWithPreCommitCheck<T>(work: (tx: DatabaseSession) => Promise<T>, check: () => void) {
      const value = await f.result.client.transactionWithPreCommitCheck(work, check);
      if (fence) f.result.quarantine();
      return value;
    },
  } };
  const runtime = await createPrivateTaskBootstrap({ clock: f.x.f.clock,
    openDatabase: database => database.username === "result_test" ? result : f.openDatabase(database), install: () => {} }).start(f.config);
  assert.ok(runtime.results); fence = true;
  const input = { projectId: f.x.registration.projectId, jobId: f.x.registration.jobId, runId: f.x.registration.id };
  await assert.rejects(runtime.results.submit(input, new AbortController().signal),
    { message: "task_coordinator_save_uncertain" });
  assert.equal(runtime.isReady(), false);
  assert.equal((await f.x.submission.submit(f.x.registration.tenantId, f.x.registration.id)).replayed, true);
  await runtime.close(); assert.equal(f.result.closes(), 1);
});

test("a failed result close makes cleanup uncertain without retry", async t => {
  const f = await resultStartupFixture(); t.after(f.x.close); let resultCloses = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: f.x.f.clock, openDatabase: database => {
    const pool = f.openDatabase(database);
    return database.username === "result_test" ? { ...pool, close: async () => { resultCloses++; throw new Error("private close detail"); } } : pool;
  }, install: () => { throw new Error("private install detail"); } });
  await assert.rejects(bootstrap.start(f.config), { message: "private_task_startup_cleanup_uncertain" });
  assert.equal(resultCloses, 1); assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1);
  await assert.rejects(bootstrap.start(f.config), /already_attempted/); assert.equal(resultCloses, 1);
});
