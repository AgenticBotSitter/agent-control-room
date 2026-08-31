import { z } from "zod";
import {
  READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1,
  READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1,
  READY_FRONTIER_ACCEPTED_AUTO070_COMMIT_V1,
  READY_FRONTIER_ACCEPTED_AUTO070_REVIEW_SHA256_V1,
  READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1,
  readyFrontierProductionEvidenceClassesV1,
} from "../../ready-frontier/v1";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import {
  OPERATIONS_DEPLOYMENT_GATE_IDS_V1,
  buildCurrentOperationsDeploymentDisabledV1,
  parseOperationsDeploymentDisabledDispositionV1,
  parseOperationsDeploymentPlanV1,
  parseOperationsDeploymentReadinessAssessmentV1,
  parseOperationsReleaseCandidateV1,
  type OperationsDeploymentDisabledDispositionV1,
  type OperationsDeploymentGateIdV1,
  type OperationsDeploymentPlanV1,
  type OperationsDeploymentReadinessAssessmentV1,
  type OperationsReleaseCandidateV1,
} from "./deployment";
import {
  OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1,
  buildOperationsProductionDatabaseTargetV1,
  parseOperationsProductionDatabaseTargetV1,
  type OperationsProductionDatabaseBlockerV1,
  type OperationsProductionDatabaseTargetV1,
} from "./database-target";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import {
  parseOperationsProductionTopologyV1,
  type OperationsProductionTopologyV1,
} from "./topology";

export const OPERATIONS_POSTGRES_READINESS_CONTRACT_V1 =
  "control-room-operations-postgres-readiness/v1" as const;
export const OPERATIONS_POSTGRES_READINESS_DISPOSITION_V1 =
  "control-room-operations-postgres-readiness-disposition/v1" as const;
export const OPERATIONS_POSTGRES_READINESS_PROJECTION_V1 =
  "control-room-operations-postgres-readiness-projection/v1" as const;

export const OPERATIONS_POSTGRES_READINESS_REPOSITORY_MET_GATES_V1 = Object.freeze([
  "topology_contract",
  "release_identity",
  "health_probe_contract",
] as const satisfies readonly OperationsDeploymentGateIdV1[]);

const DATABASE_TARGET_BLOCKERS_V1 = Object.freeze([
  "native_host_qualification",
  "deployment_mode_selection",
  "private_network_boundary_evidence",
  "postgres_runtime_preparation",
  "database_role_separation",
  "credential_reference_custody",
  "backup_and_wal_configuration",
  "clean_restore_rehearsal",
  "migration_compatibility",
  "health_and_resource_monitoring",
  "fresh_owner_effect_packet",
  "independent_security_review",
] as const satisfies readonly OperationsProductionDatabaseBlockerV1[]);
const DEPLOYMENT_GATES_V1 = Object.freeze([
  "topology_contract",
  "release_identity",
  "release_signature",
  "provenance_attestation",
  "sbom_policy",
  "configuration_schema",
  "credential_reference_custody",
  "edge_access_policy",
  "database_backup_freshness",
  "wal_archiving_health",
  "restore_rehearsal",
  "migration_compatibility",
  "rollback_material",
  "health_probe_contract",
  "resource_headroom",
  "monitoring_alert_path",
  "audit_anchor_freshness",
  "fresh_owner_window",
] as const satisfies readonly OperationsDeploymentGateIdV1[]);
const AUTOMATIC_WORK_GATES_V1 = Object.freeze([
  "ambiguity_reconciliation_unproved",
  "consumer_channel_unqualified",
  "credential_broker_unbound",
  "hosted_postgresql_unqualified",
  "multi_process_concurrency_unproved",
  "production_clock_custody_unproved",
  "production_independent_review_missing",
  "production_owner_approval_missing",
  "production_policy_custody_unproved",
] as const);
const AUTOMATIC_WORK_EVIDENCE_CLASSES_V1 = Object.freeze([
  "destination_reconciliation_attestation",
  "consumer_channel_qualification",
  "credential_broker_custody_attestation",
  "hosted_postgresql_qualification",
  "multi_process_concurrency_qualification",
  "production_clock_custody_attestation",
  "production_independent_review",
  "production_owner_approval_attestation",
  "production_policy_custody_attestation",
] as const);

