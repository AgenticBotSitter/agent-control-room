import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1, PRIVATE_PROTECTED_ROOT_NATIVE_RECEIPT_V1,
  type PrivateProtectedRootNativeCreateRequestV1, type PrivateProtectedRootNativeDirectoryV1,
  type PrivateProtectedRootNativeReceiptV1 } from "./private-protected-root-owner-adapter";

/** Private release composition only. The executable and its byte digest must
 * come from the verified native release artifact, never browser/request input.
 * Construction is inert. This factory does not compile, install or qualify it.
 * The source pathname is never executed. Verified bytes are copied into one
 * new private, ACL-free staging directory beneath the checked OS temp root.
 * Root and this OS owner remain trusted, as in the existing owner runner. */
export type PrivateProtectedRootNativeExecutableV1 = Readonly<{
  executablePath: string;
  executableSha256: string;
}>;

function failure(): Error {
  const error = new Error("private_protected_root_native_directory_uncertain");
  error.stack = undefined;
  return error;
}
const refuse = (): never => { throw failure(); };
function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key)
    || Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true
    || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return refuse();
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) return refuse();
  return value as number;
}
function path(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value
    || value === "/" || value.endsWith("/") || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 4096 || Buffer.from(value, "utf8").toString("utf8") !== value) return refuse();
  return value;
}
function capturedRequest(value: unknown): PrivateProtectedRootNativeCreateRequestV1 {
  const input = record(value, ["schema", "operation", "parentPath", "childName", "expectedParentIdentity",
    "expectedOwnerUid", "mode", "deadlineUnixMs", "signal"]);
  const identity = record(input.expectedParentIdentity, ["device", "inode"]);
  if (process.platform !== "darwin" || input.schema !== PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1
    || input.operation !== "create_one_private_child" || input.mode !== 0o700
    || typeof input.childName !== "string" || input.childName.length === 0
    || input.childName === "." || input.childName === ".." || /[/\u0000-\u001f\u007f]/u.test(input.childName)
    || Buffer.byteLength(input.childName, "utf8") > 255
    || Buffer.from(input.childName, "utf8").toString("utf8") !== input.childName
    || !(input.signal instanceof AbortSignal) || input.signal.aborted
    || typeof process.geteuid !== "function" || typeof process.getuid !== "function"
    || process.getuid() !== process.geteuid() || process.geteuid() === 0
    || input.expectedOwnerUid !== process.geteuid()) return refuse();
  const deadlineUnixMs = integer(input.deadlineUnixMs);
  const remaining = deadlineUnixMs - Date.now();
  if (remaining <= 0 || remaining > 30_000) return refuse();
  return Object.freeze({ schema: PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1, operation: "create_one_private_child",
    parentPath: path(input.parentPath), childName: input.childName,
    expectedParentIdentity: Object.freeze({ device: integer(identity.device), inode: integer(identity.inode) }),
    expectedOwnerUid: integer(input.expectedOwnerUid, 0x7fffffff), mode: 0o700,
    deadlineUnixMs, signal: input.signal });
}
function frame(request: PrivateProtectedRootNativeCreateRequestV1): Buffer {
  const parent = Buffer.from(request.parentPath, "utf8"), child = Buffer.from(request.childName, "utf8");
  const header = Buffer.alloc(48);
  header.write("ACRDIR1\n", "ascii");
  header.writeUInt32BE(parent.length, 8); header.writeUInt32BE(child.length, 12);
  [request.expectedParentIdentity.device, request.expectedParentIdentity.inode,
    request.expectedOwnerUid, request.deadlineUnixMs].forEach((value, index) => header.writeBigUInt64BE(BigInt(value), 16 + index * 8));
  return Buffer.concat([header, parent, child]);
}
function receipt(bytes: Buffer, request: PrivateProtectedRootNativeCreateRequestV1): PrivateProtectedRootNativeReceiptV1 {
  const found = /^ACRDIR1 (0|[1-9][0-9]*) (0|[1-9][0-9]*) (0|[1-9][0-9]*) (0|[1-9][0-9]*) (0|[1-9][0-9]*)\n$/u.exec(bytes.toString("ascii"));
  if (!found || !Buffer.from(bytes.toString("ascii"), "ascii").equals(bytes)) return refuse();
  const [device, inode, rootDevice, rootInode, uid] = found.slice(1).map(value => integer(Number(value)));
  if (device !== request.expectedParentIdentity.device || inode !== request.expectedParentIdentity.inode
    || uid !== request.expectedOwnerUid) return refuse();
  return Object.freeze({ schema: PRIVATE_PROTECTED_ROOT_NATIVE_RECEIPT_V1, operation: "mkdirat_then_fstatat",
    parentIdentity: Object.freeze({ device, inode }), rootIdentity: Object.freeze({ device: rootDevice, inode: rootInode }),
    ownerUid: uid, mode: 0o700, created: true, directory: true, symbolicLink: false,
    parentOpenedNoFollow: true, childInspectedNoFollow: true });
}

