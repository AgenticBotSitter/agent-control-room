// Permanent regressions from the round-2 reporter's copied scratch attacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir, uptime } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mac, trust } from './support/hardening-config.mjs';
import { loadRehearsalConfigV1 } from '../src/updater/v1/install/rehearsal-config.mjs';
import { parseRehearsalConfigV1 } from '../src/updater/v1/rehearsal/config.mjs';
import { makeOwnerPasteFile } from '../scripts/install/make-owner-paste-file.mjs';
import { parseInstallerArgumentsV1 } from '../src/updater/v1/cli.mjs';
import { loadMacLocalProtectedConfigurationFromRootV1 as loadRoot, loadMacLocalWebRoleFromRootV1 as webRole } from '../src/web/v1/mac-local-protected-loader.ts';
import { captureLocalOwnerSessionProfileV1 } from '../src/web/v1/local-owner-session.ts';
import { validatePrivatePostgresConfiguration } from '../src/web/v1/private-postgres.ts';
import { ensureFirstOwnerStateV1 as ensure, readFirstOwnerStateV1 as readState } from '../src/updater/v1/pg/first-owner-state.mjs';
import { FileStepJournalV1 as Journal } from '../src/updater/v1/journal.mjs';
import { generateInstallationReleaseKeyV1 as keygen, raiseReleaseTrustFloorV1 as raise, captureReleaseTrustV1 } from '../scripts/release-signing.mjs';
import { signAttendedConnectorReleaseV1 as signRelease } from '../src/updater/v1/install/connector-release.mjs';
import { stopRecorded } from '../scripts/mac-local/stack.mjs';
import { pgFailureLineV1 } from '../src/updater/v1/pg/init-database.mjs';

const uid = process.getuid(), commit = 'a'.repeat(40);
const write = async (path, body, mode = 0o600) => { await fs.writeFile(path, body, { mode }); await fs.chmod(path, mode); };
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'round2-files-')));
  t.after(async () => {
    async function thaw(path) { const stat = await fs.lstat(path).catch(() => null); if (stat?.isDirectory() && !stat.isSymbolicLink()) {
      await fs.chmod(path, 0o700); for (const name of await fs.readdir(path)) await thaw(join(path, name));
    } }
    await thaw(root); await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
async function patch(name, wrapper, work) {
  const original = fs[name]; fs[name] = wrapper(original); syncBuiltinESMExports();
  try { return await work(); } finally { fs[name] = original; syncBuiltinESMExports(); }
}
async function child(args) {
  const proc = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((done, fail) => { proc.once('error', fail); proc.once('close', (code, signal) => done({ code, signal })); });
  let out = '', err = ''; proc.stdout.on('data', bytes => out += bytes); proc.stderr.on('data', bytes => err += bytes);
  const timer = setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} }, 30000);
  try { return { ...await closed, out, err }; }
  finally { clearTimeout(timer); try { process.kill(-proc.pid, 'SIGKILL'); } catch {} await closed; }
}
const rehearsal = root => ({ schema: 'control-room.e2e2-rehearsal-config/v1', root,
  accounts: { service: '_controlroom_rehearsal', database: '_crdb_rehearsal', builder: '_crbuild_rehearsal' },
  launchdLabels: Object.fromEntries(['postgresql17', 'supervisor', 'fleet-gateway', 'nightly-backup', 'updater', 'updater-guard']
    .map(role => [role, `xyz.agentcontrolroom.rehearsal.${role}`])), ports: { web: 4383, gateway: 4384 }, tailnetName: 'fixture-rehearsal.ts.net',
  tailscale: { mode: 'skip', expectedStepOutcome: 'skipped (rehearsal)', mutationAllowed: false }, database: { mode: 'fresh' },
  authenticator: { kind: 'software', userVerification: 'required' }, installerArgumentTemplate: [], observedInstallerFlags: [], missingInstallerFlags: [] });

