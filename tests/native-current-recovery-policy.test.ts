import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { PinnedApprovalTrustStore } from "../src/node-policy/v1/pinned-approval-trust";
import { signArtifact, computeArtifactBodyDigest } from "../src/node-policy/v1/crypto";
import { sha256Digest } from "../src/security";
import { createNativeCurrentRecoveryPolicy } from "../src/harness/hermes-native-v1/current-recovery-policy";
import { createNativeRecoveryAuthority, composeNativeRunAuthority, type NativeRecoveryPermissionBody } from "../src/harness/hermes-native-v1/recovery-authority";
import { nativeLeaseEvidenceFixture } from "./helpers/native-lease-evidence";
import { nativeRunId, response } from "./hermes-native-fixture";

async function fixture() {
  const f = await nativeLeaseEvidenceFixture(), keys = generateKeyPairSync("ed25519");
  const enrollment = f.startConfig.enrollment, now = f.dependencies.clock!;
  const keyId = "approval-key:recovery", spki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const approvals = new PinnedApprovalTrustStore({ schema: "control-room.owner-approval-pins/v1", tenantId: enrollment.tenantId,
    nodeId: enrollment.nodeId, nodeClass: "personal-compute", validFrom: now(), validUntil: f.prepared.binding.deadline + 120_000,
    keys: [{ keyId, algorithm: "ed25519", spki, fingerprint: `sha256:${createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex")}` }] },
  { security: f.trust, clock: now });
  // Explicit synthetic node-local credential/cleanup service. No credential is read or unlocked.
  const local = { credentialRef: enrollment.credentialRef, credentialAvailable: true, recoveryAllowed: true, revision: 1 };
  const config = { enrollment, nodeClass: "personal-compute", approvalKeyId: keyId };
  const deps = { security: f.trust, approvals, readLocalState: () => ({ ...local }) };
  const read = createNativeCurrentRecoveryPolicy(config, deps);
  const body: NativeRecoveryPermissionBody = { schema: "control-room.native-run-recovery-permission/v1",
    bindingDigest: sha256Digest(f.prepared.binding), approvalKeyId: keyId, issuedAt: now(), expiresAt: f.prepared.binding.deadline + 120_000,
    operations: ["status", "stop"], nonce: "synthetic-recovery-nonce", bodyDigest: "" };
  body.bodyDigest = computeArtifactBodyDigest(body);
  const recoveryConfig = { enrollment, binding: f.prepared.binding, permission: signArtifact(body, keys.privateKey) };
  return { ...f, local, config, deps, read, approvals, recoveryConfig,
    close: async () => { approvals.close(); await f.close(); } };
}
const signal = () => new AbortController().signal;

test("recovery resolves separate current owner pins without a work ceiling or lease", async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(f.trust.loadCeiling());
  const policy = await f.read(signal()); policy.assertFresh!();
  assert.equal(policy.approvalKey.keyId, f.config.approvalKeyId);
  assert.equal(policy.recoveryAllowed, true);
  f.setNow(f.prepared.binding.deadline);
  assert.equal((await f.read(signal())).credentialAvailable, true);
});

test("composed recovery reaches fake exact-run stop after work expiry but cannot restart", async t => {
  const f = await fixture(); t.after(f.close); const start = f.create();
  const recovery = createNativeRecoveryAuthority(f.recoveryConfig, { journal: f.nativeRunJournal, effects: f.effects,
    executions: f.executions, readCurrent: f.read, assertProfileCurrent: f.dependencies.assertProfileCurrent, clock: f.dependencies.clock });
  const combined = { authority: composeNativeRunAuthority(start.authority, recovery.authority), close() { start.close(); recovery.close(); } };
  t.after(() => combined.close()); let stops = 0;
  const adapter = f.adapter(combined, { ...f.transport, async json(wire) {
    if (wire.operation !== "stop") return f.transport.json(wire);
    await wire.authorize(); stops++; return response({ run_id: nativeRunId, status: "stopping" });
  } });
  const run = await adapter.start(f.prepared.start); assert.equal(run.state, "queued");
  f.setNow(f.prepared.binding.deadline);
  assert.equal((await adapter.stop(run.binding.runId)).state, "stopping"); assert.equal(stops, 1);
  await assert.rejects(recovery.authority.check("start", run.binding));
  assert.equal(f.calls.filter(value => value === "start").length, 1);
});

test("local revocation or pin closure during profile await prevents recovery bytes", async t => {
  for (const change of ["local", "close", "trust"] as const) await t.test(change, async t => {
    const f = await fixture(); t.after(f.close); const start = f.create();
    const run = await f.adapter(start).start(f.prepared.start); let profileCalls = 0;
    const recovery = createNativeRecoveryAuthority(f.recoveryConfig, { journal: f.nativeRunJournal, effects: f.effects,
      executions: f.executions, readCurrent: f.read, clock: f.dependencies.clock, async assertProfileCurrent() {
        profileCalls++;
        if (change === "local") { f.local.revision++; f.local.credentialAvailable = false; }
        if (change === "close") f.approvals.close();
        if (change === "trust") await f.revoke();
      } }); t.after(() => { start.close(); recovery.close(); });
    await assert.rejects(recovery.authority.check("stop", run.binding), /native_recovery_authority_unavailable/);
    assert.equal(profileCalls, 1); assert.equal(f.nativeRunJournal.load(run.binding.runId)?.stopAttempted, false);
  });
});

test("local policy changes, server trust changes and owner-store close invalidate held evidence", async t => {
  for (const change of ["local", "trust", "close"] as const) await t.test(change, async t => {
    const f = await fixture(); t.after(f.close); const policy = await f.read(signal());
    if (change === "local") { f.local.revision++; f.local.recoveryAllowed = false; }
    if (change === "trust") await f.revoke();
    if (change === "close") f.approvals.close();
    assert.throws(() => policy.assertFresh!(), /native_current_recovery_unavailable/);
  });
});

test("scope mismatch, credential substitution, backwards revision and abort fail closed", async t => {
  const f = await fixture(); t.after(f.close);
  assert.throws(() => createNativeCurrentRecoveryPolicy({ ...f.config, nodeClass: "other" }, f.deps));
  await f.read(signal()); f.local.revision = 0;
  await assert.rejects(f.read(signal()), /native_current_recovery_unavailable/);
  f.local.revision = 2; f.local.credentialRef = "credential:other";
  await assert.rejects(f.read(signal()), /native_current_recovery_unavailable/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.read(abort.signal), /native_current_recovery_unavailable/);
});

test("same-revision local permission changes and invalid booleans are rejected", async t => {
  const f = await fixture(); t.after(f.close); await f.read(signal());
  f.local.recoveryAllowed = false; await assert.rejects(f.read(signal()), /unavailable/);
  f.local.revision++; assert.equal((await f.read(signal())).recoveryAllowed, false);
  f.local.revision++; f.local.credentialAvailable = undefined as unknown as boolean;
  await assert.rejects(f.read(signal()), /unavailable/);
});
