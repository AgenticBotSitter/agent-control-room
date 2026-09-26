import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  return { executablePath: executable, prompt, workingDirectory, deadlineMs, signal };
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

test("rejects a canceled task and a nonempty directory before spawning", async () => {
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await adapter().execute(input(await taskDirectory(), "hello", 10_000, controller.signal)),
    { status: "canceled", reason: "aborted_before_spawn" });
  const cwd = await taskDirectory(); await chmod(cwd, 0o700); await writeFile(join(cwd, "not-empty"), "x");
  assert.deepEqual(await adapter().execute(input(cwd)), { status: "failed", reason: "working_directory_not_empty" });
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
