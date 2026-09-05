import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PinnedApprovalTrustStore, resolvePinnedApprovalKey, type ApprovalPinSet } from "../src/node-policy/v1/pinned-approval-trust";
import { PinnedOwnerTrust, SqliteNodeSecurityStateRepository, computeArtifactBodyDigest, signArtifact, signTrustBundleShrinkAuthorization,
  type ServerTrustKeyV1 } from "../src/node-policy/v1";
import { nativeStartAuthorityFixture } from "./helpers/native-start-authority";
import { createNativeRecoveryAuthority, composeNativeRunAuthority, type NativeRecoveryPermissionBody } from "../src/harness/hermes-native-v1/recovery-authority";
import { sha256Digest } from "../src/security";
import { nativeRunId, response } from "./hermes-native-fixture";

const pin = (keyId: string, spki: string) => ({ keyId, algorithm: "ed25519" as const, spki,
  fingerprint: `sha256:${createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex")}` });
async function fixture() {
  const f = await nativeStartAuthorityFixture(), directory = await mkdtemp(join(tmpdir(), "cr-approval-pins-"));
  const root = generateKeyPairSync("ed25519"), server = generateKeyPairSync("ed25519"), recovery = generateKeyPairSync("ed25519");
  const rootPin = pin("owner-key:root", root.publicKey.export({ type: "spki", format: "der" }).toString("base64url"));
  const serverKey: ServerTrustKeyV1 = { keyId: "server-key:online", algorithm: "ed25519", state: "active",
    spki: server.publicKey.export({ type: "spki", format: "der" }).toString("base64url") };
  const r = f.prepared.request, now = f.dependencies.clock!;
  const security = new SqliteNodeSecurityStateRepository({ artifactDatabasePath: join(directory, "trust.db"), highWaterDatabasePath: join(directory, "water.db") },
    { tenantId: r.tenantId, nodeId: r.nodeId, nodeClass: "personal-compute" }, new PinnedOwnerTrust({ ceilingProvisioningKey: rootPin,
      serverTrustRootKey: rootPin, trustShrinkKeys: [rootPin] }), { now: () => new Date(now()).toISOString() });
  const bundle = (epoch: number, keys: ServerTrustKeyV1[]) => {
    const material = { schema: "control-room.server-trust-bundle/v1" as const, tenantId: r.tenantId, nodeClass: "personal-compute", epoch,
      issuedAt: new Date(now()).toISOString(), ownerRootKeyId: rootPin.keyId, keys: [...keys].sort((a,b) => a.keyId.localeCompare(b.keyId)) };
    const body = { ...material, bodyDigest: computeArtifactBodyDigest(material) };
    return { ...signArtifact(body, root.privateKey), shrinkAuthorization: signTrustBundleShrinkAuthorization(body.bodyDigest, rootPin.keyId, root.privateKey) };
  };
  await security.provisionInitialTrustBundle(bundle(1, [serverKey]));
  const approval = f.policy.approvalKey!;
  const pins: ApprovalPinSet = { schema: "control-room.owner-approval-pins/v1", tenantId: r.tenantId, nodeId: r.nodeId,
    nodeClass: "personal-compute", validFrom: now(), validUntil: f.prepared.binding.deadline + 120_000,
    keys: [pin(approval.keyId, approval.publicKeySpki), pin("approval-key:recovery", recovery.publicKey.export({ type: "spki", format: "der" }).toString("base64url"))] };
  const store = new PinnedApprovalTrustStore(pins, { security, clock: now });
  return { ...f, security, serverKey, bundle, pins, store, recovery,
    close: async () => { store.close(); security.close(); await f.close(); await rm(directory, { recursive: true }); } };
}

test("separate configured approval pins supply both actual native start and recovery checks", async t => {
  const f = await fixture(); t.after(f.close);
  const resolve = async (keyId: string) => {
    const key = await resolvePinnedApprovalKey(f.store, f.pins, keyId); if (!key) throw new Error("missing synthetic owner key");
    return key;
  };
  const start = f.create({ async readCurrent(signal) { return { ...await f.dependencies.readCurrent(signal), approvalKey: await resolve(f.policy.approvalKey!.keyId) }; } });
  const material: NativeRecoveryPermissionBody = { schema: "control-room.native-run-recovery-permission/v1", bindingDigest: sha256Digest(f.prepared.binding),
    approvalKeyId: "approval-key:recovery", issuedAt: f.dependencies.clock!(), expiresAt: f.pins.validUntil, operations: ["status", "stop"], nonce: "synthetic-recovery-nonce", bodyDigest: "" };
  material.bodyDigest = computeArtifactBodyDigest(material);
  const recovery = createNativeRecoveryAuthority({ enrollment: f.config.enrollment, binding: f.prepared.binding, permission: signArtifact(material, f.recovery.privateKey) },
    { journal: f.journal, effects: f.effects, executions: f.executions, clock: f.dependencies.clock, assertProfileCurrent: f.dependencies.assertProfileCurrent,
      async readCurrent() { return { approvalKey: await resolve(material.approvalKeyId), recoveryAllowed: true, credentialAvailable: true }; } });
  const combined = { authority: composeNativeRunAuthority(start.authority, recovery.authority), close() { start.close(); recovery.close(); } };
  t.after(() => combined.close()); let stops = 0;
  const adapter = f.adapter(combined, { ...f.transport, async json(wire) {
    if (wire.operation !== "stop") return f.transport.json(wire);
    await wire.authorize(); stops++; return response({ run_id: nativeRunId, status: "stopping" });
  } });
  const run = await adapter.start(f.prepared.start); assert.equal(run.state, "queued"); f.setNow(f.prepared.binding.deadline);
  assert.equal((await adapter.stop(run.binding.runId)).state, "stopping"); assert.equal(stops, 1);
});

