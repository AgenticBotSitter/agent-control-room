import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  PinnedOwnerTrust,
  ProtectedStoreError,
  SqliteNodeSecurityStateRepository,
  computeArtifactBodyDigest,
  ownerSignedTrustBundleSchema,
  signArtifact,
  signTrustBundleShrinkAuthorization,
  type NodeAuthorityCeilingV1,
  type OwnerPinSetV1,
  type OwnerSignedTrustBundleV1,
  type ProtectedStoreFailureCode,
  type SecurityStateFaultPoint,
  type ServerTrustBundleBodyV1,
  type ServerTrustKeyV1,
  type SignedNodeAuthorityCeilingV1,
} from "../src/node-policy/v1/index.ts";
import { MutableTestClock } from "../src/node-policy/v1/testing.ts";

const instant = "2026-08-23T12:00:00.000Z";
const binding = { tenantId: "tenant:owner", nodeId: "node:marvin", nodeClass: "personal-compute" };

interface KeyMaterial {
  privateKey: KeyObject;
  spki: string;
}

function keyMaterial(): KeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, spki: publicKey.export({ format: "der", type: "spki" }).toString("base64url") };
}

function fingerprint(spki: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex")}`;
}

function pin(keyId: string, key: KeyMaterial) {
  return { keyId, algorithm: "ed25519" as const, spki: key.spki, fingerprint: fingerprint(key.spki) };
}

function pinSet(ceilingOwner: KeyMaterial, trustRoot: KeyMaterial, shrinkOwner: KeyMaterial): OwnerPinSetV1 {
  return {
    ceilingProvisioningKey: pin("owner-key:ceiling:1", ceilingOwner),
    serverTrustRootKey: pin("owner-key:root:1", trustRoot),
    trustShrinkKeys: [pin("owner-key:shrink:1", shrinkOwner)],
  };
}

function withDigest<T extends object>(material: T): T & { bodyDigest: string } {
  return { ...material, bodyDigest: computeArtifactBodyDigest(material) };
}

function ceiling(owner: KeyMaterial, version: number, projects = ["project:alpha"]): SignedNodeAuthorityCeilingV1 {
  const body: NodeAuthorityCeilingV1 = withDigest({
    schema: "control-room.node-authority-ceiling/v1" as const,
    tenantId: binding.tenantId,
    nodeId: binding.nodeId,
    version,
    issuedAt: instant,
    issuerKeyId: "owner-key:ceiling:1",
    projectIds: projects,
    executorIds: ["executor:shell"],
    operationIds: ["operation:read"],
    credentialRefs: [],
    filesystemRoots: ["C:\\ControlRoom"],
    networkDestinations: [],
    maxRisk: "low" as const,
    externalEffects: "none" as const,
    maxDurationSeconds: 300,
    maxConcurrentEffects: 0,
  });
  return signArtifact(body, owner.privateKey);
}

function trustBundle(
  root: KeyMaterial,
  epoch: number,
  keys: ServerTrustKeyV1[],
  shrink?: { keyId: string; privateKey: KeyObject },
): OwnerSignedTrustBundleV1 {
  const body: ServerTrustBundleBodyV1 = withDigest({
    schema: "control-room.server-trust-bundle/v1" as const,
    tenantId: binding.tenantId,
    nodeClass: binding.nodeClass,
    epoch,
    issuedAt: instant,
    ownerRootKeyId: "owner-key:root:1",
    keys: [...keys].sort((left, right) => left.keyId.localeCompare(right.keyId)),
  });
  const signed = signArtifact(body, root.privateKey);
  return shrink ? {
    ...signed,
    shrinkAuthorization: signTrustBundleShrinkAuthorization(body.bodyDigest, shrink.keyId, shrink.privateKey),
  } : signed;
}

function trustKey(keyId: string, key: KeyMaterial, state: ServerTrustKeyV1["state"] = "active"): ServerTrustKeyV1 {
  return { keyId, algorithm: "ed25519", spki: key.spki, state };
}

async function expectStoreError(action: Promise<unknown>, code: ProtectedStoreFailureCode): Promise<void> {
  await assert.rejects(action, (error) => error instanceof ProtectedStoreError && error.code === code);
}

