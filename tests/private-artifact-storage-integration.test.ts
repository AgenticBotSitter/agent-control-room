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
});
