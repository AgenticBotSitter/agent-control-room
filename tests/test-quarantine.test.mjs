import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateQuarantine } from "../scripts/check-test-quarantine.mjs";
import { runtimeAssemblyMemoryGuardArgs } from "../scripts/run-runtime-assembly-memory-guard.mjs";

const today = new Date("2026-09-28T12:00:00.000Z");
const valid = { test: "tests/example.test.mjs::flaky path", issue: "#123", added: "2026-09-14", owner: "test maintainer" };

test("expired and issue-less quarantine entries fail validation", () => {
  assert.match(validateQuarantine([{ ...valid, added: "2026-09-13" }], today).join("\n"), /15 days old/);
  assert.match(validateQuarantine([{ ...valid, issue: "" }], today).join("\n"), /GitHub issue/);
  assert.deepEqual(validateQuarantine([valid], today), []);
  assert.match(validateQuarantine([{ ...valid, test: "tests/browser/example.spec.ts::journey" }], today).join("\n"), /Node tests/);
});

test("quarantined failures leave the gate green while ordinary failures fail it", async t => {
  const root = await mkdtemp(join(tmpdir(), "test-quarantine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests", "sample.test.mjs"), `
    import test from "node:test";
    import assert from "node:assert/strict";
    test("known flaky", () => assert.fail("quarantined failure"));
    test("ordinary", () => assert.ok(true));
  `);
  const runner = new URL("../scripts/run-tests-with-quarantine.mjs", import.meta.url).pathname;
  const quarantine = [{ test: "tests/sample.test.mjs::known flaky", issue: "#123", added: new Date().toISOString().slice(0, 10), owner: "test maintainer" }];
  await writeFile(join(root, "tests", "quarantine.json"), JSON.stringify(quarantine));
  const gate = spawnSync(process.execPath, [runner, "--test", "tests/sample.test.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(gate.status, 0, gate.stderr);

  quarantine[0].test = "tests/sample.test.mjs::ordinary";
  await writeFile(join(root, "tests", "quarantine.json"), JSON.stringify(quarantine));
  const failed = spawnSync(process.execPath, [runner, "--test", "tests/sample.test.mjs"], { cwd: root, encoding: "utf8" });
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /quarantined failure/);
});

test("the runtime-assembly memory guard preserves its limits through the quarantine runner", () => {
  const args = runtimeAssemblyMemoryGuardArgs("/repository");
  assert.deepEqual(args, [
    "/repository/scripts/run-tests-with-quarantine.mjs",
    "--max-old-space-size=2048",
    "--import",
    "tsx",
    "--test",
    "tests/private-local-installation-runtime-assembly.test.ts",
  ]);
});

test("CI reports quarantine failures without adding them to the merge gate", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const job = workflow.match(/  quarantined-tests:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]+:|$)/)?.[1] ?? "";
  const gate = workflow.match(/  merge-gate:\n([\s\S]*)$/)?.[1] ?? "";
  assert.match(job, /continue-on-error: true/);
  assert.match(job, /pnpm run test:quarantined/);
  assert.doesNotMatch(gate.match(/needs: \[([^\]]+)\]/)?.[1] ?? "", /quarantined-tests/);
});
