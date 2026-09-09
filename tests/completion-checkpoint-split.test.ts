import assert from "node:assert/strict";
import test from "node:test";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { scriptedEtcdCheckpoint } from "./helpers/scripted-etcd-checkpoint";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store";

test("lost external checkpoint acknowledgement rolls back SQL and blocks later completion reads and writes", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const tenantId = f.profile.tenantId, scope = `completion-gate:${tenantId}`;
  const baseline = f.checkpoints.read(scope)!; assert.ok(baseline);
  const peer = scriptedEtcdCheckpoint(baseline);
  const store = new CompletionGateStoreV1(f.db, f.reviewKey, peer.open());
  assert.deepEqual(await store.getRecord(tenantId, f.profile.id, "profile"), f.profile);
  const before = (await f.db.query("SELECT * FROM control_completion_gate_integrity WHERE tenant_id=$1", [tenantId])).rows;
  const profile = { ...f.profile, id: "profile:checkpoint-split-test" };
  peer.loseNextWriteReply();
  await assert.rejects(store.registerProfile(profile), /integrity_failed/);
  assert.equal(peer.stats().writes, 1); assert.equal(peer.checkpoint().revision, baseline.revision + 1);
  assert.deepEqual((await f.db.query("SELECT * FROM control_completion_gate_integrity WHERE tenant_id=$1", [tenantId])).rows, before);
  assert.equal((await f.db.query("SELECT id FROM control_completion_gate_records WHERE id=$1", [profile.id])).rows.length, 0);
  // Recreating clients does not authorize backfilling SQL or rolling the anchor
  // backwards. The actual completion-store integrity check rejects the split.
  const reopened = new CompletionGateStoreV1(f.db, f.reviewKey, peer.open());
  await assert.rejects(reopened.getRecord(tenantId, f.profile.id, "profile"), /integrity_failed/);
  await assert.rejects(reopened.registerProfile(profile), /integrity_failed/);
  await assert.rejects(reopened.provisionTenant(tenantId), /integrity_failed/);
  assert.equal(peer.stats().writes, 1);
  assert.deepEqual(f.checkpoints.read(scope), baseline); // Test bootstrap is not a fallback.
});
