import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { parseOperationsReleaseCandidateV1, type OperationsReleaseCandidateV1 } from "./deployment";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import { parseOperationsProductionTopologyV1, type OperationsProductionTopologyV1 } from "./topology";

export const OPERATIONS_RECOVERY_CONTRACT_V1 = "control-room-operations-recovery/v1" as const;
export const OPERATIONS_RECOVERY_PHASE_IDS_V1 = [
  "isolate_disposable_target",
  "verify_topology_and_release",
  "verify_backup_manifest",
  "resolve_protected_recovery_references",
  "restore_base_backup",
  "replay_bounded_wal",
  "verify_database_integrity",
  "verify_audit_chain_and_anchor",
  "reconcile_node_journals",
  "run_independent_health_validation",
  "request_owner_cutover_window",
] as const;
export type OperationsRecoveryPhaseIdV1 = (typeof OPERATIONS_RECOVERY_PHASE_IDS_V1)[number];

export interface OperationsBackupManifestV1 {
  contractVersion: typeof OPERATIONS_RECOVERY_CONTRACT_V1;
  backupId: string;
  deploymentId: string;
  topologyDigest: string;
  releaseDigest: string;
  databaseIdentityDigest: string;
  databaseSchemaDigest: string;
  baseBackupDigest: string;
  walStartDigest: string;
  walEndDigest: string;
  auditChainHeadDigest: string;
  auditAnchorDigest: string;
  objectLocationReferenceDigest: string;
  encryptionKeyReferenceDigest: string;
  manifestSignatureDigest: string;
  declaredEncryptedBytes: number;
  startedAt: string;
  completedAt: string;
  earliestRestorePointAt: string;
  latestRestorePointAt: string;
  encrypted: true;
  immutable: true;
  independentlyVerifiable: true;
  containsDatabaseBytes: false;
  containsWalBytes: false;
  containsObjectLocator: false;
  containsCredentialMaterial: false;
  grantsRestoreAuthority: false;
  grantsCutoverAuthority: false;
  grantsExecutionAuthority: false;
  backupDigest: string;
}

export interface OperationsRecoveryPhaseV1 {
  phaseId: OperationsRecoveryPhaseIdV1;
  position: number;
  state: "not_started";
  requiredEvidenceClass: string;
  requiresPreviousPhase: boolean;
  effectClass: "preparation" | "isolated_restore" | "validation" | "owner_gate";
  phaseAuthorized: false;
  phaseDigest: string;
}

export interface OperationsRecoveryPlanV1 {
  contractVersion: typeof OPERATIONS_RECOVERY_CONTRACT_V1;
  recoveryPlanId: string;
  deploymentId: string;
  topologyDigest: string;
  releaseDigest: string;
  backupId: string;
  backupDigest: string;
  requestedRestorePointAt: string;
  targetIdentityDigest: string;
  targetClass: "disposable_isolated_only";
  operation: "operations.restore_and_reconcile_candidate";
  operationDigest: string;
  recoveryIdempotencyKey: string;
  phases: OperationsRecoveryPhaseV1[];
  databaseRestoreMode: "base_backup_plus_bounded_wal";
  journalReconciliationMode: "node_truth_cannot_be_overwritten";
  auditVerificationMode: "chain_and_external_anchor_required";
  targetRpoSeconds: number;
  targetRtoSeconds: number;
  productionOverwriteAllowed: false;
  directProductionCutoverAllowed: false;
  databaseDownMigrationAllowed: false;
  automaticRetryAfterRestoreMarker: false;
  unknownAfterRestoreMarker: "terminal_ambiguity";
  freshStrongOwnerCutoverRequired: true;
  separateRecoveryAttestationRequired: true;
  independentValidationRequired: true;
  restoreAuthorized: false;
  cutoverAuthorized: false;
  grantsApproval: false;
  grantsRestoreAuthority: false;
  grantsExecutionAuthority: false;
  plannedAt: string;
  expiresAt: string;
  recoveryPlanDigest: string;
}

