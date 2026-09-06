import test from "node:test";
import assert from "node:assert/strict";
import { canonicalApprovalStorageFixture } from "./helpers/canonical-approval-storage";
import { NativeQueueAuthority } from "../src/web/v1/native-queue-authority";
import { sha256Digest } from "../src/security";
import type { NativeTaskSubmissionReference } from "../src/persistence/native-task-submission";
import type { DatabaseClient } from "../src/persistence/database";
import { WebSessionAuthority } from "../src/web/v1/session-authority";

async function fixture() {
  const f = await canonicalApprovalStorageFixture(); await f.save();
  const queued = await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  const ref: NativeTaskSubmissionReference = { schema: "control-room.native-task-submission/v1", tenantId: f.scope.tenantId,
    projectId: queued.projectId, jobId: queued.jobId, attemptId: queued.attemptId, queueId: queued.queueId,
    inputDigest: f.args[3], packetDigest: queued.packetDigest };
  return { ...f, ref, authority: new NativeQueueAuthority(f.db, f.scope, f.store, f.clock) };
}
test("server authority rejects forged locators and unauthenticated persisted queue evidence before callback", async t => {
  const f = await fixture(); t.after(f.close); let calls = 0;
  const work = async () => { calls++; };
  for (const ref of [{ ...f.ref, tenantId: "tenant:other" }, { ...f.ref, attemptId: "attempt:other" },
    { ...f.ref, packetDigest: sha256Digest("wrong") }, { ...f.ref, queueId: `native-queue:${"0".repeat(64)}` }])
    await assert.rejects(f.authority.authenticated(ref, work));
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, values?: unknown[]) {
      const result = await tx.query<T>(sql, values);
      if (sql.startsWith("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_task_queue"))
        result.rows = result.rows.map(row => ({ ...row, auth_tag: `hmac-sha256:${"0".repeat(64)}` }));
      return result;
    },
  }), check) };
  await assert.rejects(new NativeQueueAuthority(db, f.scope, f.store, f.clock).authenticated(f.ref, work));
  assert.equal(calls, 0);
});
test("server authority requires current active owner grants and cannot satisfy an added factor requirement", async t => {
  for (const change of ["UPDATE control_identities SET state='suspended'",
    "UPDATE control_role_grants SET revoked_at=created_at", "UPDATE control_role_grants SET require_strong_factor=true"]) await t.test(change, async t => {
    const f = await fixture(); t.after(f.close); let calls = 0;
    await f.db.query(change);
    await assert.rejects(f.authority.authenticated(f.ref, async () => { calls++; }));
    assert.equal(calls, 0);
  });
});
test("approval deadline expiry before commit rolls back the server operation", async t => {
  const f = await fixture(); t.after(f.close);
  await f.db.query("CREATE TABLE synthetic_server_operation(id int)");
  await assert.rejects(f.authority.authenticated(f.ref, async tx => {
    await tx.query("INSERT INTO synthetic_server_operation VALUES(1)");
    f.setNow(f.prepared.start.deadline);
  }));
  assert.equal((await f.db.query("SELECT * FROM synthetic_server_operation")).rows.length, 0);
});

test("never-staged recovery uses current approval after logout and caps canonical recoveries at three", async t => {
  const f = await fixture(); t.after(f.close);
  await new WebSessionAuthority(f.db, f.scope, f.clock).logout(f.identity);
  const ordinals: number[] = [];
  const coordinator = f.create(f.db, { enqueueInSession: async () => { assert.fail("not a fresh enqueue"); },
    recoverUnsentInSession: async (_tx, ref, ordinal) => { assert.deepEqual(ref, f.ref); ordinals.push(ordinal); return true; } });
  for (const ordinal of [1, 2, 3]) assert.deepEqual(await coordinator.recoverNeverStagedQueueDelivery(f.ref, f.abort.signal), { recovered: true, ordinal });
  await assert.rejects(coordinator.recoverNeverStagedQueueDelivery(f.ref, f.abort.signal));
  assert.deepEqual(ordinals, [1, 2, 3]);
  const audit = await f.db.query("SELECT * FROM audit_events WHERE action='native.queue.unsent_recovered'");
  assert.equal(audit.rows.length, 3);
});

test("recovery no-op does not consume audit budget or create another intent", async t => {
  const f = await fixture(); t.after(f.close);
  const ordinals: number[] = [];
  const coordinator = f.create(f.db, { enqueueInSession: async () => {},
    recoverUnsentInSession: async (_tx, _ref, ordinal) => { ordinals.push(ordinal); return false; } });
  for (let i = 0; i < 2; i++) assert.deepEqual(await coordinator.recoverNeverStagedQueueDelivery(f.ref, f.abort.signal), { recovered: false, ordinal: null });
  assert.deepEqual(ordinals, [1, 1]);
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.queue.unsent_recovered'")).rows.length, 0);
  assert.equal((await f.db.query("SELECT * FROM control_native_task_queue")).rows.length, 1);
  await assert.rejects(f.coordinator.recoverNeverStagedQueueDelivery(f.ref, f.abort.signal));
});

