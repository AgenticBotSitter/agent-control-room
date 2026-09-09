import assert from "node:assert/strict";
import test from "node:test";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { sha256Digest } from "../src/security/canonical-digest";
import { journaledWorkspacePort } from "../src/harness/codex-v1/journaled-workspace-port";

test("async authority is rejected before workspace effects and journal commits", async () => {
  for (const failureCall of [1, 2, 3]) {
    const journal = new SqliteBridgeJournal(":memory:");
    const runId = "run:async-authority";
    const intent = { schema: "control-room.workspace-intent/v1", tenantId: "tenant:fixture", projectId: "project:fixture",
      nodeId: "node:fixture", jobId: "job:fixture", attemptId: "attempt:fixture", runId, leaseId: "lease:fixture", leaseEpoch: 1,
      repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", checkoutPath: `/fixture/work/codex-${sha256Digest(runId).slice(7,31)}`, revision: "a".repeat(40) };
    const request = { repositoryRealPath: intent.repositoryRoot, checkoutPath: intent.checkoutPath, revision: intent.revision };
    const evidence = { realPath: intent.checkoutPath, repositoryRealPath: intent.repositoryRoot,
      headRevision: intent.revision, device: "1", inode: "2" };
    let effects = 0, checks = 0;
    const invalid = () => { if (++checks === failureCall) return Promise.reject(new Error("revoked")); };
    const underlying = { inspectExisting: async () => evidence,
      createDetachedWorktree: async () => { effects++; return evidence; },
      removeWorktree: async () => { effects++; } };
    try {
      const port = journaledWorkspacePort({ journal, intent, port: underlying, assertCurrent: invalid });
      await assert.rejects(port.createDetachedWorktree(request), /authority_must_be_synchronous/);
      assert.equal(effects, 0);
      assert.equal(journal.workspaceIntentInventory().length, failureCall === 3 ? 1 : 0);
      journal.reserveWorkspaceIntent(intent, () => {});
      const digest = journal.workspaceIntentInventory()[0].intentDigest;
      await assert.rejects(async () => journal.recordWorkspaceCreation(digest, evidence, async () => {}), /authority_must_be_synchronous/);
      assert.equal(journal.workspaceIntentInventory()[0].creation, undefined);
      journal.recordWorkspaceCreation(digest, evidence, () => {});
      checks = 0;
      const removal = journaledWorkspacePort({ journal, intent, port: underlying, assertCurrent: () => {}, assertRemovalCurrent: invalid });
      await assert.rejects(removal.removeWorktree(request), /authority_must_be_synchronous/);
      assert.equal(effects, 0);
      assert.equal(journal.workspaceIntentInventory()[0].removal, failureCall === 3 ? "pending" : undefined);
      // Let rejected callback promises settle; node:test also detects unhandled rejections.
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally { journal.close(); }
  }
});

test("journaled port records before creation and refuses replay or unjournaled removal", async () => {
  const journal = new SqliteBridgeJournal(":memory:");
  const runId = "run:port";
  const intent = { schema: "control-room.workspace-intent/v1", tenantId: "tenant:fixture", projectId: "project:fixture",
    nodeId: "node:fixture", jobId: "job:fixture", attemptId: "attempt:fixture", runId, leaseId: "lease:fixture", leaseEpoch: 1,
    repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", checkoutPath: `/fixture/work/codex-${sha256Digest(runId).slice(7,31)}`, revision: "a".repeat(40) };
  let creates = 0, removes = 0;
  const underlying = {
    inspectExisting: async (path: string) => ({ realPath: path, device: "1", inode: "2" }),
    createDetachedWorktree: async () => {
      creates++; assert.equal(journal.workspaceIntentInventory().length, 1);
      assert.equal(journal.workspaceIntentInventory()[0].creation, undefined);
      return { realPath: intent.checkoutPath, repositoryRealPath: intent.repositoryRoot, headRevision: intent.revision, device: "1", inode: "2" };
    },
    removeWorktree: async () => { removes++; },
  };
  const request = { repositoryRealPath: intent.repositoryRoot, checkoutPath: intent.checkoutPath, revision: intent.revision };
  try {
    const port = journaledWorkspacePort({ port: underlying, journal, intent, assertCurrent: () => {} });
    await assert.rejects(port.createDetachedWorktree({ ...request, revision: "b".repeat(40) }), /binding_invalid/);
    assert.equal(journal.workspaceIntentInventory().length, 0);
    await port.createDetachedWorktree(request);
    assert.ok(journal.workspaceIntentInventory()[0].creation);
    const restartedComposition = journaledWorkspacePort({ port: underlying, journal, intent, assertCurrent: () => {} });
    await assert.rejects(restartedComposition.createDetachedWorktree(request), /reconciliation_required/);
    await assert.rejects(port.removeWorktree(request), /removal_authority_required/);
    assert.equal(creates, 1); assert.equal(removes, 0);
    const removal = journaledWorkspacePort({ port: underlying, journal, intent, assertCurrent: () => {}, assertRemovalCurrent: () => {} });
    await removal.removeWorktree(request);
    assert.equal(removes, 1);
    assert.equal(journal.workspaceIntentInventory()[0].removal, "removed");
    await assert.rejects(removal.removeWorktree(request), /reconciliation_required/);
    assert.equal(removes, 1);
  } finally { journal.close(); }
});
