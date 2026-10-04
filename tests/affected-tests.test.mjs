import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  affectedTestCommands,
  affectedTests,
  DEFER_MINIMUM_TEST_COUNT,
  deferralMessage,
  isDocumentationOnly,
  NODE_TEST_TIMEOUT_MS,
  noTestsAffectedMessage,
  requestedBaseRef,
  requiresPostgres,
  runAffectedTests,
  runSelectedTests,
  selectionOutputs,
  shouldDeferToFullSuite,
  skippedTestExemptions,
} from "../scripts/ci/affected-tests.mjs";
import { listTestFiles } from "../scripts/check-test-lane-coverage.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "control-room-affected-tests-"));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), contents);
  }
  return root;
}

function check(files, changed, expected) {
  const root = fixture(files);
  try { assert.deepEqual(affectedTests(root, changed), expected); }
  finally { rmSync(root, { recursive: true }); }
}

// Quick checks runs before dependency installation. These synthetic fixtures
// are plain JavaScript; keep the real test process and TAP skip detection, but
// omit the TypeScript loader that the production test plan requires.
function executePlainFixture(command, arguments_, commandRoot, environment) {
  const fixtureArguments = arguments_.filter(argument => argument !== "--import" && argument !== "tsx");
  const env = { ...environment };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(command, fixtureArguments, {
    cwd: commandRoot, encoding: "utf8", env, timeout: 10_000,
  });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  assert.equal(child.status, 0, `the fixture must run successfully before its skip count is checked: ${output}`);
  assert.match(output, /^# tests 1$/mu, "the fixture must report its one test in TAP");
  return { status: child.status, output };
}

test("a leaf change walks transitively to exactly its importing tests", () => {
  check({
    "src/leaf.ts": "export const leaf = 1;",
    "src/middle.ts": "export { leaf } from './leaf';",
    "tests/transitive.test.ts": "import { leaf } from '../src/middle';",
    "tests/unrelated.test.ts": "import assert from 'node:assert';",
  }, ["src/leaf.ts"], ["tests/transitive.test.ts"]);
});

test("a changed test selects itself", () => {
  check({ "tests/changed.test.ts": "" }, ["tests/changed.test.ts"], ["tests/changed.test.ts"]);
});

test("migrations, lockfiles, and workflows each select ALL", () => {
  for (const file of ["migrations/001.sql", "pnpm-lock.yaml", ".github/workflows/ci.yml"])
    check({ "tests/example.test.ts": "" }, [file], "ALL");
});

test("configuration, package manifests, and database paths select ALL", () => {
  for (const file of ["vite.vps.config.ts", "package.json", "db/schema.sql", "pnpm-workspace.yaml", ".npmrc", ".nvmrc"])
    check({ "tests/example.test.ts": "" }, [file], "ALL");
});

test("an asset-only change selects ALL instead of reporting a silent green", () => {
  for (const file of ["public/favicon.svg", "styles/app.css", "public/robots.txt"])
    check({ "tests/example.test.ts": "" }, [file], "ALL");
});

test("an inert docs-directory-only change declares that no tests ran", () => {
  assert.equal(isDocumentationOnly(["docs/guide.md", "docs/nested/notes.mdx"]), true);
  check({ "tests/example.test.ts": "" }, ["docs/guide.md"], "DOCS_ONLY");
  assert.match(noTestsAffectedMessage(), /documentation-only change; no tests run/u);
});

test("a docs file read by a script selects that script's importing test", () => {
  check({
    "docs/claude/SECURE_DB_ROUTE.md": "verified route evidence",
    "scripts/provision.mjs": "import { readFile } from 'node:fs/promises'; export const evidence = readFile('docs/claude/SECURE_DB_ROUTE.md');",
    "tests/provision.test.mjs": "import '../scripts/provision.mjs';",
  }, ["docs/claude/SECURE_DB_ROUTE.md"], ["tests/provision.test.mjs"]);
});

test("root markdown selects ALL because repository lanes read it", () => {
  for (const file of ["README.md", "THIRD_PARTY.md"])
    check({ "tests/example.test.ts": "" }, [file], "ALL");
});

test("the package-manager argument separator is not mistaken for the base ref", () => {
  assert.equal(requestedBaseRef(["--run", "--", "origin/main"]), "origin/main");
  assert.equal(requestedBaseRef(["--github-output", "origin/main"]), "origin/main");
});

test("ALL prepares both generated builds before launching the complete test set", () => {
  const root = fixture({ "tests/example.test.ts": "" });
  try {
    const commands = affectedTestCommands("ALL", ["tests/example.test.ts"], root);
    assert.deepEqual(commands.slice(0, 2), [
      ["pnpm", ["build"]],
      ["pnpm", ["run", "build:demo"]],
    ]);
    assert.deepEqual(commands[2][1].slice(-1), ["tests/example.test.ts"]);
  } finally { rmSync(root, { recursive: true }); }
});

test("a normal source selection prepares artifacts required by its built-output test", () => {
  const root = fixture({
    "src/leaf.ts": "export const leaf = true;",
    "tests/built.test.ts": "import '../src/leaf'; import '../dist-vps/server/index.js';",
  });
  try {
    const selected = affectedTests(root, ["src/leaf.ts"]);
    assert.deepEqual(selected, ["tests/built.test.ts"]);
    assert.deepEqual(affectedTestCommands(selected, selected, root)[0], ["pnpm", ["build"]]);
  } finally { rmSync(root, { recursive: true }); }
});

test("a selected PostgreSQL test is detected from its source marker", () => {
  const root = fixture({
    "deploy/postgres/apply.mjs": "export const apply = true;",
    "tests/postgres.test.mjs": "import '../deploy/postgres/apply.mjs'; const requiresRealPostgres = true;",
  });
  try {
    const selected = affectedTests(root, ["deploy/postgres/apply.mjs"]);
    assert.deepEqual(selected, ["tests/postgres.test.mjs"]);
    assert.equal(requiresPostgres(selected, selected, root), true);
    assert.match(selectionOutputs(selected, selected, root), /all=false\nneeds-pg=true/u);
  } finally { rmSync(root, { recursive: true }); }
});

test("a selected PostgreSQL test fails before it can skip without binaries", () => {
  const root = fixture({ "tests/postgres.test.mjs": "const requiresRealPostgres = true;" });
  const original = process.env.PG_BIN;
  process.env.PG_BIN = join(root, "missing-postgres");
  try {
    assert.equal(runAffectedTests(["tests/postgres.test.mjs"], ["tests/postgres.test.mjs"], root, () => 0), 1);
  } finally {
    if (original === undefined) delete process.env.PG_BIN;
    else process.env.PG_BIN = original;
    rmSync(root, { recursive: true });
  }
});

test("an env-gated PostgreSQL fixture cannot skip to a green result", () => {
  const root = mkdtempSync(join(process.cwd(), ".affected-tests-pg-fixture-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "postgres.test.mjs"),
    "import test from 'node:test'; const requiresRealPostgres = true; test('gate', { skip: process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL !== '1' }, () => {});");
  const original = process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL;
  delete process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL;
  try {
    assert.equal(runAffectedTests(["tests/postgres.test.mjs"], ["tests/postgres.test.mjs"], root,
      () => 0, () => true, executePlainFixture), 1);
    assert.equal(runAffectedTests(["tests/postgres.test.mjs"], ["tests/postgres.test.mjs"], root,
      () => 0, () => true, (command, args, cwd, env) => executePlainFixture(command, args, cwd,
        { ...env, CONTROL_ROOM_PG17_UPGRADE_REHEARSAL: "1" })), 0);
  } finally {
    if (original === undefined) delete process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL;
    else process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL = original;
    rmSync(root, { recursive: true });
  }
});

test("a positive skip count for a selected PostgreSQL plan fails the lane", () => {
  const root = fixture({ "tests/postgres.test.mjs": "const requiresRealPostgres = true;" });
  try {
    assert.equal(runAffectedTests(["tests/postgres.test.mjs"], ["tests/postgres.test.mjs"], root,
      () => 0, () => true, () => ({ status: 0, output: "# skipped 1\n" })), 1);
  } finally { rmSync(root, { recursive: true }); }
});

test("an unmarked env-gated test cannot skip to a green merge-gated lane", () => {
  const root = fixture({
    "tests/unset-env.test.mjs": "import test from 'node:test'; test('gate', { skip: !process.env.UNRELATED_GATE }, () => {});",
  });
  try {
    assert.equal(runAffectedTests(["tests/unset-env.test.mjs"], ["tests/unset-env.test.mjs"], root,
      () => 0, () => true, () => ({ status: 0, output: "# skipped 1\n" })), 1);
  } finally { rmSync(root, { recursive: true }); }
});

test("an explicitly exempt skipped test passes and prints its reason", () => {
  const root = fixture({ "tests/mac-local-pg17-rehearsal.test.mjs": "import test from 'node:test'; test('gate', { skip: true }, () => {});" });
  const messages = [], originalLog = console.log;
  console.log = message => messages.push(message);
  try {
    assert.equal(runAffectedTests(["tests/mac-local-pg17-rehearsal.test.mjs"], ["tests/mac-local-pg17-rehearsal.test.mjs"], root,
      () => 0, () => true, () => ({ status: 0, output: "# skipped 1\n" })), 0);
    assert.match(messages.join("\n"), /mac-local-pg17-rehearsal\.test\.mjs.*CONTROL_ROOM_MAC_REHEARSAL_ROOT/u);
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true });
  }
});

