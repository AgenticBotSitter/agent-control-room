import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOwnerTrustedLocalCodexExecV1 } from "../src/harness/codex-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalCodexExecutionAdapterV1 } from "../src/harness/v1/owner-trusted-local-cli-execution";

const root = await mkdtemp(join(tmpdir(), "acr-codex-exec-"));
const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-owner-trusted-local-exec-fake.mjs");
const executable = process.execPath;
async function taskDirectory() { return await mkdtemp(join(root, "task-")); }
function adapter(capture?: { file?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }) {
  return createOwnerTrustedLocalCodexExecV1({ spawn: (file, args, options) => {
    if (capture) { capture.file = file; capture.args = args; capture.env = options.env; }
    return spawn(process.execPath, [fake, ...args], { ...options, env: { ...options.env, NODE_ENV: "test" } });
  } });
}
function input(workingDirectory: string, prompt = "hello", deadlineMs = 10_000, signal?: AbortSignal) {
  return { executablePath: executable, prompt, workingDirectory, deadlineMs, model: "gpt-test", effort: "high", signal };
}

test("a process group that has already exited is a stop, not cleanup uncertainty", async () => {
  // A process group can disappear between the decision to stop a task and the signal reaching it:
  // the child exits on its own, and `kill` then fails with ESRCH. That is the outcome the caller
  // asked for, not an unfinishable task. Reporting `cleanup_uncertain` there made a bounded,
  // fully-exited task look stuck, and because the window is timing-dependent it passed on most
  // runs and failed under load. The group is only "unavailable" while it still exists.
  //
  // The window is made deterministic by handing the adapter a real, already-reaped child with live
  // stdio: its group is provably gone, so every signal is ESRCH, and the result depends on how the
  // adapter reads that failure rather than on whether the scheduler let a child exit first.
  const reaped = spawn(process.execPath, [fake, "nonzero"], { stdio: ["pipe", "pipe", "pipe"] });
  reaped.stdin.end();
  await once(reaped, "close");
  const result = await createOwnerTrustedLocalCodexExecV1({
    spawn: () => reaped as unknown as ReturnType<typeof spawn>,
  }).execute({ ...input(await taskDirectory(), "overflow"), deadlineMs: 200 });
  assert.deepEqual(result, { status: "timed_out", reason: "deadline_exceeded" },
    "a stop against an already-exited group is a normal stop, not an unfinishable cleanup");
});

test("a process group that is still present and ignores TERM is stopped by the kill escalation", async () => {
  // The other side, so the fix cannot pass by treating every signalling failure as success. A group
  // that is still present when it is signalled must be escalated to KILL, not declared gone.
  const result = await adapter().execute({ ...input(await taskDirectory(), "hang"), deadlineMs: 100 });
  assert.deepEqual(result, { status: "timed_out", reason: "deadline_exceeded" },
    "a group that ignores TERM must still be killed and reported as a timeout");
});

test("runs fixed arguments once, closes stdin, and exposes only the allowed environment", async () => {
  const cwd = await taskDirectory();
  const captured: { file?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> } = {};
  const result = await adapter(captured).execute({ ...input(cwd), prompt: "hello" });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("expected completed output");
  assert.deepEqual(captured.args, ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
    "--color", "never", "-C", cwd, "-m", "gpt-test", "-c", "model_reasoning_effort=high", "-"]);
  const received = JSON.parse(result.text) as { args: string[]; env: string[]; prompt: string };
  assert.deepEqual(received.args, captured.args); assert.equal(received.prompt, "hello");
  // macOS may inject its own encoding marker after spawn; the adapter itself
  // passes exactly the four permitted values and no inherited secret survives.
  assert.equal(received.env.includes("SECRET_SHOULD_NOT_LEAK"), false);
  assert.deepEqual(Object.keys(captured.env ?? {}).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
  assert.equal(result.usage?.inputTokens, 3); assert.equal(result.usage?.outputTokens, 5);
  assert.deepEqual(await readdir(cwd), []);
});

test("omits model arguments when protected model selection is not enabled", async () => {
  const cwd = await taskDirectory();
  const captured: { args?: readonly string[] } = {};
  const selected = input(cwd);
  const result = await adapter(captured).execute({ executablePath: selected.executablePath, prompt: selected.prompt,
    workingDirectory: selected.workingDirectory, deadlineMs: selected.deadlineMs });
  assert.equal(result.status, "completed");
  assert.deepEqual(captured.args, ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
    "--color", "never", "-C", cwd, "-"]);
});

