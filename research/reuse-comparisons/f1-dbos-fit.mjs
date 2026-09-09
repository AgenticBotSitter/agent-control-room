// Opt-in research: actual pinned DBOS SQL/client on one disposable PGlite database.
// No worker, native agent, provider, network connection or application registration.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { adaptPglite, createPostgresClient } from '../../src/persistence/database.ts';

const root = process.argv[2];
assert.match(root ?? '', /^\/private\/tmp\/cr-compare-f1\.[A-Za-z0-9]+$/);
const packageRoot = join(root, 'node_modules/@dbos-inc/dbos-sdk');
assert.equal(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version, '4.27.6');
const requireCandidate = createRequire(join(packageRoot, 'package.json'));
const { DBOSClient } = requireCandidate('./dist/src/client.js');
const { ensureSystemDatabase } = requireCandidate('./dist/src/system_database.js');
const socket = process.argv[3];
if (socket) assert.match(socket, new RegExp(`^${root.replaceAll('.', '\\.')}/pg-run-[A-Za-z0-9]+/socket$`));
const pg = socket ? requireCandidate('pg') : null;
const nativePool = socket ? new pg.Pool({ host: socket, port: 65433, database: 'postgres', user: 'f1_owner', password: '', max: 2, connectionTimeoutMillis: 3000, statement_timeout: 5000 }) : null;
// postgres.js does not interpret libpq's ?host= URL query as a socket address.
// Capture the exact owned socket via its supported PG environment in this sterile
// fixture process; no application API or driver behavior is changed.
if (socket) Object.assign(process.env, { PGHOST: socket, PGPORT: '65433', PGUSER: 'f1_owner', PGDATABASE: 'postgres', PGPASSWORD: '' });
const local = socket ? createPostgresClient('') : null;
const db = socket ? { query: (...args) => nativePool.query(...args), exec: sql => nativePool.query(sql), close: async () => { await local.close(); await nativePool.end(); } } : new PGlite({ extensions: { uuid_ossp } });
const database = local?.client ?? adaptPglite(db);
const outcomes = [];
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const pgResult = r => ({ ...r, rowCount: r.affectedRows ?? r.rows.length });
const pool = {
  async query(sql, params) { return pgResult(await db.query(sql, params)); },
  async connect() { return { query: this.query.bind(this), on() {}, removeListener() {}, release() {} }; },
  on() {}, removeListener() {},
};
let candidate;
const deadline = setTimeout(() => { console.error('F1 DBOS deadline exceeded'); process.exit(2); }, 45000);
try {
  await ensureSystemDatabase('', logger, nativePool ?? pool, 'comparison_dbos', false);
  outcomes.push('actual DBOS schema migration on disposable database');
  candidate = await DBOSClient.create({ systemDatabasePool: nativePool ?? pool, systemDatabaseSchemaName: 'comparison_dbos', logger });
  await candidate.registerQueue('comparison', { concurrency: 1 });
  await db.exec('CREATE TABLE comparison_marker (id text primary key)');
  const enqueue = async (session, id, value = 'original') => candidate.enqueueInTransaction({
    query: async (sql, params) => pgResult(await session.query(sql, params)),
  }, { queueName: 'comparison', workflowName: 'synthetic-never-executed', workflowID: id }, { value });
  await database.transactionWithPreCommitCheck(async session => {
    await session.query('INSERT INTO comparison_marker VALUES ($1)', ['committed']);
    await enqueue(session, 'committed');
  }, () => {});
  assert.equal((await db.query('SELECT * FROM comparison_dbos.workflow_status WHERE workflow_uuid=$1', ['committed'])).rows.length, 1);
  outcomes.push('current Control Room DatabaseSession seam commits marker and actual candidate enqueue');
  await assert.rejects(database.transactionWithPreCommitCheck(async session => {
    await session.query('INSERT INTO comparison_marker VALUES ($1)', ['revoked']);
    await enqueue(session, 'revoked');
  }, () => { throw new Error('synthetic-revoked'); }), /synthetic-revoked/);
  assert.equal((await db.query('SELECT * FROM comparison_marker WHERE id=$1', ['revoked'])).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM comparison_dbos.workflow_status WHERE workflow_uuid=$1', ['revoked'])).rows.length, 0);
  outcomes.push('current precommit rejection rolls back marker and candidate enqueue');
  const before = (await db.query('SELECT inputs FROM comparison_dbos.workflow_status WHERE workflow_uuid=$1', ['committed'])).rows;
  await database.transaction(session => enqueue(session, 'committed', 'changed'));
  const after = (await db.query('SELECT inputs FROM comparison_dbos.workflow_status WHERE workflow_uuid=$1', ['committed'])).rows;
  assert.deepEqual(after, before);
  outcomes.push('same workflow ID retains original inputs after changed-payload replay');
  await assert.rejects(candidate.enqueueInTransaction(pool, { queueName: 'comparison', workflowName: 'synthetic', workflowID: 'unsupported', duplicationPolicy: 'return-existing' }), /not supported/);
  outcomes.push('unsupported return-existing policy refuses in caller-owned transaction');
  console.log(JSON.stringify({ candidate: 'DBOS 4.27.6', backend: socket ? 'PostgreSQL18.4' : 'PGlite', outcomes, scope: 'no worker, no concurrent pickup or native agent execution' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ candidate: 'DBOS 4.27.6', outcomes, failed: { code: error.code, message: error.message } }));
  process.exitCode = 1;
} finally {
  await candidate?.destroy();
  await db.close();
  clearTimeout(deadline);
}
