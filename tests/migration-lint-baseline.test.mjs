import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkMigrations } from "../scripts/check-migration-changes.mjs";
import { ledgerDigest } from "../scripts/generate-migration-ledger.mjs";
import {
  BASELINE_PATH, selectMigrationsOutsideBaseline, validateAcceptedBaseline,
} from "../scripts/ci/migration-lint-baseline.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const checker = join(root, "scripts/check-migration-changes.mjs");
const ledgerPath = "deploy/postgres/migration-ledger.json";
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const baseline = readJson(join(root, BASELINE_PATH));
const clone = value => structuredClone(value);
function runGit(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const currentLedger = readJson(join(root, ledgerPath));
const gitDir = runGit(["rev-parse", "--absolute-git-dir"]).trim();

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "migration-lint-baseline-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, BASELINE_PATH, ".."), { recursive: true });
  cpSync(join(root, BASELINE_PATH), join(cwd, BASELINE_PATH));
  mkdirSync(join(cwd, "db/migrations"), { recursive: true });
  mkdirSync(join(cwd, "deploy/postgres"), { recursive: true });
  for (const { file } of baseline.entries) cpSync(join(root, file), join(cwd, file));
  writeJson(cwd, ledgerPath, currentLedger);
  return cwd;
}
const select = cwd => selectMigrationsOutsideBaseline({ cwd });
const options = cwd => ({ cwd, runGit, base: "HEAD", baselinePath: BASELINE_PATH });
const writeJson = (cwd, path, value) => writeFileSync(join(cwd, path), JSON.stringify(value));
const refreshDigest = value => ({ ...value, digest: ledgerDigest(value.entries) });
function addNew(cwd, name = "9999_future.sql", sql = "SELECT 1;\n") {
  const file = `db/migrations/${name}`;
  writeFileSync(join(cwd, file), sql);
  return { file, sha256: createHash("sha256").update(sql).digest("hex") };
}
function cli(cwd, args = [], env = {}) {
  return spawnSync(process.execPath, [checker, "--base", "HEAD", "--baseline", BASELINE_PATH, ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd, ...env } });
}

test("the committed baseline exactly matches the fixed applied ledger and its files", () => {
  assert.equal(baseline.appliedRevision, "d53b7e713af13a5af379004bfec5357953aa8a68");
  assert.equal(baseline.appliedLedgerDigest, "b116c38bd01e4b61549c9f2af77d0b8a049ec6ae36912f80d19e7e64fecc7a65");
  assert.equal(createHash("sha256").update(JSON.stringify(baseline.entries)).digest("hex"),
    "905557785d6bb25bf5f39dff23a1d47361ce8a75c814da6fd4340ce0765fc060");
  assert.deepEqual(validateAcceptedBaseline(baseline, currentLedger), baseline.entries);
  assert.deepEqual(select(root), currentLedger.entries.filter(entry => entry.kind === "migrate"
    && !baseline.entries.some(accepted => accepted.file === entry.file)).map(entry => entry.file).sort());
});

test("adding a migration to both the current ledger and baseline cannot silently widen acceptance", t => {
  const cwd = fixture(t);
  const added = addNew(cwd);
  const ledger = clone(currentLedger);
  ledger.entries.push({ ...added, order: ledger.entries.length + 1, kind: "migrate" });
  writeJson(cwd, ledgerPath, refreshDigest(ledger));
  assert.deepEqual(select(cwd), [added.file], "a current-ledger entry alone must not exempt new SQL");
  const widened = clone(baseline);
  widened.entries.push(added);
  writeJson(cwd, BASELINE_PATH, widened);
  assert.throws(() => select(cwd), /migration_lint_baseline_widened_or_changed/);
  const refused = cli(cwd);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /migration_lint_baseline_widened_or_changed/);
});

test("baseline refuses roles, duplicates, omissions and digest substitutions", () => {
  const variants = [
    [...baseline.entries, currentLedger.entries.find(entry => entry.kind === "grants")],
    [...baseline.entries, baseline.entries[0]],
    baseline.entries.slice(1),
    [{ ...baseline.entries[0], sha256: "0".repeat(64) }, ...baseline.entries.slice(1)],
  ];
  for (const entries of variants) {
    assert.throws(() => validateAcceptedBaseline({ ...baseline, entries }, currentLedger),
      /migration_lint_baseline_widened_or_changed/);
  }
});

