import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readdir, realpath, rmdir, unlink,
  type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { sha256Digest } from "../../security/canonical-digest";
import { PRIVATE_MACOS_SERVICE_LABEL_V1 } from "./private-macos-service-owner-runner";
import { PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1, PRIVATE_MACOS_SERVICE_RUNTIME_RECEIPT_V1,
  type PrivateMacosServiceRuntimeHostReceiptV1, type PrivateMacosServiceRuntimeHostRequestV1,
  type PrivateMacosServiceRuntimeHostV1 } from "./private-macos-service-runtime-port";

/** One fixed native host for the accepted per-owner LaunchAgent. Construction
 * captures data and callables only. It does not inspect a path, stage bytes,
 * publish a definition, invoke launchctl, or observe service health. */
export const PRIVATE_MACOS_SERVICE_NATIVE_HOST_CONFIGURATION_V1 =
  "control-room.private-macos-service-native-host-configuration/v1" as const;
export const PRIVATE_MACOS_SERVICE_NATIVE_HELPER_PROTOCOL_V1 = "ACRSVC1" as const;
export const PRIVATE_MACOS_SERVICE_NATIVE_HOST_ACTIVATION_BLOCKERS_V1 = Object.freeze([
  "release_custody_missing",
  "authenticated_application_health_verifier_missing",
] as const);

type Identity = Readonly<{ device: string; inode: string }>;
type DefinitionIdentity = Readonly<Identity & { size: number; sha256: string }>;
type ServiceIdentity = Readonly<{ label: typeof PRIVATE_MACOS_SERVICE_LABEL_V1 }>;
type Configuration = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_NATIVE_HOST_CONFIGURATION_V1;
  helperPath: string;
  helperSha256: string;
  ownerUid: number;
  ownerHome: string;
  releaseDigest: string;
  serviceDefinitionDigest: string;
  definitionParentIdentityDigest: string;
  definitionParentIdentity: Identity;
  definitionIdentityDigest: string | null;
  definitionIdentity: DefinitionIdentity | null;
  serviceIdentityDigest: string;
  serviceIdentity: ServiceIdentity;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const integerPattern = /^(?:0|[1-9][0-9]{0,19})$/u;
const maximumHelperBytes = 16 * 1024 * 1024;
const maximumDefinitionBytes = 256 * 1024;
const responseBytes = 96;