test("the shared adapter sends a per-task Codex selection through the real executor", async () => {
  const cwd = await taskDirectory();
  const captured: { args?: readonly string[] } = {};
  const selected = createOwnerTrustedLocalCodexExecutionAdapterV1(adapter(captured), {
    executablePath: executable, workingDirectory: cwd, deadlineMs: 10_000,
    async select(jobId: string) {
      assert.equal(jobId, "job:selected");
      return { model: "gpt-selected", effort: "xhigh" };
    },
  });
  const result = await selected.execute({ delivery: { identity: { jobId: "job:selected" },
    input: { instructions: "Read only the supplied task.", prompt: "Return the bounded result." } },
  signal: new AbortController().signal });
  assert.equal(result.kind, "completed");
  assert.deepEqual(captured.args, ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
    "--color", "never", "-C", cwd, "-m", "gpt-selected", "-c", "model_reasoning_effort=xhigh", "-"]);
});

test("rejects a task before spawning when it is already canceled", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await adapter().execute(input(await taskDirectory(), "hello", 10_000, controller.signal));
  assert.deepEqual(result, { status: "canceled", reason: "aborted_before_spawn" });
});

test("rechecks cancellation after asynchronous directory inspection and never spawns", async () => {
  const controller = new AbortController(); let spawned = false;
  const blocked = createOwnerTrustedLocalCodexExecV1({
    async readDirectory() { controller.abort(); return []; },
    spawn() { spawned = true; throw new Error("must_not_spawn"); },
  });
  assert.deepEqual(await blocked.execute(input(await taskDirectory(), "hello", 10_000, controller.signal)),
    { status: "canceled", reason: "aborted_before_spawn" });
  assert.equal(spawned, false);
});

test("reuses an accessible persistent task directory", async () => {
  const cwd = await taskDirectory(); await chmod(cwd, 0o700); await writeFile(join(cwd, "not-empty"), "x");
  const result = await adapter().execute(input(cwd, "hello"));
  assert.equal(result.status, "completed");
  assert.equal((await readdir(cwd)).includes("not-empty"), true);
});

test("cancellation stops a direct child promptly instead of waiting for the kill timer", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = adapter().execute(input(await taskDirectory(), "wait", 10_000, controller.signal));
  await new Promise(resolve => setTimeout(resolve, 25));
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "canceled");
  assert.ok(Date.now() - started < 1_000, "a direct child exited after TERM without waiting for KILL");
});

test("refuses malformed output and nonzero exits", async () => {
  const malformed = await adapter().execute(input(await taskDirectory(), "malformed"));
  assert.notEqual(malformed.status, "completed");
  assert.deepEqual(await adapter().execute(input(await taskDirectory(), "nonzero")), { status: "failed", reason: "process_or_output_refused" });
});

test("enforces a configured combined output-byte limit", async () => {
  const refused = await adapter().execute({ ...input(await taskDirectory(), "overflow"), outputBytes: 16_384 });
  assert.deepEqual(refused, { status: "failed", reason: "process_or_output_refused" });
  const accepted = await adapter().execute({ ...input(await taskDirectory(), "overflow"), outputBytes: 32_768 });
  assert.equal(accepted.status, "completed", "the overflow fixture must be valid Codex JSONL below a larger cap");
});

test("enforces the 1 MiB default output-byte limit when none is supplied", async () => {
  const refused = await adapter().execute(input(await taskDirectory(), "default-overflow"));
  assert.deepEqual(refused, { status: "failed", reason: "process_or_output_refused" });
  const accepted = await adapter().execute({ ...input(await taskDirectory(), "default-overflow"), outputBytes: 2_097_152 });
  assert.equal(accepted.status, "completed", "the default-overflow fixture must be valid below a larger cap");
});

test("deadline kills the detached process group even when its child ignores TERM", async () => {
  const started = Date.now();
  const result = await adapter().execute(input(await taskDirectory(), "hang", 100));
  assert.deepEqual(result, { status: "timed_out", reason: "deadline_exceeded" });
  assert.ok(Date.now() - started >= 5_000, "waited through the TERM-to-KILL cleanup window");
});

test("does not report completion while a detached descendant remains", async () => {
  const result = await adapter().execute(input(await taskDirectory(), "leak", 10_000));
  assert.notEqual(result.status, "completed");
});
