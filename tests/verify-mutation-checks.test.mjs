import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const verifier = resolve("scripts/ci/verify-mutation-checks.mjs");
const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mutation-checks-"));
  mkdirSync(join(root, "mutation-checks"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "guard.mjs"), 'export const decision = "refuse";\n');
  git(root, "init", "-q");
  git(root, "config", "user.name", "CI Test");
  git(root, "config", "user.email", "ci@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}

function manifest(root, overrides = {}) {
  const value = [{
    file: "src/guard.mjs",
    find: 'decision = "refuse"',
    replace: 'decision = "allow"',
    test: 'node -e "process.exit(1)"',
    why: "the refusal must be enforced",
    ...overrides,
  }];
  const path = join(root, "mutation-checks", "fixture.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  git(root, "add", ".");
  git(root, "commit", "-qm", "manifest");
  return path;
}

function run(root, path, env = {}) {
  return spawnSync(process.execPath, [verifier, path], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

test("a surviving mutation fails and names the check", () => {
  const root = fixture();
  try {
    const path = manifest(root, { test: 'node -e "process.exit(0)"' });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /src\/guard\.mjs — the refusal must be enforced/u);
    assert.match(output(result), /mutation survived/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("find must match exactly once, rejecting both zero and multiple matches", () => {
  for (const [find, count] of [["missing text", 0], ['"', 2]]) {
    const root = fixture();
    try {
      const path = manifest(root, { find });
      const result = run(root, path);
      assert.equal(result.status, 1);
      assert.match(output(result), new RegExp(`matched ${count} times; expected exactly once`, "u"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a crashed test is caught, reported distinctly, and restores a clean checkout", () => {
  const root = fixture();
  try {
    const path = manifest(root, { test: 'node -e "process.kill(process.pid, \'SIGTERM\')"' });
    const checks = JSON.parse(readFileSync(path, "utf8"));
    checks.push({ ...checks[0], test: 'node -e "process.exit(1)"', why: "the next mutation sees a clean file" });
    writeFileSync(path, `${JSON.stringify(checks, null, 2)}\n`);
    git(root, "add", ".");
    git(root, "commit", "-qm", "second mutation");
    const before = readFileSync(join(root, "src", "guard.mjs"), "utf8");
    const result = run(root, path);
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /crashed with signal SIGTERM/u);
    assert.match(output(result), /\[2\] src\/guard\.mjs — the next mutation sees a clean file/u);
    assert.equal(readFileSync(join(root, "src", "guard.mjs"), "utf8"), before);
    assert.equal(git(root, "status", "--porcelain=v1"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verifier refuses a dirty checkout without applying a mutation", () => {
  const root = fixture();
  try {
    const path = manifest(root);
    writeFileSync(join(root, "uncommitted.txt"), "do not remove\n");
    const before = readFileSync(join(root, "src", "guard.mjs"), "utf8");
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /refusing to run on a dirty Git checkout/u);
    assert.equal(readFileSync(join(root, "src", "guard.mjs"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed manifest fails with a clear message", () => {
  const root = fixture();
  try {
    const path = join(root, "mutation-checks", "broken.json");
    writeFileSync(path, "{ definitely not json\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "broken manifest");
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /malformed manifest mutation-checks\/broken\.json/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manifest path outside mutation-checks is ignored", () => {
  const root = fixture();
  try {
    const path = join(root, "outside.json");
    writeFileSync(path, "not json\n");
    const result = run(root, path);
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /Ignoring manifest outside mutation-checks\//u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the missing-manifest heuristic warns only for changed guard-like src lines", () => {
  const root = fixture();
  try {
    git(root, "branch", "base");
    writeFileSync(join(root, "src", "guard.mjs"), 'export function authorize() { return true; }\n');
    git(root, "add", ".");
    git(root, "commit", "-qm", "guard-like change");
    const result = spawnSync(process.execPath, [verifier, "--warn-only"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, BASE_REF: "refs/heads/base" },
    });
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /::warning::This PR changes guard-like code under src\/\*\*/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CI job gates verification on a branch manifest and joins the merge gate", () => {
  const start = workflow.indexOf("  mutation-checks:");
  const end = workflow.indexOf("\n  quick:", start);
  assert.ok(start > 0 && end > start, "the mutation-checks job must appear before quick checks");
  const job = workflow.slice(start, end);
  assert.match(job, /name: Mutation checks/u);
  assert.match(job, /fetch-depth: 0/u);
  assert.match(job, /if: steps\.manifest\.outputs\.exists == 'true'/u);
  assert.match(job, /--warn-only/u);
  assert.doesNotMatch(job, /secrets\./u);
  const gate = workflow.slice(workflow.indexOf("  merge-gate:"));
  assert.match(gate, /needs: \[[^\]]*mutation-checks/u);
  assert.match(gate, /check mutation-checks/u);
});
