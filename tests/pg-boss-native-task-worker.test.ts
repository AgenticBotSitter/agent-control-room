import test from "node:test";
import assert from "node:assert/strict";
import { startPgBossNativeTaskWorker, type PgBossNativeWorkerClient } from "../src/persistence/pg-boss-native-task-worker";
import { PG_BOSS_NATIVE_SUBMISSION as spec, nativeTaskSubmissionId } from "../src/persistence/pg-boss-native-task-submission";
import { sha256Digest } from "../src/security";
import type { NativeTaskSubmissionReference } from "../src/persistence/native-task-submission";

const reference = (tenantId = "tenant:worker"): NativeTaskSubmissionReference => {
  const ids = { tenantId, jobId: "job:worker", attemptId: "attempt:worker" };
  return { schema: "control-room.native-task-submission/v1", ...ids, projectId: "project:worker",
    queueId: `native-queue:${sha256Digest(ids).slice(7)}`, inputDigest: sha256Digest("input"), packetDigest: sha256Digest("packet") };
};
function fixture() {
  let handler!: Parameters<PgBossNativeWorkerClient["work"]>[2];
  let options: unknown, stopped = 0;
  const cancelled: string[] = [];
  const queue = { name: spec.name, table: spec.table, policy: "standard", partition: false, retryLimit: 0, deadLetter: null, notify: false };
  const client: PgBossNativeWorkerClient = { async getQueue() { return queue; },
    async work(name, value, fn) { assert.equal(name, spec.name); options = value; handler = fn; return "worker:test"; },
    async cancel(name, id) { assert.equal(name, spec.name); cancelled.push(id); },
    async offWork(name, value) { assert.equal(name, spec.name); assert.deepEqual(value, { id: "worker:test", wait: true }); stopped++; },
  };
  const job = (data = reference()) => ({ id: nativeTaskSubmissionId(data), name: spec.name, data, retryLimit: 0, retryCount: 0,
    state: "active", policy: "standard", deadLetter: null, signal: new AbortController().signal });
  return { client, queue, job, invoke: (jobs: Parameters<typeof handler>[0]) => handler(jobs),
    options: () => options, stopped: () => stopped, cancelled };
}

test("uses upstream single-item workers with bounded concurrency; snapshots trusted handler", async () => {
  const f = fixture(); let delivered = 0;
  const input = { concurrency: 3, async deliver() { delivered++; return { disposition: "delivered" as const }; } };
  const worker = await startPgBossNativeTaskWorker(f.client, input);
  input.deliver = async () => { throw new Error("mutated"); };
  assert.deepEqual(f.options(), { batchSize: 1, includeMetadata: true, localConcurrency: 3, pollingIntervalSeconds: 1 });
  assert.deepEqual(await f.invoke([f.job()]), { disposition: "delivered" });
  assert.equal(delivered, 1); await worker.close(); await worker.close(); assert.equal(f.stopped(), 1);
  assert.equal(worker.isAccepting(), false);
  await assert.rejects(f.invoke([f.job()]), /native_task_delivery_unresolved/); assert.equal(delivered, 1);
});

for (const mode of ["verified", "denied", "aborted", "over-limit"] as const) test(`recovered pickup requires a captured canonical verifier: ${mode}`, async () => {
  const f = fixture(), abort = new AbortController(); let verified = 0, delivered = 0;
  const input = { async verifyRecovery(ref: NativeTaskSubmissionReference, ordinal: number) {
    verified++; assert.deepEqual(ref, reference()); assert.equal(ordinal, 1);
    if (mode === "denied") throw new Error("synthetic missing canonical audit");
    if (mode === "aborted") abort.abort();
  }, async deliver() { delivered++; return { disposition: "delivered" as const }; } };
  const worker = await startPgBossNativeTaskWorker(f.client, input);
  input.verifyRecovery = async () => { throw new Error("mutated verifier"); };
  const work = () => f.invoke([{ ...f.job(), retryCount: mode === "over-limit" ? 4 : 1, signal: abort.signal }]);
  if (mode === "verified") assert.deepEqual(await work(), { disposition: "delivered" });
  else await assert.rejects(work(), /native_task_delivery_unresolved/);
  assert.equal(verified, mode === "over-limit" ? 0 : 1);
  assert.equal(delivered, mode === "verified" ? 1 : 0);
  await worker.close();
});

