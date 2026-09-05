import test from "node:test";
import assert from "node:assert/strict";
import { canonicalApprovalStorageFixture } from "./helpers/canonical-approval-storage";
import { createTaskCoordinatorLifecycle } from "../src/web/v1/task-coordinator-lifecycle";
import type { DatabaseClient } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { binding } from "./hermes-native-fixture";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const f = await canonicalApprovalStorageFixture(); let closed = 0;
  const config = { scope: f.scope, planning: f.plannerConfig, routes: [f.route], clock: f.clock,
    approvals: { enrollments: [{ enrollment: f.prepared.enrollment, nodeClass: "personal-compute" }], store: f.store },
    database: { client: f.db, close: async () => { closed++; }, isAvailable: () => closed === 0 } };
  return { ...f, config, closed: () => closed };
}

test("optional lifecycle approval port prepares, stores and reads without widening assignment surface", async t => {
  const f = await fixture(); t.after(f.close); const owner = createTaskCoordinatorLifecycle(f.config); t.after(owner.close);
  assert.equal("store" in owner.assignment, false); assert.equal(owner.approvals?.tenantId, binding.tenantId);
  const port = owner.approvals!; assert.equal(await port.read(...f.args), null);
  assert.equal((await port.prepare(...f.args)).binding.operationDigest, f.prepared.binding.operationDigest);
  const saved = await port.store(...f.args, f.packet, f.abort.signal), read = await port.read(...f.args);
  assert.equal(read?.packetDigest, saved.packetDigest); assert.equal(read?.evidence, "stored_signatures_only");
  assert.equal(read?.grantsExecutionAuthority, false); assert.equal("packet" in read!, false);
  assert.equal("enrollment" in read!, false);
  await owner.close(); await assert.rejects(port.read(...f.args), /task_coordinator_unavailable/);
  assert.equal(f.closed(), 1);
});

test("historical reconciliation survives work expiry, closed project and closed owner pins without granting work", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  f.setNow(f.prepared.start.deadline + 1000); f.approvals.close();
  await f.db.query("UPDATE control_manual_project_heads SET lifecycle='completed' WHERE tenant_id=$1 AND project_id=$2", [binding.tenantId, binding.projectId]);
  const read = await f.coordinator.readNativeApproval(...f.args);
  assert.equal(read?.packetDigest, sha256Digest(f.packet)); assert.equal(read?.startsWork, false);
  await assert.rejects(f.save());
});

test("readback still requires current owner/session and exact saved input", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  await assert.rejects(f.coordinator.readNativeApproval(f.args[0], f.args[1], f.args[2], sha256Digest("different")));
  await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE tenant_id=$1", [binding.tenantId]);
  await assert.rejects(f.coordinator.readNativeApproval(...f.args));
  const g = await fixture(); t.after(g.close); await g.save();
  await g.db.query("UPDATE control_web_sessions SET revoked_at=$1 WHERE tenant_id=$2", [new Date(g.clock()).toISOString(), binding.tenantId]);
  await assert.rejects(g.coordinator.readNativeApproval(...g.args));
});

test("lost commit acknowledgement reconciles by read only without resubmitting approval", async t => {
  const f = await fixture(); t.after(f.close);
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    await f.db.transactionWithPreCommitCheck(work, check); throw new Error("synthetic_lost_commit_acknowledgement");
  } };
  await assert.rejects(f.save(f.packet, f.create(db)), /lost_commit/); assert.equal(await f.count(), 1);
  const owner = createTaskCoordinatorLifecycle(f.config); t.after(owner.close);
  assert.equal((await owner.approvals!.read(...f.args))?.packetDigest, sha256Digest(f.packet));
  assert.equal(await f.count(), 1);
});

test("approval storage shares bounded capacity and graceful drain with other coordinator work", async t => {
  const f = await fixture(); t.after(f.close); const entered = deferred(), release = deferred();
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    entered.resolve(); await release.promise; return f.db.transactionWithPreCommitCheck(work, check);
  } };
  const owner = createTaskCoordinatorLifecycle({ ...f.config, maxActive: 1, database: { ...f.config.database, client: db } });
  const pending = owner.approvals!.store(...f.args, f.packet, f.abort.signal); await entered.promise;
  await assert.rejects(owner.approvals!.read(...f.args), /task_coordinator_unavailable/);
  await assert.rejects(owner.assignment.options(f.args[0], f.args[1], f.args[2]), /task_coordinator_unavailable/);
  const closing = owner.close(); assert.equal(f.closed(), 0);
  release.resolve(); assert.equal((await pending).replayed, false); await closing; assert.equal(f.closed(), 1);
});

test("forced drain denies late writes and retains an uncertain result until cleanup", async t => {
  const f = await fixture(); t.after(f.close); const entered = deferred(), release = deferred(), finished = deferred();
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    entered.resolve(); await release.promise;
    try { return await f.db.transactionWithPreCommitCheck(work, check); } finally { finished.resolve(); }
  } };
  const owner = createTaskCoordinatorLifecycle({ ...f.config, drainMs: 5, database: { ...f.config.database, client: db } });
  const pending = assert.rejects(owner.approvals!.store(...f.args, f.packet, f.abort.signal), /task_coordinator_save_uncertain/);
  await entered.promise; await assert.rejects(owner.close(), /task_coordinator_close_uncertain/); await pending;
  release.resolve(); await finished.promise; assert.equal(await f.count(), 0); assert.equal(f.closed(), 1);
});

test("lifecycle snapshots packet input before its scheduling microtask", async t => {
  const f = await fixture(); t.after(f.close); const owner = createTaskCoordinatorLifecycle(f.config); t.after(owner.close);
  const packet = structuredClone(f.packet), expected = sha256Digest(packet);
  const pending = owner.approvals!.store(...f.args, packet, f.abort.signal); packet.approval.signature = "A".repeat(86);
  assert.equal((await pending).packetDigest, expected);
});
