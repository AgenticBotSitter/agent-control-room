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
import { verifyPgBossNativeWorkerPermissions } from '../../src/persistence/pg-boss-native-task-permissions.ts';
import { verifyNativeQueueWorkerDatabase } from '../../src/web/v1/private-database-preflight.ts';
import { createNativeQueueWorkerBootstrap } from '../../src/web/v1/native-queue-worker-startup.ts';
import { preparePgBossNativeTaskSubmission } from '../../src/persistence/pg-boss-native-task-submission.ts';
import { managedNativeSessionFixture, currentSignal } from '../../tests/helpers/managed-native-session.ts';
import { qualityText } from '../../tests/helpers/native-quality-completion.ts';
import { WebSessionAuthority } from '../../src/web/v1/session-authority.ts';
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
  await f.raw.exec(await readFile(new URL('../../db/roles/native_queue_worker_roles.sql', import.meta.url), 'utf8'));
  let closed = false, closeCount = 0;
  const statements = [], clients = [];
  class CapturedBoss extends PgBoss { constructor(options) { super(options); clients.push(this); } }
  const runtime = await startPgBossNativeTaskRuntime(CapturedBoss, {
    async query(sql, values) {
      assert.equal(closed, false, 'worker SQL must stop after its owned port closes');
      statements.push(sql);
      return f.raw.transaction(async tx => {
        await tx.exec('SET LOCAL ROLE control_room_native_queue_worker');
        return values?.length ? tx.query(sql, values) : (await tx.exec(sql)).at(-1) ?? { rows: [] };
      });
    },
    async close() { closed = true; closeCount++; },
  }, { backend: 'pglite', deliver, concurrency });
  f.workers.push(runtime);
  return { runtime, statements, closed: () => closed, closeCount: () => closeCount,
    fault: () => clients[0].emit('error', new Error('synthetic runtime fault')) };
}

