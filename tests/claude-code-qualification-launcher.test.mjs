import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

test("local Claude qualification dry run truthfully names the missing protected route", async () => {
  const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/qualify-local-claude-code.ts",
    "--owner-attended", "--reuse-owner-login", "--dry-run"], { cwd: process.cwd() });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { qualificationReady: false, ownerAttended: true,
    invocation: "protected supervised local Claude text-review route", startsWork: false,
    blocker: "protected_route_provider_required" });
  assert.doesNotMatch(stdout, /private|executable|workdir|credential|login state/iu);
});

test("local Claude qualification refuses an incomplete or non-owner-attended invocation", async () => {
  await assert.rejects(run(process.execPath, ["--import", "tsx", "scripts/qualify-local-claude-code.ts",
    "--dry-run", "--reuse-owner-login"], { cwd: process.cwd() }), error => {
    assert.equal(error.code, 2); assert.match(error.stderr, /Usage:/); return true;
  });
});

test("path-only and generic executable arguments are no longer a qualification route", async () => {
  await assert.rejects(run(process.execPath, ["--import", "tsx", "scripts/qualify-local-claude-code.ts",
    "--owner-attended", "--reuse-owner-login", "--executable", "/private/owner/claude",
    "--workdir", "/private/owner/work"], { cwd: process.cwd() }), error => {
    assert.equal(error.code, 2); assert.equal(error.stdout, "");
    assert.doesNotMatch(error.stderr, /private\/owner/); return true;
  });
});

test("owner-attended production attempt without an in-process protected route starts nothing", async () => {
  await assert.rejects(run(process.execPath, ["--import", "tsx", "scripts/qualify-local-claude-code.ts",
    "--owner-attended", "--reuse-owner-login"], { cwd: process.cwd() }), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, "");
    assert.match(error.stderr, /protected supervised installed route/u);
    assert.doesNotMatch(error.stderr, /path|command|credential|token/iu); return true;
  });
});
