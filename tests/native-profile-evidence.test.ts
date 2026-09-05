import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { sha256Digest } from "../src/security";
import { signArtifact, computeArtifactBodyDigest } from "../src/node-policy/v1/crypto";
import { PinnedApprovalTrustStore } from "../src/node-policy/v1/pinned-approval-trust";
import { createNativeProfileEvidence, type NativeProfileAcceptanceBody } from "../src/harness/hermes-native-v1/profile-evidence";
import { nativeLeaseEvidenceFixture } from "./helpers/native-lease-evidence";
import { enrollment as template, instant } from "./hermes-native-fixture";
import { createNativeRecoveryAuthority, type NativeRecoveryPermissionBody } from "../src/harness/hermes-native-v1/recovery-authority";

async function fixture() {
  const keys = generateKeyPairSync("ed25519"), keyId = "approval-key:qualification";
  const { qualificationDigest: _old, ...identity } = template; void _old;
  const body: NativeProfileAcceptanceBody = { schema: "control-room.native-profile-acceptance/v1", enrollment: identity,
    nodeClass: "personal-compute", approvalKeyId: keyId, issuedAt: instant, evidenceDigest: sha256Digest("synthetic-qualified-host-evidence"),
    guarantees: { dedicatedProfile: true, toolPolicyEnforced: true, mcpPolicyEnforced: true, pluginPolicyEnforced: true,
      skillPolicyEnforced: true, hardDeadlineEnforced: true, filesystemIsolationEnforced: true, networkIsolationEnforced: true }, bodyDigest: "" };
  body.bodyDigest = computeArtifactBodyDigest(body);
  const acceptance = signArtifact(body, keys.privateKey), enrollment = { ...template, qualificationDigest: sha256Digest(acceptance) };
  const f = await nativeLeaseEvidenceFixture(enrollment), now = f.dependencies.clock!;
  const spki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const approvals = new PinnedApprovalTrustStore({ schema: "control-room.owner-approval-pins/v1", tenantId: enrollment.tenantId,
    nodeId: enrollment.nodeId, nodeClass: "personal-compute", validFrom: instant, validUntil: enrollment.validUntil,
    keys: [{ keyId, algorithm: "ed25519", spki, fingerprint: `sha256:${createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex")}` }] },
  { security: f.trust, clock: now });
  // Synthetic supervisor state: these flags do not constitute real host qualification.
  const state = { enrollmentDigest: sha256Digest(enrollment), profilePolicyDigest: enrollment.profilePolicyDigest,
    qualificationDigest: enrollment.qualificationDigest, revision: 1, observedAt: now(), validUntil: enrollment.validUntil,
    state: "active" as "active" | "disabled", credentialAvailable: true };
  const config = { enrollment, acceptance }, deps = { approvals, security: f.trust, readSupervisedState: () => ({ ...state }), clock: now };
  return { ...f, config, deps, state, now, keys, spki, read: createNativeProfileEvidence(config, deps),
    close: async () => { approvals.close(); await f.close(); } };
}
const signal = () => new AbortController().signal;

test("owner-accepted exact profile evidence satisfies actual start controller with fake transport", async t => {
  const f = await fixture(); t.after(f.close); const c = f.create({ assertProfileCurrent: f.read }); t.after(() => c.close());
  assert.equal((await f.adapter(c).start(f.prepared.start)).state, "queued");
});

