import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOwnerTrustedLocalClaudeExecV1, OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1 } from "../src/harness/claude-code-v1/owner-trusted-local-exec";

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
  assert.equal(result.usageReported, true); assert.deepEqual(await readdir(cwd), []);
});

test("passes a chosen effort only when startup verified the installed CLI supports it", async () => {
  const captured: { args?: readonly string[] } = {};
  const result = await adapter(captured).execute({ ...input(await taskDirectory()), model: "opus", effort: "high", supportsEffort: true });
  assert.equal(result.status, "completed");
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

test("enforces a configured combined output-byte limit", async () => {
  const result = await adapter().execute({ ...input(await taskDirectory(), "overflow"), outputBytes: 16_384 });
  assert.deepEqual(result, { status: "failed", reason: "process_or_output_refused" });
});

test("enforces the 1 MiB default output-byte limit when none is supplied", async () => {
  const refused = await adapter().execute(input(await taskDirectory(), "default-overflow"));
  assert.deepEqual(refused, { status: "failed", reason: "process_or_output_refused" });
  const accepted = await adapter().execute({ ...input(await taskDirectory(), "default-overflow"), outputBytes: 2_097_152 });
  assert.equal(accepted.status, "completed", "the default-overflow fixture must be valid below a larger cap");
});

test("a process group that has already exited is a stop, not cleanup uncertainty", async () => {
  // A process group can disappear between the decision to stop a task and the signal reaching it:
  // the child exits on its own, or exits in response to whatever tripped the stop, and `kill` then
  // fails with ESRCH. That is the outcome the caller asked for, not an unfinishable task. Reporting
  // `cleanup_uncertain` there made a bounded, fully-exited task look stuck, and because the window
  // is timing-dependent it passed on most runs and failed under load.
  //
  // The window is made deterministic by giving the adapter a spawn that returns a real, already
  // reaped child with live stdio: its process group is provably gone, so every signal is ESRCH, and
  // the outcome depends on how the adapter reads that failure rather than on whether the scheduler
  // happened to let a child exit first. The task then hits its deadline, which is the stop path.
  const reaped = spawn(process.execPath, [fake, "nonzero"], { stdio: ["pipe", "pipe", "pipe"] });
  reaped.stdin.end();
  await once(reaped, "close");
  const result = await createOwnerTrustedLocalClaudeExecV1({
    spawn: () => reaped as unknown as ReturnType<typeof spawn>,
  }).execute({ ...input(await taskDirectory(), "overflow"), deadlineMs: 200 });
  assert.deepEqual(result, { status: "timed_out", reason: "deadline_exceeded" },
    "a stop against an already-exited group is a normal stop, not an unfinishable cleanup");
});

test("a process group that is still present and ignores TERM is stopped by the kill escalation", async () => {
  // The other side, so the fix cannot pass by treating every signalling failure as success. This
  // fixture keeps a TERM-ignoring descendant in the group, so the group is still present when the
  // adapter signals it and must be escalated to KILL rather than declared unfinishable.
  const result = await adapter().execute({ ...input(await taskDirectory(), "hang"), deadlineMs: 100 });
  assert.deepEqual(result, { status: "timed_out", reason: "deadline_exceeded" },
    "a group that ignores TERM must still be killed and reported as a timeout");
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
