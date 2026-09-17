import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMAIN_CONTRACT_VERSION, artifactManifestRecordSchema } from "../src/domain/v1";
import { commitNativeResultReservationMetadataV1, reserveNativeResultWriteV1,
  verifyNativeResultReservationBytesV1 } from "../src/artifacts/v1/native-result-reservation";
import { nativeResultId, resultBytesHash } from "../src/artifacts/v1/native-results";
import { bindPrivateArtifactStorageV1, openPrivateArtifactStorageV1, privateArtifactStorageNamespaceDigestV1,
  type PrivateArtifactStorageConfigurationV1 } from "../src/web/v1/private-artifact-storage";
import { ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1, artifactStorageNamespaceDigestV1,
  captureArtifactStorageConfigurationV1, captureArtifactStorageSettingsV1,
  captureS3CompatibleArtifactStorageConfigurationV1, captureS3CompatibleArtifactStorageSettingsV1,
  captureS3CompatibleEndpointV1,
  exportArtifactStorageSettingsV1, exportS3CompatibleArtifactStorageSettingsV1,
  objectArtifactStorageNamespaceDigestV1 } from "../src/config/v1/artifact-storage";
import { openS3CompatibleArtifactStorageV1, S3CompatibleClientErrorV1,
  S3_COMPATIBLE_KEY_ROOT_V1, S3_COMPATIBLE_RESULT_CONTENT_TYPE_V1, S3_COMPATIBLE_STORAGE_CLASS_V1,
  type S3CompatibleArtifactStorageConfigurationV1, type S3CompatibleArtifactStorageV1,
  type S3CompatibleClientPortV1, type S3CompatibleObjectListingV1, type S3CompatibleObjectMetadataV1,
  type S3CompatibleObjectReadV1, type S3CompatibleArtifactScopeV1 } from "../src/artifacts/v1/s3-compatible-storage";
import type { DatabaseClient } from "../src/persistence/database";
import { hmacSha256Tag, sha256Digest } from "../src/security";

const bytes = new TextEncoder().encode("Persistent composed result.");
const tenantId = "tenant:storage-test";
const runId = "run:storage-test";
const integrityKey = new Uint8Array(32).fill(7);

const inventoryBase = {
  releaseId: "release:test", releaseDigest: sha256Digest("release"),
  databaseSchemaVersion: "schema:71", databaseSchemaDigest: sha256Digest("schema"),
  storageNamespace: "artifact-namespace:test",
};

function configuration(rootPath: string): PrivateArtifactStorageConfigurationV1 {
  return { local: { rootPath, maximumArtifacts: 20, maximumFileBytes: 65_536,
    maximumTotalBytes: 1_000_000, operationTimeoutMs: 2_000 }, inventory: { ...inventoryBase,
      storageNamespaceDigest: privateArtifactStorageNamespaceDigestV1(inventoryBase.storageNamespace, rootPath) } };
}

function snapshot() {
  return { runId, projectId: "project:test", jobId: "job:test", attemptId: "attempt:test",
    leaseId: "lease:test", leaseEpoch: 1, bindingDigest: sha256Digest("binding"),
    sessionKeyDigest: sha256Digest("session"), nativeRunKeyDigest: sha256Digest("native-run"),
    snapshotVersion: 1, observedAt: "2026-09-13T12:00:00.000Z",
    upstreamUpdatedAt: "2026-09-13T11:59:59.000Z", state: "completed" as const,
    availability: "current" as const, lastActivity: "message_progress" as const,
    stopAttempted: false, safeReason: "none" as const,
    result: { contentHash: resultBytesHash(bytes), sizeBytes: bytes.byteLength }, usage: null };
}

async function savedRow(storage: Awaited<ReturnType<typeof openPrivateArtifactStorageV1>>) {
  const artifactId = nativeResultId(tenantId, runId);
  const stored = await storage.storage.put({ artifactId, bytes });
  const manifest = artifactManifestRecordSchema.parse({ contractVersion: DOMAIN_CONTRACT_VERSION,
    id: artifactId, tenantId, projectId: "project:test", workflowId: "workflow:test", jobId: "job:test",
    attemptId: "attempt:test", kind: "artifact_manifest", state: "uploaded", version: 0,
    createdAt: "2026-09-13T12:00:01.000Z", updatedAt: "2026-09-13T12:00:01.000Z",
    contentHash: resultBytesHash(bytes), sizeBytes: bytes.byteLength, mimeType: "text/plain; charset=utf-8",
    logicalRole: "task_result", schemaVersion: "1.0.0", producerId: "node:test", storageClass: "local",
    opaqueLocator: stored.opaqueLocator, retentionClass: "private_task_result" });
  const receipt = { schema: "control-room.native-result-receipt/v1", artifactId, tenantId,
    projectId: "project:test", jobId: "job:test", attemptId: "attempt:test", runId, nodeId: "node:test",
    snapshotDigest: sha256Digest(snapshot()), snapshotVersion: 1, contentHash: resultBytesHash(bytes),
    sizeBytes: bytes.byteLength, manifestDigest: sha256Digest(manifest), receivedAt: "2026-09-13T12:00:01.000Z",
    byteCheck: "matched_recorded_claim", qualityAccepted: false };
  const reserved = reserveNativeResultWriteV1({ tenantId, nodeId: "node:test", snapshot: snapshot() });
  const verified = verifyNativeResultReservationBytesV1(reserved, bytes);
  const reservation = commitNativeResultReservationMetadataV1({ reservation: verified,
    manifestDigest: sha256Digest(manifest), receiptDigest: sha256Digest(receipt) });
  return { tenant_id: tenantId, project_id: "project:test", job_id: "job:test", attempt_id: "attempt:test",
    run_id: runId, artifact_id: artifactId, receipt,
    receipt_auth_tag: hmacSha256Tag(integrityKey, { purpose: "native-result-receipt/v1", receipt }),
    manifest, reservation, reservation_auth_tag: hmacSha256Tag(integrityKey,
      { purpose: "native-result-write-reservation/v1", reservation }) };
}