test('actual queue pickup reaches managed signed receipt and completed result review without a browser identity', { timeout: 30000 }, async t => {
  const x = await managedNativeSessionFixture(undefined, { queue: true });
  let worker, producer, admin;
  t.after(async () => { try { await worker?.close(); await producer?.close(); await admin?.stop({ graceful: false }); } finally { await x.close(); } });
  admin = new PgBoss({ db: { executeSql: (sql, values) => x.admin(async () =>
    values?.length ? x.f.raw.query(sql, values) : (await x.f.raw.exec(sql)).at(-1) ?? { rows: [] }) },
    schema: spec.schema, backend: 'pglite', supervise: false, schedule: false, useListenNotify: false });
  const errors = []; admin.on('error', error => errors.push(error));
  await admin.start(); await admin.createQueue(spec.name, { retryLimit: 0 });
  const canonical = { query: (sql, values) => x.admin(() => x.f.db.query(sql, values)),
    transaction: work => x.admin(() => x.f.db.transaction(work)),
    transactionWithPreCommitCheck: (work, check) => x.admin(() => x.f.db.transactionWithPreCommitCheck(work, check)) };
  producer = await preparePgBossNativeTaskSubmission(PgBoss, canonical, { backend: 'pglite' });
  const workerRole = await readFile(new URL('../../db/roles/native_queue_worker_roles.sql', import.meta.url), 'utf8');
  await x.admin(() => x.f.raw.exec(workerRole));
  const query = (sql, values) => x.f.raw.transaction(async tx => {
    await tx.exec('SET LOCAL SESSION AUTHORIZATION postgres; SET LOCAL ROLE control_room_native_queue_worker');
    return values?.length ? tx.query(sql, values) : (await tx.exec(sql)).at(-1) ?? { rows: [] };
  });
  const c = await x.attach(); await x.handshake(c);
  let deliveries = 0;
  worker = await startPgBossNativeTaskRuntime(PgBoss, { query, async close() {} }, { backend: 'pglite', async deliver(ref, signal) {
    deliveries++; const result = await x.manager.deliverApproved(ref, signal);
    if (!result.deliveryConfirmed) throw new Error('synthetic awaiting signed receipt');
    return { disposition: 'delivered' };
  } });
  const coordinator = x.f.create(canonical, producer);
  await x.admin(() => x.f.save());
  const receipt = await coordinator.enqueueNativeTask(...x.f.args, x.task.packetDigest, currentSignal());
  const ref = { schema: 'control-room.native-task-submission/v1', tenantId: x.f.scope.tenantId,
    projectId: receipt.projectId, jobId: receipt.jobId, attemptId: receipt.attemptId, queueId: receipt.queueId,
    inputDigest: x.task.inputDigest, packetDigest: receipt.packetDigest };
  await new WebSessionAuthority(canonical, x.f.scope, x.f.clock).logout(x.f.identity);
  const id = nativeTaskSubmissionId(ref);
  await until(async () => (await admin.getJobById(spec.name, id))?.state === 'failed');
  assert.equal(deliveries, 1);
  const frames = c.peer.outgoing.filter(raw => JSON.parse(raw).type === 'harness.native.dispatch');
  assert.equal(frames.length, 1);
  await c.peer.acknowledge(); await c.handle.receipt(c.peer.incoming.shift(), currentSignal());
  const native = await x.prepareNode(c.peer, JSON.parse(frames[0]));
  const beforeCompletion = await x.states();
  const bound = await x.receiver.register(x.request, currentSignal());
  for (const phase of ['start', 'running']) {
    const wire = await native.produce(phase); await c.handle.progress(wire.raw, undefined, currentSignal()); await c.peer.acknowledge();
  }
  const wire = await native.produce('completed');
  const result = await c.handle.progress(wire.raw, new TextEncoder().encode(qualityText), currentSignal());
  await c.peer.acknowledge();
  assert.equal(result.state, 'succeeded'); assert.ok(result.submission);
  assert.equal(result.submission.targetId, bound.receipt.targetId);
  assert.equal(result.submission.qualityAccepted, false);
  const review = await x.admin(() => x.f.reviewStore.snapshot(x.f.scope.tenantId, bound.receipt.targetId));
  assert.equal(review.status, 'pending');
  const counts = await x.counts();
  assert.equal(counts.runs.length, 1); assert.equal(counts.events.length, 3);
  assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.deepEqual(await x.f.config.storage.read(counts.artifacts[0].id), new TextEncoder().encode(qualityText));
  assert.deepEqual(await x.states(), beforeCompletion);
  // An outstanding receipt is not permission to retry the external start. Later
  // evidence reaches review without rewriting the operational failure as success.
  assert.equal((await admin.getJobById(spec.name, id)).state, 'failed');
  assert.equal(deliveries, 1); assert.deepEqual(errors, []);
});

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

test('upstream version gate rejects old, future and missing versions without pickup or migration', { timeout: 20000 }, async t => {
  const f = await fixture(t); const id = await f.send(81);
  await f.raw.exec(await readFile(new URL('../../db/roles/native_queue_worker_roles.sql', import.meta.url), 'utf8'));
  for (const sql of ['UPDATE control_room_queue.version SET version=39', 'UPDATE control_room_queue.version SET version=41', 'DELETE FROM control_room_queue.version']) {
    await f.raw.exec(sql); let closed = 0, delivered = 0;
    const before = await f.raw.query('SELECT * FROM control_room_queue.version');
    const query = (sql, values) => f.raw.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE control_room_native_queue_worker');
      return values?.length ? tx.query(sql, values) : (await tx.exec(sql)).at(-1) ?? { rows: [] };
    });
    await assert.rejects(startPgBossNativeTaskRuntime(PgBoss, { query, async close() { closed++; } }, {
      backend: 'pglite', async deliver() { delivered++; return { disposition: 'held' }; },
    }), /native_task_runtime_start_failed/);
    assert.equal(closed, 1); assert.equal(delivered, 0);
    assert.deepEqual((await f.raw.query('SELECT * FROM control_room_queue.version')).rows, before.rows);
    assert.equal((await f.get(id)).state, 'created');
  }
});

