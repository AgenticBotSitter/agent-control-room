import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildReleaseCandidate, groupCommitSubjects, prepareReleaseCandidate, publishRelease, ReleaseRefusal } from "../scripts/release-tool.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const tool = join(root, "scripts/release-tool.mjs");
const privateGuard = join(root, "scripts/check-private-names.mjs");

function git(directory, args, input) {
  return execFileSync("git", args, { cwd: directory, input, encoding: "utf8" }).trim();
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "control-room-release-"));
  git(directory, ["init", "-q"]); git(directory, ["config", "user.email", "fixture@example.invalid"]); git(directory, ["config", "user.name", "Fixture"]);
  mkdirSync(join(directory, "scripts"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "control-room", version: "0.1.0" }));
  writeFileSync(join(directory, "safe.txt"), "public release input\n");
  git(directory, ["add", "."]); git(directory, ["commit", "-qm", "docs: explain public release"]);
  return directory;
}

function namesFile(directory, value = "PrivateTermOnly") {
  const path = join(directory, "names.txt"); writeFileSync(path, `${value}\n`); return path;
}

function noOpGate(executable, args, options) {
  if (executable === process.execPath && args[0] === "scripts/check-private-names.mjs") {
    const result = spawnSync(process.execPath, [privateGuard], { cwd: options.cwd, env: options.env, encoding: "utf8" });
    if (result.status !== 0) throw new Error("private_name_failed");
  }
  return "";
}

test("prepare refuses a private name planted in a tracked temp repository", () => {
  const directory = fixture();
  try {
    writeFileSync(join(directory, "safe.txt"), "PrivateTermOnly must never be public\n"); git(directory, ["add", "safe.txt"]);
    assert.throws(() => prepareReleaseCandidate({ root: directory, date: "2026-09-29", privateNamesFile: namesFile(directory), runCommand: noOpGate }),
      error => error instanceof ReleaseRefusal && error.code === "gate_failed:private-name guard");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("prepare refuses a planted credential without printing it", () => {
  const directory = fixture();
  try {
    const planted = `ghp_${"A".repeat(36)}`;
    writeFileSync(join(directory, "credential.txt"), planted); git(directory, ["add", "credential.txt"]);
    assert.throws(() => prepareReleaseCandidate({ root: directory, date: "2026-09-29", privateNamesFile: namesFile(directory), runCommand: noOpGate }),
      error => error instanceof ReleaseRefusal && error.code === "secret_scan_refused");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("changelog groups plain-language subjects by area", () => {
  assert.deepEqual(groupCommitSubjects(["docs: explain releases", "tests: cover refusals", "migration: preserve ledger", "build: make checks local", "Improve owner guidance"]), [
    { area: "Documentation", entries: ["docs: explain releases"] },
    { area: "Tests and verification", entries: ["tests: cover refusals"] },
    { area: "Database and data safety", entries: ["migration: preserve ledger"] },
    { area: "Tooling and operations", entries: ["build: make checks local"] },
    { area: "Other improvements", entries: ["Improve owner guidance"] },
  ]);
});

test("prepare uses only local commands and does not create refs or files", () => {
  const directory = fixture(), calls = [];
  try {
    const privateNamesFile = namesFile(directory);
    const before = git(directory, ["status", "--porcelain"]);
    const candidate = prepareReleaseCandidate({ root: directory, date: "2026-09-29", privateNamesFile,
      runGit(directoryArg, args) { calls.push(["git", ...args]); return git(directoryArg, args); },
      runCommand(executable, args, options) { calls.push([executable, ...args]); return noOpGate(executable, args, options); }, });
    assert.match(candidate.approval, /^[a-f0-9]{64}$/u);
    assert.ok(calls.every(call => !["curl", "wget", "gh"].includes(call[0]) && !(call[0] === "git" && ["fetch", "push", "ls-remote"].includes(call[1]))));
    assert.equal(git(directory, ["status", "--porcelain"]), before);
    assert.equal(git(directory, ["branch", "--list", "release/*"]), "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("publish refuses without the exact prepare approval", () => {
  const directory = fixture();
  try {
    assert.throws(() => publishRelease({ root: directory, sourceRef: "HEAD", date: "2026-09-29" }),
      error => error instanceof ReleaseRefusal && error.code === "release_approval_required");
    const candidate = buildReleaseCandidate({ root: directory, sourceRef: "HEAD", date: "2026-09-29" });
    const wrongApproval = candidate.approval.slice(0, -1) + (candidate.approval.endsWith("0") ? "1" : "0");
    assert.throws(() => publishRelease({ root: directory, sourceRef: "HEAD", date: "2026-09-29", approval: wrongApproval }),
      error => error instanceof ReleaseRefusal && error.code === "release_approval_invalid");
    assert.equal(git(directory, ["branch", "--list", "release/*"]), "", "a refused attempt leaves nothing to clean up");
    const published = publishRelease({ root: directory, sourceRef: "HEAD", date: "2026-09-29", approval: candidate.approval });
    assert.throws(() => publishRelease({ root: directory, sourceRef: "HEAD", date: "2026-09-29", approval: candidate.approval }),
      error => error instanceof ReleaseRefusal && error.code === "release_ref_already_exists");
    assert.equal(git(directory, ["rev-parse", `${published.tag}^{commit}`]), published.commit, "a retry cannot replace the first release");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an already-created tag refuses before a release branch can be written", () => {
  const directory = fixture();
  try {
    const candidate = buildReleaseCandidate({ root: directory, sourceRef: "HEAD", date: "2026-09-29" });
    git(directory, ["tag", "-a", candidate.tag, "-m", "existing tag"]);
    assert.throws(() => publishRelease({ root: directory, sourceRef: "HEAD", date: "2026-09-29", approval: candidate.approval }),
      error => error instanceof ReleaseRefusal && error.code === "release_ref_already_exists");
    assert.equal(git(directory, ["branch", "--list", "release/*"]), "", "a stopped publish never leaves a half-created branch");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("publish creates one root release commit and a tag, without pushing", () => {
  const directory = fixture();
  try {
    const candidate = buildReleaseCandidate({ root: directory, sourceRef: "HEAD", date: "2026-09-29" });
    const published = publishRelease({ root: directory, sourceRef: "HEAD", date: "2026-09-29", approval: candidate.approval });
    assert.equal(published.pushed, false);
    assert.equal(git(directory, ["rev-list", "--parents", "-n", "1", published.branch]).split(" ").length, 1, "release commit is squashed/rooted");
    assert.equal(git(directory, ["rev-parse", `${published.tag}^{commit}`]), published.commit);
    assert.match(git(directory, ["show", `${published.branch}:CHANGELOG.md`]), /Documentation/u);
    assert.match(published.pushCommand, /^git push origin /u);
    assert.match(published.ghCommand, /^gh release create /u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("CLI publish refuses before a token can create a branch", () => {
  const directory = fixture();
  try {
    const result = spawnSync(process.execPath, [tool, "publish", "--source-ref", "HEAD", "--date", "2026-09-29", "--approval", "not-a-token"], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release_approval_required/u);
    assert.equal(git(directory, ["branch", "--list", "release/*"]), "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
