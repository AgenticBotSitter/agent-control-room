import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import type { DatabaseClient } from "../../persistence/database";
import { artifactManifestRecordSchema } from "../../domain/v1";
import { checkedResultBytes, nativeResultReceiptSchema, type NativeResultReadConfiguration,
  type NativeResultConfiguration } from "../../artifacts/v1/native-results";
import { codexResultReceiptSchemaV1 } from "../../artifacts/v1/codex-result-receipt";
import { durableResultReceiptSchemaV1, durableResultReceiptTagV1 } from "../../artifacts/v1/durable-result-receipt";
import { nativeResultReservationSchemaV1 } from "../../artifacts/v1/native-result-reservation";
import { codexResultReservationSchemaV1 } from "../../artifacts/v1/codex-result-reservation";
import { durableResultReservationSchemaV1 } from "../../artifacts/v1/durable-result-publication";
import {
  createArtifactBackupInventoryV1,
  type ArtifactBackupInventoryV1,
} from "../../artifacts/v1/artifact-backup-inventory";
import {
  PersistentLocalArtifactStorageV1,
  type PersistentLocalArtifactStorageConfigurationV1,
} from "../../artifacts/v1/persistent-local-storage";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../../node-executor/artifact-storage";
import type { NeutralReservationPort } from "../../artifacts/v1/neutral-reservation-port";
import { ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1, artifactStorageNamespaceDigestV1,
  captureArtifactStorageSettingsV1 } from "../../config/v1/artifact-storage";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";
import { hmacSha256Tag, sha256Digest } from "../../security";

const inventoryHeaderSchema = z.object({
  releaseId: localId,
  releaseDigest: digestSchema,
  databaseSchemaVersion: localId,
  databaseSchemaDigest: digestSchema,
  storageNamespace: localId,
  storageNamespaceDigest: digestSchema,
}).strict();

const receiptSchema = z.discriminatedUnion("schema", [nativeResultReceiptSchema, codexResultReceiptSchemaV1,
  durableResultReceiptSchemaV1]);

type InventoryRow = {
  tenant_id: string | null;
  project_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  run_id: string | null;
  artifact_id: string | null;
  receipt: unknown | null;
  receipt_auth_tag: string | null;
  manifest: unknown | null;
  reservation: unknown | null;
  reservation_auth_tag: string | null;
};

export type PrivateArtifactStorageConfigurationV1 = Readonly<{
  local: PersistentLocalArtifactStorageConfigurationV1;
  inventory: z.infer<typeof inventoryHeaderSchema>;
}>;

export type PrivateArtifactStorageV1 = Readonly<{
  storage: ArtifactStoragePortV1 & ArtifactReadPortV1;
  captureInventory(database: Pick<DatabaseClient, "query">, tenantId: string,
    integrityKey: Uint8Array, signal?: AbortSignal,
    reservations?: NeutralReservationPort): Promise<ArtifactBackupInventoryV1>;
}>;

export type OpenPrivateArtifactStorageV1 = (
  configuration: PersistentLocalArtifactStorageConfigurationV1,
) => Promise<ArtifactStoragePortV1 & ArtifactReadPortV1>;

type ArtifactConsumers = {
  web: { tasks?: { results?: NativeResultReadConfiguration; [key: string]: unknown }; [key: string]: unknown };
  quality?: { results: NativeResultReadConfiguration; [key: string]: unknown };
  evidence?: { storage: NativeResultConfiguration; [key: string]: unknown };
  [key: string]: unknown;
};

function unavailable(): never { throw new Error("private_artifact_storage_unavailable"); }

/**
 * Binds a public namespace identity to one trusted canonical operator path without returning that path.
 *
 * The derivation is owned by the operator-configuration module so one rule
 * governs both the operator file and this startup boundary; the original name
 * is retained for existing callers.
 */
export const privateArtifactStorageNamespaceDigestV1 = artifactStorageNamespaceDigestV1;

export function capturePrivateArtifactStorageConfigurationV1(
  input: PrivateArtifactStorageConfigurationV1,
): PrivateArtifactStorageConfigurationV1 {
  try {
    if (!input || typeof input !== "object" || !input.local || typeof input.local !== "object") return unavailable();
    const inventory = Object.freeze(inventoryHeaderSchema.parse(input.inventory));
    // Delegate the byte-store bounds and the one explicit persistent directory
    // to the operator-configuration owner. A non-canonical root or a total
    // below one file is refused here instead of surfacing later as an opaque
    // storage error at first write.
    const captured = captureArtifactStorageSettingsV1({
      schema: ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1,
      storageClass: "local",
      storageNamespace: inventory.storageNamespace,
      rootPath: input.local.rootPath,
      maximumArtifacts: input.local.maximumArtifacts,
      maximumFileBytes: input.local.maximumFileBytes,
      maximumTotalBytes: input.local.maximumTotalBytes,
      operationTimeoutMs: input.local.operationTimeoutMs,
    });
    const local = Object.freeze({
      rootPath: captured.rootPath,
      maximumArtifacts: captured.maximumArtifacts,
      maximumFileBytes: captured.maximumFileBytes,
      maximumTotalBytes: captured.maximumTotalBytes,
      operationTimeoutMs: captured.operationTimeoutMs,
    });
    if (inventory.storageNamespaceDigest !== privateArtifactStorageNamespaceDigestV1(
      inventory.storageNamespace, local.rootPath)) return unavailable();
    return Object.freeze({ local, inventory });
  } catch { return unavailable(); }
}

