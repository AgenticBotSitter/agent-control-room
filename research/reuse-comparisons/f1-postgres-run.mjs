// Explicit local-only disposable PostgreSQL fixture. Never targets an existing DB.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const exec = promisify(execFile);
const root = process.argv[2];
const mode = process.argv[3] ?? 'transaction';
assert.ok(['transaction', 'recovery', 'worker', 'pgboss-worker'].includes(mode));
assert.match(root ?? '', /^\/private\/tmp\/cr-compare-f1\.[A-Za-z0-9]+$/);
assert.equal((await stat(root)).mode & 0o077, 0);
const pkg = join(root, 'node_modules/@embedded-postgres/darwin-arm64');
assert.equal(JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version, '18.4.0-beta.17');
const run = await mkdtemp(join(root, 'pg-run-'));
const data = join(run, 'data');
const socket = join(run, 'socket');
await mkdir(socket, { mode: 0o700 });
const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TMPDIR: run };
const command = (name, args) => exec(join(pkg, 'native/bin', name), args, { env, timeout: 20000, maxBuffer: 262144 });
let attempted = false;
let stopped = false;
try {
  await command('initdb', ['-D', data, '-U', 'f1_owner', '--auth-local=trust', '--auth-host=reject', '--no-locale']);
  attempted = true;
  await command('pg_ctl', ['-D', data, '-l', join(run, 'server.log'), '-w', '-t', '10', '-o', `-k ${socket} -p 65433 -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c bonjour=off`, 'start']);
  // This binary distribution has no psql. Use the already pinned candidate's
  // actual pg client solely for the same read-only socket readiness assertion.
  const requireCandidate = createRequire(join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json'));
  const { Client } = requireCandidate('pg');
  const probe = new Client({ host: socket, port: 65433, user: 'f1_owner', database: 'postgres',
    password: '', connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  try {
    await probe.connect();
    assert.equal((await probe.query('SHOW listen_addresses')).rows[0].listen_addresses, '', 'TCP listeners must be disabled');
  } finally { await probe.end(); }
  const isWorker = mode === 'worker' || mode === 'pgboss-worker';
  const fixture = resolve(`research/reuse-comparisons/${mode === 'pgboss-worker' ? 'f1-pgboss-worker-fit.mjs' : mode === 'worker' ? 'f1-dbos-worker-fit.mjs' : mode === 'recovery' ? 'f1-dbos-recovery-fit.mjs' : 'f1-dbos-fit.mjs'}`);
  const empty = join(run, 'empty');
  if (isWorker) await mkdir(empty, { mode: 0o700 });
  const args = isWorker ? [fixture, root, socket] : ['--import', 'tsx', fixture, root, socket];
  const result = await exec(process.execPath, args, { env, cwd: isWorker ? empty : process.cwd(), timeout: 60000, maxBuffer: 262144 });
  process.stdout.write(result.stdout);
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: error.code, message: String(error.message).slice(0,500), output: String(error.stderr ?? '').slice(-1800) }));
  process.exitCode = 1;
} finally {
  if (attempted) {
    try { await command('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '10', 'stop']); stopped = true; }
    catch { console.error('Owned cluster stop unconfirmed; retaining exact fixture root for inspection'); process.exitCode = 1; }
  }
  if (!attempted || stopped) {
    if (attempted) {
      await assert.rejects(stat(join(data, 'postmaster.pid')), { code: 'ENOENT' });
      await assert.rejects(stat(join(socket, '.s.PGSQL.65433')), { code: 'ENOENT' });
    }
    await rm(run, { recursive: true });
    console.log(JSON.stringify({ cleanup: true, clusterStopped: stopped, scope: 'owned disposable child only' }));
  }
}
