import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  parseCodexAppServerProcessBindingV1,
  type AcquireCodexAppServerProcessV1,
  type CodexAppServerProcessBindingV1,
  type CodexAppServerProcessBytePortV1,
  type OwnedCodexAppServerProcessV1,
} from '../harness/codex-v1/app-server-process-session';
import { CODEX_APP_SERVER_START_CONTRACT } from '../harness/codex-v1/schema-contract';
import { sha256Digest } from '../security/canonical-digest';
import { assertNoSecretMaterial } from '../security/redaction';
import { assertSynchronousFence } from '../security/synchronous-fence';

export const CODEX_APP_SERVER_ARGUMENTS_V1 = Object.freeze(['app-server'] as const);
export const CODEX_EXECUTABLE_DESCRIPTOR_PATH_V1 = '/proc/self/fd/3' as const;
const MAX_EXECUTABLE_BYTES = 512 * 1_024 * 1_024;
const MAX_TRACKED_BINDINGS = 65_536;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true }).refine(value => new Date(value).toISOString() === value);
const safeValue = z.string().min(1).max(1_024).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const environmentSchema = z.object({
  NODE_ENV: z.literal('production'),
  CODEX_HOME: z.string().min(1).max(4_096),
  LANG: safeValue.optional(),
  LC_ALL: safeValue.optional(),
  NO_COLOR: safeValue.optional(),
  TERM: safeValue.optional(),
}).strict();
const configurationSchema = z.object({
  executablePath: z.string().min(1).max(4_096),
  executableSha256: digest,
  appServerVersion: z.literal(CODEX_APP_SERVER_START_CONTRACT.version),
  reviewedPlatform: z.literal('linux'),
  reviewedArchitecture: z.enum(['x64', 'arm64']),
  ownerEuid: z.number().int().nonnegative(),
  fixedArguments: z.tuple([z.literal('app-server')]),
  approvedWorkspaceRoot: z.string().min(1).max(4_096),
  workspacePath: z.string().min(1).max(4_096),
  environment: environmentSchema,
  validFrom: instant,
  validUntil: instant,
  startupTimeoutMs: z.number().int().min(1).max(30_000),
  cleanupTimeoutMs: z.number().int().min(1).max(5_000),
}).strict();
type ParsedConfiguration = z.infer<typeof configurationSchema>;

export interface CodexNativeProcessConfigurationV1 extends ParsedConfiguration {
  expectedBinding: CodexAppServerProcessBindingV1;
  /** Existing local-host authority fence. It must complete synchronously and return void. */
  assertCurrent(permit: CodexNativeProcessPermitV1): void;
  clock(): number;
}

export interface CodexNativeProcessPermitV1 {
  binding: CodexAppServerProcessBindingV1;
  executablePath: string;
  executableSha256: string;
  appServerVersion: typeof CODEX_APP_SERVER_START_CONTRACT.version;
  reviewedPlatform: 'linux';
  reviewedArchitecture: 'x64' | 'arm64';
  ownerEuid: number;
  fixedArguments: typeof CODEX_APP_SERVER_ARGUMENTS_V1;
  approvedWorkspaceRoot: string;
  workspacePath: string;
  environment: Readonly<ParsedConfiguration['environment']>;
  validFrom: string;
  validUntil: string;
  startupTimeoutMs: number;
  cleanupTimeoutMs: number;
}

type LaunchOptions = Omit<SpawnOptionsWithoutStdio, 'stdio'> & {
  shell: false;
  windowsHide: true;
  stdio: ['pipe', 'pipe', 'pipe', number];
};
export type LaunchCodexNativeProcessV1 = (
  executable: string,
  args: readonly string[],
  options: LaunchOptions,
) => ChildProcessWithoutNullStreams;

export interface CodexNativeProcessAcquisitionV1 {
  acquire: AcquireCodexAppServerProcessV1;
  /** Permanently closes this one-binding acquisition port. */
  close(): Promise<void>;
}

