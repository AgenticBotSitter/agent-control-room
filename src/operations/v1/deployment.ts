import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import { buildOperationsSyntheticTopologyFixtureV1, parseOperationsProductionTopologyV1,
  type OperationsProductionTopologyV1 } from "./topology";

export const OPERATIONS_DEPLOYMENT_CONTRACT_V1 = "control-room-operations-deployment/v1" as const;
export const OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1 = sha256Digest({
  contractVersion: "control-room-operations-health/v1",
  evidence: "exact-health-readiness-contract",
});
export const OPERATIONS_DEPLOYMENT_GATE_IDS_V1 = [
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
] as const;
export type OperationsDeploymentGateIdV1 = (typeof OPERATIONS_DEPLOYMENT_GATE_IDS_V1)[number];

export interface OperationsReleaseCandidateV1 {
  contractVersion: typeof OPERATIONS_DEPLOYMENT_CONTRACT_V1;
  releaseId: string;
  version: string;
  sourceRevisionDigest: string;
  applicationArtifactDigest: string;
  migrationBundleDigest: string;
  publicAssetsDigest: string;
  lockfileDigest: string;
  sbomDigest: string;
  provenanceDigest: string;
  signatureEvidenceDigest: string;
  configurationSchemaDigest: string;
  protocolCompatibilityDigest: string;
  rollbackCompatibilityDigest: string;
  state: "candidate_references_only";
  artifactBytesPresent: false;
  productionConfigurationPresent: false;
  credentialValuesPresent: false;
  verifiedAtRuntime: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  builtAt: string;
  releaseDigest: string;
}

export interface OperationsDeploymentPlanV1 {
  contractVersion: typeof OPERATIONS_DEPLOYMENT_CONTRACT_V1;
  planId: string;
  deploymentId: string;
  topologyId: string;
  topologyDigest: string;
  releaseId: string;
  releaseDigest: string;
  previousReleaseDigest?: string;
  operation: "operations.deploy_release_candidate";
  operationDigest: string;
  deploymentIdempotencyKey: string;
  strategy: "one_host_canary_then_owner_promotion";
  canaryHostLimit: 1;
  migrationPolicy: "forward_only_separate_runner";
  preChangeBackupRequired: true;
  walArchiveContinuityRequired: true;
  cleanRestoreEvidenceRequired: true;
  independentHealthEvidenceRequired: true;
  freshStrongOwnerApprovalRequired: true;
  automaticPromotionAllowed: false;
  automaticRollbackAllowed: false;
  databaseDownMigrationAllowed: false;
  postChangeUnknown: "terminal_ambiguity";
  automaticRetryAfterChange: false;
  deploymentAuthorized: false;
  configurationWriteAllowed: false;
  serviceControlAllowed: false;
  networkChangeAllowed: false;
  databaseMutationAllowed: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  plannedAt: string;
  expiresAt: string;
  planDigest: string;
}

export interface OperationsDeploymentPrerequisiteV1 {
  contractVersion: typeof OPERATIONS_DEPLOYMENT_CONTRACT_V1;
  gateId: OperationsDeploymentGateIdV1;
  evidenceClass: string;
  state: "met" | "missing" | "expired";
  evidenceDigest?: string;
  checkedAt: string;
  validUntil?: string;
  safeReasonCode: string;
  authoritativeEvidenceRequired: true;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  prerequisiteDigest: string;
}

export interface OperationsDeploymentReadinessAssessmentV1 {
  contractVersion: typeof OPERATIONS_DEPLOYMENT_CONTRACT_V1;
  assessmentId: string;
  deploymentId: string;
  planId: string;
  planDigest: string;
  topologyDigest: string;
  releaseDigest: string;
  prerequisites: OperationsDeploymentPrerequisiteV1[];
  blockingGateIds: OperationsDeploymentGateIdV1[];
  readiness: "blocked" | "candidate_for_owner_window";
  eligibleForOwnerWindow: boolean;
  assessedAt: string;
  requiresFreshStrongApproval: true;
  requiresSeparateDeploymentAttestation: true;
  requiresIndependentCheckpoint: true;
  deploymentAuthorized: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  assessmentDigest: string;
}

