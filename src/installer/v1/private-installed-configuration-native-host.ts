import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readdir, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import { PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1 } from "./private-installed-configuration-custody";

export const PRIVATE_INSTALLED_CONFIGURATION_NATIVE_HOST_V1 =
  "control-room.private-installed-configuration-native-host/v1" as const;
export const PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1 =
  "control-room.private-installed-configuration-native-publish-request/v1" as const;
export const PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLICATION_RECEIPT_V1 =
  "control-room.private-installed-configuration-native-publication-receipt/v1" as const;

const maximumHelperBytes = 2 * 1024 * 1024;
const maximumConfigurationBytes = 256 * 1024;
const maximumManifestBytes = 16 * 1024;
const maximumOutputBytes = 384;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const standardRootPattern = /^\/Users\/[^/\u0000-\u001f\u007f]{1,255}\/Library\/Application Support\/Agent Control Room\/Protected$/u;
const kindCode = Object.freeze({ ancestor: 1, manifest: 2, configuration: 3, journal: 4 });

type Identity = Readonly<{ device: number; inode: number }>;
type NativeIdentity = Readonly<{ device: number; inode: number; ownerUid: number; mode: number; size: number;
  linkCount: number; modifiedMs: number; changedMs: number }>;
type NativeKind = keyof typeof kindCode;
type Configuration = Readonly<{
  executablePath: string;
  executableSha256: string;
  installationId: string;
  releaseDigest: string;
  planDigest: string;
  rootPath: string;
  expectedOwnerUid: number;
  configurationBytes: Buffer;
  configurationSha256: string;
  manifestBytes: Buffer;
  manifestSha256: string;
}>;
type Staged = Readonly<{ directory: string; directoryIdentity: Readonly<{ device: bigint; inode: bigint }>;
  executable: string; executableIdentity: Readonly<{ device: bigint; inode: bigint }> }>;
type PartialStaging = { directory?: string; directoryIdentity?: Readonly<{ dev: bigint; ino: bigint }>;
  executable?: string; executableIdentity?: Readonly<{ dev: bigint; ino: bigint }> };

export type PrivateInstalledConfigurationNativePublicationReceiptV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLICATION_RECEIPT_V1;
  outcome: "published";
  installationId: string;
  releaseDigest: string;
  planDigest: string;
  configurationSha256: string;
  manifestSha256: string;
  ownerUid: number;
  rootIdentity: Identity;
  configurationIdentity: Identity;
  manifestIdentity: Identity;
  journalIdentity: Identity;
  rootMode: 0o700;
  configurationMode: 0o600;
  manifestMode: 0o600;
  journalMode: 0o700;
  extendedAcl: false;
  replacedExistingRoot: false;
}>;

export type PrivateInstalledConfigurationNativeHostV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_NATIVE_HOST_V1;
  publish(request: Readonly<{ schema: typeof PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1;
    deadlineUnixMs: number; signal: AbortSignal }>): Promise<PrivateInstalledConfigurationNativePublicationReceiptV1>;
  verifyProtectedPath(request: Readonly<{ schema: typeof PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1;
    kind: NativeKind; descriptor: number; identity: NativeIdentity; signal: AbortSignal }>): Promise<unknown>;
  inspectReadiness(): Readonly<{ state: "ready" | "busy" | "unresolved" | "closed";
    staged: boolean; publicationAvailable: boolean; unresolvedHelperProcesses: number;
    unresolvedProcessGroups: number }>;
  cleanup(signal: AbortSignal): Promise<Readonly<{ outcome: "confirmed" }>>;
}>;

