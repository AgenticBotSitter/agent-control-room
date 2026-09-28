import assert from "node:assert/strict";
import { test } from "node:test";
import type { PgBossRuntimeTerminalV1 } from "../src/persistence/pg-boss-bounded-runtime";
import { startRecoveringMacLocalQueueWorkerV1 } from "../src/web/v1/mac-local-queue-worker-recovery";

function worker(name: string, trace: string[]) {
  let accepting = true, resolve!: (value: PgBossRuntimeTerminalV1) => void;
  const terminal = new Promise<PgBossRuntimeTerminalV1>(done => { resolve = done; });
  let closes = 0, ended = false;
  return {
    value: Object.freeze({ status: () => ({ accepting }), whenTerminated: () => terminal, async close() {
      closes++; accepting = false;
      if (!ended) { ended = true; trace.push(`close:${name}`); resolve({ cause: "requested_close", cleanup: "closed" }); }
    } }),
    fault(cleanup: PgBossRuntimeTerminalV1["cleanup"] = "closed") {
      if (ended) return; ended = true; accepting = false; trace.push(`fault:${name}`); resolve({ cause: "fault", cleanup });
    },
    closes: () => closes,
  };
}

async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail("condition_not_reached");
}

test("a clean runtime fault starts one fresh worker after backoff", async () => {
  const trace: string[] = [], first = worker("first", trace), second = worker("second", trace);
  const values = [first.value, second.value]; let starts = 0;
  const runtime = await startRecoveringMacLocalQueueWorkerV1(async () => { trace.push(`start:${starts + 1}`); return values[starts++]!; },
    { delaysMs: [3], sleep: async ms => { trace.push(`sleep:${ms}`); } });
  first.fault(); await eventually(() => runtime.status().accepting);
  assert.equal(starts, 2);
  assert.deepEqual(trace, ["start:1", "fault:first", "sleep:3", "start:2"]);
  await runtime.close(); assert.equal(second.closes(), 1);
});

test("an initial clean startup failure returns reconnecting and later becomes accepting", async () => {
  const trace: string[] = [], second = worker("second", trace); let starts = 0;
  const runtime = await startRecoveringMacLocalQueueWorkerV1(async () => {
    starts++; trace.push(`start:${starts}`);
    if (starts === 1) throw Object.assign(new Error("native_queue_worker_start_failed"), { stack: undefined });
    return second.value;
  }, { delaysMs: [4], sleep: async ms => { trace.push(`sleep:${ms}`); } });
  assert.deepEqual(runtime.status(), { state: "reconnecting", faulted: true, accepting: false });
  await eventually(() => runtime.status().accepting);
  assert.deepEqual(trace, ["start:1", "sleep:4", "start:2"]);
  await runtime.close();
});

test("initial cleanup uncertainty refuses to start a recovery supervisor", async () => {
  await assert.rejects(startRecoveringMacLocalQueueWorkerV1(async () => {
    throw Object.assign(new Error("native_queue_worker_start_cleanup_uncertain"), { stack: undefined });
  }, { delaysMs: [1], sleep: async () => {} }), /cleanup_uncertain/);
});

test("cleanup uncertainty permanently refuses replacement", async () => {
  const trace: string[] = [], first = worker("first", trace); let starts = 0;
  const runtime = await startRecoveringMacLocalQueueWorkerV1(async () => { starts++; return first.value; },
    { delaysMs: [1], sleep: async () => {} });
  first.fault("uncertain"); await eventually(() => runtime.status().state === "uncertain");
  assert.deepEqual(runtime.status(), { state: "uncertain", faulted: true, accepting: false });
  assert.equal(starts, 1);
  await assert.rejects(runtime.close(), /mac_local_queue_recovery_close_uncertain/);
});

test("clean replacement startup failures advance backoff without overlapping workers", async () => {
  const trace: string[] = [], first = worker("first", trace), second = worker("second", trace);
  let starts = 0;
  const runtime = await startRecoveringMacLocalQueueWorkerV1(async () => {
    starts++; trace.push(`start:${starts}`);
    if (starts === 1) return first.value;
    if (starts === 2) throw Object.assign(new Error("native_queue_worker_start_failed"), { stack: undefined });
    return second.value;
  }, { delaysMs: [2, 5], sleep: async ms => { trace.push(`sleep:${ms}`); } });
  first.fault(); await eventually(() => runtime.status().accepting);
  assert.deepEqual(trace, ["start:1", "fault:first", "sleep:2", "start:2", "sleep:5", "start:3"]);
  await runtime.close();
});

test("explicit close aborts backoff and suppresses all replacement starts", async () => {
  const trace: string[] = [], first = worker("first", trace); let starts = 0, entered!: () => void;
  const sleeping = new Promise<void>(resolve => { entered = resolve; });
  const runtime = await startRecoveringMacLocalQueueWorkerV1(async () => { starts++; return first.value; },
    { delaysMs: [30_000], sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
      entered(); signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
    }) });
  first.fault(); await sleeping; await runtime.close();
  assert.equal(starts, 1); assert.deepEqual(runtime.status(), { state: "closed", faulted: true, accepting: false });
});

test("an uncertain replacement startup stops recovery", async () => {
  const trace: string[] = [], first = worker("first", trace); let starts = 0;
  const runtime = await startRecoveringMacLocalQueueWorkerV1(async () => {
    starts++;
    if (starts === 1) return first.value;
    throw Object.assign(new Error("native_queue_worker_cleanup_uncertain"), { stack: undefined });
  }, { delaysMs: [1], sleep: async () => {} });
  first.fault(); await eventually(() => runtime.status().state === "uncertain");
  assert.equal(starts, 2);
  await assert.rejects(runtime.close(), /mac_local_queue_recovery_close_uncertain/);
});