export interface OperationsDeploymentDisabledDispositionV1 {
  contractVersion: typeof OPERATIONS_DEPLOYMENT_CONTRACT_V1;
  dispositionId: string;
  deploymentId: string;
  assessmentId: string;
  assessmentDigest: string;
  planDigest: string;
  status: "disabled_before_change";
  blockingGateIds: OperationsDeploymentGateIdV1[];
  safeReasonCode: "required_evidence_missing";
  recordedAt: string;
  requiresNewAssessmentAndAuthorization: true;
  automaticRetryAllowed: false;
  deploymentAttempted: false;
  serviceControlAttempted: false;
  configurationWritten: false;
  credentialResolutionObserved: false;
  networkOrDnsChanged: false;
  databaseMigrationAttempted: false;
  backupOrRestoreAttempted: false;
  canaryStarted: false;
  trafficChanged: false;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  dispositionDigest: string;
}

export type OperationsDeploymentStateV1 = "planned" | "readiness_candidate" | "canary_pending" | "canary_observing"
  | "promotion_pending" | "active" | "rollback_pending" | "rolled_back" | "failed_before_change" | "ambiguous";
export type OperationsDeploymentEventV1 = "readiness_confirmed" | "owner_window_opened" | "canary_started"
  | "canary_observation_passed" | "canary_observation_failed" | "canary_observation_unknown" | "promotion_approved"
  | "deployment_verified" | "rollback_requested" | "rollback_verified" | "definite_prechange_failure" | "post_change_unknown";
export interface OperationsDeploymentTransitionDecisionV1 {
  contractVersion: typeof OPERATIONS_DEPLOYMENT_CONTRACT_V1;
  fromState: OperationsDeploymentStateV1;
  event: OperationsDeploymentEventV1;
  toState?: OperationsDeploymentStateV1;
  permittedByStateMachine: boolean;
  requiresExternalAuthority: boolean;
  automaticRetryAllowed: false;
  performsAction: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  decisionDigest: string;
}

const releaseInputSchema = z.object({ releaseId: id, version: z.string().min(1).max(40).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/),
  sourceRevisionDigest: digest, applicationArtifactDigest: digest, migrationBundleDigest: digest, publicAssetsDigest: digest,
  lockfileDigest: digest, sbomDigest: digest, provenanceDigest: digest, signatureEvidenceDigest: digest,
  configurationSchemaDigest: digest, protocolCompatibilityDigest: digest, rollbackCompatibilityDigest: digest,
  builtAt: time }).strict();
const releaseSchema = z.object({ contractVersion: z.literal(OPERATIONS_DEPLOYMENT_CONTRACT_V1), releaseId: id,
  version: z.string().min(1).max(40).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/), sourceRevisionDigest: digest, applicationArtifactDigest: digest,
  migrationBundleDigest: digest, publicAssetsDigest: digest, lockfileDigest: digest, sbomDigest: digest, provenanceDigest: digest,
  signatureEvidenceDigest: digest, configurationSchemaDigest: digest, protocolCompatibilityDigest: digest,
  rollbackCompatibilityDigest: digest, state: z.literal("candidate_references_only"), artifactBytesPresent: z.literal(false),
  productionConfigurationPresent: z.literal(false), credentialValuesPresent: z.literal(false), verifiedAtRuntime: z.literal(false),
  grantsApproval: z.literal(false), grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  builtAt: time, releaseDigest: digest }).strict();
const planInputSchema = z.object({ planId: id, topology: z.unknown(), release: z.unknown(), previousReleaseDigest: digest.optional(),
  plannedAt: time, expiresAt: time }).strict();