function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let position = 0; position < left.length; position += 1) if (left[position] !== right[position]) return false;
  return true;
}

if (!sameList(OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1, DATABASE_TARGET_BLOCKERS_V1)
  || !sameList(OPERATIONS_DEPLOYMENT_GATE_IDS_V1, DEPLOYMENT_GATES_V1)
  || !sameList(READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1, AUTOMATIC_WORK_GATES_V1)
  || !sameList(readyFrontierProductionEvidenceClassesV1, AUTOMATIC_WORK_EVIDENCE_CLASSES_V1)) {
  throw new OperationsContractErrorV1("scope_mismatch");
}
Object.freeze(OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1);
Object.freeze(OPERATIONS_DEPLOYMENT_GATE_IDS_V1);
Object.freeze(readyFrontierProductionEvidenceClassesV1);

export type OperationsPostgresReadinessGateSourceV1 =
  | "database_target"
  | "operations_deployment"
  | "automatic_work";
export type OperationsPostgresReadinessGateStatusV1 =
  | "met_repository_contract"
  | "missing_live_evidence"
  | "expired_evidence"
  | "unobserved_production_proof";

export interface OperationsPostgresReadinessGateV1 {
  gateKey: string;
  source: OperationsPostgresReadinessGateSourceV1;
  sourceGateCode: string;
  evidenceClass: string;
  status: OperationsPostgresReadinessGateStatusV1;
  sourceEvidenceDigest: string | null;
  repositoryEvidenceOnly: boolean;
  liveEvidenceAccepted: false;
  blocking: boolean;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  gateDigest: string;
}

export interface OperationsPostgresReadinessSourcesV1 {
  topology: OperationsProductionTopologyV1;
  release: OperationsReleaseCandidateV1;
  plan: OperationsDeploymentPlanV1;
  assessment: OperationsDeploymentReadinessAssessmentV1;
  disposition: OperationsDeploymentDisabledDispositionV1;
}

export interface OperationsPostgresReadinessPacketV1 {
  contractVersion: typeof OPERATIONS_POSTGRES_READINESS_CONTRACT_V1;
  packetId: string;
  databaseTarget: OperationsProductionDatabaseTargetV1;
  operations: OperationsPostgresReadinessSourcesV1;
  acceptedAuto040Commit: typeof READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1;
  acceptedAuto040ReviewSha256: typeof READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1;
  acceptedAuto070Commit: typeof READY_FRONTIER_ACCEPTED_AUTO070_COMMIT_V1;
  acceptedAuto070ReviewSha256: typeof READY_FRONTIER_ACCEPTED_AUTO070_REVIEW_SHA256_V1;
  databaseTargetBlockerCodes: OperationsProductionDatabaseBlockerV1[];
  operationsGateIds: OperationsDeploymentGateIdV1[];
  automaticWorkGateCodes: string[];
  gates: OperationsPostgresReadinessGateV1[];
  totalGateCount: 39;
  metRepositoryContractCount: 3;
  blockingGateCount: 36;
  blockingGateKeys: string[];
  state: "blocked_repository_only";
  safeReason: "live_evidence_and_authorization_missing";
  reportedHostContextUsedAsEvidence: false;
  liveEvidenceAccepted: false;
  productionValuesPresent: false;
  credentialReferencesPresent: false;
  credentialValuesPresent: false;
  deployableConfigurationPresent: false;
  eligibleForOwnerWindow: false;
  productionReady: false;
  requiresNewExactOwnerAuthorization: true;
  requiresIndependentReviewBeforeLiveWork: true;
  hostContactAuthorized: false;
  databaseContactAuthorized: false;
  serviceControlAuthorized: false;
  configurationWriteAuthorized: false;
  migrationAuthorized: false;
  backupOrRestoreAuthorized: false;
  consumerActivationAuthorized: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  grantsExternalEffects: false;
  preparedAt: string;
  packetDigest: string;
}

