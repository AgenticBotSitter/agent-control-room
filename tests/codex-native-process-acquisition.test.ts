import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmod,
  chmodSync,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  renameSync,
  rm,
  symlink,
  writeFile,
  writeFileSync,
} from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import {
  createCodexAppServerProcessSessionV1,
  type CodexAppServerProcessBindingV1,
} from '../src/harness/codex-v1/app-server-process-session';
import type { OwnedCodexStartConnectionV1 } from '../src/harness/codex-v1/owned-start';
import { CODEX_APP_SERVER_START_CONTRACT } from '../src/harness/codex-v1/schema-contract';
import {
  CODEX_APP_SERVER_ARGUMENTS_V1,
  CODEX_EXECUTABLE_DESCRIPTOR_PATH_V1,
  createCodexNativeProcessAcquisitionForTestV1,
  createCodexNativeProcessAcquisitionV1,
  type CodexNativeProcessConfigurationV1,
  type LaunchCodexNativeProcessV1,
} from '../src/node-bridge/codex-native-process';

const mkdirAsync = promisify(mkdir);
const mkdtempAsync = promisify(mkdtemp);
const realpathAsync = promisify(realpath);
const readFileAsync = promisify(readFile);
const rmAsync = promisify(rm);
const symlinkAsync = promisify(symlink);
const writeFileAsync = promisify(writeFile);
const chmodAsync = promisify(chmod);
const NOW = Date.UTC(2026, 8, 13, 12);
let sequence = 0;

function binding(): CodexAppServerProcessBindingV1 {
  sequence += 1;
  return Object.freeze({
    mode: 'initial' as const,
    connectionAttemptId: 'connection-attempt:native-' + sequence,
    initializedConnectionDigest: 'sha256:' + String(sequence).padStart(64, '0'),
    threadStartRequestId: sequence * 2 + 1,
    turnStartRequestId: sequence * 2 + 2,
  });
}

async function nativeFixture(t: TestContext, options: {
  digest?: string;
  executablePath?: (directory: string, executable: string) => Promise<string>;
  clock?: () => number;
  startupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
} = {}) {
  const directory = await realpathAsync(await mkdtempAsync(join(tmpdir(), 'cr-codex-native-')));
  t.after(async () => { await rmAsync(directory, { recursive: true, force: true }); });
  const workspace = join(directory, 'workspaces', 'selected');
  const codexHome = join(directory, 'codex-home');
  await mkdirAsync(workspace, { recursive: true });
  await mkdirAsync(codexHome, { recursive: true });
  const executable = join(directory, 'codex-reviewed');
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(process.arch === 'arm64' ? 0xb7 : 0x3e, 18);
  await writeFileAsync(executable, bytes, { mode: 0o755 });
  await chmodAsync(executable, 0o755);
  const executablePath = options.executablePath
    ? await options.executablePath(directory, executable)
    : executable;
  const selectedBinding = binding();
  const digest = options.digest ?? ('sha256:' + createHash('sha256').update(bytes).digest('hex'));
  const config: CodexNativeProcessConfigurationV1 = {
    executablePath,
    executableSha256: digest,
    appServerVersion: CODEX_APP_SERVER_START_CONTRACT.version,
    reviewedPlatform: 'linux',
    reviewedArchitecture: process.arch as 'x64' | 'arm64',
    ownerEuid: process.geteuid?.() ?? -1,
    fixedArguments: ['app-server'],
    approvedWorkspaceRoot: join(directory, 'workspaces'),
    workspacePath: workspace,
    environment: Object.freeze({
      NODE_ENV: 'production' as const,
      CODEX_HOME: codexHome,
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
    }),
    validFrom: new Date(NOW - 1_000).toISOString(),
    validUntil: new Date(NOW + 1_000).toISOString(),
    startupTimeoutMs: options.startupTimeoutMs ?? 100,
    cleanupTimeoutMs: options.cleanupTimeoutMs ?? 100,
    expectedBinding: selectedBinding,
    assertCurrent(permit) {
      assert.deepEqual(permit.binding, selectedBinding);
      assert.equal(permit.workspacePath, workspace);
      assert.equal(permit.executableSha256, digest);
      assert.equal(permit.environment.CODEX_HOME, codexHome);
    },
    clock: options.clock ?? (() => NOW),
  };
  return { directory, executable, workspace, codexHome, selectedBinding, config };
}

