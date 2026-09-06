// Opt-in candidate experiment, not an application dependency or a native worker.
// Run from checkout: CR_REUSE_EVAL_ROOT=<ledger root> node --import tsx --test scripts/research/pg-boss-evaluation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { canonicalApprovalStorageFixture } from '../../tests/helpers/canonical-approval-storage.ts';
import { sha256Digest } from '../../src/security/index.ts';

const root = process.env.CR_REUSE_EVAL_ROOT;
assert.ok(root && isAbsolute(root), 'Explicit absolute evaluation root required; no auto-install');
const packageRoot = join(root, 'node_modules/pg-boss');
const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(metadata.name, 'pg-boss');
assert.equal(metadata.version, '12.30.0');
const { PgBoss } = await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
const queueName = 'synthetic-approval-delivery';
const jobId = '00000000-0000-4000-8000-000000000001';

async function startBoss(raw, transactionActive = () => false) {
  const errors = [];
  const boss = new PgBoss({
    backend: 'pglite', schema: 'reuse_e01', schedule: false, supervise: false,
    db: { async executeSql(sql, values) {
      assert.equal(transactionActive(), false, 'Candidate used outer database during caller transaction');
      // PGlite exec is needed for pg-boss's multi-statement schema construction.
      if (values?.length) return raw.query(sql, values);
      const results = await raw.exec(sql);
      return results.at(-1) ?? { rows: [] };
    } },
  });
  boss.on('error', error => errors.push(error));
  try {
    await boss.start();
    await boss.createQueue(queueName, { retryLimit: 1, retryDelay: 0 });
    // Populate metadata BEFORE entering the caller's single-connection transaction.
    // getQueue reads metadata but does NOT fill pg-boss's internal cache.
    // An empty fetch does; never apply this setup recipe to a nonempty/live queue.
    assert.deepEqual(await boss.fetch(queueName), []);
    return { boss, errors, close: () => boss.stop({ graceful: false }) };
  } catch (error) {
    await boss.stop({ graceful: false });
    throw error;
  }
}

test('actual package initializes, picks up once, completes and restarts its client', { timeout: 30000 }, async t => {
  const raw = new PGlite();
  let engine;
  t.after(async () => { if (engine) await engine.close(); await raw.close(); });
  engine = await startBoss(raw);
  assert.equal(await engine.boss.send(queueName, { synthetic: true }, { id: jobId }), jobId);
  assert.equal(await engine.boss.send(queueName, { synthetic: true }, { id: jobId }), null);
  const [job] = await engine.boss.fetch(queueName);
  assert.equal(job.id, jobId);
  assert.deepEqual(await engine.boss.fetch(queueName), []);
  await engine.boss.complete(queueName, jobId, { result: 'synthetic-complete' });
  assert.equal((await engine.boss.getJobById(queueName, jobId)).state, 'completed');
  assert.deepEqual(engine.errors, []);
  await engine.close();
  engine = await startBoss(raw);
  assert.equal((await engine.boss.getJobById(queueName, jobId)).state, 'completed');
  assert.deepEqual(await engine.boss.fetch(queueName), []);
  assert.deepEqual(engine.errors, []);
});

for (const mode of ['commit', 'rollback', 'abort', 'expiry', 'revocation', 'lost-ack']) {
  test(`canonical approval, audit and actual queue share transaction: ${mode}`, { timeout: 30000 }, async t => {
    const f = await canonicalApprovalStorageFixture();
    let engine;
    t.after(async () => { if (engine) await engine.close(); await f.close(); });
    await f.save();
    let transactionActive = false;
    engine = await startBoss(f.raw, () => transactionActive);
    let sent = false;
    const db = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
      const result = await f.db.transactionWithPreCommitCheck(async tx => {
        transactionActive = true;
        try {
        const value = await work(tx);
        await engine.boss.send(queueName, { synthetic: true }, {
          id: jobId, db: { executeSql: (sql, values) => tx.query(sql, values) },
        });
        sent = true;
        if (mode === 'rollback') throw new Error('synthetic-after-send-failure');
        if (mode === 'abort') f.abort.abort();
        if (mode === 'expiry') f.setNow(f.prepared.start.deadline);
        if (mode === 'revocation') await f.native.revoke();
        return value;
        } finally { transactionActive = false; }
      }, check);
      if (mode === 'lost-ack') throw new Error('synthetic-lost-commit-ack');
      return result;
    } };
    const coordinator = f.create(db);
    const enqueue = () => coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
    if (mode === 'commit') await enqueue(); else await assert.rejects(enqueue());
    assert.equal(sent, true, 'Candidate INSERT must execute before fault injection');
    const committed = mode === 'commit' || mode === 'lost-ack';
    assert.equal((await f.db.query('SELECT * FROM control_native_task_queue')).rows.length, Number(committed));
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.task.queued'")).rows.length, Number(committed));
    const candidate = await engine.boss.getJobById(queueName, jobId);
    assert.equal(Boolean(candidate), committed);
    if (committed) {
      const receipt = await f.coordinator.readNativeTaskQueue(...f.args);
      assert.equal(receipt.grantsExecutionAuthority, false);
      assert.equal(receipt.startsWork, false);
      if (mode === 'commit') assert.equal((await enqueue()).replayed, true);
      else await assert.rejects(enqueue(), /synthetic-lost-commit-ack/);
      assert.equal((await engine.boss.fetch(queueName)).length, 1);
      assert.deepEqual(await engine.boss.fetch(queueName), []);
      assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.task.queued'")).rows.length, 1);
    } else assert.deepEqual(await engine.boss.fetch(queueName), []);
    assert.deepEqual(engine.errors, []);
  });
}

