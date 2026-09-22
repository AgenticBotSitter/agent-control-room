import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
  PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1,
  type PrivateInstallationJournalHeldSessionPortV1,
  type PrivateInstallationJournalHeldSessionV1 } from "./private-installation-journal-held-session-adapter";
import { PRIVATE_INSTALLATION_JOURNAL_NATIVE_OPERATION_V1,
  type PrivateInstallationJournalNativeOperationRequestV1 } from
  "./private-installation-journal-native-custody-preparation";
import type { InstallationPlanJournalEntryIdentityV1, InstallationPlanJournalEntryV1,
  InstallationPlanJournalReadEntryV1 } from "./installation-plan-journal-storage-session";

export type PrivateInstallationJournalNativeExecutableV1 = Readonly<{
  executablePath: string;
  executableSha256: string;
}>;

const MAX_OUTPUT = 2_570_004;
const OPEN_HEADER_BYTES = 64;
const COMMAND_HEADER_BYTES = 44;
const RESPONSE_HEADER_BYTES = 16;
const command = Object.freeze({ list: 1, stat: 2, read: 3, create: 4, write: 5,
  syncFile: 6, link: 7, unlink: 8, syncDirectory: 9, verifyRoot: 10, close: 11 });
type Identity = Readonly<{ dev: number; ino: number }>;
type Custody = { runningChild: boolean; preparing?: boolean; directory?: string;
  directoryIdentity?: Identity; fileIdentity?: Identity };

function failure(): Error {
  const error = new Error("private_installation_journal_native_session_uncertain"); error.stack = undefined; return error;
}
const refuse = (): never => { throw failure(); };
function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) return refuse();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refuse();
  }
  return value as Readonly<Record<string, unknown>>;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) return refuse();
  return value as number;
}
function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value === "/"
    || value.endsWith("/") || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 4096 || Buffer.from(value, "utf8").toString("utf8") !== value) return refuse();
  return value;
}
function requestSnapshot(value: unknown): PrivateInstallationJournalNativeOperationRequestV1 {
  const names = ["schema", "operationId", "operation", "journalRootPath", "journalBindingDigest", "installationId",
    "expectedRootIdentity", "expectedOwnerUid", "expectedRootMode", "maximumPlanBytes", "maximumWitnessBytes",
    "maximumRevisions", "deadlineUnixMs", "signal", "requiredPrimitives", "capabilities", "requiredGuarantees",
    "recoveryScope", "mayMutateForRecovery", "mayAppend"] as const;
  const input = exact(value, names), identity = exact(input.expectedRootIdentity, ["device", "inode"]);
  if (process.platform !== "darwin" || input.schema !== PRIVATE_INSTALLATION_JOURNAL_NATIVE_OPERATION_V1
    || (input.operation !== "read_history" && input.operation !== "inspect_settled_history" && input.operation !== "append")
    || typeof input.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(input.operationId)
    || typeof input.installationId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(input.installationId)
    || typeof input.journalBindingDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.journalBindingDigest)
    || input.expectedRootMode !== 0o700 || input.maximumPlanBytes !== 65_536 || input.maximumWitnessBytes !== 1_024
    || input.maximumRevisions !== 10_000 || !(input.signal instanceof AbortSignal) || input.signal.aborted
    || typeof process.getuid !== "function" || typeof process.geteuid !== "function"
    || process.getuid() !== process.geteuid() || process.geteuid() === 0 || input.expectedOwnerUid !== process.geteuid()) return refuse();
  const deadlineUnixMs = integer(input.deadlineUnixMs), remaining = deadlineUnixMs - Date.now();
  if (remaining <= 0 || remaining > 30_000) return refuse();
  return Object.freeze({ ...(input as unknown as PrivateInstallationJournalNativeOperationRequestV1),
    journalRootPath: absolutePath(input.journalRootPath),
    expectedRootIdentity: Object.freeze({ device: integer(identity.device), inode: integer(identity.inode) }),
    expectedOwnerUid: integer(input.expectedOwnerUid, 0x7fffffff), deadlineUnixMs });
}
function active(signal: AbortSignal, end: number) { if (signal.aborted || performance.now() >= end) refuse(); }
const same = (left: Identity, right: Identity) => left.dev === right.dev && left.ino === right.ino;