export interface OperationsPostgresReadinessDispositionV1 {
  contractVersion: typeof OPERATIONS_POSTGRES_READINESS_DISPOSITION_V1;
  dispositionId: string;
  packetId: string;
  packetDigest: string;
  status: "disabled_before_host_contact";
  blockingGateKeys: string[];
  safeReason: "live_evidence_and_authorization_missing";
  recordedAt: string;
  newPacketRequiredAfterEvidenceChange: true;
  automaticRetryAllowed: false;
  hostContacted: false;
  protectedReferenceResolved: false;
  serviceInstalledOrStarted: false;
  configurationWritten: false;
  databaseContacted: false;
  migrationAttempted: false;
  backupOrRestoreAttempted: false;
  consumerActivated: false;
  deploymentAttempted: false;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  dispositionDigest: string;
}

export interface OperationsPostgresReadinessProjectionV1 {
  contractVersion: typeof OPERATIONS_POSTGRES_READINESS_PROJECTION_V1;
  packetId: string;
  packetDigest: string;
  dispositionId: string;
  dispositionDigest: string;
  providerTarget: "hostinger_kvm2_vps";
  status: "blocked_repository_only";
  safeReason: "live_evidence_and_authorization_missing";
  totalGateCount: 39;
  metRepositoryContractCount: 3;
  blockingGateCount: 36;
  blockingGateKeys: string[];
  canContactHost: false;
  canResolveProtectedReferences: false;
  canInstallOrStartServices: false;
  canWriteConfiguration: false;
  canContactDatabase: false;
  canRunMigrations: false;
  canRunBackupOrRestore: false;
  canActivateConsumer: false;
  canDeploy: false;
  projectionDigest: string;
}

const gateSource = z.enum(["database_target", "operations_deployment", "automatic_work"]);
const gateStatus = z.enum(["met_repository_contract", "missing_live_evidence", "expired_evidence",
  "unobserved_production_proof"]);
const safeCode = z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9._:-]*$/);
const gateSchema = z.object({ gateKey: safeCode, source: gateSource, sourceGateCode: safeCode,
  evidenceClass: safeCode, status: gateStatus, sourceEvidenceDigest: digest.nullable(),
  repositoryEvidenceOnly: z.boolean(), liveEvidenceAccepted: z.literal(false), blocking: z.boolean(),
  grantsApproval: z.literal(false), grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  gateDigest: digest }).strict();
const sourcesSchema = z.object({ topology: z.unknown(), release: z.unknown(), plan: z.unknown(), assessment: z.unknown(),
  disposition: z.unknown() }).strict();
const packetInputSchema = z.object({ packetId: id, databaseTarget: z.unknown(), operations: sourcesSchema,
  preparedAt: time }).strict();
const packetSchema = z.object({ contractVersion: z.literal(OPERATIONS_POSTGRES_READINESS_CONTRACT_V1), packetId: id,
  databaseTarget: z.unknown(), operations: sourcesSchema,
  acceptedAuto040Commit: z.literal(READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1),
  acceptedAuto040ReviewSha256: z.literal(READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1),
  acceptedAuto070Commit: z.literal(READY_FRONTIER_ACCEPTED_AUTO070_COMMIT_V1),
  acceptedAuto070ReviewSha256: z.literal(READY_FRONTIER_ACCEPTED_AUTO070_REVIEW_SHA256_V1),
  databaseTargetBlockerCodes: z.array(z.enum(DATABASE_TARGET_BLOCKERS_V1)).length(12),
  operationsGateIds: z.array(z.enum(DEPLOYMENT_GATES_V1)).length(18),
  automaticWorkGateCodes: z.array(safeCode).length(9), gates: z.array(gateSchema).length(39),
  totalGateCount: z.literal(39), metRepositoryContractCount: z.literal(3), blockingGateCount: z.literal(36),
  blockingGateKeys: z.array(safeCode).length(36), state: z.literal("blocked_repository_only"),
  safeReason: z.literal("live_evidence_and_authorization_missing"), reportedHostContextUsedAsEvidence: z.literal(false),
  liveEvidenceAccepted: z.literal(false), productionValuesPresent: z.literal(false),
  credentialReferencesPresent: z.literal(false), credentialValuesPresent: z.literal(false),
  deployableConfigurationPresent: z.literal(false), eligibleForOwnerWindow: z.literal(false), productionReady: z.literal(false),
  requiresNewExactOwnerAuthorization: z.literal(true), requiresIndependentReviewBeforeLiveWork: z.literal(true),
  hostContactAuthorized: z.literal(false), databaseContactAuthorized: z.literal(false),
  serviceControlAuthorized: z.literal(false), configurationWriteAuthorized: z.literal(false),
  migrationAuthorized: z.literal(false), backupOrRestoreAuthorized: z.literal(false),
  consumerActivationAuthorized: z.literal(false), grantsApproval: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  grantsExternalEffects: z.literal(false), preparedAt: time, packetDigest: digest }).strict();