const planSchema = z.object({ contractVersion: z.literal(OPERATIONS_DEPLOYMENT_CONTRACT_V1), planId: id, deploymentId: id,
  topologyId: id, topologyDigest: digest, releaseId: id, releaseDigest: digest, previousReleaseDigest: digest.optional(),
  operation: z.literal("operations.deploy_release_candidate"), operationDigest: digest, deploymentIdempotencyKey: digest,
  strategy: z.literal("one_host_canary_then_owner_promotion"), canaryHostLimit: z.literal(1),
  migrationPolicy: z.literal("forward_only_separate_runner"), preChangeBackupRequired: z.literal(true),
  walArchiveContinuityRequired: z.literal(true), cleanRestoreEvidenceRequired: z.literal(true),
  independentHealthEvidenceRequired: z.literal(true), freshStrongOwnerApprovalRequired: z.literal(true),
  automaticPromotionAllowed: z.literal(false), automaticRollbackAllowed: z.literal(false),
  databaseDownMigrationAllowed: z.literal(false), postChangeUnknown: z.literal("terminal_ambiguity"),
  automaticRetryAfterChange: z.literal(false), deploymentAuthorized: z.literal(false), configurationWriteAllowed: z.literal(false),
  serviceControlAllowed: z.literal(false), networkChangeAllowed: z.literal(false), databaseMutationAllowed: z.literal(false),
  grantsApproval: z.literal(false), grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  plannedAt: time, expiresAt: time, planDigest: digest }).strict();
const gate = z.enum(OPERATIONS_DEPLOYMENT_GATE_IDS_V1);
const prerequisiteInputSchema = z.object({ gateId: gate, state: z.enum(["met", "missing", "expired"]),
  evidenceDigest: digest.optional(), checkedAt: time, validUntil: time.optional(), safeReasonCode: id }).strict();
const prerequisiteSchema = z.object({ contractVersion: z.literal(OPERATIONS_DEPLOYMENT_CONTRACT_V1), gateId: gate,
  evidenceClass: id, state: z.enum(["met", "missing", "expired"]), evidenceDigest: digest.optional(), checkedAt: time,
  validUntil: time.optional(), safeReasonCode: id, authoritativeEvidenceRequired: z.literal(true), grantsApproval: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), prerequisiteDigest: digest }).strict();
const assessmentInputSchema = z.object({ assessmentId: id, plan: z.unknown(), prerequisites: z.array(z.unknown()).length(18),
  assessedAt: time }).strict();
const assessmentSchema = z.object({ contractVersion: z.literal(OPERATIONS_DEPLOYMENT_CONTRACT_V1), assessmentId: id,
  deploymentId: id, planId: id, planDigest: digest, topologyDigest: digest, releaseDigest: digest,
  prerequisites: z.array(prerequisiteSchema).length(18), blockingGateIds: z.array(gate).max(18),
  readiness: z.enum(["blocked", "candidate_for_owner_window"]), eligibleForOwnerWindow: z.boolean(), assessedAt: time,
  requiresFreshStrongApproval: z.literal(true), requiresSeparateDeploymentAttestation: z.literal(true),
  requiresIndependentCheckpoint: z.literal(true), deploymentAuthorized: z.literal(false), grantsApproval: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), assessmentDigest: digest }).strict();
const dispositionInputSchema = z.object({ assessment: z.unknown(), recordedAt: time }).strict();
const dispositionSchema = z.object({ contractVersion: z.literal(OPERATIONS_DEPLOYMENT_CONTRACT_V1), dispositionId: id,
  deploymentId: id, assessmentId: id, assessmentDigest: digest, planDigest: digest, status: z.literal("disabled_before_change"),
  blockingGateIds: z.array(gate).min(1).max(18), safeReasonCode: z.literal("required_evidence_missing"), recordedAt: time,
  requiresNewAssessmentAndAuthorization: z.literal(true), automaticRetryAllowed: z.literal(false),
  deploymentAttempted: z.literal(false), serviceControlAttempted: z.literal(false), configurationWritten: z.literal(false),
  credentialResolutionObserved: z.literal(false), networkOrDnsChanged: z.literal(false),
  databaseMigrationAttempted: z.literal(false), backupOrRestoreAttempted: z.literal(false), canaryStarted: z.literal(false),
  trafficChanged: z.literal(false), externalEffectOccurred: z.literal(false), grantsApproval: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), dispositionDigest: digest }).strict();

