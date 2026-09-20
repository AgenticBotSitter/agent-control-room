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