async function checkedExecutable(configuration: PrivateInstallationJournalNativeExecutableV1): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    if (await realpath(configuration.executablePath) !== configuration.executablePath) return refuse();
    handle = await open(configuration.executablePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 2 * 1024 * 1024
      || ![0, process.geteuid!()].includes(before.uid) || (before.mode & 0o7022) !== 0 || (before.mode & 0o111) === 0) return refuse();
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) return refuse(); offset += read.bytesRead; }
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== configuration.executableSha256) return refuse();
    const after = await handle.stat(), named = await lstat(configuration.executablePath);
    if (!same(before, after) || !same(before, named) || named.isSymbolicLink() || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return refuse();
    return bytes;
  } catch { return refuse(); } finally { await handle?.close(); }
}

function boundedExecutable(configuration: PrivateInstallationJournalNativeExecutableV1, signal: AbortSignal,
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
      if (finished || signal.aborted || performance.now() >= end) { bytes.fill(0); abort(); return; }
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(bytes);
    }, abort);
  });
}

function smallProcess(executable: string, args: readonly string[], signal: AbortSignal, end: number,
  maximumOutput: number, custody: Custody): Promise<Buffer> {
  active(signal, end);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, cwd: "/", env: { NODE_ENV: "production", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    custody.runningChild = true; const chunks: Buffer[] = []; let count = 0, failed = false, settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (bytes?: Buffer) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(cleanupTimer);
      signal.removeEventListener("abort", cancel); child.stdout.destroy(); child.stderr.destroy();
      bytes && !failed ? resolve(bytes) : reject(failure()); };
    const cancel = () => {
      if (settled || failed) return;
      failed = true; child.kill("SIGKILL"); cleanupTimer = setTimeout(() => finish(), 2_000);
    };
    const timer = setTimeout(cancel, Math.max(1, end - performance.now())); signal.addEventListener("abort", cancel, { once: true });
    child.on("error", cancel); child.stderr.on("data", cancel); child.stdout.on("data", (chunk: Buffer) => {
      count += chunk.length; if (count > maximumOutput) cancel(); else chunks.push(Buffer.from(chunk));
    });
    child.once("close", (code, stopped) => { custody.runningChild = false;
      if (code !== 0 || stopped !== null || signal.aborted || performance.now() >= end) failed = true;
      finish(failed ? undefined : Buffer.concat(chunks)); });
    if (signal.aborted || performance.now() >= end) cancel();
  });
}
async function noAcl(paths: readonly string[], signal: AbortSignal, end: number, custody: Custody) {
  const bytes = await smallProcess("/bin/ls", ["-ldne", ...paths], signal, end, 4096, custody);
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  if (lines.length !== paths.length || lines.some(line => !/^d[-rwxstST]{9}@?\s/u.test(line))) refuse();
}
async function trustedTemp(signal: AbortSignal, end: number, custody: Custody) {
  const paths = ["/", "/private", "/private/tmp"], before = await Promise.all(paths.map(item => lstat(item)));
  if (await realpath("/private/tmp") !== "/private/tmp" || before.some((item, index) => !item.isDirectory()
    || item.isSymbolicLink() || item.uid !== 0 || (index < 2 ? (item.mode & 0o7022) !== 0 : (item.mode & 0o7777) !== 0o1777))) refuse();
  await noAcl(paths, signal, end, custody); const after = await Promise.all(paths.map(item => lstat(item)));
  if (after.some((item, index) => !same(item, before[index]!) || item.mode !== before[index]!.mode || item.uid !== 0)) refuse();
}
async function stageExecutable(bytes: Buffer, digest: string, signal: AbortSignal, end: number, custody: Custody) {
  await trustedTemp(signal, end, custody); custody.directory = await mkdtemp("/private/tmp/acr-journal-native-");
  const initial = await lstat(custody.directory);
  if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== process.geteuid!() || (initial.mode & 0o7777) !== 0o700) refuse();
  custody.directoryIdentity = { dev: initial.dev, ino: initial.ino };
  await smallProcess("/bin/chmod", ["-N", custody.directory], signal, end, 0, custody); await noAcl([custody.directory], signal, end, custody);
  const directory = await lstat(custody.directory);
  if (!same(directory, initial) || directory.mode !== initial.mode || (await readdir(custody.directory)).length !== 0) refuse();
  const staged = join(custody.directory, "installation-journal-session-v1");
  const handle = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    | constants.O_RDWR | constants.O_NONBLOCK, 0o600);
  try {
    const created = await handle.stat(); custody.fileIdentity = { dev: created.dev, ino: created.ino };
    if (!created.isFile() || created.uid !== initial.uid || created.nlink !== 1 || (created.mode & 0o7777) !== 0o600) refuse();
    let offset = 0; while (offset < bytes.length) { active(signal, end); const wrote = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (wrote.bytesWritten < 1) refuse(); offset += wrote.bytesWritten; }
    await handle.chmod(0o500); const observed = Buffer.alloc(bytes.length); offset = 0;
    while (offset < observed.length) { const read = await handle.read(observed, offset, observed.length - offset, offset);
      if (read.bytesRead < 1) refuse(); offset += read.bytesRead; }
    const final = await handle.stat(), named = await lstat(staged);
    if (!same(final, created) || !same(named, created) || named.isSymbolicLink() || final.nlink !== 1
      || (final.mode & 0o7777) !== 0o500 || final.size !== bytes.length
      || `sha256:${createHash("sha256").update(observed).digest("hex")}` !== digest) refuse();
  } finally { await handle.close(); }
  active(signal, end); return staged;
}
async function cleanupStaged(custody: Custody) {
  if (custody.runningChild || custody.preparing) return refuse(); if (!custody.directory || !custody.directoryIdentity) return;
  const directory = await lstat(custody.directory);
  if (!same(directory, custody.directoryIdentity) || !directory.isDirectory() || directory.isSymbolicLink()
    || directory.uid !== process.geteuid!() || (directory.mode & 0o7777) !== 0o700) return refuse();
  if (custody.fileIdentity) {
    const staged = join(custody.directory, "installation-journal-session-v1"), file = await lstat(staged);
    if (!same(file, custody.fileIdentity) || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1) return refuse();
    await unlink(staged);
  }
  await rmdir(custody.directory); custody.directory = undefined;
}
async function boundedCleanup(custody: Custody) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([cleanupStaged(custody), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure()), 2_000); })]); }
  finally { clearTimeout(timer); }
}

