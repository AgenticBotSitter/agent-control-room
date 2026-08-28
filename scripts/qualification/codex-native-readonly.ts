import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";

const EXECUTABLE = "/Applications/ChatGPT.app/Contents/Resources/codex";
const USER_HOME = homedir();
const SOURCE_CODEX_HOME = join(USER_HOME, ".codex");
const WORKSPACE_PARENT = "/private/tmp";
const MAX_CALLS = 3;
const CALL_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 5 * 60_000;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const BLOCKED = "CR7B_AUTH_BLOCKED";
const READABLE = "CR7B_AUTH_READABLE";

type JsonRecord = Record<string, unknown>;

interface CallEvidence {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  signalSent: boolean;
  timedOut: boolean;
  eventTypes: Record<string, number>;
  itemTypes: Record<string, number>;
  threadId?: string;
  finalTextDigest?: string;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number };
  marker: "blocked" | "readable" | "absent";
}

const startedAt = Date.now();
let calls = 0;
let profileRoot = "";
let workspaceRoot = "";
let profileRemoved = false;
let workspaceRemoved = false;
let activeChild: ChildProcess | undefined;

if (!process.argv.includes("--execute-authorized-attempt")) {
  process.stdout.write(`${JSON.stringify({ schema: "control-room.codex-native-qualification/v1", status: "blocked", reasonCode: "explicit_authorization_flag_required" }, null, 2)}\n`);
  process.exit(2);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void stopActiveChild().then(cleanup).finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); });
}

try {
  await verifySourceCredential();
  profileRoot = await mkdtemp(join(SOURCE_CODEX_HOME, ".cr7b-native-"));
  await chmod(profileRoot, 0o700);
  await copyFile(join(SOURCE_CODEX_HOME, "auth.json"), join(profileRoot, "auth.json"), constants.COPYFILE_EXCL);
  await chmod(join(profileRoot, "auth.json"), 0o600);

  workspaceRoot = await mkdtemp(join(WORKSPACE_PARENT, "control-room-cr7b-"));
  await chmod(workspaceRoot, 0o700);
  await runLocal("/usr/bin/git", ["init", "--quiet", workspaceRoot]);

  const start = await runCodex({
    prompt: `Run exactly one shell command: if test -r "$CODEX_HOME/auth.json"; then printf ${READABLE}; else printf ${BLOCKED}; fi. Do not read or print file contents. Do not use any other tool. Then reply with exactly the marker printed by that command.`,
  });
  const authIsolation = start.marker;
  if (authIsolation !== "blocked" || !start.threadId) throw new Error(authIsolation === "readable" ? "credential_boundary_failed" : "credential_boundary_indeterminate");

  const resume = await runCodex({
    resumeThreadId: start.threadId,
    prompt: "Do not run commands or use tools. Reply with exactly CR7B_RESUME_OK.",
  });
  const cancel = await runCodex({
    prompt: "Do not run commands or use tools. Silently reason about the first 100 prime numbers, then reply with exactly CR7B_CANCEL_SHOULD_NOT_COMPLETE.",
    cancelAtTurnStart: true,
  });

  const status = await runLocal("/usr/bin/git", ["-C", workspaceRoot, "status", "--porcelain"]);
  if (status.stdout.length !== 0) throw new Error("workspace_mutated");
  if (calls !== MAX_CALLS) throw new Error("call_count_mismatch");
  if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) throw new Error("qualification_deadline_exceeded");
  if (resume.threadId && resume.threadId !== start.threadId) throw new Error("resume_thread_mismatch");
  if ((resume.itemTypes.command_execution ?? 0) !== 0 || (resume.itemTypes.mcp_tool_call ?? 0) !== 0 || (resume.itemTypes.file_change ?? 0) !== 0) throw new Error("resume_scope_drift");
  if (!cancel.signalSent || cancel.exitCode === 0 || (cancel.eventTypes["turn.completed"] ?? 0) !== 0) throw new Error("cancel_not_confirmed");

  const summary = {
    schema: "control-room.codex-native-qualification/v1",
    status: "passed",
    executableVersion: "0.150.0-alpha.8",
    macosCodeDirectoryHash: "33f71aee6d3f281e0a63630b6f7d41659834e260",
    sandbox: "read-only",
    ignoredUserConfig: true,
    ignoredRules: true,
    mcpConfigured: false,
    calls,
    authIsolation: "blocked",
    start: summarize(start),
    resume: { ...summarize(resume), explicitThreadId: true, sameThread: !resume.threadId || resume.threadId === start.threadId },
    cancel: summarize(cancel),
    workspaceClean: true,
  };
  await cleanup();
  process.stdout.write(`${JSON.stringify({ ...summary, profileRemoved, workspaceRemoved }, null, 2)}\n`);
} catch (error) {
  await cleanup();
  const reasonCode = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "qualification_failed";
  process.stdout.write(`${JSON.stringify({ schema: "control-room.codex-native-qualification/v1", status: "failed", reasonCode, calls, profileRemoved, workspaceRemoved }, null, 2)}\n`);
  process.exitCode = 1;
}

