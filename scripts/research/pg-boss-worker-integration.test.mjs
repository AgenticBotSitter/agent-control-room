// Opt-in actual-package worker evaluation. Synthetic callbacks only; no native agent,
// PostgreSQL server, provider, listener or application startup is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { startPgBossNativeTaskWorker } from '../../src/persistence/pg-boss-native-task-worker.ts';
import { startPgBossNativeTaskRuntime } from '../../src/persistence/pg-boss-native-task-runtime.ts';
import { nativeTaskSubmissionId, PG_BOSS_NATIVE_SUBMISSION as spec } from '../../src/persistence/pg-boss-native-task-submission.ts';
import { sha256Digest } from '../../src/security/index.ts';

const root = process.env.CR_REUSE_EVAL_ROOT;
assert.ok(root && isAbsolute(root), 'Explicit existing E01 acquisition root required');
const packageRoot = join(root, 'node_modules/pg-boss');
assert.equal(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version, spec.packageVersion);
const { PgBoss } = await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
const reference = number => {
  const ids = { tenantId: 'tenant:synthetic-worker', jobId: `job:${number}`, attemptId: `attempt:${number}` };
  return { schema: 'control-room.native-task-submission/v1', ...ids, projectId: 'project:synthetic-worker',
    queueId: `native-queue:${sha256Digest(ids).slice(7)}`, inputDigest: sha256Digest('input'), packetDigest: sha256Digest('packet') };
};
async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await check()) return; await delay(15); }
  assert.fail('Synthetic worker observation timed out');
}
async function fixture(t) {
  const raw = new PGlite(), workers = [], errors = [];
  const boss = new PgBoss({ db: { async executeSql(sql, values) {
    return values?.length ? raw.query(sql, values) : (await raw.exec(sql)).at(-1) ?? { rows: [] };
  } }, schema: spec.schema, backend: 'pglite', schedule: false, supervise: false, useListenNotify: false });
  boss.on('error', error => errors.push(error));
  t.after(async () => {
    try { await Promise.allSettled(workers.map(worker => worker.close())); }
    finally { await boss.stop({ graceful: false }); await raw.close(); }
  });
  await boss.start(); await boss.createQueue(spec.name, { retryLimit: 0 });
  const send = async (n, options = {}, data = reference(n)) => {
    const id = nativeTaskSubmissionId(reference(n));
    assert.equal(await boss.send(spec.name, data, { id, retryLimit: 0, ...options }), id); return id;
  };
  const start = async (deliver, concurrency = 1) => {
    const worker = await startPgBossNativeTaskWorker(boss, { deliver, concurrency }); workers.push(worker); return worker;
  };
  const get = id => boss.getJobById(spec.name, id);
  return { raw, boss, send, start, get, errors, workers };
}

// A separate logical SQL port models ownership of a dedicated worker pool; PGlite
// has one in-memory engine, so this is not proof of PostgreSQL roles/pool isolation.
async function runtimeFixture(t, f, deliver, concurrency = 1) {
  let closed = false, closeCount = 0;
  const statements = [], clients = [];
  class CapturedBoss extends PgBoss { constructor(options) { super(options); clients.push(this); } }
  const runtime = await startPgBossNativeTaskRuntime(CapturedBoss, {
    async query(sql, values) {
      assert.equal(closed, false, 'worker SQL must stop after its owned port closes');
      statements.push(sql);
      return values?.length ? f.raw.query(sql, values) : (await f.raw.exec(sql)).at(-1) ?? { rows: [] };
    },
    async close() { closed = true; closeCount++; },
  }, { backend: 'pglite', deliver, concurrency });
  f.workers.push(runtime);
  return { runtime, statements, closed: () => closed, closeCount: () => closeCount,
    fault: () => clients[0].emit('error', new Error('synthetic runtime fault')) };
}

test('actual owned runtime picks up continuously then closes only its worker SQL port', { timeout: 20000 }, async t => {
  const f = await fixture(t), seen = [];
  const r = await runtimeFixture(t, f, async ref => { seen.push(ref.jobId); return { disposition: 'held' }; }, 2);
  const ids = await Promise.all([11, 12, 13].map(n => f.send(n)));
  await until(async () => (await f.get(ids[2]))?.state === 'completed');
  await r.runtime.close();
  assert.equal(r.closed(), true); assert.equal(r.closeCount(), 1);
  assert.deepEqual(new Set(seen), new Set(['job:11', 'job:12', 'job:13']));
  assert.deepEqual(r.runtime.status(), { state: 'closed', faulted: false, accepting: false });
  assert.equal(r.statements.some(sql => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql)), false);
  const next = await f.send(14); await delay(1100);
  assert.equal((await f.get(next)).state, 'created');
  assert.deepEqual(f.errors, []);
});

test('actual runtime infrastructure fault aborts current delivery without automatic replacement', { timeout: 20000 }, async t => {
  const f = await fixture(t); let entered, signalSeen, calls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const r = await runtimeFixture(t, f, async (_ref, signal) => {
    calls++; signalSeen = signal; entered();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { disposition: 'delivered' };
  });
  const id = await f.send(21); await ready;
  r.fault(); assert.equal(signalSeen.aborted, true);
  await r.runtime.close();
  assert.deepEqual(r.runtime.status(), { state: 'closed', faulted: true, accepting: false });
  assert.equal((await f.get(id)).state, 'failed');
  assert.equal((await f.get(id)).retryCount, 0);
  const pending = await f.send(22); await delay(1100);
  assert.equal((await f.get(pending)).state, 'created'); assert.equal(calls, 1);
  assert.equal(r.closeCount(), 1); assert.deepEqual(f.errors, []);
});

