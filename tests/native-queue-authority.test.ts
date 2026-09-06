import test from "node:test";
import assert from "node:assert/strict";
import { canonicalApprovalStorageFixture } from "./helpers/canonical-approval-storage";
import { NativeQueueAuthority } from "../src/web/v1/native-queue-authority";
import { sha256Digest } from "../src/security";
import type { NativeTaskSubmissionReference } from "../src/persistence/native-task-submission";
import type { DatabaseClient } from "../src/persistence/database";

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
