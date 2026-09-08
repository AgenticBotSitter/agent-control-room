import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createNativeCleanupEvidence, type NativeCleanupAcceptanceBody, type NativeCleanupSnapshot } from "../src/harness/hermes-native-v1/cleanup-evidence";
import { PinnedApprovalTrustStore } from "../src/node-policy/v1/pinned-approval-trust";
import { computeArtifactBodyDigest, signArtifact } from "../src/node-policy/v1/crypto";
import { sha256Digest } from "../src/security";
import { nativeLeaseEvidenceFixture } from "./helpers/native-lease-evidence";
import { response, statusBody } from "./hermes-native-fixture";

const signal = () => new AbortController().signal;
async function fixture() {
  const f = await nativeLeaseEvidenceFixture(), control = f.create();
  const adapter = f.adapter(control, { ...f.transport, async json(wire) {
    if (wire.operation !== "status") return f.transport.json(wire);
    await wire.authorize(); f.calls.push("status");
    return response(statusBody("completed", { session_id: f.prepared.binding.sessionId, output: "Synthetic completed result" }));
  } });
  await adapter.start(f.prepared.start);
  f.setNow(f.dependencies.clock!() + 1000); await adapter.poll(f.prepared.binding.runId);
  const keys = generateKeyPairSync("ed25519"), enrollment = f.startConfig.enrollment;
  const now = f.dependencies.clock!, body: NativeCleanupAcceptanceBody = {
    schema: "control-room.native-cleanup-acceptance/v1", enrollmentDigest: sha256Digest(enrollment),
    producerDigest: sha256Digest("synthetic-cleanup-producer"), evidenceDigest: sha256Digest("synthetic-host-review-not-qualification"),
    nodeClass: "personal-compute", approvalKeyId: "owner-key:cleanup", issuedAt: now() - 1000, expiresAt: enrollment.validUntil,
    guarantees: { exactRunIsolation: true, descendantsStoppedVerified: true, nativeRequestsDrainedVerified: true,
      durableRevisionTracking: true }, bodyDigest: "" };
  body.bodyDigest = computeArtifactBodyDigest(body);
  const acceptance = signArtifact(body, keys.privateKey), spki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const pins = new PinnedApprovalTrustStore({ schema: "control-room.owner-approval-pins/v1", tenantId: enrollment.tenantId,
    nodeId: enrollment.nodeId, nodeClass: body.nodeClass, validFrom: body.issuedAt, validUntil: body.expiresAt,
    keys: [{ keyId: body.approvalKeyId, algorithm: "ed25519", spki,
      fingerprint: `sha256:${createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex")}` }] },
  { security: f.trust, clock: now });
  const snapshot = f.nativeRunJournal.load(f.prepared.binding.runId)!, claim = f.effects.load(f.prepared.binding.effectClaimKey);
  assert.equal(snapshot.state, "completed"); assert.equal(claim?.kind, "full");
  if (claim?.kind !== "full" || !claim.snapshot.markerDigest || !snapshot.nativeRunId) throw new Error("fixture missing exact retained evidence");
  const proof: NativeCleanupSnapshot = { enrollmentDigest: body.enrollmentDigest, producerDigest: body.producerDigest,
    bindingDigest: sha256Digest(f.prepared.binding), nativeRunId: snapshot.nativeRunId, snapshotDigest: sha256Digest(snapshot),
    markerDigest: claim.snapshot.markerDigest, revision: 1, observedAt: now(), validUntil: now() + 10_000,
    state: "quiescent", remainingDescendants: 0, pendingNativeRequests: 0 };
  const config = { enrollment, binding: f.prepared.binding, acceptance };
  const deps = { approvals: pins, security: f.trust, runs: f.nativeRunJournal, effects: f.effects,
    readSupervisedCleanup: () => proof, clock: now };
  return { f, config, deps, proof, snapshot, claim: claim.snapshot,
    create: () => createNativeCleanupEvidence(config, deps),
    close: async () => { pins.close(); control.close(); await f.close(); } };
}

test("accepted exact cleanup evidence is read-only and cannot clear retained active capacity", async t => {
  const x = await fixture(); t.after(x.close); const reader = x.create(); t.after(reader.close);
  const calls = [...x.f.calls], active = x.f.effects.countActive(x.config.enrollment.tenantId, x.config.enrollment.nodeId);
  assert.equal(active, 1);
  const evidence = await reader.verify(signal()); evidence.assertFresh();
  assert.equal(Object.isFrozen(evidence), true); assert.equal(evidence.releasesCapacity, false);
  assert.equal(evidence.grantsExecutionAuthority, false); assert.match(evidence.evidenceDigest, /^sha256:/);
  assert.equal(JSON.stringify(evidence).includes(x.snapshot.resultText!), false);
  assert.deepEqual(x.f.calls, calls); assert.deepEqual(x.f.nativeRunJournal.load(x.snapshot.binding.runId), x.snapshot);
  assert.deepEqual(x.f.effects.load(x.snapshot.binding.effectClaimKey), { kind: "full", snapshot: x.claim });
  assert.equal(x.f.effects.countActive(x.config.enrollment.tenantId, x.config.enrollment.nodeId), active);
  reader.close(); assert.throws(evidence.assertFresh);
});