type FileIdentity = Readonly<{
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}>;
type VerifiedExecutable = Readonly<{ handle: FileHandle; identity: FileIdentity }>;
type VerifiedDirectory = Readonly<{ handle: FileHandle; identity: FileIdentity; path: string }>;

const unavailable = () => new Error('codex_native_process_unavailable');
const cleanupUncertain = () => new Error('codex_native_process_cleanup_uncertain');
const startedBindings = new Set<string>();

function configurationFields(input: CodexNativeProcessConfigurationV1): ParsedConfiguration {
  return {
    executablePath: input.executablePath,
    executableSha256: input.executableSha256,
    appServerVersion: input.appServerVersion,
    reviewedPlatform: input.reviewedPlatform,
    reviewedArchitecture: input.reviewedArchitecture,
    ownerEuid: input.ownerEuid,
    fixedArguments: input.fixedArguments,
    approvedWorkspaceRoot: input.approvedWorkspaceRoot,
    workspacePath: input.workspacePath,
    environment: input.environment,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    startupTimeoutMs: input.startupTimeoutMs,
    cleanupTimeoutMs: input.cleanupTimeoutMs,
  };
}

function safeAbsolutePath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw unavailable();
  return value;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function identityOf(value: { dev: number; ino: number; mode: number; size: number; mtimeMs: number; ctimeMs: number }): FileIdentity {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function hashHandle(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.byteLength, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (!bytesRead) throw unavailable();
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return `sha256:${hash.digest('hex')}`;
}

function ownedAndProtected(value: { uid: number; mode: number }, ownerEuid: number): boolean {
  return (value.uid === 0 || value.uid === ownerEuid) && (value.mode & 0o022) === 0;
}

async function verifyExecutable(executablePath: string, expectedDigest: string, ownerEuid: number,
  architecture: 'x64' | 'arm64'): Promise<VerifiedExecutable> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(executablePath);
    if (before.isSymbolicLink() || !before.isFile() || !ownedAndProtected(before, ownerEuid)
      || before.size < 20 || before.size > MAX_EXECUTABLE_BYTES
      || (process.platform !== 'win32' && (before.mode & 0o111) === 0)
      || await realpath(executablePath) !== executablePath) throw unavailable();
    handle = await open(executablePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    const identity = identityOf(opened);
    if (!opened.isFile() || !sameIdentity(identityOf(before), identity)
      || !ownedAndProtected(opened, ownerEuid)) throw unavailable();
    const magic = Buffer.alloc(20);
    const magicRead = await handle.read(magic, 0, magic.length, 0);
    const machine = architecture === 'x64' ? 0x3e : 0xb7;
    if (magicRead.bytesRead !== magic.length
      || !magic.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || magic[4] !== 2 || magic[5] !== 1 || magic[6] !== 1 || magic.readUInt16LE(18) !== machine
      || await hashHandle(handle, opened.size) !== expectedDigest) throw unavailable();
    const after = await lstat(executablePath);
    if (after.isSymbolicLink() || await realpath(executablePath) !== executablePath
      || !sameIdentity(identity, identityOf(after))) throw unavailable();
    return Object.freeze({ handle, identity });
  } catch {
    try { await handle?.close(); } catch { /* best-effort after failed verification */ }
    throw unavailable();
  }
}

async function executableStillCurrent(executablePath: string, expected: FileIdentity): Promise<void> {
  try {
    const current = await lstat(executablePath);
    if (current.isSymbolicLink() || await realpath(executablePath) !== executablePath
      || !sameIdentity(expected, identityOf(current))) throw unavailable();
  } catch { throw unavailable(); }
}

async function verifyDirectory(path: string, ownerEuid: number): Promise<VerifiedDirectory> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isDirectory() || !ownedAndProtected(before, ownerEuid)
      || await realpath(path) !== path) throw unavailable();
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    const identity = identityOf(opened);
    if (!opened.isDirectory() || !ownedAndProtected(opened, ownerEuid)
      || !sameIdentity(identityOf(before), identity)) throw unavailable();
    const after = await lstat(path);
    if (after.isSymbolicLink() || await realpath(path) !== path
      || !sameIdentity(identity, identityOf(after))) throw unavailable();
    return Object.freeze({ handle, identity, path });
  } catch {
    try { await handle?.close(); } catch { /* best-effort after failed verification */ }
    throw unavailable();
  }
}

