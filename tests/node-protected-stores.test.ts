import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import {
  NODE_POLICY_CONTRACT_V1,
  ProtectedStoreError,
  SystemClock,
  computeArtifactBodyDigest,
  keyAvailabilitySchema,
  keyReferenceSchema,
  selectNodePrivateKeyProvider,
  signArtifact,
  verifyArtifactSignature,
  type KeyReferenceV1,
  type ProtectedStoreFailureCode,
  type ServerTrustBundleBodyV1,
} from "../src/node-policy/v1/index.ts";
import {
  DeterministicApprovalTrustStoreFake,
  DeterministicNodePrivateKeyStoreFake,
  DeterministicServerTrustStoreFake,
  MutableTestClock,
} from "../src/node-policy/v1/testing.ts";
import { ProtectedStoreFrameSigner } from "../src/node-bridge/index.ts";
import { NODE_PROTOCOL_V1, verifyNodeFrameSignature, type UnsignedNodeFrame } from "../src/node-protocol/v1/index.ts";

const t0 = "2026-08-23T12:00:00.000Z";
const t1 = "2026-08-23T12:01:00.000Z";
const t2 = "2026-08-23T12:02:00.000Z";

function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    spki: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}

function keyReference(): KeyReferenceV1 {
  return {
    contractVersion: NODE_POLICY_CONTRACT_V1,
    keyId: "node-key:test:1",
    referenceId: "key-reference:test:1",
    provider: "memory_test",
    mode: "test",
    algorithm: "Ed25519",
  };
}

function withDigest<T extends object>(material: T): T & { bodyDigest: string } {
  return { ...material, bodyDigest: computeArtifactBodyDigest(material) };
}

function trustBundleBody(spki: string, epoch = 1): ServerTrustBundleBodyV1 {
  return withDigest({
    schema: "control-room.server-trust-bundle/v1" as const,
    tenantId: "tenant:owner",
    nodeClass: "personal-compute",
    epoch,
    issuedAt: t0,
    ownerRootKeyId: "owner-key:root:1",
    keys: [{ keyId: "server-key:primary", algorithm: "ed25519" as const, spki, state: "active" as const }],
  });
}

async function expectStoreError(action: Promise<unknown>, code: ProtectedStoreFailureCode): Promise<void> {
  await assert.rejects(action, (error) => error instanceof ProtectedStoreError && error.code === code);
}

function expectSynchronousStoreError(action: () => unknown, code: ProtectedStoreFailureCode): void {
  assert.throws(action, (error) => error instanceof ProtectedStoreError && error.code === code);
}

test("provider selection is explicit, platform-bound, and cannot silently downgrade", () => {
  assert.deepEqual(selectNodePrivateKeyProvider({ platform: "darwin", provider: "macos_keychain", runtimeMode: "production" }), {
    platform: "darwin", provider: "macos_keychain", mode: "native",
  });
  assert.deepEqual(selectNodePrivateKeyProvider({ platform: "win32", provider: "windows_dpapi_current_user", runtimeMode: "production" }), {
    platform: "win32", provider: "windows_dpapi_current_user", mode: "native",
  });
  assert.deepEqual(selectNodePrivateKeyProvider({ platform: "linux", provider: "encrypted_file", runtimeMode: "production", unwrapSecretSource: "file_descriptor" }), {
    platform: "linux", provider: "encrypted_file", mode: "encrypted_file", unwrapSecretSource: "file_descriptor",
  });
  assert.deepEqual(selectNodePrivateKeyProvider({ platform: "linux", provider: "memory_test", runtimeMode: "test" }), {
    platform: "linux", provider: "memory_test", mode: "test",
  });

  expectSynchronousStoreError(() => selectNodePrivateKeyProvider({ platform: "linux", provider: "macos_keychain", runtimeMode: "production" }), "unavailable_platform");
  expectSynchronousStoreError(() => selectNodePrivateKeyProvider({ platform: "darwin", provider: "encrypted_file", runtimeMode: "production" }), "invalid_configuration");
  expectSynchronousStoreError(() => selectNodePrivateKeyProvider({ platform: "darwin", provider: "memory_test", runtimeMode: "production" }), "invalid_configuration");
  expectSynchronousStoreError(() => selectNodePrivateKeyProvider({ platform: "darwin", provider: "macos_keychain", runtimeMode: "test" }), "invalid_configuration");
  expectSynchronousStoreError(() => selectNodePrivateKeyProvider({
    platform: "linux", provider: "encrypted_file", runtimeMode: "production", unwrapSecretSource: "environment_variable",
  } as never), "invalid_configuration");
  expectSynchronousStoreError(() => selectNodePrivateKeyProvider({
    platform: "linux", provider: "encrypted_file", runtimeMode: "production", unwrapSecretSource: "protected_file", unexpected: true,
  } as never), "invalid_configuration");
});

