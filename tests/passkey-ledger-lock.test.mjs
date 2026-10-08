import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import childProcess, { execFileSync, spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { acquirePasskeyLedgerLockV1 as acquire } from '../src/updater/v1/passkey-ledger-lock.mjs';
import { kernelFileLockPlatformV1 } from '../src/installer/shared/private-process-lock.mjs';

const moduleURL = new URL('../src/updater/v1/passkey-ledger-lock.mjs', import.meta.url).href;
const busy = 'passkey_ledger_lock_busy';
const refused = 'passkey_ledger_lock_refused';
async function fixture(t) {
  // Custody intentionally refuses writable volume ancestors and allow ACLs.
  // Keep the fixture in the caller's configured private temporary layout.
  const parent = tmpdir();
  const root = await fs.realpath(await fs.mkdtemp(join(parent, 'passkey-s0-')));
  await fs.chmod(root, 0o700);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
    t.diagnostic('scratch cleanup verified');
  });
  const path = join(root, 'ledger.lock');
  await assert.rejects(fs.lstat(path), { code: 'ENOENT' });
  return { root, path };
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function rejectsLock(promise, expected, message) {
  let accepted;
  try { await assert.rejects(async () => { accepted = await promise; }, expected, message); }
  finally {
    if (accepted) await accepted.release().catch(error => {
      if (error.message !== 'kernel_file_lock_owner_changed') throw error;
    });
  }
}


// Direct children inherit the run's process group, never detach, and exit on EOF.
// A line barrier proves every contender reached the gate before a burst starts.
function launch(program, args = []) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, ...args],
    { stdio: ['pipe', 'pipe', 'pipe'], detached: false });
  let output = '', stderr = '', finished = false;
  const waiters = new Set();
  child.stdout.on('data', bytes => { output += bytes; for (const check of waiters) check(); });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      finished = true;
      for (const check of waiters) check();
      resolve({ code, signal, output, stderr });
    });
  });
  const line = text => new Promise((resolve, reject) => {
    const check = () => {
      const wanted = Array.isArray(text) ? text : [text];
      const matched = wanted.find(row => output.split('\n').includes(row));
      if (matched) { clearTimeout(timer); waiters.delete(check); resolve(matched); }
      else if (finished) { clearTimeout(timer); waiters.delete(check); reject(new Error(`child closed before ${text}: ${stderr}`)); }
    };
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`child barrier deadline: ${text}`)); }, 15_000);
    waiters.add(check); check();
  });
  const stop = async () => {
    child.stdin.destroy();
    if (!finished) child.kill('SIGKILL');
    await closed;
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'owned child is gone');
  };
  return { child, closed, line, stop };
}
const childPrelude = `
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
const {acquirePasskeyLedgerLockV1:acquire}=await import(${JSON.stringify(moduleURL)});
const input=createInterface({input:process.stdin});
const lines=input[Symbol.asyncIterator]();
process.stdin.on('end',()=>process.exit(0));
`;

async function independentAttempt(path) {
  const c = launch(`${childPrelude}
try {const lock=await acquire(process.argv[1]); await lock.release(); console.log('acquired');}
catch(e){console.log(e.code||e.message);} input.close(); process.stdin.destroy();`, [path]);
  try { const result = await c.closed; assert.equal(result.code, 0, result.stderr); return result.output.trim(); }
  finally { await c.stop(); }
}

