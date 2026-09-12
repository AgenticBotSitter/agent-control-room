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
    const creation = { realPath: value.checkoutPath, repositoryRealPath: value.repositoryRoot,
      headRevision: value.revision, device: "1", inode: "2" };
    assert.throws(() => first!.recordWorkspaceCreation(sha256Digest(value), { ...creation, headRevision: "b".repeat(40) }, () => {}), /binding_invalid/);
    let creationChecks = 0;
    assert.throws(() => first!.recordWorkspaceCreation(sha256Digest(value), creation, () => {
      if (++creationChecks === 2) throw new Error("readback_admission_revoked");
    }), /readback_admission_revoked/);
    assert.equal(first.workspaceIntentInventory()[0].creation, undefined);
    assert.equal(first.recordWorkspaceCreation(sha256Digest(value), creation, () => {}), "recorded");
    assert.equal(first.recordWorkspaceCreation(sha256Digest(value), creation, () => {}), "existing");
    assert.throws(() => first!.recordWorkspaceCreation(sha256Digest(value), { ...creation, inode: "3" }, () => {}), /conflict/);
    first.close(); first = new SqliteBridgeJournal(file);
    assert.deepEqual(first.workspaceIntentInventory()[0].creation, creation);
    assert.equal(first.workspaceIntentInventory()[0].disposition, "reconciliation_required");
    assert.throws(() => first!.recordWorkspaceRemoved(sha256Digest(value)), /intent_missing/);
    let removalChecks = 0;
    assert.throws(() => first!.reserveWorkspaceRemoval(sha256Digest(value), () => {
      if (++removalChecks === 2) throw new Error("removal_revoked");
    }), /removal_revoked/);
    assert.equal(first.workspaceIntentInventory()[0].removal, undefined);
    assert.equal(first.reserveWorkspaceRemoval(sha256Digest(value), () => {}), "recorded");
    first.close(); first = new SqliteBridgeJournal(file);
    assert.equal(first.workspaceIntentInventory()[0].removal, "pending");
    assert.equal(first.reserveWorkspaceRemoval(sha256Digest(value), () => {}), "existing");
    assert.equal(first.reserveWorkspaceIntent(intent("run:revoked"), () => {}), "recorded");
    const rootsFor = (value: ReturnType<typeof intent>) => ({
      repository: { realPath: value.repositoryRoot, device: "1", inode: "30" },
      workspace: { realPath: value.workspaceRoot, device: "1", inode: "40" },
      commonGit: { realPath: `${value.repositoryRoot}/.git`, device: "1", inode: "50" },
    });
    assert.throws(() => first!.recordWorkspaceRoots(sha256Digest(value), rootsFor(value), () => {}), /cannot_be_retrofitted/);
    const fresh = intent("run:revoked"), freshDigest = sha256Digest(fresh), roots = rootsFor(fresh);
    let rootChecks = 0;
    assert.throws(() => first!.recordWorkspaceRoots(freshDigest, roots, () => {
      if (++rootChecks === 2) throw new Error("root_capture_revoked");
    }), /root_capture_revoked/);
    assert.equal(first.workspaceIntentInventory().find(row => row.intentDigest === freshDigest)?.roots, undefined);
    assert.throws(() => first!.recordWorkspaceRoots(freshDigest, { ...roots, repository: { ...roots.repository, realPath: "/foreign" } }, () => {}), /binding_invalid/);
    assert.equal(first.recordWorkspaceRoots(freshDigest, roots, () => {}), "recorded");
    assert.equal(first.recordWorkspaceRoots(freshDigest, roots, () => {}), "existing");
    assert.throws(() => first!.recordWorkspaceRoots(freshDigest, { ...roots, workspace: { ...roots.workspace, inode: "41" } }, () => {}), /conflict/);
    first.close(); first = new SqliteBridgeJournal(file);
    assert.deepEqual(first.workspaceIntentInventory().find(row => row.intentDigest === freshDigest)?.roots, roots);
    assert.throws(() => first!.reserveWorkspaceIntent({ ...value, checkoutPath: "/elsewhere" }, () => {}), /invalid/);
  } finally { first?.close(); second?.close(); await rm(root, { recursive: true, force: true }); }
});