test("key references are opaque strict descriptors with provider-consistent modes", () => {
  assert.deepEqual(keyReferenceSchema.parse(keyReference()), keyReference());
  assert.deepEqual(keyAvailabilitySchema.parse({ state: "locked", keyReferenceId: "key-reference:test:1", observedAt: t0 }), {
    state: "locked", keyReferenceId: "key-reference:test:1", observedAt: t0,
  });
  assert.equal(keyAvailabilitySchema.safeParse({ state: "locked", keyReferenceId: "key-reference:test:1", observedAt: "2026-08-23T06:00:00-06:00" }).success, false);
  assert.equal(keyReferenceSchema.safeParse({ ...keyReference(), mode: "native" }).success, false);
  assert.equal(keyReferenceSchema.safeParse({ ...keyReference(), path: "C:\\private\\node.key" }).success, false);
  assert.equal(keyReferenceSchema.safeParse({ ...keyReference(), secret: "never" }).success, false);
});

test("private-key store fake fails closed across unlock, lock, availability, and disposal", async () => {
  const clock = new MutableTestClock(t0);
  const keys = keyMaterial();
  const store = new DeterministicNodePrivateKeyStoreFake(keyReference(), clock, keys.privateKey);
  assert.deepEqual(await store.availability(), { state: "available", keyReferenceId: "key-reference:test:1", observedAt: t0 });
  await expectStoreError(store.sign(Buffer.from("before-unlock")), "key_not_unlocked");

  await store.unlock();
  const message = Buffer.from("deterministic signing seam");
  const signature = await store.sign(message);
  assert.equal(verify(null, message, keys.publicKey, signature), true);

  await store.lock();
  await expectStoreError(store.sign(message), "key_not_unlocked");
  store.setAvailability("locked");
  assert.equal((await store.availability()).state, "locked");
  await expectStoreError(store.unlock(), "locked");
  await expectStoreError(store.sign(message), "locked");

  store.setAvailability("available");
  await store.unlock();
  await store.dispose();
  await expectStoreError(store.sign(message), "disposed");
  await expectStoreError(store.availability(), "disposed");
});

test("store observability never retains signing input or private key material", async () => {
  const clock = new MutableTestClock(t0);
  const keys = keyMaterial();
  const store = new DeterministicNodePrivateKeyStoreFake(keyReference(), clock, keys.privateKey);
  const privateMaterial = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  const secretInput = "canary-signing-input-never-retained";
  await store.unlock();
  await store.sign(Buffer.from(secretInput));
  const observable = JSON.stringify({ reference: store.reference(), availability: await store.availability(), history: store.history() });
  assert.equal(observable.includes(privateMaterial), false);
  assert.equal(observable.includes(secretInput), false);
  assert.deepEqual(store.history().map((call) => call.action), ["unlock", "sign", "reference", "availability"]);
});

