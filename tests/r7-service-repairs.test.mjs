import { createHash } from 'node:crypto';
import { stageVerifiedTreeV1 } from '../src/updater/v1/attended-source.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants as fsConstants } from 'node:fs';
import { chmod, link, symlink, lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeServiceBundleV1, CORE_SERVICE_ROLES_V1, POST_HEALTH_SERVICE_ROLES_V1 } from '../src/updater/v1/services/bundle.mjs';
import { createInProcessServiceElevatedPortV1 } from '../src/updater/v1/services/elevated.mjs';
import { installServicesV1, recoverServicesV1, uninstallServicesV1 } from '../src/updater/v1/services/installer.mjs';
import { fixture as installerFixture } from './helpers/installer-round2-fixture.mjs';
import { installControlRoomV1 } from '../src/updater/v1/install/installer.mjs';
import { chownOwnershipV1 } from '../src/updater/v1/pg/database-phase-ownership.mjs';
import { collectServiceOutputV1, openBoundedServiceLogV1, mainServiceOutputV1 } from '../src/updater/v1/service-output.mjs';

const accounts = Object.fromEntries(['builder', 'database', 'service'].map((role, i) =>
  [role, { name: '_qa' + role, uid: 300 + i, gid: 300 + i, created: true }]));

async function fixture(t, behavior = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'r7-services-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'install');
  await mkdir(root, { recursive: true, mode: 0o755 });
  await mkdir(join(root, 'Protected', 'config'), { recursive: true, mode: 0o750 });
  await mkdir(join(root, 'updater-state'), { recursive: true, mode: 0o700 });
  const ownership = new Map([
    [join(root, 'Protected'), { uid: 0, gid: accounts.service.gid }],
    [join(root, 'Protected', 'config'), { uid: 0, gid: accounts.service.gid }],
    [join(root, 'updater-state'), { uid: 0, gid: 0 }],
  ]), events = [], loaded = new Set();
  const pathFor = path => path.startsWith('/Library/') || path.startsWith('/etc/')
    ? join(directory, 'system', path.slice(1)) : path;
  const metadata = (entry, path) => {
    const ids = ownership.get(path);
    return ids ? new Proxy(entry, { get: (target, field) => field === 'uid' ? ids.uid
      : field === 'gid' ? ids.gid : field === 'mode' ? ids.mode ?? target.mode : typeof target[field] === 'function' ? target[field].bind(target) : target[field] }) : entry;
  };
  const runtime = {
    geteuid: () => 0, pathFor, mkdir, unlink, rmdir, readFile, enforceMetadata: true,
    lstat: async path => metadata(await lstat(path), path),
    lchown: async (path, uid, gid) => ownership.set(path, { uid, gid }),
    open: async (path, flags, mode) => {
      const fd = await open(path, flags, mode);
      return new Proxy(fd, { get(target, field) {
        if (field === 'stat') return async () => metadata(await target.stat(), path);
        if (field === 'chown') return async (uid, gid) => ownership.set(path, { uid, gid });
        if (field === 'writeFile') return async contents => {
          if (behavior.failWrite?.(path)) {
            await target.writeFile(contents.slice(0, 31));
            throw Object.assign(new Error('injected short write'), { code: 'ENOSPC' });
          }
          return target.writeFile(contents);
        };
        return typeof target[field] === 'function' ? target[field].bind(target) : target[field];
      } });
    },
    isServiceLoaded: async label => loaded.has(label),
    verifyPostgresShutdown: async () => { events.push('pg-shutdown-proof'); return true; },
    execute: async (file, args) => {
      assert.equal(file, '/bin/launchctl');
      events.push([...args]);
      await behavior.gate?.(args);
      if (behavior.failExecute?.(args)) throw Object.assign(new Error('injected launch failure'), { code: 1 });
      if (args[0] === 'bootstrap') loaded.add(args[2].split('/').at(-1).replace(/\.plist$/u, ''));
      if (args[0] === 'bootout') loaded.delete(args[1].slice(7));
      return { stdout: '' };
    },
  };
  function input(roles) {
    const protectedConfig = roles === CORE_SERVICE_ROLES_V1 ?
      ['host.json', 'local-owner-session.json', 'fleet-gateway.json', 'supervisor.json', 'backup.json',
        'mac-local.json', 'database-roles.json', 'release-trust.json'].map(name => ({
        path: join(root, 'Protected', 'config', name), contents: '{"synthetic":true}\n',
        accountName: accounts.service.name, groupName: accounts.service.name, fileMode: '0600',
      })).concat({ path: join(root, 'updater-state', 'updater.json'), contents: '{"synthetic":true}\n',
        accountName: 'root', groupName: 'wheel', fileMode: '0600' }) : [];
    return { root, accounts, roles, protectedConfig, pgRuntime: join(root, 'runtime', 'pg-current', 'bin', 'postgres'),
      updaterVersion: '1.2.3-abcdefabcdef' };
  }
  return { root, runtime, input, loaded, events, pathFor, ownership, port: createInProcessServiceElevatedPortV1(runtime) };
}


