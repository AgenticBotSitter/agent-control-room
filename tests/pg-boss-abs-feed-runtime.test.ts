import test from "node:test";
import assert from "node:assert/strict";
import { startPgBossAbsFeedRuntime } from "../src/persistence/pg-boss-abs-feed-runtime";
import { ABS_FEED_QUEUE, absFeedJobId } from "../src/persistence/pg-boss-abs-feed-worker";
import type { PgBossBoundedRuntimeConstructor } from "../src/persistence/pg-boss-bounded-runtime";
import type { PgBossBoundedWorkerClient } from "../src/persistence/pg-boss-bounded-worker";
import { sha256Digest } from "../src/security";

function fixture() {
  const calls: string[] = [], active: Promise<unknown>[] = [];
  let options!: ConstructorParameters<PgBossBoundedRuntimeConstructor>[0];
  let handler!: Parameters<PgBossBoundedWorkerClient["work"]>[2];
  let fault!: () => void;
  const hooks = { valid: true, retryLimit: 0, stop: async () => {}, work: async () => {} };
  class Boss {
    constructor(value: typeof options) { calls.push("construct"); options = value; }
    on(_event: "error", listener: (error: unknown) => void) { fault = () => listener(new Error("private failure")); }
    async start() { calls.push("start"); }
    async stop() { calls.push("stop"); await hooks.stop(); }
    async getQueue(name: string) { assert.equal(name, ABS_FEED_QUEUE.name); return { ...ABS_FEED_QUEUE,
      policy: "standard", partition: false, retryLimit: hooks.retryLimit, deadLetter: null, notify: false }; }
    async work(name: string, _options: unknown, callback: typeof handler) {
      assert.equal(name, ABS_FEED_QUEUE.name); calls.push("work"); handler = callback; await hooks.work(); return "worker:feed";
    }
    async offWork() { calls.push("off"); await Promise.allSettled(active); }
    async cancel() { calls.push("cancel"); }
  }
  const database = { async query<T>(sql: string) {
    assert.match(sql, /pg-boss-worker-permissions\/v1/); calls.push("permissions"); return { rows: [{ valid: hooks.valid }] as T[] };
  }, async close() { calls.push("close"); } };
  const start = (input: Parameters<typeof startPgBossAbsFeedRuntime>[2] = { async collect() { return { disposition: "held" }; } }) =>
    startPgBossAbsFeedRuntime(Boss, database, input);
  const invoke = () => {
    const data = { schema: "control-room.abs-feed-job/v1" as const, tenantId: "tenant:test", projectId: "project:test",
      jobId: "job:test", attemptId: "attempt:test", effectId: "effect:test", operationDigest: sha256Digest("operation") };
    const pending = handler([{ id: absFeedJobId(data), name: ABS_FEED_QUEUE.name, data, retryCount: 0, retryLimit: 0,
      state: "active", policy: "standard", deadLetter: null, signal: new AbortController().signal }]);
    active.push(pending); return pending;
  };
  return { calls, hooks, start, invoke, options: () => options, fault: () => fault() };
}

test("fixed feed runtime reuses restricted preflight, inert package options and captured collector", async () => {
  const f = fixture(); let collected = 0, recovered = 0;
  const input = { async collect() { collected++; return { disposition: "held" as const }; },
    async verifyRecovery() { recovered++; } };
  const runtime = await f.start(input);
  input.collect = async () => { throw new Error("mutated"); };
  await f.invoke(); assert.equal(collected, 1); assert.equal(recovered, 0);
  const { db, ...options } = f.options();
  assert.deepEqual(options, { schema: "control_room_queue", backend: "postgres", migrate: false,
    createSchema: false, supervise: false, schedule: false, useListenNotify: false });
  assert.deepEqual(f.calls.slice(0, 3), ["permissions", "construct", "start"]);
  const closed = runtime.close(); assert.equal(runtime.close(), closed); await closed;
  assert.deepEqual(f.calls.slice(-3), ["off", "stop", "close"]);
  assert.deepEqual(runtime.status(), { state: "closed", faulted: false, accepting: false });
  await assert.rejects(db.executeSql("SELECT 1"), /abs_feed_runtime_unavailable/);
  await assert.rejects(f.invoke(), /abs_feed_delivery_unresolved/); assert.equal(collected, 1);
});

test("feed runtime refuses unsafe permissions or retrying queue and closes owned resources", async () => {
  for (const patch of [{ valid: false }, { retryLimit: 1 }]) {
    const f = fixture(); Object.assign(f.hooks, patch);
    await assert.rejects(f.start(), /abs_feed_runtime_start_failed/);
    assert.equal(f.calls.includes("work"), false); assert.equal(f.calls.at(-1), "close");
    if (!f.hooks.valid) assert.equal(f.calls.includes("construct"), false);
  }
});

test("feed runtime validates bounds before taking pool ownership", async () => {
  for (const patch of [{ concurrency: 0 }, { operationTimeoutMs: 5001 }]) {
    const f = fixture();
    await assert.rejects(f.start({ async collect() { return { disposition: "held" }; }, ...patch }), /abs_feed_runtime_config_invalid/);
    assert.deepEqual(f.calls, []);
  }
});

test("infrastructure failure aborts feed collection and fences its late success", async () => {
  const f = fixture(); let entered!: () => void, signal!: AbortSignal;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const runtime = await f.start({ async collect(_reference, current) {
    signal = current; entered(); await new Promise<void>(resolve => current.addEventListener("abort", () => resolve(), { once: true }));
    return { disposition: "delivered" };
  } });
  const pending = assert.rejects(f.invoke(), /abs_feed_delivery_unresolved/);
  await ready; f.fault(); assert.equal(signal.aborted, true); await pending; await runtime.close();
  assert.equal(runtime.status().faulted, true); assert.equal(runtime.status().accepting, false);
  assert.equal(f.calls.filter(x => x === "close").length, 1);
});

test("feed cleanup failure remains uncertain and still closes the owned pool", async () => {
  const f = fixture(); f.hooks.stop = async () => { throw new Error("private stop"); };
  const runtime = await f.start();
  await assert.rejects(runtime.close(), /abs_feed_runtime_close_uncertain/);
  await assert.rejects(runtime.close(), /abs_feed_runtime_close_uncertain/);
  assert.equal(runtime.status().state, "uncertain"); assert.equal(f.calls.filter(x => x === "close").length, 1);
});
