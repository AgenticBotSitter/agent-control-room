import assert from "node:assert/strict";
import test from "node:test";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { sha256Digest } from "../src/security/canonical-digest";
import { journaledWorkspacePort } from "../src/harness/codex-v1/journaled-workspace-port";

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
