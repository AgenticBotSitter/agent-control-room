import test from "node:test";
import assert from "node:assert/strict";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { enrollment, binding, instant } from "./hermes-native-fixture";
import { verifyNativeTaskApprovalBinding } from "../src/harness/hermes-native-v1/task-approval-binding";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";

async function fixture() {
  const f = await taskAssignmentFixture(); await f.assign(); let now = instant + 9000;
  const configured = [{ enrollment: { ...enrollment }, nodeClass: "personal-compute" }];
  const create = (db: DatabaseClient = f.db, enrollments = configured) => new TaskAssignmentCoordinator(db, f.scope, f.planner, [f.route], () => now, enrollments);
  const coordinator = create();
  const prepare = (c = coordinator) => c.prepareNativeApproval(f.identity, binding.projectId, f.prepared.receipt.jobId, f.prepared.receipt.inputDigest);
  return { ...f, configured, create, coordinator, prepare, setNow: (value: number) => { now = value; } };
}

test("owner-authorized preparation reads locked canonical assignment and saved content without dispatch", async t => {
  const f = await fixture(); t.after(f.close);
  const before = await f.canonical.get(binding.tenantId, "job", f.prepared.receipt.jobId);
  const outbox = (await f.db.query("SELECT * FROM control_outbox")).rows;
  const result = await f.prepare();
  assert.equal(result.request.approval, undefined); assert.equal(result.startsWork, false); assert.equal(result.grantsExecutionAuthority, false);
  assert.equal(result.inputDigest, f.prepared.receipt.inputDigest);
  assert.deepEqual(verifyNativeTaskApprovalBinding(result.enrollment, result.request, result.start).binding, result.binding);
  assert.deepEqual(await f.canonical.get(binding.tenantId, "job", f.prepared.receipt.jobId), before);
  assert.deepEqual((await f.db.query("SELECT * FROM control_outbox")).rows, outbox);
  assert.equal("prepareNativeApproval" in f.coordinator.webOperation(), false);
  for (const table of ["control_approvals", "control_effect_intents"]) assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length, 0);
});

test("enrollment is configured, copied and matched to the actual reserved machine", async t => {
  const f = await fixture(); t.after(f.close);
  f.configured[0].enrollment.model = "changed";
  assert.equal((await f.prepare()).enrollment.model, enrollment.model);
  await assert.rejects(f.prepare(f.create(f.db, [])), { code: "conflict" });
  assert.throws(() => f.create(f.db, [f.configured[0], f.configured[0]]));
  assert.throws(() => f.create(f.db, [{ ...f.configured[0], enrollment: { ...enrollment, tenantId: "tenant:other" } }]));
});

test("wrong content digest, expired reservation and stopped node reject preparation", async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(f.coordinator.prepareNativeApproval(f.identity, binding.projectId, f.prepared.receipt.jobId, sha256Digest("wrong")), { code: "conflict" });
  f.setNow(instant + 70_000); await assert.rejects(f.prepare());
  const g = await fixture(); t.after(g.close);
  await g.db.query("UPDATE control_nodes SET state='draining',payload=jsonb_set(payload,'{state}','\"draining\"') WHERE tenant_id=$1 AND id=$2", [binding.tenantId, binding.nodeId]);
  await assert.rejects(g.prepare());
});

test("current owner role and session are required, not just an earlier assignment", async t => {
  for (const mode of ["role", "session"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close);
    if (mode === "role") await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE tenant_id=$1", [binding.tenantId]);
    else await f.db.query("UPDATE control_web_sessions SET revoked_at=$1 WHERE tenant_id=$2", [new Date(instant + 9000).toISOString(), binding.tenantId]);
    await assert.rejects(f.prepare());
  });
});

test("deadline crossing at commit cannot return signing material", async t => {
  const f = await fixture(); t.after(f.close);
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
    const result = await work(tx); f.setNow(instant + 70_000); return result;
  }, check) };
  await assert.rejects(f.prepare(f.create(db)), { code: "conflict" });
});

test("missing assignment receipt cannot be promoted into owner approval material", async t => {
  const f = await fixture(); t.after(f.close);
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      return sql.includes("SELECT entity_id,safe_metadata") ? { rows: [] } : result;
    },
  }), check) };
  await assert.rejects(f.prepare(f.create(db)), /task_assignment_unavailable/);
});
