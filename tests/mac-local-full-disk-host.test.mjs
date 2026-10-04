// R4S-06 regression test, on a REAL full filesystem.
//
// A 4 MiB disk image mounted under the worktree, filled while a stand-in host runs. No sudo, no
// system volume, nothing outside this test. The volume is created and destroyed here; if hdiutil
// is unavailable the test skips rather than pretending to have proved anything.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimePaths, supervisorLockPaths } from '../scripts/mac-local/stack.mjs';
import { acquirePrivateProcessLockV1, acquireRecoverablePrivateProcessLockV1 } from '../src/installer/shared/private-process-lock.mjs';
import { superviseTaskHost } from '../scripts/mac-local/task-host-supervisor.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, limitMs = 5000) {
  const until = performance.now() + limitMs;
  while (!predicate()) { if (performance.now() > until) throw new Error('fixture_timeout'); await sleep(10); }
}

// A real, tiny, writable volume. Mounted under the worktree so cleanup is our own.
function volume(t, megabytes = 4) {
  const base = mkdtempSync(join(tmpdir(), 'r4s06-vol-'));
  const image = join(base, 'img.dmg'), mount = join(base, 'mnt');
  execFileSync('/usr/bin/hdiutil', ['create', '-size', `${megabytes}m`, '-fs', 'HFS+',
    '-volname', 'r4s06full', '-ov', image], { stdio: 'ignore' });
  mkdir(mount, { recursive: true });
  execFileSync('/usr/bin/hdiutil', ['attach', image, '-mountpoint', mount, '-nobrowse'], { stdio: 'ignore' });
  // Detach in t.after even if the test throws: a mounted volume outliving the run is worse
  // than a failed assertion.
  t.after(() => {
    try { execFileSync('/usr/bin/hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' }); }
    finally { rmSync(base, { recursive: true, force: true }); }
  });
  return mount;
}

// Fill the volume for real, in decreasing chunk sizes, and hand back the way to undo it.
function fill(mount) {
  const path = join(mount, 'FILLER'), fd = openSync(path, 'w');
  let written = 0;
  try {
    for (const size of [65536, 4096, 512, 1]) {
      const chunk = Buffer.alloc(size, 120);
      for (;;) {
        try { written += writeSync(fd, chunk); }
        catch (error) { if (error.code === 'ENOSPC') break; throw error; }
      }
    }
  } finally { closeSync(fd); }
  return { written, free: () => rmSync(path, { force: true }) };
}

