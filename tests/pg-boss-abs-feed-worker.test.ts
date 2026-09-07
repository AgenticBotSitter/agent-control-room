import assert from "node:assert/strict";
import test from "node:test";
import { ABS_FEED_QUEUE as spec, absFeedJobId, startPgBossAbsFeedWorker, type AbsFeedJobReference } from "../src/persistence/pg-boss-abs-feed-worker";
import type { PgBossBoundedWorkerClient } from "../src/persistence/pg-boss-bounded-worker";
import { sha256Digest } from "../src/security";

const reference: AbsFeedJobReference = { schema: "control-room.abs-feed-job/v1", tenantId: "tenant:feed",
  projectId: "project:feed", jobId: "job:feed", attemptId: "attempt:feed", effectId: "effect:feed", operationDigest: sha256Digest("feed-operation") };
function fixture() {
  let handler!: Parameters<PgBossBoundedWorkerClient["work"]>[2], options: unknown, stopped = 0;
  const cancelled: string[] = [];
  const queue = { ...spec, policy: "standard", partition: false, retryLimit: 0, deadLetter: null, notify: false };
  const client: PgBossBoundedWorkerClient = { async getQueue(name) { assert.equal(name, spec.name); return queue; },
    async work(name, value, callback) { assert.equal(name, spec.name); options = value; handler = callback; return "worker:feed"; },
    async cancel(name, id) { assert.equal(name, spec.name); cancelled.push(id); },
    async offWork(name, value) { assert.equal(name, spec.name); assert.deepEqual(value, { id: "worker:feed", wait: true }); stopped++; } };
  const job = () => ({ id: absFeedJobId(reference), name: spec.name, data: reference, state: "active", retryLimit: 0,
    retryCount: 0, policy: "standard", deadLetter: null, signal: new AbortController().signal });
  return { client, queue, cancelled, job, options: () => options, stopped: () => stopped,
    invoke: (jobs: Parameters<typeof handler>[0]) => handler(jobs) };
}
test("feed queue reuses one-item bounded pickup and passes only captured immutable locators", async () => {
  const f = fixture(); let collected = 0;
  const input = { concurrency: 2, async collect(value: AbsFeedJobReference) {
    assert.equal(this, input); assert.deepEqual(value, reference); assert.equal(Object.isFrozen(value), true);
    collected++; return { disposition: "delivered" as const };
  } };
  const worker = await startPgBossAbsFeedWorker(f.client, input);
  input.collect = async () => { throw new Error("mutated"); };
  assert.deepEqual(f.options(), { batchSize: 1, includeMetadata: true, localConcurrency: 2, pollingIntervalSeconds: 1 });
  assert.deepEqual(await f.invoke([f.job()]), { disposition: "delivered" }); assert.equal(collected, 1);
  await worker.close(); await worker.close(); assert.equal(f.stopped(), 1); assert.equal(worker.isAccepting(), false);
  await assert.rejects(f.invoke([f.job()])); assert.equal(collected, 1);
});
test("retries, altered references, URLs and mismatched identity cannot invoke collection", async t => {
  for (const patch of [{ retryCount: 1 }, { retryLimit: 1 }, { policy: "singleton" }, { name: "native-task-delivery" },
    { state: "created" }, { deadLetter: "retry" }, { id: "00000000-0000-8000-8000-000000000000" },
    { data: { ...reference, endpointUrl: "https://example.org/feed" } },
    { data: { ...reference, operationDigest: sha256Digest("changed") } },
    { data: { ...reference, attemptId: "attempt:changed" } }]) await t.test(JSON.stringify(patch), async () => {
    const f = fixture(); let calls = 0;
    const worker = await startPgBossAbsFeedWorker(f.client, { async collect() { calls++; return { disposition: "held" }; } });
    await assert.rejects(f.invoke([{ ...f.job(), ...patch }]), /abs_feed_delivery_unresolved/);
    assert.equal(calls, 0); assert.equal(f.cancelled.length, 1); await worker.close();
  });
});
test("queue changes, cancelled pickup and malformed batch cannot collect", async () => {
  const f = fixture(); let calls = 0;
  const worker = await startPgBossAbsFeedWorker(f.client, { async collect() { calls++; return { disposition: "held" }; } });
  f.queue.retryLimit = 1; await assert.rejects(f.invoke([f.job()])); f.queue.retryLimit = 0;
  await assert.rejects(f.invoke([{ ...f.job(), signal: AbortSignal.abort() }]));
  await assert.rejects(f.invoke([f.job(), f.job()])); assert.equal(calls, 0); await worker.close();
});
test("failed collection is sanitized and a held job permits later unrelated pickup", async () => {
  const f = fixture(); let calls = 0;
  const worker = await startPgBossAbsFeedWorker(f.client, { async collect() {
    if (++calls === 1) throw new Error("upstream detail must not reach queue"); return { disposition: "held" };
  } });
  await assert.rejects(f.invoke([f.job()]), error => {
    assert.equal((error as Error).message, "abs_feed_delivery_unresolved"); assert.equal((error as Error).stack, undefined); return true;
  });
  const next = { ...reference, jobId: "job:unrelated", attemptId: "attempt:unrelated", effectId: "effect:unrelated" };
  assert.deepEqual(await f.invoke([{ ...f.job(), data: next, id: absFeedJobId(next) }]), { disposition: "held" }); await worker.close();
});
test("shutdown aborts active collection and refuses late success", async () => {
  const f = fixture(); let release!: () => void, entered!: () => void, signal: AbortSignal | undefined;
  const started = new Promise<void>(done => { entered = done; });
  const worker = await startPgBossAbsFeedWorker(f.client, { async collect(_ref, received) {
    signal = received; entered(); await new Promise<void>(done => { release = done; }); return { disposition: "delivered" };
  } });
  const work = f.invoke([f.job()]); await started;
  await assert.rejects(worker.close(), /abs_feed_worker_close_uncertain/); assert.equal(signal?.aborted, true);
  release(); await assert.rejects(work, /abs_feed_delivery_unresolved/);
  await assert.rejects(worker.close(), /abs_feed_worker_close_uncertain/);
});
test("feed operational IDs bind every scope field and are stable UUIDs", () => {
  const id = absFeedJobId(reference); assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(absFeedJobId({ ...reference }), id);
  for (const field of ["tenantId", "projectId", "jobId", "attemptId", "effectId"] as const)
    assert.notEqual(absFeedJobId({ ...reference, [field]: `${field}:changed` }), id);
  assert.notEqual(absFeedJobId({ ...reference, operationDigest: sha256Digest("other") }), id);
});
