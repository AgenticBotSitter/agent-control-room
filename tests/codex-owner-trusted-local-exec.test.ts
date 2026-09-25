import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOwnerTrustedLocalCodexExecV1 } from "../src/harness/codex-v1/owner-trusted-local-exec";

const root = await mkdtemp(join(tmpdir(), "acr-codex-exec-"));
const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-owner-trusted-local-exec-fake.mjs");
const executable = process.execPath;
async function taskDirectory() { return await mkdtemp(join(root, "task-")); }
function adapter(capture?: { file?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }) {
  return createOwnerTrustedLocalCodexExecV1({ spawn: (file, args, options) => {
    if (capture) { capture.file = file; capture.args = args; capture.env = options.env; }
    return spawn(process.execPath, [fake, ...args], options);
  } });
}
function input(workingDirectory: string, prompt = "hello", deadlineMs = 10_000, signal?: AbortSignal) {
  return { executablePath: executable, prompt, workingDirectory, deadlineMs, signal };
}

test("runs fixed arguments once, closes stdin, and exposes only the allowed environment", async () => {
  const cwd = await taskDirectory();
  const captured: { file?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> } = {};
  const result = await adapter(captured).execute({ ...input(cwd), prompt: "hello" });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("expected completed output");
  assert.deepEqual(captured.args, ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
    "--color", "never", "-C", cwd, "-"]);
  const received = JSON.parse(result.text) as { args: string[]; env: string[]; prompt: string };
  assert.deepEqual(received.args, captured.args); assert.equal(received.prompt, "hello");
  // macOS may inject its own encoding marker after spawn; the adapter itself
  // passes exactly the four permitted values and no inherited secret survives.
  assert.equal(received.env.includes("SECRET_SHOULD_NOT_LEAK"), false);
  assert.deepEqual(Object.keys(captured.env ?? {}).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
  assert.equal(result.usage?.inputTokens, 3); assert.equal(result.usage?.outputTokens, 5);
  assert.deepEqual(await readdir(cwd), []);
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

test("requires the caller-provided task directory to be empty", async () => {
  const cwd = await taskDirectory(); await chmod(cwd, 0o700); await writeFile(join(cwd, "not-empty"), "x");
  const result = await adapter().execute(input(cwd, "hello"));
  assert.deepEqual(result, { status: "failed", reason: "working_directory_not_empty" });
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
