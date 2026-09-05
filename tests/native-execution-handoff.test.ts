import test from "node:test";
import assert from "node:assert/strict";
import { canonicalApprovalStorageFixture as fixture } from "./helpers/canonical-approval-storage";
import { nativeStartAuthorityFixture } from "./helpers/native-start-authority";
import { nativeEnvelopeSession } from "./helpers/native-envelope-session";
import { NativeDispatchIntakeHandler } from "../src/node-bridge/native-dispatch-handler";
import { prepareNativeExecutionHandoff } from "../src/harness/hermes-native-v1/execution-handoff";
import { resolvePinnedApprovalKey } from "../src/node-policy/v1/pinned-approval-trust";
import { sha256Digest } from "../src/security";

async function ready() {
  const f = await fixture(), local = await nativeStartAuthorityFixture(undefined, f.prepared.enrollment, f.assignmentFixture);
  assert.equal(sha256Digest(f.prepared.binding), sha256Digest(local.prepared.binding));
  local.policy.approvalKey = await resolvePinnedApprovalKey(f.approvals, f.approvals.binding(), f.packet.approval.body.approvalKeyId);
  await f.save(); await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
  const s = await nativeEnvelopeSession(f, { nativeHandler(journal) {
    return new NativeDispatchIntakeHandler(f.prepared.enrollment, journal, { approvals: f.approvals, security: f.native.trust }, f.clock);
  } });
  await f.coordinator.stageQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal);
  await f.coordinator.transmitQueuedNativeDelivery(...f.args, sha256Digest(f.packet), s.session, f.abort.signal);
  const raw = s.sent.find(raw => JSON.parse(raw).type === "harness.native.dispatch")!;
  await s.bridge.receive(raw, new Date(f.clock()).toISOString());
  const queueId = JSON.parse(raw).body.queueId as string;
  let revision = 0, serverKeyAvailable = true;
  const config = { queueId, enrollment: f.prepared.enrollment, serverActorId: "server:test" };
  const deps = { deliveries: s.journal, runs: local.journal, approvals: f.approvals,
    security: { currentServerTrustRevision: () => `${f.native.trust.currentServerTrustRevision()}:${revision}`,
      async resolveServerKey() { return serverKeyAvailable ? new Uint8Array(Buffer.from(s.spki, "base64url")) : undefined; } },
    local: local.dependencies, transport: local.transport, clock: f.clock };
  return { f, local, s, config, deps, prepare: () => prepareNativeExecutionHandoff(config, deps, f.abort.signal),
    revoke: () => { revision++; serverKeyAvailable = false; },
    setNow: (now: number) => { f.setNow(now); local.setNow(now); },
    close: async () => { await s.close(); await local.close(); await f.close(); } };
}

test("durable bridge input reaches actual local admission, marker and native adapter with synthetic transport", async t => {
  const x = await ready(); t.after(x.close); const handoff = await x.prepare(); t.after(handoff.close);
  assert.deepEqual(x.local.calls, []); assert.equal(x.local.effects.countFull(), 0);
  assert.throws(() => handoff.snapshot()); // Preparation does not reserve a native run.
  const started = await handoff.start(); assert.equal(started.state, "queued", JSON.stringify(started));
  assert.deepEqual(x.local.calls, ["capabilities", "start"]);
  assert.equal(x.local.admissions.count(), 1); assert.equal(x.local.effects.countFull(), 1);
  await handoff.start(); assert.deepEqual(x.local.calls, ["capabilities", "start"]);
  assert.equal((await handoff.poll()).state, "running");
  assert.equal(handoff.snapshot().binding.runId, handoff.runId);
  const second = await x.prepare(); t.after(second.close); await second.start();
  assert.deepEqual(x.local.calls, ["capabilities", "start", "status"]);
});

test("current owner, server, cancellation and deadline remain required after handoff preparation", async t => {
  for (const mode of ["owner", "server", "cancel", "deadline", "closed"] as const) await t.test(mode, async t => {
    const x = await ready(); t.after(x.close); const handoff = await x.prepare(); t.after(handoff.close);
    if (mode === "owner") x.f.approvals.close(); else if (mode === "server") x.revoke();
    else if (mode === "cancel") x.f.abort.abort(); else if (mode === "deadline") x.setNow(x.f.prepared.start.deadline); else handoff.close();
    assert.throws(() => handoff.start()); assert.deepEqual(x.local.calls, []); assert.equal(x.local.effects.countFull(), 0);
  });
});

