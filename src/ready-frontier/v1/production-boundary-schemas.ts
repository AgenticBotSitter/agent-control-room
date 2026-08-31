import { z } from "zod";
import { READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1 } from "./no-relay";
import {
  READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1,
  READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1,
  READY_FRONTIER_PRODUCTION_BOUNDARY_ASSESSMENT_V1,
  READY_FRONTIER_PRODUCTION_BOUNDARY_PLAN_V1,
  READY_FRONTIER_PRODUCTION_BOUNDARY_PROJECTION_V1,
  READY_FRONTIER_PRODUCTION_DISABLED_DISPOSITION_V1,
  READY_FRONTIER_PRODUCTION_GATE_REQUIREMENT_V1,
  READY_FRONTIER_PRODUCTION_RECONCILIATION_DECISION_V1,
  readyFrontierProductionEvidenceClassesV1,
  readyFrontierProductionProofAuthoritiesV1,
} from "./production-boundary-types";
const readyFrontierIdSchemaV1 = z.string().min(3).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/);
const readyFrontierSafeCodeSchemaV1 = z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._:-]*$/);
const readyFrontierDigestSchemaV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const readyFrontierAuthTagSchemaV1 = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);
const readyFrontierTimeSchemaV1 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  }, "invalid canonical instant");

const readyFrontierProductionGateCodeSchemaV1 = z.enum(READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1);

const readyFrontierProductionBoundaryPlanInputSchemaV1 = z.object({
  planId: readyFrontierIdSchemaV1,
  activationPacket: z.unknown(),
  plannedAt: readyFrontierTimeSchemaV1,
  expiresAt: readyFrontierTimeSchemaV1,
}).strict();

const readyFrontierProductionGateRequirementSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_GATE_REQUIREMENT_V1),
  gateCode: readyFrontierProductionGateCodeSchemaV1,
  evidenceClass: z.enum(readyFrontierProductionEvidenceClassesV1),
  proofAuthority: z.enum(readyFrontierProductionProofAuthoritiesV1),
  requiredBindings: z.array(readyFrontierSafeCodeSchemaV1).min(4).max(12),
  freshnessRequired: z.boolean(),
  independentVerifierRequired: z.boolean(),
  status: z.literal("unobserved"),
  evidenceDigest: z.null(),
  validUntil: z.null(),
  repositoryCanSatisfy: z.literal(false),
  grantsApproval: z.literal(false),
  grantsActivationAuthority: z.literal(false),
  grantsDispatchOrExecution: z.literal(false),
  grantsExternalEffects: z.literal(false),
  requirementDigest: readyFrontierDigestSchemaV1,
}).strict();

const readyFrontierProductionBoundaryPlanSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_BOUNDARY_PLAN_V1),
  planId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  workspaceId: readyFrontierIdSchemaV1,
  activationPacketId: readyFrontierIdSchemaV1,
  activationPacketDigest: readyFrontierDigestSchemaV1,
  activationPacketCreatedAt: readyFrontierTimeSchemaV1,
  simulationRunId: readyFrontierIdSchemaV1,
  simulationRunDigest: readyFrontierDigestSchemaV1,
  acceptedAuto040Commit: z.literal(READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1),
  acceptedAuto040ReviewSha256: z.literal(READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1),
  requiredProductionGateCodes: z.array(readyFrontierProductionGateCodeSchemaV1).length(9),
  consumerProcessModel: z.literal("separate_service_principal"),
  consumerChannelProtocol: z.literal("mutual_ed25519_authenticated_handoff_v1"),
  handoffClaimMode: z.literal("transactional_single_owner_claim"),
  databaseMode: z.literal("hosted_postgresql_required_unconfigured"),
  brokerMode: z.literal("node_local_reference_only"),
  clockMode: z.literal("protected_monotonic_and_database_boundary_required"),
  policyCustodyMode: z.literal("owner_signed_external_high_water_required"),
  ambiguityMode: z.literal("destination_evidence_or_new_owner_action"),
  postMarkerUnknownState: z.literal("terminal_ambiguity"),
  automaticRetryAfterMarker: z.literal(false),
  defaultDisabled: z.literal(true),
  repositoryDesignOnly: z.literal(true),
  productionConfigurationPresent: z.literal(false),
  protectedMaterialPresent: z.literal(false),
  consumerImplemented: z.literal(false),
  policyEnrolled: z.literal(false),
  activationAuthorized: z.literal(false),
  permitsProtectedReferenceResolution: z.literal(false),
  permitsNetwork: z.literal(false),
  permitsGitHubMutation: z.literal(false),
  permitsAgentOrProviderContact: z.literal(false),
  permitsClaimOrLease: z.literal(false),
  permitsDispatchOrExecution: z.literal(false),
  permitsExternalEffects: z.literal(false),
  plannedAt: readyFrontierTimeSchemaV1,
  expiresAt: readyFrontierTimeSchemaV1,
  planDigest: readyFrontierDigestSchemaV1,
  planAuthTag: readyFrontierAuthTagSchemaV1,
}).strict();

