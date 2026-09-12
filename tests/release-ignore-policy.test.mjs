// Real-repo ignore policy test (maintainer review correction 1):
// dist-release/ and dist-release-* must be ignored in the actual repo .gitignore,
// otherwise the first real build leaves an untracked tree and the next
// build-release run fails release_worktree_unclean. Synthetic test fixtures
// already set their own .gitignore and would mask the regression.
//
// These tests are purely structural: they read the actual .gitignore and use
// `git check-ignore` on hypothetical paths. They never create files in the
// repo, so they cannot dirty the worktree and cannot mask the regression.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
// tests/release-ignore-policy.test.mjs lives at <repo>/tests/release-ignore-policy.test.mjs,
// so the repo root is one level up from this test file's directory.
const repoRoot = join(here, "..");

function isIgnored(absPath) {
  // `git check-ignore -q` exits 0 iff the path is ignored by .gitignore /
  // .git/info/exclude / core.excludesfile at the supplied repo. Non-zero
  // means not ignored. Works on hypothetical (nonexistent) paths.
  try {
    execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", "--", absPath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("actual repo .gitignore exists at the repo root", () => {
  const gitignore = join(repoRoot, ".gitignore");
  assert.equal(existsSync(gitignore), true, ".gitignore must exist at repo root");
});

test("actual repo .gitignore ignores dist-vps/ (baseline guard)", () => {
  // dist-vps has been ignored since before this PR; if this assertion fails,
  // someone has removed a baseline entry, not a regression introduced here.
  assert.equal(isIgnored(join(repoRoot, "dist-vps", "anything.js")), true,
    "dist-vps/ must be ignored (baseline)");
});

test("actual repo .gitignore ignores dist-release/ (default build output)", () => {
  // The default build output directory used by `build-release.mjs`. Without
  // this ignore, the first build leaves an untracked manifest and the next
  // build-release run refuses on release_worktree_unclean.
  assert.equal(isIgnored(join(repoRoot, "dist-release", "manifest.json")), true,
    "dist-release/ must be ignored so the default build output does not dirty the worktree");
});

test("actual repo .gitignore ignores dist-release-<short-sha>/ (versioned sibling output)", () => {
  // The documented update procedure names the new artifact directory
  // `dist-release-<new-short-sha>` so the prior tree stays intact for rollback.
  // Both the default and the versioned form must be ignored.
  assert.equal(isIgnored(join(repoRoot, "dist-release-6daf99e", "manifest.json")), true,
    "dist-release-*/ must be ignored");
});