test("refuses malformed, mismatched, automatically retried or rerouted entries before delivery", async t => {
  for (const patch of [{ retryLimit: 2 }, { retryCount: 1 }, { deadLetter: "other" }, { policy: "singleton" },
    { state: "created" }, { id: "00000000-0000-8000-8000-000000000000" }, { name: "wrong" },
    { data: { ...reference(), extra: "not-allowed" } }, { data: { ...reference(), queueId: `native-queue:${"0".repeat(64)}` } }]) {
    await t.test(JSON.stringify(patch), async () => {
      const f = fixture(); let called = false;
      const worker = await startPgBossNativeTaskWorker(f.client, { async deliver() { called = true; return { disposition: "delivered" }; } });
      await assert.rejects(f.invoke([{ ...f.job(), ...patch }]), /native_task_delivery_unresolved/);
      assert.equal(called, false); assert.equal(f.cancelled.length, 1); await worker.close();
    });
  }
});

test("queue drift and aborted library signal cannot invoke the canonical handler", async () => {
  const f = fixture(); let called = 0;
  const worker = await startPgBossNativeTaskWorker(f.client, { async deliver() { called++; return { disposition: "held" }; } });
  f.queue.retryLimit = 1; await assert.rejects(f.invoke([f.job()])); f.queue.retryLimit = 0;
  await assert.rejects(f.invoke([{ ...f.job(), signal: AbortSignal.abort() }]));
  assert.equal(called, 0); await worker.close();
});

test("passes immutable locators, not queue-granted authority; resolves tenants in the canonical handler", async () => {
  const f = fixture(), seen: string[] = [];
  const worker = await startPgBossNativeTaskWorker(f.client, { async deliver(value) {
    assert.equal(Object.isFrozen(value), true); seen.push(value.tenantId); return { disposition: "held" };
  } });
  for (const tenant of ["tenant:first", "tenant:second"]) assert.deepEqual(await f.invoke([f.job(reference(tenant))]), { disposition: "held" });
  assert.deepEqual(seen, ["tenant:first", "tenant:second"]); assert.deepEqual(f.cancelled, []); await worker.close();
});

test("handler errors and expanded outputs are coarsened; one held item does not block the next", async () => {
  const f = fixture(); let count = 0;
  const worker = await startPgBossNativeTaskWorker(f.client, { async deliver() {
    count++; if (count === 1) throw new Error("sensitive-upstream-error");
    if (count === 2) return { disposition: "delivered", raw: "not-for-queue" };
    return { disposition: "held" };
  } });
  for (let i = 0; i < 2; i++) await assert.rejects(f.invoke([f.job()]), error => {
    assert.equal((error as Error).message, "native_task_delivery_unresolved"); assert.equal((error as Error).stack, undefined); return true;
  });
  assert.deepEqual(await f.invoke([f.job()]), { disposition: "held" }); await worker.close();
});

test("close aborts handler, denies late success and reports unfinished cleanup", async () => {
  const f = fixture(); let finish!: () => void, entered!: () => void, signal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const worker = await startPgBossNativeTaskWorker(f.client, { async deliver(_value, received) {
    signal = received; entered(); await new Promise<void>(resolve => { finish = resolve; }); return { disposition: "delivered" };
  } });
  const handling = f.invoke([f.job()]); await started;
  await assert.rejects(worker.close(), /native_task_worker_close_uncertain/); assert.equal(signal?.aborted, true);
  finish(); await assert.rejects(handling, /native_task_delivery_unresolved/);
  await assert.rejects(worker.close(), /native_task_worker_close_uncertain/);
});

test("rejects unsupported concurrency and unsafe queue before registering a worker", async () => {
  for (const concurrency of [0, 9, 1.5, NaN]) {
    const f = fixture(); await assert.rejects(startPgBossNativeTaskWorker(f.client, { concurrency,
      async deliver() { return { disposition: "held" }; } })); assert.equal(f.options(), undefined);
  }
  const f = fixture(); f.queue.retryLimit = 1;
  await assert.rejects(startPgBossNativeTaskWorker(f.client, { async deliver() { return { disposition: "held" }; } }));
  assert.equal(f.options(), undefined);
});
