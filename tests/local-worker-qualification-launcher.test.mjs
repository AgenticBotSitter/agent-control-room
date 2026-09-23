import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const launcher = ["--import", "tsx", "scripts/qualify-local-workers.ts"];

function args(directory, hermes, claude) {
  return [...launcher, "--owner-attended", "--reuse-owner-login",
    "--hermes-executable", hermes, "--hermes-profile", "private-profile",
    "--hermes-model", "private-model", "--hermes-provider", "private-provider",
    "--hermes-workdir", directory, "--claude-executable", claude, "--claude-workdir", directory];
}

async function fixture(directory, name, source) {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

test("combined owner-attended qualification runs Hermes then Claude and emits one sanitized report", async t => {
  const directory = await mkdtemp(join(tmpdir(), "acr-combined-qualification-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hermes = await fixture(directory, "fake-hermes", `
import { readFileSync, appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(directory, "order"))}, "hermes\\n");
if (process.argv[2] === "--version") {
  console.log("Hermes Agent v0.21.3 · upstream 00570550");
} else {
  const index = process.argv.indexOf("--query-file");
  const text = readFileSync(process.argv[index + 1], "utf8");
  const expected = text.match(/CONTROL_ROOM_HERMES_RUNNER_[a-f0-9]{32}/)?.[0];
  console.log(JSON.stringify({ type: "result", session_id: "private-session", exit_code: 0, text: expected,
    tokens: { input: 3, output: 2, total: 5, cache_read: 0, cache_write: 0 }, duration_ms: 4, timestamp: 5 }));
}`);
  const claude = await fixture(directory, "fake-claude", `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(directory, "order"))}, "claude\\n");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const expected = input.replace("Reply with exactly this text and nothing else: ", "");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "00000000-0000-4000-8000-000000004242" }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false,
  session_id: "00000000-0000-4000-8000-000000004242", result: expected,
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }));`);
  const { stdout, stderr } = await run(process.execPath, args(directory, hermes, claude), { cwd: process.cwd() });
  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.equal(report.qualified, true);
  assert.equal(report.hermes.state, "qualified");
  assert.equal(report.claude.state, "qualified");
  assert.equal(report.startsWork, false);
  assert.equal(report.grantsWorkerAuthority, false);
  assert.equal(await readFile(join(directory, "order"), "utf8"), "hermes\nhermes\nclaude\n");
  assert.doesNotMatch(stdout, /private-profile|private-model|private-provider|private-session|acr-combined-qualification/);
});

test("a failed first qualification stops before Claude and does not echo private inputs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "acr-combined-stop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "claude-ran");
  const hermes = await fixture(directory, "bad-hermes", `console.log("not the pinned Hermes version");`);
  const claude = await fixture(directory, "should-not-run", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`);
  await assert.rejects(run(process.execPath, args(directory, hermes, claude), { cwd: process.cwd() }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stderr, "");
    const report = JSON.parse(error.stdout);
    assert.equal(report.qualified, false);
    assert.equal(report.hermes.state, "failed");
    assert.equal(report.claude.state, "not_attempted");
    assert.equal(report.retryRequiresFreshOwnerAuthorization, true);
    assert.doesNotMatch(error.stdout, /private-profile|private-model|private-provider|acr-combined-stop/);
    return true;
  });
  await assert.rejects(readFile(marker), /ENOENT/);
});

test("combined qualification refuses incomplete owner input before either attempt", async () => {
  await assert.rejects(run(process.execPath, [...launcher, "--owner-attended"], { cwd: process.cwd() }), error => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /^Usage:/);
    assert.equal(error.stdout, "");
    return true;
  });
});
