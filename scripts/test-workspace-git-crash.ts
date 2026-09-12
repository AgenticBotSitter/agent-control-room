// Opt-in disposable native Git qualification. No user repository or credentials.
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitWorkspacePort } from "../src/harness/codex-v1/git-workspace-port";
import { journaledWorkspacePort } from "../src/harness/codex-v1/journaled-workspace-port";
import { CodexWorkspaceManagerV1 } from "../src/harness/codex-v1/workspace";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { sha256Digest } from "../src/security/canonical-digest";

assert.ok(process.argv[2], "supply the reviewed Git executable");
assert.notEqual(process.platform, "win32", "this native fixture requires POSIX process groups");
const executable = resolve(process.argv[2]);
const execute = promisify(execFile);
const boundaries = ["git-created", "creation-recorded", "git-removed", "removal-recorded", "git-running"];
function killOwnedGroup(child: ReturnType<typeof fork>): void {
  // detached:true creates a fresh group with this child as its leader. Only
  // signal it while this exact tracked child is still nonterminal.
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}
function groupAbsent(child: ReturnType<typeof fork>): boolean {
  if (!child.pid) return true; // failed spawn has no process group
  try { process.kill(-child.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
async function waitGroupAbsent(child: ReturnType<typeof fork>): Promise<boolean> {
  for (let wait = 0; wait < 100 && !groupAbsent(child); wait++)
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  return groupAbsent(child);
}
function fixture(root: string, boundary: string, revision: string) {
  const repositoryRoot = join(root, "repo"), workspaceRoot = join(root, "work"), hooks = join(root, "hooks");
  const runId = `run:crash-${boundary}`;
  const intent = { schema: "control-room.workspace-intent/v1", tenantId: "tenant:fixture", projectId: "project:fixture",
    nodeId: "node:fixture", jobId: "job:fixture", attemptId: "attempt:fixture", leaseId: "lease:fixture", leaseEpoch: 1,
    runId, repositoryRoot, workspaceRoot, checkoutPath: join(workspaceRoot, `codex-${sha256Digest(runId).slice(7,31)}`), revision };
  const env = { PATH: "/usr/bin:/bin", TMPDIR: root, NODE_ENV: "test" as const,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Synthetic Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = async (cwd: string, args: string[]) => (await execute(executable,
    ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false", "-c", "core.fsmonitor=false", ...args],
    { cwd, env, timeout: 10000, maxBuffer: 262144 })).stdout.trim();
  return { intent, git, env, hooks, journalPath: join(root, `${boundary}.sqlite`) };
}

if (process.argv[3] === "child") {
  const [root, boundary, revision] = process.argv.slice(4);
  assert.ok(process.send && isAbsolute(root) && boundaries.includes(boundary) && /^[a-f0-9]{40}$/.test(revision));
  const { intent, git, env, journalPath } = fixture(root, boundary, revision);
  if (boundary === "git-running") {
    // Deterministic cleanup challenge: harmless Git is blocked reading its open
    // stdin pipe. Parent exercises the same whole-group termination as timeout.
    const pending = execute(executable, ["hash-object", "--stdin"], {
      cwd: intent.repositoryRoot, env, timeout: 10000, maxBuffer: 262144,
    });
    pending.child.once("spawn", () => process.send?.({ type: "boundary", boundary }));
    await pending;
    throw new Error("fixture_git_unexpectedly_completed");
  }
  const journal = new SqliteBridgeJournal(journalPath);
  const stop = async (): Promise<never> => {
    // All Git subprocesses have exited before this acknowledgement. Parent kills
    // only this worker, never an in-flight Git child or arbitrary process tree.
    process.on("message", () => {});
    process.send?.({ type: "boundary", boundary });
    return new Promise<never>(() => {});
  };
  const native = await createGitWorkspacePort({ ...intent, runGit: async (cwd, args) => {
    const result = await git(cwd, args);
    if ((boundary === "git-created" && args[0] === "worktree" && args[1] === "add")
      || (boundary === "git-removed" && args[0] === "worktree" && args[1] === "remove")) await stop();
    return result;
  } });
  const manager = new CodexWorkspaceManagerV1(journaledWorkspacePort({ port: native, journal, intent,
    assertCurrent: () => {}, assertRemovalCurrent: () => {} }));
  const lease = await manager.prepare(intent);
  if (boundary === "creation-recorded") {
    await writeFile(join(lease.checkoutPath, "preserved.txt"), "synthetic unfinished work\n");
    await stop();
  }
  await manager.cleanup(lease);
  await stop();
} else {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cr-git-crash-")));
  const children: { child: ReturnType<typeof fork>; done: Promise<void>; timer: ReturnType<typeof setTimeout> }[] = [];
  try {
    const setup = fixture(root, boundaries[0], "a".repeat(40));
    for (const path of [setup.intent.repositoryRoot, setup.intent.workspaceRoot, setup.hooks]) await mkdir(path, { mode: 0o700 });
    await setup.git(setup.intent.repositoryRoot, ["init", "--initial-branch=fixture", `--template=${setup.hooks}`]);
    await writeFile(join(setup.intent.repositoryRoot, "fixture.txt"), "synthetic original\n");
    await setup.git(setup.intent.repositoryRoot, ["add", "--", "fixture.txt"]);
    await setup.git(setup.intent.repositoryRoot, ["commit", "-m", "Synthetic initial"]);
    const revision = await setup.git(setup.intent.repositoryRoot, ["rev-parse", "HEAD"]);
    for (const boundary of boundaries) {
      const { intent, git, env, journalPath } = fixture(root, boundary, revision);
      const child = fork(fileURLToPath(import.meta.url), [executable, "child", root, boundary, revision], {
        execArgv: ["--import", "tsx"], silent: true, detached: true, env,
      });
      child.stdout?.resume(); child.stderr?.resume();
      let reached = false;
      const done = new Promise<void>((resolveDone, reject) => {
        child.once("error", reject);
        child.on("message", (message: { type?: string; boundary?: string }) => {
          if (message.type === "boundary" && message.boundary === boundary) {
            reached = true;
            if (boundary === "git-running") killOwnedGroup(child);
            else child.kill("SIGKILL");
          }
        });
        child.once("exit", (code, signal) => {
          if (reached && code === null && signal === "SIGKILL") resolveDone();
          else reject(new Error("native_fixture_boundary_not_reached"));
        });
      });
      const timer = setTimeout(() => killOwnedGroup(child), 30000);
      children.push({ child, done, timer });
      await done; clearTimeout(timer);
      assert.ok(await waitGroupAbsent(child), "fixture_process_group_not_terminal");
      if (boundary === "git-running") {
        await assert.rejects(lstat(journalPath), { code: "ENOENT" });
        console.log(JSON.stringify({ boundary, workerTerminated: true, gitProcessGroupAbsent: true }));
        continue;
      }
      const journal = new SqliteBridgeJournal(journalPath);
      try {
        const saved = journal.workspaceIntentInventory()[0];
        assert.equal(saved.intent.runId, intent.runId);
        assert.equal(saved.disposition, "reconciliation_required");
        assert.ok(saved.roots);
        assert.equal(Boolean(saved.creation), boundary !== "git-created");
        assert.equal(saved.removal, boundary === "git-removed" ? "pending" : boundary === "removal-recorded" ? "removed" : undefined);
        let effects = 0;
        const native = await createGitWorkspacePort({ ...intent, runGit: async (cwd, args) => {
          if (args[0] === "worktree") effects++;
          return git(cwd, args);
        } });
        const replay = new CodexWorkspaceManagerV1(journaledWorkspacePort({ port: native, journal, intent,
          assertCurrent: () => {}, assertRemovalCurrent: () => {} }));
        await assert.rejects(replay.prepare(intent), /reconciliation_required/);
        assert.equal(effects, 0);
        if (boundary === "git-created" || boundary === "creation-recorded") {
          assert.equal((await lstat(intent.checkoutPath)).isDirectory(), true);
          assert.equal(await git(intent.checkoutPath, ["rev-parse", "HEAD"]), revision);
          assert.equal(await readFile(join(intent.checkoutPath, "fixture.txt"), "utf8"), "synthetic original\n");
          if (saved.creation) {
            assert.equal((await native.observeCheckout(saved.creation, saved.roots)).state, "preserve");
            assert.equal(await readFile(join(intent.checkoutPath, "preserved.txt"), "utf8"), "synthetic unfinished work\n");
          }
          await assert.rejects(native.removeWorktree({ repositoryRealPath: intent.repositoryRoot, checkoutPath: intent.checkoutPath }), /not_owned/);
        } else {
          await assert.rejects(lstat(intent.checkoutPath), { code: "ENOENT" });
          assert.ok(saved.creation);
          assert.equal((await native.observeCheckout(saved.creation, saved.roots)).state, "absent");
          if (boundary === "removal-recorded") {
            // Replace only the fixture-owned root, retaining its entire old tree.
            await rename(intent.workspaceRoot, join(root, "retained-work"));
            await mkdir(intent.workspaceRoot, { mode: 0o700 });
            const replacement = await createGitWorkspacePort({ ...intent, runGit: git });
            assert.equal((await replacement.observeCheckout(saved.creation, saved.roots)).state, "changed");
          }
        }
        assert.equal(effects, 0);
      } finally { journal.close(); }
      console.log(JSON.stringify({ boundary, workerTerminated: true, retainedStateVerified: true, duplicateEffects: 0 }));
    }
    assert.equal(await setup.git(setup.intent.repositoryRoot, ["remote"]), "");
    assert.equal(await setup.git(setup.intent.repositoryRoot, ["status", "--porcelain"]), "");
  } finally {
    for (const entry of children) {
      clearTimeout(entry.timer);
      killOwnedGroup(entry.child);
    }
    await Promise.allSettled(children.map(entry => entry.done));
    // Reaping an orphan can lag the worker exit. Do not erase its files unless
    // all owned groups are confirmed absent; uncertainty preserves the root.
    const absent = await Promise.all(children.map(entry => waitGroupAbsent(entry.child)));
    if (absent.some(value => !value)) {
      console.log(JSON.stringify({ cleanup: false, reason: "fixture_process_group_not_terminal" }));
      throw new Error("fixture_retained_due_to_process_uncertainty");
    }
    // Exclusively fixture-created root; synthetic retained work is intentionally disposed.
    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: "ENOENT" });
    console.log(JSON.stringify({ cleanup: true }));
  }
}
