import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
  memoryBytes: 128 * 1024 * 1024,
});

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

async function groupRssBytes(pid: number, spawnProcess: typeof spawn): Promise<number | undefined> {
  return await new Promise(resolveResult => {
    let child: ChildProcess;
    try {
      child = spawnProcess("/bin/ps", ["-o", "rss=", "-g", String(pid)], {
        shell: false,
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch { resolveResult(undefined); return; }
    let output = "";
    child.stdout?.on("data", chunk => { output += chunk.toString("utf8"); });
    child.once("error", () => resolveResult(undefined));
    child.once("close", code => {
      if (code !== 0) { resolveResult(undefined); return; }
      const kibibytes = output.split(/\s+/u).filter(Boolean).reduce((sum, value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? sum + parsed : sum;
      }, 0);
      resolveResult(kibibytes * 1024);
    });
  });
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
  const home = sandboxLiteral(resolve(homedir()));
  const node = sandboxLiteral(resolve(nodeExecutable));
  const converter = sandboxLiteral(resolve(converterExecutable));
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    `(allow process-exec (literal "${node}") (literal "${converter}"))`,
    "(allow signal (target same-sandbox))",
    "(deny process-info*)",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs") (sysctl-name-prefix "kern.proc."))',
    "(allow file-read* file-map-executable)",
    `(deny file-read* file-map-executable (subpath "${home}") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/Volumes"))`,
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
        void groupRssBytes(child.pid, spawnProcess).then(bytes => {
          if (bytes === undefined) stop("resource_monitor_unavailable");
          else if (bytes > limits.memoryBytes) stop("memory_limit");
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
    let details;
    try { details = await lstat(command.outputPath); } catch { return { category: "conversion_failed" }; }
    if (details.isSymbolicLink() || !details.isFile()) return { category: "conversion_failed" };
    if (details.size > limits.markdownBytes) return { category: "output_too_large" };
    const output = await readFile(command.outputPath);
    if (output.includes(0)) return { category: "conversion_failed" };
    try { new TextDecoder("utf-8", { fatal: true }).decode(output); }
    catch { return { category: "conversion_failed" }; }
    return { category: "none", output };
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
    const bytes = request?.sourceBytes instanceof Uint8Array ? new Uint8Array(request.sourceBytes) : new Uint8Array();
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

    const tempDirectory = await mkdtemp("/tmp/acr-convert-");
    const inputPath = join(tempDirectory, format === "html" ? "source.html" : "source.pdf");
    const outputPath = join(tempDirectory, "derived.md");
    try {
      await writeFile(inputPath, bytes, { mode: 0o600, flag: "wx" });
      const converterExecutable = format === "html" ? nodeExecutable : pdfExecutable!;
      const worker = join(this.#configuration.repositoryRoot, "scripts", "converter", "html-to-markdown-worker.mjs");
      const converterArguments = format === "html"
        ? ["--max-old-space-size=96", worker, inputPath, outputPath]
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
