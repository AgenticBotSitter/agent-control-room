import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { Hermes021MacosStreamJsonHostV1 } from "./stream-json-private-port";
import type { Hermes021MacosTaskV1 } from "./macos-local-worker";

const unavailable = (): never => { throw new Error("hermes_021_macos_subprocess_host_unavailable"); };
const unavailableError = (): Error => new Error("hermes_021_macos_subprocess_host_unavailable");
const safeIdentifier = z.string().min(1).max(120).regex(/^[A-Za-z0-9._:/-]+$/);
const safeProfile = z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/);
const safePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && normalize(value) === value
  && !/[\u0000-\u001f\u007f]/u.test(value));

const configurationSchema = z.object({
  /** Hermes is fixed by this adapter; callers cannot supply another executable. */
  profile: safeProfile,
  model: safeIdentifier,
  provider: safeIdentifier,
  /** Installation-owned folder in which Hermes may perform this approved turn. */
  workingDirectory: safePath,
  /** A normal approved task is bounded; higher limits require a new adapter revision. */
  maximumTurns: z.number().int().min(1).max(8).default(1),
  maximumRunBudgetSeconds: z.number().int().min(15).max(600).default(300),
}).strict();
export type Hermes021MacosSubprocessHostConfigurationV1 = z.input<typeof configurationSchema>;

type LaunchOptions = SpawnOptions & Readonly<{ stdio: ["pipe", "pipe", "pipe"] }>;
type Launch = (file: string, args: readonly string[], options: LaunchOptions) => ChildProcessWithoutNullStreams;
type MakeDirectory = (prefix: string) => Promise<string>;
type RemoveDirectory = (path: string, options: Readonly<{ recursive: true; force: true }>) => Promise<void>;
type SaveFile = (path: string, contents: string, options: Readonly<{ encoding: "utf8"; mode: number; flag: "wx" }>) => Promise<void>;

function taskText(input: Parameters<Hermes021MacosStreamJsonHostV1["execute"]>[0]["task"]): string {
  // The task is passed as file content rather than as command-line text. A task
  // cannot change the executable or arguments selected below.
  return ["You are completing one approved Control Room task.", "", "Instructions:", input.instructions,
    "", "Task:", input.prompt, ""].join("\n");
}

/**
 * The installer's narrowly configured local Hermes host. It uses the existing
 * Hermes CLI only through fixed argv entries and a 0600 temporary query file.
 * It is intentionally not wired into application startup: creating this host
 * does not start Hermes, retain credentials, or enable a worker. The caller
 * must still supply the existing Control Room policy and queue composition.
 */
export function createHermes021MacosSubprocessStreamJsonHostV1(configurationValue: unknown,
  launch: Launch = (file, args, options) => spawn(file, [...args], options) as ChildProcessWithoutNullStreams,
  makeDirectory: MakeDirectory = mkdtemp,
  removeDirectory: RemoveDirectory = rm,
  saveFile: SaveFile = writeFile,
  now: () => number = Date.now): Hermes021MacosStreamJsonHostV1 {
  const configuration = Object.freeze(configurationSchema.parse(configurationValue));
  if (typeof launch !== "function" || typeof makeDirectory !== "function" || typeof removeDirectory !== "function"
    || typeof saveFile !== "function" || typeof now !== "function") unavailable();
  return Object.freeze({ async execute(input: Readonly<{
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
          child = launch("hermes", args, { shell: false, windowsHide: true, cwd: configuration.workingDirectory,
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
}
