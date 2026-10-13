import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
// Independent ticket inventory and literal workflow command, not checker exports.
const files = ["tests/result-file-catalog-postgres.test.ts", "tests/result-file-download-postgres.test.ts",
  "tests/result-file-upload-race-postgres.test.ts", "tests/result-upload-store-postgres.test.ts",
  "tests/text-copy-derivation-postgres.test.ts"];
const command = "node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 tests/result-file-catalog-postgres.test.ts tests/result-file-download-postgres.test.ts tests/result-file-upload-race-postgres.test.ts tests/result-upload-store-postgres.test.ts tests/text-copy-derivation-postgres.test.ts";
function fixedWorkflow(first = command, second = command) {
  return `jobs:
  test-updater:
    runs-on: macos-26
    steps:
      - run: |
          ${first}
  full-gate:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        include:
          - lane: updater
            runner: macos-26
    steps:
      - if: matrix.lane == 'updater'
        run: |
          ${second}
`;
}
function pgFixture(workflow, tests = files, source = darwinPgSource) {
  return fixture({ scripts: { "test:pg": "node --test " + tests.join(" ") },
    workflow: workflow + "  linux:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run test:pg\n",
    tests, sources: Object.fromEntries(tests.map(file => [file, source])) });
}

test("Darwin-only PostgreSQL file missing from fixed list fails", () => {
  for (const source of [darwinPgSource,
    "withRealPostgres(() => {}); if (!KERNEL_OPEN_LOCK_HOST_V1) { return; }",
    "withRealPostgres(() => {}); seatbeltTest('pg', () => {});",
    "const PG_BIN = '/pg'; const isMac = process.platform === 'darwin'; test('pg', { skip: !isMac }, () => {});",
    "withRealPostgres(); if ('darwin' !== process.platform) return;",
  ]) {
    const root = pgFixture(fixedWorkflow() + "  other-mac:\n    runs-on: macos-26\n    steps:\n      - run: pnpm run test:pg\n",
      ["tests/private-pg.test.ts"], source);
    try { assert.deepEqual(findUncoveredTests(root), ["tests/private-pg.test.ts"]); }
    finally { rmSync(root, { recursive: true }); }
  }
});

for (const [job, first, second] of [
  ["test-updater", "true", command], ["full-gate", command, "true"],
]) {
  test(`exact Darwin PostgreSQL command missing from ${job} fails`, () => {
    // Even another macOS job with the command cannot replace the named path.
    const root = pgFixture(fixedWorkflow(first, second)
      + `  other-mac:\n    runs-on: macos-26\n    steps:\n      - run: |\n          ${command}\n`);
    try { assert.deepEqual(findUncoveredTests(root), files.slice().sort()); }
    finally { rmSync(root, { recursive: true }); }
  });
}

test("exact Darwin PostgreSQL command present in both paths passes", () => {
  for (const workflow of [fixedWorkflow(), readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")]) {
    const root = pgFixture(workflow);
    try { assert.deepEqual(findUncoveredTests(root), []); }
    finally { rmSync(root, { recursive: true }); }
  }
});

for (const job of ["test-updater", "full-gate"]) {
  test(`editing Darwin PostgreSQL command in ${job} fails verbatim check`, () => {
    for (const changed of [command.replace("--import tsx", "--help --import tsx"),
      command.replace("--import tsx", "--test-name-pattern=unmatched --import tsx"),
      command.replace("--import tsx", "--import  tsx"), command + " --help"]) {
      const root = pgFixture(job === "test-updater" ? fixedWorkflow(changed, command) : fixedWorkflow(command, changed));
      try { assert.deepEqual(findUncoveredTests(root), files.slice().sort()); }
      finally { rmSync(root, { recursive: true }); }
    }
  });
}

test("portable PostgreSQL and non-database Darwin wrappers retain ordinary coverage", () => {
  for (const source of ["withRealPostgres(() => {});", "kernelOpenLockTestV1('unit', () => {});"]) {
    const root = pgFixture(fixedWorkflow(), ["tests/private-pg.test.ts"], source);
    try { assert.deepEqual(findUncoveredTests(root), []); }
    finally { rmSync(root, { recursive: true }); }
  }
});

test("portable platform paths and fixture strings do not claim Darwin-only PostgreSQL", () => {
  for (const source of [
    "const PG_BIN = '/pg'; const root = process.platform === 'darwin' ? '/private/tmp' : tmpdir();",
    "const fixture = \"withRealPostgres(); if (process.platform !== 'darwin') return;\";",
    "// withRealPostgres(); if (process.platform !== 'darwin') return;",
  ]) {
    const root = pgFixture(fixedWorkflow(), ["tests/private-pg.test.ts"], source);
    try { assert.deepEqual(findUncoveredTests(root), []); }
    finally { rmSync(root, { recursive: true }); }
  }
});

// Legacy lanes are independent literals captured from the existing workflow.
const legacyFiles = ["tests/pg-runtime-copy-stress.test.ts", "tests/test-runner-service.test.mjs"];
const legacyCommand = "node scripts/ci/run-scripts-keep-going.mjs test:updater test:updater-schema test:updater-passkey-postgres test:pg-runtime-postgres test:pg-runtime-stress test:test-runner || darwin_pg_status=$?";
function legacyWorkflow(first = legacyCommand, second = legacyCommand) {
  return fixedWorkflow(command + "\n          " + first, command + "\n          " + second);
}
for (const file of legacyFiles) {
  test(`legacy Darwin PostgreSQL ${file} in fixed map passes`, () => {
    const root = pgFixture(legacyWorkflow(), [file]);
    try { assert.deepEqual(findUncoveredTests(root), []); }
    finally { rmSync(root, { recursive: true }); }
  });
  test(`legacy Darwin PostgreSQL ${file} missing from map is refused`, async () => {
    // Load a disposable checker with just this map key absent. Imports still
    // use the real helpers; no alternate coverage implementation is supplied.
    const url = new URL("../scripts/check-test-lane-coverage.mjs", import.meta.url);
    const source = readFileSync(url, "utf8")
      .replace(`  "${file}": DARWIN_LEGACY_COMMAND,\n`, "")
      .replace(/from "(\.\.?\/[^"]+)"/gu, (_, relative) => `from "${new URL(relative, url).href}"`);
    const root = pgFixture(legacyWorkflow(), [file]);
    try {
      const path = join(root, "checker.mjs");
      writeFileSync(path, source);
      const checker = await import(pathToFileURL(path).href);
      assert.deepEqual(checker.findUncoveredTests(root), [file]);
    }
    finally { rmSync(root, { recursive: true }); }
  });
  for (const job of ["test-updater", "full-gate"]) {
    for (const mode of ["missing", "edited"]) {
      test(`legacy command ${mode} in ${job} refuses ${file}`, () => {
        const variants = mode === "missing" ? ["true"] : [
          legacyCommand.replace("test:pg-runtime-stress", "test:pg-runtime-stress-typo"),
          legacyCommand.replace("test:test-runner", "test:test-runner-typo"),
          legacyCommand + " # edited",
          legacyCommand.replace(" test:updater ", "  test:updater "),
        ];
        for (const changed of variants) {
          const root = pgFixture(job === "test-updater" ? legacyWorkflow(changed) : legacyWorkflow(legacyCommand, changed), [file]);
          try { assert.deepEqual(findUncoveredTests(root), [file]); }
          finally { rmSync(root, { recursive: true }); }
        }
      });
    }
  }
}
test("real seven-file Darwin PostgreSQL workflow passes", () => {
  assert.deepEqual(findUncoveredTests(fileURLToPath(new URL("..", import.meta.url))), []);
});