async function directoryStillCurrent(directory: VerifiedDirectory): Promise<void> {
  try {
    const current = await lstat(directory.path);
    if (current.isSymbolicLink() || await realpath(directory.path) !== directory.path
      || !sameIdentity(directory.identity, identityOf(current))) throw unavailable();
  } catch { throw unavailable(); }
}

function validateStreams(child: ChildProcessWithoutNullStreams): void {
  if (!child || typeof child !== 'object' || !child.stdin || !child.stdout || !child.stderr
    || typeof child.stdin.write !== 'function' || typeof child.stdin.end !== 'function'
    || typeof child.stdin.destroy !== 'function'
    || typeof child.stdout[Symbol.asyncIterator] !== 'function' || typeof child.stdout.destroy !== 'function'
    || typeof child.stderr[Symbol.asyncIterator] !== 'function' || typeof child.stderr.destroy !== 'function'
    || typeof child.kill !== 'function' || typeof child.once !== 'function') throw unavailable();
}

function defaultLaunch(executable: string, args: readonly string[], options: LaunchOptions): ChildProcessWithoutNullStreams {
  return spawn(executable, [...args], options) as ChildProcessWithoutNullStreams;
}

/**
 * Captures one reviewed native Codex invocation. Construction and import are inert.
 * Acquisition verifies an opened, non-symlink executable and keeps that handle open
 * across launch; callers cannot add arguments, inherit environment or retry.
 */