const evidenceClass: Record<OperationsDeploymentGateIdV1, string> = {
  topology_contract: "production_topology",
  release_identity: "immutable_release_identity",
  release_signature: "release_signature_attestation",
  provenance_attestation: "build_provenance_attestation",
  sbom_policy: "sbom_policy_result",
  configuration_schema: "configuration_schema_compatibility",
  credential_reference_custody: "credential_reference_custody",
  edge_access_policy: "protected_edge_access_policy",
  database_backup_freshness: "database_backup_freshness",
  wal_archiving_health: "wal_archiving_health",
  restore_rehearsal: "clean_restore_rehearsal",
  migration_compatibility: "migration_compatibility",
  rollback_material: "rollback_material",
  health_probe_contract: "health_probe_contract",
  resource_headroom: "resource_headroom",
  monitoring_alert_path: "monitoring_alert_path",
  audit_anchor_freshness: "audit_anchor_freshness",
  fresh_owner_window: "owner_approval_window",
};
const volatileGates = new Set<OperationsDeploymentGateIdV1>(["credential_reference_custody", "edge_access_policy",
  "database_backup_freshness", "wal_archiving_health", "resource_headroom", "monitoring_alert_path",
  "audit_anchor_freshness", "fresh_owner_window"]);

export function buildOperationsReleaseCandidateV1(inputValue: unknown): OperationsReleaseCandidateV1 {
  const input = parseExactOperationsV1(releaseInputSchema, inputValue, "operations release candidate input");
  const material: Omit<OperationsReleaseCandidateV1, "releaseDigest"> = { contractVersion: OPERATIONS_DEPLOYMENT_CONTRACT_V1,
    ...input, state: "candidate_references_only", artifactBytesPresent: false, productionConfigurationPresent: false,
    credentialValuesPresent: false, verifiedAtRuntime: false, grantsApproval: false, grantsDeploymentAuthority: false,
    grantsExecutionAuthority: false };
  return parseOperationsReleaseCandidateV1({ ...material, releaseDigest: sha256Digest(material) });
}

export function parseOperationsReleaseCandidateV1(value: unknown): OperationsReleaseCandidateV1 {
  const parsed = parseExactOperationsV1(releaseSchema, value, "operations release candidate");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "releaseDigest", parsed.releaseDigest);
  return parsed;
}

