import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { repositoryTestLoaderErrors, testLoaderErrors } from "../scripts/ci/check-test-loaders.mjs";

test("every tracked package preloads tsx for TypeScript test invocations", () => {
  assert.deepEqual(repositoryTestLoaderErrors(), []);
});

test("plain node refuses TypeScript tests including TSX and glob selections", () => {
  for (const file of ["tests/case.test.ts", "tests/case.test.tsx", "tests/*.ts", "tests/case.test.mts", "tests/case.test.cts"]) {
    assert.equal(testLoaderErrors({ test: `node --test ${file}` }).length, 1);
  }
});

test("non-test commands are outside the Node test-loader check", () => {
  assert.deepEqual(testLoaderErrors({ check: "node scripts/check.ts", test: "tsx --test tests/case.test.ts" }), []);
});

test("direct node and quarantine invocations accept the same tsx preload", () => {
  for (const command of [
    "node --import tsx --test tests/case.test.ts",
    "node --import=tsx --test tests/case.test.tsx",
    "node scripts/test-wrapper.mjs --import tsx --test tests/case.test.ts",
    "node scripts/run-tests-with-quarantine.mjs --import 'tsx' --test --test-concurrency=1 tests/case.test.ts",
    'PG_BIN="${PG_BIN:-fixture}" node scripts/run-tests-with-quarantine.mjs --import tsx --test tests/case.test.ts',
  ]) assert.deepEqual(testLoaderErrors({ test: command }), []);
});

test("a preload in another chained invocation does not protect a plain node test", () => {
  for (const separator of ["&&", "||", ";", "|", "\n"]) {
    const commands = ["node --import tsx --test tests/loaded.test.ts", "node --test tests/unloaded.test.ts"];
    assert.equal(testLoaderErrors({ test: commands.join(` ${separator} `) }).length, 1);
    assert.equal(testLoaderErrors({ test: commands.reverse().join(` ${separator} `) }).length, 1);
  }
});

test("quoted shell operators stay in one invocation", () => {
  assert.deepEqual(testLoaderErrors({ test: 'node --import tsx --test "tests/a&&b.test.ts"' }), []);
  assert.equal(testLoaderErrors({ test: 'node --test "tests/a&&b.test.ts"' }).length, 1);
});

test("another loader or a preload after the test file cannot replace --import tsx", () => {
  assert.equal(testLoaderErrors({ test: "node --loader other --test tests/case.test.ts" }).length, 1);
  assert.equal(testLoaderErrors({ test: "node --test tests/case.test.ts --import tsx" }).length, 1);
});

test("JavaScript tests importing TypeScript require the preload while plain JS stays native", () => {
  const root = mkdtempSync(join(tmpdir(), "package-test-loaders-"));
  try {
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests/typed.test.mjs"), 'import { AuditStore } from "../src/audit/audit-store.ts";\n');
    writeFileSync(join(root, "tests/plain.test.mjs"), [
      'const filename = "fixture.ts";',
      'const source = \'import { Example } from "fixture.ts"\';',
      'const fixture = `',
      'import { Example } from "fixture.ts";',
      '`;',
      '/*',
      'import { Example } from "fixture.ts";',
      '*/',
    ].join("\n"));
    assert.equal(testLoaderErrors({ test: "node --test tests/typed.test.mjs" }, root).length, 1);
    assert.deepEqual(testLoaderErrors({ test: "node --import tsx --test tests/typed.test.mjs" }, root), []);
    assert.deepEqual(testLoaderErrors({ test: "node --test tests/plain.test.mjs" }, root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing JavaScript test file is a failure rather than an assumed safe import", () => {
  const root = mkdtempSync(join(tmpdir(), "package-test-loader-missing-"));
  try {
    assert.throws(() => testLoaderErrors({ test: "node --test tests/missing.test.mjs" }, root), { code: "ENOENT" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("multiline, side-effect and dynamic literal TypeScript imports are checked", () => {
  const root = mkdtempSync(join(tmpdir(), "package-test-imports-"));
  try {
    mkdirSync(join(root, "tests"));
    for (const source of [
      'import {\n AuditStore,\n} from "../src/audit/audit-store.ts";\n',
      'import "../src/setup.ts";\n',
      'const store = await import("../src/audit/audit-store.ts");\n',
      'test("load", async () => { await import("../src/audit/audit-store.ts"); });\n',
      'export { AuditStore } from "../src/audit/audit-store.ts";\n',
      'await import(`../src/audit/audit-store.ts`);\n',
    ]) {
      writeFileSync(join(root, "tests/typed.test.mjs"), source);
      assert.equal(testLoaderErrors({ test: "node --test tests/typed.test.mjs" }, root).length, 1);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the CLI rejects an unloaded nested package and accepts its repaired command", () => {
  const root = mkdtempSync(join(tmpdir(), "package-test-loader-cli-"));
  const checker = fileURLToPath(new URL("../scripts/ci/check-test-loaders.mjs", import.meta.url));
  const nested = join(root, "nested/package.json");
  const run = () => spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8", timeout: 10_000 });
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(nested, JSON.stringify({ scripts: { test: "node --test tests/case.test.ts" } }));
    execFileSync("git", ["init", "--quiet"], { cwd: root, timeout: 10_000 });
    execFileSync("git", ["add", "package.json", "nested/package.json"], { cwd: root, timeout: 10_000 });
    const refused = run();
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /nested\/package.json: test: TypeScript tests require --import tsx/);
    writeFileSync(nested, JSON.stringify({ scripts: { test: "node --import tsx --test tests/case.test.ts" } }));
    const accepted = run();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /all package TypeScript test invocations preload tsx/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