test('database ownership plan keeps pg searchable by the web identity and data private', { timeout: 12000 }, () => {
  const root = '/fixture/install';
  const plan = chownOwnershipV1({ root, pgDataId: 'data-A', accounts });
  const pg = plan.find(entry => entry.path === join(root, 'pg'));
  assert.equal(pg.owner, 'database');
  assert.equal(pg.uid, accounts.database.uid);
  assert.equal(pg.gid, accounts.database.gid);
  assert.equal(pg.mode, 0o755);
  assert.equal(pg.mode & 0o001, 0o001, 'the distinct service identity can search the parent');
  const socket = plan.find(entry => entry.path === join(root, 'pg', 'socket'));
  assert.equal(socket.uid, accounts.database.uid);
  assert.equal(socket.intendedGid, accounts.service.gid);
  assert.equal(socket.mode, 0o750);
  assert.equal(plan.find(entry => entry.path === join(root, 'pg', 'data-A')).mode, 0o700);
});

test('R7S-04 POST_HEALTH bundle includes the searchable private backup parent', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const bundle = composeServiceBundleV1(f.input(POST_HEALTH_SERVICE_ROLES_V1));
  const parent = bundle.writableDirectories.find(entry => entry.path === join(f.root, 'backups'));
  assert.deepEqual(parent, { path: join(f.root, 'backups'), uid: 0, gid: accounts.service.gid, mode: '0710' });
  const child = bundle.writableDirectories.findIndex(entry => entry.path === join(f.root, 'backups', 'nightly'));
  assert.ok(child > bundle.writableDirectories.indexOf(parent), 'apply parent custody before the child');
});

test('R7S-04 no-op directory chmod refuses immediately and permits a repaired retry', { timeout: 12000 }, async t => {
  const f = await fixture(t), input = f.input(POST_HEALTH_SERVICE_ROLES_V1);
  const path = join(f.root, 'backups');
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  const baseOpen = f.runtime.open, openedAfterChmod = [];
  let fail = true, ignoredChmod = false;
  const port = createInProcessServiceElevatedPortV1({ ...f.runtime, open: async (named, flags, mode) => {
    if (ignoredChmod) openedAfterChmod.push(named);
    const handle = await baseOpen(named, flags, mode);
    if (named === path && fail) handle.chmod = async () => { ignoredChmod = true; };
    return handle;
  } });
  await assert.rejects(installServicesV1(input, { elevatedPort: port }), error => {
    assert.equal(error.code, 'services_batch_rolled_back');
    assert.equal(error.cause.message, 'services_batch_uncertain');
    return true;
  });
  assert.equal(ignoredChmod, true, 'the injected no-op actually ran');
  assert.deepEqual(openedAfterChmod, [], 'readback refuses before opening any subsequent directory or file');
  assert.equal((await lstat(path)).mode & 0o7777, 0o700);
  assert.equal(f.events.length, 0, 'no service manager calls before refusal');
  assert.equal(f.loaded.size, 0);
  fail = false; ignoredChmod = false;
  assert.ok((await installServicesV1(input, { elevatedPort: port })).receipt);
  assert.equal((await lstat(path)).mode & 0o7777, 0o710);
});

