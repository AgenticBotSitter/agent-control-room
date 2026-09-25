import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { types } from "node:util";
import { z } from "zod";

const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_AFTER_MS = 5_000;
const KILL_CONFIRM_MS = 50;
const SYSTEM_PATH = "/usr/bin:/bin";
const identifier = z.string().min(1).max(180).regex(/^[A-Za-z0-9._:/-]+$/u);
const terminal = z.object({
  type: z.literal("result"), session_id: z.string().min(1), exit_code: z.number().int(), text: z.string(),
  tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(), cache_read: z.number().int().nonnegative(), cache_write: z.number().int().nonnegative() }).strict(),
  duration_ms: z.number().int().nonnegative(), error: z.string().optional(), timestamp: z.number().int().nonnegative(),
}).strict();

/** Fixed controls; profile/model/provider come only from protected worker configuration. */
export const OWNER_TRUSTED_LOCAL_HERMES_FIXED_ARGS_V1 = Object.freeze([
  "chat", "--query-file", "-", "--oneshot", "--quiet", "--format", "stream-json",
  "--toolsets", "", "--ignore-rules", "--max-turns", "1", "--source", "control-room-local-worker",
] as const);

export type OwnerTrustedLocalHermesExecResultV1 = Readonly<
  | { status: "completed"; text: string; usage: Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }> }
  | { status: "failed" | "canceled" | "timed_out" | "cleanup_uncertain"; reason: string }
>;

export type OwnerTrustedLocalHermesExecV1 = Readonly<{ execute(input: Readonly<{
  executablePath: string; profile: string; model: string; provider: string;
  prompt: string; workingDirectory: string; deadlineMs: number; signal?: AbortSignal;
}>): Promise<OwnerTrustedLocalHermesExecResultV1> }>;

type Spawn = (file: string, args: readonly string[], options: Readonly<{
  cwd: string; detached: true; shell: false; windowsHide: true;
  stdio: readonly ["pipe", "pipe", "pipe"]; env: Readonly<Record<string, string>>;
}>) => ChildProcess;
type ReadDirectory = (path: string) => Promise<readonly string[]>;

function failed(status: Exclude<OwnerTrustedLocalHermesExecResultV1["status"], "completed">, reason: string) {
  return Object.freeze({ status, reason }) as OwnerTrustedLocalHermesExecResultV1;
}
function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && isAbsolute(value)
    && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
function safeInput(input: unknown): input is Parameters<OwnerTrustedLocalHermesExecV1["execute"]>[0] {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).every(key => ["executablePath", "profile", "model", "provider", "prompt", "workingDirectory", "deadlineMs", "signal"].includes(key))
    && safePath(value.executablePath) && safePath(value.workingDirectory)
    && [value.profile, value.model, value.provider].every(value => identifier.safeParse(value).success)
    && typeof value.prompt === "string" && Buffer.byteLength(value.prompt, "utf8") <= MAX_PROMPT_BYTES
    && typeof value.deadlineMs === "number" && Number.isSafeInteger(value.deadlineMs) && value.deadlineMs >= 100 && value.deadlineMs <= 3_600_000
    && (value.signal === undefined || value.signal instanceof AbortSignal);
}
function groupSignal(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid || child.pid < 1) return false;
  try { process.kill(-child.pid, signal); return true; } catch { return false; }
}
function groupExists(child: ChildProcess): boolean {
  if (!child.pid || child.pid < 1) return false;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
}

/**
 * One owner-trusted Hermes text task. It owns no queue, database, credentials,
 * model selection policy, retry, or result store. The caller supplies the
 * protected selected profile/model/provider after it holds the canonical task.
 */
