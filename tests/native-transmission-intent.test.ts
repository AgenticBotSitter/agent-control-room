import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalApprovalStorageFixture as fixture } from "./helpers/canonical-approval-storage";
import { nativeEnvelopeSession } from "./helpers/native-envelope-session";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Session = Awaited<ReturnType<typeof nativeEnvelopeSession>>;
const transmit = (f: Fixture, s: Session, c = f.coordinator) => c.transmitQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal);
const count = async (f: Fixture) => (await f.db.query("SELECT * FROM control_native_transmission_intents")).rows.length;
const sends = (s: Session) => s.sent.filter(raw => JSON.parse(raw).type === "harness.native.dispatch");
async function ready(options: Parameters<typeof nativeEnvelopeSession>[1] = {}) {
  const f = await fixture(); await f.save(); await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  const s = await nativeEnvelopeSession(f, options);
  await f.coordinator.stageQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal);
  return { f, s };
}

test("exact stored frame enters transport once and only after intent and audit commit", async t => {
  let committed = false;
  const { f, s } = await ready({ async send() { assert.equal(committed, true); assert.equal(await count(f), 1); } });
  t.after(async () => { await s.close(); await f.close(); });
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    const value = await f.db.transactionWithPreCommitCheck(work, check); committed = true; return value;
  } };
  const result = await transmit(f, s, f.create(db));
  assert.equal(result.deliveryConfirmed, false); assert.equal(result.transportResult, "returned_without_receipt");
  assert.equal(result.receipt.evidence, "stored_transmission_intent");
  assert.equal(sends(s).length, 1);
  const stored = (await f.db.query<{record:{frame:unknown}}>("SELECT record FROM control_native_delivery_envelopes")).rows[0].record.frame;
  assert.deepEqual(JSON.parse(sends(s)[0]), stored);
  assert.deepEqual(await f.coordinator.readNativeTransmissionIntent(...f.args), result.receipt);
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.delivery.transmission_requested'")).rows.length, 1);
  await assert.rejects(transmit(f, s)); assert.equal(sends(s).length, 1);
});

test("pre-commit expiry, cancellation, trust and disconnect prevent transport and roll back intent", async t => {
  for (const mode of ["expiry", "abort", "trust", "disconnect"] as const) await t.test(mode, async t => {
    const { f, s } = await ready(); t.after(async () => { await s.close(); await f.close(); });
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
      const value = await work(tx); if (mode === "expiry") f.setNow(f.prepared.start.deadline);
      else if (mode === "abort") f.abort.abort(); else if (mode === "trust") await f.native.revoke(); else s.session.disconnect();
      return value;
    }, check) };
    await assert.rejects(transmit(f, s, f.create(db))); assert.equal(await count(f), 0); assert.equal(sends(s).length, 0);
  });
});

test("lost commit acknowledgement records intent but never enters transport or retries", async t => {
  const { f, s } = await ready(); t.after(async () => { await s.close(); await f.close(); });
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    await f.db.transactionWithPreCommitCheck(work, check); throw new Error("synthetic_lost_ack");
  } };
  await assert.rejects(transmit(f, s, f.create(db))); assert.equal(await count(f), 1); assert.equal(sends(s).length, 0);
  const receipt = await f.coordinator.readNativeTransmissionIntent(...f.args); assert.ok(receipt); assert.equal(receipt.deliveryConfirmed, false);
  await assert.rejects(transmit(f, s)); assert.equal(sends(s).length, 0);
});

test("post-commit cancellation prevents transmission while preserving honest intent history", async t => {
  const { f, s } = await ready(); t.after(async () => { await s.close(); await f.close(); });
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    const value = await f.db.transactionWithPreCommitCheck(work, check); f.abort.abort(); return value;
  } };
  await assert.rejects(transmit(f, s, f.create(db))); assert.equal(await count(f), 1); assert.equal(sends(s).length, 0);
});

test("transport rejection is uncertain and cannot cause a second send", async t => {
  const { f, s } = await ready({ async send() { throw new Error("synthetic_transport_failure"); } });
  t.after(async () => { await s.close(); await f.close(); });
  await assert.rejects(transmit(f, s), /synthetic_transport_failure/); assert.equal(await count(f), 1); assert.equal(sends(s).length, 1);
  await assert.rejects(transmit(f, s)); assert.equal(sends(s).length, 1);
  f.setNow(f.prepared.start.deadline); f.approvals.close();
  assert.ok(await f.coordinator.readNativeTransmissionIntent(...f.args));
});

test("transmission intent remains immutable and inaccessible to web SQL", async t => {
  const { f, s } = await ready(); t.after(async () => { await s.close(); await f.close(); });
  await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec("SET ROLE control_room_task_coordinator");
  try { await transmit(f, s); } finally { await f.raw.exec("RESET ROLE"); }
  for (const sql of ["UPDATE control_native_transmission_intents SET record=record", "DELETE FROM control_native_transmission_intents", "TRUNCATE control_native_transmission_intents"])
    await assert.rejects(f.db.query(sql));
  await f.raw.exec("SET ROLE control_room_private_web");
  try { await assert.rejects(count(f)); } finally { await f.raw.exec("RESET ROLE"); }
});

test("stalled send times out once; concurrent and later calls cannot retry it", async t => {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { f, s } = await ready({ async send() { entered(); await gate; } });
  t.after(async () => { release(); await s.close(); await f.close(); });
  const pending = assert.rejects(transmit(f, s), /uncertain/);
  await waiting;
  await assert.rejects(transmit(f, s));
  await pending;
  assert.equal(await count(f), 1); assert.equal(sends(s).length, 1);
  release(); await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(transmit(f, s)); assert.equal(sends(s).length, 1);
});

test("transmission history verifies its HMAC before returning reconciliation evidence", async t => {
  const { f, s } = await ready(); t.after(async () => { await s.close(); await f.close(); }); await transmit(f, s);
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      return sql.startsWith("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_transmission_intents")
        ? { rows: result.rows.map(row => Object.assign({}, row, { auth_tag: "hmac-sha256:" + "0".repeat(64) })) } : result;
    },
  }), check) };
  await assert.rejects(f.create(db).readNativeTransmissionIntent(...f.args));
});
