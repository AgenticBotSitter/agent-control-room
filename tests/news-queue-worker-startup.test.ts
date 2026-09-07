import test from "node:test";
import assert from "node:assert/strict";
import { createNewsQueueWorkerBootstrap, type NewsQueueWorkerStartupConfiguration } from "../src/web/v1/news-queue-worker-startup";
import type { DatabaseClient } from "../src/persistence/database";
import type { PgBossBoundedWorkerClient } from "../src/persistence/pg-boss-bounded-worker";
import { ABS_FEED_QUEUE, absFeedJobId } from "../src/persistence/pg-boss-abs-feed-worker";
import { sha256Digest } from "../src/security";

const config = () => ({ database: { host: "127.0.0.1" as const, port: 5432, database: "synthetic",
  username: "feed_worker_test", password: "synthetic-only", majorVersion: 17 as const },
application: { host: "127.0.0.1" as const, port: 5432, database: "synthetic",
  coordinatorLogin: "news_coordinator_test", ingestionLogin: "news_ingestion_test" },
async collect() { return { disposition: "held" as const }; } });

function fixture() {
  const calls: string[] = [];
  const hooks = { available: true, permissions: true, session: true, close: async () => {} };
  let handler!: Parameters<PgBossBoundedWorkerClient["work"]>[2];
  const db: DatabaseClient = {
    async query<T>(sql: string) {
      calls.push("query");
      if (sql.includes("current_user=session_user")) return { rows: [{ valid: hooks.session, database_temp: false }] as T[] };
      if (sql.includes("SELECT rolname,")) return { rows: [
        { rolname: "feed_worker_test", valid: true }, { rolname: "control_room_native_queue_worker", valid: true },
      ] as T[] };
      if (sql.includes("pg-boss-worker-permissions/v1")) return { rows: [{ valid: hooks.permissions }] as T[] };
      if (sql.includes("AS unsafe")) return { rows: [{ unsafe: false }] as T[] };
      throw new Error("unexpected fixture SQL");
    },
    async transaction(work) { calls.push("transaction"); return work(db); },
    async transactionWithPreCommitCheck(work, check) { return db.transaction(async tx => { const result = await work(tx); await check(); return result; }); },
  };
  class Boss {
    constructor() { calls.push("construct"); }
    on() {}
    async start() { calls.push("start"); }
    async stop() { calls.push("stop"); }
    async getQueue(name: string) { assert.equal(name, ABS_FEED_QUEUE.name); return {
      ...ABS_FEED_QUEUE, policy: "standard", partition: false, retryLimit: 0, deadLetter: null, notify: false,
    }; }
    async work(name: string, _options: unknown, callback: typeof handler) {
      assert.equal(name, ABS_FEED_QUEUE.name); handler = callback; calls.push("work"); return "worker:test";
    }
    async offWork() { calls.push("off"); }
    async cancel() { throw new Error("no recovery"); }
  }
  const bootstrap = createNewsQueueWorkerBootstrap({ PgBoss: Boss, openDatabase(value) {
    calls.push("open"); assert.deepEqual(value, config().database);
    return { client: db, isAvailable: () => hooks.available, async close() { calls.push("close"); await hooks.close(); } };
  } });
  const invoke = () => {
    const data = { schema: "control-room.abs-feed-job/v1" as const, tenantId: "tenant:test", projectId: "project:test",
      jobId: "job:test", attemptId: "attempt:test", effectId: "effect:test", operationDigest: sha256Digest("operation") };
    return handler([{ id: absFeedJobId(data), name: ABS_FEED_QUEUE.name, data, retryCount: 0, retryLimit: 0,
      state: "active", policy: "standard", deadLetter: null, signal: new AbortController().signal }]);
  };
  return { bootstrap, calls, hooks, invoke };
}

test("feed bootstrap refuses shared logins, different primary and invalid bounds before opening", async () => {
  const base = config();
  for (const patch of [
    { application: { ...base.application, ingestionLogin: base.application.coordinatorLogin } },
    { application: { ...base.application, coordinatorLogin: base.database.username } },
    { application: { ...base.application, ingestionLogin: base.database.username } },
    { application: { ...base.application, database: "different" } },
    { application: { ...base.application, port: 5433 } },
    { application: { ...base.application, coordinatorLogin: "" } },
    { concurrency: 9 },
  ]) {
    const f = fixture();
    await assert.rejects(f.bootstrap.start({ ...base, ...patch }), /abs_feed_worker_config_invalid/);
    await assert.rejects(f.bootstrap.start(base), /abs_feed_worker_already_attempted/);
    assert.deepEqual(f.calls, []);
  }
});

test("feed bootstrap preflights its operational pool and preserves fixed collector and owned close", async () => {
  const f = fixture(); let collected = 0;
  const input: NewsQueueWorkerStartupConfiguration = { ...config(), async collect() {
    collected++; return { disposition: "held" };
  } };
  const runtime = await f.bootstrap.start(input);
  assert.ok(f.calls.indexOf("transaction") < f.calls.indexOf("construct"));
  input.collect = async () => { throw new Error("mutated"); };
  await f.invoke(); assert.equal(collected, 1);
  await assert.rejects(f.bootstrap.start(config()), /already_attempted/);
  await runtime.close(); await runtime.close();
  assert.deepEqual(f.calls.slice(-3), ["off", "stop", "close"]);
  assert.equal(f.calls.filter(x => x === "open").length, 1);
  assert.equal(f.calls.filter(x => x === "close").length, 1);
});

test("feed bootstrap failed role/session preflight closes pool without starting upstream", async () => {
  for (const patch of [{ permissions: false }, { session: false }, { available: false }]) {
    const f = fixture(); Object.assign(f.hooks, patch);
    await assert.rejects(f.bootstrap.start(config()), /abs_feed_worker_start_failed/);
    assert.equal(f.calls.includes("construct"), false); assert.equal(f.calls.at(-1), "close");
  }
});

test("loss of worker pool availability prevents calling the collector", async () => {
  const f = fixture(); let collected = 0;
  const runtime = await f.bootstrap.start({ ...config(), async collect() { collected++; return { disposition: "held" }; } });
  f.hooks.available = false;
  await assert.rejects(f.invoke(), /abs_feed_delivery_unresolved/);
  assert.equal(collected, 0); await runtime.close();
});

test("feed preflight plus cleanup failure reports uncertainty without raw database details", async () => {
  const f = fixture(); f.hooks.session = false; f.hooks.close = async () => { throw new Error("private database details"); };
  await assert.rejects(f.bootstrap.start(config()), error => {
    assert.equal((error as Error).message, "abs_feed_worker_cleanup_uncertain");
    assert.equal((error as Error).stack, undefined); return true;
  });
  assert.equal(f.calls.filter(x => x === "close").length, 1);
});