const database = (rows: unknown[]): Pick<DatabaseClient, "query"> => ({
  query: async <T>() => ({ rows: rows as T[] }),
});

test("one exact adapter is bound across web, quality, evidence and server inventory", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-composed-artifacts-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  let opens = 0;
  const opened = await openPrivateArtifactStorageV1(configuration(root), async config => {
    opens += 1;
    return (await import("../src/artifacts/v1/persistent-local-storage")).PersistentLocalArtifactStorageV1.create(config);
  });
  const old = { put: async () => { throw new Error("old writer used"); }, read: async () => undefined };
  const bound = bindPrivateArtifactStorageV1({
    web: { tasks: { results: { integrityKey: new Uint8Array(32), storageClass: "local", storage: old } } },
    quality: { results: { integrityKey: new Uint8Array(32), storageClass: "local", storage: old } },
    evidence: { storage: { integrityKey: new Uint8Array(32), storageClass: "local", storage: old } },
  }, opened.storage);
  assert.equal(opens, 1);
  assert.strictEqual(bound.web.tasks!.results!.storage, opened.storage);
  assert.strictEqual(bound.quality!.results.storage, opened.storage);
  assert.strictEqual(bound.evidence!.storage.storage, opened.storage);

  const row = await savedRow(opened);
  const captured = await opened.captureInventory(database([row]), tenantId, integrityKey);
  assert.deepEqual(captured.entries, [{ artifactId: row.artifact_id, contentHash: resultBytesHash(bytes),
    sizeBytes: bytes.byteLength, manifestDigest: sha256Digest(row.manifest), receiptDigest: sha256Digest(row.receipt) }]);
  assert.equal(captured.entryCount, 1);
  assert.equal(captured.storageNamespace, inventoryBase.storageNamespace);
  assert.equal(captured.restoresArtifacts, false);
  assert.equal(captured.completionVerified, false);
});

test("missing, duplicated and wrong database bindings fail before readiness", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-composed-refusal-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = await openPrivateArtifactStorageV1(configuration(root));
  const row = await savedRow(opened);
  await assert.rejects(opened.captureInventory(database([{ ...row, reservation: null }]), tenantId, integrityKey),
    /private_artifact_storage_unavailable/);
  await assert.rejects(opened.captureInventory(database([row, row]), tenantId, integrityKey),
    /private_artifact_storage_unavailable/);
  await assert.rejects(opened.captureInventory(database([{ ...row, project_id: "project:wrong" }]), tenantId, integrityKey),
    /private_artifact_storage_unavailable/);
  await assert.rejects(opened.captureInventory(database([{ ...row,
    receipt_auth_tag: hmacSha256Tag(integrityKey, { purpose: "native-result-receipt/v1", receipt: { ...row.receipt,
      contentHash: sha256Digest("tampered") } }) }]), tenantId, integrityKey), /private_artifact_storage_unavailable/);

  const { nodeId: _nodeId, ...incompleteNative } = row.receipt;
  await assert.rejects(opened.captureInventory(database([{ ...row, receipt: incompleteNative,
    receipt_auth_tag: hmacSha256Tag(integrityKey,
      { purpose: "native-result-receipt/v1", receipt: incompleteNative }) }]), tenantId, integrityKey),
  /private_artifact_storage_unavailable/);

  const incompleteCodex = { ...row.receipt, schema: "control-room.codex-result-receipt/v1" };
  await assert.rejects(opened.captureInventory(database([{ ...row, receipt: incompleteCodex,
    receipt_auth_tag: hmacSha256Tag(integrityKey,
      { purpose: "codex-result-receipt/v1", receipt: incompleteCodex }) }]), tenantId, integrityKey),
  /private_artifact_storage_unavailable/);
});

test("operator settings resolve one explicit persistent directory and derive the namespace digest", () => {
  const rootPath = "/synthetic/operator-result-storage";
  const settings = { schema: ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1, storageClass: "local",
    storageNamespace: "artifact-namespace:operator", rootPath, maximumArtifacts: 20,
    maximumFileBytes: 65_536, maximumTotalBytes: 1_000_000, operationTimeoutMs: 2_000 };
  const release = { releaseId: "release:test", releaseDigest: sha256Digest("release"),
    databaseSchemaVersion: "schema:71", databaseSchemaDigest: sha256Digest("schema") };

  const captured = captureArtifactStorageConfigurationV1(settings, release);
  assert.equal(captured.local.rootPath, rootPath);
  assert.equal(captured.inventory.storageNamespaceDigest,
    artifactStorageNamespaceDigestV1("artifact-namespace:operator", rootPath));
  assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.local) && Object.isFrozen(captured.inventory));

  // The digest is always derived, never carried in: a stale or forged digest
  // cannot bind this namespace to a different directory.
  const moved = captureArtifactStorageConfigurationV1({ ...settings, rootPath: `${rootPath}-other` }, release);
  assert.notEqual(moved.inventory.storageNamespaceDigest, captured.inventory.storageNamespaceDigest);

  // Supplying a digest is an unknown key and is refused outright.
  assert.throws(() => captureArtifactStorageConfigurationV1(
    { ...settings, storageNamespaceDigest: captured.inventory.storageNamespaceDigest }, release),
  /artifact_storage_settings_invalid/);
});

