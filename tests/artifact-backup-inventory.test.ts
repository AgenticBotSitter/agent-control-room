import assert from "node:assert/strict";
import test from "node:test";
import { artifactBackupInventorySchemaV1, artifactBackupRestoreVerificationSchemaV1,
  createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { objectArtifactStorageNamespaceDigestV1 } from "../src/config/v1/artifact-storage";
import { sha256Digest } from "../src/security";

const entry = (artifactId: string, suffix: string) => ({ artifactId,
  contentHash: sha256Digest(`content:${suffix}`), sizeBytes: suffix.length,
  manifestDigest: sha256Digest(`manifest:${suffix}`), receiptDigest: sha256Digest(`receipt:${suffix}`) });

const header = { tenantId: "tenant:test", releaseId: "release:test", releaseDigest: sha256Digest("release"),
  databaseSchemaVersion: "schema:65", databaseSchemaDigest: sha256Digest("schema"),
  storageNamespace: "artifact-namespace:test", storageNamespaceDigest: sha256Digest("namespace") };

const create = (entries = [entry("artifact:native:b", "second"), entry("artifact:native:a", "first")],
  overrides: Partial<typeof header> = {}) => createArtifactBackupInventoryV1({ ...header, ...overrides, entries });

function rehash(value: unknown) {
  const copy = structuredClone(value) as Record<string, unknown>;
  const { inventoryDigest: _ignored, ...material } = copy;
  return { ...material, inventoryDigest: sha256Digest(material) };
}

test("creates a stable sorted canonical backup inventory without storage or publication authority", () => {
  const inventory = create();
  assert.deepEqual(inventory.entries.map(value => value.artifactId), ["artifact:native:a", "artifact:native:b"]);
  assert.equal(inventory.entryCount, 2);
  assert.deepEqual(create(), inventory);
  for (const flag of ["restoresArtifacts", "deletesArtifacts", "grantsStorageReadAuthority",
    "grantsStorageWriteAuthority", "canonicalPublicationAllowed", "completionVerified",
    "grantsExecutionAuthority", "permitsRetry", "permitsCleanup"] as const) assert.equal(inventory[flag], false);
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory.entries), true);
  assert.equal(Object.isFrozen(inventory.entries[0]), true);
  assert.throws(() => { (inventory.entries as unknown[]).push(entry("artifact:native:c", "third")); }, TypeError);
});

test("refuses duplicate entries, malformed bindings, and oversized artifact claims", () => {
  assert.throws(() => create([entry("artifact:native:a", "one"), entry("artifact:native:a", "two")]), /inventory_unavailable/);
  assert.throws(() => create([{ ...entry("artifact:native:a", "one"), sizeBytes: 65_537 }]), /inventory_unavailable/);
  assert.throws(() => create([], { tenantId: "!bad" }), /inventory_unavailable/);
  assert.throws(() => createArtifactBackupInventoryV1({ ...header, entries: [], unexpected: true } as never), /inventory_unavailable/);
});

test("persisted inventory validation rejects reordered, duplicate, count, digest, and entry tampering", () => {
  const inventory = create();
  const reversed = structuredClone(inventory);
  reversed.entries.reverse();
  const duplicate = structuredClone(inventory);
  duplicate.entries[1] = structuredClone(duplicate.entries[0]!);
  for (const changed of [reversed, duplicate, { ...inventory, entryCount: 1 }]) {
    assert.equal(artifactBackupInventorySchemaV1.safeParse(rehash(changed)).success, false);
  }
  assert.equal(artifactBackupInventorySchemaV1.safeParse({ ...inventory,
    inventoryDigest: sha256Digest("wrong") }).success, false);
});

test("exact restored inventory verifies but missing, extra, or any bound-field change refuses", () => {
  const expected = create();
  const verified = verifyRestoredArtifactBackupInventoryV1({ expected, restored: JSON.parse(JSON.stringify(expected)) });
  assert.equal(verified.exactInventoryMatched, true);
  assert.equal(verified.expectedInventoryDigest, expected.inventoryDigest);
  assert.equal(verified.restoredInventoryDigest, expected.inventoryDigest);
  for (const flag of ["restoresArtifacts", "deletesArtifacts", "grantsStorageReadAuthority",
    "grantsStorageWriteAuthority", "canonicalPublicationAllowed", "completionVerified",
    "grantsExecutionAuthority", "permitsRetry", "permitsCleanup"] as const) assert.equal(verified[flag], false);
  assert.throws(() => verifyRestoredArtifactBackupInventoryV1({ expected, restored: expected,
    unexpected: true } as never), /inventory_unavailable/);

  const variants = [
    create([expected.entries[0]!]),
    create([...expected.entries, entry("artifact:native:c", "third")]),
    create([{ ...expected.entries[0]!, contentHash: sha256Digest("other-content") }, expected.entries[1]!]),
    create([{ ...expected.entries[0]!, sizeBytes: expected.entries[0]!.sizeBytes + 1 }, expected.entries[1]!]),
    create([{ ...expected.entries[0]!, manifestDigest: sha256Digest("other-manifest") }, expected.entries[1]!]),
    create([{ ...expected.entries[0]!, receiptDigest: sha256Digest("other-receipt") }, expected.entries[1]!]),
    create([...expected.entries], { releaseId: "release:other" }),
    create([...expected.entries], { releaseDigest: sha256Digest("other-release") }),
    create([...expected.entries], { databaseSchemaVersion: "schema:other" }),
    create([...expected.entries], { databaseSchemaDigest: sha256Digest("other-schema") }),
    create([...expected.entries], { storageNamespace: "artifact-namespace:other" }),
    create([...expected.entries], { storageNamespaceDigest: sha256Digest("other-namespace") }),
    create([...expected.entries], { tenantId: "tenant:other" }),
  ];
  for (const restored of variants) assert.throws(() =>
    verifyRestoredArtifactBackupInventoryV1({ expected, restored }), /inventory_unavailable/);
});