test('S0 permanent lock name excludes a second ledger process and real reader sees the write', async t => {
  const { root, path } = await fixture(t);
  assert.equal(dirname(root), await fs.realpath(tmpdir()), 'fixture uses configured temporary directory rather than checkout ancestry');
  const lock = await acquire(path), before = await fs.lstat(path);
  try {
    assert.equal(await independentAttempt(path), busy, 'one descriptor excludes the independent writer');
    await fs.writeFile(join(root, 'ledger.json'), '{"request":"first","complete":true}\n', { mode: 0o600 });
    assert.deepEqual(JSON.parse(await fs.readFile(join(root, 'ledger.json'), 'utf8')), { request: 'first', complete: true });
  } finally { await lock.release(); }
  assert.equal(same(before, await fs.lstat(path).catch(() => null) ?? {}), true, 'release retains the permanent rendezvous inode');
  await fs.rename(path, path + '.released');
  await assert.doesNotReject(lock.release(), 'completed release is idempotent even after the owner moves the name');
  await fs.rename(path + '.released', path);
  const again = await acquire(path);
  try { assert.equal(same(before, await fs.lstat(path)), true); }
  finally { await again.release(); }
  const changed = await acquire(path);
  await fs.rename(path, path + '.displaced');
  await fs.writeFile(path, 'owner-replacement', { mode: 0o600 });
  await assert.rejects(changed.release(), /kernel_file_lock_owner_changed/, 'release reports a displaced name and still closes');
  assert.equal(await fs.readFile(path, 'utf8'), 'owner-replacement', 'release preserves the owner replacement');
  // Owner replacement is a non-goal: this checks the legacy release diagnostic,
  // not exclusion through a replaced rendezvous name.
  assert.equal(await independentAttempt(path), 'acquired', 'changed-name release closes its descriptor');
});

test('S0 20 and 50 independent callers at an observable barrier admit exactly one writer', { timeout: 120_000 }, async t => {
  const { root, path } = await fixture(t);
  for (const count of [20, 50]) {
    const children = [];
    try {
      for (let n = 0; n < count; n++) children.push(launch(`${childPrelude}
console.log('ready'); const go=await lines.next(); if(go.done)process.exit(0);
try {const lock=await acquire(process.argv[1]);
console.log('winner'); await lines.next();
await fs.appendFile(process.argv[2],process.argv[3]+'\\n',{mode:0o600});
await lock.release(); console.log('released');}
catch(e){console.log(e.code||e.message);} input.close(); process.stdin.destroy();`, [path, join(root, `ledger-${count}`), `request-${n}`]));
      await Promise.all(children.map(c => c.line('ready')));
      for (const c of children) c.child.stdin.write('go\n');
      const decisions = await Promise.all(children.map(c => c.line(['winner', busy])));
      // Release only admitted children, after every losing branch responded.
      for (const [index, decision] of decisions.entries())
        if (decision === 'winner') children[index].child.stdin.write('release\n');
      const results = await Promise.all(children.map(c => c.closed));
      assert.equal(results.filter(r => r.output.includes('\nwinner\n')).length, 1, 'exactly one admitted writer in the burst');
      assert.equal(results.filter(r => r.output.includes(`\n${busy}\n`)).length, count - 1, 'every losing branch ran and refused');
      for (const result of results) assert.equal(result.code, 0, result.stderr);
      const records = (await fs.readFile(join(root, `ledger-${count}`), 'utf8')).trim().split('\n');
      assert.equal(records.length, 1, 'one complete request written and read back');
      assert.match(records[0], /^request-\d+$/);
      assert.equal(await fs.lstat(path).then(() => true, () => false), true, 'burst release retains the permanent lock name');
      t.diagnostic(`${count} callers: one admitted, ${count - 1} busy; one record; all child close/ESRCH verified`);
    } finally { await Promise.all(children.map(c => c.stop())); }
  }
});

