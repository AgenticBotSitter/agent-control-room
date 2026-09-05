import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalApprovalStorageFixture as fixture } from "./helpers/canonical-approval-storage";
import { nativeEnvelopeSession } from "./helpers/native-envelope-session";
import { NativeDispatchIntakeHandler } from "../src/node-bridge/native-dispatch-handler";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import type { SignedNodeFrame } from "../src/node-protocol/v1";
import { sha256Digest } from "../src/security";

async function ready(enabled = true, nodeSend?: (raw: string) => Promise<void>) {
  const f = await fixture(); await f.save();
  await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  let handler: NativeDispatchIntakeHandler | undefined;
  const s = await nativeEnvelopeSession(f, enabled ? { nodeSend, nativeHandler(journal) {
    handler = new NativeDispatchIntakeHandler(f.prepared.enrollment, journal, { approvals: f.approvals, security: f.native.trust }, f.clock);
    return handler;
  } } : {});
  await f.coordinator.stageQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal);
  await f.coordinator.transmitQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal);
  const raw = s.sent.find(raw => JSON.parse(raw).type === "harness.native.dispatch")!;
  const frame = JSON.parse(raw) as SignedNodeFrame<"harness.native.dispatch">;
  return { f, s, frame, handler, deliver: () => s.bridge.receive(raw, new Date(f.clock()).toISOString()),
    close: async () => { await s.close(); await f.close(); } };
}

test("canonical signed delivery reaches durable node intake and authenticated server receipt with no native execution", async t => {
  const x = await ready(); t.after(x.close); await x.deliver();
  const local = x.s.journal.nativeDeliveryReceipt(x.frame.body.queueId); assert.ok(local);
  assert.equal(local.startsWork, false); assert.equal(local.grantsExecutionAuthority, false);
  assert.equal(x.s.journal.queuedCommandCount(), 0);
  assert.equal(x.s.incoming.length, 1);
  const raw = x.s.incoming.shift()!;
  assert.equal(JSON.parse(raw).type, "harness.native.dispatch.receipt");
  assert.deepEqual(JSON.parse(raw).body, local);
  const saved = await x.f.store.receiveDeliveryReceipt(x.f.db, x.s.session, raw, x.f.abort.signal);
  assert.equal(saved.nodeReportedDisposition, "recorded"); assert.equal(saved.executionConfirmed, false);
  assert.deepEqual(await x.f.coordinator.readNativeDeliveryReceipt(...x.f.args), saved);
  await assert.rejects(x.deliver()); assert.equal(x.s.incoming.length, 0);
});

test("unconfigured handler and unavailable owner pins cannot turn a server signature into permission", async t => {
  for (const mode of ["unconfigured", "owner-pins", "expired", "closed"] as const) await t.test(mode, async t => {
    const x = await ready(mode !== "unconfigured"); t.after(x.close);
    if (mode === "owner-pins") x.f.approvals.close();
    if (mode === "expired") x.f.setNow(x.f.prepared.start.deadline);
    if (mode === "closed") x.handler!.close();
    await assert.rejects(x.deliver());
    assert.equal(x.s.journal.nativeDeliveryReceipt(x.frame.body.queueId), undefined);
    assert.equal(x.s.incoming.length, 0); assert.equal(x.s.journal.queuedCommandCount(), 0);
  });
});

test("connection changes during owner verification prevent recording and signing a receipt", async t => {
  const x = await ready(); t.after(x.close);
  const channel = x.s.bridge.nativeDeliveryChannel()!;
  const pending = x.handler!.accept(x.frame, channel);
  await x.s.bridge.disconnected();
  await assert.rejects(pending);
  assert.equal(x.s.journal.nativeDeliveryReceipt(x.frame.body.queueId), undefined);
});

