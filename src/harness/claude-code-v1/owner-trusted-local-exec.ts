import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { types } from "node:util";
import { userInfo } from "node:os";
import { createClaudeCodeStreamDecoderV1 } from "./stream-json-decode";
import { DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1, MAX_TASK_RUN_OUTPUT_BYTES,
  MIN_TASK_RUN_OUTPUT_BYTES, DEFAULT_TASK_RUN_RESOURCES_V1, captureMacLocalTaskRunResourcesV1,
  type MacLocalTaskRunResourcesV1 } from "../v1/owner-trusted-local-run-limits";
import { startTaskRunResourceSupervisorV1, taskRunResourceStopV1,
  type TaskRunResourceStopV1, type TaskRunResourceSupervisorV1 }
  from "../v1/owner-trusted-local-resource-supervisor";

const MAX_PROMPT_BYTES = 64 * 1024;
const KILL_AFTER_MS = 5_000;
const KILL_CONFIRM_MS = 50;
const SYSTEM_PATH = "/usr/bin:/bin";
const localUser = userInfo().username;

/** These are the Mac-local CLI arguments reviewed in Packet B. They are
 * intentionally separate from the legacy installed-admission arguments. */
// Sonnet is pinned because the CLI default is Opus, which spends the owner's limited
// Opus allowance on every task. Per-task model choice is W8.
export const OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1 = Object.freeze([
  "-p", "--model", "sonnet", "--output-format", "stream-json", "--verbose", "--tools", "",
  "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
  "--disable-slash-commands",
] as const);

export type OwnerTrustedLocalClaudeExecResultV1 = Readonly<
  | { status: "completed"; text: string; usageReported: boolean }
  | { status: "failed" | "canceled" | "timed_out" | "cleanup_uncertain" | "limit_exceeded"; reason: string;
      /** Present only when a resource limit stopped the run. */
      limit?: TaskRunResourceStopV1 }
>;

export type OwnerTrustedLocalClaudeExecV1 = Readonly<{
  execute(input: Readonly<{
    executablePath: string;
    prompt: string;
    workingDirectory: string;
    deadlineMs: number;
    outputBytes?: number;
    /** Per-run CPU and memory limits. Enforced by the supervisor; an
     * absent value falls back to the bounded defaults, never to none. */
    resources?: MacLocalTaskRunResourcesV1;
    model?: string;
    effort?: string;
    supportsEffort?: boolean;
    signal?: AbortSignal;
  }>): Promise<OwnerTrustedLocalClaudeExecResultV1>;
}>;

type Spawn = (file: string, args: readonly string[], options: Readonly<{
  cwd: string; detached: true; shell: false; windowsHide: true;
  stdio: ["pipe", "pipe", "pipe"]; env: Readonly<Record<string, string>>;
}>) => ChildProcess;
type ReadDirectory = (path: string) => Promise<readonly string[]>;

function failed(status: Exclude<OwnerTrustedLocalClaudeExecResultV1["status"], "completed">, reason: string,
  limit?: TaskRunResourceStopV1) {
  return Object.freeze(limit ? { status, reason, limit } : { status, reason }) as OwnerTrustedLocalClaudeExecResultV1;
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && isAbsolute(value)
    && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeInput(input: unknown): input is Parameters<OwnerTrustedLocalClaudeExecV1["execute"]>[0] {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).every(key => ["executablePath", "prompt", "workingDirectory", "deadlineMs", "outputBytes", "resources", "model", "effort", "supportsEffort", "signal"].includes(key))
    && safePath(value.executablePath) && safePath(value.workingDirectory)
    && typeof value.prompt === "string" && Buffer.byteLength(value.prompt, "utf8") <= MAX_PROMPT_BYTES
    && typeof value.deadlineMs === "number" && Number.isSafeInteger(value.deadlineMs)
    && value.deadlineMs >= 100 && value.deadlineMs <= 3_600_000
    && (value.outputBytes === undefined || typeof value.outputBytes === "number" && Number.isSafeInteger(value.outputBytes)
      && value.outputBytes >= MIN_TASK_RUN_OUTPUT_BYTES && value.outputBytes <= MAX_TASK_RUN_OUTPUT_BYTES)
    && (value.resources === undefined || safeResources(value.resources))
    && ((value.model === undefined && value.effort === undefined && value.supportsEffort === undefined)
      || typeof value.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/u.test(value.model)
        && typeof value.effort === "string" && /^(?:low|medium|high|max)$/u.test(value.effort)
        && typeof value.supportsEffort === "boolean")
    && (value.signal === undefined || value.signal instanceof AbortSignal);
}