test("operator settings refuse unsupported storage, uncanonical roots and unusable bounds", () => {
  const rootPath = "/synthetic/operator-refusals";
  const base = { schema: ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1, storageClass: "local",
    storageNamespace: "artifact-namespace:operator", rootPath, maximumArtifacts: 20,
    maximumFileBytes: 65_536, maximumTotalBytes: 1_000_000, operationTimeoutMs: 2_000 };
  const refuses = (patch: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => captureArtifactStorageSettingsV1({ ...base, ...patch }), pattern);

  // A provider brand is not a storage class. The neutral `s3-compatible`
  // class is now advertised by its own capture; `r2` stays refused by name and
  // an object document is refused by the local capture rather than parsed as
  // one. See the object-storage suite below.
  refuses({ storageClass: "r2" }, /artifact_storage_r2_unsupported/);
  refuses({ storageClass: "s3" }, /artifact_storage_class_unsupported/);
  refuses({ storageClass: S3_COMPATIBLE_STORAGE_CLASS_V1 }, /artifact_storage_object_configuration_required/);

  // One explicit persistent directory: relative, traversing, trailing-separator
  // and duplicated-separator forms are refused rather than repaired, so the
  // recorded intent and the opened directory can never differ.
  for (const bad of ["relative/path", "/synthetic/../etc", "/synthetic/trailing/", "/synthetic//double", "."]) {
    refuses({ rootPath: bad }, /artifact_storage_root_(invalid|not_canonical)/);
  }
  refuses({ rootPath: "/" }, /artifact_storage_root_not_owned/);
  refuses({ rootPath: "/synthetic/nul\0byte" }, /artifact_storage_root_invalid/);
  refuses({ rootPath: "" }, /artifact_storage_settings_invalid|artifact_storage_root_invalid/);

  // A total below one file accepts a store that can never hold a single
  // result; refuse at capture rather than at the first write.
  refuses({ maximumTotalBytes: 100, maximumFileBytes: 65_536 }, /artifact_storage_total_below_file/);

  // The bounded result ceiling and operation deadline are contract limits.
  refuses({ maximumFileBytes: 65_537 }, /artifact_storage_settings_invalid/);
  refuses({ operationTimeoutMs: 2_001 }, /artifact_storage_settings_invalid/);
  refuses({ maximumArtifacts: 0 }, /artifact_storage_settings_invalid/);

  // Equal total and file size is the smallest usable store and is accepted.
  assert.equal(captureArtifactStorageSettingsV1(
    { ...base, maximumFileBytes: 1_024, maximumTotalBytes: 1_024 }).maximumTotalBytes, 1_024);
});

test("the portable export carries the namespace identity and never the private directory", () => {
  const rootPath = "/synthetic/operator-export";
  const exported = JSON.parse(exportArtifactStorageSettingsV1({
    schema: ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1, storageClass: "local",
    storageNamespace: "artifact-namespace:operator", rootPath, maximumArtifacts: 20,
    maximumFileBytes: 65_536, maximumTotalBytes: 1_000_000, operationTimeoutMs: 2_000 }));
  assert.equal(exported.storageNamespaceDigest,
    artifactStorageNamespaceDigestV1("artifact-namespace:operator", rootPath));
  assert.ok(!("rootPath" in exported));
  assert.ok(!JSON.stringify(exported).includes("/synthetic"));
});

test("the startup boundary applies the same operator contract to its captured configuration", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-storage-contract-")));
  try {
    // A canonical absolute root still opens exactly as before.
    const opened = await openPrivateArtifactStorageV1(configuration(root));
    assert.equal(typeof opened.storage.put, "function");

    // The tightened contract now refuses at the startup boundary what would
    // otherwise surface later as an opaque storage error at first write.
    const uncanonical = `${root}/`;
    await assert.rejects(openPrivateArtifactStorageV1(configuration(uncanonical)),
      /private_artifact_storage_unavailable/);
    await assert.rejects(openPrivateArtifactStorageV1({ ...configuration(root),
      local: { ...configuration(root).local, maximumTotalBytes: 10, maximumFileBytes: 65_536 } }),
    /private_artifact_storage_unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a whole drive, share or host root is refused in either platform's spelling", () => {
  const base = { schema: ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1, storageClass: "local",
    storageNamespace: "artifact-namespace:roots", maximumArtifacts: 20,
    maximumFileBytes: 65_536, maximumTotalBytes: 1_000_000, operationTimeoutMs: 2_000 };

  // Both parsers run on every host, so these refusals reproduce from a Linux
  // server, a macOS contributor machine and a Windows contributor machine
  // alike. A root is a whole drive, share or host: the store would claim
  // everything beneath it.
  for (const root of ["/", "C:\\", "c:\\", "D:/", "\\\\server\\share\\", "\\\\server\\share"]) {
    assert.throws(() => captureArtifactStorageSettingsV1({ ...base, rootPath: root }),
      /artifact_storage_root_not_owned/, `expected ${JSON.stringify(root)} to be refused as a filesystem root`);
  }

  // A dedicated directory beneath a root is accepted. Only the host's own
  // spelling can satisfy the absolute-and-canonical check, so assert the
  // form this platform actually uses rather than pretending both pass here.
  const dedicated = process.platform === "win32" ? "C:\\control-room\\artifacts" : "/var/lib/control-room/artifacts";
  assert.equal(captureArtifactStorageSettingsV1({ ...base, rootPath: dedicated }).rootPath, dedicated);

  // The foreign spelling is still refused, but as a non-canonical path rather
  // than as a root — the reason stays accurate on each platform.
  const foreign = process.platform === "win32" ? "/var/lib/control-room/artifacts" : "C:\\control-room\\artifacts";
  assert.throws(() => captureArtifactStorageSettingsV1({ ...base, rootPath: foreign }),
    /artifact_storage_root_not_canonical/);
});

// --- provider-neutral object storage -----------------------------------------
//
// Every test below runs against a disposable in-memory fake transport. No
// bucket exists, no credential is read, no network call happens and nothing is
// uploaded, listed or deleted anywhere: the adapter's only effect is the bytes
// it hands to the injected client.

interface Deferred { readonly promise: Promise<void>; readonly resolve: () => void }

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => { resolve = () => settle(); });
  return { promise, resolve };
}

function aborted(): Error {
  const error = new Error("artifact_storage_aborted");
  error.name = "AbortError";
  return error;
}

interface FakeObject { bucket: string; key: string; body: Uint8Array; contentType: string; contentHash: string }

