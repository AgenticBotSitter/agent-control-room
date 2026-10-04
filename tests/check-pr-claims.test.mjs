import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPrClaims } from "../scripts/ci/check-pr-claims.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = join(repositoryRoot, "scripts/ci/check-pr-claims.mjs");
const workflow = `name: CI
jobs:
  quick:
    name: Quick checks
    runs-on: ubuntu-latest
    steps: []
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pr-claims-"));
  mkdirSync(join(root, "tests"));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, "tests/example.test.mjs"), 'test("keeps the claim honest", () => {});\n');
  writeFileSync(join(root, "tests/browser.spec.ts"), 'test("runs the browser journey", async () => {});\n');
  writeFileSync(join(root, ".github/workflows/ci.yml"), workflow);
  return root;
}

function inspect(root, body, changedPaths = ["src/server/example.ts"], workflowSource = workflow, addedPaths = changedPaths) {
  return checkPrClaims({ root, body, changedPaths, addedPaths, workflowSource });
}

test("a missing Evidence section on a src change fails", () => {
  const root = fixture();
  try {
    const result = inspect(root, "## Summary\n\nChanged the handler.");
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("evidence_section_missing"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a docs-only pull request passes without an Evidence section", () => {
  const root = fixture();
  try {
    assert.deepEqual(inspect(root, "## Summary\n\nUpdated wording.", ["docs/guide.md"]), {
      ok: true, errors: [], warnings: 0,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a pull request adding a repo-root report fails hygiene", () => {
  const root = fixture();
  try {
    const result = inspect(root, "## Summary\n\nRemoved a stray report.", ["reports/x.md"]);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("stray_report_path"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a pull request deleting an existing repo-root report passes hygiene", () => {
  const root = fixture();
  try {
    assert.deepEqual(inspect(root, "## Summary\n\nRemoved a stray report.", ["reports/x.md"], workflow, []), {
      ok: true, errors: [], warnings: 0,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a documentation guide about reports passes hygiene", () => {
  const root = fixture();
  try {
    assert.deepEqual(inspect(root, "## Summary\n\nAdded the reports guide.", ["docs/reports-guide.md"]), {
      ok: true, errors: [], warnings: 0,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing added-path result does not throw", () => {
  const root = fixture();
  try {
    assert.deepEqual(inspect(root, "## Summary\n\nThe diff was unavailable.", ["docs/guide.md"], workflow, null), {
      ok: true, errors: [], warnings: 0,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a nonexistent test reference fails", () => {
  const root = fixture();
  try {
    const body = "## Evidence\n\n- Handler rejects bad input.\n  test: tests/example.test.mjs::name that does not exist";
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("test_reference_unresolved"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a renamed CI job reference fails", () => {
  const root = fixture();
  try {
    const body = "## Evidence\n\n- The quick lane covers the change.\n  ci: Earlier quick-check name";
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("ci_reference_unresolved"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an absolute claim without an evidence line warns", () => {
  const root = fixture();
  try {
    const result = inspect(root, "## Summary\n\n- This never fails.", ["docs/guide.md"]);
    assert.equal(result.ok, true);
    assert.equal(result.warnings, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runChecker(root, base, head) {
  const event = join(root, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: {
    body: "## Summary\n\nHygiene regression.", base: { sha: base }, head: { sha: head },
  } }));
  return spawnSync(process.execPath, [checker], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_PATH: event },
  });
}

test("a body containing a configured private-name term is not echoed into logs", () => {
  const root = fixture();
  const privateTerm = "SyntheticPrivateNameForClaims";
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "fixture@example.invalid"]);
    git(root, ["config", "user.name", "Fixture"]);
    writeFileSync(join(root, "README.md"), "first\n");
    git(root, ["add", "."]); git(root, ["commit", "-qm", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(join(root, "README.md"), "second\n");
    git(root, ["add", "."]); git(root, ["commit", "-qm", "head"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const event = join(root, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: {
      body: `## Summary\n\n${privateTerm} is guaranteed.`, base: { sha: base }, head: { sha: head },
    } }));
    const result = spawnSync(process.execPath, [checker], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_PATH: event, CONTROL_ROOM_PRIVATE_NAMES: privateTerm },
    });
    assert.equal(result.status, 0, result.stderr);
    const logs = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(logs.toLowerCase(), new RegExp(privateTerm.toLowerCase()));
    assert.match(logs, /absolute claim\(s\) lack an evidence line/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real Git additions reject moved and copied reports but allow deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-claims-git-"));
  try {
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "reports"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/ci.yml"), workflow);
    writeFileSync(join(root, "docs/moved.md"), "move me\n");
    writeFileSync(join(root, "docs/copied.md"), "copy me\n");
    writeFileSync(join(root, "reports/existing.md"), "delete me\n");
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "fixture@example.invalid"]);
    git(root, ["config", "user.name", "Fixture"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);

    git(root, ["mv", "docs/moved.md", "reports/moved.md"]);
    git(root, ["commit", "-qm", "move report"]);
    const movedHead = git(root, ["rev-parse", "HEAD"]);
    const movedResult = runChecker(root, base, movedHead);
    assert.equal(movedResult.status, 1, movedResult.stderr);
    assert.match(movedResult.stderr, /stray_report_path/u);

    const copiedBase = movedHead;
    writeFileSync(join(root, "reports/copied.md"), readFileSync(join(root, "docs/copied.md")));
    git(root, ["add", "reports/copied.md"]);
    git(root, ["commit", "-qm", "copy report"]);
    const copiedHead = git(root, ["rev-parse", "HEAD"]);
    const copiedResult = runChecker(root, copiedBase, copiedHead);
    assert.equal(copiedResult.status, 1, copiedResult.stderr);
    assert.match(copiedResult.stderr, /stray_report_path/u);

    const deleteBase = copiedHead;
    git(root, ["rm", "reports/existing.md"]);
    git(root, ["commit", "-qm", "delete report"]);
    const deleteHead = git(root, ["rev-parse", "HEAD"]);
    const deleteResult = runChecker(root, deleteBase, deleteHead);
    assert.equal(deleteResult.status, 0, deleteResult.stderr);
    assert.match(deleteResult.stdout, /PR claims check passed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a very large body is rejected before its content is inspected", () => {
  const root = fixture();
  try {
    const result = inspect(root, "x".repeat(65_537), ["docs/guide.md"]);
    assert.deepEqual(result, { ok: false, errors: ["body_too_large_or_invalid"], warnings: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("command evidence without nonempty fenced output fails", () => {
  const root = fixture();
  try {
    const body = "## Evidence\n\n- The standalone check succeeds.\n  cmd: node --check scripts/example.mjs";
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("command_output_missing"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("test references cannot leave the tests tree", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "outside.test.mjs"), 'test("outside", () => {});\n');
    const body = "## Evidence\n\n- An out-of-tree test is not evidence.\n  test: tests/../outside.test.mjs::outside";
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("test_reference_unresolved"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("existing test, CI job, and fenced command output references pass", () => {
  const root = fixture();
  try {
    const body = `## Evidence

- The focused regression passes.
  test: tests/example.test.mjs::keeps the claim honest
- The workflow runs the fast guard.
  ci: Quick checks
- The standalone check succeeds.
  cmd: node --test tests/example.test.mjs
  \`\`\`text
  1 test passed
  \`\`\``;
    assert.deepEqual(inspect(root, body), { ok: true, errors: [], warnings: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("references in fenced command output are ignored and a following reference is checked", () => {
  const root = fixture();
  try {
    const body = `## Evidence

- The command completed.
  cmd: pnpm run test:unit
  \`\`\`text
  > package@1.0.0 test:unit
  ci: foo
  test: x::y
- test: x::y
  \`\`\`
- The regression remains covered.
  test: tests/example.test.mjs::keeps the claim honest`;
    assert.deepEqual(inspect(root, body), { ok: true, errors: [], warnings: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tilde and indented fences do not create evidence references", () => {
  const root = fixture();
  try {
    const body = `## Evidence

- The command completed.
  cmd: pnpm run test:unit
  ~~~console
  ci: missing job
  ~~~
- A nested command completed.
  cmd: pnpm run test:unit
    \`\`\`text
    test: x::y
    \`\`\``;
    assert.deepEqual(inspect(root, body), { ok: true, errors: [], warnings: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unclosed fence ignores the rest of its bullet and warns", () => {
  const root = fixture();
  try {
    const body = `## Evidence

- The command completed.
  cmd: pnpm run test:unit
  \`\`\`text
- test: x::y
- This line is also fenced because the fence is unclosed.
  test: tests/example.test.mjs::keeps the claim honest`;
    assert.deepEqual(inspect(root, body), { ok: true, errors: [], warnings: 0, fenceWarnings: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fence tracking is required to ignore command output references", async () => {
  const root = fixture();
  try {
    const body = `## Evidence

- The command completed.
  cmd: pnpm run test:unit
  \`\`\`text
- test: x::y
  \`\`\``;
    const source = readFileSync(join(repositoryRoot, "scripts/ci/check-pr-claims.mjs"), "utf8");
    const mutated = source.replace("if (fence) {", "if (false) {");
    const mutatedChecker = join(root, "mutated-check-pr-claims.mjs");
    writeFileSync(mutatedChecker, mutated
      .replace("../check-private-names.mjs", join(repositoryRoot, "scripts/check-private-names.mjs"))
      .replace("../../src/installer/shared/is-main-module.mjs", join(repositoryRoot, "src/installer/shared/is-main-module.mjs")));
    const module = await import(`${new URL(`file://${mutatedChecker}`).href}?mutation=${Date.now()}`);
    const result = module.checkPrClaims({ root, body, changedPaths: ["src/server/example.ts"], workflowSource: workflow });
    assert.ok(result.errors.includes("test_reference_unresolved"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a named Playwright spec is valid test evidence", () => {
  const root = fixture();
  try {
    const body = "## Evidence\n\n- The browser journey runs.\n  test: tests/browser.spec.ts::runs the browser journey";
    assert.deepEqual(inspect(root, body), { ok: true, errors: [], warnings: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prose that merely contains the word test: is not a test reference", () => {
  const root = fixture();
  try {
    // The shape from the brief: prose ending in "the new test:". The old
    // parser read "shows on a real cluster." as a test reference and failed.
    const body = `## Evidence

- The deadlock is gone, as the new test: shows on a real cluster.
  test: tests/example.test.mjs::keeps the claim honest`;
    assert.deepEqual(inspect(root, body), { ok: true, errors: [], warnings: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an inline-code package script inside a bullet is not a reference", () => {
  const root = fixture();
  try {
    // Package script and evidence on the SAME line, so the test isolates the
    // inline-code span rather than a following line's indentation. A marker
    // that is not at the start of the line is prose even when it is last.
    const body = "## Evidence\n\n- `pnpm test:database` 38/38 and `pnpm run test:attack-kit` both passed.\n  ci: Quick checks";
    assert.deepEqual(inspect(root, body), { ok: true, errors: [], warnings: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a marker at the end of a prose line is not a reference", () => {
  const root = fixture();
  try {
    const body = "## Evidence\n\n- Every lane ran, including `pnpm test:database` 38/38.  ci: Quick checks";
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("evidence_reference_missing"),
      "a mid-line marker must not count as the bullet's evidence");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a wrapped prose line that begins with a marker is still read as an item", () => {
  const root = fixture();
  try {
    // Documented trade-off: the rule is line-start, so a hard-wrapped sentence
    // whose continuation begins with "cmd:" is treated as a command reference
    // and held to the fenced-output rule. It fails closed, it does not pass.
    const body = `## Evidence

- The lock order is described in the
  cmd: paragraph below, which names no command.
  test: tests/example.test.mjs::keeps the claim honest`;
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("command_output_missing"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a DB-VERIFIED line naming a package script is not a test reference", () => {
  const root = fixture();
  try {
    // The shape from #439: `pnpm test:database` is a package script name, not
    // evidence. The old parser resolved "database; owner browser journey ..."
    // as a test reference. The line sits outside the evidence section, so the
    // real evidence item still has to be on a line of its own.
    const body = `## Evidence

- The lock order is pinned at the real database boundary.
  test: tests/example.test.mjs::keeps the claim honest

DB-VERIFIED: yes \`pnpm test:database;\` owner browser journey x3 on a real cluster.`;
    assert.deepEqual(inspect(root, body), { ok: true, errors: [], warnings: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a line-start DB-VERIFIED command bullet still needs its fenced output", () => {
  const root = fixture();
  try {
    // The line-start rule cuts both ways: a bullet that really is a command
    // reference is still held to the fenced-output rule.
    const body = `## Evidence

- Every lane ran, \`pnpm test:database\` 38/38.
  cmd: pnpm test:database`;
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("command_output_missing"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prose mentioning test: does not excuse a bullet with no evidence item", () => {
  const root = fixture();
  try {
    const body = "## Evidence\n\n- The handler was refactored, and we have a test: it should cover this.";
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("evidence_reference_missing"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a line-start test reference to a missing file still fails", () => {
  const root = fixture();
  try {
    const body = "## Evidence\n\n- test: tests/does-not-exist.test.mjs::a test that does not exist";
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("test_reference_unresolved"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a line-start test reference to a missing test name still fails", () => {
  const root = fixture();
  try {
    const body = "## Evidence\n\n- test: tests/example.test.mjs::a name that was never written";
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("test_reference_unresolved"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a line-start ci reference to an unknown job still fails", () => {
  const root = fixture();
  try {
    const body = "## Evidence\n\n- ci: A job name that was renamed away";
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("ci_reference_unresolved"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a line-start cmd reference without fenced output still fails", () => {
  const root = fixture();
  try {
    const body = "## Evidence\n\n- cmd: pnpm check";
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("command_output_missing"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a continuation reference is still recognised after prose bullets", () => {
  const root = fixture();
  try {
    // The documented house style: a prose line then an indented evidence line.
    const body = "## Evidence\n\n- The parser rejects an expired record.\n  test: tests/example.test.mjs::keeps the claim honest";
    assert.deepEqual(inspect(root, body), { ok: true, errors: [], warnings: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an out-of-tree reference on its own line still fails", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "outside.test.mjs"), 'test("outside", () => {});\n');
    const body = "## Evidence\n\n- The out-of-tree test is not evidence.\n  test: tests/../outside.test.mjs::outside";
    const result = inspect(root, body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("test_reference_unresolved"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prose containing test: does not satisfy an absolute claim", () => {
  const root = fixture();
  try {
    const result = inspect(root, "## Summary\n\n- This never fails, per `pnpm test:database`.", ["docs/guide.md"]);
    assert.equal(result.ok, true);
    assert.equal(result.warnings, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a real source change with prose false positives passes the wired checker", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-claims-wired-"));
  try {
    mkdirSync(join(root, "src/server"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/ci.yml"), workflow);
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "fixture@example.invalid"]);
    git(root, ["config", "user.name", "Fixture"]);
    writeFileSync(join(root, "src/server/example.ts"), "export const first = 1;\n");
    writeFileSync(join(root, "tests/example.test.mjs"), 'test("keeps the claim honest", () => {});\n');
    git(root, ["add", "."]); git(root, ["commit", "-qm", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(join(root, "src/server/example.ts"), "export const first = 2;\n");
    git(root, ["add", "."]); git(root, ["commit", "-qm", "head"]);
    const head = git(root, ["rev-parse", "HEAD"]);

    const body = `## Summary

- The handler now rejects the input.

## Evidence

- The regression is covered, as the new test: shows.
  test: tests/example.test.mjs::keeps the claim honest

DB-VERIFIED: yes \`pnpm test:database;\` reproduced on a disposable cluster.`;
    const event = join(root, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { body, base: { sha: base }, head: { sha: head } } }));
    const result = spawnSync(process.execPath, [checker], {
      cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_PATH: event },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PR claims check passed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restoring the whole-line reference scan makes the false-positive cases fail", async () => {
  const root = fixture();
  try {
    const proseBody = "## Evidence\n\n- The deadlock is gone, as the new test: shows on a real cluster.\n  test: tests/example.test.mjs::keeps the claim honest";
    const source = readFileSync(join(repositoryRoot, "scripts/ci/check-pr-claims.mjs"), "utf8");
    const loose = "const ref = referenceAtLineStart(line);";
    assert.ok(source.includes(loose), "update this mutation target: the parser call site moved");
    const mutated = source.replace(loose,
      'const match = /(?:^|\\s)(test|ci|cmd):\\s*(.+?)\\s*$/iu.exec(line);'
      + " const ref = match ? { type: match[1].toLowerCase(), value: match[2] } : null;");
    assert.notEqual(mutated, source);
    const mutatedChecker = join(root, "mutated-check-pr-claims.mjs");
    writeFileSync(mutatedChecker, mutated
      .replace("../check-private-names.mjs", join(repositoryRoot, "scripts/check-private-names.mjs"))
      .replace("../../src/installer/shared/is-main-module.mjs", join(repositoryRoot, "src/installer/shared/is-main-module.mjs")));
    const module = await import(`${new URL(`file://${mutatedChecker}`).href}?mutation=${Date.now()}`);
    const args = { root, body: proseBody, changedPaths: ["src/server/example.ts"], workflowSource: workflow };
    assert.deepEqual(checkPrClaims(args), { ok: true, errors: [], warnings: 0 },
      "the shipped parser ignores prose containing test:");
    const mutatedResult = module.checkPrClaims(args);
    assert.ok(mutatedResult.errors.includes("test_reference_unresolved"),
      "the whole-line scan must fail on prose containing test:");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the pull-request claims job is wired into the merge gate", () => {
  const source = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(source, /pull_request:\n    types: \[opened, synchronize, reopened, edited\]/u,
    "editing claims must trigger a fresh check");
  const start = source.indexOf("  pr-claims:");
  const end = source.indexOf("\n  quick:", start);
  assert.ok(start > 0 && end > start, "the claims job must exist before quick checks");
  const job = source.slice(start, end);
  assert.match(job, /if: \$\{\{ github\.event_name == 'pull_request' \}\}/u);
  assert.match(job, /fetch-depth: 0/u, "the base commit must be present for the changed-path diff");
  assert.match(job, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u,
    "test references must resolve against the PR head, not GitHub's merge commit");
  assert.match(job, /node scripts\/ci\/check-pr-claims\.mjs/u);
  assert.doesNotMatch(job, /secrets\./u, "body privacy must not depend on a secret");
  const gate = source.slice(source.indexOf("  merge-gate:"));
  assert.match(gate, /needs: \[[^\]]*pr-claims/u);
  assert.match(gate, /check pr-claims "\$\{\{ needs\.pr-claims\.result \}\}"/u);
});