export interface OperationsRollbackPlanV1 {
  contractVersion: typeof OPERATIONS_RECOVERY_CONTRACT_V1;
  rollbackPlanId: string;
  deploymentId: string;
  topologyDigest: string;
  currentReleaseDigest: string;
  previousReleaseDigest: string;
  currentMigrationBundleDigest: string;
  previousMigrationBundleDigest: string;
  databaseDisposition: "unchanged_verified" | "restore_from_verified_backup_required";
  compatibilityEvidenceDigest: string;
  backupDigest?: string;
  operation: "operations.rollback_release_candidate";
  operationDigest: string;
  rollbackIdempotencyKey: string;
  applicationRollbackRequiresCanary: true;
  databaseDownMigrationAllowed: false;
  automaticRollbackAllowed: false;
  automaticRetryAfterChange: false;
  unknownAfterChange: "terminal_ambiguity";
  freshStrongOwnerApprovalRequired: true;
  rollbackAuthorized: false;
  serviceControlAllowed: false;
  databaseMutationAllowed: false;
  grantsApproval: false;
  grantsRollbackAuthority: false;
  grantsExecutionAuthority: false;
  plannedAt: string;
  expiresAt: string;
  rollbackPlanDigest: string;
}

const backupInputSchema = z.object({ backupId: id, topology: z.unknown(), release: z.unknown(), databaseIdentityDigest: digest,
  databaseSchemaDigest: digest, baseBackupDigest: digest, walStartDigest: digest, walEndDigest: digest,
  auditChainHeadDigest: digest, auditAnchorDigest: digest, objectLocationReferenceDigest: digest,
  encryptionKeyReferenceDigest: digest, manifestSignatureDigest: digest,
  declaredEncryptedBytes: z.number().int().positive().max(17_592_186_044_416), startedAt: time, completedAt: time,
  earliestRestorePointAt: time, latestRestorePointAt: time }).strict();
const backupSchema = z.object({ contractVersion: z.literal(OPERATIONS_RECOVERY_CONTRACT_V1), backupId: id,
  deploymentId: id, topologyDigest: digest, releaseDigest: digest, databaseIdentityDigest: digest,
  databaseSchemaDigest: digest, baseBackupDigest: digest, walStartDigest: digest, walEndDigest: digest,
  auditChainHeadDigest: digest, auditAnchorDigest: digest, objectLocationReferenceDigest: digest,
  encryptionKeyReferenceDigest: digest, manifestSignatureDigest: digest,
  declaredEncryptedBytes: z.number().int().positive().max(17_592_186_044_416), startedAt: time, completedAt: time,
  earliestRestorePointAt: time, latestRestorePointAt: time, encrypted: z.literal(true), immutable: z.literal(true),
  independentlyVerifiable: z.literal(true), containsDatabaseBytes: z.literal(false), containsWalBytes: z.literal(false),
  containsObjectLocator: z.literal(false), containsCredentialMaterial: z.literal(false), grantsRestoreAuthority: z.literal(false),
  grantsCutoverAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), backupDigest: digest }).strict();
const phaseId = z.enum(OPERATIONS_RECOVERY_PHASE_IDS_V1);
const phaseSchema = z.object({ phaseId, position: z.number().int().min(0).max(10), state: z.literal("not_started"),
  requiredEvidenceClass: id, requiresPreviousPhase: z.boolean(),
  effectClass: z.enum(["preparation", "isolated_restore", "validation", "owner_gate"]),
  phaseAuthorized: z.literal(false), phaseDigest: digest }).strict();
const recoveryInputSchema = z.object({ recoveryPlanId: id, topology: z.unknown(), release: z.unknown(), backup: z.unknown(),
  requestedRestorePointAt: time, targetIdentityDigest: digest, targetRpoSeconds: z.number().int().positive().max(86_400),
  targetRtoSeconds: z.number().int().positive().max(86_400), plannedAt: time, expiresAt: time }).strict();