/**
 * A create-once store that answers exactly about the key it was given, plus the
 * failure modes the adapter has to survive: a reply that is lost after the
 * write landed, a reply about a different key, a foreign listing entry and a
 * write held open past the caller's deadline.
 */
class FakeS3Client implements S3CompatibleClientPortV1 {
  readonly objects = new Map<string, FakeObject>();
  readonly keysSeen: string[] = [];
  readonly bucketsSeen: string[] = [];
  putCalls = 0;
  putAttempted = false;
  hideFirstHead = false;
  losePutReply = false;
  renameReply = false;
  listing: "clean" | "foreign" | "duplicate" | "oversized" = "clean";
  putGate: Deferred | undefined;
  private hiddenHeads = 0;

  private metadataOf(object: FakeObject): S3CompatibleObjectMetadataV1 {
    return {
      bucket: object.bucket, key: this.renameReply ? `${object.key}.other` : object.key,
      // The store answers with the metadata it recorded when the object was
      // written, never a digest recomputed from whatever the bytes say now.
      contentHash: object.contentHash, sizeBytes: object.body.byteLength,
      contentType: object.contentType,
    };
  }

  async putObject(input: { readonly bucket: string; readonly key: string; readonly body: Uint8Array;
    readonly contentType: string; readonly signal?: AbortSignal }): Promise<S3CompatibleObjectMetadataV1> {
    this.putCalls += 1;
    this.putAttempted = true;
    this.keysSeen.push(input.key);
    this.bucketsSeen.push(input.bucket);
    const gate = this.putGate;
    if (gate) {
      await new Promise<void>((settle, fail) => {
        const onAbort = () => fail(aborted());
        input.signal?.addEventListener("abort", onAbort, { once: true });
        void gate.promise.then(() => { input.signal?.removeEventListener("abort", onAbort); settle(); }, fail);
      });
    }
    if (this.objects.has(input.key)) throw new S3CompatibleClientErrorV1("object_exists");
    const stored: FakeObject = { bucket: input.bucket, key: input.key,
      body: Uint8Array.from(input.body), contentType: input.contentType, contentHash: resultBytesHash(input.body) };
    this.objects.set(input.key, stored);
    if (this.losePutReply) throw new S3CompatibleClientErrorV1("unavailable");
    return this.metadataOf(stored);
  }

  async headObject(input: { readonly bucket: string; readonly key: string;
    readonly signal?: AbortSignal }): Promise<S3CompatibleObjectMetadataV1 | undefined> {
    this.keysSeen.push(input.key);
    if (this.hideFirstHead && this.hiddenHeads === 0) { this.hiddenHeads = 1; return undefined; }
    const object = this.objects.get(input.key);
    return object ? this.metadataOf(object) : undefined;
  }

  async getObject(input: { readonly bucket: string; readonly key: string;
    readonly signal?: AbortSignal }): Promise<S3CompatibleObjectReadV1 | undefined> {
    this.keysSeen.push(input.key);
    const object = this.objects.get(input.key);
    return object ? { ...this.metadataOf(object), body: Uint8Array.from(object.body) } : undefined;
  }

  async listObjects(input: { readonly bucket: string; readonly prefix: string;
    readonly signal?: AbortSignal }): Promise<readonly S3CompatibleObjectListingV1[]> {
    const own: S3CompatibleObjectListingV1[] = [];
    for (const object of this.objects.values()) {
      if (object.key.startsWith(input.prefix)) own.push({ key: object.key, sizeBytes: object.body.byteLength });
    }
    if (this.listing === "foreign") {
      return [...own, { key: `${S3_COMPATIBLE_KEY_ROOT_V1}/foreign/entry.artifact`, sizeBytes: 1 }];
    }
    if (this.listing === "duplicate") return [...own, ...own];
    if (this.listing === "oversized") {
      return [...own, { key: `${input.prefix}/${"a".repeat(64)}.artifact`, sizeBytes: 65_537 }];
    }
    return own;
  }
}

const objectScope: S3CompatibleArtifactScopeV1 = Object.freeze({
  tenantId: "tenant:object-test", projectId: "project:test", jobId: "job:test",
  attemptId: "attempt:test", runId: "run:object-test",
});

// A canonical private account origin. The bucket name appears nowhere in an
// export and the fake never dials it, so this is a deployment identity only.
const objectOrigin = "https://account-id.r2.cloudflarestorage.com";
const objectBucket = "control-room-artifacts";

const objectSettings = {
  schema: ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1, storageClass: S3_COMPATIBLE_STORAGE_CLASS_V1,
  storageNamespace: "artifact-namespace:object", endpoint: objectOrigin, region: "auto",
  bucket: objectBucket, contentType: S3_COMPATIBLE_RESULT_CONTENT_TYPE_V1, maximumArtifacts: 20,
  maximumFileBytes: 65_536, maximumTotalBytes: 1_000_000, operationTimeoutMs: 2_000,
};

function objectConfiguration(
  overrides: Partial<S3CompatibleArtifactStorageConfigurationV1> = {},
): S3CompatibleArtifactStorageConfigurationV1 {
  return {
    endpoint: objectOrigin, region: "auto", bucket: objectBucket,
    storageNamespace: "artifact-namespace:object",
    contentType: S3_COMPATIBLE_RESULT_CONTENT_TYPE_V1, maximumArtifacts: 20, maximumFileBytes: 65_536,
    maximumTotalBytes: 1_000_000, operationTimeoutMs: 2_000, ...overrides,
  };
}

function objectStorage(
  client: S3CompatibleClientPortV1,
  overrides: Partial<S3CompatibleArtifactStorageConfigurationV1> = {},
  scope: S3CompatibleArtifactScopeV1 = objectScope,
): S3CompatibleArtifactStorageV1 {
  return openS3CompatibleArtifactStorageV1({ client, configuration: objectConfiguration(overrides), scope });
}

const objectId = `artifact:result:${sha256Digest("object-artifact").slice("sha256:".length)}`;
const otherObjectId = `artifact:result:${sha256Digest("object-artifact-two").slice("sha256:".length)}`;
const objectKeyPattern = /^control-room-artifacts\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\.artifact$/u;