function safeResources(value: unknown): value is MacLocalTaskRunResourcesV1 {
  try { captureMacLocalTaskRunResourcesV1(value); return true; } catch { return false; }
}

function processGroupSignal(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid || child.pid < 1) return false;
  try { process.kill(-child.pid, signal); return true; } catch { return false; }
}

function processGroupExists(child: ChildProcess): boolean {
  if (!child.pid || child.pid < 1) return false;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
}

/** Runs one owner-trusted, text-only Claude Code task. It has no task queue,
 * credential, tool, session-resume, or retry authority. Its caller must hold
 * the canonical delivery claim before invoking it. */
export function createOwnerTrustedLocalClaudeExecV1(dependencies: Readonly<{ spawn?: Spawn; readDirectory?: ReadDirectory }> = {}): OwnerTrustedLocalClaudeExecV1 {
  const launch = dependencies.spawn ?? (spawn as unknown as Spawn);
  const list = dependencies.readDirectory ?? readdir;
  return Object.freeze({ async execute(input) {
    if (!safeInput(input)) return failed("failed", "invalid_input");
    const outputBytes = input.outputBytes ?? DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1.outputBytes;
    if (input.signal?.aborted) return failed("canceled", "aborted_before_spawn");
    // The configured worker directory is persistent across tasks. Listing it
    // is an accessibility check only; prior task output must not disable the
    // worker for every later assignment.
    try { await list(input.workingDirectory); }
    catch { return failed("failed", "working_directory_unavailable"); }
    // A cancellation can arrive while the asynchronous directory check is in
    // flight. Re-check it before the process boundary, not just before I/O.
    if (input.signal?.aborted) return failed("canceled", "aborted_before_spawn");
    let child: ChildProcess;
    try {
      const args = input.model === undefined ? OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1 : Object.freeze([
        "-p", "--model", input.model, ...(input.supportsEffort ? ["--effort", input.effort!] : []),
        ...OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1.slice(3),
      ]);
      child = launch(input.executablePath, args, {
        cwd: input.workingDirectory, detached: true, shell: false, windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"], env: Object.freeze({ HOME: process.env.HOME ?? "", PATH: SYSTEM_PATH,
          LANG: process.env.LANG ?? "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp",
          // The CLI finds the owner's sign-in in the login Keychain by account name.
          USER: localUser, LOGNAME: localUser }),
      });
    } catch { return failed("failed", "spawn_refused"); }
    if (!child.stdin || !child.stdout || !child.stderr) {
      processGroupSignal(child, "SIGKILL");
      return failed("cleanup_uncertain", "stdio_unavailable");
    }
    const stdin = child.stdin, stdout = child.stdout, stderr = child.stderr;
    return await new Promise<OwnerTrustedLocalClaudeExecResultV1>(resolve => {
      const decoder = createClaudeCodeStreamDecoderV1();
      let settled = false, bytes = 0, remainder = "", terminalText: string | undefined, usageReported = false;
      let stop: "canceled" | "timed_out" | "failed" | undefined;
      let killer: ReturnType<typeof setTimeout> | undefined;
      let supervisor: TaskRunResourceSupervisorV1 | undefined;
      let resourceStop: TaskRunResourceStopV1 | undefined;
      const utf8 = new StringDecoder("utf8");
      const finish = (value: OwnerTrustedLocalClaudeExecResultV1) => {
        if (settled) return;
        settled = true; clearTimeout(deadline); if (killer) clearTimeout(killer);
        supervisor?.close();
        input.signal?.removeEventListener("abort", cancel); resolve(value);
      };
      const stopped = () => resourceStop ? failed("limit_exceeded", resourceStop.reason, resourceStop)
        : stop === "canceled" ? failed("canceled", "aborted")
          : stop === "timed_out" ? failed("timed_out", "deadline_exceeded")
            : failed("failed", "process_or_output_refused");
      const terminate = (reason: "canceled" | "timed_out" | "failed") => {
        if (stop) {
          if (!processGroupExists(child)) { if (killer) clearTimeout(killer); finish(stopped()); }
          return;
        }
        stop = reason;
        if (!processGroupSignal(child, "SIGTERM")) return finish(failed("cleanup_uncertain", "process_group_unavailable"));
        killer = setTimeout(() => {
          if (!processGroupSignal(child, "SIGKILL")) return finish(failed("cleanup_uncertain", "process_group_unavailable"));
          // Sending KILL is not evidence that a detached child group is gone.
          // Confirm absence before reporting a normal cancellation or timeout.
          killer = setTimeout(() => processGroupExists(child)
            ? finish(failed("cleanup_uncertain", "process_group_still_running"))
            : finish(stopped()), KILL_CONFIRM_MS);
        }, KILL_AFTER_MS);
      };
      const acceptLine = (raw: string) => {
        if (raw.length === 0 || stop) return;
        const frame = decoder.accept(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
        if (frame.kind === "decode_error") return terminate("failed");
        if (frame.kind === "result") {
          if (frame.outcome !== "succeeded" || frame.resultText === undefined) return terminate("failed");
          terminalText = frame.resultText; usageReported = frame.usageReported;
        }
      };
      const receive = (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.byteLength; if (bytes > outputBytes) return terminate("failed");
        remainder += utf8.write(chunk);
        const lines = remainder.split("\n"); remainder = lines.pop() ?? "";
        for (const line of lines) acceptLine(line);
      };
      const receiveStderr = (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > outputBytes) terminate("failed"); };
      const cancel = () => terminate("canceled");
      const deadline = setTimeout(() => terminate("timed_out"), input.deadlineMs);
      // Enforced per-run CPU and memory limits. The supervisor is the
      // authority: macOS setrlimit is advisory (a child that catches
      // SIGXCPU outlives both the soft and hard limit), so the run is
      // stopped here and the breach recorded. It escalates through this
      // executor's own terminate, keeping one cleanup acknowledgement.
      try { supervisor = startTaskRunResourceSupervisorV1(child,
        captureMacLocalTaskRunResourcesV1(input.resources ?? DEFAULT_TASK_RUN_RESOURCES_V1),
        breach => { resourceStop = taskRunResourceStopV1(breach); terminate("failed"); }); }
      catch { resourceStop = taskRunResourceStopV1({ limit: "cpu_time", cause: "measurement_unavailable",
        measuredCpuTimeMs: 0, measuredResidentBytes: 0, limitCpuTimeMs: input.deadlineMs,
        limitResidentBytes: 0 }); terminate("failed"); }
      input.signal?.addEventListener("abort", cancel, { once: true });
      // Cover the interval between the pre-spawn recheck and listener setup.
      if (input.signal?.aborted) { cancel(); return; }
      child.on("error", () => terminate("failed"));
      stdin.on("error", () => terminate("failed")); stdout.on("error", () => terminate("failed")); stderr.on("error", () => terminate("failed"));
      stdout.on("data", receive); stderr.on("data", receiveStderr);
      child.once("close", code => {
        const trailing = remainder + utf8.end();
        if (trailing) acceptLine(trailing);
        if (stop) { if (!processGroupExists(child)) finish(stopped()); return; }
        // A detached direct child can exit while it leaves a descendant in the
        // same process group. Never call that a completed or failed task while
        // the descendant can keep running.
        if (processGroupExists(child)) {
          stop = "failed";
          if (!processGroupSignal(child, "SIGKILL")) return finish(failed("cleanup_uncertain", "process_group_unavailable"));
          killer = setTimeout(() => processGroupExists(child)
            ? finish(failed("cleanup_uncertain", "process_group_still_running"))
            : finish(stopped()), KILL_CONFIRM_MS);
          return;
        }
        if (code !== 0 || decoder.state().failed || !decoder.state().terminalObserved || terminalText === undefined)
          return finish(failed("failed", "process_or_output_refused"));
        finish(Object.freeze({ status: "completed" as const, text: terminalText, usageReported }));
      });
      try { stdin.end(input.prompt, "utf8"); } catch { terminate("failed"); }
    });
  } });
}