const recoverySchema = z.object({ contractVersion: z.literal(OPERATIONS_RECOVERY_CONTRACT_V1), recoveryPlanId: id,
  deploymentId: id, topologyDigest: digest, releaseDigest: digest, backupId: id, backupDigest: digest,
  requestedRestorePointAt: time, targetIdentityDigest: digest, targetClass: z.literal("disposable_isolated_only"),
  operation: z.literal("operations.restore_and_reconcile_candidate"), operationDigest: digest,
  recoveryIdempotencyKey: digest, phases: z.array(phaseSchema).length(11),
  databaseRestoreMode: z.literal("base_backup_plus_bounded_wal"),
  journalReconciliationMode: z.literal("node_truth_cannot_be_overwritten"),
  auditVerificationMode: z.literal("chain_and_external_anchor_required"), targetRpoSeconds: z.number().int().positive().max(86_400),
  targetRtoSeconds: z.number().int().positive().max(86_400), productionOverwriteAllowed: z.literal(false),
  directProductionCutoverAllowed: z.literal(false), databaseDownMigrationAllowed: z.literal(false),
  automaticRetryAfterRestoreMarker: z.literal(false), unknownAfterRestoreMarker: z.literal("terminal_ambiguity"),
  freshStrongOwnerCutoverRequired: z.literal(true), separateRecoveryAttestationRequired: z.literal(true),
  independentValidationRequired: z.literal(true), restoreAuthorized: z.literal(false), cutoverAuthorized: z.literal(false),
  grantsApproval: z.literal(false), grantsRestoreAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  plannedAt: time, expiresAt: time, recoveryPlanDigest: digest }).strict();
const rollbackInputSchema = z.object({ rollbackPlanId: id, topology: z.unknown(), currentRelease: z.unknown(),
  previousRelease: z.unknown(), databaseDisposition: z.enum(["unchanged_verified", "restore_from_verified_backup_required"]),
  compatibilityEvidenceDigest: digest, backup: z.unknown().optional(), plannedAt: time, expiresAt: time }).strict();
const rollbackSchema = z.object({ contractVersion: z.literal(OPERATIONS_RECOVERY_CONTRACT_V1), rollbackPlanId: id,
  deploymentId: id, topologyDigest: digest, currentReleaseDigest: digest, previousReleaseDigest: digest,
  currentMigrationBundleDigest: digest, previousMigrationBundleDigest: digest,
  databaseDisposition: z.enum(["unchanged_verified", "restore_from_verified_backup_required"]),
  compatibilityEvidenceDigest: digest, backupDigest: digest.optional(), operation: z.literal("operations.rollback_release_candidate"),
  operationDigest: digest, rollbackIdempotencyKey: digest, applicationRollbackRequiresCanary: z.literal(true),
  databaseDownMigrationAllowed: z.literal(false), automaticRollbackAllowed: z.literal(false),
  automaticRetryAfterChange: z.literal(false), unknownAfterChange: z.literal("terminal_ambiguity"),
  freshStrongOwnerApprovalRequired: z.literal(true), rollbackAuthorized: z.literal(false), serviceControlAllowed: z.literal(false),
  databaseMutationAllowed: z.literal(false), grantsApproval: z.literal(false), grantsRollbackAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), plannedAt: time, expiresAt: time, rollbackPlanDigest: digest }).strict();

const phaseEvidence: Record<OperationsRecoveryPhaseIdV1, string> = {
  isolate_disposable_target: "isolated_target_attestation",
  verify_topology_and_release: "topology_release_verification",
  verify_backup_manifest: "backup_manifest_verification",
  resolve_protected_recovery_references: "protected_reference_custody",
  restore_base_backup: "base_restore_receipt",
  replay_bounded_wal: "bounded_wal_replay_receipt",
  verify_database_integrity: "database_integrity_verification",
  verify_audit_chain_and_anchor: "audit_chain_anchor_verification",
  reconcile_node_journals: "node_journal_reconciliation",
  run_independent_health_validation: "independent_health_snapshot",
  request_owner_cutover_window: "owner_cutover_window",
};

function buildPhases(): OperationsRecoveryPhaseV1[] {
  return OPERATIONS_RECOVERY_PHASE_IDS_V1.map((currentPhaseId, position) => {
    const effectClass = position < 4 ? "preparation" as const : position < 6 ? "isolated_restore" as const
      : position < 10 ? "validation" as const : "owner_gate" as const;
    const material: Omit<OperationsRecoveryPhaseV1, "phaseDigest"> = { phaseId: currentPhaseId, position,
      state: "not_started", requiredEvidenceClass: phaseEvidence[currentPhaseId], requiresPreviousPhase: position > 0,
      effectClass, phaseAuthorized: false };
    return { ...material, phaseDigest: sha256Digest(material) };
  });
}

