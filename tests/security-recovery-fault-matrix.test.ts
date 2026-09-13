import assert from "node:assert/strict";
import test from "node:test";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store";
import { withDatabaseOperationSignal } from "../src/persistence/operation-signal";
import { verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { completionMutationCounts, securityRecoveryCheckpointPeer, syntheticArtifactInventory,
  syntheticInventoryEntry } from "./helpers/security-recovery-fault-matrix";

test("checkpoint ahead after lost acknowledgement refuses reads, writes, initialization, and repeated restart inspection", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const tenantId = f.profile.tenantId, scope = `completion-gate:${tenantId}`;
  const baseline = f.checkpoints.read(scope)!;
  const peer = securityRecoveryCheckpointPeer(baseline); peer.setWriteFault("lost_ack");
  const store = new CompletionGateStoreV1(f.db, f.reviewKey, peer.open());
  const before = await completionMutationCounts(f.db, tenantId);
  await assert.rejects(store.registerProfile({ ...f.profile, id: "profile:fault-matrix-lost-ack" }), /integrity_failed/);
  assert.deepEqual(await completionMutationCounts(f.db, tenantId), before);
  assert.equal(peer.stats().committedWrites, 1);
  for (let restart = 0; restart < 3; restart++) {
    const reopened = new CompletionGateStoreV1(f.db, f.reviewKey, peer.open());
    await assert.rejects(reopened.getRecord(tenantId, f.profile.id, "profile"), /integrity_failed/);
    await assert.rejects(reopened.registerProfile({ ...f.profile, id: `profile:fault-matrix-restart-${restart}` }), /integrity_failed/);
    await assert.rejects(reopened.provisionTenant(tenantId), /integrity_failed/);
  }
  assert.equal(peer.stats().committedWrites, 1);
  assert.deepEqual(await completionMutationCounts(f.db, tenantId), before);
});

test("database ahead of a stale checkpoint refuses fresh clients without mutation", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const tenantId = f.profile.tenantId, scope = `completion-gate:${tenantId}`;
  const stale = f.checkpoints.read(scope)!;
  await f.reviewStore.registerProfile({ ...f.profile, id: "profile:database-ahead" });
  const before = await completionMutationCounts(f.db, tenantId);
  const peer = securityRecoveryCheckpointPeer(stale);
  for (let restart = 0; restart < 3; restart++) {
    const reopened = new CompletionGateStoreV1(f.db, f.reviewKey, peer.open());
    await assert.rejects(reopened.getRecord(tenantId, f.profile.id, "profile"), /integrity_failed/);
    await assert.rejects(reopened.registerProfile({ ...f.profile, id: `profile:database-ahead-${restart}` }), /integrity_failed/);
  }
  assert.deepEqual(await completionMutationCounts(f.db, tenantId), before);
  assert.equal(peer.stats().transactions, 0);
});

test("same checkpoint revision and count with changed digest or authentication tag refuses actual completion reads and writes", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const tenantId = f.profile.tenantId, baseline = f.checkpoints.read(`completion-gate:${tenantId}`)!;
  for (const fault of ["changed_digest", "changed_tag"] as const) {
    const peer = securityRecoveryCheckpointPeer(baseline); peer.setReadFault(fault);
    const store = new CompletionGateStoreV1(f.db, f.reviewKey, peer.open());
    const before = await completionMutationCounts(f.db, tenantId);
    await assert.rejects(store.getRecord(tenantId, f.profile.id, "profile"), /integrity_failed/);
    await assert.rejects(store.registerProfile({ ...f.profile, id: `profile:${fault}` }), /integrity_failed/);
    assert.deepEqual(await completionMutationCounts(f.db, tenantId), before);
    assert.equal(peer.stats().transactions, 0);
  }
});

test("missing, replaced, wrong scope, cluster, or generation checkpoints never initialize or mutate SQL", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const tenantId = f.profile.tenantId, baseline = f.checkpoints.read(`completion-gate:${tenantId}`)!;
  for (const fault of ["missing", "replaced_key", "wrong_tenant", "wrong_scope", "wrong_cluster", "wrong_create_revision"] as const) {
    const peer = securityRecoveryCheckpointPeer(baseline); peer.setReadFault(fault);
    const store = new CompletionGateStoreV1(f.db, f.reviewKey, peer.open());
    const before = await completionMutationCounts(f.db, tenantId);
    await assert.rejects(store.getRecord(tenantId, f.profile.id, "profile"), /integrity_failed/);
    await assert.rejects(store.provisionTenant(tenantId), /integrity_failed/);
    assert.deepEqual(await completionMutationCounts(f.db, tenantId), before);
    assert.equal(peer.stats().transactions, 0);
  }
});

