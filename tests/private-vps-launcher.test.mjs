import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePrivateVpsArguments, requirePrivateVpsMode, validatePrivateVpsConfigurationPath } from '../scripts/run-private-vps.mjs';

test('launcher requires exact explicit absolute configuration or help', () => {
  assert.deepEqual(parsePrivateVpsArguments(['--help']), { help: true });
  assert.deepEqual(parsePrivateVpsArguments(['--configuration', '/synthetic/operator.mjs']),
    { configurationPath: '/synthetic/operator.mjs' });
  for (const args of [[], ['--configuration', 'relative.mjs'], ['--configuration', '/x.json'],
    ['--help', '--start'], ['--configuration', '/x.mjs', '--force'], ['--configuration', '/x\n.mjs']]) {
    assert.throws(() => parsePrivateVpsArguments(args), /private_vps_arguments_invalid/);
  }
});

test('operator mode cannot silently enable workers or accept an incomplete agent setup', () => {
  const website = { mode: 'website-only', configuration: { coordinator: {} } };
  assert.equal(requirePrivateVpsMode(website), 'website-only');
  assert.throws(() => requirePrivateVpsMode({ configuration: website.configuration }));
  for (const field of ['nativeQueue', 'queueWorker', 'nativeHttp']) {
    assert.throws(() => requirePrivateVpsMode({ ...website, configuration: { coordinator: { [field]: true } } }));
  }
  assert.throws(() => requirePrivateVpsMode({ ...website, nativeHttps: {} }));
  for (const value of [{}, undefined]) {
    assert.throws(() => requirePrivateVpsMode({ ...website, configuration: { coordinator: { ideaRuntime: value } } }));
    assert.throws(() => requirePrivateVpsMode({ ...website, configuration: { coordinator: {}, news: value } }));
  }
  assert.equal(requirePrivateVpsMode({ ...website, configuration: { web: { ideaProjects: {}, news: {} },
    coordinator: { ideaCreation: {} } } }), 'website-only');
  const coordinator = { nativeQueue: true, nativeQueueRecovery: true, revisionPlanning: true,
    queueWorker: {}, nativeHttp: {}, approvals: {}, quality: {}, resultDatabase: {}, evidence: {}, sessions: {} };
  const agent = { mode: 'agent-tasks', nativeHttps: {}, configuration: { coordinator } };
  // Presence is not resource validity; the real bootstrap must still reject these empty objects.
  assert.equal(requirePrivateVpsMode(agent), 'agent-tasks');
  for (const field of Object.keys(coordinator)) {
    const incomplete = { ...coordinator }; delete incomplete[field];
    assert.throws(() => requirePrivateVpsMode({ ...agent, configuration: { coordinator: incomplete } }), field);
  }
  assert.throws(() => requirePrivateVpsMode({ ...agent, nativeHttps: undefined }));
});

test('actual help and invalid-input commands exit without compiled startup or configuration', () => {
  const script = fileURLToPath(new URL('../scripts/run-private-vps.mjs', import.meta.url));
  for (const args of [['--help'], []]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, args.length ? 0 : 1);
    assert.doesNotMatch(result.stdout, /host ready/);
    if (args.length) assert.match(result.stdout, /Requires approved operator setup/);
    else assert.equal(result.stderr.trim(), 'Control Room launcher refused setup.');
  }
});

test('configuration path checks reject shared-readable files and symlinks without importing code', { skip: typeof process.getuid !== 'function' }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-launcher-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'operator.mjs');
  await writeFile(path, 'throw new Error("This fixture must never be imported");', { mode: 0o600 });
  await validatePrivateVpsConfigurationPath(path);
  await chmod(path, 0o644);
  await assert.rejects(validatePrivateVpsConfigurationPath(path), /private_vps_configuration_invalid/);
  await chmod(path, 0o600);
  const link = join(directory, 'link.mjs'); await symlink(path, link);
  await assert.rejects(validatePrivateVpsConfigurationPath(link), /private_vps_configuration_invalid/);
  await assert.rejects(validatePrivateVpsConfigurationPath(directory), /private_vps_configuration_invalid/);
});