function sanitized(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_installed_configuration_native_host_${kind}`); error.stack = undefined; return error;
}
const refuse = (): never => { throw sanitized("refused"); };
const uncertain = (): never => { throw sanitized("uncertain"); };
function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key)) || names.some(name => !keys.includes(name))) return refuse();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return refuse();
  }
  return value as Readonly<Record<string, unknown>>;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refuse();
  return value;
}
function boundedInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) return refuse();
  return value as number;
}
function boundedNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return refuse();
  return value;
}
function bytes(value: unknown, maximum: number): Buffer {
  const observed = exactHostUint8ArrayV1(value, maximum);
  if (!observed || observed.byteLength < 1) return refuse();
  return Buffer.from(observed.copy());
}
function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value === "/"
    || value.endsWith("/") || Buffer.byteLength(value, "utf8") > 4096
    || Buffer.from(value, "utf8").toString("utf8") !== value || /[\u0000-\u001f\u007f]/u.test(value)) return refuse();
  return value;
}
function captureConfiguration(value: unknown): Configuration {
  const input = exact(value, ["schema", "executablePath", "executableSha256", "installationId", "releaseDigest",
    "planDigest", "rootPath", "expectedOwnerUid", "configurationBytes", "configurationSha256", "manifestBytes",
    "manifestSha256"]);
  if (process.platform !== "darwin" || typeof process.getuid !== "function" || typeof process.geteuid !== "function"
    || process.getuid() !== process.geteuid() || process.geteuid() === 0
    || input.schema !== PRIVATE_INSTALLED_CONFIGURATION_NATIVE_HOST_V1
    || typeof input.installationId !== "string" || !installationPattern.test(input.installationId)
    || input.expectedOwnerUid !== process.geteuid()) return refuse();
  const rootPath = absolutePath(input.rootPath);
  if (!standardRootPattern.test(rootPath)) return refuse();
  const configurationBytes = bytes(input.configurationBytes, maximumConfigurationBytes);
  const manifestBytes = bytes(input.manifestBytes, maximumManifestBytes);
  const configurationSha256 = digest(input.configurationSha256), manifestSha256 = digest(input.manifestSha256);
  if (sha256(configurationBytes) !== configurationSha256 || sha256(manifestBytes) !== manifestSha256) return refuse();
  return Object.freeze({ executablePath: absolutePath(input.executablePath), executableSha256: digest(input.executableSha256),
    installationId: input.installationId, releaseDigest: digest(input.releaseDigest), planDigest: digest(input.planDigest),
    rootPath, expectedOwnerUid: boundedInteger(input.expectedOwnerUid, 0x7fffffff), configurationBytes,
    configurationSha256, manifestBytes, manifestSha256 });
}
function capturePublishRequest(value: unknown) {
  const input = exact(value, ["schema", "deadlineUnixMs", "signal"]);
  if (input.schema !== PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1
    || !(input.signal instanceof AbortSignal) || input.signal.aborted) return refuse();
  const deadlineUnixMs = boundedInteger(input.deadlineUnixMs), remaining = deadlineUnixMs - Date.now();
  if (remaining <= 0 || remaining > 30_000) return refuse();
  return Object.freeze({ deadlineUnixMs, signal: input.signal });
}
function captureVerifyRequest(value: unknown, expectedOwnerUid: number) {
  const input = exact(value, ["schema", "kind", "descriptor", "identity", "signal"]);
  const identity = exact(input.identity, ["device", "inode", "ownerUid", "mode", "size", "linkCount", "modifiedMs", "changedMs"]);
  if (input.schema !== PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1
    || typeof input.kind !== "string" || !Object.hasOwn(kindCode, input.kind)
    || !(input.signal instanceof AbortSignal) || input.signal.aborted
    || !Number.isInteger(input.descriptor) || (input.descriptor as number) < 0
    || (input.kind !== "ancestor" && identity.ownerUid !== expectedOwnerUid)) return refuse();
  const mode = boundedInteger(identity.mode, 0o7777), ownerUid = boundedInteger(identity.ownerUid, 0x7fffffff);
  if ((input.kind === "manifest" || input.kind === "configuration") && (mode !== 0o600 || identity.linkCount !== 1)
    || input.kind === "journal" && mode !== 0o700) return refuse();
  return Object.freeze({ kind: input.kind as NativeKind, descriptor: input.descriptor as number,
    identity: Object.freeze({ device: boundedInteger(identity.device), inode: boundedInteger(identity.inode), ownerUid, mode,
      size: boundedInteger(identity.size), linkCount: boundedInteger(identity.linkCount),
      modifiedMs: boundedNumber(identity.modifiedMs), changedMs: boundedNumber(identity.changedMs) }), signal: input.signal });
}
function same(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function checkedHelper(configuration: Configuration): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    if (await realpath(configuration.executablePath) !== configuration.executablePath) return refuse();
    for (let parent = dirname(configuration.executablePath); ; parent = dirname(parent)) {
      const stat = await lstat(parent);
      const stickyTemp = parent === "/private/tmp" && stat.uid === 0 && (stat.mode & 0o7777) === 0o1777;
      if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, configuration.expectedOwnerUid].includes(stat.uid)
        || (!stickyTemp && (stat.mode & 0o022) !== 0)) return refuse();
      if (parent === "/") break;
    }
    handle = await open(configuration.executablePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || ![0n, BigInt(configuration.expectedOwnerUid)].includes(before.uid)
      || (before.mode & 0o6022n) !== 0n || (before.mode & 0o100n) === 0n
      || before.size < 1n || before.size > BigInt(maximumHelperBytes)) return refuse();
    const captured = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < captured.length) {
      const read = await handle.read(captured, offset, captured.length - offset, offset);
      if (read.bytesRead < 1) return refuse(); offset += read.bytesRead;
    }
    if (sha256(captured) !== configuration.executableSha256) { captured.fill(0); return refuse(); }
    const after = await handle.stat({ bigint: true }), named = await lstat(configuration.executablePath, { bigint: true });
    if (!same(before, after) || !same(before, named) || named.isSymbolicLink() || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) { captured.fill(0); return refuse(); }
    return captured;
  } catch { return refuse(); }
  finally { await handle?.close().catch(() => undefined); }
}
async function cleanIdentityOwnedStaging(staging: Readonly<PartialStaging>): Promise<boolean> {
  if (!staging.directory) return true;
  if (!staging.directoryIdentity) return false;
  try {
    const directory = await lstat(staging.directory, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || directory.dev !== staging.directoryIdentity.dev || directory.ino !== staging.directoryIdentity.ino) return false;
    const entries = await readdir(staging.directory);
    if (entries.length === 1 && staging.executable && entries[0] === "installed-configuration-v1") {
      if (!staging.executableIdentity) return false;
      const executable = await lstat(staging.executable, { bigint: true });
      if (!executable.isFile() || executable.isSymbolicLink() || executable.nlink !== 1n
        || executable.dev !== staging.executableIdentity.dev || executable.ino !== staging.executableIdentity.ino) return false;
      await unlink(staging.executable);
    } else if (entries.length !== 0) return false;
    await rmdir(staging.directory); return true;
  } catch { return false; }
}

async function stageHelper(configuration: Configuration,
  retainPartial: (staging: Readonly<PartialStaging>) => void): Promise<Staged> {
  const captured = await checkedHelper(configuration), staging: PartialStaging = {};
  let handle: FileHandle | undefined;
  try {
    staging.directory = await mkdtemp("/private/tmp/acr-installed-configuration-native-");
    const createdDirectory = await lstat(staging.directory, { bigint: true });
    staging.directoryIdentity = Object.freeze({ dev: createdDirectory.dev, ino: createdDirectory.ino });
    await chmod(staging.directory, 0o700);
    const directoryStat = await lstat(staging.directory, { bigint: true });
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || directoryStat.uid !== BigInt(configuration.expectedOwnerUid) || (directoryStat.mode & 0o7777n) !== 0o700n
      || directoryStat.dev !== createdDirectory.dev || directoryStat.ino !== createdDirectory.ino
      || (await readdir(staging.directory)).length !== 0) return uncertain();
    staging.executable = join(staging.directory, "installed-configuration-v1");
    handle = await open(staging.executable, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
      | constants.O_RDWR | constants.O_NONBLOCK, 0o500);
    const created = await handle.stat({ bigint: true });
    staging.executableIdentity = Object.freeze({ dev: created.dev, ino: created.ino });
    if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1n
      || created.uid !== BigInt(configuration.expectedOwnerUid) || (created.mode & 0o7777n) !== 0o500n) return uncertain();
    let offset = 0;
    while (offset < captured.length) {
      const wrote = await handle.write(captured, offset, captured.length - offset, offset);
      if (wrote.bytesWritten < 1) return uncertain(); offset += wrote.bytesWritten;
    }
    await handle.sync(); const observed = Buffer.alloc(captured.length); offset = 0;
    while (offset < observed.length) {
      const read = await handle.read(observed, offset, observed.length - offset, offset);
      if (read.bytesRead < 1) return uncertain(); offset += read.bytesRead;
    }
    const executableStat = await handle.stat({ bigint: true }), named = await lstat(staging.executable, { bigint: true });
    if (!executableStat.isFile() || executableStat.nlink !== 1n
      || executableStat.uid !== BigInt(configuration.expectedOwnerUid) || (executableStat.mode & 0o7777n) !== 0o500n
      || !same(executableStat, named) || named.isSymbolicLink() || sha256(observed) !== configuration.executableSha256) return uncertain();
    return Object.freeze({ directory: staging.directory,
      directoryIdentity: Object.freeze({ device: directoryStat.dev, inode: directoryStat.ino }),
      executable: staging.executable,
      executableIdentity: Object.freeze({ device: executableStat.dev, inode: executableStat.ino }) });
  } catch {
    await handle?.close().catch(() => undefined); handle = undefined;
    if (!(await cleanIdentityOwnedStaging(staging))) retainPartial(Object.freeze({ ...staging }));
    return uncertain();
  }
  finally { captured.fill(0); await handle?.close().catch(() => undefined); }
}
async function removeStaged(staged: Staged): Promise<void> {
  if (!(await cleanIdentityOwnedStaging({ directory: staged.directory,
    directoryIdentity: { dev: staged.directoryIdentity.device, ino: staged.directoryIdentity.inode },
    executable: staged.executable,
    executableIdentity: { dev: staged.executableIdentity.device, ino: staged.executableIdentity.inode } }))) return uncertain();
}

function frame(configuration: Configuration, operation: 1 | 2, kind: number, deadlineUnixMs: number,
  identity?: NativeIdentity): Buffer {
  const path = operation === 1 ? Buffer.from(configuration.rootPath, "utf8") : Buffer.alloc(0);
  const installation = Buffer.from(configuration.installationId, "utf8");
  const header = Buffer.alloc(72); header.write("ACRCFG1\n", "ascii"); header[8] = operation; header[9] = kind;
  header.writeUInt32BE(path.length, 16); header.writeUInt32BE(installation.length, 20);
  header.writeUInt32BE(operation === 1 ? configuration.configurationBytes.length : 0, 24);
  header.writeUInt32BE(operation === 1 ? configuration.manifestBytes.length : 0, 28);
  header.writeBigUInt64BE(BigInt(identity?.device ?? 0), 32); header.writeBigUInt64BE(BigInt(identity?.inode ?? 0), 40);
  header.writeBigUInt64BE(BigInt(configuration.expectedOwnerUid), 48); header.writeBigUInt64BE(BigInt(deadlineUnixMs), 56);
  header.writeUInt32BE(identity?.mode ?? 0, 64);
  return Buffer.concat([header, path, installation, Buffer.from(configuration.releaseDigest, "ascii"),
    Buffer.from(configuration.planDigest, "ascii"), ...(operation === 1 ? [configuration.configurationBytes,
      configuration.manifestBytes] : [])]);
}

type ProcessCustody = { readonly helpers: Set<object>; readonly groups: Set<number> };

function groupAbsent(processGroup: number): boolean {
  try { process.kill(-processGroup, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function runHelper(staged: Staged, input: Buffer, descriptor: number | undefined, signal: AbortSignal,
  deadlineUnixMs: number, custody: ProcessCustody): Promise<Buffer> {
  const remaining = deadlineUnixMs - Date.now();
  if (remaining <= 0 || signal.aborted) return Promise.reject(sanitized("refused"));
  return new Promise((resolve, reject) => {
    let settled = false, failed = false, outputCount = 0, leaderClosed = false;
    let escalation: ReturnType<typeof setTimeout> | undefined, retirementPoll: ReturnType<typeof setTimeout> | undefined;
    let retirementDeadline = 0; const chunks: Buffer[] = [];
    const child = spawn(staged.executable, [], { shell: false, cwd: "/", detached: true,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe", descriptor === undefined ? "ignore" : descriptor] });
    custody.helpers.add(child);
    if (child.pid) custody.groups.add(child.pid);
    const finish = (value?: Buffer) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(escalation); clearTimeout(retirementPoll);
      signal.removeEventListener("abort", cancel); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      if (value && !failed) resolve(value); else reject(sanitized("uncertain"));
    };
    const groupAlive = () => child.pid !== undefined && !groupAbsent(child.pid);
    const confirmGroupAbsent = () => {
      if (child.pid !== undefined && groupAbsent(child.pid)) custody.groups.delete(child.pid);
    };
    const groupSignal = (childSignal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, childSignal); } catch { /* retirement poll decides */ }
      if (!leaderClosed) try { child.kill(childSignal); } catch { /* retirement poll decides */ }
    };
    const pollRetirement = () => {
      if (settled) return;
      if (leaderClosed && !groupAlive()) { confirmGroupAbsent(); finish(); return; }
      if (performance.now() >= retirementDeadline) { groupSignal("SIGKILL"); finish(); return; }
      retirementPoll = setTimeout(pollRetirement, 10);
    };
    const cancel = () => {
      if (settled || failed) return; failed = true; child.stdin?.destroy(); retirementDeadline = performance.now() + 2_000;
      groupSignal("SIGTERM"); escalation = setTimeout(() => groupSignal("SIGKILL"), 250); pollRetirement();
    };
    const timer = setTimeout(cancel, Math.max(1, remaining)); signal.addEventListener("abort", cancel, { once: true });
    child.on("error", () => { if (!child.pid) custody.helpers.delete(child); cancel(); });
    child.stdin?.on("error", cancel); child.stdout?.on("error", cancel);
    child.stderr?.on("error", cancel); child.stderr?.on("data", cancel);
    child.stdout?.on("data", (chunk: Buffer) => {
      outputCount += chunk.length; if (outputCount > maximumOutputBytes) cancel(); else if (!failed) chunks.push(Buffer.from(chunk));
    });
    child.once("close", (code, childSignal) => {
      leaderClosed = true; custody.helpers.delete(child); confirmGroupAbsent();
      if (settled) return;
      const output = Buffer.concat(chunks);
      if (code !== 0 || childSignal !== null || signal.aborted || Date.now() >= deadlineUnixMs) failed = true;
      if (!failed && !groupAlive()) finish(output);
      else { failed = true; if (retirementDeadline === 0) retirementDeadline = performance.now() + 2_000;
        groupSignal("SIGKILL"); pollRetirement(); }
    });
    if (signal.aborted) cancel(); else child.stdin?.end(input);
  });
}

function number(text: string): number {
  if (!/^\d{1,16}$/u.test(text)) return uncertain();
  const value = Number(text); if (!Number.isSafeInteger(value)) return uncertain(); return value;
}
function parsePublication(bytes: Buffer, configuration: Configuration): PrivateInstalledConfigurationNativePublicationReceiptV1 {
  const match = /^ACRCFG1 P (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)\n$/u.exec(bytes.toString("ascii"));
  if (!match) return uncertain(); const values = match.slice(1).map(number);
  if (values[8] !== configuration.expectedOwnerUid || values[9] !== configuration.configurationBytes.length
    || values[10] !== configuration.manifestBytes.length) return uncertain();
  return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLICATION_RECEIPT_V1,
    outcome: "published" as const, installationId: configuration.installationId, releaseDigest: configuration.releaseDigest,
    planDigest: configuration.planDigest, configurationSha256: configuration.configurationSha256,
    manifestSha256: configuration.manifestSha256, ownerUid: configuration.expectedOwnerUid,
    rootIdentity: Object.freeze({ device: values[0]!, inode: values[1]! }),
    configurationIdentity: Object.freeze({ device: values[2]!, inode: values[3]! }),
    manifestIdentity: Object.freeze({ device: values[4]!, inode: values[5]! }),
    journalIdentity: Object.freeze({ device: values[6]!, inode: values[7]! }),
    rootMode: 0o700 as const, configurationMode: 0o600 as const, manifestMode: 0o600 as const,
    journalMode: 0o700 as const, extendedAcl: false as const, replacedExistingRoot: false as const });
}
function parseVerification(bytes: Buffer, request: ReturnType<typeof captureVerifyRequest>) {
  const match = /^ACRCFG1 V ([1-4]) (\d+) (\d+) (\d+) (\d+) ([01])\n$/u.exec(bytes.toString("ascii"));
  if (!match) return uncertain(); const values = match.slice(1).map(number);
  if (values[0] !== kindCode[request.kind] || values[1] !== request.identity.device || values[2] !== request.identity.inode
    || values[3] !== request.identity.ownerUid || values[4] !== request.identity.mode
    || request.kind !== "ancestor" && values[5] !== 0) return uncertain();
  return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1, outcome: "verified" as const,
    descriptor: request.descriptor, device: request.identity.device, inode: request.identity.inode,
    ownerUid: request.identity.ownerUid, mode: request.identity.mode, extendedAcl: values[5] === 1,
    ancestorVerified: true as const });
}

/** Creates a fixed-purpose host. It copies the release-hash-checked helper to a
 * private staging directory before use and never executes the supplied path. */
export function createPrivateInstalledConfigurationNativeHostV1(value: unknown): PrivateInstalledConfigurationNativeHostV1 {
  const configuration = captureConfiguration(value); let staged: Staged | undefined, preparing: Promise<Staged> | undefined;
  let partialStaging: Readonly<PartialStaging> | undefined;
  let inFlight = false, publicationBurned = false, closing = false, cleanupInFlight = false, closed = false;
  const custody: ProcessCustody = { helpers: new Set(), groups: new Set() };
  const acquire = async () => {
    if (closed || closing) return refuse(); if (staged) return staged;
    preparing ??= stageHelper(configuration, partial => { partialStaging = partial; });
    try { staged = await preparing; return staged; } finally { preparing = undefined; }
  };
  return Object.freeze({
    schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_HOST_V1,
    async publish(value) {
      if (inFlight || closing || closed || publicationBurned || partialStaging
        || custody.helpers.size !== 0 || custody.groups.size !== 0) return refuse();
      const request = capturePublishRequest(value); publicationBurned = true; inFlight = true;
      try {
        const helper = await acquire();
        return parsePublication(await runHelper(helper, frame(configuration, 1, 0, request.deadlineUnixMs), undefined,
          request.signal, request.deadlineUnixMs, custody), configuration);
      } catch { return uncertain(); }
      finally {
        configuration.configurationBytes.fill(0); configuration.manifestBytes.fill(0); inFlight = false;
      }
    },
    async verifyProtectedPath(value) {
      if (inFlight || closing || closed || partialStaging || custody.helpers.size !== 0 || custody.groups.size !== 0) return refuse();
      const request = captureVerifyRequest(value, configuration.expectedOwnerUid);
      inFlight = true; const deadlineUnixMs = Date.now() + 30_000;
      try {
        const helper = await acquire();
        return parseVerification(await runHelper(helper, frame(configuration, 2, kindCode[request.kind], deadlineUnixMs,
          request.identity), request.descriptor, request.signal, deadlineUnixMs, custody), request);
      } catch { return uncertain(); }
      finally { inFlight = false; }
    },
    inspectReadiness() {
      const observedState = closed ? "closed" : closing || inFlight || preparing ? "unresolved"
        : custody.helpers.size !== 0 || custody.groups.size !== 0 ? "unresolved" : "ready";
      const state = partialStaging ? "unresolved" : observedState;
      return Object.freeze({ state,
        staged: staged !== undefined || partialStaging?.directory !== undefined,
        publicationAvailable: !closing && !closed && !inFlight && !publicationBurned && state === "ready",
        unresolvedHelperProcesses: custody.helpers.size, unresolvedProcessGroups: custody.groups.size });
    },
    async cleanup(signal) {
      if (!(signal instanceof AbortSignal) || signal.aborted || inFlight || preparing || cleanupInFlight || closed) return uncertain();
      // Closing is terminal for new native work, but deliberately not for
      // cleanup: a failed exact-removal attempt remains retryable.
      closing = true; cleanupInFlight = true;
      for (const processGroup of custody.groups) if (groupAbsent(processGroup)) custody.groups.delete(processGroup);
      if (custody.helpers.size !== 0 || custody.groups.size !== 0) { cleanupInFlight = false; return uncertain(); }
      configuration.configurationBytes.fill(0); configuration.manifestBytes.fill(0);
      try {
        if (partialStaging) {
          if (!(await cleanIdentityOwnedStaging(partialStaging))) return uncertain();
          partialStaging = undefined;
        }
        if (staged) await removeStaged(staged);
        staged = undefined; closed = true; return Object.freeze({ outcome: "confirmed" as const });
      }
      catch { return uncertain(); }
      finally { cleanupInFlight = false; }
    },
  });
}
