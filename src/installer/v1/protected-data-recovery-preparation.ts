import { z } from "zod";
import { verifyLocalBackupRestoreReadinessV1,
  type LocalBackupRestoreReadinessV1 } from "../../harness/v1/local-backup-restore-readiness";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { capturePrivateArtifactStorageConfigurationV1,
  type PrivateArtifactStorageConfigurationV1 } from "../../web/v1/private-artifact-storage";
import { verifyInstallationPlanV1 } from "./installation-plan";

export const PROTECTED_DATA_PREPARATION_V1 = "control-room.protected-data-preparation/v1" as const;
export const RECOVERY_PREPARATION_V1 = "control-room.recovery-preparation/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const protectedState = z.enum(["missing", "present_unverified", "verified"]);
const recoveryState = z.enum(["not_proven", "verified"]);

const protectedSchema = z.object({
  schema: z.literal(PROTECTED_DATA_PREPARATION_V1),
  installationPlanDigest: digest,
  releaseDigest: digest,
  storageConfigurationDigest: digest,
  storageNamespaceDigest: digest,
  observedState: protectedState,
  observationDigest: digest,
  protectedDataBindingDigest: digest,
  stage: z.literal("protected_data"),
  stageInputDigest: digest,
  nextOperation: z.enum(["owner_create_private_data_root", "verify_owner_private_data_root", "bind_verified_protected_storage"]),
  precondition: z.enum(["owner_attendance_and_unowned_target", "existing_candidate_and_owner_attendance", "verified_private_root_only"]),
  preparationDigest: digest,
  createsDirectory: z.literal(false),
  opensStorage: z.literal(false),
  exposesPath: z.literal(false),
  startsService: z.literal(false),
  grantsStorageAuthority: z.literal(false),
}).strict();

const recoverySchema = z.object({
  schema: z.literal(RECOVERY_PREPARATION_V1),
  installationPlanDigest: digest,
  topologyPlanDigest: digest,
  releaseDigest: digest,
  protectedDataBindingDigest: digest,
  storageConfigurationDigest: digest,
  storageNamespaceDigest: digest,
  databaseAuthorityOutcomeDigest: digest,
  expectedDatabaseIdentityDigest: digest,
  expectedDatabaseSchemaDigest: digest,
  observedState: recoveryState,
  observationDigest: digest,
  backupRestoreProofDigest: digest.optional(),
  databaseDumpDigest: digest.optional(),
  artifactInventoryDigest: digest.optional(),
  artifactRestoreVerificationDigest: digest.optional(),
  artifactEntryCount: z.number().int().nonnegative().max(10_000).optional(),
  stage: z.literal("recovery"),
  stageInputDigest: digest,
  nextOperation: z.enum(["owner_run_existing_backup_restore_rehearsal", "record_verified_backup_restore_evidence"]),
  precondition: z.enum(["owner_attendance_and_disposable_restore_target", "verified_disposable_restore_only"]),
  preparationDigest: digest,
  runsBackup: z.literal(false),
  runsRestore: z.literal(false),
  promotesRestore: z.literal(false),
  exposesPath: z.literal(false),
  exposesCredentials: z.literal(false),
  startsService: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  const evidenceFields = [value.backupRestoreProofDigest, value.databaseDumpDigest,
    value.artifactInventoryDigest, value.artifactRestoreVerificationDigest, value.artifactEntryCount];
  if (value.observedState === "verified" && evidenceFields.some(item => item === undefined)) {
    context.addIssue({ code: "custom", message: "verified recovery requires complete evidence" });
  }
  if (value.observedState === "not_proven" && evidenceFields.some(item => item !== undefined)) {
    context.addIssue({ code: "custom", message: "unproven recovery cannot retain evidence" });
  }
});

export type ProtectedDataPreparationV1 = Readonly<z.infer<typeof protectedSchema>>;
export type RecoveryPreparationV1 = Readonly<z.infer<typeof recoverySchema>>;

const refuse = (): never => { throw new Error("protected_data_recovery_preparation_refused"); };

function capturedStorage(value: PrivateArtifactStorageConfigurationV1) {
  try { return capturePrivateArtifactStorageConfigurationV1(value); }
  catch { return refuse(); }
}

export function protectedDataStorageBindingsV1(value: PrivateArtifactStorageConfigurationV1) {
  const captured = capturedStorage(value);
  return Object.freeze({
    releaseDigest: captured.inventory.releaseDigest,
    storageConfigurationDigest: sha256Digest({
      purpose: "protected-artifact-storage-configuration/v1",
      local: captured.local,
      inventory: captured.inventory,
    }),
    storageNamespaceDigest: captured.inventory.storageNamespaceDigest,
  });
}