test("start and recovery controllers enforce returned profile proof after the callback yields", async t => {
  for (const operation of ["start", "stop"] as const) await t.test(operation, async t => {
    const f = await fixture(); t.after(f.close);
    const profile: typeof f.read = async (...args) => { const fresh = await f.read(...args); f.state.revision++; f.state.state = "disabled"; return fresh; };
    if (operation === "start") {
      const c = f.create({ assertProfileCurrent: profile }); t.after(() => c.close());
      assert.equal((await f.adapter(c).start(f.prepared.start)).state, "failed"); assert.deepEqual(f.calls, []);
    } else {
      const start = f.create(); t.after(() => start.close()); await f.adapter(start).start(f.prepared.start);
      const body: NativeRecoveryPermissionBody = { schema: "control-room.native-run-recovery-permission/v1",
        bindingDigest: sha256Digest(f.prepared.binding), approvalKeyId: f.config.acceptance.body.approvalKeyId,
        issuedAt: f.now(), expiresAt: f.prepared.binding.deadline + 120_000, operations: ["status", "stop"],
        nonce: "synthetic-recovery-nonce", bodyDigest: "" }; body.bodyDigest = computeArtifactBodyDigest(body);
      const recovery = createNativeRecoveryAuthority({ enrollment: f.config.enrollment, binding: f.prepared.binding,
        permission: signArtifact(body, f.keys.privateKey) }, { journal: f.nativeRunJournal, effects: f.effects, executions: f.executions,
        clock: f.now, assertProfileCurrent: profile, async readCurrent() { return { credentialAvailable: true, recoveryAllowed: true,
          approvalKey: { keyId: body.approvalKeyId, publicKeySpki: f.spki } }; } }); t.after(() => recovery.close());
      await assert.rejects(recovery.authority.check("stop", f.prepared.binding), /unavailable/);
    }
  });
});

test("profile, model, destination or qualification substitution is rejected", async t => {
  const f = await fixture(); t.after(f.close);
  for (const enrollment of [{ ...f.config.enrollment, profile: "other" }, { ...f.config.enrollment, model: "other" },
    { ...f.config.enrollment, canonicalDestination: "https://other.example" }, { ...f.config.enrollment, qualificationDigest: sha256Digest("other") }]) {
    assert.throws(() => createNativeProfileEvidence({ ...f.config, enrollment }, f.deps));
    await assert.rejects(f.read(enrollment, f.now(), signal()));
  }
});

test("unsigned or altered acceptance is not qualification", async t => {
  const f = await fixture(); t.after(f.close);
  const acceptance = { ...f.config.acceptance, signature: "a".repeat(86) };
  const enrollment = { ...f.config.enrollment, qualificationDigest: sha256Digest(acceptance) };
  const read = createNativeProfileEvidence({ enrollment, acceptance }, { ...f.deps, readSupervisedState: () => ({ ...f.state,
    enrollmentDigest: sha256Digest(enrollment), qualificationDigest: enrollment.qualificationDigest }) });
  await assert.rejects(read(enrollment, f.now(), signal()), /native_profile_evidence_unavailable/);
});

test("supervisor disable, lost credential, expiry and trust changes invalidate held proof", async t => {
  for (const change of ["disabled", "credential", "expiry", "trust", "close"] as const) await t.test(change, async t => {
    const f = await fixture(); t.after(f.close); const fresh = await f.read(f.config.enrollment, f.now(), signal());
    if (change === "disabled") f.state.state = "disabled";
    if (change === "credential") f.state.credentialAvailable = false;
    if (change === "expiry") f.setNow(f.config.enrollment.validUntil);
    if (change === "trust") await f.revoke();
    if (change === "close") f.deps.approvals.close();
    assert.throws(fresh, /native_profile_evidence_unavailable/);
  });
});

test("rollback, same-revision conflict, future observation and abort fail closed", async t => {
  const f = await fixture(); t.after(f.close); await f.read(f.config.enrollment, f.now(), signal());
  f.state.revision = 0; await assert.rejects(f.read(f.config.enrollment, f.now(), signal()));
  f.state.revision = 1; f.state.observedAt--; await assert.rejects(f.read(f.config.enrollment, f.now(), signal()));
  f.state.revision = 2; f.state.observedAt = f.now() + 1; await assert.rejects(f.read(f.config.enrollment, f.now(), signal()));
  const abort = new AbortController(); abort.abort(); await assert.rejects(f.read(f.config.enrollment, f.now(), abort.signal));
});

test("observed expiry and newer disabled state cannot be rolled back into permission", async t => {
  const f = await fixture(); t.after(f.close); const originalTime = f.now();
  f.setNow(f.config.enrollment.validUntil); await assert.rejects(f.read(f.config.enrollment, f.now(), signal()));
  f.setNow(originalTime); await assert.rejects(f.read(f.config.enrollment, f.now(), signal()));
  const g = await fixture(); t.after(g.close); const before = { ...g.state };
  g.state.revision++; g.state.state = "disabled"; await assert.rejects(g.read(g.config.enrollment, g.now(), signal()));
  Object.assign(g.state, before); await assert.rejects(g.read(g.config.enrollment, g.now(), signal()));
});
