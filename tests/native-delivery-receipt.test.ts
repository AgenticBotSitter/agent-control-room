import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalApprovalStorageFixture as fixture } from "./helpers/canonical-approval-storage";
import { nativeEnvelopeSession } from "./helpers/native-envelope-session";
import { NODE_PROTOCOL_V1, signNodeFrame, type SignedNodeFrame, type UnsignedNodeFrame } from "../src/node-protocol/v1";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";

async function ready() {
  const f = await fixture(); await f.save();
  await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  const s = await nativeEnvelopeSession(f);
  await f.coordinator.stageQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal);
  await f.coordinator.transmitQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal);
  const dispatch = JSON.parse(s.sent.find(raw => JSON.parse(raw).type === "harness.native.dispatch")!) as SignedNodeFrame<"harness.native.dispatch">;
  const make = async (change: (frame: UnsignedNodeFrame<"harness.native.dispatch.receipt">) => void = () => {}) => {
    const seq = (await f.db.query<{ last_sequence: number }>("SELECT last_sequence FROM node_protocol_connections WHERE tenant_id=$1 AND node_id=$2 AND connection_id=$3 AND direction='node_to_server'",
      [dispatch.tenantId, dispatch.body.request.nodeId, dispatch.connectionId])).rows[0].last_sequence;
    const q = dispatch.body.request;
    const frame: UnsignedNodeFrame<"harness.native.dispatch.receipt"> = {
      protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node", tenantId: q.tenantId,
      actorId: q.nodeId, keyId: "key:test", connectionId: dispatch.connectionId, sequence: Number(seq) + 1,
      messageId: `message:${randomUUID()}`, correlationId: dispatch.correlationId, causationId: dispatch.messageId,
      nonce: randomUUID(), sentAt: new Date(f.clock()).toISOString(), expiresAt: new Date(f.clock() + 60_000).toISOString(),
      type: "harness.native.dispatch.receipt", body: { schema: "control-room.native-task-dispatch-receipt/v1",
        queueId: dispatch.body.queueId, dispatchMessageId: dispatch.messageId, dispatchBodyDigest: dispatch.bodyDigest,
        tenantId: q.tenantId, projectId: q.projectId, nodeId: q.nodeId, jobId: q.jobId, attemptId: q.attemptId,
        packetDigest: dispatch.body.packetDigest, bindingDigest: dispatch.body.bindingDigest,
        recordedAt: new Date(f.clock()).toISOString(), disposition: "recorded", safeReason: "none", startsWork: false, grantsExecutionAuthority: false } };
    change(frame); return JSON.stringify(signNodeFrame(frame, f.keys.privateKey));
  };
  return { f, s, dispatch, make, receive: (raw: string, db = f.db) => f.store.receiveDeliveryReceipt(db, s.session, raw, f.abort.signal),
    count: async () => (await f.db.query("SELECT * FROM control_native_delivery_receipts")).rows.length,
    close: async () => { await s.close(); await f.close(); } };
}

test("signed exact receipt and audit commit together; history is metadata and not execution proof", async t => {
  const x = await ready(); t.after(x.close); const raw = await x.make(), result = await x.receive(raw);
  assert.equal(result.evidence, "stored_authenticated_node_receipt"); assert.equal(result.nodeReportedDisposition, "recorded");
  assert.equal(result.executionConfirmed, false); assert.equal(result.startsWork, false);
  assert.equal("frame" in result, false); assert.equal("packet" in result, false);
  assert.equal(await x.count(), 1);
  assert.equal((await x.f.db.query("SELECT * FROM audit_events WHERE action='native.delivery.receipt_recorded'")).rows.length, 1);
  assert.deepEqual(await x.f.coordinator.readNativeDeliveryReceipt(...x.f.args), result);
  await assert.rejects(x.receive(raw)); assert.equal(await x.count(), 1);
  assert.equal(x.s.sent.filter(raw => JSON.parse(raw).type === "harness.native.dispatch").length, 1);
});

test("signed rejection after task expiry is retained as rejection, not a renewed permission", async t => {
  const x = await ready(); t.after(x.close); x.f.setNow(x.f.prepared.start.deadline + 1);
  const result = await x.receive(await x.make(frame => { frame.body.disposition = "rejected"; frame.body.safeReason = "expired"; }));
  assert.equal(result.nodeReportedDisposition, "rejected"); assert.equal(result.safeReason, "expired");
  assert.equal(result.grantsExecutionAuthority, false);
  assert.deepEqual(await x.f.coordinator.readNativeDeliveryReceipt(...x.f.args), result);
});

test("wrong receipt binding, connection, key and signature cannot create receipt history", async t => {
  for (const mode of ["binding", "connection", "key", "signature", "future", "predates"] as const) await t.test(mode, async t => {
    const x = await ready(); t.after(x.close);
    let raw = await x.make(frame => {
      if (mode === "binding") frame.body.packetDigest = "sha256:" + "0".repeat(64);
      if (mode === "connection") frame.connectionId = "connection:wrong";
      if (mode === "key") frame.keyId = "key:wrong";
      if (mode === "future") { frame.body.recordedAt = new Date(x.f.clock() + 1000).toISOString(); frame.sentAt = frame.body.recordedAt; }
      if (mode === "predates") frame.body.recordedAt = new Date(x.f.clock() - 1).toISOString();
    });
    if (mode === "signature") {
      const { signature: _signature, bodyDigest: _digest, ...frame } = JSON.parse(raw); void _signature; void _digest;
      raw = JSON.stringify(signNodeFrame(frame, generateKeyPairSync("ed25519").privateKey));
    }
    await assert.rejects(x.receive(raw)); assert.equal(await x.count(), 0);
  });
});

