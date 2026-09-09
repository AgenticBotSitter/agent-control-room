import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { CodexWorkspaceIdentityV1, CodexWorkspacePortV1 } from "./workspace";

/** Trusted host composition supplies the pinned, bounded Git process runner.
 * The runner must isolate configuration/hooks/filters and permit no network.
 * This port does not qualify arbitrary repository configuration or grant effects.
 */
export type WorkspaceGitRunner = (cwd: string, args: string[]) => Promise<string>;

async function identity(path: string): Promise<CodexWorkspaceIdentityV1> {
  const canonical = await realpath(path), info = await lstat(path, { bigint: true });
  if (canonical !== path || !info.isDirectory() || info.isSymbolicLink()) throw new Error("workspace_path_not_canonical");
  return { realPath: canonical, device: String(info.dev), inode: String(info.ino) };
}
function same(a: CodexWorkspaceIdentityV1, b: CodexWorkspaceIdentityV1): boolean {
  return a.realPath === b.realPath && a.device === b.device && a.inode === b.inode;
}
function beneath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}

/** Native Git operations, retained behind manager leases; no force/reset/prune.
 * Ownership is process-local pending a durable recovery integration.
 */
export async function createGitWorkspacePort(input: {
  repositoryRoot: string; workspaceRoot: string; runGit: WorkspaceGitRunner;
}): Promise<CodexWorkspacePortV1> {
  const { repositoryRoot, workspaceRoot, runGit } = input;
  if (!isAbsolute(repositoryRoot) || !isAbsolute(workspaceRoot)) throw new Error("workspace_roots_not_absolute");
  const repo = await identity(repositoryRoot), root = await identity(workspaceRoot);
  if (beneath(repo.realPath, root.realPath) || beneath(root.realPath, repo.realPath)) throw new Error("workspace_roots_overlap");
  const common = await realpath(resolve(repo.realPath, (await runGit(repo.realPath, ["rev-parse", "--git-common-dir"])).trim()));
  const commonIdentity = await identity(common);
  const owned = new Map<string, CodexWorkspaceIdentityV1 & { revision: string }>();
  const pending = new Set<string>(), uncertain = new Set<string>();
  const child = (path: string) => {
    if (dirname(path) !== root.realPath || !/^codex-[a-f0-9]{24}$/.test(basename(path))) throw new Error("workspace_target_not_owned_child");
  };
  const roots = async () => {
    if (!same(repo, await identity(repo.realPath)) || !same(root, await identity(root.realPath))
      || !same(commonIdentity, await identity(common))) throw new Error("workspace_root_identity_changed");
  };
  const verifyGit = async (path: string) => {
    const actual = await realpath(resolve(path, (await runGit(path, ["rev-parse", "--git-common-dir"])).trim()));
    if (actual !== common || (await runGit(path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() !== "HEAD")
      throw new Error("workspace_git_identity_changed");
  };
  return {
    inspectExisting: async path => {
      if (path !== repo.realPath && path !== root.realPath) child(path);
      await roots(); return identity(path);
    },
    createDetachedWorktree: async request => {
      const { repositoryRealPath, checkoutPath, revision } = request;
      child(checkoutPath);
      if (repositoryRealPath !== repo.realPath || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("workspace_create_input_invalid");
      if (pending.has(checkoutPath) || owned.has(checkoutPath) || uncertain.has(checkoutPath)) throw new Error("workspace_target_reserved");
      pending.add(checkoutPath);
      try {
        await roots();
        try { await lstat(checkoutPath); throw new Error("workspace_target_exists"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        uncertain.add(checkoutPath);
        await runGit(repo.realPath, ["worktree", "add", "--detach", "--", checkoutPath, revision]);
        await roots(); const created = await identity(checkoutPath); await verifyGit(checkoutPath);
        const headRevision = (await runGit(checkoutPath, ["rev-parse", "HEAD"])).trim();
        if (headRevision !== revision) throw new Error("workspace_revision_mismatch");
        owned.set(checkoutPath, { ...created, revision }); uncertain.delete(checkoutPath);
        return { ...created, repositoryRealPath: repo.realPath, headRevision };
      } finally { pending.delete(checkoutPath); }
    },
    removeWorktree: async request => {
      const { repositoryRealPath, checkoutPath } = request; child(checkoutPath);
      const expected = owned.get(checkoutPath);
      if (repositoryRealPath !== repo.realPath || !expected || pending.has(checkoutPath) || uncertain.has(checkoutPath))
        throw new Error("workspace_removal_not_owned");
      pending.add(checkoutPath);
      try {
        await roots();
        if (!same(expected, await identity(checkoutPath))) throw new Error("workspace_identity_changed");
        await verifyGit(checkoutPath);
        if ((await runGit(checkoutPath, ["rev-parse", "HEAD"])).trim() !== expected.revision)
          throw new Error("workspace_committed_work_requires_preservation");
        if ((await runGit(checkoutPath, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"])).trim())
          throw new Error("dirty_worktree");
        if (!same(expected, await identity(checkoutPath))) throw new Error("workspace_identity_changed");
        uncertain.add(checkoutPath);
        await runGit(repo.realPath, ["worktree", "remove", "--", checkoutPath]);
        try { await lstat(checkoutPath); throw new Error("workspace_removal_unconfirmed"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        owned.delete(checkoutPath); uncertain.delete(checkoutPath);
      } finally { pending.delete(checkoutPath); }
    },
  };
}
