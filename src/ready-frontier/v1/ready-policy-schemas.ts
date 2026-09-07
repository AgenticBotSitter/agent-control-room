import { z } from "zod";
import { jobRecordSchema } from "../../domain/v1";
import { readyFrontierMaterializationReceiptSchemaV1 } from "./automation-schemas";
import {
  READY_FRONTIER_HANDOFF_PACKET_V1,
  READY_FRONTIER_PROMOTION_PROJECTION_V1,
  READY_FRONTIER_PROMOTION_RECEIPT_V1,
  READY_FRONTIER_PROMOTION_REQUEST_V1,
  READY_FRONTIER_READY_POLICY_V1,
} from "./ready-policy-types";
import { readyFrontierAuthTagSchemaV1, readyFrontierDigestSchemaV1, readyFrontierIdSchemaV1,
  readyFrontierSafeCodeSchemaV1, readyFrontierTimeSchemaV1 } from "./schemas";
import { READY_FRONTIER_RESOURCE_CEILINGS_V1, readyFrontierPlatformsV1, readyFrontierRiskClassesV1 } from "./types";

const revision = z.number().int().min(1).max(2_147_483_647);
const nonAuthority = {
  permitsClaimOrLease: z.literal(false), permitsDispatchOrExecution: z.literal(false),
  permitsProviderContact: z.literal(false), permitsAgentMessage: z.literal(false),
  permitsGitHubMutation: z.literal(false), permitsExternalEffects: z.literal(false),
};

export const readyFrontierReadyProjectPolicySchemaV1 = z.object({
  projectId: readyFrontierIdSchemaV1, enabled: z.boolean(),
  allowedRouteIds: z.array(readyFrontierIdSchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxRoutes),
  allowedPlatforms: z.array(z.enum(readyFrontierPlatformsV1)).min(1).max(readyFrontierPlatformsV1.length),
  allowedCapabilities: z.array(readyFrontierSafeCodeSchemaV1).min(1).max(32),
  maximumRisk: z.enum(readyFrontierRiskClassesV1),
  maximumCostMicrousdPerWork: z.number().int().min(0).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxCostMicrousd),
  maximumActiveReady: z.number().int().min(1).max(32), resourceKey: readyFrontierIdSchemaV1,
  reservationUnits: z.number().int().min(1).max(32), resourceCapacityUnits: z.number().int().min(1).max(64),
  reservationTtlSeconds: z.number().int().min(30).max(3_600),
}).strict().superRefine((value, context) => {
  if (value.reservationUnits > value.resourceCapacityUnits) context.addIssue({ code: "custom", message: "reservation exceeds capacity" });
});

export const readyFrontierReadyPolicySchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_READY_POLICY_V1), tenantId: readyFrontierIdSchemaV1,
  workspaceId: readyFrontierIdSchemaV1, policyId: readyFrontierIdSchemaV1, revision,
  previousPolicyDigest: readyFrontierDigestSchemaV1.nullable(), action: z.enum(["enroll", "revise", "suspend", "revoke"]),
  state: z.enum(["active", "suspended", "revoked"]), parentStandingPolicyId: readyFrontierIdSchemaV1,
  parentStandingPolicyRevision: revision, parentStandingPolicyDigest: readyFrontierDigestSchemaV1,
  separateReadyReviewDigest: readyFrontierDigestSchemaV1, activationScope: z.literal("repository_simulation"),
  ownerActorDigest: readyFrontierDigestSchemaV1, ownerAuthenticationEvidenceDigest: readyFrontierDigestSchemaV1,
  evidenceSource: z.literal("repository_fixture"), repositoryReviewFixtureAccepted: z.literal(true),
  productionOwnerAuthenticationVerified: z.literal(false), productionIndependentReviewVerified: z.literal(false),
  recordedAt: readyFrontierTimeSchemaV1, effectiveAt: readyFrontierTimeSchemaV1, expiresAt: readyFrontierTimeSchemaV1,
  maximumMaterializationAgeSeconds: z.number().int().min(60).max(86_400),
  maximumActiveReadyGlobal: z.number().int().min(1).max(64),
  projectPolicies: z.array(readyFrontierReadyProjectPolicySchemaV1).min(1).max(READY_FRONTIER_RESOURCE_CEILINGS_V1.maxProjects),
  permitsAutomaticReadyTransition: z.literal(true), permitsDatabaseSchedulerReservation: z.literal(true),
  permitsInternalJobberHandoff: z.literal(true), handoffTransport: z.literal("canonical_internal_table"),
  permitsAutomaticApproval: z.literal(false), permitsScheduleCreation: z.literal(false), ...nonAuthority,
  policyCeilingDigest: readyFrontierDigestSchemaV1, policyDigest: readyFrontierDigestSchemaV1,
  policyAuthTag: readyFrontierAuthTagSchemaV1,
}).strict();

export const readyFrontierPromotionRequestSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PROMOTION_REQUEST_V1), requestId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1, workspaceId: readyFrontierIdSchemaV1,
  materializationReceiptId: readyFrontierIdSchemaV1, materializationReceiptDigest: readyFrontierDigestSchemaV1,
  jobId: readyFrontierIdSchemaV1, standingPolicyId: readyFrontierIdSchemaV1, standingPolicyRevision: revision,
  standingPolicyDigest: readyFrontierDigestSchemaV1, readyPolicyId: readyFrontierIdSchemaV1,
  readyPolicyRevision: revision, readyPolicyDigest: readyFrontierDigestSchemaV1,
  requestedAt: readyFrontierTimeSchemaV1, promotedAt: readyFrontierTimeSchemaV1,
  reservationExpiresAt: readyFrontierTimeSchemaV1, trigger: z.literal("standing_ready_policy_repository_simulation"),
  repositorySimulationOnly: z.literal(true), createsApproval: z.literal(false), createsSchedule: z.literal(false),
  permitsReadyTransition: z.literal(true), permitsDatabaseSchedulerReservation: z.literal(true),
  permitsInternalJobberHandoff: z.literal(true), ...nonAuthority,
}).strict();

export const readyFrontierSchedulerDecisionSchemaV1 = z.object({
  selectedProjectId: readyFrontierIdSchemaV1, selectedJobId: readyFrontierIdSchemaV1,
  selectedRouteId: readyFrontierIdSchemaV1, resourceKey: readyFrontierIdSchemaV1,
  reservationUnits: z.number().int().min(1).max(32), resourceCapacityUnits: z.number().int().min(1).max(64),
  score: z.number().finite(), reasonCodes: z.tuple([z.literal("hard_gates_passed"),
    z.literal("deterministic_allocation_selected"), z.literal("database_capacity_reserved")]),
  decisionDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierReservationSchemaV1 = z.object({
  reservationId: readyFrontierIdSchemaV1, tenantId: readyFrontierIdSchemaV1,
  projectId: readyFrontierIdSchemaV1, jobId: readyFrontierIdSchemaV1, routeId: readyFrontierIdSchemaV1,
  resourceKey: readyFrontierIdSchemaV1, units: z.number().int().min(1).max(32),
  capacityUnits: z.number().int().min(1).max(64), decisionDigest: readyFrontierDigestSchemaV1,
  state: z.literal("active"), acquiredAt: readyFrontierTimeSchemaV1, expiresAt: readyFrontierTimeSchemaV1,
}).strict();

export const readyFrontierHandoffPacketSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_HANDOFF_PACKET_V1), handoffId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1, workspaceId: readyFrontierIdSchemaV1,
  projectId: readyFrontierIdSchemaV1, jobId: readyFrontierIdSchemaV1, routeId: readyFrontierIdSchemaV1,
  requiredCapability: readyFrontierSafeCodeSchemaV1, materializationReceiptDigest: readyFrontierDigestSchemaV1,
  evaluationDigest: readyFrontierDigestSchemaV1, sourceDigest: readyFrontierDigestSchemaV1,
  proposalDigest: readyFrontierDigestSchemaV1, standingPolicyDigest: readyFrontierDigestSchemaV1,
  readyPolicyDigest: readyFrontierDigestSchemaV1, schedulerDecisionDigest: readyFrontierDigestSchemaV1,
  reservationId: readyFrontierIdSchemaV1, createdAt: readyFrontierTimeSchemaV1,
  expiresAt: readyFrontierTimeSchemaV1, destination: z.literal("internal_scheduler_jobber_table"),
  state: z.literal("pending_internal_handoff"), repositorySimulationOnly: z.literal(true), ...nonAuthority,
  packetDigest: readyFrontierDigestSchemaV1, packetAuthTag: readyFrontierAuthTagSchemaV1,
}).strict();

export const readyFrontierPromotionReceiptSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PROMOTION_RECEIPT_V1), receiptId: readyFrontierIdSchemaV1,
  requestId: readyFrontierIdSchemaV1, promotionRequestDigest: readyFrontierDigestSchemaV1,
  tenantId: readyFrontierIdSchemaV1, workspaceId: readyFrontierIdSchemaV1,
  materializationReceiptId: readyFrontierIdSchemaV1, materializationReceiptDigest: readyFrontierDigestSchemaV1,
  cycleId: readyFrontierIdSchemaV1, proposalId: readyFrontierIdSchemaV1, proposalDigest: readyFrontierDigestSchemaV1,
  evaluationDigest: readyFrontierDigestSchemaV1, sourceDigest: readyFrontierDigestSchemaV1,
  standingPolicyId: readyFrontierIdSchemaV1, standingPolicyRevision: revision,
  standingPolicyDigest: readyFrontierDigestSchemaV1, readyPolicyId: readyFrontierIdSchemaV1,
  readyPolicyRevision: revision, readyPolicyDigest: readyFrontierDigestSchemaV1,
  proposedJobDigest: readyFrontierDigestSchemaV1, readyJob: jobRecordSchema,
  schedulerDecision: readyFrontierSchedulerDecisionSchemaV1, reservation: readyFrontierReservationSchemaV1,
  handoff: readyFrontierHandoffPacketSchemaV1, promotedAt: readyFrontierTimeSchemaV1,
  state: z.literal("ready_handoff_pending"), repositorySimulationOnly: z.literal(true),
  createsAttempt: z.literal(false), createsLease: z.literal(false), createsApproval: z.literal(false),
  createsSchedule: z.literal(false), dispatchState: z.literal("not_requested"), contactsProvider: z.literal(false),
  messagesAgent: z.literal(false), mutatesGitHub: z.literal(false), grantsExternalEffect: z.literal(false),
  receiptDigest: readyFrontierDigestSchemaV1, receiptAuthTag: readyFrontierAuthTagSchemaV1,
}).strict();

export const readyFrontierPromotionBuildInputSchemaV1 = z.object({
  request: readyFrontierPromotionRequestSchemaV1,
  materializationReceipt: readyFrontierMaterializationReceiptSchemaV1,
}).strict();

export const readyFrontierPromotionProjectionSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PROMOTION_PROJECTION_V1), tenantId: readyFrontierIdSchemaV1,
  readyPolicyState: z.enum(["repository_fixture_active", "missing", "suspended", "revoked", "expired"]),
  productionReadyPolicyState: z.literal("not_enrolled"),
  readyPromotionState: z.enum(["not_requested", "historical_ready_handoff_recorded"]),
  readyJobCount: z.number().int().min(0).max(64), pendingInternalHandoffCount: z.number().int().min(0).max(64),
  historicalPromotionCount: z.number().int().min(0).max(64),
  repositorySimulationOnly: z.literal(true), viewCanPromote: z.literal(false), viewCanSchedule: z.literal(false),
  viewCanClaimOrLease: z.literal(false), viewCanDispatchOrExecute: z.literal(false),
  projectionDigest: readyFrontierDigestSchemaV1,
}).strict();
