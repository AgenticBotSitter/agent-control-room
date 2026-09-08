import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePrivateNodeArguments, runPrivateNode } from '../scripts/run-private-node.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-node-launcher-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'operator.mjs');
  await writeFile(path, '// synthetic; injected loader never imports this file', { mode: 0o600 });
  const calls = [], reports = [], errors = [], signals = new EventEmitter();
  const prepared = { harness: 'hermes-native-v1', node: {}, dependencies: {}, https: {}, settings: {}, sources: {},
    async close() { calls.push('resources.close'); } };
  const node = { async close() { calls.push('node.close'); } };
  const connector = { async run(mode, signal) {
    assert.equal(signal.aborted, false); calls.push(`run:${mode}`);
    return { disposition: 'terminal', state: 'completed', cycles: 1 };
  }, async close() { calls.push('connector.close'); await node.close(); } };
  const operator = { schema: 'control-room.private-node-configuration/v1', async createConfiguration({ signal, mode }) {
    assert.equal(signal.aborted, false); assert.ok(['initial', 'recover'].includes(mode)); calls.push('acquire'); return prepared;
  } };
  const release = { createNativeNodeRuntime(config, dependencies) {
    assert.equal(config, prepared.node); assert.equal(dependencies, prepared.dependencies); calls.push('node'); return node;
  }, createNativeHttpsConnector(value, https, settings, sources) {
    assert.equal(value, node); assert.equal(https, prepared.https); assert.equal(settings, prepared.settings);
    assert.equal(sources, prepared.sources); calls.push('connector'); return connector;
  } };
  const runtime = { signals, report: value => reports.push(value), reportError: value => errors.push(value),
    async loadRelease() { return release; }, async loadOperator(value) { assert.equal(value, path); return operator; } };
  const run = (mode = 'initial') => runPrivateNode(['--configuration', path, '--mode', mode], runtime);
  t.after(() => { assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0); });
  return { calls, reports, errors, signals, prepared, node, connector, operator, release, runtime, run };
}

test('exact mode is mandatory; real help is inert without compiled release', () => {
  for (const args of [[], ['--configuration', '/x.mjs'], ['--configuration', '/x.mjs', '--mode', 'auto'],
    ['--configuration', 'x.mjs', '--mode', 'initial'], ['--help', '--mode', 'recover']])
    assert.throws(() => parsePrivateNodeArguments(args));
  const command = fileURLToPath(new URL('../scripts/run-private-node.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0); assert.match(result.stdout, /Never auto-restart/); assert.equal(result.stderr, '');
});

test('initial and recovery each compose once and drain before releasing journals', async t => {
  for (const mode of ['initial', 'recover']) {
    const x = await fixture(t); assert.equal(await x.run(mode), 0);
    assert.deepEqual(x.calls, ['acquire', 'node', 'connector', `run:${mode}`, 'connector.close', 'node.close', 'resources.close']);
    assert.equal(x.reports.length, 1); assert.deepEqual(x.errors, []);
  }
});

test('bounded, ambiguous, and terminal failed work never report completed work or retry', async t => {
  for (const result of [{ disposition: 'bounded', state: 'waiting' }, { disposition: 'uncertain', state: 'ambiguous' },
    { disposition: 'terminal', state: 'failed' }]) {
    const x = await fixture(t); let attempts = 0;
    x.connector.run = async () => { attempts++; return result; };
    assert.equal(await x.run(), 1); assert.equal(attempts, 1); assert.equal(x.reports.length, 0);
    assert.equal(x.calls.at(-1), 'resources.close');
  }
});

test('setup rejection closes acquired resources and never constructs an unsupported harness', async t => {
  const x = await fixture(t); x.prepared.harness = 'codex';
  assert.equal(await x.run(), 1); assert.deepEqual(x.calls, ['acquire', 'resources.close']);
  const y = await fixture(t); y.release.createNativeHttpsConnector = () => { throw new Error('synthetic private details'); };
  assert.equal(await y.run(), 1); assert.deepEqual(y.calls, ['acquire', 'node', 'node.close', 'resources.close']);
  assert.doesNotMatch(JSON.stringify(y.errors), /synthetic private details/);
});

test('SIGTERM stops the one attempt; runtime drain uncertainty preserves owned journals', async t => {
  const x = await fixture(t);
  x.connector.run = async (_mode, signal) => {
    x.signals.emit('SIGTERM'); assert.equal(signal.aborted, true); throw new Error('synthetic');
  };
  x.connector.close = async () => { x.calls.push('uncertain'); throw new Error('synthetic'); };
  assert.equal(await x.run(), 1); assert.deepEqual(x.calls, ['acquire', 'node', 'connector', 'uncertain']);
  assert.match(x.errors[0], /cleanup uncertain/); assert.equal(x.reports.length, 0);
});

test('abort during acquisition still releases late returned resources without constructing node', async t => {
  const x = await fixture(t);
  x.operator.createConfiguration = async ({ signal }) => {
    x.signals.emit('SIGINT'); assert.equal(signal.aborted, true); return x.prepared;
  };
  assert.equal(await x.run(), 1); assert.deepEqual(x.calls, ['resources.close']);
});

test('resource-close timeout reports uncertainty without pretending cleanup stopped', async t => {
  const x = await fixture(t); let entered;
  const closing = new Promise(resolve => { entered = resolve; });
  let finish;
  x.prepared.close = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = x.run(); await closing; t.mock.timers.tick(15_001);
  assert.equal(await run, 1); assert.match(x.errors[0], /cleanup uncertain/);
  assert.equal(x.reports.length, 0); finish();
});
