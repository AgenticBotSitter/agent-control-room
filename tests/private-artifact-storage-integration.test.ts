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
  exportArtifactStorageSettingsV1 } from "../src/config/v1/artifact-storage";
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

  // Object storage stays unadvertised until a separately tested adapter exists.
  refuses({ storageClass: "r2" }, /artifact_storage_r2_unsupported/);
  refuses({ storageClass: "s3" }, /artifact_storage_class_unsupported/);

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