test("authentication replay cannot be retried after receipt transaction rollback", async t => {
  const x = await ready(); t.after(x.close); const raw = await x.make();
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(async tx => {
    await work(tx); throw new Error("synthetic_rollback");
  }, check) };
  await assert.rejects(x.receive(raw, db), /synthetic_rollback/); assert.equal(await x.count(), 0);
  await assert.rejects(x.receive(raw));
  assert.equal((await x.f.db.query("SELECT * FROM audit_events WHERE action='native.delivery.receipt_recorded'")).rows.length, 0);
});

test("lost receipt commit acknowledgement preserves history without claiming success or replay", async t => {
  const x = await ready(); t.after(x.close); const raw = await x.make();
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: async (work, check) => {
    await x.f.db.transactionWithPreCommitCheck(work, check); throw new Error("synthetic_lost_ack");
  } };
  await assert.rejects(x.receive(raw, db), /synthetic_lost_ack/); assert.equal(await x.count(), 1);
  assert.ok(await x.f.coordinator.readNativeDeliveryReceipt(...x.f.args)); await assert.rejects(x.receive(raw));
});

test("disconnect, cancellation and node-key expiry at commit roll back receipt and audit", async t => {
  for (const mode of ["disconnect", "cancel", "key-expiry"] as const) await t.test(mode, async t => {
    const x = await ready(); t.after(x.close); const raw = await x.make();
    if (mode === "key-expiry") await x.f.db.query("UPDATE control_node_keys SET valid_until=$1 WHERE id='key:test'", [new Date(x.f.clock() + 1000).toISOString()]);
    let reached = false;
    const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(async tx => {
      const result = await work(tx);
      reached = true;
      if (mode === "disconnect") x.s.session.disconnect(); else if (mode === "cancel") x.f.abort.abort(); else x.f.setNow(x.f.clock() + 1000);
      return result;
    }, check) };
    await assert.rejects(x.receive(raw, db)); assert.equal(reached, true); assert.equal(await x.count(), 0);
  });
});

test("coordinator-only receipt inserts are immutable and web SQL cannot read them", async t => {
  const x = await ready(); t.after(x.close);
  await x.f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await x.f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  const raw = await x.make();
  // Authentication/replay belongs to its existing protocol role; the receipt transaction uses coordinator privileges.
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(async tx => {
    await tx.query("SET LOCAL ROLE control_room_task_coordinator"); return work(tx);
  }, check) };
  await x.receive(raw, db);
  for (const sql of ["UPDATE control_native_delivery_receipts SET record=record", "DELETE FROM control_native_delivery_receipts", "TRUNCATE control_native_delivery_receipts"])
    await assert.rejects(x.f.db.query(sql));
  await x.f.raw.exec("SET ROLE control_room_private_web");
  try { await assert.rejects(x.count()); } finally { await x.f.raw.exec("RESET ROLE"); }
});

test("HMAC corruption is denied on current-owner historical readback", async t => {
  const x = await ready(); t.after(x.close); await x.receive(await x.make());
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      return sql.startsWith("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag FROM control_native_delivery_receipts")
        ? { rows: result.rows.map(row => Object.assign({}, row, { auth_tag: "hmac-sha256:" + "0".repeat(64) })) } : result;
    },
  }), check) };
  await assert.rejects(x.f.create(db).readNativeDeliveryReceipt(...x.f.args));
});

test("revocation after protocol authentication is observed under receipt transaction locks", async t => {
  const x = await ready(); t.after(x.close); const raw = await x.make(); let reached = false;
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: async (work, check) => {
    reached = true;
    await x.f.db.query("UPDATE control_node_keys SET state='revoked',revoked_at=$1 WHERE id='key:test'", [new Date(x.f.clock()).toISOString()]);
    return x.f.db.transactionWithPreCommitCheck(work, check);
  } };
  await assert.rejects(x.receive(raw, db), /native_delivery_receipt_unavailable/);
  assert.equal(reached, true); assert.equal(await x.count(), 0);
});

test("generic protocol acknowledgement is not a native durable receipt", async t => {
  const x = await ready(); t.after(x.close);
  const { signature: _signature, bodyDigest: _digest, ...base } = JSON.parse(await x.make()); void _signature; void _digest;
  const raw = JSON.stringify(signNodeFrame({ ...base, type: "protocol.ack", body: {
    acknowledgedMessageIds: [x.dispatch.messageId], highestContiguousSequence: x.dispatch.sequence, disposition: "accepted" } }, x.f.keys.privateKey));
  await assert.rejects(x.receive(raw), /Expected native receipt/); assert.equal(await x.count(), 0);
});

test("late receipt transaction acknowledgement cannot resurrect a disconnected session", async t => {
  const x = await ready(); t.after(x.close); const raw = await x.make();
  const db: DatabaseClient = { ...x.f.db, transactionWithPreCommitCheck: async (work, check) => {
    const value = await x.f.db.transactionWithPreCommitCheck(work, check); x.s.session.disconnect(); return value;
  } };
  await assert.rejects(x.receive(raw, db)); assert.equal(await x.count(), 1);
  assert.ok(await x.f.coordinator.readNativeDeliveryReceipt(...x.f.args)); await assert.rejects(x.receive(raw));
});
