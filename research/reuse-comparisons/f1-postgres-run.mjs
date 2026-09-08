// Explicit local-only disposable PostgreSQL fixture. Never targets an existing DB.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
const exec = promisify(execFile);
const root = process.argv[2];
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
  const readiness = await command('psql', ['-h', socket, '-p', '65433', '-U', 'f1_owner', '-d', 'postgres', '-At', '-c', 'show listen_addresses']);
  assert.equal(readiness.stdout.trim(), '', 'TCP listeners must be disabled');
  const result = await exec(process.execPath, ['--import', 'tsx', 'research/reuse-comparisons/f1-dbos-fit.mjs', root, socket], { env, timeout: 60000, maxBuffer: 262144 });
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
