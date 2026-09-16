import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Importing the script via a child-process wrapper so we exercise the CLI surface,
// not just the internal helper. The script resolves `import.meta.url` at module
// load, so we spawn it from the real scripts/ tree rather than copying.
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = join(repoRoot, "scripts", "windows", "check-windows-line-endings.mjs");

function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    // Force LF-only behavior for the test fixture so we can synthesize CRLF in
    // a controlled way. Production repos pin this via `.gitattributes`.
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

// Disposable fixture creation is itself wrapped in owned cleanup: if any
// setup step throws, the half-built directory is removed before the error
// propagates, so a setup exception can never strand the temporary directory.
function withFixtureRepo(build, fn) {
  const root = mkdtempSync(join(tmpdir(), "windows-line-endings-"));
  try {
    build(root);
    return fn(root);
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function initRepo(root) {
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
}

function allLfRepo(root) {
  initRepo(root);
  // Pin LF so CRLF is introduced explicitly per file below.
  writeFileSync(join(root, ".gitattributes"), "* text=auto eol=lf\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/lf.ts"), "const a = 1\nconst b = 2\n");
  writeFileSync(join(root, "src/ok.ts"), "const x = 1\n");
  git(root, ["add", ".gitattributes", "src/lf.ts", "src/ok.ts"]);
  git(root, ["commit", "--quiet", "-m", "init"]);
}

function crlfRepo(root) {
  allLfRepo(root);
  // Tracked CRLF bytes (committed LF, converted on checkout is impossible
  // with eol=lf, so write raw CRLF and force-add: the worktree keeps CRLF).
  writeFileSync(join(root, "src/crlf.ts"), "const y = 1\r\nconst z = 2\r\n");
  git(root, ["add", "src/crlf.ts"]);
  git(root, ["commit", "--quiet", "-m", "crlf"]);
  // Rewrite the worktree file back to CRLF after commit normalization.
  writeFileSync(join(root, "src/crlf.ts"), "const y = 1\r\nconst z = 2\r\n");
}

function mixedRepo(root) {
  initRepo(root);
  // `-text` disables all conversion so the committed mixed bytes survive
  // checkout untouched; Git reports the worktree flag as `w/mixed`.
  writeFileSync(join(root, ".gitattributes"), "*.bin -text\n");
  writeFileSync(join(root, "clean.ts"), "const a = 1\n");
  writeFileSync(join(root, "data.bin"), "line-one\nline-two\r\nline-three\r\n");
  git(root, ["add", ".gitattributes", "clean.ts", "data.bin"]);
  git(root, ["commit", "--quiet", "-m", "init"]);
}

test("ok when every tracked text file is LF", () => {
  withFixtureRepo(allLfRepo, (root) => {
    const proc = runScript([root]);
    try {
      assert.equal(proc.status, 0, `expected exit 0, got ${proc.status}\nstdout: ${proc.stdout}\nstderr: ${proc.stderr}`);
      assert.match(proc.stdout, /^ok: \d+ tracked files, all LF\n$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("reports CRLF files by exact path and exits corrupt (3)", () => {
  withFixtureRepo(crlfRepo, (root) => {
    const proc = runScript([root]);
    try {
      assert.equal(proc.status, 3, `expected exit 3, got ${proc.status}`);
      assert.match(proc.stdout, /^bad-endings: 1 tracked files use CRLF or mixed endings in worktree\n/);
      // The reported path must be exactly the repo-relative path — no
      // `attr/...` field text may leak into it.
      const reported = proc.stdout.split("\n").filter((l) => l.startsWith("  "));
      assert.deepEqual(reported, ["  w/crlf src/crlf.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("rejects w/mixed worktree content and exits corrupt (3)", () => {
  withFixtureRepo(mixedRepo, (root) => {
    const eol = git(root, ["ls-files", "--eol"]);
    assert.match(eol.stdout, /w\/mixed/, "fixture must actually produce w/mixed");
    const proc = runScript([root]);
    try {
      assert.equal(proc.status, 3, `expected exit 3, got ${proc.status}\nstdout: ${proc.stdout}`);
      const reported = proc.stdout.split("\n").filter((l) => l.startsWith("  "));
      assert.deepEqual(reported, ["  w/mixed data.bin"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("missing repo-root arg exits unavailable_platform (4)", () => {
  const proc = runScript([]);
  assert.equal(proc.status, 4);
  assert.match(proc.stderr, /usage:/);
});

test("non-absolute repo-root exits unavailable_platform (4)", () => {
  const proc = runScript(["./relative/path"]);
  assert.equal(proc.status, 4);
  assert.match(proc.stderr, /must be an absolute path/);
});

test("non-existent repo-root exits unavailable_platform (4)", () => {
  const proc = runScript(["/opt/data/does-not-exist-windows-lf-probe"]);
  assert.equal(proc.status, 4);
  assert.match(proc.stderr, /does not exist/);
});

test("fixture setup failure still removes the half-built directory", () => {
  const marker = "windows-line-endings-";
  const before = new Set(readdirSync(tmpdir()).filter((e) => e.startsWith(marker)));
  assert.throws(() => withFixtureRepo(() => { throw new Error("boom"); }, () => {}), /boom/);
  const leaked = readdirSync(tmpdir()).filter((e) => e.startsWith(marker) && !before.has(e));
  assert.deepEqual(leaked, []);
});
