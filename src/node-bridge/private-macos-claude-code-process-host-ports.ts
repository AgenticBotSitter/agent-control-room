import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, normalize } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import {
  CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1,
  type PrivateClaudeCodeInstalledProcessHostPortsV1,
  type PrivateClaudeCodeInstalledProcessLaunchRequestV1,
  type PrivateClaudeCodeInstalledProcessVerificationRequestV1,
  type PrivateClaudeCodeNativeChildV1,
} from "../harness/claude-code-v1/private-installed-process-host";
import { CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1 } from "../harness/claude-code-v1/text-review-invocation-policy";

const refused = () => new Error("claude_code_macos_process_port_refused");
const uncertain = () => new Error("claude_code_macos_process_port_uncertain");
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const path = z.string().min(2).max(4095).refine(value => isAbsolute(value) && normalize(value) === value
  && Buffer.byteLength(value) <= 4095 && !/[\u0000-\u001f\u007f]/u.test(value));
const identity = z.object({ device: z.string().regex(/^\d{1,20}$/u), inode: z.string().regex(/^\d{1,20}$/u) }).strict();
const configurationSchema = z.object({
  schema: z.literal("control-room.macos-claude-code-process-port/v1"),
  helperPath: path, helperSha256: digest,
  executablePath: path, executableSha256: digest, executableIdentity: identity,
  workingDirectory: path, workingDirectoryIdentity: identity,
  workingDirectoryBindingDigest: digest, qualificationDigest: digest,
  ownerUid: z.number().int().min(1).max(0xffff_ffff),
  holdDeadlineMs: z.number().int().min(100).max(30_000),
  runDeadlineMs: z.number().int().min(100).max(600_000),
  maximumInputBytes: z.number().int().min(1).max(1024 * 1024).default(256 * 1024),
  maximumOutputBytes: z.number().int().min(1).max(8 * 1024 * 1024).default(1024 * 1024),
}).strict();
export type PrivateMacosClaudeCodeProcessPortConfigurationV1 = z.input<typeof configurationSchema>;
type Configuration = z.output<typeof configurationSchema>;
type Exit = Readonly<{ code: number | null; signal: string | null }>;

/** These source ports are not sufficient evidence for installation activation. */
export const CLAUDE_CODE_MACOS_PROCESS_PORT_ACTIVATION_BLOCKERS_V1 = Object.freeze([
  "owner_attended_native_login_qualification_missing",
  "installed_helper_release_custody_missing",
] as const);

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(uncertain());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(uncertain()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      () => { signal.removeEventListener("abort", abort); reject(uncertain()); });
  });
}
function write(stream: Writable, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || !stream.writable) { reject(uncertain()); return; }
    stream.write(bytes, error => error ? reject(uncertain()) : resolve());
  });
}
function command(opcode: number) { const bytes = Buffer.alloc(16); bytes.write("ACRC"); bytes[4] = opcode; return bytes; }
function hold(c: Configuration): Buffer {
  const executable = Buffer.from(c.executablePath), workspace = Buffer.from(c.workingDirectory), header = Buffer.alloc(104);
  header.write("ACRCCP1\n"); header.writeUInt32BE(1, 8); header.writeUInt32BE(executable.length, 12);
  header.writeUInt32BE(workspace.length, 16); header.writeUInt32BE(c.holdDeadlineMs, 20); header.writeUInt32BE(c.runDeadlineMs, 24);
  [c.ownerUid, c.executableIdentity.device, c.executableIdentity.inode,
    c.workingDirectoryIdentity.device, c.workingDirectoryIdentity.inode]
    .forEach((value, index) => header.writeBigUInt64BE(BigInt(value), 32 + index * 8));
  Buffer.from(c.executableSha256.slice(7), "hex").copy(header, 72);
  return Buffer.concat([header, executable, workspace]);
}

/** The helper itself is a trusted, release-owned bootstrap executable. These
 * checks reject accidental drift, but are not kernel-bound helper custody and
 * do not solve hostile same-UID replacement. Activation remains blocked. */