test("an exempt test that did not skip does not claim a waived skip", () => {
  const root = fixture({ "tests/mac-local-pg17-rehearsal.test.mjs": "import test from 'node:test'; test('gate', () => {});" });
  const messages = [], originalLog = console.log;
  console.log = message => messages.push(message);
  try {
    assert.equal(runAffectedTests(["tests/mac-local-pg17-rehearsal.test.mjs"], ["tests/mac-local-pg17-rehearsal.test.mjs"], root,
      () => 0, () => true, () => ({ status: 0, output: "# skipped 0\n" })), 0);
    assert.deepEqual(messages, []);
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true });
  }
});

test("every skipped-test exemption names an existing file and non-empty reason", () => {
  assert.equal(skippedTestExemptions.size, 17, "the documented exemption list must stay deliberately bounded");
  for (const [file, reason] of skippedTestExemptions) {
    assert.ok(existsSync(join(process.cwd(), file)), `exemption file must exist: ${file}`);
    assert.equal(typeof reason, "string", `exemption reason must be text: ${file}`);
    assert.ok(reason.trim().length > 0, `exemption reason must not be empty: ${file}`);
  }
});

test("the real-Codex-sandbox suite is exempted, since CI has no qualified sandbox binary to run it", () => {
  assert.ok(skippedTestExemptions.has("tests/codex-owner-trusted-local-exec.test.ts"),
    "without this exemption, selecting this file (including via an ALL/no-skip run) fails merge-gated CI " +
    "on its CONTROL_ROOM_REAL_CODEX_SANDBOX_EXECUTABLE-gated test even though nothing regressed");
});

