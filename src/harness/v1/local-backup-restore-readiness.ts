import { z } from "zod";
import { artifactBackupInventorySchemaV1, artifactBackupRestoreVerificationSchemaV1,
  verifyRestoredArtifactBackupInventoryV1 } from "../../artifacts/v1/artifact-backup-inventory";
import { sha256Digest } from "../../security/canonical-digest";

/**
 * A sanitized, source-only binding for evidence that an owner has already
 * restored one local installation into a disposable destination.  It neither
 * performs a backup or restore nor opens a database, artifact store, file,
 * service, or credential.
 */
export const LOCAL_BACKUP_RESTORE_READINESS_V1 =
  "control-room.local-backup-restore-readiness/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const databaseRestoreEvidenceSchema = z.object({
  tenantId: id,
  releaseId: id,
  releaseDigest: digest,
  databaseIdentityDigest: digest,
  databaseDumpDigest: digest,
  databaseSchemaVersion: id,
  databaseSchemaDigest: digest,
  restoredToDisposableTarget: z.literal(true),
  promoted: z.literal(false),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsCleanup: z.literal(false),
}).strict();

const materialSchema = z.object({
  schema: z.literal(LOCAL_BACKUP_RESTORE_READINESS_V1),
  planDigest: digest,
  tenantId: id,
  releaseId: id,
  releaseDigest: digest,
  databaseIdentityDigest: digest,
  databaseDumpDigest: digest,
  databaseSchemaVersion: id,
  databaseSchemaDigest: digest,
  storageNamespace: id,
  storageNamespaceDigest: digest,
  artifactInventoryDigest: digest,
  artifactRestoreVerificationDigest: digest,
  artifactEntryCount: z.number().int().nonnegative().max(10_000),
  restoredToDisposableTarget: z.literal(true),
  promoted: z.literal(false),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsCleanup: z.literal(false),
}).strict();

export const localBackupRestoreReadinessSchemaV1 = materialSchema.extend({
  proofDigest: digest,
}).strict().superRefine((value, context) => {
  const { proofDigest, ...material } = value;
  if (proofDigest !== sha256Digest(material)) context.addIssue({ code: "custom", message: "backup restore proof digest mismatch" });
});

export type LocalBackupRestoreReadinessV1 = z.infer<typeof localBackupRestoreReadinessSchemaV1>;

function unavailable(): never { throw new Error("local_backup_restore_readiness_unavailable"); }

function freeze(value: LocalBackupRestoreReadinessV1): LocalBackupRestoreReadinessV1 {
  return Object.freeze({ ...value });
}

/**
 * Verifies only already-captured safe evidence. The artifact verification is
 * recomputed from both inventories so a caller cannot substitute a digest from
 * a different restoration. A resulting proof is suitable only as opaque
 * evidence for the existing installation readiness record.
 */
export function createLocalBackupRestoreReadinessV1(input: unknown): LocalBackupRestoreReadinessV1 {
  try {
    const parsed = z.object({
      planDigest: digest,
      databaseRestore: databaseRestoreEvidenceSchema,
      expectedArtifactInventory: z.unknown(),
      restoredArtifactInventory: z.unknown(),
      artifactRestoreVerification: z.unknown(),
    }).strict().parse(input);
    const expected = artifactBackupInventorySchemaV1.parse(parsed.expectedArtifactInventory);
    const restored = artifactBackupInventorySchemaV1.parse(parsed.restoredArtifactInventory);
    const recomputed = verifyRestoredArtifactBackupInventoryV1({ expected, restored });
    const supplied = artifactBackupRestoreVerificationSchemaV1.parse(parsed.artifactRestoreVerification);
    const database = parsed.databaseRestore;
    if (supplied.verificationDigest !== recomputed.verificationDigest
      || supplied.expectedInventoryDigest !== expected.inventoryDigest
      || supplied.restoredInventoryDigest !== restored.inventoryDigest
      || database.tenantId !== expected.tenantId || database.releaseId !== expected.releaseId
      || database.releaseDigest !== expected.releaseDigest
      || database.databaseSchemaVersion !== expected.databaseSchemaVersion
      || database.databaseSchemaDigest !== expected.databaseSchemaDigest
      || expected.storageClass !== "local") unavailable();
    const material = materialSchema.parse({
      schema: LOCAL_BACKUP_RESTORE_READINESS_V1,
      planDigest: parsed.planDigest,
      tenantId: expected.tenantId,
      releaseId: expected.releaseId,
      releaseDigest: expected.releaseDigest,
      databaseIdentityDigest: database.databaseIdentityDigest,
      databaseDumpDigest: database.databaseDumpDigest,
      databaseSchemaVersion: expected.databaseSchemaVersion,
      databaseSchemaDigest: expected.databaseSchemaDigest,
      storageNamespace: expected.storageNamespace,
      storageNamespaceDigest: expected.storageNamespaceDigest,
      artifactInventoryDigest: expected.inventoryDigest,
      artifactRestoreVerificationDigest: recomputed.verificationDigest,
      artifactEntryCount: expected.entryCount,
      restoredToDisposableTarget: true,
      promoted: false,
      startsWork: false,
      grantsExecutionAuthority: false,
      permitsRetry: false,
      permitsCleanup: false,
    });
    return freeze(localBackupRestoreReadinessSchemaV1.parse({ ...material, proofDigest: sha256Digest(material) }));
  } catch { return unavailable(); }
}

/** Refuses a persisted proof whose opaque evidence binding has changed. */
export function verifyLocalBackupRestoreReadinessV1(input: unknown): LocalBackupRestoreReadinessV1 {
  try { return freeze(localBackupRestoreReadinessSchemaV1.parse(input)); }
  catch { return unavailable(); }
}
