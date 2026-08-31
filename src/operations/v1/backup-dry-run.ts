import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import {
  buildOperationsBackupManifestV1,
  parseOperationsBackupManifestV1,
  type OperationsBackupManifestV1,
} from "./recovery";
import { parseOperationsReleaseCandidateV1, type OperationsReleaseCandidateV1 } from "./deployment";
import { parseOperationsProductionTopologyV1, type OperationsProductionTopologyV1 } from "./topology";

export const OPERATIONS_BACKUP_DRY_RUN_CONTRACT_V1 = "control-room-operations-backup-dry-run/v1" as const;
export const OPERATIONS_BACKUP_RETENTION_CEILINGS_V1 = {
  maximumBaseBackupCount: 35,
  maximumWalWindowHours: 168,
  maximumManifestRetentionDays: 90,
  maximumEstimatedEncryptedBytes: 17_592_186_044_416,
  maximumEstimatedWalBytes: 4_398_046_511_104,
  maximumEstimatedDurationSeconds: 21_600,
} as const;

export interface OperationsBackupDryRunPlanV1 {
  contractVersion: typeof OPERATIONS_BACKUP_DRY_RUN_CONTRACT_V1;
  jobPlanId: string;
  deploymentId: string;
  topologyDigest: string;
  releaseDigest: string;
  databaseServiceDigest: string;
  objectLocationReferenceDigest: string;
  encryptionKeyReferenceDigest: string;
  manifestSignerReferenceDigest: string;
  scheduleMode: "continuous_wal_plus_daily_base";
  retention: {
    baseBackupCount: number;
    walWindowHours: number;
    manifestRetentionDays: number;
  };
  resourceEstimate: {
    maximumEncryptedBytes: number;
    maximumWalBytes: number;
    maximumDurationSeconds: number;
  };
  operation: "operations.backup_and_archive_wal_candidate";
  operationDigest: string;
  idempotencyKey: string;
  requiredManifestProperties: readonly ["immutable", "encrypted", "bounded_wal", "external_audit_anchor", "digest_only_references"];
  protectedReferencesResolved: false;
  executableCommandPresent: false;
  databaseClientPresent: false;
  storageClientPresent: false;
  networkClientPresent: false;
  containsDatabaseBytes: false;
  containsWalBytes: false;
  containsObjectLocator: false;
  containsCredentialMaterial: false;
  backupAuthorized: false;
  grantsApproval: false;
  grantsBackupAuthority: false;
  grantsExecutionAuthority: false;
  plannedAt: string;
  expiresAt: string;
  planDigest: string;
}

export interface OperationsBackupManifestVerificationV1 {
  contractVersion: typeof OPERATIONS_BACKUP_DRY_RUN_CONTRACT_V1;
  planDigest: string;
  backupDigest: string;
  disposition: "contract_valid_reference_candidate";
  topologyAndReleaseBound: true;
  walBoundsPresent: true;
  immutableAndEncrypted: true;
  protectedReferencesDigestOnly: true;
  externalSignatureVerificationStillRequired: true;
  containsBytes: false;
  grantsRestoreAuthority: false;
  grantsExecutionAuthority: false;
  verificationDigest: string;
}

export interface OperationsBackupDryRunProjectionV1 {
  contractVersion: typeof OPERATIONS_BACKUP_DRY_RUN_CONTRACT_V1;
  planDigest: string;
  status: "dry_run_only";
  summaryLines: string[];
  commandLines: [];
  protectedReferenceValuesShown: false;
  externalEffectControlsPresent: false;
  grantsApproval: false;
  grantsBackupAuthority: false;
  projectionDigest: string;
}