export function buildOperationsDeploymentPlanV1(inputValue: unknown): OperationsDeploymentPlanV1 {
  const input = parseExactOperationsV1(planInputSchema, inputValue, "operations deployment plan input"),
    topology = parseOperationsProductionTopologyV1(input.topology), release = parseOperationsReleaseCandidateV1(input.release);
  if (release.configurationSchemaDigest !== topology.services[1]!.configurationSchemaDigest
    || release.applicationArtifactDigest !== topology.services[1]!.artifactIdentityDigest
    || release.migrationBundleDigest !== topology.services[2]!.artifactIdentityDigest
    || release.publicAssetsDigest !== topology.services[0]!.artifactIdentityDigest
    || Date.parse(input.expiresAt) <= Date.parse(input.plannedAt)) throw new OperationsContractErrorV1("scope_mismatch");
  const operationMaterial = { operation: "operations.deploy_release_candidate", deploymentId: topology.deploymentId,
    topologyDigest: topology.topologyDigest, releaseDigest: release.releaseDigest,
    ...(input.previousReleaseDigest ? { previousReleaseDigest: input.previousReleaseDigest } : {}) };
  const operationDigest = sha256Digest(operationMaterial);
  const material: Omit<OperationsDeploymentPlanV1, "planDigest"> = { contractVersion: OPERATIONS_DEPLOYMENT_CONTRACT_V1,
    planId: input.planId, deploymentId: topology.deploymentId, topologyId: topology.topologyId,
    topologyDigest: topology.topologyDigest, releaseId: release.releaseId, releaseDigest: release.releaseDigest,
    ...(input.previousReleaseDigest ? { previousReleaseDigest: input.previousReleaseDigest } : {}),
    operation: "operations.deploy_release_candidate", operationDigest,
    deploymentIdempotencyKey: sha256Digest({ deploymentId: topology.deploymentId, topologyDigest: topology.topologyDigest,
      releaseDigest: release.releaseDigest }), strategy: "one_host_canary_then_owner_promotion", canaryHostLimit: 1,
    migrationPolicy: "forward_only_separate_runner", preChangeBackupRequired: true, walArchiveContinuityRequired: true,
    cleanRestoreEvidenceRequired: true, independentHealthEvidenceRequired: true, freshStrongOwnerApprovalRequired: true,
    automaticPromotionAllowed: false, automaticRollbackAllowed: false, databaseDownMigrationAllowed: false,
    postChangeUnknown: "terminal_ambiguity", automaticRetryAfterChange: false, deploymentAuthorized: false,
    configurationWriteAllowed: false, serviceControlAllowed: false, networkChangeAllowed: false, databaseMutationAllowed: false,
    grantsApproval: false, grantsDeploymentAuthority: false, grantsExecutionAuthority: false,
    plannedAt: input.plannedAt, expiresAt: input.expiresAt };
  return parseOperationsDeploymentPlanV1({ ...material, planDigest: sha256Digest(material) });
}

export function parseOperationsDeploymentPlanV1(value: unknown): OperationsDeploymentPlanV1 {
  const parsed = parseExactOperationsV1(planSchema, value, "operations deployment plan");
  const operationMaterial = { operation: parsed.operation, deploymentId: parsed.deploymentId,
    topologyDigest: parsed.topologyDigest, releaseDigest: parsed.releaseDigest,
    ...(parsed.previousReleaseDigest ? { previousReleaseDigest: parsed.previousReleaseDigest } : {}) };
  if (parsed.operationDigest !== sha256Digest(operationMaterial)
    || parsed.deploymentIdempotencyKey !== sha256Digest({ deploymentId: parsed.deploymentId,
      topologyDigest: parsed.topologyDigest, releaseDigest: parsed.releaseDigest })
    || Date.parse(parsed.expiresAt) <= Date.parse(parsed.plannedAt)) throw new OperationsContractErrorV1("digest_mismatch");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "planDigest", parsed.planDigest);
  return parsed;
}

export function buildOperationsDeploymentPrerequisiteV1(inputValue: unknown): OperationsDeploymentPrerequisiteV1 {
  const input = parseExactOperationsV1(prerequisiteInputSchema, inputValue, "operations deployment prerequisite input");
  if ((input.state === "missing" && (input.evidenceDigest || input.validUntil))
    || (input.state !== "missing" && !input.evidenceDigest)
    || (input.state === "expired" && (!input.validUntil || Date.parse(input.validUntil) > Date.parse(input.checkedAt)))
    || (input.state === "met" && input.validUntil && Date.parse(input.validUntil) <= Date.parse(input.checkedAt))
    || (input.state === "met" && volatileGates.has(input.gateId) && !input.validUntil)) {
    throw new OperationsContractErrorV1("invalid_input");
  }
  const material: Omit<OperationsDeploymentPrerequisiteV1, "prerequisiteDigest"> = {
    contractVersion: OPERATIONS_DEPLOYMENT_CONTRACT_V1, gateId: input.gateId, evidenceClass: evidenceClass[input.gateId],
    state: input.state, ...(input.evidenceDigest ? { evidenceDigest: input.evidenceDigest } : {}), checkedAt: input.checkedAt,
    ...(input.validUntil ? { validUntil: input.validUntil } : {}), safeReasonCode: input.safeReasonCode,
    authoritativeEvidenceRequired: true, grantsApproval: false, grantsDeploymentAuthority: false };
  return parseOperationsDeploymentPrerequisiteV1({ ...material, prerequisiteDigest: sha256Digest(material) });
}