function fakeChild(options: {
  autoSpawn?: boolean;
  killOutcome?: boolean;
  malformedStreams?: boolean;
  writeError?: Error;
} = {}) {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let kills = 0;
  const signals: string[] = [];
  let exited = false;
  if (options.writeError) {
    const error = options.writeError;
    stdin.write = ((_: unknown, callback?: (failure?: Error | null) => void) => {
      queueMicrotask(() => callback?.(error));
      return false;
    }) as typeof stdin.write;
  }
  emitter.stdin = stdin;
  emitter.stdout = options.malformedStreams ? undefined : stdout;
  emitter.stderr = stderr;
  emitter.kill = ((signal: string) => {
    assert.ok(signal === 'SIGTERM' || signal === 'SIGKILL');
    signals.push(signal);
    kills += 1;
    const outcome = options.killOutcome ?? true;
    if (outcome && !exited) {
      exited = true;
      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        emitter.emit('exit', null, 'SIGTERM');
      });
    }
    return outcome;
  });
  const scheduleSpawn = () => {
    if (options.autoSpawn === false) return;
    queueMicrotask(() => emitter.emit('spawn'));
  };
  return {
    child: emitter as unknown as ReturnType<LaunchCodexNativeProcessV1>,
    stdin,
    stdout,
    stderr,
    scheduleSpawn,
    kills: () => kills,
    signals: () => [...signals],
  };
}

test('native acquisition is inert and launches the reviewed command once with only the explicit environment', async t => {
  const fixture = await nativeFixture(t);
  const launched: Array<{ executable: string; args: readonly string[]; options: Parameters<LaunchCodexNativeProcessV1>[2] }> = [];
  const child = fakeChild();
  const launcher: LaunchCodexNativeProcessV1 = (executable, args, options) => {
    launched.push({ executable, args, options });
    child.scheduleSpawn();
    queueMicrotask(() => {
      child.stderr.write('synthetic credential-shaped stderr must not escape\n');
      child.stdout.write('{"id":1,"result":{}}\n');
    });
    return child.child;
  };
  const acquisition = createCodexNativeProcessAcquisitionForTestV1(fixture.config, launcher);
  assert.equal(launched.length, 0);
  const session = createCodexAppServerProcessSessionV1({
    binding: fixture.selectedBinding,
    signal: new AbortController().signal,
    acquire: acquisition.acquire,
    cleanupMs: 200,
  }) as OwnedCodexStartConnectionV1;
  const wire = await session.ready;
  assert.equal(await wire.readLine(new AbortController().signal), '{"id":1,"result":{}}');
  assert.equal(launched.length, 1);
  assert.equal(launched[0]?.executable, CODEX_EXECUTABLE_DESCRIPTOR_PATH_V1);
  assert.deepEqual(launched[0]?.args, CODEX_APP_SERVER_ARGUMENTS_V1);
  assert.equal(launched[0]?.options.cwd, fixture.workspace);
  assert.deepEqual(launched[0]?.options.env, {
    NODE_ENV: 'production',
    CODEX_HOME: fixture.codexHome,
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
  });
  assert.equal(launched[0]?.options.shell, false);
  assert.equal(launched[0]?.options.windowsHide, true);
  assert.deepEqual(launched[0]?.options.stdio.slice(0, 3), ['pipe', 'pipe', 'pipe']);
  assert.ok(Number.isSafeInteger(launched[0]?.options.stdio[3]));
  assert.equal(Object.hasOwn(launched[0]?.options.env ?? {}, 'PATH'), false);
  await session.close();
  assert.equal(child.kills(), 1);
});

test('Linux production factory executes the verified descriptor rather than reopening its source path', {
  skip: process.platform !== 'linux' || !process.geteuid,
}, async t => {
  const fixture = await nativeFixture(t);
  const executable = await realpathAsync('/usr/bin/true');
  const bytes = await readFileAsync(executable);
  const config: CodexNativeProcessConfigurationV1 = {
    ...fixture.config,
    executablePath: executable,
    executableSha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    assertCurrent(permit) {
      assert.equal(permit.executablePath, executable);
      assert.equal(permit.reviewedPlatform, 'linux');
    },
  };
  const acquisition = createCodexNativeProcessAcquisitionV1(config);
  const owner = acquisition.acquire(fixture.selectedBinding, new AbortController().signal);
  const port = await owner.ready;
  assert.deepEqual(await port.exited, { code: 0, signal: null });
  await owner.close();
});