type FakeMode = "success" | "failed_after_marker" | "uncertain_after_marker";
type FakeFixture = {
  topology: OperationsProductionTopologyV1;
  release: OperationsReleaseCandidateV1;
  planDigest: string;
  backupId: string;
  startedAt: string;
  completedAt: string;
  earliestRestorePointAt: string;
  latestRestorePointAt: string;
  declaredEncryptedBytes: number;
  mode: FakeMode;
};
export interface OperationsInMemoryBackupAdapterV1 {
  readonly kind: "in_memory_fake_no_io";
  invoke(planDigest: string): { state: "succeeded"; manifest: OperationsBackupManifestV1 }
    | { state: "failed"; safeCode: "synthetic_backup_failed" }
    | { state: "uncertain"; safeCode: "synthetic_outcome_unknown_after_marker" };
}

const retentionSchema = z.object({ baseBackupCount: z.number().int().min(1).max(OPERATIONS_BACKUP_RETENTION_CEILINGS_V1.maximumBaseBackupCount),
  walWindowHours: z.number().int().min(1).max(OPERATIONS_BACKUP_RETENTION_CEILINGS_V1.maximumWalWindowHours),
  manifestRetentionDays: z.number().int().min(1).max(OPERATIONS_BACKUP_RETENTION_CEILINGS_V1.maximumManifestRetentionDays) }).strict();
const estimateSchema = z.object({ maximumEncryptedBytes: z.number().int().positive()
    .max(OPERATIONS_BACKUP_RETENTION_CEILINGS_V1.maximumEstimatedEncryptedBytes),
  maximumWalBytes: z.number().int().positive().max(OPERATIONS_BACKUP_RETENTION_CEILINGS_V1.maximumEstimatedWalBytes),
  maximumDurationSeconds: z.number().int().positive().max(OPERATIONS_BACKUP_RETENTION_CEILINGS_V1.maximumEstimatedDurationSeconds) }).strict();
const planInputSchema = z.object({ jobPlanId: id, topology: z.unknown(), release: z.unknown(),
  objectLocationReferenceDigest: digest, encryptionKeyReferenceDigest: digest, manifestSignerReferenceDigest: digest,
  retention: retentionSchema, resourceEstimate: estimateSchema, plannedAt: time, expiresAt: time }).strict();
const planSchema = z.object({ contractVersion: z.literal(OPERATIONS_BACKUP_DRY_RUN_CONTRACT_V1), jobPlanId: id,
  deploymentId: id, topologyDigest: digest, releaseDigest: digest, databaseServiceDigest: digest,
  objectLocationReferenceDigest: digest, encryptionKeyReferenceDigest: digest, manifestSignerReferenceDigest: digest,
  scheduleMode: z.literal("continuous_wal_plus_daily_base"), retention: retentionSchema, resourceEstimate: estimateSchema,
  operation: z.literal("operations.backup_and_archive_wal_candidate"), operationDigest: digest, idempotencyKey: digest,
  requiredManifestProperties: z.tuple([z.literal("immutable"), z.literal("encrypted"), z.literal("bounded_wal"),
    z.literal("external_audit_anchor"), z.literal("digest_only_references")]), protectedReferencesResolved: z.literal(false),
  executableCommandPresent: z.literal(false), databaseClientPresent: z.literal(false), storageClientPresent: z.literal(false),
  networkClientPresent: z.literal(false), containsDatabaseBytes: z.literal(false), containsWalBytes: z.literal(false),
  containsObjectLocator: z.literal(false), containsCredentialMaterial: z.literal(false), backupAuthorized: z.literal(false),
  grantsApproval: z.literal(false), grantsBackupAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  plannedAt: time, expiresAt: time, planDigest: digest }).strict();
const verificationSchema = z.object({ contractVersion: z.literal(OPERATIONS_BACKUP_DRY_RUN_CONTRACT_V1), planDigest: digest,
  backupDigest: digest, disposition: z.literal("contract_valid_reference_candidate"), topologyAndReleaseBound: z.literal(true),
  walBoundsPresent: z.literal(true), immutableAndEncrypted: z.literal(true), protectedReferencesDigestOnly: z.literal(true),
  externalSignatureVerificationStillRequired: z.literal(true), containsBytes: z.literal(false),
  grantsRestoreAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), verificationDigest: digest }).strict();