test("baseline and ledger versions, the fixed revision and anchor digest fail closed", () => {
  assert.throws(() => validateAcceptedBaseline({ ...baseline, version: 2 }, currentLedger), /baseline_version/);
  assert.throws(() => validateAcceptedBaseline({ ...baseline, appliedRevision: "HEAD" }, currentLedger), /baseline_revision/);
  assert.throws(() => validateAcceptedBaseline(baseline, { ...currentLedger, version: 2 }), /ledger_version/);
  assert.throws(() => validateAcceptedBaseline(baseline, { ...currentLedger, digest: "0".repeat(64) }), /ledger_digest/);
  assert.throws(() => validateAcceptedBaseline({ ...baseline, appliedLedgerDigest: "0".repeat(64) }, currentLedger), /applied_anchor/);
});

test("accepted files must still match exactly one migrate entry in the current ledger", () => {
  for (const [change, expected] of [
    [ledger => ledger.entries.shift(), /baseline_ledger_entry/],
    [ledger => ledger.entries.push(ledger.entries[0]), /baseline_ledger_entry/],
    [ledger => { ledger.entries[0].kind = "grants"; }, /baseline_ledger_kind/],
    [ledger => { ledger.entries[0].sha256 = "0".repeat(64); }, /baseline_ledger_digest/],
  ]) {
    const ledger = clone(currentLedger);
    change(ledger);
    assert.throws(() => validateAcceptedBaseline(baseline, refreshDigest(ledger)), expected);
  }
});

test("changed and missing accepted SQL are refused even without a Git diff", t => {
  const cwd = fixture(t);
  const path = join(cwd, baseline.entries[0].file);
  const original = readFileSync(path);
  writeFileSync(path, "SELECT 1;\n");
  assert.throws(() => select(cwd), /applied_file_changed/);
  rmSync(path);
  assert.throws(() => select(cwd), /ENOENT/);
  writeFileSync(path, original);
  assert.doesNotThrow(() => select(cwd), "restoring the bytes allows a retry");
});

test("missing baseline, malformed JSON and missing current ledger refuse instead of skipping lint", t => {
  const cwd = fixture(t);
  rmSync(join(cwd, BASELINE_PATH));
  assert.throws(() => select(cwd), /ENOENT/);
  writeFileSync(join(cwd, BASELINE_PATH), "{");
  assert.throws(() => select(cwd), SyntaxError);
  writeJson(cwd, BASELINE_PATH, baseline);
  rmSync(join(cwd, ledgerPath));
  assert.throws(() => select(cwd), /ENOENT/);
});

test("baseline selection survives squash merges without reading historical Git objects", t => {
  const cwd = fixture(t);
  addNew(cwd);
  const headOnlyGit = args => {
    assert.notEqual(args[0], "show", "baseline must not depend on an old commit surviving a squash merge");
    return runGit(args);
  };
  const result = checkMigrations({ ...options(cwd), runGit: headOnlyGit, runSquawk: () => ({ status: 0 }) });
  assert.deepEqual(result.lint, ["db/migrations/9999_future.sql"]);
  assert.deepEqual(result.violations, []);
});

test("all future SQL is linted on every run, including uncommitted and already merged files", t => {
  const cwd = fixture(t);
  const first = addNew(cwd, "9998_future.sql");
  const second = addNew(cwd);
  writeFileSync(join(cwd, "db/migrations/README.txt"), "migration notes\n");
  const expected = [first.file, second.file].sort();
  assert.deepEqual(select(cwd), expected);
  // runGit reads the real repository: neither fixture file is in its diff.
  // The scanner must lint both anyway, so no merge base or commit can exempt them.
  for (let retry = 0; retry < 2; retry++) {
    let received;
    const result = checkMigrations({ ...options(cwd), runSquawk: files => { received = files; return { status: 0 }; } });
    assert.deepEqual(result.lint, expected);
    assert.deepEqual(received, expected.map(file => join(cwd, file)));
    assert.deepEqual(result.violations, []);
  }
});

