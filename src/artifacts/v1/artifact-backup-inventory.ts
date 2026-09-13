import { z } from "zod";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";
import { sha256Digest } from "../../security";

export const ARTIFACT_BACKUP_INVENTORY_SCHEMA_V1 =
  "control-room.artifact-backup-inventory/v1" as const;

const MAXIMUM_BACKUP_ENTRIES = 10_000;
const MAXIMUM_INVENTORY_BYTES = 16 * 1_024 * 1_024;

export const artifactBackupInventoryEntrySchemaV1 = z.object({
  artifactId: localId,
  contentHash: digestSchema,
  sizeBytes: z.number().int().nonnegative().max(65_536),
  manifestDigest: digestSchema,
  receiptDigest: digestSchema,
}).strict();

const inventoryMaterialSchemaV1 = z.object({
  schema: z.literal(ARTIFACT_BACKUP_INVENTORY_SCHEMA_V1),
  tenantId: localId,
  releaseId: localId,
  releaseDigest: digestSchema,
  databaseSchemaVersion: localId,
  databaseSchemaDigest: digestSchema,
  storageClass: z.literal("local"),
  storageNamespace: localId,
  storageNamespaceDigest: digestSchema,
  entryCount: z.number().int().nonnegative().max(MAXIMUM_BACKUP_ENTRIES),
  entries: z.array(artifactBackupInventoryEntrySchemaV1).max(MAXIMUM_BACKUP_ENTRIES),
  restoresArtifacts: z.literal(false),
  deletesArtifacts: z.literal(false),
  grantsStorageReadAuthority: z.literal(false),
  grantsStorageWriteAuthority: z.literal(false),
  canonicalPublicationAllowed: z.literal(false),
  completionVerified: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsCleanup: z.literal(false),
}).strict();