const fakeInputSchema = z.object({ topology: z.unknown(), release: z.unknown(), plan: z.unknown(), backupId: id,
  startedAt: time, completedAt: time, earliestRestorePointAt: time, latestRestorePointAt: time,
  declaredEncryptedBytes: z.number().int().positive().max(OPERATIONS_BACKUP_RETENTION_CEILINGS_V1.maximumEstimatedEncryptedBytes),
  mode: z.enum(["success", "failed_after_marker", "uncertain_after_marker"]) }).strict();

const trustedBackupAdapters = new WeakMap<object, FakeFixture>();

export function buildOperationsBackupDryRunPlanV1(inputValue: unknown): OperationsBackupDryRunPlanV1 {
  const input = parseExactOperationsV1(planInputSchema, inputValue, "operations backup dry-run plan input"),
    topology = parseOperationsProductionTopologyV1(input.topology), release = parseOperationsReleaseCandidateV1(input.release),
    database = topology.services.find((service) => service.role === "postgres_primary");
  if (!database || release.applicationArtifactDigest !== topology.services.find((service) => service.role === "control_room_application")?.artifactIdentityDigest
    || Date.parse(input.expiresAt) <= Date.parse(input.plannedAt)
    || new Set([input.objectLocationReferenceDigest, input.encryptionKeyReferenceDigest, input.manifestSignerReferenceDigest]).size !== 3
    || input.resourceEstimate.maximumWalBytes > input.resourceEstimate.maximumEncryptedBytes) throw new OperationsContractErrorV1("scope_mismatch");
  const operationMaterial = { operation: "operations.backup_and_archive_wal_candidate", deploymentId: topology.deploymentId,
    topologyDigest: topology.topologyDigest, releaseDigest: release.releaseDigest, databaseServiceDigest: database.serviceDigest,
    objectLocationReferenceDigest: input.objectLocationReferenceDigest, encryptionKeyReferenceDigest: input.encryptionKeyReferenceDigest,
    retention: input.retention };
  const material: Omit<OperationsBackupDryRunPlanV1, "planDigest"> = {
    contractVersion: OPERATIONS_BACKUP_DRY_RUN_CONTRACT_V1, jobPlanId: input.jobPlanId,
    deploymentId: topology.deploymentId, topologyDigest: topology.topologyDigest, releaseDigest: release.releaseDigest,
    databaseServiceDigest: database.serviceDigest, objectLocationReferenceDigest: input.objectLocationReferenceDigest,
    encryptionKeyReferenceDigest: input.encryptionKeyReferenceDigest, manifestSignerReferenceDigest: input.manifestSignerReferenceDigest,
    scheduleMode: "continuous_wal_plus_daily_base", retention: input.retention, resourceEstimate: input.resourceEstimate,
    operation: "operations.backup_and_archive_wal_candidate", operationDigest: sha256Digest(operationMaterial),
    idempotencyKey: sha256Digest({ topologyDigest: topology.topologyDigest, releaseDigest: release.releaseDigest,
      databaseServiceDigest: database.serviceDigest, retention: input.retention, plannedAt: input.plannedAt }),
    requiredManifestProperties: ["immutable", "encrypted", "bounded_wal", "external_audit_anchor", "digest_only_references"],
    protectedReferencesResolved: false, executableCommandPresent: false, databaseClientPresent: false, storageClientPresent: false,
    networkClientPresent: false, containsDatabaseBytes: false, containsWalBytes: false, containsObjectLocator: false,
    containsCredentialMaterial: false, backupAuthorized: false, grantsApproval: false, grantsBackupAuthority: false,
    grantsExecutionAuthority: false, plannedAt: input.plannedAt, expiresAt: input.expiresAt,
  };
  return parseOperationsBackupDryRunPlanV1({ ...material, planDigest: sha256Digest(material) });
}