test('R7S-04 repairs old child modes and backup traversal under restrictive umask', { timeout: 12000 }, async t => {
  const f = await fixture(t), input = f.input(POST_HEALTH_SERVICE_ROLES_V1);
  await mkdir(join(f.root, 'backups'), { mode: 0o700 });
  await mkdir(join(f.root, 'Protected', 'runtime-state'), { mode: 0o700 });
  const bundle = composeServiceBundleV1(input);
  for (const dir of bundle.writableDirectories) {
    await mkdir(dir.path, { recursive: true, mode: 0o755 });
    await chmod(dir.path, 0o755);
  }
  const mask = process.umask(0o077);
  try { await installServicesV1(input, { elevatedPort: f.port }); }
  finally { process.umask(mask); }
  assert.equal((await lstat(join(f.root, 'backups'))).mode & 0o777, 0o710);
  assert.equal(f.ownership.get(join(f.root, 'backups')).gid, accounts.service.gid);
  for (const dir of bundle.writableDirectories) assert.equal((await lstat(dir.path)).mode & 0o777, parseInt(dir.mode, 8));
  for (const dir of bundle.writableDirectories) await chmod(dir.path, 0o755);
  await assert.rejects(f.port.install(bundle, new AbortController().signal));
});

test('R7S-01 failed exclusive plist write removes residue and retry succeeds', { timeout: 12000 }, async t => {
  let fail = true;
  const f = await fixture(t, { failWrite: path => fail && path.endsWith('xyz.agentcontrolroom.postgres.plist') });
  const input = f.input(['postgresql17']);
  await assert.rejects(installServicesV1(input, { elevatedPort: f.port }), { code: 'services_batch_rolled_back' });
  const path = f.pathFor(composeServiceBundleV1(input).resources[0].path);
  assert.equal(await lstat(path).then(() => false, e => e.code === 'ENOENT'), true);
  assert.equal(f.loaded.size, 0);
  fail = false;
  assert.ok((await installServicesV1(input, { elevatedPort: f.port })).receipt);
});

test('R7S-02 repeat install refuses a public diagnostic log before unchanged return', { timeout: 12000 }, async t => {
  const f = await fixture(t), input = f.input(CORE_SERVICE_ROLES_V1);
  await installServicesV1(input, { elevatedPort: f.port });
  const bundle = composeServiceBundleV1(input), log = bundle.logFiles[0].path;
  await chmod(log, 0o644);
  await assert.rejects(f.port.install(bundle, new AbortController().signal));
  await chmod(log, 0o600);
  assert.equal((await f.port.install(bundle, new AbortController().signal)).outcome, 'unchanged');
});

test('R7S-03 every daemon uses bounded pipe collection and disables pathname rotation', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  for (const roles of [['postgresql17'], CORE_SERVICE_ROLES_V1, POST_HEALTH_SERVICE_ROLES_V1]) {
    const bundle = composeServiceBundleV1(f.input(roles));
    for (const resource of bundle.resources.filter(x => x.kind === 'launchd_plist')) {
      assert.match(resource.contents, /service-output\.mjs/u);
      const deadline = Number(/<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/u.exec(resource.contents)[1]);
      assert.match(resource.contents, new RegExp('<string>--shutdown-ms</string>\\s*<string>' + ((deadline - 5) * 1000) + '</string>', 'u'));
      assert.match(resource.contents, /<key>StandardOutPath<\/key>\s*<string>\/dev\/null<\/string>/u);
      assert.match(resource.contents, /<key>StandardErrorPath<\/key>\s*<string>\/dev\/null<\/string>/u);
    }
    const rotation = bundle.resources.find(x => x.kind === 'newsyslog_config');
    if (rotation) assert.equal(rotation.contents.split('\n').filter(x => x && !x.startsWith('#')).length, 0);
  }
});

