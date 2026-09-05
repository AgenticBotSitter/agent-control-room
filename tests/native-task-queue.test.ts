import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalApprovalStorageFixture as fixture } from "./helpers/canonical-approval-storage";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";
import { binding } from "./hermes-native-fixture";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const queue = (f: Fixture, c = f.coordinator, digest = sha256Digest(f.packet)) => c.enqueueNativeTask(...f.args, digest, f.abort.signal);
const rows = (f: Fixture) => f.db.query("SELECT * FROM control_native_task_queue");
const audit = (f: Fixture) => f.db.query("SELECT * FROM audit_events WHERE action='native.task.queued'");

test("approved task and audit queue once atomically, replay preserves the original receipt", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  const before = (await f.db.query("SELECT * FROM control_outbox")).rows;
  assert.equal(await f.coordinator.readNativeTaskQueue(...f.args), null);
  const a = await queue(f); f.setNow(f.clock() + 1000);
  assert.deepEqual(await queue(f), { ...a, replayed: true });
  const { replayed: _replayed, ...receipt } = a; void _replayed;
  assert.deepEqual(await f.coordinator.readNativeTaskQueue(...f.args), receipt);
  assert.equal(a.startsWork, false); assert.equal(a.grantsExecutionAuthority, false);
  assert.equal(a.evidence, "recorded_delivery_intent"); assert.equal((await rows(f)).rows.length, 1);
  assert.equal((await audit(f)).rows.length, 1); assert.deepEqual((await f.db.query("SELECT * FROM control_outbox")).rows, before);
  assert.equal("enqueueNativeTask" in f.coordinator.webOperation(), false);
});

test("queue refuses missing, mismatched or expired approval without creating intent", async t => {
  const f = await fixture(); t.after(f.close); await assert.rejects(queue(f)); await f.save();
  await assert.rejects(queue(f, f.coordinator, sha256Digest("other")));
  f.setNow(f.prepared.start.deadline); await assert.rejects(queue(f));
  assert.equal((await rows(f)).rows.length, 0); assert.equal((await audit(f)).rows.length, 0);
});

test("commit cancellation, trust revocation and expiry roll back both queue and audit", async t => {
  for (const mode of ["abort", "trust", "expiry"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close); await f.save();
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
      const value = await work(tx);
      if (mode === "abort") f.abort.abort(); else if (mode === "trust") await f.native.revoke(); else f.setNow(f.prepared.start.deadline);
      return value;
    }, check) };
    await assert.rejects(queue(f, f.create(db)));
    assert.equal((await rows(f)).rows.length, 0); assert.equal((await audit(f)).rows.length, 0);
  });
});

test("audit failure rolls back already inserted queue intent", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      if (/INSERT INTO audit_events/i.test(sql)) throw new Error("synthetic_audit_failure");
      return tx.query<T>(sql, params);
    },
  }), check) };
  await assert.rejects(queue(f, f.create(db)));
  assert.equal((await rows(f)).rows.length, 0); assert.equal((await audit(f)).rows.length, 0);
});

test("lost commit acknowledgement reconciles by authenticated read, including after expiry", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    await f.db.transactionWithPreCommitCheck(work, check); throw new Error("synthetic_lost_ack");
  } };
  await assert.rejects(queue(f, f.create(db))); assert.equal((await rows(f)).rows.length, 1);
  f.setNow(f.prepared.start.deadline); f.approvals.close();
  const receipt = await f.coordinator.readNativeTaskQueue(...f.args);
  assert.equal(receipt?.packetDigest, sha256Digest(f.packet)); assert.equal(receipt?.grantsExecutionAuthority, false);
  await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE tenant_id=$1", [binding.tenantId]);
  await assert.rejects(f.coordinator.readNativeTaskQueue(...f.args));
});

test("queue is immutable and unavailable to private web role", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec("SET ROLE control_room_task_coordinator");
  try { assert.equal((await queue(f)).replayed, false); } finally { await f.raw.exec("RESET ROLE"); }
  for (const sql of ["UPDATE control_native_task_queue SET record=record", "DELETE FROM control_native_task_queue", "TRUNCATE control_native_task_queue"])
    await assert.rejects(f.db.query(sql));
  await f.raw.exec("SET ROLE control_room_private_web");
  try { await assert.rejects(rows(f)); await assert.rejects(queue(f)); } finally { await f.raw.exec("RESET ROLE"); }
});

test("tampered queue evidence cannot be read or replayed", async t => {
  const f = await fixture(); t.after(f.close); await f.save(); await queue(f);
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      return sql.startsWith("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_task_queue")
        ? { rows: result.rows.map(row => Object.assign({}, row, { auth_tag: "hmac-sha256:" + "0".repeat(64) })) } : result;
    },
  }), check) };
  const c = f.create(db); await assert.rejects(queue(f, c)); await assert.rejects(c.readNativeTaskQueue(...f.args));
});
