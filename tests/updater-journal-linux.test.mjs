import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess, { spawn } from 'node:child_process';
import { kernelFileLockPlatformV1 } from '../src/installer/shared/private-process-lock.mjs';
import { FileStepJournalV1 as Journal } from '../src/updater/v1/journal.mjs';

test('journal lock platform: macOS keeps O_EXLOCK; Linux delegates only the inherited descriptor to flock', () => {
  const mac = kernelFileLockPlatformV1('darwin', { run: () => { throw new Error('must not fork'); } });
  assert.equal(mac.openFlags, 0x20); assert.equal(mac.tryLock(5), true);
  let called = false;
  const linux = kernelFileLockPlatformV1('linux', { run: (binary, args, options) => {
    called = true; assert.equal(binary, '/usr/bin/flock');
    assert.deepEqual(args, ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3']);
    assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 7]);
    assert.equal(options.shell, undefined); assert.equal(options.detached, true);
    assert.equal(options.timeout, 5000); assert.equal(options.killSignal, 'SIGKILL'); assert.deepEqual(options.env, {});
    return { status: 0 };
  } });
  assert.equal(linux.openFlags, 0); assert.equal(linux.tryLock(7), true); assert.equal(called, true);
  assert.throws(() => kernelFileLockPlatformV1('win32'), /kernel_file_lock_unsupported/);
});

test('journal lock platform: conflict retries; missing, killed, timed-out or failed helper never grants authority', () => {
  assert.equal(kernelFileLockPlatformV1('linux', { run: () => ({ status: 75 }) }).tryLock(3), false);
  for (const result of [{ status: 1 }, { status: null, signal: 'SIGKILL' }, { status: 0, error: { code: 'ETIMEDOUT' } },
    { status: null, error: { code: 'ENOENT' } }, { status: 75, signal: 'SIGTERM' }])
    assert.throws(() => kernelFileLockPlatformV1('linux', { run: () => result }).tryLock(3), /kernel_file_lock_unsupported/);
});

const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;

test('journal on the Linux branch: no open-time lock, flock gets the opened lock descriptor, conflicts retry, a broken helper refuses', async t => {
  // Runs anywhere: the platform is reported as Linux and the util-linux helper is
  // faked, so this proves the journal's use of the platform contract, not flock(2).
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform'), realSpawn = childProcess.spawnSync;
  let script = [], calls = [];
  childProcess.spawnSync = (binary, args, options) => {
    const fd = options.stdio[3], lock = join(root, 'updater-state/journal.lock');
    calls.push({ binary, args, sameInode: sameInode(fstatSync(fd), lstatSync(lock)) });
    if (process.platform !== 'darwin' && realPlatform.value === 'darwin') {
      // Nothing was locked by the open: a macOS O_EXLOCK probe still succeeds.
      closeSync(openSync(lock, constants.O_RDWR | constants.O_NONBLOCK | 0x20));
    }
    return script.length ? script.shift() : { status: 0 };
  };
  syncBuiltinESMExports(); Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' });
  const root = await fixture(t);
  try {
    script = [{ status: 75 }, { status: 75 }];
    const journal = new Journal(root, { ownerUid: process.getuid() }); await journal.intent({ runId: 'linux', ordinal: 1 });
    assert.equal(calls.length, 3); assert.ok(calls.every(call => call.binary === '/usr/bin/flock' && call.sameInode));
    for (const failure of [{ status: 1 }, { status: null, signal: 'SIGKILL' }, { status: null, error: { code: 'ENOENT' } }]) {
      script = [failure];
      await assert.rejects(journal.intent({ runId: 'linux', ordinal: 2 }), { code: 'updater_journal_lock_unsupported' });
    }
    await journal.intent({ runId: 'linux', ordinal: 2 });
    assert.equal((await journal.validate()).entries.length, 2);
  } finally {
    Object.defineProperty(process, 'platform', realPlatform); childProcess.spawnSync = realSpawn; syncBuiltinESMExports();
  }
});