test('actual continuous worker moves on while prior work is held for review', { timeout: 20000 }, async t => {
  const f = await fixture(t), received = [], awaitingReview = new Set();
  const ids = await Promise.all([1, 2, 3].map(n => f.send(n)));
  const worker = await f.start(async ref => {
    received.push(ref.jobId);
    if (ref.jobId === 'job:1') { awaitingReview.add(ref.jobId); return { disposition: 'held' }; }
    return { disposition: 'delivered' };
  });
  await until(async () => (await f.get(ids[2]))?.state === 'completed');
  assert.equal(received.length, 3); assert.equal(new Set(received).size, 3);
  assert.deepEqual([...awaitingReview], ['job:1']);
  assert.deepEqual((await f.get(ids[0])).output, { disposition: 'held' });
  assert.equal((await f.get(ids[0])).retryCount, 0);
  await worker.close(); assert.deepEqual(f.errors, []);
});

test('upstream concurrency runs another delivery while the first handler is pending', { timeout: 20000 }, async t => {
  const f = await fixture(t); let active = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const ids = await Promise.all([1, 2].map(n => f.send(n)));
  const worker = await f.start(async ref => {
    active++; peak = Math.max(peak, active);
    try { if (ref.jobId === 'job:1') await gate; return { disposition: 'delivered' }; }
    finally { active--; }
  }, 2);
  try {
    await until(async () => (await f.get(ids[1]))?.state === 'completed');
    assert.equal((await f.get(ids[0])).state, 'active'); assert.equal(peak, 2);
  } finally { release(); }
  await until(async () => (await f.get(ids[0]))?.state === 'completed');
  await worker.close(); assert.equal(active, 0); assert.deepEqual(f.errors, []);
});

test('uncertain handler outcome fails once, strips raw errors and leaves other jobs productive', { timeout: 20000 }, async t => {
  const f = await fixture(t), calls = [];
  const ids = await Promise.all([1, 2].map(n => f.send(n)));
  const worker = await f.start(async ref => {
    calls.push(ref.jobId); if (ref.jobId === 'job:1') throw new Error('synthetic-private-provider-details');
    return { disposition: 'delivered' };
  });
  await until(async () => (await f.get(ids[1]))?.state === 'completed');
  const failed = await f.get(ids[0]);
  assert.equal(failed.state, 'failed'); assert.equal(failed.retryCount, 0);
  assert.doesNotMatch(JSON.stringify(failed.output), /synthetic-private-provider-details/);
  assert.match(JSON.stringify(failed.output), /native_task_delivery_unresolved/);
  assert.equal(failed.output.stack, undefined);
  await delay(1100); assert.deepEqual(calls, ['job:1', 'job:2']);
  await worker.close(); assert.deepEqual(f.errors, []);
});

test('unsafe retry metadata and malformed payload are cancelled operationally without any handler call', { timeout: 20000 }, async t => {
  const f = await fixture(t), calls = [];
  const unsafe = await f.send(1, { retryLimit: 3 });
  const malformed = await f.send(2, { retryLimit: 3 }, { ...reference(2), prompt: 'not-allowed' });
  const good = await f.send(3);
  const worker = await f.start(async ref => { calls.push(ref.jobId); return { disposition: 'delivered' }; });
  await until(async () => (await f.get(good))?.state === 'completed');
  for (const id of [unsafe, malformed]) {
    const value = await f.get(id); assert.equal(value.state, 'cancelled'); assert.equal(value.retryCount, 0);
  }
  assert.deepEqual(calls, ['job:3']); await worker.close(); assert.deepEqual(f.errors, []);
});

test('closing one upstream worker group stops pickup; replacement worker handles remaining rows', { timeout: 20000 }, async t => {
  const f = await fixture(t), calls = [];
  const worker = await f.start(async ref => { calls.push(ref.jobId); return { disposition: 'delivered' }; }, 3);
  await worker.close(); assert.equal(worker.isAccepting(), false);
  const id = await f.send(1); await delay(1100);
  assert.equal((await f.get(id)).state, 'created'); assert.deepEqual(calls, []);
  const next = await f.start(async ref => { calls.push(ref.jobId); return { disposition: 'held' }; });
  await until(async () => (await f.get(id))?.state === 'completed');
  await next.close(); assert.deepEqual(calls, ['job:1']); assert.deepEqual(f.errors, []);
});

test('close forwards abort and drains an abort-aware handler without accepting late success', { timeout: 20000 }, async t => {
  const f = await fixture(t); let entered, receivedSignal;
  const ready = new Promise(resolve => { entered = resolve; });
  const id = await f.send(1);
  const worker = await f.start(async (_ref, signal) => {
    receivedSignal = signal; entered();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { disposition: 'delivered' };
  });
  await ready; await worker.close();
  assert.equal(receivedSignal.aborted, true); assert.equal((await f.get(id)).state, 'failed');
  assert.deepEqual(f.errors, []);
});
