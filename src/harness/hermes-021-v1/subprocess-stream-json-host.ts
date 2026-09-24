import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { types } from "node:util";
import { z } from "zod";
import type { Hermes021MacosStreamJsonHostV1 } from "./stream-json-private-port";
import type { Hermes021MacosTaskV1 } from "./macos-local-worker";
import { captureHermes021MacosReviewedExecutableIdentityV1,
  type Hermes021MacosReviewedExecutableIdentityV1 } from "./reviewed-executable-identity";

const unavailable = (): never => { throw new Error("hermes_021_macos_subprocess_host_unavailable"); };
const unavailableError = (): Error => new Error("hermes_021_macos_subprocess_host_unavailable");
const safeIdentifier = z.string().min(1).max(120).regex(/^[A-Za-z0-9._:/-]+$/);
const safeProfile = z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/);
const safePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && normalize(value) === value
  && !/[\u0000-\u001f\u007f]/u.test(value));

const configurationSchema = z.object({
  /** Owner-pinned absolute Hermes executable; tasks cannot replace it. */
  executablePath: safePath,
  profile: safeProfile,
  model: safeIdentifier,
  provider: safeIdentifier,
  /** Installation-owned folder in which Hermes may perform this approved turn. */
  workingDirectory: safePath,
  /** This adapter revision is deliberately useful before project-writing exists. */
  taskClass: z.literal("text_review").default("text_review"),
  /** More turns or time belong to a separately qualified adapter revision. */
  maximumTurns: z.literal(1).default(1),
  maximumRunBudgetSeconds: z.number().int().min(15).max(120).default(120),
}).strict();
export type Hermes021MacosSubprocessHostConfigurationV1 = z.input<typeof configurationSchema>;

type CapturedConfiguration = ReturnType<typeof captureHermes021MacosSubprocessHostConfigurationV1>;
type OwnerQualificationHost = Readonly<{
  configuration: CapturedConfiguration;
  reviewedExecutableIdentity: Hermes021MacosReviewedExecutableIdentityV1;
  qualify(expectedText: string): Promise<readonly unknown[]>;
}>;
const ownerQualificationHosts = new WeakMap<object, OwnerQualificationHost>();

/**
 * Parses only the installation-owned runner settings. This does not touch the
 * executable, working directory, credentials, or network. The no-run
 * preflight and the real subprocess host share this parser so a preflight
 * cannot approve a shape the runner would later reject.
 */
export function captureHermes021MacosSubprocessHostConfigurationV1(value: unknown) {
  return Object.freeze(configurationSchema.parse(value));
}

type LaunchOptions = SpawnOptions & Readonly<{ stdio: ["pipe", "pipe", "pipe"] }>;
type Launch = (file: string, args: readonly string[], options: LaunchOptions) => ChildProcessWithoutNullStreams;
type MakeDirectory = (prefix: string) => Promise<string>;
type RemoveDirectory = (path: string, options: Readonly<{ recursive: true; force: true }>) => Promise<void>;
type SaveFile = (path: string, contents: string, options: Readonly<{ encoding: "utf8"; mode: number; flag: "wx" }>) => Promise<void>;

function taskText(input: Parameters<Hermes021MacosStreamJsonHostV1["execute"]>[0]["task"]): string {
  // The task is passed as file content rather than as command-line text. A task
  // cannot change the executable or arguments selected below.
  return ["You are completing one approved Control Room text-review task.",
    "Return a plain-text review, test outline, or proposed patch only.",
    "Do not call tools, write files, access accounts, or make network requests.", "", "Instructions:", input.instructions,
    "", "Task:", input.prompt, ""].join("\n");
}

/**
 * The installer's narrowly configured local Hermes host. It uses the existing
 * Hermes CLI only through fixed argv entries and a 0600 temporary query file.
 * It is intentionally not wired into application startup: creating this host
 * does not start Hermes, retain credentials, or enable a worker. The caller
 * must still supply the existing Control Room policy and queue composition.
 */