async function checkedExecutable(configuration: PrivateProtectedRootNativeExecutableV1): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    if (await realpath(configuration.executablePath) !== configuration.executablePath) return refuse();
    // libuv marks Node-opened descriptors close-on-exec. NONBLOCK ensures a
    // substituted FIFO/device cannot stall before the regular-file check.
    handle = await open(configuration.executablePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 1024 * 1024
      || ![0, process.geteuid!()].includes(before.uid) || (before.mode & 0o7022) !== 0
      || (before.mode & 0o111) === 0) return refuse();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) return refuse();
      offset += read.bytesRead;
    }
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== configuration.executableSha256) return refuse();
    const after = await handle.stat(), named = await lstat(configuration.executablePath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino) return refuse();
    return bytes;
  } catch { return refuse(); }
  finally { await handle?.close(); }
}

function boundedExecutable(configuration: PrivateProtectedRootNativeExecutableV1, signal: AbortSignal,
  end: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort); reject(failure());
    };
    const timer = setTimeout(abort, Math.max(1, end - performance.now()));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || performance.now() >= end) { abort(); return; }
    void checkedExecutable(configuration).then(bytes => {
      if (finished || signal.aborted || performance.now() >= end) {
        bytes.fill(0); abort(); return;
      }
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(bytes);
    }, abort);
  });
}

type Identity = Readonly<{ dev: number; ino: number }>;
type Custody = {
  runningChild: boolean;
  preparing?: boolean;
  directory?: string;
  directoryIdentity?: Identity;
  fileIdentity?: Identity;
};
const same = (left: Identity, right: Identity) => left.dev === right.dev && left.ino === right.ino;
function active(signal: AbortSignal, end: number) {
  if (signal.aborted || performance.now() >= end) refuse();
}

/** Fixed Apple system tools or our private staged helper only. No PATH, shell,
 * ambient environment, extra fd inheritance, or user-selected arguments. */
function ownedProcess(executable: string, args: readonly string[], input: Buffer, signal: AbortSignal,
  end: number, maximumOutput: number, custody: Custody): Promise<Buffer> {
  active(signal, end);
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, cwd: "/",
      env: { NODE_ENV: "production", LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    custody.runningChild = true;
    const chunks: Buffer[] = [];
    let count = 0, failed = false, settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const complete = (bytes?: Buffer) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(cleanupTimer);
      signal.removeEventListener("abort", cancel);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (bytes && !failed) resolve(bytes); else reject(failure());
    };
    const cancel = () => {
      if (settled || failed) return;
      failed = true; child.stdin.destroy(); child.kill("SIGKILL");
      cleanupTimer = setTimeout(() => complete(), 2_000);
    };
    const timer = setTimeout(cancel, Math.max(1, end - performance.now()));
    signal.addEventListener("abort", cancel, { once: true });
    child.on("error", cancel); child.stdin.on("error", cancel);
    child.stdout.on("error", cancel); child.stderr.on("error", cancel); child.stderr.on("data", cancel);
    child.stdout.on("data", (chunk: Buffer) => {
      count += chunk.length;
      if (count > maximumOutput) cancel(); else if (!failed) chunks.push(Buffer.from(chunk));
    });
    child.once("close", (code, stoppedBySignal) => {
      custody.runningChild = false;
      if (code !== 0 || stoppedBySignal !== null || signal.aborted || performance.now() >= end) failed = true;
      complete(failed ? undefined : Buffer.concat(chunks));
    });
    if (signal.aborted || performance.now() >= end) cancel(); else child.stdin.end(input);
  });
}

