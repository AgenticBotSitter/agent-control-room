import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPrivateNode } from '../scripts/run-private-node.mjs';
import { nativeNodeRuntimeFixture } from './helpers/native-node-runtime.ts';

// Actual compiled runtime and HTTPS connector, but intentionally denied by the
// supplied current-authority guard before DNS, TLS, credentials or native calls.
test('compiled one-task entry composes actual components and closes denied synthetic setup', async t => {
  const release = await import('../dist-vps/server/nodeConnector.js');
  const f = await nativeNodeRuntimeFixture();
  t.after(() => f.close());
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-built-node-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'operator.mjs'); await writeFile(path, '// synthetic fixture', { mode: 0o600 });
  let closes = 0, guards = 0, credentials = 0, constructed = 0;
  const errors = [], signals = new EventEmitter();
  const code = await runPrivateNode(['--configuration', path, '--mode', 'initial'], {
    signals, report() { assert.fail('denial cannot be success'); }, reportError: value => errors.push(value),
    async loadRelease() { return {
      createNativeNodeRuntime(...args) { constructed++; return release.createNativeNodeRuntime(...args); },
      createNativeHttpsConnector: release.createNativeHttpsConnector,
    }; },
    async loadOperator() { return { schema: 'control-room.private-node-configuration/v1', async createConfiguration() {
      return { harness: 'hermes-native-v1', node: f.config, dependencies: f.dependencies,
        https: { canonicalDestination: 'https://native.example.test:443', connectorCredentialRef: 'credential:synthetic',
          serverCertificateDigest: `sha256:${'a'.repeat(64)}`, serverCa: 'synthetic CA material only' },
        settings: { maxCycles: 1, intervalMs: 1, timeoutMs: 1000 },
        sources: { assertCurrent() { guards++; throw new Error('synthetic revoked authority'); },
          async credential() { credentials++; assert.fail('no credentials'); } },
        async close() { closes++; },
      };
    } }; },
  });
  assert.equal(code, 1); assert.equal(constructed, 1); assert.equal(guards, 1);
  assert.equal(credentials, 0); assert.equal(closes, 1); assert.deepEqual(f.x.local.calls, []);
  assert.doesNotMatch(JSON.stringify(errors), /revoked authority|native.example|credential:synthetic/);
  assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
});
