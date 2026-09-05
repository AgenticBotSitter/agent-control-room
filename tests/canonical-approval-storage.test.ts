import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { binding, instant } from "./hermes-native-fixture";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";
import { canonicalApprovalStorageFixture as fixture } from "./helpers/canonical-approval-storage";

test("owner saves exact signed packet once; replay preserves receipt without dispatch", async t => {
  const f = await fixture(); t.after(f.close);
  const before = (await f.db.query("SELECT * FROM control_outbox")).rows;
  const saved = await f.save(); assert.equal(saved.replayed, false); assert.equal(saved.startsWork, false);
  f.setNow(instant + 10_000);
  assert.deepEqual(await f.save(), { ...saved, replayed: true }); assert.equal(await f.count(), 1);
  assert.equal("storeNativeApproval" in f.coordinator.webOperation(), false);
  assert.deepEqual((await f.db.query("SELECT * FROM control_outbox")).rows, before);
  assert.equal((await f.db.query("SELECT * FROM control_approvals")).rows.length, 0);
});

test("invalid signature, wrong task and conflicting signed packet cannot be stored", async t => {
  const f = await fixture(); t.after(f.close);
  const invalid = structuredClone(f.packet); invalid.approval.signature = "A".repeat(86);
  await assert.rejects(f.save(invalid)); assert.equal(await f.count(), 0);
  await assert.rejects(f.save({ ...f.packet, recovery: f.sign({ ...f.packet.recovery.body, bindingDigest: sha256Digest("other") }) }));
  await f.save();
  await assert.rejects(f.save({ ...f.packet, recovery: f.sign({ ...f.packet.recovery.body, nonce: "different-signed-nonce" }) }));
  assert.equal(await f.count(), 1);
});

test("current owner and reservation remain required even for packet replay", async t => {
  const f = await fixture(); t.after(f.close); await f.save(); f.setNow(f.prepared.start.deadline);
  await assert.rejects(f.save());
  const g = await fixture(); t.after(g.close);
  await g.db.query("UPDATE control_role_grants SET role_key='operator' WHERE tenant_id=$1", [binding.tenantId]);
  await assert.rejects(g.save()); assert.equal(await g.count(), 0);
});

test("commit-time cancellation and trust revocation roll back packet evidence", async t => {
  for (const mode of ["abort", "trust", "expiry"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close);
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
      const result = await work(tx);
      if (mode === "abort") f.abort.abort();
      else if (mode === "trust") await f.native.revoke();
      else f.setNow(f.prepared.start.deadline);
      return result;
    }, check) };
    await assert.rejects(f.save(f.packet, f.create(db))); assert.equal(await f.count(), 0);
  });
});

test("stored evidence is append-only and tampered readback cannot replay", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  for (const sql of ["UPDATE control_native_approval_packets SET record=record", "DELETE FROM control_native_approval_packets", "TRUNCATE control_native_approval_packets"])
    await assert.rejects(f.db.query(sql));
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      return sql.startsWith("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag")
        ? { rows: result.rows.map(row => Object.assign({}, row, { auth_tag: "hmac-sha256:" + "0".repeat(64) })) } : result;
    },
  }), check) };
  await assert.rejects(f.save(f.packet, f.create(db)));
});

test("coordinator role can save while private web cannot read or insert packet evidence", async t => {
  const f = await fixture(); t.after(f.close);
  await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec("SET ROLE control_room_task_coordinator");
  try { assert.equal((await f.save()).replayed, false); } finally { await f.raw.exec("RESET ROLE"); }
  await f.raw.exec("SET ROLE control_room_private_web");
  try {
    await assert.rejects(f.db.query("SELECT * FROM control_native_approval_packets"));
    await assert.rejects(f.save());
  } finally { await f.raw.exec("RESET ROLE"); }
  assert.equal(await f.count(), 1);
});

test("packet input is copied before asynchronous canonical reads", async t => {
  const f = await fixture(); t.after(f.close);
  const packet = structuredClone(f.packet), expected = sha256Digest(packet);
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => {
    packet.approval.signature = "A".repeat(86);
    return f.db.transactionWithPreCommitCheck(work, check);
  } };
  assert.equal((await f.save(packet, f.create(db))).packetDigest, expected);
});
