// A fresh, read-only client process. No worker registration, enqueue or native code.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PgBoss } from 'pg-boss';
const [root, socket, candidate, id] = process.argv.slice(2);
assert.match(root, /^\/private\/tmp\/cr-compare-f1\.[A-Za-z0-9]+$/);
assert.match(socket, new RegExp(`^${root.replaceAll('.', '\\.')}/pg-run-[A-Za-z0-9]+/socket$`));
assert.ok(['pgboss', 'dbos'].includes(candidate));
assert.match(id, /^(?:[a-f0-9-]{36}|review-phase-[1-9][0-9]*)$/);
const require = createRequire(join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json'));
const { Pool } = require('pg');
const pool = new Pool({ host: socket, port: 65433, user: 'f1_owner', database: 'postgres', password: '',
  max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000,
  options: '-c default_transaction_read_only=on' });
let client;
try {
  assert.equal((await pool.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
  let output;
  if (candidate === 'pgboss') {
    const boss = new PgBoss({ schema: 'comparison_review_queue', db: { executeSql: (sql, values) => pool.query(sql, values) },
      migrate: false, supervise: false, schedule: false, useListenNotify: false });
    const job = await boss.getJobById('review-phase', id);
    assert.equal(job?.state, 'completed'); output = job.output;
  } else {
    const { DBOSClient } = require('./dist/src/client.js');
    client = await DBOSClient.create({ systemDatabasePool: pool, systemDatabaseSchemaName: 'comparison_dbos_review',
      logger: { info() {}, warn() {}, error() {}, debug() {} } });
    output = await client.retrieveWorkflow(id).getResult({ timeoutSeconds: 5, pollingIntervalMs: 50 });
  }
  assert.equal(output.disposition, 'waiting_review');
  console.log(JSON.stringify({ candidate, id, output, readOnly: true }));
} finally { try { await client?.destroy(); } finally { await pool.end(); } }
