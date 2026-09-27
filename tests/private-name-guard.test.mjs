import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const guard = join(repositoryRoot, "scripts/check-private-names.mjs");
const installer = join(repositoryRoot, "scripts/install-private-name-hook.mjs");

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "control-room-private-name-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/check-private-names.mjs"), `#!/bin/sh\nexit 0\n`);
  writeFileSync(join(root, "safe.txt"), "ordinary public text\n");
  git(root, ["add", "."]);
  return root;
}

test("guard skips cleanly when no private-name list is configured", () => {
  const root = fixture();
  try {
    const result = spawnSync(process.execPath, [guard], { cwd: root, encoding: "utf8", env: {} });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "private-name check skipped: no list configured");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("guard finds case-insensitive content and filename matches without disclosing the term", () => {
  const root = fixture();
  try {
    const privateTerm = "SyntheticPrivateTerm";
    writeFileSync(join(root, "safe.txt"), "prefix syntheticprivateterm suffix\n");
    writeFileSync(join(root, `${privateTerm}.txt`), "otherwise safe\n");
    git(root, ["add", "."]);
    const result = spawnSync(process.execPath, [guard], {
      cwd: root, encoding: "utf8", env: { CONTROL_ROOM_PRIVATE_NAMES: `${privateTerm}\n` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /safe\.txt:1: private name <redacted>/);
    assert.match(result.stderr, /<redacted>\.txt:0: private name <redacted>/);
    assert.doesNotMatch(result.stderr.toLocaleLowerCase(), new RegExp(privateTerm.toLocaleLowerCase()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("guard prefers the configured file and passes a clean tracked tree", () => {
  const root = fixture();
  try {
    const namesFile = join(root, "..", "private-name-fixture.txt");
    writeFileSync(namesFile, "SyntheticPrivateTerm\n");
    const result = spawnSync(process.execPath, [guard], {
      cwd: root, encoding: "utf8",
      env: { CONTROL_ROOM_PRIVATE_NAMES: "ordinary", CONTROL_ROOM_PRIVATE_NAMES_FILE: namesFile },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "private-name check passed");
    rmSync(namesFile, { force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installer creates an executable, idempotent hook and preserves unrelated hooks", () => {
  const root = fixture();
  try {
    const namesFile = join(root, "private-names.txt");
    writeFileSync(namesFile, "SyntheticPrivateTerm\n");
    const env = { ...process.env, CONTROL_ROOM_PRIVATE_NAMES_FILE: namesFile };
    const first = spawnSync(process.execPath, [installer], { cwd: root, encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr);
    const hookPath = join(root, git(root, ["rev-parse", "--git-path", "hooks"]), "pre-push");
    assert.match(readFileSync(hookPath, "utf8"), /control-room-private-name-hook:v1/);
    assert.notEqual(statSync(hookPath).mode & 0o111, 0);
    const second = spawnSync(process.execPath, [installer], { cwd: root, encoding: "utf8", env });
    assert.equal(second.status, 0, second.stderr);

    writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
    chmodSync(hookPath, 0o755);
    const refused = spawnSync(process.execPath, [installer], { cwd: root, encoding: "utf8", env });
    assert.equal(refused.status, 1);
    assert.equal(readFileSync(hookPath, "utf8"), "#!/bin/sh\nexit 0\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