test("observing expiry then rolling the clock back cannot revive the prepared handoff", async t => {
  const x = await ready(); t.after(x.close); const handoff = await x.prepare(); t.after(handoff.close);
  const original = x.f.clock();
  x.setNow(Date.parse(x.s.journal.acceptedNativeDelivery(x.config.queueId)!.frame.expiresAt));
  assert.throws(() => handoff.start());
  x.setNow(original);
  assert.throws(() => handoff.start());
  assert.deepEqual(x.local.calls, []); assert.equal(x.local.effects.countFull(), 0);
  assert.equal(x.local.journal.load(x.f.prepared.binding.runId), undefined);
});

test("current local pause and profile qualification still gate execution of already recorded input", async t => {
  for (const mode of ["pause", "profile"] as const) await t.test(mode, async t => {
    const x = await ready(); t.after(x.close); const handoff = await x.prepare(); t.after(handoff.close);
    if (mode === "pause") x.local.policy.paused = true; else x.local.setProfile(false);
    assert.equal((await handoff.start()).state, "failed"); assert.deepEqual(x.local.calls, []);
    assert.equal(x.local.effects.countFull(), 0);
  });
});

test("server revocation immediately before start bytes leaves ambiguity and does not replay", async t => {
  const x = await ready(); t.after(x.close);
  const original = x.deps.transport;
  x.deps.transport = { ...original, async json(wire) { if (wire.operation === "start") x.revoke(); return original.json(wire); } };
  const handoff = await x.prepare(); t.after(handoff.close);
  assert.equal((await handoff.start()).state, "ambiguous"); assert.deepEqual(x.local.calls, ["capabilities"]);
  assert.equal(x.local.effects.countFull(), 1); assert.throws(() => handoff.start());
});

test("missing history and missing current server key cannot prepare execution", async t => {
  const x = await ready(); t.after(x.close);
  await assert.rejects(prepareNativeExecutionHandoff({ ...x.config, queueId: "native-queue:missing" }, x.deps, x.f.abort.signal));
  x.revoke(); await assert.rejects(x.prepare()); assert.deepEqual(x.local.calls, []);
});

test("a locally supplied record with a forged server signature is not execution provenance", async t => {
  const x = await ready(); t.after(x.close);
  const saved = x.s.journal.acceptedNativeDelivery(x.config.queueId)!;
  saved.frame.signature = Buffer.alloc(64).toString("base64url");
  await assert.rejects(prepareNativeExecutionHandoff(x.config, { ...x.deps,
    deliveries: { acceptedNativeDelivery: () => structuredClone(saved) } }, x.f.abort.signal));
  assert.deepEqual(x.local.calls, []); assert.equal(x.local.effects.countFull(), 0);
});

test("source disappearance after preparation prevents native reservation and calls", async t => {
  const x = await ready(); t.after(x.close); let available = true;
  const handoff = await prepareNativeExecutionHandoff(x.config, { ...x.deps,
    deliveries: { acceptedNativeDelivery: queue => available ? x.s.journal.acceptedNativeDelivery(queue) : undefined } }, x.f.abort.signal);
  t.after(handoff.close); available = false;
  assert.throws(() => handoff.start()); assert.deepEqual(x.local.calls, []);
  assert.equal(x.local.journal.load(x.f.prepared.binding.runId), undefined);
});

test("unresolved signing-trust lookup times out without a late execution handle or native reservation", async t => {
  const x = await ready(); t.after(x.close);
  let release!: (value: Uint8Array) => void;
  const pendingKey = new Promise<Uint8Array>(resolve => { release = resolve; });
  const pending = prepareNativeExecutionHandoff(x.config, { ...x.deps, security: { ...x.deps.security,
    resolveServerKey: () => pendingKey } }, x.f.abort.signal);
  await assert.rejects(pending, /native_handoff_unavailable/);
  release(new Uint8Array(Buffer.from(x.s.spki, "base64url")));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(x.local.calls, []); assert.equal(x.local.journal.load(x.f.prepared.binding.runId), undefined);
});
