import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { types } from "node:util";
import { DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1, MAX_TASK_RUN_OUTPUT_BYTES,
  MIN_TASK_RUN_OUTPUT_BYTES, DEFAULT_TASK_RUN_RESOURCES_V1, captureMacLocalTaskRunResourcesV1,
  type MacLocalTaskRunResourcesV1 } from "../v1/owner-trusted-local-run-limits";
import { startTaskRunResourceSupervisorV1, taskRunResourceStopV1,
  type TaskRunResourceStopV1, type TaskRunResourceSupervisorV1 }
  from "../v1/owner-trusted-local-resource-supervisor";

const MAX_PROMPT_BYTES = 64 * 1024;
const KILL_AFTER_MS = 5_000;
// A SIGKILLed tree is torn down by the kernel, and on a loaded machine that
// takes far longer than one short wait, so the confirm after a kill is a
// polled budget rather than a single check. See awaitGroupAbsent below.
const KILL_CONFIRM_BUDGET_MS = 2_000;
const KILL_CONFIRM_STEP_MS = 25;
const SYSTEM_PATH = "/usr/bin:/bin";

export type OwnerTrustedLocalCodexExecResultV1 = Readonly<
  | { status: "completed"; text: string; usage?: Readonly<{ inputTokens?: number; outputTokens?: number }> }
  | { status: "failed" | "canceled" | "timed_out" | "cleanup_uncertain" | "limit_exceeded"; reason: string;
      /** Present only when a resource limit stopped the run. */
      limit?: TaskRunResourceStopV1 }
>;

export type OwnerTrustedLocalCodexExecV1 = Readonly<{
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
    signal?: AbortSignal;
  }>): Promise<OwnerTrustedLocalCodexExecResultV1>;
}>;

type Spawn = (file: string, args: readonly string[], options: Readonly<{
  cwd: string; detached: true; shell: false; windowsHide: true;
  stdio: ["pipe", "pipe", "pipe"]; env: Readonly<Record<string, string>>;
}>) => ChildProcess;
type ReadDirectory = (path: string) => Promise<readonly string[]>;

function failed(status: Exclude<OwnerTrustedLocalCodexExecResultV1["status"], "completed">, reason: string,
  limit?: TaskRunResourceStopV1) {
  return Object.freeze(limit ? { status, reason, limit } : { status, reason }) as OwnerTrustedLocalCodexExecResultV1;
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && isAbsolute(value)
    && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeInput(input: unknown): input is Parameters<OwnerTrustedLocalCodexExecV1["execute"]>[0] {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).every(key => ["executablePath", "prompt", "workingDirectory", "deadlineMs", "outputBytes", "resources", "model", "effort", "signal"].includes(key))
    && safePath(value.executablePath) && safePath(value.workingDirectory)
    && typeof value.prompt === "string" && Buffer.byteLength(value.prompt, "utf8") <= MAX_PROMPT_BYTES
    && typeof value.deadlineMs === "number" && Number.isSafeInteger(value.deadlineMs)
    && value.deadlineMs >= 100 && value.deadlineMs <= 3_600_000
    && (value.outputBytes === undefined || typeof value.outputBytes === "number" && Number.isSafeInteger(value.outputBytes)
      && value.outputBytes >= MIN_TASK_RUN_OUTPUT_BYTES && value.outputBytes <= MAX_TASK_RUN_OUTPUT_BYTES)
    && (value.resources === undefined || safeResources(value.resources))
    && ((value.model === undefined && value.effort === undefined)
      || typeof value.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/u.test(value.model)
        && typeof value.effort === "string" && /^(?:low|medium|high|xhigh|max)$/u.test(value.effort))
    && (value.signal === undefined || value.signal instanceof AbortSignal);
}

function safeResources(value: unknown): value is MacLocalTaskRunResourcesV1 {
  try { captureMacLocalTaskRunResourcesV1(value); return true; } catch { return false; }
}

