// Independent CR-E081 oracle: literal names captured from the base revision,
// approved eight-file allocation and unchanged 240000ms package budget.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const partitions = {
  "tests/attack-kit-real-postgres.test.ts": [
    "withRealPostgres cleans up after a thrown error",
    "withRealPostgres refuses an occupied port instead of reusing a foreign cluster",
    "hands out connections as named production roles and enforces their grants",
    "does not touch a port it was not given",
    "refuses a missing or empty allowlist before probing anything"
  ],
  "tests/attack-kit-shutdown-real-postgres.test.ts": [
    "a failed pid read after a real start leaves no postmaster behind",
    "an unconfirmed shutdown preserves the data directory and fails the run",
    "a start that fails after launching a postmaster leaves nothing behind"
  ],
  "tests/attack-kit-role-refusal-real-postgres.test.ts": [
    "roleCannot catches a role that was wrongly granted",
    "isPrivilegeDenied distinguishes a refusal from any other error",
    "isPrivilegeDenied accepts 42501 only",
    "roleCannot rejects a refusal that is not a privilege refusal"
  ],
  "tests/attack-kit-search-path-gate-real-postgres.test.ts": [
    "the gate passes on the real migrations, and fails on every attack scenario",
    "an allowlisted routine passes the gate until its expiry"
  ],
  "tests/attack-kit-search-path-waiver-real-postgres.test.ts": [
    "a later migration that changes a waived routine's search_path fails the gate",
    "the gate refuses a database whose migrations were never applied"
  ],
  "tests/bounded-usage-read-postgres.test.ts": [
    "the task-detail usage read stays bounded and exact across 5,000 runs of a real job",
    "runs whose harness reported tokens but omitted the cache key still price"
  ],
  "tests/bounded-usage-pricing-postgres.test.ts": [
    "the usage aggregate never merges two runs that price differently",
    "the usage aggregate reports the same evidence precedence the per-run path does"
  ],
  "tests/bounded-usage-attempts-postgres.test.ts": [
    "the per-attempt rollup read stays bounded when a job has more attempts than the page shows"
  ]
};
const read = path => {
  assert.ok(existsSync(new URL(path, new URL("../", import.meta.url))), `required partition exists: ${path}`);
  return readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8");
};
const names = source => [...source.matchAll(/\btest\("([^"\n]+)"/gu)].map(match => match[1]);

test("CR-E081 conserves every original feature name exactly once in its partition", () => {
  const expected = Object.values(partitions).flat().sort();
  const actual = Object.entries(partitions).flatMap(([path, wanted]) => {
    const found = names(read(path)).filter(name => expected.includes(name));
    assert.deepEqual(found, wanted, `feature allocation for ${path}`);
    return found;
  }).sort();
  assert.deepEqual(actual, expected, "all 21 original feature names occur exactly once");
});

test("CR-E081 routes all eight partitions through the package lane and example", () => {
  const command = JSON.parse(read("package.json")).scripts["test:attack-kit"];
  const example = JSON.parse(read("scripts/test-runner/config.example.json"));
  // The example carries script commands in its allowedScripts map.
  assert.equal(example.allowedScripts["test:attack-kit"], command, "example mirrors the exact package command");
  const files = command.split(/\s+/u).filter(word => word.startsWith("tests/"));
  for (const path of [...Object.keys(partitions), "tests/attack-kit-lane-partitions.test.mjs"])
    assert.equal(files.filter(file => file === path).length, 1, `lane routes ${path} exactly once`);
});

test("CR-E081 retains file budgets and each partition's closing checks", () => {
  const command = JSON.parse(read("package.json")).scripts["test:attack-kit"];
  assert.match(command, /--test-timeout=240000(?:\s|$)/u, "the file timeout remains 240000ms");
  assert.match(command, /--test-concurrency=1(?:\s|$)/u, "cluster files remain serial");
  for (const [path, wanted] of Object.entries(partitions)) {
    const source = read(path);
    if (path.includes("attack-kit-")) {
      assert.equal([...source.matchAll(/const lane = await createLane\(\);/gu)].length, 1, `own lane: ${path}`);
      assert.equal([...source.matchAll(/lane\.closeLane\(/gu)].length, 1, `closing integrity checks: ${path}`);
      for (const prefix of new Set(["attack-kit-pg-", ...[...source.matchAll(/temporary\("([^"\n]+)"/gu)].map(match => match[1])]))
        assert.ok(source.slice(source.indexOf("lane.closeLane(")).includes(`"${prefix}"`), `closing prefix ${prefix}: ${path}`);
    } else {
      assert.equal([...source.matchAll(/completed \+= 1;/gu)].length, wanted.length, `completed bodies: ${path}`);
      assert.ok(source.includes(`assert.equal(completed, ${wanted.length}, "a required-but-skipped cluster test must fail the run");`), `completion guard: ${path}`);
      assert.equal([...source.matchAll(/boundMs: 240_000/gu)].length, wanted.length, `unchanged body bounds: ${path}`);
    }
    assert.ok(source.includes("PG_BIN"), `affected-test PG routing: ${path}`);
  }
  const fixture = read("tests/support/bounded-usage-fixture.ts");
  assert.doesNotMatch(fixture, /from "node:test"|\btest\(/u, "importing fixtures registers no tests");
});
