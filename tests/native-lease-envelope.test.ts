import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { canonicalApprovalStorageFixture } from "./helpers/canonical-approval-storage";
import { nativeEnvelopeSession } from "./helpers/native-envelope-session";
import { sha256Digest } from "../src/security";
import { signedNodeFrameSchema, verifyNodeFrameSignature } from "../src/node-protocol/v1";
import { assertNativeLeaseDispatchPair } from "../src/harness/v1/native-lease-dispatch-pair";
import type { DatabaseClient } from "../src/persistence/database";

async function fixture(t: TestContext, options: Parameters<typeof nativeEnvelopeSession>[1] = {}) {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close);
  await f.save(); await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  const s = await nativeEnvelopeSession(f, { leaseDelivery: true, ...options }); t.after(s.close);
  return { f, s,
    stage: (coordinator = f.coordinator) => coordinator.stageQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal),
    transmit: () => f.coordinator.transmitQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal),
  };
}

test("negotiated canonical staging stores both signed messages and one intent binds their ordered transmission", async t => {
  const { f, s, stage, transmit } = await fixture(t), before = s.sent.length;
  assert.equal(s.session.nativeDeliveryChannel()?.leaseDelivery, true);
  const staged = await stage(); assert.equal(s.sent.length, before);
  const row = (await f.db.query<{ record: { frame: unknown; leaseFrame: unknown } }>("SELECT record FROM control_native_delivery_envelopes")).rows[0].record;
  const dispatch = signedNodeFrameSchema.parse(row.frame), lease = signedNodeFrameSchema.parse(row.leaseFrame);
  assert.equal(dispatch.type, "harness.native.dispatch");
  if (dispatch.type !== "harness.native.dispatch") throw new Error("synthetic expected dispatch");
  assertNativeLeaseDispatchPair(dispatch, lease);
  assert.equal(verifyNodeFrameSignature(lease, s.spki), true);
  assert.equal(staged.leaseFrameDigest, sha256Digest(lease));
  const result = await transmit();
  assert.equal(result.receipt.leaseFrameDigest, staged.leaseFrameDigest);
  assert.deepEqual(s.sent.slice(before).map(raw => JSON.parse(raw)), [dispatch, lease]);
  assert.deepEqual(await f.coordinator.readNativeDeliveryEnvelope(...f.args), staged);
  await assert.rejects(transmit()); assert.equal(s.sent.length, before + 2);
});

test("a failed first or second send retains the paired intent without retry or another grant", async t => {
  for (const failed of ["dispatch", "lease"] as const) await t.test(failed, async t => {
    const failure = async () => { throw new Error("synthetic transport uncertainty"); };
    const { f, s, stage, transmit } = await fixture(t, failed === "dispatch" ? { send: failure } : { leaseSend: failure });
    await stage(); const before = s.sent.length;
    await assert.rejects(transmit());
    const sent = s.sent.length; assert.equal(sent - before, failed === "dispatch" ? 1 : 2);
    const rows = (await f.db.query<{ record: { leaseFrameDigest?: string } }>("SELECT record FROM control_native_transmission_intents")).rows;
    assert.equal(rows.length, 1); assert.ok(rows[0].record.leaseFrameDigest);
    await assert.rejects(transmit()); assert.equal(s.sent.length, sent);
    assert.equal((await f.db.query("SELECT * FROM control_native_delivery_receipts")).rows.length, 0);
  });
});

test("canonical commit cancellation rolls back the entire pair without sending either frame", async t => {
  const { f, s, stage } = await fixture(t), before = s.sent.length;
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
    const result = await work(tx); f.abort.abort(); return result;
  }, check) };
  await assert.rejects(stage(f.create(db)));
  assert.equal((await f.db.query("SELECT * FROM control_native_delivery_envelopes")).rows.length, 0);
  assert.equal(s.sent.length, before);
});

test("cancellation after dispatch send withholds the grant and preserves the uncertain intent", async t => {
  const { f, s, stage, transmit } = await fixture(t, { send: async () => { abort.abort(); } });
  const abort = f.abort; await stage(); const before = s.sent.length;
  await assert.rejects(transmit());
  assert.deepEqual(s.sent.slice(before).map(raw => JSON.parse(raw).type), ["harness.native.dispatch"]);
  assert.equal((await f.db.query("SELECT * FROM control_native_transmission_intents")).rows.length, 1);
  await assert.rejects(transmit()); assert.equal(s.sent.length, before + 1);
});

test("in-flight freshness does not permit a second transmission operation", async t => {
  const { s, stage, transmit } = await fixture(t, { send: async () => { await assert.rejects(transmit()); } });
  await stage(); const before = s.sent.length;
  await transmit(); assert.equal(s.sent.length, before + 2);
  await assert.rejects(transmit()); assert.equal(s.sent.length, before + 2);
});

test("a legacy transmission callback cannot omit the paired grant commitment", async t => {
  const { s, stage } = await fixture(t); await stage(); const before = s.sent.length;
  await assert.rejects(s.session.sendPreparedNativeDispatch(async () => ({ value: null, assertFresh() {} })));
  assert.equal(s.sent.length, before);
});

test("removing a grant from historical JSON cannot downgrade its authenticated envelope", async t => {
  const { f, stage } = await fixture(t); await stage();
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (!sql.startsWith("SELECT tenant_id,project_id,job_id,attempt_id,message_id,record,auth_tag FROM control_native_delivery_envelopes")) return result;
      return { rows: result.rows.map(row => {
        const record = structuredClone((row as { record: { leaseFrame?: unknown } }).record);
        delete record.leaseFrame;
        return Object.assign({}, row, { record });
      }) };
    },
  }), check) };
  await assert.rejects(f.create(db).readNativeDeliveryEnvelope(...f.args));
});