test('R7S-04 full fake first install requests searchable private backup parent', { timeout: 25000 }, async t => {
  const f = await installerFixture(t, 'r7-backup-layout');
  const mask = process.umask(0o077);
  try { assert.equal((await installControlRoomV1(f.options)).state, 'installed'); }
  finally { process.umask(mask); }
  const input = f.ports.calls.find(row => row[0] === 'post-health-services')[1];
  const parent = join(f.root, 'backups');
  assert.equal((await lstat(parent)).mode & 0o777, 0o710);
  assert.ok(f.ports.calls.some(row => row[0] === 'lchown' && row[1] === parent
    && row[2] === 0 && row[3] === input.accounts.service.gid));
  assert.equal((await lstat(parent)).mode & 0o007, 0, 'other accounts cannot search or read backups');
});

test('R7S-01 failure at write, chown, chmod or sync cleans only the exclusive inode', { timeout: 20000 }, async t => {
  for (const operation of ['writeFile', 'chown', 'chmod', 'sync']) {
    await t.test(operation, async t => {
      const f = await fixture(t), baseOpen = f.runtime.open;
      let fails = true;
      const runtime = { ...f.runtime, open: async (path, flags, mode) => {
        const handle = await baseOpen(path, flags, mode);
        if (path.endsWith('postgres.plist') && (flags & fsConstants.O_CREAT)) {
          const original = handle[operation].bind(handle);
          return new Proxy(handle, { get(target, field) {
            if (field === operation) return async (...args) => {
              if (fails) throw new Error('injected file effect failure');
              return original(...args);
            };
            return typeof target[field] === 'function' ? target[field].bind(target) : target[field];
          } });
        }
        return handle;
      } };
      const port = createInProcessServiceElevatedPortV1(runtime), input = f.input(['postgresql17']);
      await assert.rejects(installServicesV1(input, { elevatedPort: port }), { code: 'services_batch_rolled_back' });
      const path = f.pathFor(composeServiceBundleV1(input).resources[0].path);
      assert.equal(await lstat(path).then(() => false, e => e.code === 'ENOENT'), true);
      fails = false;
      assert.ok((await installServicesV1(input, { elevatedPort: port })).receipt);
    });
  }
});

test('R7S-01 rollback preserves a replacement inode and reports incomplete cleanup', { timeout: 12000 }, async t => {
  const f = await fixture(t), baseOpen = f.runtime.open;
  let replaced;
  const port = createInProcessServiceElevatedPortV1({ ...f.runtime, open: async (path, flags, mode) => {
    const handle = await baseOpen(path, flags, mode);
    if (path.endsWith('postgres.plist') && (flags & fsConstants.O_CREAT)) {
      handle.writeFile = async () => {
        await rename(path, path + '.owned');
        await writeFile(path, 'replacement sentinel', { mode: 0o600 });
        replaced = path;
        throw new Error('injected replacement');
      };
    }
    return handle;
  } });
  await assert.rejects(installServicesV1(f.input(['postgresql17']), { elevatedPort: port }), { code: 'services_batch_uncertain' });
  assert.equal(await readFile(replaced, 'utf8'), 'replacement sentinel');
});

test('R7S-02 hot retry refuses missing, symlink, hardlink, directory and wrong-owner logs', { timeout: 20000 }, async t => {
  for (const kind of ['missing', 'symlink', 'hardlink', 'directory', 'owner', 'group', 'special-mode']) {
    await t.test(kind, async t => {
      const f = await fixture(t), input = f.input(CORE_SERVICE_ROLES_V1);
      await installServicesV1(input, { elevatedPort: f.port });
      const bundle = composeServiceBundleV1(input), log = bundle.logFiles[0].path;
      if (kind === 'missing') await unlink(log);
      if (kind === 'symlink') { await rename(log, log + '.target'); await symlink(log + '.target', log); }
      if (kind === 'hardlink') await link(log, log + '.link');
      if (kind === 'directory') { await unlink(log); await mkdir(log); }
      if (kind === 'owner') f.ownership.set(log, { uid: 999, gid: accounts.service.gid });
      if (kind === 'group') f.ownership.set(log, { uid: accounts.service.uid, gid: 999 });
      if (kind === 'special-mode') f.ownership.set(log, { uid: accounts.service.uid, gid: accounts.service.gid, mode: 0o4600 });
      const before = f.events.length;
      await assert.rejects(f.port.install(bundle, new AbortController().signal));
      assert.equal(f.events.length, before, 'refusal never restarts a running job');
    });
  }
});

