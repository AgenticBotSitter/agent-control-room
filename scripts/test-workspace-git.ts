// Disposable local Git/manager fit test. Not a production workspace adapter.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexWorkspaceManagerV1, type CodexWorkspacePortV1 } from "../src/harness/codex-v1/workspace";

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
  const inspect: CodexWorkspacePortV1["inspectExisting"] = async path => {
    const canonical = await realpath(path), info = await stat(canonical, { bigint: true });
    assert.equal(info.isDirectory(), true);
    return { realPath: canonical, device: String(info.dev), inode: String(info.ino) };
  };
  const repository = await realpath(repo), workspace = await realpath(work);
  let creates = 0, removals = 0;
  const port: CodexWorkspacePortV1 = {
    inspectExisting: inspect,
    createDetachedWorktree: async input => {
      assert.equal(input.repositoryRealPath, repository);
      assert.equal(input.checkoutPath.startsWith(workspace + "/codex-"), true);
      creates++;
      await git(repository, ["worktree", "add", "--detach", "--", input.checkoutPath, input.revision]);
      const headRevision = await git(input.checkoutPath, ["rev-parse", "HEAD"]);
      assert.equal(await git(input.checkoutPath, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
      return { ...await inspect(input.checkoutPath), repositoryRealPath: repository, headRevision };
    },
    removeWorktree: async input => {
      assert.equal(input.repositoryRealPath, repository);
      assert.equal(input.checkoutPath.startsWith(workspace + "/codex-"), true);
      // Ignored files can still contain valuable agent work. Preserve those too.
      // No force, reset or broad prune.
      if (await git(input.checkoutPath, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"])) throw new Error("dirty_worktree");
      await git(repository, ["worktree", "remove", "--", input.checkoutPath]); removals++;
    },
  };
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
  assert.equal(await git(repo, ["status", "--porcelain"]), "");
  assert.equal(await git(repo, ["remote"]), "");
  console.log(JSON.stringify({ detachedExactRevision: true, branchAdvanceIsolated: true,
    concurrentPrepareRefused: true, dirtyWorkPreserved: true, trackedAndStagedPreserved: true,
    ignoredWorkPreserved: true, cleanLeaseRemoval: true }));
} finally {
  // Every path under root was created by this fixture; no caller-supplied checkout.
  await rm(root, { recursive: true, force: true });
  await assert.rejects(stat(root), { code: "ENOENT" });
  console.log(JSON.stringify({ cleanup: true, fixtureInitialized: verifiedOwned }));
}