function createHost(configurationValue: unknown, launch: Launch, makeDirectory: MakeDirectory,
  removeDirectory: RemoveDirectory, saveFile: SaveFile, now: () => number,
  beforeLaunch?: () => Promise<void>): Hermes021MacosStreamJsonHostV1 {
  const configuration = captureHermes021MacosSubprocessHostConfigurationV1(configurationValue);
  if (typeof launch !== "function" || typeof makeDirectory !== "function" || typeof removeDirectory !== "function"
    || typeof saveFile !== "function" || typeof now !== "function") unavailable();
  const host = Object.freeze({ async execute(input: Readonly<{
    task: Hermes021MacosTaskV1;
    signal?: AbortSignal;
    onLine(line: string): Promise<void>;
  }>) {
    if (!input || input.signal?.aborted || !Number.isSafeInteger(input.task.deadline)) unavailable();
    const remainingMilliseconds = input.task.deadline - now();
    const configuredMilliseconds = configuration.maximumRunBudgetSeconds * 1000;
    // Do not give a process a grace period past the controller-approved window.
    const timeoutMilliseconds = Math.min(configuredMilliseconds, remainingMilliseconds);
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000) unavailable();
    const directory = await makeDirectory(join(tmpdir(), "control-room-hermes-task-"));
    const queryFile = join(directory, "task.txt");
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      await saveFile(queryFile, taskText(input.task), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await beforeLaunch?.();
      const args = Object.freeze(["-p", configuration.profile, "chat", "--query-file", queryFile,
        "--format", "stream-json", "--toolsets", "bot_room", "--ignore-rules", "--max-turns",
        String(configuration.maximumTurns), "--run-budget", String(configuration.maximumRunBudgetSeconds),
        "--source", "control-room-local-worker", "--in", configuration.workingDirectory,
        "--model", configuration.model, "--provider", configuration.provider]);
      await new Promise<void>((resolve, reject) => {
        let settled = false, closed = false, bytes = 0, pending = Promise.resolve();
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        let remainder = "";
        const decoder = new StringDecoder("utf8");
        const fail = () => {
          if (settled) return;
          settled = true;
          try { child?.kill("SIGTERM"); } catch { /* close is still awaited below */ }
          // A process that ignores its normal termination signal is not allowed
          // to keep the approved window open indefinitely. We still wait for
          // its close event before reporting failure or cleaning task material.
          forceTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* close remains authoritative */ } }, 5_000);
        };
        const complete = (error?: Error) => {
          if (closed) return;
          closed = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); input.signal?.removeEventListener("abort", fail);
          void pending.then(() => error || settled || input.signal?.aborted ? reject(unavailableError()) : resolve(), () => reject(unavailableError()));
        };
        const receive = (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.byteLength;
          if (bytes > 262_144) { fail(); return; }
          remainder += decoder.write(chunk);
          const lines = remainder.split("\n"); remainder = lines.pop() ?? "";
          for (const line of lines) {
            const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
            if (clean === "") continue;
            pending = pending.then(() => input.onLine(clean));
            void pending.catch(fail);
          }
        };
        try {
          child = launch(configuration.executablePath, args, { shell: false, windowsHide: true, cwd: configuration.workingDirectory,
            env: { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
        } catch { reject(unavailableError()); return; }
        const timer = setTimeout(fail, timeoutMilliseconds);
        input.signal?.addEventListener("abort", fail, { once: true });
        child.on("error", fail); child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail);
        child.stdout.on("data", receive);
        child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 262_144) fail(); });
        child.once("close", (code, signal) => {
          const tail = decoder.end();
          if (tail) {
            remainder += tail;
            if (remainder && !settled) { pending = pending.then(() => input.onLine(remainder)); void pending.catch(fail); }
          }
          if (code !== 0 || signal !== null || remainder.includes("\r") || settled || input.signal?.aborted) complete(new Error("child_failed"));
          else complete();
        });
        try { child.stdin.end(); } catch { fail(); }
      });
    } finally {
      // The task prompt is private operational content. It must not remain as a
      // local workboard artifact after the owned child has closed.
      await removeDirectory(directory, { recursive: true, force: true });
    }
  } });
  return host;
}

/** General process host with explicit test seams. It never mints owner
 * qualification authority, including when every injected primitive is real. */
export function createHermes021MacosSubprocessStreamJsonHostV1(configurationValue: unknown,
  launch: Launch = (file, args, options) => spawn(file, [...args], options) as ChildProcessWithoutNullStreams,
  makeDirectory: MakeDirectory = mkdtemp,
  removeDirectory: RemoveDirectory = rm,
  saveFile: SaveFile = writeFile,
  now: () => number = Date.now): Hermes021MacosStreamJsonHostV1 {
  return createHost(configurationValue, launch, makeDirectory, removeDirectory, saveFile, now);
}