test('R7S-03 collector caps 50 concurrent bursts and refuses external inode replacement', { timeout: 12000 }, async t => {
  const f = await fixture(t), path = join(f.root, 'bounded.log');
  await writeFile(path, '', { mode: 0o600 });
  const log = await openBoundedServiceLogV1(path, { maxBytes: 1024 });
  try {
    await Promise.all(Array.from({ length: 50 }, () => log.write(Buffer.alloc(256 * 1024, 120))));
    assert.ok((await lstat(path)).size <= 1024);
    await rename(path, path + '.0');
    await writeFile(path, 'active sentinel', { mode: 0o600 });
    const before = (await lstat(path + '.0')).size;
    await assert.rejects(log.write(Buffer.from('after rotate')));
    assert.equal((await lstat(path + '.0')).size, before);
    assert.equal(await readFile(path, 'utf8'), 'active sentinel');
  } finally { await log.close(); }
});

test('R7S-03 pipe collector preserves child exits, drains both streams and awaits stopped helper', { timeout: 12000 }, async t => {
  const f = await fixture(t), out = join(f.root, 'out.log'), err = join(f.root, 'err.log');
  for (const path of [out, err]) await writeFile(path, '', { mode: 0o600 });
  const args = ['-e', 'for(let i=0;i<50;i++){process.stdout.write(Buffer.alloc(262144,120));process.stderr.write(Buffer.alloc(262144,121));}process.exitCode=23;'];
  assert.equal(await collectServiceOutputV1({ out, err, command: process.execPath, args, maxBytes: 1024 }), 23);
  for (const path of [out, err]) assert.ok((await lstat(path)).size <= 1024);
  const pidPath = join(f.root, 'child.pid'), abort = new AbortController();
  const stopped = collectServiceOutputV1({ out, err, command: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));process.stdin.resume();process.stdin.on("end",()=>process.exit(0));setInterval(()=>process.stdout.write("alive\\n"),10);', pidPath],
    signal: abort.signal, shutdownMs: 100 });
  let pid;
  try {
    for (let i = 0; i < 100 && !pid; i++) {
      pid = await readFile(pidPath, 'utf8').then(Number, () => null);
      if (!pid) await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(pid, 'direct helper starts under its pipe lifetime');
  } finally { abort.abort(); await stopped; }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(await collectServiceOutputV1({ out, err, command: process.execPath, args, signal: abort.signal }), 0);
  await assert.rejects(collectServiceOutputV1({ out, err, command: join(f.root, 'missing') }));
  await assert.rejects(mainServiceOutputV1(['invalid']));
  await assert.rejects(mainServiceOutputV1(['--wrong', out, '--err', err, '--shutdown-ms', '5000', '--', process.execPath, '-e', '']));
  assert.equal(await collectServiceOutputV1({ out, err, command: join(f.root, 'missing'), signal: abort.signal }), 0);
  await chmod(out, 0o644);
  await assert.rejects(collectServiceOutputV1({ out, err, command: process.execPath, args }));
});

test('R7S-03 collector CLI executes through a release-style current symlink', { timeout: 12000 }, async t => {
  const f = await fixture(t), out = join(f.root, 'cli-out.log'), err = join(f.root, 'cli-err.log');
  for (const path of [out, err]) await writeFile(path, '', { mode: 0o600 });
  const link = join(f.root, 'service-output.mjs');
  await symlink(join(process.cwd(), 'src/updater/v1/service-output.mjs'), link);
  await promisify(execFile)(process.execPath, [link, '--out', out, '--err', err, '--shutdown-ms', '5000', '--', process.execPath,
    '-e', 'process.stdout.write("collected-out");process.stderr.write("collected-err");'], { timeout: 5000 });
  assert.equal(await readFile(out, 'utf8'), 'collected-out');
  assert.equal(await readFile(err, 'utf8'), 'collected-err');
});

