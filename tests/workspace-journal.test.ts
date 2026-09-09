import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { sha256Digest } from "../src/security/canonical-digest";

test("workspace intent survives reopen, conflicts across connections and rolls back on revoked admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "cr-workspace-journal-"));
  const file = join(root, "journal.sqlite");
  let first: SqliteBridgeJournal | undefined, second: SqliteBridgeJournal | undefined;
  const intent = (runId: string) => ({ schema: "control-room.workspace-intent/v1" as const,
    tenantId: "tenant:fixture", projectId: "project:fixture", nodeId: "node:fixture",
    jobId: "job:fixture", attemptId: "attempt:fixture", leaseId: "lease:fixture", leaseEpoch: 1, runId,
    repositoryRoot: "/fixture/repository", workspaceRoot: "/fixture/workspaces",
    checkoutPath: `/fixture/workspaces/codex-${sha256Digest(runId).slice(7,31)}`, revision: "a".repeat(40) });
  try {
    first = new SqliteBridgeJournal(file); second = new SqliteBridgeJournal(file);
    const value = intent("run:fixture");
    assert.equal(first.reserveWorkspaceIntent(value, () => {}), "recorded");
    assert.equal(second.reserveWorkspaceIntent(value, () => {}), "existing");
    assert.throws(() => second!.reserveWorkspaceIntent({ ...value, leaseEpoch: 2 }, () => {}), /conflict/);
    assert.throws(() => second!.reserveWorkspaceIntent({ ...value, jobId: "job:other" }, () => {}), /conflict/);
    let checks = 0;
    assert.throws(() => first!.reserveWorkspaceIntent(intent("run:revoked"), () => {
      if (++checks === 2) throw new Error("admission_revoked");
    }), /admission_revoked/);
    assert.equal(second.workspaceIntentInventory().length, 1);
    first.close(); first = undefined; second.close(); second = undefined;
    first = new SqliteBridgeJournal(file);
    assert.deepEqual(first.workspaceIntentInventory(), [{ intent: value, intentDigest: sha256Digest(value), disposition: "reconciliation_required" }]);
    assert.equal(first.reserveWorkspaceIntent(value, () => {}), "existing");
    assert.equal(first.reserveWorkspaceIntent(intent("run:revoked"), () => {}), "recorded");
    assert.throws(() => first!.reserveWorkspaceIntent({ ...value, checkoutPath: "/elsewhere" }, () => {}), /invalid/);
  } finally { first?.close(); second?.close(); await rm(root, { recursive: true, force: true }); }
});
