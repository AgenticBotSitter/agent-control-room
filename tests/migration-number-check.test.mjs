import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkMigrationNumbers,
  findDuplicateMigrationNumbers,
  listMigrationNames,
  migrationNumber,
} from "../scripts/ci/check-migration-numbers.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = join(repositoryRoot, "scripts/ci/check-migration-numbers.mjs");
const workflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");

// A copy of the real db/migrations/ directory, so a refusal is observed on the real
// tree plus one colliding file rather than on a two-file toy. The tree grows as
// migrations land, so this names no count.
function copyOfRealMigrations() {
  const root = mkdtempSync(join(tmpdir(), "control-room-migration-numbers-"));
  mkdirSync(join(root, "db"), { recursive: true });
  cpSync(join(repositoryRoot, "db/migrations"), join(root, "db/migrations"), { recursive: true });
  return root;
}

// Fixtures are numbered ABOVE every number the real tree uses, and the ceiling is read
// from the tree rather than hardcoded. Hardcoding a "currently free" number is a test
// that goes red the day a legitimate migration claims it — and 0100/0101 are exactly
// the numbers two open pull requests are already adding, so a fixture built on them
// would break on the first honest change. Reading the ceiling keeps these fixtures
// colliding with each other and with nothing real, however far the tree grows.
function ceilingMigrationNumber() {
  const numbers = listMigrationNames(join(repositoryRoot, "db/migrations"))
    .map(migrationNumber)
    .filter(number => number !== null)
    .map(Number);
  assert.ok(numbers.length > 0, "the real tree must contain numbered migrations");
  return Math.max(...numbers);
}

function freeNumberFixture(root, offset) {
  const number = String(ceilingMigrationNumber() + offset).padStart(4, "0");
  assert.match(number, /^\d{4,}$/u);
  return number;
}

function addMigration(root, name) {
  writeFileSync(join(root, "db/migrations", name), "SELECT 1;\n");
}

test("migrationNumber claims exactly four digits, and not a five-digit name's prefix", () => {
  assert.equal(migrationNumber("0100_thing.sql"), "0100");
  assert.equal(migrationNumber("0001_control_room_core.sql"), "0001");
  assert.equal(migrationNumber("00931_five_digits.sql"), null,
    "00931 is not a member of 0093's group: the applier still orders it distinctly");
  assert.equal(migrationNumber("0100"), "0100", "an extension does not change the number");
  assert.equal(migrationNumber("notes.sql"), null);
  assert.equal(migrationNumber("README"), null);
  assert.equal(migrationNumber("01000_five.sql"), null);
  assert.equal(migrationNumber("99999_nine.sql"), null);
  assert.equal(migrationNumber("0x10_hex.sql"), null, "only decimal digits are a migration number");
});

test("findDuplicateMigrationNumbers groups by number and reports every colliding file", () => {
  assert.deepEqual(findDuplicateMigrationNumbers(["0001_a.sql", "0002_b.sql", "0003_c.sql"]), []);
  assert.deepEqual(
    findDuplicateMigrationNumbers(["0100_a.sql", "0100_b.sql", "0100_c.sql"]),
    [{ number: "0100", files: ["0100_a.sql", "0100_b.sql", "0100_c.sql"] }],
  );
  assert.deepEqual(
    findDuplicateMigrationNumbers(["0093_one.sql", "0093_two.sql", "0094_three.sql"]),
    [{ number: "0093", files: ["0093_one.sql", "0093_two.sql"] }],
  );
  assert.deepEqual(findDuplicateMigrationNumbers(["0001_a.sql", "notes.txt", "README"]), [],
    "an unnumbered file is not in any group");
  assert.deepEqual(
    findDuplicateMigrationNumbers(["0093_a.sql", "00931_b.sql"]),
    [],
    "a five-digit name is a different number, not a duplicate of a four-digit one",
  );
  assert.deepEqual(
    findDuplicateMigrationNumbers(["0100_a.sql", "0100_b.md"]),
    [{ number: "0100", files: ["0100_a.sql", "0100_b.md"] }],
    "a non-.sql file cannot buy its way out of the collision: filtering on extension would be the cheapest bypass",
  );
});

test("the real db/migrations/ directory has no duplicated number, so this check passes on main", () => {
  const result = checkMigrationNumbers({ root: repositoryRoot });
  assert.equal(result.error, null);
  assert.deepEqual(result.duplicates, []);
  assert.ok(result.scanned >= 90, `expected the real migration tree, saw ${result.scanned} files`);
  assert.equal(result.ok, true);
});

