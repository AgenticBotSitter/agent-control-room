// Disposable local Git/manager fit test. Not a production workspace adapter.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexWorkspaceManagerV1 } from "../src/harness/codex-v1/workspace";
import { createGitWorkspacePort } from "../src/harness/codex-v1/git-workspace-port";

assert.ok(process.argv[2], "supply the reviewed Git executable");
const executable = resolve(process.argv[2]);
const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "cr-workspace-fit-"));
const repo = join(root, "repo"), work = join(root, "work"), hooks = join(root, "hooks");
const env = { PATH: "/usr/bin:/bin", TMPDIR: root, NODE_ENV: "test" as const, GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Synthetic Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Synthetic Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
const git = async (cwd: string, args: string[]) => (await execute(executable,
  ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false", "-c", "core.fsmonitor=false", ...args],
  { cwd, env, timeout: 10000, maxBuffer: 262144 })).stdout.trim();
let verifiedOwned = false;
try {
  for (const path of [repo, work, hooks]) await mkdir(path, { mode: 0o700 });
  await git(repo, ["init", "--initial-branch=fixture", "--template=" + hooks]);
  await writeFile(join(repo, "fixture.txt"), "original\n");
  await writeFile(join(repo, ".gitignore"), "ignored-fixture.txt\n");
  await git(repo, ["add", "--", "fixture.txt", ".gitignore"]);
  await git(repo, ["commit", "-m", "Synthetic initial"]);
  const revision = await git(repo, ["rev-parse", "HEAD"]);
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(await git(repo, ["remote"]), "");
  verifiedOwned = true;
  const repository = await realpath(repo), workspace = await realpath(work);
  let creates = 0, removals = 0;
  const port = await createGitWorkspacePort({ repositoryRoot: repository, workspaceRoot: workspace,
    runGit: async (cwd, args) => {
      const result = await git(cwd, args);
      if (args[0] === "worktree" && args[1] === "add") creates++;
      if (args[0] === "worktree" && args[1] === "remove") removals++;
      return result;
    },
  });
  const manager = new CodexWorkspaceManagerV1(port);
  const input = { runId: "run:git-fit", repositoryRoot: repository, workspaceRoot: workspace, revision };
  const preparing = manager.prepare(input);
  await assert.rejects(manager.prepare(input), /already pending|requires reconciliation/);
  const lease = await preparing;
  assert.equal(creates, 1); assert.equal(lease.revision, revision);
  await writeFile(join(repo, "fixture.txt"), "advanced main\n");
  await git(repo, ["add", "--", "fixture.txt"]); await git(repo, ["commit", "-m", "Advance fixture"]);
  assert.notEqual(await git(repo, ["rev-parse", "HEAD"]), revision);
  assert.equal(await git(lease.checkoutPath, ["rev-parse", "HEAD"]), revision);
  await writeFile(join(lease.checkoutPath, "untracked.txt"), "retain me\n");
  await assert.rejects(manager.cleanup(lease), /dirty_worktree/);
  assert.equal(await readFile(join(lease.checkoutPath, "untracked.txt"), "utf8"), "retain me\n");
  assert.equal(removals, 0);
  // Only this test-created file is removed to exercise subsequent clean cleanup.
  await rm(join(lease.checkoutPath, "untracked.txt"));
  await writeFile(join(lease.checkoutPath, "fixture.txt"), "tracked work\n");
  await assert.rejects(manager.cleanup(lease), /dirty_worktree/);
  assert.equal(await readFile(join(lease.checkoutPath, "fixture.txt"), "utf8"), "tracked work\n");
  await git(lease.checkoutPath, ["add", "--", "fixture.txt"]);
  await assert.rejects(manager.cleanup(lease), /dirty_worktree/);
  assert.equal(await git(lease.checkoutPath, ["show", ":fixture.txt"]), "tracked work");
  // Restore only fixture-owned content, including its staged version.
  await writeFile(join(lease.checkoutPath, "fixture.txt"), "original\n");
  await git(lease.checkoutPath, ["add", "--", "fixture.txt"]);
  await writeFile(join(lease.checkoutPath, "ignored-fixture.txt"), "ignored but valuable\n");
  assert.equal(await git(lease.checkoutPath, ["status", "--porcelain"]), "");
  await assert.rejects(manager.cleanup(lease), /dirty_worktree/);
  assert.equal(await readFile(join(lease.checkoutPath, "ignored-fixture.txt"), "utf8"), "ignored but valuable\n");
  assert.equal(removals, 0);
  await rm(join(lease.checkoutPath, "ignored-fixture.txt"));
  await manager.cleanup(lease); assert.equal(removals, 1);
  await assert.rejects(stat(lease.checkoutPath), { code: "ENOENT" });
  await assert.rejects(port.removeWorktree({ repositoryRealPath: repository,
    checkoutPath: join(workspace, `codex-${"0".repeat(24)}`) }), /not_owned/);
  const existing = join(workspace, `codex-${"1".repeat(24)}`);
  await mkdir(existing); await writeFile(join(existing, "keep.txt"), "existing user-like fixture\n");
  await assert.rejects(port.createDetachedWorktree({ repositoryRealPath: repository, checkoutPath: existing, revision }), /target_exists/);
  assert.equal(await readFile(join(existing, "keep.txt"), "utf8"), "existing user-like fixture\n");
  let uncertainPath = "", lostCreates = 0;
  const lostPort = await createGitWorkspacePort({ repositoryRoot: repository, workspaceRoot: workspace,
    runGit: async (cwd, args) => {
      const result = await git(cwd, args);
      if (args[0] === "worktree" && args[1] === "add") {
        lostCreates++; uncertainPath = args[4]; throw new Error("synthetic_lost_response");
      }
      return result;
    },
  });
  const lostManager = new CodexWorkspaceManagerV1(lostPort);
  await assert.rejects(lostManager.prepare({ ...input, runId: "run:lost-response" }), /synthetic_lost_response/);
  await assert.rejects(lostManager.prepare({ ...input, runId: "run:lost-response" }), /requires reconciliation/);
  assert.equal(lostCreates, 1); assert.equal((await stat(uncertainPath)).isDirectory(), true);
  await assert.rejects(lostPort.removeWorktree({ repositoryRealPath: repository, checkoutPath: uncertainPath }), /not_owned/);
  assert.equal(await git(repo, ["status", "--porcelain"]), "");
  assert.equal(await git(repo, ["remote"]), "");
  console.log(JSON.stringify({ detachedExactRevision: true, branchAdvanceIsolated: true,
    concurrentPrepareRefused: true, dirtyWorkPreserved: true, trackedAndStagedPreserved: true,
    ignoredWorkPreserved: true, cleanLeaseRemoval: true, preexistingTargetPreserved: true,
    lostResponsePreserved: true }));
} finally {
  // Every path under root was created by this fixture; no caller-supplied checkout.
  await rm(root, { recursive: true, force: true });
  await assert.rejects(stat(root), { code: "ENOENT" });
  console.log(JSON.stringify({ cleanup: true, fixtureInitialized: verifiedOwned }));
}