test("object storage round-trips exact bytes and binds the exact project/task/run identity", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client);
  const stored = await storage.put({ artifactId: objectId, bytes });

  assert.equal(stored.artifactId, objectId);
  assert.equal(stored.contentHash, resultBytesHash(bytes));
  assert.equal(stored.sizeBytes, bytes.byteLength);
  assert.match(stored.opaqueLocator, /^control-room-artifact:s3:v1:[a-f0-9]{64}$/u);

  const readBack = await storage.read(objectId);
  assert.ok(readBack);
  assert.deepEqual(new Uint8Array(readBack), bytes);
  assert.equal(await storage.read(otherObjectId), undefined);

  const head = await storage.head(objectId);
  assert.ok(head);
  assert.deepEqual(head, {
    artifactId: objectId, scopeDigest: storage.boundScopeDigest, contentHash: resultBytesHash(bytes),
    sizeBytes: bytes.byteLength, contentType: S3_COMPATIBLE_RESULT_CONTENT_TYPE_V1,
    opaqueLocator: stored.opaqueLocator,
  });
  // A caller receives identity and integrity, never a location it could re-point.
  for (const hidden of ["bucket", "key", "endpoint", "url", "region", "prefix"]) {
    assert.ok(!(hidden in head), `${hidden} must not be published in head metadata`);
  }
  assert.equal(await storage.head(otherObjectId), undefined);
  assert.deepEqual(await storage.inventory(), { count: 1, totalBytes: bytes.byteLength });

  // Every store call is made for this adapter's own key space on the configured
  // bucket: object storage holds artifact bytes and nothing else.
  assert.ok(client.keysSeen.length >= 3);
  for (const key of client.keysSeen) {
    assert.match(key, objectKeyPattern, `unexpected store key ${key}`);
  }
  assert.deepEqual([...new Set(client.bucketsSeen)], [objectBucket]);
});

test("object keys derive from the captured deployment and the bound scope, never from a caller", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client);
  await storage.put({ artifactId: objectId, bytes });
  const firstKey = [...client.objects.keys()][0] as string;

  // A different deployment is a different key space even for the same artifact
  // and the same scope: two stores can never collide on one key.
  const movedBucket = objectStorage(client, { bucket: "other-artifacts" });
  assert.notEqual(movedBucket.namespaceDigest, storage.namespaceDigest);
  assert.equal(movedBucket.namespaceDigest,
    objectArtifactStorageNamespaceDigestV1("artifact-namespace:object", objectOrigin, "auto", "other-artifacts"));
  assert.equal(await movedBucket.head(objectId), undefined);

  const movedOrigin = objectStorage(client, { endpoint: "https://other-account.r2.cloudflarestorage.com" });
  assert.notEqual(movedOrigin.namespaceDigest, storage.namespaceDigest);
  assert.equal(await movedOrigin.head(objectId), undefined);

  // A different exact project/task/run scope is a different key space too, so
  // one run can never read another run's artifact.
  const otherScope = objectStorage(client, {}, { ...objectScope, attemptId: "attempt:other" });
  assert.notEqual(otherScope.boundScopeDigest, storage.boundScopeDigest);
  assert.equal(await otherScope.read(objectId), undefined);
  assert.equal(await otherScope.head(objectId), undefined);
  assert.equal(await otherScope.inventory().then((value) => value.count), 0);

  // The key is a digest of the artifact identity under those two segments.
  assert.match(firstKey, objectKeyPattern);
  assert.notEqual(otherScope.namespaceDigest, movedBucket.namespaceDigest);

  // Declaring another scope on a write is refused rather than silently rebound.
  await assert.rejects(storage.put({ artifactId: otherObjectId, bytes, scope: { ...objectScope, runId: "run:other" } }),
    /storage_invalid/);
});

test("duplicate writes replay one object under one locator instead of writing again", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client);
  const stored = await storage.put({ artifactId: objectId, bytes });
  assert.equal(client.putCalls, 1);

  const replayed = await storage.put({ artifactId: objectId, bytes });
  assert.deepEqual(replayed, stored);
  assert.equal(client.putCalls, 1, "an identical artifact must not be written twice");
  assert.equal(client.objects.size, 1);

  // Concurrent identical writes settle on one object as well: the queue makes
  // the second writer see the first writer's object.
  const [left, right] = await Promise.all([
    storage.put({ artifactId: otherObjectId, bytes }),
    storage.put({ artifactId: otherObjectId, bytes }),
  ]);
  assert.deepEqual(left, right);
  assert.equal(client.putCalls, 2);
  assert.equal(client.objects.size, 2);

  // A writer that lost the create-once race is settled by reading the winner
  // back: the store refuses the second write and no byte is overwritten.
  client.hideFirstHead = true;
  const afterRace = await storage.put({ artifactId: otherObjectId, bytes });
  assert.deepEqual(afterRace, left);
  assert.equal(client.putCalls, 3, "the losing writer must have attempted exactly one write");
  assert.equal(client.objects.size, 2);
  assert.deepEqual(new Uint8Array((await storage.read(otherObjectId)) as Uint8Array), bytes);
});

test("an existing object with different content is a conflict that is never overwritten", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client);
  const stored = await storage.put({ artifactId: objectId, bytes });
  const key = [...client.objects.keys()][0] as string;
  const original = client.objects.get(key) as FakeObject;

  await assert.rejects(storage.put({ artifactId: objectId, bytes: new TextEncoder().encode("Different result.") }),
    /storage_conflict/);
  assert.equal(client.putCalls, 1);
  assert.deepEqual(client.objects.get(key), original);
  assert.equal((await storage.head(objectId))?.opaqueLocator, stored.opaqueLocator);

  // A claim the bytes contradict is refused before any store call, and it does
  // not poison the instance: the contradiction is definite, the store never ran.
  await assert.rejects(storage.put({ artifactId: otherObjectId, bytes, contentHash: sha256Digest("other") }),
    /storage_conflict/);
  await assert.rejects(storage.put({ artifactId: otherObjectId, bytes, sizeBytes: bytes.byteLength + 1 }),
    /storage_conflict/);
  assert.equal(client.putCalls, 1);
  assert.equal(await storage.inventory().then((value) => value.count), 1);
});

