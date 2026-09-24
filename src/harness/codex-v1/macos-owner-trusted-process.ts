import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { z } from "zod";
import { parseCodexAppServerProcessBindingV1, type AcquireCodexAppServerProcessV1,
  type CodexAppServerProcessBindingV1, type CodexAppServerProcessBytePortV1,
  type OwnedCodexAppServerProcessV1 } from "./app-server-process-session";
import { CODEX_APP_SERVER_START_CONTRACT } from "./schema-contract";
import { sha256Digest } from "../../security/canonical-digest";
import { assertSynchronousFence } from "../../security/synchronous-fence";

/**
 * Owner-trusted macOS process provider for the first local Codex route.
 * It is intentionally narrower than the Linux descriptor launcher: macOS has
 * no equivalent stable executable-descriptor launch mechanism.  The owner
 * controls the same-user Mac account, and this provider rechecks the exact
 * executable immediately before its one fixed-purpose spawn.
 */
export const CODEX_MACOS_OWNER_TRUSTED_PROCESS_V1 =
  "control-room.codex-macos-owner-trusted-process/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const path = z.string().min(1).max(4096).refine(value => isAbsolute(value)
  && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value));
const instant = z.string().datetime({ offset: true }).refine(value => new Date(value).toISOString() === value);
const configurationSchema = z.object({
  executablePath: path,
  executableSha256: digest,
  appServerVersion: z.literal(CODEX_APP_SERVER_START_CONTRACT.version),
  workingDirectory: path,
  codexHome: path,
  ownerUid: z.number().int().nonnegative(),
  validFrom: instant,
  validUntil: instant,
  startupTimeoutMs: z.number().int().min(1).max(30_000),
  cleanupTimeoutMs: z.number().int().min(1).max(5_000),
}).strict();

export type CodexMacosOwnerTrustedProcessConfigurationV1 = z.infer<typeof configurationSchema>;
export type CodexMacosOwnerTrustedProcessPermitV1 = Readonly<{
  schema: typeof CODEX_MACOS_OWNER_TRUSTED_PROCESS_V1;
  binding: CodexAppServerProcessBindingV1;
  executableSha256: string;
  configurationDigest: string;
}>;

export type CodexMacosOwnerTrustedProcessAcquisitionV1 = Readonly<{
  acquire: AcquireCodexAppServerProcessV1;
  close(): Promise<void>;
}>;

type Launch = (file: string, args: readonly string[], options: Readonly<{
  cwd: string; env: Readonly<Record<string, string>>; shell: false; windowsHide: true;
  stdio: "pipe";
}>) => ChildProcessWithoutNullStreams;

const unavailable = (): never => { throw new Error("codex_macos_owner_trusted_process_unavailable"); };
/** Process-local duplicate fence. A restart requires new current authority and
 * a new provider, but two live providers cannot start the same exact binding. */
const consumedBindings = new Set<string>();

function protectedOwnerFile(value: { uid: number; mode: number; size: number }, ownerUid: number): boolean {
  return value.uid === ownerUid && (value.mode & 0o022) === 0 && value.size > 0 && value.size <= 512 * 1024 * 1024;
}

function nested(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function hashFile(file: Awaited<ReturnType<typeof open>>, size: number): Promise<string> {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
  for (let offset = 0; offset < size;) {
    const read = await file.read(buffer, 0, Math.min(buffer.byteLength, size - offset), offset);
    if (!read.bytesRead) unavailable();
    hash.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
  }
  return `sha256:${hash.digest("hex")}`;
}

async function attest(configuration: CodexMacosOwnerTrustedProcessConfigurationV1): Promise<void> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(configuration.executablePath);
    if (before.isSymbolicLink() || !before.isFile() || !protectedOwnerFile(before, configuration.ownerUid)
      || (before.mode & 0o111) === 0 || await realpath(configuration.executablePath) !== configuration.executablePath) unavailable();
    file = await open(configuration.executablePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await file.stat();
    if (!opened.isFile() || !protectedOwnerFile(opened, configuration.ownerUid)
      || opened.dev !== before.dev || opened.ino !== before.ino || opened.mtimeMs !== before.mtimeMs
      || opened.size !== before.size || await hashFile(file, opened.size) !== configuration.executableSha256) unavailable();
    const after = await lstat(configuration.executablePath);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino
      || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size) unavailable();
  } catch { unavailable(); }
  finally { try { await file?.close(); } catch { /* no capability escaped */ } }
}

async function attestDirectory(directory: string, ownerUid: number): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== ownerUid || (stat.mode & 0o077) !== 0
      || await realpath(directory) !== directory) unavailable();
  } catch { unavailable(); }
}