function protectedOperation(state: z.infer<typeof protectedState>) {
  if (state === "missing") return Object.freeze({ nextOperation: "owner_create_private_data_root" as const,
    precondition: "owner_attendance_and_unowned_target" as const });
  if (state === "present_unverified") return Object.freeze({ nextOperation: "verify_owner_private_data_root" as const,
    precondition: "existing_candidate_and_owner_attendance" as const });
  return Object.freeze({ nextOperation: "bind_verified_protected_storage" as const,
    precondition: "verified_private_root_only" as const });
}

function recoveryOperation(state: z.infer<typeof recoveryState>) {
  if (state === "not_proven") return Object.freeze({ nextOperation: "owner_run_existing_backup_restore_rehearsal" as const,
    precondition: "owner_attendance_and_disposable_restore_target" as const });
  return Object.freeze({ nextOperation: "record_verified_backup_restore_evidence" as const,
    precondition: "verified_disposable_restore_only" as const });
}

export function protectedDataStageInputDigestV1(input: Readonly<{
  releaseDigest: unknown; storageConfigurationDigest: unknown; storageNamespaceDigest: unknown;
}>): string {
  return sha256Digest({ purpose: "protected-data-stage-input/v1",
    releaseDigest: digest.parse(input.releaseDigest),
    storageConfigurationDigest: digest.parse(input.storageConfigurationDigest),
    storageNamespaceDigest: digest.parse(input.storageNamespaceDigest) });
}

export function recoveryStageInputDigestV1(input: Readonly<{
  releaseDigest: unknown; topologyPlanDigest: unknown; protectedDataBindingDigest: unknown;
  storageConfigurationDigest: unknown; storageNamespaceDigest: unknown;
  databaseAuthorityOutcomeDigest: unknown; expectedDatabaseIdentityDigest: unknown; expectedDatabaseSchemaDigest: unknown;
}>): string {
  return sha256Digest({ purpose: "recovery-stage-input/v1",
    releaseDigest: digest.parse(input.releaseDigest), topologyPlanDigest: digest.parse(input.topologyPlanDigest),
    protectedDataBindingDigest: digest.parse(input.protectedDataBindingDigest),
    storageConfigurationDigest: digest.parse(input.storageConfigurationDigest),
    storageNamespaceDigest: digest.parse(input.storageNamespaceDigest),
    databaseAuthorityOutcomeDigest: digest.parse(input.databaseAuthorityOutcomeDigest),
    expectedDatabaseIdentityDigest: digest.parse(input.expectedDatabaseIdentityDigest),
    expectedDatabaseSchemaDigest: digest.parse(input.expectedDatabaseSchemaDigest) });
}

export function protectedDataBindingDigestV1(input: Readonly<{
  storageConfiguration: PrivateArtifactStorageConfigurationV1; observedState: unknown; observationDigest: unknown;
}>): string {
  const storage = protectedDataStorageBindingsV1(input.storageConfiguration), observedState = protectedState.parse(input.observedState),
    observationDigest = digest.parse(input.observationDigest);
  return sha256Digest({ purpose: "protected-data-evidence-binding/v1", releaseDigest: storage.releaseDigest,
    storageConfigurationDigest: storage.storageConfigurationDigest, storageNamespaceDigest: storage.storageNamespaceDigest,
    observedState, observationDigest });
}

function freezeProtected(material: Omit<ProtectedDataPreparationV1, "preparationDigest">): ProtectedDataPreparationV1 {
  return Object.freeze({ ...material, preparationDigest: sha256Digest(material) });
}

function verifyProtectedShape(value: unknown): ProtectedDataPreparationV1 {
  const parsed = protectedSchema.parse(value), { preparationDigest, ...material } = parsed;
  const expected = protectedOperation(parsed.observedState);
  if (preparationDigest !== sha256Digest(material) || parsed.nextOperation !== expected.nextOperation
    || parsed.precondition !== expected.precondition
    || parsed.stageInputDigest !== protectedDataStageInputDigestV1(parsed)) refuse();
  return freezeProtected(material);
}

/** Creates only a redacted request for the existing private-storage setup path. */
export function prepareProtectedDataV1(input: Readonly<{ installationPlan: unknown;
  storageConfiguration: PrivateArtifactStorageConfigurationV1; observedState: unknown; observationDigest: unknown;
}>): ProtectedDataPreparationV1 {
  const plan = verifyInstallationPlanV1(input.installationPlan), storage = protectedDataStorageBindingsV1(input.storageConfiguration);
  const observedState = protectedState.parse(input.observedState), observationDigest = digest.parse(input.observationDigest);
  const protectedDataBindingDigest = protectedDataBindingDigestV1({ storageConfiguration: input.storageConfiguration,
    observedState, observationDigest });
  const stage = plan.stages.find(item => item.stage === "protected_data");
  if (!stage) return refuse();
  if (stage.state !== "running" || storage.releaseDigest !== plan.releaseDigest
    || stage.inputDigest !== protectedDataStageInputDigestV1(storage)) refuse();
  return freezeProtected({ schema: PROTECTED_DATA_PREPARATION_V1, installationPlanDigest: plan.planDigest,
    ...storage, observedState, observationDigest, protectedDataBindingDigest,
    stage: "protected_data", stageInputDigest: stage.inputDigest,
    ...protectedOperation(observedState), createsDirectory: false, opensStorage: false, exposesPath: false,
    startsService: false, grantsStorageAuthority: false });
}

