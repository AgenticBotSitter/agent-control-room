import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOwnerTrustedLocalHermesExecV1, OWNER_TRUSTED_LOCAL_HERMES_FIXED_ARGS_V1 } from "../src/harness/hermes-local-v1";

const root = await mkdtemp(join(tmpdir(), "acr-hermes-exec-"));
const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hermes-owner-trusted-local-exec-fake.mjs");
async function taskDirectory() { return await mkdtemp(join(root, "task-")); }
function adapter(capture?: { args?: readonly string[]; env?: Readonly<Record<string, string>> }) {
  return createOwnerTrustedLocalHermesExecV1({ spawn: (_file, args, options) => {
    if (capture) { capture.args = args; capture.env = options.env; }
    return spawn(process.execPath, [fake, ...args], options);
  } });
}
function input(workingDirectory: string, prompt = "hello", deadlineMs = 10_000, signal?: AbortSignal) {
  return { executablePath: process.execPath, profile: "cr", model: "space-bunny-free", provider: "opencode-go", prompt, workingDirectory, deadlineMs, signal };
}

test("runs a text-only Hermes task with protected model selection and no inherited environment", async () => {
  const captured: { args?: readonly string[]; env?: Readonly<Record<string, string>> } = {};
  const cwd = await taskDirectory(); const result = await adapter(captured).execute(input(cwd));
  assert.equal(result.status, "completed"); if (result.status !== "completed") throw new Error("expected completion");
  assert.deepEqual(captured.args, ["-p", "cr", ...OWNER_TRUSTED_LOCAL_HERMES_FIXED_ARGS_V1,
    "--run-budget", "10", "--in", cwd, "--model", "space-bunny-free", "--provider", "opencode-go"]);
  const received = JSON.parse(result.text) as { args: string[]; env: string[]; prompt: string };
  assert.deepEqual(received.args, captured.args); assert.equal(received.prompt, "hello");
  assert.equal(received.env.includes("SECRET_SHOULD_NOT_LEAK"), false);
  assert.deepEqual(Object.keys(captured.env ?? {}).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 }); assert.deepEqual(await readdir(cwd), []);
});

test("refuses cancellation and a nonempty directory before spawning", async () => {
  const signal = new AbortController(); signal.abort();
  assert.deepEqual(await adapter().execute(input(await taskDirectory(), "hello", 10_000, signal.signal)), { status: "canceled", reason: "aborted_before_spawn" });
  const cwd = await taskDirectory(); await chmod(cwd, 0o700); await writeFile(join(cwd, "not-empty"), "x");
  assert.deepEqual(await adapter().execute(input(cwd)), { status: "failed", reason: "working_directory_not_empty" });
});

test("refuses malformed output and cleans a cancelled or deadline-bound process group", async () => {
  assert.notEqual((await adapter().execute(input(await taskDirectory(), "malformed"))).status, "completed");
  assert.deepEqual(await adapter().execute(input(await taskDirectory(), "nonzero")), { status: "failed", reason: "process_or_output_refused" });
  const controller = new AbortController(); const pending = adapter().execute(input(await taskDirectory(), "wait", 10_000, controller.signal));
  await new Promise(resolve => setTimeout(resolve, 25)); controller.abort(); assert.equal((await pending).status, "canceled");
  const started = Date.now(); assert.deepEqual(await adapter().execute(input(await taskDirectory(), "hang", 100)), { status: "timed_out", reason: "deadline_exceeded" });
  assert.ok(Date.now() - started >= 5_000);
});

test("does not call a leaked detached descendant a completed task", async () => {
  assert.notEqual((await adapter().execute(input(await taskDirectory(), "leak"))).status, "completed");
});