test('R2F-01: directory identity rejects Data-volume aliases, parents and missing descendants; siblings stay separate', async t => {
  const base = await fixture(t), liveRoot = join(base, 'live'), path = join(base, 'config.json'); await fs.mkdir(liveRoot);
  const aliases = [liveRoot, join(liveRoot, 'missing/practice'), base];
  if (process.platform === 'darwin') {
    const a = await fs.stat(liveRoot), b = await fs.stat('/System/Volumes/Data' + liveRoot);
    assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino);
    aliases.push(...aliases.map(root => '/System/Volumes/Data' + root));
    // Even the default live root may not exist yet: compare its existing parent.
    for (const root of ['/System/Volumes/Data/Library/Application Support/Control Room',
      '/System/Volumes/Data/Library/Application Support/Control Room/practice', '/System/Volumes/Data/Library']) {
      await write(path, JSON.stringify(rehearsal(root)));
      await assert.rejects(loadRehearsalConfigV1(path), { code: 'rehearsal_config_refused' });
    }
  }
  for (const root of aliases) { await write(path, JSON.stringify(rehearsal(root)));
    await assert.rejects(loadRehearsalConfigV1(path, { liveRoot }), { code: 'rehearsal_config_refused' }); }
  for (const root of [join(base, 'sibling'), join(base, 'missing/sibling')]) {
    await write(path, JSON.stringify(rehearsal(root))); assert.equal((await loadRehearsalConfigV1(path, { liveRoot })).root, root);
  }
});

test('R2F-20: policy-checked leaf is bound to the opened descriptor across a directory swap and swap-back', async t => {
  const root = await fixture(t), dir = join(root, 'config'), evil = join(root, 'evil'), parked = join(root, 'parked');
  await fs.mkdir(dir, { mode: 0o700 }); await fs.mkdir(evil, { mode: 0o777 }); await fs.chmod(evil, 0o777);
  const path = join(dir, 'mac-local.json'); await write(path, JSON.stringify(mac));
  await write(join(evil, 'mac-local.json'), JSON.stringify({ ...mac, workspaceId: 'workspace:substituted' }), 0o666);
  let calls = 0, swapped = false;
  await patch('lstat', original => async p => {
    if (p !== path) return original(p);
    if (swapped && calls === 4) { await fs.rename(dir, evil); await fs.rename(parked, dir); swapped = false; }
    const entry = await original(p);
    if (++calls === 2) { await fs.rename(dir, parked); await fs.rename(evil, dir); swapped = true; }
    return entry;
  }, async () => {
    // Capture the patched syscall in the production runtime, not a replacement reader.
    const { loadMacLocalProtectedConfigurationFromRootV1 } = await import('../src/web/v1/mac-local-protected-loader.ts?round2-swap');
    await assert.rejects(loadMacLocalProtectedConfigurationFromRootV1(root), /mac_local_protected_configuration_root_invalid/);
  });
});

test('R2F-20b: first-owner refuses a descriptor from a parent temporarily substituted around open', async t => {
  const root = await fixture(t), other = await fixture(t); await ensure(root); await ensure(other);
  const dir = join(root, 'updater-state'), parked = join(root, 'parked');
  await assert.rejects(readState(root, { open: async (path, flags) => {
    await fs.rename(dir, parked); await fs.rename(join(other, 'updater-state'), dir);
    try { return await fs.open(path, flags); } finally { await fs.rename(dir, join(other, 'updater-state')); await fs.rename(parked, dir); }
  } }), { code: 'first_owner_state_refused' });
});

test('R2F-07: killing first-owner before publication leaves no torn authority, then 50 callers share one key', async t => {
  const root = await fixture(t), module = resolve('src/updater/v1/pg/first-owner-state.mjs');
  const result = await child(['--input-type=module', '-e', `
    import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.open; fs.open=async (...args)=>{ const handle=await original(...args);
      if(String(args[0]).includes('first-owner')) handle.writeFile=async()=>process.kill(process.pid,'SIGKILL'); return handle; };
    syncBuiltinESMExports(); const {ensureFirstOwnerStateV1}=await import(${JSON.stringify(module)});
    await ensureFirstOwnerStateV1(process.argv[1]);`, root]);
  assert.equal(result.signal, 'SIGKILL', result.err);
  await assert.rejects(fs.lstat(join(root, 'updater-state/first-owner.json')), { code: 'ENOENT' });
  const states = await Promise.all(Array.from({ length: 50 }, () => ensure(root)));
  assert.equal(new Set(states.map(state => state.reviewKey)).size, 1);
  assert.deepEqual(await ensure(root), states[0]);
  // A pre-existing damaged authority must still refuse, never mint a replacement key.
  // (A zero-byte file is the one exception: atk-fa F12 replaces the shape the older
  // O_EXCL-then-write left after a kill, see tests/updater-first-owner-script.test.mjs.)
  for (const damaged of ['{', '{"schema":"control-room.first-owner-state/v1"', 'x']) {
    await write(join(root, 'updater-state/first-owner.json'), damaged);
    await assert.rejects(ensure(root), { code: 'first_owner_state_refused' });
  }
});

