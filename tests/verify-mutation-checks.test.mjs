import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
    test: 'node -e "const text=require(\'fs\').readFileSync(\'src/guard.mjs\',\'utf8\');process.exit(text.includes(\'allow\')?1:0)"',
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
    const path = manifest(root, { test: 'node -e "const fs=require(\'fs\');if(fs.readFileSync(\'src/guard.mjs\',\'utf8\').includes(\'allow\'))process.kill(process.pid,\'SIGTERM\')"' });
    const checks = JSON.parse(readFileSync(path, "utf8"));
    checks.push({ ...checks[0], why: "the next mutation sees a clean file" });
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
    assert.match(output(result), /::warning::This PR changes guard-like code under src\/\*\*, db\/migrations\/\*\*, or db\/roles\/\*\*/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a test that is already failing is rejected before any mutation is applied", () => {
  const root = fixture();
  try {
    const path = manifest(root, { test: 'node -e "process.exit(1)"' });
    const before = readFileSync(join(root, "src", "guard.mjs"), "utf8");
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /baseline failing with exit 1/u);
    assert.equal(readFileSync(join(root, "src", "guard.mjs"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a command-not-found exit is a configuration error, never a caught mutation", () => {
  const root = fixture();
  try {
    const path = manifest(root, { test: "mutation-check-command-does-not-exist" });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /configuration error \(exit 127\)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replacement containing dollar patterns is applied literally", () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      find: 'decision = "refuse"',
      replace: 'decision = "$&"',
      test: 'node -e "const text=require(\'fs\').readFileSync(\'src/guard.mjs\',\'utf8\');process.exit(text.includes(String.fromCharCode(36,38))?1:0)"',
    });
    const result = run(root, path);
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /mutation was caught/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a timed-out mutated command restores the file", () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      test: 'exec node -e "const fs=require(\'fs\');if(fs.readFileSync(\'src/guard.mjs\',\'utf8\').includes(\'allow\'))setInterval(()=>{},1000)"',
    });
    const before = readFileSync(join(root, "src", "guard.mjs"), "utf8");
    const result = run(root, path, { MUTATION_CHECK_TIMEOUT_MS: "50" });
    assert.equal(result.status, 1);
    assert.match(output(result), /timed out after 50ms/u);
    assert.equal(readFileSync(join(root, "src", "guard.mjs"), "utf8"), before);
    assert.equal(git(root, "status", "--porcelain=v1"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGTERM during a mutated command restores the file", async () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      test: 'exec node -e "const fs=require(\'fs\');if(fs.readFileSync(\'src/guard.mjs\',\'utf8\').includes(\'allow\'))setInterval(()=>{},1000)"',
    });
    const before = readFileSync(join(root, "src", "guard.mjs"), "utf8");
    const child = spawn(process.execPath, [verifier, path], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let transcript = "";
    child.stdout.on("data", data => { transcript += data; });
    child.stderr.on("data", data => { transcript += data; });
    await new Promise(resolveDone => {
      const ready = setInterval(() => {
        if (transcript.includes("[1] src/guard.mjs")) {
          clearInterval(ready);
          child.kill("SIGTERM");
        }
      }, 10);
      child.once("close", resolveDone);
    });
    assert.equal(readFileSync(join(root, "src", "guard.mjs"), "utf8"), before);
    assert.equal(git(root, "status", "--porcelain=v1"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping verifiers refuse the second run and preserve the target", async () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      test: 'exec node -e "const fs=require(\'fs\');if(fs.readFileSync(\'src/guard.mjs\',\'utf8\').includes(\'allow\'))setInterval(()=>{},1000)"',
    });
    const before = readFileSync(join(root, "src", "guard.mjs"), "utf8");
    const first = spawn(process.execPath, [verifier, path], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let transcript = "";
    await new Promise(resolveStarted => {
      const observe = data => {
        transcript += data;
        if (transcript.includes("[1] src/guard.mjs")) resolveStarted();
      };
      first.stdout.on("data", observe);
      first.stderr.on("data", observe);
    });
    const second = run(root, path);
    assert.equal(second.status, 1);
    assert.match(output(second), /another mutation-check verifier is already running/u);
    const finished = new Promise(resolveDone => first.once("close", resolveDone));
    first.kill("SIGTERM");
    await finished;
    assert.equal(readFileSync(join(root, "src", "guard.mjs"), "utf8"), before);
    assert.equal(git(root, "status", "--porcelain=v1"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked manifest is refused", () => {
  const root = fixture();
  try {
    const actual = join(root, "actual.json");
    writeFileSync(actual, "[]\n");
    const path = join(root, "mutation-checks", "fixture.json");
    symlinkSync(actual, path);
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /refusing symbolic-link manifest/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty replacement deletes a guard line and is caught", () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      find: 'export const decision = "refuse";\n',
      replace: "",
      test: 'node -e "const text=require(\'fs\').readFileSync(\'src/guard.mjs\',\'utf8\');process.exit(text.includes(\'refuse\')?0:1)"',
    });
    const result = run(root, path);
    assert.equal(result.status, 0, output(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the missing-manifest heuristic warns for GRANT changes under db", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "db"));
    mkdirSync(join(root, "db", "migrations"));
    writeFileSync(join(root, "db", "migrations", "001.sql"), "SELECT 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "migration");
    git(root, "branch", "base");
    writeFileSync(join(root, "db", "migrations", "001.sql"), "GRANT SELECT ON x TO y;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "grant change");
    const result = run(root, "--warn-only", { BASE_REF: "refs/heads/base" });
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /::warning::This PR changes guard-like code/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function malformedEntry(root, overrides) {
  return manifest(root, overrides);
}

test("a manifest file path cannot traverse out of the checkout", () => {
  const root = fixture();
  try {
    const path = malformedEntry(root, { file: "../outside.mjs" });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /file must stay inside the checkout/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a manifest file path cannot be absolute", () => {
  const root = fixture();
  try {
    const path = malformedEntry(root, { file: resolve(root, "src", "guard.mjs") });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /file must stay inside the checkout/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a manifest target cannot itself be a symbolic link", () => {
  const root = fixture();
  try {
    const target = join(root, "src", "target.mjs");
    writeFileSync(target, 'export const decision = "refuse";\n');
    const link = join(root, "src", "linked.mjs");
    symlinkSync(target, link);
    git(root, "add", "src/target.mjs", "src/linked.mjs");
    git(root, "commit", "-qm", "linked target");
    const path = malformedEntry(root, { file: "src/linked.mjs" });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /file must not be a symbolic link/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a manifest target cannot resolve through a symbolic-link parent", () => {
  const root = fixture();
  try {
    const outside = mkdtempSync(join(tmpdir(), "mutation-outside-"));
    writeFileSync(join(outside, "guard.mjs"), 'export const decision = "refuse";\n');
    symlinkSync(outside, join(root, "linked-parent"));
    git(root, "add", "linked-parent");
    git(root, "commit", "-qm", "linked parent");
    const path = malformedEntry(root, { file: "linked-parent/guard.mjs" });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /file must not resolve outside the checkout/u);
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a manifest target must be tracked even when Git ignores it", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, ".gitignore"), "ignored.mjs\n");
    git(root, "add", ".gitignore");
    git(root, "commit", "-qm", "ignore fixture target");
    const path = malformedEntry(root, { file: "ignored.mjs" });
    writeFileSync(join(root, "ignored.mjs"), 'export const decision = "refuse";\n');
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /file must be tracked by Git/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a manifest entry refuses extra schema fields", () => {
  const root = fixture();
  try {
    const path = malformedEntry(root, { unexpected: "value" });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /expected only file, find, replace, test, why/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a manifest entry refuses a no-op replacement", () => {
  const root = fixture();
  try {
    const path = malformedEntry(root, { replace: 'decision = "refuse"' });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /find and replace must differ/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a test-created stray file is reported distinctly after restoration", () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      test: 'node -e "const fs=require(\'fs\');const text=fs.readFileSync(\'src/guard.mjs\',\'utf8\');if(text.includes(\'allow\')){fs.writeFileSync(\'stray.txt\',\'x\');process.exit(1)}"',
    });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /test command left the checkout dirty \(stray files or edits\): stray.txt/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
