import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openOwnedPrivateCodexConfigurationV1, openPrivateCodexConfigurationV1,
  validatePrivateCodexStatePathsV1 } from '../src/node-bridge/private-codex-configuration';
import { CODEX_APP_SERVER_READ_CONTRACT } from '../src/harness/codex-v1/schema-contract';
import { SqliteCodexStartJournalV1 } from '../src/harness/codex-v1/start-journal';
import type { CodexAppServerProcessBindingV1,
  CodexAppServerProcessBytePortV1 } from '../src/harness/codex-v1/app-server-process-session';
import type { CodexNativeProcessAcquisitionV1 } from '../src/node-bridge/codex-native-process';
import { SqliteBridgeJournal } from '../src/node-bridge/journal';
import { codexTaskRunIdV1 } from '../src/harness/codex-v1/delivery-contract';
import { sha256Digest } from '../src/security/canonical-digest';
import { createWorkerLifecycleFixture, recordSyntheticLifecycle } from './helpers/private-worker-lifecycle';

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

function initialPorts() {
  return {
    authority: { currentAdmissionDigest: () => sha256Digest('admission'), assertCurrent() {} },
    workspacePort: { inspectRootIdentities: async () => { throw new Error('synthetic_unavailable'); },
      inspectExisting: async () => { throw new Error('synthetic_unavailable'); },
      observeCheckout: async () => { throw new Error('synthetic_unavailable'); },
      createDetachedWorktree: async () => { throw new Error('synthetic_unavailable'); },
      async removeWorktree() {} },
    clock: () => Date.now(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function recoverInput(paths: { bridge: string; starts: string }, runId: string) {
  return { mode: 'recover' as const, paths, runId,
    connectionAttemptId: 'connection-attempt:private-owned-recover',
    initializedConnectionDigest: sha256Digest('private-owned-recover'), readTimeoutMs: 1_000,
    cleanupTimeoutMs: 200, processCleanupTimeoutMs: 100 };
}

function recoverAcquisition(saved: { runId: string; threadId: string; turnId: string },
  events: string[], options: { pendingReady?: boolean; failAcquire?: boolean; failClose?: boolean;
    hangSessionClose?: boolean } = {}) {
  const acquired = deferred<void>(); let reads = 0;
  const responses = ['{"id":1,"result":{}}', JSON.stringify({ id: 2, result: { thread: {
    id: saved.threadId, cliVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
    turns: [{ id: saved.turnId, status: 'completed', itemsView: 'full', items: [] }] } } })];
  const acquisition: CodexNativeProcessAcquisitionV1 = {
    acquire(binding: CodexAppServerProcessBindingV1) {
      events.push('acquire'); acquired.resolve();
      assert.equal(this, acquisition); assert.deepEqual(binding, { mode: 'recover', runId: saved.runId,
        connectionAttemptId: 'connection-attempt:private-owned-recover',
        initializedConnectionDigest: sha256Digest('private-owned-recover'),
        threadId: saved.threadId, turnId: saved.turnId });
      if (options.failAcquire) throw new Error('synthetic_private_acquisition_secret');
      let finish!: (value: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { finish = resolve; });
      let endStdout!: () => void;
      const stdoutEnded = new Promise<undefined>(resolve => { endStdout = () => resolve(undefined); });
      const port: CodexAppServerProcessBytePortV1 = { async writeStdin() {}, async readStdout() {
        const line = responses[reads++]; return line === undefined ? stdoutEnded : new TextEncoder().encode(`${line}\n`);
      }, async readStderr() { return undefined; }, async closeStdin() { events.push('close-stdin'); },
      async terminate() { events.push('terminate'); endStdout(); finish({ code: null, signal: 'SIGTERM' }); }, exited };
      return { ready: options.pendingReady ? new Promise<CodexAppServerProcessBytePortV1>(() => {}) : Promise.resolve(port),
        async close() { events.push('session-close');
          if (options.hangSessionClose) await new Promise<void>(() => {}); } };
    },
    async close() { events.push('acquisition-close');
      if (options.failClose || options.hangSessionClose) throw new Error('synthetic_private_cleanup_secret'); },
  };
  return { acquisition, acquired: acquired.promise };
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

test('owned private Codex construction is inert in initial and recover modes and closes once before run', async t => {
  const initial = await stateFiles(); t.after(() => rm(initial.directory, { recursive: true, force: true }));
  const initialEvents: string[] = [];
  const initialAcquisition = { acquire() { initialEvents.push('acquire'); throw new Error('must_not_acquire'); },
    async close() { initialEvents.push('acquisition-close'); } };
  const initialOwner = await openOwnedPrivateCodexConfigurationV1(initialInput(initial.paths), initialPorts(),
    initialAcquisition, new AbortController().signal);
  assert.deepEqual(Object.keys(initialOwner).sort(), ['close', 'harness', 'mode', 'run']);
  assert.deepEqual(initialEvents, []); await initialOwner.close(); await initialOwner.close();
  assert.deepEqual(initialEvents, ['acquisition-close']);
  await assert.rejects(initialOwner.run(new AbortController().signal), /private_codex_configuration_unavailable/);

  const recover = await stateFiles(); t.after(() => rm(recover.directory, { recursive: true, force: true }));
  const saved = recordSyntheticLifecycle(recover.paths.starts, 'recorded');
  if (saved.status !== 'recorded') assert.fail('synthetic recorded lifecycle required');
  const recoverEvents: string[] = [], port = recoverAcquisition(saved, recoverEvents);
  const recoverOwner = await openOwnedPrivateCodexConfigurationV1(recoverInput(recover.paths, saved.runId),
    { authority: { assertCurrent() {} } }, port.acquisition, new AbortController().signal);
  assert.equal(recoverOwner.mode, 'recover'); assert.deepEqual(recoverEvents, []);
  const observation = await recoverOwner.run(new AbortController().signal);
  assert.equal(observation.mode, 'recover'); assert.equal(observation.status, 'completed');
  assert.deepEqual(recoverEvents, ['acquire', 'close-stdin', 'terminate', 'session-close']);
  await recoverOwner.close(); assert.deepEqual(recoverEvents,
    ['acquire', 'close-stdin', 'terminate', 'session-close', 'acquisition-close']);
});

test('owned recovery binds the exact acquisition and closes its session before the acquisition owner', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-private-owned-recover-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await createWorkerLifecycleFixture(directory);
  const saved = recordSyntheticLifecycle(fixture.startPath, 'recorded');
  if (saved.status !== 'recorded') assert.fail('synthetic recorded lifecycle required');
  const paths = { bridge: fixture.bridgePath, starts: fixture.startPath }, events: string[] = [];
  const port = recoverAcquisition(saved, events, { pendingReady: true });
  const owner = await openOwnedPrivateCodexConfigurationV1(recoverInput(paths, saved.runId),
    { authority: { assertCurrent() {} } }, port.acquisition, new AbortController().signal);
  const running = owner.run(new AbortController().signal); await port.acquired;
  await owner.close(); await assert.rejects(running, /private_codex_configuration_unavailable/);
  assert.deepEqual(events, ['acquire', 'session-close', 'acquisition-close']);
});

test('owned close does not deadlock on a stalled session and still attempts later cleanup', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-private-owned-stalled-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await createWorkerLifecycleFixture(directory);
  const saved = recordSyntheticLifecycle(fixture.startPath, 'recorded');
  if (saved.status !== 'recorded') assert.fail('synthetic recorded lifecycle required');
  const events: string[] = [], port = recoverAcquisition(saved, events,
    { pendingReady: true, hangSessionClose: true });
  const owner = await openOwnedPrivateCodexConfigurationV1(recoverInput({
    bridge: fixture.bridgePath, starts: fixture.startPath }, saved.runId),
  { authority: { assertCurrent() {} } }, port.acquisition, new AbortController().signal);
  const running = owner.run(new AbortController().signal); await port.acquired;
  await assert.rejects(owner.close(), /private_codex_configuration_cleanup_uncertain/);
  await assert.rejects(running, /private_codex_configuration_cleanup_uncertain/);
  assert.deepEqual(events, ['acquire', 'session-close', 'acquisition-close']);
});

test('owned run and construction failures sanitize details, close late acquisition, and preserve cleanup uncertainty', async t => {
  const runFixture = await stateFiles(); t.after(() => rm(runFixture.directory, { recursive: true, force: true }));
  const saved = recordSyntheticLifecycle(runFixture.paths.starts, 'recorded');
  if (saved.status !== 'recorded') assert.fail('synthetic recorded lifecycle required');
  const runEvents: string[] = [], failed = recoverAcquisition(saved, runEvents, { failAcquire: true });
  const runOwner = await openOwnedPrivateCodexConfigurationV1(recoverInput(runFixture.paths, saved.runId),
    { authority: { assertCurrent() {} } }, failed.acquisition, new AbortController().signal);
  await assert.rejects(runOwner.run(new AbortController().signal), error => {
    assert.match(String(error), /private_codex_configuration_unavailable/);
    assert.doesNotMatch(String(error), /synthetic|secret/); return true;
  });
  assert.deepEqual(runEvents, ['acquire', 'acquisition-close']);

  const badFixture = await stateFiles(); t.after(() => rm(badFixture.directory, { recursive: true, force: true }));
  const badEvents: string[] = [], uncertain = recoverAcquisition({ runId: 'run:unused',
    threadId: 'thread:unused', turnId: 'turn:unused' }, badEvents, { failClose: true });
  await assert.rejects(openOwnedPrivateCodexConfigurationV1({ ...initialInput(badFixture.paths),
    startTimeoutMs: undefined as never }, initialPorts(), uncertain.acquisition,
  new AbortController().signal), error => {
    assert.match(String(error), /private_codex_configuration_cleanup_uncertain/);
    assert.doesNotMatch(String(error), /synthetic|secret/); return true;
  });
  assert.deepEqual(badEvents, ['acquisition-close']);
});

test('owned close attempts acquisition and both journals once and repeats cleanup uncertainty', async t => {
  const fixture = await stateFiles(); t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const events: string[] = [];
  const startClose = Object.getOwnPropertyDescriptor(SqliteCodexStartJournalV1.prototype, 'close')!;
  const bridgeClose = Object.getOwnPropertyDescriptor(SqliteBridgeJournal.prototype, 'close')!;
  Object.defineProperty(SqliteCodexStartJournalV1.prototype, 'close', { ...startClose,
    value: function(this: SqliteCodexStartJournalV1) {
      events.push('starts-close'); return startClose.value!.call(this); } });
  Object.defineProperty(SqliteBridgeJournal.prototype, 'close', { ...bridgeClose,
    value: function(this: SqliteBridgeJournal) {
      events.push('bridge-close'); return bridgeClose.value!.call(this); } });
  t.after(() => {
    Object.defineProperty(SqliteCodexStartJournalV1.prototype, 'close', startClose);
    Object.defineProperty(SqliteBridgeJournal.prototype, 'close', bridgeClose);
  });
  const acquisition = { acquire() { throw new Error('must_not_acquire'); }, async close() {
    events.push('acquisition-close'); throw new Error('synthetic_private_cleanup_secret'); } };
  const owner = await openOwnedPrivateCodexConfigurationV1(initialInput(fixture.paths), initialPorts(),
    acquisition, new AbortController().signal);
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(owner.close(), error => {
    assert.match(String(error), /private_codex_configuration_cleanup_uncertain/);
    assert.doesNotMatch(String(error), /synthetic|secret/); return true;
  });
  assert.deepEqual(events, ['acquisition-close', 'starts-close', 'bridge-close']);
});