test('S0 unsafe directory and lock custody refuse before effects including replacement during acquire', async t => {
  const { root, path } = await fixture(t);
  for (const mode of [0o720, 0o702, 0o777]) {
    await fs.chmod(root, mode);
    await assert.rejects(async () => { const lock = await acquire(path); await lock.release(); },
      { code: refused }, 'writable lock directory is refused at acquire');
    await assert.rejects(fs.lstat(path), { code: 'ENOENT' }, 'unsafe directory creates no lock');
  }
  await fs.chmod(root, 0o700);
  // Keep the trusted outer scratch as the sticky parent's direct child.
  // A foreign nested directory then isolates the owner check from sticky custody.
  const uid = process.getuid(), foreignDirectory = join(root, 'foreign');
  const foreignLock = join(foreignDirectory, 'ledger.lock');
  await fs.mkdir(foreignDirectory, { mode: 0o700 });
  const realLstat = fs.lstat;
  // Root proves actual ownership. Unprivileged runs inject only the nested
  // directory's stat uid; this synthetic seam cannot change kernel answers.
  if (uid === 0) await fs.chown(foreignDirectory, 10000, process.getgid());
  else {
    fs.lstat = async (...args) => {
      const entry = await realLstat(...args);
      return args[0] === foreignDirectory ? Object.assign(Object.create(entry), { uid: uid + 10000 }) : entry;
    };
    syncBuiltinESMExports();
  }
  try {
    await rejectsLock(acquire(foreignLock), { code: refused }, 'wrong directory owner creates no lock');
    await assert.rejects(fs.lstat(foreignLock), { code: 'ENOENT' }, 'wrong directory owner creates no lock');
  } finally {
    if (uid === 0) await fs.chown(foreignDirectory, uid, process.getgid());
    fs.lstat = realLstat; syncBuiltinESMExports();
  }
  await fs.symlink(root, join(root, 'alias'));
  await rejectsLock(acquire(join(root, 'alias', 'other.lock')), { code: refused }, 'symlinked lock directory is refused');
  const nested = join(root, 'child'); await fs.mkdir(nested, { mode: 0o700 });
  await rejectsLock(acquire(join(root, 'alias', 'child', 'other.lock')), { code: refused }, 'symlinked ancestor is refused');
  await assert.rejects(fs.lstat(join(root, 'child', 'other.lock')), { code: 'ENOENT' }, 'symlinked ancestor creates no lock');
  await rejectsLock(acquire(`${root}/alias/../hidden.lock`), { code: refused }, 'lexical traversal cannot hide a symlink');
  await rejectsLock(acquire(join(root, 'missing', 'other.lock')), { code: 'ENOENT' });
  await rejectsLock(acquire(join(root, 'x'.repeat(300))), { code: 'ENAMETOOLONG' }, 'oversized filename fails closed');
  for (const fault of ['mode', 'links', 'symlink', 'directory', 'fifo', 'uid']) {
    const target = join(root, `bad-${fault}.lock`), sentinel = join(root, `sentinel-${fault}`);
    await fs.writeFile(sentinel, 'unmodified', { mode: 0o600 });
    if (fault === 'mode') { await fs.writeFile(target, 'unmodified', { mode: 0o644 }); await fs.chmod(target, 0o644); }
    if (fault === 'links') await fs.link(sentinel, target);
    if (fault === 'symlink') await fs.symlink(sentinel, target);
    if (fault === 'directory') await fs.mkdir(target);
    if (fault === 'fifo') execFileSync('/usr/bin/mkfifo', [target]);
    if (fault === 'uid') await fs.writeFile(target, 'unmodified', { mode: 0o600 });
    await rejectsLock(acquire(target, fault === 'uid' ? { expectedUid: process.getuid() + 10000 } : {}),
      e => fault === 'symlink' ? e.code === 'ELOOP' || e.code === refused : e.code === refused,
      `${fault} lock is refused`);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'unmodified', 'invalid lock never damages sentinel');
    if (['mode', 'links', 'uid'].includes(fault)) assert.equal(await fs.readFile(target, 'utf8'), 'unmodified');
  }
  // Deterministic in-acquire races use the real FS; only the scheduling seam is
  // intercepted. No successful kernel response is faked.
  const realOpen = fs.open;
  await fs.writeFile(path, 'original-before-acquire', { mode: 0o600 });
  try {
    fs.open = async (...args) => {
      const h = await realOpen(...args);
      if (args[0] === path) { await fs.rename(path, path + '.opened'); await fs.writeFile(path, 'replacement', { mode: 0o600 }); }
      return h;
    };
    syncBuiltinESMExports();
    await rejectsLock(acquire(path), { code: refused }, 'descriptor/name mismatch refuses acquisition');
    assert.equal(await fs.readFile(path, 'utf8'), 'replacement', 'refusal preserves the replacement');
    assert.equal(await fs.readFile(path + '.opened', 'utf8'), 'original-before-acquire', 'unproved descriptor is never truncated');
  } finally { fs.open = realOpen; syncBuiltinESMExports(); }
  await fs.unlink(path);
  for (const change of ['directory-mode', 'directory-identity', 'lock-identity']) {
    try {
      fs.open = async (...args) => {
        const h = await realOpen(...args), sync = h.sync.bind(h);
        if (args[0] === path) h.sync = async () => {
          await sync();
          if (change === 'directory-mode') await fs.chmod(root, 0o720);
          if (change === 'directory-identity') {
            await fs.rename(root, root + '.moved');
            await fs.mkdir(root, { mode: 0o700 });
            // Preserve the lock inode so the directory check is the observer.
            await fs.rename(join(root + '.moved', 'ledger.lock'), path);
          }
          if (change === 'lock-identity') {
            await fs.rename(path, path + '.synced');
            await fs.writeFile(path, 'late-replacement', { mode: 0o600 });
          }
        };
        return h;
      };
      syncBuiltinESMExports();
      await rejectsLock(acquire(path), { code: refused }, `${change} during acquire is refused`);
    } finally {
      fs.open = realOpen; syncBuiltinESMExports();
      await fs.chmod(root, 0o700);
      await fs.rm(root + '.moved', { recursive: true, force: true });
      await fs.rm(path, { force: true });
    }
  }
});

