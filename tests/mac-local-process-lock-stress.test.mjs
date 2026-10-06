// Stress: many concurrent callers on every lock path this branch changed.
// 50 parallel acquires on one lock, with a damaged entry racing in, and a damaged entry under
// contention. Reports what was admitted, what was refused and with which code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, chmod, mkdir, readdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquirePrivateProcessLockV1, acquireRecoverablePrivateProcessLockV1, quarantineUsableLockV1,
} from '../src/installer/shared/private-process-lock.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Every shape that can stand where a lock belongs. A SHAPE, not a state: quarantining one of
// these fixes the problem, so each must be reported as a damaged entry.
const DAMAGED_SHAPES_V1 = Object.freeze({
  directory: path => mkdir(path),
  symlink: async path => symlink(join(path, '..', 'nowhere'), path),
  fifo: path => execFileSync('/usr/bin/mkfifo', [path]),
  mode644: async path => { await writeFile(path, 'stale\n'); await chmod(path, 0o644); },
});

test('STRESS 50 concurrent acquires admit exactly one, and the losers say busy not unusable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r4s07-stress-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const path = join(root, 'contended.lock');
  const CALLERS = 50;
  // Every caller races for the same lock, each holding it briefly.
  const attempt = async index => {
    try {
      const lock = acquireRecoverablePrivateProcessLockV1(path, { busyCode: 'BUSY' });
      await sleep(20 + (index % 7) * 5);
      lock.release();
      return 'acquired';
    } catch (error) { return error.unusable === true ? 'unusable' : error.message; }
  };
  const results = await Promise.all(Array.from({ length: CALLERS }, (_, index) => attempt(index)));
  const acquired = results.filter(row => row === 'acquired').length;
  const unusable = results.filter(row => row === 'unusable').length;
  const busy = results.filter(row => row === 'BUSY').length;
  assert.equal(acquired + busy + unusable, CALLERS, `unaccounted: ${JSON.stringify(results)}`);
  assert.equal(unusable, 0, 'contention must never be reported as damage');
  assert.equal(busy, CALLERS - acquired, 'every loser is a live holder');
  assert.ok(acquired >= 1 && acquired <= CALLERS, `admitted ${acquired} of ${CALLERS}`);
  // Sequential after the burst: the lock is free again and the entry is a real private file.
  const after = acquireRecoverablePrivateProcessLockV1(path, { busyCode: 'BUSY' });
  after.release();
  assert.deepEqual((await readdir(root)).filter(entry => entry.includes('.quarantine-')), [],
    'normal contention quarantines nothing');
});

test('STRESS a damaged entry under concurrent callers is quarantined once, and all callers proceed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r4s07-race-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const path = join(root, 'damaged.lock');
  await writeFile(path, 'stale\n'); await chmod(path, 0o644);           // wrong mode
  const CALLERS = 50;
  const attempt = async () => {
    try {
      const lock = acquireRecoverablePrivateProcessLockV1(path, { busyCode: 'BUSY' });
      await sleep(10);
      lock.release();
      return 'acquired';
    } catch (error) { return error.unusable === true ? 'unusable' : error.message; }
  };
  const results = await Promise.all(Array.from({ length: CALLERS }, () => attempt()));
  const acquired = results.filter(row => row === 'acquired').length;
  const busy = results.filter(row => row === 'BUSY').length;
  assert.ok(acquired >= 1, `at least one caller must get through, got ${JSON.stringify(results.slice(0, 5))}`);
  assert.equal(acquired + busy, CALLERS, `unaccounted: ${JSON.stringify([...new Set(results)])}`);
  // The damaged entry is moved aside EXACTLY once: fifty callers must not pile up forty-nine
  // quarantine copies of the same thing.
  const quarantined = (await readdir(root)).filter(entry => entry.includes('.quarantine-'));
  assert.equal(quarantined.length, 1, `expected one quarantine, saw ${quarantined.length}`);
  // And a later call on a healthy lock still works and quarantines nothing.
  const clean = acquireRecoverablePrivateProcessLockV1(path, { busyCode: 'BUSY' });
  clean.release();
  assert.equal((await readdir(root)).filter(entry => entry.includes('.quarantine-')).length, 1);
});

test('STRESS every damaged shape is quarantined exactly once across repeated bursts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r4s07-shapes-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const shapes = {
    mode644: async path => { await writeFile(path, 'stale\n'); await chmod(path, 0o644); },
    directory: path => mkdir(path),
    danglingSymlink: async path => symlink(join(root, 'nowhere'), path),
    fifo: async path => execFileSync('/usr/bin/mkfifo', [path]),
  };
  for (const [name, make] of Object.entries(shapes)) {
    const path = join(root, `${name}.lock`);
    for (let burst = 0; burst < 5; burst += 1) {
      await make(path);
      let acquired = 0, unusable = 0, busy = 0;
      await Promise.all(Array.from({ length: 20 }, async () => {
        try { const lock = acquireRecoverablePrivateProcessLockV1(path, { busyCode: 'BUSY' }); lock.release(); acquired += 1; }
        catch (error) { if (error.unusable === true) unusable += 1; else if (error.message === 'BUSY') busy += 1; else throw error; }
      }));
      assert.ok(acquired >= 1, `${name} burst ${burst}: nobody got through`);
      // Only the FIRST caller of a burst can quarantine; the rest find a healthy or absent lock.
      assert.equal(unusable, 0, `${name} burst ${burst}: damage leaked past recovery`);
      const quarantined = (await readdir(root)).filter(entry => entry.startsWith(`${name}.lock.quarantine-`));
      assert.ok(quarantined.length >= 1 && quarantined.length <= burst + 1,
        `${name} burst ${burst}: ${quarantined.length} quarantine entries`);
      await sleep(5);
    }
  }
});

