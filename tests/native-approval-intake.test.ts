import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { sha256Digest } from "../src/security";
import { signArtifact, computeArtifactBodyDigest } from "../src/node-policy/v1/crypto";
import { PinnedApprovalTrustStore } from "../src/node-policy/v1/pinned-approval-trust";
import { createNativeApprovalIntake } from "../src/harness/hermes-native-v1/approval-intake";
import { createNativeStartAuthority } from "../src/harness/hermes-native-v1/start-authority";
import { createNativeRecoveryAuthority, composeNativeRunAuthority, type NativeRecoveryPermissionBody } from "../src/harness/hermes-native-v1/recovery-authority";
import { nativeLeaseEvidenceFixture } from "./helpers/native-lease-evidence";
import { nativeRunId, response } from "./hermes-native-fixture";

async function fixture() {
  const f = await nativeLeaseEvidenceFixture(), startKeys = generateKeyPairSync("ed25519"), recoveryKeys = generateKeyPairSync("ed25519");
  const now = f.dependencies.clock!, r = f.prepared.request;
  const pin = (keyId: string, keys: typeof startKeys) => {
    const spki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    return { keyId, algorithm: "ed25519" as const, spki, fingerprint: `sha256:${createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex")}` };
  };
  const startPin = pin("approval-key:test", startKeys), recoveryPin = pin("approval-key:recovery", recoveryKeys);
  const approvals = new PinnedApprovalTrustStore({ schema: "control-room.owner-approval-pins/v1", tenantId: r.tenantId,
    nodeId: r.nodeId, nodeClass: r.nodeClass, validFrom: now(), validUntil: f.startConfig.enrollment.validUntil, keys: [startPin, recoveryPin] },
  { security: f.trust, clock: now });
  const startBody = f.startConfig.request.approval.body;
  const recoveryBody: NativeRecoveryPermissionBody = { schema: "control-room.native-run-recovery-permission/v1",
    bindingDigest: sha256Digest(f.prepared.binding), approvalKeyId: recoveryPin.keyId, issuedAt: now(), expiresAt: f.prepared.binding.deadline + 120_000,
    operations: ["status", "stop"], nonce: "synthetic-recovery-nonce", bodyDigest: "" };
  const signStart = (body = startBody) => signArtifact({ ...body, bodyDigest: computeArtifactBodyDigest(body) }, startKeys.privateKey);
  const signRecovery = (body = recoveryBody) => signArtifact({ ...body, bodyDigest: computeArtifactBodyDigest(body) }, recoveryKeys.privateKey);
  const packet = { schema: "control-room.native-task-approval-packet/v1" as const, approval: signStart(), recovery: signRecovery() };
  const config = { enrollment: f.startConfig.enrollment, request: r, start: f.prepared.start };
  const deps = { approvals, security: f.trust, clock: now };
  return { ...f, config, deps, packet, startPin, recoveryPin, signStart, signRecovery, startBody, recoveryBody,
    intake: createNativeApprovalIntake(config, deps), close: async () => { approvals.close(); await f.close(); } };
}
const signal = () => new AbortController().signal;

test("both signed permissions pass intake and actual start/recovery controllers with fake transport", async t => {
  const f = await fixture(); t.after(f.close); const accepted = await f.intake(f.packet, signal()); accepted.assertFresh();
  assert.equal(accepted.startsWork, false); assert.equal(accepted.grantsExecutionAuthority, false); assert.equal(f.calls.length, 0);
  const start = createNativeStartAuthority(accepted, { ...f.dependencies, async readCurrent(signal) {
    return { ...await f.dependencies.readCurrent(signal), approvalKey: { keyId: f.startPin.keyId, publicKeySpki: f.startPin.spki } };
  } });
  const recovery = createNativeRecoveryAuthority({ enrollment: accepted.enrollment, binding: accepted.binding, permission: accepted.recoveryPermission },
    { journal: f.nativeRunJournal, effects: f.effects, executions: f.executions, clock: f.dependencies.clock,
      assertProfileCurrent: f.dependencies.assertProfileCurrent, async readCurrent() { return { credentialAvailable: true, recoveryAllowed: true,
        approvalKey: { keyId: f.recoveryPin.keyId, publicKeySpki: f.recoveryPin.spki } }; } });
  const combined = { authority: composeNativeRunAuthority(start.authority, recovery.authority), close() { start.close(); recovery.close(); } };
  t.after(() => combined.close()); let stops = 0;
  const adapter = f.adapter(combined, { ...f.transport, async json(wire) {
    if (wire.operation !== "stop") return f.transport.json(wire);
    await wire.authorize(); stops++; return response({ run_id: nativeRunId, status: "stopping" });
  } });
  const run = await adapter.start(accepted.start); assert.equal(run.state, "queued");
  f.setNow(accepted.binding.deadline); assert.equal((await adapter.stop(run.binding.runId)).state, "stopping"); assert.equal(stops, 1);
});