export function verifyProtectedDataPreparationV1(value: unknown, installationPlan: unknown,
  storageConfiguration: PrivateArtifactStorageConfigurationV1,
  observation: Readonly<{ observedState: unknown; observationDigest: unknown }>): ProtectedDataPreparationV1 {
  const prepared = verifyProtectedShape(value), plan = verifyInstallationPlanV1(installationPlan),
    storage = protectedDataStorageBindingsV1(storageConfiguration), stage = plan.stages.find(item => item.stage === "protected_data"),
    trustedState = protectedState.parse(observation.observedState), trustedObservation = digest.parse(observation.observationDigest);
  if (!stage || stage.state !== "running" || prepared.installationPlanDigest !== plan.planDigest
    || prepared.releaseDigest !== plan.releaseDigest || prepared.releaseDigest !== storage.releaseDigest
    || prepared.storageConfigurationDigest !== storage.storageConfigurationDigest
    || prepared.storageNamespaceDigest !== storage.storageNamespaceDigest
    || prepared.observedState !== trustedState || prepared.observationDigest !== trustedObservation
    || prepared.protectedDataBindingDigest !== protectedDataBindingDigestV1({ storageConfiguration,
      observedState: trustedState, observationDigest: trustedObservation })
    || prepared.stageInputDigest !== stage.inputDigest) refuse();
  return prepared;
}

function freezeRecovery(material: Omit<RecoveryPreparationV1, "preparationDigest">): RecoveryPreparationV1 {
  return Object.freeze({ ...material, preparationDigest: sha256Digest(material) });
}

type ProofEvidence = Readonly<{ backupRestoreProofDigest?: string; databaseDumpDigest?: string;
  artifactInventoryDigest?: string; artifactRestoreVerificationDigest?: string; artifactEntryCount?: number;
  proof?: LocalBackupRestoreReadinessV1 }>;

function proofEvidence(state: z.infer<typeof recoveryState>, proofInput: unknown): ProofEvidence {
  if (state === "not_proven") {
    if (proofInput !== undefined) refuse();
    return Object.freeze({});
  }
  if (proofInput === undefined) return refuse();
  const proof = verifyLocalBackupRestoreReadinessV1(proofInput);
  return Object.freeze({ backupRestoreProofDigest: proof.proofDigest, databaseDumpDigest: proof.databaseDumpDigest,
    artifactInventoryDigest: proof.artifactInventoryDigest,
    artifactRestoreVerificationDigest: proof.artifactRestoreVerificationDigest,
    artifactEntryCount: proof.artifactEntryCount, proof });
}

