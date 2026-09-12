import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { sha256Digest } from "../src/security";
import { signArtifact, computeArtifactBodyDigest } from "../src/node-policy/v1/crypto";
import { createNativeRecoveryAuthority, type NativeRecoveryDependencies,
  type NativeRecoveryPermissionBody } from "../src/harness/hermes-native-v1/recovery-authority";
import { HermesNativeRunAdapter } from "../src/harness/hermes-native-v1/adapter";
import { nativeStartAuthorityFixture } from "./helpers/native-start-authority";
import { recordedHermesGptTransport } from "../src/harness/hermes-native-v1/hermes-gpt-recorded-responses";

/** Offline Path-A scenarios for issue #8: the already-hardened
 * `HermesNativeRunAdapter` driven by recorded hermes-gpt-shaped transports
 * (`asimons81/hermes-gpt@11db8ac`). No subprocess, no network, no live upstream.
 * Each scenario asserts the uncertainty/interruption behavior #8 requires:
 * failed start, lost reply, disconnect/reconnect, restart, stop handshake,
 * and never auto-accepting an upstream success string.
 */
test("hermes-gpt mapping: failed capabilities preflight never dispatches", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close);
  const wire = recordedHermesGptTransport({ capabilities: "offline" });
  const started = await f.adapter(f.create(), wire).start(f.prepared.start);
  assert.equal(started.state, "failed");
  assert.equal(started.availability, "offline");
  assert.equal(started.safeReason, "preflight_failed");
  assert.ok(!wire.calls.includes("start"), `no dispatch after failed preflight, saw: ${wire.calls}`);
});

test("hermes-gpt mapping: lost start reply quarantines to ambiguous without redispatch", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close);
  const wire = recordedHermesGptTransport({ start: "uncertain" });
  const adapter = f.adapter(f.create(), wire);
  const first = await adapter.start(f.prepared.start);
  assert.equal(first.state, "ambiguous");
  assert.equal(first.safeReason, "dispatch_uncertain");
  const second = await adapter.start(f.prepared.start);
  assert.equal(second.state, "ambiguous");
  assert.equal(wire.calls.filter(call => call === "start").length, 1);
});

test("hermes-gpt mapping: dropped event stream resnapshots on reconnect, never replays", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close);
  const wire = recordedHermesGptTransport({ events: "disconnect" });
  const adapter = f.adapter(f.create(), wire);
  await adapter.start(f.prepared.start);
  const observed = await adapter.observe(f.prepared.binding.runId);
  assert.equal(observed.state, "running");
  assert.equal(observed.availability, "current");
  assert.equal(observed.streamAttempted, true);
  assert.equal(observed.lastActivity, "status_resnapshot");
  assert.equal(wire.calls.filter(call => call === "start").length, 1);
});

test("hermes-gpt mapping: restart reuses the reserved run, never replays dispatch", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close);
  const firstWire = recordedHermesGptTransport({});
  const first = f.adapter(f.create(), firstWire);
  const started = await first.start(f.prepared.start);
  assert.equal(started.state, "queued");
  const secondWire = recordedHermesGptTransport({});
  const restarted = f.adapter(f.create(), secondWire);
  const again = await restarted.start(f.prepared.start);
  assert.equal(again.state, "queued");
  assert.deepEqual(secondWire.calls, []);
});

test("hermes-gpt mapping: stop handshake is idempotent, terminal confirmed by status", async t => {
  // Stop needs its own exact-run cleanup permission: the start authority denies
  // it by design, so stop runs through the recovery authority (same journal).
  const f = await nativeStartAuthorityFixture(); t.after(f.close);
  const wire = recordedHermesGptTransport({ stop: "terminal", output: "done" });
  const start = f.create(); t.after(() => start.close());
  await f.adapter(start, wire).start(f.prepared.start);
  const keys = generateKeyPairSync("ed25519");
  const body: NativeRecoveryPermissionBody = { schema: "control-room.native-run-recovery-permission/v1",
    bindingDigest: sha256Digest(f.prepared.binding), approvalKeyId: "approval-key:recovery",
    issuedAt: f.dependencies.clock!(), expiresAt: f.prepared.binding.deadline + 120_000,
    operations: ["status", "stop"], nonce: "synthetic-hermes-gpt-stop", bodyDigest: "" };
  const permission = signArtifact({ ...body, bodyDigest: computeArtifactBodyDigest(body) }, keys.privateKey);
  const trust = { approvalKey: { keyId: body.approvalKeyId,
    publicKeySpki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url") },
    credentialAvailable: true, recoveryAllowed: true };
  const deps: NativeRecoveryDependencies = { readCurrent: async () => trust,
    assertProfileCurrent: f.dependencies.assertProfileCurrent, journal: f.journal,
    effects: f.effects, executions: f.executions, clock: f.dependencies.clock };
  const recovery = createNativeRecoveryAuthority(
    { enrollment: f.config.enrollment, binding: f.prepared.binding, permission }, deps);
  t.after(() => recovery.close());
  const adapter = new HermesNativeRunAdapter(f.config.enrollment, f.journal, recovery.authority, wire, f.dependencies.clock);
  const stopped = await adapter.stop(f.prepared.binding.runId);
  assert.equal(stopped.state, "completed");
  assert.equal(stopped.resultText, "done");
  const again = await adapter.stop(f.prepared.binding.runId);
  assert.equal(again.state, "completed");
  assert.equal(wire.calls.filter(call => call === "stop").length, 1);
});

test("hermes-gpt mapping: upstream success text is never auto-accepted", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close);
  const noOutput = f.adapter(f.create(), recordedHermesGptTransport({ status: "completed" }));
  await noOutput.start(f.prepared.start);
  const polled = await noOutput.poll(f.prepared.binding.runId);
  assert.equal(polled.state, "completed");
  assert.equal(polled.resultText, null);
});

test("hermes-gpt mapping: upstream failed/timed-out/orphaned jobs yield no result text", async t => {
  for (const status of ["failed", "timed_out", "orphaned"] as const) {
    const f = await nativeStartAuthorityFixture();
    try {
      const adapter = f.adapter(f.create(), recordedHermesGptTransport({ status }));
      await adapter.start(f.prepared.start);
      const polled = await adapter.poll(f.prepared.binding.runId);
      assert.equal(polled.resultText, null);
      assert.equal(polled.state, status === "orphaned" ? "ambiguous" : "failed");
    } finally { await f.close(); }
  }
});