test('R7S-04 refuses a symlinked child or ancestor, failed exact mode and missing search permission', { timeout: 20000 }, async t => {
  for (const kind of ['child-link', 'parent-link', 'chmod-noop', 'lost-search', 'world-writable']) {
    await t.test(kind, async t => {
      const f = await fixture(t), input = f.input(POST_HEALTH_SERVICE_ROLES_V1);
      const parent = join(f.root, 'backups'), child = join(parent, 'nightly');
      await mkdir(parent, { mode: 0o700 });
      if (kind === 'world-writable') await chmod(parent, 0o777);
      if (kind === 'child-link') await symlink(f.root, child);
      if (kind === 'parent-link') { await rename(parent, parent + '.original'); await symlink(f.root, parent); }
      const baseOpen = f.runtime.open;
      const port = createInProcessServiceElevatedPortV1({ ...f.runtime, open: async (path, flags, mode) => {
        const handle = await baseOpen(path, flags, mode);
        if (kind === 'chmod-noop' && path === parent) return new Proxy(handle, { get(target, field) {
          if (field === 'chmod') return async () => {};
          return typeof target[field] === 'function' ? target[field].bind(target) : target[field];
        } });
        return handle;
      } });
      if (kind === 'lost-search') {
        await installServicesV1(input, { elevatedPort: port });
        await chmod(join(f.root, 'Protected'), 0o700);
      }
      await assert.rejects(port.install(composeServiceBundleV1(input), new AbortController().signal));
      assert.equal(f.events.filter(row => Array.isArray(row) && row[0] === 'bootstrap').length,
        kind === 'lost-search' ? 3 : 0);
    });
  }
});

test('R7S-03 log custody, short writes, zero writes and parameter refusals are enforced', { timeout: 12000 }, async t => {
  const f = await fixture(t), path = join(f.root, 'guarded.log');
  await writeFile(path, Buffer.alloc(2048, 120), { mode: 0o600 });
  const bounded = await openBoundedServiceLogV1(path, { maxBytes: 1024 });
  await bounded.close();
  assert.equal((await lstat(path)).size, 0);
  for (const options of [{ maxBytes: 0 }, { maxBytes: 1.5 }, { maxBytes: 10485761 },
    { uid: process.geteuid() + 1 }, { gid: process.getegid() + 1 }]) {
    const value = await openBoundedServiceLogV1(path, options).then(log => log, () => null);
    try { assert.equal(value, null); } finally { await value?.close(); }
  }
  await assert.rejects(openBoundedServiceLogV1('relative.log'));
  await assert.rejects(openBoundedServiceLogV1(f.root));
  await chmod(path, 0o644);
  await assert.rejects(openBoundedServiceLogV1(path));
  await chmod(path, 0o600);
  await link(path, path + '.hardlink');
  await assert.rejects(openBoundedServiceLogV1(path));
  await unlink(path + '.hardlink');
  await symlink(path, path + '.symlink');
  const linked = await openBoundedServiceLogV1(path + '.symlink').then(log => log, () => null);
  try { assert.equal(linked, null); } finally { await linked?.close(); }
  const err = join(f.root, 'err.log'); await writeFile(err, '', { mode: 0o600 });
  for (const input of [{ command: 'relative' }, { out: path, err: path }, { args: [1] },
    { shutdownMs: 0 }, { shutdownMs: 120001 }]) {
    await assert.rejects(collectServiceOutputV1({ out: path, err, command: process.execPath, args: ['-e', ''], ...input }));
  }
  const zero = await openBoundedServiceLogV1(path, { openFile: async (...args) => {
    const handle = await open(...args); handle.write = async () => ({ bytesWritten: 0 }); return handle;
  } });
  try { await assert.rejects(zero.write(Buffer.from('never written')), /service_log_write_failed/u); }
  finally { await zero.close(); }
  const short = await openBoundedServiceLogV1(path, { openFile: async (...args) => {
    const handle = await open(...args), write = handle.write.bind(handle);
    handle.write = (buffer, offset, length, position) => write(buffer, offset, Math.min(length, 2), position);
    return handle;
  } });
  try { await short.write(Buffer.from('short write completes')); }
  finally { await short.close(); }
  assert.match(await readFile(path, 'utf8'), /short write completes/u);
});