export function createOwnerTrustedLocalHermesExecV1(dependencies: Readonly<{ spawn?: Spawn; readDirectory?: ReadDirectory }> = {}): OwnerTrustedLocalHermesExecV1 {
  const launch = dependencies.spawn ?? (spawn as unknown as Spawn);
  const list = dependencies.readDirectory ?? readdir;
  return Object.freeze({ async execute(input) {
    if (!safeInput(input)) return failed("failed", "invalid_input");
    if (input.signal?.aborted) return failed("canceled", "aborted_before_spawn");
    try { if ((await list(input.workingDirectory)).length !== 0) return failed("failed", "working_directory_not_empty"); }
    catch { return failed("failed", "working_directory_unavailable"); }
    if (input.signal?.aborted) return failed("canceled", "aborted_before_spawn");
    const seconds = Math.max(1, Math.ceil(input.deadlineMs / 1_000));
    const args = Object.freeze(["-p", input.profile, ...OWNER_TRUSTED_LOCAL_HERMES_FIXED_ARGS_V1,
      "--run-budget", String(seconds), "--in", input.workingDirectory, "--model", input.model, "--provider", input.provider]);
    let child: ChildProcess;
    try { child = launch(input.executablePath, args, { cwd: input.workingDirectory, detached: true, shell: false, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"], env: Object.freeze({ HOME: process.env.HOME ?? "", PATH: SYSTEM_PATH,
        LANG: process.env.LANG ?? "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp" }) }); }
    catch { return failed("failed", "spawn_refused"); }
    if (!child.stdin || !child.stdout || !child.stderr) { groupSignal(child, "SIGKILL"); return failed("cleanup_uncertain", "stdio_unavailable"); }
    return await new Promise<OwnerTrustedLocalHermesExecResultV1>(resolve => {
      let settled = false, bytes = 0, remainder = "", result: z.infer<typeof terminal> | undefined;
      let stop: "canceled" | "timed_out" | "failed" | undefined;
      let killer: ReturnType<typeof setTimeout> | undefined;
      const decoder = new StringDecoder("utf8");
      const final = (value: OwnerTrustedLocalHermesExecResultV1) => {
        if (settled) return; settled = true; clearTimeout(deadline); if (killer) clearTimeout(killer);
        input.signal?.removeEventListener("abort", cancel); resolve(value);
      };
      const stopped = () => stop === "canceled" ? failed("canceled", "aborted")
        : stop === "timed_out" ? failed("timed_out", "deadline_exceeded") : failed("failed", "process_or_output_refused");
      const terminate = (reason: "canceled" | "timed_out" | "failed") => {
        if (stop) { if (!groupExists(child)) final(stopped()); return; }
        stop = reason;
        if (!groupSignal(child, "SIGTERM")) return final(failed("cleanup_uncertain", "process_group_unavailable"));
        killer = setTimeout(() => {
          if (!groupSignal(child, "SIGKILL")) return final(failed("cleanup_uncertain", "process_group_unavailable"));
          killer = setTimeout(() => groupExists(child) ? final(failed("cleanup_uncertain", "process_group_still_running")) : final(stopped()), KILL_CONFIRM_MS);
        }, KILL_AFTER_MS);
      };
      const accept = (raw: string) => {
        if (raw.length === 0 || stop) return;
        const parsed = terminal.safeParse(JSON.parse(raw.endsWith("\r") ? raw.slice(0, -1) : raw));
        if (!parsed.success || result !== undefined || parsed.data.exit_code !== 0 || parsed.data.tokens.total < parsed.data.tokens.input + parsed.data.tokens.output)
          return terminate("failed");
        result = parsed.data;
      };
      const receive = (chunk: Buffer) => {
        if (settled) return; bytes += chunk.byteLength; if (bytes > MAX_OUTPUT_BYTES) return terminate("failed");
        remainder += decoder.write(chunk); const lines = remainder.split("\n"); remainder = lines.pop() ?? "";
        for (const line of lines) { try { accept(line); } catch { terminate("failed"); } }
      };
      const stderr = (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > MAX_OUTPUT_BYTES) terminate("failed"); };
      const cancel = () => terminate("canceled");
      const deadline = setTimeout(() => terminate("timed_out"), input.deadlineMs);
      input.signal?.addEventListener("abort", cancel, { once: true });
      child.on("error", () => terminate("failed")); child.stdin.on("error", () => terminate("failed"));
      child.stdout.on("error", () => terminate("failed")); child.stderr.on("error", () => terminate("failed"));
      child.stdout.on("data", receive); child.stderr.on("data", stderr);
      child.once("close", code => {
        const trailing = remainder + decoder.end(); if (trailing) { try { accept(trailing); } catch { stop = "failed"; } }
        if (stop) { if (!groupExists(child)) final(stopped()); return; }
        if (groupExists(child)) { stop = "failed"; if (!groupSignal(child, "SIGKILL")) return final(failed("cleanup_uncertain", "process_group_unavailable"));
          killer = setTimeout(() => groupExists(child) ? final(failed("cleanup_uncertain", "process_group_still_running")) : final(stopped()), KILL_CONFIRM_MS); return; }
        if (code !== 0 || !result) return final(failed("failed", "process_or_output_refused"));
        final(Object.freeze({ status: "completed" as const, text: result.text, usage: Object.freeze({ inputTokens: result.tokens.input,
          outputTokens: result.tokens.output, totalTokens: result.tokens.total }) }));
      });
      try { child.stdin.end(input.prompt, "utf8"); } catch { terminate("failed"); }
    });
  } });
}