const readyFrontierProductionBoundaryAssessmentInputSchemaV1 = z.object({
  assessmentId: readyFrontierIdSchemaV1,
  plan: z.unknown(),
  assessedAt: readyFrontierTimeSchemaV1,
}).strict();

const readyFrontierProductionBoundaryAssessmentSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_BOUNDARY_ASSESSMENT_V1),
  assessmentId: readyFrontierIdSchemaV1,
  planId: readyFrontierIdSchemaV1,
  planDigest: readyFrontierDigestSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  workspaceId: readyFrontierIdSchemaV1,
  activationPacketId: readyFrontierIdSchemaV1,
  activationPacketDigest: readyFrontierDigestSchemaV1,
  activationPacketCreatedAt: readyFrontierTimeSchemaV1,
  simulationRunId: readyFrontierIdSchemaV1,
  simulationRunDigest: readyFrontierDigestSchemaV1,
  plannedAt: readyFrontierTimeSchemaV1,
  planExpiresAt: readyFrontierTimeSchemaV1,
  planAuthTag: readyFrontierAuthTagSchemaV1,
  requirements: z.array(readyFrontierProductionGateRequirementSchemaV1).length(9),
  blockingGateCodes: z.array(readyFrontierProductionGateCodeSchemaV1).length(9),
  remainingProofCount: z.literal(9),
  state: z.literal("blocked_design_only"),
  safeReason: z.literal("production_evidence_unobserved"),
  eligibleForOwnerApproval: z.literal(false),
  eligibleForActivation: z.literal(false),
  requiresNewProductionEvidenceAssessment: z.literal(true),
  requiresFreshStrongOwnerApproval: z.literal(true),
  requiresIndependentSecurityReview: z.literal(true),
  assessedAt: readyFrontierTimeSchemaV1,
  activationAuthorized: z.literal(false),
  grantsApproval: z.literal(false),
  grantsActivationAuthority: z.literal(false),
  grantsClaimOrLease: z.literal(false),
  grantsDispatchOrExecution: z.literal(false),
  grantsExternalEffects: z.literal(false),
  assessmentDigest: readyFrontierDigestSchemaV1,
}).strict();

const readyFrontierProductionDisabledDispositionInputSchemaV1 = z.object({
  assessment: z.unknown(),
  recordedAt: readyFrontierTimeSchemaV1,
}).strict();

const readyFrontierProductionDisabledDispositionSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_DISABLED_DISPOSITION_V1),
  dispositionId: readyFrontierIdSchemaV1,
  planId: readyFrontierIdSchemaV1,
  planDigest: readyFrontierDigestSchemaV1,
  assessmentId: readyFrontierIdSchemaV1,
  assessmentDigest: readyFrontierDigestSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  workspaceId: readyFrontierIdSchemaV1,
  status: z.literal("disabled_before_consumer_construction"),
  blockingGateCodes: z.array(readyFrontierProductionGateCodeSchemaV1).length(9),
  safeReason: z.literal("production_evidence_unobserved"),
  recordedAt: readyFrontierTimeSchemaV1,
  requiresNewAssessmentAndOwnerAuthorization: z.literal(true),
  automaticRetryAllowed: z.literal(false),
  productionConfigurationRead: z.literal(false),
  databaseContacted: z.literal(false),
  protectedReferenceResolutionAttempted: z.literal(false),
  consumerConstructed: z.literal(false),
  claimOrLeaseAttempted: z.literal(false),
  handoffConsumed: z.literal(false),
  agentOrProviderContacted: z.literal(false),
  networkContacted: z.literal(false),
  deploymentAttempted: z.literal(false),
  externalEffectOccurred: z.literal(false),
  grantsApproval: z.literal(false),
  grantsActivationAuthority: z.literal(false),
  grantsDispatchOrExecution: z.literal(false),
  dispositionDigest: readyFrontierDigestSchemaV1,
}).strict();