const dispositionInputSchema = z.object({ packet: z.unknown(), recordedAt: time }).strict();
const dispositionSchema = z.object({ contractVersion: z.literal(OPERATIONS_POSTGRES_READINESS_DISPOSITION_V1),
  dispositionId: id, packetId: id, packetDigest: digest, status: z.literal("disabled_before_host_contact"),
  blockingGateKeys: z.array(safeCode).length(36), safeReason: z.literal("live_evidence_and_authorization_missing"),
  recordedAt: time, newPacketRequiredAfterEvidenceChange: z.literal(true), automaticRetryAllowed: z.literal(false),
  hostContacted: z.literal(false), protectedReferenceResolved: z.literal(false),
  serviceInstalledOrStarted: z.literal(false), configurationWritten: z.literal(false), databaseContacted: z.literal(false),
  migrationAttempted: z.literal(false), backupOrRestoreAttempted: z.literal(false), consumerActivated: z.literal(false),
  deploymentAttempted: z.literal(false), externalEffectOccurred: z.literal(false), grantsApproval: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), dispositionDigest: digest }).strict();
const projectionSchema = z.object({ contractVersion: z.literal(OPERATIONS_POSTGRES_READINESS_PROJECTION_V1),
  packetId: id, packetDigest: digest, dispositionId: id, dispositionDigest: digest,
  providerTarget: z.literal("hostinger_kvm2_vps"),
  status: z.literal("blocked_repository_only"), safeReason: z.literal("live_evidence_and_authorization_missing"),
  totalGateCount: z.literal(39), metRepositoryContractCount: z.literal(3), blockingGateCount: z.literal(36),
  blockingGateKeys: z.array(safeCode).length(36), canContactHost: z.literal(false),
  canResolveProtectedReferences: z.literal(false), canInstallOrStartServices: z.literal(false),
  canWriteConfiguration: z.literal(false), canContactDatabase: z.literal(false), canRunMigrations: z.literal(false),
  canRunBackupOrRestore: z.literal(false), canActivateConsumer: z.literal(false), canDeploy: z.literal(false),
  projectionDigest: digest }).strict();

const currentOperations = buildCurrentOperationsDeploymentDisabledV1();
const CURRENT_OPERATIONS_IDENTITY_V1 = Object.freeze({
  topologyId: currentOperations.topology.topologyId,
  topologyDigest: currentOperations.topology.topologyDigest,
  releaseId: currentOperations.release.releaseId,
  releaseDigest: currentOperations.release.releaseDigest,
  planId: currentOperations.plan.planId,
  planDigest: currentOperations.plan.planDigest,
  assessmentId: currentOperations.assessment.assessmentId,
  assessmentDigest: currentOperations.assessment.assessmentDigest,
  dispositionId: currentOperations.disposition.dispositionId,
  dispositionDigest: currentOperations.disposition.dispositionDigest,
});

function copyList<T>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (let position = 0; position < values.length; position += 1) result.push(values[position]!);
  return result;
}

function blockingKeys(gates: readonly OperationsPostgresReadinessGateV1[]): string[] {
  const result: string[] = [];
  for (let position = 0; position < gates.length; position += 1) {
    if (gates[position]!.blocking) result.push(gates[position]!.gateKey);
  }
  return result;
}

