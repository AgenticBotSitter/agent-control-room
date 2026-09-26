import { z } from "zod";
import { artifactBackupInventorySchemaV1, artifactBackupRestoreVerificationSchemaV1 } from "../../artifacts/v1/artifact-backup-inventory";
import { sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTransitionV1 } from "./installation-transition";
import { digestSchema, localId } from "./native-run-identifiers";

/**
 * A source-only cutover preparation record. It binds evidence already produced
 * by an owner-run maintenance procedure; it never opens either database,
 * reads a checkpoint, handles backup bytes, or fences or starts a service.
 */
export const DATABASE_RELOCATION_PREPARATION_V1 =
  "control-room.database-relocation-preparation/v1" as const;

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const state = z.enum(["preflight", "ready", "failed"]);
const action = z.enum(["mark_ready", "fail"]);

export type DatabaseRelocationPreparationStateV1 = z.infer<typeof state>;
export type DatabaseRelocationPreparationV1 = Readonly<{
  schema: typeof DATABASE_RELOCATION_PREPARATION_V1;
  relocationId: string;
  tenantId: string;
  sourceAuthorityDigest: string;
  targetAuthorityDigest: string;
  /** The same scheduler authority remains bound through the cutover plan. */
  schedulerAuthorityDigest: string;
  releaseDigest: string;
  databaseSchemaDigest: string;
  restrictedRoleProofDigest: string;
  artifactInventoryDigest: string;
  artifactRestoreVerificationDigest: string;
  externalRollbackCheckpointDigest: string;
  installationTransitionDigest: string;
  drainEvidenceDigest: string;
  revision: number;
  state: DatabaseRelocationPreparationStateV1;
  failureDigest?: string;
  updatedAt: string;
  performsBackup: false;
  performsRestore: false;
  readsExternalCheckpoint: false;
  writesExternalCheckpoint: false;
  startsOrFencesServices: false;
  configuresAuthority: false;
  activatesController: false;
  preparationDigest: string;
}>;

const materialSchema = z.object({
  schema: z.literal(DATABASE_RELOCATION_PREPARATION_V1),
  relocationId: localId,
  tenantId: localId,
  sourceAuthorityDigest: digestSchema,
  targetAuthorityDigest: digestSchema,
  schedulerAuthorityDigest: digestSchema,
  releaseDigest: digestSchema,
  databaseSchemaDigest: digestSchema,
  restrictedRoleProofDigest: digestSchema,
  artifactInventoryDigest: digestSchema,
  artifactRestoreVerificationDigest: digestSchema,
  externalRollbackCheckpointDigest: digestSchema,
  installationTransitionDigest: digestSchema,
  drainEvidenceDigest: digestSchema,
  revision: z.number().int().min(0),
  state,
  failureDigest: digestSchema.optional(),
  updatedAt: instant,
  performsBackup: z.literal(false),
  performsRestore: z.literal(false),
  readsExternalCheckpoint: z.literal(false),
  writesExternalCheckpoint: z.literal(false),
  startsOrFencesServices: z.literal(false),
  configuresAuthority: z.literal(false),
  activatesController: z.literal(false),
}).strict();

export const databaseRelocationPreparationSchemaV1 = materialSchema.extend({
  preparationDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { preparationDigest, ...material } = value;
  if (preparationDigest !== sha256Digest(material)
    || (value.state === "failed" ? value.failureDigest === undefined : value.failureDigest !== undefined)) {
    context.addIssue({ code: "custom", message: "database relocation preparation digest or state mismatch" });
  }
});

function unavailable(): never { throw new Error("database_relocation_preparation_unavailable"); }

function freeze(value: Omit<DatabaseRelocationPreparationV1, "preparationDigest">): DatabaseRelocationPreparationV1 {
  const material = materialSchema.parse(value);
  return Object.freeze(databaseRelocationPreparationSchemaV1.parse({ ...material, preparationDigest: sha256Digest(material) }));
}

