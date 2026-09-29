import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const verifier = resolve("scripts/ci/verify-mutation-checks.mjs");
const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
const typescriptAvailable = (() => {
  try { createRequire(import.meta.url).resolve("typescript"); return true; } catch { return false; }
})();

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

async function interruptDuringMutation(root, path, signal, verifierPath = verifier, marker = "RUNNING MUTATED TEST [1] src/guard.mjs") {
  const child = spawn(process.execPath, [verifierPath, path], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let transcript = "";
  let sent = false;
  const status = await new Promise((resolveDone, rejectDone) => {
    const timeout = setTimeout(() => {
      // Send the intended signal, not SIGKILL: the verifier's own handler is what
      // reaps its detached mutated-test grandchild. SIGKILL can't be caught, so it
      // would skip that cleanup and leak a still-running grandchild that holds the
      // inherited stdio pipe open, hanging this process's own "close" event (and,
      // nested inside a real mutation-check run, the whole CI job) far past this
      // test's own failure.
      child.kill(signal);
      // The marker was never observed, so the verifier never reached the mutated
      // test command and never spawned its detached grandchild -- there is nothing
      // for a forceful kill to leak here. If the intended signal doesn't finish the
      // job soon (the verifier can be stuck in a slow synchronous git call under a
      // loaded CI runner), escalate so this process's "close" event -- and the
      // whole CI job -- can't hang indefinitely on it.
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("close", () => clearTimeout(forceKill));
      rejectDone(new Error(`verifier never reached ${marker}: ${transcript}`));
    }, 20_000);
    const observe = data => {
      transcript += data;
      if (!sent && transcript.includes(marker)) {
        sent = true;
        assert.match(readFileSync(join(root, "src", "guard.mjs"), "utf8"), /allow/u);
        child.kill(signal);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("close", (code, closeSignal) => {
      clearTimeout(timeout);
      resolveDone({ code, signal: closeSignal });
    });
  });
  return { ...status, sent, transcript };
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

test("an empty manifest is refused", () => {
  const root = fixture();
  try {
    const path = join(root, "mutation-checks", "empty.json");
    writeFileSync(path, "[]\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "empty manifest");
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /expected a non-empty JSON array/u);
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

test("a manifest nested below mutation-checks is ignored", () => {
  const root = fixture();
  try {
    const nested = join(root, "mutation-checks", "nested");
    mkdirSync(nested);
    const path = join(nested, "fixture.json");
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

test("A1 rejects a syntax-breaking JavaScript replacement before its test command runs", () => {
  const root = fixture();
  try {
    const path = manifest(root, { replace: 'decision = "allow";\n(', test: 'node -e "process.exit(0)"' });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /mutation does not parse/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A3 rejects a replacement that deletes a JavaScript function header", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "src", "guard.mjs"), 'export function canRun(owner) { return owner === "owner"; }\n');
    git(root, "add", "src/guard.mjs");
    git(root, "commit", "-qm", "function fixture");
    const path = manifest(root, { find: "export function canRun(owner) {", replace: "", test: 'node -e "process.exit(0)"' });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /mutation does not parse/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a syntax-breaking TypeScript replacement is refused", { skip: !typescriptAvailable }, () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "src", "guard.ts"), 'export const decision: string = "refuse";\n');
    git(root, "add", "src/guard.ts");
    git(root, "commit", "-qm", "TypeScript fixture");
    const path = manifest(root, {
      file: "src/guard.ts", find: 'decision: string = "refuse"', replace: 'decision: string = "allow";\n(', test: 'node -e "process.exit(0)"',
    });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /mutation does not parse/u);
    assert.match(output(result), /Expression expected/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valid TypeScript mutation is applied and its test is run", { skip: !typescriptAvailable }, () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "src", "guard.ts"), 'export const decision: string = "refuse";\n');
    git(root, "add", "src/guard.ts");
    git(root, "commit", "-qm", "TypeScript fixture");
    const path = manifest(root, {
      file: "src/guard.ts",
      find: 'decision: string = "refuse"',
      replace: 'decision: string = "allow"',
      test: 'node -e "const text=require(\'fs\').readFileSync(\'src/guard.ts\',\'utf8\');process.exit(text.includes(\'allow\')?1:0)"',
    });
    const result = run(root, path);
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /APPLIED MUTATION \[1\] src\/guard\.ts/u);
    assert.doesNotMatch(output(result), /mutation does not parse/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valid TSX mutation is applied and its test is run", { skip: !typescriptAvailable }, () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "src", "guard.tsx"), 'export const decision: string = "refuse";\n');
    git(root, "add", "src/guard.tsx");
    git(root, "commit", "-qm", "TSX fixture");
    const path = manifest(root, {
      file: "src/guard.tsx",
      find: 'decision: string = "refuse"',
      replace: 'decision: string = "allow"',
      test: 'node -e "const text=require(\'fs\').readFileSync(\'src/guard.tsx\',\'utf8\');process.exit(text.includes(\'allow\')?1:0)"',
    });
    const result = run(root, path);
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /APPLIED MUTATION \[1\] src\/guard\.tsx/u);
    assert.doesNotMatch(output(result), /mutation does not parse/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("broken .mts, .cts, and .json mutations are refused before their test command", { skip: !typescriptAvailable }, () => {
  for (const [file, source, find, replace] of [
    ["src/guard.mts", 'export const decision: string = "refuse";\n', 'decision: string = "refuse"', 'decision: string = "allow";\n('],
    ["src/guard.cts", 'export const decision: string = "refuse";\n', 'decision: string = "refuse"', 'decision: string = "allow";\n('],
    ["src/guard.json", '{"decision":"refuse"}\n', '"refuse"', '"allow",'],
  ]) {
    const root = fixture();
    try {
      writeFileSync(join(root, file), source);
      git(root, "add", file);
      git(root, "commit", "-qm", `fixture ${file}`);
      const path = manifest(root, { file, find, replace, test: 'node -e "process.exit(0)"' });
      const result = run(root, path);
      assert.equal(result.status, 1, `${file}: ${output(result)}`);
      assert.match(output(result), /mutation does not parse/u);
      assert.doesNotMatch(output(result), /mutation survived/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a test command that fails on a whitespace-only edit is rejected", () => {
  const root = fixture();
  try {
    const path = manifest(root, { test: 'git diff --quiet && node -e "process.exit(0)"' });
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /fails on a whitespace-only edit/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diff and source-grep test-command bypasses are rejected by text-only controls", () => {
  for (const [command, expectedProbe] of [
    ['git diff --ignore-blank-lines --quiet && node -e "process.exit(0)"', /whitespace-only/u],
    ['grep -qF \'decision = "refuse"\' src/guard.mjs && node -e "process.exit(0)"', /semantically neutral text-only/u],
    ['test "$(git diff | grep -c \'^[+-]\')" = 0 && node -e "process.exit(0)"', /whitespace-only/u],
  ]) {
    const root = fixture();
    try {
      const path = manifest(root, { test: command });
      const result = run(root, path);
      assert.equal(result.status, 1, output(result));
      assert.match(output(result), expectedProbe);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a failed baseline prevents later mutations from being applied", () => {
  const root = fixture();
  try {
    const path = manifest(root, { test: 'node -e "process.exit(1)"' });
    const checks = JSON.parse(readFileSync(path, "utf8"));
    checks.push({
      ...checks[0],
      test: 'node -e "const fs=require(\'fs\');if(fs.readFileSync(\'src/guard.mjs\',\'utf8\').includes(\'allow\'))fs.writeFileSync(\'mutation-ran.txt\',\'unexpected\')"',
      why: "later mutations do not run after a failed baseline",
    });
    writeFileSync(path, `${JSON.stringify(checks, null, 2)}\n`);
    git(root, "add", ".");
    git(root, "commit", "-qm", "two checks");
    const result = run(root, path);
    assert.equal(result.status, 1);
    assert.match(output(result), /baseline failing with exit 1/u);
    assert.equal(existsSync(join(root, "mutation-ran.txt")), false);
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

test("a timeout kills the test command's whole process group", async () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      test: "sh -c 'if grep -q allow src/guard.mjs; then (sleep 0.1; printf unexpected > orphan.txt) & wait; fi'",
    });
    const result = run(root, path, { MUTATION_CHECK_TIMEOUT_MS: "50" });
    assert.equal(result.status, 1);
    await new Promise(resolveDone => setTimeout(resolveDone, 200));
    assert.equal(existsSync(join(root, "orphan.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a normal test-command exit kills its background child", async () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      test: "sh -c '(sleep 0.1; printf unexpected > background.txt) & grep -q refuse src/guard.mjs'",
    });
    const result = run(root, path);
    assert.equal(result.status, 0, output(result));
    await new Promise(resolveDone => setTimeout(resolveDone, 200));
    assert.equal(existsSync(join(root, "background.txt")), false);
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
    const result = await interruptDuringMutation(root, path, "SIGTERM");
    assert.equal(result.sent, true, result.transcript);
    assert.equal(result.code, 1, result.transcript);
    assert.equal(readFileSync(join(root, "src", "guard.mjs"), "utf8"), before);
    assert.equal(git(root, "status", "--porcelain=v1"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGINT during a mutated command restores the file", async () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      test: 'exec node -e "const fs=require(\'fs\');if(fs.readFileSync(\'src/guard.mjs\',\'utf8\').includes(\'allow\'))setInterval(()=>{},1000)"',
    });
    const before = readFileSync(join(root, "src", "guard.mjs"), "utf8");
    const result = await interruptDuringMutation(root, path, "SIGINT");
    assert.equal(result.sent, true, result.transcript);
    assert.equal(result.code, 1, result.transcript);
    assert.equal(readFileSync(join(root, "src", "guard.mjs"), "utf8"), before);
    assert.equal(git(root, "status", "--porcelain=v1"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting the SIGINT handler fails the mutated-run restoration test", async () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      test: 'exec node -e "setTimeout(() => process.exit(0), 1000)"',
    });
    const mutant = join(root, "verify-mutation-checks-no-sigint.mjs");
    writeFileSync(mutant, readFileSync(verifier, "utf8").replace(
      /process\.on\("SIGINT",(?:\s|\/\*.*?\*\/)*\(\) => restoreOnSignal\("SIGINT"\)\);\n/u,
      "",
    ));
    git(root, "add", mutant);
    git(root, "commit", "-qm", "SIGINT-handler mutant");
    const result = await interruptDuringMutation(root, path, "SIGINT", mutant);
    assert.equal(result.sent, true, result.transcript);
    assert.notEqual(readFileSync(join(root, "src", "guard.mjs"), "utf8"), 'export const decision = "refuse";\n');
    git(root, "restore", "--", "src/guard.mjs");
    await new Promise(resolveDone => setTimeout(resolveDone, 1_100));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent verifiers refuse the second run on the first run's dirty tree", async () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      test: 'exec node -e "const fs=require(\'fs\');if(fs.readFileSync(\'src/guard.mjs\',\'utf8\').includes(\'allow\'))setInterval(()=>{},1000)"',
    });
    const before = readFileSync(join(root, "src", "guard.mjs"), "utf8");
    const first = spawn(process.execPath, [verifier, path], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolveStarted, rejectStarted) => {
      const startedAt = Date.now();
      const ready = setInterval(() => {
        if (readFileSync(join(root, "src", "guard.mjs"), "utf8").includes("allow")) {
          clearInterval(ready);
          resolveStarted();
        } else if (Date.now() - startedAt > 5_000) {
          clearInterval(ready);
          rejectStarted(new Error("first verifier did not apply its mutation"));
        }
      }, 10);
    });
    const second = run(root, path);
    assert.equal(second.status, 1);
    assert.match(output(second), /refusing to run on a dirty Git checkout; restore the changed files before retrying/u);
    const finished = new Promise(resolveDone => first.once("close", resolveDone));
    first.kill("SIGTERM");
    await finished;
    assert.equal(readFileSync(join(root, "src", "guard.mjs"), "utf8"), before);
    assert.equal(git(root, "status", "--porcelain=v1"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verifier runs green in a linked worktree", () => {
  const root = fixture();
  const linked = mkdtempSync(join(tmpdir(), "mutation-linked-worktree-"));
  rmSync(linked, { recursive: true, force: true });
  try {
    manifest(root);
    git(root, "worktree", "add", "--detach", linked);
    const result = run(linked, join(linked, "mutation-checks", "fixture.json"));
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /All 1 mutation check\(s\) were caught/u);
  } finally {
    if (existsSync(linked)) git(root, "worktree", "remove", "--force", linked);
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL leaves only a dirty target, which can be restored without a wedged verifier", async () => {
  const root = fixture();
  try {
    const path = manifest(root, {
      test: 'exec node -e "const fs=require(\'fs\');if(fs.readFileSync(\'src/guard.mjs\',\'utf8\').includes(\'allow\'))setInterval(()=>{},1000)"',
    });
    const child = spawn(process.execPath, [verifier, path], { cwd: root, detached: true, stdio: "ignore" });
    child.unref();
    await new Promise((resolveStarted, rejectStarted) => {
      const startedAt = Date.now();
      const ready = setInterval(() => {
        if (readFileSync(join(root, "src", "guard.mjs"), "utf8").includes("allow")) {
          clearInterval(ready);
          resolveStarted();
        } else if (Date.now() - startedAt > 5_000) {
          clearInterval(ready);
          rejectStarted(new Error("verifier did not apply the mutation"));
        }
      }, 10);
    });
    process.kill(-child.pid, "SIGKILL");
    await new Promise(resolveDone => setTimeout(resolveDone, 50));
    const blocked = run(root, path);
    assert.equal(blocked.status, 1);
    assert.match(output(blocked), /dirty Git checkout; restore the changed files before retrying/u);
    assert.equal(existsSync(join(root, ".git", "mutation-checks.lock")), false);
    git(root, "restore", "--", "src/guard.mjs");
    const restoredManifest = manifest(root);
    const result = run(root, restoredManifest);
    assert.equal(result.status, 0, output(result));
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

test("the self-manifest runs behavioral tests without the source-drift meta-test", () => {
  const entries = JSON.parse(readFileSync("mutation-checks/codex-ci-mutation-check.json", "utf8"));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.match(entry.test, /--test-skip-pattern='declared manifests name unique, tracked source snippets'/u);
    assert.match(entry.test, /tests\/verify-mutation-checks\.test\.mjs/u);
  }
});

test("declared manifests name unique, tracked source snippets", () => {
  for (const name of readdirSync("mutation-checks").filter(entry => entry.endsWith(".json"))) {
    const manifestPath = join("mutation-checks", name);
    const entries = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const entry of entries) {
      const source = readFileSync(entry.file, "utf8");
      const matches = source.split(entry.find).length - 1;
      assert.equal(matches, 1, `${manifestPath}: ${entry.file} find must occur exactly once`);
      const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", entry.file], { encoding: "utf8" });
      assert.equal(tracked.status, 0, `${manifestPath}: ${entry.file} must be tracked`);
    }
  }
});