function bytePort(child: ChildProcessWithoutNullStreams): CodexAppServerProcessBytePortV1 {
  if (!child.stdin || !child.stdout || !child.stderr) unavailable();
  const stdout = child.stdout[Symbol.asyncIterator](), stderr = child.stderr[Symbol.asyncIterator]();
  return Object.freeze({
    async writeStdin(bytes: Uint8Array, signal: AbortSignal) {
      if (signal.aborted) unavailable();
      await new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve()));
      if (signal.aborted) unavailable();
    },
    async readStdout(signal: AbortSignal) {
      if (signal.aborted) unavailable(); const next = await stdout.next();
      return next.done ? undefined : new Uint8Array(next.value);
    },
    async readStderr(signal: AbortSignal) {
      if (signal.aborted) unavailable(); const next = await stderr.next();
      return next.done ? undefined : new Uint8Array(next.value);
    },
    async closeStdin(signal: AbortSignal) { if (signal.aborted) unavailable(); child.stdin.end(); },
    async terminate(signal: AbortSignal) { if (signal.aborted) unavailable(); child.kill("SIGTERM"); },
    exited: new Promise<Readonly<{ code: number | null; signal: string | null }>>(resolve =>
      child.once("exit", (code, signal) => resolve({ code, signal }))),
  });
}

/**
 * Creates one exact App Server acquisition. Construction performs no I/O or
 * spawn. The caller must supply the current Control Room authority fence; a
 * changed task cannot reach the provider after its delivery receipt exists.
 */
export function createCodexMacosOwnerTrustedProcessAcquisitionV1(input: Readonly<{
  configuration: CodexMacosOwnerTrustedProcessConfigurationV1;
  expectedBinding: CodexAppServerProcessBindingV1;
  assertCurrent(permit: CodexMacosOwnerTrustedProcessPermitV1): void;
  clock(): number;
}>, launch: Launch = (file, args, options) => spawn(file, [...args], options as SpawnOptions) as ChildProcessWithoutNullStreams): CodexMacosOwnerTrustedProcessAcquisitionV1 {
  const configuration = Object.freeze(configurationSchema.parse(input.configuration));
  const expectedBinding = parseCodexAppServerProcessBindingV1(input.expectedBinding);
  if (process.platform !== "darwin" || typeof process.getuid !== "function" || process.getuid() !== configuration.ownerUid
    || Date.parse(configuration.validUntil) <= Date.parse(configuration.validFrom)
    || configuration.workingDirectory === configuration.codexHome || nested(configuration.workingDirectory, configuration.codexHome)
    || nested(configuration.codexHome, configuration.workingDirectory)
    || typeof input.assertCurrent !== "function" || typeof input.clock !== "function" || typeof launch !== "function") unavailable();
  const configurationDigest = sha256Digest({ purpose: CODEX_MACOS_OWNER_TRUSTED_PROCESS_V1, configuration });
  const permit = Object.freeze({ schema: CODEX_MACOS_OWNER_TRUSTED_PROCESS_V1, binding: expectedBinding,
    executableSha256: configuration.executableSha256, configurationDigest });
  let used = false, closed = false, owner: OwnedCodexAppServerProcessV1 | undefined, highWater = -1;
  const assertCurrent = input.assertCurrent.bind(input), clock = input.clock.bind(input);
  const check = () => {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < highWater || now < Date.parse(configuration.validFrom)
      || now >= Date.parse(configuration.validUntil)) unavailable();
    highWater = now; assertSynchronousFence(() => assertCurrent(permit), unavailable);
  };
  return Object.freeze({
    acquire(bindingValue: CodexAppServerProcessBindingV1, signal: AbortSignal): OwnedCodexAppServerProcessV1 {
      const binding = parseCodexAppServerProcessBindingV1(bindingValue);
      const bindingDigest = sha256Digest(binding);
      const duplicateKey = sha256Digest({ purpose: CODEX_MACOS_OWNER_TRUSTED_PROCESS_V1, configurationDigest, bindingDigest });
      if (closed || used || signal.aborted || bindingDigest !== sha256Digest(expectedBinding) || consumedBindings.has(duplicateKey)) unavailable();
      consumedBindings.add(duplicateKey);
      used = true; check();
      const ready = (async () => {
        await attestDirectory(configuration.workingDirectory, configuration.ownerUid);
        await attestDirectory(configuration.codexHome, configuration.ownerUid);
        await attest(configuration); if (closed || signal.aborted) unavailable(); check();
        const options: Parameters<Launch>[2] = Object.freeze({ cwd: configuration.workingDirectory,
          env: Object.freeze({ CODEX_HOME: configuration.codexHome, HOME: configuration.codexHome, NO_COLOR: "1" }),
          shell: false, windowsHide: true, stdio: "pipe" as const });
        const child = launch(configuration.executablePath, ["app-server"], options);
        if (!child || !child.stdin || !child.stdout || !child.stderr) unavailable();
        return bytePort(child);
      })();
      owner = Object.freeze({ ready, async close() {
        try { const port = await ready; await port.terminate(new AbortController().signal); } catch { /* no retry */ }
      } });
      return owner;
    },
    async close() { closed = true; try { await owner?.close(); } catch { /* terminal cleanup only */ } },
  });
}
