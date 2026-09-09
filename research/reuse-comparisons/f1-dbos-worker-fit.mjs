// Actual SDK worker, synthetic bodies only; invoked by the disposable PG runner.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
const [root, socket] = process.argv.slice(2);
assert.match(root, /^\/private\/tmp\/cr-compare-f1\.[A-Za-z0-9]+$/);
assert.match(socket, new RegExp(`^${root.replaceAll('.', '\\.')}/pg-run-[A-Za-z0-9]+/socket$`));
assert.equal(process.cwd(), join(dirname(socket), 'empty'));
assert.deepEqual(await readdir(process.cwd()), []);
assert.equal(process.env.DBOS__CLOUD, undefined);
const pkg = join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json');
assert.equal(JSON.parse(await readFile(pkg, 'utf8')).version, '4.27.6');
const require = createRequire(pkg);
const { DBOS } = require('./dist/src/dbos.js');
const { ensureSystemDatabase } = require('./dist/src/system_database.js');
const { Pool } = require('pg');
const pool = new Pool({ host: socket, port: 65433, user: 'f1_owner', database: 'postgres', password: '',
  max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
const errors = [];
pool.on('error', error => errors.push(error.code ?? 'pool-error'));
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const outcomes = [], executions = [];
let launched = false;
try {
  await ensureSystemDatabase('', logger, pool, 'comparison_worker', false);
  DBOS.setConfig({ name: 'synthetic-worker-comparison', applicationVersion: 'fixture-v1', executorID: 'fixture-executor',
    systemDatabasePool: pool, systemDatabasePoolSize: 4, systemDatabaseSchemaName: 'comparison_worker', runMigrations: false,
    runAdminServer: false, enableOTLP: false, tracingEnabled: false, otlpTracesEndpoints: [], otlpLogsEndpoints: [], logger,
    useListenNotify: false, listenQueues: ['fixture-one', 'fixture-two'], maxConcurrentQueueDispatches: 1,
    systemDatabasePollingConcurrency: 1 });
  const work = DBOS.registerWorkflow(async input => {
    executions.push(input.id);
    await DBOS.setEvent('started', input.id);
    if (input.wait) {
      const review = await DBOS.recv('synthetic-review', { timeoutSeconds: 15, pollingIntervalMs: 50 });
      assert.equal(review, 'released');
    }
    return { id: input.id, complete: true };
  }, { name: 'inert-work', maxRecoveryAttempts: 1 });
  await DBOS.launch(); launched = true;
  for (const concurrency of [1, 2]) {
    const queueName = concurrency === 1 ? 'fixture-one' : 'fixture-two';
    await DBOS.registerQueue(queueName, { globalConcurrency: concurrency, workerConcurrency: concurrency, minPollingIntervalMs: 50 });
    const aID = `wait-${concurrency}`, bID = `independent-${concurrency}`;
    const a = await DBOS.startWorkflow(work, { workflowID: aID, queueName })({ id: aID, wait: true });
    assert.equal(await DBOS.getEvent(aID, 'started', { timeoutSeconds: 5, pollingIntervalMs: 50 }), aID);
    const b = await DBOS.startWorkflow(work, { workflowID: bID, queueName })({ id: bID, wait: false });
    const startedBeforeRelease = await DBOS.getEvent(bID, 'started', { timeoutSeconds: concurrency === 1 ? 1 : 5, pollingIntervalMs: 50 });
    const statusBeforeRelease = await b.getStatus();
    assert.equal(startedBeforeRelease, concurrency === 1 ? null : bID);
    await DBOS.send(aID, 'released', 'synthetic-review', `review-${concurrency}`);
    assert.deepEqual(await a.getResult({ timeoutSeconds: 5, pollingIntervalMs: 50 }), { id: aID, complete: true });
    assert.deepEqual(await b.getResult({ timeoutSeconds: 5, pollingIntervalMs: 50 }), { id: bID, complete: true });
    outcomes.push({ concurrency, startedBeforeRelease, statusBeforeRelease: statusBeforeRelease?.status,
      bothResultsRetrieved: true, observationWindowSeconds: concurrency === 1 ? 1 : 5 });
  }
  assert.deepEqual([...executions].sort(), ['independent-1', 'independent-2', 'wait-1', 'wait-2']);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ candidate: 'DBOS4.27.6', backend: 'PostgreSQL18.4', outcomes, executions,
    scope: 'actual synthetic queue pickup and durable review wait; no canonical admission or native effects; no process recovery tested' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ failed: true, message: error.message, outcomes, executions })); process.exitCode = 1;
} finally {
  if (launched || DBOS.isInitialized()) await DBOS.shutdown({ workflowCompletionTimeoutMS: 1000, deregister: true });
  await pool.end();
}