test("node receipt and exact frame persist across SQLite reopen; conflicting attempts cannot replace them", async t => {
  const x = await ready(); t.after(x.close); await x.deliver();
  const receipt = x.s.journal.nativeDeliveryReceipt(x.frame.body.queueId)!;
  const directory = await mkdtemp(join(tmpdir(), "cr-native-intake-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "bridge.sqlite"); let journal = new SqliteBridgeJournal(path);
  try {
    journal.recordNativeDelivery(x.frame, receipt, () => {}); journal.close(); journal = new SqliteBridgeJournal(path);
    assert.deepEqual(journal.nativeDeliveryReceipt(x.frame.body.queueId), receipt);
    assert.throws(() => journal.recordNativeDelivery(x.frame, receipt, () => {}), /already_recorded/);
    const db = new DatabaseSync(path);
    try { assert.throws(() => db.exec("UPDATE bridge_native_deliveries SET receipt_json='{}'"));
      assert.throws(() => db.exec("DELETE FROM bridge_native_deliveries")); } finally { db.close(); }
  } finally { journal.close(); }
});

test("intake pre-commit fence rolls back its record without manufacturing a receipt", async t => {
  const x = await ready(); t.after(x.close); await x.deliver();
  const journal = new SqliteBridgeJournal(":memory:"); t.after(() => journal.close()); let checks = 0;
  assert.throws(() => journal.recordNativeDelivery(x.frame, x.s.journal.nativeDeliveryReceipt(x.frame.body.queueId)!, () => {
    if (++checks === 2) throw new Error("synthetic_precommit_failure");
  }), /synthetic_precommit_failure/);
  assert.equal(checks, 2); assert.equal(journal.nativeDeliveryReceipt(x.frame.body.queueId), undefined);
});

test("receipt transport uncertainty preserves durable intake and never repeats delivery handling", async t => {
  let sends = 0;
  const x = await ready(true, async raw => {
    if (JSON.parse(raw).type === "harness.native.dispatch.receipt") { sends++; throw new Error("synthetic_receipt_send_uncertain"); }
  }); t.after(x.close);
  await assert.rejects(x.deliver(), /synthetic_receipt_send_uncertain/);
  assert.equal(sends, 1); assert.ok(x.s.journal.nativeDeliveryReceipt(x.frame.body.queueId));
  await assert.rejects(x.deliver()); assert.equal(sends, 1);
  assert.equal(x.s.journal.pendingOutbound().filter(x => x.frame.type === "harness.native.dispatch.receipt").length, 1);
});

test("concurrent intake cannot duplicate its record and mutable caller input cannot alter retained delivery", async t => {
  const x = await ready(); t.after(x.close); const channel = x.s.bridge.nativeDeliveryChannel()!;
  const original = structuredClone(x.frame);
  const first = x.handler!.accept(x.frame, channel);
  const second = assert.rejects(x.handler!.accept(x.frame, channel), /native_intake_unavailable/);
  x.frame.body.packetDigest = "sha256:" + "0".repeat(64);
  await second;
  const result = await first;
  assert.equal(result.packetDigest, original.body.packetDigest);
  assert.deepEqual(x.s.journal.nativeDeliveryReceipt(original.body.queueId), result);
});

test("owner trust closure while intake is awaiting verification leaves no durable delivery", async t => {
  const x = await ready(); t.after(x.close);
  const pending = x.handler!.accept(x.frame, x.s.bridge.nativeDeliveryChannel()!);
  x.f.approvals.close(); await assert.rejects(pending);
  assert.equal(x.s.journal.nativeDeliveryReceipt(x.frame.body.queueId), undefined);
});

test("old bridge intake failure cannot invalidate a fully reconciled replacement connection", async t => {
  const x = await ready(); t.after(x.close);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const accept = x.handler!.accept.bind(x.handler);
  x.handler!.accept = async (...args) => { entered(); await gate; return accept(...args); };
  const old = assert.rejects(x.deliver()); await waiting;
  const replacement = await x.s.reconnect();
  assert.equal(x.s.bridge.status().state, "online"); assert.ok(replacement.nativeDeliveryChannel());
  const current = x.s.bridge.nativeDeliveryChannel()!; assert.notEqual(current.connectionId, x.frame.connectionId);
  release(); await old;
  current.assertCurrent(); assert.equal(x.s.bridge.status().state, "online");
  assert.ok(replacement.nativeDeliveryChannel()); assert.equal(x.s.incoming.length, 0);
  assert.equal(x.s.journal.nativeDeliveryReceipt(x.frame.body.queueId), undefined);
});
