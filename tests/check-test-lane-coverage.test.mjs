import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findUncoveredTests, reachableTests, workflowCommands } from "../scripts/check-test-lane-coverage.mjs";

function fixture({ scripts, workflow, tests, sources = {} }) {
  const root = mkdtempSync(join(tmpdir(), "control-room-lane-coverage-"));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  for (const file of tests) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), sources[file] ?? "");
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(root, ".github/workflows/ci.yml"), workflow);
  return root;
}

test("an unused package script cannot disguise an uncovered test", () => {
  const root = fixture({
    scripts: { "test:live": "node --test tests/live.test.ts", "test:unused": "node --test tests/orphan.test.ts" },
    workflow: "steps:\n  - run: pnpm run test:live\n",
    tests: ["tests/live.test.ts", "tests/orphan.test.ts"],
  });
  try { assert.deepEqual(findUncoveredTests(root), ["tests/orphan.test.ts"]); }
  finally { rmSync(root, { recursive: true }); }
});

test("nested tests are discovered and workflow-reachable script chains are followed", () => {
  const root = fixture({
    scripts: { test: "pnpm test:nested", "test:nested": "node --test tests/nested/covered.test.mjs" },
    workflow: "steps:\n  - run: |\n      pnpm run test\n",
    tests: ["tests/nested/covered.test.mjs", "tests/nested/orphan.test.mjs"],
  });
  try { assert.deepEqual(findUncoveredTests(root), ["tests/nested/orphan.test.mjs"]); }
  finally { rmSync(root, { recursive: true }); }
});

test("look-alike filenames do not count as exact test arguments", () => {
  const reached = reachableTests({}, ["node --test tests/case.test.tsx"]);
  assert.equal(reached.has("tests/case.test.tsx"), true);
  assert.equal(reached.has("tests/case.test.ts"), false);
});

test("keep-going runner names reach their package chains without covering unused scripts", () => {
  const scripts = { suite: "pnpm a && pnpm b", a: "node --test tests/a.test.mjs",
    b: "node --test tests/b.test.mjs", unused: "node --test tests/unused.test.mjs" };
  assert.deepEqual([...reachableTests(scripts,
    ["node scripts/ci/run-scripts-keep-going.mjs --jobs 1 --expand suite"])].sort(),
    ["tests/a.test.mjs", "tests/b.test.mjs"]);
  for (const flags of ["--jobs 2", "--unknown"]) {
    assert.deepEqual([...reachableTests(scripts,
      [`node scripts/ci/run-scripts-keep-going.mjs ${flags} suite`])], []);
  }
});

test("quoted and block workflow commands are extracted", () => {
  assert.deepEqual(workflowCommands([
    "steps:",
    "  - run: pnpm install --frozen-lockfile",
    "  - run: 'pnpm run test:one'",
    "  - run: |",
    "      pnpm run test:two",
    "      node --test tests/direct.test.js",
  ].join("\n")), ["pnpm install --frozen-lockfile", "pnpm run test:one", "pnpm run test:two\nnode --test tests/direct.test.js"]);
});

const darwinPgSource = "import { withRealPostgres } from './support/attack-kit/index'; if (process.platform !== 'darwin') { return; }";
const linuxJob = "jobs:\n  linux:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run test:pg\n";
const macJob = "  mac:\n    runs-on: macos-26\n    steps:\n      - run: pnpm run test:pg\n";

function pgFixture(workflow, source = darwinPgSource) {
  return fixture({ scripts: { "test:pg": "node --test tests/private-pg.test.ts" }, workflow,
    tests: ["tests/private-pg.test.ts"], sources: { "tests/private-pg.test.ts": source } });
}

test("Darwin-only PostgreSQL requires a macOS execution even when Linux reaches it", () => {
  const root = pgFixture(linuxJob);
  try { assert.deepEqual(findUncoveredTests(root), ["tests/private-pg.test.ts"]); }
  finally { rmSync(root, { recursive: true }); }
});

test("a macOS package chain covers Darwin-only PostgreSQL", () => {
  const root = pgFixture(linuxJob + macJob);
  try { assert.deepEqual(findUncoveredTests(root), []); }
  finally { rmSync(root, { recursive: true }); }
});