function verifyHelper(c: Configuration) {
  for (let parent = dirname(c.helperPath); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, c.ownerUid].includes(stat.uid)
      || ((stat.mode & 0o022) !== 0 && !(parent === "/private/tmp" && stat.uid === 0 && (stat.mode & 0o7777) === 0o1777))) throw refused();
    if (parent === "/") break;
  }
  const fd = openSync(c.helperPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd), named = lstatSync(c.helperPath);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== c.ownerUid || (before.mode & 0o6022) !== 0
      || (before.mode & 0o100) === 0 || before.size < 1 || before.size > 16 * 1024 * 1024
      || named.dev !== before.dev || named.ino !== before.ino) throw refused();
    const actual = `sha256:${createHash("sha256").update(readFileSync(fd)).digest("hex")}`;
    const after = fstatSync(fd), current = lstatSync(c.helperPath);
    if (actual !== c.helperSha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || current.dev !== before.dev || current.ino !== before.ino) throw refused();
  } finally { closeSync(fd); }
}

class OutputQueue {
  private chunks: Buffer[] = [];
  private total = 0;
  private ended = false;
  private failure = false;
  private reader: ReturnType<typeof deferred<Uint8Array | undefined>> | undefined;
  constructor(stream: Readable, maximum: number, fail: () => void) {
    stream.on("data", (chunk: Buffer) => {
      this.total += chunk.length;
      if (this.total > maximum || this.failure) { this.fail(); fail(); return; }
      const bytes = Buffer.from(chunk), reader = this.reader; this.reader = undefined;
      if (reader) reader.resolve(bytes); else this.chunks.push(bytes);
    });
    stream.on("end", () => { this.ended = true; if (!this.chunks.length) this.reader?.resolve(undefined); });
    stream.on("error", () => { this.fail(); fail(); });
  }
  fail() { this.failure = true; this.chunks = []; this.reader?.reject(uncertain()); this.reader = undefined; }
  async read(signal: AbortSignal): Promise<Uint8Array | undefined> {
    if (signal.aborted || this.failure || this.reader) throw uncertain();
    const chunk = this.chunks.shift(); if (chunk) return chunk;
    if (this.ended) return undefined;
    const pending = deferred<Uint8Array | undefined>(); this.reader = pending;
    try { return await interruptible(pending.promise, signal); }
    finally { if (this.reader === pending) this.reader = undefined; }
  }
}

