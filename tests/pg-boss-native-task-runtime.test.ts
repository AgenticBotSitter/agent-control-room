import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { startPgBossNativeTaskRuntime, type PgBossNativeRuntimeConstructor } from "../src/persistence/pg-boss-native-task-runtime";
import { nativeTaskSubmissionId, PG_BOSS_NATIVE_SUBMISSION as spec } from "../src/persistence/pg-boss-native-task-submission";
import type { PgBossNativeWorkerClient } from "../src/persistence/pg-boss-native-task-worker";
import { sha256Digest } from "../src/security";
import { createNativeQueueWorkerBootstrap } from "../src/web/v1/native-queue-worker-startup";
import type { DatabaseClient } from "../src/persistence/database";

const reference = () => {
  const ids = { tenantId: "tenant:runtime", jobId: "job:runtime", attemptId: "attempt:runtime" };
  return { schema: "control-room.native-task-submission/v1" as const, ...ids, projectId: "project:runtime",
    queueId: `native-queue:${sha256Digest(ids).slice(7)}`, inputDigest: sha256Digest("input"), packetDigest: sha256Digest("packet") };
};
function fixture() {
  const calls: string[] = [], active: Promise<unknown>[] = [];
  let options!: ConstructorParameters<PgBossNativeRuntimeConstructor>[0];
  let onError!: (error: unknown) => void, handler!: Parameters<PgBossNativeWorkerClient["work"]>[2];
  const hooks = { permissions: async (): Promise<unknown[]> => [{ valid: true }], start: async () => {}, stop: async () => {}, work: async () => {}, closeDb: async () => {}, off: async () => {} };
  const queue = { name: spec.name, table: spec.table, policy: "standard", partition: false, retryLimit: 0, deadLetter: null, notify: false };
  class Boss {
    constructor(value: typeof options) { calls.push("constructor"); options = value; }
    on(_event: "error", listener: typeof onError) { calls.push("listen"); onError = listener; }
    async start() { calls.push("start"); await hooks.start(); }
    async stop(value: { graceful: false }) { assert.deepEqual(value, { graceful: false }); calls.push("stop"); await hooks.stop(); }
    async getQueue() { return queue; }
    async work(_name: string, _options: unknown, callback: typeof handler) { handler = callback; calls.push("work"); await hooks.work(); return "worker:runtime"; }
    async offWork() { calls.push("off"); await hooks.off(); await Promise.allSettled(active); }
    async cancel() { calls.push("cancel"); }
  }
  const database = { async query<T>(sql: string) {
    if (sql.includes("pg-boss-worker-permissions/v1")) { calls.push("preflight"); return { rows: await hooks.permissions() as T[] }; }
    calls.push("sql"); return { rows: [] as T[] }; },
    async close() { calls.push("db-close"); await hooks.closeDb(); } };
  const start = (input: Parameters<typeof startPgBossNativeTaskRuntime>[2] = { async deliver() { return { disposition: "held" }; } }) =>
    startPgBossNativeTaskRuntime(Boss, database, input);
  const invoke = () => {
    const data = reference();
    const result = handler([{ id: nativeTaskSubmissionId(data), name: spec.name, data, retryCount: 0, retryLimit: 0,
      state: "active", policy: "standard", deadLetter: null, signal: new AbortController().signal }]);
    active.push(result); return result;
  };
  return { calls, hooks, queue, database, Boss, start, invoke, options: () => options, fault: () => onError(new Error("private upstream details")) };
}

test("dedicated package composition disables schema, scheduling and notification effects", async () => {
  const f = fixture(); let seen = 0;
  const input = { async deliver() { seen++; return { disposition: "held" as const }; }, concurrency: 2 };
  const runtime = await f.start(input);
  const { db, ...options } = f.options();
  assert.deepEqual(options, { schema: spec.schema, backend: "postgres", migrate: false, createSchema: false,
    supervise: false, schedule: false, useListenNotify: false });
  assert.deepEqual(f.calls.slice(0, 4), ["preflight", "constructor", "listen", "start"]);
  input.deliver = async () => { throw new Error("mutated callback"); };
  await f.invoke(); assert.equal(seen, 1);
  assert.deepEqual(runtime.status(), { state: "running", faulted: false, accepting: true });
  const close = runtime.close(); assert.equal(runtime.close(), close); await close;
  assert.deepEqual(f.calls.slice(-3), ["off", "stop", "db-close"]);
  assert.deepEqual(runtime.status(), { state: "closed", faulted: false, accepting: false });
  await assert.rejects(db.executeSql("SELECT 1"), /native_task_runtime_unavailable/);
  await assert.rejects(f.invoke(), /native_task_delivery_unresolved/); assert.equal(seen, 1);
});