test("protected-store frame signer plugs into CR-5B without exposing key bytes", async () => {
  const clock = new MutableTestClock(t0);
  const keys = keyMaterial();
  const store = new DeterministicNodePrivateKeyStoreFake(keyReference(), clock, keys.privateKey);
  const signer = new ProtectedStoreFrameSigner(store);
  const frame: UnsignedNodeFrame<"connection.hello"> = {
    protocol: NODE_PROTOCOL_V1,
    direction: "node_to_server",
    messageId: "message:hello:protected-store",
    correlationId: "correlation:protected-store",
    tenantId: "tenant:owner",
    actorId: "node:test",
    senderKind: "node",
    keyId: "node-key:test:1",
    connectionId: "connection:test:1",
    sequence: 1,
    sentAt: t0,
    expiresAt: t1,
    nonce: "protected_store_nonce_1234567890",
    type: "connection.hello",
    body: {
      supportedProtocols: [NODE_PROTOCOL_V1],
      features: [],
      requestedMaxFrameBytes: 65_536,
      lastAcknowledgedServerSequence: 0,
      unresolvedAttemptIds: [],
    },
  };
  await expectStoreError(signer.sign(frame), "key_not_unlocked");
  await store.unlock();
  const signed = await signer.sign(frame);
  assert.equal(verifyNodeFrameSignature(signed, keys.spki), true);
  await expectStoreError(signer.sign({ ...frame, keyId: "node-key:wrong" }), "invalid_configuration");
  assert.deepEqual(store.history().map((call) => call.action), ["reference", "sign", "unlock", "reference", "sign", "reference"]);
});

test("server and approval trust fakes remain separate and clone resolved public bytes", async () => {
  const clock = new MutableTestClock(t0);
  const owner = keyMaterial();
  const server = keyMaterial();
  const approval = keyMaterial();
  const artifact = signArtifact(trustBundleBody(server.spki), owner.privateKey);
  const serverStore = new DeterministicServerTrustStoreFake(clock, (bundle) => verifyArtifactSignature(bundle, owner.spki));
  const approvalBytes = new Uint8Array(Buffer.from(approval.spki, "base64url"));
  const approvalStore = new DeterministicApprovalTrustStoreFake(clock, new Map([["approval-key:1", approvalBytes]]));

  await serverStore.applyOwnerSignedBundle(artifact);
  assert.equal(await serverStore.currentEpoch(), 1);
  const serverBytes = await serverStore.resolveServerKey("server-key:primary");
  assert.deepEqual(serverBytes, new Uint8Array(Buffer.from(server.spki, "base64url")));
  assert.equal(await serverStore.resolveServerKey("approval-key:1"), undefined);
  assert.equal(await approvalStore.resolveApprovalKey("server-key:primary"), undefined);

  const firstApprovalRead = await approvalStore.resolveApprovalKey("approval-key:1");
  assert.ok(firstApprovalRead);
  firstApprovalRead[0] ^= 0xff;
  assert.deepEqual(await approvalStore.resolveApprovalKey("approval-key:1"), approvalBytes);

  await expectStoreError(serverStore.applyOwnerSignedBundle(artifact), "rollback_detected");
  const attacker = keyMaterial();
  const epochTwo = signArtifact(trustBundleBody(server.spki, 2), attacker.privateKey);
  await expectStoreError(serverStore.applyOwnerSignedBundle(epochTwo), "invalid_bundle");

  const throwingStore = new DeterministicServerTrustStoreFake(clock, () => { throw new Error("raw verifier failure with a private path"); });
  await expectStoreError(throwingStore.applyOwnerSignedBundle(artifact), "invalid_bundle");
});

test("clock boundary is canonical and deterministic", () => {
  const clock = new MutableTestClock(t0);
  assert.equal(clock.now(), t0);
  clock.advanceMilliseconds(60_000);
  assert.equal(clock.now(), t1);
  clock.set(t2);
  assert.equal(clock.now(), t2);
  assert.throws(() => clock.set("2026-08-23T06:00:00-06:00"), /canonical RFC 3339 UTC/);
  assert.throws(() => clock.advanceMilliseconds(-1), /nonnegative safe integer/);
  assert.match(new SystemClock().now(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("protected-store errors expose only fixed safe messages", () => {
  const canary = "raw-os-error-with-private-path-and-user";
  const error = new ProtectedStoreError("permission_denied");
  assert.equal(error.code, "permission_denied");
  assert.equal(error.message, "Protected store permission was denied");
  assert.equal(JSON.stringify(error).includes(canary), false);
  expectSynchronousStoreError(() => selectNodePrivateKeyProvider({
    platform: canary,
    provider: canary,
    runtimeMode: "production",
  } as never), "invalid_configuration");
});
