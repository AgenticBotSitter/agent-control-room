import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalApprovalStorageFixture as fixture } from "./helpers/canonical-approval-storage";
import { nativeEnvelopeSession } from "./helpers/native-envelope-session";
import { sha256Digest } from "../src/security";
import { verifyNodeFrameSignature, type SignedNodeFrame } from "../src/node-protocol/v1";
import type { DatabaseClient } from "../src/persistence/database";
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Session = Awaited<ReturnType<typeof nativeEnvelopeSession>>;
const stage = (f: Fixture, s: Session, c = f.coordinator) => c.stageQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal);
const count = async (f: Fixture) => (await f.db.query("SELECT * FROM control_native_delivery_envelopes")).rows.length;
async function ready() {
  const f = await fixture(); await f.save(); await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  const s = await nativeEnvelopeSession(f); return { f, s };
}

test("canonical approval and actual server session persist one exact signed frame without transmission", async t => {
  const { f, s } = await ready(); t.after(async () => { await s.close(); await f.close(); });
  const before = s.sent.length;
  const receipt = await stage(f, s);
  assert.equal(receipt.evidence, "stored_signed_delivery_envelope"); assert.equal(receipt.startsWork, false);
  assert.equal(s.sent.length, before);
  const r = (await f.db.query<{record:{frame:SignedNodeFrame}}>("SELECT record FROM control_native_delivery_envelopes")).rows[0].record;
  assert.equal(r.frame.type, "harness.native.dispatch"); assert.equal(verifyNodeFrameSignature(r.frame, s.spki), true);
  assert.equal(sha256Digest(r.frame), receipt.frameDigest);
  assert.deepEqual(await f.coordinator.readNativeDeliveryEnvelope(...f.args), receipt);
  assert.equal(s.session.nativeDeliveryChannel(), undefined);
  await assert.rejects(stage(f, s));
  const replacement = await nativeEnvelopeSession(f); t.after(replacement.close);
  await assert.rejects(stage(f, replacement)); assert.equal(await count(f), 1);
  assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.delivery.staged'")).rows.length, 1);
  f.setNow(f.prepared.start.deadline); f.approvals.close();
  assert.deepEqual(await f.coordinator.readNativeDeliveryEnvelope(...f.args), receipt);
  assert.equal("frame" in receipt, false);
});

test("expiry, cancellation, trust and disconnect at commit roll back envelope and audit", async t => {
  for (const mode of ["expiry", "abort", "trust", "disconnect"] as const) await t.test(mode, async t => {
    const { f, s } = await ready(); t.after(async () => { await s.close(); await f.close(); });
    const before = s.sent.length;
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
      const value = await work(tx); if (mode === "expiry") f.setNow(f.prepared.start.deadline);
      else if (mode === "abort") f.abort.abort(); else if (mode === "trust") await f.native.revoke(); else s.session.disconnect();
      return value;
    }, check) };
    await assert.rejects(stage(f, s, f.create(db))); assert.equal(await count(f), 0); assert.equal(s.sent.length, before);
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE action='native.delivery.staged'")).rows.length, 0);
  });
});

test("lost commit acknowledgement leaves historical envelope but never resends or resigns it", async t => {
  const { f, s } = await ready(); t.after(async () => { await s.close(); await f.close(); });
  const before = s.sent.length;
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    await f.db.transactionWithPreCommitCheck(work, check); throw new Error("synthetic_lost_ack");
  } };
  await assert.rejects(stage(f, s, f.create(db))); assert.equal(await count(f), 1); assert.equal(s.sent.length, before);
  const receipt = await f.coordinator.readNativeDeliveryEnvelope(...f.args); assert.ok(receipt);
  assert.equal("frame" in receipt, false); assert.equal("packet" in receipt, false);
});

test("coordinator may stage but web cannot read envelopes and immutable history cannot be rewritten", async t => {
  const { f, s } = await ready(); t.after(async () => { await s.close(); await f.close(); });
  await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec("SET ROLE control_room_task_coordinator");
  try { await stage(f, s); } finally { await f.raw.exec("RESET ROLE"); }
  for (const sql of ["UPDATE control_native_delivery_envelopes SET record=record", "DELETE FROM control_native_delivery_envelopes", "TRUNCATE control_native_delivery_envelopes"])
    await assert.rejects(f.db.query(sql));
  await f.raw.exec("SET ROLE control_room_private_web");
  try { await assert.rejects(count(f)); } finally { await f.raw.exec("RESET ROLE"); }
});

test("envelope expiry respects the canonical node key validity limit", async t => {
  const { f, s } = await ready(); t.after(async () => { await s.close(); await f.close(); });
  const expiresAt = new Date(f.clock() + 1000).toISOString();
  await f.db.query("UPDATE control_node_keys SET valid_until=$1 WHERE id='key:test'", [expiresAt]);
  const receipt = await stage(f, s); assert.equal(receipt.expiresAt, expiresAt);
});

test("missing queued authority cannot stage an envelope", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  const s = await nativeEnvelopeSession(f); t.after(s.close);
  const before = s.sent.length;
  await assert.rejects(stage(f, s)); assert.equal(await count(f), 0); assert.equal(s.sent.length, before);
});

test("historical envelope HMAC and expected input scope are verified", async t => {
  const { f, s } = await ready(); t.after(async () => { await s.close(); await f.close(); }); await stage(f, s);
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      return sql.startsWith("SELECT tenant_id,project_id,job_id,attempt_id,message_id,record,auth_tag FROM control_native_delivery_envelopes")
        ? { rows: result.rows.map(row => Object.assign({}, row, { auth_tag: "hmac-sha256:" + "0".repeat(64) })) } : result;
    },
  }), check) };
  await assert.rejects(f.create(db).readNativeDeliveryEnvelope(...f.args));
  await assert.rejects(f.coordinator.readNativeDeliveryEnvelope(f.args[0], f.args[1], f.args[2], sha256Digest("other")));
});
