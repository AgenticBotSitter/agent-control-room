import test from "node:test";
import assert from "node:assert/strict";
import { createNativeLeaseIntake } from "../src/harness/hermes-native-v1/lease-intake";
import { nativeLeaseEvidenceFixture } from "./helpers/native-lease-evidence";

async function fixture() {
  const f = await nativeLeaseEvidenceFixture();
  const key = await f.trust.resolveServerKey(f.grant.keyId); assert.ok(key);
  const config = { request: f.config.request, serverActorId: f.config.serverActorId,
    serverKeyId: f.grant.keyId, serverPublicKeySpki: Buffer.from(key).toString("base64url"), connectionId: f.grant.connectionId };
  let taskCurrent = true;
  const deps = { journal: f.journal, trust: f.trust, clock: f.dependencies.clock!,
    assertTaskCurrent: (): true => { if (!taskCurrent) throw new Error("synthetic task changed"); return true; } };
  const intake = createNativeLeaseIntake(config, deps);
  return { ...f, config, deps, intake, loseTask: () => { taskCurrent = false; },
    close: async () => { intake.close(); await f.close(); } };
}
const signal = () => new AbortController().signal;

test("exact authenticated grant is retained atomically and reusable by existing verified lease reader", async t => {
  const f = await fixture(); t.after(f.close); await f.journal.consume(f.grant, f.at);
  assert.deepEqual(await f.intake.accept(f.grant, f.at, signal()), {
    disposition: "recorded", messageId: f.grant.messageId, grantsExecutionAuthority: false });
  assert.deepEqual(await f.read(signal()), f.policy.lease);
  assert.equal((await f.intake.accept(f.grant, f.at, signal())).disposition, "duplicate");
  assert.deepEqual(f.calls, []);
});

test("wrong channel, task or signature and unconsumed grants leave no command or attempt", async t => {
  for (const mode of ["channel", "task", "signature", "unconsumed"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close);
    if (mode !== "unconsumed") await f.journal.consume(f.grant, f.at);
    const input = structuredClone(f.grant);
    if (mode === "signature") input.signature = "a".repeat(86);
    const intake = createNativeLeaseIntake({ ...f.config,
      ...(mode === "channel" ? { connectionId: "connection:other" } : {}),
      ...(mode === "task" ? { request: { ...f.config.request, leaseId: "lease:other" } } : {}) }, f.deps);
    t.after(intake.close);
    await assert.rejects(intake.accept(input, f.at, signal()));
    assert.equal(f.journal.queuedCommandCount(), 0); assert.equal(f.journal.attemptSummary(f.summary.attemptId), undefined);
    await assert.rejects(intake.accept(f.grant, f.at, signal()));
    assert.deepEqual(f.calls, []);
  });
});

test("revoked trust, cancelled caller and changed task fence cannot adopt a grant", async t => {
  for (const mode of ["revoked", "abort", "task"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close); await f.journal.consume(f.grant, f.at);
    const abort = new AbortController();
    if (mode === "revoked") await f.revoke();
    if (mode === "abort") abort.abort();
    if (mode === "task") f.loseTask();
    await assert.rejects(f.intake.accept(f.grant, f.at, abort.signal));
    assert.equal(f.journal.queuedCommandCount(), 0); assert.equal(f.journal.attemptSummary(f.summary.attemptId), undefined);
  });
});

test("trust-await changes and slow task fences are rechecked before storage", async t => {
  for (const mode of ["abort", "expire", "fence"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close); await f.journal.consume(f.grant, f.at);
    const abort = new AbortController();
    const intake = createNativeLeaseIntake(f.config, { ...f.deps,
      assertTaskCurrent: () => { if (mode === "fence") f.setNow(Date.parse(f.grant.expiresAt)); return true; },
      trust: { currentServerTrustRevision: f.trust.currentServerTrustRevision.bind(f.trust),
        async resolveServerKey(id) {
          const key = await f.trust.resolveServerKey(id);
          if (mode === "abort") abort.abort();
          if (mode === "expire") f.setNow(Date.parse(f.grant.expiresAt));
          return key;
        } } });
    t.after(intake.close);
    await assert.rejects(intake.accept(f.grant, f.at, abort.signal));
    assert.equal(f.journal.queuedCommandCount(), 0); assert.equal(f.journal.attemptSummary(f.summary.attemptId), undefined);
  });
});