type Phase = "holding" | "verified" | "launching" | "started" | "exit" | "cancelled" | "refused" | "failed";
class NativeSession {
  readonly verified = deferred<void>();
  readonly started = deferred<void>();
  readonly exited = deferred<Exit>();
  readonly closed = deferred<void>();
  phase: Phase = "holding";
  private control: Writable;
  private input: Writable;
  private output: OutputQueue;
  private errors: OutputQueue;
  private frames = Buffer.alloc(0);
  private frameBytes = 0;
  private inputBytes = 0;
  private commandCount = 0;
  private sentEof = false;
  private terminal: Exit | undefined;
  private recoveredAfterCustodianLoss = false;
  private timer: ReturnType<typeof setTimeout>;
  private unlinkVerification: () => void = () => {};
  constructor(readonly configuration: Configuration, signal: AbortSignal) {
    const child: ChildProcess = spawn(configuration.helperPath, [], {
      shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_ENV: "production" },
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"], windowsHide: true,
    });
    const streams: (Readable | Writable | null | undefined)[] = child.stdio;
    this.control = child.stdin!; this.input = streams[3] as Writable;
    this.output = new OutputQueue(streams[4] as Readable, configuration.maximumOutputBytes, () => this.fail());
    this.errors = new OutputQueue(streams[5] as Readable, configuration.maximumOutputBytes, () => this.fail());
    this.timer = setTimeout(() => this.fail(), configuration.holdDeadlineMs + configuration.runDeadlineMs + 4_000);
    this.timer.unref();
    this.control.on("error", () => this.fail()); this.input.on("error", () => this.fail());
    child.stderr!.on("data", () => this.fail()); child.stderr!.on("error", () => this.fail());
    child.stdout!.on("data", (bytes: Buffer) => this.status(bytes));
    child.stdout!.on("end", () => {
      if (this.frames.length || !["exit", "cancelled", "refused"].includes(this.phase)) this.fail();
    });
    child.stdout!.on("error", () => this.fail()); child.on("error", () => this.fail());
    // Exact exit 2 is emitted only by the independently retained supervisor
    // after it has reaped the custodian and anchor and proved group absence.
    // The task remains uncertain, but the port's native custody is retired.
    child.once("exit", (code, signalName) => {
      // REFUSED uses exit 1. Its final status may still be in the pipe when
      // exit fires, so validate that exact pairing only after pipe closure.
      if (code === 2 && signalName === null) this.recoveredAfterCustodianLoss = true;
      else if ((code !== 0 && code !== 1) || signalName !== null) this.fail();
    });
    child.once("close", (code, signalName) => {
      clearTimeout(this.timer); this.unlinkVerification();
      const expectedCode = this.phase === "refused" ? 1 : 0;
      if (this.frames.length || (code !== expectedCode && !(code === 2 && this.recoveredAfterCustodianLoss))
        || signalName !== null) this.fail();
      if (this.phase === "exit" && this.terminal) { this.exited.resolve(this.terminal); this.closed.resolve(); }
      else if (this.phase === "cancelled" || this.phase === "refused") this.closed.resolve();
      else if (this.phase === "failed" && this.recoveredAfterCustodianLoss) this.closed.resolve();
      else { this.fail(); this.closed.reject(uncertain()); }
    });
    const abort = () => this.fail();
    signal.addEventListener("abort", abort, { once: true });
    this.unlinkVerification = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) this.fail();
    else void write(this.control, hold(configuration)).catch(() => this.fail());
  }
  fail() {
    if (this.phase === "failed") return;
    this.phase = "failed"; this.unlinkVerification();
    this.verified.reject(refused()); this.started.reject(uncertain()); this.exited.reject(uncertain());
    this.output?.fail(); this.errors?.fail();
    // EOF asks the custodian to clean its owned group. If that custodian is
    // already gone, the independent supervisor owns the same anchored group
    // and emits exact exit 2 only after cleanup is proved.
    this.control?.destroy(); this.input?.destroy();
  }
  private status(bytes: Buffer) {
    this.frameBytes += bytes.length;
    if (this.frameBytes > 64 || this.phase === "failed") { this.fail(); return; }
    this.frames = Buffer.concat([this.frames, bytes]);
    while (this.frames.length >= 16) {
      const frame = this.frames.subarray(0, 16); this.frames = this.frames.subarray(16);
      const status = frame[4], kind = frame[5], absent = frame[6], value = frame.readUInt32BE(8);
      if (!frame.subarray(0, 4).equals(Buffer.from("ACRS", "ascii")) || frame[7] !== 0
        || frame.readUInt32BE(12) !== 0 || status < 1 || status > 6
        || (status !== 3 && (kind !== 0 || absent !== 0 || value !== 0))) { this.fail(); return; }
      if (status === 1 && this.phase === "holding") {
        this.phase = "verified";
        // bounded() in the higher host aborts its temporary verification
        // signal even on success. Custody now belongs to this retained session.
        this.unlinkVerification(); this.verified.resolve();
      } else if (status === 2 && this.phase === "launching") { this.phase = "started"; this.started.resolve(); }
      else if (status === 3 && this.phase === "started" && absent === 1
        && ((kind === 1 && value <= 255) || (kind === 2 && value >= 1 && value <= 64))) {
        const signalName = kind === 2 ? Object.entries(osConstants.signals).find(([, number]) => number === value)?.[0] : null;
        if (kind === 2 && !signalName) { this.fail(); return; }
        this.terminal = Object.freeze({ code: kind === 1 ? value : null, signal: signalName ?? null }); this.phase = "exit";
      } else if (status === 6 && this.phase === "verified") { this.phase = "cancelled"; this.exited.reject(refused()); }
      else if (status === 4 && (this.phase === "holding" || this.phase === "verified")) {
        // GO was never sent. A well-formed native REFUSED plus the expected
        // helper close proves this abandoned HOLD has no target to recover.
        this.phase = "refused"; this.unlinkVerification();
        this.verified.reject(refused()); this.started.reject(refused()); this.exited.reject(refused());
      }
      else { this.fail(); return; }
    }
  }
  launch(): PrivateClaudeCodeNativeChildV1 {
    if (this.phase !== "verified") throw refused();
    this.phase = "launching";
    const ready = (signal: AbortSignal) => interruptible(this.started.promise, signal);
    const send = async (opcode: number, signal: AbortSignal) => {
      if (signal.aborted) throw uncertain();
      if (this.terminal) return;
      await ready(signal);
      if (this.phase === "exit") return;
      if (this.phase !== "started" || ++this.commandCount > 32) throw uncertain();
      await interruptible(write(this.control, command(opcode)), signal);
    };
    const owned = Object.freeze({
      writeStdin: async (bytes: Uint8Array, signal: AbortSignal) => {
        this.inputBytes += bytes.byteLength;
        if (this.sentEof || this.inputBytes > this.configuration.maximumInputBytes) { this.fail(); throw uncertain(); }
        const copied = Buffer.from(bytes);
        await ready(signal); await interruptible(write(this.input, copied), signal);
      },
      readStdout: async (signal: AbortSignal) => { await ready(signal); return this.output.read(signal); },
      readStderr: async (signal: AbortSignal) => { await ready(signal); return this.errors.read(signal); },
      closeStdin: async (signal: AbortSignal) => {
        await ready(signal); if (this.sentEof) return; this.sentEof = true;
        await interruptible(new Promise<void>((resolve, reject) => this.input.end((error?: Error) => error ? reject(uncertain()) : resolve())), signal);
      },
      signalTerminate: (signal: AbortSignal) => send(4, signal),
      signalKill: (signal: AbortSignal) => send(5, signal),
      close: async (signal: AbortSignal) => { await interruptible(this.exited.promise, signal); await interruptible(this.closed.promise, signal); },
      exited: this.exited.promise,
    });
    // Queue GO only after synchronous ownership is returned to the higher
    // authority-fenced host. It cannot lose an asynchronously created child.
    queueMicrotask(() => { if (this.phase === "launching") void write(this.control, command(2)).catch(() => this.fail()); });
    return owned;
  }
}

