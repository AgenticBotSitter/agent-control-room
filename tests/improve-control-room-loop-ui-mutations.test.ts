// Dedicated lane; none of these child commands can select this runner.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertGuardBites } from "./support/attack-kit/index";
const exec = promisify(execFile), root = resolve(".");
const panel = "private-app/app/improvement-run-panel.tsx";
const probes = [
  { name: "display identity binding", file: "src/web/v1/improve-control-room-loop-browser-client.ts",
    find: "if (display.projectId !== projectId || display.requestId !== requestId) throw new LoopReadError(0, true);",
    replace: "/* MUTANT: display identity binding disabled. */", pattern: "B2a display identity binding", assertion: "B2a foreign display never reaches DOM" },
  { name: "Start freshness and confirmation", file: panel,
    find: 'const canStart = statusFresh && current.canStart && current.confirmationCurrent && current.startState === "not_started"\n    && !actions.current.start && !pending.start && !pending.stop;',
    replace: "const canStart = true;", pattern: "B2a Start freshness gate", assertion: "B2a checking status attempts zero Start POSTs" },
  { name: "synchronous duplicate latch", file: panel,
    find: "if (latch.current[operation] || !navigator.onLine || !row.runLink) return;",
    replace: "if (!navigator.onLine || !row.runLink) return;", pattern: "B2a synchronous duplicate latch", assertion: "B2a synchronous clicks attempt exactly one POST" },
  { name: "stale-response suppression", file: panel,
    find: 'if (captured !== writeEpoch.current || signal.aborted || status.engineRevision === null\n        || status.engineRevision < revision.current || safeRef.current?.state === "stopped" && status.state !== "stopped") throw new LoopReadError(0);',
    replace: "/* MUTANT: stale responses admitted. */", pattern: "B2a stale response suppression", assertion: "B2a older running reply cannot erase known stopped" },
];
test("B2a UI guards fail independently and restore green", { timeout: 300_000 }, async t => {
  await mkdir(resolve(".test-tmp"), { recursive: true }); const copy = await mkdtemp(resolve(".test-tmp/b2a-mutations-"));
  try {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--local", "--no-hardlinks", "--quiet", root, copy], { timeout: 120_000 });
    await symlink(join(root, "node_modules"), join(copy, "node_modules"), "dir");
    for (const probe of probes) await t.test(probe.name, async () => {
      const testCmd = [process.execPath, "scripts/run-tests-with-quarantine.mjs", "--import", "tsx", "--test", `--test-name-pattern=^${probe.pattern}$`, "tests/improve-control-room-loop-ui.test.tsx"];
      const original = await readFile(join(copy, probe.file), "utf8");
      const result = await assertGuardBites({ root: copy, file: probe.file, find: probe.find, replace: probe.replace, testCmd, boundMs: 60_000, because: probe.assertion });
      assert.equal(result.applied, true); assert.equal(result.exitCode, 1); assert.equal(result.signal, null);
      assert.ok(result.output.includes(probe.assertion), `loaded mutation reached independent assertion: ${probe.assertion}`);
      assert.match(result.output, /ERR_ASSERTION/u); assert.match(result.output, /# fail 1/u);
      assert.doesNotMatch(result.output, /SyntaxError|# skipped [1-9]|# tests 0|timed out|migration_altered:/iu);
      assert.equal(await readFile(join(copy, probe.file), "utf8"), original);
      const env: NodeJS.ProcessEnv = { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" }; delete env.NODE_TEST_CONTEXT;
      const restored = await exec(testCmd[0]!, testCmd.slice(1), { cwd: copy, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      assert.match(restored.stdout, /# pass 1/u); assert.match(restored.stdout, /# fail 0/u); assert.doesNotMatch(restored.stdout, /# skipped [1-9]|# tests 0/u);
      console.log(`B2a mutation ${probe.name}: loaded=true intended_assertion=true restored=true green=true`);
    });
  } finally { await rm(copy, { recursive: true, force: true }); }
});