test("recovered pickup requires the exact current recovery sequence and current owner authority", async t => {
  const f = await fixture(); t.after(f.close);
  const coordinator = f.create(f.db, { enqueueInSession: async () => {}, recoverUnsentInSession: async () => true });
  await assert.rejects(coordinator.verifyRecoveredQueueDelivery(f.ref, 1, f.abort.signal));
  for (const ordinal of [1, 2]) {
    await coordinator.recoverNeverStagedQueueDelivery(f.ref, f.abort.signal);
    await coordinator.verifyRecoveredQueueDelivery(f.ref, ordinal, f.abort.signal);
    for (const wrong of [0, ordinal + 1, 4, 0.5, NaN]) await assert.rejects(coordinator.verifyRecoveredQueueDelivery(f.ref, wrong, f.abort.signal));
  }
  await assert.rejects(coordinator.verifyRecoveredQueueDelivery(f.ref, 1, f.abort.signal));
  for (const patch of [{ actor_id: "identity:other" }, { target_id: "job:other" }, { id: "audit:other" },
    { safe_metadata: { ordinal: 2, packetDigest: sha256Digest("other packet") } }]) {
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
      async query<T>(sql: string, values?: unknown[]) {
        const result = await tx.query<T>(sql, values);
        if (sql.startsWith("SELECT id,actor_id,target_id,safe_metadata FROM audit_events")) result.rows = result.rows.map(row => ({ ...row, ...patch }));
        return result;
      },
    }), check) };
    const corrupted = f.create(db, { enqueueInSession: async () => {}, recoverUnsentInSession: async () => true });
    await assert.rejects(corrupted.verifyRecoveredQueueDelivery(f.ref, 2, f.abort.signal));
  }
  await f.db.query("UPDATE control_role_grants SET revoked_at=created_at");
  await assert.rejects(coordinator.verifyRecoveredQueueDelivery(f.ref, 2, f.abort.signal));
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.queue.unsent_recovered'")).rows.length, 2);
});

test("ready-node discovery respects node and attempt scope and reports ineligible work as held", async t => {
  const f = await fixture(); t.after(f.close); let calls = 0;
  const coordinator = f.create(f.db, { enqueueInSession: async () => {}, recoverUnsentInSession: async () => { calls++; return true; } });
  for (const node of [{ nodeId: "node:other" }, { nodeId: f.route.nodeId, attemptId: "attempt:other" }])
    assert.deepEqual(await coordinator.recoverForReadyNode(node, f.abort.signal, () => {}), { examined: 0, recovered: 0, held: 0, truncated: false });
  await f.db.query("UPDATE control_role_grants SET revoked_at=created_at");
  assert.deepEqual(await coordinator.recoverForReadyNode({ nodeId: f.route.nodeId }, f.abort.signal, () => {}),
    { examined: 1, recovered: 0, held: 1, truncated: false });
  assert.equal(calls, 0);
});

test("readiness generation change before commit rolls back the recovery and audit", async t => {
  const f = await fixture(); t.after(f.close); let current = true;
  await f.db.query("CREATE TABLE synthetic_ready_recovery(id int)");
  const coordinator = f.create(f.db, { enqueueInSession: async () => {}, recoverUnsentInSession: async tx => {
    await tx.query("INSERT INTO synthetic_ready_recovery VALUES(1)"); current = false; return true;
  } });
  await assert.rejects(coordinator.recoverForReadyNode({ nodeId: f.route.nodeId }, f.abort.signal, () => { if (!current) throw new Error("synthetic replaced session"); }));
  assert.equal((await f.db.query("SELECT * FROM synthetic_ready_recovery")).rows.length, 0);
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.queue.unsent_recovered'")).rows.length, 0);
});

for (const failure of ["expiry", "abort", "throw", "revoked"] as const) test(`recovery ${failure} preserves operational and audit rollback`, async t => {
  const f = await fixture(); t.after(f.close); let calls = 0;
  await f.db.query("CREATE TABLE synthetic_unsent_recovery(id int)");
  if (failure === "revoked") await f.db.query("UPDATE control_role_grants SET revoked_at=created_at");
  const coordinator = f.create(f.db, { enqueueInSession: async () => {}, recoverUnsentInSession: async tx => {
    calls++; await tx.query("INSERT INTO synthetic_unsent_recovery VALUES(1)");
    if (failure === "expiry") f.setNow(f.prepared.start.deadline);
    if (failure === "abort") f.abort.abort();
    if (failure === "throw") throw new Error("synthetic operation uncertainty");
    return true;
  } });
  await assert.rejects(coordinator.recoverNeverStagedQueueDelivery(f.ref, f.abort.signal));
  assert.equal(calls, failure === "revoked" ? 0 : 1);
  assert.equal((await f.db.query("SELECT * FROM synthetic_unsent_recovery")).rows.length, 0);
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.queue.unsent_recovered'")).rows.length, 0);
});
