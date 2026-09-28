import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  affectedTestCommands,
  affectedTests,
  isDocumentationOnly,
  noTestsAffectedMessage,
  requestedBaseRef,
  requiresPostgres,
  runAffectedTests,
  selectionOutputs,
} from "../scripts/ci/affected-tests.mjs";

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

test("an asset-only change selects ALL instead of reporting a silent green", () => {
  for (const file of ["public/favicon.svg", "styles/app.css", "public/robots.txt"])
    check({ "tests/example.test.ts": "" }, [file], "ALL");
});

test("a docs-directory-only change declares that no tests ran", () => {
  assert.equal(isDocumentationOnly(["docs/guide.md", "docs/nested/notes.mdx"]), true);
  check({ "tests/example.test.ts": "" }, ["docs/guide.md"], "DOCS_ONLY");
  assert.match(noTestsAffectedMessage(), /documentation-only change; no tests run/u);
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

test("the runner executes every planned ALL command in order", () => {
  const executed = [];
  const status = runAffectedTests("ALL", ["tests/example.test.ts"], "/repo", (command, arguments_, root) => {
    executed.push([command, arguments_, root]);
    return 0;
  }, () => true);
  assert.equal(status, 0);
  assert.equal(executed.length, 3);
  assert.deepEqual(executed.map(call => call[0]), ["pnpm", "pnpm", process.execPath]);
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