function processGroupSignal(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid || child.pid < 1) return false;
  try { process.kill(-child.pid, signal); return true; } catch { return false; }
}

/** Waits for the run's whole process group to be absent, then reports which way
 * it went.
 *
 * A SIGKILLed process tree is torn down by the kernel, and on a loaded machine
 * that takes far longer than one short wait. Checking once after a fixed 50 ms
 * reported `cleanup_uncertain` for a group the kernel had not finished reaping,
 * and discarded the measured stop record with it; Linux CI caught exactly that.
 * Only a group still present after the whole budget really is still running,
 * which is what `cleanup_uncertain` is meant to mean. The group is signalled
 * exactly as before and must still be absent before the run is reported, so
 * this waits for the teardown rather than weakening the guarantee. */
function awaitGroupAbsent(child: ChildProcess, schedule: (fn: () => void, ms: number) => void,
  onAbsent: () => void, onStillRunning: () => void): void {
  const deadline = Date.now() + KILL_CONFIRM_BUDGET_MS;
  const check = () => {
    if (!processGroupExists(child)) { onAbsent(); return; }
    if (Date.now() >= deadline) { onStillRunning(); return; }
    schedule(check, KILL_CONFIRM_STEP_MS);
  };
  check();
}

function processGroupExists(child: ChildProcess): boolean {
  if (!child.pid || child.pid < 1) return false;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
}
/** Signals the owned group, and reports whether the group was still there to receive it.
 *
 * A process group disappears between the decision to stop a task and the signal reaching it — the
 * child can exit on its own, or in response to whatever tripped the stop. `kill` then fails with
 * ESRCH, which is the outcome the caller wanted rather than an uncertainty about cleanup: there
 * is nothing left to clean up. EPERM is the genuine uncertainty, because the group exists and
 * this account may not signal it. */
function processGroupStop(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid || child.pid < 1) return false;
  try { process.kill(-child.pid, signal); return true; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : !processGroupExists(child);
  }
}

function parseLine(line: string): { kind: "message"; text: string } | { kind: "complete"; usage?: { inputTokens?: number; outputTokens?: number } } | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("malformed_jsonl"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("malformed_jsonl");
  const record = value as Record<string, unknown>;
  if (record.type === "item.completed") {
    const item = record.item;
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof (item as Record<string, unknown>).type !== "string")
      throw new Error("malformed_jsonl");
    if ((item as Record<string, unknown>).type === "agent_message") {
      if (typeof (item as Record<string, unknown>).text !== "string") throw new Error("malformed_jsonl");
      return { kind: "message", text: (item as Record<string, string>).text };
    }
    // Read-only Codex may emit a completed reasoning item before the final
    // message. It is not result text and does not grant any extra capability.
    if ((item as Record<string, unknown>).type === "reasoning") return undefined;
    throw new Error("malformed_jsonl");
  }
  if (record.type === "turn.completed") {
    const usage = record.usage;
    if (usage === undefined) return { kind: "complete" };
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("malformed_jsonl");
    const raw = usage as Record<string, unknown>;
    const inputTokens = typeof raw.input_tokens === "number" && Number.isSafeInteger(raw.input_tokens) && raw.input_tokens >= 0
      ? raw.input_tokens : undefined;
    const outputTokens = typeof raw.output_tokens === "number" && Number.isSafeInteger(raw.output_tokens) && raw.output_tokens >= 0
      ? raw.output_tokens : undefined;
    return { kind: "complete", ...(inputTokens === undefined && outputTokens === undefined ? {} : { usage: { inputTokens, outputTokens } }) };
  }
  if (typeof record.type !== "string") throw new Error("malformed_jsonl");
  return undefined;
}

/** Owner-trusted local text execution only. This is an adapter, not queue or
 * lifecycle authority; its caller must already hold the canonical delivery claim. */