/** Replaces every composed result byte port with one exact server-owned adapter. */
export function bindPrivateArtifactStorageV1<T extends ArtifactConsumers>(
  input: T,
  storage: ArtifactStoragePortV1 & ArtifactReadPortV1,
): T {
  if (!input.quality || !input.evidence || !input.web.tasks?.results
    || typeof storage?.put !== "function" || typeof storage.read !== "function") return unavailable();
  const result = {
    ...input,
    web: { ...input.web, tasks: { ...input.web.tasks, results: {
      ...input.web.tasks.results, storageClass: "local" as const, storage } } },
    quality: { ...input.quality, results: { ...input.quality.results, storageClass: "local" as const, storage } },
    evidence: { ...input.evidence, storage: { ...input.evidence.storage, storageClass: "local" as const, storage } },
  };
  return result as T;
}

type InventoryReservation = { identity: { tenantId: string; projectId: string; jobId: string; attemptId: string;
  runId: string; artifactId: string; contentHash: string; sizeBytes: number };
  state: string; manifestDigest: string | null; receiptDigest: string | null };
type InventoryReservationTag = "native-result-write-reservation/v1" | "durable-result-write-reservation/v1";

function reservation(value: unknown): { reserved: InventoryReservation; tagPurpose: InventoryReservationTag } {
  const native = nativeResultReservationSchemaV1.safeParse(value);
  if (native.success) return { reserved: native.data, tagPurpose: "native-result-write-reservation/v1" };
  const codex = codexResultReservationSchemaV1.safeParse(value);
  if (codex.success) return { reserved: codex.data, tagPurpose: "native-result-write-reservation/v1" };
  const durable = durableResultReservationSchemaV1.safeParse(value);
  if (durable.success) return { reserved: durable.data, tagPurpose: "durable-result-write-reservation/v1" };
  return unavailable();
}

/**
 * Opens one already-existing private local store and exposes only opaque byte ports plus
 * a bounded metadata inventory. It creates no directory, repairs no file and performs no cleanup.
 */
