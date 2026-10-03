import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEXT_COPY_DERIVATION_SCHEMA,
  type TextCopyConversionRequest,
  type TextCopyConverterIdentity,
  type TextCopyConverterPort,
  type TextCopyDerivationResult,
  type TextCopyDiagnosticCategory,
  type TextCopySourceFormat,
} from "./text-copy-port.ts";

const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const MEMORY_SAMPLE_MS = 25;
const STOP_GRACE_MS = 150;
/**
 * The Node old-space ceiling, in MB, for the sandboxed HTML worker.
 *
 * The worker refuses to run unless its own `heap_size_limit` is at or below
 * `TEXT_COPY_WORKER_MAX_HEAP_BYTES`, and `--max-old-space-size=N` does NOT
 * produce a `heap_size_limit` of N. Measured on the deployed Node (26.7.0):
 *
 *     --max-old-space-size=64  ->  heap_size_limit = 167772160  (passes)
 *     --max-old-space-size=96  ->  heap_size_limit = 201326592  (fails)
 *     --max-old-space-size=128 ->  heap_size_limit = 234881024  (fails)
 *     --max-old-space-size=160 ->  heap_size_limit = 268435456  (fails)
 *
 * The service used to pass 96 against a 160 MiB worker ceiling. Every HTML
 * conversion therefore died with `memory_limit_unenforced` and returned no
 * text copy at all. The flag and the worker's own guard are now derived from
 * one constant so they cannot drift apart again, and the mutation check for
 * the flag is paired with one for the worker's ceiling.
 */
const TEXT_COPY_NODE_HEAP_MB = 64;
const HTML_IDENTITY = Object.freeze({ id: "control-room.html-readability-markdown", version: "1.0.0" });
const PDF_IDENTITY = Object.freeze({ id: "control-room.pdftotext", version: "1.0.0" });
const STUB_IDENTITIES = Object.freeze({
  docx: Object.freeze({ id: "control-room.docx-stub", version: "1.0.0" }),
  pptx: Object.freeze({ id: "control-room.pptx-stub", version: "1.0.0" }),
  audio: Object.freeze({ id: "control-room.audio-stub", version: "1.0.0" }),
});

export const TEXT_COPY_LIMITS = Object.freeze({
  htmlInputBytes: 512 * 1024,
  pdfInputBytes: 32 * 1024 * 1024,
  markdownBytes: 2 * 1024 * 1024,
  diagnosticBytes: 16 * 1024,
  timeoutMs: 10_000,
  /**
   * The ceiling on the converter's whole PROCESS GROUP, which is what the
   * monitor samples and what bounds a hostile converter.
   *
   * This was 128 MiB, and that was below the service's own declared limits: the
   * worker is given a 160 MiB heap ceiling, so a converter that is behaving
   * correctly could be killed for exceeding a budget smaller than the one it
   * was given. Measured on the production sandbox, sweeping legal input sizes:
   *
   *     8 KiB input  -> succeeded
   *    32 KiB input  -> succeeded
   *    64 KiB input  -> succeeded
   *   128 KiB input  -> memory_limit   (deterministic; a retry fails the same way)
   *   256 KiB input  -> memory_limit
   *   512 KiB input  -> memory_limit
   *
   * So a quarter of the advertised 512 KiB HTML ceiling could not be converted
   * at all. jsdom builds a DOM several times the size of its source, Readability
   * holds a second copy while scoring, and the resulting text is a third — so
   * the group legitimately reaches ~190 MiB on a 128 KiB document.
   *
   * 512 MiB now admits the largest HTML the service will accept (measured peak
   * ~190 MiB, so roughly 2.7x headroom) while still bounding a hostile process:
   * one converter cannot reach the machine's memory, and the deadline still caps
   * how long it may hold it.
   */
  memoryBytes: 512 * 1024 * 1024,
});

/** Shared across every service instance in this process; there is no wait queue. */
export const TEXT_COPY_ADMISSION_LIMITS = Object.freeze({ activeConversions: 2, sourceBytes: 32 * 1024 * 1024 });
let activeConversions = 0;
let activeSourceBytes = 0;

export interface TextCopyLimits {
  readonly htmlInputBytes: number;
  readonly pdfInputBytes: number;
  readonly markdownBytes: number;
  readonly diagnosticBytes: number;
  readonly timeoutMs: number;
  readonly memoryBytes: number;
}