export function parseOperationsBackupDryRunPlanV1(value: unknown): OperationsBackupDryRunPlanV1 {
  const plan = parseExactOperationsV1(planSchema, value, "operations backup dry-run plan"), operationMaterial = {
    operation: plan.operation, deploymentId: plan.deploymentId, topologyDigest: plan.topologyDigest,
    releaseDigest: plan.releaseDigest, databaseServiceDigest: plan.databaseServiceDigest,
    objectLocationReferenceDigest: plan.objectLocationReferenceDigest,
    encryptionKeyReferenceDigest: plan.encryptionKeyReferenceDigest, retention: plan.retention };
  if (plan.operationDigest !== sha256Digest(operationMaterial) || plan.idempotencyKey !== sha256Digest({
    topologyDigest: plan.topologyDigest, releaseDigest: plan.releaseDigest, databaseServiceDigest: plan.databaseServiceDigest,
    retention: plan.retention, plannedAt: plan.plannedAt }) || plan.resourceEstimate.maximumWalBytes > plan.resourceEstimate.maximumEncryptedBytes) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(plan as unknown as Record<string, unknown>, "planDigest", plan.planDigest); return plan;
}

export function verifyOperationsBackupManifestForPlanV1(planValue: unknown, manifestValue: unknown): OperationsBackupManifestVerificationV1 {
  const plan = parseOperationsBackupDryRunPlanV1(planValue), manifest = parseOperationsBackupManifestV1(manifestValue);
  if (manifest.deploymentId !== plan.deploymentId || manifest.topologyDigest !== plan.topologyDigest
    || manifest.releaseDigest !== plan.releaseDigest || manifest.databaseIdentityDigest !== plan.databaseServiceDigest
    || manifest.objectLocationReferenceDigest !== plan.objectLocationReferenceDigest
    || manifest.encryptionKeyReferenceDigest !== plan.encryptionKeyReferenceDigest
    || Date.parse(manifest.completedAt) > Date.parse(plan.expiresAt)
    || manifest.declaredEncryptedBytes > plan.resourceEstimate.maximumEncryptedBytes
    || Date.parse(manifest.completedAt) - Date.parse(manifest.startedAt) > plan.resourceEstimate.maximumDurationSeconds * 1000) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const material: Omit<OperationsBackupManifestVerificationV1, "verificationDigest"> = {
    contractVersion: OPERATIONS_BACKUP_DRY_RUN_CONTRACT_V1, planDigest: plan.planDigest, backupDigest: manifest.backupDigest,
    disposition: "contract_valid_reference_candidate", topologyAndReleaseBound: true, walBoundsPresent: true,
    immutableAndEncrypted: true, protectedReferencesDigestOnly: true, externalSignatureVerificationStillRequired: true,
    containsBytes: false, grantsRestoreAuthority: false, grantsExecutionAuthority: false,
  };
  const result = parseExactOperationsV1(verificationSchema, { ...material, verificationDigest: sha256Digest(material) },
    "operations backup manifest verification");
  verifyOperationsDigestV1(result as unknown as Record<string, unknown>, "verificationDigest", result.verificationDigest);
  return result;
}

