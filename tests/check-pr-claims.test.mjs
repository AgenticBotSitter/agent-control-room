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

function inspect(root, body, changedPaths = ["src/server/example.ts"], workflowSource = workflow) {
  return checkPrClaims({ root, body, changedPaths, workflowSource });
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
    writeFileSync(mutatedChecker, mutated.replace("../check-private-names.mjs", join(repositoryRoot, "scripts/check-private-names.mjs")));
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