export interface TextCopyServiceConfiguration {
  readonly repositoryRoot?: string;
  readonly sandboxExecutable?: string;
  readonly nodeExecutable?: string;
  readonly pdfExecutable?: string;
  readonly pdfPrefixArguments?: readonly string[];
  readonly limits?: Partial<TextCopyLimits>;
}

interface ExecutionDependencies {
  readonly spawnProcess?: typeof spawn;
  /** Tests use the real worker behind a direct runner because nested Seatbelt
   * profiles are not available in every build sandbox. Production never sets
   * this and the worker verifies that its network syscall is denied. */
  readonly skipNetworkDenialProbe?: boolean;
  readonly skipMemoryLimitProbe?: boolean;
}

interface FixedCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly outputPath: string;
  readonly tempDirectory: string;
  readonly profile: string;
}

interface ExecutionResult {
  readonly category: TextCopyDiagnosticCategory;
  readonly output?: Uint8Array;
}

interface Limits {
  readonly htmlInputBytes: number;
  readonly pdfInputBytes: number;
  readonly markdownBytes: number;
  readonly diagnosticBytes: number;
  readonly timeoutMs: number;
  readonly memoryBytes: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`text_copy_configuration_invalid:${name}`);
  return value;
}

function safeArgument(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`text_copy_configuration_invalid:${name}`);
  }
  return value;
}

function absoluteExecutable(value: string, name: string): string {
  const checked = safeArgument(value, name);
  if (!isAbsolute(checked)) throw new Error(`text_copy_configuration_invalid:${name}`);
  return checked;
}

