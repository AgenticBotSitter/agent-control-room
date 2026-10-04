import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, open, lstat, readdir } from 'node:fs/promises';
import { constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { RotatingHostLog, superviseTaskHost } from '../scripts/mac-local/task-host-supervisor.mjs';
import { runtimePaths } from '../scripts/mac-local/stack.mjs';
import { runNightlyBackupV1, readNightlyBackupCredentialV1 } from '../src/installer/v1/nightly-backup.ts';
import { createNightlyBackupConfigurationV1 } from '../src/installer/v1/nightly-backup-configuration.ts';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rootFor(t) { const root = await mkdtemp(join(await realpath(tmpdir()), 'hard13-services-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function waitFor(predicate) { const until = performance.now() + 3000; while (!predicate()) { if (performance.now() > until) throw Error('fixture_timeout'); await sleep(5); } }

test('R2S-03: FIFO metadata cannot stall retention or fifty subsequent backup callers', async t => {
  const root = await rootFor(t), cfg = createNightlyBackupConfigurationV1(root), path = join(root, 'Protected/config/backup.json');
  await mkdir(join(root, 'Protected/config/database-passwords'), { recursive: true });
  await mkdir(join(root, 'Protected/runtime-state/nightly-backup'), { recursive: true }); await mkdir(cfg.outputRoot, { recursive: true });
  await writeFile(path, JSON.stringify(cfg)); await writeFile(cfg.database.passwordFile, 'fixture\n', { mode: 0o600 });
  const old = join(cfg.outputRoot, '2026-09-01T02-30-00-000Z'); await mkdir(old); await writeFile(join(old, 'database.dump'), 'dump');
  const fifo = join(old, 'metadata.json'); execFileSync('/usr/bin/mkfifo', [fifo]);
  let settled = false, dumped = false;
  // R4B-01 made the manifest part of what a run produces, so this fixture writes
  // one that binds the dump and metadata it writes. It is deliberately still
  // driven by the same real `backupDatabase` file contract the FIFO above is
  // about: oversized metadata must be read through the descriptor, not by size.
  const identity = 'sha256:' + 'a'.repeat(64);
  const backup = async ({ out }) => {
    const dump = Buffer.from('dump');
    const metadata = JSON.stringify({ version: 1, identity: { identityDigest: identity }, evidence: 'x'.repeat(100_000) });
    await writeFile(join(out, 'database.dump'), dump);
    await writeFile(join(out, 'metadata.json'), metadata);
    await writeFile(join(out, 'manifest.json'), JSON.stringify({
      schema: 'control-room.verified-database-backup/v1',
      dumpDigest: 'sha256:' + createHash('sha256').update(dump).digest('hex'),
      metadataDigest: 'sha256:' + createHash('sha256').update(metadata).digest('hex'),
      restoreIdentityDigest: identity }));
    dumped = true;
    return { planned: false, identityDigest: identity };
  };
  const first = runNightlyBackupV1(path, { backup, now: () => '2026-09-02T02:30:00.000Z' }).finally(() => { settled = true; });
  try {
    await waitFor(() => dumped); await sleep(150); assert.equal(settled, true);
    await first; await assert.rejects(lstat(cfg.lockFile), { code: 'ENOENT' });
    let release; const held = new Promise(r => { release = r; });
    const owner = runNightlyBackupV1(path, { backup: async value => { await held; return backup(value); }, now: () => '2026-09-03T02:30:00.000Z' });
    try { const burst = await Promise.allSettled(Array.from({ length: 50 }, () => runNightlyBackupV1(path, { backup }))); assert.ok(burst.every(v => v.status === 'rejected' && /concurrent_refused/.test(v.reason.message))); }
    finally { release(); await owner; }
    await runNightlyBackupV1(path, { backup, now: () => '2026-09-04T02:30:00.000Z' });
    for (let day = 5; day <= 17; day++) await runNightlyBackupV1(path, { backup, now: () => `2026-09-${String(day).padStart(2, '0')}T02:30:00.000Z` });
    const retained = await readdir(cfg.outputRoot);
    assert.ok(!retained.includes('2026-09-02T02-30-00-000Z'), 'valid metadata larger than 64 KiB still spends completed-day retention');
  } finally {
    if (!settled) { const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK); await writer.writeFile('{}'); await writer.close(); }
    await first;
  }
});

test('R2S-03: metadata and credential reads reject oversized files and nonregular descriptors', async t => {
  const root = await rootFor(t), path = join(root, 'large'); await writeFile(path, 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(readNightlyBackupCredentialV1(path), /nightly_backup_credential_refused/);
  await assert.rejects(readNightlyBackupCredentialV1(root), /nightly_backup_credential_refused/);
});

test('R2S-04: directories in all diagnostic log slots are quarantined without descending', async t => {
  const root = await rootFor(t), path = join(root, 'host.log');
  for (const slot of ['.1', '.2', '.3']) { await mkdir(path + slot); await writeFile(join(path + slot, 'keep'), 'owner data'); }
  const log = await RotatingHostLog.open(path, 32, 3);
  try { await log.write('x'.repeat(160)); }
  finally { await log.close(); }
  const quarantines = (await readdir(root)).filter(v => v.includes('.quarantine-'));
  assert.equal(quarantines.length, 3);
  for (const name of quarantines) assert.equal(await readFile(join(root, name, 'keep'), 'utf8'), 'owner data');
  for (let i = 0; i < 3; i++) { const retry = await RotatingHostLog.open(path, 32, 3); await retry.write('retry'); await retry.close(); }
});

test('R2S-04: real streaming supervisor survives a directory at the five MiB rotation limit', async t => {
  const root = await rootFor(t), paths = runtimePaths(root); await mkdir(paths.runtime, { recursive: true });
  const childPath = join(root, 'diagnostic-child.mjs');
  await writeFile(childPath, "setTimeout(()=>{process.stdout.write('x'.repeat(6*1024*1024),()=>process.exit(0));},100);\n");
  assert.equal(await superviseTaskHost(root, { command: process.execPath, args: [childPath], onStarted() { mkdirSync(paths.hostLog + '.3'); } }), 1);
  assert.equal(JSON.parse(await readFile(paths.hostState, 'utf8')).reason, 'exit code 0');
  for (let i = 0; i < 3; i++) assert.equal(await superviseTaskHost(root, { command: process.execPath, args: [childPath] }), 1);
});

test('R2S-08: repeated real task-host stop signals allow graceful close to finish', async t => {
  const root = await rootFor(t), stamp = join(root, 'closed');
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const source = `import {monitorActiveTaskHost} from ${JSON.stringify(new URL('../scripts/mac-local/start-task-host.mjs', import.meta.url).href)};
      import {writeFile} from 'node:fs/promises'; const keep=setInterval(()=>{},1000);
      monitorActiveTaskHost({isReady:()=>true,close:async()=>{console.log('draining');await new Promise(r=>setTimeout(r,150));await writeFile(process.argv[2],'closed');clearInterval(keep);}});console.log('ready');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, stamp], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => { output += b; });
    const closed = new Promise(r => child.once('close', (code, exitSignal) => r({ code, signal: exitSignal })));
    try { await waitFor(() => output.includes('ready')); child.kill(signal); await waitFor(() => output.includes('draining')); child.kill(signal);
      assert.deepEqual(await closed, { code: 0, signal: null }); assert.equal(await readFile(stamp, 'utf8'), 'closed'); }
    finally { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await closed; await rm(stamp, { force: true }); }
  }
});

// R4S-08: a directory where the supervisor's state or pid file belongs made every start fail
// with EISDIR and killed the child, so launchd could never bring the site back. The same
// tolerance the code already had for an unreadable state file now covers a wrong-shaped one.
test('R4S-08: a directory at the state or pid file cannot stop the host from starting', async t => {
  const childSource = 'setInterval(() => {}, 1000);\n';
  for (const [name, shape] of Object.entries({
    stateDirectory: async (path) => { await mkdir(path); await writeFile(join(path, 'owner-data'), 'keep me'); },
    pidDirectory: async (path) => mkdir(path),
    stateSymlink: async (path) => { const { symlink } = await import('node:fs/promises'); await symlink('/etc/hosts', path); },
    // Control first: an ordinary private root must be untouched, so the cases below cannot pass
    // for the wrong reason (for example because nothing was ever written).
    control: async () => {},
  })) {
    const root = await rootFor(t), paths = runtimePaths(root);
    await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
    const childPath = join(root, 'child.mjs');
    await writeFile(childPath, childSource);
    const target = name.startsWith('pid') ? paths.hostPid : name === 'control' ? undefined : paths.hostState;
    if (target) await shape(target);
    // Three starts in a row, as launchd would retry. All three must serve and stop cleanly.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let started = false;
      const code = await superviseTaskHost(root, { command: process.execPath, args: [childPath],
        onStarted() { started = true; setTimeout(() => process.emit('SIGTERM'), 150); } })
        .then(value => value, error => `THROW:${error.code ?? error.message}`);
      assert.equal(started, true, `${name} attempt ${attempt}: the host must start`);
      assert.equal(code, 0, `${name} attempt ${attempt}: a requested stop exits cleanly`);
    }
    const files = (await readdir(paths.runtime)).sort();
    // The state file is a real private file again, and the recorded stop is truthful.
    const state = JSON.parse(await readFile(paths.hostState, 'utf8'));
    assert.equal(state.state, 'stopped', name);
    assert.equal(state.reason, 'requested SIGTERM', name);
    // A wrong-shaped entry is MOVED aside, never opened: what was inside it is still there.
    const quarantined = files.filter(entry => entry.includes('.quarantine-'));
    assert.equal(quarantined.length, name === 'control' ? 0 : 1, `${name}: one entry moved aside`);
    if (name === 'stateDirectory')
      assert.equal(await readFile(join(paths.runtime, quarantined[0], 'owner-data'), 'utf8'), 'keep me', name);
    // And no half-written temporary is left behind for the next start to trip over, and the pid
    // file is gone again after the clean stop (it exists only while the host is up).
    assert.deepEqual(files.filter(entry => /\.new-\d+$/u.test(entry)), [], `${name}: no temporary left`);
    assert.equal(files.includes('task-host.pid'), false, `${name}: the pid file is cleared on stop`);
  }
});