export const artifactBackupInventorySchemaV1 = inventoryMaterialSchemaV1.extend({
  inventoryDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { inventoryDigest, ...material } = value;
  if (value.entryCount !== value.entries.length || inventoryDigest !== sha256Digest(material)) {
    context.addIssue({ code: "custom", message: "artifact backup inventory digest or count mismatch" });
  }
  for (let index = 1; index < value.entries.length; index += 1) {
    const prior = value.entries[index - 1]!, current = value.entries[index]!;
    if (prior.artifactId >= current.artifactId) {
      context.addIssue({ code: "custom", message: "artifact backup entries must be strictly sorted and unique" });
      break;
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAXIMUM_INVENTORY_BYTES) {
    context.addIssue({ code: "custom", message: "artifact backup inventory oversized" });
  }
});

export type ArtifactBackupInventoryV1 = z.infer<typeof artifactBackupInventorySchemaV1>;
export type ArtifactBackupInventoryEntryV1 = z.infer<typeof artifactBackupInventoryEntrySchemaV1>;

function unavailable(): never { throw new Error("artifact_backup_inventory_unavailable"); }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** Canonical metadata inventory only. It reads, copies, restores, or deletes no artifact bytes. */
export function createArtifactBackupInventoryV1(input: {
  tenantId: string;
  releaseId: string;
  releaseDigest: string;
  databaseSchemaVersion: string;
  databaseSchemaDigest: string;
  storageNamespace: string;
  storageNamespaceDigest: string;
  entries: readonly unknown[];
}): ArtifactBackupInventoryV1 {
  try {
    const parsed = z.object({ tenantId: localId, releaseId: localId, releaseDigest: digestSchema,
      databaseSchemaVersion: localId, databaseSchemaDigest: digestSchema,
      storageNamespace: localId, storageNamespaceDigest: digestSchema,
      entries: z.array(artifactBackupInventoryEntrySchemaV1).max(MAXIMUM_BACKUP_ENTRIES) }).strict().parse(input);
    const entries = parsed.entries.sort((left, right) =>
      left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0);
    if (new Set(entries.map(entry => entry.artifactId)).size !== entries.length) return unavailable();
    const material = inventoryMaterialSchemaV1.parse({
      schema: ARTIFACT_BACKUP_INVENTORY_SCHEMA_V1,
      tenantId: parsed.tenantId, releaseId: parsed.releaseId, releaseDigest: parsed.releaseDigest,
      databaseSchemaVersion: parsed.databaseSchemaVersion, databaseSchemaDigest: parsed.databaseSchemaDigest,
      storageNamespace: parsed.storageNamespace, storageNamespaceDigest: parsed.storageNamespaceDigest,
      storageClass: "local",
      entryCount: entries.length,
      entries,
      restoresArtifacts: false,
      deletesArtifacts: false,
      grantsStorageReadAuthority: false,
      grantsStorageWriteAuthority: false,
      canonicalPublicationAllowed: false,
      completionVerified: false,
      grantsExecutionAuthority: false,
      permitsRetry: false,
      permitsCleanup: false,
    });
    return deepFreeze(artifactBackupInventorySchemaV1.parse({
      ...material, inventoryDigest: sha256Digest(material),
    }));
  } catch { return unavailable(); }
}

const restoreVerificationMaterialSchemaV1 = z.object({
  schema: z.literal("control-room.artifact-backup-restore-verification/v1"),
  tenantId: localId,
  releaseId: localId,
  databaseSchemaVersion: localId,
  storageNamespace: localId,
  expectedInventoryDigest: digestSchema,
  restoredInventoryDigest: digestSchema,
  entryCount: z.number().int().nonnegative().max(MAXIMUM_BACKUP_ENTRIES),
  exactInventoryMatched: z.literal(true),
  restoresArtifacts: z.literal(false),
  deletesArtifacts: z.literal(false),
  grantsStorageReadAuthority: z.literal(false),
  grantsStorageWriteAuthority: z.literal(false),
  canonicalPublicationAllowed: z.literal(false),
  completionVerified: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsCleanup: z.literal(false),
}).strict();

export const artifactBackupRestoreVerificationSchemaV1 = restoreVerificationMaterialSchemaV1.extend({
  verificationDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { verificationDigest, ...material } = value;
  if (value.expectedInventoryDigest !== value.restoredInventoryDigest
    || verificationDigest !== sha256Digest(material)) {
    context.addIssue({ code: "custom", message: "artifact backup restore verification mismatch" });
  }
});

export type ArtifactBackupRestoreVerificationV1 =
  z.infer<typeof artifactBackupRestoreVerificationSchemaV1>;

/** Compares two already captured inventories. It performs no restore, read, retry, or cleanup. */
export function verifyRestoredArtifactBackupInventoryV1(input: {
  expected: unknown;
  restored: unknown;
}): ArtifactBackupRestoreVerificationV1 {
  try {
    const parsedInput = z.object({ expected: z.unknown(), restored: z.unknown() }).strict().parse(input);
    const expected = artifactBackupInventorySchemaV1.parse(parsedInput.expected);
    const restored = artifactBackupInventorySchemaV1.parse(parsedInput.restored);
    if (expected.inventoryDigest !== restored.inventoryDigest
      || sha256Digest(expected) !== sha256Digest(restored)) return unavailable();
    const material = restoreVerificationMaterialSchemaV1.parse({
      schema: "control-room.artifact-backup-restore-verification/v1",
      tenantId: expected.tenantId,
      releaseId: expected.releaseId,
      databaseSchemaVersion: expected.databaseSchemaVersion,
      storageNamespace: expected.storageNamespace,
      expectedInventoryDigest: expected.inventoryDigest,
      restoredInventoryDigest: restored.inventoryDigest,
      entryCount: expected.entryCount,
      exactInventoryMatched: true,
      restoresArtifacts: false,
      deletesArtifacts: false,
      grantsStorageReadAuthority: false,
      grantsStorageWriteAuthority: false,
      canonicalPublicationAllowed: false,
      completionVerified: false,
      grantsExecutionAuthority: false,
      permitsRetry: false,
      permitsCleanup: false,
    });
    return deepFreeze(artifactBackupRestoreVerificationSchemaV1.parse({
      ...material, verificationDigest: sha256Digest(material),
    }));
  } catch { return unavailable(); }
}