test("a zero skip count remains green", () => {
  const root = fixture({ "tests/no-skip.test.mjs": "import test from 'node:test'; test('runs', () => {});" });
  try {
    assert.equal(runAffectedTests(["tests/no-skip.test.mjs"], ["tests/no-skip.test.mjs"], root,
      () => 0, () => true, () => ({ status: 0, output: "# skipped 0\n" })), 0);
  } finally { rmSync(root, { recursive: true }); }
});

test("a child TAP skip does not override the selected command's zero-skip summary", () => {
  const root = fixture({ "tests/runner.test.mjs": "import test from 'node:test'; test('runs', () => {});" });
  try {
    assert.equal(runAffectedTests(["tests/runner.test.mjs"], ["tests/runner.test.mjs"], root,
      () => 0, () => true, () => ({ status: 0, output: "# skipped 1\n# skipped 0\n" })), 0);
  } finally { rmSync(root, { recursive: true }); }
});

test("PostgreSQL settings are scoped to the selected PostgreSQL subprocess", () => {
  const root = fixture({
    "tests/normal.test.mjs": "",
    "tests/postgres.test.mjs": "const requiresRealPostgres = true;",
  });
  const original = process.env.CONTROL_ROOM_PG_CONCURRENCY_GATE;
  process.env.CONTROL_ROOM_PG_CONCURRENCY_GATE = "1";
  const environments = [];
  try {
    assert.equal(runAffectedTests(["tests/normal.test.mjs", "tests/postgres.test.mjs"],
      ["tests/normal.test.mjs", "tests/postgres.test.mjs"], root,
      () => 0, () => true,
      (_command, _arguments, _root, environment) => {
        environments.push(environment);
        return { status: 0, output: "" };
      }), 0);
    assert.equal(environments[0].CONTROL_ROOM_PG_CONCURRENCY_GATE, undefined);
    assert.equal(environments[1].CONTROL_ROOM_PG_CONCURRENCY_GATE, "1");
  } finally {
    if (original === undefined) delete process.env.CONTROL_ROOM_PG_CONCURRENCY_GATE;
    else process.env.CONTROL_ROOM_PG_CONCURRENCY_GATE = original;
    rmSync(root, { recursive: true });
  }
});