test('upstream drift API detects a missing managed index but can skip an unavailable function probe', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.boss.detectSchemaDrift()).ok, true);
  let skipped = 0;
  const inspection = new PgBoss({ db: { async executeSql(sql, values) {
    if (sql.includes('pg_get_functiondef')) { skipped++; throw new Error('synthetic catalog probe unavailable'); }
    return values?.length ? f.raw.query(sql, values) : (await f.raw.exec(sql)).at(-1) ?? { rows: [] };
  } }, schema: spec.schema, backend: 'pglite', migrate: false, createSchema: false,
    schedule: false, supervise: false, useListenNotify: false });
  inspection.on('error', () => {}); f.workers.push({ close: () => inspection.stop({ graceful: false }) });
  await inspection.start();
  assert.equal((await inspection.detectSchemaDrift()).ok, true);
  assert.equal(skipped, 1, 'ok does not certify every probe ran');
  await f.raw.exec('DROP INDEX control_room_queue.job_common_i11');
  const report = await f.boss.detectSchemaDrift();
  assert.equal(report.ok, false); assert.ok(report.missing.some(index => index.name === 'job_common_i11'));
  assert.equal(await f.boss.schemaVersion(), 40, 'version equality is not a full integrity check');
});

test('actual worker role distinguishes pickup/completion privileges from failure privileges', { timeout: 20000 }, async t => {
  const f = await fixture(t), errors = [];
  await f.raw.exec(`CREATE ROLE cr_reuse_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA control_room_queue TO cr_reuse_worker;
    GRANT SELECT ON control_room_queue.version,control_room_queue.queue,
      control_room_queue.job,control_room_queue.job_common TO cr_reuse_worker;
    GRANT UPDATE ON control_room_queue.job,control_room_queue.job_common TO cr_reuse_worker;`);
  const roleQuery = (sql, values) => f.raw.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE cr_reuse_worker');
    return values?.length ? tx.query(sql, values) : (await tx.exec(sql)).at(-1) ?? { rows: [] };
  });
  const worker = new PgBoss({ db: { executeSql: roleQuery }, schema: spec.schema, backend: 'pglite',
    migrate: false, createSchema: false, schedule: false, supervise: false, useListenNotify: false });
  worker.on('error', error => errors.push(error));
  f.workers.push({ close: () => worker.stop({ graceful: false }) });
  await worker.start();
  const first = await f.send(31);
  assert.equal((await worker.fetch(spec.name))[0].id, first);
  await worker.complete(spec.name, first, { disposition: 'held' });
  assert.equal((await f.get(first)).state, 'completed');
  const second = await f.send(32); await worker.fetch(spec.name);
  await assert.rejects(worker.fail(spec.name, second, { reason: 'synthetic' }), /permission denied/);
  assert.equal((await f.get(second)).state, 'active', 'failed statement must roll back');
  await f.raw.exec('GRANT INSERT,DELETE ON control_room_queue.job,control_room_queue.job_common TO cr_reuse_worker');
  await worker.fail(spec.name, second, { reason: 'synthetic' });
  assert.equal((await f.get(second)).state, 'failed');
  assert.equal((await f.get(second)).retryCount, 0);
  await assert.rejects(roleQuery("UPDATE control_room_queue.queue SET retry_limit=2 WHERE name='native-task-delivery'"), /permission denied/);
  await assert.rejects(roleQuery('CREATE TABLE control_room_queue.unapproved(id int)'), /permission denied/);
  await worker.stop({ graceful: false }); assert.deepEqual(errors, []);
});