test('S0 dead holder releases exclusion and interrupted retry keeps the same permanent inode', async t => {
  const { root, path } = await fixture(t);
  const c = launch(`${childPrelude}
const lock=await acquire(process.argv[1]);
await fs.writeFile(process.argv[2],'interrupted\\n',{mode:0o600});
console.log('held'); await lines.next(); await lock.release(); input.close(); process.stdin.destroy();`, [path, join(root, 'intent')]);
  try {
    await c.line('held');
    const before = await fs.lstat(path);
    assert.equal(await independentAttempt(path), busy, 'live holder refuses a second process');
    c.child.kill('SIGKILL'); const result = await c.closed; assert.equal(result.signal, 'SIGKILL');
    const recovered = await acquire(path);
    try {
      assert.equal(await fs.readFile(join(root, 'intent'), 'utf8'), 'interrupted\n');
      await fs.writeFile(join(root, 'complete'), 'retried-once\n', { mode: 0o600 });
    } finally { await recovered.release(); }
    assert.equal(same(before, await fs.lstat(path).catch(() => null) ?? {}), true, 'death and retry never remove the rendezvous');
    assert.equal(await fs.readFile(join(root, 'complete'), 'utf8'), 'retried-once\n');
    const realOpen = fs.open;
    try {
      fs.open = async (...args) => {
        const h = await realOpen(...args);
        if (args[0] === path) h.sync = async () => { throw Object.assign(new Error('injected write failure'), { code: 'EIO' }); };
        return h;
      };
      syncBuiltinESMExports();
      await rejectsLock(acquire(path), { code: 'EIO' }, 'failed acquisition preserves its real error');
      assert.equal(same(before, await fs.lstat(path).catch(() => null) ?? {}), true, 'failed acquisition keeps the permanent name');
    } finally { fs.open = realOpen; syncBuiltinESMExports(); }
    const retry = await acquire(path); await retry.release();
  } finally { await c.stop(); }
});

test('S0 Linux helper is attached and a slow killed helper closes without granting authority', async t => {
  const { path } = await fixture(t);
  const handle = await fs.open(path, 'wx', 0o600);
  let result, pid, observed;
  try {
    const linux = kernelFileLockPlatformV1('linux', { run: (binary, args, options) => {
      observed = options;
      if (options.detached !== false) return { status: null, error: { code: 'ENOENT' } };
      assert.equal(options.timeout, 5000, 'helper timeout remains bounded');
      assert.equal(options.killSignal, 'SIGKILL');
      // Synthetic slow tool, real spawnSync timeout/reap. This is not util-linux
      // kernel proof. It is a bounded direct child with stdin, no descendants.
      result = spawnSync(process.execPath, ['-e', "require('node:fs').writeSync(2,String(process.pid));process.stdin.resume();process.stdin.on('end',()=>process.exit());Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);"],
        { ...options, stdio: ['pipe', 'ignore', 'pipe', handle.fd] });
      pid = Number(result.stderr.toString());
      return result;
    } });
    assert.throws(() => linux.tryLock(handle.fd), /kernel_file_lock_unsupported/);
    assert.equal(observed.detached, false, 'Linux helper never detaches');
    assert.equal(result.error.code, 'ETIMEDOUT', 'real slow child reached timeout');
    assert.equal(result.signal, 'SIGKILL');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'timed-out helper was reaped');
  } finally { await handle.close(); }
});