function prepareRecovery(input: Readonly<{ installationPlan: unknown; topologyPlan: unknown;
  protectedDataPreparation: unknown; storageConfiguration: PrivateArtifactStorageConfigurationV1;
  protectedDataObservation: Readonly<{ observedState: unknown; observationDigest: unknown }>;
  databaseAuthorityOutcomeDigest: unknown; expectedDatabaseIdentityDigest: unknown; expectedDatabaseSchemaDigest: unknown;
  observedState: unknown; observationDigest: unknown; backupRestoreProof?: unknown;
}>): RecoveryPreparationV1 {
  const plan = verifyInstallationPlanV1(input.installationPlan), topology = verifyInstallationTopologyPlanV1(input.topologyPlan),
    protectedData = verifyProtectedShape(input.protectedDataPreparation), storage = protectedDataStorageBindingsV1(input.storageConfiguration),
    captured = capturedStorage(input.storageConfiguration),
    databaseAuthorityOutcomeDigest = digest.parse(input.databaseAuthorityOutcomeDigest),
    expectedDatabaseIdentityDigest = digest.parse(input.expectedDatabaseIdentityDigest),
    expectedDatabaseSchemaDigest = digest.parse(input.expectedDatabaseSchemaDigest),
    observedState = recoveryState.parse(input.observedState), observationDigest = digest.parse(input.observationDigest),
    evidence = proofEvidence(observedState, input.backupRestoreProof), stage = plan.stages.find(item => item.stage === "recovery"),
    protectedStage = plan.stages.find(item => item.stage === "protected_data"),
    databaseStage = plan.stages.find(item => item.stage === "database_authority");
  if (!stage || !protectedStage || !databaseStage) return refuse();
  if (stage.state !== "running" || protectedStage.state !== "passed"
    || databaseStage.state !== "passed" || databaseStage.outcomeDigest !== databaseAuthorityOutcomeDigest
    || protectedData.observedState !== "verified"
    || protectedData.observedState !== protectedState.parse(input.protectedDataObservation.observedState)
    || protectedData.observationDigest !== digest.parse(input.protectedDataObservation.observationDigest)
    || protectedData.protectedDataBindingDigest !== protectedDataBindingDigestV1({ storageConfiguration: input.storageConfiguration,
      observedState: input.protectedDataObservation.observedState,
      observationDigest: input.protectedDataObservation.observationDigest })
    || protectedStage.outcomeDigest !== protectedData.protectedDataBindingDigest
    || plan.topologyPlanDigest !== topology.planDigest || plan.releaseDigest !== storage.releaseDigest
    || protectedData.releaseDigest !== storage.releaseDigest
    || protectedData.storageConfigurationDigest !== storage.storageConfigurationDigest
    || protectedData.storageNamespaceDigest !== storage.storageNamespaceDigest
    || captured.inventory.databaseSchemaDigest !== expectedDatabaseSchemaDigest) refuse();
  const stable = { releaseDigest: plan.releaseDigest, topologyPlanDigest: topology.planDigest,
    protectedDataBindingDigest: protectedData.protectedDataBindingDigest,
    storageConfigurationDigest: storage.storageConfigurationDigest,
    storageNamespaceDigest: storage.storageNamespaceDigest,
    databaseAuthorityOutcomeDigest, expectedDatabaseIdentityDigest, expectedDatabaseSchemaDigest };
  if (stage.inputDigest !== recoveryStageInputDigestV1(stable)) refuse();
  if (evidence.proof !== undefined) {
    const proof = evidence.proof;
    if (proof.planDigest !== topology.planDigest || proof.releaseDigest !== plan.releaseDigest
      || proof.releaseId !== captured.inventory.releaseId
      || proof.storageNamespaceDigest !== storage.storageNamespaceDigest
      || proof.databaseIdentityDigest !== expectedDatabaseIdentityDigest
      || proof.databaseSchemaVersion !== captured.inventory.databaseSchemaVersion
      || proof.databaseSchemaDigest !== expectedDatabaseSchemaDigest) refuse();
  }
  const { proof: _proof, ...retainedEvidence } = evidence;
  return freezeRecovery({ schema: RECOVERY_PREPARATION_V1, installationPlanDigest: plan.planDigest, ...stable,
    observedState, observationDigest, ...retainedEvidence, stage: "recovery", stageInputDigest: stage.inputDigest,
    ...recoveryOperation(observedState), runsBackup: false, runsRestore: false, promotesRestore: false,
    exposesPath: false, exposesCredentials: false, startsService: false, grantsExecutionAuthority: false });
}

/** Prepares or records only existing evidence; it cannot run a backup or restore. */
export function prepareRecoveryV1(input: Parameters<typeof prepareRecovery>[0]): RecoveryPreparationV1 {
  return prepareRecovery(input);
}

export type RecoveryObservationV1 = Readonly<{ observedState: unknown; observationDigest: unknown;
  backupRestoreProofDigest?: unknown }>;

export function verifyRecoveryPreparationV1(value: unknown, input: Parameters<typeof prepareRecovery>[0],
  observation: RecoveryObservationV1): RecoveryPreparationV1 {
  const parsed = recoverySchema.parse(value), { preparationDigest, ...material } = parsed,
    expected = prepareRecovery(input), trustedState = recoveryState.parse(observation.observedState),
    trustedObservationDigest = digest.parse(observation.observationDigest),
    trustedProofDigest = observation.backupRestoreProofDigest === undefined
      ? undefined : digest.parse(observation.backupRestoreProofDigest);
  if ((trustedState === "verified") !== (trustedProofDigest !== undefined)
    || preparationDigest !== sha256Digest(material) || canonicalJson(parsed) !== canonicalJson(expected)
    || parsed.observedState !== trustedState || parsed.observationDigest !== trustedObservationDigest
    || parsed.backupRestoreProofDigest !== trustedProofDigest) refuse();
  return expected;
}

/** Returns only the named next owner action after the independent observation is rechecked. */
export function recoveryNextOperationV1(value: unknown, input: Parameters<typeof prepareRecovery>[0],
  observation: RecoveryObservationV1) {
  const prepared = verifyRecoveryPreparationV1(value, input, observation);
  return Object.freeze({ stage: prepared.stage, operation: prepared.nextOperation,
    precondition: prepared.precondition, performsEffect: false as const,
    runsBackup: false as const, runsRestore: false as const });
}
