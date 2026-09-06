// Opt-in, owner-authorized E02 only. No application/runtime wiring or auto-install.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, mkdir, stat, access } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const root = process.env.CR_REUSE_PG_ROOT;
const candidateRoot = process.env.CR_REUSE_EVAL_ROOT;
assert.ok(root && /^\/private\/tmp\/cr-e02\.[A-Za-z0-9]+$/.test(root));
assert.ok(candidateRoot && isAbsolute(candidateRoot));
assert.equal(process.env.CR_REUSE_PG_AUTHORIZED, 'E02-one-disposable-cluster');
assert.equal((await stat(root)).mode & 0o077, 0, 'Evaluation root must be owner-only');
const binaryPackage = join(root, 'node_modules/@embedded-postgres/darwin-arm64');
assert.equal(JSON.parse(await readFile(join(binaryPackage, 'package.json'), 'utf8')).version, '18.4.0-beta.17');
assert.equal(JSON.parse(await readFile(join(candidateRoot, 'node_modules/pg-boss/package.json'), 'utf8')).version, '12.30.0');
const { PgBoss } = await import(pathToFileURL(join(candidateRoot, 'node_modules/pg-boss/dist/index.js')).href);
const { default: pg } = await import(pathToFileURL(join(candidateRoot, 'node_modules/pg/lib/index.js')).href);
// Never inherit a real database destination, password, options, service or passfile.
for (const key of Object.keys(process.env)) if (key.startsWith('PG')) delete process.env[key];
const bin = join(binaryPackage, 'native/bin');
const data = join(root, 'data');
const socket = join(root, 'socket');
const environment = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TMPDIR: root };
const command = (name, args) => exec(join(bin, name), args, { env: environment, timeout: 15000, maxBuffer: 1024 * 1024 });
const clients = new Set();
const engines = new Set();
const errors = [];
const outcomes = [];
let started = false;
let deadline;
let firstStart;
let stopping;
const followupMode = process.env.CR_REUSE_PG_FOLLOWUP;
const followup = ['roles-only', 'domain-recovery'].includes(followupMode);
assert.ok(!followupMode || followup, 'Unknown followup scope');
if (followup) {
  // Same cluster and original authorization window, never a fresh 20-minute budget.
  firstStart = Date.parse(process.env.CR_REUSE_PG_FIRST_START ?? '');
  assert.ok(Number.isFinite(firstStart) && firstStart <= Date.now());
  assert.ok(Date.now() - firstStart < 18 * 60 * 1000);
}

async function connect(user = 'e02_owner') {
  const client = new pg.Client({ host: socket, port: 65432, user, password: '', database: 'postgres',
    application_name: 'control_room_disposable_e02', connectionTimeoutMillis: 5000, query_timeout: 10000 });
  client.on('error', error => errors.push(error.code ?? 'client-error'));
  clients.add(client);
  await client.connect();
  await client.query("SET statement_timeout='8s'");
  return client;
}
const adapter = client => ({ async executeSql(sql, values) {
  const result = await client.query(sql, values);
  return Array.isArray(result) ? result.at(-1) : result;
} });
async function engine(client, migrate = false) {
  const boss = new PgBoss({ db: adapter(client), schema: 'reuse_e02', migrate, schedule: false, supervise: false });
  boss.on('error', error => errors.push(error.code ?? error.message));
  engines.add(boss);
  await boss.start();
  return boss;
}
async function closeClients() {
  for (const boss of engines) await boss.stop({ graceful: false });
  engines.clear();
  for (const client of clients) await client.end();
  clients.clear();
}
async function stopServer() {
  if (!started) return;
  if (stopping) return stopping;
  stopping = command('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '10', 'stop']);
  try { await stopping; started = false; } finally { stopping = undefined; }
}
async function startServer() {
  if (!firstStart) {
    firstStart = Date.now();
  }
  if (!deadline) {
    // Independent of test progression, stop the exact owned cluster before 20 minutes.
    deadline = setTimeout(() => {
      process.exitCode = 1;
      void stopServer().catch(() => { process.exitCode = 1; });
    }, Math.max(1, 19 * 60 * 1000 - (Date.now() - firstStart)));
  }
  assert.ok(Date.now() - firstStart < 18 * 60 * 1000, 'No restart near deadline');
  started = true; // Ensure finally also checks a partially failed start.
  await command('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '10', '-o',
    `-k ${socket} -p 65432 -h '' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB -c bonjour=off`, 'start']);
}
async function check(name, work) {
  try { await work(); outcomes.push({ name, status: 'pass' }); console.log('PASS', name); }
  catch (error) { outcomes.push({ name, status: 'fail', reason: error.code ?? error.message }); console.log('FAIL', name, error.code ?? error.message); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  process.exitCode = 1;
  void stopServer().finally(() => process.exit(1));
});