test('S0 platform distinguishes busy from unsupported and never launches a command or shell', () => {
  const mac = kernelFileLockPlatformV1('darwin', { run: () => { throw new Error('Mac must not launch helper'); } });
  assert.equal(mac.openFlags, 0x20); assert.equal(mac.tryLock(5), true);
  assert.throws(() => kernelFileLockPlatformV1('win32'), /kernel_file_lock_unsupported/);
  const statuses = [{ status: 0 }, { status: 75 }, { status: 1 }, { status: null, error: { code: 'ENOENT' } },
    { status: null, signal: 'SIGKILL' }, { status: 0, error: { code: 'ETIMEDOUT' } }, { status: 75, signal: 'SIGTERM' }];
  for (const status of statuses) {
    const linux = kernelFileLockPlatformV1('linux', { run: (binary, args, options) => {
      assert.equal(binary, '/usr/bin/flock');
      assert.deepEqual(args, ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3']);
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 8]);
      assert.equal(options.detached, false, 'platform contract requires attached helpers');
      assert.equal(options.shell, undefined, 'no shell injection surface');
      assert.deepEqual(options.env, {});
      return status; // Synthetic contract cases, not captured Linux results.
    } });
    if (status.status === 0 && !status.error) assert.equal(linux.tryLock(8), true);
    else if (status.status === 75 && !status.signal) assert.equal(linux.tryLock(8), false);
    else assert.throws(() => linux.tryLock(8), /kernel_file_lock_unsupported/, 'unknown helper results fail closed');
  }
});

test('S0 writable non-sticky grandparent refused before lock creation', async t => {
  const { root } = await fixture(t);
  const grandparent = join(root, 'grandparent'), folder = join(grandparent, 'ledger');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await fs.chmod(grandparent, 0o777);
  const path = join(folder, 'ledger.lock');
  await rejectsLock(acquire(path), { code: refused }, 'writable non-sticky grandparent refused');
  await assert.rejects(fs.lstat(path), { code: 'ENOENT' }, 'refused ancestry creates no lock');
  if (process.platform === 'linux' && process.getuid() === 0) await rootSwapReproduction(t);
  else t.diagnostic('root/runner swap branch NOT-RUN: requires the Linux root container');
});

test('S0 sticky grandparent accepted and still excludes another process', async t => {
  const { root } = await fixture(t);
  const grandparent = join(root, 'grandparent'), folder = join(grandparent, 'ledger');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await fs.chmod(grandparent, 0o1777);
  const path = join(folder, 'ledger.lock');
  let lock;
  await assert.doesNotReject(async () => { lock = await acquire(path); }, 'sticky grandparent accepted');
  try { assert.equal(await independentAttempt(path), busy); }
  finally { await lock?.release(); }
});