/** Validates supplied evidence only; it does not contact either authority or checkpoint store. */
export function createDatabaseRelocationPreparationV1(input: unknown): DatabaseRelocationPreparationV1 {
  try {
    const parsed = z.object({
      relocationId: localId,
      tenantId: localId,
      sourceAuthorityDigest: digestSchema,
      targetAuthorityDigest: digestSchema,
      schedulerAuthorityDigest: digestSchema,
      sourceReleaseDigest: digestSchema,
      targetReleaseDigest: digestSchema,
      sourceDatabaseSchemaDigest: digestSchema,
      targetDatabaseSchemaDigest: digestSchema,
      sourceRestrictedRoleProofDigest: digestSchema,
      targetRestrictedRoleProofDigest: digestSchema,
      verifiedArtifactInventory: z.unknown(),
      artifactRestoreVerification: z.unknown(),
      externalRollbackCheckpointDigest: digestSchema,
      installationTransition: z.unknown(),
      now: instant,
    }).strict().parse(input);
    if (parsed.sourceAuthorityDigest === parsed.targetAuthorityDigest
      || parsed.sourceReleaseDigest !== parsed.targetReleaseDigest
      || parsed.sourceDatabaseSchemaDigest !== parsed.targetDatabaseSchemaDigest
      || parsed.sourceRestrictedRoleProofDigest !== parsed.targetRestrictedRoleProofDigest) unavailable();
    const inventory = artifactBackupInventorySchemaV1.parse(parsed.verifiedArtifactInventory);
    const restoration = artifactBackupRestoreVerificationSchemaV1.parse(parsed.artifactRestoreVerification);
    const transition = verifyInstallationTransitionV1(parsed.installationTransition);
    if (inventory.tenantId !== parsed.tenantId
      || inventory.releaseDigest !== parsed.sourceReleaseDigest
      || inventory.databaseSchemaDigest !== parsed.sourceDatabaseSchemaDigest
      || restoration.expectedInventoryDigest !== inventory.inventoryDigest
      || restoration.restoredInventoryDigest !== inventory.inventoryDigest
      || restoration.tenantId !== inventory.tenantId
      || restoration.releaseId !== inventory.releaseId
      || restoration.databaseSchemaVersion !== inventory.databaseSchemaVersion
      || transition.state !== "drained" || transition.evidenceDigest === undefined
      || transition.drainStatus !== "all_drained"
      || transition.databaseAuthorityDigest !== parsed.sourceAuthorityDigest
      || transition.schedulerAuthorityDigest !== parsed.schedulerAuthorityDigest
      || Date.parse(parsed.now) < Date.parse(transition.updatedAt)) unavailable();
    return freeze({
      schema: DATABASE_RELOCATION_PREPARATION_V1,
      relocationId: parsed.relocationId,
      tenantId: parsed.tenantId,
      sourceAuthorityDigest: parsed.sourceAuthorityDigest,
      targetAuthorityDigest: parsed.targetAuthorityDigest,
      schedulerAuthorityDigest: parsed.schedulerAuthorityDigest,
      releaseDigest: parsed.sourceReleaseDigest,
      databaseSchemaDigest: parsed.sourceDatabaseSchemaDigest,
      restrictedRoleProofDigest: parsed.sourceRestrictedRoleProofDigest,
      artifactInventoryDigest: inventory.inventoryDigest,
      artifactRestoreVerificationDigest: restoration.verificationDigest,
      externalRollbackCheckpointDigest: parsed.externalRollbackCheckpointDigest,
      installationTransitionDigest: transition.transitionDigest,
      drainEvidenceDigest: transition.evidenceDigest,
      revision: 0,
      state: "preflight",
      updatedAt: parsed.now,
      performsBackup: false,
      performsRestore: false,
      readsExternalCheckpoint: false,
      writesExternalCheckpoint: false,
      startsOrFencesServices: false,
      configuresAuthority: false,
      activatesController: false,
    });
  } catch { return unavailable(); }
}

export function verifyDatabaseRelocationPreparationV1(value: unknown): DatabaseRelocationPreparationV1 {
  try { return Object.freeze(databaseRelocationPreparationSchemaV1.parse(value)); }
  catch { return unavailable(); }
}

/** Advances only the local evidence record; target activation remains separately authorized. */
export function advanceDatabaseRelocationPreparationV1(currentValue: unknown, input: unknown): DatabaseRelocationPreparationV1 {
  const current = verifyDatabaseRelocationPreparationV1(currentValue);
  try {
    const parsed = z.object({ expectedRevision: z.number().int().min(0), action, now: instant,
      failureDigest: digestSchema.optional() }).strict().parse(input);
    if (parsed.expectedRevision !== current.revision || Date.parse(parsed.now) < Date.parse(current.updatedAt)) unavailable();
    if (current.state !== "preflight") unavailable();
    if ((parsed.action === "fail") !== (parsed.failureDigest !== undefined)) unavailable();
    const { preparationDigest: _ignored, ...material } = current;
    return freeze({ ...material, revision: current.revision + 1,
      state: parsed.action === "mark_ready" ? "ready" : "failed", updatedAt: parsed.now,
      ...(parsed.failureDigest === undefined ? {} : { failureDigest: parsed.failureDigest }) });
  } catch { return unavailable(); }
}