test('digest mismatch and symlink executable refuse before launch', async t => {
  const wrong = await nativeFixture(t, { digest: 'sha256:' + 'f'.repeat(64) });
  let launches = 0;
  const badDigest = createCodexNativeProcessAcquisitionForTestV1(wrong.config, () => {
    launches += 1;
    return fakeChild().child;
  });
  const digestOwner = badDigest.acquire(wrong.selectedBinding, new AbortController().signal);
  await assert.rejects(digestOwner.ready, /native_process_unavailable/);
  assert.equal(launches, 0);

  const linked = await nativeFixture(t, {
    executablePath: async (directory, executable) => {
      const link = join(directory, 'codex-link');
      await symlinkAsync(executable, link);
      return link;
    },
  });
  const symlinkPort = createCodexNativeProcessAcquisitionForTestV1(linked.config, () => {
    launches += 1;
    return fakeChild().child;
  });
  const linkOwner = symlinkPort.acquire(linked.selectedBinding, new AbortController().signal);
  await assert.rejects(linkOwner.ready, /native_process_unavailable/);
  assert.equal(launches, 0);
});

test('replacement between verification and spawn is detected and the one launched child is retired', async t => {
  const fixture = await nativeFixture(t);
  const child = fakeChild();
  let launches = 0;
  const acquisition = createCodexNativeProcessAcquisitionForTestV1(fixture.config, () => {
    launches += 1;
    renameSync(fixture.executable, fixture.executable + '.replaced');
    writeFileSync(fixture.executable, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    chmodSync(fixture.executable, 0o755);
    child.scheduleSpawn();
    return child.child;
  });
  const owner = acquisition.acquire(fixture.selectedBinding, new AbortController().signal);
  await assert.rejects(owner.ready, /native_process_unavailable/);
  await owner.close();
  assert.equal(launches, 1);
  assert.equal(child.kills(), 1);
});

test('mismatch, expiry, pre-abort, duplicate, and post-close paths launch zero additional children', async t => {
  const fixture = await nativeFixture(t);
  const child = fakeChild();
  let launches = 0;
  const acquisition = createCodexNativeProcessAcquisitionForTestV1(fixture.config, () => {
    launches += 1;
    child.scheduleSpawn();
    return child.child;
  });
  assert.throws(() => acquisition.acquire(binding(), new AbortController().signal), /native_process_unavailable/);
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() => acquisition.acquire(fixture.selectedBinding, aborted.signal), /native_process_unavailable/);
  const owner = acquisition.acquire(fixture.selectedBinding, new AbortController().signal);
  await owner.ready;
  assert.throws(() => acquisition.acquire(fixture.selectedBinding, new AbortController().signal), /native_process_unavailable/);
  assert.equal(launches, 1);
  await owner.close();

  const expired = await nativeFixture(t, { clock: () => NOW + 2_000 });
  let expiredLaunches = 0;
  const expiredPort = createCodexNativeProcessAcquisitionForTestV1(expired.config, () => {
    expiredLaunches += 1;
    return fakeChild().child;
  });
  assert.throws(() => expiredPort.acquire(expired.selectedBinding, new AbortController().signal), /native_process_unavailable/);
  await expiredPort.close();
  assert.throws(() => expiredPort.acquire(expired.selectedBinding, new AbortController().signal), /native_process_unavailable/);
  assert.equal(expiredLaunches, 0);
});

test('close before asynchronous verification settles guarantees zero launch', async t => {
  const fixture = await nativeFixture(t);
  let launches = 0;
  const acquisition = createCodexNativeProcessAcquisitionForTestV1(fixture.config, () => {
    launches += 1;
    return fakeChild().child;
  });
  const owner = acquisition.acquire(fixture.selectedBinding, new AbortController().signal);
  const closing = owner.close();
  await assert.rejects(owner.ready, /native_process_unavailable/);
  await closing;
  assert.equal(launches, 0);
});

test('workspace symlink and replacement cannot escape the reviewed canonical directory', async t => {
  const linkedFixture = await nativeFixture(t);
  const outside = join(linkedFixture.directory, 'outside');
  const linkedWorkspace = join(linkedFixture.directory, 'workspaces', 'linked');
  await mkdirAsync(outside);
  await symlinkAsync(outside, linkedWorkspace);
  let linkLaunches = 0;
  const linkedConfig: CodexNativeProcessConfigurationV1 = {
    ...linkedFixture.config,
    workspacePath: linkedWorkspace,
    assertCurrent() {},
  };
  const linked = createCodexNativeProcessAcquisitionForTestV1(linkedConfig, () => {
    linkLaunches += 1;
    return fakeChild().child;
  });
  const linkedOwner = linked.acquire(linkedFixture.selectedBinding, new AbortController().signal);
  await assert.rejects(linkedOwner.ready, /native_process_unavailable/);
  assert.equal(linkLaunches, 0);

  const replacedFixture = await nativeFixture(t);
  const replacedChild = fakeChild();
  let replacementLaunches = 0;
  const replaced = createCodexNativeProcessAcquisitionForTestV1(replacedFixture.config, () => {
    replacementLaunches += 1;
    renameSync(replacedFixture.workspace, replacedFixture.workspace + '.replaced');
    mkdir(replacedFixture.workspace, { recursive: true }, () => replacedChild.scheduleSpawn());
    return replacedChild.child;
  });
  const replacedOwner = replaced.acquire(replacedFixture.selectedBinding, new AbortController().signal);
  await assert.rejects(replacedOwner.ready, /native_process_unavailable/);
  await replacedOwner.close();
  assert.equal(replacementLaunches, 1);
  assert.equal(replacedChild.kills(), 1);
});

