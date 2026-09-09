// Actual pg-boss queue primitives, not a production review coordinator.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss, getConstructionPlans } from 'pg-boss';
const [root, socket] = process.argv.slice(2);
assert.match(root, /^\/private\/tmp\/cr-compare-f1\.[A-Za-z0-9]+$/);
assert.match(socket, new RegExp(`^${root.replaceAll('.', '\\.')}/pg-run-[A-Za-z0-9]+/socket$`));
assert.equal(process.cwd(), join(dirname(socket), 'empty'));
assert.deepEqual(await readdir(process.cwd()), []);
const localRequire = createRequire(import.meta.url);
assert.equal(JSON.parse(await readFile(join(dirname(localRequire.resolve('pg-boss')), '../package.json'), 'utf8')).version, '12.30.0');
const require = createRequire(join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json'));
const { Pool } = require('pg');
const pool = new Pool({ host: socket, port: 65433, user: 'f1_owner', database: 'postgres', password: '',
  max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
const errors = [], outcomes = [], executions = [], releases = [];
pool.on('error', error => errors.push(error.code ?? 'pool-error'));
const schema = 'comparison_pgboss_worker';
const boss = new PgBoss({ schema, db: { executeSql: (sql, params) => pool.query(sql, params) },
  migrate: false, supervise: false, schedule: false, useListenNotify: false });
boss.on('error', error => errors.push(error.message));
const until = async (predicate, ms = 5000) => {
  const end = Date.now() + ms;
  do { const value = await predicate(); if (value) return value; await delay(50); } while (Date.now() < end);
  throw new Error('bounded observation deadline');
};
const completed = (queue, id) => until(async () => {
  const job = await boss.getJobById(queue, id); return job?.state === 'completed' ? job : false;
});
try {
  assert.equal((await pool.query('SELECT to_regnamespace($1) AS existing', [schema])).rows[0].existing, null);
  const plan = getConstructionPlans(schema);
  assert.doesNotMatch(plan, /CREATE\s+(DATABASE|ROLE|EXTENSION)|ALTER\s+SYSTEM|COPY\s+.*PROGRAM/i);
  await pool.query(plan);
  await boss.start();
  for (const concurrency of [1, 2]) {
    const queue = `hold-${concurrency}`;
    await boss.createQueue(queue, { retryLimit: 0, expireInSeconds: 20 });
    let release;
    const held = new Promise(resolve => { release = resolve; }); releases.push(release);
    const started = new Set();
    await boss.work(queue, { localConcurrency: concurrency, batchSize: 1, pollingIntervalSeconds: 0.5 }, async jobs => {
      assert.equal(jobs.length, 1); const job = jobs[0];
      started.add(job.data.label); executions.push(job.data.label);
      if (job.data.hold) await held;
      return { label: job.data.label, complete: true };
    });
    const a = await boss.send(queue, { label: `A${concurrency}`, hold: true }); assert.ok(a);
    await until(() => started.has(`A${concurrency}`));
    const b = await boss.send(queue, { label: `B${concurrency}`, hold: false }); assert.ok(b);
    if (concurrency === 1) await delay(1500); else await completed(queue, b);
    const bBefore = await boss.getJobById(queue, b);
    assert.equal(started.has(`B${concurrency}`), concurrency === 2);
    assert.equal(bBefore.state, concurrency === 1 ? 'created' : 'completed');
    release();
    assert.deepEqual((await completed(queue, a)).output, { label: `A${concurrency}`, complete: true });
    assert.deepEqual((await completed(queue, b)).output, { label: `B${concurrency}`, complete: true });
    outcomes.push({ case: 'in-memory-callback-hold', concurrency, bBeforeRelease: bBefore.state, bothPersistedOutputs: true });
  }
  const queue = 'phase-one';
  await boss.createQueue(queue, { retryLimit: 0, expireInSeconds: 20 });
  await boss.work(queue, { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 0.5 }, async jobs => {
    assert.equal(jobs.length, 1); executions.push(jobs[0].data.label); return jobs[0].data;
  });
  const first = await boss.send(queue, { label: 'phase-A', phase: 'waiting_review' }); assert.ok(first);
  const firstResult = await completed(queue, first);
  assert.equal(firstResult.output.phase, 'waiting_review');
  const independent = await boss.send(queue, { label: 'phase-B', phase: 'done' }); assert.ok(independent);
  assert.equal((await completed(queue, independent)).output.phase, 'done');
  const continuation = await boss.send(queue, { label: 'phase-A-continuation', parent: first, phase: 'done' }); assert.ok(continuation);
  assert.notEqual(continuation, first);
  assert.equal((await completed(queue, continuation)).output.parent, first);
  outcomes.push({ case: 'explicit-persisted-phase-boundary', concurrency: 1, waitingOutput: firstResult.output.phase,
    independentCompletedBeforeContinuation: true, distinctContinuation: true, storedParentMatched: true });
  assert.equal(executions.length, 7); assert.equal(new Set(executions).size, 7); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ candidate: 'pg-boss12.30.0', backend: 'PostgreSQL18.4',
    constructionPlanSHA256: createHash('sha256').update(plan).digest('hex'), outcomes, executions,
    scope: 'one-process capacity and persisted synthetic phases only; not DBOS.recv durability, canonical approval, crash recovery or atomic continuation' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ failed: true, message: error.message, outcomes, executions, errors })); process.exitCode = 1;
} finally {
  for (const release of releases) release();
  await boss.stop({ graceful: true, timeout: 1000, close: false });
  await pool.end();
}
