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
  assert.equal(typeof release.openOwnedPrivateCodexConfigurationV1, 'function');
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

test('private node launcher accepts one bounded Codex observation without loading a provider connector', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-built-codex-host-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'operator.mjs'); await writeFile(path, '// synthetic fixture', { mode: 0o600 });
  const reports = [], errors = [], signals = new EventEmitter(); let runs = 0, closes = 0;
  const code = await runPrivateNode(['--configuration', path, '--mode', 'recover'], {
    signals, report: value => reports.push(value), reportError: value => errors.push(value),
    async loadRelease() { assert.fail('Codex local host must not load the Hermes/provider connector'); },
    async loadOperator() { return { schema: 'control-room.private-node-configuration/v1', async createConfiguration({ mode }) {
      assert.equal(mode, 'recover');
      return { harness: 'codex-local-v1', mode, async run() { runs++; return {
        disposition: 'observed', mode: 'recover', status: 'completed',
        identity: { runId: 'private:must-not-log', threadId: 'private:must-not-log', turnId: 'private:must-not-log' },
        canonicalPublicationAllowed: false, completionVerified: false, grantsExecutionAuthority: false,
        permitsRetry: false, permitsResume: false, permitsNewTurn: false,
        writesResult: false, writesArtifact: false, writesReview: false, releasesCapacity: false,
      }; }, async close() { closes++; } };
    } }; },
  });
  assert.equal(code, 0); assert.equal(runs, 1); assert.equal(closes, 1); assert.deepEqual(errors, []);
  assert.deepEqual(reports, ['Control Room Codex host returned a noncanonical observation and closed. No result, artifact or review was published.']);
  assert.doesNotMatch(JSON.stringify(reports), /private:must-not-log/);
  assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
});