function expectSyncStoreError(action: () => unknown, code: ProtectedStoreFailureCode): void {
  assert.throws(action, (error) => error instanceof ProtectedStoreError && error.code === code);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "control-room-security-state-"));
  const ceilingOwner = keyMaterial();
  const trustRoot = keyMaterial();
  const shrinkOwner = keyMaterial();
  const pins = new PinnedOwnerTrust(pinSet(ceilingOwner, trustRoot, shrinkOwner));
  const paths = { artifactDatabasePath: join(directory, "artifacts.sqlite"), highWaterDatabasePath: join(directory, "high-water.sqlite") };
  const open = (fault?: SecurityStateFaultPoint) => new SqliteNodeSecurityStateRepository(
    paths,
    binding,
    pins,
    new MutableTestClock(instant),
    fault ? (point) => { if (point === fault) throw new Error(`simulated crash: ${point}`); } : undefined,
  );
  return { directory, paths, ceilingOwner, trustRoot, shrinkOwner, pins, open };
}

test("owner pins are cryptographically bound and the two databases must be independent", async () => {
  const state = await fixture();
  try {
    const invalid = pinSet(state.ceilingOwner, state.trustRoot, state.shrinkOwner);
    invalid.ceilingProvisioningKey.fingerprint = `sha256:${"0".repeat(64)}`;
    expectSyncStoreError(() => new PinnedOwnerTrust(invalid), "invalid_configuration");
    expectSyncStoreError(() => new SqliteNodeSecurityStateRepository(
      { artifactDatabasePath: state.paths.artifactDatabasePath, highWaterDatabasePath: state.paths.artifactDatabasePath },
      binding, state.pins, new MutableTestClock(instant),
    ), "invalid_configuration");
    expectSyncStoreError(() => new SqliteNodeSecurityStateRepository(
      { artifactDatabasePath: ":memory:", highWaterDatabasePath: state.paths.highWaterDatabasePath },
      binding, state.pins, new MutableTestClock(instant),
    ), "invalid_configuration");

    const closed = state.open();
    closed.close();
    await expectStoreError(closed.loadCeiling(), "corrupt");
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("ceiling provisioning is explicit, durable, monotonic, tenant-bound, and idempotent", async () => {
  const state = await fixture();
  const attacker = keyMaterial();
  try {
    let repository = state.open();
    const v1 = ceiling(state.ceilingOwner, 1);
    await expectStoreError(repository.loadCeiling(), "missing");
    await expectStoreError(repository.adoptCeiling(v1), "missing");
    assert.equal(await repository.provisionInitialCeiling(v1), "provisioned");
    assert.equal(await repository.provisionInitialCeiling(v1), "duplicate");
    assert.deepEqual(await repository.loadCeiling(), v1);

    const forged = signArtifact(v1.body, attacker.privateKey);
    await expectStoreError(repository.adoptCeiling(forged), "invalid_bundle");
    const wrongTenantBody = withDigest({ ...v1.body, tenantId: "tenant:other", bodyDigest: undefined });
    await expectStoreError(repository.adoptCeiling(signArtifact(wrongTenantBody as NodeAuthorityCeilingV1, state.ceilingOwner.privateKey)), "invalid_bundle");

    const v2 = ceiling(state.ceilingOwner, 2, ["project:alpha", "project:beta"]);
    assert.equal(await repository.adoptCeiling(v2), "adopted");
    assert.equal(await repository.adoptCeiling(v2), "duplicate");
    await expectStoreError(repository.adoptCeiling(v1), "rollback_detected");
    await expectStoreError(repository.adoptCeiling(ceiling(state.ceilingOwner, 2, ["project:other"])), "rollback_detected");
    repository.close();

    repository = state.open();
    assert.deepEqual(await repository.loadCeiling(), v2);
    repository.close();
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("ceiling crashes recover fail-closed before and after artifact commit", async () => {
  const state = await fixture();
  try {
    const v1 = ceiling(state.ceilingOwner, 1);
    const v2 = ceiling(state.ceilingOwner, 2);
    let repository = state.open("ceiling_after_prepare");
    await assert.rejects(repository.provisionInitialCeiling(v1), /simulated crash/);
    repository.close();

    repository = state.open();
    await expectStoreError(repository.loadCeiling(), "rollback_detected");
    await expectStoreError(repository.adoptCeiling(v1), "recovery_required");
    assert.equal(await repository.provisionInitialCeiling(v1), "recovered");
    repository.close();

    repository = state.open("ceiling_after_prepare");
    await assert.rejects(repository.adoptCeiling(v2), /simulated crash/);
    repository.close();
    repository = state.open();
    await expectStoreError(repository.loadCeiling(), "recovery_required");
    assert.equal(await repository.adoptCeiling(v2), "recovered");
    repository.close();

    const v3 = ceiling(state.ceilingOwner, 3);
    repository = state.open("ceiling_after_artifact");
    await assert.rejects(repository.adoptCeiling(v3), /simulated crash/);
    repository.close();
    repository = state.open();
    assert.deepEqual(await repository.loadCeiling(), v3);
    repository.close();

    const v4 = ceiling(state.ceilingOwner, 4);
    repository = state.open("ceiling_after_commit");
    await assert.rejects(repository.adoptCeiling(v4), /simulated crash/);
    repository.close();
    repository = state.open();
    assert.deepEqual(await repository.loadCeiling(), v4);
    assert.equal(await repository.adoptCeiling(v4), "duplicate");
    repository.close();
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("independent high-water detects ceiling tamper, partial deletion, and artifact rollback", async () => {
  const state = await fixture();
  try {
    const v1 = ceiling(state.ceilingOwner, 1);
    const v2 = ceiling(state.ceilingOwner, 2);
    let repository = state.open();
    await repository.provisionInitialCeiling(v1);
    await repository.adoptCeiling(v2);
    repository.close();

    let db = new DatabaseSync(state.paths.artifactDatabasePath);
    db.prepare("UPDATE node_ceiling_current SET version=?,body_digest=?,artifact_json=? WHERE tenant_id=? AND node_id=?")
      .run(v1.body.version, v1.body.bodyDigest, JSON.stringify(v1), binding.tenantId, binding.nodeId);
    db.close();
    repository = state.open();
    await expectStoreError(repository.loadCeiling(), "rollback_detected");
    repository.close();

    db = new DatabaseSync(state.paths.artifactDatabasePath);
    db.prepare("UPDATE node_ceiling_current SET artifact_json='{}' WHERE tenant_id=? AND node_id=?").run(binding.tenantId, binding.nodeId);
    db.close();
    repository = state.open();
    await expectStoreError(repository.loadCeiling(), "corrupt");
    repository.close();

    db = new DatabaseSync(state.paths.highWaterDatabasePath);
    db.prepare("DELETE FROM ceiling_high_water WHERE tenant_id=? AND node_id=?").run(binding.tenantId, binding.nodeId);
    db.close();
    repository = state.open();
    await expectStoreError(repository.loadCeiling(), "rollback_detected");
    repository.close();
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("trust lifecycle prevents omission, resurrection, SPKI aliasing, and unauthorized full replacement", async () => {
  const state = await fixture();
  const serverA = keyMaterial();
  const serverB = keyMaterial();
  const serverC = keyMaterial();
  const serverD = keyMaterial();
  try {
    const repository = state.open();
    const epoch1 = trustBundle(state.trustRoot, 1, [trustKey("server:a", serverA), trustKey("server:b", serverB)]);
    assert.equal(await repository.provisionInitialTrustBundle(epoch1), "provisioned");
    assert.equal(await repository.provisionInitialTrustBundle(epoch1), "duplicate");
    assert.equal(await repository.currentEpoch(), 1);

    const epoch2 = trustBundle(state.trustRoot, 2, [
      trustKey("server:a", serverA, "retired"), trustKey("server:b", serverB), trustKey("server:c", serverC),
    ]);
    await repository.applyOwnerSignedBundle(epoch2);
    assert.deepEqual(await repository.resolveServerKey("server:b"), new Uint8Array(Buffer.from(serverB.spki, "base64url")));
    assert.equal(await repository.resolveServerKey("server:a"), undefined);

    await expectStoreError(repository.applyOwnerSignedBundle(trustBundle(state.trustRoot, 3, [
      trustKey("server:a", serverA, "active"), trustKey("server:b", serverB), trustKey("server:c", serverC),
    ])), "invalid_bundle");
    await expectStoreError(repository.applyOwnerSignedBundle(trustBundle(state.trustRoot, 3, [
      trustKey("server:a", serverA, "retired"), trustKey("server:c", serverC),
    ])), "invalid_bundle");
    await expectStoreError(repository.applyOwnerSignedBundle(trustBundle(state.trustRoot, 3, [
      trustKey("server:a", serverA, "retired"), trustKey("server:b", serverB), trustKey("server:c", serverC), trustKey("server:d", serverA),
    ])), "invalid_bundle");

    const epoch3 = trustBundle(state.trustRoot, 3, [
      trustKey("server:a", serverA, "retired"), trustKey("server:b", serverB, "revoked"), trustKey("server:c", serverC),
    ]);
    await repository.applyOwnerSignedBundle(epoch3);
    await expectStoreError(repository.applyOwnerSignedBundle(trustBundle(state.trustRoot, 4, [
      trustKey("server:a", serverA, "retired"), trustKey("server:b", serverB), trustKey("server:c", serverC),
    ])), "invalid_bundle");

    const replacementKeys = [
      trustKey("server:a", serverA, "retired"), trustKey("server:b", serverB, "revoked"),
      trustKey("server:c", serverC, "retired"), trustKey("server:d", serverD),
    ];
    await expectStoreError(repository.applyOwnerSignedBundle(trustBundle(state.trustRoot, 4, replacementKeys)), "invalid_bundle");
    await repository.applyOwnerSignedBundle(trustBundle(state.trustRoot, 4, replacementKeys, {
      keyId: "owner-key:shrink:1", privateKey: state.shrinkOwner.privateKey,
    }));
    assert.equal(await repository.currentEpoch(), 4);
    assert.ok(await repository.resolveServerKey("server:d"));
    repository.close();
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("trust signatures, binding, epoch replay, and public-key uniqueness fail closed", async () => {
  const state = await fixture();
  const server = keyMaterial();
  const attacker = keyMaterial();
  try {
    const repository = state.open();
    const epoch1 = trustBundle(state.trustRoot, 1, [trustKey("server:a", server)]);
    await expectStoreError(repository.applyOwnerSignedBundle(epoch1), "missing");
    await repository.provisionInitialTrustBundle(epoch1);
    await expectStoreError(repository.applyOwnerSignedBundle(trustBundle(attacker, 2, [trustKey("server:a", server)])), "invalid_bundle");
    await expectStoreError(repository.applyOwnerSignedBundle(trustBundle(state.trustRoot, 1, [trustKey("server:other", attacker)])), "rollback_detected");

    const wrongBinding = trustBundle(state.trustRoot, 2, [trustKey("server:a", server)]);
    const wrongBody = withDigest({ ...wrongBinding.body, nodeClass: "other-class", bodyDigest: undefined });
    await expectStoreError(repository.applyOwnerSignedBundle(signArtifact(wrongBody as ServerTrustBundleBodyV1, state.trustRoot.privateKey)), "invalid_bundle");

    const duplicateSpki = trustBundle(state.trustRoot, 2, [trustKey("server:a", server), trustKey("server:b", server)]);
    assert.equal(ownerSignedTrustBundleSchema.safeParse(duplicateSpki).success, false);
    await expectStoreError(repository.applyOwnerSignedBundle(duplicateSpki), "invalid_bundle");
    repository.close();
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("trust crashes recover safely and trust history tamper is detected", async () => {
  const state = await fixture();
  const serverA = keyMaterial();
  const serverB = keyMaterial();
  try {
    const epoch1 = trustBundle(state.trustRoot, 1, [trustKey("server:a", serverA)]);
    let repository = state.open("trust_after_prepare");
    await assert.rejects(repository.provisionInitialTrustBundle(epoch1), /simulated crash/);
    repository.close();
    repository = state.open();
    await expectStoreError(repository.loadTrustBundle(), "rollback_detected");
    await expectStoreError(repository.applyOwnerSignedBundle(epoch1), "recovery_required");
    assert.equal(await repository.provisionInitialTrustBundle(epoch1), "recovered");
    repository.close();

    const epoch2 = trustBundle(state.trustRoot, 2, [trustKey("server:a", serverA), trustKey("server:b", serverB)]);
    repository = state.open("trust_after_prepare");
    await assert.rejects(repository.applyOwnerSignedBundle(epoch2), /simulated crash/);
    repository.close();
    repository = state.open();
    await expectStoreError(repository.loadTrustBundle(), "recovery_required");
    await repository.applyOwnerSignedBundle(epoch2);
    repository.close();

    const epoch3 = trustBundle(state.trustRoot, 3, [trustKey("server:a", serverA), trustKey("server:b", serverB)]);
    repository = state.open("trust_after_artifact");
    await assert.rejects(repository.applyOwnerSignedBundle(epoch3), /simulated crash/);
    repository.close();
    repository = state.open();
    assert.deepEqual(await repository.loadTrustBundle(), epoch3);
    repository.close();

    const epoch4 = trustBundle(state.trustRoot, 4, [trustKey("server:a", serverA), trustKey("server:b", serverB)]);
    repository = state.open("trust_after_commit");
    await assert.rejects(repository.applyOwnerSignedBundle(epoch4), /simulated crash/);
    repository.close();
    repository = state.open();
    assert.deepEqual(await repository.loadTrustBundle(), epoch4);
    await repository.applyOwnerSignedBundle(epoch4);
    repository.close();

    const db = new DatabaseSync(state.paths.artifactDatabasePath);
    db.prepare("UPDATE server_trust_key_history SET state='revoked' WHERE tenant_id=? AND node_class=? AND key_id='server:a'")
      .run(binding.tenantId, binding.nodeClass);
    db.close();
    repository = state.open();
    await expectStoreError(repository.loadTrustBundle(), "corrupt");
    repository.close();
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});