export function createOwnerTrustedLocalCodexExecV1(dependencies: Readonly<{ spawn?: Spawn; readDirectory?: ReadDirectory }> = {}): OwnerTrustedLocalCodexExecV1 {
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
    // Directory inspection is asynchronous. A cancellation that arrives while
    // it is in flight must fence the process boundary, not merely the earlier
    // input validation.
    if (input.signal?.aborted) return failed("canceled", "aborted_before_spawn");
    const args = Object.freeze(["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
      "--color", "never", "-C", input.workingDirectory,
      ...(input.model ? ["-m", input.model, "-c", `model_reasoning_effort=${input.effort}`] : []), "-"]);
    let child: ChildProcess;
    try {
      child = launch(input.executablePath, args, { cwd: input.workingDirectory, detached: true, shell: false, windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"], env: Object.freeze({ HOME: process.env.HOME ?? "", PATH: SYSTEM_PATH,
          LANG: process.env.LANG ?? "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp" }) });
    } catch { return failed("failed", "spawn_refused"); }
    if (!child.stdin || !child.stdout || !child.stderr) {
      // A process may already exist even when the expected streams were not
      // supplied. Never leave that detached process running merely because we
      // cannot observe its output.
      processGroupSignal(child, "SIGKILL");
      return failed("cleanup_uncertain", "stdio_unavailable");
    }
    const stdin = child.stdin, stdoutStream = child.stdout, stderrStream = child.stderr;
    return await new Promise<OwnerTrustedLocalCodexExecResultV1>(resolve => {
      let settled = false, bytes = 0, stdout = "", resultText: string | undefined, terminal = false;
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      let stop: "canceled" | "timed_out" | "failed" | undefined;
      let killer: ReturnType<typeof setTimeout> | undefined;
      let supervisor: TaskRunResourceSupervisorV1 | undefined;
      let resourceStop: TaskRunResourceStopV1 | undefined;
      const decoder = new StringDecoder("utf8");
      const finish = (value: OwnerTrustedLocalCodexExecResultV1) => {
        if (settled) return;
        settled = true; clearTimeout(deadline); if (killer) clearTimeout(killer);
        supervisor?.close();
        input.signal?.removeEventListener("abort", cancel); resolve(value);
      };
      const stoppedResult = () => resourceStop
        ? failed("limit_exceeded", resourceStop.reason, resourceStop)
        : stop === "canceled" ? failed("canceled", "aborted")
          : stop === "timed_out" ? failed("timed_out", "deadline_exceeded")
            : failed("failed", "process_or_output_refused");
      const terminate = (reason: "canceled" | "timed_out" | "failed") => {
        if (stop) {
          if (processGroupExists(child)) return;
          if (killer) clearTimeout(killer);
          return finish(stoppedResult());
        }
        stop = reason;
        // An already-exited group is a completed stop, not an uncertain one.
        if (!processGroupStop(child, "SIGTERM")) {
          if (!processGroupExists(child)) { if (killer) clearTimeout(killer); finish(stoppedResult()); }
          else finish(failed("cleanup_uncertain", "process_group_unavailable"));
          return;
        }
        killer = setTimeout(() => {
          if (!processGroupStop(child, "SIGKILL")) {
            if (!processGroupExists(child)) { finish(stoppedResult()); return; }
            finish(failed("cleanup_uncertain", "process_group_unavailable"));
            return;
          }
          // KILL is an instruction, not proof that detached descendants are
          // gone. Confirm the whole process group before reporting a normal
          // cancellation, timeout, or malformed-output failure.
          awaitGroupAbsent(child, (fn, ms) => { killer = setTimeout(fn, ms); },
            () => finish(stoppedResult()), () => finish(failed("cleanup_uncertain", "process_group_still_running")));
        }, KILL_AFTER_MS);
      };
      const cancel = () => terminate("canceled");
      const receive = (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.byteLength; if (bytes > outputBytes) { terminate("failed"); return; }
        stdout += decoder.write(chunk);
        const lines = stdout.split("\n"); stdout = lines.pop() ?? "";
        for (const raw of lines) {
          if (raw.length === 0) continue;
          try {
            const frame = parseLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
            if (!frame) continue;
            if (frame.kind === "message") resultText = frame.text;
            else { terminal = true; usage = frame.usage; }
          } catch { terminate("failed"); }
        }
      };
      const receiveStderr = (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > outputBytes) terminate("failed"); };
      const deadline = setTimeout(() => terminate("timed_out"), input.deadlineMs);
      // Enforced per-run CPU and memory limits. The supervisor is the
      // authority: macOS setrlimit is advisory (a child that catches
      // SIGXCPU outlives both the soft and hard limit), so the run is
      // stopped here and the breach recorded. It escalates through this
      // executor's own terminate, keeping one cleanup acknowledgement.
      const resources = captureMacLocalTaskRunResourcesV1(input.resources ?? DEFAULT_TASK_RUN_RESOURCES_V1);
      try { supervisor = startTaskRunResourceSupervisorV1(child, resources,
        breach => { resourceStop = taskRunResourceStopV1(breach); terminate("failed"); }); }
      // The supervisor could not even be started, so the run is stopped with
      // no limit named and the CONFIGURED pair recorded, never the wall-clock
      // deadline, which is a different bound and would misreport the record.
      catch { resourceStop = taskRunResourceStopV1({ limit: "unknown", cause: "measurement_unavailable",
        measuredCpuTimeMs: 0, measuredResidentBytes: 0, limitCpuTimeMs: resources.cpuTimeMs,
        limitResidentBytes: resources.maxResidentBytes }); terminate("failed"); }
      input.signal?.addEventListener("abort", cancel, { once: true });
      child.on("error", () => terminate("failed"));
      stdin.on("error", () => terminate("failed")); stdoutStream.on("error", () => terminate("failed")); stderrStream.on("error", () => terminate("failed"));
      stdoutStream.on("data", receive); stderrStream.on("data", receiveStderr);
      child.once("close", code => {
        if (stdout.length) {
          try {
            const frame = parseLine(stdout);
            if (frame?.kind === "message") resultText = frame.text;
            if (frame?.kind === "complete") { terminal = true; usage = frame.usage; }
          } catch { stop = "failed"; }
        }
        // A detached process may have children which ignore TERM. Do not claim
        // cleanup merely because the direct parent closed; the KILL timer above
        // is the bounded process-group cleanup acknowledgement.
        // The direct child is gone. If its detached group is gone too, TERM
        // was sufficient and we can return immediately. A surviving child
        // remains owned by the deadline KILL timer below.
        if (stop) {
          if (processGroupExists(child)) return;
          return finish(stoppedResult());
        }
        // A direct CLI process can exit while a detached descendant remains.
        // Never call a task completed until that owned group is absent.
        if (processGroupExists(child)) {
          stop = "failed";
          // The group was just observed alive, so a failed signal here is a genuine uncertainty
          // rather than a race with an exit: nothing has closed the window between the check and
          // the signal the way there is in `terminate`.
          if (!processGroupSignal(child, "SIGKILL")) return finish(failed("cleanup_uncertain", "process_group_unavailable"));
          awaitGroupAbsent(child, (fn, ms) => { killer = setTimeout(fn, ms); },
            () => finish(stoppedResult()), () => finish(failed("cleanup_uncertain", "process_group_still_running")));
          return;
        }
        if (code !== 0 || !terminal || resultText === undefined) return finish(failed("failed", "process_or_output_refused"));
        finish(Object.freeze({ status: "completed" as const, text: resultText, ...(usage ? { usage: Object.freeze(usage) } : {}) }));
      });
      try { stdin.end(input.prompt, "utf8"); } catch { terminate("failed"); }
    });
  } });
}