async function rootSwapReproduction(t) {
    const { root } = await fixture(t);
    // The runner must traverse scratch to reach the world-writable grandparent.
    await fs.chmod(root, 0o755);
    for (const mode of [0o777, 0o1777]) {
      const grandparent = join(root, `g${mode.toString(8)}`), folder = join(grandparent, 'ledger');
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      await fs.mkdir(join(grandparent, 'spare'), { mode: 0o700 });
      await fs.chmod(grandparent, mode);
      const path = join(folder, 'ledger.lock');
      // FIRST is the independently held primitive, bypassing the new custody
      // policy to replay the recorded vulnerable holder under a 0777 ancestor.
      const first = await fs.open(path, 'wx+', 0o600);
      assert.equal(kernelFileLockPlatformV1().tryLock(first.fd), true);
      try {
        const remove = spawnSync('/usr/sbin/runuser', ['-u', 'runner', '--', '/usr/bin/rm', path], { encoding: 'utf8' });
        assert.notEqual(remove.status, 0, 'runner cannot remove the private lock');
        assert.match(remove.stderr, /Permission denied/u);
        const move = spawnSync('/usr/sbin/runuser', ['-u', 'runner', '--', '/usr/bin/mv', folder, folder + '.old'], { encoding: 'utf8' });
        if (mode === 0o777) {
          assert.equal(move.status, 0, move.stderr);
          const spare = spawnSync('/usr/sbin/runuser', ['-u', 'runner', '--', '/usr/bin/mv', join(grandparent, 'spare'), folder], { encoding: 'utf8' });
          assert.equal(spare.status, 0, spare.stderr);
          assert.equal(await independentAttempt(path), refused, 'SECOND refused after runner swaps unsafe ancestor');
          await assert.rejects(fs.lstat(path), { code: 'ENOENT' }, 'SECOND creates no stray lock in swapped folder');
        } else {
          assert.notEqual(move.status, 0, 'sticky ancestor denies runner rename');
          assert.match(move.stderr, /Operation not permitted/u);
          assert.equal(await independentAttempt(path), busy, 'SECOND remains busy behind sticky custody');
        }
      } finally { await first.close(); }
    }
}

