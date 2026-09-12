import assert from "node:assert/strict";
import test from "node:test";
import { CodexWorkspaceManagerV1, type CodexWorkspacePortV1 } from "../src/harness/codex-v1/workspace";

test("nested roots beginning with two dots are still overlapping", async () => {
  let creates = 0;
  const manager = new CodexWorkspaceManagerV1({
    inspectExisting: async path => ({ realPath: path, device: "1", inode: "2" }),
    createDetachedWorktree: async () => { creates++; throw new Error("must_not_create"); },
    removeWorktree: async () => {},
  });
  await assert.rejects(manager.prepare({ runId: "run:overlap", repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/repo/..work", revision: "a".repeat(40) }), /must be disjoint/);
  assert.equal(creates, 0);
});

test("uncertain creation cannot silently retry after failure or invalid readback", async () => {
  for (const mode of ["lost-response", "wrong-head"]) {
    let calls = 0, removes = 0;
    const manager = new CodexWorkspaceManagerV1({
      inspectExisting: async path => ({ realPath: path, device: "1", inode: "2" }),
      createDetachedWorktree: async ({ repositoryRealPath, checkoutPath }) => {
        calls++;
        if (mode === "lost-response") throw new Error("lost_response");
        return { realPath: checkoutPath, repositoryRealPath, headRevision: "b".repeat(40), device: "1", inode: "2" };
      },
      removeWorktree: async () => { removes++; },
    });
    const input = { runId: "run:uncertain", repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision: "a".repeat(40) };
    await assert.rejects(manager.prepare(input));
    await assert.rejects(manager.prepare(input), /requires reconciliation/);
    assert.equal(calls, 1); assert.equal(removes, 0);
  }
});

test("preparation snapshots caller input before asynchronous inspection", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const manager = new CodexWorkspaceManagerV1({
    inspectExisting: async path => { await wait; return { realPath: path, device: "1", inode: "2" }; },
    createDetachedWorktree: async ({ repositoryRealPath, checkoutPath, revision }) => ({
      realPath: checkoutPath, repositoryRealPath, headRevision: revision, device: "1", inode: "2" }),
    removeWorktree: async () => {},
  });
  const input = { runId: "run:original", repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision: "a".repeat(40) };
  const pending = manager.prepare(input);
  input.runId = "run:changed"; input.revision = "b".repeat(40); input.workspaceRoot = "/changed";
  release(); const lease = await pending;
  assert.equal(lease.runId, "run:original"); assert.equal(lease.revision, "a".repeat(40));
  assert.ok(lease.checkoutPath.startsWith("/fixture/work/"));
});

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