test("a selected migration test uses the pinned Squawk runner from migration-lint", () => {
  const root = fixture({ "tests/migration-change-check.test.mjs": "spawnSync('squawk', []);" });
  try {
    const commands = affectedTestCommands(["tests/migration-change-check.test.mjs"], ["tests/migration-change-check.test.mjs"], root);
    assert.deepEqual(commands, [["npm", ["exec", "--yes", "--package=squawk-cli@2.61.0", "--", process.execPath,
      "--import", "tsx", "--test", "--test-concurrency=1", `--test-timeout=${NODE_TEST_TIMEOUT_MS}`, "--test-reporter=tap", "tests/migration-change-check.test.mjs"]]]);
  } finally { rmSync(root, { recursive: true }); }
});

test("the runner executes every planned ALL command in order", () => {
  const root = fixture({ "tests/example.test.ts": "" });
  const executed = [], captured = [];
  try {
    const status = runAffectedTests("ALL", ["tests/example.test.ts"], root, (command, arguments_, commandRoot) => {
      executed.push([command, arguments_, commandRoot]);
      return 0;
    }, () => true, (command, arguments_, commandRoot) => {
      captured.push([command, arguments_, commandRoot]);
      return { status: 0, output: "# skipped 0\n" };
    });
    assert.equal(status, 0);
    assert.deepEqual(executed.map(call => call[0]), ["pnpm", "pnpm"]);
    assert.deepEqual(captured.map(call => call[0]), [process.execPath]);
  } finally { rmSync(root, { recursive: true }); }
});

test("a literal dynamic import is followed", () => {
  check({
    "src/lazy.ts": "export const lazy = true;",
    "tests/lazy.test.ts": "const loaded = import('../src/lazy');",
  }, ["src/lazy.ts"], ["tests/lazy.test.ts"]);
});

test("a deleted file selects its former importers without crashing", () => {
  const root = fixture({
    "src/former.ts": "export const former = true;",
    "tests/former.test.ts": "import { former } from '../src/former';",
  });
  unlinkSync(join(root, "src/former.ts"));
  try { assert.deepEqual(affectedTests(root, ["src/former.ts"]), ["tests/former.test.ts"]); }
  finally { rmSync(root, { recursive: true }); }
});

test("a circular import terminates", () => {
  check({
    "src/a.ts": "export { b } from './b';",
    "src/b.ts": "export { a } from './a';",
    "tests/circle.test.ts": "import '../src/a';",
  }, ["src/b.ts"], ["tests/circle.test.ts"]);
});

test("output is sorted deterministically", () => {
  check({
    "src/shared.ts": "export const shared = true;",
    "tests/z.test.ts": "import '../src/shared';",
    "tests/a.test.ts": "import '../src/shared';",
  }, ["src/shared.ts"], ["tests/a.test.ts", "tests/z.test.ts"]);
});

test("every node --test invocation this planner builds bounds each test file, so a hang cannot silently run to the job limit", () => {
  const root = fixture({ "tests/example.test.ts": "" });
  try {
    const commands = affectedTestCommands(["tests/example.test.ts"], ["tests/example.test.ts"], root);
    assert.ok(commands.at(-1)[1].includes(`--test-timeout=${NODE_TEST_TIMEOUT_MS}`),
      "the generic test runner needs a bound, the same way test:attack-kit already relies on one");
  } finally { rmSync(root, { recursive: true }); }
});

test("each affected test file gets its own node --test invocation, so several files can never share one timeout clock", () => {
  const root = fixture({ "tests/a.test.ts": "", "tests/b.test.ts": "", "tests/c.test.ts": "" });
  try {
    const tests = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"];
    const commands = affectedTestCommands(tests, tests, root);
    assert.equal(commands.length, 3, "bundling several files into one command lets a slow file be crowded out " +
      "by its neighbors' time, which is exactly how --test-timeout falsely killed tests/attack-kit.test.ts");
    for (const [command, arguments_] of commands) {
      assert.equal(arguments_.filter(argument => argument.endsWith(".test.ts")).length, 1,
        "a single node --test invocation must carry exactly one test file");
    }
  } finally { rmSync(root, { recursive: true }); }
});