test('S0 socket lock gets the named custody refusal', async t => {
  const { path } = await fixture(t), server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  try { await rejectsLock(acquire(path), { code: refused }, 'socket gets named refusal'); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('S0 correct folder owner but wrong lock file owner is refused without truncation', async t => {
  const { path } = await fixture(t), uid = process.getuid();
  await fs.writeFile(path, 'foreign-file-sentinel', { mode: 0o600 });
  const realOpen = fs.open;
  // Root exercises real chown. Unprivileged runs inject only stat's foreign uid;
  // the descriptor, inode, directory custody and kernel lock are real.
  if (uid === 0) await fs.chown(path, 10001, process.getgid());
  else {
    fs.open = async (...args) => {
      const handle = await realOpen(...args), stat = handle.stat.bind(handle);
      if (args[0] === path) handle.stat = async () => Object.assign(await stat(), { uid: uid + 10000 });
      return handle;
    };
    syncBuiltinESMExports();
  }
  try {
    await rejectsLock(acquire(path), { code: refused }, 'wrong file owner refused with correct directory owner');
    assert.equal(await fs.readFile(path, 'utf8'), 'foreign-file-sentinel', 'foreign file is never truncated');
  } finally {
    fs.open = realOpen; syncBuiltinESMExports();
    if (uid === 0) await fs.chown(path, uid, process.getgid());
  }
});

test('S0 deny-only ACL accepted; allow ACL refused and fixed-path probe fails closed', async t => {
  const api = await import('../src/installer/shared/private-process-lock.mjs');
  assert.equal(typeof api.macLockPathHasAclV1, 'function', 'ACL custody probe exists');
  const probe = output => api.macLockPathHasAclV1('/literal path', { run: (binary, args, options) => {
    assert.equal(binary, '/bin/ls'); assert.deepEqual(args, ['-lde', '/literal path']);
    assert.equal(options.detached, false); assert.equal(options.timeout, 5000);
    assert.deepEqual(options.env, { LC_ALL: 'C' });
    return { status: 0, stdout: output, stderr: '' };
  } });
  // Synthetic metadata uses role labels, following the recorded ls -lde shape.
  const plain = 'drwx------  2 role staff 64 Oct  7 20:00 /literal path\n';
  // Recorded on the job Mac; only owner identity and scratch path are redacted.
  const recordedFolder = 'drwx------@ 3 role  staff  96 Oct  7 22:49 /literal path\n';
  const recordedFile = '-rw-------@ 1 role  staff  8 Oct  7 22:49 /literal path\n';
  assert.equal(probe(recordedFolder + ' 0: group:everyone allow add_file,delete\n'), true, 'recorded folder ACL detected');
  assert.equal(probe(recordedFile + ' 0: group:everyone allow write,delete\n'), true, 'recorded file ACL detected');
  assert.equal(probe(recordedFolder + ' 0: group:everyone inherited allow delete_child,directory_inherit\n'), true,
    'recorded inherited ACL detected');
  // Recorded with /bin/ls -lde on the job Mac (2026-10-07); identity and
  // destination are redacted. The @ marker is com.apple.provenance, not an ACL.
  const recordedRoot = 'drwxr-xr-x  22 root  wheel  704 Aug 12 20:51 /\n';
  const recordedSticky = 'drwxrwxrwt  40 root  wheel  1280 Oct  7 23:51 /private/tmp\n';
  const recordedXattr = 'drwx------@ 2 role  staff  64 Oct  7 23:51 /literal path\n';
  const recordedHomeAcl = 'drwxr-x---+ 101 role  staff  3232 Oct  7 23:27 /literal path\n 0: group:everyone deny delete\n';
  for (const output of [recordedRoot, recordedSticky, recordedXattr])
    assert.equal(probe(output), false, 'recorded valid Mac metadata without ACL accepted');
  assert.equal(probe(recordedHomeAcl), false, 'recorded deny-only home ancestor ACL accepted');
  assert.equal(probe(recordedHomeAcl + ' 1: group:everyone allow delete_child\n'), true,
    'mixed deny and allow ACL refused');
  // Recorded on the review Mac: an allow row precedes an inherited deny row.
  assert.equal(probe(recordedFolder + ' 0: group:staff allow add_file\n'
    + ' 1: group:everyone inherited deny delete,directory_inherit\n'), true,
    'recorded allow-first ACL refused before inherited deny');
  assert.equal(probe(recordedHomeAcl.replace('deny delete', 'inherited deny delete')), false,
    'inherited deny-only ACL accepted');
  assert.equal(probe(recordedXattr + ' 0: group:everyone allow add_file,delete\n'), true,
    'recorded scratch ACL refused despite xattr marker');
  assert.equal(probe(plain), false, 'plain metadata has no ACL');
  assert.equal(probe(plain.replace('------ ', '------@ ')), false, 'xattrs alone are not ACLs');
  assert.equal(probe(plain.replace('------ ', '------+ ') + ' 0: group:everyone allow add_file,delete_child\n'), true,
    'ACL entry is detected');
  assert.equal(probe(plain.replace('------ ', '------+ ') + ' 0: group:everyone inherited allow delete\n'), true,
    'inherited ACL entry is detected');
  for (const output of ['', 'unparseable\n', plain + 'unexpected row\n', plain.replace('------ ', '------+ ')])
    assert.throws(() => probe(output), { code: 'kernel_file_lock_acl_probe_failed' }, 'unparseable ACL probe fails closed');
  for (const result of [{ status: 1 }, { status: null, error: { code: 'ENOENT' } }, { status: 0, signal: 'SIGKILL' },
    { status: 0, stdout: plain, stderr: 'ls warning' }, { status: 0, stdout: Buffer.from(plain), stderr: '' }])
    assert.throws(() => api.macLockPathHasAclV1('/literal', { run: () => result }),
      { code: 'kernel_file_lock_acl_probe_failed' }, 'failed ACL probe fails closed');
  assert.throws(() => api.macLockPathHasAclV1('/literal', { run: () => { throw new Error('tool launch failed'); } }),
    { code: 'kernel_file_lock_acl_probe_failed' }, 'thrown ACL probe fails closed');
  if (process.platform === 'darwin') await realMacAclCustody(t, api);
  else {
    await recordedMacAclWiring(t, recordedFolder, recordedFile);
    t.diagnostic('real Mac ACL custody branch NOT-RUN: requires darwin; recorded platform seam exercised');
  }
});

async function realMacAclCustody(t, api) {
  const { root, path } = await fixture(t);
  assert.equal(typeof api.macLockPathHasAclV1, 'function', 'real ACL custody probe exists');
  assert.equal(api.macLockPathHasAclV1(root), false);
  const clean = await acquire(path);
  await clean.release();
  await fs.unlink(path); // Isolated fixture reset before adding its own ACL.
  for (const target of [root, path]) {
    if (target === path) await fs.writeFile(path, 'acl-file-sentinel', { mode: 0o600 });
    execFileSync('/bin/chmod', ['+a', 'everyone deny delete', target]);
    try {
      const recorded = execFileSync('/bin/ls', ['-lde', target], { encoding: 'utf8', env: { LC_ALL: 'C' } });
      assert.match(recorded, /0: group:everyone deny delete/u, 'real deny-only ACL entry recorded');
      assert.equal(api.macLockPathHasAclV1(target), false, 'real deny-only ACL accepted');
      const deniedOnly = await acquire(path); await deniedOnly.release();
    } finally { execFileSync('/bin/chmod', ['-N', target]); }
    if (target === root) await fs.unlink(path);
    else await fs.writeFile(path, 'acl-file-sentinel', { mode: 0o600 });
    execFileSync('/bin/chmod', ['+a', 'everyone allow write,delete', target]);
    try {
      const recorded = execFileSync('/bin/ls', ['-lde', target], { encoding: 'utf8', env: { LC_ALL: 'C' } });
      assert.match(recorded, /0: group:everyone allow/u, 'real ACL entry recorded');
      assert.equal(api.macLockPathHasAclV1(target), true, 'real extended ACL detected');
      await rejectsLock(acquire(path), { code: refused }, 'Mac ACL custody refused');
      if (target === root) await assert.rejects(fs.lstat(path), { code: 'ENOENT' },
        'Darwin ancestor allow ACL creates no lock');
      else assert.equal(await fs.readFile(path, 'utf8'), 'acl-file-sentinel');
    } finally { execFileSync('/bin/chmod', ['-N', target]); }
  }
}

// Synthetic Darwin platform seam on Linux. Only ls answers replay recorded Mac
// output and O_EXLOCK is removed from open: this proves ACL wiring, not Mac
// kernel exclusion. Native Mac custody remains covered by realMacAclCustody.
async function recordedMacAclWiring(t, folderHeader, fileHeader) {
  const { root } = await fixture(t);
  const ancestor = join(root, 'ancestor'), folder = join(ancestor, 'folder');
  const lockPath = join(folder, 'ledger.lock');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await fs.chmod(ancestor, 0o700);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realRun = childProcess.spawnSync, realOpen = fs.open;
  let target, kind, seen;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    childProcess.spawnSync = (binary, args, options) => {
      if (binary !== '/bin/ls') return realRun(binary, args, options);
      assert.deepEqual(args.slice(0, 1), ['-lde']);
      const selected = args[1] === target;
      if (selected) seen++;
      const header = args[1] === lockPath ? fileHeader : folderHeader;
      return { status: 0, stdout: header + (selected ? ` 0: group:everyone ${kind} delete\n` : ''), stderr: '' };
    };
    fs.open = (name, flags, ...rest) => realOpen(name, flags & ~0x20, ...rest);
    syncBuiltinESMExports();
    for (target of [ancestor, folder, lockPath]) {
      kind = 'deny'; seen = 0;
      const lock = await acquire(lockPath);
      await lock.release();
      assert.ok(seen > 0, 'Darwin ACL wiring probes the selected ancestor, folder or file');
      if (target !== lockPath) await fs.unlink(lockPath);
      else await fs.writeFile(lockPath, 'acl-file-sentinel', { mode: 0o600 });
      kind = 'allow'; seen = 0;
      await rejectsLock(acquire(lockPath), { code: refused }, 'Darwin allow ACL custody refused at ancestor, folder and file');
      assert.ok(seen > 0, 'Darwin allow ACL refusal reached the selected probe');
      if (target !== lockPath)
        await assert.rejects(fs.lstat(lockPath), { code: 'ENOENT' }, 'Darwin ancestor allow ACL creates no lock');
      else assert.equal(await fs.readFile(lockPath, 'utf8'), 'acl-file-sentinel', 'Darwin file allow ACL preserves sentinel');
      kind = 'deny';
      const retry = await acquire(lockPath); await retry.release();
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
    childProcess.spawnSync = realRun; fs.open = realOpen; syncBuiltinESMExports();
  }
}