const linuxOnly = { skip: process.platform === 'linux' ? false : 'requires Linux flock(2) and /usr/bin/flock; macOS exercises the platform unit tests' };
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'journal-linux-')));
  await fs.mkdir(join(root, 'updater-state'), { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
function launch(args) {
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => stderr += bytes);
  const closed = new Promise((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done({ code, signal, stderr })); });
  return { child, closed, stop: async () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await closed; } };
}
const modulePath = resolve('src/updater/v1/journal.mjs');

test('Linux journal: helper exit retains kernel exclusion; SIGKILL releases it and an empty leftover cannot strand a reused PID', linuxOnly, async t => {
  const root = await fixture(t), lock = join(root, 'updater-state/journal.lock');
  await new Journal(root, { ownerUid: process.getuid() }).intent({ runId: 'seed', ordinal: 1 });
  const holder = launch(['--input-type=module', '-e', `
    const {FileStepJournalV1}=await import(${JSON.stringify(modulePath)});
    await new FileStepJournalV1(process.argv[1],{ownerUid:process.getuid(),checkpoint:async point=>{
      if(point==='append_before_write'){process.stdout.write('held\\n');setInterval(()=>{},1000);await new Promise(()=>{});}
    }}).intent({runId:'killed',ordinal:1});`, root]);
  let timer;
  try {
    await new Promise((done, fail) => { timer = setTimeout(() => fail(new Error('holder not ready')), 10000);
      holder.child.once('error', fail); holder.child.stdout.once('data', done); });
    const probe = await fs.open(lock, constants.O_RDWR | constants.O_NOFOLLOW);
    try { assert.equal(kernelFileLockPlatformV1().tryLock(probe.fd), false, 'helper already exited; parent still holds its open description'); }
    finally { await probe.close(); }
    await assert.rejects(new Journal(root, { ownerUid: process.getuid() }).intent({ runId: 'contender', ordinal: 1 }), { code: 'updater_journal_busy' });
    await holder.stop(); assert.equal((await holder.closed).signal, 'SIGKILL');
    assert.equal(await fs.readFile(lock, 'utf8'), '', 'no PID-only content survives the holder');
    const retry = new Journal(root, { ownerUid: process.getuid() }); await retry.intent({ runId: 'retry', ordinal: 1 });
    assert.equal((await retry.validate()).entries.length, 2);
  } finally { clearTimeout(timer); await holder.stop(); }
});

test('Linux journal: a replaced lock is refused and its replacement is preserved', linuxOnly, async t => {
  const root = await fixture(t), path = join(root, 'updater-state/journal.lock');
  const journal = new Journal(root, { ownerUid: process.getuid(), checkpoint: async point => {
    if (point === 'append_before_open') { await fs.rename(path, path + '.owned'); await fs.writeFile(path, 'replacement', { mode: 0o600 }); }
  } });
  await assert.rejects(journal.intent({ runId: 'replacement', ordinal: 1 }), { code: 'updater_journal_owner_refused' });
  assert.equal(await fs.readFile(path, 'utf8'), 'replacement');
});

test('Linux journal: 20 processes and 200 appends retain one complete MAC chain', linuxOnly, async t => {
  const root = await fixture(t), children = [];
  try {
    for (let n = 0; n < 20; n++) children.push(launch(['--input-type=module', '-e', `
      const {FileStepJournalV1}=await import(${JSON.stringify(modulePath)});
      const journal=new FileStepJournalV1(process.argv[1],{ownerUid:process.getuid()});
      for(let n=1;n<=10;n++)await journal.intent({runId:process.argv[2],ordinal:n});`, root, `writer-${n}`]));
    for (const result of await Promise.all(children.map(child => child.closed))) assert.equal(result.code, 0, result.stderr);
    const entries = (await new Journal(root, { ownerUid: process.getuid() }).validate()).entries;
    assert.equal(entries.length, 200); assert.equal(new Set(entries.map(entry => `${entry.runId}:${entry.ordinal}`)).size, 200);
  } finally { await Promise.all(children.map(child => child.stop())); }
});