export function buildOperationsBackupManifestV1(inputValue: unknown): OperationsBackupManifestV1 {
  const input = parseExactOperationsV1(backupInputSchema, inputValue, "operations backup manifest input"),
    topology = parseOperationsProductionTopologyV1(input.topology), release = parseOperationsReleaseCandidateV1(input.release);
  if (Date.parse(input.completedAt) < Date.parse(input.startedAt)
    || Date.parse(input.earliestRestorePointAt) > Date.parse(input.latestRestorePointAt)
    || Date.parse(input.latestRestorePointAt) > Date.parse(input.completedAt)) throw new OperationsContractErrorV1("invalid_input");
  const material: Omit<OperationsBackupManifestV1, "backupDigest"> = { contractVersion: OPERATIONS_RECOVERY_CONTRACT_V1,
    backupId: input.backupId, deploymentId: topology.deploymentId, topologyDigest: topology.topologyDigest,
    releaseDigest: release.releaseDigest, databaseIdentityDigest: input.databaseIdentityDigest,
    databaseSchemaDigest: input.databaseSchemaDigest, baseBackupDigest: input.baseBackupDigest,
    walStartDigest: input.walStartDigest, walEndDigest: input.walEndDigest, auditChainHeadDigest: input.auditChainHeadDigest,
    auditAnchorDigest: input.auditAnchorDigest, objectLocationReferenceDigest: input.objectLocationReferenceDigest,
    encryptionKeyReferenceDigest: input.encryptionKeyReferenceDigest, manifestSignatureDigest: input.manifestSignatureDigest,
    declaredEncryptedBytes: input.declaredEncryptedBytes, startedAt: input.startedAt, completedAt: input.completedAt,
    earliestRestorePointAt: input.earliestRestorePointAt, latestRestorePointAt: input.latestRestorePointAt,
    encrypted: true, immutable: true, independentlyVerifiable: true, containsDatabaseBytes: false, containsWalBytes: false,
    containsObjectLocator: false, containsCredentialMaterial: false, grantsRestoreAuthority: false,
    grantsCutoverAuthority: false, grantsExecutionAuthority: false };
  return parseOperationsBackupManifestV1({ ...material, backupDigest: sha256Digest(material) });
}

export function parseOperationsBackupManifestV1(value: unknown): OperationsBackupManifestV1 {
  const parsed = parseExactOperationsV1(backupSchema, value, "operations backup manifest");
  if (Date.parse(parsed.completedAt) < Date.parse(parsed.startedAt)
    || Date.parse(parsed.earliestRestorePointAt) > Date.parse(parsed.latestRestorePointAt)
    || Date.parse(parsed.latestRestorePointAt) > Date.parse(parsed.completedAt)) throw new OperationsContractErrorV1("scope_mismatch");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "backupDigest", parsed.backupDigest);
  return parsed;
}