export function parseOperationsDeploymentPrerequisiteV1(value: unknown): OperationsDeploymentPrerequisiteV1 {
  const parsed = parseExactOperationsV1(prerequisiteSchema, value, "operations deployment prerequisite");
  if (parsed.evidenceClass !== evidenceClass[parsed.gateId]
    || (parsed.state === "missing" && (parsed.evidenceDigest || parsed.validUntil))
    || (parsed.state !== "missing" && !parsed.evidenceDigest)
    || (parsed.state === "met" && volatileGates.has(parsed.gateId) && !parsed.validUntil)
    || (parsed.state === "met" && parsed.validUntil && Date.parse(parsed.validUntil) <= Date.parse(parsed.checkedAt))
    || (parsed.state === "expired" && (!parsed.validUntil || Date.parse(parsed.validUntil) > Date.parse(parsed.checkedAt)))) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "prerequisiteDigest", parsed.prerequisiteDigest);
  return parsed;
}

export function buildOperationsDeploymentReadinessAssessmentV1(inputValue: unknown): OperationsDeploymentReadinessAssessmentV1 {
  const input = parseExactOperationsV1(assessmentInputSchema, inputValue, "operations deployment assessment input"),
    plan = parseOperationsDeploymentPlanV1(input.plan), prerequisites = input.prerequisites.map(parseOperationsDeploymentPrerequisiteV1);
  if (prerequisites.map((item) => item.gateId).join("|") !== OPERATIONS_DEPLOYMENT_GATE_IDS_V1.join("|")
    || prerequisites[0]!.evidenceDigest !== plan.topologyDigest || prerequisites[1]!.evidenceDigest !== plan.releaseDigest
    || (prerequisites[13]!.state === "met" && prerequisites[13]!.evidenceDigest !== OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const blockingGateIds = prerequisites.filter((item) => item.state !== "met").map((item) => item.gateId),
    candidate = blockingGateIds.length === 0;
  const material: Omit<OperationsDeploymentReadinessAssessmentV1, "assessmentDigest"> = {
    contractVersion: OPERATIONS_DEPLOYMENT_CONTRACT_V1, assessmentId: input.assessmentId,
    deploymentId: plan.deploymentId, planId: plan.planId, planDigest: plan.planDigest, topologyDigest: plan.topologyDigest,
    releaseDigest: plan.releaseDigest, prerequisites, blockingGateIds,
    readiness: candidate ? "candidate_for_owner_window" : "blocked", eligibleForOwnerWindow: candidate,
    assessedAt: input.assessedAt, requiresFreshStrongApproval: true, requiresSeparateDeploymentAttestation: true,
    requiresIndependentCheckpoint: true, deploymentAuthorized: false, grantsApproval: false,
    grantsDeploymentAuthority: false, grantsExecutionAuthority: false };
  return parseOperationsDeploymentReadinessAssessmentV1({ ...material, assessmentDigest: sha256Digest(material) });
}

export function parseOperationsDeploymentReadinessAssessmentV1(value: unknown): OperationsDeploymentReadinessAssessmentV1 {
  const parsed = parseExactOperationsV1(assessmentSchema, value, "operations deployment readiness assessment"),
    prerequisites = parsed.prerequisites.map(parseOperationsDeploymentPrerequisiteV1),
    blockers = prerequisites.filter((item) => item.state !== "met").map((item) => item.gateId), candidate = blockers.length === 0;
  if (prerequisites.map((item) => item.gateId).join("|") !== OPERATIONS_DEPLOYMENT_GATE_IDS_V1.join("|")
    || blockers.join("|") !== parsed.blockingGateIds.join("|")
    || (parsed.readiness === "candidate_for_owner_window") !== candidate || parsed.eligibleForOwnerWindow !== candidate
    || prerequisites[0]!.evidenceDigest !== parsed.topologyDigest || prerequisites[1]!.evidenceDigest !== parsed.releaseDigest
    || (prerequisites[13]!.state === "met" && prerequisites[13]!.evidenceDigest !== OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "assessmentDigest", parsed.assessmentDigest);
  return parsed;
}

export function buildOperationsDeploymentDisabledDispositionV1(inputValue: unknown): OperationsDeploymentDisabledDispositionV1 {
  const input = parseExactOperationsV1(dispositionInputSchema, inputValue, "operations deployment disposition input"),
    assessment = parseOperationsDeploymentReadinessAssessmentV1(input.assessment);
  if (assessment.readiness !== "blocked" || !assessment.blockingGateIds.length
    || Date.parse(input.recordedAt) < Date.parse(assessment.assessedAt)) throw new OperationsContractErrorV1("unsupported_action");
  const material: Omit<OperationsDeploymentDisabledDispositionV1, "dispositionDigest"> = {
    contractVersion: OPERATIONS_DEPLOYMENT_CONTRACT_V1,
    dispositionId: `disposition:operations:deployment:${assessment.assessmentDigest.slice(7, 31)}`,
    deploymentId: assessment.deploymentId, assessmentId: assessment.assessmentId, assessmentDigest: assessment.assessmentDigest,
    planDigest: assessment.planDigest, status: "disabled_before_change", blockingGateIds: assessment.blockingGateIds,
    safeReasonCode: "required_evidence_missing", recordedAt: input.recordedAt,
    requiresNewAssessmentAndAuthorization: true, automaticRetryAllowed: false, deploymentAttempted: false,
    serviceControlAttempted: false, configurationWritten: false, credentialResolutionObserved: false,
    networkOrDnsChanged: false, databaseMigrationAttempted: false, backupOrRestoreAttempted: false,
    canaryStarted: false, trafficChanged: false, externalEffectOccurred: false, grantsApproval: false,
    grantsDeploymentAuthority: false, grantsExecutionAuthority: false };
  return parseOperationsDeploymentDisabledDispositionV1({ ...material, dispositionDigest: sha256Digest(material) });
}

export function parseOperationsDeploymentDisabledDispositionV1(value: unknown): OperationsDeploymentDisabledDispositionV1 {
  const parsed = parseExactOperationsV1(dispositionSchema, value, "operations deployment disabled disposition");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "dispositionDigest", parsed.dispositionDigest);
  return parsed;
}

const transitions = new Map<string, OperationsDeploymentStateV1>([
  ["planned|readiness_confirmed", "readiness_candidate"],
  ["readiness_candidate|owner_window_opened", "canary_pending"],
  ["canary_pending|canary_started", "canary_observing"],
  ["canary_observing|canary_observation_passed", "promotion_pending"],
  ["canary_observing|canary_observation_failed", "rollback_pending"],
  ["canary_observing|canary_observation_unknown", "ambiguous"],
  ["promotion_pending|promotion_approved", "active"],
  ["active|deployment_verified", "active"],
  ["active|rollback_requested", "rollback_pending"],
  ["rollback_pending|rollback_verified", "rolled_back"],
  ["planned|definite_prechange_failure", "failed_before_change"],
  ["readiness_candidate|definite_prechange_failure", "failed_before_change"],
  ["canary_pending|definite_prechange_failure", "failed_before_change"],
  ["canary_pending|post_change_unknown", "ambiguous"],
  ["canary_observing|post_change_unknown", "ambiguous"],
  ["promotion_pending|post_change_unknown", "ambiguous"],
  ["rollback_pending|post_change_unknown", "ambiguous"],
]);

export function evaluateOperationsDeploymentTransitionV1(fromState: OperationsDeploymentStateV1,
  event: OperationsDeploymentEventV1): OperationsDeploymentTransitionDecisionV1 {
  const toState = transitions.get(`${fromState}|${event}`), requiresExternalAuthority = ["owner_window_opened", "canary_started",
    "promotion_approved", "rollback_requested"].includes(event);
  const material: Omit<OperationsDeploymentTransitionDecisionV1, "decisionDigest"> = {
    contractVersion: OPERATIONS_DEPLOYMENT_CONTRACT_V1, fromState, event, ...(toState ? { toState } : {}),
    permittedByStateMachine: Boolean(toState), requiresExternalAuthority, automaticRetryAllowed: false, performsAction: false,
    grantsApproval: false, grantsDeploymentAuthority: false };
  return { ...material, decisionDigest: sha256Digest(material) };
}

export function buildOperationsSyntheticReleaseCandidateV1(topology: OperationsProductionTopologyV1 = buildOperationsSyntheticTopologyFixtureV1()) {
  const value = (label: string) => sha256Digest({ release: "synthetic-candidate", label });
  return buildOperationsReleaseCandidateV1({ releaseId: "release:operations:synthetic:1", version: "0.1.0-ops-candidate",
    sourceRevisionDigest: value("source"), applicationArtifactDigest: topology.services[1]!.artifactIdentityDigest,
    migrationBundleDigest: topology.services[2]!.artifactIdentityDigest,
    publicAssetsDigest: topology.services[0]!.artifactIdentityDigest, lockfileDigest: value("lockfile"), sbomDigest: value("sbom"),
    provenanceDigest: value("provenance"), signatureEvidenceDigest: value("signature"),
    configurationSchemaDigest: topology.services[1]!.configurationSchemaDigest,
    protocolCompatibilityDigest: value("protocol-compatibility"), rollbackCompatibilityDigest: value("rollback-compatibility"),
    builtAt: "2026-08-29T23:56:00.000Z" });
}

export function buildCurrentOperationsDeploymentDisabledV1() {
  const topology = buildOperationsSyntheticTopologyFixtureV1(), release = buildOperationsSyntheticReleaseCandidateV1(topology),
    plan = buildOperationsDeploymentPlanV1({ planId: "plan:operations:production-candidate:1", topology, release,
      plannedAt: "2026-08-29T23:57:00.000Z", expiresAt: "2026-08-30T00:57:00.000Z" }),
    checkedAt = "2026-08-29T23:58:00.000Z";
  const prerequisites = OPERATIONS_DEPLOYMENT_GATE_IDS_V1.map((gateId, position) => {
    const met = position === 0 || position === 1 || position === 13;
    return buildOperationsDeploymentPrerequisiteV1({ gateId, state: met ? "met" : "missing",
      ...(met ? { evidenceDigest: position === 0 ? topology.topologyDigest : position === 1 ? release.releaseDigest
        : OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1 } : {}), checkedAt,
      safeReasonCode: met ? "contract_evidence_present" : "authoritative_evidence_missing" });
  });
  const assessment = buildOperationsDeploymentReadinessAssessmentV1({ assessmentId: "assessment:operations:deployment:current",
    plan, prerequisites, assessedAt: checkedAt });
  return { topology, release, plan, assessment, disposition: buildOperationsDeploymentDisabledDispositionV1({ assessment,
    recordedAt: "2026-08-29T23:58:01.000Z" }) };
}

export const operationsDeploymentSchemasV1 = { release: releaseSchema, plan: planSchema, prerequisite: prerequisiteSchema,
  assessment: assessmentSchema, disabledDisposition: dispositionSchema } as const;