function boundedStage(bytes: Buffer, digest: string, signal: AbortSignal, end: number,
  custody: Custody): Promise<string> {
  return new Promise((resolve, reject) => {
    let abandoned = false, settled = false; custody.preparing = true;
    const release = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => {
      if (settled) return;
      abandoned = true; settled = true; release(); reject(failure());
    };
    const timer = setTimeout(abort, Math.max(1, end - performance.now()));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || performance.now() >= end) { custody.preparing = false; abort(); return; }
    void stageExecutable(bytes, digest, signal, end, custody).then(staged => {
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

function openFrame(request: PrivateInstallationJournalNativeOperationRequestV1): Buffer {
  const path = Buffer.from(request.journalRootPath), id = Buffer.from(request.installationId), header = Buffer.alloc(OPEN_HEADER_BYTES);
  header.write("ACRJNL1\n", "ascii"); header.writeUInt32BE(request.operation === "read_history" ? 1 : request.operation === "inspect_settled_history" ? 2 : 3, 8);
  header.writeUInt32BE(path.length, 12); header.writeUInt32BE(id.length, 16);
  header.writeBigUInt64BE(BigInt(request.expectedRootIdentity.device), 24); header.writeBigUInt64BE(BigInt(request.expectedRootIdentity.inode), 32);
  header.writeBigUInt64BE(BigInt(request.expectedOwnerUid), 40); header.writeBigUInt64BE(BigInt(request.deadlineUnixMs), 48);
  return Buffer.concat([header, path, id]);
}
function commandFrame(opcode: number, ordinal: number, first = "", second = "", payload = Buffer.alloc(0),
  identity?: InstallationPlanJournalEntryIdentityV1, maximum = 0, flag = 0): Buffer {
  const one = Buffer.from(first), two = Buffer.from(second), header = Buffer.alloc(COMMAND_HEADER_BYTES);
  header.write("ACRC", "ascii"); header[4] = opcode; header[5] = flag; header.writeUInt16BE(one.length, 6); header.writeUInt16BE(two.length, 8);
  header.writeUInt32BE(ordinal, 12); header.writeUInt32BE(payload.length, 16);
  header.writeBigUInt64BE(identity?.device ?? BigInt(0), 20); header.writeBigUInt64BE(identity?.inode ?? BigInt(0), 28);
  header.writeUInt32BE(maximum, 36); return Buffer.concat([header, one, two, payload]);
}
function identityPayload(payload: Buffer): InstallationPlanJournalEntryIdentityV1 {
  if (payload.length !== 16) return refuse(); return Object.freeze({ device: payload.readBigUInt64BE(0), inode: payload.readBigUInt64BE(8) });
}
function statPayload(payload: Buffer): InstallationPlanJournalEntryV1 | undefined {
  if (payload.length !== 40 || (payload[0] !== 0 && payload[0] !== 1)) return refuse(); if (payload[0] === 0) return undefined;
  const kind = payload[1] === 1 ? "file" as const : payload[1] === 2 ? "directory" as const : payload[1] === 3 ? "other" as const : refuse();
  return Object.freeze({ identity: Object.freeze({ device: payload.readBigUInt64BE(24), inode: payload.readBigUInt64BE(32) }),
    kind, ownerUid: payload.readUInt32BE(4), mode: payload.readUInt32BE(8), linkCount: payload.readUInt32BE(12),
    size: integer(Number(payload.readBigUInt64BE(16))), canonical: payload[2] === 1 });
}

type Response = Readonly<{ opcode: number; ordinal: number; status: number; payload: Buffer }>;
class SessionProcess {
  private buffer = Buffer.alloc(0); private waiting?: { opcode: number; ordinal: number; resolve(value: Response): void; reject(error: Error): void };
  private failed = false; private closing = false; private closed = false;
  private exit?: { code: number | null; signal: NodeJS.Signals | null };
  private exitWait: Promise<void>; private exitResolve!: () => void; private ordinal = 0;
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly request: PrivateInstallationJournalNativeOperationRequestV1,
    private readonly end: number, private readonly custody: Custody) {
    this.exitWait = new Promise(resolve => { this.exitResolve = resolve; }); custody.runningChild = true;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk)); child.stdout.on("error", () => this.break());
    child.stderr.on("data", () => this.break()); child.stderr.on("error", () => this.break()); child.stdin.on("error", () => this.break());
    child.on("error", () => this.break()); child.once("close", (code, signal) => { this.exit = { code, signal }; custody.runningChild = false;
      if ((!this.closing && !this.closed) || code !== 0 || signal !== null) this.break(); this.exitResolve(); });
    request.signal.addEventListener("abort", () => this.break(), { once: true });
  }
  private receive(chunk: Buffer) {
    if (this.failed || this.buffer.length + chunk.length > MAX_OUTPUT + RESPONSE_HEADER_BYTES) return this.break();
    this.buffer = Buffer.concat([this.buffer, chunk]); this.parse();
  }
  private parse() {
    if (!this.waiting || this.buffer.length < RESPONSE_HEADER_BYTES) return;
    if (this.buffer.subarray(0, 4).toString("ascii") !== "ACRS" || this.buffer[5]! > 1 || this.buffer.readUInt16BE(6) !== 0) return this.break();
    const opcode = this.buffer[4]!, status = this.buffer[5]!, ordinal = this.buffer.readUInt32BE(8), length = this.buffer.readUInt32BE(12);
    if (length > MAX_OUTPUT || this.buffer.length < RESPONSE_HEADER_BYTES + length) return;
    if (opcode !== this.waiting.opcode || ordinal !== this.waiting.ordinal) return this.break();
    const payload = Buffer.from(this.buffer.subarray(RESPONSE_HEADER_BYTES, RESPONSE_HEADER_BYTES + length));
    this.buffer = this.buffer.subarray(RESPONSE_HEADER_BYTES + length); const waiter = this.waiting; this.waiting = undefined;
    if (this.buffer.length !== 0 || (status === 1 && (payload.length !== 0 || (opcode !== command.create && opcode !== command.link)))) {
      payload.fill(0); return this.break();
    }
    waiter.resolve(Object.freeze({ opcode, ordinal, status, payload }));
  }
  private break() {
    if (this.failed) return; this.failed = true; this.child.stdin.destroy(); this.child.kill("SIGKILL");
    const waiter = this.waiting; this.waiting = undefined; waiter?.reject(failure());
  }
  async exchange(opcode: number, frame: Buffer): Promise<Buffer> {
    active(this.request.signal, this.end); if (this.failed || this.closed || this.waiting) return refuse();
    const ordinal = opcode === 0 ? 0 : ++this.ordinal;
    const response = new Promise<Response>((resolve, reject) => { this.waiting = { opcode, ordinal, resolve, reject }; });
    this.child.stdin.write(frame, error => { if (error) this.break(); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([response, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.break(); reject(failure()); }, Math.max(1, this.end - performance.now()));
      })]);
      if (result.status === 1) { const exists = failure() as NodeJS.ErrnoException; exists.code = "EEXIST"; throw exists; }
      return result.payload;
    } finally { clearTimeout(timer); }
  }
  async finishClose(frame: Buffer) {
    this.closing = true;
    const payload = await this.exchange(command.close, frame); if (payload.length !== 0) return refuse();
    this.closed = true; this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.exitWait, new Promise<never>((_, reject) => { timer = setTimeout(() => {
      this.break(); reject(failure()); }, Math.max(1, this.end - performance.now())); })]); }
    finally { clearTimeout(timer); }
    if (!this.exit || this.exit.code !== 0 || this.exit.signal !== null || this.failed || this.buffer.length !== 0) return refuse();
  }
  async terminate() { this.break(); await Promise.race([this.exitWait, new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
    if (!this.exit) return refuse(); }
}

/** One staged, descriptor-holding child per operation. No shell, runtime
 * compiler, path fallback, generic command execution or transition logic. */
export function createPrivateInstallationJournalNativeSessionPortV1(value: unknown): PrivateInstallationJournalHeldSessionPortV1 {
  const input = exact(value, ["executablePath", "executableSha256"]);
  if (typeof input.executableSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.executableSha256)) return refuse();
  const configuration = Object.freeze({ executablePath: absolutePath(input.executablePath), executableSha256: input.executableSha256 });
  let occupied = false, poisoned = false;
  return Object.freeze({ schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
    async openSession(value: PrivateInstallationJournalNativeOperationRequestV1): Promise<PrivateInstallationJournalHeldSessionV1> {
      if (occupied || poisoned) return refuse(); occupied = true;
      const request = requestSnapshot(value), end = performance.now() + request.deadlineUnixMs - Date.now();
      const custody: Custody = { runningChild: false }; let captured: Buffer | undefined, processHost: SessionProcess | undefined;
      let lifetimeTimer: ReturnType<typeof setTimeout> | undefined, released = false;
      const release = async () => {
        if (released) return; released = true; clearTimeout(lifetimeTimer);
        try { await boundedCleanup(custody); }
        catch { poisoned = true; return refuse(); }
        finally { occupied = false; }
      };
      try {
        captured = await boundedExecutable(configuration, request.signal, end); active(request.signal, end);
        const staged = await boundedStage(captured, configuration.executableSha256, request.signal, end, custody);
        const child = spawn(staged, [], { shell: false, cwd: "/", env: { NODE_ENV: "production", LANG: "C", LC_ALL: "C" },
          stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        processHost = new SessionProcess(child, request, end, custody);
        const opened = await processHost.exchange(0, openFrame(request)); if (opened.length !== 0) return refuse();
        lifetimeTimer = setTimeout(() => { void processHost?.terminate().finally(() => release()).catch(() => undefined); },
          Math.max(1, end - performance.now()));
      } catch {
        await processHost?.terminate().catch(() => undefined); await release().catch(() => undefined); return refuse();
      } finally { captured?.fill(0); }
      let ended = false;
      const invoke = async (opcode: number, first = "", second = "", payload = Buffer.alloc(0),
        identity?: InstallationPlanJournalEntryIdentityV1, maximum = 0, flag = 0) => {
        if (ended || !processHost) return refuse();
        try { return await processHost.exchange(opcode,
          commandFrame(opcode, (processHost as unknown as { ordinal: number }).ordinal + 1, first, second, payload, identity, maximum, flag)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
          ended = true; await processHost.terminate().catch(() => undefined); await release().catch(() => undefined); return refuse();
        }
      };
      return Object.freeze({ schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1, operationId: request.operationId,
        operation: request.operation,
        async listEntryNames() {
          const bytes = await invoke(command.list); if (bytes.length < 4) return refuse();
          const count = bytes.readUInt32BE(0); if (count > 10_000) return refuse(); let offset = 4; const names: string[] = [];
          for (let index = 0; index < count; index++) { if (offset + 2 > bytes.length) return refuse(); const length = bytes.readUInt16BE(offset); offset += 2;
            if (length < 1 || offset + length > bytes.length) return refuse(); const name = bytes.subarray(offset, offset + length).toString("utf8");
            if (!Buffer.from(name).equals(bytes.subarray(offset, offset + length))) return refuse(); names.push(name); offset += length; }
          if (offset !== bytes.length) return refuse(); return Object.freeze(names);
        },
        async statEntry(name: string) { return statPayload(await invoke(command.stat, name)); },
        async readEntry(name: string, maximumBytes: number): Promise<InstallationPlanJournalReadEntryV1> {
          const bytes = await invoke(command.read, name, "", Buffer.alloc(0), undefined, maximumBytes);
          if (bytes.length <= 40) return refuse(); const entry = statPayload(bytes.subarray(0, 40)); if (!entry || entry.size !== bytes.length - 40) return refuse();
          return Object.freeze({ entry, bytes: Uint8Array.from(bytes.subarray(40)) });
        },
        async createExclusiveEntry(name: string) { return identityPayload(await invoke(command.create, name)); },
        async writeExactBounded(name: string, identity: InstallationPlanJournalEntryIdentityV1,
          bytes: Uint8Array, maximumBytes: number) {
          const result = await invoke(command.write, name, "", Buffer.from(bytes), identity, maximumBytes); if (result.length !== 0) return refuse();
        },
        async syncFile(name: string, identity: InstallationPlanJournalEntryIdentityV1) {
          if ((await invoke(command.syncFile, name, "", Buffer.alloc(0), identity)).length !== 0) return refuse();
        },
        async linkNoReplace(sourceName: string, identity: InstallationPlanJournalEntryIdentityV1, targetName: string) {
          if ((await invoke(command.link, sourceName, targetName, Buffer.alloc(0), identity)).length !== 0) return refuse();
        },
        async unlinkExact(name: string, identity: InstallationPlanJournalEntryIdentityV1, allowMissing = false) {
          if ((await invoke(command.unlink, name, "", Buffer.alloc(0), identity, 0, allowMissing ? 1 : 0)).length !== 0) return refuse();
        },
        async syncDirectory() { if ((await invoke(command.syncDirectory)).length !== 0) return refuse(); },
        async verifyRoot() { if ((await invoke(command.verifyRoot)).length !== 0) return refuse(); },
        async close() {
          if (ended || !processHost) return refuse(); ended = true;
          try { await processHost.finishClose(commandFrame(command.close,
            (processHost as unknown as { ordinal: number }).ordinal + 1)); await release(); }
          catch { await processHost.terminate().catch(() => undefined); await release().catch(() => undefined); return refuse(); }
        },
      });
    },
  });
}