test('candidate worker role runs the actual owned runtime without queue-edit or canonical privileges', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.raw.exec(await readFile(new URL('../../db/roles/native_queue_worker_roles.sql', import.meta.url), 'utf8'));
  await f.raw.exec('CREATE TABLE public.synthetic_canonical_evidence(id int); REVOKE ALL ON public.synthetic_canonical_evidence FROM PUBLIC');
  const query = (sql, values) => f.raw.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE control_room_native_queue_worker');
    return values?.length ? tx.query(sql, values) : (await tx.exec(sql)).at(-1) ?? { rows: [] };
  });
  let closed = false;
  const runtime = await startPgBossNativeTaskRuntime(PgBoss, { async query(sql, values) {
    assert.equal(closed, false); return query(sql, values);
  }, async close() { closed = true; } }, { backend: 'pglite', async deliver(ref) {
    if (ref.jobId === 'job:42') throw new Error('synthetic unresolved delivery');
    return { disposition: 'held' };
  } });
  f.workers.push(runtime);
  const success = await f.send(41), failure = await f.send(42);
  await until(async () => (await f.get(failure))?.state === 'failed');
  assert.equal((await f.get(success)).state, 'completed');
  assert.equal((await f.get(failure)).retryCount, 0);
  for (const sql of ["UPDATE control_room_queue.queue SET retry_limit=2", 'CREATE TABLE control_room_queue.unapproved(id int)',
    'SELECT * FROM public.synthetic_canonical_evidence', 'INSERT INTO public.synthetic_canonical_evidence VALUES(1)']) {
    await assert.rejects(query(sql), /permission denied/);
  }
  const flags = await query("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user");
  assert.equal(Object.values(flags.rows[0]).every(value => value === false), true);
  await runtime.close(); assert.equal(closed, true);
  assert.deepEqual(runtime.status(), { state: 'closed', faulted: false, accepting: false });
  assert.deepEqual(f.errors, []);
});

test('effective worker preflight rejects missing and excessive privileges', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.raw.exec(await readFile(new URL('../../db/roles/native_queue_worker_roles.sql', import.meta.url), 'utf8'));
  await f.raw.exec('CREATE TABLE public.synthetic_private(id int); REVOKE ALL ON public.synthetic_private FROM PUBLIC');
  const query = sql => f.raw.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE control_room_native_queue_worker');
    return tx.query(sql);
  });
  const check = () => verifyPgBossNativeWorkerPermissions({ query });
  await check();
  const changes = [
    ['REVOKE DELETE ON control_room_queue.job_common FROM control_room_native_queue_worker', 'GRANT DELETE ON control_room_queue.job_common TO control_room_native_queue_worker'],
    ['GRANT UPDATE(name) ON control_room_queue.queue TO control_room_native_queue_worker', 'REVOKE UPDATE(name) ON control_room_queue.queue FROM control_room_native_queue_worker'],
    ['GRANT SELECT(id) ON public.synthetic_private TO control_room_native_queue_worker', 'REVOKE SELECT(id) ON public.synthetic_private FROM control_room_native_queue_worker'],
    ['GRANT SELECT ON control_room_queue.version TO control_room_native_queue_worker WITH GRANT OPTION', 'REVOKE GRANT OPTION FOR SELECT ON control_room_queue.version FROM control_room_native_queue_worker'],
    ['CREATE FUNCTION public.synthetic_callable() RETURNS int LANGUAGE SQL AS $$ SELECT 1 $$', 'DROP FUNCTION public.synthetic_callable()'],
    ['CREATE ROLE synthetic_extra; GRANT synthetic_extra TO control_room_native_queue_worker', 'REVOKE synthetic_extra FROM control_room_native_queue_worker; DROP ROLE synthetic_extra'],
  ];
  for (const [change, restore] of changes) {
    await f.raw.exec(change);
    await assert.rejects(check(), /native_task_worker_permissions_invalid/);
    await f.raw.exec(restore); await check();
  }
});