test("the per-file node --test bound is at least as large as the largest per-test timeout override in the repository", () => {
  // tests/work-batch-assignment-gate.test.ts:315 sets `{ timeout: 600_000 }` on one test. A CLI
  // --test-timeout below that would kill that test even though it explicitly asked for more time,
  // and green CI has already measured tests/attack-kit.test.ts at ~170s (94% of the old 180000ms
  // bound), which the fix must also clear.
  const source = readFileSync(join(process.cwd(), "tests/work-batch-assignment-gate.test.ts"), "utf8");
  const largestOverrideMatch = /timeout:\s*600_000/u;
  assert.match(source, largestOverrideMatch, "this assertion is pinned to that file's actual override value");
  assert.ok(NODE_TEST_TIMEOUT_MS >= 600_000,
    "the per-file bound must cover the largest known per-test override, or that test would still be killed early");
});

test("a real slow-ish node:test run is not killed by crowding from a neighboring file, unlike the old bundled command", () => {
  const root = mkdtempSync(join(tmpdir(), "control-room-affected-tests-slow-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests/slow-a.test.mjs"), "import test from 'node:test';\nimport { setTimeout } from 'node:timers/promises';\n" +
    "test('a', async () => { await setTimeout(1200); });");
  writeFileSync(join(root, "tests/slow-b.test.mjs"), "import test from 'node:test';\nimport { setTimeout } from 'node:timers/promises';\n" +
    "test('b', async () => { await setTimeout(1200); });");
  try {
    const tests = ["tests/slow-a.test.mjs", "tests/slow-b.test.mjs"];
    // Real execution, not a mocked runner: this is the same node --test the CI job invokes.
    assert.equal(runAffectedTests(tests, tests, root, undefined, undefined, executePlainFixture), 0);
  } finally { rmSync(root, { recursive: true }); }
});

test("the ALL selection always defers to the full-suite lanes", () => {
  assert.equal(shouldDeferToFullSuite("ALL", 553), true);
  assert.equal(shouldDeferToFullSuite("ALL", 0), true);
});

test("a documentation-only selection never defers, since it already skips execution on its own", () => {
  assert.equal(shouldDeferToFullSuite("DOCS_ONLY", 553), false);
});

test("a normal small selection runs directly instead of deferring", () => {
  assert.equal(shouldDeferToFullSuite(["tests/a.test.ts"], 553), false);
});

test("a huge selection defers once it crosses both the absolute floor and half the suite", () => {
  const total = DEFER_MINIMUM_TEST_COUNT * 2;
  const huge = Array.from({ length: DEFER_MINIMUM_TEST_COUNT }, (_, index) => `tests/t${index}.test.ts`);
  assert.equal(shouldDeferToFullSuite(huge, total), true);
});

test("the absolute floor stops the ratio from firing on a small repository, such as a unit-test fixture", () => {
  assert.equal(shouldDeferToFullSuite(["tests/a.test.ts", "tests/b.test.ts"], 2), false);
});

test("a large selection under half the suite still runs directly, not deferred", () => {
  const large = Array.from({ length: DEFER_MINIMUM_TEST_COUNT + 10 }, (_, index) => `tests/t${index}.test.ts`);
  assert.equal(shouldDeferToFullSuite(large, large.length * 4), false);
});

test("a package.json-only change is the everything path: it exits fast without executing anything", () => {
  const root = fixture({ "tests/example.test.ts": "" });
  const messages = [], originalLog = console.log;
  console.log = message => messages.push(message);
  const executed = [];
  try {
    const selected = affectedTests(root, ["package.json"]);
    assert.equal(selected, "ALL");
    const tests = listTestFiles(root);
    const status = runSelectedTests(selected, tests, root, (...arguments_) => { executed.push(arguments_); return 0; },
      () => true, (...arguments_) => { executed.push(arguments_); return { status: 0, output: "" }; });
    assert.equal(status, 0);
    assert.deepEqual(executed, [], "the everything path must not execute any build or test command");
    assert.match(messages.join("\n"), /skipping direct execution/iu);
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true });
  }
});

test("a single changed source file runs only its own affected tests, never the whole repository", () => {
  const root = fixture({
    "src/leaf.ts": "export const leaf = 1;",
    "tests/transitive.test.ts": "import { leaf } from '../src/leaf';",
    "tests/unrelated.test.ts": "import assert from 'node:assert';",
  });
  const captured = [];
  try {
    const selected = affectedTests(root, ["src/leaf.ts"]);
    assert.deepEqual(selected, ["tests/transitive.test.ts"]);
    const status = runSelectedTests(selected, selected, root, () => 0, () => true,
      (command, arguments_) => { captured.push(arguments_); return { status: 0, output: "# skipped 0\n" }; });
    assert.equal(status, 0);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].filter(argument => argument.endsWith(".test.ts")), ["tests/transitive.test.ts"]);
  } finally { rmSync(root, { recursive: true }); }
});

