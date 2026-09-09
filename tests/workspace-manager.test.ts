import assert from "node:assert/strict";
import test from "node:test";
import { CodexWorkspaceManagerV1, type CodexWorkspacePortV1 } from "../src/harness/codex-v1/workspace";

test("workspace manager serializes preparation and cleanup before awaiting the port", async () => {
  const input = { runId: "run:workspace", repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision: "a".repeat(40) };
  let creates = 0, removes = 0;
  let releaseCreate!: () => void, releaseRemove!: () => void;
  const createWait = new Promise<void>(resolve => { releaseCreate = resolve; });
  const removeWait = new Promise<void>(resolve => { releaseRemove = resolve; });
  const port: CodexWorkspacePortV1 = {
    inspectExisting: async path => ({ realPath: path, device: "1", inode: "2" }),
    createDetachedWorktree: async ({ repositoryRealPath, checkoutPath, revision }) => {
      creates++; await createWait;
      return { realPath: checkoutPath, repositoryRealPath, headRevision: revision, device: "1", inode: "2" };
    },
    removeWorktree: async () => { removes++; await removeWait; },
  };
  const manager = new CodexWorkspaceManagerV1(port);
  const pending = manager.prepare(input);
  await assert.rejects(manager.prepare(input), /already pending/);
  releaseCreate(); const lease = await pending;
  assert.equal(creates, 1);
  await assert.rejects(manager.prepare(input), /already active/);
  const removing = manager.cleanup(lease);
  await assert.rejects(manager.cleanup(lease), /already pending/);
  await assert.rejects(manager.prepare(input), /already pending/);
  releaseRemove(); await removing;
  assert.equal(removes, 1);
  await assert.rejects(manager.cleanup(lease), /not active/);
});

test("workspace cleanup retains lease after port refusal and rejects changed identity", async () => {
  let inode = "2", refuse = true, removals = 0;
  const port: CodexWorkspacePortV1 = {
    inspectExisting: async path => ({ realPath: path, device: "1", inode }),
    createDetachedWorktree: async ({ repositoryRealPath, checkoutPath, revision }) => ({
      realPath: checkoutPath, repositoryRealPath, headRevision: revision, device: "1", inode: "2" }),
    removeWorktree: async () => { removals++; if (refuse) throw new Error("dirty_worktree"); },
  };
  const manager = new CodexWorkspaceManagerV1(port);
  const lease = await manager.prepare({ runId: "run:identity", repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision: "b".repeat(40) });
  await assert.rejects(manager.cleanup(lease), /dirty_worktree/);
  inode = "3"; await assert.rejects(manager.cleanup(lease), /identity changed/);
  assert.equal(removals, 1);
  inode = "2"; refuse = false; await manager.cleanup(lease);
  assert.equal(removals, 2);
});