test("cleanup evidence refuses mismatched identity, active work, expired proof and forged owner acceptance", async t => {
  const x = await fixture(); t.after(x.close); const original = structuredClone(x.proof);
  const bad: Record<string, unknown>[] = [
    ...["enrollmentDigest", "producerDigest", "bindingDigest", "snapshotDigest", "markerDigest"].map(field => ({ [field]: `sha256:${"e".repeat(64)}` })),
    { nativeRunId: "run_22222222-2222-4222-8222-222222222222" }, { remainingDescendants: 1 }, { pendingNativeRequests: 1 },
    { state: "running" }, { observedAt: original.observedAt + 1 }, { validUntil: original.observedAt },
    { validUntil: original.observedAt + 30_001 },
  ];
  for (const change of bad) {
    Object.assign(x.proof, original, change); const reader = x.create();
    await assert.rejects(reader.verify(signal()), /native_cleanup_evidence_unavailable/);
    Object.assign(x.proof, original); await assert.rejects(reader.verify(signal())); reader.close();
  }
  const forged = structuredClone(x.config); forged.acceptance.signature = "a".repeat(86);
  await assert.rejects(createNativeCleanupEvidence(forged, x.deps).verify(signal()));
  assert.equal(x.f.effects.countActive(x.config.enrollment.tenantId, x.config.enrollment.nodeId), 1);
});

test("proof freshness binds source revision, owner pins and cancellation", async t => {
  const x = await fixture(); t.after(x.close);
  const original = structuredClone(x.proof), reader = x.create(), controller = new AbortController();
  const evidence = await reader.verify(controller.signal); x.proof.revision++;
  assert.throws(evidence.assertFresh); Object.assign(x.proof, original); await assert.rejects(reader.verify(signal()));
  const second = x.create(), next = await second.verify(controller.signal); controller.abort(); assert.throws(next.assertFresh);
  const third = x.create(), last = await third.verify(signal()); x.deps.approvals.close(); assert.throws(last.assertFresh);
  assert.deepEqual(x.f.effects.load(x.snapshot.binding.effectClaimKey), { kind: "full", snapshot: x.claim });
});

test("retained native observation changes and committed trust changes invalidate earlier cleanup proof", async t => {
  const x = await fixture(); t.after(x.close);
  const reader = x.create(), evidence = await reader.verify(signal());
  x.f.setNow(x.snapshot.observedAt + 1);
  x.f.nativeRunJournal.update(x.snapshot.binding.runId, x.snapshot.version, { observedAt: x.snapshot.observedAt + 1 });
  assert.throws(evidence.assertFresh);
  x.proof.snapshotDigest = sha256Digest(x.f.nativeRunJournal.load(x.snapshot.binding.runId));
  x.proof.observedAt++; x.proof.revision++;
  const next = x.create(), fresh = await next.verify(signal());
  await x.f.revoke(); assert.throws(fresh.assertFresh);
  assert.deepEqual(x.f.effects.load(x.snapshot.binding.effectClaimKey), { kind: "full", snapshot: x.claim });
});

test("final synchronous cleanup reads cannot borrow an earlier wall-clock or monotonic validity check", async t => {
  const x = await fixture(); t.after(x.close);
  let elapsed = 0; t.mock.method(performance, "now", () => elapsed);
  for (const fault of ["deadline", "expiry", "abort"] as const) {
    let reads = 0; elapsed = 0; const controller = new AbortController();
    x.proof.observedAt = x.f.dependencies.clock!(); x.proof.validUntil = x.proof.observedAt + 10_000;
    const reader = createNativeCleanupEvidence(x.config, { ...x.deps, readSupervisedCleanup() {
      if (++reads === 2) {
        if (fault === "deadline") elapsed = 5000;
        else if (fault === "expiry") x.f.setNow(x.proof.validUntil);
        else controller.abort();
      }
      return x.proof;
    } });
    await assert.rejects(reader.verify(controller.signal), /native_cleanup_evidence_unavailable/);
    assert.equal(reads, 2); reader.close();
  }
  assert.deepEqual(x.f.effects.load(x.snapshot.binding.effectClaimKey), { kind: "full", snapshot: x.claim });
});
