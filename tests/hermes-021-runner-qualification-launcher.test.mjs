import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

test("local Hermes runner qualification dry run is explicit and does not disclose owner settings", async () => {
  const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/qualify-local-hermes-021-runner.ts",
    "--owner-attended", "--dry-run", "--executable", "/private/owner/hermes", "--profile", "owner-profile",
    "--model", "owner-model", "--provider", "owner-provider", "--workdir", "/private/owner/work"],
  { cwd: process.cwd() });
  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.deepEqual(report, { qualificationReady: true, ownerAttended: true,
    invocation: "fixed-argument local Hermes stream-json bridge", startsWork: false });
  assert.doesNotMatch(stdout, /owner-profile|owner-model|owner-provider|\/private\/owner/);
});