export function createOperationsInMemoryBackupAdapterV1(inputValue: unknown): OperationsInMemoryBackupAdapterV1 {
  const input = parseExactOperationsV1(fakeInputSchema, inputValue, "operations in-memory backup adapter input"),
    topology = parseOperationsProductionTopologyV1(input.topology), release = parseOperationsReleaseCandidateV1(input.release),
    plan = parseOperationsBackupDryRunPlanV1(input.plan);
  if (plan.topologyDigest !== topology.topologyDigest || plan.releaseDigest !== release.releaseDigest
    || Date.parse(input.completedAt) < Date.parse(input.startedAt)
    || input.declaredEncryptedBytes > plan.resourceEstimate.maximumEncryptedBytes) throw new OperationsContractErrorV1("scope_mismatch");
  const fixture: FakeFixture = { topology, release, planDigest: plan.planDigest, backupId: input.backupId,
    startedAt: input.startedAt, completedAt: input.completedAt, earliestRestorePointAt: input.earliestRestorePointAt,
    latestRestorePointAt: input.latestRestorePointAt, declaredEncryptedBytes: input.declaredEncryptedBytes, mode: input.mode };
  const adapter: OperationsInMemoryBackupAdapterV1 = { kind: "in_memory_fake_no_io", invoke(planDigest) {
    const trusted = trustedBackupAdapters.get(adapter);
    if (!trusted || planDigest !== trusted.planDigest) throw new OperationsContractErrorV1("scope_mismatch");
    if (trusted.mode === "uncertain_after_marker") return { state: "uncertain", safeCode: "synthetic_outcome_unknown_after_marker" };
    if (trusted.mode === "failed_after_marker") return { state: "failed", safeCode: "synthetic_backup_failed" };
    const synthetic = (label: string) => sha256Digest({ adapter: "in-memory-backup-no-io", planDigest, label });
    const manifest = buildOperationsBackupManifestV1({ backupId: trusted.backupId, topology: trusted.topology,
      release: trusted.release, databaseIdentityDigest: parseOperationsBackupDryRunPlanV1(input.plan).databaseServiceDigest,
      databaseSchemaDigest: synthetic("database-schema"), baseBackupDigest: synthetic("base-backup"),
      walStartDigest: synthetic("wal-start"), walEndDigest: synthetic("wal-end"),
      auditChainHeadDigest: synthetic("audit-chain-head"), auditAnchorDigest: synthetic("external-audit-anchor"),
      objectLocationReferenceDigest: parseOperationsBackupDryRunPlanV1(input.plan).objectLocationReferenceDigest,
      encryptionKeyReferenceDigest: parseOperationsBackupDryRunPlanV1(input.plan).encryptionKeyReferenceDigest,
      manifestSignatureDigest: synthetic("manifest-signature"), declaredEncryptedBytes: trusted.declaredEncryptedBytes,
      startedAt: trusted.startedAt, completedAt: trusted.completedAt, earliestRestorePointAt: trusted.earliestRestorePointAt,
      latestRestorePointAt: trusted.latestRestorePointAt });
    return { state: "succeeded", manifest };
  } };
  trustedBackupAdapters.set(adapter, fixture); return Object.freeze(adapter);
}

export function invokeOperationsTrustedInMemoryBackupAdapterV1(adapter: OperationsInMemoryBackupAdapterV1, planDigest: string) {
  if (!trustedBackupAdapters.has(adapter)) throw new OperationsContractErrorV1("unsupported_action");
  return adapter.invoke(planDigest);
}

export function projectOperationsBackupDryRunV1(planValue: unknown): OperationsBackupDryRunProjectionV1 {
  const plan = parseOperationsBackupDryRunPlanV1(planValue);
  const material: Omit<OperationsBackupDryRunProjectionV1, "projectionDigest"> = {
    contractVersion: OPERATIONS_BACKUP_DRY_RUN_CONTRACT_V1, planDigest: plan.planDigest, status: "dry_run_only",
    summaryLines: [
      `Plan ${plan.jobPlanId} is a non-authorizing backup/WAL rehearsal.`,
      `Retention ceiling: ${plan.retention.baseBackupCount} base backups and ${plan.retention.walWindowHours} WAL hours.`,
      `Bounded estimate: ${plan.resourceEstimate.maximumEncryptedBytes} encrypted bytes, ${plan.resourceEstimate.maximumDurationSeconds} seconds.`,
      "Protected locations and keys remain unresolved digest references.",
      "No command, connection, credential, storage call, or encryption operation is available.",
    ], commandLines: [], protectedReferenceValuesShown: false, externalEffectControlsPresent: false,
    grantsApproval: false, grantsBackupAuthority: false,
  };
  return { ...material, projectionDigest: sha256Digest(material) };
}

export const operationsBackupDryRunSchemasV1 = { plan: planSchema, verification: verificationSchema } as const;