test("baseline selection preserves the refusal for a later shipped migration edit", t => {
  const cwd = fixture(t);
  const added = addNew(cwd);
  const editedGit = args => {
    if (args[0] === "diff") return `M\0${added.file}\0`;
    if (args[0] === "ls-tree" && args.at(-1) === added.file) return `100644 blob ${"0".repeat(40)}\t${added.file}\0`;
    return runGit(args);
  };
  const result = checkMigrations({ ...options(cwd), runGit: editedGit, runSquawk: () => { assert.fail("shipped edits must refuse before lint"); } });
  assert.match(result.violations.join("\n"), /exists on main/);
});

test("baseline mode still refuses symlinks and nested migration directories", t => {
  for (const kind of ["link", "directory"]) {
    const cwd = fixture(t);
    const target = join(cwd, "db/migrations/9999_invalid.sql");
    if (kind === "link") symlinkSync("../../deploy/postgres/migration-ledger.json", target);
    else mkdirSync(target);
    const result = checkMigrations({ ...options(cwd), runSquawk: () => assert.fail("invalid files must refuse before lint") });
    assert.match(result.violations.join("\n"), /not a regular file/);
  }
});

test("Squawk rejection, dropped execution and stop halfway fail; a repaired retry passes", t => {
  const cwd = fixture(t);
  addNew(cwd);
  const rejected = checkMigrations({ ...options(cwd), runSquawk: () => ({ status: 1 }) });
  assert.match(rejected.violations.join("\n"), /Squawk rejected/);
  const stopped = checkMigrations({ ...options(cwd), runSquawk: () => ({ status: null, signal: "SIGTERM" }) });
  assert.match(stopped.violations.join("\n"), /Squawk rejected/);
  const dropped = checkMigrations({ ...options(cwd), runSquawk: () => ({ status: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) }) });
  assert.match(dropped.violations.join("\n"), /Squawk could not run/);
  assert.deepEqual(checkMigrations({ ...options(cwd), runSquawk: () => ({ status: 0 }) }).violations, []);
});

test("CLI requires a baseline path and refuses a missing file", t => {
  const cwd = fixture(t);
  const missingPath = spawnSync(process.execPath, [checker, "--baseline"], { cwd: root, encoding: "utf8" });
  assert.equal(missingPath.status, 1);
  assert.match(missingPath.stderr, /--baseline requires a file path/);
  const flagInsteadOfPath = spawnSync(process.execPath, [checker, "--baseline", "--base", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(flagInsteadOfPath.status, 1);
  assert.match(flagInsteadOfPath.stderr, /--baseline requires a file path/);
  rmSync(join(cwd, BASELINE_PATH));
  const missingFile = cli(cwd);
  assert.equal(missingFile.status, 1);
  assert.match(missingFile.stderr, /ENOENT/);
});

test("real Squawk rejects unsafe future SQL and a safe retry passes in baseline mode", t => {
  const cwd = fixture(t);
  addNew(cwd, "9999_future.sql", "ALTER TABLE public.base_records ADD COLUMN owner_id bigint NOT NULL;\n");
  const refused = cli(cwd);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /adding-required-field/);
  assert.match(refused.stderr, /Squawk rejected a changed migration/);
  addNew(cwd, "9999_future.sql", "CREATE TABLE public.future_records (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);\n");
  const accepted = cli(cwd);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout, /Squawk passed 1 new migration/);
});

test("50 concurrent CLI callers see the same baseline without writes or locks", async t => {
  const cwd = fixture(t);
  const before = readFileSync(join(cwd, BASELINE_PATH), "utf8");
  const results = await Promise.all(Array.from({ length: 50 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [checker, "--base", "HEAD", "--baseline", BASELINE_PATH],
      { cwd, env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  })));
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /committed lint baseline/);
  }
  assert.equal(readFileSync(join(cwd, BASELINE_PATH), "utf8"), before);
});

test("workflow uses the committed baseline and runs this selection test lane", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const job = workflow.split("\n  migration-lint:")[1].split("\n  quarantined-tests:")[0];
  assert.match(job, /npm exec --yes --package=squawk-cli@2\.61\.0 -- node --test tests\/migration-lint-baseline\.test\.mjs/);
  assert.match(job, /npm exec --yes --package=squawk-cli@2\.61\.0 -- node scripts\/check-migration-changes\.mjs --base origin\/main --baseline scripts\/ci\/migration-lint-baseline\.json/);
  assert.equal(readFileSync(join(root, ".squawk.toml"), "utf8"), 'pg_version = "17.0"\nassume_in_transaction = true\n');
});