test('R7S-03 real staging keeps collector reachable and private bundle bytes inaccessible to other accounts', { timeout: 12000 }, async t => {
  const f = await fixture(t), source = join(f.root, 'source'), target = join(f.root, 'staged');
  await mkdir(source);
  const entries = [['service-output.mjs', 'immutable collector code', 0o555], ['private.json', 'synthetic private config', 0o400]];
  const snapshot = new Map();
  for (const [name, contents, mode] of entries) {
    await writeFile(join(source, name), contents, { mode });
    snapshot.set(name, { type: 'file', mode, bytes: Buffer.byteLength(contents),
      sha256: 'sha256:' + createHash('sha256').update(contents).digest('hex') });
  }
  const session = { identity: { rootUid: process.geteuid(), rootGid: process.getegid() }, input: {} };
  try {
    await stageVerifiedTreeV1(session, source, snapshot, target, target + '.partial', process.getegid(), (_name, mode) => mode);
    assert.equal((await lstat(target)).mode & 0o777, 0o551);
    assert.equal((await lstat(join(target, 'service-output.mjs'))).mode & 0o777, 0o555);
    assert.equal((await lstat(join(target, 'private.json'))).mode & 0o777, 0o400);
    await stageVerifiedTreeV1(session, source, snapshot, target, target + '.partial', process.getegid(), (_name, mode) => mode);
    await chmod(target, 0o550);
    await assert.rejects(stageVerifiedTreeV1(session, source, snapshot, target, target + '.partial', process.getegid(), (_name, mode) => mode));
  } finally { await chmod(target, 0o700).catch(() => {}); }
});

test('R7S-04 no-follow directory descriptor refuses an open-time link before touching its target', { timeout: 12000 }, async t => {
  const f = await fixture(t), input = f.input(POST_HEALTH_SERVICE_ROLES_V1);
  const child = join(f.root, 'backups', 'nightly'), target = join(f.root, 'unrelated');
  await mkdir(target, { mode: 0o755 });
  const baseOpen = f.runtime.open;
  let swapped = false;
  const port = createInProcessServiceElevatedPortV1({ ...f.runtime, open: async (path, flags, mode) => {
    if (path === child && !swapped && (flags & fsConstants.O_DIRECTORY)) {
      swapped = true; await rename(child, child + '.owned'); await symlink(target, child);
    }
    return baseOpen(path, flags, mode);
  } });
  await assert.rejects(installServicesV1(input, { elevatedPort: port }));
  assert.equal(swapped, true);
  assert.equal((await lstat(target)).mode & 0o777, 0o755);
});

test('R7S-04 installer detects a replaced layout inode and never marks installation ready', { timeout: 25000 }, async t => {
  const f = await installerFixture(t, 'r7-layout-swap'), original = f.ports.lchownPath;
  const path = join(f.root, 'backups');
  let swapped = false;
  f.ports.lchownPath = async (named, uid, gid) => {
    await original(named, uid, gid);
    if (named === path && !swapped) {
      swapped = true; await rename(path, path + '.owned'); await mkdir(path, { mode: 0o755 });
    }
  };
  await assert.rejects(installControlRoomV1(f.options));
  assert.equal(swapped, true);
  assert.equal((await lstat(path)).mode & 0o777, 0o755);
});

