import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { sha256Digest } from "../src/security";
import { signArtifact, computeArtifactBodyDigest } from "../src/node-policy/v1/crypto";
import { createNativeRecoveryAuthority, composeNativeRunAuthority, type NativeRecoveryDependencies,
  type NativeRecoveryPermissionBody } from "../src/harness/hermes-native-v1/recovery-authority";
import { nativeStartAuthorityFixture } from "./helpers/native-start-authority";
import { nativeRunId, response } from "./hermes-native-fixture";

async function fixture() {
  const f = await nativeStartAuthorityFixture(), keys = generateKeyPairSync("ed25519");
  const body: NativeRecoveryPermissionBody = { schema: "control-room.native-run-recovery-permission/v1",
    bindingDigest: sha256Digest(f.prepared.binding), approvalKeyId: "approval-key:recovery", issuedAt: f.dependencies.clock!(),
    expiresAt: f.prepared.binding.deadline + 120_000, operations: ["status", "stop"], nonce: "synthetic-recovery-nonce", bodyDigest: "" };
  const sign = (value = body) => signArtifact({ ...value, bodyDigest: computeArtifactBodyDigest(value) }, keys.privateKey);
  const config = { enrollment: f.config.enrollment, binding: f.prepared.binding, permission: sign() };
  const trust = { approvalKey: { keyId: body.approvalKeyId, publicKeySpki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url") },
    credentialAvailable: true, recoveryAllowed: true };
  const deps: NativeRecoveryDependencies = { readCurrent: async () => trust, assertProfileCurrent: f.dependencies.assertProfileCurrent,
    journal: f.journal, effects: f.effects, executions: f.executions, clock: f.dependencies.clock };
  const create = (override: Partial<NativeRecoveryDependencies> = {}) => createNativeRecoveryAuthority(config, { ...deps, ...override });
  const start = f.create(), recovery = create();
  const combined = { authority: composeNativeRunAuthority(start.authority, recovery.authority), close() { start.close(); recovery.close(); } };
  const close = async () => { combined.close(); await f.close(); };
  return { ...f, close, body, sign, config, trust, deps, recovery, combined, createRecovery: create };
}

test("separate signed recovery permits exact-run stop after expiry without extending or settling work", async t => {
  const f = await fixture(); t.after(f.close); let stops = 0;
  const adapter = f.adapter(f.combined, { ...f.transport, async json(wire) {
    if (wire.operation !== "stop") return f.transport.json(wire);
    await wire.authorize(); stops++; return response({ run_id: nativeRunId, status: "stopping" });
  } });
  const run = await adapter.start(f.prepared.start); assert.equal(run.state, "queued");
  const lookup = f.effects.load(f.prepared.binding.effectClaimKey); if (lookup?.kind !== "full") assert.fail();
  const executionId = lookup.snapshot.executionId;
  f.setNow(f.prepared.binding.deadline);
  f.executions.apply(executionId, { eventId: "event:recovery:expired", kind: "deadline_crossed", latenessMilliseconds: 0,
    occurredAt: new Date(f.prepared.binding.deadline).toISOString() });
  assert.equal((await adapter.stop(run.binding.runId)).state, "stopping");
  assert.equal((await adapter.stop(run.binding.runId)).state, "stopping"); assert.equal(stops, 1);
  assert.equal(f.executions.load(executionId)?.state, "expired");
  const claim = f.effects.load(run.binding.effectClaimKey); assert.equal(claim?.kind === "full" && claim.snapshot.state, "executing");
  assert.equal(f.calls.filter(op => op === "start").length, 1);
});

test("recovery never permits starts, events or capability calls and requires a recorded known run", async t => {
  const f = await fixture(); t.after(f.close);
  for (const op of ["start", "capabilities", "events", "status", "stop"] as const)
    await assert.rejects(f.recovery.authority.check(op, f.prepared.binding), /unavailable/);
  await assert.rejects(f.recovery.authority.markStart(f.prepared.binding), /unavailable/);
  await f.combined.authority.markStart(f.prepared.binding);
  await assert.rejects(f.recovery.authority.check("status", f.prepared.binding), /unavailable/);
  assert.equal(f.calls.length, 0);
});

test("current revocation, key, credentials and profile checks precede authenticated recovery bytes", async t => {
  for (const failure of ["revoked", "key", "credential", "profile"] as const) await t.test(failure, async t => {
    const f = await fixture(); t.after(f.close); let stopBytes = 0;
    const adapter = f.adapter(f.combined, { ...f.transport, async json(wire) {
      if (wire.operation !== "stop") return f.transport.json(wire);
      if (failure === "revoked") f.trust.recoveryAllowed = false;
      if (failure === "key") f.trust.approvalKey.keyId = "approval-key:revoked";
      if (failure === "credential") f.trust.credentialAvailable = false;
      if (failure === "profile") f.setProfile(false);
      await wire.authorize(); stopBytes++; return response({ run_id: nativeRunId, status: "stopping" });
    } });
    const run = await adapter.start(f.prepared.start);
    assert.equal((await adapter.stop(run.binding.runId)).state, "ambiguous"); assert.equal(stopBytes, 0);
    assert.equal(f.journal.load(run.binding.runId)?.stopAttempted, true);
  });
});

test("lost stop acknowledgement remains ambiguous and is not replayed by a replacement adapter", async t => {
  const f = await fixture(); t.after(f.close); let calls = 0;
  const transport = { ...f.transport, async json(wire: Parameters<typeof f.transport.json>[0]) {
    if (wire.operation !== "stop") return f.transport.json(wire);
    await wire.authorize(); calls++; throw new Error("synthetic lost acknowledgement");
  } };
  const adapter = f.adapter(f.combined, transport), run = await adapter.start(f.prepared.start);
  assert.equal((await adapter.stop(run.binding.runId)).state, "ambiguous");
  await f.adapter(f.combined, transport).stop(run.binding.runId); assert.equal(calls, 1);
});

test("permission signatures, exact binding and preauthorization time cannot be substituted", async t => {
  const f = await fixture(); t.after(f.close); await f.adapter(f.combined).start(f.prepared.start);
  await assert.rejects(f.recovery.authority.check("status", { ...f.prepared.binding, runId: "run:other" }), /unavailable/);
  for (const changed of [
    { ...f.body, issuedAt: f.body.issuedAt + 1 },
    { ...f.body, bindingDigest: `sha256:${"a".repeat(64)}` },
  ]) {
    const config = { ...f.config, permission: f.sign(changed) };
    if (changed.bindingDigest !== f.body.bindingDigest) assert.throws(() => createNativeRecoveryAuthority(config, f.deps), /unavailable/);
    else { const c = createNativeRecoveryAuthority(config, f.deps); t.after(() => c.close()); f.setNow(changed.issuedAt);
      await assert.rejects(c.authority.check("status", f.prepared.binding), /unavailable/); }
  }
  const invalid = createNativeRecoveryAuthority({ ...f.config, permission: { ...f.config.permission, signature: "a".repeat(86) } }, f.deps);
  t.after(() => invalid.close()); await assert.rejects(invalid.authority.check("status", f.prepared.binding), /unavailable/);
});

test("recovery has a fixed expiry, bounded extension and monotonic per-controller clock", async t => {
  const f = await fixture(); t.after(f.close); await f.adapter(f.combined).start(f.prepared.start);
  assert.throws(() => createNativeRecoveryAuthority({ ...f.config, permission: f.sign({ ...f.body, expiresAt: f.prepared.binding.deadline + 300_001 }) }, f.deps), /unavailable/);
  await f.recovery.authority.check("status", f.prepared.binding);
  f.setNow(f.body.issuedAt - 1); await assert.rejects(f.recovery.authority.check("status", f.prepared.binding), /unavailable/);
  f.setNow(f.body.expiresAt); await assert.rejects(f.recovery.authority.check("stop", f.prepared.binding), /unavailable/);
});

test("unresolved recovery checks retain their eight slots across timeout batches and close fences late work", async t => {
  const f = await fixture(); t.after(f.close); let reads = 0; const release: Array<() => void> = [];
  const c = f.createRecovery({ checkMs: 10, async readCurrent() { reads++; await new Promise<void>(resolve => release.push(resolve)); return f.trust; } });
  for (let batch = 0; batch < 3; batch++) {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => c.authority.check("status", f.prepared.binding)));
    assert.equal(results.filter(r => r.status === "rejected").length, 8); assert.equal(reads, 8);
  }
  c.close(); for (const done of release) done(); await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(c.authority.check("status", f.prepared.binding), /unavailable/); assert.equal(reads, 8);
  assert.equal(f.effects.countFull(), 0); assert.equal(f.calls.length, 0);
});