export async function openPrivateArtifactStorageV1(
  input: PrivateArtifactStorageConfigurationV1,
  openStorage: OpenPrivateArtifactStorageV1 = configuration => PersistentLocalArtifactStorageV1.create(configuration),
): Promise<PrivateArtifactStorageV1> {
  const configuration = capturePrivateArtifactStorageConfigurationV1(input);
  if (typeof openStorage !== "function") return unavailable();
  const raw = await openStorage(configuration.local);
  if (!raw || typeof raw.put !== "function" || typeof raw.read !== "function") return unavailable();
  // Keep one exact object behind every bound reader and writer.
  const storage = Object.freeze({ put: raw.put.bind(raw), read: raw.read.bind(raw) });
  return Object.freeze({ storage, async captureInventory(database, tenantId, integrityKey, signal, reservations) {
    localId.parse(tenantId);
    if (!database || typeof database.query !== "function" || !(integrityKey instanceof Uint8Array)
      || integrityKey.length !== 32 || signal?.aborted) return unavailable();
    const key = Uint8Array.from(integrityKey);
    const rows = (await database.query<InventoryRow>(`SELECT
      COALESCE(r.tenant_id,m.tenant_id,v.tenant_id) AS tenant_id,
      COALESCE(r.project_id,m.project_id,v.project_id) AS project_id,
      COALESCE(r.job_id,m.job_id,v.job_id) AS job_id,
      COALESCE(r.attempt_id,m.attempt_id,v.attempt_id) AS attempt_id,
      COALESCE(r.run_id,v.run_id) AS run_id,
      COALESCE(r.artifact_id,m.id,v.artifact_id) AS artifact_id,
      r.receipt,r.auth_tag AS receipt_auth_tag,m.payload AS manifest,
      v.reservation,v.auth_tag AS reservation_auth_tag
      FROM control_native_artifact_receipts r
      FULL OUTER JOIN control_artifact_manifests m
        ON m.tenant_id=r.tenant_id AND m.id=r.artifact_id
      FULL OUTER JOIN control_native_result_write_reservations v
        ON v.tenant_id=COALESCE(r.tenant_id,m.tenant_id)
       AND v.artifact_id=COALESCE(r.artifact_id,m.id)
      WHERE COALESCE(r.tenant_id,m.tenant_id,v.tenant_id)=$1
      ORDER BY COALESCE(r.artifact_id,m.id,v.artifact_id) COLLATE "C"
      LIMIT 10001`, [tenantId])).rows;
    if (signal?.aborted || rows.length > 10_000) return unavailable();
    const entries = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (signal?.aborted || !row.receipt || !row.receipt_auth_tag || !row.manifest) return unavailable();
      const parsedReceipt = receiptSchema.safeParse(row.receipt);
      if (!parsedReceipt.success) return unavailable();
      const receipt = parsedReceipt.data;
      // Neutral reservations live behind the injected reservation boundary,
      // not the native table, so the SQL join yields no reservation columns
      // for them. Consult the boundary port when supplied and verify the
      // returned row with the exact same checks below. Without the port the
      // reader still fails closed; production server composition passes the
      // lead-owned PostgreSQL adapter once it lands after #63.
      let reservationValue = row.reservation, reservationAuthTag = row.reservation_auth_tag;
      if (reservationValue == null || reservationAuthTag == null) {
        if (!reservations || typeof reservations.findForUpdate !== "function") return unavailable();
        const portRow = await reservations.findForUpdate(database, tenantId, receipt.runId);
        if (!portRow || portRow.tenant_id !== tenantId || portRow.run_id !== receipt.runId
          || portRow.artifact_id !== receipt.artifactId) return unavailable();
        reservationValue = portRow.reservation; reservationAuthTag = portRow.auth_tag;
      }
      if (typeof reservationAuthTag !== "string") return unavailable();
      const manifest = artifactManifestRecordSchema.parse(row.manifest);
      const { reserved, tagPurpose } = reservation(reservationValue);
      const identity = reserved.identity;
      const receiptTag = receipt.schema === "control-room.durable-result-receipt/v1"
        ? durableResultReceiptTagV1(key, receipt)
        : hmacSha256Tag(key, { purpose: receipt.schema === "control-room.codex-result-receipt/v1"
          ? "codex-result-receipt/v1" : "native-result-receipt/v1", receipt });
      const reservationTag = hmacSha256Tag(key, { purpose: tagPurpose, reservation: reserved });
      const equalTag = (expected: string, actual: string) => {
        const left = Buffer.from(expected), right = Buffer.from(actual);
        return left.length === right.length && timingSafeEqual(left, right);
      };
      if (reserved.state !== "metadata_committed" || row.tenant_id !== tenantId || receipt.tenantId !== tenantId
        || !equalTag(receiptTag, row.receipt_auth_tag) || !equalTag(reservationTag, reservationAuthTag)
        || row.project_id !== receipt.projectId || row.job_id !== receipt.jobId
        || row.attempt_id !== receipt.attemptId || row.run_id !== receipt.runId
        || row.artifact_id !== receipt.artifactId || seen.has(receipt.artifactId)
        || identity.tenantId !== receipt.tenantId || identity.projectId !== receipt.projectId
        || identity.jobId !== receipt.jobId || identity.attemptId !== receipt.attemptId
        || identity.runId !== receipt.runId || identity.artifactId !== receipt.artifactId
        || identity.contentHash !== receipt.contentHash || identity.sizeBytes !== receipt.sizeBytes
        || reserved.manifestDigest !== receipt.manifestDigest || reserved.receiptDigest !== sha256Digest(receipt)
        || manifest.tenantId !== receipt.tenantId || manifest.projectId !== receipt.projectId
        || manifest.jobId !== receipt.jobId || manifest.attemptId !== receipt.attemptId
        || manifest.id !== receipt.artifactId || manifest.contentHash !== receipt.contentHash
        || manifest.sizeBytes !== receipt.sizeBytes || manifest.storageClass !== "local" || manifest.state !== "uploaded"
        || sha256Digest(manifest) !== receipt.manifestDigest) return unavailable();
      const bytes = await storage.read(receipt.artifactId, signal);
      if (!bytes) return unavailable();
      checkedResultBytes(bytes, receipt);
      seen.add(receipt.artifactId);
      entries.push({ artifactId: receipt.artifactId, contentHash: receipt.contentHash,
        sizeBytes: receipt.sizeBytes, manifestDigest: receipt.manifestDigest,
        receiptDigest: sha256Digest(receipt) });
    }
    if (signal?.aborted) return unavailable();
    return createArtifactBackupInventoryV1({ tenantId, ...configuration.inventory, entries });
  } });
}