test("a lost write reply fails closed, poisons the instance, and reconciles on restart", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client);
  client.losePutReply = true;

  await assert.rejects(storage.put({ artifactId: objectId, bytes }), /storage_ambiguous/);
  assert.equal(client.putCalls, 1);
  assert.equal(client.objects.size, 1, "the write may have landed; nothing may delete or retry it");

  // The instance is poisoned: no later operation on it may report a result, and
  // the ambiguous artifact may not be read as if the write had been acknowledged.
  await assert.rejects(storage.put({ artifactId: objectId, bytes }), /storage_ambiguous/);
  await assert.rejects(storage.read(objectId), /storage_ambiguous/);
  await assert.rejects(storage.head(objectId), /storage_ambiguous/);
  await assert.rejects(storage.inventory(), /storage_ambiguous/);
  assert.equal(client.putCalls, 1);

  // Restart reconciliation: a fresh adapter reads the key, sees byte-identical
  // content and replays one object with no further write and no deletion.
  client.losePutReply = false;
  const restarted = objectStorage(client);
  const replayed = await restarted.put({ artifactId: objectId, bytes });
  assert.equal(client.putCalls, 1, "restart reconciliation must not write again");
  assert.equal(client.objects.size, 1);
  assert.match(replayed.opaqueLocator, /^control-room-artifact:s3:v1:[a-f0-9]{64}$/u);
  assert.deepEqual(new Uint8Array((await restarted.read(objectId)) as Uint8Array), bytes);
});

test("a store reply about another key is refused as ambiguous rather than accepted", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client);
  await storage.put({ artifactId: objectId, bytes });

  client.renameReply = true;
  await assert.rejects(storage.put({ artifactId: otherObjectId, bytes }), /storage_ambiguous/);
  await assert.rejects(storage.head(objectId), /storage_ambiguous/);

  // The store wrote the object and only then described another key, which is
  // exactly the ambiguous case: the adapter refused the reply and recorded
  // nothing, so a fresh adapter reconciles against what the store really holds
  // — the exact bytes, bound to the identity that was submitted — while the
  // instance that saw the renamed reply stays poisoned.
  client.renameReply = false;
  const fresh = objectStorage(client);
  assert.ok(await fresh.head(objectId));
  const reconciled = await fresh.head(otherObjectId);
  assert.equal(reconciled?.artifactId, otherObjectId);
  assert.equal(reconciled?.contentHash, resultBytesHash(bytes));
  assert.deepEqual(await fresh.read(otherObjectId), bytes);
  await assert.rejects(storage.head(objectId), /storage_ambiguous/);
});

test("oversized, malformed and credential-bearing results are refused before any store call", async () => {
  const client = new FakeS3Client();
  const bounded = objectStorage(client, { maximumFileBytes: 64, maximumTotalBytes: 64 });

  const oversized = new TextEncoder().encode("x".repeat(65));
  await assert.rejects(bounded.put({ artifactId: objectId, bytes: oversized }), /storage_capacity/);
  // Invalid UTF-8 is not private result bytes, whatever it claims.
  await assert.rejects(bounded.put({ artifactId: objectId, bytes: new Uint8Array([0xff, 0xfe]) }), /storage_invalid/);
  // Result text carrying credential material is refused, never uploaded.
  await assert.rejects(bounded.put({ artifactId: objectId,
    bytes: new TextEncoder().encode(`token: AKIA${"A".repeat(16)}`) }), /storage_invalid/);

  const storage = objectStorage(client);
  await assert.rejects(storage.put({ artifactId: "artifact:result:not-a-digest", bytes }), /storage_invalid/);
  await assert.rejects(storage.put({ artifactId: "artifact:native:judge", bytes }), /storage_invalid/);
  await assert.rejects(storage.put({ artifactId: objectId, bytes, contentType: "application/octet-stream" }),
    /storage_invalid/);
  await assert.rejects(storage.put({ artifactId: objectId, bytes, contentHash: "sha256:not-a-digest" }), /storage_invalid/);
  await assert.rejects(storage.put({ artifactId: objectId, bytes: "persistent result" as unknown as Uint8Array }),
    /storage_invalid/);
  assert.equal(client.putCalls, 0);

  // Zero-length bytes are valid under the shared result contract — the local
  // adapter accepts them and `checkedResultBytes` accepts them — so the object
  // adapter must not invent a stricter rule of its own. The empty result is
  // written and bound like any other artifact rather than silently vanishing.
  const emptyClient = new FakeS3Client();
  const emptyStored = await objectStorage(emptyClient).put({ artifactId: objectId, bytes: new Uint8Array(0) });
  assert.equal(emptyStored.sizeBytes, 0);
  assert.equal(emptyStored.contentHash, resultBytesHash(new Uint8Array(0)));
  assert.equal(emptyClient.putCalls, 1);
});

test("capacity bounds refuse the next artifact without touching the store", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client, { maximumArtifacts: 1 });
  await storage.put({ artifactId: objectId, bytes });
  assert.equal(client.putCalls, 1);

  await assert.rejects(storage.put({ artifactId: otherObjectId, bytes }), /storage_capacity/);
  assert.equal(client.putCalls, 1, "a refused write must not reach the store");

  const totalClient = new FakeS3Client();
  const bounded = objectStorage(totalClient, { maximumFileBytes: 64, maximumTotalBytes: 64 });
  const half = new Uint8Array(40).fill(0x61);
  await bounded.put({ artifactId: objectId, bytes: half });
  await assert.rejects(bounded.put({ artifactId: otherObjectId, bytes: half }), /storage_capacity/);
  assert.equal(totalClient.putCalls, 1);
});