function buildCodexNativeProcessAcquisitionV1(
  input: CodexNativeProcessConfigurationV1,
  launch: LaunchCodexNativeProcessV1,
): CodexNativeProcessAcquisitionV1 {
  const parsed = configurationSchema.parse(configurationFields(input));
  const executablePath = safeAbsolutePath(parsed.executablePath);
  const approvedWorkspaceRoot = safeAbsolutePath(parsed.approvedWorkspaceRoot);
  const workspacePath = safeAbsolutePath(parsed.workspacePath);
  const codexHome = safeAbsolutePath(parsed.environment.CODEX_HOME);
  const actualEuid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
  if (parsed.reviewedArchitecture !== process.arch || parsed.ownerEuid !== actualEuid
    || !inside(approvedWorkspaceRoot, workspacePath)
    || codexHome === approvedWorkspaceRoot || inside(approvedWorkspaceRoot, codexHome)
    || inside(codexHome, approvedWorkspaceRoot) || inside(approvedWorkspaceRoot, executablePath)
    || inside(codexHome, executablePath)
    || Date.parse(parsed.validUntil) <= Date.parse(parsed.validFrom)
    || typeof input.assertCurrent !== 'function' || typeof input.clock !== 'function'
    || typeof launch !== 'function') throw unavailable();
  const expectedBinding = parseCodexAppServerProcessBindingV1(input.expectedBinding);
  const environment = Object.freeze({ ...parsed.environment });
  const permit: CodexNativeProcessPermitV1 = Object.freeze({
    binding: expectedBinding,
    executablePath,
    executableSha256: parsed.executableSha256,
    appServerVersion: parsed.appServerVersion,
    reviewedPlatform: parsed.reviewedPlatform,
    reviewedArchitecture: parsed.reviewedArchitecture,
    ownerEuid: parsed.ownerEuid,
    fixedArguments: CODEX_APP_SERVER_ARGUMENTS_V1,
    approvedWorkspaceRoot,
    workspacePath,
    environment,
    validFrom: parsed.validFrom,
    validUntil: parsed.validUntil,
    startupTimeoutMs: parsed.startupTimeoutMs,
    cleanupTimeoutMs: parsed.cleanupTimeoutMs,
  });
  const expectedBindingDigest = sha256Digest(expectedBinding);
  assertNoSecretMaterial({
    executablePath,
    executableSha256: parsed.executableSha256,
    appServerVersion: parsed.appServerVersion,
    workspacePath,
    environment,
  });
  const assertCurrent = input.assertCurrent.bind(input);
  const clock = input.clock.bind(input);
  let highWater = -1;
  let used = false;
  let closed = false;
  let currentOwner: OwnedCodexAppServerProcessV1 | undefined;

  const now = (): number => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < highWater
      || value < Date.parse(parsed.validFrom) || value >= Date.parse(parsed.validUntil)) throw unavailable();
    highWater = value;
    return value;
  };
  const check = (): void => {
    now();
    assertSynchronousFence(() => assertCurrent(permit), () => { throw unavailable(); });
    now();
  };

  const acquire: AcquireCodexAppServerProcessV1 = (bindingValue, signal) => {
    if (closed || used || !(signal instanceof AbortSignal) || signal.aborted) throw unavailable();
    const binding = parseCodexAppServerProcessBindingV1(bindingValue);
    if (sha256Digest(binding) !== expectedBindingDigest) throw unavailable();
    check();
    const bindingKey = sha256Digest(permit);
    if (startedBindings.has(bindingKey) || startedBindings.size >= MAX_TRACKED_BINDINGS) throw unavailable();
    startedBindings.add(bindingKey);
    used = true;

    const operation = new AbortController();
    let child: ChildProcessWithoutNullStreams | undefined;
    let terminal = false;
    let termSent = false;
    let readyAdmitted = false;
    let closing: Promise<void> | undefined;
    let retirement: Promise<void> | undefined;
    let startupSettled: Promise<void> = Promise.resolve();
    let settleExit: (value: Readonly<{ code: number | null; signal: string | null }>) => void;
    let rejectExit: (error: Error) => void;
    const exited = new Promise<Readonly<{ code: number | null; signal: string | null }>>((resolve, reject) => {
      settleExit = resolve;
      rejectExit = reject;
    });
    void exited.catch(() => {});

    const bounded = async <T>(work: Promise<T>, milliseconds: number): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(cleanupUncertain()), milliseconds);
        })]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const retire = (): Promise<void> => {
      if (retirement) return retirement;
      retirement = (async () => {
        const selected = child;
        if (!selected) return;
        let uncertain = false;
        try { selected.stdin.destroy(); } catch { uncertain = true; }
        if (!terminal) {
          if (!termSent) {
            termSent = true;
            try { if (!selected.kill('SIGTERM')) uncertain = true; } catch { uncertain = true; }
          }
          const gracefulMs = Math.max(1, Math.floor(parsed.cleanupTimeoutMs / 2));
          try { await bounded(exited, gracefulMs); }
          catch {
            if (!terminal) {
              try { if (!selected.kill('SIGKILL')) uncertain = true; } catch { uncertain = true; }
              try { await bounded(exited, Math.max(1, parsed.cleanupTimeoutMs - gracefulMs)); }
              catch { uncertain = true; }
            } else uncertain = true;
          }
        } else {
          try { await bounded(exited, parsed.cleanupTimeoutMs); } catch { uncertain = true; }
        }
        try { selected.stdout.destroy(); selected.stderr.destroy(); } catch { uncertain = true; }
        if (uncertain) throw cleanupUncertain();
      })();
      void retirement.catch(() => {});
      return retirement;
    };

    let detachSignal: () => void = () => {};
    const close = async (): Promise<void> => {
      if (closing) return closing;
      closed = true;
      operation.abort();
      closing = (async () => {
        let uncertain = false;
        try { await bounded(startupSettled, parsed.cleanupTimeoutMs); } catch { uncertain = true; }
        try { await retire(); } catch { uncertain = true; }
        if (uncertain) throw cleanupUncertain();
      })().finally(() => detachSignal()).catch(() => { throw cleanupUncertain(); });
      return closing;
    };

    const stop = (): void => {
      if (!readyAdmitted) {
        operation.abort();
        void close().catch(() => {});
      } else {
        setImmediate(() => { if (!terminal) void close().catch(() => {}); });
      }
    };
    let signalAttached = true;
    detachSignal = (): void => {
      if (!signalAttached) return;
      signalAttached = false;
      signal.removeEventListener('abort', stop);
    };
    signal.addEventListener('abort', stop, { once: true });

    const startup = (async (): Promise<CodexAppServerProcessBytePortV1> => {
      let verified: VerifiedExecutable | undefined;
      let verifiedRoot: VerifiedDirectory | undefined;
      let verifiedWorkspace: VerifiedDirectory | undefined;
      let verifiedCodexHome: VerifiedDirectory | undefined;
      try {
        verified = await verifyExecutable(executablePath, parsed.executableSha256, parsed.ownerEuid,
          parsed.reviewedArchitecture);
        verifiedRoot = await verifyDirectory(approvedWorkspaceRoot, parsed.ownerEuid);
        verifiedWorkspace = await verifyDirectory(workspacePath, parsed.ownerEuid);
        verifiedCodexHome = await verifyDirectory(codexHome, parsed.ownerEuid);
        if (!inside(verifiedRoot.path, verifiedWorkspace.path)) throw unavailable();
        await executableStillCurrent(executablePath, verified.identity);
        await directoryStillCurrent(verifiedRoot);
        await directoryStillCurrent(verifiedWorkspace);
        await directoryStillCurrent(verifiedCodexHome);
        if (closed || signal.aborted || operation.signal.aborted) throw unavailable();
        check();
        if (closed || signal.aborted || operation.signal.aborted) throw unavailable();

        let selected: ChildProcessWithoutNullStreams;
        try {
          selected = launch(CODEX_EXECUTABLE_DESCRIPTOR_PATH_V1, CODEX_APP_SERVER_ARGUMENTS_V1, {
            cwd: workspacePath,
            env: { ...environment },
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe', verified.handle.fd],
          });
          child = selected;
          validateStreams(selected);
        } catch { throw unavailable(); }

        let spawnReadyResolve: () => void = () => {};
        let spawnReadyReject: (error: Error) => void = () => {};
        const spawnReady = new Promise<void>((resolve, reject) => {
          spawnReadyResolve = resolve;
          spawnReadyReject = reject;
        });
        selected.once('spawn', spawnReadyResolve);
        selected.once('error', () => {
          rejectExit(unavailable());
          spawnReadyReject(unavailable());
        });
        selected.once('exit', (code, childSignal) => {
          terminal = true;
          detachSignal();
          const exitedByCode = Number.isSafeInteger(code) && childSignal === null;
          const exitedBySignal = code === null && typeof childSignal === 'string'
            && childSignal.length > 0 && childSignal.length <= 64;
          if (!exitedByCode && !exitedBySignal) rejectExit(unavailable());
          else settleExit(Object.freeze({ code, signal: childSignal }));
        });
        const operationAbort = (): void => spawnReadyReject(unavailable());
        operation.signal.addEventListener('abort', operationAbort, { once: true });
        try { await bounded(spawnReady, parsed.startupTimeoutMs); }
        finally { operation.signal.removeEventListener('abort', operationAbort); }

        await executableStillCurrent(executablePath, verified.identity);
        await directoryStillCurrent(verifiedRoot);
        await directoryStillCurrent(verifiedWorkspace);
        await directoryStillCurrent(verifiedCodexHome);
        if (closed || signal.aborted || operation.signal.aborted) throw unavailable();
        check();
        if (closed || signal.aborted || operation.signal.aborted) throw unavailable();

        const stdout = selected.stdout[Symbol.asyncIterator]();
        const stderr = selected.stderr[Symbol.asyncIterator]();
        const read = async (iterator: AsyncIterator<unknown>, readSignal: AbortSignal): Promise<Uint8Array | undefined> => {
          if (!(readSignal instanceof AbortSignal) || readSignal.aborted || operation.signal.aborted) throw unavailable();
          let abort: () => void = () => {};
          const cancelled = new Promise<never>((_, reject) => {
            abort = () => reject(unavailable());
            readSignal.addEventListener('abort', abort, { once: true });
          });
          try {
            const value = await Promise.race([iterator.next(), cancelled]);
            if (value.done) return undefined;
            if (!(value.value instanceof Uint8Array)) throw unavailable();
            return Uint8Array.from(value.value);
          } finally { readSignal.removeEventListener('abort', abort); }
        };
        const port: CodexAppServerProcessBytePortV1 = Object.freeze({
          async writeStdin(bytes: Uint8Array, writeSignal: AbortSignal): Promise<void> {
            if (!(bytes instanceof Uint8Array) || !bytes.byteLength || !(writeSignal instanceof AbortSignal)
              || writeSignal.aborted || operation.signal.aborted) throw unavailable();
            await new Promise<void>((resolve, reject) => {
              const abort = (): void => reject(unavailable());
              writeSignal.addEventListener('abort', abort, { once: true });
              selected.stdin.write(Buffer.from(bytes), (error?: Error | null) => {
                writeSignal.removeEventListener('abort', abort);
                if (error || writeSignal.aborted || operation.signal.aborted) reject(unavailable());
                else resolve();
              });
            });
          },
          readStdout: (readSignal: AbortSignal) => read(stdout, readSignal),
          readStderr: (readSignal: AbortSignal) => read(stderr, readSignal),
          async closeStdin(closeSignal: AbortSignal): Promise<void> {
            if (!(closeSignal instanceof AbortSignal) || closeSignal.aborted || operation.signal.aborted) throw unavailable();
            await new Promise<void>((resolve, reject) => {
              const failed = (): void => {
                selected.stdin.removeListener('error', failed);
                reject(unavailable());
              };
              selected.stdin.once('error', failed);
              selected.stdin.end(() => {
                selected.stdin.removeListener('error', failed);
                resolve();
              });
            });
          },
          async terminate(terminateSignal: AbortSignal): Promise<void> {
            if (!(terminateSignal instanceof AbortSignal) || terminateSignal.aborted || terminal) return;
            if (termSent) return;
            termSent = true;
            try { if (!selected.kill('SIGTERM')) throw unavailable(); } catch { throw unavailable(); }
          },
          exited,
        });
        readyAdmitted = true;
        return port;
      } catch {
        try { await retire(); } catch { /* readiness remains unavailable; close preserves uncertainty */ }
        detachSignal();
        throw unavailable();
      } finally {
        try { await verified?.handle.close(); } catch { /* executable is never retained after launch decision */ }
        try { await verifiedRoot?.handle.close(); } catch { /* directory handle retained only across admission */ }
        try { await verifiedWorkspace?.handle.close(); } catch { /* directory handle retained only across admission */ }
        try { await verifiedCodexHome?.handle.close(); } catch { /* directory handle retained only across admission */ }
      }
    })();
    startupSettled = startup.then(() => {}, () => {});
    void startup.catch(() => {});
    currentOwner = Object.freeze({ ready: startup, close });
    return currentOwner;
  };

  return Object.freeze({
    acquire,
    async close(): Promise<void> {
      if (closed) return currentOwner?.close();
      closed = true;
      return currentOwner?.close();
    },
  });
}

/** Linux production port. The module-captured launcher cannot be replaced by a caller. */
export function createCodexNativeProcessAcquisitionV1(
  input: CodexNativeProcessConfigurationV1,
): CodexNativeProcessAcquisitionV1 {
  if (process.platform !== 'linux') throw unavailable();
  return buildCodexNativeProcessAcquisitionV1(input, defaultLaunch);
}

/** Injected-launch seam for effect-free tests only; it is not exported by the private server entry. */
export function createCodexNativeProcessAcquisitionForTestV1(
  input: CodexNativeProcessConfigurationV1,
  testOnlyLaunch: LaunchCodexNativeProcessV1,
): CodexNativeProcessAcquisitionV1 {
  if (typeof testOnlyLaunch !== 'function') throw unavailable();
  return buildCodexNativeProcessAcquisitionV1(input, testOnlyLaunch);
}