const readyFrontierProductionReconciliationStateSchemaV1 = z.enum([
  "pending", "claimed", "failed_before_contact", "delivery_started", "ambiguous", "confirmed",
  "reconciled_not_delivered",
]);
const readyFrontierProductionReconciliationEventSchemaV1 = z.enum([
  "claim_acquired", "definite_precontact_failure", "delivery_marker_written", "post_marker_unknown",
  "qualified_destination_confirmed", "qualified_destination_absence_observed",
  "independent_destination_absence_confirmed",
]);
const readyFrontierProductionReconciliationDecisionSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_RECONCILIATION_DECISION_V1),
  fromState: readyFrontierProductionReconciliationStateSchemaV1,
  event: readyFrontierProductionReconciliationEventSchemaV1,
  toState: readyFrontierProductionReconciliationStateSchemaV1.nullable(),
  permittedByStateMachine: z.boolean(),
  requiresProtectedDatabaseTransaction: z.boolean(),
  requiresQualifiedDestinationEvidence: z.boolean(),
  requiresNewOwnerAuthorizedActionBeforeRetry: z.boolean(),
  automaticRetryAllowed: z.literal(false),
  performsConsumerAction: z.literal(false),
  contactsDestination: z.literal(false),
  grantsClaimOrLease: z.literal(false),
  grantsDispatchOrExecution: z.literal(false),
  grantsExternalEffects: z.literal(false),
  decisionDigest: readyFrontierDigestSchemaV1,
}).strict();

const readyFrontierProductionBoundaryProjectionSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_BOUNDARY_PROJECTION_V1),
  tenantId: readyFrontierIdSchemaV1,
  workspaceId: readyFrontierIdSchemaV1,
  planId: readyFrontierIdSchemaV1,
  assessmentId: readyFrontierIdSchemaV1,
  status: z.literal("blocked_design_only"),
  safeReason: z.literal("production_evidence_unobserved"),
  blockingGateCodes: z.array(readyFrontierProductionGateCodeSchemaV1).length(9),
  remainingProofCount: z.literal(9),
  canActivateProduction: z.literal(false),
  canConstructConsumer: z.literal(false),
  canResolveProtectedReferences: z.literal(false),
  canContactNetwork: z.literal(false),
  canClaimOrLease: z.literal(false),
  canDispatchOrExecute: z.literal(false),
  projectionDigest: readyFrontierDigestSchemaV1,
}).strict();

function bindAuthoritativeParserV1<T>(schema: { parse(value: unknown): T }): { parse(value: unknown): T } {
  const parse = schema.parse.bind(schema);
  return Object.freeze({ parse });
}

export const readyFrontierProductionBoundaryPlanInputSyntaxParserV1 = bindAuthoritativeParserV1(
  readyFrontierProductionBoundaryPlanInputSchemaV1);
export const readyFrontierProductionGateRequirementSyntaxParserV1 = bindAuthoritativeParserV1(
  readyFrontierProductionGateRequirementSchemaV1);
export const readyFrontierProductionBoundaryPlanSyntaxParserV1 = bindAuthoritativeParserV1(
  readyFrontierProductionBoundaryPlanSchemaV1);
export const readyFrontierProductionBoundaryAssessmentInputSyntaxParserV1 = bindAuthoritativeParserV1(
  readyFrontierProductionBoundaryAssessmentInputSchemaV1);
export const readyFrontierProductionBoundaryAssessmentSyntaxParserV1 = bindAuthoritativeParserV1(
  readyFrontierProductionBoundaryAssessmentSchemaV1);
export const readyFrontierProductionDisabledDispositionInputSyntaxParserV1 = bindAuthoritativeParserV1(
  readyFrontierProductionDisabledDispositionInputSchemaV1);
export const readyFrontierProductionDisabledDispositionSyntaxParserV1 = bindAuthoritativeParserV1(
  readyFrontierProductionDisabledDispositionSchemaV1);
export const readyFrontierProductionReconciliationStateSyntaxParserV1 = bindAuthoritativeParserV1(
  readyFrontierProductionReconciliationStateSchemaV1);
export const readyFrontierProductionReconciliationEventSyntaxParserV1 = bindAuthoritativeParserV1(
  readyFrontierProductionReconciliationEventSchemaV1);
export const readyFrontierProductionReconciliationDecisionSyntaxParserV1 = bindAuthoritativeParserV1(
  readyFrontierProductionReconciliationDecisionSchemaV1);
export const readyFrontierProductionBoundaryProjectionSyntaxParserV1 = bindAuthoritativeParserV1(
  readyFrontierProductionBoundaryProjectionSchemaV1);