test("the check refuses a duplicate number in a copy of the real tree, and names both files", () => {
  const root = copyOfRealMigrations();
  try {
    assert.equal(checkMigrationNumbers({ root }).ok, true, "the copy is clean before the collision is added");
    // 0092 is a number the real tree already uses, so this collides with a shipped
    // migration rather than with nothing. (0093 is free on main, which is exactly why
    // three separate pull requests were each able to claim it.)
    addMigration(root, "0092_a_collision_fixture.sql");
    const result = checkMigrationNumbers({ root });
    assert.equal(result.ok, false);
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0].number, "0092");
    assert.deepEqual(
      result.duplicates[0].files,
      ["0092_a_collision_fixture.sql", "0092_phase2b_mac_local_quality_profile.sql"],
      "both colliding files must be named, so the author knows which one to renumber",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the check refuses every colliding pair at once, not only the first", () => {
  const root = copyOfRealMigrations();
  try {
    const number = freeNumberFixture(root, 1);
    addMigration(root, `${number}_first_fixture.sql`);
    addMigration(root, `${number}_second_fixture.sql`);
    addMigration(root, `${number}_third_fixture.sql`);
    const result = checkMigrationNumbers({ root });
    assert.equal(result.ok, false);
    assert.deepEqual(result.duplicates.map(entry => entry.number), [number]);
    assert.equal(result.duplicates[0].files.length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two independently duplicated numbers are both reported, not just the first one", () => {
  // The single-group test above cannot catch a check that reports only its first
  // finding, which is the shape a "report everything" guard usually decays into.
  const root = copyOfRealMigrations();
  try {
    const first = freeNumberFixture(root, 1), second = freeNumberFixture(root, 2);
    addMigration(root, `${first}_third_fixture.sql`);
    addMigration(root, `${first}_fourth_fixture.sql`);
    addMigration(root, `${second}_fifth_fixture.sql`);
    addMigration(root, `${second}_sixth_fixture.sql`);
    const result = checkMigrationNumbers({ root });
    assert.equal(result.ok, false);
    assert.deepEqual(result.duplicates.map(entry => entry.number), [first, second],
      "a second, unrelated collision must not be swallowed by the first");
    assert.equal(result.duplicates[0].files.length, 2);
    assert.equal(result.duplicates[1].files.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a colliding non-SQL file in the real tree is refused, not skipped by extension", () => {
  // The directory is read, not filtered to .sql. If it were, adding a colliding file
  // with another extension would be the cheapest way to land a duplicate number while
  // the check stayed green, and a human would still read it as a duplicate.
  const root = copyOfRealMigrations();
  try {
    const number = freeNumberFixture(root, 1);
    addMigration(root, `${number}_real_fixture.sql`);
    writeFileSync(join(root, `db/migrations/${number}_notes.md`), "notes\n");
    const result = checkMigrationNumbers({ root });
    assert.equal(result.ok, false, "an extension must not buy a way around the check");
    assert.deepEqual(
      result.duplicates,
      [{ number, files: [`${number}_notes.md`, `${number}_real_fixture.sql`] }],
      "the pair is a collision whichever extension one of them carries",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a symlinked migration counts, because counting it is the safe direction", () => {
  const root = copyOfRealMigrations();
  try {
    symlinkSync(join(root, "db/migrations/0001_control_room_core.sql"), join(root, "db/migrations/0001_linked_fixture.sql"));
    const result = checkMigrationNumbers({ root });
    assert.equal(result.ok, false);
    assert.deepEqual(result.duplicates[0].files, ["0001_control_room_core.sql", "0001_linked_fixture.sql"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing migrations directory is reported as an error rather than as a clean result", () => {
  const root = mkdtempSync(join(tmpdir(), "control-room-migration-missing-"));
  try {
    const result = checkMigrationNumbers({ root });
    assert.equal(result.ok, false);
    assert.equal(result.duplicates.length, 0);
    assert.match(result.error, /cannot read db\/migrations/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the checker's own entry point reports the collision and exits non-zero", () => {
  const root = copyOfRealMigrations();
  try {
    addMigration(root, "0090_a_collision_fixture.sql");
    const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, "a duplicated number must fail the step, not warn");
    assert.match(result.stderr, /migration number check failed: 1 duplicated 4-digit number/u);
    assert.match(result.stderr, /0090_: /u, "the duplicated number must be named");
    assert.match(result.stderr, /0090_a_collision_fixture\.sql, 0090_mac_local/u,
      "both colliding files must be named, so the author knows which to renumber");
    assert.equal(result.stdout, "", "a refusal must not also print a pass line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the checker's own entry point passes on the real tree", () => {
  const result = spawnSync(process.execPath, [checker], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^migration number check passed: \d+ migration file\(s\), no duplicated 4-digit number$/mu);
});

test("both guards are wired into the quick job, so neither can be removed from CI unnoticed", () => {
  const start = workflow.indexOf("\n  quick:\n");
  const end = workflow.indexOf("\n  test-demo:\n", start);
  assert.ok(start > 0 && end > start, "the quick job must exist in the workflow");
  const job = workflow.slice(start, end);
  assert.match(job, /run: node scripts\/check-private-names\.mjs/u,
    "the private-name guard must still run in quick checks");
  assert.match(job, /run: node scripts\/ci\/check-migration-numbers\.mjs/u,
    "the migration-number check must run in quick checks");
  // The secret reaches the guard through its own named variable and nowhere else, which
  // is what lets the guard tell a configured run from an unconfigured one.
  assert.match(job, /CONTROL_ROOM_PRIVATE_NAMES: \$\{\{ secrets\.CONTROL_ROOM_PRIVATE_NAMES \}\}/u);
});
