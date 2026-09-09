// Actual DBOS client and CR SQL adapter; disposable socket only, no worker.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPostgresClient } from '../../src/persistence/database.ts';
const [root, socket] = process.argv.slice(2);
assert.match(root, /^\/private\/tmp\/cr-compare-f1\.[A-Za-z0-9]+$/);
assert.match(socket, new RegExp(`^${root.replaceAll('.', '\\.')}/pg-run-[A-Za-z0-9]+/socket$`));
const pkg = join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json');
assert.equal(JSON.parse(await readFile(pkg, 'utf8')).version, '4.27.6');
const require = createRequire(pkg), { DBOSClient } = require('./dist/src/client.js');
const { ensureSystemDatabase } = require('./dist/src/system_database.js');
const { Pool } = require('pg');
Object.assign(process.env, { PGHOST: socket, PGPORT: '65433', PGUSER: 'f1_owner', PGDATABASE: 'postgres', PGPASSWORD: '' });
const pool = new Pool({ host: socket, port: 65433, user: 'f1_owner', database: 'postgres', password: '', max: 2,
  connectionTimeoutMillis: 3000, statement_timeout: 5000 });
let local = createPostgresClient(''), candidate;
const logger = { info() {}, warn() {}, error() {}, debug() {} }, outcomes = [];
const options = { systemDatabasePool: pool, systemDatabaseSchemaName: 'comparison_dbos', logger };
let dispatches = 0;
const enqueue = (id, value) => local.client.transaction(async tx => {
  dispatches++;
  return candidate.enqueueInTransaction({ query: async (sql, params) => {
    const result = await tx.query(sql, params); return { ...result, rowCount: result.rows.length };
  } }, { queueName: 'comparison', workflowName: 'synthetic-never-executed', workflowID: id }, { value });
});
try {
  await ensureSystemDatabase('', logger, pool, 'comparison_dbos', false);
  candidate = await DBOSClient.create(options);
  await candidate.registerQueue('comparison', { concurrency: 1 });
  const competing = await Promise.all([enqueue('same-id', 'left'), enqueue('same-id', 'right')]);
  assert.deepEqual(competing.map(x => x.getWorkflowUUID()), ['same-id', 'same-id']);
  assert.equal((await pool.query('SELECT workflow_uuid FROM comparison_dbos.workflow_status WHERE workflow_uuid=$1', ['same-id'])).rowCount, 1);
  const original = await candidate.retrieveWorkflow('same-id').getWorkflowInputs();
  assert.ok(['left', 'right'].includes(original[0].value));
  outcomes.push({ name: 'concurrent-client-same-id', rows: 1, retainedInput: original, returnedHandles: 2,
    limit: 'parallel client submissions, not guaranteed overlapping engine critical sections; no canonical admission' });
  await Promise.all([enqueue('independent-a', 'A'), enqueue('independent-b', 'B')]);
  assert.equal((await pool.query("SELECT workflow_uuid FROM comparison_dbos.workflow_status WHERE workflow_uuid IN ('independent-a','independent-b')")).rowCount, 2);
  outcomes.push({ name: 'independent-submissions', rows: 2, limit: 'enqueue only, no pickup or review wait' });
  await assert.rejects((async () => { await enqueue('lost-ack', 'original'); throw new Error('synthetic-caller-ack-loss'); })(), /synthetic-caller-ack-loss/);
  const before = dispatches;
  const recovered = await candidate.retrieveWorkflow('lost-ack').getWorkflowInputs();
  assert.deepEqual(recovered, [{ value: 'original' }]); assert.equal(dispatches, before);
  outcomes.push({ name: 'lost-caller-ack-read-recovery', dispatchesBefore: before, dispatchesAfter: dispatches,
    limit: 'injected after known transaction commit, not network loss during server commit' });
  await candidate.destroy(); candidate = undefined;
  await local.close(); local = createPostgresClient('');
  candidate = await DBOSClient.create(options);
  assert.deepEqual(await candidate.retrieveWorkflow('lost-ack').getWorkflowInputs(), recovered);
  assert.equal(dispatches, before);
  outcomes.push({ name: 'client-reconstruction', preservedInputs: true, newSubmissions: 0,
    limit: 'client objects recreated, not engine/process crash or worker execution recovery' });
  console.log(JSON.stringify({ candidate: 'DBOS4.27.6', backend: 'PostgreSQL18.4', outcomes, dispatches, scope: 'synthetic queue/client only' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: error.code, message: error.message, outcomes })); process.exitCode = 1;
} finally { await candidate?.destroy(); await local.close(); await pool.end(); }
