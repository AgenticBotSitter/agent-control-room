import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPrivateVpsDatabase } from '../scripts/check-private-vps-database.mjs';

test('database-check help and invalid input never require a compiled release or operator settings', () => {
  const script = fileURLToPath(new URL('../scripts/check-private-vps-database.mjs', import.meta.url));
  for (const args of [['--help'], [], ['--configuration', 'relative.mjs'], ['--force']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined); assert.equal(result.status, args[0] === '--help' ? 0 : 1);
    assert.doesNotMatch(result.stdout, /"databasePreflight":"passed"/);
  }
});

test('database check selects only the fixed read-only release operation and sanitizes failures', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-database-check-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'operator.mjs');
  await writeFile(path, '// synthetic inert operator fixture', { mode: 0o600 });
  const reports = [], errors = [], calls = [];
  const web = { synthetic: true };
  let prepared = { mode: 'website-only', configuration: { web } };
  const runtime = {
    report: value => reports.push(value), reportError: value => errors.push(value),
    loadOperator: async value => { assert.equal(value, path); return {
      schema: 'control-room.private-vps-configuration/v1', createConfiguration: async () => prepared,
    }; },
    loadRelease: async () => ({ checkPrivateWebDatabase: async value => {
      calls.push(value); return { databasePreflight: 'passed', listenerStarted: false, productionReady: false };
    }, startPrivateWebApplication: () => { assert.fail('must not install'); } }),
  };
  const args = ['--configuration', path];
  assert.equal(await checkPrivateVpsDatabase(args, runtime), 0);
  assert.deepEqual(calls, [web]); assert.equal(errors.length, 0);
  assert.equal(JSON.parse(reports[0]).listenerStarted, false);
  for (const invalid of [{ mode: 'agent-tasks', configuration: { web } },
    { mode: 'website-only', configuration: { web, coordinator: {} } },
    { mode: 'website-only', configuration: { web, extra: {} } }]) {
    prepared = invalid;
    assert.equal(await checkPrivateVpsDatabase(args, runtime), 1);
  }
  assert.equal(calls.length, 1);
  prepared = { mode: 'website-only', configuration: { web } };
  assert.equal(await checkPrivateVpsDatabase(args, { ...runtime, loadRelease: async () => ({
    checkPrivateWebDatabase: async () => { throw new Error('synthetic credential must not escape'); },
  }) }), 1);
  assert.ok(errors.every(value => value === errors[0]));
  assert.doesNotMatch(errors.join('\n'), /synthetic credential/);
  const authoring = { web, ideaAuthoring: { synthetic: true } };
  prepared = { mode: 'website-only', configuration: authoring };
  let authoringChecks = 0;
  assert.equal(await checkPrivateVpsDatabase(args, { ...runtime, loadRelease: async () => ({
    checkPrivateWebDatabase: () => assert.fail('must check both roles'),
    checkPrivateIdeaAuthoringDatabase: async value => {
      assert.equal(value, authoring); authoringChecks++;
      return { databasePreflight: 'passed', databaseClosed: true, applicationInstalled: false, listenerStarted: false, productionReady: false };
    },
    startPrivateIdeaAuthoringApplication: () => assert.fail('must not install'),
  }) }), 0);
  assert.equal(authoringChecks, 1);
  const coordinator = { nativeQueue: true, nativeQueueRecovery: true, revisionPlanning: true,
    queueWorker: {}, nativeHttp: {}, approvals: {}, quality: {}, resultDatabase: {}, evidence: {}, sessions: {} };
  const tasks = { web, coordinator };
  prepared = { mode: 'agent-tasks', configuration: tasks, nativeHttps: {} };
  let taskChecks = 0;
  const taskRuntime = { ...runtime, loadRelease: async () => ({
    checkPrivateWebDatabase: () => assert.fail('must check configured task roles'),
    checkPrivateTaskDatabase: async value => {
      assert.equal(value, tasks); taskChecks++;
      return { databasePreflight: 'passed', databaseClosed: true, applicationInstalled: false,
        listenerStarted: false, workersStarted: false, productionReady: false };
    },
    startPrivateTaskApplication: () => assert.fail('must not start tasks'),
    createInstalledPrivateTaskHost: () => assert.fail('must not construct host'),
  }) };
  assert.equal(await checkPrivateVpsDatabase(args, taskRuntime), 0);
  assert.equal(taskChecks, 1);
  assert.equal(JSON.parse(reports.at(-1)).workersStarted, false);
  for (const field of Object.keys(coordinator)) {
    const partial = { ...coordinator }; delete partial[field];
    prepared = { mode: 'agent-tasks', configuration: { web, coordinator: partial }, nativeHttps: {} };
    assert.equal(await checkPrivateVpsDatabase(args, taskRuntime), 1, field);
  }
  prepared = { mode: 'agent-tasks', configuration: tasks };
  assert.equal(await checkPrivateVpsDatabase(args, taskRuntime), 1);
  assert.equal(taskChecks, 1);
  prepared = { mode: 'agent-tasks', configuration: tasks, nativeHttps: {} };
  const beforeFailure = reports.length;
  assert.equal(await checkPrivateVpsDatabase(args, { ...taskRuntime, loadRelease: async () => ({
    checkPrivateTaskDatabase: async () => { throw new Error('synthetic task credential must not escape'); },
  }) }), 1);
  assert.equal(reports.length, beforeFailure);
  assert.doesNotMatch(errors.join('\n'), /synthetic task credential/);
});