test("a CI-workflow change selects ALL, same as any other fallback path, and the fast lane defers rather than re-running it", () => {
  const root = fixture({ "tests/example.test.ts": "" });
  try {
    const selected = affectedTests(root, [".github/workflows/ci.yml"]);
    assert.equal(selected, "ALL");
    assert.equal(shouldDeferToFullSuite(selected, listTestFiles(root).length), true);
  } finally { rmSync(root, { recursive: true }); }
});

test("the deferral message names the full-suite lanes so the log explains why nothing ran here", () => {
  assert.match(deferralMessage("ALL", 0, 553), /test-demo.*test-server.*test-components.*full-gate/su);
  assert.match(deferralMessage(["a", "b"], 2, 553), /2 of 553/u);
});

test("selectionOutputs keeps the PostgreSQL setup on during a deferral, since the lane still runs the PostgreSQL-gated subset itself", () => {
  const root = fixture({ "tests/postgres.test.mjs": "const requiresRealPostgres = true;" });
  try {
    const outputs = selectionOutputs("ALL", listTestFiles(root), root);
    assert.match(outputs, /needs-pg=true/u);
    assert.match(outputs, /defer-to-full-suite=true/u);
  } finally { rmSync(root, { recursive: true }); }
});

test("an ALL deferral still runs the PostgreSQL-gated subset directly, since no other lane sets up its environment", () => {
  const root = fixture({
    "tests/normal.test.mjs": "",
    "tests/postgres.test.mjs": "const requiresRealPostgres = true;",
  });
  const captured = [], messages = [], originalLog = console.log;
  console.log = message => messages.push(message);
  try {
    const tests = listTestFiles(root);
    const status = runSelectedTests("ALL", tests, root, () => 0, () => true,
      (command, arguments_) => { captured.push(arguments_); return { status: 0, output: "# skipped 0\n" }; });
    assert.equal(status, 0);
    assert.deepEqual(captured.flatMap(arguments_ => arguments_.filter(argument => argument.endsWith(".test.mjs"))),
      ["tests/postgres.test.mjs"], "the deferred bulk (tests/normal.test.mjs) must not re-run, but the " +
      "PostgreSQL-gated file this lane uniquely sets up an environment for must still execute");
    assert.match(messages.join("\n"), /PostgreSQL-gated/u);
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true });
  }
});

test("an env-gated PostgreSQL fixture cannot skip to a green result even when the bulk selection defers to ALL", () => {
  const root = mkdtempSync(join(process.cwd(), ".affected-tests-pg-fixture-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "postgres.test.mjs"),
    "import test from 'node:test'; const requiresRealPostgres = true; " +
    "test('gate', { skip: process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL !== '1' }, () => {});");
  const original = process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL;
  delete process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL;
  try {
    const tests = listTestFiles(root);
    assert.equal(runSelectedTests("ALL", tests, root, () => 0, () => true, executePlainFixture), 1,
      "a migration PR that defers to ALL must not get a green merge gate while the upgrade rehearsal " +
      "silently skips for want of its env var");
    assert.equal(runSelectedTests("ALL", tests, root, () => 0, () => true,
      (command, args, cwd, env) => executePlainFixture(command, args, cwd,
        { ...env, CONTROL_ROOM_PG17_UPGRADE_REHEARSAL: "1" })), 0);
  } finally {
    if (original === undefined) delete process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL;
    else process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL = original;
    rmSync(root, { recursive: true });
  }
});

test("a package.json plus a migration change still selects ALL but keeps needs-pg=true, since the lane still runs the upgrade rehearsal itself", () => {
  const root = process.cwd();
  const result = affectedTests(root, ["package.json", "db/migrations/0999_example.sql"]);
  assert.equal(result, "ALL");
  const tests = listTestFiles(root);
  const outputs = selectionOutputs(result, tests, root);
  assert.match(outputs, /needs-pg=true/u,
    "tests/mac-local-database-upgrade-pg17.test.mjs matches the PostgreSQL marker in the real repository, " +
    "so a real migration PR must still provision PostgreSQL for this lane to run it");
  assert.match(outputs, /defer-to-full-suite=true/u);
});
