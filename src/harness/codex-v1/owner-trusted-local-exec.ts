import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { types } from "node:util";

const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_AFTER_MS = 5_000;
const SYSTEM_PATH = "/usr/bin:/bin";

export type OwnerTrustedLocalCodexExecResultV1 = Readonly<
  | { status: "completed"; text: string; usage?: Readonly<{ inputTokens?: number; outputTokens?: number }> }
  | { status: "failed" | "canceled" | "timed_out" | "cleanup_uncertain"; reason: string }
>;

export type OwnerTrustedLocalCodexExecV1 = Readonly<{
  execute(input: Readonly<{
    executablePath: string;
    prompt: string;
    workingDirectory: string;
    deadlineMs: number;
    signal?: AbortSignal;
  }>): Promise<OwnerTrustedLocalCodexExecResultV1>;
}>;

type Spawn = (file: string, args: readonly string[], options: Readonly<{
  cwd: string; detached: true; shell: false; windowsHide: true;
  stdio: readonly ["pipe", "pipe", "pipe"]; env: Readonly<Record<string, string>>;
}>) => ChildProcess;
type ReadDirectory = (path: string) => Promise<readonly string[]>;

function failed(status: Exclude<OwnerTrustedLocalCodexExecResultV1["status"], "completed">, reason: string) {
  return Object.freeze({ status, reason }) as OwnerTrustedLocalCodexExecResultV1;
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && isAbsolute(value)
    && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeInput(input: unknown): input is Parameters<OwnerTrustedLocalCodexExecV1["execute"]>[0] {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).every(key => ["executablePath", "prompt", "workingDirectory", "deadlineMs", "signal"].includes(key))
    && safePath(value.executablePath) && safePath(value.workingDirectory)
    && typeof value.prompt === "string" && Buffer.byteLength(value.prompt, "utf8") <= MAX_PROMPT_BYTES
    && Number.isSafeInteger(value.deadlineMs) && value.deadlineMs >= 100 && value.deadlineMs <= 3_600_000
    && (value.signal === undefined || value.signal instanceof AbortSignal);
}

function processGroupSignal(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid || child.pid < 1) return false;
  try { process.kill(-child.pid, signal); return true; } catch { return false; }
}

function processGroupExists(child: ChildProcess): boolean {
  if (!child.pid || child.pid < 1) return false;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
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
    if (input.signal?.aborted) return failed("canceled", "aborted_before_spawn");
    try { if ((await list(input.workingDirectory)).length !== 0) return failed("failed", "working_directory_not_empty"); }
    catch { return failed("failed", "working_directory_unavailable"); }
    const args = Object.freeze(["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
      "--color", "never", "-C", input.workingDirectory, "-"]);
    let child: ChildProcess;
    try {
      child = launch(input.executablePath, args, { cwd: input.workingDirectory, detached: true, shell: false, windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"], env: Object.freeze({ HOME: process.env.HOME ?? "", PATH: SYSTEM_PATH,
          LANG: process.env.LANG ?? "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp" }) });
    } catch { return failed("failed", "spawn_refused"); }
    if (!child.stdin || !child.stdout || !child.stderr) return failed("cleanup_uncertain", "stdio_unavailable");
    return await new Promise<OwnerTrustedLocalCodexExecResultV1>(resolve => {
      let settled = false, bytes = 0, stdout = "", resultText: string | undefined, terminal = false;
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      let stop: "canceled" | "timed_out" | "failed" | undefined;
      let killer: ReturnType<typeof setTimeout> | undefined;
      let stopCleanupVerified = false;
      const decoder = new StringDecoder("utf8");
      const finish = (value: OwnerTrustedLocalCodexExecResultV1) => {
        if (settled) return;
        settled = true; clearTimeout(deadline); if (killer) clearTimeout(killer);
        input.signal?.removeEventListener("abort", cancel); resolve(value);
      };
      const terminate = (reason: "canceled" | "timed_out" | "failed") => {
        if (stop) {
          if (processGroupExists(child)) return;
          if (killer) clearTimeout(killer);
          if (stop === "canceled") return finish(failed("canceled", "aborted"));
          if (stop === "timed_out") return finish(failed("timed_out", "deadline_exceeded"));
          return finish(failed("failed", "process_or_output_refused"));
        }
        stop = reason;
        if (!processGroupSignal(child, "SIGTERM")) {
          finish(failed("cleanup_uncertain", "process_group_unavailable")); return;
        }
        killer = setTimeout(() => {
          stopCleanupVerified = processGroupSignal(child, "SIGKILL");
          if (!stopCleanupVerified) return finish(failed("cleanup_uncertain", "process_group_unavailable"));
          if (stop === "canceled") return finish(failed("canceled", "aborted"));
          if (stop === "timed_out") return finish(failed("timed_out", "deadline_exceeded"));
          return finish(failed("failed", "process_or_output_refused"));
        }, KILL_AFTER_MS);
      };
      const cancel = () => terminate("canceled");
      const receive = (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.byteLength; if (bytes > MAX_OUTPUT_BYTES) { terminate("failed"); return; }
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
      const receiveStderr = (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > MAX_OUTPUT_BYTES) terminate("failed"); };
      const deadline = setTimeout(() => terminate("timed_out"), input.deadlineMs);
      input.signal?.addEventListener("abort", cancel, { once: true });
      child.on("error", () => terminate("failed"));
      child.stdin.on("error", () => terminate("failed")); child.stdout.on("error", () => terminate("failed")); child.stderr.on("error", () => terminate("failed"));
      child.stdout.on("data", receive); child.stderr.on("data", receiveStderr);
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
        if (stop) return;
        if (code !== 0 || !terminal || resultText === undefined) return finish(failed("failed", "process_or_output_refused"));
        finish(Object.freeze({ status: "completed" as const, text: resultText, ...(usage ? { usage: Object.freeze(usage) } : {}) }));
      });
      try { child.stdin.end(input.prompt, "utf8"); } catch { terminate("failed"); }
    });
  } });
}
