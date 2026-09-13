import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openPrivateCodexConfigurationV1,
  validatePrivateCodexStatePathsV1 } from '../src/node-bridge/private-codex-configuration';
import { codexTaskRunIdV1 } from '../src/harness/codex-v1/delivery-contract';
import { sha256Digest } from '../src/security/canonical-digest';

async function stateFiles() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-private-codex-')));
  await chmod(directory, 0o700);
  const paths = { bridge: join(directory, 'bridge.sqlite'), starts: join(directory, 'starts.sqlite') };
  await writeFile(paths.bridge, '', { mode: 0o600 }); await writeFile(paths.starts, '', { mode: 0o600 });
  return { directory, paths };
}

function initialInput(paths: { bridge: string; starts: string }) {
  const basis = { tenantId: 'tenant:test', nodeId: 'node:test', projectId: 'project:test',
    jobId: 'job:test', attemptId: 'attempt:test', leaseId: 'lease:test', leaseEpoch: 1 };
  const runId = codexTaskRunIdV1(basis);
  return { mode: 'initial' as const, paths, runId, queueId: 'queue:test',
    connectionAttemptId: 'connection-attempt:private-config', initializedConnectionDigest: sha256Digest('initialized'),
    threadStartRequestId: 10, turnStartRequestId: 20, startTimeoutMs: 1_000, processCleanupTimeoutMs: 100,
    workspaceIntent: { schema: 'control-room.workspace-intent/v1', ...basis, runId,
      repositoryRoot: '/synthetic/repository', workspaceRoot: '/synthetic/workspaces',
      checkoutPath: `/synthetic/workspaces/codex-${sha256Digest(runId).slice(7,31)}`, revision: 'a'.repeat(40) } };
}

test('private Codex configuration requires pre-created distinct owner-only state files', async t => {
  const f = await stateFiles(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  assert.deepEqual(validatePrivateCodexStatePathsV1(f.paths), f.paths);
  assert.throws(() => validatePrivateCodexStatePathsV1({ bridge: f.paths.bridge, starts: f.paths.bridge }), /unavailable/);
  await chmod(f.paths.starts, 0o644);
  assert.throws(() => validatePrivateCodexStatePathsV1(f.paths), /unavailable/);
});

test('private Codex configuration opens one selected mode with no default native or workspace port', async t => {
  const f = await stateFiles(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const input = initialInput(f.paths); let sessions = 0, workspaceEffects = 0;
  const owner = openPrivateCodexConfigurationV1(input, {
    authority: { currentAdmissionDigest: () => sha256Digest('admission'), assertCurrent() {} },
    workspacePort: { inspectRootIdentities: async () => { workspaceEffects++; throw new Error(); },
      inspectExisting: async () => { workspaceEffects++; throw new Error(); },
      observeCheckout: async () => { workspaceEffects++; throw new Error(); },
      createDetachedWorktree: async () => { workspaceEffects++; throw new Error(); },
      removeWorktree: async () => { workspaceEffects++; } },
    acquireProcess() { sessions++; throw new Error(); }, clock: () => Date.now(),
  }, new AbortController().signal);
  assert.equal(owner.harness, 'codex-local-v1'); assert.equal(owner.mode, 'initial');
  await assert.rejects(owner.run(new AbortController().signal), /codex_local_host_unavailable/);
  assert.equal(sessions, 0); assert.equal(workspaceEffects, 0);
  await owner.close(); await owner.close();

  const second = await stateFiles(); t.after(() => rm(second.directory, { recursive: true, force: true }));
  assert.throws(() => openPrivateCodexConfigurationV1({ ...initialInput(second.paths), startTimeoutMs: undefined as never }, {
    authority: { currentAdmissionDigest: () => sha256Digest('admission'), assertCurrent() {} },
    workspacePort: {} as never, acquireProcess: () => { throw new Error(); }, clock: () => Date.now(),
  }, new AbortController().signal), /private_codex_configuration_unavailable/);
});