test("server material and server identifiers cannot be configured as owner approval", async t => {
  const f = await fixture(); t.after(f.close);
  for (const key of [pin("approval-key:alias", f.serverKey.spki), { ...f.pins.keys[0], keyId: f.serverKey.keyId }]) {
    const store = new PinnedApprovalTrustStore({ ...f.pins, keys: [key] }, { security: f.security, clock: f.dependencies.clock }); t.after(() => store.close());
    await assert.rejects(store.resolveApprovalKey(key.keyId));
  }
  const replacement = generateKeyPairSync("ed25519");
  await f.security.applyOwnerSignedBundle(f.bundle(2, [{ ...f.serverKey, state: "retired" }, { keyId: "server-key:new", algorithm: "ed25519", state: "active",
    spki: replacement.publicKey.export({ type: "spki", format: "der" }).toString("base64url") }]));
  const old = new PinnedApprovalTrustStore({ ...f.pins, keys: [pin("approval-key:retired-alias", f.serverKey.spki)] }, { security: f.security, clock: f.dependencies.clock });
  t.after(() => old.close()); await assert.rejects(old.resolveApprovalKey("approval-key:retired-alias"));
});

test("current signed server trust updates can invalidate formerly separate approval material", async t => {
  const f = await fixture(); t.after(f.close); const approval = f.pins.keys[0];
  assert.ok(await f.store.resolveApprovalKey(approval.keyId));
  await f.security.applyOwnerSignedBundle(f.bundle(2, [f.serverKey, { keyId: "server-key:accidental-reuse", algorithm: "ed25519", state: "active", spki: approval.spki }]));
  await assert.rejects(f.store.resolveApprovalKey(approval.keyId));
});

test("malformed, duplicate and aliased pins fail before use; returned bytes and inputs are isolated", async t => {
  const f = await fixture(); t.after(f.close); const key = f.pins.keys[0];
  for (const keys of [[{ ...key, fingerprint: `sha256:${"f".repeat(64)}` }], [key, { ...key }], [key, { ...key, keyId: "approval-key:duplicate-material" }], [{ ...key, spki: key.spki + "=" }]])
    assert.throws(() => new PinnedApprovalTrustStore({ ...f.pins, keys }, { security: f.security, clock: f.dependencies.clock }));
  const expected = key.spki; key.spki = "bad";
  const first = await f.store.resolveApprovalKey(key.keyId); first!.fill(0);
  assert.equal(Buffer.from((await f.store.resolveApprovalKey(key.keyId))!).toString("base64url"), expected);
  assert.equal(await f.store.resolveApprovalKey("approval-key:unknown"), undefined);
});

test("wrong scope, expired pins, backwards clock and closed stores cannot resolve approval", async t => {
  const f = await fixture(); t.after(f.close); const id = f.pins.keys[0].keyId;
  const wrong = new PinnedApprovalTrustStore({ ...f.pins, tenantId: "tenant:other" }, { security: f.security, clock: f.dependencies.clock });
  t.after(() => wrong.close()); await assert.rejects(wrong.resolveApprovalKey(id));
  await assert.rejects(resolvePinnedApprovalKey(f.store, { ...f.pins, nodeId: "node:other" }, id));
  await f.store.resolveApprovalKey(id); f.setNow(f.pins.validFrom - 1); await assert.rejects(f.store.resolveApprovalKey(id));
  f.setNow(f.pins.validUntil); await assert.rejects(f.store.resolveApprovalKey(id));
  f.setNow(f.pins.validFrom); await assert.rejects(f.store.resolveApprovalKey(id));
  f.store.close(); await assert.rejects(f.store.resolveApprovalKey(id));
});

test("stalled trust reads are capped and timeout permanently disables that store without new reads", async t => {
  const f = await fixture(); t.after(f.close); let reads = 0; const releases: Array<() => void> = [];
  const store = new PinnedApprovalTrustStore({ ...f.pins, validUntil: f.pins.validFrom + 20 }, { clock: f.dependencies.clock, security: { async loadTrustBundle() {
    reads++; await new Promise<void>(resolve => releases.push(resolve)); return f.security.loadTrustBundle();
  } } }); t.after(() => store.close());
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.resolveApprovalKey(f.pins.keys[0].keyId)));
  assert.equal(results.filter(r => r.status === "rejected").length, 8); assert.equal(reads, 8);
  await assert.rejects(store.resolveApprovalKey(f.pins.keys[0].keyId)); assert.equal(reads, 8);
  for (const release of releases) release(); await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(store.resolveApprovalKey(f.pins.keys[0].keyId));
});
