import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapPrivateVpsOwner } from '../scripts/bootstrap-private-vps-owner.mjs';
import { createConfiguration, schema } from '../deploy/owner-bootstrap-config.mjs';

test('owner bootstrap help and invalid arguments do not import operator or release', async () => {
  for (const args of [['--help'], [], ['--configuration', 'relative.mjs'], ['--force']]) {
    const reports = [], errors = [];
    const code = await bootstrapPrivateVpsOwner(args, { report: value => reports.push(value), reportError: value => errors.push(value),
      loadOperator: () => assert.fail('operator must not load'), loadRelease: () => assert.fail('release must not load') });
    assert.equal(code, args[0] === '--help' ? 0 : 1);
    assert.ok(reports.every(value => !value.includes('"ownerCreated"')));
    assert.equal(errors.length, args[0] === '--help' ? 0 : 1);
  }
});

test('owner command rejects missing or untrusted modules before compiled operation', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-owner-wrapper-denials-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'operator.mjs');
  const reports = [], errors = []; let loads = 0, operator = {};
  const runtime = { report: value => reports.push(value), reportError: value => errors.push(value),
    loadOperator: async () => { loads++; return operator; }, loadRelease: () => assert.fail('release must not load') };
  assert.equal(await bootstrapPrivateVpsOwner(['--configuration', path], runtime), 1); assert.equal(loads, 0);
  await writeFile(path, '// inert fixture', { mode: 0o644 });
  assert.equal(await bootstrapPrivateVpsOwner(['--configuration', path], runtime), 1); assert.equal(loads, 0);
  await chmod(path, 0o600);
  for (const value of [{}, { schema: 'untrusted', createConfiguration }, { schema }]) {
    operator = value; assert.equal(await bootstrapPrivateVpsOwner(['--configuration', path], runtime), 1);
  }
  assert.equal(loads, 3); assert.deepEqual(reports, []);
  assert.equal(new Set(errors).size, 1);
});

test('protected synthetic JSON reaches only fixed owner operation and failures never report success or raw inputs', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-owner-wrapper-settings-')));
  const previous = process.env.CONTROL_ROOM_OWNER_BOOTSTRAP_FILE;
  t.after(async () => {
    if (previous === undefined) delete process.env.CONTROL_ROOM_OWNER_BOOTSTRAP_FILE;
    else process.env.CONTROL_ROOM_OWNER_BOOTSTRAP_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const modulePath = join(directory, 'operator.mjs'), settingsPath = join(directory, 'settings.json');
  await writeFile(modulePath, '// inert injected operator', { mode: 0o600 });
  const input = { synthetic: true, assertion: 'synthetic-private-assertion', database: { password: 'synthetic-private-password' } };
  await writeFile(settingsPath, JSON.stringify(input), { mode: 0o600 });
  process.env.CONTROL_ROOM_OWNER_BOOTSTRAP_FILE = settingsPath;
  const reports = [], errors = []; let calls = 0, fail = false;
  const runtime = { report: value => reports.push(value), reportError: value => errors.push(value),
    loadOperator: async path => { assert.equal(path, modulePath); return { schema, createConfiguration }; },
    loadRelease: async () => ({ runPrivateOwnerBootstrap: async value => {
      calls++; assert.deepEqual(value, input);
      if (fail) throw new Error(JSON.stringify(input));
      return { ownerCreated: true, applicationInstalled: false, productionReady: false };
    }, startPrivateWebApplication: () => assert.fail('must not install website'),
    startPrivateTaskApplication: () => assert.fail('must not start tasks') }) };
  const args = ['--configuration', modulePath];
  assert.equal(await bootstrapPrivateVpsOwner(args, runtime), 0); assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(reports[0]), { ownerCreated: true, applicationInstalled: false, productionReady: false });
  fail = true; const count = reports.length;
  assert.equal(await bootstrapPrivateVpsOwner(args, runtime), 1); assert.equal(calls, 2); assert.equal(reports.length, count);
  await chmod(settingsPath, 0o644);
  assert.equal(await bootstrapPrivateVpsOwner(args, runtime), 1); assert.equal(calls, 2); assert.equal(reports.length, count);
  await chmod(settingsPath, 0o600); await writeFile(settingsPath, '{invalid-json');
  assert.equal(await bootstrapPrivateVpsOwner(args, runtime), 1); assert.equal(calls, 2);
  assert.equal(new Set(errors).size, 1);
  assert.doesNotMatch([...errors, ...reports].join('\n'), /synthetic-private|invalid-json|settings\.json/);
});
