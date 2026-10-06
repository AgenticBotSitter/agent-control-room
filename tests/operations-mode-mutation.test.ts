// SQL guard mutations run only in disposable physical copies. A killed runner
// cannot change the checkout's migrations or its immutable release ledger.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertGuardBites, REPOSITORY_ROOT, type GuardBitesResult } from "./support/attack-kit/index";

// PG_BIN is required: the guard cases launch production-login PostgreSQL bodies.
const SUITE = "tests/operations-mode-postgres.test.ts";
const BOUND = 180_000;
const OWNER_TEST = "the owner records the mode server-side and the database refuses claims, admissions and starts";
const AUTHORITY_TEST = "a worker cannot change the mode, and the database refuses the change itself";
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Evidence = Pick<GuardBitesResult, "exitCode" | "signal" | "output">;
function requireGuardAssertion(result: Evidence, name: string, refusal: string): void {
  assert.equal(result.exitCode, 1, "the mutant must fail by assertion");
  assert.equal(result.signal, null, "a killed test is not guard evidence");
  assert.match(result.output, new RegExp(`^not ok \\d+ - ${escapeRegex(name)}$`, "m"));
  assert.match(result.output, /failureType: 'testCodeFailure'/);
  assert.match(result.output, /code: 'ERR_ASSERTION'/);
  assert.ok(result.output.includes(`Missing expected rejection: ${refusal}`),
    "the named refusal assertion must fail, after database setup and cleanup");
  // Node 22.13 reports the other name-filtered test as skipped; later 22.x
  // omits it. In either form exactly one selected body completed and failed.
  assert.match(result.output, /^# tests (?:1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0|2\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 1)\n# todo 0$/m);
}

test("mutation evidence requires a completed named assertion", () => {
  // Handwritten TAP, independent of the command/helper being checked.
  const output = `not ok 1 - fixture guard
  failureType: 'testCodeFailure'
  error: 'Missing expected rejection: fixture refusal'
  code: 'ERR_ASSERTION'
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
`;
  const valid: Evidence = { exitCode: 1, signal: null, output };
  requireGuardAssertion(valid, "fixture guard", "fixture refusal");
  requireGuardAssertion({ ...valid, output: output.replace("# tests 1", "# tests 2").replace("# skipped 0", "# skipped 1") },
    "fixture guard", "fixture refusal");
  const invalid: Evidence[] = [
    { ...valid, exitCode: 0 }, { ...valid, signal: "SIGKILL" },
    { ...valid, output: output.replace("fixture guard", "another test") },
    { ...valid, output: output.replace("testCodeFailure", "testTimeoutFailure") },
    { ...valid, output: output.replace("ERR_ASSERTION", "ERR_TEST_FAILURE") },
    { ...valid, output: output.replace("Missing expected rejection: fixture refusal", "migration_altered:fixture.sql") },
    { ...valid, output: output.replace("# tests 1", "# tests 0") },
    { ...valid, output: output.replace("# cancelled 0", "# cancelled 1") },
    { ...valid, output: output.replace("# skipped 0", "# skipped 1") },
    { ...valid, output: output.replace("# todo 0", "# todo 1") },
    { ...valid, output: output.slice(0, output.indexOf("# tests")) },
  ];
  for (const evidence of invalid) assert.throws(() => requireGuardAssertion(evidence, "fixture guard", "fixture refusal"));
  for (const [field, expected] of [["tests", 1], ["suites", 0], ["pass", 0], ["fail", 1],
    ["cancelled", 0], ["skipped", 0], ["todo", 0]] as const) {
    for (let value = 0; value <= 25; value++) {
      if (value === expected) continue;
      const changed = output.replace(`# ${field} ${expected}`, `# ${field} ${value}`);
      assert.throws(() => requireGuardAssertion({ ...valid, output: changed }, "fixture guard", "fixture refusal"));
    }
  }
});

function requireBaselineCompletion(output: string): void {
  if (!/^# tests (?:1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0|2\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1)\n# todo 0$/m.test(output))
    throw new Error("mutation_baseline_did_not_complete");
}

test("an unmutated baseline needs one completed functional body", () => {
  const output = "# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  requireBaselineCompletion(output);
  requireBaselineCompletion(output.replace("# tests 1", "# tests 2").replace("# skipped 0", "# skipped 1"));
  for (const invalid of [output.replace("# tests 1", "# tests 0"), output.replace("# pass 1", "# pass 0"),
    output.replace("# fail 0", "# fail 1"), output.replace("# cancelled 0", "# cancelled 1"),
    output.replace("# skipped 0", "# skipped 1"), output.replace("# todo 0", "# todo 1"), ""])
    assert.throws(() => requireBaselineCompletion(invalid), /mutation_baseline_did_not_complete/);
});

// Reuse only a completed baseline with exactly the same copied input bytes.
// Claim/start select the same functional body; migrating that baseline twice
// wastes a cluster and can exhaust the file budget on a slow filesystem.
const verifiedBaselines = new Set<string>();
const baselineKeyFor = (name: string, digest: string) => JSON.stringify([name, digest]);
const baselineWasVerified = (key: string) => verifiedBaselines.has(key);
async function fixtureDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (directory === "" && entry.name === "node_modules") continue; // Frozen, shared read-only dependencies.
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        const bytes = await readFile(join(root, file));
        hash.update(JSON.stringify([file, bytes.length]));
        hash.update(bytes);
      }
    }
  };
  await visit("");
  return hash.digest("hex");
}