export function buildOperationsRecoveryPlanV1(inputValue: unknown): OperationsRecoveryPlanV1 {
  const input = parseExactOperationsV1(recoveryInputSchema, inputValue, "operations recovery plan input"),
    topology = parseOperationsProductionTopologyV1(input.topology), release = parseOperationsReleaseCandidateV1(input.release),
    backup = parseOperationsBackupManifestV1(input.backup);
  if (backup.deploymentId !== topology.deploymentId || backup.topologyDigest !== topology.topologyDigest
    || backup.releaseDigest !== release.releaseDigest || input.requestedRestorePointAt < backup.earliestRestorePointAt
    || input.requestedRestorePointAt > backup.latestRestorePointAt || Date.parse(input.expiresAt) <= Date.parse(input.plannedAt)
    || topology.services.some((service) => service.principalIdentityDigest === input.targetIdentityDigest)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const operationMaterial = { operation: "operations.restore_and_reconcile_candidate", deploymentId: topology.deploymentId,
    topologyDigest: topology.topologyDigest, releaseDigest: release.releaseDigest, backupDigest: backup.backupDigest,
    requestedRestorePointAt: input.requestedRestorePointAt, targetIdentityDigest: input.targetIdentityDigest };
  const material: Omit<OperationsRecoveryPlanV1, "recoveryPlanDigest"> = {
    contractVersion: OPERATIONS_RECOVERY_CONTRACT_V1, recoveryPlanId: input.recoveryPlanId,
    deploymentId: topology.deploymentId, topologyDigest: topology.topologyDigest, releaseDigest: release.releaseDigest,
    backupId: backup.backupId, backupDigest: backup.backupDigest, requestedRestorePointAt: input.requestedRestorePointAt,
    targetIdentityDigest: input.targetIdentityDigest, targetClass: "disposable_isolated_only",
    operation: "operations.restore_and_reconcile_candidate", operationDigest: sha256Digest(operationMaterial),
    recoveryIdempotencyKey: sha256Digest({ backupDigest: backup.backupDigest,
      requestedRestorePointAt: input.requestedRestorePointAt, targetIdentityDigest: input.targetIdentityDigest }),
    phases: buildPhases(), databaseRestoreMode: "base_backup_plus_bounded_wal",
    journalReconciliationMode: "node_truth_cannot_be_overwritten",
    auditVerificationMode: "chain_and_external_anchor_required", targetRpoSeconds: input.targetRpoSeconds,
    targetRtoSeconds: input.targetRtoSeconds, productionOverwriteAllowed: false, directProductionCutoverAllowed: false,
    databaseDownMigrationAllowed: false, automaticRetryAfterRestoreMarker: false,
    unknownAfterRestoreMarker: "terminal_ambiguity", freshStrongOwnerCutoverRequired: true,
    separateRecoveryAttestationRequired: true, independentValidationRequired: true, restoreAuthorized: false,
    cutoverAuthorized: false, grantsApproval: false, grantsRestoreAuthority: false, grantsExecutionAuthority: false,
    plannedAt: input.plannedAt, expiresAt: input.expiresAt };
  return parseOperationsRecoveryPlanV1({ ...material, recoveryPlanDigest: sha256Digest(material) });
}

export function parseOperationsRecoveryPlanV1(value: unknown): OperationsRecoveryPlanV1 {
  const parsed = parseExactOperationsV1(recoverySchema, value, "operations recovery plan");
  const operationMaterial = { operation: parsed.operation, deploymentId: parsed.deploymentId,
    topologyDigest: parsed.topologyDigest, releaseDigest: parsed.releaseDigest, backupDigest: parsed.backupDigest,
    requestedRestorePointAt: parsed.requestedRestorePointAt, targetIdentityDigest: parsed.targetIdentityDigest };
  if (parsed.phases.map((phase) => phase.phaseId).join("|") !== OPERATIONS_RECOVERY_PHASE_IDS_V1.join("|")
    || parsed.phases.some((phase, position) => phase.position !== position || phase.requiresPreviousPhase !== (position > 0)
      || phase.requiredEvidenceClass !== phaseEvidence[phase.phaseId]
      || phase.phaseDigest !== buildPhases()[position]!.phaseDigest)
    || parsed.operationDigest !== sha256Digest(operationMaterial)
    || parsed.recoveryIdempotencyKey !== sha256Digest({ backupDigest: parsed.backupDigest,
      requestedRestorePointAt: parsed.requestedRestorePointAt, targetIdentityDigest: parsed.targetIdentityDigest })) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  for (const phase of parsed.phases) verifyOperationsDigestV1(phase as unknown as Record<string, unknown>, "phaseDigest", phase.phaseDigest);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "recoveryPlanDigest", parsed.recoveryPlanDigest);
  return parsed;
}