test("caller mutation during trust resolution cannot change the captured grant", async t => {
  const f = await fixture(); t.after(f.close); await f.journal.consume(f.grant, f.at);
  const input = structuredClone(f.grant);
  const intake = createNativeLeaseIntake(f.config, { ...f.deps, trust: {
    currentServerTrustRevision: f.trust.currentServerTrustRevision.bind(f.trust),
    async resolveServerKey(id) { input.signature = "a".repeat(86); return f.trust.resolveServerKey(id); },
  } }); t.after(intake.close);
  assert.equal((await intake.accept(input, f.at, signal())).disposition, "recorded");
  assert.deepEqual(f.journal.acceptedCommand(f.grant.messageId)?.frame, f.grant);
});

test("timed-out or overlapping trust reads cannot commit when they eventually resolve", async t => {
  for (const mode of ["timeout", "overlap"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close); await f.journal.consume(f.grant, f.at);
    const key = await f.trust.resolveServerKey(f.grant.keyId);
    let release!: (value: typeof key) => void;
    const pending = new Promise<typeof key>(resolve => { release = resolve; });
    const intake = createNativeLeaseIntake(f.config, { ...f.deps, trust: {
      currentServerTrustRevision: f.trust.currentServerTrustRevision.bind(f.trust), resolveServerKey: () => pending,
    } }); t.after(intake.close);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const first = intake.accept(f.grant, f.at, signal());
    const denied = assert.rejects(first);
    if (mode === "timeout") t.mock.timers.tick(5000);
    else await assert.rejects(intake.accept(f.grant, f.at, signal()));
    release(key); await denied;
    assert.equal(f.journal.queuedCommandCount(), 0); assert.equal(f.journal.attemptSummary(f.summary.attemptId), undefined);
    await assert.rejects(intake.accept(f.grant, f.at, signal()));
  });
});

test("non-AbortSignal inputs are refused before persistence", async t => {
  const f = await fixture(); t.after(f.close); await f.journal.consume(f.grant, f.at);
  for (const invalid of [false, {}, { aborted: false }, undefined]) {
    const intake = createNativeLeaseIntake(f.config, f.deps); t.after(intake.close);
    await assert.rejects(intake.accept(f.grant, f.at, invalid as AbortSignal));
  }
  assert.equal(f.journal.queuedCommandCount(), 0); assert.equal(f.journal.attemptSummary(f.summary.attemptId), undefined);
});

test("the final trust revision read cannot carry a post-write fence past lease expiry", async t => {
  const f = await fixture(); t.after(f.close); await f.journal.consume(f.grant, f.at);
  let postWrite = false;
  const intake = createNativeLeaseIntake(f.config, { ...f.deps,
    journal: { recordInitialLease(frame, at, fence) {
      let calls = 0;
      return f.journal.recordInitialLease(frame, at, () => { postWrite = ++calls === 2; return fence(); });
    } },
    trust: { resolveServerKey: f.trust.resolveServerKey.bind(f.trust), currentServerTrustRevision() {
      const revision = f.trust.currentServerTrustRevision();
      if (postWrite) f.setNow(Date.parse(f.grant.expiresAt));
      return revision;
    } },
  }); t.after(intake.close);
  await assert.rejects(intake.accept(f.grant, f.at, signal()));
  assert.equal(postWrite, true); assert.equal(f.journal.queuedCommandCount(), 0);
  assert.equal(f.journal.attemptSummary(f.summary.attemptId), undefined);
});