test('abort and authority expiry after launch but before admission retire the child', async t => {
  const abortedFixture = await nativeFixture(t);
  const child = fakeChild({ autoSpawn: false });
  const operation = new AbortController();
  let didLaunch: () => void = () => {};
  const launched = new Promise<void>(resolve => { didLaunch = resolve; });
  const acquisition = createCodexNativeProcessAcquisitionForTestV1(abortedFixture.config, () => {
    didLaunch();
    return child.child;
  });
  const owner = acquisition.acquire(abortedFixture.selectedBinding, operation.signal);
  await launched;
  operation.abort();
  await assert.rejects(owner.ready, /native_process_unavailable/);
  await owner.close();
  assert.equal(child.kills(), 1);

  const clockValues = [NOW, NOW, NOW, NOW, NOW, NOW + 2_000];
  const expiringFixture = await nativeFixture(t, { clock: () => clockValues.shift() ?? NOW + 2_000 });
  const expiringChild = fakeChild();
  const expiring = createCodexNativeProcessAcquisitionForTestV1(expiringFixture.config, () => {
    expiringChild.scheduleSpawn();
    return expiringChild.child;
  });
  const expiringOwner = expiring.acquire(expiringFixture.selectedBinding, new AbortController().signal);
  await assert.rejects(expiringOwner.ready, /native_process_unavailable/);
  await expiringOwner.close();
  assert.equal(expiringChild.kills(), 1);
});

test('caller cancellation remains attached after ready and retires the live child', async t => {
  const fixture = await nativeFixture(t);
  const child = fakeChild();
  const operation = new AbortController();
  const acquisition = createCodexNativeProcessAcquisitionForTestV1(fixture.config, () => {
    child.scheduleSpawn();
    return child.child;
  });
  const owner = acquisition.acquire(fixture.selectedBinding, operation.signal);
  await owner.ready;
  operation.abort();
  await owner.close();
  assert.equal(child.kills(), 1);
});

test('write failure is withheld and malformed streams or uncertain retirement fail closed', async t => {
  const writeFixture = await nativeFixture(t);
  const writeChild = fakeChild({ writeError: new Error('synthetic stdin detail') });
  const writeAcquisition = createCodexNativeProcessAcquisitionForTestV1(writeFixture.config, () => {
    writeChild.scheduleSpawn();
    return writeChild.child;
  });
  const writeOwner = writeAcquisition.acquire(writeFixture.selectedBinding, new AbortController().signal);
  const port = await writeOwner.ready;
  await assert.rejects(
    port.writeStdin(new Uint8Array([1]), new AbortController().signal),
    error => {
      assert.doesNotMatch(String(error), /synthetic stdin detail/);
      return /native_process_unavailable/.test(String(error));
    },
  );
  await writeOwner.close();

  const malformedFixture = await nativeFixture(t);
  const malformedChild = fakeChild({ malformedStreams: true });
  const malformed = createCodexNativeProcessAcquisitionForTestV1(malformedFixture.config, () => malformedChild.child);
  const malformedOwner = malformed.acquire(malformedFixture.selectedBinding, new AbortController().signal);
  await assert.rejects(malformedOwner.ready, /native_process_unavailable/);
  await assert.rejects(malformedOwner.close(), /cleanup_uncertain/);

  const uncertainFixture = await nativeFixture(t, { startupTimeoutMs: 10, cleanupTimeoutMs: 10 });
  const uncertainChild = fakeChild({ autoSpawn: false, killOutcome: false });
  const uncertain = createCodexNativeProcessAcquisitionForTestV1(uncertainFixture.config, () => uncertainChild.child);
  const uncertainOwner = uncertain.acquire(uncertainFixture.selectedBinding, new AbortController().signal);
  await assert.rejects(uncertainOwner.ready, /native_process_unavailable/);
  await assert.rejects(uncertainOwner.close(), /cleanup_uncertain/);
  assert.deepEqual(uncertainChild.signals(), ['SIGTERM', 'SIGKILL']);
});
