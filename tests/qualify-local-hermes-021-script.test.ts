import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const script = join(root, "scripts", "qualify-local-hermes-021.mjs");

async function run(args: readonly string[], environment: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

test("the local Hermes qualification dry run is explicit and never starts a runner", async () => {
  const result = await run(["--owner-attended", "--dry-run"]);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.qualificationReady, true);
  assert.equal(output.ownerAttended, true);
  assert.equal(output.invocation.executable, "hermes");
  assert.equal(output.invocation.maxTurns, 1);
  assert.equal(output.invocation.toolAccess, "none");
});

test("an owner can select a temporary local model without exposing it in the proof", async () => {
  const result = await run(["--owner-attended", "--dry-run", "--profile", "local-worker", "--model", "qwen3.8:27b-long", "--provider", "ollama"]);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.modelOverrideUsed, undefined);
  assert.equal(output.invocation.arguments.includes("qwen3.8:27b-long"), false);
  assert.equal(output.invocation.arguments.includes("<owner-selected-model>"), true);
  assert.equal(output.invocation.arguments.includes("local-worker"), false);
  assert.equal(output.invocation.arguments.includes("<owner-selected-profile>"), true);
});

test("a malformed override is refused before a runner starts", async () => {
  const result = await run(["--owner-attended", "--profile", "--model"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage:/);
  assert.equal(result.stdout, "");
});

test("a missing local Hermes runner is reported safely and requires fresh owner authorization", async () => {
  const result = await run(["--owner-attended"], { PATH: "" });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.qualified, false);
  assert.equal(output.terminalResultObserved, false);
  assert.equal(output.failureStage, "before_terminal_result");
  assert.equal(output.failureReason, "runner_unavailable");
  assert.equal(output.retryRequiresFreshOwnerAuthorization, true);
  assert.equal(JSON.stringify(output).includes("hermes chat"), false);
});

test("a disposable Hermes-compatible runner can return the bounded text-only proof", async t => {
  const dir = await mkdtemp(join(tmpdir(), "control-room-hermes-qualification-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "hermes");
  await writeFile(fake, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv;\nconst q = fs.readFileSync(args[args.indexOf('--query-file') + 1], 'utf8');\nconst text = q.match(/CONTROL_ROOM_HERMES_021_[a-f0-9]+/)[0];\nconsole.log(JSON.stringify({ type: 'result', session_id: 'session:fixture', exit_code: 0, text, tokens: { input: 1, output: 1, total: 2 }, duration_ms: 1, timestamp: 1 }));\n`, { mode: 0o700 });
  await chmod(fake, 0o700);
  const result = await run(["--owner-attended"], { PATH: dir });
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.qualified, true);
  assert.equal(output.failureStage, "none");
  assert.equal(output.failureReason, "none");
  assert.equal(output.retryRequiresFreshOwnerAuthorization, false);
  assert.equal(output.sessionDigest.startsWith("sha256:"), true);
  assert.equal(JSON.stringify(output).includes("session:fixture"), false);
});

test("a provider quota refusal is classified without emitting provider output", async t => {
  const dir = await mkdtemp(join(tmpdir(), "control-room-hermes-qualification-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "hermes");
  await writeFile(fake, `#!${process.execPath}\nprocess.stderr.write('HTTP 429: quota has been exhausted\\n'); process.exit(1);\n`, { mode: 0o700 });
  await chmod(fake, 0o700);
  const result = await run(["--owner-attended"], { PATH: dir });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.failureReason, "model_quota_exhausted");
  assert.equal(JSON.stringify(output).includes("quota has been exhausted"), false);
});

test("a temporary shared-model limit is not reported as an exhausted allowance", async t => {
  const dir = await mkdtemp(join(tmpdir(), "control-room-hermes-qualification-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "hermes");
  await writeFile(fake, `#!${process.execPath}\nprocess.stderr.write('HTTP 429: temporarily rate-limited upstream; retry shortly\\n'); process.exit(1);\n`, { mode: 0o700 });
  await chmod(fake, 0o700);
  const result = await run(["--owner-attended"], { PATH: dir });
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.failureReason, "model_rate_limited");
  assert.equal(JSON.stringify(output).includes("retry shortly"), false);
});

test("a retired model is classified without emitting provider output", async t => {
  const dir = await mkdtemp(join(tmpdir(), "control-room-hermes-qualification-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "hermes");
  await writeFile(fake, `#!${process.execPath}\nprocess.stderr.write('HTTP 404: model is retired\\n'); process.exit(1);\n`, { mode: 0o700 });
  await chmod(fake, 0o700);
  const result = await run(["--owner-attended"], { PATH: dir });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.failureReason, "model_unavailable");
  assert.equal(JSON.stringify(output).includes("model is retired"), false);
});