test('R7S-04 descriptor readback checks mode and ownership before proceeding', { timeout: 12000 }, async t => {
  for (const field of ['type', 'mode', 'uid', 'gid']) {
    await t.test(field, async t => {
      const f = await fixture(t), path = join(f.root, 'backups');
      let corrupted = false;
      const baseOpen = f.runtime.open;
      const port = createInProcessServiceElevatedPortV1({ ...f.runtime, open: async (named, flags, mode) => {
        const handle = await baseOpen(named, flags, mode);
        if (named !== path) return handle;
        let reads = 0;
        return new Proxy(handle, { get(target, property) {
          if (property === 'stat') return async () => {
            const entry = await target.stat();
            if (++reads !== (field === 'type' ? 1 : 2) || corrupted) return entry;
            corrupted = true;
            return new Proxy(entry, { get(stat, key) {
              if (field === 'type' && key === 'isDirectory') return () => false;
              if (key === field) return field === 'mode' ? 0o700 : 999;
              return typeof stat[key] === 'function' ? stat[key].bind(stat) : stat[key];
            } });
          };
          return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
        } });
      } });
      await assert.rejects(installServicesV1(f.input(POST_HEALTH_SERVICE_ROLES_V1), { elevatedPort: port }));
      assert.equal(f.events.length, 0);
    });
  }
});

test('R7S-02 hot retry refuses a writable diagnostic parent and a swapped log pathname', { timeout: 12000 }, async t => {
  const f = await fixture(t), input = f.input(CORE_SERVICE_ROLES_V1);
  await installServicesV1(input, { elevatedPort: f.port });
  const bundle = composeServiceBundleV1(input), log = bundle.logFiles[0];
  await chmod(log.directory, 0o775);
  await assert.rejects(f.port.install(bundle, new AbortController().signal));
  await chmod(log.directory, 0o755);
  const baseOpen = f.runtime.open;
  const port = createInProcessServiceElevatedPortV1({ ...f.runtime, open: async (path, flags, mode) => {
    const handle = await baseOpen(path, flags, mode);
    if (path === log.path) {
      await rename(path, path + '.original'); await writeFile(path, 'replacement', { mode: 0o600 });
    }
    return handle;
  } });
  await assert.rejects(port.install(bundle, new AbortController().signal));
});

test('R7S-03 detects a hardlink planted during a log write', { timeout: 12000 }, async t => {
  const f = await fixture(t), path = join(f.root, 'linked-during-write.log');
  await writeFile(path, '', { mode: 0o600 });
  const log = await openBoundedServiceLogV1(path, { openFile: async (...args) => {
    const handle = await open(...args), write = handle.write.bind(handle);
    handle.write = async (...values) => { const result = await write(...values); await link(path, path + '.link'); return result; };
    return handle;
  } });
  try { await assert.rejects(log.write(Buffer.from('synthetic'))); } finally { await log.close(); }
});

test('R7S-04 service directory inode replacement is detected before launch', { timeout: 12000 }, async t => {
  const f = await fixture(t), path = join(f.root, 'backups', 'nightly'), baseOpen = f.runtime.open;
  let swapped = false;
  const port = createInProcessServiceElevatedPortV1({ ...f.runtime, open: async (named, flags, mode) => {
    const handle = await baseOpen(named, flags, mode);
    if (named !== path || swapped) return handle;
    return new Proxy(handle, { get(target, key) {
      if (key === 'chmod') return async value => {
        await target.chmod(value);
        swapped = true; await rename(path, path + '.owned'); await mkdir(path, { mode: 0o770 }); await chmod(path, 0o770);
        await writeFile(join(path, 'sentinel'), 'unrelated');
      };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } });
  } });
  await assert.rejects(installServicesV1(f.input(POST_HEALTH_SERVICE_ROLES_V1), { elevatedPort: port }));
  assert.equal(swapped, true);
  assert.equal(f.events.length, 0);
  assert.equal(await readFile(join(path, 'sentinel'), 'utf8'), 'unrelated');
});

test('R7S-03 cancellation during a failed spawn never signals a missing child PID', { timeout: 12000 }, async t => {
  const f = await fixture(t), out = join(f.root, 'cancel-out.log'), err = join(f.root, 'cancel-err.log');
  for (const path of [out, err]) await writeFile(path, '', { mode: 0o600 });
  const abort = new AbortController(), add = abort.signal.addEventListener.bind(abort.signal);
  abort.signal.addEventListener = (...args) => { abort.abort(); return add(...args); };
  await assert.rejects(collectServiceOutputV1({ out, err, command: join(f.root, 'missing'), signal: abort.signal }), { code: 'ENOENT' });
});