function gateDigests(gates: readonly OperationsPostgresReadinessGateV1[]): string[] {
  const result: string[] = [];
  for (let position = 0; position < gates.length; position += 1) result.push(parseGate(gates[position]!).gateDigest);
  return result;
}

function parseCanonicalDatabaseTarget(value: unknown): OperationsProductionDatabaseTargetV1 {
  const target = parseOperationsProductionDatabaseTargetV1(value);
  const canonical = buildOperationsProductionDatabaseTargetV1({ decisionId: target.decisionId, decidedAt: target.decidedAt });
  if (target.decisionDigest !== canonical.decisionDigest || !sameList(target.blockers, DATABASE_TARGET_BLOCKERS_V1)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  return target;
}

function parseGate(value: unknown): OperationsPostgresReadinessGateV1 {
  const gate = parseExactOperationsV1(gateSchema, value, "operations postgres readiness gate");
  if (gate.gateKey !== `${gate.source}:${gate.sourceGateCode}`
    || gate.repositoryEvidenceOnly !== (gate.status === "met_repository_contract")
    || gate.blocking !== (gate.status !== "met_repository_contract")
    || (gate.status === "met_repository_contract" && gate.sourceEvidenceDigest === null)
    || ((gate.source === "database_target" || gate.source === "automatic_work")
      && gate.sourceEvidenceDigest !== null)) throw new OperationsContractErrorV1("scope_mismatch");
  verifyOperationsDigestV1(gate as unknown as Record<string, unknown>, "gateDigest", gate.gateDigest);
  return gate;
}

function buildGate(input: Omit<OperationsPostgresReadinessGateV1, "gateKey" | "repositoryEvidenceOnly"
  | "liveEvidenceAccepted" | "blocking" | "grantsApproval" | "grantsDeploymentAuthority"
  | "grantsExecutionAuthority" | "gateDigest">): OperationsPostgresReadinessGateV1 {
  const material: Omit<OperationsPostgresReadinessGateV1, "gateDigest"> = {
    gateKey: `${input.source}:${input.sourceGateCode}`, source: input.source, sourceGateCode: input.sourceGateCode,
    evidenceClass: input.evidenceClass, status: input.status, sourceEvidenceDigest: input.sourceEvidenceDigest,
    repositoryEvidenceOnly: input.status === "met_repository_contract", liveEvidenceAccepted: false,
    blocking: input.status !== "met_repository_contract", grantsApproval: false, grantsDeploymentAuthority: false,
    grantsExecutionAuthority: false };
  return parseGate({ ...material, gateDigest: sha256Digest(material) });
}

function parseSources(value: unknown): OperationsPostgresReadinessSourcesV1 {
  const input = parseExactOperationsV1(sourcesSchema, value, "operations postgres readiness sources");
  const topology = parseOperationsProductionTopologyV1(input.topology);
  const release = parseOperationsReleaseCandidateV1(input.release);
  const plan = parseOperationsDeploymentPlanV1(input.plan);
  const assessment = parseOperationsDeploymentReadinessAssessmentV1(input.assessment);
  const disposition = parseOperationsDeploymentDisabledDispositionV1(input.disposition);
  if (topology.topologyId !== plan.topologyId || topology.deploymentId !== plan.deploymentId
    || release.releaseId !== plan.releaseId || topology.topologyDigest !== plan.topologyDigest
    || topology.topologyDigest !== assessment.topologyDigest || release.releaseDigest !== plan.releaseDigest
    || release.releaseDigest !== assessment.releaseDigest || plan.planId !== assessment.planId
    || plan.deploymentId !== assessment.deploymentId || plan.planDigest !== assessment.planDigest
    || plan.planDigest !== disposition.planDigest || assessment.assessmentId !== disposition.assessmentId
    || assessment.deploymentId !== disposition.deploymentId
    || assessment.assessmentDigest !== disposition.assessmentDigest
    || !sameList(assessment.blockingGateIds, disposition.blockingGateIds)
    || Date.parse(release.builtAt) > Date.parse(plan.plannedAt)
    || Date.parse(topology.createdAt) > Date.parse(release.builtAt)
    || Date.parse(plan.plannedAt) > Date.parse(assessment.assessedAt)
    || Date.parse(assessment.assessedAt) > Date.parse(disposition.recordedAt)
    || Date.parse(assessment.assessedAt) >= Date.parse(plan.expiresAt)
    || topology.topologyId !== CURRENT_OPERATIONS_IDENTITY_V1.topologyId
    || topology.topologyDigest !== CURRENT_OPERATIONS_IDENTITY_V1.topologyDigest
    || release.releaseId !== CURRENT_OPERATIONS_IDENTITY_V1.releaseId
    || release.releaseDigest !== CURRENT_OPERATIONS_IDENTITY_V1.releaseDigest
    || plan.planId !== CURRENT_OPERATIONS_IDENTITY_V1.planId
    || plan.planDigest !== CURRENT_OPERATIONS_IDENTITY_V1.planDigest
    || assessment.assessmentId !== CURRENT_OPERATIONS_IDENTITY_V1.assessmentId
    || assessment.assessmentDigest !== CURRENT_OPERATIONS_IDENTITY_V1.assessmentDigest
    || disposition.dispositionId !== CURRENT_OPERATIONS_IDENTITY_V1.dispositionId
    || disposition.dispositionDigest !== CURRENT_OPERATIONS_IDENTITY_V1.dispositionDigest
    || assessment.readiness !== "blocked" || disposition.status !== "disabled_before_change") {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const met: OperationsDeploymentGateIdV1[] = [];
  for (let position = 0; position < assessment.prerequisites.length; position += 1) {
    const prerequisite = assessment.prerequisites[position]!;
    if (prerequisite.state === "met") met.push(prerequisite.gateId);
  }
  if (!sameList(met, OPERATIONS_POSTGRES_READINESS_REPOSITORY_MET_GATES_V1)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  return { topology, release, plan, assessment, disposition };
}

function buildGates(target: OperationsProductionDatabaseTargetV1,
  operations: OperationsPostgresReadinessSourcesV1): OperationsPostgresReadinessGateV1[] {
  const gates: OperationsPostgresReadinessGateV1[] = [];
  for (const sourceGateCode of target.blockers) gates.push(buildGate({ source: "database_target", sourceGateCode,
    evidenceClass: "production_database_target_prerequisite", status: "missing_live_evidence", sourceEvidenceDigest: null }));
  for (const prerequisite of operations.assessment.prerequisites) gates.push(buildGate({ source: "operations_deployment",
    sourceGateCode: prerequisite.gateId, evidenceClass: prerequisite.evidenceClass,
    status: prerequisite.state === "met" ? "met_repository_contract"
      : prerequisite.state === "expired" ? "expired_evidence" : "missing_live_evidence",
    sourceEvidenceDigest: prerequisite.evidenceDigest ?? null }));
  for (let position = 0; position < AUTOMATIC_WORK_GATES_V1.length; position += 1) {
    gates.push(buildGate({ source: "automatic_work", sourceGateCode: AUTOMATIC_WORK_GATES_V1[position]!,
      evidenceClass: AUTOMATIC_WORK_EVIDENCE_CLASSES_V1[position]!, status: "unobserved_production_proof",
      sourceEvidenceDigest: null }));
  }
  return gates;
}

export function buildOperationsPostgresReadinessPacketV1(inputValue: unknown): OperationsPostgresReadinessPacketV1 {
  const input = parseExactOperationsV1(packetInputSchema, inputValue, "operations postgres readiness packet input");
  const databaseTarget = parseCanonicalDatabaseTarget(input.databaseTarget);
  const operations = parseSources(input.operations);
  if (Date.parse(input.preparedAt) < Date.parse(databaseTarget.decidedAt)
    || Date.parse(input.preparedAt) < Date.parse(operations.assessment.assessedAt)
    || Date.parse(input.preparedAt) < Date.parse(operations.disposition.recordedAt)) {
    throw new OperationsContractErrorV1("invalid_input");
  }
  const gates = buildGates(databaseTarget, operations);
  const blockingGateKeys = blockingKeys(gates);
  const material: Omit<OperationsPostgresReadinessPacketV1, "packetDigest"> = {
    contractVersion: OPERATIONS_POSTGRES_READINESS_CONTRACT_V1, packetId: input.packetId, databaseTarget, operations,
    acceptedAuto040Commit: READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1,
    acceptedAuto040ReviewSha256: READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1,
    acceptedAuto070Commit: READY_FRONTIER_ACCEPTED_AUTO070_COMMIT_V1,
    acceptedAuto070ReviewSha256: READY_FRONTIER_ACCEPTED_AUTO070_REVIEW_SHA256_V1,
    databaseTargetBlockerCodes: copyList(DATABASE_TARGET_BLOCKERS_V1),
    operationsGateIds: copyList(DEPLOYMENT_GATES_V1),
    automaticWorkGateCodes: copyList(AUTOMATIC_WORK_GATES_V1), gates,
    totalGateCount: 39, metRepositoryContractCount: 3, blockingGateCount: 36, blockingGateKeys,
    state: "blocked_repository_only", safeReason: "live_evidence_and_authorization_missing",
    reportedHostContextUsedAsEvidence: false, liveEvidenceAccepted: false, productionValuesPresent: false,
    credentialReferencesPresent: false, credentialValuesPresent: false, deployableConfigurationPresent: false,
    eligibleForOwnerWindow: false, productionReady: false, requiresNewExactOwnerAuthorization: true,
    requiresIndependentReviewBeforeLiveWork: true, hostContactAuthorized: false, databaseContactAuthorized: false,
    serviceControlAuthorized: false, configurationWriteAuthorized: false, migrationAuthorized: false,
    backupOrRestoreAuthorized: false, consumerActivationAuthorized: false, grantsApproval: false,
    grantsDeploymentAuthority: false, grantsExecutionAuthority: false, grantsExternalEffects: false,
    preparedAt: input.preparedAt };
  return parseOperationsPostgresReadinessPacketV1({ ...material, packetDigest: sha256Digest(material) });
}

export function parseOperationsPostgresReadinessPacketV1(value: unknown): OperationsPostgresReadinessPacketV1 {
  const packet = parseExactOperationsV1(packetSchema, value,
    "operations postgres readiness packet") as unknown as OperationsPostgresReadinessPacketV1;
  const databaseTarget = parseCanonicalDatabaseTarget(packet.databaseTarget);
  const operations = parseSources(packet.operations);
  const expectedGates = buildGates(databaseTarget, operations);
  const blockers = blockingKeys(expectedGates);
  if (!sameList(packet.databaseTargetBlockerCodes, DATABASE_TARGET_BLOCKERS_V1)
    || !sameList(packet.operationsGateIds, DEPLOYMENT_GATES_V1)
    || !sameList(packet.automaticWorkGateCodes, AUTOMATIC_WORK_GATES_V1)
    || !sameList(gateDigests(packet.gates), gateDigests(expectedGates))
    || !sameList(packet.blockingGateKeys, blockers)
    || Date.parse(packet.preparedAt) < Date.parse(databaseTarget.decidedAt)
    || Date.parse(packet.preparedAt) < Date.parse(operations.assessment.assessedAt)
    || Date.parse(packet.preparedAt) < Date.parse(operations.disposition.recordedAt)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(packet as unknown as Record<string, unknown>, "packetDigest", packet.packetDigest);
  return packet;
}

export function buildOperationsPostgresReadinessDispositionV1(inputValue: unknown): OperationsPostgresReadinessDispositionV1 {
  const input = parseExactOperationsV1(dispositionInputSchema, inputValue,
    "operations postgres readiness disposition input");
  const packet = parseOperationsPostgresReadinessPacketV1(input.packet);
  if (Date.parse(input.recordedAt) < Date.parse(packet.preparedAt)) throw new OperationsContractErrorV1("invalid_input");
  const material: Omit<OperationsPostgresReadinessDispositionV1, "dispositionDigest"> = {
    contractVersion: OPERATIONS_POSTGRES_READINESS_DISPOSITION_V1,
    dispositionId: `disposition:operations:postgres-readiness:${packet.packetDigest.slice(7, 31)}`,
    packetId: packet.packetId, packetDigest: packet.packetDigest, status: "disabled_before_host_contact",
    blockingGateKeys: copyList(packet.blockingGateKeys), safeReason: "live_evidence_and_authorization_missing",
    recordedAt: input.recordedAt, newPacketRequiredAfterEvidenceChange: true, automaticRetryAllowed: false,
    hostContacted: false, protectedReferenceResolved: false, serviceInstalledOrStarted: false,
    configurationWritten: false, databaseContacted: false, migrationAttempted: false,
    backupOrRestoreAttempted: false, consumerActivated: false, deploymentAttempted: false,
    externalEffectOccurred: false, grantsApproval: false, grantsDeploymentAuthority: false,
    grantsExecutionAuthority: false };
  return parseOperationsPostgresReadinessDispositionV1({ ...material, dispositionDigest: sha256Digest(material) }, packet);
}

export function parseOperationsPostgresReadinessDispositionV1(value: unknown, packetValue: unknown):
  OperationsPostgresReadinessDispositionV1 {
  const packet = parseOperationsPostgresReadinessPacketV1(packetValue);
  const disposition = parseExactOperationsV1(dispositionSchema, value, "operations postgres readiness disposition");
  if (disposition.dispositionId !== `disposition:operations:postgres-readiness:${packet.packetDigest.slice(7, 31)}`
    || disposition.packetId !== packet.packetId || disposition.packetDigest !== packet.packetDigest
    || !sameList(disposition.blockingGateKeys, packet.blockingGateKeys)
    || Date.parse(disposition.recordedAt) < Date.parse(packet.preparedAt)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(disposition as unknown as Record<string, unknown>, "dispositionDigest",
    disposition.dispositionDigest);
  return disposition;
}

export function projectOperationsPostgresReadinessV1(packetValue: unknown, dispositionValue: unknown):
  OperationsPostgresReadinessProjectionV1 {
  const packet = parseOperationsPostgresReadinessPacketV1(packetValue);
  const disposition = parseOperationsPostgresReadinessDispositionV1(dispositionValue, packet);
  const material: Omit<OperationsPostgresReadinessProjectionV1, "projectionDigest"> = {
    contractVersion: OPERATIONS_POSTGRES_READINESS_PROJECTION_V1, packetId: packet.packetId,
    packetDigest: packet.packetDigest, dispositionId: disposition.dispositionId,
    dispositionDigest: disposition.dispositionDigest, providerTarget: packet.databaseTarget.providerTarget,
    status: packet.state, safeReason: packet.safeReason, totalGateCount: 39, metRepositoryContractCount: 3,
    blockingGateCount: 36, blockingGateKeys: copyList(packet.blockingGateKeys), canContactHost: false,
    canResolveProtectedReferences: false, canInstallOrStartServices: false, canWriteConfiguration: false,
    canContactDatabase: false, canRunMigrations: false, canRunBackupOrRestore: false,
    canActivateConsumer: false, canDeploy: false };
  return parseOperationsPostgresReadinessProjectionV1({ ...material, projectionDigest: sha256Digest(material) },
    packet, disposition);
}

export function parseOperationsPostgresReadinessProjectionV1(value: unknown, packetValue: unknown,
  dispositionValue: unknown): OperationsPostgresReadinessProjectionV1 {
  const packet = parseOperationsPostgresReadinessPacketV1(packetValue);
  const disposition = parseOperationsPostgresReadinessDispositionV1(dispositionValue, packet);
  const projection = parseExactOperationsV1(projectionSchema, value, "operations postgres readiness projection");
  if (projection.packetId !== packet.packetId || projection.packetDigest !== packet.packetDigest
    || projection.dispositionId !== disposition.dispositionId
    || projection.dispositionDigest !== disposition.dispositionDigest
    || projection.providerTarget !== packet.databaseTarget.providerTarget
    || !sameList(projection.blockingGateKeys, packet.blockingGateKeys)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(projection as unknown as Record<string, unknown>, "projectionDigest",
    projection.projectionDigest);
  return projection;
}