async function verifySourceCredential(): Promise<void> {
  const sourceHome = await realpath(SOURCE_CODEX_HOME);
  if (sourceHome !== SOURCE_CODEX_HOME) throw new Error("source_profile_not_canonical");
  const auth = await lstat(join(sourceHome, "auth.json"));
  if (!auth.isFile() || auth.isSymbolicLink() || (auth.mode & 0o077) !== 0) throw new Error("source_credential_permissions_invalid");
}

async function runCodex(input: { prompt: string; resumeThreadId?: string; cancelAtTurnStart?: boolean }): Promise<CallEvidence> {
  calls += 1;
  if (calls > MAX_CALLS || Date.now() - startedAt >= TOTAL_TIMEOUT_MS) throw new Error("qualification_budget_exceeded");
  const common = ["exec", "--json", "--color", "never", "--strict-config", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--cd", workspaceRoot, "--thread-source", "control-room-harness", "--model", "gpt-5.6-sol"];
  const args = input.resumeThreadId ? [...common, "resume", input.resumeThreadId, "-"] : [...common, "-"];
  const child = spawn(EXECUTABLE, args, {
    cwd: workspaceRoot,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: USER_HOME, CODEX_HOME: profileRoot, TMPDIR: WORKSPACE_PARENT, LANG: "en_US.UTF-8", CI: "true", NODE_ENV: "production" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  activeChild = child;
  child.stdin.end(input.prompt);

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutBuffer = "";
  const frames: JsonRecord[] = [];
  let streamInvalid = false;
  let signalSent = false;
  let timedOut = false;
  let hardKill: NodeJS.Timeout | undefined;
  const sendSignal = () => {
    if (signalSent || child.exitCode !== null || child.signalCode !== null) return;
    signalSent = child.kill("SIGINT");
    hardKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
  };
  const timeout = setTimeout(() => { timedOut = true; sendSignal(); }, CALL_TIMEOUT_MS);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > MAX_STREAM_BYTES) { sendSignal(); return; }
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) {
        try {
          const frame = parseFrame(line);
          frames.push(frame);
          if (input.cancelAtTurnStart && frame.type === "turn.started") sendSignal();
        } catch { streamInvalid = true; sendSignal(); }
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > MAX_STREAM_BYTES) sendSignal();
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.once("error", () => reject(new Error("codex_spawn_failed")));
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  activeChild = undefined;
  clearTimeout(timeout);
  if (hardKill) clearTimeout(hardKill);
  if (stdoutBuffer.trim()) {
    try { frames.push(parseFrame(stdoutBuffer.trim())); } catch { streamInvalid = true; }
  }
  if (streamInvalid) throw new Error("invalid_jsonl");
  return evidence(frames, outcome.code, outcome.signal, signalSent, timedOut);
}

function parseFrame(line: string): JsonRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error("invalid_jsonl"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_jsonl");
  return parsed as JsonRecord;
}

function evidence(frames: JsonRecord[], exitCode: number | null, signal: NodeJS.Signals | null, signalSent: boolean, timedOut: boolean): CallEvidence {
  const eventTypes: Record<string, number> = {};
  const itemTypes: Record<string, number> = {};
  let threadId: string | undefined;
  let finalText: string | undefined;
  let marker: CallEvidence["marker"] = "absent";
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
  for (const frame of frames) {
    const type = typeof frame.type === "string" ? frame.type : "invalid";
    eventTypes[type] = (eventTypes[type] ?? 0) + 1;
    if (type === "thread.started" && typeof frame.thread_id === "string") threadId = frame.thread_id;
    const item = frame.item && typeof frame.item === "object" && !Array.isArray(frame.item) ? frame.item as JsonRecord : undefined;
    if (item && typeof item.type === "string") {
      itemTypes[item.type] = (itemTypes[item.type] ?? 0) + 1;
      if (item.type === "agent_message" && typeof item.text === "string") finalText = item.text;
    }
    const serialized = JSON.stringify(frame);
    if (serialized.includes(READABLE)) marker = "readable";
    else if (serialized.includes(BLOCKED) && marker !== "readable") marker = "blocked";
    const rawUsage = frame.usage && typeof frame.usage === "object" && !Array.isArray(frame.usage) ? frame.usage as JsonRecord : undefined;
    if (rawUsage) {
      usage.inputTokens += safeCount(rawUsage.input_tokens);
      usage.outputTokens += safeCount(rawUsage.output_tokens);
      usage.cachedInputTokens += safeCount(rawUsage.cached_input_tokens);
      usage.reasoningTokens += safeCount(rawUsage.reasoning_output_tokens);
    }
  }
  return { exitCode, signal, signalSent, timedOut, eventTypes, itemTypes, ...(threadId ? { threadId } : {}), ...(finalText ? { finalTextDigest: digest(finalText) } : {}), usage, marker };
}

function summarize(call: CallEvidence) {
  return {
    exitCode: call.exitCode,
    signal: call.signal,
    signalSent: call.signalSent,
    timedOut: call.timedOut,
    eventTypes: call.eventTypes,
    itemTypes: call.itemTypes,
    nativeThreadKeyDigest: call.threadId ? digest(call.threadId) : undefined,
    finalTextDigest: call.finalTextDigest,
    usage: call.usage,
  };
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function runLocal(executable: string, args: string[]): Promise<{ stdout: string }> {
  const child = spawn(executable, args, { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: USER_HOME, LANG: "en_US.UTF-8", NODE_ENV: "production" }, stdio: ["ignore", "pipe", "ignore"], shell: false });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; if (Buffer.byteLength(stdout) > 65_536) child.kill("SIGKILL"); });
  const code = await new Promise<number | null>((resolvePromise, reject) => { child.once("error", reject); child.once("close", resolvePromise); });
  if (code !== 0) throw new Error("local_preparation_failed");
  return { stdout };
}

async function cleanup(): Promise<void> {
  if (workspaceRoot) {
    assertDisposable(workspaceRoot, join(WORKSPACE_PARENT, "control-room-cr7b-"));
    await rm(workspaceRoot, { recursive: true, force: false }).catch(() => undefined);
    workspaceRemoved = await missing(workspaceRoot);
  }
  if (profileRoot) {
    assertDisposable(profileRoot, join(SOURCE_CODEX_HOME, ".cr7b-native-"));
    await rm(profileRoot, { recursive: true, force: false }).catch(() => undefined);
    profileRemoved = await missing(profileRoot);
  }
}

async function stopActiveChild(): Promise<void> {
  const child = activeChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 2_000);
    child.once("close", () => { clearTimeout(timer); resolvePromise(); });
    child.kill("SIGKILL");
  });
  activeChild = undefined;
}

function assertDisposable(path: string, prefix: string): void {
  const resolved = resolve(path);
  if (!resolved.startsWith(prefix) || resolved === SOURCE_CODEX_HOME || resolved === WORKSPACE_PARENT || resolved.split(sep).length < 4) throw new Error("cleanup_target_invalid");
}

async function missing(path: string): Promise<boolean> {
  try { await access(path); return false; } catch { return true; }
}
