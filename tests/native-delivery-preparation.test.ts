import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalApprovalStorageFixture as fixture } from "./helpers/canonical-approval-storage";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";
import { nativeTaskDispatchBodySchema, prepareNativeTaskDispatchIntake } from "../src/harness/v1/native-delivery";
type Fixture = Awaited<ReturnType<typeof fixture>>;
const prepare = (f: Fixture, c = f.coordinator) => c.prepareQueuedNativeDelivery(...f.args, sha256Digest(f.packet), f.abort.signal);
const queue = (f: Fixture) => f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
const count = async (f: Fixture) => (await f.db.query("SELECT * FROM control_native_delivery_preparations")).rows.length;

test("queued canonical task produces one immutable protocol body and audit with historical receipt", async t => {
  const f = await fixture(); t.after(f.close); await f.save(); await queue(f);
  assert.equal(await f.coordinator.readNativeDeliveryPreparation(...f.args), null);
  const receipt = await prepare(f); assert.equal(receipt.startsWork, false); assert.equal(receipt.evidence, "stored_unsigned_delivery_body");
  const record = (await f.db.query<{record:{body:unknown}}>("SELECT record FROM control_native_delivery_preparations")).rows[0].record;
  const body = nativeTaskDispatchBodySchema.parse(record.body); assert.equal(sha256Digest(body), receipt.bodyDigest);
  assert.deepEqual(prepareNativeTaskDispatchIntake(body, f.prepared.enrollment).packet, f.packet);
  f.setNow(f.clock() + 1000); assert.deepEqual(await prepare(f), { ...receipt, replayed: true });
  assert.equal(await count(f), 1);
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.delivery.prepared'")).rows.length, 1);
  f.setNow(f.prepared.start.deadline); f.approvals.close();
  const { replayed: _r, ...historical } = receipt; void _r;
  assert.deepEqual(await f.coordinator.readNativeDeliveryPreparation(...f.args), historical);
  await assert.rejects(prepare(f));
});

test("approval without queued intent cannot produce a delivery record", async t => {
  const f = await fixture(); t.after(f.close); await f.save(); await assert.rejects(prepare(f)); assert.equal(await count(f), 0);
});

test("commit-time expiry, cancellation and trust changes roll back prepared body and audit", async t => {
  for (const mode of ["expiry", "abort", "trust"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close); await f.save(); await queue(f);
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
      const value = await work(tx); if (mode === "expiry") f.setNow(f.prepared.start.deadline);
      else if (mode === "abort") f.abort.abort(); else await f.native.revoke(); return value;
    }, check) };
    await assert.rejects(prepare(f, f.create(db))); assert.equal(await count(f), 0);
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.delivery.prepared'")).rows.length, 0);
  });
});

test("lost commit acknowledgement reconciles without re-preparing or exposing stored body", async t => {
  const f = await fixture(); t.after(f.close); await f.save(); await queue(f);
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    await f.db.transactionWithPreCommitCheck(work, check); throw new Error("synthetic_lost_ack");
  } };
  await assert.rejects(prepare(f, f.create(db))); assert.equal(await count(f), 1);
  const receipt = await f.coordinator.readNativeDeliveryPreparation(...f.args); assert.ok(receipt);
  assert.equal("body" in receipt, false); assert.equal("packet" in receipt, false);
  await assert.rejects(f.coordinator.readNativeDeliveryPreparation(f.args[0], f.args[1], f.args[2], sha256Digest("other")));
});

test("queue or delivery HMAC tampering fails closed", async t => {
  for (const table of ["control_native_task_queue", "control_native_delivery_preparations"]) await t.test(table, async t => {
    const f = await fixture(); t.after(f.close); await f.save(); await queue(f); await prepare(f);
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
      async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        return sql.startsWith(`SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM ${table}`)
          ? { rows: result.rows.map(row => Object.assign({}, row, { auth_tag: "hmac-sha256:" + "0".repeat(64) })) } : result;
      },
    }), check) };
    await assert.rejects(prepare(f, f.create(db)));
    if (table === "control_native_delivery_preparations") await assert.rejects(f.create(db).readNativeDeliveryPreparation(...f.args));
  });
});

test("coordinator may prepare but web cannot read body; history cannot be overwritten or erased", async t => {
  const f = await fixture(); t.after(f.close); await f.save(); await queue(f);
  await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec("SET ROLE control_room_task_coordinator");
  try { await prepare(f); } finally { await f.raw.exec("RESET ROLE"); }
  for (const sql of ["UPDATE control_native_delivery_preparations SET record=record", "DELETE FROM control_native_delivery_preparations", "TRUNCATE control_native_delivery_preparations"])
    await assert.rejects(f.db.query(sql));
  await f.raw.exec("SET ROLE control_room_private_web");
  try { await assert.rejects(count(f)); await assert.rejects(prepare(f)); } finally { await f.raw.exec("RESET ROLE"); }
});