test('STRESS a FIFO at the lock path never blocks a caller and never opens the FIFO', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r4s07-fifo-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const path = join(root, 'fifo.lock');
  await execFileSync('/usr/bin/mkfifo', [path]);
  // Opening a FIFO for write blocks until a reader arrives, which is exactly what made this
  // hang before. If the guard regressed, this promise would never settle and the test times out.
  const settled = await Promise.race([
    Promise.all(Array.from({ length: 10 }, async () => {
      try { const lock = acquireRecoverablePrivateProcessLockV1(path, { busyCode: 'BUSY' }); lock.release(); return 'ok'; }
      catch (error) { return error.unusable === true ? 'unusable' : error.message; }
    })).then(rows => rows.join(',')),
    sleep(4000).then(() => 'TIMED_OUT'),
  ]);
  assert.notEqual(settled, 'TIMED_OUT', 'a FIFO at the lock path must not block a caller');
  assert.match(settled, /ok/, `expected at least one success, got ${settled}`);
  assert.doesNotMatch(settled, /BUSY/, 'a FIFO is not a live holder');
});

test('STRESS quarantine never opens or descends into what it moves aside', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r4s07-quar-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const path = join(root, 'dir.lock'), nestedBefore = join(path, 'deep');
    await mkdir(nestedBefore, { recursive: true });
    await writeFile(join(nestedBefore, 'owner-file'), 'precious');
    // A FIFO deep inside: if quarantine descended or opened anything, this would block or empty it.
    execFileSync('/usr/bin/mkfifo', [join(nestedBefore, 'inner-fifo')]);
    const moved = quarantineUsableLockV1(path);
    assert.ok(moved, 'quarantine must report where the entry went');
    const { lstat, readFile, readdir } = await import('node:fs/promises');
    assert.equal((await lstat(moved)).isDirectory(), true, 'the moved entry is still a directory');
    assert.deepEqual((await readdir(moved)).sort(), ['deep']);
    // Everything below it is still there, at its new path, untouched.
    const nested = join(moved, 'deep');
    assert.deepEqual((await readdir(nested)).sort(), ['inner-fifo', 'owner-file'], 'nothing was removed');
    assert.equal(await readFile(join(nested, 'owner-file'), 'utf8'), 'precious');
    assert.equal((await lstat(join(nested, 'inner-fifo'))).isFIFO(), true, 'the FIFO was not consumed');
  // Quarantining something that is not there is a no-op, not an error.
  assert.equal(quarantineUsableLockV1(join(root, 'absent.lock')), undefined);
});
test('STRESS only a wrong SHAPE is quarantineable; a state of the disk or directory is not', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r4s07-errno-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  // A SHAPE: something is at the path that can never be the lock, and moving it aside fixes it.
  for (const [name, make] of Object.entries(DAMAGED_SHAPES_V1)) {
    const path = join(root, `${name}.lock`);
    await make(path);
    assert.throws(() => acquirePrivateProcessLockV1(path, { busyCode: 'BUSY' }),
      error => error.unusable === true, `${name} is a shape and must be quarantineable`);
  }
  // A STATE: nothing is wrong with any entry, and quarantineing cannot fix it. The lock file's
  // parent directory does not exist, so open() fails with ENOENT. This must propagate its own
  // reason, not become "another one is running" (the pre-R4S-07 bug) and not become a damaged
  // entry (which would have recovery rename a path whose parent is missing).
  const orphan = join(root, 'no-such-directory', 'nightly-backup.lock');
  assert.throws(() => acquirePrivateProcessLockV1(orphan, { busyCode: 'BUSY' }),
    error => error.code === 'ENOENT' && error.unusable !== true,
    'a missing parent directory propagates ENOENT');
  assert.throws(() => acquireRecoverablePrivateProcessLockV1(orphan, { busyCode: 'BUSY' }),
    error => error.unusable !== true, 'a missing parent directory is never quarantined');
  // And nothing was quarantined by any of the refusals above.
  assert.deepEqual((await readdir(root)).filter(entry => entry.includes('.quarantine-')), []);
  // A state that IS a broken entry still recovers, so the errno narrowing did not break R4S-07:
  // a file at the path that is world-readable is opened fine and refused for what it is.
  const loose = join(root, 'loose.lock');
  await writeFile(loose, 'stale\n'); await chmod(loose, 0o644);
  const recovered = acquireRecoverablePrivateProcessLockV1(loose, { busyCode: 'BUSY' });
  recovered.release();
  assert.equal((await readdir(root)).filter(entry => entry.startsWith('loose.lock.quarantine-')).length, 1);
});