test("a Linux matrix command cannot impersonate the macOS matrix entry", () => {
  const root = pgFixture("jobs:\n  catchup:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n          - lane: components\n            runner: ubuntu-latest\n          - lane: updater\n            runner: macos-26\n    steps:\n      - name: Linux only\n        if: matrix.lane == 'components'\n        run: pnpm run test:pg\n");
  try { assert.deepEqual(findUncoveredTests(root), ["tests/private-pg.test.ts"]); }
  finally { rmSync(root, { recursive: true }); }
});

test("a macOS matrix command covers Darwin-only PostgreSQL", () => {
  const root = pgFixture("jobs:\n  catchup:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n          - lane: updater\n            runner: macos-26\n    steps:\n      - name: Mac only\n        if: matrix.lane == 'updater'\n        run: pnpm run test:pg\n");
  try { assert.deepEqual(findUncoveredTests(root), []); }
  finally { rmSync(root, { recursive: true }); }
});

test("helper-level kernel lock gating also requires macOS PostgreSQL execution", () => {
  const root = pgFixture(linuxJob, "withRealPostgres(() => {}); if (!KERNEL_OPEN_LOCK_HOST_V1) { return; }");
  try { assert.deepEqual(findUncoveredTests(root), ["tests/private-pg.test.ts"]); }
  finally { rmSync(root, { recursive: true }); }
});

test("portable PostgreSQL remains covered by Linux", () => {
  const root = pgFixture(linuxJob, "withRealPostgres(() => {});");
  try { assert.deepEqual(findUncoveredTests(root), []); }
  finally { rmSync(root, { recursive: true }); }
});

test("portable platform paths and fixture strings do not claim Darwin-only PostgreSQL", () => {
  for (const source of [
    "const PG_BIN = '/pg'; const root = process.platform === 'darwin' ? '/private/tmp' : tmpdir();",
    "const fixture = \"withRealPostgres(); if (process.platform !== 'darwin') return;\";",
    "// withRealPostgres(); if (process.platform !== 'darwin') return;",
  ]) {
    const root = pgFixture(linuxJob, source);
    try { assert.deepEqual(findUncoveredTests(root), []); }
    finally { rmSync(root, { recursive: true }); }
  }
});

test("a helper wrapper without PostgreSQL does not need a database macOS lane", () => {
  const root = pgFixture(linuxJob, "kernelOpenLockTestV1('unit', () => {});");
  try { assert.deepEqual(findUncoveredTests(root), []); }
  finally { rmSync(root, { recursive: true }); }
});

test("aliased and reversed Darwin PostgreSQL gates cannot hide behind Linux coverage", () => {
  for (const source of [
    "const PG_BIN = '/pg'; const isMac = process.platform === 'darwin'; test('pg', { skip: !isMac }, () => {});",
    "withRealPostgres(); if ('darwin' !== process.platform) return;",
  ]) {
    const root = pgFixture(linuxJob, source);
    try { assert.deepEqual(findUncoveredTests(root), ["tests/private-pg.test.ts"]); }
    finally { rmSync(root, { recursive: true }); }
  }
});

test("both hosted macOS paths execute every inventoried result PostgreSQL file", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
  const files = ["tests/result-file-catalog-postgres.test.ts", "tests/result-file-download-postgres.test.ts",
    "tests/result-file-upload-race-postgres.test.ts", "tests/result-upload-store-postgres.test.ts",
    "tests/text-copy-derivation-postgres.test.ts"];
  for (const job of ["test-updater", "full-gate"]) {
    const block = workflow.match(new RegExp(`^  ${job}:[\\s\\S]*?(?=^  [a-z][a-z-]+:|$(?![\\s\\S]))`, "mu"))?.[0];
    assert.ok(block, `hosted path exists: ${job}`);
    const root = fixture({ scripts, workflow: "jobs:\n" + block, tests: files,
      sources: Object.fromEntries(files.map(file => [file, darwinPgSource])) });
    try { assert.deepEqual(findUncoveredTests(root), [], `all five real file arguments reached on ${job}`); }
    finally { rmSync(root, { recursive: true }); }
  }
});

