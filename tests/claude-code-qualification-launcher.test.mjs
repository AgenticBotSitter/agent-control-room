import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
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