export function buildOperationsRollbackPlanV1(inputValue: unknown): OperationsRollbackPlanV1 {
  const input = parseExactOperationsV1(rollbackInputSchema, inputValue, "operations rollback plan input"),
    topology = parseOperationsProductionTopologyV1(input.topology), current = parseOperationsReleaseCandidateV1(input.currentRelease),
    previous = parseOperationsReleaseCandidateV1(input.previousRelease), backup = input.backup ? parseOperationsBackupManifestV1(input.backup) : undefined;
  if (current.releaseDigest === previous.releaseDigest || Date.parse(input.expiresAt) <= Date.parse(input.plannedAt)
    || (input.databaseDisposition === "restore_from_verified_backup_required") !== Boolean(backup)
    || (backup && (backup.deploymentId !== topology.deploymentId || backup.releaseDigest !== previous.releaseDigest))) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const operationMaterial = { operation: "operations.rollback_release_candidate", deploymentId: topology.deploymentId,
    topologyDigest: topology.topologyDigest, currentReleaseDigest: current.releaseDigest,
    previousReleaseDigest: previous.releaseDigest, databaseDisposition: input.databaseDisposition,
    ...(backup ? { backupDigest: backup.backupDigest } : {}) };
  const material: Omit<OperationsRollbackPlanV1, "rollbackPlanDigest"> = {
    contractVersion: OPERATIONS_RECOVERY_CONTRACT_V1, rollbackPlanId: input.rollbackPlanId,
    deploymentId: topology.deploymentId, topologyDigest: topology.topologyDigest,
    currentReleaseDigest: current.releaseDigest, previousReleaseDigest: previous.releaseDigest,
    currentMigrationBundleDigest: current.migrationBundleDigest, previousMigrationBundleDigest: previous.migrationBundleDigest,
    databaseDisposition: input.databaseDisposition, compatibilityEvidenceDigest: input.compatibilityEvidenceDigest,
    ...(backup ? { backupDigest: backup.backupDigest } : {}), operation: "operations.rollback_release_candidate",
    operationDigest: sha256Digest(operationMaterial), rollbackIdempotencyKey: sha256Digest({ deploymentId: topology.deploymentId,
      currentReleaseDigest: current.releaseDigest, previousReleaseDigest: previous.releaseDigest,
      databaseDisposition: input.databaseDisposition, ...(backup ? { backupDigest: backup.backupDigest } : {}) }),
    applicationRollbackRequiresCanary: true, databaseDownMigrationAllowed: false, automaticRollbackAllowed: false,
    automaticRetryAfterChange: false, unknownAfterChange: "terminal_ambiguity", freshStrongOwnerApprovalRequired: true,
    rollbackAuthorized: false, serviceControlAllowed: false, databaseMutationAllowed: false, grantsApproval: false,
    grantsRollbackAuthority: false, grantsExecutionAuthority: false, plannedAt: input.plannedAt, expiresAt: input.expiresAt };
  return parseOperationsRollbackPlanV1({ ...material, rollbackPlanDigest: sha256Digest(material) });
}

export function parseOperationsRollbackPlanV1(value: unknown): OperationsRollbackPlanV1 {
  const parsed = parseExactOperationsV1(rollbackSchema, value, "operations rollback plan"), operationMaterial = {
    operation: parsed.operation, deploymentId: parsed.deploymentId, topologyDigest: parsed.topologyDigest,
    currentReleaseDigest: parsed.currentReleaseDigest, previousReleaseDigest: parsed.previousReleaseDigest,
    databaseDisposition: parsed.databaseDisposition, ...(parsed.backupDigest ? { backupDigest: parsed.backupDigest } : {}) };
  if ((parsed.databaseDisposition === "restore_from_verified_backup_required") !== Boolean(parsed.backupDigest)
    || parsed.operationDigest !== sha256Digest(operationMaterial)
    || parsed.rollbackIdempotencyKey !== sha256Digest({ deploymentId: parsed.deploymentId,
      currentReleaseDigest: parsed.currentReleaseDigest, previousReleaseDigest: parsed.previousReleaseDigest,
      databaseDisposition: parsed.databaseDisposition, ...(parsed.backupDigest ? { backupDigest: parsed.backupDigest } : {}) })) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "rollbackPlanDigest", parsed.rollbackPlanDigest);
  return parsed;
}

export function buildOperationsSyntheticBackupManifestV1(topology: OperationsProductionTopologyV1,
  release: OperationsReleaseCandidateV1): OperationsBackupManifestV1 {
  const value = (label: string) => sha256Digest({ backup: "synthetic-manifest", label });
  return buildOperationsBackupManifestV1({ backupId: "backup:operations:synthetic:1", topology, release,
    databaseIdentityDigest: topology.services[3]!.serviceDigest, databaseSchemaDigest: value("database-schema"),
    baseBackupDigest: value("base-backup"), walStartDigest: value("wal-start"), walEndDigest: value("wal-end"),
    auditChainHeadDigest: value("audit-chain-head"), auditAnchorDigest: value("audit-anchor"),
    objectLocationReferenceDigest: value("object-location-reference"), encryptionKeyReferenceDigest: value("encryption-key-reference"),
    manifestSignatureDigest: value("manifest-signature"), declaredEncryptedBytes: 1_048_576,
    startedAt: "2026-08-29T22:00:00.000Z", completedAt: "2026-08-29T22:10:00.000Z",
    earliestRestorePointAt: "2026-08-29T22:00:00.000Z", latestRestorePointAt: "2026-08-29T22:09:59.000Z" });
}

export const operationsRecoverySchemasV1 = { backupManifest: backupSchema, recoveryPhase: phaseSchema,
  recoveryPlan: recoverySchema, rollbackPlan: rollbackSchema } as const;