for (const [name, workflow] of Object.entries({
  "Linux-only step on a macOS job": macJob.replace("      - run:", "      - if: runner.os == 'Linux'\n        run:"),
  "disabled step on a macOS job": macJob.replace("      - run:", "      - if: false\n        run:"),
  "matrix macOS lane with an extra Linux condition": "jobs:\n  catchup:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n          - lane: updater\n            runner: macos-26\n    steps:\n      - if: matrix.lane == 'updater' && runner.os == 'Linux'\n        run: pnpm run test:pg\n",
  "shell uname condition on a macOS job": "jobs:\n  mac:\n    runs-on: macos-26\n    steps:\n      - run: |\n          if [ \"$(uname -s)\" = Linux ]; then\n            pnpm run test:pg\n          fi\n",
  "unsupported condition": macJob.replace("      - run:", "      - if: contains(matrix.platform, 'mac')\n        run:"),
  "disabled job": macJob.replace("    runs-on:", "    if: false\n    runs-on:"),
  "unsupported node wrapper": macJob.replace("pnpm run test:pg", "node scripts/unknown.mjs pnpm run test:pg"),
  "early successful exit": macJob.replace("pnpm run test:pg", "|\n          exit 0\n          pnpm run test:pg"),
  "here-document prose": macJob.replace("pnpm run test:pg", "|\n          cat <<'DOC'\n          pnpm run test:pg\n          DOC"),
  "multiline false and": macJob.replace("pnpm run test:pg", "|\n          false &&\n          pnpm run test:pg"),
  "inline shell condition": macJob.replace("pnpm run test:pg", "test $(uname -s) = Linux && pnpm run test:pg"),
})) {
  test(`macOS coverage refuses ${name}`, () => {
    const root = pgFixture(linuxJob + workflow);
    try { assert.deepEqual(findUncoveredTests(root), ["tests/private-pg.test.ts"]); }
    finally { rmSync(root, { recursive: true }); }
  });
}

// Unknown shell lines invalidate the entire step, including earlier commands.
for (const [name, shell] of Object.entries({
  "unknown trailing line": "pnpm run test:pg\nunknown",
  "inline false or": "false || pnpm run test:pg",
  "loop": "for item in one; do\npnpm run test:pg\ndone",
  "case": "case x in y)\npnpm run test:pg\nesac",
  "function": "f() {\npnpm run test:pg\n}",
  "continuation": "false && \\\n pnpm run test:pg",
  "unterminated subshell": "darwin_pg_status=0\n(\npnpm run test:pg",
  "nested subshell with one close": "darwin_pg_status=0\n(\n(\npnpm run test:pg\n) || darwin_pg_status=$?",
  "nested subshell": "darwin_pg_status=0\n(\n(\npnpm run test:pg\n) || darwin_pg_status=$?\n) || darwin_pg_status=$?",
  "unopened subshell": "darwin_pg_status=0\npnpm run test:pg\n) || darwin_pg_status=$?",
  "uncaptured subshell": "(\npnpm run test:pg\n) || darwin_pg_status=$?",
  "early aggregate exit": 'darwin_pg_status=0\nexit "${darwin_pg_status}"\npnpm run test:pg',
  "uninitialized aggregate exit": 'pnpm run test:pg\nexit "${darwin_pg_status}"',
  "aggregate exit inside subshell": 'darwin_pg_status=0\n(\npnpm run test:pg\nexit "${darwin_pg_status}"\n) || darwin_pg_status=$?',
  "unsafe environment assignment": "NODE_OPTIONS=--help\npnpm run test:pg",
  "test command help argument": "pnpm run test:pg --help",
})) {
  test(`macOS whole-step grammar refuses ${name}`, () => {
    const workflow = macJob.replace("pnpm run test:pg", "|\n" + shell.split("\n").map(line => "          " + line).join("\n"));
    const root = pgFixture(linuxJob + workflow);
    try { assert.deepEqual(findUncoveredTests(root), ["tests/private-pg.test.ts"]); }
    finally { rmSync(root, { recursive: true }); }
  });
}

for (const [name, shell] of Object.entries({
  "comments and blank lines": "# if Linux\n\npnpm run test:pg\n# exit 0",
  "environment and cd": "export CI=true\ncd .\nCI=true pnpm run test:pg",
  "known subshell and aggregate exit": 'darwin_pg_status=0\n(\npnpm run test:pg\n) || darwin_pg_status=$?\nexit "${darwin_pg_status}"',
  "known error capture": "darwin_pg_status=0\npnpm run test:pg || darwin_pg_status=$?",
})) {
  test(`macOS whole-step grammar accepts ${name}`, () => {
    const workflow = macJob.replace("pnpm run test:pg", "|\n" + shell.split("\n").map(line => "          " + line).join("\n"));
    const root = pgFixture(linuxJob + workflow);
    try { assert.deepEqual(findUncoveredTests(root), []); }
    finally { rmSync(root, { recursive: true }); }
  });
}