/** Explicit source port, never a default or an installer. One verification
 * owns one HOLD session; launch consumes it once. Owner installation code must
 * supply reviewed release pins, target identities and qualification evidence. */
export function createPrivateMacosClaudeCodeInstalledProcessHostPortsV1(
  configurationValue: PrivateMacosClaudeCodeProcessPortConfigurationV1,
): PrivateClaudeCodeInstalledProcessHostPortsV1 {
  let c: Configuration;
  try { c = configurationSchema.parse(configurationValue); }
  catch { throw refused(); }
  if (process.platform !== "darwin" || process.getuid?.() !== c.ownerUid || process.geteuid?.() !== c.ownerUid) throw refused();
  for (const value of [c.executableIdentity.device, c.executableIdentity.inode, c.workingDirectoryIdentity.device, c.workingDirectoryIdentity.inode])
    if (BigInt(value) > BigInt("18446744073709551615")) throw refused();
  let held: NativeSession | undefined, busy = false;
  function matches(request: PrivateClaudeCodeInstalledProcessVerificationRequestV1 | PrivateClaudeCodeInstalledProcessLaunchRequestV1) {
    return request.schema === CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1
      && request.executablePath === c.executablePath && request.executableSha256 === c.executableSha256
      && request.workingDirectory === c.workingDirectory && request.workingDirectoryBindingDigest === c.workingDirectoryBindingDigest
      && request.qualificationDigest === c.qualificationDigest;
  }
  return Object.freeze({
    async verifyInstallation(request: PrivateClaudeCodeInstalledProcessVerificationRequestV1) {
      if (busy || !matches(request) || !(request.signal instanceof AbortSignal) || request.signal.aborted) throw refused();
      busy = true;
      try {
        verifyHelper(c); const session = new NativeSession(c, request.signal); held = session;
        // A port supports sequential tasks. Concurrency is refused because the
        // existing verification contract carries no per-attempt lookup key.
        void session.closed.promise.then(() => {
          if (held === session) held = undefined;
          busy = false;
        }, () => { /* Unknown retirement stays locked. */ });
        await session.verified.promise;
        return Object.freeze({ schema: CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1, outcome: "verified" as const,
          executableSha256: c.executableSha256, workingDirectoryBindingDigest: c.workingDirectoryBindingDigest,
          qualificationDigest: c.qualificationDigest });
      } catch { if (held && held.phase !== "refused") held.fail(); else if (!held) busy = false; throw refused(); }
    },
    launch(request: PrivateClaudeCodeInstalledProcessLaunchRequestV1) {
      if (!held || !matches(request) || request.args.length !== CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1.length
        || request.args.some((value, index) => value !== CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1[index])) { held?.fail(); throw refused(); }
      const session = held; held = undefined; return session.launch();
    },
  });
}
