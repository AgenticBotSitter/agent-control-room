import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOwnerTrustedLocalClaudeExecV1, OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1 } from "../src/harness/claude-code-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalClaudeExecutionAdapterV1 } from "../src/harness/v1/owner-trusted-local-cli-execution";

const root = await mkdtemp(join(tmpdir(), "acr-claude-exec-"));
const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-owner-trusted-local-exec-fake.mjs");
const executable = process.execPath;
async function taskDirectory() { return await mkdtemp(join(root, "task-")); }
function adapter(capture?: { file?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }) {
  return createOwnerTrustedLocalClaudeExecV1({ spawn: (file, args, options) => {
    if (capture) { capture.file = file; capture.args = args; capture.env = options.env; }
    return spawn(process.execPath, [fake, ...args], { ...options, env: { ...options.env, NODE_ENV: "test" } });
  } });
}
function input(workingDirectory: string, prompt = "hello", deadlineMs = 10_000, signal?: AbortSignal) {
  return { executablePath: executable, prompt, workingDirectory, deadlineMs, model: "sonnet", effort: "high",
    supportsEffort: false, signal };
}

test("runs only the reviewed Mac-local Claude arguments and exposes no inherited environment", async () => {
  const cwd = await taskDirectory();
  const captured: { file?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> } = {};
  const result = await adapter(captured).execute(input(cwd));
  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("expected completed output");
  assert.deepEqual(captured.args, OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1);
  const received = JSON.parse(result.text) as { args: string[]; env: string[]; prompt: string };
  assert.deepEqual(received.args, captured.args); assert.equal(received.prompt, "hello");
  assert.equal(received.env.includes("SECRET_SHOULD_NOT_LEAK"), false);
  assert.deepEqual(Object.keys(captured.env ?? {}).sort(), ["HOME", "LANG", "LOGNAME", "PATH", "TMPDIR", "USER"]);
  assert.equal(result.usageReported, true);
  // Lead decision 2026-10-02 13:16 (r6tfix): a harness that reports usage but omits
  // the cache count records an explicit zero, so the cost is known, not "Unknown".
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedInputTokens: 0 });
  assert.deepEqual(await readdir(cwd), []);
});

test("passes a chosen effort only when startup verified the installed CLI supports it", async () => {
  const captured: { args?: readonly string[] } = {};
  const result = await adapter(captured).execute({ ...input(await taskDirectory()), model: "opus", effort: "high", supportsEffort: true });
  assert.equal(result.status, "completed");
  assert.deepEqual(captured.args, ["-p", "--model", "opus", "--effort", "high", ...OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1.slice(3)]);
});

test("the shared adapter sends a per-task Claude selection through the real executor", async () => {
  const cwd = await taskDirectory(); const captured: { args?: readonly string[] } = {};
  const selected = createOwnerTrustedLocalClaudeExecutionAdapterV1(adapter(captured), {
    executablePath: executable, workingDirectory: cwd, deadlineMs: 10_000,
    async select(jobId: string) {
      assert.equal(jobId, "job:selected");
      return { model: "opus", effort: "high", supportsEffort: true };
    },
  });
  const result = await selected.execute({ delivery: { identity: { jobId: "job:selected" },
    input: { instructions: "Read only the supplied task.", prompt: "Return the bounded result." } },
  signal: new AbortController().signal });
  assert.equal(result.kind, "completed");
  assert.deepEqual(captured.args, ["-p", "--model", "opus", "--effort", "high", ...OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1.slice(3)]);
});

test("keeps the pre-W8 Sonnet invocation when protected model selection is absent", async () => {
  const cwd = await taskDirectory();
  const captured: { args?: readonly string[] } = {};
  const result = await adapter(captured).execute({ executablePath: executable, prompt: "hello", workingDirectory: cwd, deadlineMs: 10_000 });
  assert.equal(result.status, "completed");
  assert.deepEqual(captured.args, OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1);
});

test("rejects a canceled task and reuses an accessible persistent directory", async () => {
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await adapter().execute(input(await taskDirectory(), "hello", 10_000, controller.signal)),
    { status: "canceled", reason: "aborted_before_spawn" });
  const cwd = await taskDirectory(); await chmod(cwd, 0o700); await writeFile(join(cwd, "not-empty"), "x");
  assert.equal((await adapter().execute(input(cwd))).status, "completed");
  assert.equal((await readdir(cwd)).includes("not-empty"), true);
});

test("rechecks cancellation after asynchronous directory inspection and never spawns", async () => {
  const controller = new AbortController(); let spawned = false;
  const blocked = createOwnerTrustedLocalClaudeExecV1({
    async readDirectory() { controller.abort(); return []; },
    spawn() { spawned = true; throw new Error("must_not_spawn"); },
  });
  assert.deepEqual(await blocked.execute(input(await taskDirectory(), "hello", 10_000, controller.signal)),
    { status: "canceled", reason: "aborted_before_spawn" });
  assert.equal(spawned, false);
});

test("refuses malformed output and nonzero exits", async () => {
  assert.notEqual((await adapter().execute(input(await taskDirectory(), "malformed"))).status, "completed");
  assert.deepEqual(await adapter().execute(input(await taskDirectory(), "nonzero")),
    { status: "failed", reason: "process_or_output_refused" });
});

test("cancel and deadline stop the complete detached process group", async () => {
  const controller = new AbortController();
  const pending = adapter().execute(input(await taskDirectory(), "wait", 10_000, controller.signal));
  await new Promise(resolve => setTimeout(resolve, 25)); controller.abort();
  assert.equal((await pending).status, "canceled");
  const started = Date.now();
  assert.deepEqual(await adapter().execute(input(await taskDirectory(), "hang", 100)),
    { status: "timed_out", reason: "deadline_exceeded" });
  assert.ok(Date.now() - started >= 5_000);
});

test("does not report a finished task while a detached descendant remains", async () => {
  const result = await adapter().execute(input(await taskDirectory(), "leak", 10_000));
  assert.notEqual(result.status, "completed");
});