test("a listing naming a foreign, repeated or oversized key is refused as ambiguous", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client);
  await storage.put({ artifactId: objectId, bytes });
  assert.deepEqual(await storage.inventory(), { count: 1, totalBytes: bytes.byteLength });

  for (const listing of ["foreign", "duplicate", "oversized"] as const) {
    const brokenClient = new FakeS3Client();
    const broken = objectStorage(brokenClient);
    await broken.put({ artifactId: objectId, bytes });
    brokenClient.listing = listing;
    await assert.rejects(broken.inventory(), /storage_ambiguous/, `a ${listing} listing must be refused`);
    await assert.rejects(broken.put({ artifactId: otherObjectId, bytes }), /storage_ambiguous/);
  }
});

test("changed content fails safely on read and leaves the recorded metadata standing", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client);
  const stored = await storage.put({ artifactId: objectId, bytes });
  const key = [...client.objects.keys()][0] as string;
  const original = client.objects.get(key) as FakeObject;
  client.objects.set(key, { ...original, body: new TextEncoder().encode("Tampered result bytes.") });

  await assert.rejects(storage.read(objectId), /storage_ambiguous/);
  await assert.rejects(storage.head(objectId), /storage_ambiguous/);
  assert.deepEqual(client.objects.get(key)?.body, new TextEncoder().encode("Tampered result bytes."));

  // A fresh adapter reports the tampered object as ambiguous too, and never
  // repairs, rewrites or deletes it.
  const fresh = objectStorage(client);
  await assert.rejects(fresh.read(objectId), /storage_ambiguous/);
  assert.equal(client.putCalls, 1);
  assert.equal(stored.contentHash, resultBytesHash(bytes));
});

test("an operation deadline fails closed instead of reporting an unfinished write", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client, { operationTimeoutMs: 25 });
  client.putGate = deferred();

  await assert.rejects(storage.put({ artifactId: objectId, bytes }), /storage_ambiguous/);
  assert.equal(client.putAttempted, true);
  assert.equal(client.objects.size, 0);
  await assert.rejects(storage.read(objectId), /storage_ambiguous/);
});