test("failed conditional checkpoint update never retries and rolls SQL back", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const tenantId = f.profile.tenantId, baseline = f.checkpoints.read(`completion-gate:${tenantId}`)!;
  const peer = securityRecoveryCheckpointPeer(baseline); peer.setWriteFault("conditional_failure");
  const store = new CompletionGateStoreV1(f.db, f.reviewKey, peer.open());
  const before = await completionMutationCounts(f.db, tenantId);
  await assert.rejects(store.registerProfile({ ...f.profile, id: "profile:conditional-failure" }), /integrity_failed/);
  assert.deepEqual(await completionMutationCounts(f.db, tenantId), before);
  // Initial integrity verification, refresh verification, and the CAS read are all real reads.
  assert.deepEqual(peer.stats(), { ranges: 3, transactions: 1, committedWrites: 0, cancels: 0 });
  assert.deepEqual(peer.transactionShapes(), [{ failureCount: 0, successCount: 1 }]);
});

test("timeout and late acknowledgement stay uncertain with one dispatch and no SQL mutation", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const tenantId = f.profile.tenantId, baseline = f.checkpoints.read(`completion-gate:${tenantId}`)!;
  for (const fault of ["timeout", "late_ack"] as const) {
    const peer = securityRecoveryCheckpointPeer(baseline, 10); peer.setWriteFault(fault);
    const store = new CompletionGateStoreV1(f.db, f.reviewKey, peer.open());
    const before = await completionMutationCounts(f.db, tenantId);
    await assert.rejects(store.registerProfile({ ...f.profile, id: `profile:${fault}` }), /integrity_failed/);
    const stopped = peer.stats(); assert.equal(stopped.transactions, 1);
    assert.equal(stopped.committedWrites, fault === "late_ack" ? 1 : 0);
    if (fault === "late_ack") peer.acknowledgeLate();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(peer.stats().transactions, 1);
    assert.deepEqual(await completionMutationCounts(f.db, tenantId), before);
    if (fault === "late_ack") {
      const reopened = new CompletionGateStoreV1(f.db, f.reviewKey, peer.open());
      await assert.rejects(reopened.getRecord(tenantId, f.profile.id, "profile"), /integrity_failed/);
    }
  }
});

test("pre-abort refuses actual completion reads and writes without SQL or checkpoint mutation", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const tenantId = f.profile.tenantId, initial = f.checkpoints.read(`completion-gate:${tenantId}`)!;
  const peer = securityRecoveryCheckpointPeer(initial), store = new CompletionGateStoreV1(f.db, f.reviewKey, peer.open());
  const before = await completionMutationCounts(f.db, tenantId), signal = AbortSignal.abort();
  await assert.rejects(withDatabaseOperationSignal(signal,
    () => store.getRecord(tenantId, f.profile.id, "profile")), /integrity_failed/);
  await assert.rejects(withDatabaseOperationSignal(signal,
    () => store.registerProfile({ ...f.profile, id: "profile:aborted" })), /integrity_failed/);
  assert.deepEqual(peer.stats(), { ranges: 0, transactions: 0, committedWrites: 0, cancels: 0 });
  assert.deepEqual(peer.checkpoint(), initial);
  assert.deepEqual(await completionMutationCounts(f.db, tenantId), before);
});

test("artifact inventory mismatch matrix remains synthetic metadata comparison only", () => {
  const expected = syntheticArtifactInventory();
  const matched = verifyRestoredArtifactBackupInventoryV1({ expected, restored: structuredClone(expected) });
  assert.equal(matched.exactInventoryMatched, true);
  assert.equal(matched.restoresArtifacts, false);
  assert.equal(matched.grantsStorageReadAuthority, false);
  const [first, second] = expected.entries;
  assert.ok(first && second);
  const variants = [
    syntheticArtifactInventory([first]),
    syntheticArtifactInventory([...expected.entries, syntheticInventoryEntry("artifact:synthetic:c", "c")]),
    syntheticArtifactInventory([{ ...first, contentHash: `sha256:${"3".repeat(64)}` }, second]),
    syntheticArtifactInventory([{ ...first, manifestDigest: `sha256:${"4".repeat(64)}` }, second]),
    syntheticArtifactInventory([{ ...first, receiptDigest: `sha256:${"5".repeat(64)}` }, second]),
    syntheticArtifactInventory([...expected.entries], { databaseSchemaDigest: `sha256:${"6".repeat(64)}` }),
    syntheticArtifactInventory([...expected.entries], { storageNamespace: "namespace:other" }),
  ];
  for (const restored of variants) assert.throws(() =>
    verifyRestoredArtifactBackupInventoryV1({ expected, restored }), /inventory_unavailable/);
});