test("invalid configuration does not acquire or close the caller's pool", async () => {
  for (const options of [{ concurrency: 0 }, { concurrency: 9 }, { operationTimeoutMs: 0 }, { operationTimeoutMs: 5001 }]) {
    const f = fixture();
    await assert.rejects(f.start({ async deliver() { return { disposition: "held" }; }, ...options }), /config_invalid/);
    assert.deepEqual(f.calls, []);
  }
});

test("worker bootstrap rejects a different primary, shared login and invalid concurrency before opening", async () => {
  const config = { host: "127.0.0.1" as const, port: 5432, database: "synthetic", username: "worker_test", password: "synthetic-only", majorVersion: 17 as const };
  const application = { host: config.host, port: config.port, database: config.database, loginNames: ["web_test", "coordinator_test"] };
  for (const patch of [{ application: { ...application, port: 5433 } }, { application: { ...application, database: "other" } },
    { application: { ...application, loginNames: ["web_test", "worker_test"] } }, { concurrency: 9 }]) {
    let opened = 0;
    const f = fixture();
    const bootstrap = createNativeQueueWorkerBootstrap({ PgBoss: f.Boss, openDatabase: () => { opened++; throw new Error(); } });
    const input = { database: config, application, async deliver() { return { disposition: "held" as const }; }, ...patch };
    await assert.rejects(bootstrap.start(input), /native_queue_worker_config_invalid/);
    await assert.rejects(bootstrap.start(input), /already_attempted/);
    assert.equal(opened, 0);
  }
});

test("worker configuration accepts seven distinct application logins but never eight or the worker login", async () => {
  const database = { host: "127.0.0.1" as const, port: 5432, database: "synthetic", username: "worker_test", password: "synthetic-only", majorVersion: 17 as const };
  const names = ["web_test", "coordinator_test", "result_test", "evidence_test", "session_test", "idea_test"];
  for (const loginNames of [names, [...names, "idea_runtime_test"], [...names, "idea_runtime_test", "extra_test"], [...names, "worker_test"]]) {
    let opened = 0; const f = fixture();
    const bootstrap = createNativeQueueWorkerBootstrap({ PgBoss: f.Boss, openDatabase: () => { opened++; throw new Error("synthetic open failure"); } });
    await assert.rejects(bootstrap.start({ database, application: { ...database, loginNames }, async deliver() { return { disposition: "held" }; } }));
    assert.equal(opened, loginNames.length <= 7 && !loginNames.includes("worker_test") ? 1 : 0);
  }
});

test("worker startup timeout closes once and fences late preflight SQL", async t => {
  let enter!: () => void, release!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let queries = 0, closes = 0;
  const db: DatabaseClient = {
    async query<T>() { queries++; return { rows: [] as T[] }; },
    async transaction(work) { enter(); await released; try { return await work(db); } finally { finish(); } },
    async transactionWithPreCommitCheck(work, check) { return db.transaction(async tx => { const result = await work(tx); await check(); return result; }); },
  };
  const f = fixture();
  const config = { host: "127.0.0.1" as const, port: 5432, database: "synthetic", username: "worker_test", password: "synthetic-only", majorVersion: 17 as const };
  const bootstrap = createNativeQueueWorkerBootstrap({ PgBoss: f.Boss, openDatabase: () => ({ client: db,
    isAvailable: () => true, async close() { closes++; } }) });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = assert.rejects(bootstrap.start({ database: config,
    application: { ...config, loginNames: ["web_test", "coordinator_test"] }, async deliver() { return { disposition: "held" }; },
  }), /cleanup_uncertain/);
  await entered; t.mock.timers.tick(5001); await pending;
  release(); await finished;
  assert.equal(closes, 1); assert.equal(queries, 0); assert.deepEqual(f.calls, []);
});

test("failed or malformed permissions prevent package construction and close the owned pool", async () => {
  for (const rows of [[], [{ valid: false }], [{ valid: "true" }], [{ valid: true }, { valid: true }]]) {
    const f = fixture(); f.hooks.permissions = async () => rows;
    await assert.rejects(f.start(), /native_task_runtime_start_failed/);
    assert.deepEqual(f.calls, ["preflight", "db-close"]);
  }
  const f = fixture(); f.hooks.permissions = async () => { throw new Error("private database details"); };
  await assert.rejects(f.start(), error => {
    assert.equal((error as Error).message, "native_task_runtime_start_failed");
    assert.equal((error as Error).stack, undefined); return true;
  });
  assert.deepEqual(f.calls, ["preflight", "db-close"]);
});