test('dedicated worker login passes shared session gates and runs without canonical access', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.raw.exec(await readFile(new URL('../../db/roles/native_queue_worker_roles.sql', import.meta.url), 'utf8'));
  await f.raw.exec(`CREATE ROLE queue_worker_test LOGIN INHERIT;
    GRANT control_room_native_queue_worker TO queue_worker_test;
    SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
    SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
  const config = { host: '127.0.0.1', port: 5432, database: 'template1', username: 'queue_worker_test', password: 'synthetic-only', majorVersion: 17 };
  function database(setting, injectTemp = true) {
    const db = { transaction: work => f.raw.transaction(async tx => {
      await tx.exec('SET LOCAL SESSION AUTHORIZATION queue_worker_test');
      if (setting) await tx.exec(setting);
      return work({ async query(sql, values) {
        const result = await tx.query(sql, values);
        // Existing PGlite TEMP metadata limitation only; actual session/role/ACL queries run.
        if (injectTemp && sql.includes('AS database_temp')) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
        return result;
      } });
    }) };
    return { ...db, query: (sql, values) => db.transaction(tx => tx.query(sql, values)) };
  }
  const db = database();
  await assert.rejects(verifyNativeQueueWorkerDatabase(database(undefined, false), config), /preflight_failed/);
  await verifyNativeQueueWorkerDatabase(db, config);
  for (const override of [{ username: 'other_worker' }, { database: 'other_database' }])
    await assert.rejects(verifyNativeQueueWorkerDatabase(db, { ...config, ...override }), /preflight_failed/);
  for (const setting of ["SET LOCAL statement_timeout='0'", "SET LOCAL search_path=public", 'SET LOCAL ROLE control_room_native_queue_worker'])
    await assert.rejects(verifyNativeQueueWorkerDatabase(database(setting), config), /preflight_failed/);
  for (const [change, restore] of [
    ['ALTER ROLE control_room_native_queue_worker LOGIN', 'ALTER ROLE control_room_native_queue_worker NOLOGIN'],
    ['ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO queue_worker_test', 'ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM queue_worker_test'],
    ['CREATE SCHEMA unexpected_worker_schema', 'DROP SCHEMA unexpected_worker_schema'],
  ]) {
    // Restore the administrator explicitly after the rejected SET ROLE fixture;
    // this single-engine fixture does not certify connection-pool role isolation.
    await f.raw.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
    await f.raw.exec(change);
    await assert.rejects(verifyNativeQueueWorkerDatabase(db, config), /preflight_failed/);
    await f.raw.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');
    await f.raw.exec(restore); await verifyNativeQueueWorkerDatabase(db, config);
  }
  let closed = 0, delivered = 0;
  const input = { database: config, application: { host: config.host, port: config.port, database: config.database,
    loginNames: ['web_test', 'coordinator_test'] }, async deliver() { delivered++; return { disposition: 'held' }; } };
  const make = () => createNativeQueueWorkerBootstrap({ PgBoss, backend: 'pglite', openDatabase: () => ({
    client: db, isAvailable: () => true, async close() { closed++; },
  }) });
  await f.raw.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE; REVOKE DELETE ON control_room_queue.job_common FROM control_room_native_queue_worker');
  await assert.rejects(make().start(input), /native_queue_worker_start_failed/);
  assert.equal(closed, 1); assert.equal(delivered, 0);
  await f.raw.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE; GRANT DELETE ON control_room_queue.job_common TO control_room_native_queue_worker');
  const bootstrap = make(), runtime = await bootstrap.start(input);
  await assert.rejects(bootstrap.start(input), /already_attempted/);
  f.workers.push(runtime);
  const id = await f.send(91); await until(async () => (await f.get(id))?.state === 'completed');
  await runtime.close(); assert.equal(closed, 2); assert.equal(delivered, 1);
});

test('candidate worker role setup rejects retry-enabled queue before creating a role', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.boss.updateQueue(spec.name, { retryLimit: 1 });
  const script = await readFile(new URL('../../db/roles/native_queue_worker_roles.sql', import.meta.url), 'utf8');
  try { await assert.rejects(f.raw.exec(script), /native queue prerequisite mismatch/); }
  finally { await f.raw.exec('ROLLBACK'); }
  assert.equal((await f.raw.query("SELECT rolname FROM pg_roles WHERE rolname='control_room_native_queue_worker'")).rows.length, 0);
  assert.equal((await f.boss.getQueue(spec.name)).retryLimit, 1);
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