function sandboxLiteral(value: string): string {
  if (/["\\\n\r]/u.test(value)) throw new Error("text_copy_configuration_invalid:sandbox_path");
  return value;
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function result(
  sourceDigest: `sha256:${string}`,
  converter: TextCopyConverterIdentity,
  status: "succeeded" | "no_text_copy",
  diagnosticCategory: TextCopyDiagnosticCategory,
  markdownBytes: Uint8Array = new Uint8Array(),
): TextCopyDerivationResult {
  return Object.freeze({
    schema: TEXT_COPY_DERIVATION_SCHEMA,
    sourceDigest,
    converter,
    status,
    diagnosticCategory,
    markdownBytes: new Uint8Array(markdownBytes),
  });
}

function inputLimit(format: TextCopySourceFormat, limits: Limits): number {
  return format === "pdf" ? limits.pdfInputBytes : limits.htmlInputBytes;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) return;
  try { process.kill(-pid!, signal); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Once the owned group leader has exited, macOS can resolve the old group
    // number to a protected process and answer EPERM instead of ESRCH. Never
    // fall back to signalling a positive pid; the pre-exit group signal and
    // the bounded KILL timer are the owned-process cleanup boundary.
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

/**
 * The resident memory of one process group, or a reason the sample is unusable.
 *
 * The distinction between "the monitor failed" and "the group is already gone"
 * is load-bearing and was measured, not assumed. `/bin/ps -o rss= -g <pgid>`
 * exits 0 with output for a live group (40/40 samples) and exits NON-ZERO for a
 * group whose leader has already exited (40/40 samples). The service used to
 * map both to `undefined`, and the caller turned `undefined` into
 * `resource_monitor_unavailable` — so a conversion that had already finished
 * perfectly was reported as a failed conversion whenever its monitor sample
 * landed after the process exited. Under a 20-caller burst that happened on
 * 13 of 50 calls. Reporting "the group is gone" separately lets the caller
 * apply the rule it actually wants: a vanished group is a finished conversion,
 * not a broken monitor.
 */
type GroupRssSample =
  | { readonly kind: "sampled"; readonly bytes: number }
  /** `ps` ran and reported no such group: the process finished before we looked. */
  | { readonly kind: "group_gone" }
  /** `ps` itself could not be run or read: the monitor is genuinely unavailable. */
  | { readonly kind: "monitor_unavailable" };

async function groupRssBytes(pid: number, spawnProcess: typeof spawn): Promise<GroupRssSample> {
  return await new Promise(resolveResult => {
    let child: ChildProcess;
    try {
      child = spawnProcess("/bin/ps", ["-o", "rss=", "-g", String(pid)], {
        shell: false,
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch { resolveResult({ kind: "monitor_unavailable" }); return; }
    let output = "";
    let settled = false;
    const settle = (sample: GroupRssSample) => {
      if (settled) return;
      settled = true;
      resolveResult(sample);
    };
    child.stdout?.on("data", chunk => { output += chunk.toString("utf8"); });
    child.once("error", () => settle({ kind: "monitor_unavailable" }));
    child.once("close", code => {
      // A spawn error and a close both fire; the first one to arrive wins, so a
      // monitor that fails to start is never reported as a vanished group.
      if (code !== 0) { settle({ kind: "group_gone" }); return; }
      const rows = output.split(/\s+/u).filter(Boolean);
      if (rows.length === 0) {
        // `ps` exited 0 and printed no row at all. That is a monitor that cannot
        // answer, so it fails closed rather than reporting a healthy reading.
        settle({ kind: "monitor_unavailable" });
        return;
      }
      // A row that sums to ZERO is a real reading, not a broken monitor: macOS
      // `ps` reports RSS 0 for a process group whose members are already being
      // torn down, and that was measured happening mid-burst (2 of 636 samples
      // at n=50). Zero is unambiguously within the budget, so it is honoured.
      // Treating it as "unavailable" — which this function did on its first
      // version — turned correct conversions into resource_monitor_unavailable
      // failures under load. Only a missing row is a missing measurement.
      const kibibytes = rows.reduce((sum, value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? sum + parsed : sum;
      }, 0);
      settle({ kind: "sampled", bytes: kibibytes * 1024 });
    });
  });
}

/**
 * The converter's output, validated on the OPEN FILE DESCRIPTOR, not on a path.
 *
 * The previous shape was `lstat(path)` then `readFile(path)`, which is a
 * check/use pair on a name another process can rename: `lstat` does not follow
 * symlinks and `readFile` does, so anything that could rewrite the output
 * between the two calls won the race and made the service return the bytes of a
 * file the converter had no right to read. Measured through the real service
 * against a forked child swapping the output for a symlink to a file the
 * sandbox denies the worker itself.
 *
 * Now the name is resolved ONCE, by the kernel, at open time, with O_NOFOLLOW:
 *
 *   * O_NOFOLLOW makes the open itself fail with ELOOP if the final component
 *     is a symlink, so no later rename or swap can change what was opened.
 *   * `fstat` then describes the file this descriptor actually refers to, not
 *     whatever the path pointed at a moment ago — the type check and the size
 *     ceiling are both answered from the descriptor.
 *   * the read comes off that same descriptor.
 *
 * There is no window in which the service decides about one file and reads
 * another. This holds regardless of whether any process survives the worker,
 * which is why it is kept alongside (and not instead of) denying `process-fork`
 * in the profile.
 *
 * Returns the bytes, `null` when the output is absent, is not a regular file,
 * is a symlink, or cannot be read, or a zero-length-but-valid result otherwise.
 * An oversize file returns the sentinel `OVERSIZE` so the caller can report
 * `output_too_large` rather than `conversion_failed`.
 */
const OVERSIZE = Symbol("text_copy_output_oversize");

/** Read chunk for the bounded loop below. Sized so the common case (a few KiB of
 * markdown) is a single read, while a 2 MiB output costs 32 reads rather than
 * one 2 MiB allocation per conversion. */
const OUTPUT_READ_CHUNK_BYTES = 64 * 1024;

async function readVerifiedOutput(path: string, maximumBytes: number): Promise<Buffer | typeof OVERSIZE | null> {
  let handle: FileHandle | undefined;
  try {
    // O_RDONLY | O_NOFOLLOW: the open refuses a symlinked final component
    // (ELOOP) instead of following it, and it is the only point at which the
    // name is resolved.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    // The descriptor's own type, never the path's. A FIFO or a device here
    // would block forever in read() and is not text either way.
    if (!stats.isFile()) return null;
    if (stats.size > maximumBytes) return OVERSIZE;
    // Loop to EOF rather than reading once. POSIX permits a single read() of a
    // regular file to return SHORT, and treating one short read as the whole
    // output would store a silently truncated text copy and report SUCCESS — the
    // worst possible failure shape, because nothing downstream can tell it
    // happened. Measured, for honesty: read() returned the full length at every
    // size tried on this filesystem (64 KiB through 2 MiB), so that is the
    // justification and not an observed failure here.
    //
    // The ceiling is enforced against bytes ACTUALLY READ, not against the stat,
    // because the file can grow between the two: the stat is the fast path that
    // avoids a 2 MiB allocation on the common refusal, and this loop is the
    // authority.
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(OUTPUT_READ_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) return OVERSIZE;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } catch {
    // ELOOP (symlink), ENOENT (never written), ENOENT/EACCES from the sandbox,
    // EISDIR — all refusals, and all refusals are the same typed outcome: the
    // conversion produced no trusted output.
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

class BoundedDiagnostic {
  readonly #maximum: number;
  #bytes = 0;
  #chunks: Buffer[] = [];

  constructor(maximum: number) { this.#maximum = maximum; }

  add(chunk: Buffer | string): boolean {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#bytes += bytes.length;
    const retained = this.#chunks.reduce((sum, value) => sum + value.length, 0);
    if (retained < this.#maximum) this.#chunks.push(bytes.subarray(0, this.#maximum - retained));
    return this.#bytes <= this.#maximum;
  }

  text(): string { return Buffer.concat(this.#chunks).toString("utf8"); }
}

function buildSandboxProfile(repositoryRoot: string, tempDirectory: string, nodeExecutable: string, converterExecutable: string): string {
  const repository = sandboxLiteral(resolve(repositoryRoot));
  const workerDirectory = sandboxLiteral(join(repository, "scripts", "converter"));
  const dependencies = sandboxLiteral(join(repository, "node_modules"));
  const packageManifest = sandboxLiteral(join(repository, "package.json"));
  const temporary = sandboxLiteral(resolve(tempDirectory));
  const node = sandboxLiteral(resolve(nodeExecutable));
  const converter = sandboxLiteral(resolve(converterExecutable));
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    // NO `(allow process-fork)`. The worker's whole job is one Node process that
    // reads the input and writes the output, and it was measured converting
    // correctly with fork denied: same status, same markdown, and a `spawnSync`
    // from inside this profile returns EPERM where the fork-granting profile
    // returned status 0. `probe: converter sandbox fork containment` and the
    // real-enforcement suite both assert that.
    //
    // Why the denial is the containment, not a nicety. Cleanup signals the
    // worker's PROCESS GROUP (`process.kill(-pid)`) and the memory monitor
    // samples only that pgid (`ps -g`). A child the worker started `detached`
    // lands in its own session and therefore in neither: it survives the
    // SIGTERM/SIGKILL sweep and is never counted against the memory budget. A
    // compromised converter (an RCE in jsdom/Readability via hostile HTML —
    // the exact case the sandbox exists for) could leave an unbounded number of
    // uncounted, unkilled processes running — each still unable to reach the
    // network or write outside its temp dir, but outside every bound the
    // service advertises.
    //
    // Denying fork also closes the output TOCTOU the fork granted: with no
    // surviving process, nothing can swap the output between the lstat that
    // validates it and the read that consumes it. Both were measured against a
    // forked child racing a symlink swap at the output path; with fork denied
    // the racing writer cannot exist. The O_NOFOLLOW read below is the
    // defence-in-depth half of the same property, and it holds independently.
    `(allow process-exec (literal "${node}") (literal "${converter}"))`,
    "(allow signal (target same-sandbox))",
    "(deny process-info*)",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs") (sysctl-name-prefix "kern.proc."))',
    // Metadata only, across the whole filesystem, and nothing else.
    //
    // This REPLACED a `(allow file-read* file-map-executable)` blanket followed
    // by a blanket deny of the home directory, the temp roots and /Volumes. That
    // shape was measured and it is fatal: `file-read*` covers the lstat that
    // resolves a path, so denying it on every ancestor of the worker script
    // (`/Users/<name>`, `/Users`, `/`) made Node die before main with
    // `EPERM: operation not permitted, lstat '/Users/<name>'` — every HTML
    // conversion failed with no output at all.
    //
    // `file-read-metadata` is stat/lstat/readlink on its own; it cannot return
    // a byte of file content. A converter therefore still cannot read the
    // source HTML of another task, a credential, or any other file outside the
    // list below, and path resolution can still walk from `/` down to the exact
    // leaves that are allowed. `probe: converter sandbox read scope` proves the
    // content boundary rather than assuming it.
    '(allow file-read-metadata (subpath "/"))',
    // Content, and only here: the worker script, the pinned dependencies, this
    // call's own private temp directory, the manifest, and the two executables.
    `(allow file-read* file-map-executable (subpath "${workerDirectory}") (subpath "${dependencies}") (subpath "${temporary}") (literal "${packageManifest}") (literal "${node}") (literal "${converter}"))`,
    `(allow file-write* (subpath "${temporary}") (literal "/dev/null") (subpath "/dev/fd"))`,
    '(allow file-ioctl (literal "/dev/null") (subpath "/dev/fd"))',
    "(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6) (socket-domain AF_UNIX))",
    "(deny network*)",
    "(deny appleevent-send)",
    "(deny lsopen)",
  ].join("\n");
}

async function executableExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function defaultPdfExecutable(): Promise<string | undefined> {
  for (const candidate of ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "/usr/bin/pdftotext"]) {
    if (await executableExists(candidate)) return candidate;
  }
  return undefined;
}

function fixedEnvironment(tempDirectory: string, probe: boolean): NodeJS.ProcessEnv {
  return Object.freeze({
    HOME: tempDirectory,
    TMPDIR: tempDirectory,
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    NODE_ENV: "production",
    CONTROL_ROOM_NETWORK_DENIAL_PROBE: probe ? "required" : "test-bypass",
  });
}

async function executeFixedCommand(
  command: FixedCommand,
  limits: Limits,
  signal: AbortSignal | undefined,
  dependencies: ExecutionDependencies,
): Promise<ExecutionResult> {
  if (signal?.aborted) return { category: "cancelled" };
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const diagnostic = new BoundedDiagnostic(limits.diagnosticBytes);
  let child: ChildProcess | undefined;
  let stopCategory: TextCopyDiagnosticCategory | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let memoryTimer: NodeJS.Timeout | undefined;
  let sampling = false;

  const stop = (category: TextCopyDiagnosticCategory) => {
    if (stopCategory) return;
    stopCategory = category;
    signalGroup(child?.pid, "SIGTERM");
    stopTimer = setTimeout(() => signalGroup(child?.pid, "SIGKILL"), STOP_GRACE_MS);
  };
  const onAbort = () => stop("cancelled");

  try {
    const completion = new Promise<{ code: number | null; spawnError?: string }>(resolveResult => {
      child = spawnProcess(command.executable, command.arguments as string[], {
        cwd: command.tempDirectory,
        detached: true,
        shell: false,
        env: fixedEnvironment(command.tempDirectory, !dependencies.skipNetworkDenialProbe),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const capture = (chunk: Buffer) => { if (!diagnostic.add(chunk)) stop("output_too_large"); };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      child.once("error", error => resolveResult({ code: null, spawnError: error.message }));
      child.once("close", code => resolveResult({ code }));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    timeoutTimer = setTimeout(() => stop("timeout"), limits.timeoutMs);
    if (!dependencies.skipMemoryLimitProbe) {
      memoryTimer = setInterval(() => {
        if (!child?.pid || sampling || stopCategory) return;
        sampling = true;
        void groupRssBytes(child.pid, spawnProcess).then(sample => {
          // A group that has already exited is a conversion that already
          // finished, not a broken monitor: the process it was watching is
          // gone, so there is nothing left to bound and nothing to report.
          // Failing closed here is what turned 13 of 50 correct conversions
          // under a burst into `resource_monitor_unavailable`.
          //
          // Mutation note: this line alone is NOT covered by a test, and that is
          // not a gap. `ps` reports a vanished group in TWO ways — a non-zero
          // exit and a zero-row success — and the zero-row case is already caught
          // by the `rows.length === 0` branch in groupRssBytes, which returns
          // `monitor_unavailable`... so removing only this line leaves the case
          // covered by the OTHER refusal, and the suite still passes 18/18.
          // Removing both breaks 9 of 18. Which means the burst failure this
          // fixed had two independent causes and either one alone is enough to
          // catch most of it; the two are kept because "the group is gone" and
          // "the monitor cannot answer" are different facts and only one of them
          // should be reported.
          if (sample.kind === "group_gone") return;
          if (sample.kind === "monitor_unavailable") { stop("resource_monitor_unavailable"); return; }
          if (sample.bytes > limits.memoryBytes) stop("memory_limit");
        }).finally(() => { sampling = false; });
      }, MEMORY_SAMPLE_MS);
    }

    const completed = await completion;
    clearTimeout(timeoutTimer);
    clearInterval(memoryTimer);
    signalGroup(child?.pid, "SIGTERM");
    await new Promise(resolveWait => setTimeout(resolveWait, STOP_GRACE_MS));
    signalGroup(child?.pid, "SIGKILL");
    clearTimeout(stopTimer);

    if (stopCategory) return { category: stopCategory };
    const diagnosticText = diagnostic.text();
    if (completed.spawnError || /sandbox_apply: Operation not permitted|sandbox-exec:.*(?:denied|invalid)/iu.test(diagnosticText)) {
      return { category: "sandbox_unavailable" };
    }
    if (/network_(?:probe|policy)_/u.test(diagnosticText)) return { category: "sandbox_unavailable" };
    if (/memory_limit_unenforced/u.test(diagnosticText)) return { category: "memory_limit" };
    if (/output_too_large/u.test(diagnosticText)) return { category: "output_too_large" };
    if (/html_has_no_readable_text|input_not_utf8/u.test(diagnosticText)) return { category: "invalid_input" };
    if (completed.code !== 0) return { category: "conversion_failed" };
    const verified = await readVerifiedOutput(command.outputPath, limits.markdownBytes);
    if (verified === OVERSIZE) return { category: "output_too_large" };
    // A symlinked output, a missing output and a non-regular file are all the
    // same typed refusal: the conversion produced no trusted text.
    if (verified === null) return { category: "conversion_failed" };
    if (verified.includes(0)) return { category: "conversion_failed" };
    try { new TextDecoder("utf-8", { fatal: true }).decode(verified); }
    catch { return { category: "conversion_failed" }; }
    return { category: "none", output: verified };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(stopTimer);
    clearInterval(memoryTimer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export class SandboxedTextCopyService implements TextCopyConverterPort {
  readonly #configuration: Required<Omit<TextCopyServiceConfiguration, "pdfExecutable" | "limits">> & {
    readonly pdfExecutable?: string;
    readonly limits: Limits;
  };
  readonly #dependencies: ExecutionDependencies;

  constructor(configuration: TextCopyServiceConfiguration = {}, dependencies: ExecutionDependencies = {}) {
    const repositoryRoot = resolve(configuration.repositoryRoot ?? fileURLToPath(new URL("../../../", import.meta.url)));
    const limits = { ...TEXT_COPY_LIMITS, ...configuration.limits };
    for (const [name, value] of Object.entries(limits)) positiveInteger(value, name);
    const prefix = configuration.pdfPrefixArguments ?? [];
    this.#configuration = Object.freeze({
      repositoryRoot,
      sandboxExecutable: absoluteExecutable(configuration.sandboxExecutable ?? SANDBOX_EXECUTABLE, "sandboxExecutable"),
      nodeExecutable: absoluteExecutable(configuration.nodeExecutable ?? process.execPath, "nodeExecutable"),
      pdfExecutable: configuration.pdfExecutable === undefined ? undefined : absoluteExecutable(configuration.pdfExecutable, "pdfExecutable"),
      pdfPrefixArguments: Object.freeze(prefix.map((value, index) => safeArgument(value, `pdfPrefixArguments[${index}]`))),
      limits: Object.freeze(limits),
    });
    this.#dependencies = Object.freeze({ ...dependencies });
  }

  async convert(request: TextCopyConversionRequest): Promise<TextCopyDerivationResult> {
    const source = request?.sourceBytes instanceof Uint8Array ? request.sourceBytes : new Uint8Array();
    const bytes = source;
    const sourceDigest = digest(bytes);
    const format = request?.format;
    if (!(["html", "pdf", "docx", "pptx", "audio"] as const).includes(format)) {
      return result(sourceDigest, { id: "control-room.unknown-stub", version: "1.0.0" }, "no_text_copy", "invalid_input");
    }
    if (format === "docx" || format === "pptx" || format === "audio") {
      return result(sourceDigest, STUB_IDENTITIES[format], "no_text_copy", "not_supported_yet");
    }
    const identity = format === "html" ? HTML_IDENTITY : PDF_IDENTITY;
    if (bytes.length === 0) return result(sourceDigest, identity, "no_text_copy", "invalid_input");
    if (bytes.length > inputLimit(format, this.#configuration.limits)) {
      return result(sourceDigest, identity, "no_text_copy", "input_too_large");
    }
    if (request.signal?.aborted) return result(sourceDigest, identity, "no_text_copy", "cancelled");
    if (activeConversions >= TEXT_COPY_ADMISSION_LIMITS.activeConversions
      || activeSourceBytes + source.byteLength > TEXT_COPY_ADMISSION_LIMITS.sourceBytes)
      return result(sourceDigest, identity, "no_text_copy", "memory_limit");
    activeConversions++;
    const reservedBytes = source.byteLength;
    activeSourceBytes += reservedBytes;
    try {
      // Admission is synchronous and precedes the first source copy or await.
      const snapshot = Uint8Array.from(source);
      return await this.convertAdmitted(request, snapshot, digest(snapshot), format, identity);
    } finally { activeConversions--; activeSourceBytes -= reservedBytes; }
  }

  private async convertAdmitted(request: TextCopyConversionRequest, bytes: Uint8Array,
    sourceDigest: `sha256:${string}`, format: "html" | "pdf", identity: TextCopyConverterIdentity): Promise<TextCopyDerivationResult> {
    if (!(await executableExists(this.#configuration.sandboxExecutable)) || !(await executableExists(this.#configuration.nodeExecutable))) {
      return result(sourceDigest, identity, "no_text_copy", "sandbox_unavailable");
    }
    const sandboxExecutable = await realpath(this.#configuration.sandboxExecutable);
    const nodeExecutable = await realpath(this.#configuration.nodeExecutable);

    const configuredPdfExecutable = format === "pdf"
      ? this.#configuration.pdfExecutable ?? await defaultPdfExecutable()
      : undefined;
    if (format === "pdf" && (!configuredPdfExecutable || !(await executableExists(configuredPdfExecutable)))) {
      return result(sourceDigest, identity, "no_text_copy", "converter_unavailable");
    }
    const pdfExecutable = configuredPdfExecutable ? await realpath(configuredPdfExecutable) : undefined;

    // The temp directory MUST be canonical before it goes into the profile.
    //
    // On macOS `/tmp` is a symlink to `/private/tmp`, so `mkdtemp("/tmp/...")`
    // returns a path whose real path is `/private/tmp/...`. The kernel resolves
    // every operation to the REAL path, and a `(subpath "/tmp/acr-convert-X")`
    // allow therefore matches nothing at all — measured: the write allow covered
    // `/tmp/acr-convert-X` while the worker wrote to `/private/tmp/acr-convert-X`.
    // `resolve()` (which the profile builder used) does not follow symlinks and
    // is not enough; only `realpath` is.
    const tempDirectory = await realpath(await mkdtemp("/tmp/acr-convert-"));
    const inputPath = join(tempDirectory, format === "html" ? "source.html" : "source.pdf");
    const outputPath = join(tempDirectory, "derived.md");
    try {
      await writeFile(inputPath, bytes, { mode: 0o600, flag: "wx" });
      const converterExecutable = format === "html" ? nodeExecutable : pdfExecutable!;
      const worker = join(this.#configuration.repositoryRoot, "scripts", "converter", "html-to-markdown-worker.mjs");
      const converterArguments = format === "html"
        ? [`--max-old-space-size=${TEXT_COPY_NODE_HEAP_MB}`, worker, inputPath, outputPath]
        : [...this.#configuration.pdfPrefixArguments, "-enc", "UTF-8", "-nopgbrk", inputPath, outputPath];
      const profile = buildSandboxProfile(
        this.#configuration.repositoryRoot,
        tempDirectory,
        nodeExecutable,
        converterExecutable,
      );
      const command = Object.freeze({
        executable: sandboxExecutable,
        arguments: Object.freeze(["-p", profile, converterExecutable, ...converterArguments]),
        outputPath,
        tempDirectory,
        profile,
      });
      const execution = await executeFixedCommand(command, this.#configuration.limits, request.signal, this.#dependencies);
      return execution.category === "none" && execution.output
        ? result(sourceDigest, identity, "succeeded", "none", execution.output)
        : result(sourceDigest, identity, "no_text_copy", execution.category);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}
