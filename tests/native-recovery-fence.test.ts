import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { sha256Digest } from "../src/security";
import { signArtifact, computeArtifactBodyDigest } from "../src/node-policy/v1/crypto";
import { createNativeRecoveryAuthority, type NativeRecoveryDependencies,
  type NativeRecoveryPermissionBody } from "../src/harness/hermes-native-v1/recovery-authority";
import { nativeStartAuthorityFixture } from "./helpers/native-start-authority";

test("known-run recovery refuses asynchronous freshness fences at either check", async t => {
  // One existing disposable database fixture for the whole matrix; no provider.
  const f = await nativeStartAuthorityFixture(); t.after(f.close);
  const keys = generateKeyPairSync("ed25519");
  const body: NativeRecoveryPermissionBody = { schema: "control-room.native-run-recovery-permission/v1",
    bindingDigest: sha256Digest(f.prepared.binding), approvalKeyId: "approval-key:recovery",
    issuedAt: f.dependencies.clock!(), expiresAt: f.prepared.binding.deadline + 120_000,
    operations: ["status", "stop"], nonce: "synthetic-recovery-nonce", bodyDigest: "" };
  const permission = signArtifact({ ...body, bodyDigest: computeArtifactBodyDigest(body) }, keys.privateKey);
  const config = { enrollment: f.config.enrollment, binding: f.prepared.binding, permission };
  const trust = { approvalKey: { keyId: body.approvalKeyId,
    publicKeySpki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url") },
    credentialAvailable: true, recoveryAllowed: true };
  const deps: NativeRecoveryDependencies = { readCurrent: async () => trust,
    assertProfileCurrent: f.dependencies.assertProfileCurrent, journal: f.journal,
    effects: f.effects, executions: f.executions, clock: f.dependencies.clock };
  const start = f.create(); t.after(() => start.close());
  await f.adapter(start).start(f.prepared.start);
  const positive = createNativeRecoveryAuthority(config, deps); t.after(() => positive.close());
  await positive.authority.check("status", f.prepared.binding);
  await assert.rejects(positive.authority.check("start", f.prepared.binding), /unavailable/);
  for (const source of ["trust", "profile"] as const) for (const failureCall of [1, 2]) for (const rejection of [false, true]) {
    let calls = 0;
    const fence = () => {
      if (++calls === failureCall) return rejection ? Promise.reject(new Error("synthetic_revocation")) : Promise.resolve();
    };
    const controller = createNativeRecoveryAuthority(config, { ...deps,
      ...(source === "trust" ? { readCurrent: async () => ({ ...trust, assertFresh: fence }) }
        : { assertProfileCurrent: async () => fence }) });
    try {
      let authorizedOperations = 0;
      await assert.rejects(async () => {
        await controller.authority.check("stop", f.prepared.binding);
        authorizedOperations++;
      }, /native_recovery_authority_unavailable/);
      assert.equal(authorizedOperations, 0);
      assert.equal(calls, failureCall);
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally { controller.close(); }
  }
  for (const invalid of [false, null, 0]) {
    const controller = createNativeRecoveryAuthority(config, { ...deps,
      assertProfileCurrent: async () => invalid as unknown as () => void });
    try { await assert.rejects(controller.authority.check("status", f.prepared.binding), /native_recovery_authority_unavailable/); }
    finally { controller.close(); }
  }
  let lateChecks = 0, stopBytes = 0;
  const late = createNativeRecoveryAuthority(config, { ...deps, readCurrent: async () => ({ ...trust,
    assertFresh: () => { if (++lateChecks >= 3) return Promise.reject(new Error("late_revocation")); },
  }) });
  t.after(() => late.close());
  const adapter = f.adapter(late, { ...f.transport, async json(wire) {
    await wire.authorize(); stopBytes++; throw new Error("unexpected_stop_bytes");
  } });
  assert.equal((await adapter.stop(f.prepared.binding.runId)).state, "ambiguous");
  assert.equal(stopBytes, 0);
  assert.equal(f.journal.load(f.prepared.binding.runId)?.stopAttempted, true);
  // A new adapter must not silently retry an uncertain stop.
  await f.adapter(late).stop(f.prepared.binding.runId);
  assert.equal(stopBytes, 0);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(value => value === "start").length, 1);
  assert.equal(f.calls.filter(value => value === "stop").length, 0);
});