test('unapproved or mismatched tasks never reach the candidate INSERT', { timeout: 30000 }, async t => {
  const f = await canonicalApprovalStorageFixture();
  let engine;
  t.after(async () => { if (engine) await engine.close(); await f.close(); });
  engine = await startBoss(f.raw);
  let submitted = 0;
  const coordinator = f.create({ ...f.db,
    transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
      const value = await work(tx);
      submitted++;
      await engine.boss.send(queueName, { synthetic: true }, {
        id: jobId, db: { executeSql: (sql, values) => tx.query(sql, values) },
      });
      return value;
    }, check),
  });
  await assert.rejects(coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal));
  await f.save();
  await assert.rejects(coordinator.enqueueNativeTask(...f.args, sha256Digest('wrong-packet'), f.abort.signal));
  assert.equal(submitted, 0);
  assert.deepEqual(await engine.boss.fetch(queueName), []);
  assert.deepEqual(engine.errors, []);
});

test('deleting operational history permits the same ID again: canonical dedup must outlive it', { timeout: 30000 }, async t => {
  const raw = new PGlite();
  let engine;
  t.after(async () => { if (engine) await engine.close(); await raw.close(); });
  engine = await startBoss(raw);
  await engine.boss.send(queueName, { synthetic: true }, { id: jobId });
  await engine.boss.fetch(queueName);
  await engine.boss.complete(queueName, jobId);
  await engine.boss.deleteJob(queueName, jobId);
  assert.equal(await engine.boss.send(queueName, { synthetic: true }, { id: jobId }), jobId);
  assert.equal((await engine.boss.fetch(queueName))[0].id, jobId);
  assert.deepEqual(engine.errors, []);
});

test('schedule definitions persist timezone; invalid cron rejected without starting timer', { timeout: 30000 }, async t => {
  const raw = new PGlite();
  let engine;
  t.after(async () => { if (engine) await engine.close(); await raw.close(); });
  engine = await startBoss(raw);
  await engine.boss.schedule(queueName, '0 9 * * *', { synthetic: true }, { tz: 'America/Denver' });
  const [schedule] = await engine.boss.getSchedules(queueName);
  assert.equal(schedule.cron, '0 9 * * *');
  assert.equal(schedule.timezone, 'America/Denver');
  await assert.rejects(engine.boss.schedule(queueName, 'not-a-cron', { synthetic: true }));
  await engine.boss.unschedule(queueName);
  assert.deepEqual(await engine.boss.getSchedules(queueName), []);
  assert.deepEqual(await engine.boss.fetch(queueName), []);
  assert.deepEqual(engine.errors, []);
});

test('retry is bounded, cancellation prevents pickup, future work stays queued', { timeout: 30000 }, async t => {
  const raw = new PGlite();
  let engine;
  t.after(async () => { if (engine) await engine.close(); await raw.close(); });
  engine = await startBoss(raw);
  const id = await engine.boss.send(queueName, { synthetic: true });
  assert.equal((await engine.boss.fetch(queueName))[0].id, id);
  await engine.boss.fail(queueName, id, { reason: 'synthetic-failure' });
  assert.equal((await engine.boss.getJobById(queueName, id)).state, 'retry');
  assert.equal((await engine.boss.fetch(queueName))[0].id, id);
  await engine.boss.fail(queueName, id, { reason: 'synthetic-final-failure' });
  assert.equal((await engine.boss.getJobById(queueName, id)).state, 'failed');
  const cancelId = await engine.boss.send(queueName, { synthetic: true });
  await engine.boss.cancel(queueName, cancelId);
  assert.equal((await engine.boss.getJobById(queueName, cancelId)).state, 'cancelled');
  const futureId = await engine.boss.send(queueName, { synthetic: true }, { startAfter: 3600 });
  assert.ok(futureId);
  assert.deepEqual(await engine.boss.fetch(queueName), []);
  assert.deepEqual(engine.errors, []);
});