async function noAcl(paths: readonly string[], signal: AbortSignal, end: number, custody: Custody) {
  // macOS ls -e prints every ACL entry on an additional line. Require one
  // conservative long-listing summary per fixed path, with no '+' ACL marker.
  // A format change, extra line, stderr or excessive output refuses. Numeric
  // owner fields and C locale prevent account-name/localization ambiguity.
  const bytes = await ownedProcess("/bin/ls", ["-ldne", ...paths], Buffer.alloc(0), signal, end, 4096, custody);
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  if (lines.length !== paths.length || lines.some(line => !/^d[-rwxstST]{9}@?\s/u.test(line))) refuse();
}

async function trustedTemp(signal: AbortSignal, end: number, custody: Custody) {
  const paths = ["/", "/private", "/private/tmp"];
  const before = await Promise.all(paths.map(name => lstat(name)));
  if (await realpath("/private/tmp") !== "/private/tmp"
    || before.some((stat, index) => !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0
      || (index < 2 ? (stat.mode & 0o7022) !== 0 : (stat.mode & 0o7777) !== 0o1777))) refuse();
  await noAcl(paths, signal, end, custody);
  const after = await Promise.all(paths.map(name => lstat(name)));
  if (after.some((stat, index) => !same(stat, before[index]) || stat.mode !== before[index].mode
    || stat.uid !== 0 || stat.isSymbolicLink())) refuse();
  active(signal, end);
}

async function stageExecutable(bytes: Buffer, expectedDigest: string, signal: AbortSignal, end: number, custody: Custody) {
  await trustedTemp(signal, end, custody);
  custody.directory = await mkdtemp("/private/tmp/acr-protected-native-");
  const initial = await lstat(custody.directory);
  if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== process.geteuid!()
    || (initial.mode & 0o7777) !== 0o700) refuse();
  custody.directoryIdentity = { dev: initial.dev, ino: initial.ino };
  // Only this fresh empty directory is changed. Clearing inherited ACLs before
  // creating any executable prevents broad inherited rights from granting
  // other users custody. The root-owned sticky parent protects its basename.
  await ownedProcess("/bin/chmod", ["-N", custody.directory], Buffer.alloc(0), signal, end, 0, custody);
  await noAcl([custody.directory], signal, end, custody);
  const directory = await lstat(custody.directory);
  if (!same(directory, initial) || directory.uid !== initial.uid || directory.mode !== initial.mode
    || directory.isSymbolicLink() || (await readdir(custody.directory)).length !== 0) refuse();
  active(signal, end);
  const stagedPath = join(custody.directory, "protected-directory-v1");
  const handle = await open(stagedPath, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    | constants.O_RDWR | constants.O_NONBLOCK, 0o600);
  try {
    const created = await handle.stat();
    if (!created.isFile() || created.uid !== initial.uid || created.nlink !== 1 || (created.mode & 0o7777) !== 0o600) refuse();
    custody.fileIdentity = { dev: created.dev, ino: created.ino };
    let offset = 0;
    while (offset < bytes.length) {
      active(signal, end);
      const result = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (result.bytesWritten < 1) refuse();
      offset += result.bytesWritten;
    }
    await handle.chmod(0o500);
    const observed = Buffer.alloc(bytes.length);
    offset = 0;
    while (offset < observed.length) {
      active(signal, end);
      const result = await handle.read(observed, offset, observed.length - offset, offset);
      if (result.bytesRead < 1) refuse();
      offset += result.bytesRead;
    }
    const final = await handle.stat(), named = await lstat(stagedPath);
    if (!same(final, created) || !same(named, created) || named.isSymbolicLink()
      || final.uid !== initial.uid || final.nlink !== 1 || (final.mode & 0o7777) !== 0o500
      || final.size !== bytes.length || `sha256:${createHash("sha256").update(observed).digest("hex")}` !== expectedDigest) refuse();
  } finally { await handle.close(); }
  active(signal, end);
  return stagedPath;
}