test("baseline reuse requires the previously verified fixture bytes", async () => {
  const temporary = join(REPOSITORY_ROOT, ".test-tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, "operations-mode-baseline-proof-"));
  try {
    await mkdir(join(root, "source"));
    const file = join(root, "source", "functional.ts");
    await cp(join(REPOSITORY_ROOT, SUITE), file);
    const original = await readFile(file);
    const first = baselineKeyFor("claim fixture", await fixtureDigest(root));
    assert.equal(baselineWasVerified(first), false);
    verifiedBaselines.add(first);
    assert.equal(baselineWasVerified(baselineKeyFor("claim fixture", await fixtureDigest(root))), true);
    assert.equal(baselineWasVerified(baselineKeyFor("authority fixture", await fixtureDigest(root))), false);
    // Same name/length, different bytes must run a fresh baseline.
    const different = Buffer.from(original);
    different[0] = different[0]! ^ 1;
    await writeFile(file, different);
    assert.equal(baselineWasVerified(baselineKeyFor("claim fixture", await fixtureDigest(root))), false);
    await writeFile(file, original);
    // The path is an input too: changing the module location changes imports.
    await rename(file, join(root, "source", "renamed.ts"));
    assert.equal(baselineWasVerified(baselineKeyFor("claim fixture", await fixtureDigest(root))), false);
    await rename(join(root, "source", "renamed.ts"), file);
    await writeFile(join(root, "extra.sql"), "");
    assert.equal(baselineWasVerified(baselineKeyFor("claim fixture", await fixtureDigest(root))), false);
    await mkdir(join(root, "source", "node_modules"));
    const nested = join(root, "source", "node_modules", "module.ts");
    await writeFile(nested, "module-a");
    verifiedBaselines.add(baselineKeyFor("claim fixture", await fixtureDigest(root)));
    await writeFile(nested, "module-b");
    assert.equal(baselineWasVerified(baselineKeyFor("claim fixture", await fixtureDigest(root))), false);
  } finally {
    verifiedBaselines.clear();
    await rm(root, { recursive: true, force: true });
  }
});

async function copiedGuardBites(options: { file: string; find: string; replace: string;
  name: string; refusal: string; because: string }): Promise<void> {
  const temporary = join(REPOSITORY_ROOT, ".test-tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, "operations-mode-mutation-"));
  try {
    for (const directory of ["src", "scripts", "db", "deploy", "tests/support"]) {
      await cp(join(REPOSITORY_ROOT, directory), join(root, directory), { recursive: true, dereference: true });
    }
    await cp(join(REPOSITORY_ROOT, SUITE), join(root, SUITE));
    await cp(join(REPOSITORY_ROOT, "package.json"), join(root, "package.json"));
    // Dependencies are read-only inputs; source, SQL and ledger are real copies.
    await symlink(join(REPOSITORY_ROOT, "node_modules"), join(root, "node_modules"), "dir");
    const baselineKey = baselineKeyFor(options.name, await fixtureDigest(root));
    const command = `
      import { mkdir, writeFile } from "node:fs/promises";
      import { spawnSync } from "node:child_process";
      import { collectLedgerEntries, ledgerDigest } from "./scripts/generate-migration-ledger.mjs";
      // The shared mutation helper removes its baseline run root. Recreate it
      // before the next command; never mistake ENOENT for a guard assertion.
      await mkdir(process.env.ATTACK_KIT_RUN_ROOT, { recursive: true });
      const entries = await collectLedgerEntries();
      // This ledger authorizes a synthetic mutant fixture, never an installed
      // release or an expected security outcome. The assertion supplies that.
      await writeFile("deploy/postgres/migration-ledger.json", JSON.stringify({
        version: 1, digest: ledgerDigest(entries), entries }));
      const result = spawnSync(process.execPath, ["--import", "tsx", "--test",
        "--test-concurrency=1", "--test-reporter=tap", ${JSON.stringify(`--test-name-pattern=^${escapeRegex(options.name)}$`)},
        ${JSON.stringify(SUITE)}], { encoding: "utf8", env: process.env, maxBuffer: 1 << 24 });
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      if (result.status === 0) (${requireBaselineCompletion.toString()})(result.stdout);
      process.exit(result.status ?? 2);
    `;
    const result = await assertGuardBites({ ...options, root, allowDirtyTree: true,
      testCmd: [process.execPath, "--input-type=module", "-e", command],
      boundMs: BOUND, baselineBoundMs: BOUND, skipBaseline: baselineWasVerified(baselineKey) });
    requireGuardAssertion(result, options.name, options.refusal);
    verifiedBaselines.add(baselineKey);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("the claim guard is a real guard: removing it lets a paused installation claim work", { timeout: 420_000 },
  async () => copiedGuardBites({ file: "db/migrations/0156_installation_operations_mode_gates.sql",
    find: `  RAISE EXCEPTION 'installation operations mode % refuses a new claim', mode
    USING ERRCODE = 'object_not_in_prerequisite_state';`, replace: "  RETURN NEW;",
    name: OWNER_TEST, refusal: "paused must refuse a claim",
    because: "the paused fixture must refuse a claim even when the inserting login holds every table right" }));

test("the start guard is a real guard: removing it lets a paused installation start work", { timeout: 420_000 },
  async () => copiedGuardBites({ file: "db/migrations/0156_installation_operations_mode_gates.sql",
    find: `  RAISE EXCEPTION 'installation operations mode % refuses a new start', mode
    USING ERRCODE = 'object_not_in_prerequisite_state';`, replace: "  RETURN NEW;",
    name: OWNER_TEST, refusal: "paused must refuse a start for an already-claimed attempt",
    because: "a claim recorded while running must not start after the independent paused decision" }));

test("the owner check is a real guard: dropping it lets a non-owner record a mode", { timeout: 420_000 },
  async () => copiedGuardBites({ file: "db/migrations/0155_installation_operations_modes.sql",
    find: `  -- Only the owner's own human session writes this. A worker, an agent and the
  -- shared intake login are all refused here, not merely in the application.
  IF NOT EXISTS (`,
    replace: "  IF false AND NOT EXISTS (",
    name: AUTHORITY_TEST, refusal: "the trigger refuses a non-owner identity holding every table right",
    because: "the seeded agent identity differs from the independently granted human owner" }));