test("missing cleanup, forged signatures and cross-task signed approvals are rejected", async t => {
  const f = await fixture(); t.after(f.close);
  const packets = [{ ...f.packet, recovery: undefined }, { ...f.packet, approval: { ...f.packet.approval, signature: "a".repeat(86) } },
    { ...f.packet, approval: f.signStart({ ...f.startBody, jobId: "job:other" }) },
    { ...f.packet, approval: f.signStart({ ...f.startBody, approvalKeyId: "approval-key:unknown" }) },
    { ...f.packet, recovery: f.signRecovery({ ...f.recoveryBody, bindingDigest: sha256Digest("other") }) },
    { ...f.packet, approval: { ...f.packet.approval, body: { ...f.startBody, decision: "denied" } } }];
  for (const packet of packets) await assert.rejects(f.intake(packet, signal()), /native_approval_intake_unavailable/);
  assert.equal(f.admissions.count(), 0); assert.equal(f.calls.length, 0);
});

test("trust changes or cancellation during key resolution cannot yield accepted intake", async t => {
  for (const change of ["trust", "abort"] as const) await t.test(change, async t => {
    const f = await fixture(); t.after(f.close); const abort = new AbortController();
    const resolve = f.deps.approvals.resolveApprovalKey.bind(f.deps.approvals); let changed = false;
    f.deps.approvals.resolveApprovalKey = async keyId => {
      if (!changed) { changed = true; if (change === "trust") await f.revoke(); else abort.abort(); }
      return resolve(keyId);
    };
    await assert.rejects(f.intake(f.packet, abort.signal), /native_approval_intake_unavailable/);
    assert.equal(f.admissions.count(), 0); assert.equal(f.calls.length, 0);
  });
});

test("approval timing and bounded cleanup extension cannot change the prepared deadline", async t => {
  const f = await fixture(); t.after(f.close); const now = f.dependencies.clock!();
  for (const packet of [
    { ...f.packet, approval: f.signStart({ ...f.startBody, expiresAt: new Date(f.prepared.binding.deadline - 1).toISOString() }) },
    { ...f.packet, approval: f.signStart({ ...f.startBody, issuedAt: new Date(now + 1).toISOString() }) },
    { ...f.packet, recovery: f.signRecovery({ ...f.recoveryBody, issuedAt: now + 1 }) },
    { ...f.packet, recovery: f.signRecovery({ ...f.recoveryBody, expiresAt: f.prepared.binding.deadline }) },
    { ...f.packet, recovery: f.signRecovery({ ...f.recoveryBody, expiresAt: f.prepared.binding.deadline + 300_001 }) },
  ]) await assert.rejects(f.intake(packet, signal()));
});

test("changed prepared content and already signed requests cannot enter unsigned intake", async t => {
  const f = await fixture(); t.after(f.close);
  assert.throws(() => createNativeApprovalIntake({ ...f.config, start: { ...f.config.start, prompt: "changed" } }, f.deps));
  assert.throws(() => createNativeApprovalIntake({ ...f.config, request: f.startConfig.request }, f.deps));
});

test("current trust, expiry and owner-store closure invalidate held intake evidence", async t => {
  for (const change of ["trust", "expiry", "close"] as const) await t.test(change, async t => {
    const f = await fixture(); t.after(f.close); const accepted = await f.intake(f.packet, signal());
    if (change === "trust") await f.revoke();
    if (change === "expiry") f.setNow(f.prepared.binding.deadline);
    if (change === "close") f.deps.approvals.close();
    assert.throws(accepted.assertFresh, /native_approval_intake_unavailable/);
  });
});

test("abort, backwards time and caller mutation never dispatch or revive an expired packet", async t => {
  const f = await fixture(); t.after(f.close); const now = f.dependencies.clock!(), accepted = await f.intake(f.packet, signal());
  f.packet.approval.signature = "a".repeat(86); assert.notEqual(accepted.request.approval.signature, f.packet.approval.signature);
  const abort = new AbortController(); abort.abort(); await assert.rejects(f.intake(f.packet, abort.signal));
  f.setNow(f.prepared.binding.deadline); assert.throws(accepted.assertFresh); f.setNow(now); assert.throws(accepted.assertFresh);
  assert.equal(f.calls.length, 0);
});
