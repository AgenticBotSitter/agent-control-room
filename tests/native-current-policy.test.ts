import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PinnedApprovalTrustStore } from "../src/node-policy/v1/pinned-approval-trust";
import { createNativeCurrentPolicy } from "../src/harness/hermes-native-v1/current-policy";
import { nativeLeaseEvidenceFixture } from "./helpers/native-lease-evidence";

async function fixture(state?: "active" | "draining" | "quarantined") {
  const f = await nativeLeaseEvidenceFixture(); await f.accept(); await f.provisionCeiling();
  const r = f.startConfig.request, key = f.policy.approvalKey!;
  const approvals = new PinnedApprovalTrustStore({ schema: "control-room.owner-approval-pins/v1",
    tenantId: r.tenantId, nodeId: r.nodeId, nodeClass: "personal-compute", validFrom: f.dependencies.clock!(),
    validUntil: f.prepared.binding.deadline, keys: [{ keyId: key.keyId, algorithm: "ed25519", spki: key.publicKeySpki,
      fingerprint: `sha256:${createHash("sha256").update(Buffer.from(key.publicKeySpki, "base64url")).digest("hex")}` }] },
  { security: f.trust, clock: f.dependencies.clock });
  if (state) f.journal.initializeNodeControlState({ nodeId: r.nodeId, nodeVersion: 1, state, updatedAt: f.at,
    ...(state === "quarantined" ? { safeReasonCode: "synthetic_quarantine" } : {}) });
  let paused = false;
  const config = { request: r, executor: f.policy.executor, nodeClass: "personal-compute", leaseMessageId: f.grant.messageId,
    serverActorId: f.config.serverActorId, nodeSigningKeyReferenceId: "key:test", parentAuthorities: f.policy.lease.parentAuthorities };
  const deps = { security: f.trust, approvals, journal: f.journal, effects: f.effects,
    // Explicit synthetic availability only: no native key-store query or credential unlock.
    keys: { async availability() { return f.policy.keyAvailability; } }, localPaused: () => paused, clock: f.dependencies.clock };
  return { ...f, config, deps, read: createNativeCurrentPolicy(config, deps), pause: () => { paused = true; },
    close: async () => { approvals.close(); await f.close(); } };
}
const signal = () => new AbortController().signal;

test("current verified stores compose into actual native start with a fake transport", async t => {
  const f = await fixture("active"); t.after(f.close);
  const { assertFresh, ...policy } = await f.read(signal()); assertFresh!(); assert.deepEqual(policy, f.policy);
  const controller = f.create({ readCurrent: f.read }); t.after(() => controller.close());
  assert.equal((await f.adapter(controller).start(f.prepared.start)).state, "queued");
  assert.equal((await f.read(signal())).activeExternalEffects, 1);
});

test("missing, draining and quarantined node state and local pause all deny start", async t => {
  for (const state of [undefined, "draining", "quarantined", "active"] as const) await t.test(String(state), async t => {
    const f = await fixture(state); t.after(f.close); if (state === "active") f.pause();
    assert.equal((await f.read(signal())).paused, true);
    const controller = f.create({ readCurrent: f.read }); t.after(() => controller.close());
    await assert.rejects(controller.authority.check("start", f.prepared.binding));
    assert.equal((await f.adapter(controller).start(f.prepared.start)).state, "failed"); assert.deepEqual(f.calls, []);
  });
});

test("server revocation and unavailable owner pins invalidate current evidence", async t => {
  const f = await fixture("active"); t.after(f.close); await f.read(signal()); await f.revoke();
  await assert.rejects(f.read(signal()), /native_current_policy_unavailable/);
  const g = await fixture("active"); t.after(g.close); g.deps.approvals.close();
  await assert.rejects(g.read(signal()), /native_current_policy_unavailable/);
});

test("wrong key reference and invalid pause evidence fail closed", async t => {
  const f = await fixture("active"); t.after(f.close);
  const wrong = createNativeCurrentPolicy({ ...f.config, nodeSigningKeyReferenceId: "key:other" }, f.deps);
  await assert.rejects(wrong(signal()), /native_current_policy_unavailable/);
  const invalid = createNativeCurrentPolicy(f.config, { ...f.deps, localPaused: () => undefined as unknown as boolean });
  await assert.rejects(invalid(signal()), /native_current_policy_unavailable/);
});

test("abort during a store await prevents later source reads", async t => {
  const f = await fixture("active"); t.after(f.close); const abort = new AbortController(); let keyReads = 0;
  const read = createNativeCurrentPolicy(f.config, { ...f.deps, security: {
    currentPolicyRevision: f.trust.currentPolicyRevision.bind(f.trust),
    resolveServerKey: f.trust.resolveServerKey.bind(f.trust), async loadCeiling() { abort.abort(); return f.trust.loadCeiling(); } },
    keys: { async availability() { keyReads++; return f.policy.keyAvailability; } } });
  await assert.rejects(read(abort.signal), /native_current_policy_unavailable/); assert.equal(keyReads, 0);
});

test("permission changes during availability resolution invalidate the entire snapshot", async t => {
  for (const change of ["cancel", "revoke", "ceiling"] as const) await t.test(change, async t => {
    const f = await fixture("active"); t.after(f.close);
    const read = createNativeCurrentPolicy(f.config, { ...f.deps, keys: { async availability() {
      if (change === "cancel") f.journal.upsertAttempt({ ...f.summary, state: "cancelled" }, f.at);
      else if (change === "revoke") await f.revoke();
      else await f.narrowCeiling();
      return f.policy.keyAvailability;
    } } });
    const controller = f.create({ readCurrent: read }); t.after(() => controller.close());
    assert.equal((await f.adapter(controller).start(f.prepared.start)).state, "failed");
    assert.deepEqual(f.calls, []); assert.equal(f.admissions.count(), 0);
  });
});

test("profile-await cancellation and owner-store closure are fenced before admission", async t => {
  for (const change of ["cancel", "close"] as const) await t.test(change, async t => {
    const f = await fixture("active"); t.after(f.close);
    const controller = f.create({ readCurrent: f.read, async assertProfileCurrent() {
      if (change === "cancel") f.journal.upsertAttempt({ ...f.summary, state: "cancelled" }, f.at);
      else f.deps.approvals.close();
    } }); t.after(() => controller.close());
    assert.equal((await f.adapter(controller).start(f.prepared.start)).state, "failed");
    assert.deepEqual(f.calls, []); assert.equal(f.admissions.count(), 0);
  });
});

test("scope mismatch is rejected and caller configuration cannot change a created reader", async t => {
  const f = await fixture("active"); t.after(f.close);
  assert.throws(() => createNativeCurrentPolicy({ ...f.config, nodeClass: "another-class" }, f.deps));
  f.config.executor.operationIds.length = 0; f.config.nodeSigningKeyReferenceId = "key:other";
  assert.equal((await f.read(signal())).executor.operationIds.length, 1);
});