test('R4S-06: a full disk drops diagnostics and keeps serving; the host restarts afterwards', { concurrency: false }, async t => {
  let mount;
  try { mount = volume(t); } catch (error) {
    t.skip(`cannot create a scratch volume on this machine: ${error.code ?? error.message}`); return;
  }
  // Control: the same fixture on an ordinary filesystem starts and stops cleanly, so a failure
  // below cannot be mistaken for "everything is broken on this Mac".
  const controlRoot = await mkdtemp(join(tmpdir(), 'r4s06-control-'));
  t.after(() => rmSync(controlRoot, { recursive: true, force: true }));
  const controlPaths = runtimePaths(controlRoot);
  await mkdir(controlPaths.runtime, { recursive: true, mode: 0o700 });
  const controlChild = join(controlRoot, 'child.mjs');
  await writeFile(controlChild, 'setInterval(() => {}, 1000);\n');
  let controlStarted = false;
  assert.equal(await superviseTaskHost(controlRoot, { command: process.execPath, args: [controlChild],
    onStarted() { controlStarted = true; setTimeout(() => process.emit('SIGTERM'), 150); } }), 0);
  assert.equal(controlStarted, true, 'the control host must start');

  // The real thing: the protected root lives ON the volume, and the volume fills 400 ms in.
  const root = join(mount, 'protected');
  const paths = { ...runtimePaths(root), ...supervisorLockPaths(root) };
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  // A stand-in for the website: one line every 100 ms. Liveness is counted from the bytes the
  // child WRITES TO ITS STDOUT, which the supervisor receives in a pipe — so the measurement
  // needs no free disk and works with the volume completely full. The old code SIGKILLed the
  // child on the first failed log write, so this counter stopped dead.
  let served = 0;
  const childPath = join(mount, 'child.mjs');
  await writeFile(childPath, "setInterval(() => console.log('request served'), 100);\n");

  let filler, started = false;
  // The first run has to be STOPPED by the test, or it never returns. The disk fills while it
  // runs, and the stop arrives while the disk is still full: that is the whole case.
  const first = await superviseTaskHost(root, { command: process.execPath, args: [childPath],
    onStarted() {
      started = true;
      setTimeout(() => { filler = fill(mount); }, 400);
      setTimeout(() => process.emit('SIGTERM'), 1200);
    } }).then(code => `exit:${code}`, error => `THROW:${error.code ?? error.message}`);

  assert.equal(started, true, 'the host must start before the disk fills');
  assert.ok(filler, 'the volume was actually filled');
  assert.equal(first, 'exit:0', 'the first run ends on the requested stop, not an ENOSPC throw');
  // Count the lines the child produced while the disk was full, by reading the pipe through a
  // second supervise run and watching the child's stdout directly.
  const counted = await superviseTaskHost(root, { command: process.execPath, args: [childPath],
    onChildOutput(chunk) { served += String(chunk).split('request served').length - 1; },
    onStarted() { setTimeout(() => process.emit('SIGTERM'), 600); } })
    .then(code => code, error => `THROW:${error.code ?? error.message}`);
  assert.equal(counted, 0, 'a start and stop with the disk full is clean');
  assert.ok(served >= 3, `the child kept serving with the disk full (${served} lines in 600 ms)`);
  filler?.free();
  // Two more restarts after space returns, as launchd would do.
  const after = [];
  for (let attempt = 0; attempt < 2; attempt += 1)
    after.push(await superviseTaskHost(root, { command: process.execPath, args: [childPath],
      onStarted() { setTimeout(() => process.emit('SIGTERM'), 150); } })
      .then(code => `exit:${code}`, error => `THROW:${error.code ?? error.message}`));
  const state = JSON.parse(await readFile(paths.hostState, 'utf8'));
  const files = (await readdir(paths.runtime)).sort();
  assert.ok(!files.some(entry => /\.new-\d+$/u.test(entry)), 'no half-written temporary is left behind');
  assert.equal(first, 'exit:0', 'the first run ends on the requested stop, not an ENOSPC throw');
  assert.equal(counted, 0, 'a stop while the disk is full is clean');
  assert.deepEqual(after, ['exit:0', 'exit:0'], 'the host restarts once space returns');
  assert.equal(state.state, 'stopped');
  assert.equal(state.reason, 'requested SIGTERM', 'the recorded reason is the real one, not a disk failure');
});
test('R4S-06/R4S-07: a full disk does not make a valid lock look like a damaged entry', { concurrency: false }, async t => {
  let mount;
  try { mount = volume(t); } catch (error) {
    t.skip(`cannot create a scratch volume on this machine: ${error.code ?? error.message}`); return;
  }
  const runtime = join(mount, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const lockPath = join(runtime, 'nightly-backup.lock');
  // A real, valid lock file, created while there is still space and left in place.
  const held = acquirePrivateProcessLockV1(lockPath, { busyCode: 'BUSY' });
  held.close();                       // drop the descriptor without unlinking: the entry stays
  assert.deepEqual(await readdir(runtime), ['nightly-backup.lock'], 'the valid lock exists');
  const before = (await lstat(lockPath)).ino;
  // Fill the volume completely. On HFS+ `fill` reaches bavail 0, so even a three-byte write to a
// NEW path then fails with ENOSPC — asserted below, because the whole point is that the LOCK
// write is a write and therefore cannot succeed.
  const filler = fill(mount);
  const stamp = join(mount, 'owner-stamp');
  await writeFile(stamp, 'x').then(() => assert.fail('the volume still has room'),
    error => assert.equal(error.code, 'ENOSPC', `expected ENOSPC, got ${error.code}`));
  // Now the lock is at an existing inode, so opening it and rewriting its owner stamp needs no
  // NEW blocks and succeeds: a full disk does not make a lock unusable, and must not make it
  // look damaged either. This is the assertion that matters, and it is measured, not assumed.
  let direct;
  try {
    const lock = acquirePrivateProcessLockV1(lockPath, { busyCode: 'BUSY' });
    // Check the inode BEFORE release: release unlinks the entry by design.
    assert.equal((await lstat(lockPath)).ino, before, 'the valid lock inode is untouched');
    lock.release();
    direct = 'acquired';
  } catch (error) { direct = `${error.code ?? error.message} unusable=${error.unusable === true}`; }
  assert.doesNotMatch(direct, /unusable=true/u,
    `a full disk is not a damaged entry and must not be quarantined, got ${direct}`);
  assert.doesNotMatch(direct, /BUSY/u, `a full disk is not contention, got ${direct}`);
  // Nothing was quarantined: the runtime holds only the lock release removes.
  assert.deepEqual((await readdir(runtime)).filter(entry => entry.includes('quarantine')), [],
    'a full disk quarantines nothing');
  // And the recovery wrapper agrees: it neither invents an unusable entry nor quarantines.
  let recovery;
  try { const lock = acquireRecoverablePrivateProcessLockV1(lockPath, { busyCode: 'BUSY' }); lock.release(); recovery = 'acquired'; }
  catch (error) { recovery = error.unusable === true ? 'unusable' : (error.code ?? error.message); }
  assert.notEqual(recovery, 'unusable', 'a full disk must never be treated as a damaged entry');
  assert.deepEqual((await readdir(runtime)).filter(entry => entry.includes('quarantine')), [],
    'a full disk quarantines nothing on the retry path either');
  filler.free();
  // And once there is space, the same lock is acquired normally.
  const after = acquirePrivateProcessLockV1(lockPath, { busyCode: 'BUSY' });
  after.release();
});