function sameStat(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size
    && left.nlink === right.nlink && left.uid === right.uid && left.gid === right.gid
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function attestExecutable(path: string, reviewed: Hermes021MacosReviewedExecutableIdentityV1,
  expectedStat?: Awaited<ReturnType<typeof lstat>>): Promise<Awaited<ReturnType<typeof lstat>>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined, bytes: Buffer | undefined;
  try {
    const namedBefore = await lstat(path);
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.nlink !== 1
      || (namedBefore.mode & 0o111) === 0 || await realpath(path) !== path) unavailable();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = await handle.stat();
    if (!sameStat(namedBefore, openedBefore) || expectedStat && !sameStat(expectedStat, openedBefore)
      || openedBefore.size < 1 || openedBefore.size > 64 * 1024 * 1024) unavailable();
    bytes = await handle.readFile();
    const openedAfter = await handle.stat(), namedAfter = await lstat(path);
    const executableSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (!sameStat(openedBefore, openedAfter) || !sameStat(openedBefore, namedAfter)
      || bytes.length !== openedBefore.size || executableSha256 !== reviewed.executableSha256
      || await realpath(path) !== path) unavailable();
    return openedBefore;
  } catch { return unavailable(); }
  finally { bytes?.fill(0); await handle?.close().catch(() => undefined); }
}

/**
 * Concrete owner-terminal subprocess route. There is deliberately no launch,
 * filesystem, clock, or callback injection seam: only this native constructor
 * can place a host in qualification custody.
 */
export async function createHermes021MacosNativeOwnerQualificationHostV1(
  configurationValue: unknown, reviewedExecutableIdentityValue: unknown): Promise<object> {
  const configuration = captureHermes021MacosSubprocessHostConfigurationV1(configurationValue);
  const reviewedExecutableIdentity = captureHermes021MacosReviewedExecutableIdentityV1(reviewedExecutableIdentityValue);
  const executableStat = await attestExecutable(configuration.executablePath, reviewedExecutableIdentity);
  const host = createHost(configuration,
    (file, args, options) => spawn(file, [...args], options) as ChildProcessWithoutNullStreams,
    mkdtemp, rm, writeFile, Date.now,
    async () => { await attestExecutable(configuration.executablePath, reviewedExecutableIdentity, executableStat); });
  const capability = Object.freeze({ schema: "control-room.hermes-021-macos-native-owner-qualification-host/v1",
    providesGeneralExecutionAuthority: false as const });
  ownerQualificationHosts.set(capability, Object.freeze({ configuration, reviewedExecutableIdentity,
    async qualify(expectedText) {
      if (!/^CONTROL_ROOM_HERMES_RUNNER_[a-f0-9]{32}$/u.test(expectedText)) unavailable();
      const lines: unknown[] = [];
      await host.execute(Object.freeze({ task: Object.freeze({ tenantId: "tenant:qualification",
        projectId: "project:qualification", jobId: "job:qualification", attemptId: "attempt:qualification",
        runId: "run:qualification", nodeId: "node:qualification",
        prompt: `Reply with exactly this text and nothing else: ${expectedText}`,
        instructions: "Use no tools and do not write files.",
        deadline: Date.now() + configuration.maximumRunBudgetSeconds * 1_000 + 5_000 }),
      async onLine(line) {
        if (lines.length >= 64 || typeof line !== "string" || line.includes("\n") || line.includes("\r")) unavailable();
        try { lines.push(JSON.parse(line)); } catch { unavailable(); }
      } }));
      return Object.freeze(lines);
    } }));
  return capability;
}

/**
 * Burns the concrete subprocess host's one qualification route.  A structural
 * `{ execute }` value, copied host, Proxy, or replay has no entry in this
 * module's private custody and cannot reach the qualification procedure.
 *
 * The outer owner-terminal command is responsible for resolving the selected
 * executable and constructing this host after its attended checks.  This seam
 * deliberately accepts no caller-supplied `ownerAttended` assertion.
 */
export function consumeHermes021MacosOwnerQualificationHostV1(value: unknown): OwnerQualificationHost {
  if (!value || typeof value !== "object" || types.isProxy(value)) unavailable();
  const token = value as object;
  const captured = ownerQualificationHosts.get(token);
  if (!captured) return unavailable();
  if (!ownerQualificationHosts.delete(token)) return unavailable();
  return captured;
}
