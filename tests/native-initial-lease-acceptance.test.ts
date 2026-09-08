import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nativeLeaseEvidenceFixture } from "./helpers/native-lease-evidence";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";

async function fixture() {
  const f = await nativeLeaseEvidenceFixture();
  if (f.grant.type !== "job.lease.grant") { await f.close(); throw new Error("synthetic expected grant"); }
  const grant = f.grant;
  return { ...f, grant, record: (fence: () => true = () => true) => f.journal.recordInitialLease(grant, f.at, fence) };
}

test("initial grant and attempt commit together; exact replay preserves running progress", async t => {
  const f = await fixture(); t.after(f.close);
  await f.journal.consume(f.grant, f.at);
  assert.equal(f.record(), "recorded");
  assert.deepEqual(f.journal.attemptSummary(f.summary.attemptId), f.summary);
  assert.deepEqual(await f.read(new AbortController().signal), f.policy.lease);
  const running = { ...f.summary, state: "running" as const, lastEventSequence: 4, checkpointIds: ["checkpoint:retained"] };
  f.journal.upsertAttempt(running, f.at);
  assert.equal(f.record(), "duplicate");
  assert.deepEqual(f.journal.attemptSummary(f.summary.attemptId), running);
});

test("unconsumed, queued-only and conflicting retained attempts cannot create usable lease state", async t => {
  for (const state of ["unconsumed", "queued-only", "attempt-only", "terminal", "epoch"] as const) await t.test(state, async t => {
    const f = await fixture(); t.after(f.close);
    if (state !== "unconsumed") await f.journal.consume(f.grant, f.at);
    if (state === "queued-only") f.journal.recordCommand(f.grant, f.at);
    if (state === "attempt-only") f.journal.upsertAttempt(f.summary, f.at);
    if (state === "terminal" || state === "epoch") {
      f.record(); f.journal.upsertAttempt({ ...f.summary,
        ...(state === "terminal" ? { state: "completed" as const } : { leaseEpoch: f.summary.leaseEpoch + 1 }) }, f.at);
    }
    const before = f.journal.attemptSummary(f.summary.attemptId), commands = f.journal.queuedCommandCount();
    assert.throws(() => f.record());
    assert.deepEqual(f.journal.attemptSummary(f.summary.attemptId), before);
    assert.equal(f.journal.queuedCommandCount(), commands);
  });
});

test("late freshness failure rolls back both writes while preserving the consumed inbox", async t => {
  const f = await fixture(); t.after(f.close); await f.journal.consume(f.grant, f.at);
  let checks = 0;
  assert.throws(() => f.record(() => { if (++checks === 2) throw new Error("synthetic expired"); return true; }));
  assert.equal(checks, 2); assert.equal(f.journal.queuedCommandCount(), 0);
  assert.equal(f.journal.attemptSummary(f.summary.attemptId), undefined);
  assert.equal(f.journal.inboundStatus(f.grant.messageId), "received");
  assert.equal(f.record(), "recorded");
});

test("another connection sees no partial attempt and reopened storage retains the committed grant", async t => {
  const f = await fixture(); t.after(f.close); await f.journal.consume(f.grant, f.at);
  const observer = new SqliteBridgeJournal(f.path);
  try {
    assert.equal(f.record(() => {
      assert.equal(observer.attemptSummary(f.summary.attemptId), undefined);
      assert.equal(observer.queuedCommandCount(), 0);
      return true;
    }), "recorded");
    assert.deepEqual(observer.attemptSummary(f.summary.attemptId), f.summary);
    assert.equal(observer.queuedCommandCount(), 1);
  } finally { observer.close(); }
  const reopened = new SqliteBridgeJournal(f.path);
  try {
    assert.deepEqual(reopened.acceptedCommand(f.grant.messageId), { frame: f.grant, receivedAt: f.at });
    assert.equal(reopened.recordInitialLease(f.grant, f.at, () => true), "duplicate");
  } finally { reopened.close(); }
});

test("asynchronous fences and post-write attempt mutation are refused and rolled back", async t => {
  const f = await fixture(); t.after(f.close); await f.journal.consume(f.grant, f.at);
  assert.throws(() => f.record((() => Promise.reject(new Error("synthetic async fence"))) as unknown as () => true));
  let checks = 0;
  assert.throws(() => f.record(() => {
    if (++checks === 2) f.journal.upsertAttempt({ ...f.summary, state: "cancelled" }, f.at);
    return true;
  }));
  assert.equal(f.journal.queuedCommandCount(), 0);
  assert.equal(f.journal.attemptSummary(f.summary.attemptId), undefined);
});

test("corrupt consumed receipt and changed replay bytes cannot become a grant", async t => {
  const f = await fixture(); t.after(f.close); await f.journal.consume(f.grant, f.at);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  db.prepare("UPDATE bridge_inbox SET frame_digest=? WHERE message_id=?").run(`sha256:${"f".repeat(64)}`, f.grant.messageId);
  assert.throws(() => f.record()); assert.equal(f.journal.queuedCommandCount(), 0);
  assert.equal(f.journal.attemptSummary(f.summary.attemptId), undefined);
  const g = await fixture(); t.after(g.close); await g.accept();
  const changed = structuredClone(g.grant); changed.signature = "a".repeat(86);
  assert.throws(() => g.journal.recordInitialLease(changed, g.at, () => true));
  assert.deepEqual(g.journal.attemptSummary(g.summary.attemptId), g.summary);
});

test("replay refuses malformed retained checkpoint and sequence fields without repairing history", async t => {
  const f = await fixture(); t.after(f.close); await f.accept();
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  for (const checkpoints of ["{}", "[1]", JSON.stringify(Array(1001).fill("checkpoint:test"))]) {
    db.prepare("UPDATE bridge_attempts SET checkpoint_ids=? WHERE attempt_id=?").run(checkpoints, f.summary.attemptId);
    assert.throws(() => f.record());
    assert.equal((db.prepare("SELECT checkpoint_ids FROM bridge_attempts WHERE attempt_id=?").get(f.summary.attemptId) as { checkpoint_ids: string }).checkpoint_ids, checkpoints);
  }
  db.prepare("UPDATE bridge_attempts SET checkpoint_ids='[]',last_event_sequence=? WHERE attempt_id=?").run(1.5, f.summary.attemptId);
  assert.throws(() => f.record());
  assert.equal(f.journal.queuedCommandCount(), 1);
});