test('R2F-02: a journal PID stamp written before this boot is reclaimed even when its PID is alive again', async t => {
  const bootedAt = Date.now() - uptime() * 1000, beforeBoot = new Date(bootedAt - 3_600_000);
  for (const body of [JSON.stringify({ pid: process.pid }), JSON.stringify({ pid: 1 }), '{', 'x'.repeat(300)]) {
    const root = await fixture(t); await fs.mkdir(join(root, 'updater-state'));
    const path = join(root, 'updater-state/journal.lock');
    await write(path, body); await fs.utimes(path, beforeBoot, beforeBoot);
    const journal = new Journal(root, { ownerUid: uid }); await journal.intent({ runId: 'after-reboot', ordinal: 1 });
    assert.equal((await journal.validate()).entries.length, 1);
    await assert.rejects(fs.lstat(path), { code: 'ENOENT' });
  }
});

test('R2F-10: a short ENOSPC write or failed sync restores old journal bytes and retry succeeds', async t => {
  for (const seeded of [false, true]) for (const point of ['write', 'sync']) {
    const root = await fixture(t); await fs.mkdir(join(root, 'updater-state'));
    const journal = new Journal(root, { ownerUid: uid }), path = join(root, 'updater-state/journal.jsonl');
    if (seeded) await journal.intent({ runId: 'seed', ordinal: 1 });
    const before = await fs.readFile(path).catch(() => undefined); let injected = false;
    await patch('open', original => async (...args) => {
      const handle = await original(...args);
      if (args[0] === path) {
        if (point === 'write') handle.writeFile = async line => { await handle.write(Buffer.from(line).subarray(0, 64)); injected = true;
          throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' }); };
        else { const sync = handle.sync.bind(handle); handle.sync = async () => { if (!injected) { injected = true;
          throw Object.assign(new Error('fixture sync full'), { code: 'ENOSPC' }); } return sync(); }; }
      }
      return handle;
    }, () => assert.rejects(journal.intent({ runId: 'failed', ordinal: 1 }), { code: 'ENOSPC' }));
    assert.equal(injected, true);
    assert.deepEqual(await fs.readFile(path).catch(() => undefined), before);
    await journal.intent({ runId: 'retry', ordinal: 1 }); assert.equal((await journal.validate()).entries.length, seeded ? 2 : 1);
  }
});

test('R2F-07: kill after exclusive link preserves the published key and safely removes its temporary alias on retry', async t => {
  const root = await fixture(t), module = resolve('src/updater/v1/pg/first-owner-state.mjs');
  const result = await child(['--input-type=module', '-e', `
    import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.link;fs.link=async(...args)=>{await original(...args);process.kill(process.pid,'SIGKILL');};
    syncBuiltinESMExports();const {ensureFirstOwnerStateV1}=await import(${JSON.stringify(module)});await ensureFirstOwnerStateV1(process.argv[1]);`, root]);
  assert.equal(result.signal, 'SIGKILL', result.err);
  const path = join(root, 'updater-state/first-owner.json'), published = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.equal((await fs.lstat(path)).nlink, 2);
  const states = await Promise.all(Array.from({ length: 20 }, () => ensure(root)));
  assert.ok(states.every(state => state.reviewKey === published.reviewKey));
  assert.equal((await fs.lstat(path)).nlink, 1);
  assert.deepEqual(await fs.readdir(join(root, 'updater-state')), ['first-owner.json']);
});

test('R2F-11: rehearsal identities and all argument arrays require strings', async t => {
  const base = await fixture(t), liveRoot = join(base, 'live'), path = join(base, 'config.json'); await fs.mkdir(liveRoot);
  for (const change of [v => v.accounts.service = ['_controlroom_rehearsal'], v => v.launchdLabels.supervisor = [v.launchdLabels.supervisor],
    ...['installerArgumentTemplate', 'observedInstallerFlags', 'missingInstallerFlags'].map(key => v => v[key] = [null])]) {
    const value = rehearsal(join(base, 'practice')); change(value); await write(path, JSON.stringify(value));
    await assert.rejects(loadRehearsalConfigV1(path, { liveRoot }), { code: 'rehearsal_config_refused' });
  }
});

test('R2F-12: updater rehearsal uses the shared DNS rule', () => {
  const base = { schema: 'control-room.updater-rehearsal-config/v1', mode: 'throwaway', rehearsalRoot: '/private/tmp/control-room-rehearsal-x',
    ports: { web: 59681, gateway: 59682, postgres: 59683 }, accounts: { service: '_cr_rehearsal_s', database: '_cr_rehearsal_d', builder: '_cr_rehearsal_b' },
    daemonLabelPrefix: 'xyz.agentcontrolroom.rehearsal.x', allowRealRoot: false };
  for (const host of ['rehearsal', 'rehearsal..example', 'a.-rehearsal-.b', 'x'.repeat(70) + '-rehearsal.example', 'rehearsal.' + 'a'.repeat(240)])
    assert.throws(() => parseRehearsalConfigV1({ ...base, rehearsalHostname: host, expectedOrigin: `https://${host}:59681` }), { code: 'rehearsal_hostname_refused' });
});

test('R2F-13: owner paste refuses hidden path characters, noncanonical paths and unsafe repo components', async () => {
  const input = { releaseCommit: commit, stagingFolder: '/staging/cr', livePorts: [3210], liveLabelPrefixes: ['xyz.agentcontrolroom'],
    rehearsalTailnetName: 'x-rehearsal.ts.net', repoSlug: 'owner/repo' };
  for (const suffix of ['\u202e', '\u200b', '\u0085', '\u2028', '\u2029', '\ud800', '/'])
    await assert.rejects(makeOwnerPasteFile({ ...input, stagingFolder: input.stagingFolder + suffix }), /staging_folder_refused/);
  for (const slug of ['../..', '-o/-r', '.git/.git', './repo', 'owner/..'])
    await assert.rejects(makeOwnerPasteFile({ ...input, repoSlug: slug }), /repo_slug_refused/);
  assert.ok((await makeOwnerPasteFile(input)).includes('/staging/cr'));
});

test('R2F-14: every installer path flag uses bounded canonical absolute text', () => {
  const who = { invokingUser: { user: 'fixture', uid: 501, gid: 20 } };
  for (const verb of ['status', 'install', 'uninstall-fresh']) for (const path of ['relative/dir', '/', '', '/a/../b', '/a\nb', '/' + 'x'.repeat(4096), '/a/', '/a\u200b'])
    assert.throws(() => parseInstallerArgumentsV1(verb, ['--root', path], who), { code: 'arguments_refused' });
  for (const flag of ['--bootstrap', '--rehearsal-config', '--e2e2-evidence-log']) for (const path of ['/a/../../etc', '/x\n', '/a/'])
    assert.throws(() => parseInstallerArgumentsV1('install', [flag, path], who), { code: 'arguments_refused' });
  assert.equal(parseInstallerArgumentsV1('status', ['--root', '/neutral/install']).root, '/neutral/install');
});

test('R2F-15: protected config, role map, first-owner, trust and staged marker reject duplicate JSON members', async t => {
  const root = await fixture(t), dir = join(root, 'config'); await fs.mkdir(dir, { mode: 0o700 });
  await write(join(dir, 'mac-local.json'), JSON.stringify(mac).replace('"workspaceId":', '"workspaceId":"workspace:shadow","workspaceId":'));
  await assert.rejects(loadRoot(root), /mac_local_protected_configuration_root_invalid/);
  await write(join(dir, 'database-roles.json'), `{"schema":"control-room.mac-local-database-roles/v1","web":{},"web":${JSON.stringify(mac.database)}}`);
  await assert.rejects(webRole(root), /mac_local_database_roles_root_invalid/);
  const state = await ensure(root); await write(join(root, 'updater-state/first-owner.json'),
    `{"schema":"control-room.first-owner-state/v1","createdAt":"${state.createdAt}","reviewKey":"${state.reviewKey}","reviewKey":"${state.reviewKey}"}`);
  await assert.rejects(readState(root), { code: 'first_owner_state_refused' });
  const f = await releaseFixture(t); await write(f.key.trustPath, JSON.stringify(f.key.trust).replace('"versionFloor":', '"versionFloor":"5.0.0","versionFloor":'), 0o640);
  await assert.rejects(raise({ trustPath: f.key.trustPath, installedVersion: '0.0.2' }, { expectedUid: uid }), error => error.reason === 'trust');
  const { readStagedReleaseV1, writeStagedReleaseV1 } = await import('../src/updater/v1/staged-release.mjs');
  const markerRoot = await fixture(t); await fs.mkdir(join(markerRoot, 'updater-state'));
  await writeStagedReleaseV1(markerRoot, 'release-one');
  const markerPath = join(markerRoot, 'updater-state/staged-release');
  const marker = await fs.readFile(markerPath, 'utf8'); await write(markerPath, marker.replace('"releaseId":', '"releaseId":"release-two","releaseId":'));
  await assert.rejects(readStagedReleaseV1(markerRoot), /updater_staged_release_refused/);
});

test('R2F-16: invalid session URLs and invisible or broken identities get the typed refusal', () => {
  for (const change of [{ origin: 'not a url' }, { trustedOrigin: '::' }, { tenantId: 'tenant\ud800' }, { subject: 'owner\u202e' }, { provider: 'local\u200bowner' }])
    assert.throws(() => captureLocalOwnerSessionProfileV1({ ...mac.localOwnerSession, ...change }), { message: 'invalid_local_owner_session_profile' });
});

test('R2F-17: socket authority is bound to the supplied install root; invisible characters refuse without one', async t => {
  const installRoot = '/neutral/install', host = installRoot + '/pg/socket';
  assert.equal(validatePrivatePostgresConfiguration({ ...mac.database, host }, { installRoot }).host, host);
  for (const bad of ['/a/pg/socket', '/tmp/anyone/pg/socket', '/neutral/install/x/pg/socket', '/neutral/pg/socket', '/' + 'x'.repeat(1000) + '/pg/socket'])
    assert.throws(() => validatePrivatePostgresConfiguration({ ...mac.database, host: bad }, { installRoot }), /invalid_private_database_endpoint/);
  // Re-validating an already-bound value without a root keeps the shape rule, now also refusing invisible text.
  assert.equal(validatePrivatePostgresConfiguration({ ...mac.database, host }).host, host);
  for (const bad of ['/tmp/\u202e/pg/socket', '/tmp/\u200b/pg/socket', '/tmp/\u2028/pg/socket', '/tmp/\ud800/pg/socket', '/tmp/\u0085/pg/socket'])
    assert.throws(() => validatePrivatePostgresConfiguration({ ...mac.database, host: bad }), /invalid_private_database_endpoint/);
  const root = await fixture(t), protectedRoot = join(root, 'Protected'); await fs.mkdir(join(protectedRoot, 'config'), { recursive: true, mode: 0o700 });
  await write(join(protectedRoot, 'config/mac-local.json'), JSON.stringify({ ...mac, database: { ...mac.database, host: '/a/pg/socket' } }));
  await assert.rejects(loadRoot(protectedRoot), /mac_local_protected_configuration_root_invalid/);
  await write(join(protectedRoot, 'config/mac-local.json'), JSON.stringify({ ...mac, database: { ...mac.database, host: root + '/pg/socket' } }));
  assert.equal((await loadRoot(protectedRoot)).database.host, root + '/pg/socket');
});

test('R2F-18: refused PID custody preserves the record and reports a typed stop failure', async t => {
  const root = await fixture(t), real = join(root, 'real'), alias = join(root, 'alias'); await fs.mkdir(real); await fs.symlink(real, alias);
  await write(join(real, 'host.pid'), '424242\n', 0o644);
  await assert.rejects(stopRecorded(join(alias, 'host.pid'), ['fixture-command'], 0), /recorded_pid_refused/);
  assert.equal(await fs.readFile(join(real, 'host.pid'), 'utf8'), '424242\n');
  await write(join(real, 'host.pid'), 'bad\n'); await assert.rejects(stopRecorded(join(real, 'host.pid'), ['fixture-command'], 0), /recorded_pid_refused/);
  assert.equal(await fs.readFile(join(real, 'host.pid'), 'utf8'), 'bad\n');
  assert.equal(await stopRecorded(join(root, 'missing.pid'), ['fixture-command'], 0), 'not_running');
});

async function releaseFixture(t) {
  const root = await fixture(t), protectedRoot = join(root, 'Protected'); await fs.mkdir(protectedRoot, { mode: 0o750 });
  const key = await keygen({ protectedRoot, versionFloor: '0.0.0' }, { expectedUid: uid });
  const output = join(root, 'output'), dir = join(output, 'dist-vps/server/fleet/release'); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const bundle = Buffer.from(`// Control Room embedded release key ID: ${key.trust.keyId}\nvar CONNECTOR_VERSION = "1.2.3";\n`);
  const manifest = { schema: 'control-room.fleet-connector-release/v1', builtFrom: commit, file: 'connector-1.2.3.mjs', version: '1.2.3', size: bundle.length, sha256: hash(bundle) };
  await write(join(dir, manifest.file), bundle, 0o400); await write(join(dir, 'manifest.json'), JSON.stringify(manifest), 0o400);
  const files = []; for (const name of await fs.readdir(dir)) { const bytes = await fs.readFile(join(dir, name)); files.push({ path: 'dist-vps/server/fleet/release/' + name, bytes: bytes.length, mode: 0o400, sha256: 'sha256:' + hash(bytes) }); }
  const build = { schema: 'control-room.attended-build-manifest/v1', commit, version: '1.2.3', files, fileCount: files.length, byteCount: files.reduce((sum, file) => sum + file.bytes, 0) };
  await write(join(output, 'RELEASE_MANIFEST.json'), JSON.stringify(build), 0o400);
  return { root, output, dir, key, manifest, build, input: { output, commit, trust: key.trust, privateKeyPath: key.privateKeyPath } };
}

test('R2F-19 and R2F-15 connector: malformed or duplicate manifests and invalid counts refuse without publication', async t => {
  for (const [target, value] of [['manifest', 'null'], ['manifest', '{'], ['manifest', '[]'], ['build', 'null'], ['build', { files: [null] }],
    ['build', { fileCount: 'two' }], ['build', { byteCount: -1 }], ['build', { fileCount: 1 }], ['build', { byteCount: 1 }], ['manifest-duplicate', null]]) {
    const f = await releaseFixture(t);
    const path = target.startsWith('manifest') ? join(f.dir, 'manifest.json') : join(f.output, 'RELEASE_MANIFEST.json');
    const body = target === 'manifest-duplicate' ? JSON.stringify(f.manifest).replace('"version":', '"version":"1.2.3","version":')
      : typeof value === 'string' ? value : JSON.stringify({ ...f.build, ...value });
    await fs.chmod(path, 0o600); await write(path, body, 0o400);
    await assert.rejects(signRelease(f.input, { expectedUid: uid }), { message: 'attended_connector_release_refused' });
    await assert.rejects(fs.lstat(join(f.dir, 'connector-release.json')), { code: 'ENOENT' });
    assert.equal((await fs.readdir(f.output)).some(name => /lock|tmp/u.test(name)), false);
  }
});

test('R2F-21: release trust text fields refuse coercible arrays and boxed text', () => {
  for (const key of ['versionFloor', 'keyId', 'publicKey']) for (const value of [[trust[key]], [[trust[key]]], new String(trust[key])])
    assert.throws(() => captureReleaseTrustV1({ ...trust, [key]: value }));
  for (const value of [[['sha256:' + 'b'.repeat(64)]], [new String('sha256:' + 'b'.repeat(64))]])
    assert.throws(() => captureReleaseTrustV1({ ...trust, revokedKeyIds: value }));
});

test('R2F-04 and R2F-05: empty and reused PID trust locks recover, 50 writers never lower acknowledged floors', async t => {
  const f = await releaseFixture(t), path = f.key.trustPath + '.lock';
  for (const body of ['', JSON.stringify({ pid: process.pid, token: 'old' })]) {
    await write(path, body); await raise({ trustPath: f.key.trustPath, installedVersion: '1.0.0' }, { expectedUid: uid, attempts: 3 });
  }
  await write(path, JSON.stringify({ pid: process.pid, token: 'old' }));
  const versions = Array.from({ length: 50 }, (_, i) => `1.0.${i + 1}`);
  await Promise.all(versions.map(installedVersion => raise({ trustPath: f.key.trustPath, installedVersion }, { expectedUid: uid })));
  assert.equal(JSON.parse(await fs.readFile(f.key.trustPath, 'utf8')).versionFloor, '1.0.50');
  const results = await Promise.all(versions.slice(0, 20).map(installedVersion => child(['--input-type=module', '-e',
    `import {raiseReleaseTrustFloorV1} from './scripts/release-signing.mjs'; await raiseReleaseTrustFloorV1({trustPath:process.argv[1],installedVersion:process.argv[2]},{expectedUid:process.getuid()});`, f.key.trustPath, installedVersion])));
  for (const result of results) assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(await fs.readFile(f.key.trustPath, 'utf8')).versionFloor, '1.0.50');
});

test('R2F-23: failure lines strip invisible, direction and separator characters', () => {
  for (const character of ['\u202e', '\u200b', '\u2028', '\u2029', '\u{e0041}', '\ud800'])
    assert.equal(pgFailureLineV1('FATAL: a' + character + 'b'), 'FATAL: a b');
});