try {
  // Refuse reuse of an existing cluster: this invocation is a single approved evaluation.
  if (followup) await access(join(data, 'PG_VERSION'));
  else {
    await assert.rejects(access(data), { code: 'ENOENT' });
    await mkdir(socket, { mode: 0o700 });
    await command('initdb', ['-D', data, '-U', 'e02_owner', '--auth-local=trust', '--auth-host=reject', '--locale=C', '--encoding=UTF8', '--no-instructions']);
  }
  await startServer();
  let owner = await connect();
  const settings = await owner.query("SELECT current_setting('server_version') AS version, current_setting('listen_addresses') AS ip, current_setting('unix_socket_directories') AS socket, current_setting('unix_socket_permissions') AS permissions");
  assert.match(settings.rows[0].version, /^18\.4/);
  assert.equal(settings.rows[0].ip, '');
  assert.equal(settings.rows[0].socket, socket);
  assert.equal(settings.rows[0].permissions, '0700');
  const pid = (await readFile(join(data, 'postmaster.pid'), 'utf8')).split('\n')[0];
  try {
    const result = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN'], { timeout: 5000 });
    assert.equal(result.stdout.trim(), '', 'Unexpected TCP listener');
  } catch (error) { if (error.code !== 1 || error.stdout?.trim() || error.stderr?.trim()) throw error; }
  console.log('SERVER_READY PostgreSQL 18.4; Unix socket only; owner-only; no TCP listener');
  let boss = await engine(owner, !followup);
  if (followupMode === 'domain-recovery') {
    await check('actual Control Room reservation store serializes capacity and releases it', async () => {
      const { ResourceReservationStore } = await import('../../src/scheduler/v1/reservation-store.ts');
      await owner.query("INSERT INTO tenants(id,display_name) VALUES('tenant:e02','Synthetic E02')");
      const transaction = async (work, beforeCommit = () => {}) => {
        const client = await connect();
        await client.query('BEGIN');
        try {
          const value = await work({ query: (sql, values) => client.query(sql, values) });
          beforeCommit(); await client.query('COMMIT'); return value;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      };
      const database = { query: (sql, values) => owner.query(sql, values), transaction, transactionWithPreCommitCheck: transaction };
      const store = new ResourceReservationStore(database);
      const at = '2026-09-06T00:00:00.000Z';
      const request = { id: 'reservation:e02a', tenantId: 'tenant:e02', projectId: 'project:e02',
        workItemId: 'work:e02', routeId: 'route:e02', resourceKey: 'resource:e02', units: 1,
        capacityUnits: 1, decisionDigest: `sha256:${'a'.repeat(64)}`, acquiredAt: at, expiresAt: '2026-09-06T00:05:00.000Z' };
      const attempts = [request, { ...request, id: 'reservation:e02b', workItemId: 'work:e02b' }];
      const results = await Promise.allSettled(attempts.map(value => store.acquire(value, at)));
      assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
      assert.equal(results.filter(value => value.status === 'rejected' && value.reason.safeCode === 'resource_unavailable').length, 1);
      const winnerIndex = results.findIndex(value => value.status === 'fulfilled');
      const winner = attempts[winnerIndex], loser = attempts[1 - winnerIndex];
      assert.equal((await store.acquire(winner, at)).replayed, true);
      assert.equal((await store.release({ tenantId: winner.tenantId, id: winner.id, releasedAt: '2026-09-06T00:01:00.000Z' })).state, 'released');
      assert.equal((await store.acquire(loser, '2026-09-06T00:01:00.000Z')).replayed, false);
    });
    await check('disconnected worker times out; retry-disabled unknown job is not reissued', async () => {
      await boss.createQueue('orphan', { expireInSeconds: 1, retryLimit: 0 });
      const id = await boss.send('orphan', { synthetic: 'unknown-external-start' });
      const client = await connect(), worker = await engine(client);
      assert.equal((await worker.fetch('orphan'))[0].id, id);
      await worker.stop({ graceful: false }); engines.delete(worker);
      await client.end(); clients.delete(client);
      await new Promise(resolve => setTimeout(resolve, 1200));
      await boss.supervise('orphan', { reindex: false });
      assert.equal((await boss.getJobById('orphan', id)).state, 'failed');
      assert.deepEqual(await boss.fetch('orphan'), []);
    });
  } else if (followup) {
    await check('narrow job_common grants repair roles without owner or schema privileges', async () => {
      const submitClient = await connect('e02_submit'), workerClient = await connect('e02_worker');
      const submit = await engine(submitClient), worker = await engine(workerClient);
      await assert.rejects(submit.send('roles', { synthetic: true }), { code: '42501' });
      await owner.query(`GRANT SELECT,INSERT ON reuse_e02.job_common TO e02_submit;
        GRANT SELECT,UPDATE ON reuse_e02.job_common TO e02_worker`);
      const id = await submit.send('roles', { synthetic: true });
      assert.ok(id);
      await assert.rejects(submit.fetch('roles'), { code: '42501' });
      assert.equal((await worker.fetch('roles'))[0].id, id);
      await worker.complete('roles', id, { synthetic: 'completed' });
      assert.equal((await boss.getJobById('roles', id)).state, 'completed');
      await assert.rejects(worker.send('roles', { synthetic: true }), { code: '42501' });
      for (const client of [submitClient, workerClient]) {
        await assert.rejects(client.query('CREATE TABLE reuse_e02.forbidden(id int)'), { code: '42501' });
        await assert.rejects(client.query('DELETE FROM reuse_e02.job_common'), { code: '42501' });
        await assert.rejects(client.query('ALTER TABLE reuse_e02.job_common ADD COLUMN forbidden int'), { code: '42501' });
      }
      const privateClient = await connect('e02_private');
      await assert.rejects(privateClient.query('SELECT * FROM reuse_e02.job_common'), { code: '42501' });
      await assert.rejects(privateClient.query("INSERT INTO reuse_e02.job_common(name) VALUES('roles')"), { code: '42501' });
    });
  } else {
  await owner.query('CREATE TABLE e02_intent(id uuid PRIMARY KEY, state text NOT NULL); CREATE TABLE e02_audit(id uuid PRIMARY KEY REFERENCES e02_intent(id))');
  await boss.createQueue('transaction');
  await check('real-PG commit, rollback and lost-ack identity', async () => {
    for (const commit of [true, false]) {
      const id = randomUUID();
      const tx = await connect();
      await tx.query('BEGIN');
      try {
        await tx.query("INSERT INTO e02_intent VALUES($1,'approved-marker')", [id]);
        await tx.query('INSERT INTO e02_audit VALUES($1)', [id]);
        assert.equal(await boss.send('transaction', { synthetic: true }, { id, db: adapter(tx) }), id);
        await tx.query(commit ? 'COMMIT' : 'ROLLBACK');
      } catch (error) { await tx.query('ROLLBACK'); throw error; }
      assert.equal((await owner.query('SELECT * FROM e02_intent WHERE id=$1', [id])).rowCount, Number(commit));
      assert.equal((await owner.query('SELECT * FROM e02_audit WHERE id=$1', [id])).rowCount, Number(commit));
      assert.equal(Boolean(await boss.getJobById('transaction', id)), commit);
      if (commit) {
        // Simulated lost acknowledgement: reconcile by ID, then repeat the same submission.
        assert.equal(await boss.send('transaction', { synthetic: true }, { id }), null);
      }
    }
  });
  await check('two independent workers claim 40 jobs without overlap', async () => {
    await boss.createQueue('concurrency');
    const ids = new Set();
    for (let n = 0; n < 40; n++) ids.add(await boss.send('concurrency', { n }));
    const left = await engine(await connect()), right = await engine(await connect());
    const [a, b] = await Promise.all([left.fetch('concurrency', { batchSize: 20 }), right.fetch('concurrency', { batchSize: 20 })]);
    const fetched = [...a, ...b].map(job => job.id);
    assert.equal(a.length, 20); assert.equal(b.length, 20);
    assert.equal(new Set(fetched).size, 40);
    assert.deepEqual(new Set(fetched), ids);
    await left.complete('concurrency', a.map(job => job.id));
    await right.complete('concurrency', b.map(job => job.id));
  });
  await check('held row lock does not block another eligible job', async () => {
    await boss.createQueue('locking');
    const a = await boss.send('locking', { n: 1 }), b = await boss.send('locking', { n: 2 });
    const holding = await connect(), worker = await engine(await connect());
    await holding.query('BEGIN');
    try {
      await holding.query('SELECT id FROM reuse_e02.job WHERE id=$1 FOR UPDATE', [a]);
      const found = await worker.fetch('locking');
      assert.equal(found[0].id, b);
    } finally { await holding.query('ROLLBACK'); }
    assert.equal((await boss.fetch('locking'))[0].id, a);
  });
  await check('restricted submission and worker roles; private role denied', async () => {
    await boss.createQueue('roles');
    await owner.query(`CREATE ROLE e02_submit LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
      CREATE ROLE e02_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
      CREATE ROLE e02_private LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT USAGE ON SCHEMA reuse_e02 TO e02_submit,e02_worker;
      GRANT SELECT ON reuse_e02.version,reuse_e02.queue TO e02_submit,e02_worker;
      GRANT SELECT,INSERT ON reuse_e02.job TO e02_submit;
      GRANT SELECT,UPDATE ON reuse_e02.job TO e02_worker;`);
    const submit = await engine(await connect('e02_submit'));
    const worker = await engine(await connect('e02_worker'));
    const id = await submit.send('roles', { synthetic: true });
    assert.ok(id);
    await assert.rejects(submit.fetch('roles'), { code: '42501' });
    assert.equal((await worker.fetch('roles'))[0].id, id);
    await worker.complete('roles', id, { synthetic: 'finished' });
    assert.equal((await boss.getJobById('roles', id)).state, 'completed');
    await assert.rejects(worker.send('roles', { synthetic: true }), { code: '42501' });
    const privateClient = await connect('e02_private');
    await assert.rejects(privateClient.query('SELECT * FROM reuse_e02.job'), { code: '42501' });
    await assert.rejects(privateClient.query("INSERT INTO reuse_e02.job(name) VALUES('roles')"), { code: '42501' });
    await assert.rejects(privateClient.query('CREATE TABLE reuse_e02.forbidden(id int)'), { code: '42501' });
  });
  await check('bounded retry, failed item, cancel and deferral', async () => {
    await boss.createQueue('retry', { retryLimit: 1, retryDelay: 0 });
    const id = await boss.send('retry', { synthetic: true });
    await boss.fetch('retry'); await boss.fail('retry', id);
    assert.equal((await boss.fetch('retry'))[0].id, id);
    await boss.fail('retry', id);
    assert.equal((await boss.getJobById('retry', id)).state, 'failed');
    const cancel = await boss.send('retry', { synthetic: true });
    await boss.cancel('retry', cancel);
    await boss.send('retry', { synthetic: true }, { startAfter: 3600 });
    assert.deepEqual(await boss.fetch('retry'), []);
  });
  // Retain exact identities across actual server stop/start, not just client recreation.
  await boss.createQueue('restart', { retryLimit: 0 });
  const pending = await boss.send('restart', { synthetic: 'pending' });
  const completed = await boss.send('restart', { synthetic: 'complete' });
  const active = await boss.send('restart', { synthetic: 'unknown-external-start' });
  const all = await boss.fetch('restart', { batchSize: 3 });
  assert.equal(all.length, 3);
  await boss.complete('restart', completed);
  // Put a separate genuinely unclaimed job into the queue.
  const unclaimed = await boss.send('restart', { synthetic: 'unclaimed' });
  await closeClients(); await stopServer(); await startServer();
  owner = await connect(); boss = await engine(owner);
  await check('server restart preserves pending, completed and uncertain-active identities', async () => {
    assert.equal((await boss.getJobById('restart', completed)).state, 'completed');
    assert.equal((await boss.getJobById('restart', active)).state, 'active');
    assert.equal((await boss.getJobById('restart', pending)).state, 'active');
    assert.equal((await boss.fetch('restart'))[0].id, unclaimed);
    assert.deepEqual(await boss.fetch('restart'), []);
  });
  await check('all existing SQL migrations and private-web role script apply on real PG', async () => {
    for (const name of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await owner.query(await readFile(join('db/migrations', name), 'utf8'));
    }
    await owner.query(await readFile('db/roles/private_web_roles.sql', 'utf8'));
    await owner.query('SET ROLE control_room_private_web');
    try { await assert.rejects(owner.query('SELECT * FROM reuse_e02.job'), { code: '42501' }); }
    finally { await owner.query('RESET ROLE'); }
  });
  }
  assert.deepEqual(errors, [], 'No unexpected client/engine errors');
} catch (error) {
  outcomes.push({ name: 'evaluation-lifecycle', status: 'fail', reason: error.code ?? error.message });
  console.log('FAIL evaluation-lifecycle', error.code ?? error.message);
} finally {
  try { await closeClients(); } catch { process.exitCode = 1; }
  try { await stopServer(); } catch (error) { console.log('CLEANUP_UNCERTAIN', error.code ?? error.message); process.exitCode = 1; }
  if (deadline) clearTimeout(deadline);
  try {
    await assert.rejects(access(join(data, 'postmaster.pid')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(socket), []);
    console.log('SHUTDOWN_VERIFIED no postmaster PID file or socket remains');
  } catch { console.log('SHUTDOWN_NOT_VERIFIED retain all state'); process.exitCode = 1; }
  console.log(JSON.stringify({ outcomes, elapsedServerWindowMs: firstStart ? Date.now() - firstStart : 0 }));
  if (outcomes.some(item => item.status === 'fail')) process.exitCode = 1;
}