test("constructor and start failures close ownership once and redact raw errors", async () => {
  const f = fixture(); f.hooks.start = async () => { throw new Error("private startup details"); };
  await assert.rejects(f.start(), error => {
    assert.equal((error as Error).message, "native_task_runtime_start_failed"); assert.equal((error as Error).stack, undefined); return true;
  });
  assert.deepEqual(f.calls, ["preflight", "constructor", "listen", "start", "stop", "db-close"]);
  class Broken extends f.Boss { constructor(options: ConstructorParameters<typeof f.Boss>[0]) { super(options); throw new Error("secret"); } }
  await assert.rejects(startPgBossNativeTaskRuntime(Broken, f.database, { async deliver() { return { disposition: "held" }; } }), /start_failed/);
  assert.equal(f.calls.filter(value => value === "db-close").length, 2);
});

test("invalid queue configuration stops startup before any callback registration", async () => {
  const f = fixture(); f.queue.retryLimit = 1;
  await assert.rejects(f.start(), /start_failed/);
  assert.equal(f.calls.includes("work"), false); assert.deepEqual(f.calls.slice(-2), ["stop", "db-close"]);
});

test("fault during startup cannot return a ready worker", async () => {
  const f = fixture(); f.hooks.start = async () => { f.fault(); };
  await assert.rejects(f.start(), /start_failed/);
  assert.equal(f.calls.includes("work"), false); assert.equal(f.calls.filter(x => x === "db-close").length, 1);
});

test("runtime fault aborts admission and active callback; late success is unresolved", async () => {
  const f = fixture(); let entered!: () => void, observed!: AbortSignal;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const runtime = await f.start({ async deliver(_ref, signal) {
    observed = signal; entered(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { disposition: "delivered" };
  } });
  const invocation = f.invoke(), rejected = assert.rejects(invocation, /delivery_unresolved/);
  await ready; f.fault(); assert.equal(observed.aborted, true); assert.equal(runtime.status().accepting, false);
  await rejected; await runtime.close();
  assert.equal(runtime.status().faulted, true); assert.equal(f.calls.filter(x => x === "stop").length, 1);
});

test("stop failure still closes the pool and retains uncertain status on repeated close", async () => {
  const f = fixture(); f.hooks.stop = async () => { throw new Error("private stop failure"); };
  const runtime = await f.start();
  await assert.rejects(runtime.close(), /close_uncertain/); await assert.rejects(runtime.close(), /close_uncertain/);
  assert.deepEqual(runtime.status(), { state: "uncertain", faulted: false, accepting: false });
  assert.equal(f.calls.filter(x => x === "db-close").length, 1);
});

test("pool close failure cannot be reported as a clean stop", async () => {
  const f = fixture(); f.hooks.closeDb = async () => { throw new Error("private pool failure"); };
  const runtime = await f.start(); await assert.rejects(runtime.close(), /close_uncertain/);
  assert.equal(runtime.status().state, "uncertain");
});

test("startup with failed cleanup reports uncertainty, not only startup failure", async () => {
  const f = fixture(); f.hooks.start = async () => { throw new Error("private start"); };
  f.hooks.stop = async () => { throw new Error("private cleanup"); };
  await assert.rejects(f.start(), /native_task_runtime_start_cleanup_uncertain/);
  assert.equal(f.calls.filter(x => x === "db-close").length, 1);
});

test("uncooperative drain is bounded and still attempts upstream and pool cleanup", async () => {
  const f = fixture(); f.hooks.off = () => new Promise(() => {});
  const runtime = await f.start({ operationTimeoutMs: 20, async deliver() { return { disposition: "held" }; } });
  await assert.rejects(runtime.close(), /close_uncertain/);
  assert.deepEqual(f.calls.slice(-3), ["off", "stop", "db-close"]);
});

test("startup timeout stops and closes without registering a worker or retrying start", async () => {
  const f = fixture(); f.hooks.start = () => new Promise(() => {});
  await assert.rejects(f.start({ operationTimeoutMs: 20, async deliver() { return { disposition: "held" }; } }), /start_failed/);
  assert.deepEqual(f.calls, ["preflight", "constructor", "listen", "start", "stop", "db-close"]);
});

test("late registration after timeout is fenced and retired without delivery", async () => {
  const f = fixture(); let release!: () => void, deliveries = 0;
  f.hooks.work = () => new Promise<void>(resolve => { release = resolve; });
  await assert.rejects(f.start({ operationTimeoutMs: 20, async deliver() { deliveries++; return { disposition: "held" }; } }), /start_failed/);
  await assert.rejects(f.invoke(), /delivery_unresolved/); release(); await delay(5);
  assert.equal(deliveries, 0); assert.equal(f.calls.includes("off"), true);
});