test("an abort before the write is an abort, and an abort after it starts fails closed", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client);

  const early = new AbortController();
  early.abort();
  await assert.rejects(storage.put({ artifactId: objectId, bytes, signal: early.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(client.putCalls, 0, "an aborted write must never reach the store");

  const late = new AbortController();
  client.putGate = deferred();
  const attempt = storage.put({ artifactId: objectId, bytes, signal: late.signal })
    .then(() => "stored", (error: unknown) => String(error));
  while (!client.putAttempted) await new Promise((resolve) => setTimeout(resolve, 1));
  late.abort();
  assert.match(await attempt, /storage_ambiguous/);
  assert.equal(client.objects.size, 0);
  await assert.rejects(storage.put({ artifactId: otherObjectId, bytes }), /storage_ambiguous/);
  client.putGate = undefined;
});

test("object settings refuse public, insecure, credentialed and uncanonical deployments", () => {
  const refuses = (patch: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => captureS3CompatibleArtifactStorageSettingsV1({ ...objectSettings, ...patch }), pattern);

  // An anonymous public object host is readable by anyone holding the URL, so
  // it is not a Control Room private store.
  refuses({ endpoint: "https://pub-0f1e2d3c4b5a.r2.dev" }, /artifact_storage_endpoint_public/);
  refuses({ endpoint: "https://control-room-artifacts.s3-website-us-east-1.amazonaws.com" },
    /artifact_storage_endpoint_public/);
  // Plain HTTP, and an origin carrying credentials, are refused by name.
  refuses({ endpoint: "http://account-id.r2.cloudflarestorage.com" }, /artifact_storage_endpoint_insecure/);
  // The whole-document credential scan runs before every shape rule, so a
  // credentialed origin is reported as credential material at settings capture;
  // the endpoint rule itself is owned by the endpoint capture, which is checked
  // directly below for the deployment path that never sees a whole document.
  refuses({ endpoint: "https://key:secret@account-id.r2.cloudflarestorage.com" },
    /artifact_storage_credential_material_refused/);
  assert.throws(() => captureS3CompatibleEndpointV1("https://key:secret@account-id.r2.cloudflarestorage.com"),
    /artifact_storage_endpoint_credentials/);
  // A non-canonical spelling is refused rather than repaired: the captured
  // identity and the origin the client dials must not be able to differ.
  for (const bad of [
    "https://account-id.r2.cloudflarestorage.com/",
    "https://ACCOUNT-ID.r2.cloudflarestorage.com",
    "https://account-id.r2.cloudflarestorage.com/api",
    "https://account-id.r2.cloudflarestorage.com?region=auto",
    "https://account-id.r2.cloudflarestorage.com#fragment",
    "account-id.r2.cloudflarestorage.com",
  ]) {
    refuses({ endpoint: bad }, /artifact_storage_endpoint_(not_canonical|invalid)/);
  }
  refuses({ bucket: "Control_Room" }, /artifact_storage_bucket_invalid/);
  refuses({ bucket: "192.0.2.10" }, /artifact_storage_bucket_invalid/);
  refuses({ bucket: "ab" }, /artifact_storage_bucket_invalid/);
  refuses({ contentType: "application/octet-stream" }, /artifact_storage_content_type_unsupported/);
  refuses({ maximumTotalBytes: 100 }, /artifact_storage_total_below_file/);
  refuses({ storageClass: "r2" }, /artifact_storage_r2_unsupported/);
  refuses({ storageClass: "s3" }, /artifact_storage_class_unsupported/);
  refuses({ storageClass: "local" }, /artifact_storage_local_configuration_required/);
  // Credential material is refused wherever an operator puts it, by name.
  refuses({ secretAccessKey: `AKIA${"A".repeat(16)}` }, /artifact_storage_credential_material_refused/);
  refuses({ region: `Bearer ${"z".repeat(24)}` }, /artifact_storage_credential_material_refused/);

  const captured = captureS3CompatibleArtifactStorageSettingsV1(objectSettings);
  assert.equal(captured.endpoint, objectOrigin);
  assert.equal(captured.bucket, objectBucket);
  assert.ok(Object.isFrozen(captured));

  const configuration = captureS3CompatibleArtifactStorageConfigurationV1(captured, {
    releaseId: "release:test", releaseDigest: sha256Digest("release"),
    databaseSchemaVersion: "schema:71", databaseSchemaDigest: sha256Digest("schema"),
  });
  assert.equal(configuration.object.endpoint, objectOrigin);
  assert.equal(configuration.object.maximumFileBytes, 65_536);
  assert.equal(configuration.inventory.storageNamespaceDigest,
    objectArtifactStorageNamespaceDigestV1("artifact-namespace:object", objectOrigin, "auto", objectBucket));
  assert.ok(Object.isFrozen(configuration) && Object.isFrozen(configuration.object)
    && Object.isFrozen(configuration.inventory));

  // The two captures refuse each other's documents by name, so a local document
  // and an object document can never be bound as the same deployment.
  assert.throws(() => captureArtifactStorageSettingsV1(objectSettings),
    /artifact_storage_object_configuration_required/);
  assert.throws(() => captureS3CompatibleArtifactStorageSettingsV1({ ...objectSettings, storageClass: "local" }),
    /artifact_storage_local_configuration_required/);

  // The adapter binds the same policy: a deployment refused as a document is
  // refused as a configuration, and a smuggled credential field cannot pass.
  assert.throws(() => objectStorage(new FakeS3Client(), { endpoint: "https://pub-0f1e2d3c4b5a.r2.dev" }),
    /artifact_storage_endpoint_public/);
  assert.throws(() => objectStorage(new FakeS3Client(), { endpoint: "http://account-id.r2.cloudflarestorage.com" }),
    /artifact_storage_endpoint_insecure/);
  assert.throws(() => objectStorage(new FakeS3Client(), { bucket: "192.0.2.10" }),
    /artifact_storage_bucket_invalid/);
  assert.throws(() => openS3CompatibleArtifactStorageV1({ client: new FakeS3Client(), scope: objectScope,
    configuration: { ...objectConfiguration(), secretAccessKey: `AKIA${"A".repeat(16)}` } as
      unknown as S3CompatibleArtifactStorageConfigurationV1 }), /storage_invalid/);
  assert.throws(() => objectStorage(new FakeS3Client(), {}, { ...objectScope, runId: "run with spaces" }),
    /storage_invalid/);
});

test("the portable object export carries identity and bounds, never the deployment", () => {
  const exported = JSON.parse(exportS3CompatibleArtifactStorageSettingsV1(objectSettings)) as Record<string, unknown>;
  assert.equal(exported.schema, ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1);
  assert.equal(exported.storageClass, S3_COMPATIBLE_STORAGE_CLASS_V1);
  assert.equal(exported.storageNamespace, "artifact-namespace:object");
  assert.equal(exported.storageNamespaceDigest,
    objectArtifactStorageNamespaceDigestV1("artifact-namespace:object", objectOrigin, "auto", objectBucket));
  assert.equal(exported.maximumFileBytes, 65_536);

  const document = JSON.stringify(exported);
  // The origin and the bucket are deployment data: the digest travels instead.
  for (const deploymentField of ["endpoint", "bucket", "region"]) {
    assert.ok(!(deploymentField in exported), `${deploymentField} must not be exported`);
  }
  assert.ok(!document.includes("cloudflarestorage"));
  assert.ok(!document.includes(objectBucket));

  // An export carrying credential material is refused, not redacted.
  assert.throws(() => exportS3CompatibleArtifactStorageSettingsV1({ ...objectSettings,
    sessionCookie: `Bearer ${"z".repeat(24)}` }), /artifact_storage_credential_material_refused/);
});

test("the object store owns no task, lock, approval or completion state", async () => {
  const client = new FakeS3Client();
  const storage = objectStorage(client);
  await storage.put({ artifactId: objectId, bytes });

  // The whole surface is artifact bytes in and artifact bytes out. Nothing on
  // it could claim, lock, lease, approve, complete, retry, cancel or delete.
  const prototype = Object.getPrototypeOf(storage) as Record<string, unknown>;
  const surface = Object.getOwnPropertyNames(prototype);
  for (const expected of ["put", "read", "head", "inventory"]) {
    assert.equal(typeof prototype[expected], "function", `${expected} must be on the surface`);
  }
  for (const forbidden of ["task", "claim", "lock", "lease", "fence", "epoch", "heartbeat",
    "approve", "approval", "complete", "completion", "retry", "cancel", "delete", "remove", "renew"]) {
    assert.equal(prototype[forbidden], undefined, `${forbidden} must not be callable on the store`);
    assert.ok(!surface.some((name) => name.toLowerCase().includes(forbidden)),
      `no store operation may concern ${forbidden}`);
    assert.equal((storage as unknown as Record<string, unknown>)[forbidden], undefined);
  }
  for (const field of Object.keys(storage)) {
    assert.ok(!/task|claim|lock|lease|approval|completion|fence|epoch|heartbeat/i.test(field),
      `the store must hold no ${field} state`);
  }

  // Nothing the store hands back carries coordination state either.
  const metadata = JSON.stringify({ head: await storage.head(objectId), inventory: await storage.inventory() });
  for (const forbidden of ["task", "lock", "lease", "approval", "completion", "epoch", "fence", "claim"]) {
    assert.ok(!metadata.includes(forbidden), `${forbidden} must not travel in object-storage metadata`);
  }
  assert.deepEqual(Object.keys(await storage.head(objectId) as object).sort(),
    ["artifactId", "contentHash", "contentType", "opaqueLocator", "scopeDigest", "sizeBytes"]);
  assert.deepEqual(Object.keys(await storage.inventory()).sort(), ["count", "totalBytes"]);
});