async function cleanupStaged(custody: Custody) {
  if (custody.runningChild || custody.preparing) refuse();
  if (!custody.directory) return;
  const expectedDirectory = custody.directoryIdentity;
  if (!expectedDirectory) return refuse();
  const directory = await lstat(custody.directory);
  if (!same(directory, expectedDirectory) || !directory.isDirectory() || directory.isSymbolicLink()
    || directory.uid !== process.geteuid!() || (directory.mode & 0o7777) !== 0o700) refuse();
  if (custody.fileIdentity) {
    const stagedPath = join(custody.directory, "protected-directory-v1"), file = await lstat(stagedPath);
    if (!same(file, custody.fileIdentity) || !file.isFile() || file.isSymbolicLink()
      || file.uid !== process.geteuid!() || file.nlink !== 1) refuse();
    await unlink(stagedPath);
  }
  // Never recursively remove: unexpected content or changed identity preserves
  // the staging tree and makes cleanup uncertain.
  await rmdir(custody.directory);
  custody.directory = undefined;
}

async function boundedCleanup(custody: Custody) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([cleanupStaged(custody), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(failure()), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

function boundedStage(bytes: Buffer, expectedDigest: string, signal: AbortSignal, end: number,
  custody: Custody): Promise<string> {
  return new Promise((resolve, reject) => {
    let abandoned = false, settled = false;
    custody.preparing = true;
    const release = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => {
      if (settled) return;
      abandoned = true; settled = true; release(); reject(failure());
    };
    const timer = setTimeout(abort, Math.max(1, end - performance.now()));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || performance.now() >= end) {
      custody.preparing = false; abort(); return;
    }
    // If an OS filesystem call finishes after cancellation, it cannot launch
    // the helper: stageExecutable checks the signal/deadline between actions.
    // Its late cleanup owns only its captured staging identity. The caller has
    // already received uncertainty and no successful receipt can be emitted.
    void stageExecutable(bytes, expectedDigest, signal, end, custody).then(staged => {
      custody.preparing = false;
      if (abandoned) { void boundedCleanup(custody).catch(() => undefined); return; }
      settled = true; release(); resolve(staged);
    }, () => {
      custody.preparing = false;
      if (abandoned) { void boundedCleanup(custody).catch(() => undefined); return; }
      settled = true; release(); reject(failure());
    });
  });
}

/** Exactly one primitive attempt per native port (plus fixed staging tools).
 * Failure never returns raw OS
 * output. SIGKILL targets only our child; close must confirm reaping before a
 * success is accepted. Cleanup timeout returns uncertainty, never success. */
export function createPrivateProtectedRootNativeDirectoryV1(value: unknown): PrivateProtectedRootNativeDirectoryV1 {
  const input = record(value, ["executablePath", "executableSha256"]);
  if (typeof input.executableSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.executableSha256)) return refuse();
  const configuration = Object.freeze({ executablePath: path(input.executablePath), executableSha256: input.executableSha256 });
  let entered = false;
  return Object.freeze({ schema: PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1,
    async createOnePrivateChild(value: PrivateProtectedRootNativeCreateRequestV1) {
      if (entered) return refuse();
      entered = true;
      const request = capturedRequest(value), end = performance.now() + request.deadlineUnixMs - Date.now();
      const custody: Custody = { runningChild: false };
      let bytes: Buffer | undefined, result: PrivateProtectedRootNativeReceiptV1 | undefined;
      try {
        bytes = await boundedExecutable(configuration, request.signal, end);
        const stagedPath = await boundedStage(bytes, configuration.executableSha256, request.signal, end, custody);
        const output = await ownedProcess(stagedPath, [], frame(request), request.signal, end, 160, custody);
        active(request.signal, end);
        result = receipt(output, request);
      } catch { result = undefined; }
      finally { bytes?.fill(0); }
      try { await boundedCleanup(custody); } catch { return refuse(); }
      if (!result || request.signal.aborted || performance.now() >= end) return refuse();
      return result;
    },
  });
}