test("restored verification rejects noncanonical order and duplicates even with a recomputed inventory digest", () => {
  const expected = create();
  const reordered = structuredClone(expected); reordered.entries.reverse();
  const duplicate = structuredClone(expected); duplicate.entries[1] = structuredClone(duplicate.entries[0]!);
  for (const restored of [rehash(reordered), rehash(duplicate)]) assert.throws(() =>
    verifyRestoredArtifactBackupInventoryV1({ expected, restored }), /inventory_unavailable/);
});

const schemaRefuses = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success === false;

test("an object deployment cannot be recorded as backup authority: the storage class is a literal and no store is named", () => {
  // The inventory is the only durable record of which artifact bytes exist, and
  // it is written for the neutral local class only. Nothing in it can name an
  // object store, so a bucket can never be substituted into backup or restore
  // authority, and no field of it could hold task, lock or approval state.
  const inventory = create();
  assert.equal(inventory.storageClass, "local");
  assert.deepEqual(Object.keys(inventory).sort(), Object.keys(artifactBackupInventorySchemaV1.shape).sort());
  // Identifiers are compared word by word, not as substrings: a legitimate key
  // such as `releaseId` or `releaseDigest` must not be mistaken for the blocked
  // concept that happens to sit inside it (`lease`).
  const noForeignAuthority = new Set(["bucket", "endpoint", "region", "credential", "secret",
    "prefix", "task", "lock", "lease", "approval", "claim", "epoch", "fence", "heartbeat"]);
  const keyWords = (key: string) => key.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  const assertNoForeignAuthority = (keys: string[], where: string) => {
    for (const key of keys) {
      for (const word of keyWords(key)) {
        assert.equal(noForeignAuthority.has(word), false, `${where} key ${key} names ${word}`);
      }
    }
  };
  assertNoForeignAuthority(Object.keys(artifactBackupInventorySchemaV1.shape), "inventory");
  assertNoForeignAuthority(Object.keys(artifactBackupRestoreVerificationSchemaV1.shape), "verification");

  // A persisted inventory re-labelled with the object class, or naming a store,
  // is refused outright rather than reinterpreted.
  assert.equal(schemaRefuses(artifactBackupInventorySchemaV1, { ...inventory, storageClass: "s3-compatible" }), true);
  assert.equal(schemaRefuses(artifactBackupInventorySchemaV1, { ...inventory, bucket: "control-room-artifacts" }), true);
  assert.equal(schemaRefuses(artifactBackupInventorySchemaV1, { ...inventory, endpoint: "https://account-id.r2.cloudflarestorage.com" }), true);

  // A digest is not an authority: substituting an object deployment's namespace
  // digest changes no class and buys no store identity.
  const substituted = create(undefined, { storageNamespace: "artifact-namespace:object",
    storageNamespaceDigest: objectArtifactStorageNamespaceDigestV1("artifact-namespace:object",
      "https://account-id.r2.cloudflarestorage.com", "auto", "control-room-artifacts") });
  assert.equal(substituted.storageClass, "local");
  assert.equal(schemaRefuses(artifactBackupInventorySchemaV1, { ...substituted, storageClass: "s3-compatible" }), true);

  // The only per-object evidence an object store hands back is a key and a byte
  // count, and it cannot become an inventory entry: entries are bound to the
  // durable publication digests, which no listing carries.
  const listing = { key: `control-room-artifacts/v1/${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}.artifact`, sizeBytes: 27 };
  assert.throws(() => create([listing] as never), /inventory_unavailable/);
  assert.throws(() => create([{ artifactId: `artifact:result:${"d".repeat(64)}`, sizeBytes: 27 }] as never), /inventory_unavailable/);

  // Restore verification, the only object that can stand for a restored copy,
  // still grants no read, write, execution, retry or cleanup authority.
  const restored = verifyRestoredArtifactBackupInventoryV1({ expected: inventory, restored: structuredClone(inventory) });
  assert.equal(restored.exactInventoryMatched, true);
  assert.deepEqual(Object.keys(restored).sort(), Object.keys(artifactBackupRestoreVerificationSchemaV1.shape).sort());
  for (const flag of ["restoresArtifacts", "deletesArtifacts", "grantsStorageReadAuthority",
    "grantsStorageWriteAuthority", "canonicalPublicationAllowed", "completionVerified",
    "grantsExecutionAuthority", "permitsRetry", "permitsCleanup"] as const) assert.equal(restored[flag], false);
});
