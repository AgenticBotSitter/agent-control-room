import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { runPrivateVps } from '../scripts/run-private-vps.mjs';
import * as hostModule from '../dist-vps/server/taskHost.js';
import * as serving from '../dist-vps/server/serving.js';
import * as renderer from '../dist-vps/server/index.js';
import { installPrivateApplication } from '../dist-vps/server/runtime.js';
import { taskStartupFixture } from './helpers/task-startup.ts';
import { instant } from './hermes-native-fixture.ts';

test('launcher runs compiled application/assets and closes through supplied stop events', { skip: typeof process.getuid !== 'function' }, async t => {
  const f = await taskStartupFixture(); t.after(f.close);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-built-launcher-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'operator.mjs');
  await writeFile(path, '// Synthetic path validation only; operator dependency supplied in process.', { mode: 0o600 });
  const signals = new EventEmitter(), server = new EventEmitter();
  let binds = 0, closes = 0, opens = 0;
  server.listen = (options, callback) => { binds++; assert.equal(options.host, '127.0.0.1'); queueMicrotask(callback); return server; };
  server.close = callback => { closes++; queueMicrotask(callback); return server; };
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const messages = [], errors = [];
  const code = await runPrivateVps(['--configuration', path], {
    signals, reportError: message => errors.push(message), report(message) {
      messages.push(message);
      if (message.includes('host ready.')) queueMicrotask(() => signals.emit('SIGTERM'));
    },
    async loadOperator(actual) {
      assert.equal(actual, path);
      assert.equal(signals.listenerCount('SIGTERM'), 1);
      return { schema: 'control-room.private-vps-configuration/v1', createConfiguration: async ({ signal }) => {
        assert.equal(signal.aborted, false); return { mode: 'website-only', configuration: f.config, port: 3210 };
      } };
    },
    async loadRelease() { return [{ ...hostModule, createInstalledPrivateTaskHost: () => hostModule.createPrivateTaskHost({
      openDatabase: config => { opens++; return f.openDatabase(config); }, install: installPrivateApplication,
      clock: () => instant + 8000, createServer: () => server,
    }) }, serving, renderer]; },
  });
  assert.equal(code, 0); assert.deepEqual(errors, []);
  assert.deepEqual(messages, ['Control Room website-only host ready. Agent execution is disabled.', 'Control Room private host closed.']);
  assert.equal(opens, 2); assert.equal(binds, 1); assert.equal(closes, 1);
  assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 1);
  assert.equal(signals.eventNames().length, 0);
});

test('operator failure is sanitized before host creation and removes signal handlers', { skip: typeof process.getuid !== 'function' }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-built-launcher-refusal-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'operator.mjs');
  await writeFile(path, '// No executable fixture needed.', { mode: 0o600 });
  const signals = new EventEmitter(), errors = [], messages = [];
  let hosts = 0;
  const code = await runPrivateVps(['--configuration', path], {
    signals, report: message => messages.push(message), reportError: message => errors.push(message),
    async loadRelease() { return [{ ...hostModule, createInstalledPrivateTaskHost() {
      hosts++; throw new Error('Host must not be created');
    } }, serving, renderer]; },
    async loadOperator() { return { schema: 'control-room.private-vps-configuration/v1', createConfiguration() {
      throw new Error('synthetic confidential configuration detail');
    } }; },
  });
  assert.equal(code, 1); assert.equal(hosts, 0); assert.deepEqual(messages, []);
  assert.deepEqual(errors, ['Control Room startup failed; cleanup may require operator attention.']);
  assert.equal(signals.eventNames().length, 0);
});

test('website-only rejects Idea runtime and news workers before assets, databases or host creation', { skip: typeof process.getuid !== 'function' }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-launcher-mode-refusal-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'operator.mjs');
  await writeFile(path, '// Synthetic configuration; never executed.', { mode: 0o600 });
  for (const configuration of [{ coordinator: { ideaRuntime: {} } }, { coordinator: {}, news: {} }]) {
    const signals = new EventEmitter(), messages = [], errors = [];
    const unexpected = () => { assert.fail('Rejected mode must not acquire runtime resources'); };
    const code = await runPrivateVps(['--configuration', path], {
      signals, report: value => messages.push(value), reportError: value => errors.push(value),
      async loadRelease() { return [{ startPrivateHostLifecycle: hostModule.startPrivateHostLifecycle,
        createInstalledPrivateTaskHost: unexpected }, { loadPrivateClientAssets: unexpected }, renderer]; },
      async loadOperator() { return { schema: 'control-room.private-vps-configuration/v1',
        createConfiguration: async () => ({ mode: 'website-only', port: 3210, configuration }) }; },
    });
    assert.equal(code, 1); assert.deepEqual(messages, []);
    assert.deepEqual(errors, ['Control Room startup failed; cleanup may require operator attention.']);
    assert.equal(signals.eventNames().length, 0);
  }
});
