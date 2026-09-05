import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createNativeLeaseEvidence } from "../src/harness/hermes-native-v1/lease-evidence";
import { nativeLeaseEvidenceFixture as fixture } from "./helpers/native-lease-evidence";

const signal = () => new AbortController().signal;

test("real owner-pinned trust and accepted bridge receipt supply the native start controller's lease", async t => {
  const f = await fixture(); t.after(f.close); await f.accept();
  const lease = await f.read(signal()); assert.deepEqual(lease, f.policy.lease);
  const controller = f.create({ async readCurrent(s) { return { ...await f.dependencies.readCurrent(s), lease: await f.read(s) }; } });
  t.after(() => controller.close()); assert.equal((await f.adapter(controller).start(f.prepared.start)).state, "queued");
});

test("a lease object, queued-only frame or accepted-only receipt is not usable lease evidence", async t => {
  for (const partial of ["none", "queued", "received"] as const) await t.test(partial, async t => {
    const f = await fixture(); t.after(f.close);
    if (partial === "queued") f.journal.recordCommand(f.grant, f.at);
    if (partial === "received") await f.journal.consume(f.grant, f.at);
    await assert.rejects(f.read(signal()), /unavailable/);
  });
});

test("terminal, superseded, expired and wrong-actor grants fail closed", async t => {
  const f = await fixture(); t.after(f.close); await f.accept();
  for (const patch of [{ state: "completed" as const }, { leaseEpoch: f.summary.leaseEpoch + 1 }, { leaseId: "lease:other" }]) {
    f.journal.upsertAttempt({ ...f.summary, ...patch }, f.at); await assert.rejects(f.read(signal()), /unavailable/);
  }
  f.journal.upsertAttempt(f.summary, f.at);
  const other = createNativeLeaseEvidence({ ...f.config, serverActorId: "control-room:other" }, { journal: f.journal, trust: f.trust, clock: f.dependencies.clock });
  await assert.rejects(other(signal()), /unavailable/);
  f.setNow(Date.parse(f.policy.lease.expiresAt)); await assert.rejects(f.read(signal()), /unavailable/);
});

test("accepted grant can outlive transport envelope expiry but not lease expiry", async t => {
  const f = await fixture(); t.after(f.close); await f.accept(); f.setNow(Date.parse(f.grant.expiresAt) + 1);
  assert.equal((await f.read(signal())).leaseId, f.summary.leaseId);
});

test("receipt corruption and lost current trust cannot be replaced by a previously valid object", async t => {
  const f = await fixture(); t.after(f.close); await f.accept(); await f.read(signal());
  const noKey = createNativeLeaseEvidence(f.config, { journal: f.journal, trust: { async resolveServerKey() { return undefined; } }, clock: f.dependencies.clock });
  await assert.rejects(noKey(signal()), /unavailable/);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  db.prepare("UPDATE bridge_inbox SET frame_digest=? WHERE message_id=?").run(`sha256:${"f".repeat(64)}`, f.grant.messageId);
  await assert.rejects(f.read(signal()), /unavailable/);
});

test("abort and attempt changes while current signing trust resolves prevent admission", async t => {
  const f = await fixture(); t.after(f.close); await f.accept(); let release!: () => void;
  const read = createNativeLeaseEvidence(f.config, { journal: f.journal, trust: { async resolveServerKey(id) {
    await new Promise<void>(resolve => { release = resolve; }); return f.trust.resolveServerKey(id);
  } }, clock: f.dependencies.clock });
  const c = new AbortController(), pending = read(c.signal), rejected = assert.rejects(pending, /unavailable/); c.abort(); release(); await rejected;
  const next = read(signal()), refused = assert.rejects(next, /unavailable/);
  f.journal.upsertAttempt({ ...f.summary, state: "cancelled" }, f.at); release(); await refused;
});

test("actual owner-signed server key revocation invalidates an already recorded lease", async t => {
  const f = await fixture(); t.after(f.close); await f.accept(); await f.read(signal());
  await f.revoke(); await assert.rejects(f.read(signal()), /unavailable/);
});

test("recording a forged signature does not convert it into verified lease authority", async t => {
  const f = await fixture(); t.after(f.close); f.grant.signature = "a".repeat(86); await f.accept();
  await assert.rejects(f.read(signal()), /unavailable/);
});
