import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { affectedTestCommands, affectedTests, requestedBaseRef } from "../scripts/ci/affected-tests.mjs";

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

test("the package-manager argument separator is not mistaken for the base ref", () => {
  assert.equal(requestedBaseRef(["--run", "--", "origin/main"]), "origin/main");
});

test("ALL prepares both generated builds before launching the complete test set", () => {
  const commands = affectedTestCommands("ALL", ["tests/example.test.ts"]);
  assert.deepEqual(commands.slice(0, 2), [
    ["pnpm", ["build"]],
    ["pnpm", ["run", "build:demo"]],
  ]);
  assert.deepEqual(commands[2][1].slice(-1), ["tests/example.test.ts"]);
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