function sanitized(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_macos_service_native_host_${kind}`);
  error.stack = undefined;
  return error;
}
const refuse = (): never => { throw sanitized("refused"); };
const uncertain = (): never => { throw sanitized("uncertain"); };

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key)) || names.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
  })) return refuse();
  const captured: Record<string, unknown> = {};
  for (const name of names) captured[name] = Object.getOwnPropertyDescriptor(value, name)!.value;
  return Object.freeze(captured);
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refuse();
  return value;
}
function uint64(value: unknown): string {
  if (typeof value !== "string" || !integerPattern.test(value) || BigInt(value) > 0xffff_ffff_ffff_ffffn) return refuse();
  return value;
}
function identity(value: unknown): Identity {
  const input = exact(value, ["device", "inode"]);
  return Object.freeze({ device: uint64(input.device), inode: uint64(input.inode) });
}
function definitionIdentity(value: unknown): DefinitionIdentity {
  const input = exact(value, ["device", "inode", "size", "sha256"]);
  if (!Number.isSafeInteger(input.size) || (input.size as number) < 1
    || (input.size as number) > maximumDefinitionBytes) return refuse();
  return Object.freeze({ device: uint64(input.device), inode: uint64(input.inode),
    size: input.size as number, sha256: digest(input.sha256) });
}
function parentIdentityDigest(value: Identity): string {
  return sha256Digest({ purpose: "private-macos-service-native-definition-parent-identity/v1",
    device: value.device, inode: value.inode });
}
function definitionIdentityDigest(value: DefinitionIdentity | null): string | null {
  return value === null ? null : sha256Digest({ purpose: "private-macos-service-native-definition-identity/v1",
    device: value.device, inode: value.inode, size: value.size, sha256: value.sha256 });
}
function serviceIdentityDigest(value: ServiceIdentity): string {
  return sha256Digest({ purpose: "macos-service-identity/v1", label: value.label });
}
function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value === "/"
    || value.endsWith("/") || Buffer.byteLength(value, "utf8") > 4095
    || /[\u0000-\u001f\u007f]/u.test(value)) return refuse();
  return value;
}

function captureConfiguration(value: unknown): Configuration {
  const input = exact(value, ["schema", "helperPath", "helperSha256", "ownerUid", "ownerHome", "releaseDigest",
    "serviceDefinitionDigest", "definitionParentIdentityDigest", "definitionParentIdentity",
    "definitionIdentityDigest", "definitionIdentity", "serviceIdentityDigest", "serviceIdentity"]);
  if (input.schema !== PRIVATE_MACOS_SERVICE_NATIVE_HOST_CONFIGURATION_V1
    || !Number.isSafeInteger(input.ownerUid) || (input.ownerUid as number) < 1
    || (input.ownerUid as number) > 2_147_483_647 || typeof input.ownerHome !== "string"
    || !/^\/Users\/[^/]+$/u.test(input.ownerHome) || normalize(input.ownerHome) !== input.ownerHome) return refuse();
  const foundDefinition = input.definitionIdentity === null ? null : definitionIdentity(input.definitionIdentity);
  const foundDefinitionDigest = input.definitionIdentityDigest === null ? null : digest(input.definitionIdentityDigest);
  if ((foundDefinition === null) !== (foundDefinitionDigest === null)) return refuse();
  const foundParent = identity(input.definitionParentIdentity);
  const foundParentDigest = digest(input.definitionParentIdentityDigest);
  const foundServiceIdentity = exact(input.serviceIdentity, ["label"]);
  if (foundServiceIdentity.label !== PRIVATE_MACOS_SERVICE_LABEL_V1) return refuse();
  const capturedServiceIdentity = Object.freeze({ label: PRIVATE_MACOS_SERVICE_LABEL_V1 });
  const foundServiceDigest = digest(input.serviceIdentityDigest);
  if (parentIdentityDigest(foundParent) !== foundParentDigest
    || definitionIdentityDigest(foundDefinition) !== foundDefinitionDigest
    || serviceIdentityDigest(capturedServiceIdentity) !== foundServiceDigest) return refuse();
  return Object.freeze({ schema: PRIVATE_MACOS_SERVICE_NATIVE_HOST_CONFIGURATION_V1,
    helperPath: absolutePath(input.helperPath), helperSha256: digest(input.helperSha256),
    ownerUid: input.ownerUid as number, ownerHome: input.ownerHome,
    releaseDigest: digest(input.releaseDigest), serviceDefinitionDigest: digest(input.serviceDefinitionDigest),
    definitionParentIdentityDigest: foundParentDigest,
    definitionParentIdentity: foundParent,
    definitionIdentityDigest: foundDefinitionDigest, definitionIdentity: foundDefinition,
    serviceIdentityDigest: foundServiceDigest, serviceIdentity: capturedServiceIdentity });
}

type CapturedRequest = PrivateMacosServiceRuntimeHostRequestV1;
const operations = ["verify_supervisor_readiness", "verify_release", "verify_service_definition",
  "install_service_definition", "start_service", "verify_service_health", "inspect_service_status", "stop_service"] as const;

function captureRequest(value: unknown, configuration: Configuration,
  currentDefinitionDigest: string | null): CapturedRequest {
  const hasDefinition = value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "serviceDefinition");
  const input = exact(value, ["schema", "operation", "ownerUid", "launchctlDomain", "launchctlTarget", "label",
    "launchAgentPath", "requestDigest", "lifecycleDigest", "releaseDigest", "serviceDefinitionDigest",
    "expectedDefinitionParentIdentityDigest", "expectedDefinitionIdentityDigest", "expectedServiceIdentityDigest",
    ...(hasDefinition ? ["serviceDefinition"] : []), "deadlineUnixMs", "signal"]);
  const launchAgentPath = join(configuration.ownerHome, "Library", "LaunchAgents", `${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist`);
  if (input.schema !== PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1 || typeof input.operation !== "string"
    || !operations.includes(input.operation as typeof operations[number]) || input.ownerUid !== configuration.ownerUid
    || input.launchctlDomain !== `gui/${configuration.ownerUid}`
    || input.launchctlTarget !== `gui/${configuration.ownerUid}/${PRIVATE_MACOS_SERVICE_LABEL_V1}`
    || input.label !== PRIVATE_MACOS_SERVICE_LABEL_V1 || input.launchAgentPath !== launchAgentPath
    || input.releaseDigest !== configuration.releaseDigest
    || input.serviceDefinitionDigest !== configuration.serviceDefinitionDigest
    || input.expectedDefinitionParentIdentityDigest !== configuration.definitionParentIdentityDigest
    || input.expectedDefinitionIdentityDigest !== currentDefinitionDigest
    || input.expectedServiceIdentityDigest !== configuration.serviceIdentityDigest
    || (input.operation === "install_service_definition") !== hasDefinition
    || !Number.isSafeInteger(input.deadlineUnixMs) || (input.deadlineUnixMs as number) <= Date.now()
    || (input.deadlineUnixMs as number) > Date.now() + 300_000
    || !(input.signal instanceof AbortSignal) || input.signal.aborted) return refuse();
  if (hasDefinition && (typeof input.serviceDefinition !== "string"
    || Buffer.byteLength(input.serviceDefinition, "utf8") < 1
    || Buffer.byteLength(input.serviceDefinition, "utf8") > maximumDefinitionBytes
    || sha256Digest(input.serviceDefinition) !== configuration.serviceDefinitionDigest)) return refuse();
  return Object.freeze({ schema: PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1,
    operation: input.operation as CapturedRequest["operation"], ownerUid: configuration.ownerUid,
    launchctlDomain: input.launchctlDomain as string, launchctlTarget: input.launchctlTarget as string,
    label: PRIVATE_MACOS_SERVICE_LABEL_V1, launchAgentPath,
    requestDigest: digest(input.requestDigest), lifecycleDigest: digest(input.lifecycleDigest),
    releaseDigest: configuration.releaseDigest, serviceDefinitionDigest: configuration.serviceDefinitionDigest,
    expectedDefinitionParentIdentityDigest: configuration.definitionParentIdentityDigest,
    expectedDefinitionIdentityDigest: currentDefinitionDigest,
    expectedServiceIdentityDigest: configuration.serviceIdentityDigest,
    ...(hasDefinition ? { serviceDefinition: input.serviceDefinition as string } : {}),
    deadlineUnixMs: input.deadlineUnixMs as number, signal: input.signal as AbortSignal });
}

type Staged = { directory: string; directoryDevice: bigint; directoryInode: bigint;
  executable: string; executableDevice: bigint; executableInode: bigint };
type UnresolvedProcessGroup = Readonly<{ absenceProven(): boolean }>;
type PartialStaging = { directory?: string; directoryIdentity?: Readonly<{ dev: bigint; ino: bigint }>;
  executable?: string; executableIdentity?: Readonly<{ dev: bigint; ino: bigint }> };

async function cleanIdentityOwnedStaging(staging: PartialStaging): Promise<boolean> {
  if (!staging.directory) return true;
  if (!staging.directoryIdentity) return false;
  try {
    const directory = await lstat(staging.directory, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || directory.dev !== staging.directoryIdentity.dev || directory.ino !== staging.directoryIdentity.ino) return false;
    const entries = await readdir(staging.directory);
    if (entries.length === 1 && staging.executable && entries[0] === "macos-service-v1") {
      if (!staging.executableIdentity) return false;
      const executable = await lstat(staging.executable, { bigint: true });
      if (!executable.isFile() || executable.isSymbolicLink() || executable.nlink !== 1n
        || executable.dev !== staging.executableIdentity.dev || executable.ino !== staging.executableIdentity.ino) return false;
      await unlink(staging.executable);
    } else if (entries.length !== 0) return false;
    await rmdir(staging.directory);
    return true;
  } catch { return false; }
}

async function checkedHelper(configuration: Configuration): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    if (await realpath(configuration.helperPath) !== configuration.helperPath) return refuse();
    for (let parent = dirname(configuration.helperPath); ; parent = dirname(parent)) {
      const stat = await lstat(parent);
      const stickyTemp = parent === "/private/tmp" && stat.uid === 0 && (stat.mode & 0o7777) === 0o1777;
      if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, configuration.ownerUid].includes(stat.uid)
        || (!stickyTemp && (stat.mode & 0o022) !== 0)) return refuse();
      if (parent === "/") break;
    }
    handle = await open(configuration.helperPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || ![0n, BigInt(configuration.ownerUid)].includes(before.uid)
      || (before.mode & 0o6022n) !== 0n || (before.mode & 0o100n) === 0n
      || before.size < 1n || before.size > BigInt(maximumHelperBytes)) return refuse();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead < 1) return refuse();
      offset += read.bytesRead;
    }
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== configuration.helperSha256) return refuse();
    const after = await handle.stat({ bigint: true }), named = await lstat(configuration.helperPath, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino) return refuse();
    return bytes;
  } catch { return refuse(); }
  finally { await handle?.close(); }
}

async function stageHelper(configuration: Configuration,
  retainPartial: (staging: Readonly<PartialStaging>) => void): Promise<Staged> {
  const bytes = await checkedHelper(configuration);
  const staging: PartialStaging = {};
  let handle: FileHandle | undefined;
  try {
    staging.directory = await mkdtemp("/private/tmp/acr-service-native-");
    const createdDirectory = await lstat(staging.directory, { bigint: true });
    staging.directoryIdentity = { dev: createdDirectory.dev, ino: createdDirectory.ino };
    await chmod(staging.directory, 0o700);
    const directoryStat = await lstat(staging.directory, { bigint: true });
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== BigInt(configuration.ownerUid)
      || directoryStat.dev !== createdDirectory.dev || directoryStat.ino !== createdDirectory.ino
      || (directoryStat.mode & 0o7777n) !== 0o700n || (await readdir(staging.directory)).length !== 0) throw sanitized("uncertain");
    staging.executable = join(staging.directory, "macos-service-v1");
    handle = await open(staging.executable, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
      | constants.O_RDWR | constants.O_NONBLOCK, 0o500);
    const createdExecutable = await handle.stat({ bigint: true });
    staging.executableIdentity = { dev: createdExecutable.dev, ino: createdExecutable.ino };
    let offset = 0;
    while (offset < bytes.length) {
      const written = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (written.bytesWritten < 1) throw sanitized("uncertain");
      offset += written.bytesWritten;
    }
    await handle.sync();
    const stat = await handle.stat({ bigint: true }), observed = Buffer.alloc(bytes.length);
    offset = 0;
    while (offset < observed.length) {
      const read = await handle.read(observed, offset, observed.length - offset, offset);
      if (read.bytesRead < 1) throw sanitized("uncertain");
      offset += read.bytesRead;
    }
    const named = await lstat(staging.executable, { bigint: true });
    const entries = await readdir(staging.directory);
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(configuration.ownerUid)
      || (stat.mode & 0o7777n) !== 0o500n || named.dev !== stat.dev || named.ino !== stat.ino
      || stat.dev !== createdExecutable.dev || stat.ino !== createdExecutable.ino
      || entries.length !== 1 || entries[0] !== "macos-service-v1"
      || `sha256:${createHash("sha256").update(observed).digest("hex")}` !== configuration.helperSha256) throw sanitized("uncertain");
    return { directory: staging.directory, directoryDevice: directoryStat.dev, directoryInode: directoryStat.ino,
      executable: staging.executable, executableDevice: stat.dev, executableInode: stat.ino };
  } catch {
    await handle?.close().catch(() => undefined); handle = undefined;
    if (!(await cleanIdentityOwnedStaging(staging))) retainPartial(Object.freeze({ ...staging }));
    return uncertain();
  } finally { bytes.fill(0); await handle?.close().catch(() => undefined); }
}

async function removeStaged(staged: Staged): Promise<void> {
  const directory = await lstat(staged.directory, { bigint: true });
  const executable = await lstat(staged.executable, { bigint: true });
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== staged.directoryDevice
    || directory.ino !== staged.directoryInode || executable.isSymbolicLink() || !executable.isFile()
    || executable.nlink !== 1n || executable.dev !== staged.executableDevice || executable.ino !== staged.executableInode
    || (await readdir(staged.directory)).length !== 1) return uncertain();
  await unlink(staged.executable); await rmdir(staged.directory);
}

function executableOperationCode(operation: CapturedRequest["operation"]): number {
  switch (operation) {
    case "verify_supervisor_readiness": return 1;
    case "verify_service_definition": return 2;
    case "install_service_definition": return 3;
    case "inspect_service_status": return 4;
    case "start_service": return 5;
    case "stop_service": return 6;
    case "verify_release":
    case "verify_service_health": return refuse();
  }
}

function requestFrame(configuration: Configuration, request: CapturedRequest,
  expected: DefinitionIdentity | null): Buffer {
  const pathBytes = Buffer.from(request.launchAgentPath, "utf8");
  const definition = Buffer.from(request.serviceDefinition ?? "", "utf8");
  const header = Buffer.alloc(120);
  header.write("ACRSVC1\n", "ascii"); header.writeUInt32BE(1, 8);
  header.writeUInt32BE(executableOperationCode(request.operation), 12);
  [BigInt(configuration.ownerUid), BigInt(request.deadlineUnixMs),
    BigInt(configuration.definitionParentIdentity.device), BigInt(configuration.definitionParentIdentity.inode)]
    .forEach((value, index) => header.writeBigUInt64BE(value, 16 + index * 8));
  header.writeUInt32BE(pathBytes.length, 48); header.writeUInt32BE(definition.length, 52);
  header.writeUInt32BE(expected ? 1 : 0, 56); header.writeUInt32BE(0, 60);
  if (expected) {
    header.writeBigUInt64BE(BigInt(expected.device), 64); header.writeBigUInt64BE(BigInt(expected.inode), 72);
    header.writeBigUInt64BE(BigInt(expected.size), 80); Buffer.from(expected.sha256.slice(7), "hex").copy(header, 88);
  }
  return Buffer.concat([header, pathBytes, definition]);
}

function runHelper(staged: Staged, input: Buffer, request: CapturedRequest,
  retainUnresolved: (custody: UnresolvedProcessGroup) => void): Promise<Buffer> {
  const remaining = request.deadlineUnixMs - Date.now();
  if (remaining <= 0 || request.signal.aborted) return Promise.reject(sanitized("refused"));
  return new Promise((resolve, reject) => {
    let settled = false, failed = false, count = 0, leaderClosed = false, killSent = false, custodyRetained = false;
    let escalation: ReturnType<typeof setTimeout> | undefined, retirementPoll: ReturnType<typeof setTimeout> | undefined;
    let retirementDeadline = 0;
    const chunks: Buffer[] = [];
    const child = spawn(staged.executable, [], { shell: false, cwd: "/", detached: true,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (value?: Buffer) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(escalation); clearTimeout(retirementPoll);
      request.signal.removeEventListener("abort", cancel);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (value && !failed) resolve(value); else reject(sanitized("uncertain"));
    };
    const groupAlive = () => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    };
    const groupSignal = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { /* retirement poll decides */ }
      if (!leaderClosed) try { child.kill(signal); } catch { /* retirement poll decides */ }
    };
    const retainCustody = () => {
      if (custodyRetained) return;
      custodyRetained = true;
      retainUnresolved(Object.freeze({ absenceProven: () => leaderClosed && !groupAlive() }));
    };
    const pollRetirement = () => {
      if (settled) return;
      if (leaderClosed && !groupAlive()) { finish(); return; }
      if (!killSent && performance.now() >= retirementDeadline - 1_750) {
        killSent = true; groupSignal("SIGKILL");
      }
      if (performance.now() >= retirementDeadline) { retainCustody(); finish(); return; }
      retirementPoll = setTimeout(pollRetirement, 10);
    };
    const cancel = () => {
      if (settled || failed) return;
      failed = true; child.stdin.destroy();
      if (retirementDeadline === 0) retirementDeadline = performance.now() + 2_000;
      groupSignal("SIGTERM"); escalation = setTimeout(() => groupSignal("SIGKILL"), 250); pollRetirement();
    };
    const timer = setTimeout(cancel, Math.max(1, remaining));
    request.signal.addEventListener("abort", cancel, { once: true });
    child.on("error", cancel); child.stdin.on("error", cancel); child.stdout.on("error", cancel);
    child.stderr.on("error", cancel); child.stderr.on("data", cancel);
    child.stdout.on("data", (chunk: Buffer) => {
      count += chunk.length;
      if (count > responseBytes) cancel(); else if (!failed) chunks.push(Buffer.from(chunk));
    });
    child.once("close", (code, signal) => {
      leaderClosed = true;
      const output = Buffer.concat(chunks);
      if (code !== 0 || signal !== null || request.signal.aborted || Date.now() >= request.deadlineUnixMs
        || output.length !== responseBytes) failed = true;
      if (!failed && !groupAlive()) finish(output);
      else {
        failed = true;
        if (retirementDeadline === 0) retirementDeadline = performance.now() + 2_000;
        killSent = true; groupSignal("SIGKILL"); pollRetirement();
      }
    });
    if (request.signal.aborted) cancel(); else child.stdin.end(input);
  });
}

type HelperResult = Readonly<{ outcome: "succeeded" | "failed_before_effect";
  state: "not_installed" | "stopped" | "running" | "unknown";
  definition: DefinitionIdentity | null }>;
function parseResponse(bytes: Buffer, configuration: Configuration): HelperResult {
  if (bytes.length !== responseBytes || bytes.subarray(0, 8).toString("ascii") !== "ACRSVR1\n") return uncertain();
  const outcomeCode = bytes.readUInt32BE(8), stateCode = bytes.readUInt32BE(12);
  if (![1, 2].includes(outcomeCode) || ![1, 2, 3, 4].includes(stateCode)
    || bytes.readBigUInt64BE(16).toString() !== configuration.definitionParentIdentity.device
    || bytes.readBigUInt64BE(24).toString() !== configuration.definitionParentIdentity.inode) return uncertain();
  const present = bytes.readUInt32BE(32), reserved = bytes.readUInt32BE(36);
  if (![0, 1].includes(present) || reserved !== 0) return uncertain();
  if (present === 0 && bytes.subarray(40).some(byte => byte !== 0)) return uncertain();
  const definition = present === 0 ? null : Object.freeze({ device: bytes.readBigUInt64BE(40).toString(),
    inode: bytes.readBigUInt64BE(48).toString(), size: Number(bytes.readBigUInt64BE(56)),
    sha256: `sha256:${bytes.subarray(64, 96).toString("hex")}` });
  if (definition && (!Number.isSafeInteger(definition.size) || definition.size < 1
    || definition.size > maximumDefinitionBytes)) return uncertain();
  return Object.freeze({ outcome: outcomeCode === 1 ? "succeeded" : "failed_before_effect",
    state: (["", "not_installed", "stopped", "running", "unknown"] as const)[stateCode]!, definition });
}

/** Creates the exact runtime host. The helper is release-hash checked and
 * copied into a fresh private staging directory before the first invocation;
 * the configured source pathname is never executed. */
export function createPrivateMacosServiceNativeHostV1(input: unknown): PrivateMacosServiceRuntimeHostV1 {
  const configuration = captureConfiguration(input);
  let currentDefinition = configuration.definitionIdentity;
  let currentDefinitionDigest = configuration.definitionIdentityDigest;
  let staged: Staged | undefined;
  let partialStaging: Readonly<PartialStaging> | undefined;
  let preparing: Promise<Staged> | undefined;
  let unresolved: UnresolvedProcessGroup | undefined;
  let inFlight = false;
  let terminal = false;
  let closed = false;
  const acquire = async () => {
    if (closed) return refuse();
    if (staged) return staged;
    preparing ??= stageHelper(configuration, partial => {
      partialStaging = partial;
      terminal = true;
    });
    try { staged = await preparing; return staged; }
    finally { preparing = undefined; }
  };
  const execute = async (request: CapturedRequest) => {
    const start = performance.now();
    let helper: Staged;
    try { helper = await acquire(); }
    catch (error) { terminal = true; throw error; }
    if (request.signal.aborted || Date.now() >= request.deadlineUnixMs) return refuse();
    let bytes: Buffer;
    try {
      bytes = await runHelper(helper, requestFrame(configuration, request, currentDefinition), request,
        custody => { unresolved = custody; terminal = true; });
    } catch (error) { terminal = true; throw error; }
    let result: HelperResult;
    try { result = parseResponse(bytes, configuration); }
    catch (error) { terminal = true; throw error; }
    if (request.signal.aborted || Date.now() >= request.deadlineUnixMs || performance.now() < start) {
      terminal = true; return uncertain();
    }
    const foundDigest = definitionIdentityDigest(result.definition);
    if (request.operation !== "install_service_definition" && foundDigest !== currentDefinitionDigest) {
      terminal = true; return uncertain();
    }
    if (request.operation === "install_service_definition" && result.outcome === "succeeded") {
      const definitionBytesSha256 = `sha256:${createHash("sha256").update(request.serviceDefinition!, "utf8").digest("hex")}`;
      if (!result.definition || result.definition.sha256 !== definitionBytesSha256) {
        terminal = true; return uncertain();
      }
      currentDefinition = result.definition; currentDefinitionDigest = foundDigest;
    }
    return Object.freeze({ result, definitionIdentityDigest: foundDigest });
  };
  const receipt = (request: CapturedRequest, found: Awaited<ReturnType<typeof execute>>): PrivateMacosServiceRuntimeHostReceiptV1 =>
    Object.freeze({ schema: PRIVATE_MACOS_SERVICE_RUNTIME_RECEIPT_V1, operation: request.operation,
      outcome: found.result.outcome, ownerUid: configuration.ownerUid, launchctlDomain: request.launchctlDomain,
      launchctlTarget: request.launchctlTarget, label: PRIVATE_MACOS_SERVICE_LABEL_V1,
      launchAgentPath: request.launchAgentPath, requestDigest: request.requestDigest,
      lifecycleDigest: request.lifecycleDigest, releaseDigest: configuration.releaseDigest,
      serviceDefinitionDigest: configuration.serviceDefinitionDigest,
      definitionParentIdentityDigest: configuration.definitionParentIdentityDigest,
      definitionIdentityDigest: found.definitionIdentityDigest, serviceIdentityDigest: configuration.serviceIdentityDigest,
      state: found.result.state });

  return Object.freeze({
    schema: PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1,
    async perform(value: PrivateMacosServiceRuntimeHostRequestV1) {
      if (inFlight || closed || terminal) return refuse();
      const request = captureRequest(value, configuration, currentDefinitionDigest);
      if (request.operation === "verify_release") return refuse();
      if (request.operation === "verify_service_health") return refuse();
      inFlight = true;
      try { return receipt(request, await execute(request)); }
      catch { return uncertain(); }
      finally { inFlight = false; }
    },
    async observeHealth(value: PrivateMacosServiceRuntimeHostRequestV1) {
      if (inFlight || closed || terminal) return refuse();
      const request = captureRequest(value, configuration, currentDefinitionDigest);
      if (request.operation !== "verify_service_health") return refuse();
      return uncertain();
    },
    async cleanup(signal: AbortSignal) {
      if (!(signal instanceof AbortSignal) || signal.aborted || inFlight || preparing || closed) return uncertain();
      terminal = true;
      if (unresolved && !unresolved.absenceProven()) return uncertain();
      unresolved = undefined;
      try {
        if (partialStaging) {
          if (!(await cleanIdentityOwnedStaging(partialStaging))) return uncertain();
          partialStaging = undefined;
        }
        if (staged) await removeStaged(staged);
        staged = undefined; closed = true;
        return Object.freeze({ outcome: "confirmed" as const });
      }
      catch { return uncertain(); }
    },
  });
}
