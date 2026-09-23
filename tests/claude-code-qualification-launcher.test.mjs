import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

test("local Claude qualification dry run is explicit and does not disclose owner settings", async () => {
  const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/qualify-local-claude-code.ts",
    "--owner-attended", "--dry-run", "--reuse-owner-login", "--executable", "/private/owner/claude",
    "--workdir", "/private/owner/work"], { cwd: process.cwd() });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { qualificationReady: true, ownerAttended: true,
    invocation: "fixed-argument local Claude Code text-review bridge", startsWork: false });
  assert.doesNotMatch(stdout, /private\/owner|reuse-owner-login/i);
});

test("local Claude qualification refuses an incomplete or non-owner-attended invocation without a process", async () => {
  await assert.rejects(run(process.execPath, ["--import", "tsx", "scripts/qualify-local-claude-code.ts",
    "--dry-run", "--reuse-owner-login", "--executable", "/private/owner/claude", "--workdir", "/private/owner/work"],
  { cwd: process.cwd() }), error => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /Usage:/);
    assert.doesNotMatch(error.stderr, /private\/owner/);
    return true;
  });
});

test("owner-attended qualification runs only the fixed argv through a disposable fake and retains no prompt text", async t => {
  const directory = await mkdtemp(join(tmpdir(), "acr-claude-qualification-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-claude");
  // This is not Claude Code. It is an isolated process fixture which proves
  // the launcher supplies the fixed stream framing and sanitizes its report.
  await writeFile(executable, `#!/bin/sh
input=$(cat)
nonce=$(printf '%s' "$input" | sed 's/^Reply with exactly this text and nothing else: //')
printf '{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-000000004242"}\\n'
printf '{"type":"result","subtype":"success","is_error":false,"session_id":"00000000-0000-4000-8000-000000004242","result":"%s","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}\\n' "$nonce"
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/qualify-local-claude-code.ts",
    "--owner-attended", "--reuse-owner-login", "--executable", executable, "--workdir", directory], { cwd: process.cwd() });
  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.equal(report.qualified, true);
  assert.deepEqual({ input: report.inputTokens, output: report.outputTokens, total: report.totalTokens }, { input: 3, output: 2, total: 5 });
  assert.doesNotMatch(stdout, /Reply with exactly|CONTROL_ROOM_CLAUDE|00000000-0000-4000-8000-000000004242|acr-claude-qualification-test/);
});

test("qualification closes the whole disposable process group, not only its leader", async t => {
  const directory = await mkdtemp(join(tmpdir(), "acr-claude-group-cleanup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-claude");
  const script = "#!/bin/sh\n(trap '' TERM; while :; do sleep 1; done) </dev/null >/dev/null 2>&1 &\necho $! > child.pid\ninput=$(cat)\n"
    + "nonce=$(printf '%s' \"$input\" | sed 's/^Reply with exactly this text and nothing else: //')\n"
    + "printf '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"00000000-0000-4000-8000-000000004242\"}\\n'\n"
    + "printf '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"00000000-0000-4000-8000-000000004242\",\"result\":\"%s\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}\\n' \"$nonce\"\n";
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  const { stdout } = await run(process.execPath, ["--import", "tsx", "scripts/qualify-local-claude-code.ts",
    "--owner-attended", "--reuse-owner-login", "--executable", executable, "--workdir", directory], { cwd: process.cwd() });
  assert.equal(JSON.parse(stdout).qualified, true);
  const childPid = Number((await readFile(join(directory, "child.pid"), "utf8")).trim());
  assert.equal(Number.isSafeInteger(childPid) && childPid > 1, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
});
